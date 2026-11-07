"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Icon } from "@/components/icon";
import { checkNewDevice, checkNewNode } from "@/lib/iot";
import {
  addDevice,
  addNode,
  linkNode,
  makeDeviceToken,
  setDeviceEnabled,
  type DeviceResult,
  type TokenResult,
} from "./actions";

export type DeviceItem = {
  id: string;
  name: string;
  zone: string | null;
  enabled: boolean;
  hasToken: boolean;
  tokenLine: string;
  heardLine: string;
};

export type NodeItem = { id: string; name: string; zone: string; deviceId: string | null };

function ask<T extends DeviceResult>(request: Promise<T>): Promise<T | DeviceResult> {
  return request.catch(() => ({
    ok: false,
    message: "The server didn’t answer, so nothing changed. Check your connection and try again.",
  }));
}

function useFocusRequest(saving = false) {
  const [request, setRequest] = useState<{ id: string } | null>(null);
  const done = useRef<{ id: string } | null>(null);
  useEffect(() => {
    // A disabled button can't take focus, so this waits until the save has finished
    if (!request || saving || done.current === request) return;
    done.current = request;
    document.getElementById(request.id)?.focus();
  }, [request, saving]);
  return (id: string) => setRequest({ id });
}

function ResultLine({ result }: { result: DeviceResult | null }) {
  if (!result) return null;
  return (
    <p
      className={`flex items-start gap-1.5 text-sm font-bold ${result.ok ? "text-ok" : "text-bad"}`}
    >
      <Icon name={result.ok ? "check" : "info"} className="mt-0.5 size-4 shrink-0" />
      {result.message}
    </p>
  );
}

/**
 * Shown once. The token only lives in this component's state, so it goes when the panel closes or
 * the page reloads. It isn't in the live region, so a screen reader doesn't read it out by itself.
 */
function TokenPanel({
  deviceId,
  token,
  onClose,
}: {
  deviceId: string;
  token: string;
  onClose: () => void;
}) {
  const inputId = useId();
  const focus = useFocusRequest();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token);
      setCopy("copied");
    } catch {
      setCopy("failed");
      focus(inputId);
    }
  }

  return (
    <div className="mt-4 rounded-xl border-2 border-forest bg-paper p-4">
      <label htmlFor={inputId} className="font-bold">
        The token for {deviceId}. Copy it now, because it isn’t shown again.
      </label>
      <p className="mt-1 text-sm text-moss">
        It goes in this edge device’s secrets.toml, as edge_key (run iot-edge secrets on the edge), and
        nowhere else. Not in a chat, a commit or a screenshot.
      </p>
      <input
        id={inputId}
        ref={inputRef}
        readOnly
        value={token}
        autoComplete="off"
        spellCheck={false}
        onFocus={(event) => event.target.select()}
        className="field mt-3 w-full font-mono text-sm"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" onClick={copyToken}>
          Copy
        </button>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          I’ve copied it
        </button>
        <p role="status" className="text-sm font-bold">
          {copy === "copied" && <span className="text-ok">Copied.</span>}
          {copy === "failed" && (
            <span className="text-bad">Your browser wouldn’t copy it. Select the text and copy it yourself.</span>
          )}
        </p>
      </div>
    </div>
  );
}

