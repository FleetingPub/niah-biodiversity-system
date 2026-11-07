#!/usr/bin/env bash
# =============================================================================
# reset-edge.sh - wipes the edge's data so it starts again from empty
#
#   cd iot/edge-device        (in your copy of the repo)
#   sudo bash reset-edge.sh            (asks before deleting)
#   sudo bash reset-edge.sh --yes      (no question)
#
# Use it when the edge ran an earlier version of this design, or to throw away
# test data. It is NOT part of install-edge.sh and never runs by itself.
#
# Deletes
#   /opt/iot-edge/data/edge.db (+ -wal, -shm): every reading, sent or not, the
#     quick-alert history, positions, commands and calibration copies
# Keeps
#   config.toml, secrets.toml (MQTT passwords, edge key), Mosquitto, the scripts and
#   the services. Readings not yet uploaded to Supabase are LOST.
#   The broker's retained status / position messages are kept on purpose: they
#   describe each thing's current power-up, and a connected thing only sends
#   its boot_id again when it reconnects, so thing-com needs them.
#
# Resetting Supabase (supabase/reset.sql + schema.sql) needs this reset too,
# run after it; then paste the edge registration printed at the end.
# =============================================================================
set -euo pipefail

APP=${IOT_EDGE_APP:-/opt/iot-edge}
CFG="$APP/config.toml"
PY="$APP/venv/bin/python"
YES=0
[[ "${1:-}" == "--yes" ]] && YES=1

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo:  sudo bash reset-edge.sh"
  exit 1
fi
[[ -f "$CFG" ]] || { echo "$CFG not found - is the edge installed (install-edge.sh)?"; exit 1; }
[[ -x "$PY" ]] || PY=python3

# database path from config.toml, Supabase URL from secrets.toml
eval "$("$PY" - "$CFG" <<'EOF'
import shlex, sys, tomllib
from pathlib import Path
c = tomllib.load(open(sys.argv[1], "rb"))
s = Path(c.get("secrets_path") or Path(sys.argv[1]).with_name("secrets.toml"))
url = tomllib.load(open(s, "rb")).get("supabase_function_url", "") if s.exists() else ""
for k, v in (("DB", c.get("db_path", "")), ("URL", url)):
    print(f"{k}={shlex.quote(str(v))}")
EOF
)"
[[ -n "$DB" ]] || { echo "config.toml has no db_path"; exit 1; }

echo "This deletes $DB."
if [[ -f "$DB" ]]; then
  "$PY" - "$DB" <<'EOF' || true
import sqlite3, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    total, unsent = con.execute("SELECT COUNT(*), COALESCE(SUM(is_sent = 0), 0) FROM readings").fetchone()
    print(f"It holds {total} readings, {unsent} of them NOT uploaded to Supabase yet (these are lost).")
except sqlite3.Error:
    print("(it is from another version; its contents cannot be counted)")
EOF
else
  echo "(no database there yet)"
fi
if [[ $YES == 0 ]]; then
  read -r -p "Type RESET to continue: " answer
  [[ "$answer" == "RESET" ]] || { echo "Nothing changed."; exit 1; }
fi

echo "==> 1/3 Stopping thing-com and cloud-com"
systemctl stop thing-com cloud-com 2>/dev/null || true

echo "==> 2/3 Deleting the edge database"
rm -f "$DB" "$DB-wal" "$DB-shm" "$DB-journal"

echo "==> 3/3 Starting the services (a new, empty edge.db is created)"
systemctl start thing-com
if [[ -z "$URL" || "$URL" == *YOUR_PROJECT_REF* ]]; then
  echo "    cloud-com left stopped: supabase_function_url in secrets.toml is not set yet"
else
  systemctl start cloud-com
fi

echo
echo "Edge reset. Connected ESP32s carry on; their readings go into the new database."
echo "If you also reset Supabase, register this edge again:"
echo
sudo -u iotedge "$PY" "$APP/cloud-com.py" --config "$CFG" --register-sql 2>/dev/null | sed 's/^/   /' \
  || echo "   (run: iot-edge register-sql)"
