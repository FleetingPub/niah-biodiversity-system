// =============================================================================
// edge-com - Supabase Edge Function (TypeScript / Deno)
//
// Receives gzip-compressed batches from cloud-com.py on each forest region's edge device, checks
// the device's token, stores the raw values in iot_readings, decides alerts in iot_alerts, keeps
// each node's status up to date, and hands back commands and calibration for that device's nodes.
//
//   POST https://<project-ref>.supabase.co/functions/v1/edge-com
//   Header  x-edge-key: <the device's token, made on the Devices page>
//           Content-Encoding: gzip        (plain JSON is accepted too)
//   Body    { "edge_id": "NNP-EDGE-01",                       // = iot_devices.device_id
//             "nodes": [ { "node_id": "NNP-IOT-01", "boot_id": 2840193877,
//                          "rows": [ [seq, ts, lag, temp_c, hum_pct, soil_raw, rain_raw,
//                                     dist_cm, baseline_cm, beep_on, rssi, motion], ... ] } ],
//             "boots": [ { "node_id", "boot_id", "lat", "lon", "at" } ],   // positions, once per power-up
//             "command_updates": [ {...}, ... ],
//             "cal_since": 7 }
//     ts  = measurement time, Unix seconds UTC
//     lag = seconds from measurement to arrival at the edge; null = ts is the edge's clock
//
//   Reply   HTTP 204 (no body) when the batch is stored and there is nothing for the edge;
//           HTTP 200 { "commands": [...], "calibration": [...] } when there is.
//           HTTP 401 for an unknown device, a wrong token or a device that's turned off (all the
//           same answer, so nobody can find out which device IDs exist).
//           HTTP 429 when the device has sent more than 3,600 readings in the last hour (022).
//           Nothing from the batch is kept, and the edge sends it again later.
//           Any 2xx means the whole batch is handled: the edge marks it as sent.
//
// What gets in
//   * Only nodes an admin has linked to this device (iot_nodes.edge_device_id). Readings and
//     positions from any other node are skipped and listed in this function's logs.
//   * A sensor value outside what the part can measure is left out (stored empty), and the rest of
//     the reading is kept. The ranges match the database's checks (016_4) and the edge's.
//   * A reading measured more than 5 minutes ahead of the server (a wrong clock) is skipped. Old
//     readings are fine, they're stored for analysis.
//
// Alerts (rules in 017): from the new readings, with each node's settings in iot_nodes.
//   An alert whose start is more than an hour before it opens came from the edge's backlog after an
//   outage: it's recorded with its real times but marked from_backlog, so it doesn't count in the
//   staff menu. QUIET alerts are raised by iot_raise_quiet_alerts() after every upload and ended
//   here when a node sends again.
//
// Soil %, rain % and the states are NOT stored: iot_raw_pct() and the iot_node_status view work
// them out from the raw values with each node's calibration.
//
// Deploy: Dashboard -> Edge Functions -> Deploy a new function -> Via Editor,
// name it  edge-com , paste this file, Deploy. Then turn OFF JWT verification
// for this function: it checks the device's own token instead.
//
// It connects to the database with SUPABASE_DB_URL, which Supabase provides to every function
// automatically, so Row Level Security doesn't apply to it. No API keys are needed in this code.
// =============================================================================

import postgres from "npm:postgres@3.4.9";
import { gunzipSync, gzipSync } from "node:zlib";

// SUPABASE_DB_URL is provided automatically. Only if the function logs show it
// cannot reach the database, add a secret EDGE_COM_DB_URL with the "Session
// pooler" connection string (Dashboard -> Connect) and it is used instead.
const DB_URL = Deno.env.get("EDGE_COM_DB_URL") || Deno.env.get("SUPABASE_DB_URL") || "";

const sql = postgres(DB_URL, {
  prepare: false,   // also works through Supabase's connection pooler
  max: 3,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: "prefer",
});

