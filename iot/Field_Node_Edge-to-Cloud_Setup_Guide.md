# Field Node Edge-to-Cloud Setup Guide

Nov 5, 2026

Each ESP32 sensor node sends a 21-byte binary frame over the region's Wi-Fi to Mosquitto on the edge (the Ubuntu VM): a routine reading every 60 s, and one at once when something starts (movement, a moved or blocked node, saturated soil, heavy rain). thing-com.py stores each reading's raw values in SQLite. cloud-com.py uploads them to Supabase every 60 s as one gzip-compressed batch through the edge-com function; readings that look like an alert go up at once (quick alert). In Supabase the readings land in the IoT tables of the Niah National Park project (`iot_readings` and the others), where edge-com decides the alerts with each node's own settings. Beep and baseline commands travel back down the same path. The dashboard that shows all this to officers is on hold; this guide covers everything up to the cloud database.

## What the solution does

| Feature | What it does | Where |
| --- | --- | --- |
| Sensing | Air temperature and humidity (DHT11), soil moisture (flash flood / drying), rain, ultrasonic distance to tell whether the node has moved, fallen or been covered, PIR movement, and a locate beep every 5 s | ESP32 |
| Sending on events | A routine reading every 60 s, and one at once (at most every 5 s) when PIR movement starts, the distance shifts more than 10 cm or the echo is lost (each held for 3 checks, 1 s apart), the soil reaches 85 % or the rain 60 % (checked every 10 s, with 5 % hysteresis). Each fires once when the condition starts | ESP32 |
| Compact node → edge link | One 21-byte binary frame per reading with raw values only. node\_id comes from the MQTT topic and boot\_id from the status message | ESP32, thing-com |
| Short outages at the node | While the edge can't be reached the node keeps its last 30 readings (about 30 min) in RAM and sends them in order once the edge is back; a reading taken before NTP answered gets its time worked out then | ESP32 |
| Node position | Each node's `secrets.h` holds its latitude and longitude (it has no GPS). It sends them once after every power-up; Supabase keeps one row per power-up in `iot_boots` | ESP32, `iot_boots` |
| Store and forward | edge.db keeps every reading until an upload of it goes through without an error, and Supabase skips readings it already has. An internet outage delays readings but doesn't lose them | thing-com, cloud-com, edge-com |
| Compact edge → cloud link | Compact JSON with no field names per reading, node\_id and boot\_id once per group, and gzip on top. Supabase sends nothing back for the readings: no error means delivered | cloud-com, edge-com |
| Quick alerts | A reading that shows a flood, heavy-rain, node-moved, no-echo or PIR-movement condition goes up at once, ahead of any backlog, instead of waiting up to 60 s. Once per node and condition per 5 minutes; while the internet is down it retries every 10 s | thing-com, cloud-com |
| Alerts | edge-com decides them from the readings with each node's settings in `iot_nodes`. One event is one alert: it opens on the first reading that shows the condition, ends after a reading back past a clear threshold, and the same condition stays quiet for 5 minutes after an end. Also `TOO_HOT` (fire warning, 45 °C) and `QUIET` (a node silent for 15 min). Each has a severity, and officers and admins can acknowledge and resolve it | edge-com, `iot_alerts` |
| Node status | Each node's `status` in `iot_nodes` follows its alerts: `offline` (QUIET), `threat_triggered` (an urgent alert), `warning` (DRY or RAIN), otherwise `online` | edge-com, `iot_nodes` |
| Values worked out from raw | Soil %, rain % and the states are calculated when they're read, with each node's calibration in `iot_nodes`. A change applies to all readings, old and new, and reaches the edge with its next upload | `iot_raw_pct`, `iot_node_status` |
| Commands down | `beep_on`, `beep_off` and `reset_baseline` go from a row in `iot_commands` to the edge and on to the node. They are resent until acknowledged and expire after 1 hour | `iot_commands`, thing-com |
| Security | MQTT logins with passwords; each edge device has its own token that Supabase keeps only as a SHA-256 hash; a node is accepted only when it's linked to the device that sends it; at most 3,600 readings an hour from one edge device; Row Level Security on every table: officers and admins read, admins manage devices and nodes | Mosquitto, edge-com, Supabase |
| Tools | `iot-edge` shortcuts (status, alerts, logs, watch with decoded frames, sync, requeue) and a simulated ESP32 that sends like the real one and can fake floods, rain, a moved node, PIR movement and a position | edge |

## How it fits together

The edge holds every reading until it has been uploaded without an error, so an internet outage delays readings instead of losing them.

&#91;embedded content: node → edge → Supabase, readings up and commands down\]

The node keeps its last 30 readings while the edge is unreachable, edge.db keeps every row until it is uploaded, and a command waits at each step until the next one is reachable. A quick alert uses the same path but doesn't wait for the upload interval.

## Emergency alerts

The work is split three ways: the node sends at once when something starts, the edge makes sure alert readings get to Supabase fast, and Supabase decides the alerts.

**At the node: sending at once**

The node checks the PIR all the time, the ultrasonic every second and the soil and rain probes every 10 s. When a condition starts it sends a reading straight away instead of waiting for the next minute, at most once every 5 s. The node debounces it itself: a distance change or a lost echo has to hold for 3 checks in a row, and soil and rain have to drop 5 % below their threshold before they can fire again.

**At the edge: quick alerts**

1. thing-com works out every reading's values with that node's calibration and alert settings (from Supabase, or the `[calibration]` and `[alerts]` defaults in config.toml until Supabase has sent them).
2. It checks the node's `alert_types`. The edge spots `SATURATED` (flash-flood risk), `HEAVY` rain, `MOVED` and `NO_ECHO` (the node has fallen, been moved or is blocked) and `MOTION` (the PIR saw movement); `DRY` and `RAIN` can be added. `TOO_HOT` and `QUIET` are decided in Supabase only.
3. When `alert_confirm_readings` (1) readings in a row show one of them, those readings are marked `urgent` and the log shows `QUICK ALERT NNP-IOT-01 SATURATED … -> uploading to Supabase now`. One reading is enough because the node has already debounced it.
4. cloud-com checks for urgent readings every 0.5 s and uploads at once, urgent readings first, even behind a long backlog. If the upload fails, it retries every 10 s (`urgent_retry_s`) instead of following the 60 s → 5 min back-off.
5. The same condition on the same node gets a quick upload again only after `quick_window_s` (300 s). In between, its readings go with the regular uploads.

**In Supabase: alerts**

edge-com judges every new reading with the node's settings in `iot_nodes`, the same way whether the reading came quickly or with a regular upload:

| Rule | What it does | Setting in `iot_nodes` (default) |
| --- | --- | --- |
| Confirm | An alert opens after this many readings in a row show the condition, starting at the first of them | `alert_confirm_readings` (1); `motion_confirm_readings` (1) |
| Clear threshold | An open alert ends only after as many readings in a row are back past a clear threshold set a little away from the one that opens it, so a value sitting on the line can't switch it on and off | `soil_flood_clear_pct` (80 %, opens at 85), `soil_dry_clear_pct` (25 %, opens at 20), `rain_heavy_clear_pct` (50 %, opens at 60), `rain_light_clear_pct` (15 %, opens at 20), `move_clear_cm` (7 cm, opens beyond 10), `too_hot_clear_c` (40 °C, opens at 45). `MOTION` ends after `motion_clear_readings` (2) readings in a row without movement, about 2 minutes |
| One alert while it goes on | While an alert is going on, the same condition on the same node can't open another | – |
| Gap after an end | After an alert ends, the same condition on the same node can't open a new one for this long, timed on the readings' own clock | `alert_rearm_s` (300 s) |
| Quiet node | `QUIET` opens when a node's newest reading is older than this. It's checked after every upload from any edge, so it also works when a whole region's edge is down, and it ends when the node sends again | `quiet_minutes` (15) |
| Conditions | Which states raise alerts (also sent to the edge for quick alerts) | `alert_types`: `SATURATED`, `HEAVY`, `MOVED`, `NO_ECHO`, `MOTION`, `TOO_HOT`, `QUIET`; `DRY` and `RAIN` can be added |

Every alert is `urgent` (someone may be at the plant, or there may be a fire or a flash flood) except `DRY` and `RAIN`, which are `routine`. An alert has two kinds of "over": `cleared_at` is when the readings showed the condition had passed, `resolved_at` is when an officer or admin said it's dealt with (`iot_acknowledge_alert`, `iot_resolve_alert`, for the dashboard). Either can come first.

Old readings that arrive after an outage are judged like any other and their alerts are recorded with their real times. An alert that started more than an hour before it was opened is marked `from_backlog`, so it doesn't count as one needing someone (`iot_check_alerts`, which the dashboard's staff menu will call).

**About TOO_HOT.** The DHT11 reads 0–50 °C, and both the edge and the database store anything above 50 °C as empty, so the fire warning has to trigger below that: 45 °C by default, per node. In a real fire a DHT11 may fail or go silent before it reports that high (a silent node then becomes `QUIET`, which is urgent too). Treat TOO\_HOT as an early warning, not a fire sensor.

`NO_ECHO` ends when the sensor gets an echo again. A reading with no distance says nothing about `MOVED`, so it neither opens nor ends one. Supabase judges each node's readings in time order; a reading older than the newest one it has already judged for that node is stored but not judged again.

See them in Supabase with:

```sql
select node_id, type, severity, recorded_at, cleared_recorded_at, status, from_backlog
from public.iot_alerts order by recorded_at desc limit 20;
select node_id, status, last_reading_at, soil_pct, soil_state, rain_state, dist_state, quiet, open_alerts
from public.iot_node_status;
```

