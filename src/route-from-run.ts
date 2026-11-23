/**
 * Routes from your own runs: "the loop I ran last Tuesday but 2 km longer", "my usual Sunday long
 * run route", "the river run from last week, reversed". A run is found by when (date words), its
 * name, its distance, or as your usual one (the line most other runs follow, from about the same
 * start); its GPS line becomes a route like one drawn in the editor (so it can go to the watch).
 * Longer: an out-and-back spur along paths from its farthest point. Shorter: a loop is cut across
 * around its farthest point along paths, a one-way run ends early. The distance is what it came to.
 */
import type { Get } from "./route-finder.ts";
import { routeFinder } from "./route-finder.ts";
import { offset } from "./route-loop.ts";
import { along, metres, thin, type LngLat, type RouteInput } from "./routes.ts";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dow = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/**
 * Date words as a range of days (inclusive, "YYYY-MM-DD"): today, yesterday, "3 days ago",
 * "last tuesday" or "tuesday" (the latest before today), "this week", "last week", "last weekend",
 * "this weekend", or a date. Null when it isn't one of these.
 */
export function whenRange(words: string, today: string): { from: string; to: string } | null {
  const w = words.trim().toLowerCase().replace(/[.,!?]/g, "").replace(/^on /, "").replace(/'s$/, "");
  const iso = /^(\d{4}-\d{2}-\d{2})$/.exec(w);
  if (iso) return { from: iso[1]!, to: iso[1]! };
  if (w === "today") return { from: today, to: today };
  if (w === "yesterday") return { from: addDays(today, -1), to: addDays(today, -1) };
  const ago = /^(\d+) days? ago$/.exec(w);
  if (ago) return { from: addDays(today, -Number(ago[1])), to: addDays(today, -Number(ago[1])) };
  const monday = addDays(today, -((dow(today) + 6) % 7));
  if (w === "this week") return { from: monday, to: today };
  if (w === "last week") return { from: addDays(monday, -7), to: addDays(monday, -1) };
  if (w === "this weekend") return { from: addDays(monday, 5), to: [addDays(monday, 6), today].sort()[0]! };
  // The weekend before this week's Monday.
  if (w === "last weekend") return { from: addDays(monday, -2), to: addDays(monday, -1) };
  const day = /^(?:last |this |past )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(w);
  if (day) {
    const want = WEEKDAYS.indexOf(day[1]!);
    // The latest such day before today ("this tuesday" when today is Tuesday: today).
    let back = (dow(today) - want + 7) % 7;
    if (back === 0 && !w.startsWith("this")) back = 7;
    const d = addDays(today, -back);
    return { from: d, to: d };
  }
  return null;
}

/** About `n` points spread evenly along the line by distance. */
export function resample(line: LngLat[], n: number): LngLat[] {
  if (line.length < 2) return line;
  const d = along(line);
  const total = d.at(-1)!;
  const out: LngLat[] = [];
  for (let k = 0, j = 0; k < n; k++) {
    const at = (total * k) / (n - 1);
    while (j < line.length - 2 && d[j + 1]! < at) j++;
    const span = d[j + 1]! - d[j]! || 1;
    const t = Math.min(1, Math.max(0, (at - d[j]!) / span));
    out.push([line[j]![0] + (line[j + 1]![0] - line[j]![0]) * t, line[j]![1] + (line[j + 1]![1] - line[j]![1]) * t]);
  }
  return out;
}

const lengthOf = (line: LngLat[]) => along(line).at(-1) ?? 0;

/** The same run, more or less: from about the same start, about as long, along the same ground (both ways). */
export function sameRoute(a: LngLat[], b: LngLat[]): boolean {
  if (a.length < 2 || b.length < 2 || metres(a[0]!, b[0]!) > 300) return false;
  const [la, lb] = [lengthOf(a), lengthOf(b)];
  if (Math.abs(la - lb) > 0.15 * Math.max(la, lb)) return false;
  const [x, y] = [resample(a, 40), resample(b, 40)];
  const off = (p: LngLat[], q: LngLat[]) => p.reduce((n, pt) => n + Math.min(...q.map((o) => metres(pt, o))), 0) / p.length;
  return off(x, y) < 200 && off(y, x) < 200;
}

/** Of these runs (newest first), the one most others follow, and how many follow it. */
export function usualOf<T extends { line: LngLat[] }>(runs: T[]): { run: T; repeats: number } | null {
  let best: { run: T; repeats: number } | null = null;
  for (const r of runs) {
    const n = runs.filter((o) => o !== r && sameRoute(r.line, o.line)).length + 1;
    if (!best || n > best.repeats) best = { run: r, repeats: n };
  }
  return best;
}

/** Which points of a GPS line to keep: at least `m` apart (and the last), at most about `max`. */
export function lighten(line: LngLat[], m = 8, max = 3000): number[] {
  const keep: number[] = [];
  for (let i = 0; i < line.length; i++) if (!keep.length || metres(line[keep.at(-1)!]!, line[i]!) >= m) keep.push(i);
  if (line.length && keep.at(-1) !== line.length - 1) keep.push(line.length - 1);
  return thin(keep.map((i) => [i, 0] as LngLat), max).map((p) => p[0]);
}

const isLoop = (line: LngLat[]) => line.length > 2 && metres(line[0]!, line.at(-1)!) < 300;
const farthest = (line: LngLat[]) => line.reduce((best, p, i) => (metres(line[0]!, p) > metres(line[0]!, line[best]!) ? i : best), 0);
const bearing = (a: LngLat, b: LngLat) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(r(b[0] - a[0])) * Math.cos(r(b[1]));
  const x = Math.cos(r(a[1])) * Math.sin(r(b[1])) - Math.sin(r(a[1])) * Math.cos(r(b[1])) * Math.cos(r(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

/** A line in pieces (each followed straight as recorded, or along paths), joined into a route's waypoints and segments. */
type Piece = { mode: "straight" | "paths"; coords: LngLat[] };
function asRoute(name: string, pieces: Piece[], elevation?: number[]): RouteInput {
  const segments = pieces.filter((p) => p.coords.length >= 2);
  return { name, waypoints: [segments[0]!.coords[0]!, ...segments.map((s) => s.coords.at(-1)!)], segments, ...(elevation ? { elevation } : {}) };
}

export interface Resized {
  pieces: Piece[];
  km: number;
  /** What was done, in words ("a 1 km out and back added at the far end"). */
  how: string;
}

/**
 * The line made `targetKm` long (within a few hundred metres when the paths allow): longer by an
 * out-and-back spur along paths from its farthest point; shorter by cutting a loop across along
 * paths around its farthest point, or ending a one-way line early. Throws when the paths can't be
 * reached or nothing comes near.
 */
export async function resize(line: LngLat[], targetKm: number, get: Get): Promise<Resized> {
  const finder = routeFinder(get);
  const d = along(line);
  const L = d.at(-1)!;
  const T = targetKm * 1000;
  const delta = T - L;
  const f = farthest(line);
  const km = (pieces: Piece[]) => Math.round(pieces.reduce((n, p) => n + lengthOf(p.coords), 0) / 10) / 100;
  if (delta > 0) {
    // A spur from the farthest point, heading on away from the start (or a little either side).
    const at = line[f]!;
    const away = f > 0 ? bearing(line[0]!, at) : 0;
    let best: { out: LngLat[]; got: number } | null = null;
    let reached = false;
    for (const b of [away, (away + 60) % 360, (away + 300) % 360]) {
      let reach = delta / 2 / 1.25;
      for (let t = 0; t < 3; t++) {
        const p = await finder.footpath(at, offset(at, b, reach));
        if (!p.line) break;
        reached = true;
        const got = 2 * lengthOf(p.line);
        if (!best || Math.abs(got - delta) < Math.abs(best.got - delta)) best = { out: p.line, got };
        if (Math.abs(got - delta) <= Math.max(150, 0.08 * delta)) break;
        reach *= delta / Math.max(1, got);
      }
      if (best && Math.abs(best.got - delta) <= Math.max(150, 0.08 * delta)) break;
    }
    if (!best) throw new Error(reached ? "No path leads on from the far end of that run to make it longer." : "The path finders couldn't be reached to make it longer: check the connection.");
    const pieces: Piece[] = [{ mode: "straight", coords: line.slice(0, f + 1) }, { mode: "paths", coords: best.out }, { mode: "paths", coords: [...best.out].reverse() }, { mode: "straight", coords: line.slice(f) }];
    return { pieces, km: km(pieces), how: `an out and back of ${Math.round(best.got / 100) / 10} km added at the far end` };
  }
  if (!isLoop(line)) {
    // One way: it ends early.
    const end = d.findIndex((x) => x >= T);
    const pieces: Piece[] = [{ mode: "straight", coords: line.slice(0, Math.max(2, end + 1)) }];
    return { pieces, km: km(pieces), how: "ended early" };
  }
  // A loop (or out and back): cut across around the farthest point.
  const cut = -delta;
  let x = cut / 2;
  let best: { pieces: Piece[]; km: number } | null = null;
  let reached = false;
  for (let t = 0; t < 4; t++) {
    x = Math.max(50, Math.min(x, d[f]! - 50, L - d[f]! - 50));
    const i = d.findIndex((v) => v >= d[f]! - x);
    const j = d.findIndex((v) => v >= d[f]! + x);
    if (i < 0 || j < 0 || j <= i) break;
    const p = await finder.footpath(line[i]!, line[j]!);
    if (!p.line) {
      if (p.reason === "unreachable") break;
      x *= 1.3;
      continue;
    }
    reached = true;
    const pieces: Piece[] = [{ mode: "straight", coords: line.slice(0, i + 1) }, { mode: "paths", coords: p.line }, { mode: "straight", coords: line.slice(j) }];
    const got = km(pieces);
    if (!best || Math.abs(got - targetKm) < Math.abs(best.km - targetKm)) best = { pieces, km: got };
    const err = got * 1000 - T;
    if (Math.abs(err) <= Math.max(150, 0.05 * T)) break;
    x += err / 2;
  }
  if (!best) throw new Error(reached ? "That run couldn't be cut shorter along paths." : "The path finders couldn't be reached to make it shorter: check the connection.");
  return { ...best, how: "cut across along paths near its far end" };
}

export interface RunTrack {
  id: string;
  start: string;
  name?: string;
  distance_km?: number;
  line: LngLat[];
  /** Heights per point of `line`, when the run had them. */
  elevation?: number[];
}

export interface FromRun {
  route: RouteInput;
  km: number;
  /** The run it came from. */
  run: { id: string; date: string; name?: string; km: number };
  how: string[];
}

const dayWords = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** A route from a run's line: as it was, reversed, made longer or shorter (along paths). */
export async function routeFromRun(run: RunTrack, o: { reverse?: boolean; km?: number; name?: string; get: Get }): Promise<FromRun> {
  const idx = lighten(run.line);
  let line = idx.map((i) => run.line[i]!);
  let elevation = run.elevation?.length === run.line.length ? idx.map((i) => run.elevation![i]!) : undefined;
  if (line.length < 2) throw new Error("That run has no GPS line to follow.");
  const how: string[] = [];
  if (o.reverse) {
    line = line.reverse();
    elevation = elevation?.reverse();
    how.push("reversed");
  }
  const runKm = Math.round(lengthOf(line) / 10) / 100;
  let pieces: Piece[] = [{ mode: "straight", coords: line }];
  let km = runKm;
  if (o.km && Math.abs(o.km - runKm) >= 0.2) {
    const r = await resize(line, Math.min(100, Math.max(1, o.km)), o.get);
    pieces = r.pieces;
    km = r.km;
    how.push(r.how);
    // The heights no longer match the line: the map's, when it answers.
    const all = pieces.flatMap((p, k) => (k ? p.coords.slice(1) : p.coords));
    elevation = (await routeFinder(o.get).heights(all)) ?? undefined;
  }
  const base = `${run.name?.trim() || "Run"}, ${dayWords(run.start)}`;
  const name = o.name?.trim() || [base, o.reverse ? "reversed" : "", km !== runKm ? `${Math.round(km * 10) / 10} km` : ""].filter(Boolean).join(", ");
  const route = asRoute(name.slice(0, 80), pieces, elevation);
  // Joined segments drop the points where they meet: heights only when they still line up.
  const joined = route.segments.reduce((n, s, k) => n + s.coords.length - (k ? 1 : 0), 0);
  if (route.elevation && route.elevation.length !== joined) delete route.elevation;
  return { route, km, run: { id: run.id, date: run.start.slice(0, 10), name: run.name, km: run.distance_km ?? runKm }, how };
}

/** Rows to look through for a run: what's asked, newest first. */
export function matchRuns<R extends { id: string; start: string; name?: string; distance_km?: number }>(
  rows: R[],
  ask: { when?: string; weekday?: string; name?: string; km?: number },
  today: string,
): { rows: R[]; problem?: string } {
  let out = [...rows].sort((a, b) => b.start.localeCompare(a.start));
  const local = (r: R) => new Date(r.start).toLocaleDateString("sv");
  if (ask.when?.trim()) {
    const range = whenRange(ask.when, today);
    if (!range) return { rows: [], problem: `"${ask.when}" isn't a day Tartan can read: say yesterday, last tuesday, last week or a date (YYYY-MM-DD).` };
    out = out.filter((r) => local(r) >= range.from && local(r) <= range.to);
  }
  if (ask.weekday) {
    const want = WEEKDAYS.findIndex((d) => d.startsWith(ask.weekday!.toLowerCase().slice(0, 3)));
    out = out.filter((r) => new Date(r.start).getDay() === want);
  }
  if (ask.name?.trim()) {
    const words = ask.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    out = out.filter((r) => words.every((w) => (r.name ?? "").toLowerCase().includes(w)));
  }
  if (ask.km) out = out.filter((r) => r.distance_km && Math.abs(r.distance_km - ask.km!) <= Math.max(1, 0.2 * ask.km!));
  return { rows: out };
}
