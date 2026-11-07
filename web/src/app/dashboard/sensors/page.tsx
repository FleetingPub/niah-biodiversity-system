import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth";
import { clockNow, formatDateTime, formatSeconds, formatTime, parkTime, plural } from "@/lib/format";
import {
  ALERT_COLUMNS,
  ALERT_WORDS,
  BAD_STATES,
  COMMAND_COLUMNS,
  COMMAND_STATUS_WORDS,
  COMMAND_WORDS,
  DEVICE_COLUMNS,
  HISTORY_COLUMNS,
  NODE_COLUMNS,
  POSITION_COLUMNS,
  SETTINGS_COLUMNS,
  STATE_WORDS,
  ageInWords,
  alertFromRow,
  alertOrder,
  commandFromRow,
  deviceFromRow,
  durationInWords,
  historyFromRow,
  mapStateOf,
  needsSomeone,
  nodeFromRow,
  positionsFromRows,
  rawToPct,
  settingsFromRow,
  shortNumber,
  type CommandName,
  type EdgeDevice,
  type HistoryReading,
  type NodePosition,
  type NodeSettings,
  type NodeStatus,
  type SensorAlert,
  type SensorCommand,
} from "@/lib/iot";
import { checkAlerts, sqlIsMissing } from "@/lib/iot-db";
import { createClient } from "@/lib/supabase/server";
import { AlertList, type AlertItem } from "./alert-list";
import { AutoRefresh } from "./auto-refresh";
import { NodeCommands, type CommandLine } from "./node-commands";
import { SensorMap, type MapEdge, type MapNode } from "./sensor-map";
import { Sparkline, type ChartPoint } from "./sparkline";

export const metadata: Metadata = { title: "Sensors" };

// A node sends once a minute and on events, so this is about the last three hours
const HISTORY_READINGS = 180;
const TABLE_READINGS = 10;
const RESOLVED_SHOWN = 10;
const COMMANDS_READ = 100;
const COMMANDS_SHOWN = 3;
// Only for joining up the chart line if a node's settings didn't load
const FALLBACK_QUIET_MINUTES = 15;

function databaseTime(iso: string) {
  return formatDateTime(parkTime(iso));
}

function alertItem(alert: SensorAlert, now: number): AlertItem {
  const words = ALERT_WORDS[alert.type];
  const details: string[] = [];
  if (alert.clearedRecordedAt) {
    details.push(
      `${alert.type === "QUIET" ? "Readings came back" : "Readings back to normal"} ${databaseTime(alert.clearedRecordedAt)}, after ${durationInWords(alert.recordedAt, Date.parse(alert.clearedRecordedAt))}.`,
    );
  } else {
    details.push(`Going on for ${durationInWords(alert.recordedAt, now)}.`);
  }
  if (alert.fromBacklog) {
    details.push(
      "This came in late, from the edge device’s backlog after its internet was down, so it may be long over. It doesn’t count in the staff menu.",
    );
  }
  return {
    id: alert.id,
    nodeId: alert.nodeId,
    nodeName: alert.nodeName,
    severity: alert.severity,
    status: alert.status,
    title: words.title,
    means: words.means,
    todo: words.todo,
    details,
    late: alert.fromBacklog,
    seen: `Started ${databaseTime(alert.recordedAt)} (${ageInWords(alert.recordedAt, now)}), through ${alert.deviceId}.`,
    handled:
      alert.status === "acknowledged" && alert.acknowledgedAt
        ? `Acknowledged by ${alert.acknowledgedByName ?? "someone"}, ${databaseTime(alert.acknowledgedAt)}`
        : null,
  };
}

type ChartParts = { points: ChartPoint[]; from: string; quietFrom: number | null };

