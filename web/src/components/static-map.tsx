import type { CSSProperties } from "react";
import { PARK_HQ } from "@/lib/geo";
import { SENSOR_CLASS } from "@/lib/iot";
import type { MapArea, MapPoint, MapSensor } from "./leaflet-map";

// The map for browsers with JavaScript turned off (ParkMap puts it in a
// <noscript>, so nobody else loads its tiles). It draws the same things as
// LeafletMap, worked out here on the server: OpenStreetMap tiles laid out
// around the middle of everything, then the squares, park HQ, the sensors
// and the plants on top. It can't zoom or move, so it says so.

const TILE = 256;
// The map is at least about 320 px wide and tall on a phone. Leaflet keeps
// 48 px clear around the edge, so everything has to fit in what's left. The
// notes under the map take about 40 px of the height on a phone, which still
// leaves over 20 px clear at the top and bottom.
const NARROWEST = 320;
const FIT = NARROWEST - 2 * 48;
// A label that would go past this on a phone goes on the other side of its
// dot instead, so it isn't cut off
const EDGE = NARROWEST / 2;
const MAX_ZOOM = 15;
// Enough tiles to fill the widest map (the overview) and the tallest (h-96)
const HALF_WIDTH = 640;
const HALF_HEIGHT = 200;

// Labels are 13 px bold, about this wide per letter. They can't be measured
// without a browser, so this is a guess, on the wide side. The height is the
// 18 px line LABEL gives them.
const LETTER = 7.5;
const MONO_LETTER = 9;
const LABEL_HEIGHT = 18;

type Box = { left: number; top: number; right: number; bottom: number };
type Side = "right" | "left";

