/**
 * Moments on a finished run: a few pointers tied to a stretch of the route, as a coach who watched
 * it would give them ("the climb at 3.1 km took your heart rate to 172"). One thing done well and
 * at most two to work on; none is the usual answer for a steady easy run.
 *
 * Every moment is found by rules from the recording alone (time, distance, heart rate, altitude,
 * the route) against the session it filled; nothing comes from a language model. Each carries its
 * stretch (metres along the run and sample indexes), a pin (the stretch's midpoint), its facts with
 * their numbers, and one line in the coach's voice that says only what is in the facts. The cloud
 * coach may reword them; it may not add any.
 *
 * What counts, by the session (a run that filled no planned session is judged as easy):
 *
 *   easy, long, recovery
 *     hill_hr        work on  a climb (20 m and 3% or more) took the heart rate 8 or more over the
 *                            top of easy for 45 s or longer, while the flat stayed easy.
 *     fast_start     work on  the first 1 km (2 km on runs of 8 km or more) 4% and 12 s/km quicker
 *                            than the rest, or heart rate 5 higher, not explained by the slope.
 *     fade           work on  long runs (planned long and an hour or more, or 70 min or more): the
 *                            last third 5% and 15 s/km slower than before it (after a 10-minute
 *                            warm-up), not uphill.
 *     decoupling     work on  the same, by heart rate: 5% or more less speed per beat in the last third.
 *     hill_steady    good     the biggest climb (25 m and 4% or more) stayed inside easy, with the pace
 *                            eased 5% or more: effort, not pace.
 *     held_long      good     long runs (planned long and an hour or more, or 90 min or more): the
 *                            last third within 3% of the pace before it, heart rate drift under 3%.
 *   tempo, intervals, hills (the planned steps laid over the recording, src/workout/review.ts)
 *     rep_slow       work on  a rep 5 s/km or more slower than its range.
 *     rep_fast       work on  a rep 8 s/km or more quicker than its range (over-cooked).
 *     rep_high       work on  a heart-rate rep 5 bpm or more over its range.
 *     reps_on_target good     every rep on target (3 reps or more, or 10 minutes of work or more).
 *   race: fast_start and strong_finish.
 *   any but tempo, intervals and hills
 *     strong_finish  good     the last km the fastest whole km, 3% and 8 s/km quicker than the usual
 *                            km, at a controlled heart rate (easy days: no more than 10 over easy;
 *                            else under 92% of max).
 *     downhill_easing work on a gentle downhill (15 m or more, 2-6%, nowhere steeper than 8%, not a
 *                            trail run) run 5% and 15 s/km slower than the flat (8% without heart
 *                            rate; with it, heart rate 3 lower too): free speed left.
 *
 * No data, no claim: without heart rate (80% of the moving time) nothing is said about effort;
 * hill and downhill moments need altitude that can be trusted: not the phone's or Health Connect's
 * GPS altitude, covering 90% of the samples, and smooth (on a 10 m grid, less than 1.5 m RMS from
 * its own 100 m average). Runs under 2 km or 15 minutes get none.
 */
import { readJson, type Disk } from "./disk.ts";
import type { SessionReview, StepReview } from "./workout/review.ts";

export type MomentId =
  | "hill_hr"
  | "hill_steady"
  | "fast_start"
  | "fade"
  | "decoupling"
  | "held_long"
  | "strong_finish"
  | "downhill_easing"
  | "rep_slow"
  | "rep_fast"
  | "rep_high"
  | "reps_on_target";

export interface Moment {
  kind: "good" | "work_on";
  /** Which rule found it. */
  id: MomentId;
  /** Where, in a few words: "the climb at 3.1 km", "rep 5/6", "the first 2 km". */
  where: string;
  /** The stretch, in metres from the start of the run. */
  from_m: number;
  to_m: number;
  /** The stretch as sample indexes (inclusive) into the streams it came with. */
  from_i: number;
  to_i: number;
  /** The pin: [lat, lon] at the stretch's midpoint (as the latlng stream), when the run has a route. */
  at?: [number, number];
  /** What was found, with its numbers: every number in `text` is one of these. */
  facts: Record<string, number | string>;
  /** One plain line in the coach's voice. */
  text: string;
}

export interface MomentColumns {
  time?: unknown[];
  distance?: unknown[];
  heartrate?: unknown[];
  altitude?: unknown[];
  latlng?: unknown[];
}

export interface MomentContext {
  /** The planned session's kind it filled; none: judged as easy. */
  kind?: string;
  /** Where the streams came from (src/merge.ts Source): the phone's and Health Connect's altitude is GPS. */
  source?: string;
  sport?: string;
  /** The top of easy (zone 2), bpm. */
  easy_max?: number | null;
  max_hr?: number | null;
  /** The planned steps laid over the same columns (paced sessions). */
  review?: SessionReview | null;
}

