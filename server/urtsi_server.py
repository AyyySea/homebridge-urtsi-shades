#!/usr/bin/env python3
"""
URTSI II HTTP server with global RS-485 bus queueing.

All URTSI units share the same RS-485 bus, so commands must be spaced
regardless of target unit. A single global lock + inter-command delay
(default 500 ms, tunable via URTSI_DELAY_MS) serializes everything cleanly.

The serial port is opened lazily and reopened automatically after errors
(USB unplug/replug, adapter reset), so the server survives a flaky cable
without needing a container restart.

API: GET/POST http://host:8181/?urtsi=XX&channel=YY&direction=D
  urtsi:     01-16 (URTSI unit address, set by the rotary switch)
  channel:   01-16
  direction: U (up), D (down), S (stop), M (my/favorite)
Returns 200 "OK", 400 on bad params, 503 "ERR: ..." on serial failure.
"""

import os
import time
import threading
import serial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

SERIAL_PORT = os.environ.get("URTSI_SERIAL_PORT", "/dev/ttyUSB0")
SERIAL_BAUD = int(os.environ.get("URTSI_SERIAL_BAUD", "9600"))
HTTP_PORT   = int(os.environ.get("URTSI_HTTP_PORT", "8181"))
# Manual says >100 ms between commands; 500 ms is the empirically safe value
# for sustained bulk operations. Lower via env var at your own risk (red-LED
# flashes on the URTSI = dropped commands = go back up).
INTER_COMMAND_DELAY = float(os.environ.get("URTSI_DELAY_MS", "500")) / 1000.0

VALID_DIRECTIONS = ("U", "D", "S", "M")

ser = None                       # opened lazily; touched only under bus_lock
bus_lock = threading.Lock()      # global serialization of the RS-485 bus
last_command_at = 0.0            # timestamp of last write


def _open_serial():
    s = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=1)
    print(f"[URTSI] opened serial {SERIAL_PORT} @ {SERIAL_BAUD}", flush=True)
    return s


def _drop_serial():
    """Close and forget the handle so the next command reopens it."""
    global ser
    s, ser = ser, None
    if s is not None:
        try:
            s.close()
        except Exception:
            pass


def send_to_urtsi(unit, channel, direction):
    """Single global queue. Every command waits its turn, with delay since last.

    Raises on serial failure; the stale handle is dropped so the next call
    retries opening the port.
    """
    global ser, last_command_at
    with bus_lock:
        now = time.monotonic()
        elapsed = now - last_command_at
        if elapsed < INTER_COMMAND_DELAY:
            time.sleep(INTER_COMMAND_DELAY - elapsed)

        try:
            if ser is None or not ser.is_open:
                _drop_serial()
                ser = _open_serial()
            cmd = f"{unit}{channel}{direction}\r".encode("ascii")
            ser.write(cmd)
            ser.flush()
        except (serial.SerialException, OSError):
            _drop_serial()
            raise

        last_command_at = time.monotonic()
        print(f"[URTSI] sent {unit}{channel}{direction}", flush=True)


def _unit_or_channel(raw):
    """Validate a urtsi/channel parameter: integer 1-16. Returns '01'-'16' or None."""
    v = (raw or "").strip()
    if not v.isdigit():
        return None
    n = int(v)
    if not 1 <= n <= 16:
        return None
    return f"{n:02d}"


class Handler(BaseHTTPRequestHandler):
    def _respond(self, code, body):
        self.send_response(code)
        self.end_headers()
        self.wfile.write(body)

    def _handle(self):
        params = parse_qs(urlparse(self.path).query)
        unit      = _unit_or_channel(params.get("urtsi",     [""])[0])
        channel   = _unit_or_channel(params.get("channel",   [""])[0])
        direction = (params.get("direction", [""])[0] or "").strip().upper()

        if unit is None or channel is None or direction not in VALID_DIRECTIONS:
            self._respond(400, b"bad params (need urtsi 01-16, channel 01-16, direction U/D/S/M)")
            return

        try:
            send_to_urtsi(unit, channel, direction)
            self._respond(200, b"OK")
        except Exception as e:
            self._respond(503, f"ERR: {e}".encode())

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def log_message(self, fmt, *args):
        return  # quiet access log


def main():
    global ser
    print(f"[URTSI] HTTP server :{HTTP_PORT}, inter-cmd delay = "
          f"{INTER_COMMAND_DELAY*1000:.0f}ms (global bus lock)", flush=True)
    # Eager open so misconfiguration is visible at startup, but don't die if
    # the adapter isn't plugged in yet -- commands retry the open themselves.
    try:
        ser = _open_serial()
    except (serial.SerialException, OSError) as e:
        print(f"[URTSI] serial {SERIAL_PORT} not available yet ({e}); "
              f"will retry on first command", flush=True)

    server = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[URTSI] shutting down", flush=True)
    finally:
        _drop_serial()


if __name__ == "__main__":
    main()
