# homebridge-urtsi-shades

HomeKit control for Somfy RTS shades driven through Somfy URTSI II RS-485 controllers, via Homebridge.

The setup is two cooperating components:

- **`server/`** — a small Python HTTP server that owns the USB-serial port to the URTSI II bus, enforces inter-command timing (the bus needs >100 ms gaps; 500 ms is the reliable value), validates inputs, reopens the serial port automatically after USB errors, and exposes a simple HTTP API for shade commands
- **`plugin/`** — a Homebridge plugin that creates one HomeKit accessory per shade and translates HomeKit commands into HTTP calls to the server

Splitting them lets the bus-management logic stay simple and self-contained, while Homebridge handles the HomeKit pairing and accessory lifecycle.

## Hardware requirements

- One or more Somfy URTSI II controllers (model 1810872, FCC ID DWNURTSII) sharing a single RS-485 bus — daisy-chained through the pass-through ports, or wired in parallel (RS-485 is a multidrop bus, and parallel feeds are a reliable fallback when a unit's pass-through port is flaky)
- USB-to-RS-485 (or USB-to-DB9) serial adapter — FTDI-based chips work reliably; the device path is typically `/dev/ttyUSB0` or `/dev/serial/by-id/usb-FTDI_...`
- A host running Homebridge with both the URTSI server and the URTSI plugin installed
- The URTSI II rotary switches set so each controller has a unique address (01-16)

## What this gives you

- One HomeKit tile per shade (or grouped shade pair) using the `WindowCovering` service type — correct window-shade icon, correct voice grammar ("open the blinds")
- Tap to open or close; native Apple Home Stop button appears next to the slider during transit
- Optimistic state (RTS is one-way RF with no position feedback), but the slider doesn't lie — positions snap to fully open (100) or fully closed (0), with a transit window in between
- Reliable bulk operations — bus serialization handles "close all shades" sweeps without dropping commands
- Combined-shade support — one HomeKit tile can fire commands to multiple URTSI channels (for window pairs that should move together)

## Architecture summary

```
HomeKit (iPhone/Apple Home)
    ↓ HomeKit Bridge
Homebridge
    ↓ homebridge-urtsi-shades plugin
HTTP (localhost:8181)
    ↓
URTSI HTTP Server (Python)
    ↓ /dev/ttyUSB0 (RS-485, 9600 8N1)
URTSI II Controllers (daisy-chained on bus)
    ↓ 433.42 MHz RTS RF
Somfy RTS shade motors
```

See [`docs/architecture.md`](docs/architecture.md) for the design rationale behind the bus locking and the HomeKit service-type choice (and the alternatives that didn't work).

## Installation

See [`docs/installation.md`](docs/installation.md). High-level:

1. Deploy the URTSI server as a Docker container with USB passthrough (a reference `docker-compose.example.yaml` is provided)
2. Install the Homebridge plugin via npm in your Homebridge instance
3. Configure each shade in Homebridge `config.json` with its `urtsi` (controller address) and `channel`
4. Restart Homebridge

## Plugin configuration

```json
{
  "platform": "URTSIShades",
  "name": "URTSI Shades",
  "host": "http://127.0.0.1:8181",
  "transitionTime": 5000,
  "shades": [
    { "name": "Bedroom Left",  "urtsi": "01", "channel": "01" },
    { "name": "Bedroom Right", "urtsi": "01", "channel": "02" },
    { "name": "Living Room Wide", "channels": [
        { "urtsi": "01", "channel": "05" },
        { "urtsi": "01", "channel": "06" }
    ]}
  ]
}
```

- A shade with `channels: [...]` fires every listed channel on Up, Down, and Stop — use it for window pairs that should always move together. Bus serialization is handled by the server.
- `transitionTime` (ms) is how long Apple Home shows "Opening"/"Closing" before settling — and the window during which the native Stop button is visible. 5000 is a good default.
- State is optimistic (RTS is one-way RF). `TargetPosition` snaps to fully open (100) or fully closed (0); a Stop mid-transit settles `CurrentPosition` at 50 as an honest "unknown" value.

## Protocol notes

URTSI II takes simple ASCII commands over RS-485 at 9600 8N1:

```
<unit><channel><direction>\r
```

- `unit`: 01-16 (two ASCII digits, matching the rotary switch position)
- `channel`: 01-16 (two ASCII digits)
- `direction`: `U` (up), `D` (down), `S` (stop), `M` (my/favorite preset)

Example: `0203D\r` = unit 2, channel 3, down.

The manual specifies a "WAIT command" between commands; empirically 500ms is the safe lower bound. At lower intervals (200-300ms), the URTSI's internal RF transmission queue overflows and commands are dropped silently.

## Status

Works in production for an installation with 22 active shades across 2 URTSI controllers. See [`docs/architecture.md`](docs/architecture.md) for the service-type design rationale — and why the obvious alternatives misbehave in Apple Home.

## Acknowledgments

This project was developed with extensive assistance from Anthropic's Claude.

## License

MIT — see [LICENSE](LICENSE).
