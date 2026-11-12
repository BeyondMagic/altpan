#!/usr/bin/env python3
"""
AltPan Native Messaging Input Bridge for Linux.
Synthesizes high-resolution hardware wheel events via /dev/uinput to drive
Firefox's native Asynchronous Pan/Zoom (APZ) compositor engine during pinch-zoom.
"""

import sys
import struct
import json
import os
import time

LOG_FILE = "/tmp/altpan_host.log"

def log(msg):
    try:
        with open(LOG_FILE, "a") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass

log(f"altpan_host.py started. PID: {os.getpid()}, ARGV: {sys.argv}")


try:
    import evdev
    from evdev import ecodes, UInput
    HAS_EVDEV = True
except ImportError:
    HAS_EVDEV = False

# High-resolution wheel units: 120 units = 1 standard wheel notch.
# In Firefox APZ with smooth scrolling, 1 notch (120 units) corresponds
# to ~100px of scroll distance.
# Setting HI_RES_PER_PIXEL to 1.2 produces authentic 1:1 screen tracking
# at sensitivity = 1.0 (100px mouse drag -> 120 units -> 100px scroll).
HI_RES_PER_PIXEL = 1.2


class PanDevice:
    def __init__(self):
        self.ui = None
        self.remainder_x = 0.0
        self.remainder_y = 0.0
        self.last_event_time = time.monotonic()

        if HAS_EVDEV:
            try:
                cap = {
                    ecodes.EV_REL: [
                        ecodes.REL_X,
                        ecodes.REL_Y,
                        ecodes.REL_WHEEL,
                        ecodes.REL_HWHEEL,
                        ecodes.REL_WHEEL_HI_RES,
                        ecodes.REL_HWHEEL_HI_RES,
                    ]
                }
                self.ui = UInput(cap, name="AltPan Virtual Pan Device", version=0x1)
                log("UInput created successfully.")
            except Exception as e:
                sys.stderr.write(f"[AltPan Native] Failed to initialize UInput: {e}\n")
                sys.stderr.flush()
                log(f"Failed to initialize UInput: {e}")
                self.ui = None

    def emit_pan(self, dx, dy, sensitivity=0.5, scale=1.0):
        if not self.ui:
            return False

        # In "Hand Tool" grab-and-drag:
        # Dragging mouse left (dx < 0) -> scroll right (+HWHEEL)
        # Dragging mouse right (dx > 0) -> scroll left (-HWHEEL)
        # Dragging mouse up (dy < 0) -> scroll down (-WHEEL in Linux libinput)
        # Dragging mouse down (dy > 0) -> scroll up (+WHEEL in Linux libinput)
        now = time.monotonic()
        if now - self.last_event_time > 0.2:
            self.remainder_x = 0.0
            self.remainder_y = 0.0
        self.last_event_time = now

        # Convert physical drag pixels directly to continuous high-res wheel ticks.
        # Firefox APZ compositor already accounts for visual zoom internally.
        hi_res_x = - dx * sensitivity * HI_RES_PER_PIXEL + self.remainder_x
        hi_res_y = dy * sensitivity * HI_RES_PER_PIXEL + self.remainder_y

        int_x = int(round(hi_res_x))
        int_y = int(round(hi_res_y))

        self.remainder_x = hi_res_x - int_x
        self.remainder_y = hi_res_y - int_y

        # Emit high-resolution continuous wheel events.
        # We do NOT emit discrete REL_WHEEL / REL_HWHEEL notches here because
        # firing discrete clicks causes Firefox APZ to trigger abrupt step animations
        # that fight with high-frequency continuous dragging gestures.
        if int_x != 0:
            self.ui.write(ecodes.EV_REL, ecodes.REL_HWHEEL_HI_RES, int_x)

        if int_y != 0:
            self.ui.write(ecodes.EV_REL, ecodes.REL_WHEEL_HI_RES, int_y)

        if int_x != 0 or int_y != 0:
            self.ui.syn()

        return True

    def close(self):
        if self.ui:
            try:
                self.ui.close()
            except Exception:
                pass
            self.ui = None


def read_message():
    """Reads a message from standard input (WebExtension protocol)."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    raw_content = sys.stdin.buffer.read(length)
    if not raw_content or len(raw_content) < length:
        return None
    return json.loads(raw_content.decode("utf-8"))


def send_response(data):
    """Sends a JSON response to standard output (WebExtension protocol)."""
    encoded = json.dumps(data).encode("utf-8")
    length = struct.pack("<I", len(encoded))
    sys.stdout.buffer.write(length)
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    log("main() entered.")
    device = PanDevice()

    while True:
        try:
            msg = read_message()
            if msg is None:
                log("EOF reached on stdin. Exiting.")
                break

            msg_type = msg.get("type")

            if msg_type == "ping":
                log("Received ping, responding with pong.")
                send_response({
                    "type": "pong",
                    "ok": True,
                    "uinput_active": device.ui is not None
                })
            elif msg_type == "pan":
                dx = float(msg.get("deltaX", 0))
                dy = float(msg.get("deltaY", 0))
                scale = float(msg.get("scale", 1.0))
                sensitivity = float(msg.get("sensitivity", 0.5))

                success = device.emit_pan(dx, dy, sensitivity, scale)
                send_response({"ok": success})
            else:
                log(f"Received unknown message type: {msg_type}")
                send_response({"ok": False, "error": f"Unknown message type: {msg_type}"})

        except Exception as e:
            log(f"Exception in main loop: {e}")
            send_response({"ok": False, "error": str(e)})

    device.close()
    log("altpan_host.py terminated cleanly.")


if __name__ == "__main__":
    main()
