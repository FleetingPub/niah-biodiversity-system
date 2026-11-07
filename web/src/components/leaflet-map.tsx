"use client";

import "leaflet/dist/leaflet.css";
import type {
  LatLngTuple,
  Map as LeafletMapType,
  Marker,
  Tooltip,
} from "leaflet";
import { useEffect, useRef, useState } from "react";
import { PARK_HQ, type Area } from "@/lib/geo";
import { SENSOR_CLASS, type SensorMapState } from "@/lib/iot";

export type MapPoint = {
  id: string;
  lat: number;
  lng: number;
  label: string;
  // Where the dot goes when it's clicked, and what a screen reader says for it
  link?: { href: string; text: string };
};
export type MapArea = Area & { id: string };
// The same four looks as the map on the Sensors page. mapStateOf in lib/iot.ts works it out from
// a row of iot_node_status.
export type MapSensor = {
  id: string;
  lat: number;
  lng: number;
  state: SensorMapState;
};

// Said in words, since a screen reader can't see a sensor is amber, hollow or circled
const SENSOR_WORDS: Record<SensorMapState, string> = {
  ok: "reporting",
  warning: "with a routine alert",
  alert: "with an urgent alert",
  quiet: "gone quiet",
};

// The same colour as globals.css. Leaflet writes it onto the SVG as an
// attribute, and attributes can't read CSS variables.
const MOSS = "#5b6b60";

const HQ_ICON =
  '<svg viewBox="-9 -8 18 18" width="18" height="18" aria-hidden="true"><path d="M-7 1L0-6 7 1V8H-7Z" fill="#16201a" stroke="#fff" stroke-width="1.5"/></svg>';

type Side = "right" | "left";

/** Whether two boxes overlap. No box (a dot not drawn yet) never does. */
function overlaps(a: DOMRect, b?: DOMRect) {
  return (
    b !== undefined &&
    a.left < b.right &&
    b.left < a.right &&
    a.top < b.bottom &&
    b.top < a.bottom
  );
}

// Labels come from the database, so they go in as text and never as HTML
function label(text: string, mono = false) {
  const span = document.createElement("span");
  span.textContent = text;
  if (mono) span.className = "font-mono";
  return span;
}

// For a dot that has its own name for screen readers, so they don't hear it
// twice
function shownLabel(text: string, mono = false) {
  const span = label(text, mono);
  span.setAttribute("aria-hidden", "true");
  return span;
}

/**
 * The map itself, drawn with Leaflet on OpenStreetMap tiles. Leaflet needs
 * the browser, so it is loaded after the page has rendered. It only draws
 * what it is given: for a hidden species the server sends rough squares and
 * never the points inside them (see ParkMap).
 */