const MAX_READINGS = 1000;
const MAX_UPDATES = 200;
const MAX_BOOTS = 100;
const MAX_COMMANDS_OUT = 50;
const MAX_BODY_BYTES = 4 * 1024 * 1024;       // after decompression
const GZIP_REPLY_FROM = 400;                  // smaller replies are sent plain (gzip would add bytes)
const AHEAD_S = 5 * 60;                       // a reading this far in the future has a wrong clock
const BACKLOG_MS = 60 * 60 * 1000;            // an alert that started longer ago than this is from a backlog
const DEVICE_RE = /^[A-Za-z0-9-]{3,40}$/;     // iot_devices.device_id
const NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;      // iot_nodes.node_id
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPDATE_STATES = ["at_edge", "sent", "done", "failed", "expired"];
const ROUTINE = new Set(["DRY", "RAIN"]);     // every other alert type is urgent

// Order of the values in each row (must match ROW_FIELDS in cloud-com.py).
const ROW_FIELDS = [
  "seq", "ts", "lag", "temp_c", "hum_pct", "soil_raw", "rain_raw",
  "dist_cm", "baseline_cm", "beep_on", "rssi", "motion",
] as const;

// Columns written to public.iot_readings.
const READING_COLUMNS = [
  "node_id", "device_id", "boot_id", "seq", "recorded_at", "ts_source", "received_at",
  "temp_c", "hum_pct", "soil_raw", "rain_raw", "dist_cm", "baseline_cm", "beep_on", "rssi", "motion",
] as const;

// What the edge needs from public.iot_nodes (it spots quick alerts with these).
const CAL_COLUMNS = [
  "soil_dry_raw", "soil_wet_raw", "soil_flood_pct", "soil_dry_pct",
  "rain_dry_raw", "rain_wet_raw", "rain_light_pct", "rain_heavy_pct", "move_cm",
  "alert_types", "alert_confirm_readings", "motion_confirm_readings",
] as const;

type Reading = {
  node_id: string;
  device_id: string;
  boot_id: number;
  seq: number;
  recorded_at: Date;
  ts_source: string;
  received_at: Date;
  temp_c: number | null;
  hum_pct: number | null;
  soil_raw: number | null;
  rain_raw: number | null;
  dist_cm: number | null;
  baseline_cm: number | null;
  beep_on: boolean | null;
  rssi: number | null;
  motion: boolean | null;
};
type CommandUpdate = {
  id: string;
  status: string;
  at_edge_at: Date | null;
  sent_at: Date | null;
  done_at: Date | null;
  result: string | null;
};
type Boot = { node_id: string; boot_id: number; lat: number | null; lon: number | null; at: Date };

class Invalid extends Error {}

// ----------------------------------------------------------------- helpers
function reply(req: Request, status: number, body: unknown): Response {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (json.length >= GZIP_REPLY_FROM && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
    headers["Content-Encoding"] = "gzip";
    return new Response(Uint8Array.from(gzipSync(json)), { status, headers });
  }
  return new Response(json, { status, headers });
}

// A number from r[name]. Out of range or not a number: with leaveOut, it's noted there and left
// out (null); without, the whole item is turned down.
function num(
  r: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  opts: { int?: boolean; required?: boolean; leaveOut?: string[] } = {},
): number | null {
  const v = r[name];
  if (v === null || v === undefined) {
    if (opts.required) throw new Invalid(`${name} is required`);
    return null;
  }
  let problem = "";
  if (typeof v !== "number" || !Number.isFinite(v)) problem = `${name} must be a number`;
  else if (opts.int && !Number.isInteger(v)) problem = `${name} must be a whole number`;
  else if (v < min || v > max) problem = `${name}=${v} is outside ${min}..${max}`;
  if (!problem) return v as number;
  if (opts.leaveOut) {
    opts.leaveOut.push(problem);
    return null;
  }
  throw new Invalid(problem);
}

function flag(r: Record<string, unknown>, name: string, leaveOut: string[]): boolean | null {
  const v = r[name];
  if (v === null || v === undefined) return null;
  if (v === 0 || v === 1) return v === 1;
  leaveOut.push(`${name} must be 0 or 1`);
  return null;
}

