/**
 * Finding the way on foot, for the route editor and the coach's routes: OpenStreetMap's walking
 * router (OSRM, run by FOSSGIS for openstreetmap.org), BRouter's public server when that one
 * doesn't answer, and heights from Open-Meteo. Free, no key. `get` is the app's HTTP (the
 * phone's native one, which names Tartan as the services ask); `log` says what went wrong.
 */
import type { LngLat } from "./routes.ts";
import { metres } from "./routes.ts";
import { splitLoop } from "./route-loop.ts";

/** Why there's no path: none exists there, or the path finders couldn't be reached. */
export type PathResult = { line: LngLat[]; via: "osm" | "brouter" } | { line: null; reason: "no-path" | "unreachable"; detail: string };

export type Get = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<Response>;

declare const BUILD_ID: string;
/** How Tartan names itself to the free map services (they ask apps to). */
export const UA = `Tartan/${typeof BUILD_ID === "string" ? BUILD_ID : "dev"} (running app; https://github.com/sanjinpepic/Tartan)`;

export function routeFinder(get: Get, log: (m: string) => void = () => {}) {
  const OSRM = "https://routing.openstreetmap.de/routed-foot/route/v1/driving";
  const BROUTER = "https://brouter.de/brouter";
  const ELEVATION = "https://api.open-meteo.com/v1/elevation";


  async function osrm(a: LngLat, b: LngLat): Promise<LngLat[] | "no-path"> {
    const res = await get(`${OSRM}/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson&steps=false`);
    const text = await res.text();
    if (!res.ok && res.status !== 400) throw new Error(`HTTP ${res.status} ${text.slice(0, 80)}`);
    const j = JSON.parse(text) as { code?: string; routes?: Array<{ geometry?: { coordinates?: LngLat[] } }> };
    if (j.code === "NoRoute" || j.code === "NoSegment") return "no-path";
    const line = j.code === "Ok" ? j.routes?.[0]?.geometry?.coordinates : undefined;
    if (!line || line.length < 2) throw new Error(`answer ${j.code ?? "without a route"}`);
    return line;
  }

  async function brouter(a: LngLat, b: LngLat): Promise<LngLat[] | "no-path"> {
    const res = await get(`${BROUTER}?lonlats=${a[0]},${a[1]}|${b[0]},${b[1]}&profile=hiking-mountain&alternativeidx=0&format=geojson`);
    const text = await res.text();
    // BRouter answers plain text when it finds nothing ("target island detected", "no track found").
    if (!res.ok) {
      if (/island|no track|not mapped|position not/i.test(text)) return "no-path";
      throw new Error(`HTTP ${res.status} ${text.slice(0, 80)}`);
    }
    const j = JSON.parse(text) as { features?: Array<{ geometry?: { coordinates?: number[][] } }> };
    const line = j.features?.[0]?.geometry?.coordinates?.map((c) => [c[0]!, c[1]!] as LngLat);
    if (!line || line.length < 2) throw new Error("answer without a track");
    return line;
  }

  /** The way on foot from a to b. */
  async function footpath(a: LngLat, b: LngLat): Promise<PathResult> {
    const problems: string[] = [];
    let noPath = false;
    for (const [via, find] of [["osm", osrm], ["brouter", brouter]] as const) {
      try {
        const line = await find(a, b);
        if (line === "no-path") {
          noPath = true;
          continue;
        }
        // Start and end exactly where you tapped, so the parts join up.
        return { line: [a, ...line.slice(1, -1), b], via };
      } catch (e) {
        problems.push(`${via}: ${(e as Error).message}`);
      }
    }
    const detail = problems.join("; ");
    log(`Routes: no path from ${a.join(",")} to ${b.join(",")}${detail ? ` (${detail})` : " (none there)"}`);
    return { line: null, reason: noPath && problems.length < 2 ? "no-path" : "unreachable", detail };
  }

  /**
   * A loop through several points in one go, without turning back at them (OSRM's
   * continue_straight): no dead-end spurs out to a point and back. The line comes back split
   * into one leg per pair of points, and the points moved onto the paths. BRouter when OSRM
   * can't answer. null when neither finds a way.
   */
  async function footloop(points: LngLat[]): Promise<{ legs: LngLat[][]; points: LngLat[] } | null> {
    try {
      const res = await get(`${OSRM}/${points.map((p) => `${p[0]},${p[1]}`).join(";")}?overview=full&geometries=geojson&steps=false&continue_straight=true`);
      const j = (await res.json()) as { code?: string; routes?: Array<{ geometry?: { coordinates?: LngLat[] } }>; waypoints?: Array<{ location?: LngLat }> };
      const line = j.code === "Ok" ? j.routes?.[0]?.geometry?.coordinates : undefined;
      const snapped = j.waypoints?.map((w, i) => w.location ?? points[i]!);
      if (line && line.length > 2 && snapped?.length === points.length) return splitLoop(line, snapped);
    } catch (e) {
      log(`Routes: loop by OSRM failed (${(e as Error).message})`);
    }
    try {
      const res = await get(`${BROUTER}?lonlats=${points.map((p) => `${p[0]},${p[1]}`).join("|")}&profile=hiking-mountain&alternativeidx=0&format=geojson`);
      if (res.ok) {
        const j = (await res.json()) as { features?: Array<{ geometry?: { coordinates?: number[][] } }> };
        const line = j.features?.[0]?.geometry?.coordinates?.map((c) => [c[0]!, c[1]!] as LngLat);
        if (line && line.length > 2) return splitLoop(line, points);
      }
    } catch (e) {
      log(`Routes: loop by BRouter failed (${(e as Error).message})`);
    }
    return null;
  }

  const cache = new Map<string, number>();
  const key = (p: LngLat) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

  /**
   * Heights along a line, one per point: up to 200 points are looked up (about every 25 m on a
   * short route), the rest interpolated by distance. null when the service can't be reached.
   */
  async function heights(line: LngLat[]): Promise<number[] | null> {
    if (line.length < 2) return null;
    const d = [0];
    for (let i = 1; i < line.length; i++) d.push(d[i - 1]! + metres(line[i - 1]!, line[i]!));
    const total = d.at(-1)!;
    const n = Math.max(2, Math.min(200, Math.ceil(total / 25) + 1));
    // Samples evenly along the line.
    const samples: LngLat[] = [];
    for (let k = 0, j = 0; k < n; k++) {
      const at = (total * k) / (n - 1);
      while (j < line.length - 2 && d[j + 1]! < at) j++;
      const span = d[j + 1]! - d[j]! || 1;
      const t = Math.min(1, Math.max(0, (at - d[j]!) / span));
      samples.push([line[j]![0] + (line[j + 1]![0] - line[j]![0]) * t, line[j]![1] + (line[j + 1]![1] - line[j]![1]) * t]);
    }
    const missing = [...new Set(samples.map(key).filter((k) => !cache.has(k)))];
    try {
      for (let i = 0; i < missing.length; i += 100) {
        const part = missing.slice(i, i + 100).map((k) => k.split(",").map(Number) as LngLat);
        const res = await get(`${ELEVATION}?latitude=${part.map((p) => p[1]).join(",")}&longitude=${part.map((p) => p[0]).join(",")}`);
        if (!res.ok) {
          log(`Routes: heights unavailable (HTTP ${res.status})`);
          return null;
        }
        const j = (await res.json()) as { elevation?: number[] };
        if (!Array.isArray(j.elevation) || j.elevation.length !== part.length) return null;
        part.forEach((p, k) => cache.set(key(p), j.elevation![k]!));
      }
    } catch (e) {
      log(`Routes: heights unavailable (${(e as Error).message})`);
      return null;
    }
    const h = samples.map((p) => cache.get(key(p))!);
    // Back onto every point of the line.
    return d.map((at) => {
      const x = total ? (at / total) * (n - 1) : 0;
      const i = Math.min(n - 2, Math.floor(x));
      return Math.round((h[i]! + (h[i + 1]! - h[i]!) * (x - i)) * 10) / 10;
    });
  }
  return { footpath, footloop, heights };
}
