# Architecture

Design rationale: why the server/plugin split, why one global bus lock, and why `WindowCovering` — carefully constrained — is the right HomeKit service type when the obvious choices misbehave.

## Why a separate server, not a direct-from-Homebridge serial driver

The URTSI II controllers share a single RS-485 bus. Whether the URTSIs are daisy-chained or wired in parallel (electrically equivalent on a multidrop bus), they all receive every command on the wire; each one acts only on commands matching its rotary-switch address. This means **the bus is a shared resource regardless of which URTSI you're addressing**.

If multiple Homebridge accessories try to send commands concurrently (e.g., a "close all" scene firing 22 shades at once), the result is serial-byte collisions on the wire and/or RF transmission queue overflows inside individual URTSIs. The visible symptom: shades randomly fail to respond, the URTSI's red error LED flashes, and dropped commands have no error path back to HomeKit.

The fix is a single point of serialization. Rather than embed that in the Homebridge plugin (where it would have to coordinate across plugin instances and Homebridge restarts), we put it in a separate Python server that owns the USB-serial port exclusively. The plugin just makes HTTP requests; the server enforces the ordering.

Side benefit: the server is trivially testable from a shell (`curl`), independent of Homebridge.

## Bus lock + inter-command delay

The server uses a single threading.Lock for the entire bus (not per-URTSI), because the bus serializes across units. The lock is held for each command write, and a 500ms minimum inter-command gap is enforced.

500ms was chosen empirically:

- At 100-200ms (the manual's stated minimum): frequent dropped commands and red-LED errors
- At 300-400ms: occasional drops under bulk operations
- At 500ms: reliable for sustained bulk operations across many shades

The trade-off is bulk operation speed. A "close all 22 shades" command takes roughly 22 × 500ms = 11 seconds. In practice the cascade-style sequencing is visually pleasant (shades close in a wave) and similar to how high-end systems behave; it's not a bug, but it's a noticeable change from "everything at once."

Lower delays may work for some setups. The server reads `URTSI_DELAY_MS` from the environment so it's tunable without code changes.

## HomeKit service type: design alternatives

Picking the right HomeKit service type for one-way RTS shades is harder than it looks. There are four plausible designs; three of them fail in non-obvious ways.

### Alternative 1: Naive WindowCovering

The semantically correct type. Correct icon, correct voice grammar ("open the blinds"), works with HomeKit Automations that target window coverings.

**Problem:** WindowCovering exposes a position slider (0-100%). The naive implementation tracks `TargetPosition` and `CurrentPosition` as freely-settable values. Since RTS is one-way with no feedback, these values are necessarily optimistic — the slider shows positions the shade isn't necessarily at. Animating between values makes the UX feel deeply wrong.

**Rejected** — the slider lies about reality.

### Alternative 2: Two Switch services (Open and Stop)

Rejection of the slider entirely. Two on/off tiles per shade — one to fire Up, one to fire Stop. Eliminates the lie, and tapping is reliable.

**Problem:** Apple Home's "tap the tile to control everything in this room" gesture interprets the two Switches as a group, and tapping the group fires BOTH switches simultaneously (Up + Stop). The shade starts to move and immediately halts. Bulk operations become unusable.

**Rejected.**

### Alternative 3: Switch + Fan (mixed service types)

Same idea as the dual-Switch but using Fan for the Stop service to break the group-toggle behavior.

**Problem:** Apple Home interprets the Fan service as part of "turn off everything in this room" sweeps. Pressing "turn off all the lights" fires Stop commands on every shade — sometimes mid-motion. Worse, the Fan service has its own UI quirks (speed slider, "auto" toggle) that don't make sense for a shade stop.

**Rejected.**

### Alternative 4: GarageDoorOpener with nested Stop Switch

A different framing. One HomeKit accessory containing:

- A `GarageDoorOpener` service for the primary tile (Open/Close), with a 5-second transition window
- A nested `Switch` service for the Stop button, accessible via long-press tile expand

Open/Close mental model fits cleanly. Bulk operations behave correctly. The nested Stop avoids the group-toggle problem entirely.

**Trade-offs that didn't justify it:**

- **Garage door icon** — can't be customized
- **Garage-door voice grammar** — "Hey Siri, open the garage door X" works; "open the blinds X" does not
- **Security notifications by default** — HomeKit auto-enables status notifications on `GarageDoorOpener` (security concern for actual garages), requiring manual disable per tile

Workable but every quality-of-life downside was an iceberg under the "it works."

### The design used here: WindowCovering, smartly constrained

The insight that made WindowCovering work: **the slider doesn't have to lie if you don't let it report fake intermediate positions**.

The implementation:

- `TargetPosition` accepts any 0-100 input from Apple Home, but **snaps internally** to 0 (closed) or 100 (open). RTS can't do anything else, so the data model reflects that constraint honestly.
- `CurrentPosition` stays at its old value during the transit window (e.g., 5 seconds for a shade going from closed to open). During that window, `PositionState` reports `INCREASING` or `DECREASING`.
- The `INCREASING`/`DECREASING` state is exactly the signal Apple Home uses to render the **native Stop button next to the slider during transit**. No nested service required.
- When the user taps Stop, the `HoldPosition` characteristic fires. The plugin sends `S` to the URTSI bus and sets `CurrentPosition` to 50 — a "we don't know where it actually is" middle value that's honest about the uncertainty without animating fake positions.
- After the transit window elapses (no Stop pressed), `CurrentPosition` snaps to the target and `PositionState` returns to `STOPPED`.

**Wins compared to Alternative 4:**

- Correct icon (window shade)
- Correct voice grammar ("open the blinds")
- No garage-door security notifications
- Native HomeKit Stop button (no nested service needed)
- Tile state is honest about RTS's lack of position feedback

## Combined shades

Some installations have window pairs that should always move together (e.g., a wide window split into two motorized rollers). The plugin supports a `channels` array per accessory:

```json
{
  "name": "South Window",
  "channels": [
    { "urtsi": "01", "channel": "05" },
    { "urtsi": "01", "channel": "06" }
  ]
}
```

The plugin fires both channels for each command. Bus serialization handles the ordering automatically; the user sees a single HomeKit tile that controls both motors.

## Optimistic state model

RTS is one-way RF. The shade motors receive commands but transmit nothing back. We have no way to know:

- Whether a command actually reached the shade
- The shade's current position
- Whether the shade is currently moving

The plugin tracks state purely optimistically: when a command is sent, the plugin updates HomeKit's view of state to match what was commanded. If a command fails to reach the shade (RF interference, dead motor, dead battery), HomeKit will show the wrong state until corrected.

This is unavoidable for RTS. The alternatives — Z-Wave shades, Lutron Serena, Somfy Zigbee — all have two-way feedback but cost considerably more or aren't compatible with existing RTS motors. The design embraces this rather than papering over it.

## Plugin lifecycle / persistence

Homebridge plugins are managed via npm. To keep a locally-developed plugin from being pruned on container restart, the parent `package.json` includes a reference like:

```json
"dependencies": {
  "homebridge-urtsi-shades": "file:local-plugins/homebridge-urtsi-shades"
}
```

Without this, Homebridge's startup script removes the plugin folder. With it, the plugin is treated as a regular npm dependency pointing at a local path.