/** Bump when the rules change: kept moments are worked out again. */
export const MOMENTS_VERSION = 1;
const STEADY = new Set(["easy", "long", "recovery"]);
const PACED = new Set(["tempo", "intervals", "hills"]);
/** Altitude from these is the GPS's: too rough for hills. */
const GPS_ALTITUDE = new Set(["phone", "health"]);
const GRID = 10;

const mmss = (s: number) => {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const one = (x: number) => Math.round(x * 10) / 10;
const km = (m: number) => one(m / 1000);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The run as kept samples: monotonic distance, moving time, smoothed heart rate. */
interface Track {
  /** Kept sample → index in the columns. */
  idx: number[];
  t: number[];
  d: number[];
  /** Moving seconds up to each sample (pauses and stops left out). */
  mt: number[];
  hr: Array<number | null>;
  /** Heart rate averaged over 30 s, centred. */
  hrs: Array<number | null>;
  ll: Array<[number, number] | null>;
  hasHr: boolean;
}

/**
 * A column with its gaps filled from the nearest value within 5 s: some recordings (the watch's
 * own) put heart rate or altitude on rows of their own, between the rows with distance.
 */
export function nearby(col: unknown[] | undefined, time: unknown[]): Array<number | null> {
  const out: Array<number | null> = [];
  if (!col) return out;
  const n = Math.min(col.length, time.length);
  for (let k = 0; k < n; k++) out.push(num(col[k]));
  if (out.every((v) => v !== null)) return out;
  const near: Array<[number, number] | null> = out.map((v, k) => (v !== null ? [v, 0] : null));
  const pass = (from: number, to: number, dir: 1 | -1) => {
    let last: { v: number; t: number } | null = null;
    for (let k = from; k !== to; k += dir) {
      const t = num(time[k]);
      if (out[k] !== null && t !== null) last = { v: out[k]!, t };
      else if (last && t !== null) {
        const gap = Math.abs(t - last.t);
        if (gap <= 5 && (!near[k] || gap < near[k]![1])) near[k] = [last.v, gap];
      }
    }
  };
  pass(0, n, 1);
  pass(n - 1, -1, -1);
  return near.map((x) => x?.[0] ?? null);
}

function track(c: MomentColumns): Track | null {
  const time = c.time ?? [];
  const dist = c.distance ?? [];
  const n = Math.min(time.length, dist.length);
  const heart = nearby(c.heartrate, time);
  const tr: Track = { idx: [], t: [], d: [], mt: [], hr: [], hrs: [], ll: [], hasHr: false };
  for (let k = 0; k < n; k++) {
    const t = num(time[k]);
    const d = num(dist[k]);
    if (t === null || d === null) continue;
    if (tr.t.length && (t < tr.t.at(-1)! || d < tr.d.at(-1)!)) continue;
    const h = heart[k] ?? null;
    const p = c.latlng?.[k];
    tr.idx.push(k);
    tr.t.push(t);
    tr.d.push(d);
    tr.hr.push(h !== null && h >= 30 && h <= 230 ? h : null);
    tr.ll.push(Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null ? [p[0] as number, p[1] as number] : null);
  }
  const N = tr.t.length;
  if (N < 30) return null;
  let moving = 0;
  let withHr = 0;
  tr.mt.push(0);
  for (let k = 1; k < N; k++) {
    const dt = tr.t[k]! - tr.t[k - 1]!;
    const go = dt > 0 && dt <= 30 && (tr.d[k]! - tr.d[k - 1]!) / dt >= 0.5;
    moving += go ? dt : 0;
    if (go && tr.hr[k] !== null) withHr += dt;
    tr.mt.push(moving);
  }
  tr.hasHr = moving > 0 && withHr / moving >= 0.8;
  // 30-second centred average: single-sample spikes don't make a peak.
  let a = 0;
  let b = 0;
  let sum = 0;
  let cnt = 0;
  for (let k = 0; k < N; k++) {
    while (b < N && tr.t[b]! <= tr.t[k]! + 15) {
      if (tr.hr[b] !== null) (sum += tr.hr[b]!), cnt++;
      b++;
    }
    while (tr.t[a]! < tr.t[k]! - 15) {
      if (tr.hr[a] !== null) (sum -= tr.hr[a]!), cnt--;
      a++;
    }
    tr.hrs.push(cnt ? sum / cnt : null);
  }
  return tr;
}

/** The first kept sample at or past `m` metres along. */
function at(tr: Track, m: number): number {
  let lo = 0;
  let hi = tr.d.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tr.d[mid]! < m) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first kept sample at or past moving second `s`. */
function atMoving(tr: Track, s: number): number {
  const k = tr.mt.findIndex((x) => x >= s);
  return k < 0 ? tr.mt.length - 1 : k;
}

interface Stretch {
  metres: number;
  seconds: number;
  /** s/km over moving time. */
  pace: number | null;
  hr: number | null;
  peak: number | null;
}

function stretch(tr: Track, a: number, b: number): Stretch {
  const metres = tr.d[b]! - tr.d[a]!;
  const seconds = tr.mt[b]! - tr.mt[a]!;
  let sum = 0;
  let w = 0;
  let peak: number | null = null;
  for (let k = a; k <= b; k++) {
    const s = tr.hrs[k];
    if (s != null && (peak === null || s > peak)) peak = s;
    if (k > a) {
      const dt = tr.mt[k]! - tr.mt[k - 1]!;
      if (dt > 0 && tr.hr[k] !== null) (sum += tr.hr[k]! * dt), (w += dt);
    }
  }
  return { metres, seconds, pace: metres >= 100 && seconds > 0 ? seconds / (metres / 1000) : null, hr: w >= 0.6 * seconds && w > 0 ? sum / w : null, peak };
}

/** Altitude on a 10 m grid, smoothed; null when it can't be trusted for hills. */
interface Terrain {
  d0: number;
  alt: number[];
}

function terrainOf(tr: Track | null, altitude: unknown[] | undefined, time: unknown[], source?: string): Terrain | null {
  if (!tr || !altitude || (source && GPS_ALTITUDE.has(source))) return null;
  const filled = nearby(altitude, time);
  const ds: number[] = [];
  const as: number[] = [];
  for (let k = 0; k < tr.idx.length; k++) {
    const v = filled[tr.idx[k]!] ?? null;
    if (v === null || v < -500 || v > 9000) continue;
    if (ds.length && tr.d[k]! <= ds.at(-1)!) continue;
    ds.push(tr.d[k]!);
    as.push(v);
  }
  if (as.length < 0.9 * tr.idx.length || as.length < 30) return null;
  const d0 = tr.d[0]!;
  const total = tr.d.at(-1)! - d0;
  const raw: number[] = [];
  let j = 0;
  for (let g = 0; g * GRID <= total; g++) {
    const x = d0 + g * GRID;
    while (j < ds.length - 2 && ds[j + 1]! < x) j++;
    const [xa, xb, ya, yb] = [ds[j]!, ds[j + 1] ?? ds[j]!, as[j]!, as[j + 1] ?? as[j]!];
    raw.push(x <= xa || xb === xa ? ya : x >= xb ? yb : ya + ((yb - ya) * (x - xa)) / (xb - xa));
  }
  if (raw.length < 20) return null;
  const s1 = average(raw, 5);
  const rms = Math.sqrt(raw.reduce((n, v, i) => n + (v - s1[i]!) ** 2, 0) / raw.length);
  if (rms > 1.5) return null;
  return { d0, alt: average(s1, 5) };
}

/** A centred moving average over ±h points. */
function average(xs: number[], h: number): number[] {
  const pre = [0];
  for (const x of xs) pre.push(pre.at(-1)! + x);
  return xs.map((_, i) => {
    const a = Math.max(0, i - h);
    const b = Math.min(xs.length - 1, i + h);
    return (pre[b + 1]! - pre[a]!) / (b - a + 1);
  });
}

interface Hill {
  /** Grid points. */
  a: number;
  b: number;
  /** Metres up (or down, for a descent). */
  gain: number;
  grade: number;
  /** The steepest 50 m, in percent. */
  steepest: number;
}

/** Climbs (sign 1) or descents (-1) of `min` metres or more, ended by a 3 m turn the other way. */
function hills(t: Terrain, sign: 1 | -1, min: number): Hill[] {
  const y = t.alt.map((v) => v * sign);
  const out: Hill[] = [];
  let lo = 0;
  let hi = 0;
  const close = () => {
    if (y[hi]! - y[lo]! < min) return;
    // Trim the flat at either end: from the last point near the bottom to the first near the top.
    let a = hi;
    while (a > lo && y[a - 1]! > y[lo]! + 1) a--;
    a = Math.max(lo, a - 1);
    let b = a;
    while (b < hi && y[b]! < y[hi]! - 1) b++;
    const gain = y[hi]! - y[lo]!;
    if (b <= a) return;
    let steepest = 0;
    for (let i = a; i + 5 <= b; i++) steepest = Math.max(steepest, ((y[i + 5]! - y[i]!) / (5 * GRID)) * 100);
    out.push({ a, b, gain, grade: (gain / ((b - a) * GRID)) * 100, steepest });
  };
  for (let i = 1; i < y.length; i++) {
    if (y[hi]! - y[i]! >= 3) {
      close();
      lo = hi = i;
    } else if (y[i]! < y[lo]!) lo = hi = i;
    else if (y[i]! > y[hi]!) hi = i;
  }
  close();
  return out;
}

/** Net grade of a stretch between kept samples, percent. */
function netGrade(tr: Track, t: Terrain, a: number, b: number): number {
  const g = (k: number) => t.alt[Math.min(t.alt.length - 1, Math.max(0, Math.round((tr.d[k]! - t.d0) / GRID)))]!;
  const m = tr.d[b]! - tr.d[a]!;
  return m > 0 ? ((g(b) - g(a)) / m) * 100 : 0;
}

interface Candidate extends Moment {
  score: number;
}

const decouple = (e: Stretch, l: Stretch) => (e.pace && l.pace && e.hr && l.hr ? ((1000 / e.pace / e.hr - 1000 / l.pace / l.hr) / (1000 / e.pace / e.hr)) * 100 : null);

/** The moments of one run: at most one good and two to work on, in order along the route. */
export function runMoments(c: MomentColumns, ctx: MomentContext = {}): Moment[] {
  const tr = track(c);
  if (!tr) return [];
  const N = tr.d.length;
  const D = tr.d[N - 1]! - tr.d[0]!;
  const T = tr.mt[N - 1]!;
  if (D < 2000 || T < 15 * 60) return [];
  const kind = ctx.kind && (STEADY.has(ctx.kind) || PACED.has(ctx.kind) || ctx.kind === "race") ? ctx.kind : "easy";
  const steady = STEADY.has(kind);
  const easyMax = ctx.easy_max && ctx.easy_max > 60 ? Math.round(ctx.easy_max) : null;
  const terrain = terrainOf(tr, c.altitude, c.time ?? [], ctx.source);
  const hr = tr.hasHr;
  const out: Candidate[] = [];
  const along = (m: number) => tr.d[0]! + m;
  const make = (kindOf: Moment["kind"], id: MomentId, a: number, b: number, where: string, facts: Moment["facts"], text: string, score: number): Candidate => {
    const mid = at(tr, (tr.d[a]! + tr.d[b]!) / 2);
    let pin: [number, number] | null = null;
    for (let r = 0; r < N && !pin; r++) pin = tr.ll[mid + r] ?? tr.ll[mid - r] ?? null;
    return {
      kind: kindOf,
      id,
      where,
      from_m: Math.round(tr.d[a]! - tr.d[0]!),
      to_m: Math.round(tr.d[b]! - tr.d[0]!),
      from_i: tr.idx[a]!,
      to_i: tr.idx[b]!,
      ...(pin ? { at: [Math.round(pin[0] * 1e6) / 1e6, Math.round(pin[1] * 1e6) / 1e6] as [number, number] } : {}),
      facts,
      text,
      score,
    };
  };
  const runWord = kind === "long" ? "a long run" : kind === "recovery" ? "a recovery run" : "an easy run";

  // ---- Hills on easy days: the effort, not the pace.
  if (steady && terrain) {
    const climbs = hills(terrain, 1, 20).filter((h) => h.grade >= 3 && (h.b - h.a) * GRID >= 200);
    const span = (h: Hill) => [at(tr, terrain.d0 + h.a * GRID), at(tr, terrain.d0 + h.b * GRID)] as const;
    if (hr && easyMax && climbs.length) {
      // The flat: everything but the climbs and the minute after each, past the first 10 minutes.
      const skip = new Uint8Array(N);
      for (const h of climbs) {
        const [a, b] = span(h);
        const until = tr.t[b]! + 60;
        for (let k = a; k < N && (k <= b || tr.t[k]! <= until); k++) skip[k] = 1;
      }
      let sum = 0;
      let w = 0;
      let fm = 0;
      let fs = 0;
      const warm = atMoving(tr, 600);
      for (let k = Math.max(1, warm); k < N; k++) {
        const dt = tr.mt[k]! - tr.mt[k - 1]!;
        if (skip[k] || !(dt > 0)) continue;
        fm += tr.d[k]! - tr.d[k - 1]!;
        fs += dt;
        if (tr.hr[k] !== null) (sum += tr.hr[k]! * dt), (w += dt);
      }
      const flatHr = w ? sum / w : null;
      const flatPace = fm >= 1000 ? fs / (fm / 1000) : null;
      const looked = climbs.map((h) => {
        const [a, b] = span(h);
        let b2 = b;
        while (b2 < N - 1 && tr.t[b2 + 1]! <= tr.t[b]! + 30) b2++;
        const s = stretch(tr, a, b2);
        let above = 0;
        for (let k = a + 1; k <= b2; k++) if ((tr.hrs[k] ?? 0) > easyMax) above += tr.mt[k]! - tr.mt[k - 1]!;
        return { h, a, b, peak: s.peak ?? 0, above, pace: stretch(tr, a, b).pace };
      });
      const over = looked.filter((x) => x.peak >= easyMax + 8 && x.above >= 45).sort((x, y) => y.peak - x.peak || y.h.gain - x.h.gain)[0];
      if (over && flatHr !== null && flatHr <= easyMax) {
        const facts = { at_km: km(tr.d[over.a]! - tr.d[0]!), climb_m: Math.round(over.h.gain), grade_pct: Math.round(over.h.grade), hr_peak: Math.round(over.peak), easy_max: easyMax, flat_hr: Math.round(flatHr) };
        out.push(
          make("work_on", "hill_hr", over.a, over.b, `the climb at ${facts.at_km} km`, facts, `The climb at ${facts.at_km} km took your heart rate to ${facts.hr_peak}; easy tops out at ${easyMax}. On ${runWord}, slow down on hills and keep the effort, not the pace.`, 20 + facts.hr_peak - easyMax),
        );
      } else if (!over && flatPace) {
        const best = looked.filter((x) => x.h.gain >= 25 && x.h.grade >= 4 && x.peak > 0 && x.peak <= easyMax && x.pace && x.pace >= flatPace * 1.05).sort((x, y) => y.h.gain - x.h.gain)[0];
        if (best) {
          const facts = { at_km: km(tr.d[best.a]! - tr.d[0]!), climb_m: Math.round(best.h.gain), grade_pct: Math.round(best.h.grade), hr_peak: Math.round(best.peak), easy_max: easyMax, climb_pace: mmss(best.pace!), flat_pace: mmss(flatPace) };
          out.push(make("good", "hill_steady", best.a, best.b, `the climb at ${facts.at_km} km`, facts, `The climb at ${facts.at_km} km stayed at ${facts.hr_peak} or under, inside easy, at ${facts.climb_pace} /km against ${facts.flat_pace} on the flat. Effort, not pace.`, 10));
        }
      }
    }
  }

  // ---- A fast start.
  if ((steady || kind === "race") && D >= 5000) {
    const W = D >= 8000 ? 2000 : 1000;
    const s = at(tr, along(W));
    const e = at(tr, along(D * 0.9));
    const first = stretch(tr, 0, s);
    const rest = stretch(tr, s, e);
    // Heart rate from 3 minutes in: it takes that long to rise.
    const a3 = atMoving(tr, 180);
    const firstHr = a3 < s && tr.d[s]! - tr.d[a3]! >= 300 ? stretch(tr, a3, s).hr : null;
    const slope = terrain ? netGrade(tr, terrain, 0, s) - netGrade(tr, terrain, s, e) : 0;
    const quick = first.pace && rest.pace && rest.pace - first.pace >= 12 && (rest.pace - first.pace) / rest.pace >= 0.04 && slope > -1;
    const hot = hr && firstHr && rest.hr && firstHr - rest.hr >= 5 && slope < 1;
    if (quick || hot) {
      const facts: Moment["facts"] = { first_km: W / 1000, start_pace: mmss(first.pace!), rest_pace: mmss(rest.pace!) };
      if (hot) Object.assign(facts, { start_hr: Math.round(firstHr!), rest_hr: Math.round(rest.hr!) });
      const went = quick && hot ? `went at ${facts.start_pace} /km and heart rate ${facts.start_hr}, the rest at ${facts.rest_pace} and ${facts.rest_hr}` : quick ? `went at ${facts.start_pace} /km, the rest at ${facts.rest_pace}` : `ran at heart rate ${facts.start_hr}, the rest at ${facts.rest_hr}`;
      const advice = kind === "race" ? "The first kilometres cost the most: start at goal pace, not quicker." : "Start slower: the first kilometres should feel too easy.";
      const score = 15 + (quick ? ((rest.pace! - first.pace!) / rest.pace!) * 100 : 0) + (hot ? firstHr! - rest.hr! : 0);
      out.push(make("work_on", "fast_start", 0, s, `the first ${W / 1000} km`, facts, `The first ${W / 1000} km ${went}. ${advice}`, score));
    }
  }

  // ---- The last third of a long run: a fade, decoupling, or held.
  const long = steady && ((kind === "long" && T >= 60 * 60) || T >= 70 * 60);
  if (long) {
    const a0 = atMoving(tr, 600);
    const s = at(tr, along(D * (2 / 3)));
    const early = stretch(tr, a0, s);
    const late = stretch(tr, s, N - 1);
    const uphill = terrain ? netGrade(tr, terrain, s, N - 1) - netGrade(tr, terrain, a0, s) > 0.8 : false;
    if (early.pace && late.pace && late.metres >= 2000 && !uphill) {
      const dec = hr ? decouple(early, late) : null;
      const slower = late.pace - early.pace;
      const lastKm = km(late.metres);
      const base = { last_km: lastKm, early_pace: mmss(early.pace), late_pace: mmss(late.pace) };
      const withHr: Record<string, number> = dec !== null ? { early_hr: Math.round(early.hr!), late_hr: Math.round(late.hr!), decoupling_pct: Math.round(dec) } : {};
      const tip = "Start long runs a little slower and take fuel early so the last third holds.";
      if (slower >= 15 && slower / early.pace >= 0.05) {
        const facts = { ...base, slower_s: Math.round(slower), ...withHr };
        out.push(make("work_on", "fade", s, N - 1, `the last ${lastKm} km`, facts, `The last ${lastKm} km slowed to ${facts.late_pace} /km from ${facts.early_pace} before. ${tip}`, 15 + (slower / early.pace) * 100));
      } else if (dec !== null && dec >= 5) {
        const facts = { ...base, ...withHr } as Record<string, number | string>;
        out.push(make("work_on", "decoupling", s, N - 1, `the last ${lastKm} km`, facts, `Over the last ${lastKm} km your heart rate rose to ${facts.late_hr} from ${facts.early_hr}, at ${facts.late_pace} /km against ${facts.early_pace}: ${facts.decoupling_pct}% decoupling. ${tip}`, 15 + dec));
      } else if (dec !== null && Math.abs(dec) < 3 && Math.abs(slower) / early.pace <= 0.03 && (kind === "long" || T >= 90 * 60)) {
        const facts = { ...base, drift_pct: Math.round(Math.abs(dec)) };
        out.push(make("good", "held_long", s, N - 1, `the last ${lastKm} km`, facts, `The last ${lastKm} km held ${facts.late_pace} /km with heart rate drift of ${facts.drift_pct}%. An even long run.`, 15));
      }
    }
  }

  // ---- A strong finish: the last km the fastest, at a controlled heart rate.
  const cap = steady && easyMax ? easyMax + 10 : ctx.max_hr ? Math.round(ctx.max_hr * 0.92) : null;
  if (!PACED.has(kind) && hr && cap && D >= 4000) {
    const end = N - 1;
    const s = at(tr, along(D - 1000));
    const last = stretch(tr, s, end);
    const splits: number[] = [];
    for (let k = 0; (k + 1) * 1000 <= D - 1000; k++) {
      const p = stretch(tr, at(tr, along(k * 1000)), at(tr, along((k + 1) * 1000))).pace;
      if (p) splits.push(p);
    }
    const usual = [...splits].sort((x, y) => x - y)[Math.floor(splits.length / 2)];
    const downhill = terrain ? netGrade(tr, terrain, s, end) < -1 : false;
    if (last.pace && usual && splits.length >= 3 && last.pace < Math.min(...splits) && usual - last.pace >= 8 && (usual - last.pace) / usual >= 0.03 && last.peak !== null && last.peak <= cap && !downhill) {
      const facts = { last_pace: mmss(last.pace), usual_pace: mmss(usual), hr_peak: Math.round(last.peak) };
      out.push(make("good", "strong_finish", s, end, "the last km", facts, `The last km was the fastest, ${facts.last_pace} /km against ${facts.usual_pace} for a usual km, with heart rate no higher than ${facts.hr_peak}. A controlled finish.`, 20));
    }
  }

  // ---- Gentle downhills given away: free speed.
  if (!PACED.has(kind) && terrain && !/trail/i.test(ctx.sport ?? "")) {
    // The flat: 100 m pieces with less than 1.5% either way, past the first km.
    let fm = 0;
    let fs = 0;
    let fh = 0;
    let fw = 0;
    for (let m = 1000; m + 100 <= D; m += 100) {
      const a = at(tr, along(m));
      const b = at(tr, along(m + 100));
      if (b <= a || Math.abs(netGrade(tr, terrain, a, b)) >= 1.5) continue;
      const st = stretch(tr, a, b);
      fm += st.metres;
      fs += st.seconds;
      if (st.hr) (fh += st.hr * st.seconds), (fw += st.seconds);
    }
    const flatPace = fm >= 2000 ? fs / (fm / 1000) : null;
    const flatHr = fw ? fh / fw : null;
    if (flatPace) {
      const found = hills(terrain, -1, 15)
        .filter((h) => h.grade >= 2 && h.grade <= 6 && h.steepest <= 8 && (h.b - h.a) * GRID >= 300 && h.a * GRID >= 1000)
        .map((h) => {
          const a = at(tr, terrain.d0 + h.a * GRID);
          const b = at(tr, terrain.d0 + h.b * GRID);
          const st = stretch(tr, a, b);
          const elapsed = tr.t[b]! - tr.t[a]!;
          return { h, a, b, st, steady: elapsed > 0 && st.seconds / elapsed >= 0.95 };
        })
        .filter((x) => {
          if (!x.steady || !x.st.pace) return false;
          const slower = x.st.pace - flatPace;
          if (slower < 15) return false;
          if (hr && flatHr && x.st.hr) return slower / flatPace >= 0.05 && x.st.hr <= flatHr - 3;
          return slower / flatPace >= 0.08;
        })
        .sort((x, y) => y.st.pace! - x.st.pace!)[0];
      if (found) {
        const facts = { at_km: km(tr.d[found.a]! - tr.d[0]!), drop_m: Math.round(found.h.gain), grade_pct: Math.round(found.h.grade), downhill_pace: mmss(found.st.pace!), flat_pace: mmss(flatPace) };
        out.push(
          make("work_on", "downhill_easing", found.a, found.b, `the downhill at ${facts.at_km} km`, facts, `On the gentle downhill at ${facts.at_km} km (${facts.grade_pct}%) you ran ${facts.downhill_pace} /km, slower than ${facts.flat_pace} on the flat. Let it roll on easy downhills: that's free speed.`, 8 + ((found.st.pace! - flatPace) / flatPace) * 100),
        );
      }
    }
  }

  // ---- Reps against their targets.
  if (PACED.has(kind) && ctx.review) {
    const pos = (i: number) => {
      // Kept sample at or past column index i.
      let lo = 0;
      let hi = N - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tr.idx[mid]! < i) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const work = ctx.review.steps.filter((s): s is StepReview & { span: [number, number] } => s.kind === "run" && !!s.target && !!s.span && s.verdict !== "not done" && s.verdict !== "no data");
    const offBy = (s: StepReview) => Number(/^(\d+)/.exec(s.off)?.[1] ?? 0);
    const name = (s: StepReview) => s.label.replace(/^Rep /, "rep ").replace(/^Run$/, "the run");
    const Name = (s: StepReview) => s.label;
    const half = Math.ceil(work.length / 2);
    work.forEach((s, n) => {
      const a = pos(s.span[0]);
      const b = pos(s.span[1]);
      if (b <= a) return;
      const off = offBy(s);
      const facts = { rep: s.label, actual: s.actual, target: s.target, off: s.off };
      const pace = s.target.includes("/km");
      if (pace && s.verdict === "slow" && off >= 5) {
        const tip = work.length > 2 && n >= half ? " Start the early reps at the slow end of the range so the late ones hold." : "";
        out.push(make("work_on", "rep_slow", a, b, name(s), facts, `${Name(s)} came in at ${s.actual} against ${s.target}, ${s.off} slow.${tip}`, 12 + off));
      } else if (pace && s.verdict === "fast" && off >= 8) {
        out.push(make("work_on", "rep_fast", a, b, name(s), facts, `${Name(s)} went at ${s.actual} against ${s.target}, ${s.off} quick. Faster than asked costs the reps after it.`, 10 + off));
      } else if (s.target.includes("bpm") && s.verdict === "high" && off >= 5 && hr) {
        out.push(make("work_on", "rep_high", a, b, name(s), facts, `${Name(s)} averaged ${s.actual} against ${s.target}. Ease the pace until it sits in the range.`, 10 + off));
      }
    });
    const seconds = work.reduce((x, s) => x + s.seconds, 0);
    if (work.length && (work.length >= 3 || seconds >= 600) && work.every((s) => s.verdict === "on target") && (hr || work.every((s) => !s.target.includes("bpm")))) {
      const a = pos(work[0]!.span[0]);
      const b = pos(work.at(-1)!.span[1]);
      const same = work.every((s) => s.target === work[0]!.target);
      const facts: Moment["facts"] = { reps: work.length, ...(same ? { target: work[0]!.target } : {}) };
      const text = work.length === 1 ? `On target all the way: ${work[0]!.actual} against ${work[0]!.target}.` : `All ${work.length} reps on target${same ? `, ${work[0]!.target}` : ""}.`;
      if (work.length === 1) facts.actual = work[0]!.actual;
      if (b > a) out.push(make("good", "reps_on_target", a, b, work.length === 1 ? name(work[0]!) : "the reps", facts, text, 30));
    }
  }

  return pick(out);
}

/** The best good and the two weightiest to work on, no two on the same stretch; along the route. */
function pick(all: Candidate[]): Moment[] {
  const chosen: Candidate[] = [];
  const overlaps = (x: Candidate, y: Candidate) => {
    const o = Math.min(x.to_m, y.to_m) - Math.max(x.from_m, y.from_m);
    return o > 0.5 * Math.min(x.to_m - x.from_m || 1, y.to_m - y.from_m || 1);
  };
  for (const [kind, max] of [["work_on", 2], ["good", 1]] as const) {
    for (const c of all.filter((x) => x.kind === kind).sort((x, y) => y.score - x.score)) {
      if (chosen.filter((x) => x.kind === kind).length >= max) break;
      if (chosen.some((x) => overlaps(x, c))) continue;
      chosen.push(c);
    }
  }
  return chosen.sort((x, y) => x.from_m - y.from_m).map(({ score: _s, ...m }) => m);
}

/** The moment the note after the run mentions: the first to work on along the route, else the good one. */
export function leadMoment(ms: Moment[]): Moment | null {
  return ms.find((m) => m.kind === "work_on") ?? ms[0] ?? null;
}

/** Moments as lines for the coach: the only ones it may point to. */
export function momentFacts(ms: Moment[]): string[] {
  return ms.map((m, i) => `Moment ${i + 1} (${m.kind === "good" ? "done well" : "to work on"}, ${m.where}, ${km(m.from_m)}-${km(m.to_m)} km): ${m.text}`);
}

/** Moments for the sheet's charts: sample indexes moved onto the evenly thinned streams it gets (src/library.ts streams). */
export function onThinned(ms: Moment[], step: number, points: number): Moment[] {
  if (!(step > 1)) return ms;
  const last = Math.max(0, points - 1);
  return ms.map((m) => ({ ...m, from_i: Math.min(last, Math.floor(m.from_i / step)), to_i: Math.min(last, Math.ceil(m.to_i / step)) }));
}

// ------------------------------------------------------------ loaded and kept

const FILE = "cache/run-moments.json";
/** At most this many runs kept. */
const KEEP = 300;

type PlanViewLike = { weeks: Array<{ days: Array<{ date: string; sessions: Array<{ kind: string; target?: string; activity?: { id: string } }> }> }> };

export interface MomentDeps {
  disk: Disk;
  find(id: string): Promise<{ id: string; sport: string; streams_from?: string }>;
  rawStreams(m: { id: string; sport: string; streams_from?: string }): Promise<{ source: string; columns: Record<string, unknown[]> } | null>;
  view(): Promise<PlanViewLike>;
  review(date: string, kind: string): Promise<SessionReview | { error: string }>;
  profile(): Promise<{ max_hr: number; zone_limits?: [number, number, number, number] }>;
  family(sport: string): string;
}

/**
 * One run's moments, worked out from its recording against the session it filled, and kept in
 * cache/run-moments.json until the recording, the session or the zones change. Null for anything
 * but a run with a time series.
 */
export async function loadMoments(deps: MomentDeps, id: string): Promise<Moment[] | null> {
  const m = await deps.find(id);
  if (deps.family(m.sport) !== "run" || !m.streams_from) return null;
  const [view, prof] = await Promise.all([deps.view(), deps.profile()]);
  const at = view.weeks.flatMap((w) => w.days.flatMap((d) => d.sessions.map((s) => ({ date: d.date, s })))).find((x) => x.s.activity?.id === m.id);
  const easy_max = (prof.zone_limits?.[1] ?? Math.round(0.7 * prof.max_hr)) - 1;
  const sig = [MOMENTS_VERSION, m.streams_from, at?.s.kind ?? "", at?.s.target ?? "", easy_max, prof.max_hr].join("|");
  const kept = (await readJson<Record<string, { sig: string; moments: Moment[] }>>(deps.disk, FILE).catch(() => null)) ?? {};
  if (kept[m.id]?.sig === sig) return kept[m.id]!.moments;
  const raw = await deps.rawStreams(m);
  if (!raw) return null;
  let review: SessionReview | null = null;
  if (at && PACED.has(at.s.kind)) {
    const r = await deps.review(at.date, at.s.kind).catch(() => null);
    review = r && "steps" in r ? r : null;
  }
  const moments = runMoments(raw.columns, { kind: at?.s.kind, source: raw.source, sport: m.sport, easy_max, max_hr: prof.max_hr, review });
  delete kept[m.id];
  kept[m.id] = { sig, moments };
  const ids = Object.keys(kept);
  for (const x of ids.slice(0, Math.max(0, ids.length - KEEP))) delete kept[x];
  await deps.disk.write(FILE, JSON.stringify(kept)).catch(() => {});
  return moments;
}
