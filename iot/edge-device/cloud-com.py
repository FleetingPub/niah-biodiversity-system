#!/usr/bin/env python3
"""
cloud-com.py - edge <-> cloud (Supabase) over HTTPS, gzip-compressed JSON

Every 60 s (upload_interval_s) it:
  1. takes up to 500 readings with is_sent = 0 from edge.db (quick-alert readings first, then oldest)
  2. adds command status changes and power-up positions Supabase does not have yet
  3. POSTs them as one compact, gzip-compressed batch to the edge-com Edge Function:
     raw values only, node_id and boot_id once per group, each reading as an array
  4. if the POST goes through without an error (HTTP 2xx), marks all of it as sent;
     the reply carries nothing about the readings, only new commands and changed
     calibration / alert settings, when there are any

Quick alerts: every 0.5 s it checks for readings thing-com.py marked `urgent`.
They are uploaded at once, without waiting for the interval; while the upload
fails they are retried every urgent_retry_s.

If the internet is down nothing is lost: rows stay is_sent = 0 and go in the next
batch. After an outage the backlog is sent in back-to-back batches. If an upload
reached Supabase but the edge saw an error, the edge sends it again and Supabase
skips the readings it already has.

If Supabase refuses a batch as malformed (HTTP 400 or 422), sending it again would
get the same answer and hold up everything behind it. So the batch is set aside:
its readings stay in edge.db (table `rejected`, kept for retention_days) but are
left out of uploads, and the next batch goes. `--requeue` puts them back in line.

Run:     python3 cloud-com.py [--config /opt/iot-edge/config.toml]
Other:   --once                 do one upload now, print what was sent and received, exit
         --status               show what is waiting in edge.db
         --alerts               show the latest quick alerts at this edge
         --requeue              put readings from refused batches back in the upload queue
         --register-sql         print the SQL that registers this edge in Supabase
"""

from __future__ import annotations

import gzip
import json
import signal
import sys
import threading
import time

import requests

import edge_db as db

log = db.setup_logging("cloud-com")

PLACEHOLDER_MARKERS = ("YOUR_PROJECT_REF", "PASTE", "CHANGE_ME")
URGENT_POLL_S = 0.5

# Order of the values in each uploaded reading (must match ROW_FIELDS in edge-com).
#   lag = seconds from measurement to arrival at the edge; null = ts is the edge's arrival time
ROW_FIELDS = ["seq", "ts", "lag", "temp_c", "hum_pct", "soil_raw", "rain_raw",
              "dist_cm", "baseline_cm", "beep_on", "rssi", "motion"]
SELECT_READINGS = ("SELECT id, node_id, boot_id, seq, ts, ts_source, received_at, "
                   f"{', '.join(db.RAW_FIELDS)}, urgent FROM readings ")
# Readings waiting to go up: not sent, and not in a batch Supabase refused
QUEUED = "is_sent = 0 AND id NOT IN (SELECT reading_id FROM rejected)"
REFUSED_STATUSES = (400, 422)   # the batch itself is wrong; sending it again won't help


def is_placeholder(value: str | None) -> bool:
    return not value or any(m in value for m in PLACEHOLDER_MARKERS)


def compact(v):
    """65.0 -> 65 (shorter JSON); everything else unchanged."""
    return int(v) if isinstance(v, float) and v.is_integer() else v


def to_row(r) -> list:
    ts = int(db.epoch(r["ts"]))
    lag = None if r["ts_source"] == "edge" else max(0, int(db.epoch(r["received_at"]) - ts))
    return [r["seq"], ts, lag] + [compact(r[f]) for f in db.RAW_FIELDS]


