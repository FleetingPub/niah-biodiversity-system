"""
edge_db.py - shared code for thing-com.py and cloud-com.py

  * loads config.toml and merges in secrets.toml (keys, passwords, the Supabase address)
  * opens the local SQLite database (edge.db) and creates its tables
  * the 21-byte binary frame the ESP32 sends (decode / encode)
  * works out soil %, rain % and the states from the raw values, with the same
    integer maths as the ESP32 and the Supabase views
  * small time helpers (all times are stored as UTC ISO-8601 text)

Both scripts import this file, so keep it in the same folder as them.
"""

from __future__ import annotations

import logging
import math
import os
import sqlite3
import struct
import sys
import tomllib
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_CONFIG = "/opt/iot-edge/config.toml"

COMMANDS = {"beep_on", "beep_off", "reset_baseline"}

# States worked out from the raw values (same names as the Supabase views).
SOIL_STATES = {"SATURATED", "NORMAL", "DRY"}
RAIN_STATES = {"HEAVY", "RAIN", "NONE"}
DIST_STATES = {"OK", "MOVED", "NO_ECHO"}
ALERT_TYPES = {"SATURATED", "DRY", "HEAVY", "RAIN", "MOVED", "NO_ECHO", "MOTION",   # states that may raise an alert
               "TOO_HOT", "QUIET"}   # Supabase decides these two; the edge only passes them on
DEFAULT_ALERTS = ["SATURATED", "HEAVY", "MOVED", "NO_ECHO", "MOTION"]

# Calibration and alert settings used until Supabase sends a node's own values
# (public.nodes). The edge needs them only to spot an alert early and send it first;
# Supabase decides alerts and their ends itself. alert_confirm_readings is 1 because
# the node already sends at once when a condition starts and debounces it itself
# (ultrasonic: 3 checks in a row; soil and rain: hysteresis).
CAL_FIELDS = ["soil_dry_raw", "soil_wet_raw", "soil_flood_pct", "soil_dry_pct",
              "rain_dry_raw", "rain_wet_raw", "rain_light_pct", "rain_heavy_pct", "move_cm",
              "alert_confirm_readings", "motion_confirm_readings"]
DEFAULT_CALIBRATION = {
    "soil_dry_raw": 4095, "soil_wet_raw": 1400, "soil_flood_pct": 85, "soil_dry_pct": 20,
    "rain_dry_raw": 4095, "rain_wet_raw": 1500, "rain_light_pct": 20, "rain_heavy_pct": 60,
    "move_cm": 10.0, "alert_confirm_readings": 1, "motion_confirm_readings": 1,
    "alert_types": list(DEFAULT_ALERTS),
}

# ----------------------------------------------------------------- binary frame
# One reading from the ESP32: 21 bytes, little-endian, no padding.
# A telemetry message holds exactly one frame.
#
#   offset size  field      encoding
#     0     4    seq        uint32, counter since power-up (starts at 1)
#     4     4    ts         uint32 Unix seconds UTC, 0 = clock not set yet
#     8     2    temp       int16  0.1 C,  -32768 = DHT11 read failed
#    10     1    hum        uint8  %RH,    255 = DHT11 read failed
#    11     2    soil_raw   uint16 ADC 0-4095
#    13     2    rain_raw   uint16 ADC 0-4095
#    15     2    dist       uint16 mm,     65535 = no echo
#    17     2    baseline   uint16 mm,     65535 = not set
#    19     1    rssi       int8   dBm,    0 = WiFi not connected
#    20     1    flags      bit 0 = beep on, bit 1 = PIR motion since the previous
#                               reading, bits 2-7 must be 0
FRAME = struct.Struct("<IIhBHHHHbB")
FRAME_SIZE = FRAME.size                 # 21
TEMP_NONE, HUM_NONE, DIST_NONE = -32768, 255, 0xFFFF
TEMP_MIN_C, TEMP_MAX_C = 0, 50          # the DHT11's own range: anything outside is a garbled read

# Columns of the readings table that hold measured values (uploaded to Supabase).
RAW_FIELDS = ["temp_c", "hum_pct", "soil_raw", "rain_raw", "dist_cm", "baseline_cm", "beep_on", "rssi", "motion"]


