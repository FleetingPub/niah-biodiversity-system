// The parts of the sensor pages that are safe for the browser: the rows, the words for each alert,
// the maths that turns raw sensor values into percentages and states, and the checks on what staff
// type. Nothing here reads the clock or the database.

import { plural } from "./format";

export type AlertSeverity = "urgent" | "routine";
export type AlertStatus = "open" | "acknowledged" | "resolved";
export type AlertType =
  | "SATURATED"
  | "DRY"
  | "HEAVY"
  | "RAIN"
  | "MOVED"
  | "NO_ECHO"
  | "MOTION"
  | "TOO_HOT"
  | "QUIET";
export type NodeHealth = "online" | "warning" | "threat_triggered" | "offline";
export type CommandName = "beep_on" | "beep_off" | "reset_baseline";
export type CommandStatus = "pending" | "at_edge" | "sent" | "done" | "failed" | "expired";

export const ALERT_TYPES: AlertType[] = [
  "SATURATED",
  "DRY",
  "HEAVY",
  "RAIN",
  "MOVED",
  "NO_ECHO",
  "MOTION",
  "TOO_HOT",
  "QUIET",
];

export type SensorAlert = {
  id: number;
  nodeId: string;
  nodeName: string;
  deviceId: string;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  /** When it started: the measurement time of its first reading (QUIET: the last reading before the silence) */
  recordedAt: string;
  confirmedAt: string;
  /** It started over an hour before it was opened, because its readings came from an edge's backlog */
  fromBacklog: boolean;
  /** The first reading back to normal; null while it's going on */
  clearedRecordedAt: string | null;
  clearedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
};

/** One row of the iot_node_status view: a node and its newest reading, worked out from raw. */
export type NodeStatus = {
  nodeId: string;
  name: string;
  zone: string;
  edgeDeviceId: string | null;
  health: NodeHealth;
  lastReadingAt: string | null;
  tempC: number | null;
  tempState: string | null;
  humPct: number | null;
  soilPct: number | null;
  soilState: string | null;
  rainPct: number | null;
  rainState: string | null;
  distCm: number | null;
  baselineCm: number | null;
  distState: string | null;
  motion: boolean | null;
  beepOn: boolean | null;
  rssi: number | null;
  quiet: boolean;
  openAlerts: number;
  urgentAlerts: number;
};

/** A node's own calibration and alert settings, from iot_nodes */
export type NodeSettings = {
  nodeId: string;
  soilDryRaw: number;
  soilWetRaw: number;
  soilFloodPct: number;
  soilDryPct: number;
  rainDryRaw: number;
  rainWetRaw: number;
  rainLightPct: number;
  rainHeavyPct: number;
  moveCm: number;
  tooHotC: number;
  soilFloodClearPct: number;
  soilDryClearPct: number;
  rainLightClearPct: number;
  rainHeavyClearPct: number;
  moveClearCm: number;
  tooHotClearC: number;
  alertTypes: AlertType[];
  alertConfirmReadings: number;
  motionConfirmReadings: number;
  motionClearReadings: number;
  alertRearmS: number;
  quietMinutes: number;
};

export type HistoryReading = {
  recordedAt: string;
  tempC: number | null;
  humPct: number | null;
  soilRaw: number | null;
  rainRaw: number | null;
  distCm: number | null;
  baselineCm: number | null;
  motion: boolean | null;
};

export type SensorCommand = {
  id: string;
  nodeId: string;
  command: CommandName;
  status: CommandStatus;
  createdAt: string;
  createdByName: string | null;
  doneAt: string | null;
  result: string | null;
};

