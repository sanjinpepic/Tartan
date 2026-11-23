/**
 * A route as the Suunto Run 2 stores it: an SBEM file written to /Settings/Navigation/Route/Data,
 * then a record for /Settings/Navigation/Route (route-send.ts). Recovered from the HCI capture of
 * 16 Oct 2026, where the Suunto app sent a 7 km route; the watch describes the format itself in
 * /DataFormat/Descriptors (id 2):
 *
 *   1 CompressedRoutePoints uint32      (0)
 *   2 Points                int32       (0)
 *   then per point, in order:
 *   3 Altitude              int32, metres; 2147483647 = unknown (a new point starts here)
 *   4 Latitude              float32
 *   5 Longitude             float32
 *   6 Name                  utf8, NUL-terminated: "" for a placed waypoint, "none" between,
 *                           or the turn ("Left", "Slight right", "Right at fork"…)
 *   7 RelativeDistance      float32, 0 at the start to 1 at the end
 *   8 Type                  uint8: 100 a waypoint, 255 nothing, 48–55 turns (below)
 *
 * Each value is an SBEM chunk: id u8, length u8, bytes. The file starts "SBEM0102".
 */
import { metres, type LngLat } from "../routes.ts";

export const ROUTE_DESCRIPTOR_ID = 2;
/** The fields the watch must describe (in this order) before Tartan writes a route. */
export const ROUTE_FIELDS = [
  "CompressedRoutePoints",
  "Points",
  "RoutePoints+point.Altitude",
  "RoutePoints.point.Latitude",
  "RoutePoints.point.Longitude",
  "RoutePoints.point.Name",
  "RoutePoints.point.RelativeDistance",
  "RoutePoints.point.Type",
] as const;

export const POINT_TYPE = { waypoint: 100, none: 255, left: 48, right: 49, sharpLeft: 50, sharpRight: 51, slightLeft: 52, slightRight: 53, leftAtFork: 54, rightAtFork: 55 } as const;
const NO_ALTITUDE = 2147483647;

export interface WatchRoutePoint {
  lat: number;
  lon: number;
  /** Metres; undefined when unknown. */
  alt?: number;
  /** "" for a waypoint, "none" otherwise (or a turn instruction). */
  name: string;
  /** 0 → 1 along the route. */
  rd: number;
  type: number;
}

const enc = new TextEncoder();

/** The SBEM route file. */
export function routeFile(points: WatchRoutePoint[]): Uint8Array {
  const parts: number[] = [..."SBEM0102"].map((c) => c.charCodeAt(0));
  const chunk = (id: number, bytes: Uint8Array) => {
    if (bytes.length > 254) throw new Error("route field too long");
    parts.push(id, bytes.length, ...bytes);
  };
  const u32 = (v: number) => new Uint8Array(new Uint32Array([v >>> 0]).buffer);
  const i32 = (v: number) => new Uint8Array(new Int32Array([v | 0]).buffer);
  const f32 = (v: number) => new Uint8Array(new Float32Array([v]).buffer);
  chunk(1, u32(0));
  chunk(2, i32(0));
  for (const p of points) {
    chunk(3, i32(p.alt === undefined || !Number.isFinite(p.alt) ? NO_ALTITUDE : Math.round(p.alt)));
    chunk(4, f32(p.lat));
    chunk(5, f32(p.lon));
    chunk(6, enc.encode(`${p.name.slice(0, 60)}\0`));
    chunk(7, f32(p.rd));
    chunk(8, Uint8Array.of(p.type & 0xff));
  }
  return Uint8Array.from(parts);
}

const TURN_NAME: Record<number, string> = {
  [POINT_TYPE.left]: "Left", [POINT_TYPE.right]: "Right", [POINT_TYPE.sharpLeft]: "Sharp left", [POINT_TYPE.sharpRight]: "Sharp right",
  [POINT_TYPE.slightLeft]: "Slight left", [POINT_TYPE.slightRight]: "Slight right",
};

/**
 * Where the route turns, from its own shape (no routing service needed, so drawn and saved
 * routes get them too): the heading over ~25 m before and after each point, corners where it
 * changes by 30° or more, the sharpest point of each corner, at least 60 m apart and not in the
 * first or last 40 m. Slight under 50°, sharp over 130°, and a near reversal is a turn-around.
 */
