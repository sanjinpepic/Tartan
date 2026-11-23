/**
 * Routes you draw in Tartan (or bring in as GPX), to run and to put on the watch. One file per
 * route in `routes/`, with the points you placed, the line between them (following paths or
 * straight), and the height along it. A GPX file is what the Suunto app imports, so that is
 * how a route reaches the watch until Tartan can send one over Bluetooth itself.
 */
import { readJson, type Disk } from "./disk.ts";

export type LngLat = [number, number];
export type RouteMode = "paths" | "straight";

export interface Route {
  id: string;
  name: string;
  created: string;
  updated: string;
  /** The points you placed, in order (the first is the start). */
  waypoints: LngLat[];
  /** The line between each pair of waypoints (waypoints.length - 1 of them). */
  segments: Array<{ mode: RouteMode; coords: LngLat[] }>;
  /** Metres above sea level for each point of the whole line, when known. */
  elevation?: number[];
  distance_m: number;
  ascent_m?: number;
  descent_m?: number;
  /** Where it came from when it wasn't drawn here. */
  source?: "gpx";
  /** Sent to the watch over Bluetooth: the id the watch keeps it under, and when. */
  watch?: { id: number; sent: string; name: string };
}

export type RouteSummary = Pick<Route, "id" | "name" | "updated" | "distance_m" | "ascent_m" | "descent_m" | "source" | "watch"> & {
  /** The line thinned to at most ~80 points, for the list's little map. */
  preview: LngLat[];
  loop: boolean;
};

export type RouteInput = Pick<Route, "name" | "waypoints" | "segments"> & Partial<Pick<Route, "id" | "elevation" | "source" | "watch">>;

const DIR = "routes";
const MAX_POINTS = 50_000;
const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Metres between two points (haversine). */
export function metres(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The whole line: the segments joined, without repeating the point where two meet. */
export function lineOf(segments: Route["segments"]): LngLat[] {
  const out: LngLat[] = [];
  for (const s of segments)
    for (const p of s.coords) {
      const last = out.at(-1);
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
  return out;
}

/** Distance from the start at every point. */
export function along(line: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1]! + metres(line[i - 1]!, line[i]!));
  return out;
}

/**
 * Climb and descent, ignoring wobbles under 3 m (map heights are noisy; counting every
 * centimetre would add up to climbs that aren't there).
 */
export function climb(elevation: number[]): { ascent_m: number; descent_m: number } {
  let up = 0;
  let down = 0;
  let ref = elevation[0];
  for (const e of elevation) {
    if (ref === undefined || !Number.isFinite(e)) continue;
    if (e - ref >= 3) {
      up += e - ref;
      ref = e;
    } else if (ref - e >= 3) {
      down += ref - e;
      ref = e;
    }
  }
  return { ascent_m: Math.round(up), descent_m: Math.round(down) };
}

/** Every `n`-th point and the last, so a long line draws small. */
export function thin(line: LngLat[], max = 80): LngLat[] {
  if (line.length <= max) return line;
  const step = (line.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => line[Math.round(i * step)]!);
}

const isLngLat = (p: unknown): p is LngLat =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0] as number) <= 180 && Math.abs(p[1] as number) <= 90;
const round = (p: LngLat): LngLat => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** A GPX 1.1 track (what the Suunto app, Strava and most watches import as a route). */
export function toGpx(r: Pick<Route, "name" | "segments" | "elevation">): string {
  const line = lineOf(r.segments);
  const ele = r.elevation?.length === line.length ? r.elevation : undefined;
  const pts = line.map((p, i) => `<trkpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}">${ele && Number.isFinite(ele[i]) ? `<ele>${ele[i]!.toFixed(1)}</ele>` : ""}</trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Tartan" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(r.name)}</name></metadata>
<trk><name>${esc(r.name)}</name><trkseg>
${pts.join("\n")}
</trkseg></trk>
</gpx>
`;
}

/** A route from a GPX file: its tracks (or route, or waypoints) as one line, heights kept. */
export function parseGpx(text: string): { name?: string; line: LngLat[]; elevation?: number[] } {
  const name = /<name>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/name>/i.exec(text)?.[1]?.trim();
  const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  for (const tag of ["trkpt", "rtept", "wpt"]) {
    const line: LngLat[] = [];
    const ele: number[] = [];
    const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, "gi");
    for (const m of text.matchAll(re)) {
      const lat = Number(/\blat\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1]);
      const lon = Number(/\blon\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1]);
      const last = line.at(-1);
      if (!isLngLat([lon, lat]) || (last && last[0] === lon && last[1] === lat)) continue;
      line.push([lon, lat]);
      ele.push(Number(/<ele>\s*([-\d.eE+]+)\s*<\/ele>/i.exec(m[2] ?? "")?.[1]));
    }
    if (line.length >= 2) return { name: name ? unesc(name) : undefined, line, elevation: ele.every(Number.isFinite) ? ele : undefined };
  }
  throw new Error("No track, route or points in this file.");
}