export type EdgeDevice = {
  deviceId: string;
  name: string;
  zone: string | null;
  enabled: boolean;
  lastHeardAt: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type NodePosition = { nodeId: string; latitude: number; longitude: number; positionAt: string | null };

// The columns the pages read. None of them gets a select("*"), so a column added later for staff
// only can't leak into a page by accident.
export const NODE_COLUMNS =
  "node_id, name, zone, edge_device_id, status, last_reading_at, temp_c, temp_state, hum_pct, soil_pct, soil_state, rain_pct, rain_state, dist_cm, baseline_cm, dist_state, motion, beep_on, rssi, quiet, open_alerts, urgent_alerts";
export const SETTINGS_COLUMNS =
  "node_id, soil_dry_raw, soil_wet_raw, soil_flood_pct, soil_dry_pct, rain_dry_raw, rain_wet_raw, rain_light_pct, rain_heavy_pct, move_cm, too_hot_c, soil_flood_clear_pct, soil_dry_clear_pct, rain_light_clear_pct, rain_heavy_clear_pct, move_clear_cm, too_hot_clear_c, alert_types, alert_confirm_readings, motion_confirm_readings, motion_clear_readings, alert_rearm_s, quiet_minutes";
export const ALERT_COLUMNS =
  "id, node_id, node_name, device_id, type, severity, status, recorded_at, confirmed_at, from_backlog, cleared_recorded_at, cleared_at, acknowledged_at, acknowledged_by_name, resolved_at, resolved_by_name";
export const HISTORY_COLUMNS = "recorded_at, temp_c, hum_pct, soil_raw, rain_raw, dist_cm, baseline_cm, motion";
export const COMMAND_COLUMNS = "id, node_id, command, status, created_at, created_by_name, done_at, result";
export const DEVICE_COLUMNS = "device_id, name, zone, enabled, last_heard_at, latitude, longitude";
export const POSITION_COLUMNS = "node_id, latitude, longitude, position_at";

type Row = Record<string, unknown>;

/** Postgres numerics can arrive as strings, and a value a sensor didn't send is null */
function numberOrNull(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

function textOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function boolOrNull(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

export function alertFromRow(row: Row): SensorAlert {
  return {
    id: Number(row.id),
    nodeId: String(row.node_id),
    nodeName: String(row.node_name ?? ""),
    deviceId: String(row.device_id ?? ""),
    type: row.type as AlertType,
    severity: row.severity as AlertSeverity,
    status: row.status as AlertStatus,
    recordedAt: String(row.recorded_at),
    confirmedAt: String(row.confirmed_at),
    fromBacklog: row.from_backlog === true,
    clearedRecordedAt: textOrNull(row.cleared_recorded_at),
    clearedAt: textOrNull(row.cleared_at),
    acknowledgedAt: textOrNull(row.acknowledged_at),
    acknowledgedByName: textOrNull(row.acknowledged_by_name),
    resolvedAt: textOrNull(row.resolved_at),
    resolvedByName: textOrNull(row.resolved_by_name),
  };
}

export function nodeFromRow(row: Row): NodeStatus {
  return {
    nodeId: String(row.node_id),
    name: String(row.name ?? ""),
    zone: String(row.zone ?? ""),
    edgeDeviceId: textOrNull(row.edge_device_id),
    health: (textOrNull(row.status) ?? "online") as NodeHealth,
    lastReadingAt: textOrNull(row.last_reading_at),
    tempC: numberOrNull(row.temp_c),
    tempState: textOrNull(row.temp_state),
    humPct: numberOrNull(row.hum_pct),
    soilPct: numberOrNull(row.soil_pct),
    soilState: textOrNull(row.soil_state),
    rainPct: numberOrNull(row.rain_pct),
    rainState: textOrNull(row.rain_state),
    distCm: numberOrNull(row.dist_cm),
    baselineCm: numberOrNull(row.baseline_cm),
    distState: textOrNull(row.dist_state),
    motion: boolOrNull(row.motion),
    beepOn: boolOrNull(row.beep_on),
    rssi: numberOrNull(row.rssi),
    quiet: row.quiet === true,
    openAlerts: Number(row.open_alerts ?? 0),
    urgentAlerts: Number(row.urgent_alerts ?? 0),
  };
}

export function settingsFromRow(row: Row): NodeSettings {
  const n = (key: string) => Number(row[key]);
  return {
    nodeId: String(row.node_id),
    soilDryRaw: n("soil_dry_raw"),
    soilWetRaw: n("soil_wet_raw"),
    soilFloodPct: n("soil_flood_pct"),
    soilDryPct: n("soil_dry_pct"),
    rainDryRaw: n("rain_dry_raw"),
    rainWetRaw: n("rain_wet_raw"),
    rainLightPct: n("rain_light_pct"),
    rainHeavyPct: n("rain_heavy_pct"),
    moveCm: n("move_cm"),
    tooHotC: n("too_hot_c"),
    soilFloodClearPct: n("soil_flood_clear_pct"),
    soilDryClearPct: n("soil_dry_clear_pct"),
    rainLightClearPct: n("rain_light_clear_pct"),
    rainHeavyClearPct: n("rain_heavy_clear_pct"),
    moveClearCm: n("move_clear_cm"),
    tooHotClearC: n("too_hot_clear_c"),
    alertTypes: Array.isArray(row.alert_types)
      ? (row.alert_types as unknown[]).filter((t): t is AlertType => ALERT_TYPES.includes(t as AlertType))
      : [],
    alertConfirmReadings: n("alert_confirm_readings"),
    motionConfirmReadings: n("motion_confirm_readings"),
    motionClearReadings: n("motion_clear_readings"),
    alertRearmS: n("alert_rearm_s"),
    quietMinutes: n("quiet_minutes"),
  };
}

export function historyFromRow(row: Row): HistoryReading {
  return {
    recordedAt: String(row.recorded_at),
    tempC: numberOrNull(row.temp_c),
    humPct: numberOrNull(row.hum_pct),
    soilRaw: numberOrNull(row.soil_raw),
    rainRaw: numberOrNull(row.rain_raw),
    distCm: numberOrNull(row.dist_cm),
    baselineCm: numberOrNull(row.baseline_cm),
    motion: boolOrNull(row.motion),
  };
}

export function commandFromRow(row: Row): SensorCommand {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    command: row.command as CommandName,
    status: row.status as CommandStatus,
    createdAt: String(row.created_at),
    createdByName: textOrNull(row.created_by_name),
    doneAt: textOrNull(row.done_at),
    result: textOrNull(row.result),
  };
}

export function deviceFromRow(row: Row): EdgeDevice {
  return {
    deviceId: String(row.device_id),
    name: String(row.name ?? ""),
    zone: textOrNull(row.zone),
    enabled: row.enabled !== false,
    lastHeardAt: textOrNull(row.last_heard_at),
    latitude: numberOrNull(row.latitude),
    longitude: numberOrNull(row.longitude),
  };
}

/**
 * How a node looks on a map, the Sensors page's and the park map's: ok is reporting with no alert,
 * warning has a routine alert, alert has an urgent one, and quiet has gone quiet or never sent.
 */
export type SensorMapState = "ok" | "warning" | "alert" | "quiet";

/** The classes in globals.css for each look, for the park map's LeafletMap and StaticMap. */
export const SENSOR_CLASS: Record<SensorMapState, string> = {
  ok: "map-sensor",
  warning: "map-sensor map-sensor-warn",
  alert: "map-sensor map-sensor-alert",
  quiet: "map-sensor map-sensor-offline",
};

export function mapStateOf(node: Pick<NodeStatus, "quiet" | "lastReadingAt" | "health">): SensorMapState {
  if (node.quiet || !node.lastReadingAt) return "quiet";
  if (node.health === "threat_triggered") return "alert";
  if (node.health === "warning") return "warning";
  return "ok";
}

/** Each node's newest position. The rows come newest first. */
export function positionsFromRows(rows: Row[]) {
  const positions = new Map<string, NodePosition>();
  for (const row of rows) {
    const nodeId = String(row.node_id);
    const latitude = numberOrNull(row.latitude);
    const longitude = numberOrNull(row.longitude);
    if (positions.has(nodeId) || latitude === null || longitude === null) continue;
    positions.set(nodeId, { nodeId, latitude, longitude, positionAt: textOrNull(row.position_at) });
  }
  return positions;
}

/**
 * Raw ADC value to percent with a node's dry and wet values: Arduino's map(raw, dry, wet, 0, 100)
 * kept within 0 to 100, with the same whole-number division as the ESP32, the edge and
 * iot_raw_pct in the database, so all four agree on a reading's state.
 */
export function rawToPct(raw: number | null, dry: number, wet: number) {
  if (raw === null || wet === dry) return null;
  return Math.max(0, Math.min(100, Math.trunc(((raw - dry) * 100) / (wet - dry))));
}

/** Going on first, then the ones nobody has picked up, then urgent, then the newest. */
export function alertOrder(a: SensorAlert, b: SensorAlert) {
  return (
    Number(a.clearedAt !== null) - Number(b.clearedAt !== null) ||
    Number(a.status === "acknowledged") - Number(b.status === "acknowledged") ||
    Number(b.severity === "urgent") - Number(a.severity === "urgent") ||
    b.recordedAt.localeCompare(a.recordedAt)
  );
}

/** What iot_check_alerts counts for the red number in the staff menu */
export function needsSomeone(alert: SensorAlert) {
  return alert.status === "open" && alert.clearedAt === null && !alert.fromBacklog;
}

// What officers read. Each one says what it means and what to do about it, because the people using
// this page aren't the people who built the sensors.
export const ALERT_WORDS: Record<AlertType, { title: string; means: string; todo: string }> = {
  SATURATED: {
    title: "Soil is saturated",
    means: "The soil here is soaked through. That’s a flash flood risk for the plants on this slope.",
    todo: "Look at the rain on this node and the ones near it. If it’s still raining hard, keep patrols away from the stream banks and check the plants once the water is down.",
  },
  DRY: {
    title: "Soil is very dry",
    means: "The soil here is drier than its limit. The plant may be short of water and the slope may erode, or the probe may have come loose.",
    todo: "Check the probe at the next visit. If the soil really is that dry, tell the botanist who looks after this plot.",
  },
  HEAVY: {
    title: "Heavy rain",
    means: "The rain pad on this node is wet past its heavy rain limit.",
    todo: "Watch the soil on this node and the others nearby for flooding. Hold off on patrols near streams until it eases.",
  },
  RAIN: {
    title: "Raining",
    means: "The rain pad on this node is wet.",
    todo: "Nothing straight away. It’s here so you can see when rain started.",
  },
  MOVED: {
    title: "Node moved or knocked",
    means: "The node’s distance to the ground has changed. It may have been knocked, moved, or fallen, or something is in front of the sensor.",
    todo: "Ask the patrol team to check the plant and the node as soon as they can. If it was put back on purpose, reset its baseline below, then resolve this.",
  },
  NO_ECHO: {
    title: "Distance sensor blocked",
    means: "The node’s distance sensor gets no echo. It may be covered, tilted towards the sky, wet, or the node has fallen.",
    todo: "Ask the patrol team to look at the node. If it’s only rain on the sensor, this ends by itself once it dries.",
  },
  MOTION: {
    title: "Movement near a plant",
    means: "The motion sensor saw something near this plant. It could be a person or an animal.",
    todo: "Check if anyone is meant to be there today. If it keeps coming back, ask the patrol team to take a look.",
  },
  TOO_HOT: {
    title: "Too hot, possible fire",
    means: "The air temperature here is past its limit. Under the canopy that’s unusual, and it could be a fire nearby, or the sensor sitting in direct sun.",
    todo: "Compare it with the nodes nearby. If they’re hot too, or the node then goes quiet, ask the patrol team to look for smoke or fire straight away.",
  },
  QUIET: {
    title: "Node has gone quiet",
    means: "Nothing has come in from this node. Its power or WiFi may be down, or it may have been damaged or taken.",
    todo: "See if the other nodes on the same edge device are quiet too. If they are, check the edge device and the router. If it’s only this one, send someone to look. This ends by itself when readings come back.",
  },
};

export const STATE_WORDS: Record<string, string> = {
  SATURATED: "Saturated",
  DRY: "Dry",
  NORMAL: "Normal",
  HEAVY: "Heavy rain",
  RAIN: "Raining",
  NONE: "No rain",
  OK: "In place",
  MOVED: "Moved",
  NO_ECHO: "No echo",
  TOO_HOT: "Too hot",
};

/** States that are worth a red word on the card */
export const BAD_STATES = new Set(["SATURATED", "HEAVY", "MOVED", "NO_ECHO", "TOO_HOT"]);

export const COMMAND_WORDS: Record<CommandName, string> = {
  beep_on: "Start the locate beep",
  beep_off: "Stop the locate beep",
  reset_baseline: "Reset the baseline",
};

export const COMMAND_STATUS_WORDS: Record<CommandStatus, string> = {
  pending: "Waiting for the edge device to collect it (up to a minute)",
  at_edge: "At the edge device, waiting for the node",
  sent: "Sent to the node, waiting for its answer",
  done: "Done",
  failed: "The node said no",
  expired: "Not delivered within an hour",
};

/** 12.5, not 12.50 */
export function shortNumber(value: number) {
  return String(Math.round(value * 10) / 10);
}

/** "less than a minute ago", "20 minutes ago", "3 hours ago", "2 days ago" */
export function ageInWords(iso: string, nowMs: number) {
  const minutes = Math.floor((nowMs - Date.parse(iso)) / 60000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

/** "5 minutes", "2 hours 10 minutes" */
export function durationInWords(fromIso: string, toMs: number) {
  const minutes = Math.max(0, Math.floor((toMs - Date.parse(fromIso)) / 60000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 48) return plural(Math.floor(hours / 24), "day");
  return rest ? `${plural(hours, "hour")} ${plural(rest, "minute")}` : plural(hours, "hour");
}

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const DEVICE_ID = /^[A-Za-z0-9-]{3,40}$/;
// The same as the node IDs the sketch, the edge and iot_nodes accept
const NODE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_NAME = 80;
const COMMANDS: CommandName[] = ["beep_on", "beep_off", "reset_baseline"];

function tidied(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function checkAlertId(input: unknown): Checked<number> {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) {
    return { ok: false, message: "That isn’t an alert the database knows." };
  }
  return { ok: true, value: input };
}

export function checkDeviceId(input: unknown): Checked<string> {
  const id = tidied(input);
  if (!DEVICE_ID.test(id)) {
    return {
      ok: false,
      message: "An ID is 3 to 40 letters, numbers or hyphens, like NNP-EDGE-01.",
    };
  }
  return { ok: true, value: id };
}

export function checkNodeId(input: unknown): Checked<string> {
  const id = tidied(input);
  if (!NODE_ID.test(id)) {
    return {
      ok: false,
      message: "A node ID is up to 32 letters, numbers, hyphens or underscores, like NNP-IOT-04. It has to match NODE_ID in the node’s secrets.h.",
    };
  }
  return { ok: true, value: id };
}

export type NewDevice = { deviceId: string; name: string; zone: string };

export function checkNewDevice(input: unknown): Checked<NewDevice> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = checkDeviceId(raw.deviceId);
  if (!id.ok) return id;
  const name = tidied(raw.name);
  const zone = tidied(raw.zone);
  if (!name) return { ok: false, message: "Enter a name, like Niah north edge device." };
  if (name.length > MAX_NAME || zone.length > MAX_NAME) {
    return { ok: false, message: `Names and zones can be up to ${MAX_NAME} characters.` };
  }
  return { ok: true, value: { deviceId: id.value, name, zone } };
}

export type DeviceSwitch = { deviceId: string; enabled: boolean };

export function checkDeviceSwitch(input: unknown): Checked<DeviceSwitch> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = checkDeviceId(raw.deviceId);
  if (!id.ok) return id;
  if (typeof raw.enabled !== "boolean") {
    return { ok: false, message: "Reload the page, then try again." };
  }
  return { ok: true, value: { deviceId: id.value, enabled: raw.enabled } };
}

export type DevicePosition = { deviceId: string; latitude: number | null; longitude: number | null };

/** Both empty clears the position. Decimal degrees, like a phone's map app gives. */
export function checkDevicePosition(input: unknown): Checked<DevicePosition> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = checkDeviceId(raw.deviceId);
  if (!id.ok) return { ok: false, message: "Reload the page, then try again." };
  const lat = tidied(raw.latitude);
  const lon = tidied(raw.longitude);
  if (!lat && !lon) return { ok: true, value: { deviceId: id.value, latitude: null, longitude: null } };
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!lat || !lon || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, message: "Enter both, as decimal degrees like 3.81488 and 113.77968, or leave both empty." };
  }
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return { ok: false, message: "Latitude goes from −90 to 90 and longitude from −180 to 180." };
  }
  return { ok: true, value: { deviceId: id.value, latitude, longitude } };
}