class CloudCom:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        c = cfg["cloud"]
        self.edge_id = cfg["edge_id"]
        self.url = c.get("function_url", "")
        self.edge_key = c.get("edge_key", "")
        self.anon_key = c.get("anon_key", "")
        self.interval_s = int(c.get("upload_interval_s", 60))
        self.urgent_retry_s = int(c.get("urgent_retry_s", 10))
        self.batch_size = max(1, min(int(c.get("batch_size", 500)), 1000))
        self.retention_days = int(c.get("retention_days", 30))
        self.timeout_s = int(c.get("timeout_s", 20))
        self.gzip = bool(c.get("gzip", True))
        self.con = db.connect(cfg["db_path"])
        self.http = requests.Session()
        self.stop = threading.Event()
        self.bytes_up = self.bytes_down = 0          # body bytes since start, for the log
        self.refused = False                         # the last upload was refused and set aside

    # ------------------------------------------------------------- one upload
    def headers(self) -> dict:
        h = {"Content-Type": "application/json", "x-edge-key": self.edge_key,
             "User-Agent": "iot-edge", "Accept-Encoding": "gzip"}
        if self.gzip:
            h["Content-Encoding"] = "gzip"
        if self.anon_key:   # only needed if JWT verification is left ON for edge-com
            h["apikey"] = self.anon_key
            h["Authorization"] = f"Bearer {self.anon_key}"
        return h

    def urgent_waiting(self) -> bool:
        return self.con.execute(
            f"SELECT 1 FROM readings WHERE {QUEUED} AND urgent IS NOT NULL LIMIT 1").fetchone() is not None

    def build_batch(self):
        # quick-alert readings first (they may sit behind a long backlog), then the oldest
        rows = self.con.execute(SELECT_READINGS + f"WHERE {QUEUED} AND urgent IS NOT NULL ORDER BY id LIMIT ?",
                                (self.batch_size,)).fetchall()
        rows += self.con.execute(SELECT_READINGS + f"WHERE {QUEUED} AND urgent IS NULL ORDER BY id LIMIT ?",
                                 (self.batch_size - len(rows),)).fetchall()
        groups: dict[tuple[str, int], dict] = {}
        for r in rows:
            g = groups.setdefault((r["node_id"], r["boot_id"]),
                                  {"node_id": r["node_id"], "boot_id": r["boot_id"], "rows": []})
            g["rows"].append(to_row(r))

        boots = self.con.execute("SELECT node_id, boot_id, lat, lon, received_at FROM boots "
                                 "WHERE is_sent = 0 ORDER BY received_at LIMIT 100").fetchall()
        cmds = self.con.execute(
            "SELECT id, status, at_edge_at, sent_at, done_at, result, updated_at "
            "FROM commands WHERE is_synced = 0 ORDER BY updated_at LIMIT 200").fetchall()
        updates = [{k: c[k] for k in ("id", "status", "at_edge_at", "sent_at", "done_at", "result")
                    if c[k] is not None} for c in cmds]

        body = {"edge_id": self.edge_id}
        if groups:
            body["nodes"] = list(groups.values())
        if boots:
            body["boots"] = [{"node_id": b["node_id"], "boot_id": b["boot_id"], "lat": b["lat"], "lon": b["lon"],
                              "at": b["received_at"]} for b in boots]
        if updates:
            body["command_updates"] = updates
        body["cal_since"] = self.con.execute("SELECT COALESCE(MAX(version), 0) FROM calibration").fetchone()[0]
        return body, rows, boots, {c["id"]: c["updated_at"] for c in cmds}

    def sync_once(self, verbose: bool = False) -> tuple[bool, bool]:
        """Returns (succeeded, more_waiting). A refused batch counts as done (it is set aside)."""
        self.refused = False
        body, rows, boots, update_versions = self.build_batch()
        urgent = [r for r in rows if r["urgent"]]
        data = json.dumps(body, separators=(",", ":")).encode()
        wire = gzip.compress(data, compresslevel=9, mtime=0) if self.gzip else data
        t0 = time.monotonic()
        try:
            resp = self.http.post(self.url, data=wire, headers=self.headers(), timeout=self.timeout_s)
        except requests.RequestException as e:
            log.warning("upload failed, will retry: %s (%d readings waiting in this batch%s)",
                        e.__class__.__name__, len(rows), ", including a QUICK ALERT" if urgent else "")
            return False, False
        took = time.monotonic() - t0
        down = len(resp.content)
        self.bytes_up += len(wire)
        self.bytes_down += down

        reply = {}
        if resp.content:
            try:
                reply = resp.json()
            except ValueError:
                reply = {"error": resp.text[:200]}
        if verbose:
            # HTTP/1.1 header sizes as they go over the (TLS) connection, for the data budget
            req_hdr = len(f"POST {resp.request.path_url} HTTP/1.1\r\n\r\n") + sum(
                len(k) + len(v) + 4 for k, v in resp.request.headers.items()) + len(f"Host: {resp.url.split('/')[2]}\r\n")
            resp_hdr = len(f"HTTP/1.1 {resp.status_code} {resp.reason}\r\n\r\n") + sum(
                len(k) + len(v) + 4 for k, v in resp.raw.headers.items())
            print(f"sent {len(wire)} bytes ({len(data)} before gzip) + ~{req_hdr} bytes of request "
                  f"headers in {took:.2f} s\nreply HTTP {resp.status_code}: {down} bytes + ~{resp_hdr} bytes of "
                  f"headers{': ' + json.dumps(reply) if reply else ''}")
        if resp.status_code in REFUSED_STATUSES:
            reason = reply.get("error", reply) if isinstance(reply, dict) else reply
            self.set_aside(resp.status_code, str(reason), rows, boots, update_versions)
            return True, False                 # carry on with the next batch at the normal interval
        if not 200 <= resp.status_code < 300:
            hint = ""
            if resp.status_code == 401:
                hint = (" -> check edge_id and edge_key in secrets.toml match the device and its token on "
                        "the Devices page, that the device is turned on, and that JWT verification is OFF "
                        "for edge-com")
            elif resp.status_code == 429:
                hint = (" -> this device has sent more than its readings for the last hour "
                        "(supabase/022_iot_reading_limit.sql); they're kept and sent again later")
            elif resp.status_code == 404:
                hint = " -> check supabase_function_url in secrets.toml (function name edge-com deployed?)"
            log.error("Supabase replied HTTP %s: %s%s", resp.status_code, reply.get("error", reply), hint)
            return False, False

        # No error: everything in this batch is sent.
        now = db.now_iso()
        self.con.execute("BEGIN IMMEDIATE")
        try:
            self.con.executemany("UPDATE readings SET is_sent = 1, sent_at = ? WHERE id = ?",
                                 [(now, r["id"]) for r in rows])
            self.con.executemany("UPDATE boots SET is_sent = 1 WHERE node_id = ? AND boot_id = ?",
                                 [(b["node_id"], b["boot_id"]) for b in boots])
            # Mark command updates as reported, unless thing-com changed them meanwhile.
            self.con.executemany(
                "UPDATE commands SET is_synced = 1, synced_at = ? WHERE id = ? AND updated_at = ?",
                [(now, cid, ver) for cid, ver in update_versions.items()])
            new_cmds = self.store_new_commands(reply.get("commands", []), now)
            new_cal = self.store_calibration(reply.get("calibration", []), now)
            self.con.execute("COMMIT")
        except Exception:
            self.con.execute("ROLLBACK")
            raise

        for kind in sorted({k for r in urgent for k in r["urgent"].split(",")}):
            first = min(db.epoch(r["received_at"]) for r in urgent if kind in r["urgent"].split(","))
            log.warning("QUICK ALERT %s sent to Supabase %.1f s after its first reading reached the edge",
                        kind, db.epoch(now) - first)
        if rows or boots or body.get("command_updates") or new_cmds or new_cal:
            log.info("uploaded %d readings, %d power-up positions, %d command updates; %d new commands%s "
                     "- %d bytes up (%d before gzip), %d down, %.2f s",
                     len(rows), len(boots), len(body.get("command_updates", [])), new_cmds,
                     f", calibration for {new_cal} node(s)" if new_cal else "", len(wire), len(data), down, took)
        return True, len(rows) >= self.batch_size

    def set_aside(self, status: int, reason: str, rows, boots, update_versions: dict):
        """Supabase refused this batch as malformed. Take it out of the queue so the rest can go."""
        self.refused = True
        now = db.now_iso()
        self.con.execute("BEGIN IMMEDIATE")
        try:
            self.con.executemany(
                "INSERT OR IGNORE INTO rejected (reading_id, rejected_at, http_status, reason) VALUES (?, ?, ?, ?)",
                [(r["id"], now, status, reason[:300]) for r in rows])
            # The positions and command updates in it could be what Supabase objects to, so they
            # leave the queue too; otherwise every following batch would be refused with them.
            self.con.executemany("UPDATE boots SET is_sent = 1 WHERE node_id = ? AND boot_id = ?",
                                 [(b["node_id"], b["boot_id"]) for b in boots])
            self.con.executemany(
                "UPDATE commands SET is_synced = 1, synced_at = ? WHERE id = ? AND updated_at = ?",
                [(now, cid, ver) for cid, ver in update_versions.items()])
            self.con.execute("COMMIT")
        except Exception:
            self.con.execute("ROLLBACK")
            raise
        extra = []
        if boots:
            extra.append(f"{len(boots)} power-up position(s)")
        if update_versions:
            extra.append(f"{len(update_versions)} command update(s)")
        log.error("Supabase refused the batch (HTTP %s: %s). Set aside %d readings so the ones behind them can "
                  "go; they stay in edge.db (iot-edge status) and `iot-edge requeue` puts them back.%s",
                  status, reason[:200], len(rows),
                  f" Not delivered either: {' and '.join(extra)}." if extra else "")

    def store_new_commands(self, commands: list, now: str) -> int:
        added = 0
        for c in commands:
            if (not isinstance(c, dict) or c.get("command") not in db.COMMANDS
                    or not isinstance(c.get("id"), str) or not isinstance(c.get("node_id"), str)):
                log.warning("ignored malformed command from Supabase: %r", c)
                continue
            cur = self.con.execute(
                "INSERT OR IGNORE INTO commands (id, node_id, command, created_at, expires_at, status, "
                "at_edge_at, updated_at, is_synced) VALUES (?, ?, ?, ?, ?, 'at_edge', ?, ?, 0)",
                (c["id"], c["node_id"], c["command"], c.get("created_at") or now,
                 c.get("expires_at") or db.iso_ago(seconds=-3600), now, now))
            if cur.rowcount:
                added += 1
                log.info("new command from Supabase: %s for %s (%s)", c["command"], c["node_id"], c["id"][:8])
        return added

    def store_calibration(self, items: list, now: str) -> int:
        stored = 0
        for c in items:
            try:
                values = [c["node_id"]] + [float(c[f]) if f.endswith("_cm") else int(c[f]) for f in db.CAL_FIELDS]
                types = c["alert_types"]
                if not isinstance(types, list) or not set(types) <= db.ALERT_TYPES:
                    raise ValueError(types)
                values += [",".join(types), int(c["v"]), now]
            except (KeyError, TypeError, ValueError):
                log.warning("ignored malformed calibration from Supabase: %r", c)
                continue
            cols = ["node_id"] + db.CAL_FIELDS + ["alert_types", "version", "received_at"]
            self.con.execute(f"INSERT OR REPLACE INTO calibration ({', '.join(cols)}) "
                             f"VALUES ({', '.join('?' * len(cols))})", values)
            stored += 1
            log.info("calibration for %s from Supabase (version %s): %s, alert_types=%s", c["node_id"], c["v"],
                     ", ".join(f"{f}={c[f]}" for f in db.CAL_FIELDS), ",".join(types))
        return stored

    # ------------------------------------------------------------- housekeeping
    def purge(self):
        cutoff = db.iso_ago(days=self.retention_days)
        n = self.con.execute("DELETE FROM readings WHERE is_sent = 1 AND sent_at < ?", (cutoff,)).rowcount
        m = self.con.execute(
            "DELETE FROM commands WHERE is_synced = 1 AND status IN ('done', 'failed', 'expired') "
            "AND updated_at < ?", (cutoff,)).rowcount
        k = self.con.execute("DELETE FROM readings WHERE id IN "
                             "(SELECT reading_id FROM rejected WHERE rejected_at < ?)", (cutoff,)).rowcount
        self.con.execute("DELETE FROM rejected WHERE rejected_at < ?", (cutoff,))
        if n or m or k:
            log.info("housekeeping: deleted %d sent readings, %d refused readings and %d finished commands "
                     "older than %d days", n, k, m, self.retention_days)

    # ------------------------------------------------------------- main loop
    def check_config(self):
        if is_placeholder(self.url):
            sys.exit("Set supabase_function_url in secrets.toml first "
                     "(https://<project-ref>.supabase.co/functions/v1/edge-com)")
        if is_placeholder(self.edge_key) or len(self.edge_key) < 16:
            sys.exit("Set edge_key in secrets.toml first (see: cloud-com.py --register-sql)")

    def run(self):
        self.check_config()
        log.info("edge %s (position %s) uploading to %s every %ds (batches of up to %d, gzip %s); "
                 "quick alerts at once", self.edge_id,
                 db.format_position(self.cfg["edge"]["lat"], self.cfg["edge"]["lon"]),
                 self.url, self.interval_s, self.batch_size, "on" if self.gzip else "off")
        backoff = self.interval_s
        next_regular = next_urgent = time.monotonic()
        last_purge = 0.0
        while not self.stop.is_set():
            now = time.monotonic()
            urgent = now >= next_urgent and self.urgent_waiting()
            if urgent or now >= next_regular:
                try:
                    ok, more = self.sync_once()
                except Exception:
                    log.exception("unexpected error during upload")
                    ok, more = False, False
                now = time.monotonic()
                if ok:
                    backoff = self.interval_s
                    next_regular = now + (1 if more else self.interval_s)   # catch up quickly after an outage
                    next_urgent = now
                else:
                    next_regular = now + backoff
                    backoff = min(backoff * 2, 300)            # 60 s, 120 s, 240 s, then every 5 min
                    next_urgent = now + self.urgent_retry_s    # a quick alert keeps trying more often
                if now - last_purge > 3600:
                    self.purge()
                    last_purge = now
            self.stop.wait(URGENT_POLL_S)
        log.info("stopped (this run: %d bytes up, %d bytes down, HTTP bodies only)", self.bytes_up, self.bytes_down)


