"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, LayerGroup } from "leaflet";
import type { SensorMapState } from "@/lib/iot";

export type MapEdge = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** "Last heard from 2 minutes ago", worked out by the server */
  line: string;
  off: boolean;
};

/** ok: reporting, no alert; warning: a routine alert; alert: an urgent alert; quiet: gone quiet or never sent */
export type MapNodeState = SensorMapState;

export type MapNode = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** The edge device it sends through, if that device has a position */
  edge: { latitude: number; longitude: number } | null;
  state: MapNodeState;
  /** "Reporting", "2 alerts going on, 1 urgent", "Quiet, last reading 40 minutes ago" */
  line: string;
};

const STATE_CLASS: Record<MapNodeState, string> = {
  ok: "map-sensor",
  warning: "map-sensor map-sensor-warn",
  alert: "map-sensor map-sensor-alert",
  quiet: "map-sensor map-sensor-offline",
};

// OpenStreetMap's own tiles. Their usage policy asks for this attribution and a light load, which a
// page that only a few staff open is.
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
// Niah National Park HQ, for a map with nothing on it yet
const NIAH: [number, number] = [3.8149, 113.7797];

function escape(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The edge devices with lines to the nodes linked to them. Leaflet needs the browser, so it loads
 * after the page has. The node cards below have everything the map shows, as text, for anyone who
 * can't use the map. Clicking a node, or Enter on it, jumps to its card.
 */
export function SensorMap({ edges, nodes }: { edges: MapEdge[]; nodes: MapNode[] }) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const layer = useRef<LayerGroup | null>(null);
  const fitted = useRef(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let gone = false;
    import("leaflet")
      .then((L) => {
        if (gone || !holder.current || map.current) return;
        map.current = L.map(holder.current, { scrollWheelZoom: false }).setView(NIAH, 14);
        L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map.current);
        layer.current = L.layerGroup().addTo(map.current);
        setReady(true);
      })
      .catch(() => setFailed(true));
    return () => {
      gone = true;
      map.current?.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  // The page redraws every 15 seconds. This only swaps the markers, and keeps where staff have
  // panned or zoomed to.
  const key = JSON.stringify({ edges, nodes });
  useEffect(() => {
    if (!ready) return;
    let gone = false;
    import("leaflet").then((L) => {
      const group = layer.current;
      if (gone || !group || !map.current) return;
      group.clearLayers();
      const points: [number, number][] = [];

      for (const node of nodes) {
        if (node.edge) {
          L.polyline(
            [
              [node.latitude, node.longitude],
              [node.edge.latitude, node.edge.longitude],
            ],
            { color: "#5b6b60", weight: 2, dashArray: "4 5", interactive: false },
          ).addTo(group);
        }
      }

      for (const edge of edges) {
        points.push([edge.latitude, edge.longitude]);
        L.marker([edge.latitude, edge.longitude], {
          title: `Edge device ${edge.id}, ${edge.name}. ${edge.line}`,
          alt: `Edge device ${edge.id}`,
          zIndexOffset: 500,
          icon: L.divIcon({
            className: "",
            iconSize: [26, 26],
            html: `<span class="block size-[26px] rotate-45 rounded-[4px] border-[3px] border-white ${
              edge.off ? "bg-pencil" : "bg-forest"
            } shadow"></span>`,
          }),
        })
          .bindTooltip(
            `<strong>${escape(edge.id)}</strong><br>${escape(edge.name)}<br>${escape(edge.line)}`,
            { direction: "top", offset: [0, -14] },
          )
          .addTo(group);
      }

      for (const node of nodes) {
        points.push([node.latitude, node.longitude]);
        L.marker([node.latitude, node.longitude], {
          title: `${node.id}, ${node.name}. ${node.line}`,
          alt: node.id,
          zIndexOffset: node.state === "alert" ? 1000 : 0,
          icon: L.divIcon({ className: STATE_CLASS[node.state], iconSize: [12, 12], html: "<span></span>" }),
        })
          .bindTooltip(`<strong>${escape(node.id)}</strong><br>${escape(node.name)}<br>${escape(node.line)}`, {
            direction: "top",
            offset: [0, -8],
          })
          .on("click", () => {
            const card = document.getElementById(`node-${node.id}`);
            card?.scrollIntoView({ behavior: "smooth", block: "start" });
            card?.focus({ preventScroll: true });
          })
          .addTo(group);
      }

      if (!fitted.current && points.length > 0) {
        fitted.current = true;
        if (points.length === 1) map.current.setView(points[0], 16);
        else map.current.fitBounds(points, { padding: [32, 32], maxZoom: 17 });
      }
    });
    return () => {
      gone = true;
    };
    // key stands for edges and nodes, which are new arrays on every draw
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key]);

  return (
    <div>
      <div
        ref={holder}
        role="region"
        aria-label="Map of the edge devices and their sensor nodes. The node cards below have the same details as text."
        className="map-frame relative z-0 h-[22rem] overflow-hidden rounded-xl border border-line bg-paper sm:h-[28rem]"
      />
      {failed && (
        <p role="alert" className="mt-2 text-sm font-bold text-bad">
          The map didn’t load. The node cards below still have everything on it.
        </p>
      )}
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-moss" aria-label="Map key">
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block size-3.5 rotate-45 rounded-[3px] bg-forest" />
          Edge device
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block size-3 rounded-[2px] bg-ink" />
          Node reporting
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block size-3 rounded-[2px] bg-warn" />
          Routine alert
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="relative inline-block size-3 rounded-[2px] bg-ink ring-2 ring-bad ring-offset-2" />
          Urgent alert
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block size-3 rounded-[2px] border-2 border-ink bg-sheet" />
          Quiet
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block w-5 border-t-2 border-dashed border-moss" />
          Sends through
        </li>
      </ul>
    </div>
  );
}