export type NewNode = { nodeId: string; name: string; zone: string; deviceId: string | null };

export function checkNewNode(input: unknown): Checked<NewNode> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = checkNodeId(raw.nodeId);
  if (!id.ok) return id;
  const name = tidied(raw.name);
  const zone = tidied(raw.zone);
  if (!name) return { ok: false, message: "Enter a name for the node." };
  if (!zone) return { ok: false, message: "Enter the zone it’s in." };
  if (name.length > MAX_NAME || zone.length > MAX_NAME) {
    return { ok: false, message: `Names and zones can be up to ${MAX_NAME} characters.` };
  }
  const device = checkNodeDevice(raw.deviceId);
  if (!device.ok) return device;
  return { ok: true, value: { nodeId: id.value, name, zone, deviceId: device.value } };
}

function checkNodeDevice(input: unknown): Checked<string | null> {
  if (input === null || input === "") return { ok: true, value: null };
  const id = checkDeviceId(input);
  return id.ok ? id : { ok: false, message: "Reload the page, then choose the device again." };
}

export type NodeLink = { nodeId: string; deviceId: string | null };

export function checkNodeLink(input: unknown): Checked<NodeLink> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = checkNodeId(raw.nodeId);
  if (!id.ok) return { ok: false, message: "Reload the page, then try again." };
  const device = checkNodeDevice(raw.deviceId);
  if (!device.ok) return device;
  return { ok: true, value: { nodeId: id.value, deviceId: device.value } };
}

export type NewCommand = { nodeId: string; command: CommandName };

export function checkCommand(input: unknown): Checked<NewCommand> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = checkNodeId(raw.nodeId);
  if (!id.ok || !COMMANDS.includes(raw.command as CommandName)) {
    return { ok: false, message: "Reload the page, then try again." };
  }
  return { ok: true, value: { nodeId: id.value, command: raw.command as CommandName } };
}
