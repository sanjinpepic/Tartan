/**
 * The map behind the route editor: MapLibre with OpenFreeMap's OpenStreetMap tiles (free, no
 * key), recoloured to Tartan's paper and ink so it reads as part of the app, with footpaths
 * and tracks drawn clearly because that's where runs go. Loaded only when a route is opened.
 */
import * as maplibregl from "maplibre-gl";
import type { Map as MlMap, StyleSpecification } from "maplibre-gl";

export { maplibregl };
export type { MlMap };

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const asset = (f: string) => new URL(`maplibre/${f}`, `${location.origin}/`).href;

let ready = false;
function setup(): void {
  if (ready) return;
  ready = true;
  maplibregl.setWorkerUrl(asset("maplibre-gl-worker.mjs"));
  if (!document.querySelector("link[data-maplibre]")) {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: asset("maplibre-gl.css") });
    link.dataset.maplibre = "";
    document.head.append(link);
  }
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
/** Mix two #rrggbb colours. */
function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a.length === 4 ? `#${[...a.slice(1)].map((c) => c + c).join("")}` : a), p(b.length === 4 ? `#${[...b.slice(1)].map((c) => c + c).join("")}` : b)];
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return a;
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** The base map in the app's colours (light or dark, whichever the app is in). */
export function brandStyle(style: StyleSpecification): StyleSpecification {
  const bg = css("--bg");
  const ink = css("--ink");
  const dark = parseInt(bg.slice(1, 3), 16) < 100;
  const c = {
    bg,
    water: mix(bg, "#5b8db8", dark ? 0.35 : 0.22),
    green: mix(bg, "#5f8f5a", dark ? 0.22 : 0.16),
    building: mix(bg, ink, dark ? 0.12 : 0.07),
    road: dark ? mix(bg, "#ffffff", 0.16) : "#ffffff",
    casing: mix(bg, ink, dark ? 0.25 : 0.14),
    path: mix(bg, ink, dark ? 0.55 : 0.42),
    label: mix(bg, ink, 0.7),
    border: mix(bg, ink, 0.3),
  };
  const set = (l: Record<string, unknown>, k: string, v: unknown) => ((l.paint as Record<string, unknown>) = { ...((l.paint as Record<string, unknown>) ?? {}), [k]: v });
  for (const layer of style.layers as unknown as Array<Record<string, unknown>>) {
    const id = String(layer.id).toLowerCase();
    const type = layer.type;
    if (type === "background") set(layer, "background-color", c.bg);
    else if (type === "fill") {
      if (/water|ocean|lake|river/.test(id)) set(layer, "fill-color", c.water);
      else if (/park|wood|forest|grass|green|landcover|nature|meadow|scrub/.test(id)) set(layer, "fill-color", c.green);
      else if (/building/.test(id)) set(layer, "fill-color", c.building);
      else set(layer, "fill-color", c.bg);
      if (/building/.test(id)) set(layer, "fill-outline-color", c.building);
    } else if (type === "line") {
      if (/water|river|stream|canal/.test(id)) set(layer, "line-color", c.water);
      else if (/boundary|admin/.test(id)) set(layer, "line-color", c.border);
      else if (/path|track|pedestrian|foot|steps|cycle|bridleway/.test(id)) {
        set(layer, "line-color", c.path);
        set(layer, "line-opacity", 0.75);
      } else if (/casing|outline/.test(id)) set(layer, "line-color", c.casing);
      else if (/road|highway|street|tunnel|bridge|motorway|trunk|primary|secondary|tertiary|minor|service/.test(id)) set(layer, "line-color", c.road);
      else if (/rail/.test(id)) set(layer, "line-color", c.casing);
    } else if (type === "symbol") {
      set(layer, "text-color", c.label);
      set(layer, "text-halo-color", c.bg);
      set(layer, "text-halo-width", 1.4);
    }
  }
  return style;
}

/**
 * A map in `container`, centred on `center` (or the whole world). Rejects when the map can't
 * start (no network for the style, no WebGL), so the editor can say so instead of staying blank.
 */
/** `interactive: false`: a picture of the map (a workout's sheet), which never takes a gesture from the page. */
export async function createMap(container: HTMLElement, center: [number, number] | null, opts: { interactive?: boolean } = {}): Promise<MlMap> {
  setup();
  const res = await fetch(STYLE_URL);
  if (!res.ok) throw new Error(`the map didn't load (${res.status})`);
  const style = brandStyle((await res.json()) as StyleSpecification);
  const map = new maplibregl.Map({
    container,
    style,
    center: center ?? [10, 50],
    zoom: center ? 13.5 : 2,
    attributionControl: { compact: true },
    interactive: opts.interactive ?? true,
    dragRotate: false,
    pitchWithRotate: false,
    // One finger pans the map, it never scrolls the page.
    cooperativeGestures: false,
  });
  map.touchZoomRotate.disableRotation();
  // A missing tile is no reason to give up (it shows as empty paper); only a map that never loads is.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the map didn't load")), 20_000);
    map.once("load", () => {
      clearTimeout(t);
      resolve();
    });
  });
  return map;
}