def decode_frame(b: bytes) -> tuple[dict, list[str]]:
    """One 21-byte frame -> (values, warnings). Raises ValueError if it is not a field-node frame."""
    seq, ts, temp, hum, soil, rain, dist, base, rssi, flags = FRAME.unpack(b)
    if flags & 0xFC:
        raise ValueError(f"flags byte 0x{flags:02x} has reserved bits set (not a field-node frame)")
    warn = []

    def check(name, v, lo, hi):
        if v is not None and not lo <= v <= hi:
            warn.append(f"{name}={v} is outside {lo}..{hi}, stored as empty")
            return None
        return v

    return {
        "seq": seq,
        "ts_epoch": ts,
        "temp_c": check("temp_c", None if temp == TEMP_NONE else temp / 10, TEMP_MIN_C, TEMP_MAX_C),
        "hum_pct": check("hum_pct", None if hum == HUM_NONE else hum, 0, 100),
        "soil_raw": check("soil_raw", soil, 0, 4095),
        "rain_raw": check("rain_raw", rain, 0, 4095),
        "dist_cm": check("dist_cm", None if dist == DIST_NONE else dist / 10, 0, 1000),
        "baseline_cm": check("baseline_cm", None if base == DIST_NONE else base / 10, 0, 1000),
        "rssi": None if rssi == 0 else check("rssi", rssi, -127, -1),
        "beep_on": flags & 1,
        "motion": (flags >> 1) & 1,
    }, warn


def check_message(payload: bytes) -> bytes:
    """A telemetry payload must be one frame. Raises ValueError if the length is wrong."""
    if len(payload) != FRAME_SIZE:
        raise ValueError(f"{len(payload)} bytes is not one frame of {FRAME_SIZE} bytes")
    return payload


def encode_frame(seq: int, ts: int, temp_c, hum_pct, soil_raw: int, rain_raw: int,
                 dist_cm, baseline_cm, rssi, beep_on: bool, motion: bool = False) -> bytes:
    """The ESP32's packFrame() in Python (used by fake-thing.py and the tests)."""
    return FRAME.pack(
        seq, ts,
        TEMP_NONE if temp_c is None else round(temp_c * 10),
        HUM_NONE if hum_pct is None else round(hum_pct),
        soil_raw, rain_raw,
        DIST_NONE if dist_cm is None else round(dist_cm * 10),
        DIST_NONE if baseline_cm is None else round(baseline_cm * 10),
        rssi or 0,
        (1 if beep_on else 0) | (2 if motion else 0))


# ----------------------------------------------------------------- values from raw
def raw_to_pct(raw, dry: int, wet: int):
    """Arduino map(raw, dry, wet, 0, 100) clamped to 0..100: integer division that truncates toward zero."""
    if raw is None or wet == dry:
        return None
    a, b = (raw - dry) * 100, wet - dry
    q = abs(a) // abs(b)
    return max(0, min(100, q if (a >= 0) == (b > 0) else -q))


def derive(row: dict, cal: dict) -> dict:
    """soil_pct, soil_state, rain_pct, rain_state, dist_state, motion_state from the raw values."""
    soil = raw_to_pct(row["soil_raw"], cal["soil_dry_raw"], cal["soil_wet_raw"])
    rain = raw_to_pct(row["rain_raw"], cal["rain_dry_raw"], cal["rain_wet_raw"])
    dist, base = row["dist_cm"], row["baseline_cm"]
    if dist is None:
        dist_state = "NO_ECHO"
    elif base is not None and abs(round(dist * 10) - round(base * 10)) > round(cal["move_cm"] * 10):
        dist_state = "MOVED"
    else:
        dist_state = "OK"
    return {
        "soil_pct": soil,
        "soil_state": None if soil is None else
        "SATURATED" if soil >= cal["soil_flood_pct"] else "DRY" if soil <= cal["soil_dry_pct"] else "NORMAL",
        "rain_pct": rain,
        "rain_state": None if rain is None else
        "HEAVY" if rain >= cal["rain_heavy_pct"] else "RAIN" if rain >= cal["rain_light_pct"] else "NONE",
        "dist_state": dist_state,
        # row can be a dict or an sqlite3.Row (iot-edge status), which has no .get()
        "motion_state": None if row["motion"] is None else "MOTION" if row["motion"] else "NONE",
    }