function time(r: Record<string, unknown>, name: string, required: boolean): Date | null {
  const v = r[name];
  if (v === null || v === undefined) {
    if (required) throw new Invalid(`${name} is required`);
    return null;
  }
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw new Invalid(`${name} must be an ISO-8601 time`);
  if (t < Date.UTC(2020, 0, 1) || t > Date.now() + 24 * 3600 * 1000) {
    throw new Invalid(`${name}=${v} is not a plausible time`);
  }
  return new Date(t);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const raw = new Uint8Array(await req.arrayBuffer());
  let bytes: Uint8Array = raw;
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {          // gzip magic number
    bytes = gunzipSync(raw, { maxOutputLength: MAX_BODY_BYTES });
  } else if (raw.length > MAX_BODY_BYTES) {
    throw new RangeError("body too large");
  }
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new SyntaxError("not an object");
  return body;
}

// ----------------------------------------------------------------- validation
function validateRow(input: unknown, nodeId: string, bootId: number, deviceId: string, leftOut: string[]): Reading {
  if (!Array.isArray(input) || input.length !== ROW_FIELDS.length) {
    throw new Invalid(`a reading must be an array of ${ROW_FIELDS.length} values`);
  }
  const r: Record<string, unknown> = {};
  ROW_FIELDS.forEach((f, i) => (r[f] = input[i]));
  const tsS = num(r, "ts", Date.UTC(2020, 0, 1) / 1000, Number.MAX_SAFE_INTEGER, { int: true, required: true }) as number;
  if (tsS > Date.now() / 1000 + AHEAD_S) {
    throw new Invalid(`measured ${Math.round(tsS - Date.now() / 1000)} s in the future (wrong clock?)`);
  }
  const lag = num(r, "lag", 0, 10 * 365 * 86400, { int: true });
  // Same ranges as the checks on iot_readings (016_4)
  return {
    node_id: nodeId,
    device_id: deviceId,
    boot_id: bootId,
    seq: num(r, "seq", 0, Number.MAX_SAFE_INTEGER, { int: true, required: true }) as number,
    recorded_at: new Date(tsS * 1000),
    ts_source: lag === null ? "edge" : "device",
    received_at: new Date((tsS + (lag ?? 0)) * 1000),
    temp_c: num(r, "temp_c", 0, 50, { leaveOut: leftOut }),
    hum_pct: num(r, "hum_pct", 0, 100, { leaveOut: leftOut }),
    soil_raw: num(r, "soil_raw", 0, 4095, { int: true, leaveOut: leftOut }),
    rain_raw: num(r, "rain_raw", 0, 4095, { int: true, leaveOut: leftOut }),
    dist_cm: num(r, "dist_cm", 0, 1000, { leaveOut: leftOut }),
    baseline_cm: num(r, "baseline_cm", 0, 1000, { leaveOut: leftOut }),
    beep_on: flag(r, "beep_on", leftOut),
    rssi: num(r, "rssi", -127, 0, { int: true, leaveOut: leftOut }),
    motion: flag(r, "motion", leftOut),
  };
}

function validateUpdate(input: unknown): CommandUpdate {
  if (typeof input !== "object" || input === null) throw new Invalid("update must be an object");
  const u = input as Record<string, unknown>;
  if (typeof u.id !== "string" || !UUID_RE.test(u.id)) throw new Invalid("id must be a command uuid");
  if (typeof u.status !== "string" || !UPDATE_STATES.includes(u.status)) {
    throw new Invalid(`status must be one of ${UPDATE_STATES.join(", ")}`);
  }
  const result = u.result;
  if (result !== null && result !== undefined && typeof result !== "string") {
    throw new Invalid("result must be text");
  }
  return {
    id: u.id,
    status: u.status,
    at_edge_at: time(u, "at_edge_at", false),
    sent_at: time(u, "sent_at", false),
    done_at: time(u, "done_at", false),
    result: typeof result === "string" ? result.slice(0, 300) : null,
  };
}

function validateBoot(input: unknown): Boot {
  if (typeof input !== "object" || input === null) throw new Invalid("boot must be an object");
  const b = input as Record<string, unknown>;
  if (typeof b.node_id !== "string" || !NODE_RE.test(b.node_id)) throw new Invalid("node_id is malformed");
  const lat = num(b, "lat", -90, 90);
  const lon = num(b, "lon", -180, 180);
  return {
    node_id: b.node_id,
    boot_id: num(b, "boot_id", 0, 4294967295, { int: true, required: true }) as number,
    // iot_boots keeps both or neither
    lat: lat === null || lon === null ? null : lat,
    lon: lat === null || lon === null ? null : lon,
    at: time(b, "at", true) as Date,
  };
}