and the quick alerts on the edge with `iot-edge alerts`.

## Local database: SQLite

The edge buffers everything in SQLite: one file, `/opt/iot-edge/data/edge.db`, built into Python. Readings survive VM reboots and internet drop-outs, and stay until an upload of them goes through without an error.

| Database | What it is | Fit for this edge |
| --- | --- | --- |
| **SQLite (used)** | A file database inside the Python scripts | Best: nothing to install or secure, survives reboots, easily handles a few rows a minute per node |
| PostgreSQL | A database server, same engine as Supabase | Works, but a server to run and secure just to buffer rows |
| InfluxDB | A time-series server with built-in charts | Good for local dashboards; no natural per-row "sent" flag |
| Redis or broker queues | In-memory queues | Not durable enough to be the only copy |

How a reading moves through the `readings` table:

1. thing-com.py inserts each reading with `is_sent = 0` and `sent_at` empty. `received_at` records when it arrived. Readings that trigger a quick alert get `urgent` set to its condition.
2. Every 60 s, cloud-com.py takes up to 500 rows with `is_sent = 0` (urgent ones first, then oldest) and posts them to edge-com. Urgent rows start an upload at once.
3. If the POST goes through without an error (HTTP 2xx), all those rows get `is_sent = 1` and `sent_at`. On a network or server error they stay unsent and go in the next upload.
4. If Supabase refuses the batch as malformed (HTTP 400 or 422), sending it again would get the same answer and hold up everything behind it. So the batch is set aside: its readings stay in edge.db (listed in the `rejected` table and in `iot-edge status`) but are left out of uploads, and the next batch goes. `iot-edge requeue` puts them back in line, for example after fixing edge-com.
5. Sent rows older than 30 days are deleted, and so are set-aside rows. Unsent rows are never deleted.

| Column | Meaning |
| --- | --- |
| `node_id`, `boot_id`, `seq` | Which node, which power-up, which reading. Unique together, so a repeated message is stored once |
| `ts`, `ts_source` | Measurement time in UTC; `device` = the node's clock from NTP, `edge` = the VM's clock, used when the node had no time yet |
| `received_at` | When the edge received it |
| `temp_c` … `motion` | The raw values: `temp_c`, `hum_pct`, `soil_raw`, `rain_raw`, `dist_cm`, `baseline_cm`, `beep_on`, `rssi`, `motion` (1 = PIR movement since the previous reading). A value outside what the part can measure (e.g. temperature outside 0–50 °C) is stored as empty |
| `alert`, `urgent` | Alert conditions this reading shows, and the ones it triggered a quick upload for |
| `is_sent`, `sent_at` | 0 / empty until uploaded without an error; then 1 and the time |

Five small tables help:
- `nodes` remembers the boot\_id each node last announced, so a restart of thing-com doesn't need the node to reconnect.
- `boots` holds each power-up's position from the node's info message, with `is_sent` for its one upload.
- `calibration` holds each node's calibration and alert settings as last received from Supabase.
- `quick_alerts` holds when each condition last triggered a quick upload per node, so the window survives a restart.
- `rejected` lists the readings of batches Supabase refused.

The `commands` table holds beep and baseline commands on their way down. Its `status` runs `at_edge` → `sent` → `done`, `failed` or `expired`. `is_synced` and `synced_at` work like `is_sent` and `sent_at`: they show whether Supabase has been told the latest status.

Supabase has the same uniqueness rule (`node_id`, `boot_id`, `seq`). If an upload reached Supabase but the edge saw an error (the connection dropped before the reply), the edge sends the batch again and nothing is stored twice.

## Cloud database: Supabase

The IoT tables live in the same Supabase project as the rest of the Niah National Park system, so they use its roles: `has_any_role()` from migrations 001–015, with officers (`conservation_officer`) and admins seeing the sensor data. They are added by eight migrations, one per table, and a ninth (022) that limits how many readings an edge device can send. They run after 001–015, with the team's 019–021 in between:

| File | Table | What it holds | Who can read / change it through the API |
| --- | --- | --- | --- |
| `016_1_iot_devices.sql` | `iot_devices` | One row per edge device (one per forest region): name, zone, on/off, when its token was made, when it was last heard from, its position | Officers and admins read (for the Sensors map), admins change |
| `016_2_iot_nodes.sql` | `iot_nodes` (from 001) | Links each node to its edge device (`edge_device_id`), and adds its last reported state and its calibration and alert settings | Officers and admins read, admins change (the policies from 006) |
| `016_3_iot_device_tokens.sql` | `iot_device_tokens` | The SHA-256 hash of each device's token, and `iot_make_device_token()` that makes one | Nobody; only the function and edge-com use it |
| `016_4_iot_readings.sql` | `iot_readings` | Every reading's raw values, plus `iot_raw_pct()` that turns raw ADC values into % | Officers and admins read; only edge-com adds |
| `017_iot_alerts.sql` | `iot_alerts` | Every alert, with its start, end, severity and who acknowledged or resolved it; the quiet check, the node status update, acknowledge and resolve, and the `iot_node_status` view | Officers and admins read; acknowledge and resolve through the functions |
| `022_iot_reading_limit.sql` | `iot_readings` (from 016_4) | A trigger that turns an upload down when its edge device has sent more than 3,600 readings in the last hour | Nobody; it runs by itself |
| `023_iot_boots.sql` | `iot_boots` | One row per node power-up: position and first / last reading that arrived | Officers and admins read |
| `024_iot_alert_state.sql` | `iot_alert_state` | edge-com's working state for alerts | Nobody |
| `025_iot_commands.sql` | `iot_commands` | Commands for the nodes and how far they've got | Officers and admins read and send |

Each file checks that the one before it ran, is safe to run again, and runs as one transaction (all of it or none).

**iot\_readings.** One row per reading, unique on (`node_id`, `boot_id`, `seq`). `recorded_at` is the measurement time, `ts_source` says which clock it came from, `received_at` when the edge got it and `inserted_at` when Supabase stored it. The values are raw: `temp_c`, `hum_pct`, `soil_raw`, `rain_raw`, `dist_cm`, `baseline_cm`, `beep_on`, `rssi`, `motion`. Each has a named check for what the part can really measure (temperature 0–50 °C, ADC 0–4095, distance 0–1000 cm …), so an error says which value it was. A device can't be deleted while it has readings, and neither can a node, so the history stays whole; turn a device off instead.

**iot\_nodes.** Besides 001's `node_id`, `name`, `zone`, `status` and `last_heartbeat` (the time of its newest reading), each node has:

| Columns | Meaning (defaults) |
| --- | --- |
| `edge_device_id` | The edge device it sends through. A node with none can't get readings from anyone |
| `last_rssi`, `beep_on`, `baseline_cm` | What its newest reading said about itself |
| `soil_dry_raw`, `soil_wet_raw`, `rain_dry_raw`, `rain_wet_raw` | Raw ADC → % (4095 / 1400, 4095 / 1500) |
| `soil_flood_pct`, `soil_dry_pct`, `rain_light_pct`, `rain_heavy_pct`, `move_cm`, `too_hot_c` | Where the states start (85, 20, 20, 60, 10 cm, 45 °C) |
| `*_clear_*` | Where an alert ends (see Emergency alerts) |
| `alert_types`, `alert_confirm_readings`, `motion_confirm_readings`, `motion_clear_readings`, `alert_rearm_s`, `quiet_minutes` | Alert settings |
| `cal_version` | Goes up when a calibration or alert setting the edge uses changes; the edge fetches the node's settings again with its next upload |

A clear threshold must sit on the normal side of the one that opens the alert; the database refuses anything else. Because the readings are raw, you can calibrate a probe on site later and all past data follows.

**iot\_node\_status** (view, for the Sensors page). Each node with its newest reading worked out: `last_reading_at`, `age`, `temp_c` and `temp_state`, `soil_pct` and `soil_state` (`SATURATED`, `NORMAL`, `DRY`), `rain_pct` and `rain_state` (`HEAVY`, `RAIN`, `NONE`), `dist_state` (`OK`, `MOVED`, `NO_ECHO`), `motion`, `beep_on`, `rssi`, `quiet`, and how many alerts are going on (`open_alerts`, `urgent_alerts`). It leaves out the position.

**Upload limit (022).** One edge device can add at most 3,600 readings an hour, counted by when Supabase stored them (`inserted_at`). Three nodes send about 180 an hour. An upload that would go over gets HTTP 429 and none of it is kept; cloud-com keeps the batch and tries again, waiting 60 s, then 120 s, 240 s and every 5 minutes. Readings sent again don't count twice. After a long outage the backlog counts too, so a day's backlog from three nodes (about 4,300 readings) takes about two hours to arrive. To change the limit, change the number in 022 and run it again.

**Who sees what.** The public (anon) key can't read or change any IoT table. Nodes sit beside protected plants, so their positions (`iot_boots`) and the edges' positions (`iot_devices`) are staff only, and no public view reads them. edge-com connects to the database directly and isn't limited by Row Level Security, but it checks the device's token itself and only takes readings for nodes linked to that device.

## Files in the repo

The edge and ESP32 files are in the repo's `iot/` folder, and the Supabase files in `supabase/`. Copy `iot/edge-device` into the Ubuntu VM (Step 3); the Supabase and ESP32 files are opened from the repo on Windows. `iot/testing/` has sketches for trying one part at a time.