def conditions(d: dict) -> list[str]:
    """The states of a reading (soil, rain, distance, motion)."""
    return [s for s in (d["soil_state"], d["rain_state"], d["dist_state"], d["motion_state"]) if s]


# ----------------------------------------------------------------- SQLite
SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id       TEXT    NOT NULL,
    boot_id       INTEGER NOT NULL,             -- from the node's status message
    seq           INTEGER NOT NULL,
    ts            TEXT    NOT NULL,             -- measurement time, UTC
    ts_source     TEXT    NOT NULL,             -- 'device' (ESP32 NTP) or 'edge'
    received_at   TEXT    NOT NULL,             -- when the edge got it = due for upload
    temp_c        REAL,
    hum_pct       REAL,
    soil_raw      INTEGER,
    rain_raw      INTEGER,
    dist_cm       REAL,
    baseline_cm   REAL,
    beep_on       INTEGER,                      -- 0/1
    rssi          INTEGER,
    motion        INTEGER,                      -- 0/1: PIR saw movement since the previous reading
    alert         TEXT,                         -- alert conditions in this reading, e.g. 'SATURATED,HEAVY'
    urgent        TEXT,                         -- quick alert: these conditions made it go up at once, first
    is_sent       INTEGER NOT NULL DEFAULT 0 CHECK (is_sent IN (0, 1)),
    sent_at       TEXT,                         -- when the upload went through without an error
    UNIQUE (node_id, boot_id, seq)
);
CREATE INDEX IF NOT EXISTS readings_unsent_idx ON readings (is_sent, id);
CREATE INDEX IF NOT EXISTS readings_sent_at_idx ON readings (sent_at);
CREATE INDEX IF NOT EXISTS readings_urgent_idx ON readings (id) WHERE is_sent = 0 AND urgent IS NOT NULL;

-- Quick alerts: when each condition last made a node's readings go up at once.
CREATE TABLE IF NOT EXISTS quick_alerts (
    node_id     TEXT NOT NULL,
    type        TEXT NOT NULL,                  -- SATURATED, DRY, HEAVY, RAIN, MOVED, NO_ECHO, MOTION
    last_ts     TEXT NOT NULL,                  -- measurement time of the reading that triggered it
    PRIMARY KEY (node_id, type)
);

CREATE TABLE IF NOT EXISTS commands (
    id              TEXT PRIMARY KEY,           -- uuid from Supabase
    node_id         TEXT NOT NULL,
    command         TEXT NOT NULL,              -- beep_on / beep_off / reset_baseline
    created_at      TEXT NOT NULL,              -- when it was created in Supabase
    expires_at      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'at_edge',  -- at_edge -> sent -> done / failed / expired
    at_edge_at      TEXT NOT NULL,
    sent_at         TEXT,                       -- first publish to the thing
    done_at         TEXT,
    publish_count   INTEGER NOT NULL DEFAULT 0,
    last_publish_at TEXT,
    result          TEXT,
    updated_at      TEXT NOT NULL,
    is_synced       INTEGER NOT NULL DEFAULT 0 CHECK (is_synced IN (0, 1)),  -- Supabase has the latest status
    synced_at       TEXT
);
CREATE INDEX IF NOT EXISTS commands_open_idx ON commands (status);
CREATE INDEX IF NOT EXISTS commands_unsynced_idx ON commands (is_synced);

-- The boot_id each thing announced in its status message (telemetry frames carry no boot_id).
CREATE TABLE IF NOT EXISTS nodes (
    node_id     TEXT PRIMARY KEY,
    boot_id     INTEGER,
    online      INTEGER,
    status_at   TEXT
);

