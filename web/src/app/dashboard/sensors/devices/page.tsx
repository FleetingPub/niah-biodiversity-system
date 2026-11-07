import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth";
import { clockNow, formatDate, parkTime } from "@/lib/format";
import { ageInWords } from "@/lib/iot";
import { sqlIsMissing } from "@/lib/iot-db";
import { createClient } from "@/lib/supabase/server";
import { DevicePositions, type DevicePlace } from "./device-positions";
import { Devices, type DeviceItem, type NodeItem } from "./devices";

export const metadata: Metadata = { title: "Sensor devices" };

const BACK = (
  <Link href="/dashboard/sensors" className="btn btn-secondary">
    Back to sensors
  </Link>
);

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="flex max-w-2xl items-start gap-2.5 rounded-xl border-2 border-bad bg-sheet p-4 font-bold text-bad"
    >
      <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export default async function DevicesPage() {
  const me = await requireStaff();
  if (!me) return null;

  if (me.role !== "admin") {
    return (
      <div className="space-y-12">
        <PageHeader
          eyebrow="Monitoring"
          title="Sensor devices"
          description="Only administrators can manage sensor devices and their tokens."
          aside={BACK}
        />
      </div>
    );
  }

  const header = (
    <PageHeader
      eyebrow="Monitoring"
      title="Sensor devices"
      description="There’s one edge device for each forest region, and each sends for the nodes linked to it. A device’s token lets it add readings for those nodes and nothing else, and readings from a node that isn’t linked are turned down. iot/README.md says how to set one up."
      aside={BACK}
    />
  );

  const now = clockNow();
  const supabase = await createClient();
  const [devicesResult, nodesResult] = await Promise.all([
    supabase
      .from("iot_devices")
      .select("device_id, name, zone, enabled, token_made_at, token_made_by_name, last_heard_at, latitude, longitude")
      .order("device_id"),
    // Only these columns. iot_nodes also has each node's calibration, which isn't changed here.
    supabase.from("iot_nodes").select("node_id, name, zone, edge_device_id").order("node_id"),
  ]);

  if (sqlIsMissing(devicesResult.error) || sqlIsMissing(nodesResult.error)) {
    return (
      <div className="space-y-12">
        {header}
        <Problem>
          This database hasn’t been set up for sensors yet, or has an older version of the sensor
          tables, so there aren’t any devices to manage. Run the sensor files, 016_1 to 025, in
          supabase/README.md first.
        </Problem>
      </div>
    );
  }
  if (devicesResult.error || nodesResult.error) {
    console.error(
      "Loading the devices page failed:",
      devicesResult.error?.code ?? nodesResult.error?.code,
    );
    return (
      <div className="space-y-12">
        {header}
        <Problem>
          The devices didn’t load. Refresh the page, and if it keeps happening, check the database is
          up to date (supabase/README.md).
        </Problem>
      </div>
    );
  }

  const devices: DeviceItem[] = devicesResult.data.map((row) => ({
    id: row.device_id,
    name: row.name,
    zone: row.zone,
    enabled: row.enabled,
    hasToken: Boolean(row.token_made_at),
    tokenLine: row.token_made_at
      ? `Token made ${formatDate(parkTime(row.token_made_at))}${
          row.token_made_by_name ? ` by ${row.token_made_by_name}` : ""
        }`
      : "No token yet",
    heardLine: row.last_heard_at
      ? `Last heard from ${ageInWords(row.last_heard_at, now)}`
      : "Not heard from yet",
  }));
  const places: DevicePlace[] = devicesResult.data.map((row) => ({
    id: row.device_id,
    name: row.name,
    latitude: row.latitude === null ? "" : String(row.latitude),
    longitude: row.longitude === null ? "" : String(row.longitude),
  }));
  const nodes: NodeItem[] = nodesResult.data.map((row) => ({
    id: row.node_id,
    name: row.name,
    zone: row.zone,
    deviceId: row.edge_device_id,
  }));

  return (
    <div className="space-y-12">
      {header}
      <Devices devices={devices} nodes={nodes} />
      <DevicePositions devices={places} />
    </div>
  );
}
