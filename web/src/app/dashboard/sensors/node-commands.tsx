"use client";

import { useState, useTransition } from "react";
import { Icon } from "@/components/icon";
import type { CommandName } from "@/lib/iot";
import { sendCommand, type SensorResult } from "./actions";

export type CommandLine = {
  id: string;
  /** "Stop the locate beep" */
  what: string;
  /** "Sent by Aina Officer, 6 Nov, 3:14 pm" */
  who: string;
  /** "Done", "At the edge device, waiting for the node" */
  status: string;
  finished: boolean;
  failed: boolean;
};

/**
 * The locate beep and the baseline reset for one node. Officers and admins can send them (025). A
 * command the node hasn't finished yet is shown with how far it's got, and the same one can't be
 * sent again until it's finished, so a slow edge device doesn't get a pile of them.
 */
export function NodeCommands({
  nodeId,
  beepOn,
  waiting,
  recent,
}: {
  nodeId: string;
  /** What the node last said, or null if it hasn't sent anything */
  beepOn: boolean | null;
  /** Commands the node hasn't finished yet */
  waiting: CommandName[];
  recent: CommandLine[];
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SensorResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  function send(command: CommandName) {
    setResult(null);
    setConfirming(false);
    startTransition(async () => {
      const answer = await sendCommand({ nodeId, command }).catch(() => ({
        ok: false,
        message: "The server didn’t answer, so nothing was sent. Check your connection and try again.",
      }));
      setResult(answer);
    });
  }

  const beep: CommandName = beepOn === false ? "beep_on" : "beep_off";
  const beepWaiting = waiting.includes("beep_on") || waiting.includes("beep_off");
  const resetWaiting = waiting.includes("reset_baseline");

  return (
    <div className="mt-4 border-t border-line pt-4 text-sm">
      <h4 className="font-bold">Commands</h4>
      <p className="mt-1 text-moss">
        The locate beep sounds every 5 seconds so a patrol can find the node.{" "}
        {beepOn === null ? "" : beepOn ? "It’s on now." : "It’s off now."} Reset the baseline after the
        node has been put back on purpose, so it takes its distance to the ground now as normal.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending || beepWaiting}
          onClick={() => send(beep)}
        >
          <Icon name="sensor" className="size-4" />
          {beep === "beep_on" ? "Start the locate beep" : "Stop the locate beep"}
          <span className="sr-only"> on {nodeId}</span>
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="btn btn-danger"
              disabled={pending}
              onClick={() => send("reset_baseline")}
            >
              Yes, reset it
              <span className="sr-only"> on {nodeId}</span>
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending || resetWaiting}
            onClick={() => setConfirming(true)}
          >
            <Icon name="undo" className="size-4" />
            Reset the baseline
            <span className="sr-only"> on {nodeId}</span>
          </button>
        )}
      </div>
      {confirming && (
        <p className="mt-2 max-w-md font-bold">
          Only do this when the node is back where it should be. If it’s been knocked over, resetting
          hides that, and it won’t say it’s moved again.
        </p>
      )}
      {(beepWaiting || resetWaiting) && (
        <p className="mt-2 text-moss">A button is greyed out while its last command is still on its way.</p>
      )}

      <p role="status" className={`mt-2 ${result && !result.ok ? "font-bold text-bad" : "text-moss"}`}>
        {pending ? "Sending…" : result?.message}
      </p>

      {recent.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {recent.map((line) => (
            <li key={line.id} className="flex items-start gap-1.5">
              <Icon
                name={line.failed ? "alert" : line.finished ? "check" : "clock"}
                className={`mt-0.5 size-4 shrink-0 ${line.failed ? "text-bad" : line.finished ? "text-ok" : "text-moss"}`}
              />
              <span>
                <span className="font-bold">{line.what}</span>: {line.status}.{" "}
                <span className="text-moss">{line.who}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
