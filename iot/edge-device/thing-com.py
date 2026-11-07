#!/usr/bin/env python3
"""
thing-com.py - thing <-> edge over WiFi, MQTT

  thing -> edge   field/<node_id>/telemetry   binary: one 21-byte frame per message, a routine
                                              one every 60 s and one at once when a condition
                                              starts (motion, moved, no echo, saturated soil,
                                              heavy rain; at most every 5 s). Readings the node
                                              held while the edge was unreachable arrive late,
                                              in order, with their own ts
                  field/<node_id>/status      {"online": true/false, "boot_id": N} (retained, last will)
                  field/<node_id>/info        {"boot_id": N, "lat": .., "lon": ..} once per power-up (retained)
                  field/<node_id>/ack         JSON reply to a command
  edge -> thing   field/<node_id>/cmd         {"id": "...", "cmd": "beep_on" | "beep_off" | "reset_baseline"}

What it does
  * decodes every frame, takes node_id from the topic and boot_id from the
    node's last status message, and stores the raw values in SQLite (edge.db)
    with is_sent = 0
  * stores each power-up's position (info message) once, for upload to Supabase
  * quick alerts: works out soil %, rain % and the states from the raw values
    (calibration and alert settings from Supabase). When alert_confirm_readings
    readings in a row show an alert condition (motion_confirm_readings for MOTION,
    the PIR sensor; both 1 by default, since the node already sends at once when a
    condition starts and debounces it itself), those readings are marked urgent and
    cloud-com.py uploads them at once, first in line. The same condition on the same
    node does that again only after quick_window_s. Supabase decides the alerts
    themselves; the edge only makes sure the readings get there fast
  * sends commands that cloud-com.py fetched from Supabase down to the thing,
    resends them every 20 s until the thing acknowledges, and records the reply

Run:   python3 thing-com.py [--config /opt/iot-edge/config.toml]
       python3 thing-com.py --watch      (only print every MQTT message, store nothing)
Stop:  Ctrl+C (or: sudo systemctl stop thing-com)
"""

from __future__ import annotations

import json
import re
import signal
import sys
import threading
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

import edge_db as db

log = db.setup_logging("thing-com")

NODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
EARLIEST_DEVICE_TIME = 1704067200          # 2024-01-01: anything older means "clock not set"


def fmt(v, unit="", digits=1):
    return "-" if v is None else (f"{v:.{digits}f}{unit}" if isinstance(v, float) else f"{v}{unit}")


def describe(row: dict, d: dict) -> str:
    """One log line: raw value -> worked-out value and state."""
    return (f"{fmt(row['temp_c'], 'C')} {fmt(row['hum_pct'], '%', 0)}  "
            f"soil {fmt(row['soil_raw'])}={fmt(d['soil_pct'], '%')} {d['soil_state'] or '-'}  "
            f"rain {fmt(row['rain_raw'])}={fmt(d['rain_pct'], '%')} {d['rain_state'] or '-'}  "
            f"dist {fmt(row['dist_cm'], 'cm')} {d['dist_state']}  "
            f"beep {'on' if row['beep_on'] else 'off' if row['beep_on'] == 0 else '-'}  rssi {fmt(row['rssi'], 'dBm')}"
            f"{'  MOTION' if row.get('motion') else ''}")


# ----------------------------------------------------------------- quick alerts
class QuickAlerts:
    """Which readings go up at once.

    A condition (SATURATED, HEAVY, ...) in the node's alert types that shows in
    `confirm` readings in a row triggers a quick alert: those readings are marked
    urgent. The same condition on the same node triggers one again only when the
    window has passed since the last one (timed on the readings' own clock).
    """

    def __init__(self, window_s: int):
        self.window_s = window_s
        self.runs: dict[tuple[str, str], list[tuple[int, int]]] = {}   # (node, type) -> [(boot_id, seq), ...]
        self.last: dict[tuple[str, str], float] = {}                   # (node, type) -> epoch of last quick alert

    def restore(self, con):
        for r in con.execute("SELECT node_id, type, last_ts FROM quick_alerts"):
            self.last[(r["node_id"], r["type"])] = db.epoch(r["last_ts"])

    def process(self, con, node: str, boot_id: int, row: dict, d: dict, cal: dict) -> tuple[list[str], list[str]]:
        """-> (alert conditions in this reading, conditions that trigger a quick alert now)."""
        types = cal["alert_types"]
        conds = [c for c in db.conditions(d) if c in types]
        fired = []
        ts = db.epoch(row["ts"])
        for kind in types:
            key, confirm = (node, kind), db.confirm_for(kind, cal)
            if kind not in conds:
                self.runs.pop(key, None)
                continue
            run = (self.runs.get(key, []) + [(boot_id, row["seq"])])[-confirm:]
            self.runs[key] = run
            if len(run) < confirm:
                continue
            last = self.last.get(key)
            if last is not None and ts - last < self.window_s:
                continue
            for b, s in run:                                 # these go up at once, first in line
                con.execute("UPDATE readings SET urgent = CASE WHEN urgent IS NULL THEN ? ELSE urgent || ',' || ? END "
                            "WHERE node_id = ? AND boot_id = ? AND seq = ? AND is_sent = 0",
                            (kind, kind, node, b, s))
            con.execute("INSERT INTO quick_alerts (node_id, type, last_ts) VALUES (?, ?, ?) "
                        "ON CONFLICT (node_id, type) DO UPDATE SET last_ts = excluded.last_ts", (node, kind, row["ts"]))
            self.last[key] = ts
            self.runs.pop(key, None)
            fired.append(kind)
        return conds, fired


