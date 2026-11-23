/**
 * Race-day pacing for a course: even effort over the hills for a target time. The course is
 * cut into 50 m pieces; each piece's gradient sets its cost (Minetti et al. 2002, the energy cost
 * of running on a slope), with only half the downhill saving counted (few runners bank it all);
 * the target time is shared out in proportion to cost. Then: a split per kilometre, the line
 * with a point at every kilometre (named for the watch: "5k 24:10"), and a pacing workout.
 */
import { metres, type LngLat } from "./routes.ts";
import type { Workout, WorkoutStep } from "./workout/guide.ts";

/** Energy cost of running, J/kg/m, at gradient g (rise over run), within ±0.45. */
export function minetti(g: number): number {
  const i = Math.max(-0.45, Math.min(0.45, g));
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}
/** How much harder a piece is than the flat: uphill in full, downhill half the saving, at least 0.8. */
export function effort(g: number): number {
  const f = minetti(g) / 3.6;
  return f >= 1 ? f : Math.max(0.8, 1 - (1 - f) / 2);
}

export interface Split {
  km: number;
  /** This split's length (the last one may be short). */
  distance_m: number;
  time_s: number;
  /** Seconds per km over this split. */
  pace_s: number;
  /** Race time at its end. */
  cumulative_s: number;
  climb_m: number;
  descent_m: number;
}

export const clock = (s: number) => {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** "1:45:00", "45:30" or "52" (minutes) → seconds; null when it isn't a time. */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(":").map((x) => Number(x));
  if (!parts.length || parts.some((x) => !Number.isFinite(x) || x < 0)) return null;
  const s = parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : parts.length === 2 ? parts[0]! * 60 + parts[1]! : parts[0]! * 60;
  return s > 0 ? s : null;
}

/** Even-effort splits for `target_s` over the line (heights per point when known, else flat). */
export function raceSplits(line: LngLat[], elevation: number[] | null, target_s: number): { splits: Split[]; marks: Array<{ point: LngLat; name: string }>; line: LngLat[] } {
  if (line.length < 2) throw new Error("A course needs at least two points.");
  // Distance along the line, and the height at any distance.
  const d = [0];
  for (let i = 1; i < line.length; i++) d.push(d[i - 1]! + metres(line[i - 1]!, line[i]!));
  const total = d.at(-1)!;
  if (total < 200) throw new Error("The course is too short to pace.");
  const ele = elevation?.length === line.length ? elevation : null;
  let seg = 0;
  const at = (x: number): { p: LngLat; h: number } => {
    while (seg < d.length - 2 && d[seg + 1]! < x) seg++;
    while (seg > 0 && d[seg]! > x) seg--;
    const t = d[seg + 1]! > d[seg]! ? (x - d[seg]!) / (d[seg + 1]! - d[seg]!) : 0;
    const a = line[seg]!;
    const b = line[seg + 1]!;
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], h: ele ? ele[seg]! + (ele[seg + 1]! - ele[seg]!) * t : 0 };
  };
  // 50 m pieces: their effort, and which kilometre they're in.
  const STEP = 50;
  const pieces: Array<{ from: number; len: number; rise: number; cost: number }> = [];
  for (let x = 0; x < total; x += STEP) {
    const len = Math.min(STEP, total - x);
    const rise = at(x + len).h - at(x).h;
    pieces.push({ from: x, len, rise, cost: len * effort(rise / len) });
  }
  const perCost = target_s / pieces.reduce((n, p) => n + p.cost, 0);
  const splits: Split[] = [];
  let cumulative = 0;
  for (let k = 0; k * 1000 < total; k++) {
    const mine = pieces.filter((p) => p.from >= k * 1000 && p.from < (k + 1) * 1000);
    const distance_m = Math.min(1000, total - k * 1000);
    const time_s = mine.reduce((n, p) => n + p.cost * perCost, 0);
    cumulative += time_s;
    splits.push({
      km: k + 1,
      distance_m: Math.round(distance_m),
      time_s,
      pace_s: time_s / (distance_m / 1000),
      cumulative_s: cumulative,
      climb_m: Math.round(mine.reduce((n, p) => n + Math.max(0, p.rise), 0)),
      descent_m: Math.round(mine.reduce((n, p) => n + Math.max(0, -p.rise), 0)),
    });
  }
  // A point on the line at every whole kilometre, named for the watch.
  const out: LngLat[] = [];
  const marks: Array<{ point: LngLat; name: string }> = [];
  let next = 1000;
  for (let i = 0; i < line.length; i++) {
    while (next < total - 100 && i > 0 && d[i]! >= next) {
      const p = at(next).p.map((v) => Math.round(v * 1e6) / 1e6) as LngLat;
      out.push(p);
      const split = splits[next / 1000 - 1]!;
      marks.push({ point: p, name: `${next / 1000}k ${clock(split.cumulative_s)}` });
      next += 1000;
    }
    out.push(line[i]!);
  }
  return { splits, marks, line: out };
}

/**
 * The pacing workout: a step per kilometre (two per step past 55 km) at its pace, ±5 s.
 * Its last step runs to the finish.
 */
export function pacingWorkout(name: string, splits: Split[]): Workout {
  const per = splits.length > 55 ? 2 : 1;
  const blocks: WorkoutStep[] = [];
  for (let i = 0; i < splits.length; i += per) {
    const group = splits.slice(i, i + per);
    const distance_m = group.reduce((n, s) => n + s.distance_m, 0);
    const pace = group.reduce((n, s) => n + s.time_s, 0) / (distance_m / 1000);
    if (distance_m < 50) continue;
    blocks.push({ kind: "run", distance_m, pace: [Math.round(pace) - 5, Math.round(pace) + 5], title: `Km ${group[0]!.km}${per > 1 ? `-${group.at(-1)!.km}` : ""}` });
  }
  return { name, blocks };
}