/** Where a point is on the world map at a zoom, in pixels (Web Mercator) */
function project(lat: number, lng: number, zoom: number) {
  const size = TILE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

function covers(a: Box, b: Box) {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

/** A square box around a dot of this size */
function around(x: number, y: number, size: number): Box {
  return {
    left: x - size / 2,
    top: y - size / 2,
    right: x + size / 2,
    bottom: y + size / 2,
  };
}

/** The space a label takes up on one side of its dot */
function beside(x: number, y: number, width: number, side: Side): Box {
  const left = side === "right" ? x + 14 : x - 14 - width;
  return {
    left,
    top: y - LABEL_HEIGHT / 2,
    right: left + width,
    bottom: y + LABEL_HEIGHT / 2,
  };
}

const LABEL =
  "absolute whitespace-nowrap text-[0.8125rem] font-bold leading-[18px] text-ink [text-shadow:0_0_2px_#fff,0_0_3px_#fff,0_0_4px_#fff]";

export function StaticMap({
  points,
  areas,
  sensors,
}: {
  points: MapPoint[];
  areas: MapArea[];
  sensors: MapSensor[];
}) {
  const corners = [
    PARK_HQ,
    ...areas.flatMap((a) => [
      { lat: a.south, lng: a.west },
      { lat: a.north, lng: a.east },
    ]),
    ...sensors,
    ...points,
  ];

  // The closest zoom that fits everything, like Leaflet's fitBounds
  let zoom = MAX_ZOOM;
  for (; zoom > 1; zoom--) {
    const xs = corners.map((c) => project(c.lat, c.lng, zoom).x);
    const ys = corners.map((c) => project(c.lat, c.lng, zoom).y);
    const wide = Math.max(...xs) - Math.min(...xs);
    const tall = Math.max(...ys) - Math.min(...ys);
    if (wide <= FIT && tall <= FIT) break;
  }
  const projected = corners.map((c) => project(c.lat, c.lng, zoom));
  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const middle = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };

  // Everything below is in pixels from the middle of the map, which stays in
  // the middle of the box however wide it is
  const at = (lat: number, lng: number) => {
    const p = project(lat, lng, zoom);
    return {
      x: Math.round(p.x - middle.x),
      y: Math.round(p.y - middle.y),
    };
  };
  const place = (x: number, y: number): CSSProperties => ({ left: x, top: y });

  const tiles: { key: string; src: string; x: number; y: number }[] = [];
  const last = 2 ** zoom - 1;
  const firstX = Math.floor((middle.x - HALF_WIDTH) / TILE);
  const lastX = Math.floor((middle.x + HALF_WIDTH) / TILE);
  const firstY = Math.max(0, Math.floor((middle.y - HALF_HEIGHT) / TILE));
  const lastY = Math.min(last, Math.floor((middle.y + HALF_HEIGHT) / TILE));
  for (let ty = firstY; ty <= lastY; ty++) {
    for (let tx = firstX; tx <= lastX; tx++) {
      tiles.push({
        key: `${tx},${ty}`,
        src: `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`,
        x: Math.round(tx * TILE - middle.x),
        y: Math.round(ty * TILE - middle.y),
      });
    }
  }

  const hq = at(PARK_HQ.lat, PARK_HQ.lng);
  const squares = areas.map((area) => {
    const nw = at(area.north, area.west);
    const se = at(area.south, area.east);
    return { id: area.id, ...nw, width: se.x - nw.x, height: se.y - nw.y };
  });
  const sensorSpots = sensors.map((s) => ({ ...s, ...at(s.lat, s.lng) }));
  const plantSpots = points.map((p) => ({ ...p, ...at(p.lat, p.lng) }));

  // The same order as LeafletMap: plants first when two labels want the same
  // space, then park HQ, sensors and rough areas. A label goes on the right
  // of its dot (park HQ's on the left), or the other side when that keeps it
  // on a phone's screen or out of the way. A label that would cover another
  // label or a dot that isn't its own on both sides doesn't go on the map.
  type Label = { key: string; options: { side: Side; box: Box }[]; dot?: Box };
  const sidesOf = (x: number, y: number, width: number, first: Side) =>
    (first === "right" ? ["right", "left"] : ["left", "right"]).map((side) => ({
      side: side as Side,
      box: beside(x, y, width, side as Side),
    }));
  const wanted: Label[] = [
    ...plantSpots.map((p) => ({
      key: `plant-${p.id}`,
      options: sidesOf(p.x, p.y, p.label.length * LETTER, "right"),
      dot: around(p.x, p.y, 17),
    })),
    {
      key: "hq",
      options: sidesOf(hq.x, hq.y, "Park HQ".length * LETTER, "left"),
      dot: around(hq.x, hq.y, 18),
    },
    ...sensorSpots.map((s) => ({
      key: `sensor-${s.id}`,
      options: sidesOf(s.x, s.y, s.id.length * MONO_LETTER, "right"),
      dot: around(s.x, s.y, 14),
    })),
    ...squares.map((square) => ({
      key: `area-${square.id}`,
      // Inside the square's top left corner
      options: [
        {
          side: "right" as const,
          box: {
            left: square.x + 8,
            top: square.y + 12 - LABEL_HEIGHT / 2,
            right: square.x + 8 + "Rough area".length * LETTER,
            bottom: square.y + 12 + LABEL_HEIGHT / 2,
          },
        },
      ],
    })),
  ];
  const kept: Box[] = [];
  const sides = new Map<string, Side>();
  for (const label of wanted) {
    const clear = (box: Box) =>
      !kept.some((k) => covers(box, k)) &&
      !wanted.some(
        (other) => other !== label && other.dot && covers(box, other.dot),
      );
    const onScreen = (box: Box) => box.left >= -EDGE && box.right <= EDGE;
    const option =
      label.options.find((o) => onScreen(o.box) && clear(o.box)) ??
      label.options.find((o) => clear(o.box));
    if (!option) continue;
    kept.push(option.box);
    sides.set(label.key, option.side);
  }

  /** The label beside a dot, on the side picked above, if it has room */
  const labelFor = (
    key: string,
    x: number,
    y: number,
    text: string,
    extra: { className?: string; hidden?: boolean } = {},
  ) => {
    const side = sides.get(key);
    if (!side) return null;
    return (
      <span
        aria-hidden={extra.hidden || undefined}
        className={[
          LABEL,
          "-translate-y-1/2",
          side === "left" ? "-translate-x-full" : "",
          extra.className ?? "",
        ].join(" ")}
        style={place(side === "right" ? x + 14 : x - 14, y)}
      >
        {text}
      </span>
    );
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-xl border border-line bg-sheet">
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute left-1/2 top-1/2">
          {tiles.map((tile) => (
            // eslint-disable-next-line @next/next/no-img-element -- map tiles
            <img
              key={tile.key}
              src={tile.src}
              alt=""
              width={TILE}
              height={TILE}
              className="absolute max-w-none"
              style={place(tile.x, tile.y)}
            />
          ))}

          {squares.map((square) => (
            <div key={square.id}>
              <div
                className="absolute border-2 border-dashed border-moss bg-moss/20"
                style={{
                  ...place(square.x, square.y),
                  width: square.width,
                  height: square.height,
                }}
              />
              {sides.has(`area-${square.id}`) && (
                <span
                  className={`${LABEL} -translate-y-1/2`}
                  style={place(square.x + 8, square.y + 12)}
                >
                  Rough area
                </span>
              )}
            </div>
          ))}

          <svg
            viewBox="-9 -8 18 18"
            width="18"
            height="18"
            aria-hidden="true"
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={place(hq.x, hq.y)}
          >
            <path
              d="M-7 1L0-6 7 1V8H-7Z"
              fill="#16201a"
              stroke="#fff"
              strokeWidth="1.5"
            />
          </svg>
          {labelFor("hq", hq.x, hq.y, "Park HQ")}

          {sensorSpots.map((sensor) => (
            <div key={sensor.id}>
              <span
                className={`${SENSOR_CLASS[sensor.state]} absolute size-3.5 -translate-x-1/2 -translate-y-1/2`}
                style={place(sensor.x, sensor.y)}
              >
                <span />
              </span>
              {labelFor(`sensor-${sensor.id}`, sensor.x, sensor.y, sensor.id, {
                className: "font-mono",
              })}
            </div>
          ))}

          {plantSpots.map((point) => {
            const key = `plant-${point.id}`;
            return (
              <div key={point.id}>
                {point.link ? (
                  // A plain link, so it works without JavaScript. Its name
                  // shows when the pointer is on it if the label is left off.
                  <a
                    href={point.link.href}
                    title={sides.has(key) ? undefined : point.link.text}
                    // .map-dot fills a Leaflet marker, so it needs a size here
                    className="map-dot absolute size-6! -translate-x-1/2 -translate-y-1/2"
                    style={place(point.x, point.y)}
                  >
                    <span className="sr-only">{point.link.text}</span>
                  </a>
                ) : (
                  <span
                    className="absolute size-[17px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-white bg-forest"
                    style={place(point.x, point.y)}
                  />
                )}
                {/* The link already says it, so it isn't read out twice */}
                {labelFor(key, point.x, point.y, point.label, {
                  hidden: Boolean(point.link),
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Both notes go in a strip under the map rather than on it, so they
          can't cover a label */}
      <div className="flex flex-wrap justify-between gap-x-3 border-t border-line px-2 py-1 text-xs text-moss">
        <p>Turn JavaScript on to zoom and move the map.</p>
        <p>
          &copy;{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            className="underline"
          >
            OpenStreetMap
          </a>{" "}
          contributors
        </p>
      </div>
    </div>
  );
}