/** Turns one measure's readings into places along the chart, from the first one shown up to now. */
function chartParts(
  history: HistoryReading[],
  value: (reading: HistoryReading) => number | null,
  unit: string,
  node: NodeStatus,
  quietMinutes: number,
  now: number,
): ChartParts | null {
  const readings = history.flatMap((reading) => {
    const number = value(reading);
    return number === null ? [] : [{ ms: Date.parse(reading.recordedAt), iso: reading.recordedAt, number }];
  });
  if (readings.length === 0) return null;

  const start = readings[0].ms;
  const span = Math.max(now - start, 1);
  const at = (ms: number) => Math.min(Math.max((ms - start) / span, 0), 1);
  return {
    points: readings.map((reading, index) => ({
      at: at(reading.ms),
      value: reading.number,
      text: `${formatTime(parkTime(reading.iso))}, ${shortNumber(reading.number)}${unit}`,
      afterGap: index > 0 && reading.ms - readings[index - 1].ms > quietMinutes * 60000,
    })),
    from: formatTime(parkTime(readings[0].iso)),
    quietFrom: node.quiet ? at(readings[readings.length - 1].ms) : null,
  };
}

/** What a screen reader gets instead of the line */
function chartLabel(title: string, nodeId: string, points: ChartPoint[], unit: string) {
  const values = points.map((point) => point.value);
  const number = (value: number) => `${shortNumber(value)}${unit}`;
  return `${title} on ${nodeId}, ${plural(points.length, "reading")}. Lowest ${number(Math.min(...values))}, highest ${number(Math.max(...values))}, latest ${number(values[values.length - 1])}.`;
}

function NodeChart({
  id,
  title,
  unit,
  node,
  parts,
  floor,
  ceiling,
  limits,
}: {
  id: string;
  title: string;
  unit: string;
  node: NodeStatus;
  parts: ChartParts | null;
  floor: number;
  ceiling: number;
  limits: number[];
}) {
  if (!parts) {
    return <p className="text-sm text-moss">{title}: no readings to draw yet.</p>;
  }
  return (
    <Sparkline
      id={id}
      title={title}
      label={chartLabel(title, node.nodeId, parts.points, unit)}
      points={parts.points}
      floor={floor}
      ceiling={ceiling}
      limits={limits}
      quietFrom={parts.quietFrom}
      from={parts.from}
    />
  );
}

function reading(value: number | null, unit: string) {
  return value === null ? "Not sent" : `${shortNumber(value)}${unit}`;
}

/** A value with its state underneath, red when it's one that raises an alert */
function Measure({ label, value, state, stale }: { label: string; value: string; state?: string | null; stale: boolean }) {
  const bad = state ? BAD_STATES.has(state) : false;
  return (
    <div>
      <dt className="text-moss">{label}</dt>
      <dd className={`text-lg font-bold ${stale ? "text-moss" : ""}`}>{value}</dd>
      {state && (
        <dd className={`text-xs font-bold ${bad && !stale ? "text-bad" : "text-moss"}`}>
          {STATE_WORDS[state] ?? state}
        </dd>
      )}
    </div>
  );
}

/** "Strong", "Fair", "Weak" from the node's WiFi signal */
function signalWords(rssi: number | null) {
  if (rssi === null) return "Not sent";
  const word = rssi >= -60 ? "Strong" : rssi >= -75 ? "Fair" : "Weak";
  return `${word} (${rssi} dBm)`;
}

function commandLine(command: SensorCommand): CommandLine {
  return {
    id: command.id,
    what: COMMAND_WORDS[command.command],
    who: `Sent by ${command.createdByName ?? "someone"}, ${databaseTime(command.createdAt)}`,
    status: COMMAND_STATUS_WORDS[command.status],
    finished: ["done", "failed", "expired"].includes(command.status),
    failed: command.status === "failed" || command.status === "expired",
  };
}