function DeviceCard({
  device,
  nodes,
  onResult,
}: {
  device: DeviceItem;
  nodes: NodeItem[];
  onResult: (message: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<DeviceResult | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"token" | "off" | null>(null);
  const focus = useFocusRequest(pending);
  const baseId = useId();
  const tokenButton = `${baseId}-token`;
  const switchButton = `${baseId}-switch`;
  const confirmButton = `${baseId}-confirm`;

  function startConfirm(kind: "token" | "off") {
    setConfirming(kind);
    setResult(null);
    focus(confirmButton);
  }

  function backOut(kind: "token" | "off") {
    setConfirming(null);
    focus(kind === "token" ? tokenButton : switchButton);
  }

  function makeToken() {
    setResult(null);
    setConfirming(null);
    startTransition(async () => {
      const answer: TokenResult = await ask(makeDeviceToken(device.id));
      if (answer.ok && answer.token) {
        setToken(answer.token);
        onResult(answer.message);
      } else {
        setResult(answer);
        onResult(answer.message);
        focus(tokenButton);
      }
    });
  }

  function setEnabled(enabled: boolean) {
    setResult(null);
    setConfirming(null);
    startTransition(async () => {
      const answer = await ask(setDeviceEnabled({ deviceId: device.id, enabled }));
      setResult(answer);
      onResult(answer.message);
      focus(switchButton);
    });
  }

  return (
    <li className={`card p-4 sm:p-5 ${device.enabled ? "" : "border-l-4 border-l-pencil"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-mono text-lg font-bold">{device.id}</h3>
          <p className="text-sm text-moss">
            {device.name}
            {device.zone && `, ${device.zone}`}
          </p>
        </div>
        {device.enabled ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-bold text-ok">
            <span className="size-2 rounded-full bg-ok" aria-hidden="true" />
            On
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 py-0.5 text-xs font-bold text-moss">
            <Icon name="offline" className="size-3.5" />
            Off
          </span>
        )}
      </div>

      <ul className="mt-3 space-y-1 text-sm text-moss">
        <li>{device.tokenLine}</li>
        <li>{device.heardLine}</li>
        <li>
          {nodes.length === 0
            ? "No nodes linked yet"
            : `Nodes: ${nodes.map((node) => node.id).join(", ")}`}
        </li>
      </ul>

      {token && (
        <TokenPanel
          deviceId={device.id}
          token={token}
          onClose={() => {
            setToken(null);
            focus(tokenButton);
          }}
        />
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {confirming === "token" ? (
          <>
            <p className="w-full text-sm font-bold text-bad">
              Make a new token for {device.id}? The old one stops working straight away, and the
              device can’t send anything until it has the new one.
            </p>
            <button type="button" id={confirmButton} className="btn btn-danger" onClick={makeToken}>
              Make a new token
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => backOut("token")}>
              Keep the old one
            </button>
          </>
        ) : confirming === "off" ? (
          <>
            <p className="w-full text-sm font-bold text-bad">
              Turn off {device.id}? Its readings are turned down until it’s turned back on.
            </p>
            <button
              type="button"
              id={confirmButton}
              className="btn btn-danger"
              onClick={() => setEnabled(false)}
            >
              Turn off
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => backOut("off")}>
              Leave it on
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              id={tokenButton}
              disabled={pending}
              className="btn btn-secondary"
              onClick={device.hasToken ? () => startConfirm("token") : makeToken}
            >
              {pending ? "Saving…" : device.hasToken ? "Make a new token" : "Make a token"}
              <span className="sr-only"> for {device.id}</span>
            </button>
            <button
              type="button"
              id={switchButton}
              disabled={pending}
              className="btn btn-secondary"
              onClick={device.enabled ? () => startConfirm("off") : () => setEnabled(true)}
            >
              {device.enabled ? "Turn off" : "Turn on"}
              <span className="sr-only"> {device.id}</span>
            </button>
          </>
        )}
      </div>
      {result && !result.ok && (
        <div className="mt-3">
          <ResultLine result={result} />
        </div>
      )}
    </li>
  );
}

function NodeRow({
  node,
  devices,
  onResult,
}: {
  node: NodeItem;
  devices: DeviceItem[];
  onResult: (message: string) => void;
}) {
  const selectId = useId();
  const [chosen, setChosen] = useState(node.deviceId ?? "");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<DeviceResult | null>(null);
  const focus = useFocusRequest(pending);
  const dirty = chosen !== (node.deviceId ?? "");

  function save() {
    setResult(null);
    startTransition(async () => {
      const answer = await ask(linkNode({ nodeId: node.id, deviceId: chosen || null }));
      setResult(answer);
      onResult(answer.message);
      focus(selectId);
    });
  }

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-mono font-bold">{node.id}</p>
        <p className="text-sm text-moss">
          {node.name}, {node.zone}
        </p>
        {result && (
          <div className="mt-1">
            <ResultLine result={result} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="sr-only">
          Device for {node.id}
        </label>
        <select
          id={selectId}
          value={chosen}
          disabled={pending}
          onChange={(event) => {
            setChosen(event.target.value);
            setResult(null);
          }}
          className="field w-full sm:w-56"
        >
          <option value="">Not linked</option>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.id}
            </option>
          ))}
        </select>
        {dirty && (
          <>
            <button type="button" disabled={pending} className="btn btn-primary" onClick={save}>
              {pending ? "Saving…" : "Save"}
              <span className="sr-only"> the device for {node.id}</span>
            </button>
            <button
              type="button"
              disabled={pending}
              className="btn btn-secondary"
              onClick={() => {
                setChosen(node.deviceId ?? "");
                focus(selectId);
              }}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function AddDeviceForm({ onResult }: { onResult: (message: string) => void }) {
  const [deviceId, setDeviceId] = useState("");
  const [name, setName] = useState("");
  const [zone, setZone] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<DeviceResult | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const checked = checkNewDevice({ deviceId, name, zone });
    if (!checked.ok) {
      setResult({ ok: false, message: checked.message });
      return;
    }
    setResult(null);
    startTransition(async () => {
      const answer = await ask(addDevice(checked.value));
      setResult(answer);
      onResult(answer.message);
      if (answer.ok) {
        setDeviceId("");
        setName("");
        setZone("");
      }
    });
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="mt-4 grid max-w-2xl gap-4 rounded-xl border border-line bg-sheet p-4 sm:grid-cols-2 sm:p-5"
    >
      <div>
        <label htmlFor="device-id" className="text-sm font-bold">
          ID, like NNP-EDGE-01
        </label>
        <input
          id="device-id"
          type="text"
          autoComplete="off"
          value={deviceId}
          onChange={(event) => setDeviceId(event.target.value)}
          className="field mt-1.5 w-full font-mono"
        />
      </div>
      <div>
        <label htmlFor="device-name" className="text-sm font-bold">
          Name
        </label>
        <input
          id="device-name"
          type="text"
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="field mt-1.5 w-full"
        />
      </div>
      <div>
        <label htmlFor="device-zone" className="text-sm font-bold">
          Zone (optional)
        </label>
        <input
          id="device-zone"
          type="text"
          autoComplete="off"
          value={zone}
          onChange={(event) => setZone(event.target.value)}
          className="field mt-1.5 w-full"
        />
      </div>
      <div className="flex items-end">
        <button type="submit" disabled={pending} className="btn btn-primary">
          <Icon name="plus" className="size-4" />
          {pending ? "Adding…" : "Add device"}
        </button>
      </div>
      {result && (
        <div className="sm:col-span-2">
          <ResultLine result={result} />
        </div>
      )}
    </form>
  );
}

function AddNodeForm({
  devices,
  onResult,
}: {
  devices: DeviceItem[];
  onResult: (message: string) => void;
}) {
  const [nodeId, setNodeId] = useState("");
  const [name, setName] = useState("");
  const [zone, setZone] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<DeviceResult | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const checked = checkNewNode({ nodeId, name, zone, deviceId });
    if (!checked.ok) {
      setResult({ ok: false, message: checked.message });
      return;
    }
    setResult(null);
    startTransition(async () => {
      const answer = await ask(addNode(checked.value));
      setResult(answer);
      onResult(answer.message);
      if (answer.ok) {
        setNodeId("");
        setName("");
        setZone("");
      }
    });
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="mt-4 grid max-w-2xl gap-4 rounded-xl border border-line bg-sheet p-4 sm:grid-cols-2 sm:p-5"
    >
      <div>
        <label htmlFor="node-id" className="text-sm font-bold">
          ID, like NNP-IOT-04
        </label>
        <input
          id="node-id"
          type="text"
          autoComplete="off"
          value={nodeId}
          onChange={(event) => setNodeId(event.target.value)}
          className="field mt-1.5 w-full font-mono"
        />
      </div>
      <div>
        <label htmlFor="node-name" className="text-sm font-bold">
          Name
        </label>
        <input
          id="node-name"
          type="text"
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="field mt-1.5 w-full"
        />
      </div>
      <div>
        <label htmlFor="node-zone" className="text-sm font-bold">
          Zone
        </label>
        <input
          id="node-zone"
          type="text"
          autoComplete="off"
          value={zone}
          onChange={(event) => setZone(event.target.value)}
          className="field mt-1.5 w-full"
        />
      </div>
      <div>
        <label htmlFor="node-device" className="text-sm font-bold">
          Device
        </label>
        <select
          id="node-device"
          value={deviceId}
          onChange={(event) => setDeviceId(event.target.value)}
          className="field mt-1.5 w-full"
        >
          <option value="">Not linked</option>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.id}
            </option>
          ))}
        </select>
      </div>
      <div>
        <button type="submit" disabled={pending} className="btn btn-primary">
          <Icon name="plus" className="size-4" />
          {pending ? "Adding…" : "Add node"}
        </button>
      </div>
      {result && (
        <div className="sm:col-span-2">
          <ResultLine result={result} />
        </div>
      )}
    </form>
  );
}

export function Devices({ devices, nodes }: { devices: DeviceItem[]; nodes: NodeItem[] }) {
  const [announcement, setAnnouncement] = useState("");

  return (
    <>
      <p role="status" className="sr-only">
        {announcement}
      </p>

      <section aria-labelledby="devices-heading">
        <h2 id="devices-heading" className="text-xl font-bold tracking-tight">
          Edge devices
        </h2>
        {devices.length === 0 ? (
          <p className="card mt-4 p-5 text-moss">No edge devices yet. Add the first one below.</p>
        ) : (
          <ul className="mt-4 grid gap-4 lg:grid-cols-2">
            {devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                nodes={nodes.filter((node) => node.deviceId === device.id)}
                onResult={setAnnouncement}
              />
            ))}
          </ul>
        )}
        <h3 className="mt-8 font-bold">Add an edge device</h3>
        <AddDeviceForm onResult={setAnnouncement} />
      </section>

      <section aria-labelledby="link-heading">
        <h2 id="link-heading" className="text-xl font-bold tracking-tight">
          Sensor nodes
        </h2>
        <p className="max-w-2xl text-moss">
          A device can only add readings for the nodes linked to it. If its Serial Monitor prints
          node_not_on_this_device, this is where to fix it.
        </p>
        {nodes.length === 0 ? (
          <p className="card mt-4 p-5 text-moss">No sensor nodes yet. Add the first one below.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line rounded-xl border border-line bg-sheet">
            {nodes.map((node) => (
              <NodeRow key={node.id} node={node} devices={devices} onResult={setAnnouncement} />
            ))}
          </ul>
        )}
        <h3 className="mt-8 font-bold">Add a sensor node</h3>
        <AddNodeForm devices={devices} onResult={setAnnouncement} />
      </section>
    </>
  );
}
