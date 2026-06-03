# Installation

## Prerequisites

- Homebridge already installed and running (typically Docker-based; `homebridge/homebridge:latest`)
- USB-to-RS-485 serial adapter (FTDI-based recommended), connected to the URTSI II RS-485 bus
- Identified serial device path on the host — typically `/dev/ttyUSB0` or stable by-id form like `/dev/serial/by-id/usb-FTDI_USB_Serial_Converter_*-if00-port0`
- Each URTSI II controller's rotary switch set to a unique address (01-16)
- Each shade motor's RTS channel assignments known (you'll need to map physical shades to URTSI/channel pairs)

## Step 1: Deploy the URTSI HTTP server

The server is a Python script meant to run in a Docker container with USB passthrough. Reference `docker-compose.example.yaml`:

```yaml
services:
  urtsi:
    image: python:3.14-slim
    container_name: urtsi-control
    devices:
      - /dev/ttyUSB0:/dev/ttyUSB0
    ports:
      - "8181:8181"
    volumes:
      - /path/to/this/repo/server:/app
    working_dir: /app
    environment:
      URTSI_DELAY_MS: "500"
    command: bash -c "pip install pyserial && python urtsi_server.py"
    restart: always
```

Adjust the volume path to point at this repo's `server/` directory on your host. Adjust `devices:` if your USB-serial adapter is at a different path.

Start it (Docker Compose, Portainer, TrueNAS custom app, Unraid, etc. — any container manager works):

```bash
docker compose -f docker-compose.example.yaml up -d
```

Verify the server responds:

```bash
curl 'http://localhost:8181/?urtsi=01&channel=01&direction=S'
```

Should print `OK`. (The shade won't actually move; `S` is Stop, which is a safe test.) Out-of-range parameters return HTTP 400; serial failures return 503 with the error text.

## Step 2: Map your shades

Before configuring Homebridge, you need to know which `(urtsi, channel)` pair corresponds to each physical shade. Two approaches:

**If you have the original installer's documentation:** use it.

**If you don't:** sweep manually. For each `(urtsi, channel)` combination:

```bash
curl 'http://localhost:8181/?urtsi=01&channel=01&direction=D'
```

Watch which physical shade moves, write it down, repeat. Be systematic — `urtsi=01 channel=01`, `urtsi=01 channel=02`, etc. After each command, send the Stop command before testing the next channel, so you don't have shades simultaneously at random positions.

Channels that don't move any shade are unused. You'll skip them in your Homebridge config (no point exposing tiles for nothing).

## Step 3: Install the plugin

In your Homebridge container:

```bash
# Copy plugin source into a persistent location
cp -r plugin /path/to/homebridge/local-plugins/homebridge-urtsi-shades

# Install as a local file dependency (preserves it across restarts)
cd /path/to/homebridge
docker exec -w /homebridge homebridge-container-name \
  npm install ./local-plugins/homebridge-urtsi-shades --save
```

The `--save` flag updates `package.json` so the plugin isn't pruned on next Homebridge restart.

## Step 4: Configure shades in Homebridge

Open Homebridge's `config.json` (via the Homebridge UI's Config editor, or by editing the file directly) and add a `platforms` entry:

```json
{
  "platforms": [
    {
      "platform": "URTSIShades",
      "name": "Shades",
      "host": "http://localhost:8181",
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
  ]
}
```

- Use single `urtsi`/`channel` for shades that should be controlled independently
- Use `channels: [...]` for window pairs that should always move together
- Omit unused channels entirely — don't expose tiles for nothing
- `transitionTime` is in milliseconds. The default 5000 (5 seconds) is a good middle ground; shorter values make the Apple Home Stop button window briefer

## Step 5: Restart Homebridge

After restart, your shades appear as HomeKit accessories under "Bridges" in Apple Home, with the `WindowCovering` service (window shade icon). Move them to appropriate rooms and rename if desired.

## Tuning the inter-command delay

If your install has fewer shades and bulk operations feel slow, you can reduce the delay. Default is 500ms; the URTSI manual states >100ms as the minimum, but empirically 300-400ms is the practical lower bound.

Set the `URTSI_DELAY_MS` environment variable in the container definition (in milliseconds) and restart:

```yaml
environment:
  URTSI_DELAY_MS: "400"
```

If you see red error LEDs on the URTSI controllers during bulk operations, the delay is too low. Increase it.

## Troubleshooting

**Server starts but commands return errors.** Check the container logs:
```bash
docker logs urtsi-control
```
If you see `Permission denied` on the serial device, the container needs the device passed through with the `devices:` directive (or `--device` flag).

**Some shades respond but others don't.** Most common causes:
- URTSI rotary switch on a controller is set to the wrong address
- Shade motor's RTS pairing was lost (re-pair using the motor's program button)
- One of the URTSI controllers on the bus isn't powered (check the green LED on each)
- A unit's pass-through (daisy-chain) port has failed — wire the units in parallel off the bus run instead; RS-485 is multidrop and parallel feeds work fine
- Shade is out of RF range from its assigned URTSI (move URTSI or test from closer)

**Bulk commands cause some shades to skip.** Increase `URTSI_DELAY_MS`. The default 500ms is conservative; you may have a setup that needs longer.

**Stop button doesn't appear during transit.** The native Apple Home Stop button only shows while `PositionState` is `INCREASING` or `DECREASING`, which is during the `transitionTime` window after Open/Close. If `transitionTime` is too short, the Stop button flashes by faster than you can tap. Increase it (e.g., 7000ms) for a longer Stop window.
