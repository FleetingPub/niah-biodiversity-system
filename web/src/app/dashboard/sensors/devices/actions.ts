"use server";

import { revalidatePath } from "next/cache";
import { getSession, SERVICE_DOWN } from "@/lib/auth";
import {
  checkDeviceId,
  checkDevicePosition,
  checkDeviceSwitch,
  checkNewDevice,
  checkNewNode,
  checkNodeLink,
} from "@/lib/iot";
import { sqlIsMissing } from "@/lib/iot-db";
import { authConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export type DeviceResult = { ok: boolean; message: string };
export type TokenResult = DeviceResult & { token?: string };

const TRY_AGAIN = "Nothing was changed. Try again, and if it keeps happening, check the server’s logs.";

/**
 * Anyone can send a request straight to a server action, so this checks who is signed in itself.
 * Row Level Security and the database functions check the role again (supabase/016_1 to 016_3).
 */
async function adminProblem() {
  if (!authConfigured) return "Sensors aren’t set up on this server yet.";
  const session = await getSession();
  if (session.status === "signed-out") {
    return "You’re signed out. Sign in again, then try that again.";
  }
  if (session.status === "unavailable") return SERVICE_DOWN;
  if (session.status !== "ok" || session.role !== "admin") {
    return "Only administrators can manage sensor devices.";
  }
  return null;
}

function failed(error: { code?: string }, what: string, exists?: string): DeviceResult {
  if (error.code === "42501") {
    return {
      ok: false,
      message: "The database didn’t let your account do this. Reload the page to check you’re still an administrator.",
    };
  }
  if (sqlIsMissing(error)) {
    return {
      ok: false,
      message: "This database hasn’t been set up for sensors yet, or has an older version. Run 016_1 to 025 first.",
    };
  }
  if (error.code === "23505" && exists) return { ok: false, message: exists };
  // Only the code. A failed token call must never put anything else about it in the logs.
  console.error(`${what} failed:`, error.code);
  return { ok: false, message: TRY_AGAIN };
}

function changed() {
  revalidatePath("/dashboard/sensors/devices");
  revalidatePath("/dashboard/sensors");
}

export async function addDevice(input: unknown): Promise<DeviceResult> {
  const problem = await adminProblem();
  if (problem) return { ok: false, message: problem };
  const checked = checkNewDevice(input);
  if (!checked.ok) return checked;

  const { deviceId, name, zone } = checked.value;
  const supabase = await createClient();
  const { error } = await supabase
    .from("iot_devices")
    .insert({ device_id: deviceId, name, zone: zone || null });
  if (error) return failed(error, "Adding a device", `There’s already a device called ${deviceId}.`);
  changed();
  return { ok: true, message: `${deviceId} added. It can’t send anything until you make it a token.` };
}

export async function setDeviceEnabled(input: unknown): Promise<DeviceResult> {
  const problem = await adminProblem();
  if (problem) return { ok: false, message: problem };
  const checked = checkDeviceSwitch(input);
  if (!checked.ok) return checked;

  const { deviceId, enabled } = checked.value;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("iot_devices")
    .update({ enabled })
    .eq("device_id", deviceId)
    .select("device_id");
  if (error) return failed(error, "Turning a device on or off");
  changed();
  if (data.length === 0) {
    return { ok: false, message: "This device isn’t in the database any more. Reload the page." };
  }
  return {
    ok: true,
    message: enabled
      ? `${deviceId} is on. It can add readings again.`
      : `${deviceId} is off. Its readings are turned down until you turn it back on.`,
  };
}

/** The only time the token exists outside the device. The database keeps a hash, and nothing logs it. */
export async function makeDeviceToken(input: unknown): Promise<TokenResult> {
  const problem = await adminProblem();
  if (problem) return { ok: false, message: problem };
  const checked = checkDeviceId(input);
  if (!checked.ok) return checked;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("iot_make_device_token", { device: checked.value });
  if (error) {
    if (error.code === "P0001") {
      return { ok: false, message: "This device isn’t in the database any more. Reload the page." };
    }
    return failed(error, "Making a device token");
  }
  changed();
  const token = (data as { token?: unknown } | null)?.token;
  if (typeof token !== "string") {
    console.error("Making a device token gave no token back");
    return { ok: false, message: TRY_AGAIN };
  }
  return { ok: true, message: `New token made for ${checked.value}.`, token };
}

export async function addNode(input: unknown): Promise<DeviceResult> {
  const problem = await adminProblem();
  if (problem) return { ok: false, message: problem };
  const checked = checkNewNode(input);
  if (!checked.ok) return checked;

  const { nodeId, name, zone, deviceId } = checked.value;
  const supabase = await createClient();
  const { error } = await supabase
    .from("iot_nodes")
    .insert({ node_id: nodeId, name, zone, edge_device_id: deviceId });
  if (error) {
    if (error.code === "23503") {
      return { ok: false, message: "That device isn’t in the database any more. Reload the page." };
    }
    return failed(error, "Adding a node", `There’s already a node called ${nodeId}.`);
  }
  changed();
  return { ok: true, message: `${nodeId} added.` };
}

export async function linkNode(input: unknown): Promise<DeviceResult> {
  const problem = await adminProblem();
  if (problem) return { ok: false, message: problem };
  const checked = checkNodeLink(input);
  if (!checked.ok) return checked;

  const { nodeId, deviceId } = checked.value;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("iot_nodes")
    .update({ edge_device_id: deviceId })
    .eq("node_id", nodeId)
    .select("node_id");
  if (error) {
    if (error.code === "23503") {
      return { ok: false, message: "That device isn’t in the database any more. Reload the page." };
    }
    return failed(error, "Linking a node");
  }
  changed();
  if (data.length === 0) {
    return { ok: false, message: "This node isn’t in the database any more. Reload the page." };
  }
  return { ok: true, message: deviceId ? `${nodeId} now sends through ${deviceId}.` : `${nodeId} isn’t linked to a device now.` };
}

export async function setDevicePosition(input: unknown): Promise<DeviceResult> {
  const problem = await adminProblem();
  if (problem) return { ok: false, message: problem };
  const checked = checkDevicePosition(input);
  if (!checked.ok) return checked;

  const { deviceId, latitude, longitude } = checked.value;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("iot_devices")
    .update({ latitude, longitude })
    .eq("device_id", deviceId)
    .select("device_id");
  if (error) return failed(error, "Saving a device position");
  changed();
  if (data.length === 0) {
    return { ok: false, message: "This device isn’t in the database any more. Reload the page." };
  }
  return {
    ok: true,
    message: latitude === null ? `${deviceId} has no position now.` : `${deviceId} is on the map now.`,
  };
}