// ----------------------------------------------------------------- alerts
// The rules (also described in 017_iot_alerts.sql):
//  1 an alert opens after alert_confirm_readings readings in a row show the condition;
//    it starts at the first of them (MOTION: motion_confirm_readings)
//  2 it ends after as many readings in a row are back past the clear threshold
//    (MOTION: motion_clear_readings readings in a row without movement)
//  3 while it is going on, the same condition cannot open another one
//  4 after it ends, the same condition stays quiet for alert_rearm_s (readings' clock)
// QUIET isn't judged from readings: iot_raise_quiet_alerts() raises it, and a new reading ends it.
type Eval = {
  id: string; node_id: string; boot_id: string; seq: string; recorded_at: Date;
  temp_c: number | null; soil_pct: number | null; rain_pct: number | null;
  dist_cm: number | null; baseline_cm: number | null; motion: boolean | null;
};
type NodeCfg = Record<string, unknown> & { node_id: string; name: string; alert_types: string[] };
type State = {
  node_id: string; type: string; last_reading_at: Date | null;
  run_count: number; run_boot_id: string | null; run_seq: string | null; run_started_at: Date | null;
  clear_count: number; clear_started_at: Date | null; open_alert_id: string | null; last_cleared_at: Date | null;
};

// "enter" = the reading shows the condition, "clear" = back past the clear threshold,
// "hold" = in between, null = the reading cannot tell (e.g. no distance for MOVED).
function alertTest(kind: string, e: Eval, c: NodeCfg): "enter" | "clear" | "hold" | null {
  const n = (k: string) => Number(c[k]);
  const pick = (p: number | null, enter: boolean, clear: boolean) =>
    p === null ? null : enter ? "enter" : clear ? "clear" : "hold";
  switch (kind) {
    case "SATURATED":
      return pick(e.soil_pct, (e.soil_pct ?? 0) >= n("soil_flood_pct"), (e.soil_pct ?? 0) < n("soil_flood_clear_pct"));
    case "DRY":
      return pick(e.soil_pct, (e.soil_pct ?? 0) <= n("soil_dry_pct"), (e.soil_pct ?? 0) > n("soil_dry_clear_pct"));
    case "HEAVY":
      return pick(e.rain_pct, (e.rain_pct ?? 0) >= n("rain_heavy_pct"), (e.rain_pct ?? 0) < n("rain_heavy_clear_pct"));
    case "RAIN":
      return pick(e.rain_pct, (e.rain_pct ?? 0) >= n("rain_light_pct"), (e.rain_pct ?? 0) < n("rain_light_clear_pct"));
    case "TOO_HOT":
      return pick(e.temp_c, (e.temp_c ?? 0) >= n("too_hot_c"), (e.temp_c ?? 0) < n("too_hot_clear_c"));
    case "MOVED": {
      if (e.dist_cm === null || e.baseline_cm === null) return null;
      const delta = Math.abs(Math.round(e.dist_cm * 10) - Math.round(e.baseline_cm * 10));
      return delta > Math.round(n("move_cm") * 10) ? "enter" : delta <= Math.round(n("move_clear_cm") * 10) ? "clear" : "hold";
    }
    case "NO_ECHO":
      return e.dist_cm === null ? "enter" : "clear";
    case "MOTION":
      return e.motion === null ? null : e.motion ? "enter" : "clear";
  }
  return null;
}

