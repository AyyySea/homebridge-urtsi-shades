# homebridge-urtsi-shades (plugin)

Homebridge platform plugin for Somfy URTSI II shades. Each shade appears as a
HomeKit `WindowCovering` accessory with snap-to-endpoint behavior (RTS is
one-way RF) and a native Apple Home Stop button during transit. Single-channel
and combined-channel shades are supported.

Requires the companion URTSI HTTP server from this repo's `server/` directory,
reachable at the configured `host` URL.

Configuration reference, installation steps, and design rationale live in the
repo root: see [`README.md`](../README.md), [`docs/installation.md`](../docs/installation.md),
and [`docs/architecture.md`](../docs/architecture.md). A ready-to-edit config
example is in [`config-block.json`](config-block.json).
