"use client";

import { useId, useState, useTransition } from "react";
import { checkDevicePosition } from "@/lib/iot";
import { setDevicePosition, type DeviceResult } from "./actions";

export type DevicePlace = { id: string; name: string; latitude: string; longitude: string };

function PositionForm({ device }: { device: DevicePlace }) {
  const baseId = useId();
  const [latitude, setLatitude] = useState(device.latitude);
  const [longitude, setLongitude] = useState(device.longitude);
  const [result, setResult] = useState<DeviceResult | null>(null);
  const [pending, startTransition] = useTransition();

  function save(event: React.FormEvent) {
    event.preventDefault();
    const checked = checkDevicePosition({ deviceId: device.id, latitude, longitude });
    if (!checked.ok) {
      setResult(checked);
      return;
    }
    setResult(null);
    startTransition(async () => {
      const answer = await setDevicePosition({ deviceId: device.id, latitude, longitude }).catch(() => ({
        ok: false,
        message: "The server didn’t answer, so nothing changed. Check your connection and try again.",
      }));
      setResult(answer);
    });
  }

  const invalid = result !== null && !result.ok;
  return (
    <li className="p-4">
      <form onSubmit={save} aria-labelledby={`${baseId}-name`} className="flex flex-wrap items-end gap-3">
        <p id={`${baseId}-name`} className="w-full text-sm sm:w-auto sm:min-w-48">
          <span className="font-mono font-bold">{device.id}</span>{" "}
          <span className="text-moss">{device.name}</span>
        </p>
        <div>
          <label htmlFor={`${baseId}-lat`} className="block text-sm font-bold">
            Latitude
          </label>
          <input
            id={`${baseId}-lat`}
            className="field w-36"
            inputMode="decimal"
            placeholder="3.81488"
            value={latitude}
            aria-invalid={invalid || undefined}
            aria-describedby={`${baseId}-result`}
            onChange={(event) => setLatitude(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`${baseId}-lon`} className="block text-sm font-bold">
            Longitude
          </label>
          <input
            id={`${baseId}-lon`}
            className="field w-36"
            inputMode="decimal"
            placeholder="113.77968"
            value={longitude}
            aria-invalid={invalid || undefined}
            aria-describedby={`${baseId}-result`}
            onChange={(event) => setLongitude(event.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-secondary" disabled={pending}>
          {pending ? "Saving…" : "Save position"}
          <span className="sr-only"> of {device.id}</span>
        </button>
      </form>
      <p
        id={`${baseId}-result`}
        role="status"
        className={`mt-2 text-sm ${invalid ? "font-bold text-bad" : "text-moss"}`}
      >
        {result?.message}
      </p>
    </li>
  );
}

/**
 * Where each edge device is, for the map on the Sensors page. Decimal degrees, like a phone's map
 * app gives. Only admins see this page, and only staff see the map.
 */
export function DevicePositions({ devices }: { devices: DevicePlace[] }) {
  if (devices.length === 0) return null;
  return (
    <section aria-labelledby="positions-heading">
      <h2 id="positions-heading" className="text-xl font-bold tracking-tight">
        Where the edge devices are
      </h2>
      <p className="max-w-2xl text-moss">
        For the map on the Sensors page. Leave both empty if you don’t know yet. A node’s position
        comes from its own secrets.h each time it starts, so it isn’t set here.
      </p>
      <ul className="mt-4 divide-y divide-line rounded-xl border border-line bg-sheet">
        {devices.map((device) => (
          <PositionForm key={device.id} device={device} />
        ))}
      </ul>
    </section>
  );
}
