/**
 * Durability: how well a long run's effort holds. Over a steady run the heart rate creeps up
 * for the same pace (cardiac drift); how much, and how late it starts, says more about readiness
 * for a long race than any single best effort.
 *
 * Per run of an hour or more with heart rate: after a 10-minute warm-up, the moving time is cut
 * in halves. Each half's efficiency is its hill-adjusted speed per heartbeat (Minetti's cost of
 * running on a slope, as race pacing uses, half the downhill saving counted). Drift is how much
 * the second half falls below the first (Friel's Pa:HR decoupling: under 5% is a well-built
 * aerobic base). "Holds until" is the minute where 10-minute stretches fall 5% below the
 * opening 20 minutes and stay there. Runs that aren't steady (intervals, a fartlek) are left out:
 * their drift says nothing.
 */
import { readJson } from "./disk.ts";
import { effort } from "./race-pace.ts";
import { heat, type Weather } from "./weather.ts";
import type { Library } from "./library.ts";

export interface Columns {
  time?: unknown[];
  heartrate?: unknown[];
  velocity?: unknown[];
  distance?: unknown[];
  altitude?: unknown[];
}

export interface Drift {
  /** Moving minutes looked at (the warm-up included). */
  minutes: number;
  /** Second half against the first, %: positive is heart rate up for the same (hill-adjusted) pace. */
  drift_pct: number;
  /** Minute the effort stopped holding, or null when it held to the end. */
  holds_until_min: number | null;
  /** Hill-adjusted metres per heartbeat, first and second half. */
  first: number;
  second: number;
  /** Pace varied too much (intervals, fartlek, a lot of stopping) for the drift to mean much. */
  steady: boolean;
  /** Altitude was there to adjust for hills. */
  hills_adjusted: boolean;
}

const CACHE = "cache/durability.json";
const WARMUP_S = 10 * 60;
const MIN_MOVING_S = 60 * 60;
/** Slower than this (16:40 /km) is standing, walking a water stop, waiting at lights. */
const MOVING = 1.0;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface Sample {
  /** Moving seconds since the start. */
  t: number;
  dt: number;
  hr: number;
  /** Hill-adjusted speed, m/s. */
  v: number;
}

/** The moving samples with heart rate, each with its hill-adjusted speed. */
function samples(c: Columns): { list: Sample[]; hills: boolean } | null {
  const time = c.time?.map(num);
  const hr = c.heartrate?.map(num);
  if (!time || !hr) return null;
  const n = time.length;
  // Distance from the speed when there is none (a phone recording without it, say).
  let dist = c.distance?.map(num);
  const vel = c.velocity?.map(num);
  if (!dist?.some((d) => d !== null) && vel) {
    let d = 0;
    dist = time.map((t, i) => (i && t !== null && time[i - 1] !== null ? (d += (vel[i] ?? 0) * Math.max(0, t - time[i - 1]!)) : d));
  }
  if (!dist) return null;
  const alt = c.altitude?.map(num);
  const hills = !!alt && alt.filter((a) => a !== null).length > n / 2;
  const list: Sample[] = [];
  let moving = 0;
  let back = 0;
  for (let i = 1; i < n; i++) {
    const t = time[i];
    const t0 = time[i - 1];
    const h = hr[i];
    const d = dist[i];
    const d0 = dist[i - 1];
    if (t == null || t0 == null || d == null || d0 == null) continue;
    const dt = t - t0;
    if (dt <= 0 || dt > 30) continue;
    const v = vel?.[i] ?? (d - d0) / dt;
    if (v < MOVING) continue;
    moving += dt;
    if (!h || h < 60) continue;
    // Gradient over the last 50 m or more (one-second altitude is too noisy for less).
    let g = 0;
    if (hills) {
      while (back < i - 1 && (dist[back + 1] ?? 0) <= d - 50) back++;
      const a = alt![i];
      const a0 = alt![back];
      const run = d - (dist[back] ?? d);
      if (a != null && a0 != null && run >= 40) g = Math.max(-0.3, Math.min(0.3, (a - a0) / run));
    }
    list.push({ t: moving, dt, hr: h, v: v * effort(g) });
  }
  return { list, hills };
}

/** Speed per heartbeat over some samples (ratio of sums, so long samples count for more). */
const ef = (s: Sample[]) => {
  let m = 0;
  let beats = 0;
  for (const x of s) {
    m += x.v * x.dt;
    beats += (x.hr / 60) * x.dt;
  }
  return beats ? m / beats : 0;
};