# ----------------------------------------------------------------- CLI extras
def print_status(cfg: dict):
    con = db.connect(cfg["db_path"])
    q = lambda sql, *a: con.execute(sql, a).fetchone()[0]
    total = q("SELECT COUNT(*) FROM readings")
    sent = q("SELECT COUNT(*) FROM readings WHERE is_sent = 1")
    waiting = q(f"SELECT COUNT(*) FROM readings WHERE {QUEUED}")
    urgent = q(f"SELECT COUNT(*) FROM readings WHERE {QUEUED} AND urgent IS NOT NULL")
    refused = q("SELECT COUNT(*) FROM rejected")
    print(f"Edge {cfg['edge_id']}   position {db.format_position(cfg['edge']['lat'], cfg['edge']['lon'])}"
          f"   database {cfg['db_path']}")
    print(f"Readings : {total} stored, {sent} sent, {waiting} waiting to send ({urgent} quick-alert readings)")
    if refused:
        last = con.execute("SELECT rejected_at, http_status, reason FROM rejected "
                           "ORDER BY rejected_at DESC LIMIT 1").fetchone()
        print(f"Refused  : {refused} readings set aside, last at {last['rejected_at']} "
              f"(HTTP {last['http_status']}: {last['reason']}); put back with: iot-edge requeue")
    print(f"Oldest waiting : {q(f'SELECT MIN(received_at) FROM readings WHERE {QUEUED}') or '-'}")
    print(f"Last sent      : {q('SELECT MAX(sent_at) FROM readings') or '-'}")
    open_cmds = q("SELECT COUNT(*) FROM commands WHERE status IN ('at_edge', 'sent')")
    unsynced = q("SELECT COUNT(*) FROM commands WHERE is_synced = 0")
    print(f"Commands : {open_cmds} open, {unsynced} status changes not yet reported to Supabase")
    for n in con.execute(
            "SELECT n.node_id, n.boot_id, n.online, c.version, b.lat, b.lon FROM nodes n "
            "LEFT JOIN calibration c USING (node_id) LEFT JOIN boots b ON b.node_id = n.node_id "
            "AND b.boot_id = n.boot_id ORDER BY n.node_id"):
        pos = db.format_position(n["lat"], n["lon"])
        print(f"Node {n['node_id']:8} boot_id {n['boot_id']}  {'online' if n['online'] else 'offline'}  "
              f"position {pos}  calibration "
              f"{'from Supabase v' + str(n['version']) if n['version'] else 'default (config.toml)'}")
    print("\nNewest readings (times in UTC; % and states worked out from the raw values):")
    print(f"  {'node':8} {'seq':>6}  {'ts':24} {'temp C':>6} {'hum %':>5}  {'soil raw':19} {'rain raw':15} "
          f"{'dist cm':13} {'alert':18} sent")
    dash = lambda v, f="{}": "-" if v is None else f.format(v)
    for r in con.execute("SELECT * FROM readings ORDER BY id DESC LIMIT 8"):
        d = db.derive(r, db.calibration_for(con, r["node_id"], cfg["calibration"]))
        soil = f"{dash(r['soil_raw'])} {dash(d['soil_pct'])}% {d['soil_state'] or '-'}"
        rain = f"{dash(r['rain_raw'])} {dash(d['rain_pct'])}% {d['rain_state'] or '-'}"
        dist = f"{dash(r['dist_cm'], '{:.1f}')} {d['dist_state']}"
        alert = (r["alert"] or "") + (" (quick)" if r["urgent"] else "")
        print(f"  {r['node_id']:8} {r['seq']:>6}  {r['ts']:24} {dash(r['temp_c'], '{:.1f}'):>6} "
              f"{dash(r['hum_pct'], '{:.0f}'):>5}  {soil:19} {rain:15} {dist:13} {alert:18} "
              f"{'yes' if r['is_sent'] else 'no'}")
    cmds = con.execute("SELECT * FROM commands ORDER BY updated_at DESC LIMIT 5").fetchall()
    if cmds:
        print("\nRecent commands:")
        for c in cmds:
            print(f"  {c['updated_at']}  {c['node_id']:8} {c['command']:15} {c['status']:8} {c['result'] or ''}")


