#!/usr/bin/env python3
"""
fake-thing.py - pretends to be the ESP32 so you can test the edge and Supabase
without hardware. Sends the same binary frames, status and info (position)
messages as the firmware and answers commands.

Like the sketch, it sends a routine reading every --interval seconds (60), and a
reading only --event-gap seconds (5) after the previous one when a condition
starts: SATURATED, HEAVY, MOVED, NO_ECHO or MOTION. "Reading N" below counts
readings sent, routine or not.

  python3 tools/fake-thing.py                       # NNP-IOT-01, a routine reading every 60 s
  python3 tools/fake-thing.py --interval 5          # faster, for a quick test
  python3 tools/fake-thing.py --node NNP-IOT-02 --interval 2 --count 20
  python3 tools/fake-thing.py --no-clock            # behave like an ESP32 without NTP time yet
  python3 tools/fake-thing.py --flood-at 4          # soil saturated from reading 4 (sent at once, quick alert)
  python3 tools/fake-thing.py --flood-at 4 --flood-until 9   # ... and back to normal from reading 9
  python3 tools/fake-thing.py --soil-pct 90,70,90,90,82,82,70,70   # soil % of the first readings
  python3 tools/fake-thing.py --move-at 6           # node knocked 25 cm off its baseline from reading 6
  python3 tools/fake-thing.py --rain-at 3           # heavy rain from reading 3
  python3 tools/fake-thing.py --motion-at 4,5,12    # PIR motion in readings 4, 5 and 12
  python3 tools/fake-thing.py --lat 1.5533 --lon 110.3592   # position sent once after "power-up"

It logs in with the [mqtt] username from config.toml and mqtt_password from
secrets.toml unless you pass
--user / --password (e.g. the 'thing' account the ESP32 uses).
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from pathlib import Path

import paho.mqtt.client as mqtt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import edge_db as db  # noqa: E402

# Conditions that make the sketch send at once when they start
EVENT_STATES = {"SATURATED", "HEAVY", "MOVED", "NO_ECHO", "MOTION"}


def main():
    ap = argparse.ArgumentParser(description="Simulated ESP32 field node")
    ap.add_argument("--config")
    ap.add_argument("--node", default="NNP-IOT-01")
    ap.add_argument("--interval", type=float, default=60.0, help="seconds between routine readings")
    ap.add_argument("--event-gap", type=float, default=5.0,
                    help="seconds before a reading in which a condition starts (the sketch sends it at once)")
    ap.add_argument("--count", type=int, default=0, help="stop after this many readings (0 = run forever)")
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    ap.add_argument("--user")
    ap.add_argument("--password")
    ap.add_argument("--no-clock", action="store_true", help="send ts = 0 like an ESP32 without NTP")
    ap.add_argument("--flood-at", type=int, default=0, help="soil saturated from this reading on")
    ap.add_argument("--flood-until", type=int, default=0, help="soil back to normal from this reading on")
    ap.add_argument("--soil-pct", default="", help="comma list: soil %% of the first readings")
    ap.add_argument("--rain-at", type=int, default=0, help="heavy rain from this reading on")
    ap.add_argument("--move-at", type=int, default=0, help="node moved 25 cm from this reading on")
    ap.add_argument("--motion-at", default="", help="comma list: readings in which the PIR saw movement")
    ap.add_argument("--lat", type=float, help="position (decimal degrees) sent once in the info message")
    ap.add_argument("--lon", type=float)
    ap.add_argument("--boot-id", type=int, help="use this boot_id instead of a random one")
    args = ap.parse_args()

    cfg = db.load_config(args.config or db.config_path_from_args(sys.argv))
    m = cfg["mqtt"]
    prefix = m.get("topic_prefix", "field")
    host, port = args.host or m.get("host", "localhost"), args.port or int(m.get("port", 1883))
    user, password = args.user or m.get("username"), args.password or m.get("password")
    cal = cfg["calibration"]

    node = args.node
    boot_id = args.boot_id if args.boot_id is not None else random.getrandbits(32)
    state = {"beep_on": True, "baseline": None, "dist": 23.4, "seen": [], "connected": False}
    t_status = f"{prefix}/{node}/status"
    t_tele = f"{prefix}/{node}/telemetry"

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"fake-{node}", clean_session=True)
    if user:
        client.username_pw_set(user, password or "")
    client.will_set(t_status, json.dumps({"online": False, "boot_id": boot_id}, separators=(",", ":")),
                    qos=1, retain=True)

    def on_connect(c, userdata, flags, rc, props):
        if rc.is_failure:
            print(f"broker refused login: {rc}")
            return
        c.publish(t_status, json.dumps({"online": True, "boot_id": boot_id}, separators=(",", ":")),
                  qos=0, retain=True)
        if not state.get("info_sent"):          # once per power-up, like the sketch
            c.publish(f"{prefix}/{node}/info", json.dumps({"boot_id": boot_id, "lat": args.lat, "lon": args.lon},
                                                          separators=(",", ":")), qos=0, retain=True)
            state["info_sent"] = True
        c.subscribe(f"{prefix}/{node}/cmd", qos=1)
        state["connected"] = True
        print(f"{node} connected to {host}:{port} (boot_id {boot_id})")

    def on_message(c, userdata, msg):
        try:
            cmd = json.loads(msg.payload)
        except ValueError:
            return
        cid, name = cmd.get("id"), cmd.get("cmd")
        repeat = cid in state["seen"]
        if not repeat:
            state["seen"] = (state["seen"] + [cid])[-8:]
            if name == "beep_on":
                state["beep_on"] = True
            elif name == "beep_off":
                state["beep_on"] = False
            elif name == "reset_baseline":
                state["baseline"] = None
        ok = name in db.COMMANDS
        ack = {"id": cid, "cmd": name, "ok": ok,
               "detail": ("repeat, already done" if repeat else f"{name} done") if ok else "unknown command",
               "beep_on": state["beep_on"], "baseline_cm": state["baseline"]}
        c.publish(f"{prefix}/{node}/ack", json.dumps(ack), qos=1)
        print(f"{node} got command {name} ({str(cid)[:8]}) -> ack ok={ok}")

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(host, port, keepalive=30)
    client.loop_start()
    for _ in range(50):                       # telemetry only after the status (boot_id) is out
        if state["connected"]:
            break
        time.sleep(0.1)

    seq = 0
    soil_list = [int(x) for x in args.soil_pct.split(",") if x.strip()]
    motion_at = {int(x) for x in args.motion_at.split(",") if x.strip()}

    def next_values() -> dict:
        """The next reading's values; the time is added when it is sent."""
        nonlocal seq
        seq += 1
        n = seq
        soil_raw = int(2300 + 200 * math.sin(time.time() / 300) + random.randint(-20, 20))
        if args.flood_at and n >= args.flood_at and not (args.flood_until and n >= args.flood_until):
            soil_raw = random.randint(1420, 1480)            # ~98 % -> SATURATED
        if 1 <= n <= len(soil_list):                         # raw for an exact percentage
            soil_raw = 4095 - (soil_list[n - 1] * 2695 + 99) // 100
        rain_raw = random.choice([4095, 4095, 4095, 3200])
        if args.rain_at and n >= args.rain_at:
            rain_raw = random.randint(2100, 2300)            # ~70 % -> HEAVY
        dist = round(state["dist"] + random.uniform(-0.3, 0.3), 1)
        if args.move_at and n >= args.move_at:
            dist = round(dist + 25, 1)                       # knocked over -> MOVED
        if state["baseline"] is None:
            state["baseline"] = dist
        return {"seq": n, "temp_c": round(28 + random.uniform(-0.5, 0.5), 1), "hum_pct": random.randint(70, 80),
                "soil_raw": soil_raw, "rain_raw": rain_raw, "dist_cm": dist, "baseline_cm": state["baseline"],
                "rssi": random.randint(-70, -55), "motion": int(n in motion_at)}

    try:
        sent, before = 0, set()
        while args.count == 0 or sent < args.count:
            v = next_values()
            now_states = set(db.conditions(db.derive(v, cal))) & EVENT_STATES
            started = sorted(now_states - before)
            before = now_states
            if sent:                                         # the first reading goes straight away
                time.sleep(args.event_gap if started else args.interval)
            frame = db.encode_frame(v["seq"], 0 if args.no_clock else int(time.time()), v["temp_c"],
                                    v["hum_pct"], v["soil_raw"], v["rain_raw"], v["dist_cm"], v["baseline_cm"],
                                    v["rssi"], state["beep_on"], motion=bool(v["motion"]))
            client.publish(t_tele, frame, qos=0)
            sent += 1
            why = f"at once: {', '.join(started)}" if started else "routine"
            print(f"{node} sent reading #{v['seq']} ({db.FRAME_SIZE} bytes, {why})")
    except KeyboardInterrupt:
        pass
    finally:
        client.publish(t_status, json.dumps({"online": False, "boot_id": boot_id}, separators=(",", ":")),
                       qos=1, retain=True)
        time.sleep(0.5)
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