/** Drift for one run's time series, or null when it is too short or has no heart rate. */
export function drift(c: Columns): Drift | null {
  const s = samples(c);
  if (!s || s.list.length < 60) return null;
  const total = s.list.at(-1)!.t;
  if (total < MIN_MOVING_S) return null;
  const body = s.list.filter((x) => x.t > WARMUP_S);
  const mid = WARMUP_S + (total - WARMUP_S) / 2;
  const first = ef(body.filter((x) => x.t <= mid));
  const second = ef(body.filter((x) => x.t > mid));
  if (!first || !second) return null;

  // Steady: minute by minute, the hill-adjusted speed varies by less than 15%.
  const perMin = new Map<number, Sample[]>();
  for (const x of body) {
    const k = Math.floor(x.t / 60);
    const m = perMin.get(k);
    if (m) m.push(x);
    else perMin.set(k, [x]);
  }
  const speeds = [...perMin.values()].filter((m) => m.length > 2).map((m) => m.reduce((a, x) => a + x.v * x.dt, 0) / m.reduce((a, x) => a + x.dt, 0));
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const sd = Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length);

  // Holds until: 10-minute windows a minute apart against the opening 20 minutes after the warm-up.
  const base = ef(body.filter((x) => x.t <= WARMUP_S + 20 * 60));
  const below: number[] = [];
  for (let from = WARMUP_S + 10 * 60; from + 600 <= total; from += 60) {
    const w = ef(body.filter((x) => x.t > from && x.t <= from + 600));
    if (w && w < base * 0.95) below.push(from);
    else below.length = 0;
  }
  // Below from some minute to the end (at least three windows in a row).
  const holds = below.length >= 3 ? Math.round(below[0]! / 60) : null;

  return {
    minutes: Math.round(total / 60),
    drift_pct: Math.round(((first - second) / first) * 1000) / 10,
    holds_until_min: holds,
    first: Math.round(first * 1000) / 1000,
    second: Math.round(second * 1000) / 1000,
    steady: sd / mean < 0.15,
    hills_adjusted: s.hills,
  };
}

/** Under 5% held, under 10% drifted, more faded (Friel's thresholds). */
export function verdict(pct: number): "held" | "drifted" | "faded" {
  return pct < 5 ? "held" : pct < 10 ? "drifted" : "faded";
}

export interface LongRun extends Drift {
  id: string;
  date: string;
  name?: string;
  km?: number;
  verdict: ReturnType<typeof verdict>;
  /** What it was run in (the latest steady run only). */
  weather?: { temp_c: number; dew_c: number };
}

export interface Durability {
  runs: LongRun[];
  /** Median drift of the last three steady long runs against the three before, when there are six. */
  trend: { recent_pct: number; earlier_pct: number } | null;
  /** One line in words, for the coach and the card. */
  summary: string;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Durability over the last `weeks`: each run of an hour or more, newest first. */
export async function durability(lib: Library, weeks = 26, now = Date.now(), weather?: Weather): Promise<Durability> {
  const since = new Date(now - weeks * 7 * 86_400_000).toISOString().slice(0, 10);
  const rows = (await lib.activities({ since, sport: "run" })).filter((r) => (r.moving_min ?? 0) >= 60 && r.avg_hr);
  // Each run's drift is worked out once per time series (it reads every second of the run).
  const cache = (await readJson<Record<string, { src: string; d: Drift | null }>>(lib.disk, CACHE)) ?? {};
  let changed = false;
  const runs: LongRun[] = [];
  for (const r of rows) {
    const src = r.streams_from ?? "";
    let hit = cache[r.id];
    if (!hit || hit.src !== src) {
      const raw = src ? await lib.rawStreams(await lib.find(r.id)).catch(() => null) : null;
      hit = cache[r.id] = { src, d: raw ? drift(raw.columns) : null };
      changed = true;
    }
    const d = hit.d;
    if (d) runs.push({ id: r.id, date: (r.start_local ?? r.start).slice(0, 10), name: r.name, km: r.distance_km, ...d, verdict: verdict(d.drift_pct) });
  }
  if (changed) await lib.disk.write(CACHE, JSON.stringify(cache)).catch(() => {});
  runs.sort((a, b) => b.date.localeCompare(a.date));
  const steady = runs.filter((r) => r.steady);
  const trend = steady.length >= 6 ? { recent_pct: median(steady.slice(0, 3).map((r) => r.drift_pct)), earlier_pct: median(steady.slice(3, 6).map((r) => r.drift_pct)) } : null;
  let summary = summarize(steady, trend);
  // Heat raises drift: the last long run's weather, when it can be had (one request per run, ever).
  const last = steady[0];
  const was = last && weather ? await weather.run(last.id).catch(() => null) : null;
  if (last && was) {
    last.weather = { temp_c: was.temp_c, dew_c: was.dew_c };
    const hx = heat(was.temp_c, was.dew_c);
    if (hx.slow_pct && hx.slow_pct[1] >= 2 && last.drift_pct >= 3) summary += ` It was warm (${Math.round(was.temp_c)} °C, dew point ${Math.round(was.dew_c)} °C): heat explains some of that drift.`;
  }
  return { runs, trend, summary };
}

function summarize(steady: LongRun[], trend: Durability["trend"]): string {
  const last = steady[0];
  if (!last) return "No steady run of an hour or more with heart rate yet: durability shows after one.";
  const day = new Date(`${last.date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const v = verdict(last.drift_pct);
  const drifted = last.drift_pct <= 0 ? "didn't drift" : `drifted ${last.drift_pct}%`;
  const meaning = v === "held" ? "a well-built aerobic base" : v === "drifted" ? "some fade" : "a clear fade";
  const slip = last.holds_until_min === null ? ", and the effort held to the end" : `; the effort started to slip from minute ${last.holds_until_min}`;
  let s = `Last steady long run (${day}, ${last.minutes} min): heart rate ${drifted} for the same effort, ${meaning}${slip}.`;
  if (trend) {
    const change = Math.round((trend.recent_pct - trend.earlier_pct) * 10) / 10;
    s += Math.abs(change) < 1 ? ` About the same as before (${trend.earlier_pct}% → ${trend.recent_pct}%).` : change < 0 ? ` Better than before: ${trend.earlier_pct}% → ${trend.recent_pct}% over the last three.` : ` Worse than before: ${trend.earlier_pct}% → ${trend.recent_pct}% over the last three (heat, fatigue or fewer long runs can do this).`;
  }
  return s;
}