def print_alerts(cfg: dict):
    con = db.connect(cfg["db_path"])
    rows = con.execute("SELECT node_id, seq, ts, urgent, received_at, is_sent, sent_at FROM readings "
                       "WHERE urgent IS NOT NULL ORDER BY id DESC LIMIT 15").fetchall()
    if not rows:
        print(f"No quick alerts yet (window {cfg['alerts']['quick_window_s']} s per node and condition)")
        return
    print(f"  {'node':8} {'seq':>6}  {'measured (UTC)':24} {'quick alert':18} {'reached the edge':24} sent to Supabase")
    for r in rows:
        sent = "waiting"
        if r["is_sent"]:
            sent = f"{r['sent_at']}  (+{db.epoch(r['sent_at']) - db.epoch(r['received_at']):.1f} s)"
        print(f"  {r['node_id']:8} {r['seq']:>6}  {r['ts']:24} {r['urgent']:18} {r['received_at']:24} {sent}")


def print_register_sql(cfg: dict):
    """How to register this edge in Supabase: the Devices page makes its token, its position is SQL."""
    edge_id = cfg["edge_id"]
    lat, lon = cfg["edge"]["lat"], cfg["edge"]["lon"]
    key = cfg["cloud"].get("edge_key", "")
    sql = lambda v: "null" if v is None else f"{v:.6f}"
    print(f"1. On the Devices page (as an admin), add a device with the ID  {edge_id}  and make its token.")
    print("   (Or change edge_id in secrets.toml to a device that's already there.)")
    if is_placeholder(key) or len(key) < 16:
        print("2. Paste the token into secrets.toml as  edge_key = \"...\"  (iot-edge secrets), then: iot-edge restart")
    else:
        print("2. secrets.toml has a token. If you made a new one, paste it there as  edge_key = \"...\"")
        print("   (iot-edge secrets), then: iot-edge restart")
    print("3. In the Devices page, link each sensor node of this region to the device; readings from a")
    print("   node that isn't linked are turned down.")
    print("4. This edge's position: paste into Supabase, SQL Editor -> New query -> Run")
    print("   (again after changing [edge] lat / lon in config.toml):")
    print(f"update public.iot_devices set latitude = {sql(lat)}, longitude = {sql(lon)} where device_id = '{edge_id}';")

def main():
    cfg = db.load_config(db.config_path_from_args(sys.argv))
    if "--status" in sys.argv:
        return print_status(cfg)
    if "--alerts" in sys.argv:
        return print_alerts(cfg)
    if "--register-sql" in sys.argv:
        return print_register_sql(cfg)
    if "--requeue" in sys.argv:
        con = db.connect(cfg["db_path"])
        n = con.execute("DELETE FROM rejected").rowcount
        print(f"{n} refused readings put back in the upload queue" if n else "No refused readings to put back")
        return

    svc = CloudCom(cfg)
    if "--once" in sys.argv:
        svc.check_config()
        ok, more = svc.sync_once(verbose=True)
        if svc.refused:
            print("upload REFUSED by Supabase: the batch was set aside (see message above)")
            sys.exit(1)
        print("upload OK" if ok else "upload FAILED (see message above)")
        sys.exit(0 if ok else 1)

    signal.signal(signal.SIGTERM, lambda s, f: svc.stop.set())
    signal.signal(signal.SIGINT, lambda s, f: svc.stop.set())
    svc.run()


if __name__ == "__main__":
    main()