| File | Runs on | What it does |
| --- | --- | --- |
| `iot/edge-device/thing-com.py` | Ubuntu VM | node ↔ edge: MQTT binary frames and positions in, raw values into SQLite, quick alerts, commands out to the node |
| `iot/edge-device/cloud-com.py` | Ubuntu VM | edge ↔ cloud: gzip uploads every 60 s, quick alerts at once, refused batches set aside, brings commands and calibration back |
| `iot/edge-device/edge_db.py` | Ubuntu VM | Shared by both scripts: config and secrets, SQLite tables, the frame format, raw → % and state maths |
| `iot/edge-device/install-edge.sh` | Ubuntu VM | One-time installer: Mosquitto, Python, MQTT passwords, services |
| `iot/edge-device/reset-edge.sh` | Ubuntu VM | Deletes edge.db so the edge starts from empty; asks first, keeps config, secrets and passwords |
| `iot/edge-device/config.example.toml` | Ubuntu VM | Template for `/opt/iot-edge/config.toml`: nothing secret |
| `iot/edge-device/secrets.example.toml` | Ubuntu VM | Template for `/opt/iot-edge/secrets.toml`: device ID and token, Supabase address, MQTT passwords. Never commit `secrets.toml` (`.gitignore` leaves it out) |
| `iot/edge-device/iot-edge` | Ubuntu VM | Shortcut command: `iot-edge status`, `alerts`, `logs`, `sync`, `watch` … |
| `iot/edge-device/tools/fake-thing.py` | Ubuntu VM | Simulated ESP32 for testing without hardware |
| `iot/edge-device/mosquitto/field-node.conf`, `iot/edge-device/systemd/*.service` | Ubuntu VM | Broker settings and the two background services |
| `supabase/016_1 … 025_*.sql` | Supabase SQL Editor | The IoT tables, functions and view (see Cloud database) |
| `supabase/functions/edge-com/index.ts` | Supabase Edge Functions | **edge-com**: checks the device token, unpacks gzip, stores readings and positions, decides alerts and node status, returns commands and calibration |
| `iot/sensor-node/sensor-node.ino` | ESP32 (Arduino IDE) | The sensor node: sensors, sending on events, MQTT binary frames, its position, NTP time and the three commands |
| `iot/sensor-node/secrets.example.h` | ESP32 (Arduino IDE) | Copy it to `secrets.h` next to it and fill in the node's Wi-Fi, ID, edge address, node secret and position. git ignores `secrets.h`; never commit it |

edge-com is TypeScript, not Python: Supabase Edge Functions only run TypeScript or JavaScript on Deno. It needs no API keys; it reaches the database through `SUPABASE_DB_URL`, which Supabase gives every function.

What was tested before delivery:

- **Supabase side.** The eight migrations ran in order on PostgreSQL (PGlite) with stand-ins for 001–015 (roles, `has_any_role`, 001's `iot_nodes`), and then a second time; running one out of order stops with a message. Checked there: the token check, `cal_version` going up only for calibration changes, a named range check refusing 55 °C, `iot_raw_pct`, a QUIET alert raised once per silence, node status following the alerts, acknowledge and resolve, `iot_node_status`, sending a command, and the grants. The SQL in Step 1 for making a device token was run there too. 022, the upload limit, came later: `supabase/tests/iot-limit.test.js` checks it, with edge-com answering 429.
- **edge-com.** It passes Deno 2.9.6's type check, and ran on Deno against that database with real upload batches. Checked: a wrong token is turned down; a reading 10 minutes ahead is skipped; a node not linked to the device is skipped; a 55 °C value is left out while the rest of its reading is kept; a saturated reading opens an alert and the next normal one ends it; a quiet node gets a QUIET alert that ends when it sends again; a command goes out and comes back done; calibration is returned with the new alert types; a duplicate reading is stored once; the node's last state is recorded.
- **Edge.** The scripts compile. Earlier in this version: a refused batch is set aside and the next one goes through, `requeue` puts it back, a single saturated reading gives a quick alert, a 55 °C value is stored as empty, and the simulated ESP32 sends routine readings every 60 s and event readings after 5 s.
- **ESP32 sketch.** Checked with a C++ compiler against stand-ins for the Arduino libraries and the real ArduinoJson; its frame is the one the edge decodes.
- **Not tested.** The sketch hasn't been compiled in the Arduino IDE or run on a board. `install-edge.sh` and the full chain with a real Mosquitto haven't been run with this version, and nothing has run on the real Supabase project yet.

## Step 1 – Supabase: tables, edge-com and registration

About 15 minutes, done in a browser on Windows, in the project that already has migrations 001–015. You finish with the edge-com URL and the device token that the edge needs in Step 3.

**Create the tables**

1. Supabase → left sidebar → **SQL Editor** → **New query**.
2. For each of these files in `supabase/`, in this order, open it in Notepad, copy all of it, paste it into the editor and click **Run**. Expect "Success. No rows returned" each time:
   1. `016_1_iot_devices.sql`
   2. `016_2_iot_nodes.sql`
   3. `016_3_iot_device_tokens.sql`
   4. `016_4_iot_readings.sql`
   5. `017_iot_alerts.sql`
   6. `019_public_record_details.sql`, `020_record_photo_access.sql` and `021_role_changes.sql`, if they aren't in yet (`supabase/README.md`)
   7. `022_iot_reading_limit.sql`
   8. `023_iot_boots.sql`
   9. `024_iot_alert_state.sql`
   10. `025_iot_commands.sql`
3. Left sidebar → **Table Editor**: you should see `iot_alert_state`, `iot_alerts`, `iot_boots`, `iot_commands`, `iot_device_tokens`, `iot_devices`, `iot_nodes` and `iot_readings`.

**Deploy edge-com**

4. Left sidebar → **Edge Functions** → **Deploy a new function** → **Via Editor**.
5. Set the function name to `edge-com`. Delete the sample code in `index.ts`, paste the whole of `supabase/functions/edge-com/index.ts`, and click **Deploy function** (10–30 s).
6. Open the function's details tab and **turn off JWT verification**. edge-com checks the device's own token instead; with the check on, every upload gets HTTP 401.
7. Copy the function URL shown on its page. It looks like `https://abcdefghijklmnop.supabase.co/functions/v1/edge-com`. Keep it for Step 3.

**Register the edge device and its nodes**

Later the dashboard's Devices page will do this (`iot-edge register-sql` already describes it that way). Until it's built, do it in the SQL Editor. `iot_make_device_token()` only answers a signed-in admin, so the SQL Editor makes the token directly:

8. Add the device and make its token. Change the ID, name and zone for your region; the ID may use letters, digits and `-` (3–40 characters) and is the edge's `edge_id`:

```sql
insert into public.iot_devices (device_id, name, zone)
values ('NNP-EDGE-01', 'Edge, region 1', 'Niah HQ')
on conflict (device_id) do nothing;

with new_token as (
  select 'niah_device_' || replace(gen_random_uuid()::text, '-', '')
                        || replace(gen_random_uuid()::text, '-', '') as token
), saved as (
  insert into public.iot_device_tokens (device_id, token_hash)
  select 'NNP-EDGE-01', sha256(convert_to(token, 'UTF8')) from new_token
  on conflict (device_id) do update set token_hash = excluded.token_hash
  returning device_id
)
select saved.device_id, new_token.token from saved, new_token;

update public.iot_devices set token_made_at = now() where device_id = 'NNP-EDGE-01';
```

The result shows the token once. Copy it for Step 3; only its hash is kept, so a lost token can't be looked up, only replaced by running the same query again (the old one stops working straight away).

9. Add each sensor node and link it to the device. A node that isn't in `iot_nodes`, or is linked to another device, has its readings turned down:

```sql
insert into public.iot_nodes (node_id, name, zone, edge_device_id)
values ('NNP-IOT-01', 'Node 1', 'Niah HQ', 'NNP-EDGE-01')
on conflict (node_id) do update set edge_device_id = excluded.edge_device_id;
```

The node ID is the sketch's `NODE_ID` (letters, digits, `-` or `_`, up to 32). The new columns give it the default calibration and alert settings; change them in Table Editor → `iot_nodes` at any time.

**Free plan limits** that matter here: 500 MB database (shared with the rest of the Niah system), 500,000 function calls a month, and projects pause after 1 week of inactivity. One node makes about 1,440 readings a day plus its event readings; at about 295 bytes per reading with indexes, that is about 0.4 MB a day, so one node adds roughly 13 MB a month. Uploads every 60 s use about 43,200 calls a month per edge, plus one per quick alert.

## Step 2 – VirtualBox on the region's Wi-Fi

The nodes must reach the Ubuntu VM directly, so the VM needs its own address on the Wi-Fi the nodes use. In the field that is the region's access-point router; for the prototype it is the phone hotspot. VirtualBox's **Bridged Adapter** does that; the default NAT hides the VM behind Windows.

**Set the Wi-Fi to 2.4 GHz first.** The ESP32 cannot see 5 GHz networks.

- iPhone hotspot: Settings → Personal Hotspot → turn on **Maximize Compatibility**.
- Android hotspot: Hotspot settings → **AP band** (or Band) → **2.4 GHz**. The wording varies by phone.
- Router: use a 2.4 GHz network (or a router that offers one alongside 5 GHz).
- Use WPA2 (or WPA2/WPA3) security, not WPA3 only.

**Bridge the VM**

1. Connect the Windows laptop to the Wi-Fi.
2. Shut down the Ubuntu VM (not just close the window).
3. VirtualBox → select the VM → **Settings** → **Network** → **Adapter 1**.
4. **Attached to: Bridged Adapter**. **Name:** the laptop's Wi-Fi adapter (its name usually contains "Wi-Fi" or "Wireless"). Leave Promiscuous Mode on Deny. Click **OK**.
5. Start the VM, open a Terminal and run:

```bash
hostname -I
hostname
ping -c 3 supabase.com
```

The first line is the VM's IP address. It should start like the laptop's (`ipconfig` in Windows PowerShell shows it), e.g. both `172.20.10.x` on an iPhone hotspot. The second line is the VM's name; a node can find it as `<that name>.local`. The ping proves the VM has internet. On a router, give the VM a fixed address (a DHCP reservation) so the nodes' `EDGE_HOST` doesn't change.

Over Wi-Fi, VirtualBox shares the laptop's radio, so it rewrites the VM's network address on the way out. Normal traffic (IPv4, DHCP, MQTT, HTTPS) works this way.

**If the VM gets no address in bridged mode** (some laptops or phones refuse it), use NAT with port forwarding instead:

1. Adapter 1 → **Attached to: NAT** → **Advanced** → **Port Forwarding** → **+** → Protocol TCP, Host Port `1883`, Guest Port `1883` → **OK**.
2. In each node's `secrets.h`, set `EDGE_HOST` to the **laptop's** Wi-Fi IP (from `ipconfig`), not the VM's.
3. Windows may ask whether to allow VirtualBox through the firewall: allow it on **private and public** networks, because Windows often treats a phone hotspot as public.

## Step 3 – Edge software on the Ubuntu VM

One installer sets up the broker, Python, both scripts and their services. About 5 minutes.

**Get the edge files into the VM.** Easiest: in Firefox inside Ubuntu, download the repo as a zip from GitHub (**Code → Download ZIP**); it lands in `~/Downloads`. A `git clone` works too. Only the `iot/edge-device` folder is needed.

**Install**

```bash
sudo apt update && sudo apt install -y unzip
cd ~ && unzip -o ~/Downloads/<the repo>.zip
cd ~/<the repo folder>/iot/edge-device
sudo bash install-edge.sh
```

The installer:

1. Installs Mosquitto (the MQTT broker), Python's venv, SQLite and the mDNS service (so a node can find `<vm-name>.local`).
2. Creates a service account `iotedge` and the folder `/opt/iot-edge`, with the database in `/opt/iot-edge/data/edge.db`.
3. Installs the Python packages `paho-mqtt` and `requests` in `/opt/iot-edge/venv`.
4. Writes `/opt/iot-edge/config.toml` (nothing secret) and `/opt/iot-edge/secrets.toml`, readable only by root and `iotedge`. It creates random passwords for two MQTT accounts, `thing` for the nodes and `edge` for the scripts, and puts them in `secrets.toml`.
5. Opens Mosquitto on port 1883, password login only.
6. Installs `thing-com` and `cloud-com` as services that start at every boot and restart if they crash. `thing-com` starts now; `cloud-com` waits for the function URL and the device token.

At the end it prints the VM's IP and `.local` name, the `#define NODE_SECRET "…"` line for the nodes' `secrets.h`, and the registration steps. Keep that window open.

**Connect the edge to Supabase**

1. Put the device ID, token and edge-com URL from Step 1 in the secrets:

```bash
iot-edge secrets
```

Set `supabase_function_url` to your URL, `edge_id` to the device ID (e.g. `NNP-EDGE-01`) and `edge_key` to the token. Save with Ctrl+O, Enter, then exit with Ctrl+X.

2. Set the edge's position (optional): `sudo nano /opt/iot-edge/config.toml`, and in `[edge]` replace `nan` with the latitude and longitude in decimal degrees. Then run `iot-edge register-sql`: its last line is an `update public.iot_devices set latitude …` statement; paste it into the SQL Editor and **Run**.

3. Start the uploader and test one upload:

```bash
sudo systemctl start cloud-com
iot-edge sync
```

`upload OK` means the token, the URL and edge-com all work: the reply is HTTP 204 (nothing to say) or 200 with commands or calibration. With no node running yet it uploads 0 readings, and Supabase sends each linked node's calibration. The lines above it show the bytes sent and received.

**Settings worth knowing** in `config.toml` (after a change: `iot-edge restart`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `[edge] lat`, `lon` | nan | Where the edge is; reaches Supabase with the SQL from `iot-edge register-sql` |
| `[cloud] upload_interval_s` | 60 | Regular upload interval. Quick alerts don't wait for it, so a longer interval saves mobile data; the other readings, and so the ends of alerts, reach Supabase only this often |
| `[cloud] urgent_retry_s` | 10 | How often waiting quick-alert readings retry while uploads fail |
| `[cloud] gzip` | true | Compress uploads (edge-com accepts both) |
| `[cloud] retention_days` | 30 | Sent and set-aside readings older than this are deleted from edge.db |
| `[alerts] quick_window_s` | 300 | The same condition on the same node gets a quick upload again only after this long |
| `[alerts] types`, `confirm_readings`, `motion_confirm_readings` | SATURATED, HEAVY, MOVED, NO\_ECHO, MOTION; 1; 1 | Used for quick alerts until Supabase sends the node's own values |
| `[calibration]` | the sketch's values | Opening thresholds, used for a node until Supabase sends its own |

**Everyday commands**

| Command | Shows or does |
| --- | --- |
| `iot-edge status` | Readings stored, waiting, sent and set aside; each node's boot\_id, position and calibration; newest readings with % and states |
| `iot-edge alerts` | The latest quick alerts and how fast they reached Supabase |
| `iot-edge logs` | Live log of both services (Ctrl+C to stop) |
| `iot-edge watch` | Every MQTT message from the nodes; binary frames shown in hex and decoded |
| `iot-edge sync` | Upload right now and show Supabase's answer and the bytes used |
| `iot-edge requeue` | Put readings from batches Supabase refused back in the upload queue |
| `iot-edge fake-thing --count 12 --interval 5` | A simulated ESP32 sending 12 readings (`--node NNP-IOT-02`, `--flood-at 3 --flood-until 9`, `--soil-pct 90,90,82,70,70`, `--rain-at 3`, `--move-at 3`, `--motion-at 4,5`, `--lat 1.5533 --lon 110.3592`, `--no-clock`). Like the sketch, a reading in which a condition starts follows after `--event-gap` (5 s) |
| `iot-edge node-secret` | The `#define NODE_SECRET` line for the nodes' `secrets.h` |
| `iot-edge secrets` | Edit `secrets.toml` |
| `iot-edge register-sql` | The registration steps and the SQL for the edge's position |
| `iot-edge restart` | Restart both services after editing `config.toml` or `secrets.toml` |
| `iot-edge db` | Open `edge.db` in sqlite3, e.g. `select * from readings where is_sent = 0;` |

Running the installer again after updating the scripts keeps `config.toml`, `secrets.toml`, all passwords and edge.db. To empty edge.db, run `sudo bash reset-edge.sh` in the `iot/edge-device` folder: it asks you to type `RESET` first.

## Step 4 – ESP32 firmware

The sketch is in `iot/sensor-node`: `sensor-node.ino` and `secrets.example.h`. Copy `secrets.example.h` to `secrets.h` in the same folder and fill it in (git ignores `secrets.h`). The Arduino IDE needs the folder to keep the sketch's name, `sensor-node`. Board **ESP32 Dev Module** (core esp32 by Espressif Systems 3.3.12), Serial Monitor at 115200 baud.

**Libraries** (Arduino IDE → Sketch → Include Library → Manage Libraries):

| Search for | Install | Notes |
| --- | --- | --- |
| PubSubClient | **PubSubClient** by Nick O'Leary, 2.8 | MQTT client |
| ArduinoJson | **ArduinoJson** by Benoit Blanchon, 7.x | Commands and their replies only |
| DHT sensor library | **DHT sensor library** by Adafruit | Plus **Adafruit Unified Sensor** |

`WiFi` comes with the ESP32 core.

**Settings** in `secrets.h` (one copy per node; keep it out of git):

| Setting | Put in |
| --- | --- |
| `WIFI_SSID`, `WIFI_PASSWORD` | The region's Wi-Fi (prototype: the phone hotspot) |
| `NODE_ID` | e.g. `NNP-IOT-01`. It has to be in `iot_nodes`, linked to this region's edge device (Step 1); give each node its own |
| `EDGE_HOST` | The VM's IP from `hostname -I`, e.g. `"192.168.1.50"`, or its name + `.local` from the installer. NAT fallback: the laptop's IP |
| `NODE_SECRET` | The line from `iot-edge node-secret`: the password of the `thing` MQTT login, the same for every node of this region |
| `NODE_LAT`, `NODE_LON` | Where the node is installed, in decimal degrees (WGS84, e.g. from a phone's map app; south and west negative). Left as `NAN`, the position is recorded as empty |

**Wiring** (expansion board header: G = GND, V = supply, S = signal):

| Device | Pin | Board header | Notes |
| --- | --- | --- | --- |
| DHT11 | + / OUT / − | D21 (V) / D21 (S) / D21 (G) | Voltage jumper on 3.3 V |
| Soil probe | AO / VCC / GND | VP/36 (S) / D17 (S) / VP/36 (G) | Powered only while sampling |
| Rain pad | AO / VCC / GND | VN/39 (S) / D19 (S) / VN/39 (G) | Powered only while sampling |
| HC-SR04 | VCC / Trig / Echo / GND | 5V pin / D5 (S) / D16 (S) / D16 (G) | Echo through a 1k/2k divider (recommended) |
| Buzzer | + / − | D23 (S) / D23 (G) | |
| PIR HC-SR501 | VCC / OUT / GND | 5V pin / D27 (S) / D27 (G) | Needs 4.5–20 V; its output is 3.3 V, safe for the ESP32 |

On the PIR module, put the trigger jumper on **H** (repeat trigger: the output stays high while movement goes on) and turn the time pot fully anticlockwise (about 3 s). Set the sensitivity pot to mid-range to start. The sketch latches every rising edge with an interrupt, so a short pulse between checks still counts. It ignores the PIR for the first 60 s after power-up while the sensor settles. A pull-down on D27 makes an unplugged PIR read "no movement".

**What the firmware does**

- Joins the Wi-Fi and gets UTC time from NTP, so every reading carries its own measurement time.
- Sends a routine reading every 60 s, and one at once when a condition starts (see Emergency alerts), at most every 5 s. A routine reading that falls due first carries a waiting event with it.
- Sends `online` / `offline` with its `boot_id` to `field/<node_id>/status`, and sends no reading on a connection until that status message is out.
- Every reading goes into a buffer of 30 first, so readings leave in order. While the edge is unreachable they wait there; when it's full, the oldest make room. The Serial Monitor says how many are waiting and how many were dropped.
- Sets bit 1 of the frame's flags byte when the PIR saw movement at any moment since the previous reading. The frame stays 21 bytes.
- Once after each power-up, sends its `boot_id` and position to `field/<node_id>/info` (retained).
- Beeps every 5 s so it can be found, and executes `beep_on`, `beep_off` and `reset_baseline` from `field/<node_id>/cmd`, replying on `field/<node_id>/ack`. A command the edge resends is confirmed again but not repeated.
- Nothing is kept across a restart: the beep starts on, and the first good ultrasonic reading after each power-up becomes the baseline. A node that falls while running is still caught; one knocked over while it was off takes its new position as normal. Send `reset_baseline` after you reposition a node on purpose.
- The Serial Monitor prints each sensor's value and state and why the reading was sent, worked out with the sketch's own constants. They are for display only; the data is judged with the calibration in Supabase.

A healthy start in the Serial Monitor looks like this:

```
ESP32 field node NNP-IOT-01 started (boot_id 2840193877, beep on, baseline taken from the first good reading)
Position : 1.553300, 110.359200
PIR      : warming up for 60 s
WiFi     : connected to MyRouter, IP 192.168.1.61, RSSI -48 dBm
MQTT     : edge 192.168.1.50 is 192.168.1.50
MQTT     : connected to 192.168.1.50:1883 as thing

---- #1 (t = 3 s, routine) ----
```

## Step 4b – Test node + edge without Supabase

You can test the ESP32 and the edge completely before Supabase is connected. Install the edge as in Step 3 but skip "Connect the edge to Supabase"; cloud-com then stays stopped. Readings pile up in edge.db with `is_sent = 0` and nothing is lost: they upload later when you connect Supabase. Without Supabase the edge uses the `[calibration]` defaults.

To stand in for Supabase's commands, you insert a command into the edge's `commands` table yourself, with status `at_edge`. That is exactly where cloud-com puts one it fetched from Supabase, and thing-com delivers it the same way (step 5 below).

1. **Edge is running.** `systemctl status mosquitto thing-com --no-pager` shows both `active (running)`. Leave `iot-edge logs` open in a second terminal window.
2. **Node connects.** Power the ESP32. The Serial Monitor shows `MQTT : connected to … as thing`, and the log shows `NNP-IOT-01 is ONLINE (boot_id …)` and `NNP-IOT-01 power-up … at 1.553300, 110.359200` (or `no position set`). `iot-edge watch` prints a 21-byte frame every minute, in hex and decoded.
3. **Readings are stored.** Run `iot-edge status` a few times: "stored" and "waiting to send" grow by one a minute, and "sent" stays at 0. That is expected without Supabase.
4. **Sensors make sense.** Watch `iot-edge logs` and the Serial Monitor while you test each sensor. Each reading shows as `NNP-IOT-01 #12  28.4C 76%  soil 2310=66% NORMAL  rain 4095=0% NONE  dist 23.4cm OK  beep on  rssi -61dBm` (raw value = worked-out %):

| Action | Expected |
| --- | --- |
| Push the soil probe into wet soil or a glass of water | Within 10 s the Serial Monitor shows `Event : soil saturated` and a reading goes out; the log shows `SATURATED` from 85 % and a `QUICK ALERT NNP-IOT-01 SATURATED` line |
| Drip water on the rain pad | `Event : heavy rain` from 60 %, with a `QUICK ALERT` line |
| Move the node so the ultrasonic distance changes by more than 10 cm | After 3 s `Event : node moved`, `MOVED` in the log, with a `QUICK ALERT` line |
| Cover the ultrasonic sensor or point it at open sky | After 3 s `Event : echo lost`, `NO_ECHO` and distance `-`, with a `QUICK ALERT` line |
| Breathe on the DHT11 | Humidity jumps in the next readings |
| Wave a hand 1–2 m in front of the PIR (wait 60 s after power-up) | `Event : motion` at once, `MOTION` at the end of the log line, and a `QUICK ALERT NNP-IOT-01 MOTION` line. Another wave within 5 minutes gives no second quick-alert line |

Without Supabase the quick-alert readings wait in edge.db; `iot-edge alerts` lists them as `waiting`. The same condition on the same node gives another quick alert only after 5 minutes. Alerts themselves, their ends and the node status appear only in Supabase.

5. **Commands, as if from Supabase.** Open `iot-edge db` and insert a command (change `'beep_off'` to `'beep_on'` or `'reset_baseline'` for the others):

```sql
WITH r(h) AS (SELECT lower(hex(randomblob(16))))
INSERT INTO commands (id, node_id, command, created_at, expires_at, status, at_edge_at, updated_at)
SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21,12),
       'NNP-IOT-01', 'beep_off',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),
       'at_edge', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM r;
```

It gets a random UUID as its id, like one from Supabase. Within about a second the buzzer stops (`beep_on`: beeping resumes; `reset_baseline`: the Serial Monitor prints `new baseline … cm` on the next good reading). Check the result:

```sql
select command, status, publish_count, result from commands order by created_at desc limit 5;
```

The status reads `done` and the result `beep disabled (beep_on=false, ...)`. The log shows each step: `sent command beep_off to NNP-IOT-01`, then `NNP-IOT-01 acknowledged command …`.

6. **Command to an offline node.** Unplug the ESP32 and wait about a minute; the log shows `NNP-IOT-01 is OFFLINE`. Insert a `beep_off` as above: the `select` shows `at_edge`. Plug the ESP32 back in, and within seconds of it reconnecting the status becomes `done`. A command not delivered within 1 hour becomes `expired`.
7. **Edge outage.** Run `sudo systemctl stop mosquitto` for 3 minutes. The Serial Monitor prints `MQTT : edge not reachable, reading held (N waiting)` with each reading. After `sudo systemctl start mosquitto` it reconnects and prints `edge reachable again, held readings sent`; the held readings arrive in order with their own times, and there's no gap in the `seq` numbers:

```bash
iot-edge db
select seq, ts, received_at from readings order by id desc limit 10;
.quit
```

Before connecting Supabase later, decide whether the test data should go up with it. To start clean, run `sudo bash reset-edge.sh` in the `iot/edge-device` folder. Otherwise cloud-com uploads the whole backlog in batches of 500. Supabase simply ignores the status reports for these local test commands, because it never had them.

## Step 5 – Test the chain and send commands

Test in this order, so a fault shows up at the first link that breaks.

1. **Edge + cloud without the ESP32.** On the VM: `iot-edge fake-thing --count 6 --interval 5`, then `iot-edge status`. Within a minute all 6 should show `sent yes`. In Supabase → Table Editor → `iot_readings` they appear with `node_id` = NNP-IOT-01 and raw values only. (The simulated node has to be in `iot_nodes` and linked like a real one; otherwise the edge-com logs show `skipped … node is not linked to this device`.)
2. **An alert, its end and the node status.** `iot-edge fake-thing --count 10 --interval 5 --flood-at 3 --flood-until 7 --lat 1.5533 --lon 110.3592`. Reading 3 comes after 5 s, and the log shows `QUICK ALERT NNP-IOT-01 SATURATED (1 reading(s) in a row up to #3) -> uploading to Supabase now` and, within a second, `QUICK ALERT SATURATED sent to Supabase …`. In Supabase:

```sql
select type, severity, recorded_at, cleared_recorded_at, status from public.iot_alerts order by id desc limit 5;
select node_id, status from public.iot_nodes;
select node_id, boot_id, latitude, longitude, first_seq, last_seq from public.iot_boots;
```

The alert starts at reading 3 and the node's status is `threat_triggered`. After the next regular upload the alert has a `cleared_recorded_at` (it ended at reading 7) and the status is back to `online`. `iot_boots` shows the position.

3. **The real ESP32.** Flash it and run `iot-edge logs` on the VM. Each reading appears as a line like `NNP-IOT-01 #12  28.4C 76%  soil 2310=66% NORMAL …`, followed every minute by `uploaded 1 readings, 0 power-up positions, …`. The simulated readings stay in Supabase under a different `boot_id`; delete them if you like:

```sql
update public.iot_alert_state set open_alert_id = null
  where open_alert_id in (select id from public.iot_alerts where boot_id = <that id>);
delete from public.iot_alerts   where boot_id = <that id>;
delete from public.iot_readings where boot_id = <that id>;
delete from public.iot_boots    where boot_id = <that id>;
```

4. **Look at the data in Supabase** (SQL Editor). `iot_node_status` works out the values from the raw ones; for older readings use `iot_raw_pct` with the node's calibration:

```sql
select * from public.iot_node_status;                 -- each node, newest reading, states, alerts going on
select r.recorded_at at time zone 'Asia/Kuala_Lumpur' as myt, r.temp_c, r.hum_pct,
       r.soil_raw, public.iot_raw_pct(r.soil_raw, n.soil_dry_raw, n.soil_wet_raw) as soil_pct,
       r.rain_raw, public.iot_raw_pct(r.rain_raw, n.rain_dry_raw, n.rain_wet_raw) as rain_pct,
       r.dist_cm, r.baseline_cm, r.motion, r.rssi
from public.iot_readings r join public.iot_nodes n using (node_id)
where r.node_id = 'NNP-IOT-01' order by r.recorded_at desc limit 20;
select * from public.iot_boots order by position_at desc;   -- power-ups: position, first and last reading
```

5. **Send a command.** Insert a row into `iot_commands` (Table Editor → iot\_commands → Insert row, or SQL):

```sql
insert into public.iot_commands (node_id, command) values ('NNP-IOT-01', 'beep_off');
-- also: 'beep_on'  or  'reset_baseline'
```

Within about a minute the buzzer stops and the row reads `status = done`, with `result` like `beep disabled (beep_on=false, baseline_cm=23.4)`. Check with:

```sql
select command, status, created_at, done_at, result
from public.iot_commands order by created_at desc limit 5;
```

6. **Quiet node.** Unplug the ESP32 for 16 minutes while the edge keeps uploading. A `QUIET` alert opens and the node's status becomes `offline`; when the node sends again the alert ends and the status goes back to `online`.
7. **Outage test.** Turn off the internet for 3 minutes (the Wi-Fi stays up), and during it run `iot-edge fake-thing --count 4 --interval 5 --rain-at 2`. `iot-edge status` shows readings waiting, including quick-alert ones, and the log retries every 10 s. When the internet returns the quick-alert readings go first, the rest follows, the alert opens in Supabase, and nothing is lost.

A command travels in steps, and the `status` column shows where it is:

| Status | Meaning |
| --- | --- |
| `pending` | Waiting in Supabase for the edge's next upload (up to 60 s) |
| `at_edge` | Stored in the edge's SQLite, waiting for the node to be online |
| `sent` | Published to the node over MQTT; resent every 20 s until it replies |
| `done` / `failed` | The node replied; `result` holds its answer |
| `expired` | Not completed within 1 hour (`expires_at`), e.g. the node stayed offline |

## Message formats

Times leave the ESP32 as Unix seconds (UTC) and are stored as UTC.

**Node → edge** on `field/<node_id>/telemetry`, every 60 s and on events: binary, 21 bytes per reading, little-endian, no padding.

| Offset | Bytes | Field | Encoding |
| --- | --- | --- | --- |
| 0 | 4 | `seq` | uint32, counter since power-up (starts at 1) |
| 4 | 4 | `ts` | uint32 Unix seconds; `0` if the clock is not set yet, then the edge uses its arrival time (`ts_source = edge`) |
| 8 | 2 | `temp_c` | int16 in 0.1 °C; −32768 when the DHT11 read failed |
| 10 | 1 | `hum_pct` | uint8 %RH; 255 when the DHT11 read failed |
| 11 | 2 | `soil_raw` | uint16 ADC 0–4095 |
| 13 | 2 | `rain_raw` | uint16 ADC 0–4095 |
| 15 | 2 | `dist_cm` | uint16 in mm; 65535 = no echo |
| 17 | 2 | `baseline_cm` | uint16 in mm; 65535 = not set |
| 19 | 1 | `rssi` | int8 dBm, Wi-Fi signal at the node; 0 = not connected |
| 20 | 1 | flags | bit 0 = `beep_on`; bit 1 = `motion` (PIR movement since the previous reading); the other bits must be 0 |

Example: `d2040000 a80ee86a 2301 41 0609 ff0f ea00 e700 c3 01` is reading 1234 at 1793593000, 29.1 °C, 65 %RH, soil 2310, rain 4095, 23.4 cm from a 23.1 cm baseline, −61 dBm, beep on, no movement (flags `03` would add movement). Every message holds exactly one frame; anything else is rejected.

`soil_pct` = Arduino `map(raw, dry_raw, wet_raw, 0, 100)` clamped to 0–100, done with the same integer division in the ESP32, the edge and Supabase (`iot_raw_pct`). `soil_state`: `SATURATED` (≥ 85 %, flash-flood risk), `NORMAL`, `DRY` (≤ 20 %, erosion risk). `rain_state`: `HEAVY` (≥ 60 %), `RAIN` (≥ 20 %), `NONE`. `dist_state`: `NO_ECHO` without a distance, `MOVED` when more than 10 cm from `baseline_cm`, otherwise `OK`. `motion_state`: `MOTION` or `NONE`.

**Status** (retained) on `field/<node_id>/status`: `{"online":true,"boot_id":2840193877}`. The broker publishes the last will `{"online":false,"boot_id":2840193877}` itself about 45 s after the node drops off.

**Position** (retained, once per power-up) on `field/<node_id>/info`: `{"boot_id":2840193877,"lat":1.553300,"lon":110.359200}`, with `null` when `NODE_LAT` / `NODE_LON` are not set.

**Edge → node** on `field/<node_id>/cmd`: `{"id":"<uuid>","cmd":"beep_off"}`. **Reply** on `field/<node_id>/ack`: `{"id":"<uuid>","cmd":"beep_off","ok":true,"detail":"beep disabled","beep_on":false,"baseline_cm":23.4}`. Commands stay JSON; they are rare.

**Edge → cloud**: `POST <function_url>` with headers `x-edge-key: <device token>`, `Content-Encoding: gzip` and `Accept-Encoding: gzip`. The body before gzip:

```json
{"edge_id":"NNP-EDGE-01",
 "nodes":[{"node_id":"NNP-IOT-01","boot_id":2840193877,
           "rows":[[1234,1793593000,0,29.1,65,2310,4095,23.4,23.1,1,-61,0],
                   [1235,1793593005,0,29.1,65,1440,4095,23.4,23.1,1,-60,1]]}],
 "boots":[{"node_id":"NNP-IOT-01","boot_id":2840193877,"lat":1.5533,"lon":110.3592,
           "at":"2026-11-02T03:14:58.120Z"}],
 "command_updates":[{"id":"<uuid>","status":"done","at_edge_at":"...","sent_at":"...",
                     "done_at":"...","result":"beep disabled (beep_on=false, baseline_cm=23.4)"}],
 "cal_since":12}
```

`edge_id` is the device ID in `iot_devices`. Each row is `[seq, ts, lag, temp_c, hum_pct, soil_raw, rain_raw, dist_cm, baseline_cm, beep_on, rssi, motion]`. `ts` is the measurement time in Unix seconds. `lag` is the number of seconds from measuring to arriving at the edge, and `null` means `ts` is the edge's clock. A missing value is `null`. `node_id` and `boot_id` appear once per group, empty lists are left out, and `cal_since` is the newest calibration version the edge has. There is nothing about alerts: Supabase decides them from the readings. edge-com also accepts the same body without gzip.

What edge-com does with it:

- An unknown device, a wrong token and a device that's turned off all get the same HTTP 401, so nobody can find out which device IDs exist.
- Readings and positions from a node not linked to this device are skipped.
- A reading measured more than 5 minutes ahead of the server (a wrong clock) is skipped. Old readings are fine; they're stored for analysis.
- A sensor value outside what the part can measure is left out (stored empty), and the rest of the reading is kept.
- Everything skipped or left out is listed in the function's logs (Supabase → Edge Functions → edge-com → Logs). Each batch, with its alert decisions, is stored in one database transaction: all of it or none.

**Cloud → edge** (edge-com's reply): no per-reading acknowledgement. Any HTTP 2xx means the whole batch is handled and the edge marks it as sent. HTTP 400 or 422 means the batch itself is wrong, and the edge sets it aside. Any other status or a lost connection means the edge sends it again. Normally the reply is HTTP 204 with no body. When there is something for the edge it is HTTP 200 with `commands` and/or `calibration` (opening thresholds and alert settings):

```json
{"commands":[{"id":"<uuid>","node_id":"NNP-IOT-01","command":"reset_baseline","created_at":"...","expires_at":"..."}],
 "calibration":[{"node_id":"NNP-IOT-01","soil_dry_raw":4095,"soil_wet_raw":1400,"soil_flood_pct":85,"soil_dry_pct":20,
                 "rain_dry_raw":4095,"rain_wet_raw":1500,"rain_light_pct":20,"rain_heavy_pct":60,"move_cm":10,
                 "alert_types":["SATURATED","HEAVY","MOVED","NO_ECHO","MOTION","TOO_HOT","QUIET"],
                 "alert_confirm_readings":1,"motion_confirm_readings":1,"v":13}]}
```

Replies of 400 bytes or more are gzip-compressed.

## Network usage

Estimates for this version, worked out from message sizes measured on the earlier version (same frame and upload format), not measured again:

| Message | Size |
| --- | --- |
| Node → edge, one reading (whole MQTT packet incl. topic) | about 50 bytes |
| Edge → cloud, regular 60 s upload body (1 reading) | about 130 bytes |
| Edge → cloud, backlog upload body (500 readings) | about 5.6 KB |
| Cloud → edge, normal reply body | none (HTTP 204) |
| HTTP request headers | about 300 bytes |

Per day for one node (about 1,440 readings and 1,440 uploads, plus a few event readings and quick alerts):

| | Estimate |
| --- | --- |
| Node → edge MQTT (local Wi-Fi, not mobile data) | about 70 KB |
| Edge → cloud bodies (mobile data) | about 0.2 MB |
| Edge → cloud with HTTP headers, TLS and TCP | about 1.9 MB (about 60 MB a month) |

The estimate assumes about 700 bytes of response headers from Supabase and about 250 bytes of TLS and TCP framing per upload on a connection that stays open between uploads. `iot-edge sync` prints your real header sizes. If every upload has to open a new TLS connection, add roughly 5 KB per upload (about 7 MB a day at 60 s). Each upload carries about 1.2 KB of fixed overhead, shared by every node in the batch, so 10 nodes on one edge cost little more than one; a longer `upload_interval_s` is the main way to save mobile data, since quick alerts don't wait for it.

Storage: Supabase uses about 295 bytes per reading including indexes, about 0.4 MB per node per day. edge.db uses about 232 bytes per reading, about 0.33 MB per node per day; sent rows are deleted after 30 days, so the edge holds about 10 MB per node, plus whatever is still unsent.

## In the rainforest

How the solution should behave in the field, and where it will be limited.

**Wi-Fi range is the main limit.** Free-space loss at 2.4 GHz plus foliage loss from Weissberger's model, for a node with a +19.5 dBm transmitter and a 2 dBi antenna:

| Distance through foliage | Path loss | Signal at the access point |
| --- | --- | --- |
| 20 m | ~76 dB | ~−55 dBm |
| 50 m | ~91 dB | ~−70 dBm |
| 100 m | ~106 dB | ~−84 dBm |

The ESP32 datasheet gives −98 dBm receive sensitivity at 1 Mbit/s. A phone hotspot is usually less sensitive and transmits with less power than a router. Weissberger's model is for dry leafy trees. Wet leaves and a node sitting near the ground (the antennas then block their own Fresnel zone, about 1.8 m in radius at the middle of a 100 m path) can each cost another 10 dB or more. Expect reliable links over tens of metres. A 100 m radius needs the access point mounted high, with external antennas, or a radio built for range such as LoRa. The 21-byte frame is small enough for a single LoRa packet, so a LoRa gateway could carry the same frame and publish it to the same MQTT topic.

**What the binary frame does for the radio.** Each reading's Wi-Fi data frame is about 141 bytes instead of about 417 with JSON, counting TCP/IP and 802.11 headers. At the 1 Mbit/s rate a weak link falls back to, that is 1.3 ms on air instead of 3.5 ms. Fewer bits mean fewer chances of corruption.

**Node-to-edge drop-outs.** The node keeps its last 30 readings (about 30 minutes at one a minute), so a short drop-out (weak Wi-Fi, the edge restarting) delays readings without losing them. A longer one loses the oldest; the Serial Monitor counts them and `iot_boots` (first and last `seq`) shows the gap. Because readings leave once a minute, an outage at the node costs far fewer readings than before.

**The mobile link out.** Coverage in the interior is patchy, so plan for long offline spells:

- The edge keeps every unsent reading and never deletes it; Supabase accepts old readings and stores them for analysis.
- A day offline costs about 3 catch-up requests of about 5.6 KB each.
- Quick-alert readings wait at the edge, retry every 10 s, and go first when the link returns. An alert that started more than an hour before it reaches Supabase is recorded but marked `from_backlog`.
- A node whose edge is down becomes `QUIET` in Supabase after 15 minutes, as soon as any other edge uploads or a staff page asks.
- Without internet the ESP32 has no NTP time, so readings carry the edge's arrival time (`ts_source = edge`). The edge needs a correct clock of its own.

**Power.** The sketch never sleeps. Typical figures for the ESP32 chip are 30–68 mA with the CPU at 240 MHz, about 95–100 mA while the radio listens, and 240 mA while it transmits at 1 Mbit/s. Sending once a minute instead of every 5 s cuts transmit time, but the always-on Wi-Fi and CPU dominate, so battery life is roughly unchanged. Real savings need deep sleep between readings. A laptop running a VM draws tens of watts; a small single-board computer running Ubuntu should run the same scripts on a few watts, though that wasn't tested here. Under the canopy only a small fraction of sunlight reaches the ground, so a solar panel needs a gap in the canopy or a mount above it.

**Sensors in constant humidity.** The DHT11 is specified for 20–90 %RH (±5 %RH) and 0–50 °C (±2 °C). Rainforest air spends long periods above 90 %RH, so expect it to sit at its upper limit and to suffer from condensation. An SHT3x/SHT4x in a vented radiation shield is the usual upgrade, and would also let `TOO_HOT` see higher temperatures (the database's 0–50 °C check would then need widening). The HC-SR04 isn't sealed. Condensation and rain drops give `NO_ECHO` or false `MOVED` readings; the node only reports them after 3 checks in a row, lasting trouble opens one alert, and after it ends the 5-minute gap holds back repeats. A waterproof JSN-SR04T fits the same wiring idea; until then you can remove `NO_ECHO` from the node's `alert_types` in `iot_nodes` if it is noisy. The soil probe and rain pad are powered only while sampling, which slows corrosion. Because Supabase keeps the raw values, you can calibrate them on site later (`soil_wet_raw`, `soil_dry_raw` … in `iot_nodes`) and all past data follows.

**Movement detection.** A PIR sees warm bodies against a cooler background. In lowland Borneo the air is often 25–33 °C, close to the surface temperature of fur, clothing and skin, so the contrast is small: range drops, and a sunlit leaf or a warm gust can look like an animal. Condensation on the lens and swaying foliage add false triggers. Options, from cheapest change to most capable:

| Option | How it works | Strengths | Weaknesses | Fit here |
| --- | --- | --- | --- | --- |
| PIR, well placed | Passive infrared, the current sensor | Cheap, under 0.1 mA, no setup | Weak in heat; foliage and sun false triggers | Keep as one input; shade it and aim at a steady background |
| 24 GHz mmWave radar (e.g. HLK-LD2410C) | Doppler radar with distance gates you set per 0.75 m | Works in any temperature and darkness, sees through a plastic box, can ignore leaves close to the node | Rain gives noise; draws ~80 mA | Good partner for the PIR; its OUT pin wires like the PIR's |
| 60 GHz radar | Same idea at a higher band | Copes with rain better than 24 GHz in published tests | Costlier modules | Upgrade if 24 GHz is noisy in rain |
| Dual technology (PIR **and** radar) | Movement counts only when both agree within ~2 s | Removes most false alarms of each, the standard trick in outdoor security | Two sensors to power | **Recommended next step**; still one bit in the frame |
| Beam break or lidar across a trail | Active IR beam, or a ToF lidar measuring across the path | Very reliable "something crossed this line" | Needs a trail to watch and alignment; fog and heavy rain block it | For a known path or stream crossing |
| Camera with AI check | PIR or radar triggers a camera; a model tells person, animal or nothing | Says what moved; ends false alarms | Power, data, image storage; heavier work at the edge | Later: confirm alerts at the edge, send only the label |
| Ground vibration (geophone) | Buried sensor picks up footsteps | Hidden; foliage doesn't matter | Rain and falling branches; short range | Niche |
| Sound (microphone + classifier) | Recognises chainsaws, engines, gunshots | Covers hundreds of metres, aimed at illegal logging or poaching | Needs an audio model; not "movement" as such | If the real goal is intrusion or logging |

**Where to mount the node and the edge on a tree.**

| Part | Height | Why |
| --- | --- | --- |
| Sensor node enclosure | About 1.5 m, and at least 0.5 m above the highest flood mark on the trunk (mud lines, debris caught in bark) | Reachable for service, above floods; good height for the PIR to see people |
| PIR / radar | 1–1.5 m for people; about 0.5 m for mammals (the height camera-trap studies in Borneo use), aimed level or slightly down along the path, 2–5 m from it | Below the canopy clutter, with a background that doesn't move |
| Ultrasonic | Pointing straight down at bare ground from the enclosure | It measures a steady distance; over a stream the same reading would show rising water |
| DHT11 (or SHT4x) | 1.25–2 m, in a vented radiation shield on the shaded side | The standard height for air temperature and humidity |
| Rain pad | On an arm out of the trunk's shelter, tilted about 30–45° so water runs off | Under the canopy it reads drip, and later than the rain itself |
| Soil probe | In the soil 0.5–1 m from the trunk, cable run down the trunk | Away from the root plate and stem flow |
| Edge enclosure | 3–6 m, below the canopy top | Clears more of the Wi-Fi Fresnel zone (about 1.8 m radius mid-way on a 100 m path) and gives the 4G modem a better view; out of reach of people and most animals. Avoid the tallest (emergent) tree, which draws lightning, and dead branches overhead |

**Attaching to a tree.** The usual way is straps, not nails or screws: a nylon or polyester strap with a cam or ratchet buckle (as used for camera traps), or a stainless steel band clamp for long-term mounts, through slots in a backing board (HDPE or marine plywood) that the enclosure is screwed to. Put rubber (EPDM) pads between board and bark, leave a little slack, and check every 6–12 months, because the trunk grows and a tight strap cuts into it. Nails and screws wound the tree, let fungus in, are usually not allowed in protected areas, and are a hazard to anyone cutting the tree later. Add a steel cable lock through the enclosure against theft. Choose a live, sound, upright trunk about 20–40 cm across, bring every cable in from below with a drip loop, and point the enclosure's openings downwards. In Sarawak's national parks and other protected forest, check the permit conditions for fixing equipment to trees.

## Troubleshooting

Start with `iot-edge logs` on the VM, the Serial Monitor on the ESP32, and Supabase → Edge Functions → edge-com → **Logs**; most faults name themselves there.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| ESP32 never prints `WiFi : connected` | Wi-Fi on 5 GHz or WPA3-only, or a typo | 2.4 GHz / Maximize Compatibility, WPA2; check `WIFI_SSID` and password in `secrets.h` |
| `MQTT : cannot resolve … .local` | The Wi-Fi does not pass mDNS between devices | Put the VM's IP from `hostname -I` in `EDGE_HOST` |
| `MQTT : connect failed (state -2)` | The node cannot reach port 1883: VM off, not bridged, wrong IP, or NAT without port forwarding | Redo Step 2; on the VM, `hostname -I` must be on the Wi-Fi's network |
| `MQTT : connect failed (state 4)` or `(state 5)` | Wrong `NODE_SECRET` | `iot-edge node-secret`, copy the line into `secrets.h` and flash again |
| `reading ignored: no status message with a boot_id from this node yet` | The edge has never seen this node's status message, e.g. a test message published by hand | The ESP32 sends it on every connect; reset the ESP32 and check `iot-edge watch` for `field/<node_id>/status` |
| `telemetry rejected: N bytes is not one frame of 21 bytes` | Something else publishes on the telemetry topic, or a sketch with another frame | Flash `iot/sensor-node/sensor-node.ino` from the repo |
| Two nodes keep going ONLINE / OFFLINE | Two ESP32s with the same `NODE_ID` (same MQTT client id) | Give each its own `NODE_ID` |
| cloud-com won't start: `Set edge_key in secrets.toml first` or `Set supabase_function_url …` | The token or the URL is still the placeholder | `iot-edge secrets`, then `sudo systemctl start cloud-com` |
| `iot-edge sync`: HTTP 401 mentioning a JWT or authorization header | JWT verification is still on for edge-com | Turn it off on the function's details tab (Step 1, item 6) |
| HTTP 401 `this device can't send readings` | `edge_id` isn't in `iot_devices`, the token doesn't match, or the device is turned off (`enabled`) | Check `edge_id` and `edge_key` in `secrets.toml`; make a new token (Step 1, item 8) if in doubt |
| edge-com logs `skipped … node is not linked to this device` | The node isn't in `iot_nodes`, or its `edge_device_id` is another device | Add or link it (Step 1, item 9). The edge counts those readings as delivered, so link nodes before they start sending |
| `Supabase refused the batch (HTTP 400 …)` and `Refused` in `iot-edge status` | edge-com didn't accept the batch's format, e.g. an edge-com that isn't the one from this repo | Deploy `supabase/functions/edge-com/index.ts` from the repo, then `iot-edge requeue` |
| HTTP 429 `This device has sent too many readings in the last hour` | The edge sent more than 3,600 readings in the last hour (022), usually while catching up after an outage | Nothing to do: cloud-com keeps the readings and tries again, and they go in once the hour's count is lower. If it lasts with no backlog, check `iot-edge status` for a node sending far too often |
| HTTP 404 | `supabase_function_url` mistyped, or the function is not named `edge-com` | Compare with the URL on the function's page, then `iot-edge restart` |
| HTTP 500 `server error: …` | edge-com could not use the database, or the migrations haven't all run | Supabase → Edge Functions → edge-com → **Logs**. For a connection error, add a secret `EDGE_COM_DB_URL` with the **Session pooler** string from the **Connect** button, then redeploy |
| `upload failed, will retry: ConnectionError` | VM has no internet | `ping -c 3 supabase.com`; check the mobile data. Nothing is lost meanwhile |
| Gaps in `seq` | The node couldn't reach the edge for more than its 30 held readings | Check Wi-Fi strength (`rssi`) and that the edge was running |
| A migration stops with `… needs … to be run first` | Run out of order | Run the files in the order of Step 1 |
| No quick alert although a reading was SATURATED / HEAVY … | The same condition had a quick alert less than `quick_window_s` ago, or the state is not in the node's `alert_types` | `iot-edge alerts`; the readings still go up with the regular upload |
| No alert in Supabase | An alert of that kind is already going on, the last one ended less than `alert_rearm_s` ago, or the state is not in `alert_types` | `select * from public.iot_alert_state where node_id = 'NNP-IOT-01';` shows the counts and the open alert |
| An alert does not end | The value is back below the opening threshold but not past the clear threshold (e.g. soil between 80 and 85 %) | Wait, or change the node's `*_clear_*` values in `iot_nodes` |
| Many `MOTION` alerts with nobody there | Sun patches warming leaves, branches swaying in the PIR's view, or rain on the lens | Aim it at a steady background in shade, lower the sensitivity pot, raise `motion_confirm_readings` to 2, or remove `MOTION` from the node's `alert_types` |
| `MOTION` never appears | Within 60 s of power-up, PIR on 3.3 V, or wired to the wrong pin | Wait a minute; power it from 5V; `iot-edge watch` shows `motion 1` when the bit arrives |
| Many `NO_ECHO` or `MOVED` alerts in rain | The HC-SR04 is wet or obstructed | Remove `NO_ECHO` from the node's `alert_types`, shield the sensor or use a waterproof one |
| Temperature empty in Supabase | The DHT11 read failed, or the value was outside 0–50 °C | The edge-com and edge logs say which; check the DHT11 wiring |
| Soil or rain % look wrong | Calibration does not match this probe | Change the node's row in `iot_nodes`; the view and the edge follow |
| `iot_boots` has no position for a node | `NODE_LAT` / `NODE_LON` left as `NAN` in `secrets.h` | Set them and flash the sketch again; the next power-up records the position |
| Inserting a command fails with a foreign key error | That `node_id` isn't in `iot_nodes` | Check the spelling, or add the node (Step 1, item 9) |
| Command stays `pending` | cloud-com is not running, or the node isn't linked to this edge | `sudo systemctl status cloud-com`; check the node's `edge_device_id` |
| Command stays `at_edge` | The node is offline | `iot-edge watch` shows its `status` messages; it is delivered once the node reconnects |
| Many rows with `ts_source = edge` | The ESP32 cannot reach the NTP time servers | Make sure the Wi-Fi has internet; it fixes itself once NTP answers |
| Supabase dashboard says the project is paused | Free projects pause after 1 week without activity | **Restore project** in the dashboard; the edge uploads its backlog afterwards |

## Sources

Checked on 2–4 November 2026.

- [Supabase: Getting Started with Edge Functions (Dashboard)](https://supabase.com/docs/guides/functions/quickstart-dashboard): deploying via the editor, function URL, tester
- [Supabase: Handling Compressed Requests](https://supabase.com/docs/guides/functions/compression): gzip request bodies reach the function as-is and are decompressed in its code
- [Supabase: Edge Function 401 error response](https://supabase.com/docs/guides/troubleshooting/edge-function-401-error-response.md): turning off JWT verification on the function's details tab
- [Supabase: Securing Edge Functions](https://supabase.com/docs/guides/functions/auth.md) and [Function Configuration](https://supabase.com/docs/guides/functions/function-configuration): `verify_jwt` behaviour
- [Supabase: Environment Variables](https://supabase.com/docs/guides/functions/secrets): `SUPABASE_DB_URL` and the other default secrets
- [Supabase: Integrating with Supabase Database (Postgres)](https://supabase.com/docs/guides/functions/connect-to-postgres.md): direct Postgres connections from functions
- [Supabase pricing](https://supabase.com/pricing): Free plan limits (500 MB, 500,000 invocations, pause after 1 week)
- [VirtualBox manual: Bridged Networking](https://docs.oracle.com/en/virtualization/virtualbox/6.0/user/network_bridged.html): how bridging over Wi-Fi works
- [Analytical Modelling of the Impact of Foliage Cover on the Propagation Loss (arXiv 2511.11449)](https://arxiv.org/pdf/2511.11449) and [Weissberger's model](https://en.wikipedia.org/wiki/Weissberger%27s_model): the foliage loss formula
- [ESP32 Datasheet V2.7 (Espressif)](https://cdn.sparkfun.com/assets/learn_tutorials/8/5/2/esp32_datasheet_en.pdf): −98 dBm sensitivity at 1 Mbit/s, +19.5 dBm output, 240 mA transmit, 95–100 mA receive
- [ESP32 power consumption explained (JLCPCB)](https://jlcpcb.com/blog/esp32-power-consumption-explained): ESP32 current in modem sleep
- [DHT11 module specifications (ProtoSupplies)](https://protosupplies.com/product/dht11-humidity-and-temp-sensor-module/): DHT11 range and accuracy
- [Borneo Nature Foundation: Placing Camera Traps SOP](https://www.borneonaturefoundation.org/wp-content/uploads/2014/07/Placing-Camera-Traps-SOP.pdf): about 50 cm above ground, about 2 m from the trail, mounted higher near streams that flood
- [OPTEX: How well do PIR sensors work in warmer climates](https://www.optex-europe.com/news-events/how-well-do-pir-sensors-work-in-warmer-climates): PIR detection struggles when body and background temperature are close
- [Rutronik: Radar vs. Rain, 24 GHz and 60 GHz outdoor presence tests](https://www.rutronik.com/article/radar-vs-rain-testing-24ghz-and-60ghz-sensors-for-reliable-outdoor-presence-detection): rain shows as noise, 24 GHz more affected than 60 GHz
- [HLK-LD2410 (atomic14)](https://www.atomic14.com/esp32/sensors/hlk-ld2410/): 24 GHz radar module with configurable distance gates, used with the ESP32