function SettingsList({ settings }: { settings: NodeSettings }) {
  const on = new Set(settings.alertTypes);
  const rows: { type: keyof typeof ALERT_WORDS; when: string }[] = [
    { type: "SATURATED", when: `Soil at ${settings.soilFloodPct}% or wetter; ends under ${settings.soilFloodClearPct}%` },
    { type: "DRY", when: `Soil at ${settings.soilDryPct}% or drier; ends over ${settings.soilDryClearPct}%` },
    { type: "HEAVY", when: `Rain at ${settings.rainHeavyPct}% or more; ends under ${settings.rainHeavyClearPct}%` },
    { type: "RAIN", when: `Rain at ${settings.rainLightPct}% or more; ends under ${settings.rainLightClearPct}%` },
    {
      type: "MOVED",
      when: `More than ${shortNumber(settings.moveCm)} cm from its baseline; ends within ${shortNumber(settings.moveClearCm)} cm`,
    },
    { type: "NO_ECHO", when: "The distance sensor gets no echo; ends when it does" },
    {
      type: "MOTION",
      when: `The motion sensor sees something; ends after ${plural(settings.motionClearReadings, "reading")} without`,
    },
    {
      type: "TOO_HOT",
      when: `${shortNumber(settings.tooHotC)} °C or hotter; ends under ${shortNumber(settings.tooHotClearC)} °C`,
    },
    { type: "QUIET", when: `Nothing for ${plural(settings.quietMinutes, "minute")}; ends when it sends again` },
  ];
  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer font-bold">What raises an alert on this node</summary>
      <ul className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <li key={row.type} className={on.has(row.type) ? "" : "text-moss"}>
            <span className="font-bold">{ALERT_WORDS[row.type].title}</span>
            {on.has(row.type) ? "" : " (turned off)"}: {row.when}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-moss">
        An alert opens after {plural(settings.alertConfirmReadings, "reading")} in a row show it, and the same
        alert stays silent for {plural(Math.round(settings.alertRearmS / 60), "minute")} after it ends. An
        administrator can change these for this node in the iot_nodes table.
      </p>
    </details>
  );
}

