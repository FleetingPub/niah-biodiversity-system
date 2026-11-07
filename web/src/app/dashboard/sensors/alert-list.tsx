"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Icon } from "@/components/icon";
import { ALERT_LEVEL } from "@/lib/alert-level";
import type { AlertSeverity, AlertStatus } from "@/lib/iot";
import { acknowledgeAlert, resolveAlert, type SensorResult } from "./actions";

export type AlertItem = {
  id: number;
  nodeId: string;
  nodeName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  means: string;
  todo: string;
  /** Extra lines, like "Readings back to normal at 2:40 am" or a note that it came in late */
  details: string[];
  /** "Started 2 Oct, 2:14 am (40 minutes ago)" */
  seen: string;
  /** It came from an edge device's backlog after an outage, so it may be long over */
  late: boolean;
  /** "Acknowledged by Aina Officer, 2 Oct, 2:20 am" */
  handled: string | null;
};

function ask(request: Promise<SensorResult>): Promise<SensorResult> {
  return request.catch(() => ({
    ok: false,
    message: "The server didn’t answer, so nothing changed. Check your connection and try again.",
  }));
}

function AlertRow({
  alert,
  onDone,
}: {
  alert: AlertItem;
  onDone: (alert: AlertItem, resolved: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  function run(request: () => Promise<SensorResult>, resolved: boolean) {
    setProblem(null);
    startTransition(async () => {
      const result = await ask(request());
      if (result.ok) onDone(alert, resolved);
      else setProblem(result.message);
    });
  }

  return (
    <li
      className={`flex flex-col gap-4 rounded-xl border border-l-4 border-line bg-sheet p-4 sm:flex-row sm:items-start sm:justify-between ${
        alert.severity === "urgent" ? "border-l-bad" : "border-l-pencil"
      }`}
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={`rounded-full px-2 py-px text-xs font-bold ${ALERT_LEVEL[alert.severity].badge}`}
          >
            {ALERT_LEVEL[alert.severity].label}
          </span>
          <span className="font-mono font-bold text-ink">{alert.nodeId}</span>
          <span className="text-moss">{alert.nodeName}</span>
          {alert.late && (
            <span className="rounded-full border border-line bg-paper px-2 py-px text-xs font-bold text-moss">
              Came in late
            </span>
          )}
        </p>
        <h3 id={`alert-${alert.id}`} tabIndex={-1} className="mt-2 font-bold">
          {alert.title}
        </h3>
        <p className="mt-1 max-w-2xl text-sm">{alert.means}</p>
        {alert.details.map((line) => (
          <p key={line} className="mt-1 text-sm font-bold">
            {line}
          </p>
        ))}
        <p className="mt-2 max-w-2xl text-sm">
          <span className="font-bold">What to do: </span>
          {alert.todo}
        </p>
        <p className="mt-2 text-sm text-moss">{alert.seen}</p>
        {alert.handled && (
          <p className="mt-1 flex items-start gap-1.5 text-sm font-bold text-ok">
            <Icon name="check" className="mt-0.5 size-4 shrink-0" />
            {alert.handled}
          </p>
        )}
        {problem && (
          <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm font-bold text-bad">
            <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
            {problem}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-stretch">
        {alert.status === "open" && (
          <button
            type="button"
            disabled={pending}
            className="btn btn-secondary"
            onClick={() => run(() => acknowledgeAlert(alert.id), false)}
          >
            <Icon name="check" className="size-4" />
            {pending ? "Saving…" : "Acknowledge"}
            <span className="sr-only">: {alert.title} on {alert.nodeId}</span>
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          className="btn btn-secondary"
          onClick={() => run(() => resolveAlert(alert.id), true)}
        >
          {pending ? "Saving…" : "Resolve"}
          <span className="sr-only">: {alert.title} on {alert.nodeId}</span>
        </button>
      </div>
    </li>
  );
}

export function AlertList({
  alerts,
  clearId,
  clearTitle,
  clearText,
}: {
  alerts: AlertItem[];
  /** Where focus goes when the last alert in this list is resolved */
  clearId: string;
  clearTitle: string;
  clearText: string;
}) {
  const [announcement, setAnnouncement] = useState("");
  // The new list can arrive from the server just after the button's answer, so this keeps trying on
  // each draw until the place to move focus to is on the page.
  const wantFocus = useRef<string | null>(null);
  useEffect(() => {
    const target = wantFocus.current && document.getElementById(wantFocus.current);
    if (target) {
      target.focus();
      wantFocus.current = null;
    }
  });

  // Reads out a new alert that comes in while someone has the page open with a screen reader. The
  // timer redraws this list quietly, so nothing else would tell them.
  const ids = alerts.map((alert) => alert.id).join(",");
  const [seenIds, setSeenIds] = useState(ids);
  if (ids !== seenIds) {
    const before = new Set(seenIds.split(","));
    const fresh = alerts.filter((alert) => !before.has(String(alert.id)));
    setSeenIds(ids);
    if (fresh.length > 0) {
      setAnnouncement(
        `New alert: ${fresh.map((alert) => `${alert.title} on ${alert.nodeId}, ${ALERT_LEVEL[alert.severity].label}`).join(". ")}`,
      );
    }
  }

  function onDone(alert: AlertItem, resolved: boolean) {
    setAnnouncement(`${alert.title} on ${alert.nodeId} ${resolved ? "resolved" : "acknowledged"}.`);
    if (!resolved) {
      wantFocus.current = `alert-${alert.id}`;
      return;
    }
    const left = alerts.filter((other) => other.id !== alert.id);
    const index = alerts.findIndex((other) => other.id === alert.id);
    const next = left[Math.min(index, left.length - 1)];
    wantFocus.current = next ? `alert-${next.id}` : clearId;
  }

  return (
    <>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {alerts.length === 0 ? (
        <div className="card mt-4 flex items-center gap-4 p-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
            <Icon name="check" />
          </span>
          <div>
            <h3 id={clearId} tabIndex={-1} className="font-bold">
              {clearTitle}
            </h3>
            <p className="text-sm text-moss">{clearText}</p>
          </div>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {alerts.map((alert) => (
            <AlertRow key={alert.id} alert={alert} onDone={onDone} />
          ))}
        </ul>
      )}
    </>
  );
}
