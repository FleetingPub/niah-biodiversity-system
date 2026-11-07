import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * True when the error means newer SQL (016_1 to 025 here, 021 for the users page)
 * isn't in this database yet, rather than something going wrong today. The pages
 * say something different for each.
 */
export function sqlIsMissing(error: { code?: string } | null) {
  return ["PGRST202", "PGRST205", "42P01", "42883", "42703"].includes(error?.code ?? "");
}

/**
 * Has the database look for nodes that have gone quiet, and counts the alerts that need someone:
 * still going on, not acknowledged, and not from an edge device's backlog (017). No reading
 * arrives to set a quiet alert off, so something has to ask. The layout and the sensors page both
 * want this, and cache makes that one call for each page load. Gives null if it can't answer, and
 * then the staff menu leaves the badge off and everything else keeps working.
 */
export const checkAlerts = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("iot_check_alerts");
  if (error) {
    // Until the SQL is there this would fill the logs on every page, and the sensors page says so
    if (!sqlIsMissing(error)) console.error("Checking the sensor alerts failed:", error.code);
    return null;
  }
  const counts = data as { urgent?: unknown; open?: unknown } | null;
  return { urgent: Number(counts?.urgent ?? 0), open: Number(counts?.open ?? 0) };
});