function NodeCard({
  node,
  settings,
  history,
  commands,
  device,
  now,
}: {
  node: NodeStatus;
  settings: NodeSettings | null;
  /** Oldest first, or null if it didn't load */
  history: HistoryReading[] | null;
  /** Newest first */
  commands: SensorCommand[];
  device: EdgeDevice | null;
  now: number;
}) {
  const headingId = `node-${node.nodeId}`;
  const stale = node.quiet;
  const quietMinutes = settings?.quietMinutes ?? FALLBACK_QUIET_MINUTES;

  // The view works out the newest reading; older ones are worked out here the same way
  const soilOf = (r: HistoryReading) => (settings ? rawToPct(r.soilRaw, settings.soilDryRaw, settings.soilWetRaw) : null);
  const rainOf = (r: HistoryReading) => (settings ? rawToPct(r.rainRaw, settings.rainDryRaw, settings.rainWetRaw) : null);
  const soil = history ? chartParts(history, soilOf, "%", node, quietMinutes, now) : null;
  const rain = history ? chartParts(history, rainOf, "%", node, quietMinutes, now) : null;
  const temperature = history ? chartParts(history, (r) => r.tempC, " °C", node, quietMinutes, now) : null;
  const temperatures = temperature?.points.map((point) => point.value) ?? [];
  const lowestShown = Math.min(20, ...temperatures);
  const highestShown = Math.max(settings?.tooHotC ?? 45, ...temperatures);
  const recent = (history ?? []).slice(-TABLE_READINGS).reverse();
  const waiting = commands
    .filter((command) => ["pending", "at_edge", "sent"].includes(command.status))
    .map((command) => command.command as CommandName);

  const badge = !node.lastReadingAt ? (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 py-0.5 text-xs font-bold text-moss">
      <Icon name="info" className="size-3.5" />
      Waiting
    </span>
  ) : stale ? (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-bad-soft px-2.5 py-0.5 text-xs font-bold text-bad">
      <Icon name="offline" className="size-3.5" />
      Quiet
    </span>
  ) : node.health === "threat_triggered" ? (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-bad px-2.5 py-0.5 text-xs font-bold text-white">
      <Icon name="alert" className="size-3.5" />
      Urgent alert
    </span>
  ) : node.health === "warning" ? (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-bold text-warn">
      <Icon name="alert" className="size-3.5" />
      Alert
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-bold text-ok">
      <span className="size-2 rounded-full bg-ok" aria-hidden="true" />
      Reporting
    </span>
  );

  return (
    <article
      aria-labelledby={headingId}
      className={`card p-4 sm:p-5 ${stale ? "border-l-4 border-l-bad" : node.health === "threat_triggered" ? "border-l-4 border-l-bad" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} tabIndex={-1} className="scroll-mt-24 font-mono text-lg font-bold">
            {node.nodeId}
          </h3>
          <p className="text-sm text-moss">
            {node.name}
            {node.zone && `, ${node.zone}`}
          </p>
          <p className="text-sm text-moss">
            {node.edgeDeviceId
              ? `Sends through ${node.edgeDeviceId}${device ? `, ${device.name}` : ""}`
              : "Not linked to an edge device, so its readings are turned down"}
          </p>
        </div>
        {badge}
      </div>

      {!node.lastReadingAt ? (
        <p className="mt-3 text-sm text-moss">
          Nothing has come in from this node yet. This fills in when its first reading arrives.
        </p>
      ) : (
        <>
          <p className={`mt-3 flex items-start gap-1.5 text-sm ${stale ? "font-bold text-bad" : "text-moss"}`}>
            <Icon name="clock" className="mt-0.5 size-4 shrink-0" />
            <span>
              {stale
                ? `Last reading ${ageInWords(node.lastReadingAt, now)} (${databaseTime(node.lastReadingAt)}). These are its last values, not what’s happening now.`
                : `Last reading ${ageInWords(node.lastReadingAt, now)} (${databaseTime(node.lastReadingAt)})`}
            </span>
          </p>
          {node.openAlerts > 0 && (
            <p className="mt-1 flex items-start gap-1.5 text-sm font-bold text-bad">
              <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
              {plural(node.openAlerts, "alert")} going on
              {node.urgentAlerts > 0 ? `, ${node.urgentAlerts} urgent` : ""}. See Alerts above.
            </p>
          )}

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Measure label="Temperature" value={reading(node.tempC, " °C")} state={node.tempState} stale={stale} />
            <Measure label="Humidity" value={reading(node.humPct, "%")} stale={stale} />
            <Measure label="Soil moisture" value={reading(node.soilPct, "%")} state={node.soilState} stale={stale} />
            <Measure label="Rain" value={reading(node.rainPct, "%")} state={node.rainState} stale={stale} />
            <Measure
              label="Distance to the ground"
              value={
                node.distCm === null
                  ? "No echo"
                  : `${shortNumber(node.distCm)} cm${node.baselineCm === null ? "" : ` (normal ${shortNumber(node.baselineCm)})`}`
              }
              state={node.distCm === null ? null : node.distState}
              stale={stale}
            />
            <Measure
              label="Movement"
              value={node.motion === null ? "Not sent" : node.motion ? "Seen" : "None"}
              stale={stale}
            />
            <Measure label="WiFi signal" value={signalWords(node.rssi)} stale={stale} />
            <Measure
              label="Locate beep"
              value={node.beepOn === null ? "Not sent" : node.beepOn ? "On" : "Off"}
              stale={stale}
            />
          </dl>

          <div className="mt-4 space-y-4 border-t border-line pt-4">
            {history === null ? (
              <p className="flex items-start gap-1.5 text-sm font-bold text-bad">
                <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
                The history for this node didn’t load, so there’s no chart right now.
              </p>
            ) : (
              <>
                {!settings && (
                  <p className="text-sm text-moss">
                    This node’s calibration didn’t load, so the soil and rain charts can’t be drawn.
                  </p>
                )}
                <NodeChart
                  id={`${node.nodeId}-soil`}
                  title="Soil moisture"
                  unit="%"
                  node={node}
                  parts={soil}
                  floor={0}
                  ceiling={100}
                  limits={settings ? [settings.soilDryPct, settings.soilFloodPct] : []}
                />
                <NodeChart
                  id={`${node.nodeId}-rain`}
                  title="Rain"
                  unit="%"
                  node={node}
                  parts={rain}
                  floor={0}
                  ceiling={100}
                  limits={settings ? [settings.rainHeavyPct] : []}
                />
                <NodeChart
                  id={`${node.nodeId}-temperature`}
                  title="Temperature"
                  unit=" °C"
                  node={node}
                  parts={temperature}
                  floor={lowestShown - 2}
                  ceiling={highestShown + 2}
                  limits={settings ? [settings.tooHotC] : []}
                />
              </>
            )}
          </div>

          {recent.length > 0 && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-bold">Last {plural(recent.length, "reading")}</summary>
              <div className="relative mt-2 overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left">
                  <thead className="border-b border-line bg-paper/60 text-moss">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-bold">When</th>
                      <th scope="col" className="px-3 py-2 font-bold">Temp.</th>
                      <th scope="col" className="px-3 py-2 font-bold">Soil</th>
                      <th scope="col" className="px-3 py-2 font-bold">Rain</th>
                      <th scope="col" className="px-3 py-2 font-bold">Distance</th>
                      <th scope="col" className="px-3 py-2 font-bold">Movement</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {recent.map((row) => (
                      <tr key={row.recordedAt}>
                        <td className="whitespace-nowrap px-3 py-2">{databaseTime(row.recordedAt)}</td>
                        <td className="whitespace-nowrap px-3 py-2">{reading(row.tempC, " °C")}</td>
                        <td className="whitespace-nowrap px-3 py-2">{reading(soilOf(row), "%")}</td>
                        <td className="whitespace-nowrap px-3 py-2">{reading(rainOf(row), "%")}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {row.distCm === null ? "No echo" : `${shortNumber(row.distCm)} cm`}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {row.motion === null ? "Not sent" : row.motion ? "Seen" : "None"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}

      {settings && <SettingsList settings={settings} />}

      <NodeCommands
        nodeId={node.nodeId}
        beepOn={node.beepOn}
        waiting={waiting}
        recent={commands.slice(0, COMMANDS_SHOWN).map(commandLine)}
      />
    </article>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-4 flex max-w-2xl items-start gap-2.5 rounded-xl border-2 border-bad bg-sheet p-4 font-bold text-bad"
    >
      <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Quiet ones and urgent ones first because those need someone, then alerts, then waiting, then by ID. */
function nodeRank(node: NodeStatus) {
  if (node.quiet || node.health === "threat_triggered") return 0;
  if (node.health === "warning") return 1;
  return node.lastReadingAt ? 3 : 2;
}

function mapLine(node: NodeStatus, now: number) {
  if (!node.lastReadingAt) return "Nothing sent yet";
  if (node.quiet) return `Quiet, last reading ${ageInWords(node.lastReadingAt, now)}`;
  if (node.openAlerts > 0) {
    return `${plural(node.openAlerts, "alert")} going on${node.urgentAlerts ? `, ${node.urgentAlerts} urgent` : ""}`;
  }
  return `Reporting, last reading ${ageInWords(node.lastReadingAt, now)}`;
}

export default async function SensorsPage() {
  const me = await requireStaff();
  if (!me) return null;

  // Before the reads, so a node that has just gone quiet shows up on this draw and not the next
  await checkAlerts();

  const now = clockNow();
  const supabase = await createClient();
  const [nodesResult, settingsResult, alertsResult, resolvedResult, devicesResult, positionsResult, commandsResult] =
    await Promise.all([
      supabase.from("iot_node_status").select(NODE_COLUMNS),
      supabase.from("iot_nodes").select(SETTINGS_COLUMNS),
      supabase.from("iot_alerts").select(ALERT_COLUMNS).neq("status", "resolved"),
      supabase
        .from("iot_alerts")
        .select(ALERT_COLUMNS)
        .eq("status", "resolved")
        .order("resolved_at", { ascending: false })
        .limit(RESOLVED_SHOWN),
      supabase.from("iot_devices").select(DEVICE_COLUMNS).order("device_id"),
      // Newest first, so the first row for each node is where it is now
      supabase
        .from("iot_boots")
        .select(POSITION_COLUMNS)
        .not("latitude", "is", null)
        .order("position_at", { ascending: false, nullsFirst: false })
        .limit(500),
      supabase
        .from("iot_commands")
        .select(COMMAND_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(COMMANDS_READ),
    ]);

  const results = [nodesResult, settingsResult, alertsResult, resolvedResult, devicesResult, positionsResult, commandsResult];
  const missing = results.some((result) => sqlIsMissing(result.error));
  if (!missing) {
    for (const { error } of results) {
      if (error) console.error("Loading the sensors page failed:", error.code);
    }
  }

  const header = (aside?: React.ReactNode, status?: React.ReactNode) => (
    <PageHeader
      eyebrow="Monitoring"
      title="Sensors"
      description={
        <>
          <p>
            Readings from the sensor nodes beside tagged plants, the alerts they’ve raised, and where
            each node and edge device is. The database decides the alerts as readings arrive, so they
            come up with this page closed too.
          </p>
          {status && <div className="mt-3">{status}</div>}
        </>
      }
      aside={aside}
    />
  );

  if (missing) {
    return (
      <div className="space-y-12">
        {header()}
        <Problem>
          This database hasn’t been set up for sensors yet, or has an older version of the sensor
          tables, so there’s nothing to show here. The other pages aren’t affected. Ask an
          administrator to run the sensor files, 016_1 to 025, in supabase/README.md.
        </Problem>
      </div>
    );
  }

  const nodes = nodesResult.error
    ? null
    : (nodesResult.data ?? [])
        .map(nodeFromRow)
        .sort((a, b) => nodeRank(a) - nodeRank(b) || a.nodeId.localeCompare(b.nodeId));
  const settingsFor = new Map(
    settingsResult.error ? [] : (settingsResult.data ?? []).map(settingsFromRow).map((s) => [s.nodeId, s] as const),
  );
  const alerts = alertsResult.error ? null : (alertsResult.data ?? []).map(alertFromRow).sort(alertOrder);
  const goingOn = alerts?.filter((alert) => alert.clearedAt === null) ?? null;
  const ended = alerts?.filter((alert) => alert.clearedAt !== null) ?? null;
  const resolved = resolvedResult.error ? null : (resolvedResult.data ?? []).map(alertFromRow);
  const devices = devicesResult.error ? null : (devicesResult.data ?? []).map(deviceFromRow);
  const deviceFor = new Map((devices ?? []).map((device) => [device.deviceId, device]));
  const positions: Map<string, NodePosition> = positionsResult.error
    ? new Map()
    : positionsFromRows(positionsResult.data ?? []);
  const commandsFor = new Map<string, SensorCommand[]>();
  for (const command of commandsResult.error ? [] : (commandsResult.data ?? []).map(commandFromRow)) {
    commandsFor.set(command.nodeId, [...(commandsFor.get(command.nodeId) ?? []), command]);
  }

  // One query for each node. That's fine for a few nodes, and it stops one busy node using up a
  // shared limit and leaving the others with short charts.
  const histories = await Promise.all(
    (nodes ?? []).map(async (node): Promise<[string, HistoryReading[] | null]> => {
      if (!node.lastReadingAt) return [node.nodeId, []];
      const { data, error } = await supabase
        .from("iot_readings")
        .select(HISTORY_COLUMNS)
        .eq("node_id", node.nodeId)
        .order("recorded_at", { ascending: false })
        .limit(HISTORY_READINGS);
      if (error) {
        console.error("Loading a node’s history failed:", error.code);
        return [node.nodeId, null];
      }
      return [node.nodeId, (data ?? []).map(historyFromRow).reverse()];
    }),
  );
  const historyFor = new Map(histories);

  // The map: edge devices with a position, and nodes with one from their last power-up
  const mapEdges: MapEdge[] = (devices ?? []).flatMap((device) =>
    device.latitude === null || device.longitude === null
      ? []
      : [
          {
            id: device.deviceId,
            name: device.name,
            latitude: device.latitude,
            longitude: device.longitude,
            off: !device.enabled,
            line: `${device.enabled ? "" : "Turned off. "}${
              device.lastHeardAt ? `Last heard from ${ageInWords(device.lastHeardAt, now)}` : "Not heard from yet"
            }`,
          },
        ],
  );
  const mapNodes: MapNode[] = (nodes ?? []).flatMap((node) => {
    const where = positions.get(node.nodeId);
    if (!where) return [];
    const edge = node.edgeDeviceId ? deviceFor.get(node.edgeDeviceId) : undefined;
    return [
      {
        id: node.nodeId,
        name: node.name,
        latitude: where.latitude,
        longitude: where.longitude,
        edge:
          edge && edge.latitude !== null && edge.longitude !== null
            ? { latitude: edge.latitude, longitude: edge.longitude }
            : null,
        state: mapStateOf(node),
        line: mapLine(node, now),
      },
    ];
  });
  const unplacedNodes = (nodes ?? []).filter((node) => !positions.has(node.nodeId)).map((node) => node.nodeId);
  const unplacedEdges = (devices ?? [])
    .filter((device) => device.latitude === null || device.longitude === null)
    .map((device) => device.deviceId);

  const reporting = nodes?.filter((node) => node.lastReadingAt && !node.quiet).length ?? null;
  const quiet = nodes?.filter((node) => node.quiet).length ?? null;
  const tiles: { label: string; value: string | null }[] = [
    { label: "Nodes reporting", value: nodes ? `${reporting} of ${nodes.length}` : null },
    { label: "Nodes gone quiet", value: quiet === null ? null : String(quiet) },
    {
      label: "Urgent, not acknowledged",
      value: goingOn ? String(goingOn.filter((alert) => needsSomeone(alert) && alert.severity === "urgent").length) : null,
    },
    { label: "Alerts going on", value: goingOn ? String(goingOn.length) : null },
  ];

  return (
    <div className="space-y-12">
      {header(
        me.role === "admin" ? (
          <Link href="/dashboard/sensors/devices" className="btn btn-secondary">
            <Icon name="sensor" className="size-4" />
            Devices
          </Link>
        ) : undefined,
        <AutoRefresh updatedAt={formatSeconds(now)} />,
      )}

      <section aria-labelledby="sensor-counts-heading">
        <h2 id="sensor-counts-heading" className="sr-only">
          Counts
        </h2>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4">
          {tiles.map((tile) => (
            <div key={tile.label} className="flex flex-col bg-sheet p-4 sm:p-5">
              <dt className="text-sm text-moss">{tile.label}</dt>
              <dd className="order-first text-2xl font-bold tracking-tight">
                {tile.value ?? <span className="text-base text-moss">Didn’t load</span>}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="alerts-heading">
        <h2 id="alerts-heading" className="text-xl font-bold tracking-tight">
          Alerts
        </h2>
        <p className="max-w-2xl text-moss">
          Acknowledge one to say you’ve seen it and someone is on it, and resolve it once it’s dealt
          with. An alert also ends by itself when the readings go back to normal, and then it moves to
          the list below this one. The red number in the menu only counts urgent alerts that are still
          going on and that nobody has acknowledged.
        </p>
        {goingOn && ended ? (
          <>
            <AlertList
              alerts={goingOn.map((alert) => alertItem(alert, now))}
              clearId="alerts-clear"
              clearTitle="Nothing going on"
              clearText="New alerts show up here and in the staff menu."
            />
            {ended.length > 0 && (
              <details className="mt-6">
                <summary className="cursor-pointer font-bold">
                  Ended by themselves, not resolved yet ({ended.length})
                </summary>
                <p className="mt-2 max-w-2xl text-sm text-moss">
                  The readings for these went back to normal. Resolve each one once you’re happy
                  nothing needs doing, so the list stays short.
                </p>
                <AlertList
                  alerts={ended.map((alert) => alertItem(alert, now))}
                  clearId="ended-clear"
                  clearTitle="All resolved"
                  clearText="Alerts that end by themselves wait here until someone resolves them."
                />
              </details>
            )}
          </>
        ) : (
          <Problem>
            The alerts didn’t load. There could be alerts going on that you can’t see. This page tries
            again by itself. If it keeps happening, ask an administrator to check the database.
          </Problem>
        )}
      </section>

      <section aria-labelledby="map-heading">
        <h2 id="map-heading" className="text-xl font-bold tracking-tight">
          Map
        </h2>
        <p className="max-w-2xl text-moss">
          Each edge device with the nodes that send through it. A node’s spot comes from its last power-up.
          Point at one for its details, or select a node to jump to its card. Nodes sit beside protected
          plants, so this map is for staff only.
        </p>
        <div className="mt-4">
          <SensorMap edges={mapEdges} nodes={mapNodes} />
        </div>
        {positionsResult.error || devicesResult.error ? (
          <p className="mt-2 text-sm font-bold text-bad">
            Some positions didn’t load, so the map may be missing nodes or edge devices.
          </p>
        ) : (
          (unplacedNodes.length > 0 || unplacedEdges.length > 0) && (
            <p className="mt-2 max-w-2xl text-sm text-moss">
              Not on the map because they have no position yet:{" "}
              {[...unplacedEdges.map((id) => `${id} (edge device)`), ...unplacedNodes].join(", ")}. A node’s position
              is set in its secrets.h, and an edge device’s on the Devices page.
            </p>
          )
        )}
      </section>

      <section aria-labelledby="nodes-heading">
        <h2 id="nodes-heading" className="text-xl font-bold tracking-tight">
          Sensor nodes
        </h2>
        <p className="max-w-2xl text-moss">
          Nodes that need someone come first. On the charts, the dashed lines are this node’s alert limits.
          Hover over or tap a chart to read a value, and each node has a table of its latest readings.
        </p>
        {!nodes ? (
          <Problem>
            The sensor nodes didn’t load, so their readings aren’t shown. This page tries again by itself.
            If it keeps happening, ask an administrator to check the database.
          </Problem>
        ) : nodes.length === 0 ? (
          <p className="card mt-4 p-5 text-moss">
            There aren’t any sensor nodes in the database yet. An administrator can add them on the Devices
            page.
          </p>
        ) : (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {nodes.map((node) => (
              <li key={node.nodeId}>
                <NodeCard
                  node={node}
                  settings={settingsFor.get(node.nodeId) ?? null}
                  history={historyFor.get(node.nodeId) ?? null}
                  commands={commandsFor.get(node.nodeId) ?? []}
                  device={node.edgeDeviceId ? (deviceFor.get(node.edgeDeviceId) ?? null) : null}
                  now={now}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {devices && devices.length > 0 && (
        <section aria-labelledby="edges-heading">
          <h2 id="edges-heading" className="text-xl font-bold tracking-tight">
            Edge devices
          </h2>
          <ul className="mt-4 divide-y divide-line rounded-xl border border-line bg-sheet text-sm">
            {devices.map((device) => {
              const linked = (nodes ?? []).filter((node) => node.edgeDeviceId === device.deviceId);
              return (
                <li key={device.deviceId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-4">
                  <p>
                    <span className="font-mono font-bold">{device.deviceId}</span>{" "}
                    <span className="text-moss">
                      {device.name}
                      {device.zone && `, ${device.zone}`}
                    </span>
                  </p>
                  <p className={device.enabled ? "text-moss" : "font-bold text-bad"}>
                    {device.enabled ? "" : "Turned off. "}
                    {device.lastHeardAt ? `Last heard from ${ageInWords(device.lastHeardAt, now)}` : "Not heard from yet"}
                    {`, ${plural(linked.length, "node")}`}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {resolved && resolved.length > 0 && (
        <section aria-labelledby="resolved-heading">
          <h2 id="resolved-heading" className="text-xl font-bold tracking-tight">
            Recently resolved
          </h2>
          <details className="mt-2">
            <summary className="cursor-pointer font-bold">Show the last {plural(resolved.length, "alert")}</summary>
            <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-sheet text-sm">
              {resolved.map((alert) => (
                <li key={alert.id} className="p-4">
                  <p>
                    <span className="font-mono font-bold">{alert.nodeId}</span>{" "}
                    <span className="font-bold">{ALERT_WORDS[alert.type].title}</span>
                  </p>
                  <p className="text-moss">
                    Started {databaseTime(alert.recordedAt)}.{" "}
                    {alert.clearedRecordedAt ? `Back to normal ${databaseTime(alert.clearedRecordedAt)}. ` : ""}
                    Resolved by {alert.resolvedByName ?? "someone"}
                    {alert.resolvedAt && `, ${databaseTime(alert.resolvedAt)}`}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </div>
  );
}
