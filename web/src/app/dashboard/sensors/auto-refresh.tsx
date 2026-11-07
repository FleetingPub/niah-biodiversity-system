"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { useVisibleTimer } from "@/lib/use-visible-timer";
import { refreshSensors } from "./actions";

// A node sends straight away when something starts, and its edge device sends that on at once
// (a quick alert), so a threat shows up here within about 20 seconds. The proposal's goal is 30.
// Routine readings reach the database once a minute.
const REFRESH_MS = 15000;

/**
 * Keeps the page up to date by asking the server to draw it again. The browser can't listen to
 * Supabase Realtime itself, because our Content Security Policy only lets it talk to this site
 * (connect-src 'self'), and opening that up would put the browser back in touch with the database
 * for the sake of a few seconds.
 */
export function AutoRefresh({ updatedAt }: { updatedAt: string }) {
  const [failed, setFailed] = useState(false);

  useVisibleTimer(async () => {
    try {
      await refreshSensors();
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, REFRESH_MS);

  // Not a live region. A screen reader saying the time every 15 seconds would make the page useless.
  return (
    <div className="text-sm text-moss">
      <p className="flex items-center gap-1.5">
        <Icon name="clock" className="size-4 shrink-0" />
        Updated at {updatedAt}. This page checks again every 15 seconds while it’s open.
      </p>
      {failed && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 font-bold text-bad">
          <Icon name="offline" className="mt-0.5 size-4 shrink-0" />
          The last check didn’t get through, so what you see may be out of date. It’ll keep trying.
          Check your connection if this stays.
        </p>
      )}
    </div>
  );
}