// deno-lint-ignore no-explicit-any
async function evaluateAlerts(tx: any, deviceId: string, ids: string[]) {
  const out = { opened: 0, ended: 0 };
  if (ids.length === 0) return out;
  const evals: Eval[] = await tx`
    select r.id, r.node_id, r.boot_id, r.seq, r.recorded_at, r.temp_c, r.dist_cm, r.baseline_cm, r.motion,
           public.iot_raw_pct(r.soil_raw, n.soil_dry_raw, n.soil_wet_raw) as soil_pct,
           public.iot_raw_pct(r.rain_raw, n.rain_dry_raw, n.rain_wet_raw) as rain_pct
    from public.iot_readings r
    join public.iot_nodes n on n.node_id = r.node_id
    where r.id = any(${ids}::bigint[])
    order by r.node_id, r.recorded_at, r.seq`;
  const nodeIds = [...new Set(evals.map((e) => e.node_id))];
  const cfgs: NodeCfg[] = await tx`
    select node_id, name, soil_flood_pct, soil_dry_pct, rain_light_pct, rain_heavy_pct, move_cm, too_hot_c,
           soil_flood_clear_pct, soil_dry_clear_pct, rain_light_clear_pct, rain_heavy_clear_pct, move_clear_cm,
           too_hot_clear_c, alert_types, alert_confirm_readings, motion_confirm_readings, motion_clear_readings,
           alert_rearm_s
    from public.iot_nodes where node_id = any(${nodeIds}::text[]) for update`;
  const cfgOf = new Map(cfgs.map((c) => [c.node_id, c]));
  const rows: State[] = await tx`select * from public.iot_alert_state where node_id = any(${nodeIds}::text[])`;
  const states = new Map(rows.map((s) => [`${s.node_id}/${s.type}`, s]));
  const touched = new Set<State>();

  for (const e of evals) {
    const c = cfgOf.get(e.node_id);
    if (!c) continue;
    for (const kind of c.alert_types) {
      if (kind === "QUIET") continue;
      const confirm = Number(kind === "MOTION" ? c.motion_confirm_readings : c.alert_confirm_readings);
      const clearN = kind === "MOTION" ? Number(c.motion_clear_readings) : confirm;
      const key = `${e.node_id}/${kind}`;
      let st = states.get(key);
      if (!st) {
        st = { node_id: e.node_id, type: kind, last_reading_at: null, run_count: 0, run_boot_id: null, run_seq: null,
               run_started_at: null, clear_count: 0, clear_started_at: null, open_alert_id: null, last_cleared_at: null };
        states.set(key, st);
      }
      if (st.last_reading_at && e.recorded_at.getTime() < st.last_reading_at.getTime()) continue;  // older than what was judged
      st.last_reading_at = e.recorded_at;
      touched.add(st);
      const r = alertTest(kind, e, c);
      if (r === null) continue;
      if (st.open_alert_id !== null) {                      // going on: wait for the end
        if (r !== "clear") { st.clear_count = 0; continue; }
        if (st.clear_count === 0) st.clear_started_at = e.recorded_at;
        st.clear_count++;
        if (st.clear_count < clearN) continue;
        await tx`update public.iot_alerts
                 set cleared_recorded_at = ${st.clear_started_at}, cleared_at = now()
                 where id = ${st.open_alert_id}`;
        st.last_cleared_at = st.clear_started_at;
        st.open_alert_id = null;
        st.clear_count = 0;
        out.ended++;
        continue;
      }
      if (r !== "enter") {                                  // not going on: count readings in a row
        st.run_count = 0;
        continue;
      }
      if (st.run_count === 0) { st.run_boot_id = e.boot_id; st.run_seq = e.seq; st.run_started_at = e.recorded_at; }
      st.run_count++;
      if (st.run_count < confirm) continue;
      if (st.last_cleared_at && e.recorded_at.getTime() - st.last_cleared_at.getTime() < Number(c.alert_rearm_s) * 1000) continue;
      const started = st.run_started_at as Date;
      const [a] = await tx`
        insert into public.iot_alerts as t (node_id, node_name, device_id, type, severity, boot_id, seq,
                                            recorded_at, confirmed_recorded_at, from_backlog)
        values (${e.node_id}, ${c.name}, ${deviceId}, ${kind}, ${ROUTINE.has(kind) ? "routine" : "urgent"},
                ${st.run_boot_id}, ${st.run_seq}, ${started}, ${e.recorded_at},
                ${Date.now() - started.getTime() > BACKLOG_MS})
        on conflict (node_id, type, boot_id, seq) do update set confirmed_recorded_at = t.confirmed_recorded_at
        returning id`;
      st.open_alert_id = a.id;
      st.run_count = 0;
      st.clear_count = 0;
      out.opened++;
    }
  }
  for (const st of touched) {
    await tx`
      insert into public.iot_alert_state ${tx(st, "node_id", "type", "last_reading_at", "run_count", "run_boot_id",
                                              "run_seq", "run_started_at", "clear_count", "clear_started_at",
                                              "open_alert_id", "last_cleared_at")}
      on conflict (node_id, type) do update set
        last_reading_at = excluded.last_reading_at, run_count = excluded.run_count,
        run_boot_id = excluded.run_boot_id, run_seq = excluded.run_seq, run_started_at = excluded.run_started_at,
        clear_count = excluded.clear_count, clear_started_at = excluded.clear_started_at,
        open_alert_id = excluded.open_alert_id, last_cleared_at = excluded.last_cleared_at`;
  }

  // A node that sends again ends its QUIET alert, if the reading is new enough to say it's back
  // (an old one from a buffer doesn't: the node could still be quiet now).
  const quiet = await tx`
    update public.iot_alerts as a
    set cleared_recorded_at = x.newest, cleared_at = now()
    from (select r.node_id, max(r.recorded_at) as newest
          from public.iot_readings r where r.id = any(${ids}::bigint[]) group by r.node_id) as x
    join public.iot_nodes as n on n.node_id = x.node_id
    where a.node_id = x.node_id and a.type = 'QUIET' and a.cleared_at is null
      and x.newest > a.recorded_at
      and x.newest >= now() - make_interval(mins => n.quiet_minutes)
    returning a.id`;
  out.ended += quiet.length;
  return out;
}

