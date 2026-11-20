/**
 * How green a route is, from OpenStreetMap (the Overpass API, free, no key): how much of it runs
 * on trails and paths, through parks, woods and meadows, and by water, and how much beside busy
 * roads. For the coach's routes ("a scenic loop in nature", "somewhere quiet"): the candidate
 * loops are scored and the best one kept.
 */
import type { Get } from "./route-finder.ts";
import { along, metres, type LngLat } from "./routes.ts";

const OVERPASS = "https://overpass-api.de/api/interpreter";

export interface Scenery {
  /** Shares of the route, 0–1. */
  trails: number;
  green: number;
  water: number;
  busy: number;
}

/** What the map has around the routes, by kind. */
export interface Features {
  trails: LngLat[][];
  /** Closed outlines (parks, woods, meadows, water areas). */
  green: LngLat[][];
  water: LngLat[][];
  busy: LngLat[][];
}

type Way = { tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> };

/** Everything in the box around the lines, sorted by kind. null when Overpass can't be reached. */
export async function features(get: Get, lines: LngLat[][]): Promise<Features | null> {
  const all = lines.flat();
  if (!all.length) return null;
  const pad = 0.004;
  const s = Math.min(...all.map((p) => p[1])) - pad;
  const w = Math.min(...all.map((p) => p[0])) - pad;
  const n = Math.max(...all.map((p) => p[1])) + pad;
  const e = Math.max(...all.map((p) => p[0])) + pad;
  const box = `(${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)})`;
  const q = `[out:json][timeout:25];(
way["highway"~"^(path|track|footway|bridleway)$"]${box};
way["leisure"~"^(park|nature_reserve|garden)$"]${box};
way["landuse"~"^(forest|meadow|grass|recreation_ground)$"]${box};
way["natural"~"^(wood|water|scrub|heath|grassland|beach|wetland)$"]${box};
way["waterway"~"^(river|stream|canal)$"]${box};
way["highway"~"^(motorway|trunk|primary|secondary)$"]${box};
);out geom;`;
  try {
    const res = await get(OVERPASS, { method: "POST", body: new URLSearchParams({ data: q }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { elements?: Way[] };
    return sortWays(j.elements ?? []);
  } catch {
    return null;
  }
}

export function sortWays(ways: Way[]): Features {
  const out: Features = { trails: [], green: [], water: [], busy: [] };
  for (const w of ways) {
    const g = w.geometry?.map((p) => [p.lon, p.lat] as LngLat);
    const t = w.tags ?? {};
    if (!g || g.length < 2) continue;
    if (/^(motorway|trunk|primary|secondary)$/.test(t.highway ?? "")) out.busy.push(g);
    else if (/^(path|track|footway|bridleway)$/.test(t.highway ?? "")) out.trails.push(g);
    else if (t.waterway || t.natural === "water" || t.natural === "beach" || t.natural === "wetland") out.water.push(g);
    else out.green.push(g);
  }
  return out;
}

/** Whether p is inside the closed outline (ray casting). */
function inside(p: LngLat, ring: LngLat[]): boolean {
  let yes = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}

/** Metres from p to the segment a–b (flat, fine at these distances). */
function toSegment(p: LngLat, a: LngLat, b: LngLat): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + t * dx, ay + t * dy) * 111_320;
}

/** Lines cut into a grid of about 200 m, so each point only looks at what's near it. */
function grid(lines: LngLat[][]) {
  const cell = 0.002;
  const key = (p: LngLat) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
  const m = new Map<string, Array<[LngLat, LngLat]>>();
  for (const l of lines)
    for (let i = 1; i < l.length; i++) {
      const seg: [LngLat, LngLat] = [l[i - 1]!, l[i]!];
      for (const k of new Set([key(seg[0]), key(seg[1])])) (m.get(k) ?? m.set(k, []).get(k)!).push(seg);
    }
  return (p: LngLat, within: number) => {
    const [cx, cy] = [Math.floor(p[0] / cell), Math.floor(p[1] / cell)];
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++) for (const [a, b] of m.get(`${x},${y}`) ?? []) if (toSegment(p, a, b) <= within) return true;
    return false;
  };
}

/** Points every ~40 m along the line. */
function samples(line: LngLat[]): LngLat[] {
  const d = along(line);
  const out: LngLat[] = [];
  let next = 0;
  for (let i = 0; i < line.length; i++) if (d[i]! >= next) { out.push(line[i]!); next = d[i]! + 40; }
  return out;
}

/** How much of a route is on trails, in green, by water, beside busy roads. */
export function sceneryOf(line: LngLat[], f: Features): Scenery {
  const pts = samples(line);
  if (!pts.length) return { trails: 0, green: 0, water: 0, busy: 0 };
  const onTrail = grid(f.trails);
  const nearWater = grid(f.water);
  const nearBusy = grid(f.busy);
  const nearGreen = grid(f.green);
  const closed = f.green.filter((r) => r.length > 3 && metres(r[0]!, r.at(-1)!) < 5);
  let t = 0, g = 0, w = 0, b = 0;
  for (const p of pts) {
    if (onTrail(p, 15)) t++;
    if (closed.some((r) => inside(p, r)) || nearGreen(p, 25)) g++;
    if (nearWater(p, 80)) w++;
    if (nearBusy(p, 30)) b++;
  }
  const n = pts.length;
  return { trails: t / n, green: g / n, water: w / n, busy: b / n };
}

/** One number for "how much would someone wanting nature (or quiet) like this". */
export function sceneryScore(s: Scenery, want: "nature" | "quiet"): number {
  return want === "nature" ? 0.45 * s.green + 0.35 * s.trails + 0.2 * s.water - 0.5 * s.busy : 0.6 * s.trails + 0.2 * s.green - 0.8 * s.busy;
}

/** The scenery in a few words, for the coach to say. */
export function sceneryWords(s: Scenery): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const parts = [`${pct(s.trails)} on trails and paths`, `${pct(s.green)} through parks, woods or meadows`];
  if (s.water >= 0.1) parts.push(`${pct(s.water)} by water`);
  if (s.busy >= 0.05) parts.push(`${pct(s.busy)} beside busy roads`);
  return parts.join(", ");
}