export function LeafletMap({
  title,
  descriptionId,
  points,
  areas,
  sensors,
}: {
  title: string;
  descriptionId: string;
  points: MapPoint[];
  areas: MapArea[];
  sensors: MapSensor[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let map: LeafletMapType | undefined;
    let cancelled = false;

    import("leaflet")
      .then((L) => {
        if (cancelled) return;
        map = L.map(element, {
          // Scrolling the page shouldn't zoom the map. The buttons still do.
          scrollWheelZoom: false,
          maxZoom: 18,
        });
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map);

        const corners: LatLngTuple[] = [[PARK_HQ.lat, PARK_HQ.lng]];

        // Every label, with the dot it belongs to if it has one. Plants come
        // first when two labels want the same space, then park HQ, sensors
        // and rough areas. Leaflet only draws a dot once the map has a view,
        // so it's looked up each time instead of kept here. A dot's label
        // starts on the side it was made with (home), how far from the dot
        // it was made (gap).
        const labels: {
          rank: number;
          tooltip: Tooltip;
          layer?: Marker;
          home?: Side;
          gap?: number;
        }[] = [];
        const remember = (rank: number, layer: Marker) => {
          const tooltip = layer.getTooltip();
          if (!tooltip) return;
          const { direction, offset } = tooltip.options;
          labels.push({
            rank,
            tooltip,
            layer,
            home: direction as Side,
            gap: Math.abs(L.point(offset ?? [0, 0]).x),
          });
        };
        // The labels of the dot under the pointer and the dot with focus.
        // They always show, and the others make room for them.
        let pointed: Tooltip | undefined;
        let focused: Tooltip | undefined;
        const featured = (tooltip: Tooltip) =>
          tooltip === pointed || tooltip === focused;

        // Plants close together would have their labels on top of each other
        // and on top of the dots. A dot's label goes on its home side, or the
        // other side when that keeps it on the map or out of the way, like
        // StaticMap does. A label that would cover another label, another
        // dot or the zoom buttons or OSM note, or be cut off by the edge, on
        // both sides is hidden until zooming in or moving the map makes room
        // for it. Pointing at its dot or tabbing to it still shows it.
        const declutter = () => {
          const frame = element.getBoundingClientRect();
          const dots = new Map(
            labels.map((item) => [
              item,
              item.layer?.getElement()?.getBoundingClientRect(),
            ]),
          );
          // The controls sit on top of the labels, so they count as taken
          const kept = [...element.querySelectorAll(".leaflet-control")].map(
            (control) => control.getBoundingClientRect(),
          );
          const order = [...labels].sort(
            (a, b) => Number(featured(b.tooltip)) - Number(featured(a.tooltip)),
          );
          for (const item of order) {
            const tip = item.tooltip.getElement();
            if (!tip) continue;
            // The line is a little taller than the letters, so a label can
            // touch something above or below it by 2 pixels
            const line = tip.getBoundingClientRect();
            const here = new DOMRect(
              line.x,
              line.y + 2,
              line.width,
              line.height - 4,
            );
            const side = item.tooltip.options.direction as Side;
            const options = [{ side, box: here }];
            // Leaflet puts a left label as far from the dot as a right one,
            // so the other side is this box flipped around the dot's middle
            const dot = dots.get(item);
            if (item.home && dot) {
              const middle = dot.x + dot.width / 2;
              const other = {
                side: side === "right" ? ("left" as const) : ("right" as const),
                box: new DOMRect(
                  2 * middle - here.right,
                  here.y,
                  here.width,
                  here.height,
                ),
              };
              if (side === item.home) options.push(other);
              else options.unshift(other);
            }
            const clear = (box: DOMRect) =>
              !kept.some((k) => overlaps(box, k)) &&
              !labels.some(
                (other) => other !== item && overlaps(box, dots.get(other)),
              );
            const onMap = (box: DOMRect) =>
              box.left >= frame.left &&
              box.right <= frame.right &&
              box.top >= frame.top &&
              box.bottom <= frame.bottom;
            const fits = options.find((o) => onMap(o.box) && clear(o.box));
            // A label that's pointed at shows even if it's in the way, but
            // takes a side that's clear of the controls and dots if it has one
            const pick = featured(item.tooltip)
              ? (fits ?? options.find((o) => onMap(o.box)) ?? options[0])
              : fits;
            tip.classList.toggle("map-label-hidden", !pick);
            if (!pick) continue;
            kept.push(pick.box);
            if (pick.side !== side && item.gap !== undefined) {
              item.tooltip.options.direction = pick.side;
              item.tooltip.options.offset = [
                pick.side === "right" ? item.gap : -item.gap,
                0,
              ];
              item.tooltip.update();
            }
          }
        };

        // A sensor or a dot with no link isn't something to open, but its name
        // can be hidden to make room, so it can be tabbed to or pointed at to
        // show it. A finger leaves the screen as soon as it taps, so a tap
        // keeps the name showing until the next tap somewhere else.
        const showsItsName = (
          shape: HTMLElement,
          name: string,
          marker: Marker,
          at: LatLngTuple,
        ) => {
          shape.tabIndex = 0;
          shape.setAttribute("role", "img");
          shape.setAttribute("aria-label", name);
          const tooltip = marker.getTooltip();
          shape.addEventListener("focus", () => {
            // Tabbing to one that's been panned out of sight brings it back
            if (map && !map.getBounds().contains(at)) map.panTo(at);
            focused = tooltip;
            declutter();
          });
          shape.addEventListener("blur", () => {
            if (focused === tooltip) focused = undefined;
            declutter();
          });
          shape.addEventListener("pointerenter", () => {
            pointed = tooltip;
            declutter();
          });
          shape.addEventListener("pointerleave", (event) => {
            if (event.pointerType !== "mouse" || pointed !== tooltip) return;
            pointed = undefined;
            declutter();
          });
        };

        // The map can be dragged by a dot too. A dot moves with the map, so a
        // drag that starts on one ends on it, and that shouldn't open the link.
        let dragged = false;
        map.on("dragstart", () => {
          dragged = true;
        });

        for (const area of areas) {
          const bounds: [LatLngTuple, LatLngTuple] = [
            [area.south, area.west],
            [area.north, area.east],
          ];
          corners.push(...bounds);
          L.rectangle(bounds, {
            color: MOSS,
            weight: 2,
            dashArray: "7 5",
            fillColor: MOSS,
            fillOpacity: 0.2,
            interactive: false,
          }).addTo(map);
          // In the top left corner, like the sketch maps had it, so it stays
          // clear of a dot or park HQ in the middle
          const tooltip = L.tooltip({
            permanent: true,
            direction: "right",
            offset: [2, 12],
            className: "map-label",
          })
            .setLatLng([area.north, area.west])
            .setContent(label("Rough area"))
            .addTo(map);
          labels.push({ rank: 3, tooltip });
        }

        const hq = L.marker([PARK_HQ.lat, PARK_HQ.lng], {
          icon: L.divIcon({ html: HQ_ICON, className: "", iconSize: [18, 18] }),
          interactive: false,
          keyboard: false,
        })
          .bindTooltip(label("Park HQ"), {
            permanent: true,
            direction: "left",
            offset: [-8, 0],
            className: "map-label",
          })
          .addTo(map);
        remember(1, hq);

        for (const sensor of sensors) {
          const at: LatLngTuple = [sensor.lat, sensor.lng];
          corners.push(at);
          // An element rather than HTML, so it can tell when it's pointed at
          const square = document.createElement("span");
          const marker = L.marker(at, {
            icon: L.divIcon({
              html: square,
              className: SENSOR_CLASS[sensor.state],
              iconSize: [14, 14],
            }),
            interactive: false,
            keyboard: false,
            // Under the plants, so a plant's link opens where they overlap
            zIndexOffset: -1000,
          })
            .bindTooltip(shownLabel(sensor.id, true), {
              permanent: true,
              direction: "right",
              offset: [10, 0],
              className: "map-label",
            })
            .addTo(map);
          remember(2, marker);
          showsItsName(square, `Sensor ${sensor.id}, ${SENSOR_WORDS[sensor.state]}`, marker, at);
        }
        // Leaflet doesn't count a drag as a click, so moving the map keeps a
        // tapped sensor's name showing
        map.on("click", (event) => {
          const target = event.originalEvent.target as Element;
          if (!pointed || target.closest(".map-sensor, .map-dot")) return;
          pointed = undefined;
          declutter();
        });

        for (const point of points) {
          const at: LatLngTuple = [point.lat, point.lng];
          corners.push(at);
          if (!point.link) {
            const dot = document.createElement("span");
            dot.className = "map-dot";
            const marker = L.marker(at, {
              icon: L.divIcon({ html: dot, className: "", iconSize: [24, 24] }),
              interactive: false,
              keyboard: false,
            })
              .bindTooltip(shownLabel(point.label), {
                permanent: true,
                direction: "right",
                offset: [10, 0],
                className: "map-label",
              })
              .addTo(map);
            remember(0, marker);
            showsItsName(dot, point.label, marker, at);
            continue;
          }

          // A dot with somewhere to go is a real link, so it can be tabbed to
          // and opened with the keyboard as well as clicked
          const link = document.createElement("a");
          link.href = point.link.href;
          link.className = "map-dot";
          const name = label(point.link.text);
          name.className = "sr-only";
          link.append(name);
          // Tabbing to a dot that's been panned out of sight brings it back
          link.addEventListener("focus", () => {
            if (map && !map.getBounds().contains(at)) map.panTo(at);
          });
          link.addEventListener("pointerdown", () => {
            dragged = false;
          });
          link.addEventListener("click", (event) => {
            // Enter gives a click with no pointer (detail 0), so it always opens
            if (dragged && event.detail > 0) event.preventDefault();
          });
          const marker = L.marker(at, {
            icon: L.divIcon({ html: link, className: "", iconSize: [24, 24] }),
            interactive: false,
            keyboard: false,
          })
            .bindTooltip(shownLabel(point.label), {
              permanent: true,
              direction: "right",
              offset: [10, 0],
              className: "map-label",
            })
            .addTo(map);
          remember(0, marker);

          // Pointing at a dot or tabbing to it shows its label, even if
          // another one was in the way
          const tooltip = marker.getTooltip();
          link.addEventListener("focus", () => {
            focused = tooltip;
            declutter();
          });
          link.addEventListener("blur", () => {
            if (focused === tooltip) focused = undefined;
            declutter();
          });
          link.addEventListener("pointerenter", () => {
            pointed = tooltip;
            declutter();
          });
          link.addEventListener("pointerleave", () => {
            if (pointed === tooltip) pointed = undefined;
            declutter();
          });
        }

        labels.sort((a, b) => a.rank - b.rank);
        // Zooming and fitBounds fire moveend too, so this runs once the map is
        // first drawn, after every zoom, and after a drag takes a label near
        // the edge
        map.on("moveend resize", declutter);
        // A label gets wider when the web font arrives
        document.fonts.ready.then(() => {
          if (!cancelled) declutter();
        });

        map.fitBounds(L.latLngBounds(corners), { padding: [48, 48], maxZoom: 15 });
        setState("ready");
      })
      .catch((error) => {
        console.error("The map didn't load:", error);
        if (!cancelled) setState("failed");
      });

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [points, areas, sensors]);

  return (
    <div className="map-frame relative isolate h-80 overflow-hidden rounded-xl border border-line bg-sheet sm:h-96">
      {/* Leaflet owns everything inside this box, so React never renders into it */}
      <div
        ref={box}
        role="region"
        aria-label={title}
        aria-describedby={descriptionId}
        className="h-full w-full"
      />
      {state !== "ready" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-sheet p-6 text-center text-sm text-moss">
          {state === "loading" ? (
            // Without JavaScript, ParkMap shows StaticMap on top of this
            <span aria-hidden="true">Loading the map…</span>
          ) : (
            <p role="alert">
              The map didn’t load. Check your connection and refresh the page.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