# ----------------------------------------------------------------- service
class ThingCom:
    def __init__(self, cfg: dict, watch_only: bool = False):
        self.cfg = cfg
        self.watch_only = watch_only
        m = cfg["mqtt"]
        self.prefix = m.get("topic_prefix", "field")
        self.resend_after_s = int(cfg["commands"].get("resend_after_s", 20))
        self.default_cal = cfg["calibration"]
        self.quick = QuickAlerts(cfg["alerts"]["quick_window_s"])
        self.online: dict[str, bool] = {}          # node_id -> last status message
        self.boot_ids: dict[str, int] = {}         # node_id -> boot_id from its status message
        self._local = threading.local()            # one SQLite connection per thread
        self.stop = threading.Event()

        suffix = "watch" if watch_only else cfg["edge_id"]
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                  client_id=f"thing-com-{suffix}", clean_session=True)
        if m.get("username"):
            self.client.username_pw_set(m["username"], m.get("password", ""))
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)

    # one connection per thread (paho's network thread + the main loop)
    @property
    def con(self):
        c = getattr(self._local, "con", None)
        if c is None:
            c = self._local.con = db.connect(self.cfg["db_path"])
        return c

    # ------------------------------------------------------------- MQTT callbacks
    def on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            log.error("MQTT broker refused the connection: %s (check [mqtt] username in config.toml and "
                      "mqtt_password in secrets.toml)", reason_code)
            return
        # status first: its retained message (with the boot_id) must arrive before telemetry
        topics = [f"{self.prefix}/#"] if self.watch_only else [
            f"{self.prefix}/+/status", f"{self.prefix}/+/info", f"{self.prefix}/+/telemetry", f"{self.prefix}/+/ack"]
        for t in topics:
            client.subscribe(t, qos=1)
        log.info("connected to MQTT %s:%s, listening on %s",
                 self.cfg["mqtt"].get("host", "localhost"), self.cfg["mqtt"].get("port", 1883), ", ".join(topics))

    def on_disconnect(self, client, userdata, flags, reason_code, properties):
        if not self.stop.is_set():
            log.warning("MQTT disconnected (%s), reconnecting...", reason_code)

    def on_message(self, client, userdata, msg):
        if self.watch_only:
            return self.print_message(msg)
        parts = msg.topic.split("/")
        if len(parts) != 3 or not NODE_RE.match(parts[1]):
            log.warning("ignored message on unexpected topic %s", msg.topic)
            return
        node, kind = parts[1], parts[2]
        try:
            if kind == "telemetry":
                self.handle_telemetry(node, msg.payload)
                return
            try:
                data = json.loads(msg.payload)
            except (ValueError, UnicodeDecodeError):
                log.warning("%s: %s message is not valid JSON: %r", node, kind, msg.payload[:200])
                return
            if kind == "status":
                self.handle_status(node, data)
            elif kind == "info":
                self.handle_info(node, data)
            elif kind == "ack":
                self.handle_ack(node, data)
        except Exception:                      # never let one bad message kill the service
            log.exception("%s: failed to handle %s message", node, kind)

    def print_message(self, msg):
        p = msg.payload
        if msg.topic.endswith("/telemetry"):
            try:
                v, _ = db.decode_frame(db.check_message(p))
                print(f"{db.now_iso()}  {msg.topic}  {p.hex(' ')}   seq {v['seq']} ts {v['ts_epoch']} "
                      f"temp {fmt(v['temp_c'])} hum {fmt(v['hum_pct'])} soil_raw {v['soil_raw']} "
                      f"rain_raw {v['rain_raw']} dist {fmt(v['dist_cm'])} base {fmt(v['baseline_cm'])} "
                      f"rssi {fmt(v['rssi'])} beep {v['beep_on']} motion {v['motion']}", flush=True)
            except ValueError as e:
                print(f"{db.now_iso()}  {msg.topic}  {len(p)} bytes: {e}  {p.hex()}", flush=True)
            return
        print(f"{db.now_iso()}  {msg.topic}  {p.decode(errors='replace')}", flush=True)

    # ------------------------------------------------------------- handlers
    def handle_telemetry(self, node: str, payload: bytes):
        received_at = db.now_iso()
        boot_id = self.boot_ids.get(node)
        if boot_id is None:
            log.warning("%s: %d-byte reading ignored: no status message with a boot_id from this node yet",
                        node, len(payload))
            return
        try:
            v, problems = db.decode_frame(db.check_message(payload))
        except ValueError as e:
            log.warning("%s: telemetry rejected: %s", node, e)
            return
        for p in problems:
            log.warning("%s: #%s: %s", node, v["seq"], p)

        # Measurement time: the ESP32's NTP clock if it had one, otherwise arrival time.
        ts_epoch = v.pop("ts_epoch")
        if EARLIEST_DEVICE_TIME <= ts_epoch <= time.time() + 86400:
            ts, ts_source = db.iso(datetime.fromtimestamp(ts_epoch, timezone.utc)), "device"
        else:
            ts, ts_source = received_at, "edge"
        row = {"node_id": node, "boot_id": boot_id, **v, "ts": ts, "ts_source": ts_source, "received_at": received_at}
        cal = db.calibration_for(self.con, node, self.default_cal)
        d = db.derive(v, cal)
        con = self.con
        con.execute("BEGIN IMMEDIATE")
        try:
            cols = list(row)
            cur = con.execute(
                f"INSERT OR IGNORE INTO readings ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                [row[c] for c in cols])
            if cur.rowcount == 0:
                con.execute("COMMIT")
                log.info("%s: duplicate reading boot %s #%s ignored", node, boot_id, v["seq"])
                return
            rid = cur.lastrowid
            conds, fired = self.quick.process(con, node, boot_id, row, d, cal)
            if conds:
                con.execute("UPDATE readings SET alert = ? WHERE id = ?", (",".join(conds), rid))
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
        log.info("%s #%s  %s", node, row["seq"], describe(row, d))
        for kind in fired:
            log.warning("QUICK ALERT %s %s (%d reading(s) in a row up to #%s) -> uploading to Supabase now",
                        node, kind, db.confirm_for(kind, cal), row["seq"])

    def handle_info(self, node: str, data):
        """Once per power-up: the node's position from the sketch. Stored once, uploaded once."""
        if not isinstance(data, dict):
            return
        boot_id = data.get("boot_id")
        if isinstance(boot_id, bool) or not isinstance(boot_id, int) or not 0 <= boot_id <= 0xFFFFFFFF:
            log.warning("%s: info message without a valid boot_id: %r", node, data)
            return

        def coord(name, limit):
            v = data.get(name)
            if v is None:
                return None
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not -limit <= v <= limit:
                log.warning("%s: %s=%r is not a coordinate, stored as empty", node, name, v)
                return None
            return float(v)

        lat, lon = coord("lat", 90), coord("lon", 180)
        cur = self.con.execute("INSERT OR IGNORE INTO boots (node_id, boot_id, lat, lon, received_at) "
                               "VALUES (?, ?, ?, ?, ?)", (node, boot_id, lat, lon, db.now_iso()))
        if cur.rowcount:
            log.info("%s power-up %s at %s", node, boot_id,
                     f"{lat:.6f}, {lon:.6f}" if lat is not None and lon is not None else "no position set")

    def handle_status(self, node: str, data: dict):
        online = bool(data.get("online")) if isinstance(data, dict) else False
        boot_id = data.get("boot_id") if isinstance(data, dict) else None
        if not (isinstance(boot_id, int) and not isinstance(boot_id, bool) and 0 <= boot_id <= 0xFFFFFFFF):
            boot_id = None
        if self.online.get(node) != online:
            log.info("%s is %s%s", node, "ONLINE" if online else "OFFLINE",
                     f" (boot_id {boot_id})" if boot_id is not None else "")
        self.online[node] = online
        if boot_id is not None:
            if self.boot_ids.get(node) not in (None, boot_id):
                log.info("%s restarted: boot_id %s -> %s", node, self.boot_ids[node], boot_id)
            self.boot_ids[node] = boot_id
        self.con.execute(
            "INSERT INTO nodes (node_id, boot_id, online, status_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (node_id) DO UPDATE SET boot_id = COALESCE(excluded.boot_id, nodes.boot_id), "
            "online = excluded.online, status_at = excluded.status_at",
            (node, boot_id, int(online), db.now_iso()))
        if online:
            # resend any open command straight away instead of waiting for the timer
            self.con.execute("UPDATE commands SET last_publish_at = NULL "
                             "WHERE node_id = ? AND status IN ('at_edge', 'sent')", (node,))

    def handle_ack(self, node: str, data: dict):
        cmd_id = data.get("id") if isinstance(data, dict) else None
        if not isinstance(cmd_id, str):
            log.warning("%s: ack without a command id: %r", node, data)
            return
        ok = data.get("ok") is True
        detail = data.get("detail") or ("ok" if ok else "failed")
        state = []
        for key in ("beep_on", "baseline_cm"):
            if key in data:
                state.append(f"{key}={json.dumps(data[key])}")
        result = detail + (f" ({', '.join(state)})" if state else "")
        now = db.now_iso()
        cur = self.con.execute(
            "UPDATE commands SET status = ?, done_at = ?, result = ?, updated_at = ?, is_synced = 0 "
            "WHERE id = ? AND node_id = ? AND status IN ('at_edge', 'sent')",
            ("done" if ok else "failed", now, result[:300], now, cmd_id, node))
        if cur.rowcount:
            log.info("%s acknowledged command %s: %s", node, cmd_id[:8], result)

    # ------------------------------------------------------------- commands down
    def publish_due_commands(self):
        now = db.now_iso()
        con = self.con
        expired = con.execute(
            "UPDATE commands SET status = 'expired', done_at = ?, result = 'expired before the thing acknowledged it', "
            "updated_at = ?, is_synced = 0 WHERE status IN ('at_edge', 'sent') AND expires_at < ?",
            (now, now, now)).rowcount
        if expired:
            log.warning("%d command(s) expired without an acknowledgement", expired)

        resend_before = db.iso_ago(seconds=self.resend_after_s)
        due = con.execute(
            "SELECT id, node_id, command FROM commands WHERE status IN ('at_edge', 'sent') "
            "AND (last_publish_at IS NULL OR last_publish_at < ?) ORDER BY created_at",
            (resend_before,)).fetchall()
        for c in due:
            if self.online.get(c["node_id"]) is False:
                continue                       # wait until the thing says it is online again
            payload = json.dumps({"id": c["id"], "cmd": c["command"]}, separators=(",", ":"))
            info = self.client.publish(f"{self.prefix}/{c['node_id']}/cmd", payload, qos=1)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                log.warning("could not publish command %s (MQTT error %s)", c["id"][:8], info.rc)
                return
            con.execute(
                "UPDATE commands SET "
                "  is_synced = CASE WHEN status = 'sent' THEN is_synced ELSE 0 END, "
                "  status = 'sent', sent_at = COALESCE(sent_at, ?), publish_count = publish_count + 1, "
                "  last_publish_at = ?, updated_at = CASE WHEN status = 'sent' THEN updated_at ELSE ? END "
                "WHERE id = ? AND status IN ('at_edge', 'sent')",
                (now, now, now, c["id"]))
            log.info("sent command %s to %s (%s)", c["command"], c["node_id"], c["id"][:8])

    # ------------------------------------------------------------- main loop
    def run(self):
        m = self.cfg["mqtt"]
        host, port = m.get("host", "localhost"), int(m.get("port", 1883))
        if not self.watch_only:
            log.info("edge %s, database %s, quick alerts at most once per %ds per node and condition",
                     self.cfg["edge_id"], self.cfg["db_path"], self.quick.window_s)
            for r in self.con.execute("SELECT node_id, boot_id FROM nodes WHERE boot_id IS NOT NULL"):
                self.boot_ids[r["node_id"]] = r["boot_id"]
            self.quick.restore(self.con)
        self.client.connect_async(host, port, keepalive=30)
        self.client.loop_start()
        try:
            while not self.stop.is_set():
                if not self.watch_only and self.client.is_connected():
                    try:
                        self.publish_due_commands()
                    except Exception:
                        log.exception("command publishing failed")
                self.stop.wait(1.0)
        finally:
            self.client.disconnect()
            self.client.loop_stop()
            log.info("stopped")


def main():
    cfg = db.load_config(db.config_path_from_args(sys.argv))
    svc = ThingCom(cfg, watch_only="--watch" in sys.argv)

    def _stop(signum, frame):
        svc.stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    svc.run()


if __name__ == "__main__":
    main()
