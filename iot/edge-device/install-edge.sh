#!/usr/bin/env bash
# =============================================================================
# install-edge.sh - sets up the edge on Ubuntu 24.04
#
#   cd iot/edge-device        (in your copy of the repo)
#   sudo bash install-edge.sh
#
# Installs Mosquitto (MQTT broker), Python packages, the two scripts and their
# services. Creates the MQTT passwords the first time, in secrets.toml.
# Safe to run again after updating the scripts: existing config.toml,
# secrets.toml and passwords are kept.
# =============================================================================
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/iot-edge
SVC_USER=iotedge

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo:  sudo bash install-edge.sh"
  exit 1
fi
for f in edge_db.py thing-com.py cloud-com.py config.example.toml secrets.example.toml requirements.txt iot-edge \
         tools/fake-thing.py mosquitto/field-node.conf systemd/thing-com.service systemd/cloud-com.service; do
  [[ -f "$SRC/$f" ]] || { echo "Missing $SRC/$f - run this from the repo's iot/edge-device folder"; exit 1; }
done
. /etc/os-release
[[ "${VERSION_ID:-}" == "24.04" ]] || echo "Note: written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}"

echo "==> 1/7 Installing packages (Mosquitto, Python venv, SQLite, mDNS)"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  mosquitto mosquitto-clients python3-venv sqlite3 avahi-daemon >/dev/null

echo "==> 2/7 Service account '$SVC_USER' and folders in $APP"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin "$SVC_USER"
install -d -o root -g "$SVC_USER" -m 0750 "$APP" "$APP/tools"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$APP/data"

echo "==> 3/7 Copying the scripts"
install -o root -g "$SVC_USER" -m 0644 "$SRC/edge_db.py" "$SRC/thing-com.py" "$SRC/cloud-com.py" \
  "$SRC/requirements.txt" "$SRC/config.example.toml" "$SRC/secrets.example.toml" "$APP/"
install -o root -g "$SVC_USER" -m 0644 "$SRC/tools/fake-thing.py" "$APP/tools/"
install -o root -g root -m 0755 "$SRC/iot-edge" /usr/local/bin/iot-edge

echo "==> 4/7 Python virtual environment"
[[ -x "$APP/venv/bin/python" ]] || python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q --disable-pip-version-check -r "$APP/requirements.txt"

echo "==> 5/7 config.toml, and the MQTT passwords in secrets.toml"
NEW_SECRETS=0
if [[ ! -f "$APP/config.toml" ]]; then
  install -o root -g "$SVC_USER" -m 0644 "$SRC/config.example.toml" "$APP/config.toml"
fi
if [[ -f "$APP/secrets.toml" ]]; then
  echo "    $APP/secrets.toml already exists - keeping it and the existing passwords"
else
  gen() { python3 -c "import secrets; print(secrets.token_urlsafe($1))"; }
  NODE_PW=$(gen 18)
  EDGE_PW=$(gen 18)
  (umask 077; sed -e "s|__EDGE_MQTT_PASSWORD__|$EDGE_PW|" \
     -e "s|__NODE_SECRET__|$NODE_PW|" "$SRC/secrets.example.toml" > "$APP/secrets.toml")
  rm -f /etc/mosquitto/passwd
  mosquitto_passwd -c -b /etc/mosquitto/passwd thing "$NODE_PW"
  mosquitto_passwd -b /etc/mosquitto/passwd edge "$EDGE_PW"
  NEW_SECRETS=1
fi
chown root:"$SVC_USER" "$APP/secrets.toml"
chmod 0640 "$APP/secrets.toml"

echo "==> 6/7 Mosquitto broker on port 1883 (password login only)"
install -o root -g root -m 0644 "$SRC/mosquitto/field-node.conf" /etc/mosquitto/conf.d/field-node.conf
chown mosquitto:mosquitto /etc/mosquitto/passwd
chmod 0600 /etc/mosquitto/passwd
systemctl enable mosquitto >/dev/null 2>&1 || true
systemctl restart mosquitto
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 1883/tcp >/dev/null && echo "    firewall: opened port 1883"
fi

echo "==> 7/7 Services thing-com and cloud-com"
install -o root -g root -m 0644 "$SRC/systemd/thing-com.service" "$SRC/systemd/cloud-com.service" \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable thing-com cloud-com >/dev/null 2>&1
systemctl restart thing-com
if grep -qE "YOUR_PROJECT_REF|PASTE-THE-TOKEN" "$APP/secrets.toml"; then
  systemctl stop cloud-com 2>/dev/null || true
  CLOUD_READY=0
else
  systemctl restart cloud-com
  CLOUD_READY=1
fi

echo
echo "================================================================="
echo " Edge installed."
echo "   Edge IP address(es) : $(hostname -I 2>/dev/null || echo unknown)"
echo "   Edge mDNS name      : $(hostname).local"
if [[ $NEW_SECRETS == 1 ]]; then
  echo
  echo " For the sensor nodes' secrets.h (also in $APP/secrets.toml as node_secret):"
  echo "   #define NODE_SECRET \"$NODE_PW\""
  echo
  echo " This edge's ID is $(sed -n 's/^edge_id *= *"\(.*\)"/\1/p' "$APP/secrets.toml"). For another region,"
  echo " change edge_id in $APP/secrets.toml before registering it:  sudo nano $APP/secrets.toml"
fi
echo
if ! grep -qE '^\s*lat\s*=\s*-?[0-9]' "$APP/config.toml"; then
  echo " This edge's position is not set. Put it in $APP/config.toml (sudo nano $APP/config.toml),"
  echo " then run  iot-edge register-sql  and paste the SQL again:"
  echo "   [edge]"
  echo "   lat = 1.553300      # decimal degrees, north +"
  echo "   lon = 110.359200    # east +"
  echo
fi
echo " Register this edge in Supabase:"
echo
sudo -u "$SVC_USER" "$APP/venv/bin/python" "$APP/cloud-com.py" --config "$APP/config.toml" --register-sql \
  | sed 's/^/   /'
echo
if [[ $CLOUD_READY == 0 ]]; then
  echo " Next: put your edge-com URL (supabase_function_url) and the device token (edge_key)"
  echo " in $APP/secrets.toml (iot-edge secrets), then:"
  echo "   sudo systemctl start cloud-com"
fi
echo " Check anytime with:  iot-edge status    |   follow logs:  iot-edge logs"
echo "================================================================="