// ----------------------------------------------------------------- handler
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply(req, 405, { error: "use POST" });
  if (!DB_URL) return reply(req, 500, { error: "SUPABASE_DB_URL is not set" });

  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (e) {
    if (e instanceof RangeError) return reply(req, 413, { error: "body larger than 4 MB" });
    return reply(req, 400, { error: "body is not valid (gzip-compressed) JSON" });
  }

  const deviceId = body.edge_id;
  const token = req.headers.get("x-edge-key") ?? "";
  if (typeof deviceId !== "string" || !DEVICE_RE.test(deviceId) || token.length < 16 || token.length > 200) {
    return reply(req, 401, { error: "missing or malformed edge_id / x-edge-key" });
  }

  const groupsIn = Array.isArray(body.nodes) ? body.nodes : [];
  const bootsIn = Array.isArray(body.boots) ? body.boots : [];
  const updatesIn = Array.isArray(body.command_updates) ? body.command_updates : [];
  const calSince = typeof body.cal_since === "number" && Number.isInteger(body.cal_since) ? body.cal_since : 0;
  let total = 0;
  for (const g of groupsIn) total += Array.isArray(g?.rows) ? g.rows.length : 0;
  if (total > MAX_READINGS || updatesIn.length > MAX_UPDATES || bootsIn.length > MAX_BOOTS) {
    return reply(req, 413, { error: `send at most ${MAX_READINGS} readings, ${MAX_UPDATES} updates, ${MAX_BOOTS} boots` });
  }

  try {
    // The same answer for an unknown device, a wrong token and a device that's turned off
    const [device] = await sql`
      select d.device_id
      from public.iot_devices d
      join public.iot_device_tokens t on t.device_id = d.device_id
      where d.device_id = ${deviceId} and d.enabled
        and t.token_hash = sha256(convert_to(${token}, 'UTF8'))`;
    if (!device) return reply(req, 401, { error: "this device can't send readings" });

    const linked = new Set<string>(
      (await sql`select node_id from public.iot_nodes where edge_device_id = ${deviceId}`).map((r) => r.node_id),
    );

    // Validate everything before touching the database; what fails a check is skipped and logged.
    const skipped: string[] = [];
    const notes: string[] = [];
    const rows: Reading[] = [];
    for (const g of groupsIn as Record<string, unknown>[]) {
      const nodeId = g?.node_id;
      const bootId = g?.boot_id;
      let groupError = "";
      if (typeof nodeId !== "string" || !NODE_RE.test(nodeId)) groupError = "node_id must be 1-32 letters, digits, - or _";
      else if (!linked.has(nodeId)) groupError = "node is not linked to this device (Devices page / iot_nodes)";
      else if (typeof bootId !== "number" || !Number.isInteger(bootId) || bootId < 0 || bootId > 4294967295) {
        groupError = "boot_id must be a whole number 0..4294967295";
      }
      const groupRows = (Array.isArray(g?.rows) ? g.rows : []) as unknown[];
      if (groupError) {
        if (groupRows.length) skipped.push(`${groupRows.length} reading(s) from ${String(nodeId)}: ${groupError}`);
        continue;
      }
      for (const r of groupRows) {
        const leftOut: string[] = [];
        const where = `reading ${nodeId}/${bootId}/#${Array.isArray(r) ? r[0] : "?"}`;
        try {
          rows.push(validateRow(r, nodeId as string, bootId as number, deviceId, leftOut));
          if (leftOut.length) notes.push(`${where}: left out ${leftOut.join("; ")}`);
        } catch (e) {
          if (!(e instanceof Invalid)) throw e;
          skipped.push(`${where}: ${e.message}`);
        }
      }
    }
    const updates: CommandUpdate[] = [];
    for (const u of updatesIn) {
      try {
        updates.push(validateUpdate(u));
      } catch (e) {
        if (!(e instanceof Invalid)) throw e;
        skipped.push(`command update ${String((u as Record<string, unknown>)?.id)}: ${e.message}`);
      }
    }
    const boots: Boot[] = [];
    for (const b of bootsIn) {
      try {
        const v = validateBoot(b);
        if (!linked.has(v.node_id)) throw new Invalid("node is not linked to this device");
        boots.push(v);
      } catch (e) {
        if (!(e instanceof Invalid)) throw e;
        skipped.push(`boot ${JSON.stringify(b)}: ${e.message}`);
      }
    }

    // One transaction: either the whole batch is stored or nothing is.
    const out = await sql.begin(async (tx) => {
      // 1. Nodes: the state each one reported in its newest reading, unless a newer one is already
      // stored (an old batch from a buffer doesn't overwrite it). Status follows in step 5.
      const newest = new Map<string, Reading>();
      for (const row of rows) {
        const cur = newest.get(row.node_id);
        if (!cur || row.recorded_at.getTime() > cur.recorded_at.getTime()) newest.set(row.node_id, row);
      }
      for (const n of newest.values()) {
        await tx`
          update public.iot_nodes as t set
            last_heartbeat = ${n.recorded_at},
            last_rssi      = ${n.rssi},
            beep_on        = ${n.beep_on},
            baseline_cm    = ${n.baseline_cm}
          where t.node_id = ${n.node_id} and t.edge_device_id = ${deviceId}
            and not exists (select 1 from public.iot_readings r
                            where r.node_id = t.node_id and r.recorded_at > ${n.recorded_at})`;
      }

      // 2. Readings: duplicates (same node_id, boot_id, seq) are skipped.
      let ids: string[] = [];
      if (rows.length > 0) {
        const res = await tx`
          insert into public.iot_readings ${tx(rows, ...READING_COLUMNS)}
          on conflict (node_id, boot_id, seq) do nothing
          returning id`;
        ids = res.map((r) => String(r.id));
      }

      // 3. Power-ups: position (once per power-up) and the first / last reading of each.
      for (const b of boots) {
        await tx`
          insert into public.iot_boots as t (node_id, boot_id, device_id, latitude, longitude, position_at)
          values (${b.node_id}, ${b.boot_id}, ${deviceId}, ${b.lat}, ${b.lon}, ${b.at})
          on conflict (node_id, boot_id) do update set
            device_id = excluded.device_id, latitude = excluded.latitude, longitude = excluded.longitude,
            position_at = excluded.position_at`;
      }
      const spans = new Map<string, { node_id: string; boot_id: number; first: Reading; last: Reading }>();
      for (const row of rows) {
        const k = `${row.node_id}/${row.boot_id}`;
        const b = spans.get(k);
        if (!b) spans.set(k, { node_id: row.node_id, boot_id: row.boot_id, first: row, last: row });
        else {
          if (row.seq < b.first.seq) b.first = row;
          if (row.seq > b.last.seq) b.last = row;
        }
      }
      for (const b of spans.values()) {
        await tx`
          insert into public.iot_boots as t (node_id, boot_id, device_id, first_seq, first_recorded_at,
                                             last_seq, last_recorded_at)
          values (${b.node_id}, ${b.boot_id}, ${deviceId}, ${b.first.seq}, ${b.first.recorded_at},
                  ${b.last.seq}, ${b.last.recorded_at})
          on conflict (node_id, boot_id) do update set
            device_id = excluded.device_id,
            first_recorded_at = case when t.first_seq is null or excluded.first_seq < t.first_seq
                                     then excluded.first_recorded_at else t.first_recorded_at end,
            first_seq = least(t.first_seq, excluded.first_seq),
            last_recorded_at  = case when t.last_seq is null or excluded.last_seq > t.last_seq
                                     then excluded.last_recorded_at else t.last_recorded_at end,
            last_seq  = greatest(t.last_seq, excluded.last_seq)`;
      }

      // 4. Alerts from the new readings, then nodes that have gone quiet (any edge's).
      const alerts = await evaluateAlerts(tx, deviceId, ids);
      const [q] = await tx`select public.iot_raise_quiet_alerts() as raised`;

      // 5. Each node's status from its alerts.
      if (newest.size > 0) {
        await tx`select public.iot_refresh_node_status(${[...newest.keys()]}::text[])`;
      }

      // 6. Command status changes reported by the edge (never move backwards).
      for (const u of updates) {
        await tx`
          update public.iot_commands c set
            status     = ${u.status},
            at_edge_at = coalesce(c.at_edge_at, ${u.at_edge_at}),
            sent_at    = coalesce(c.sent_at, ${u.sent_at}),
            done_at    = coalesce(c.done_at, ${u.done_at}),
            result     = coalesce(${u.result}, c.result)
          from public.iot_nodes n
          where c.id = ${u.id}::uuid
            and n.node_id = c.node_id
            and n.edge_device_id = ${deviceId}
            and (case c.status when 'pending' then 0 when 'at_edge' then 1 when 'sent' then 2 else 3 end)
              < (case ${u.status}::text when 'at_edge' then 1 when 'sent' then 2 else 3 end)`;
      }

      // 7. Commands that waited too long without reaching an edge.
      await tx`
        update public.iot_commands
        set status = 'expired', done_at = now(), result = 'expired before reaching the edge'
        where status = 'pending' and expires_at < now()`;

      // 8. Commands waiting for this device's nodes.
      const commands = await tx`
        select c.id, c.node_id, c.command, c.created_at, c.expires_at
        from public.iot_commands c
        join public.iot_nodes n on n.node_id = c.node_id
        where n.edge_device_id = ${deviceId} and c.status = 'pending' and c.expires_at > now()
        order by c.created_at
        limit ${MAX_COMMANDS_OUT}`;

      // 9. Calibration / alert settings the edge does not have yet.
      const calibration = await tx`
        select node_id, ${tx(CAL_COLUMNS as unknown as string[])}, cal_version as v
        from public.iot_nodes
        where edge_device_id = ${deviceId} and cal_version > ${calSince}
        order by cal_version`;

      await tx`update public.iot_devices set last_heard_at = now() where device_id = ${deviceId}`;
      return { inserted: ids.length, alerts, quiet: Number(q.raised), commands, calibration };
    });

    for (const s of skipped) console.warn(`${deviceId}: skipped ${s}`);
    for (const n of notes) console.warn(`${deviceId}: ${n}`);
    console.log(
      `${deviceId}: ${rows.length} readings (${out.inserted} new, ${rows.length - out.inserted} duplicate, ` +
        `${skipped.length} skipped), ${boots.length} positions, alerts ${out.alerts.opened} opened / ` +
        `${out.alerts.ended} ended / ${out.quiet} quiet, ${updates.length} command updates, ` +
        `${out.commands.length} commands out, ${out.calibration.length} calibrations out`,
    );

    const res: Record<string, unknown> = {};
    if (out.commands.length) res.commands = out.commands;
    if (out.calibration.length) res.calibration = out.calibration.map((c) => ({ ...c, v: Number(c.v) }));
    if (Object.keys(res).length === 0) return new Response(null, { status: 204 });
    return reply(req, 200, res);
  } catch (e) {
    // 022: the device has sent more than its readings for the hour. Nothing from this batch was
    // kept, and the edge sends it again later.
    if ((e as { code?: string }).code === "PT429") {
      console.warn(`edge-com: ${(e as Error).message}, so nothing from this batch was kept`);
      return reply(req, 429, { error: (e as Error).message });
    }
    console.error("edge-com failed:", e);
    return reply(req, 500, { error: `server error: ${(e as Error).message}` });
  }
});