-- One row per power-up of a thing, from its info message: where it is.
CREATE TABLE IF NOT EXISTS boots (
    node_id     TEXT    NOT NULL,
    boot_id     INTEGER NOT NULL,
    lat         REAL,                           -- decimal degrees, NULL = not set in the sketch
    lon         REAL,
    received_at TEXT    NOT NULL,
    is_sent     INTEGER NOT NULL DEFAULT 0,     -- uploaded to Supabase
    PRIMARY KEY (node_id, boot_id)
);

-- Readings in a batch Supabase refused as malformed (HTTP 400/422). They stay in
-- readings with is_sent = 0 but are left out of uploads, so the readings behind them
-- get through. Deleted with their reading after retention_days; `iot-edge requeue`
-- puts them back in the queue (e.g. after fixing edge-com).
CREATE TABLE IF NOT EXISTS rejected (
    reading_id  INTEGER PRIMARY KEY,            -- readings.id
    rejected_at TEXT    NOT NULL,
    http_status INTEGER NOT NULL,
    reason      TEXT
);

-- Each node's calibration as last received from Supabase (public.nodes).
CREATE TABLE IF NOT EXISTS calibration (
    node_id        TEXT PRIMARY KEY,
    soil_dry_raw   INTEGER NOT NULL,
    soil_wet_raw   INTEGER NOT NULL,
    soil_flood_pct INTEGER NOT NULL,
    soil_dry_pct   INTEGER NOT NULL,
    rain_dry_raw   INTEGER NOT NULL,
    rain_wet_raw   INTEGER NOT NULL,
    rain_light_pct INTEGER NOT NULL,
    rain_heavy_pct INTEGER NOT NULL,
    move_cm        REAL    NOT NULL,
    alert_confirm_readings INTEGER NOT NULL,
    motion_confirm_readings INTEGER NOT NULL,
    alert_types    TEXT    NOT NULL,            -- comma list, e.g. 'SATURATED,HEAVY,MOVED,NO_ECHO'
    version        INTEGER NOT NULL,            -- cal_version in Supabase
    received_at    TEXT    NOT NULL
);
"""


# ----------------------------------------------------------------- time
def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    """UTC ISO-8601 with milliseconds, e.g. 2026-11-02T03:15:00.123Z"""
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now_iso() -> str:
    return iso(utc_now())


def iso_ago(**kwargs) -> str:
    return iso(utc_now() - timedelta(**kwargs))


def epoch(iso_text: str) -> float:
    return datetime.fromisoformat(iso_text.replace("Z", "+00:00")).timestamp()


# ----------------------------------------------------------------- config
def config_path_from_args(argv: list[str]) -> str:
    """--config PATH, else $IOT_EDGE_CONFIG, else ./config.toml if present, else /opt/iot-edge/config.toml"""
    if "--config" in argv:
        i = argv.index("--config")
        if i + 1 < len(argv):
            return argv[i + 1]
    if os.environ.get("IOT_EDGE_CONFIG"):
        return os.environ["IOT_EDGE_CONFIG"]
    local = Path(__file__).with_name("config.toml")
    if local.exists():
        return str(local)
    return DEFAULT_CONFIG


# secrets.toml key -> where it goes in the config (section, name); None = top level.
SECRET_KEYS = {
    "supabase_function_url": ("cloud", "function_url"),
    "supabase_anon_key": ("cloud", "anon_key"),
    "edge_id": (None, "edge_id"),
    "edge_key": ("cloud", "edge_key"),
    "mqtt_password": ("mqtt", "password"),
    "node_secret": (None, "node_secret"),
}


def load_secrets(cfg: dict, config_path: str) -> str:
    """Merge secrets.toml into cfg. Returns its path."""
    path = cfg.get("secrets_path") or str(Path(config_path).with_name("secrets.toml"))
    try:
        with open(path, "rb") as f:
            secrets = tomllib.load(f)
    except FileNotFoundError:
        sys.exit(f"Secrets file not found: {path}  (copy secrets.example.toml to secrets.toml and fill it in)")
    except PermissionError:
        sys.exit(f"Can't read {path}: it is readable only by root and iotedge (try: sudo iot-edge ...)")
    except tomllib.TOMLDecodeError as e:
        sys.exit(f"Secrets file {path} has a mistake: {e}")
    unknown = set(secrets) - set(SECRET_KEYS)
    if unknown:
        sys.exit(f"Secrets file {path} has unknown keys {sorted(unknown)}; allowed: {sorted(SECRET_KEYS)}")
    for key, (section, name) in SECRET_KEYS.items():
        if key not in secrets:
            continue
        target = cfg if section is None else cfg[section]
        target[name] = secrets[key]
    return path


def load_position(edge: dict, config_path: str):
    """[edge] lat / lon: decimal degrees, or nan / left out = unknown (None)."""
    def coord(name, limit):
        v = edge.get(name)
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return None
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not -limit <= v <= limit:
            sys.exit(f"Config file {config_path}: [edge] {name} = {v!r} is not a coordinate "
                     f"(decimal degrees, -{limit} to {limit}, or nan if unknown)")
        return float(v)

    edge["lat"], edge["lon"] = coord("lat", 90), coord("lon", 180)
    if (edge["lat"] is None) != (edge["lon"] is None):
        sys.exit(f"Config file {config_path}: [edge] needs both lat and lon, or neither (nan)")


def format_position(lat, lon) -> str:
    return f"{lat:.6f}, {lon:.6f}" if lat is not None and lon is not None else "-"


def load_config(path: str) -> dict:
    try:
        with open(path, "rb") as f:
            cfg = tomllib.load(f)
    except FileNotFoundError:
        sys.exit(f"Config file not found: {path}  (copy config.example.toml to config.toml and edit it)")
    except tomllib.TOMLDecodeError as e:
        sys.exit(f"Config file {path} has a mistake: {e}")
    for section in ("edge", "mqtt", "cloud", "commands", "alerts", "calibration"):
        cfg.setdefault(section, {})
    secrets_path = load_secrets(cfg, path)
    if not cfg.get("db_path"):
        sys.exit(f"Config file {path} is missing 'db_path'")
    if not cfg.get("edge_id"):
        sys.exit(f"{secrets_path} is missing 'edge_id' (copy secrets.example.toml to secrets.toml and fill it in)")
    load_position(cfg["edge"], path)
    a = cfg["alerts"]
    types = a.get("types", DEFAULT_ALERTS)
    unknown = set(types) - ALERT_TYPES
    if unknown:
        sys.exit(f"Config file {path}: [alerts] types has unknown values {sorted(unknown)}; "
                 f"allowed: {sorted(ALERT_TYPES)}")
    a["quick_window_s"] = max(0, int(a.get("quick_window_s", 300)))
    cal = dict(DEFAULT_CALIBRATION)
    cal.update({k: v for k, v in cfg["calibration"].items() if k in DEFAULT_CALIBRATION})
    cal["alert_types"] = list(types)
    cal["alert_confirm_readings"] = max(1, int(a.get("confirm_readings", 1)))
    cal["motion_confirm_readings"] = max(1, int(a.get("motion_confirm_readings", 1)))
    cfg["calibration"] = cal
    return cfg


def setup_logging(name: str) -> logging.Logger:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
    )
    return logging.getLogger(name)


# ----------------------------------------------------------------- database
def connect(db_path: str) -> sqlite3.Connection:
    """Open edge.db (creating it and its tables if needed)."""
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path, timeout=10, isolation_level=None)  # autocommit; we BEGIN explicitly
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")      # one script can write while the other reads
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=10000")
    con.executescript(SCHEMA)
    return con


def confirm_for(kind: str, cal: dict) -> int:
    """Readings in a row that confirm an alert: MOTION has its own count (a detection is the event)."""
    key = "motion_confirm_readings" if kind == "MOTION" else "alert_confirm_readings"
    return max(1, int(cal.get(key) or 1))


def calibration_for(con: sqlite3.Connection, node_id: str, default: dict) -> dict:
    """The node's calibration and alert settings from Supabase, else the config.toml defaults."""
    r = con.execute(f"SELECT {', '.join(CAL_FIELDS)}, alert_types FROM calibration WHERE node_id = ?",
                    (node_id,)).fetchone()
    if not r:
        return default
    cal = dict(r)
    cal["alert_types"] = [t for t in r["alert_types"].split(",") if t]
    return cal