const validWatch = (w: unknown): w is NonNullable<Route["watch"]> =>
  !!w && typeof w === "object" && Number.isInteger((w as { id: unknown }).id) && typeof (w as { sent: unknown }).sent === "string" && typeof (w as { name: unknown }).name === "string";

export class Routes {
  constructor(private readonly disk: Disk) {}

  async get(id: string): Promise<Route | null> {
    if (!/^[\w-]{1,64}$/.test(id)) return null;
    const r = await readJson<Route & { deleted?: boolean }>(this.disk, `${DIR}/${id}.json`);
    return r && !r.deleted ? r : null;
  }

  async list(): Promise<RouteSummary[]> {
    const out: RouteSummary[] = [];
    for (const f of await this.disk.list(DIR)) {
      if (f.dir || !f.name.endsWith(".json")) continue;
      const r = await this.get(f.name.slice(0, -5));
      if (!r) continue;
      const line = lineOf(r.segments);
      out.push({
        id: r.id, name: r.name, updated: r.updated, distance_m: r.distance_m, ascent_m: r.ascent_m, descent_m: r.descent_m, source: r.source, watch: r.watch,
        preview: thin(line),
        loop: line.length > 2 && metres(line[0]!, line.at(-1)!) < 60,
      });
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** Check and save; distance and climb are worked out here, not trusted from the caller. */
  async save(input: RouteInput, now = new Date()): Promise<Route> {
    const name = String(input.name ?? "").trim().slice(0, 80) || "Route";
    if (!Array.isArray(input.waypoints) || input.waypoints.length < 1 || !input.waypoints.every(isLngLat)) throw new Error("A route needs at least one point.");
    if (!Array.isArray(input.segments) || input.segments.length !== input.waypoints.length - 1) throw new Error("Each pair of points needs a line between them.");
    const segments = input.segments.map((s) => {
      if (!Array.isArray(s?.coords) || s.coords.length < 2 || !s.coords.every(isLngLat)) throw new Error("A line between two points is broken.");
      return { mode: s.mode === "straight" ? ("straight" as const) : ("paths" as const), coords: s.coords.map(round) };
    });
    const line = lineOf(segments);
    if (line.length > MAX_POINTS) throw new Error("This route is too long to save.");
    const elevation = Array.isArray(input.elevation) && input.elevation.length === line.length && input.elevation.every((e) => Number.isFinite(e)) ? input.elevation.map((e) => Math.round(e * 10) / 10) : undefined;
    const prev = input.id ? await this.get(input.id) : null;
    const id = prev?.id ?? input.id?.replace(/[^\w-]/g, "").slice(0, 64) ?? "";
    const d = along(line);
    const r: Route = {
      id: id || `r${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      created: prev?.created ?? now.toISOString(),
      updated: now.toISOString(),
      waypoints: input.waypoints.map(round),
      segments,
      ...(elevation ? { elevation, ...climb(elevation) } : {}),
      distance_m: Math.round(d.at(-1) ?? 0),
      ...(input.source === "gpx" || prev?.source === "gpx" ? { source: "gpx" as const } : {}),
      // The copy on the watch stays recorded until a new one is sent (the line may have changed since).
      ...(validWatch(input.watch) ? { watch: input.watch } : prev?.watch ? { watch: prev.watch } : {}),
    };
    await this.disk.write(`${DIR}/${r.id}.json`, JSON.stringify(r));
    return r;
  }

  /** A GPX file as a route: one straight segment that follows the file's own points. */
  async importGpx(text: string, fallbackName = "Imported route"): Promise<Route> {
    const g = parseGpx(text);
    return this.save({ name: g.name || fallbackName, waypoints: [g.line[0]!, g.line.at(-1)!], segments: [{ mode: "straight", coords: g.line }], elevation: g.elevation, source: "gpx" });
  }

  /** Disks have no delete: an empty marker hides it everywhere. */
  async remove(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await this.disk.write(`${DIR}/${id}.json`, JSON.stringify({ id, deleted: true }));
    return true;
  }
}