export function findTurns(line: LngLat[], d: number[]): Map<number, { type: number; name: string }> {
  const total = d.at(-1) ?? 0;
  const at = (i: number, by: number) => {
    // The point `by` metres along from i (negative: back), as an index on the line.
    let j = i;
    if (by < 0) while (j > 0 && d[i]! - d[j]! < -by) j--;
    else while (j < line.length - 1 && d[j]! - d[i]! < by) j++;
    return j;
  };
  const heading = (a: LngLat, b: LngLat) => {
    const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
    return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI;
  };
  const corners: Array<{ i: number; angle: number }> = [];
  for (let i = 1; i < line.length - 1; i++) {
    if (d[i]! < 40 || total - d[i]! < 40) continue;
    const a = at(i, -25);
    const b = at(i, 25);
    if (a === i || b === i) continue;
    const turn = ((heading(line[i]!, line[b]!) - heading(line[a]!, line[i]!) + 540) % 360) - 180;
    if (Math.abs(turn) >= 30) corners.push({ i, angle: turn });
  }
  // One point per corner (the sharpest of a run within 20 m), then at least 60 m apart.
  const picked: Array<{ i: number; angle: number }> = [];
  for (const c of corners) {
    const prev = picked.at(-1);
    if (prev && d[c.i]! - d[prev.i]! < 20) {
      if (Math.abs(c.angle) > Math.abs(prev.angle)) picked[picked.length - 1] = c;
    } else picked.push(c);
  }
  const spaced: typeof picked = [];
  for (const c of picked) {
    const prev = spaced.at(-1);
    if (prev && d[c.i]! - d[prev.i]! < 60) {
      if (Math.abs(c.angle) > Math.abs(prev.angle)) spaced[spaced.length - 1] = c;
    } else spaced.push(c);
  }
  const out = new Map<number, { type: number; name: string }>();
  for (const { i, angle } of spaced) {
    const a = Math.abs(angle);
    const right = angle > 0;
    const type = a > 130 ? (right ? POINT_TYPE.sharpRight : POINT_TYPE.sharpLeft) : a < 50 ? (right ? POINT_TYPE.slightRight : POINT_TYPE.slightLeft) : right ? POINT_TYPE.right : POINT_TYPE.left;
    out.set(i, { type, name: a > 165 ? "Turn around" : TURN_NAME[type]! });
  }
  return out;
}

/**
 * The points for the watch from a drawn line: points closer than `minGap` metres to the last kept
 * one are dropped (the watch needs shape, not every routing vertex), at most `max` are kept,
 * and the placed waypoints are marked so the watch shows them.
 */
export function watchPoints(
  line: LngLat[],
  opts: { elevation?: number[]; waypoints?: LngLat[]; named?: Array<{ point: LngLat; name: string }>; minGap?: number; max?: number; turns?: boolean } = {},
): { points: WatchRoutePoint[]; distance_m: number } {
  if (line.length < 2) throw new Error("A route needs at least two points.");
  const minGap = opts.minGap ?? 8;
  const d = [0];
  for (let i = 1; i < line.length; i++) d.push(d[i - 1]! + metres(line[i - 1]!, line[i]!));
  const total = d.at(-1)!;
  // Which line points are waypoints (the closest point to each placed one).
  const marks = new Set<number>([0]);
  // Named waypoints (race splits: "5k 24:10"); the Suunto app's own are unnamed ("").
  const names = new Map<number, string>();
  for (const w of opts.named ?? []) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < line.length; i++) {
      const m = metres(w.point, line[i]!);
      if (m < bestD) [best, bestD] = [i, m];
    }
    if (bestD < 30) {
      marks.add(best);
      names.set(best, w.name.replace(/[^\x20-\x7e]/g, "").slice(0, 20));
    }
  }
  for (const w of opts.waypoints ?? []) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < line.length; i++) {
      const m = metres(w, line[i]!);
      if (m < bestD) [best, bestD] = [i, m];
    }
    if (bestD < 30) marks.add(best);
  }
  // Turn prompts where the route turns ("Left", "Sharp right"); a placed waypoint wins where both are.
  const turns = opts.turns === false ? new Map<number, { type: number; name: string }>() : findTurns(line, d);
  for (const i of marks) turns.delete(i);
  let keep: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < line.length; i++) {
    if (i === 0 || i === line.length - 1 || marks.has(i) || turns.has(i) || d[i]! - last >= minGap) {
      keep.push(i);
      last = d[i]!;
    }
  }
  const max = opts.max ?? 1500;
  if (keep.length > max) {
    const step = (keep.length - 1) / (max - 1);
    const thin = new Set(Array.from({ length: max }, (_, k) => keep[Math.round(k * step)]!));
    for (const i of keep) if (marks.has(i) || turns.has(i)) thin.add(i);
    keep = [...thin].sort((a, b) => a - b);
  }
  const ele = opts.elevation?.length === line.length ? opts.elevation : undefined;
  const points = keep.map((i) => ({
    lat: line[i]![1],
    lon: line[i]![0],
    alt: ele?.[i],
    name: marks.has(i) && i !== line.length - 1 ? (names.get(i) ?? "") : (turns.get(i)?.name ?? "none"),
    rd: total ? d[i]! / total : 0,
    type: marks.has(i) && i !== line.length - 1 ? POINT_TYPE.waypoint : (turns.get(i)?.type ?? POINT_TYPE.none),
  }));
  return { points, distance_m: Math.round(total) };
}
