/**
 * Training analytics over merged activities (each workout counted once):
 *  - load: Banister TRIMP from heart rate, fitness (42-day) / fatigue (7-day) / form
 *  - heart-rate zones from the activity's single time series
 *  - aerobic efficiency on easy runs (metres per heartbeat)
 *  - takeaways: plain statements with the numbers behind them
 * Everything here is deterministic; the LLM coach and MCP agents build on it.
 */
import { readJson } from "./disk.ts";
import { isFootSport, round, pace, type ActivityRow, type Library } from "./library.ts";
import { sportFamily, type MergedActivity } from "./merge.ts";
import { EFFORTS } from "./run-finish.ts";
import { countdown, COUNTDOWN_DAYS, predictRace, raceAhead } from "./race-countdown.ts";
import { Plans } from "./plan.ts";

const HR_CACHE = "cache/hr-histograms.json";
/** Seconds at each heart rate (bpm → s) per activity, and which stream it came from. */
type HrCache = Record<string, { src: string; hist: Record<string, number> }>;

export interface Profile {
  /** Maximum heart rate; default: highest seen in the last year. */
  max_hr?: number;
  /** Resting heart rate; default 50. */
  rest_hr?: number;
  sex?: "M" | "F";
}

export interface LoadPoint {
  date: string;
  load: number;
  fitness: number;
  fatigue: number;
  form: number;
}

export interface Takeaway {
  id: string;
  tone: "good" | "watch" | "info";
  title: string;
  detail: string;
  activity?: string;
  /** "now": about the last days (the Today screen); "trend": about the last weeks and months (Progress). */
  horizon?: "now" | "trend";
  /** When it happened (a new best: when it was set), for Today's few days of celebration. */
  date?: string;
}

const TREND_TAKEAWAYS = new Set(["ramp", "efficiency", "intensity"]);

/** Your targets (goals.json). Every field is optional. */
export interface Goals {
  weekly_km?: number;
  weekly_workouts?: number;
  long_run_km?: number;
  race?: { name?: string; distance_km: number; date?: string; target_s?: number };
  /** How much time you have for training: the coach plans to fit it. */
  availability?: Availability;
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export interface Availability {
  days_per_week?: number;
  hours_per_week?: number;
  long_run_day?: (typeof WEEKDAYS)[number];
  /** Free text for the coach: "no running Thursdays", "travelling 20-24 Oct". */
  notes?: string;
}

function cleanAvailability(a: Availability | undefined): Availability | undefined {
  if (!a || typeof a !== "object") return undefined;
  const days = typeof a.days_per_week === "number" && a.days_per_week >= 1 && a.days_per_week <= 7 ? Math.round(a.days_per_week) : undefined;
  const hours = typeof a.hours_per_week === "number" && a.hours_per_week > 0 && a.hours_per_week <= 40 ? Math.round(a.hours_per_week * 2) / 2 : undefined;
  const long = WEEKDAYS.includes(a.long_run_day as (typeof WEEKDAYS)[number]) ? a.long_run_day : undefined;
  const notes = typeof a.notes === "string" && a.notes.trim() ? a.notes.trim().slice(0, 300) : undefined;
  return days || hours || long || notes ? { days_per_week: days, hours_per_week: hours, long_run_day: long, notes } : undefined;
}

const DAY = 86400_000;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
/** "Tue 7 Oct": readable in a takeaway, unambiguous for an agent. */
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : 0);

export const ZONES = [
  { zone: 1, name: "Recovery", from: 0.5, to: 0.6 },
  { zone: 2, name: "Endurance", from: 0.6, to: 0.7 },
  { zone: 3, name: "Tempo", from: 0.7, to: 0.8 },
  { zone: 4, name: "Threshold", from: 0.8, to: 0.9 },
  { zone: 5, name: "Max", from: 0.9, to: 1.01 },
] as const;

/** The top of zone 2 (the profile's zones, else 70% of max): "easy" in every piece of advice. */
export function easyCeiling(prof: { max_hr: number; zone_limits?: [number, number, number, number] }): number {
  return (prof.zone_limits?.[1] ?? Math.round(0.7 * prof.max_hr)) - 1;
}

/**
 * The highest heart rate that isn't a lone sensor spike: the top value counts only when the
 * next highest is within 8 bpm of it (optical sensors and strap glitches throw single peaks).
 */
export function robustMax(values: number[]): number {
  const v = values.filter((x) => x > 0 && x <= 225).sort((a, b) => b - a);
  if (v.length > 1 && v[0]! - v[1]! > 8) return v[1]!;
  return v[0] ?? 0;
}

export class Analytics {
  constructor(readonly lib: Library) {}

  private hrCache: Promise<HrCache> | null = null;
  private hrDirty = false;
  private profileMemo: { at: number; p: ReturnType<Analytics["computeProfile"]> } | null = null

  // ------------------------------------------------------------ profile

  /** The heart-rate settings (shared for a moment: one dashboard asks for them a dozen times). */
  profile(): ReturnType<Analytics["computeProfile"]> {
    if (this.profileMemo && Date.now() - this.profileMemo.at < 1500) return this.profileMemo.p;
    const p = this.computeProfile();
    this.profileMemo = { at: Date.now(), p };
    return p;
  }

  /**
   * Heart-rate settings and the zones everything uses, from the most personal source:
   *  1. a max heart rate the owner set in Settings (zones as % of it);
   *  2. the zones set on the watch (read from its workouts), with its max / resting HR;
   *  3. % of the highest heart rate in the last year, ignoring a lone sensor spike.
   * `zone_limits` are the lower bounds of zones 2–5 in bpm; zone 1 starts at half the max.
   */
  private async computeProfile(): Promise<Required<Pick<Profile, "max_hr" | "rest_hr">> & Profile & { max_hr_source: string; zone_limits: [number, number, number, number]; zones_source: string; watch_zones?: [number, number, number, number] }> {
    const saved = (await readJson<Profile>(this.lib.disk, "profile.json")) ?? {};
    const athlete = await this.lib.strava.read<{ sex?: string }>("athlete.json");
    const watch = await this.lib.watchHeartRate().catch(() => null);
    const year = await this.lib.activities({ since: dayKey(Date.now() - 365 * DAY) });
    const observed = robustMax(year.map((r) => r.max_hr ?? 0));
    const max_hr = saved.max_hr ?? watch?.max_hr ?? (observed || 190);
    const max_hr_source = saved.max_hr ? "set by you" : watch?.max_hr ? "set on your watch" : observed ? "highest in the last year" : "default";
    const pctLimits = [0.6, 0.7, 0.8, 0.9].map((f) => Math.round(f * max_hr)) as [number, number, number, number];
    const useWatch = !saved.max_hr && !!watch;
    return {
      ...saved,
      max_hr,
      max_hr_source,
      rest_hr: saved.rest_hr ?? watch?.rest_hr ?? 50,
      sex: saved.sex ?? (athlete?.sex === "F" ? "F" : athlete?.sex === "M" ? "M" : undefined),
      zone_limits: useWatch ? watch!.zones : pctLimits,
      zones_source: useWatch ? "your watch" : saved.max_hr ? "your max heart rate" : "an estimated max heart rate",
      watch_zones: watch?.zones,
    };
  }

  /** Change what's given: a field left out stays as it was, `null` clears it (back to the estimate). */
  async saveProfile(p: { [K in keyof Profile]?: Profile[K] | null }): Promise<void> {
    const clean: Profile = { ...((await readJson<Profile>(this.lib.disk, "profile.json")) ?? {}) };
    if ("max_hr" in p) delete clean.max_hr;
    if ("rest_hr" in p) delete clean.rest_hr;
    if ("sex" in p) delete clean.sex;
    if (p.max_hr && p.max_hr > 120 && p.max_hr < 240) clean.max_hr = Math.round(p.max_hr);
    if (p.rest_hr && p.rest_hr > 25 && p.rest_hr < 110) clean.rest_hr = Math.round(p.rest_hr);
    if (p.sex === "M" || p.sex === "F") clean.sex = p.sex;
    await this.lib.disk.write("profile.json", JSON.stringify(clean));
    this.profileMemo = null;
  }

  // ------------------------------------------------------------ load

  /** Banister TRIMP from duration and average heart rate; a duration-only estimate without HR. */
  trimp(r: ActivityRow, prof: { max_hr: number; rest_hr: number; sex?: string }): { load: number; estimated: boolean } {
    const minutes = r.moving_min ?? r.elapsed_min ?? 0;
    if (!minutes) return { load: 0, estimated: true };
    if (!r.avg_hr) return { load: round(minutes * 0.9, 1)!, estimated: true };
    const hrr = Math.min(1, Math.max(0, (r.avg_hr - prof.rest_hr) / (prof.max_hr - prof.rest_hr)));
    const k = prof.sex === "F" ? [0.86, 1.67] : [0.64, 1.92];
    return { load: round(minutes * hrr * k[0]! * Math.exp(k[1]! * hrr), 1)!, estimated: false };
  }

  /**
   * Every day of the last `days`, oldest first: its effort (summed load), how many workouts,
   * the kilometres run, and the day's biggest workout (to open). For the year-at-a-glance grid.
   */
  async days(days = 371): Promise<Array<{ date: string; load: number; n: number; run_km: number; id?: string; name?: string }>> {
    const prof = await this.profile();
    const start = Date.now() - (days - 1) * DAY;
    const by = new Map<string, { load: number; n: number; run_km: number; top: number; id?: string; name?: string }>();
    for (const r of await this.lib.activities({ since: dayKey(start) })) {
      const k = dayKey(Date.parse(r.start));
      const load = this.trimp(r, prof).load;
      const d = by.get(k) ?? { load: 0, n: 0, run_km: 0, top: -1 };
      d.load += load;
      d.n += 1;
      if (sportFamily(r.sport) === "run") d.run_km += r.distance_km ?? 0;
      if (load > d.top) Object.assign(d, { top: load, id: r.id, name: r.name ?? r.sport });
      by.set(k, d);
    }
    const out = [];
    for (let t = Date.parse(dayKey(start)); dayKey(t) <= dayKey(Date.now()); t += DAY) {
      const k = dayKey(t);
      const d = by.get(k);
      out.push(d ? { date: k, load: round(d.load, 1)!, n: d.n, run_km: round(d.run_km, 1)!, id: d.id, name: d.name } : { date: k, load: 0, n: 0, run_km: 0 });
    }
    return out;
  }

  /**
   * Race shape: for each week, what your runs of the six weeks before say you could race now,
   * at 5k, 10k and the half (and your goal race's distance). Each from your best effort at a
   * standard distance (Strava's, or worked out from the run's time series), scaled with Riegel
   * (time × (D/d)^1.06), from efforts between a fifth and twice the distance, the fastest wins.
   * Weeks without such a run in the window have none.
   */
  async raceShape(weeks = 26, now = Date.now()): Promise<{ distances: Array<{ name: string; metres: number; weeks: Array<{ week: string; s: number | null; from?: string }> }> }> {
    const runs = await this.lib.runEfforts();
    const metres = new Map(EFFORTS.map(([n, m]) => [n, m] as const));
    const goal = (await this.goals()).race;
    const targets: Array<[string, number]> = [["5k", 5000], ["10k", 10000], ["Half", 21097.5]];
    if (goal?.distance_km && !targets.some(([, m]) => Math.abs(m - goal.distance_km * 1000) < 300)) targets.push([`${goal.distance_km} km`, goal.distance_km * 1000]);
    const monday = new Date(dayKey(now) + "T00:00:00Z");
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const ends = Array.from({ length: weeks }, (_, i) => monday.getTime() + 7 * DAY - (weeks - 1 - i) * 7 * DAY);
    return {
      distances: targets.map(([name, D]) => ({
        name,
        metres: D,
        weeks: ends.map((end) => {
          let best: { s: number; from: string } | null = null;
          for (const r of runs) {
            const t = Date.parse(r.start);
            if (t >= end || t < end - 42 * DAY) continue;
            for (const e of r.efforts) {
              const d = metres.get(e.name);
              if (!d || d < D / 5 || d > D * 2 || !(e.time_s > 0)) continue;
              const s = e.time_s * Math.pow(D / d, 1.06);
              if (!best || s < best.s) best = { s: Math.round(s), from: e.name };
            }
          }
          return { week: dayKey(end - 7 * DAY), s: best?.s ?? null, ...(best ? { from: best.from } : {}) };
        }),
      })),
    };
  }

  /** Daily load with fitness (42-day EWMA), fatigue (7-day EWMA) and form (yesterday's fitness − fatigue). */
  async load(days = 180): Promise<{ series: LoadPoint[]; today: LoadPoint; estimated_share: number; since: string | null; history_days: number }> {
    const prof = await this.profile();
    const warmup = 120; // let the 42-day average settle before the window starts
    const start = Date.now() - (days + warmup) * DAY;
    const rows = await this.lib.activities({ since: dayKey(start) });
    const perDay = new Map<string, number>();
    let estimated = 0;
    for (const r of rows) {
      const t = this.trimp(r, prof);
      if (t.estimated) estimated++;
      const k = dayKey(Date.parse(r.start));
      perDay.set(k, (perDay.get(k) ?? 0) + t.load);
    }
    const series: LoadPoint[] = [];
    let fitness = 0;
    let fatigue = 0;
    const kf = 1 - Math.exp(-1 / 42);
    const ka = 1 - Math.exp(-1 / 7);
    const first = dayKey(Date.now() - days * DAY);
    const today = dayKey(Date.now());
    for (let t = Date.parse(dayKey(start)); dayKey(t) <= today; t += DAY) {
      const k = dayKey(t);
      const load = perDay.get(k) ?? 0;
      const form = fitness - fatigue;
      fitness += (load - fitness) * kf;
      fatigue += (load - fatigue) * ka;
      if (k >= first) series.push({ date: k, load: round(load, 1)!, fitness: round(fitness, 1)!, fatigue: round(fatigue, 1)!, form: round(form, 1)! });
    }
    const latest = series.at(-1) ?? { date: today, load: 0, fitness: 0, fatigue: 0, form: 0 };
    // Days before the first workout on record are "no data", not "rested": leave them out.
    const since = [...perDay.keys()].sort()[0] ?? null;
    const shown = since && since > first ? series.filter((p) => p.date >= since) : series;
    const history_days = since ? Math.round((Date.parse(today) - Date.parse(since)) / DAY) : 0;
    return { series: shown, today: latest, estimated_share: rows.length ? round(estimated / rows.length, 2)! : 0, since, history_days };
  }

  // ------------------------------------------------------------ zones

  /**
   * Seconds spent at each heart rate in one activity. Reading a time series is the expensive
   * part (and slow through the phone's file bridge), so the histogram is kept in
   * cache/hr-histograms.json and only recomputed when the activity's stream source changes.
   */
  private async hrHistogram(m: MergedActivity): Promise<Record<string, number> | null> {
    this.hrCache ??= readJson<HrCache>(this.lib.disk, HR_CACHE).then((c) => c ?? {});
    const cache = await this.hrCache;
    const src = m.streams_from ?? "";
    let hit = cache[m.id];
    if (!hit || hit.src !== src) {
      const raw = src ? await this.lib.rawStreams(m) : null;
      const hr = raw?.columns.heartrate as (number | null)[] | undefined;
      const time = raw?.columns.time as (number | null)[] | undefined;
      const hist: Record<string, number> = {};
      for (let i = 1; hr && time && i < hr.length; i++) {
        const h = hr[i];
        const dt = (time[i] ?? 0) - (time[i - 1] ?? 0);
        if (h === null || h === undefined || dt <= 0 || dt > 30) continue;
        hist[h] = (hist[h] ?? 0) + dt;
      }
      hit = cache[m.id] = { src, hist };
      this.hrDirty = true;
    }
    return Object.keys(hit.hist).length ? hit.hist : null;
  }

  private async saveHrCache(): Promise<void> {
    if (!this.hrDirty || !this.hrCache) return;
    this.hrDirty = false;
    await this.lib.disk.write(HR_CACHE, JSON.stringify(await this.hrCache)).catch(() => {});
  }

  /** Seconds in each heart-rate zone (the profile's zone limits) from one activity's time series. */
  async zonesFor(id: string, prof?: { max_hr: number; zone_limits?: [number, number, number, number] }): Promise<Array<{ zone: number; name: string; seconds: number; bpm: [number, number] }> | null> {
    prof ??= await this.profile();
    const hist = await this.hrHistogram(await this.lib.find(id));
    if (!hist) return null;
    const limits = prof.zone_limits ?? ([0.6, 0.7, 0.8, 0.9].map((f) => Math.round(f * prof!.max_hr)) as [number, number, number, number]);
    // Lower bound of each zone; zone 1 from half the max (standing still is not training).
    const from = [Math.round(0.5 * prof.max_hr), ...limits];
    const secs = ZONES.map(() => 0);
    for (const [h, dt] of Object.entries(hist)) {
      const hr = Number(h);
      if (hr < from[0]!) continue;
      let z = 0;
      while (z < 4 && hr >= from[z + 1]!) z++;
      secs[z]! += dt;
    }
    return ZONES.map((zn, i) => ({ zone: zn.zone, name: zn.name, seconds: Math.round(secs[i]!), bpm: [from[i]!, i < 4 ? from[i + 1]! - 1 : Math.max(prof!.max_hr, from[4]!)] as [number, number] }));
  }

  /** Zone time summed over a period (activities with a heart-rate series). */
  async zonesOver(days = 28): Promise<{ zones: Array<{ zone: number; name: string; seconds: number }>; activities: number }> {
    const rows = await this.lib.activities({ since: dayKey(Date.now() - days * DAY) });
    const prof = await this.profile();
    const total = ZONES.map((z) => ({ zone: z.zone, name: z.name, seconds: 0 }));
    let n = 0;
    for (const r of rows) {
      const z = await this.zonesFor(r.id, prof).catch(() => null);
      if (!z) continue;
      n++;
      z.forEach((x, i) => (total[i]!.seconds += x.seconds));
    }
    await this.saveHrCache();
    return { zones: total, activities: n };
  }

  // ------------------------------------------------------------ efficiency

  /**
   * Aerobic efficiency per week for easy runs (average HR below 80% of max):
   * metres covered per heartbeat. Rising means the same effort carries you further.
   */
  async efficiency(weeks = 16): Promise<Array<{ week: string; m_per_beat: number; easy_pace: string | undefined; runs: number }>> {
    const prof = await this.profile();
    const rows = await this.lib.activities({ since: dayKey(Date.now() - weeks * 7 * DAY), sport: "run" });
    const byWeek = new Map<string, { m: number; beats: number; speed: number[]; runs: number }>();
    for (const r of rows) {
      if (!r.avg_hr || !r.distance_km || !r.moving_min || r.avg_hr > 0.8 * prof.max_hr || r.moving_min < 15) continue;
      const k = weekKey(Date.parse(r.start));
      const b = byWeek.get(k) ?? { m: 0, beats: 0, speed: [], runs: 0 };
      b.m += r.distance_km * 1000;
      b.beats += r.avg_hr * r.moving_min;
      b.speed.push((r.distance_km * 1000) / (r.moving_min * 60));
      b.runs++;
      byWeek.set(k, b);
    }
    return [...byWeek.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, b]) => ({ week, m_per_beat: round(b.m / b.beats, 3)!, easy_pace: pace(mean(b.speed)), runs: b.runs }));
  }

  // ------------------------------------------------------------ totals

  async totals() {
    const now = new Date();
    const weekStart = Date.parse(weekKey(now.getTime()));
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const yearStart = Date.UTC(now.getUTCFullYear(), 0, 1);
    const rows = await this.lib.activities({ since: dayKey(yearStart) });
    const sum = (since: number) => {
      const xs = rows.filter((r) => Date.parse(r.start) >= since);
      return {
        activities: xs.length,
        distance_km: round(xs.reduce((n, r) => n + (r.distance_km ?? 0), 0), 1),
        hours: round(xs.reduce((n, r) => n + (r.moving_min ?? 0), 0) / 60, 1),
        elevation_m: Math.round(xs.reduce((n, r) => n + (r.elevation_m ?? 0), 0)),
      };
    };
    return { week: sum(weekStart), month: sum(monthStart), year: sum(yearStart) };
  }

  // ------------------------------------------------------------ targets

  async goals(): Promise<Goals> {
    return (await readJson<Goals>(this.lib.disk, "goals.json")) ?? {};
  }

  async saveGoals(g: Goals): Promise<Goals> {
    const pos = (n: unknown, max: number) => (typeof n === "number" && n > 0 && n <= max ? Math.round(n * 10) / 10 : undefined);
    const clean: Goals = { weekly_km: pos(g.weekly_km, 500), weekly_workouts: pos(g.weekly_workouts, 21), long_run_km: pos(g.long_run_km, 200) };
    const dist = pos(g.race?.distance_km, 250);
    if (dist) {
      clean.race = {
        distance_km: dist,
        name: typeof g.race?.name === "string" && g.race.name.trim() ? g.race.name.trim().slice(0, 60) : undefined,
        date: typeof g.race?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(g.race.date) ? g.race.date : undefined,
        target_s: pos(g.race?.target_s, 100 * 3600),
      };
    }
    // The targets form doesn't send your available time: keep what the Plan tab saved.
    clean.availability = "availability" in g ? cleanAvailability(g.availability) : (await this.goals()).availability;
    await this.lib.disk.write("goals.json", JSON.stringify(clean));
    return clean;
  }

  async saveAvailability(a: Availability): Promise<Availability | undefined> {
    const g = await this.goals();
    g.availability = cleanAvailability(a);
    await this.lib.disk.write("goals.json", JSON.stringify(g));
    return g.availability;
  }

  /**
   * Where you stand against your targets: this week's distance and workouts (with what's left
   * per remaining day), the longest run of the last two weeks, weeks the target was hit, and
   * for a race the days to go, a predicted time (src/race-countdown.ts: from your recent runs) and,
   * from twelve weeks out, the countdown.
   */
  async goalProgress() {
    const g = await this.goals();
    const now = Date.now();
    const monday = Date.parse(weekKey(now));
    const rows = await this.lib.activities({ since: dayKey(monday - 12 * 7 * DAY) });
    const runs = rows.filter((r) => sportFamily(r.sport) === "run");
    const inWeek = (from: number) => rows.filter((r) => Date.parse(r.start) >= from && Date.parse(r.start) < from + 7 * DAY);
    const thisWeek = inWeek(monday);
    const km = round(thisWeek.reduce((n, r) => n + (r.distance_km ?? 0), 0), 1)!;
    const daysLeft = Math.max(0, 7 - Math.floor((now - monday) / DAY) - 1); // after today
    const week =
      g.weekly_km || g.weekly_workouts
        ? {
            km,
            target_km: g.weekly_km,
            workouts: thisWeek.length,
            target_workouts: g.weekly_workouts,
            days_left: daysLeft,
            km_per_day_needed: g.weekly_km && km < g.weekly_km ? round((g.weekly_km - km) / Math.max(1, daysLeft + 1), 1) : 0,
            // Complete weeks before this one in which the target was met.
            hit: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((w) => {
              const xs = inWeek(monday - w * 7 * DAY);
              const d = xs.reduce((n, r) => n + (r.distance_km ?? 0), 0);
              return (!g.weekly_km || d >= g.weekly_km) && (!g.weekly_workouts || xs.length >= g.weekly_workouts);
            }).filter(Boolean).length,
            of_weeks: 12,
          }
        : null;
    const recentLong = runs.filter((r) => Date.parse(r.start) >= now - 14 * DAY).reduce<ActivityRow | null>((b, r) => (!b || (r.distance_km ?? 0) > (b.distance_km ?? 0) ? r : b), null);
    const long_run = g.long_run_km ? { target_km: g.long_run_km, longest_km: recentLong?.distance_km ?? 0, activity: recentLong?.id, date: recentLong?.start } : null;

    // The race: your target's while it's ahead, else the plan's next race session.
    const plan = await new Plans(this.lib).current().catch(() => null);
    const ahead = raceAhead(g.race, plan?.weeks.flatMap((w) => w.sessions) ?? [], dayKey(now));
    let race = null;
    if (ahead) {
      const meters = ahead.distance_km * 1000;
      const efforts = await this.lib.runEfforts();
      const p = predictRace(efforts, ahead.distance_km, now);
      const predicted = p?.time_s;
      const days_to_go = ahead.date ? Math.ceil((Date.parse(ahead.date) - Date.parse(dayKey(now))) / DAY) : undefined;
      const r = {
        ...ahead,
        days_to_go,
        target_pace: ahead.target_s ? pace(meters / ahead.target_s) : undefined,
        predicted_s: predicted,
        predicted_pace: predicted ? pace(meters / predicted) : undefined,
        from: p?.from,
        on_track: predicted && ahead.target_s ? predicted <= ahead.target_s : undefined,
      };
      // From twelve weeks out: how the prediction moved over the last four (src/race-countdown.ts).
      const c = countdown(r, days_to_go !== undefined && days_to_go <= COUNTDOWN_DAYS ? (predictRace(efforts, ahead.distance_km, now - 28 * DAY)?.time_s ?? null) : null);
      race = { ...r, ...(c ? { countdown: c } : {}) };
    }
    return { goals: g, week, long_run, race };
  }

  /** What the last four weeks looked like, in a sentence's worth of numbers (the coach's intro). */
  async recent(days = 28) {
    const rows = await this.lib.activities({ since: dayKey(Date.now() - days * DAY) });
    const runs = rows.filter((r) => sportFamily(r.sport) === "run");
    const weeks = days / 7;
    return {
      days,
      workouts: rows.length,
      runs: runs.length,
      run_km_per_week: round(runs.reduce((n, r) => n + (r.distance_km ?? 0), 0) / weeks, 1)!,
      hours_per_week: round(rows.reduce((n, r) => n + (r.moving_min ?? r.elapsed_min ?? 0), 0) / 60 / weeks, 1)!,
      longest_run_km: round(Math.max(0, ...runs.map((r) => r.distance_km ?? 0)), 1)!,
    };
  }

  // ------------------------------------------------------------ one week

  /**
   * One week, Monday to Sunday (the week of `start`, default this one): day by day, its
   * workouts, load and zones, against the week before and the four before that.
   */
  async week(start?: string) {
    const prof = await this.profile();
    const now = Date.now();
    const thisMonday = Date.parse(weekKey(now));
    const asked = start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? Date.parse(weekKey(Date.parse(start))) : thisMonday;
    const monday = Math.min(asked, thisMonday);
    const rows = await this.lib.activities({ since: dayKey(monday - 28 * DAY), until: dayKey(monday + 6 * DAY) });
    const within = (from: number, to: number) => rows.filter((r) => Date.parse(r.start) >= from && Date.parse(r.start) < to);
    const total = (xs: ActivityRow[]) => ({
      km: round(xs.reduce((n, r) => n + (r.distance_km ?? 0), 0), 1)!,
      minutes: Math.round(xs.reduce((n, r) => n + (r.moving_min ?? r.elapsed_min ?? 0), 0)),
      workouts: xs.length,
      climb: Math.round(xs.reduce((n, r) => n + (r.elevation_m ?? 0), 0)),
      load: Math.round(xs.reduce((n, r) => n + this.trimp(r, prof).load, 0)),
    });
    const weekRows = within(monday, monday + 7 * DAY).sort((a, b) => a.start.localeCompare(b.start));
    const days = Array.from({ length: 7 }, (_, i) => {
      const from = monday + i * DAY;
      const xs = weekRows.filter((r) => Date.parse(r.start) >= from && Date.parse(r.start) < from + DAY);
      return { date: dayKey(from), ...total(xs), future: from > now, activities: xs };
    });
    const prior = [1, 2, 3, 4].map((w) => total(within(monday - w * 7 * DAY, monday - (w - 1) * 7 * DAY)));
    const usual = { km: round(mean(prior.map((p) => p.km)), 1)!, minutes: Math.round(mean(prior.map((p) => p.minutes))), workouts: round(mean(prior.map((p) => p.workouts)), 1)!, load: Math.round(mean(prior.map((p) => p.load))) };

    const zones = ZONES.map((z) => ({ zone: z.zone, name: z.name, seconds: 0 }));
    for (const r of weekRows) {
      const zs = await this.zonesFor(r.id, prof).catch(() => null);
      zs?.forEach((z, i) => (zones[i]!.seconds += z.seconds));
    }
    await this.saveHrCache();
    const sports = new Map<string, { sport: string; km: number; minutes: number; workouts: number }>();
    for (const r of weekRows) {
      const f = sportFamily(r.sport);
      const k = f === "?" ? "other" : f;
      const s = sports.get(k) ?? { sport: k, km: 0, minutes: 0, workouts: 0 };
      s.km = round(s.km + (r.distance_km ?? 0), 1)!;
      s.minutes += Math.round(r.moving_min ?? r.elapsed_min ?? 0);
      s.workouts++;
      sports.set(k, s);
    }
    const earlier = (await this.lib.activities({ until: dayKey(monday - DAY), limit: 1 })).length > 0;
    return {
      start: dayKey(monday),
      end: dayKey(monday + 6 * DAY),
      current: monday === thisMonday,
      prev: earlier ? dayKey(monday - 7 * DAY) : null,
      next: monday < thisMonday ? dayKey(monday + 7 * DAY) : null,
      totals: total(weekRows),
      previous: prior[0]!,
      usual,
      days,
      zones,
      sports: [...sports.values()].sort((a, b) => b.minutes - a.minutes),
    };
  }

  // ------------------------------------------------------------ dashboard

  /** Everything the dashboard draws, in one call. */
  async dashboard(days = 84) {
    days = Math.max(28, Math.min(366, Math.round(days)));
    const weeksN = Math.ceil(days / 7);
    const [totals, load, weeks, efficiency, zones, takeaways, recent, prof, bests, targets] = await Promise.all([
      this.totals(),
      this.load(days),
      this.lib.summary({ period: "week", since: weekKey(Date.now() - (weeksN - 1) * 7 * DAY) }),
      this.efficiency(weeksN),
      this.zonesOver(Math.min(days, 180)),
      this.takeaways(),
      this.lib.activities({ limit: 8 }),
      this.profile(),
      this.lib.bestEfforts("run"),
      this.goalProgress(),
    ]);
    return { days, totals, load, weeks, efficiency, zones, takeaways, recent, profile: prof, bests, targets };
  }

  /** How hard a workout was for you: its effort against your own workouts of the last 90 days. */
  async effortLabel(load: number, zones?: Array<{ seconds: number }> | null): Promise<{ label: string; rank: string }> {
    const prof = await this.profile();
    const loads = (await this.lib.activities({ since: dayKey(Date.now() - 90 * DAY) })).map((r) => this.trimp(r, prof).load).filter((l) => l > 0);
    // A short run mostly above easy isn't "light", however small its effort: never say so beside
    // a heart-rate bar that shows it was hard.
    const total = zones?.reduce((n, z) => n + z.seconds, 0) ?? 0;
    const mostlyAbove = total > 0 && (zones![0]!.seconds + (zones![1]?.seconds ?? 0)) / total < 0.3;
    const floor = (l: string) => (mostlyAbove && l === "Light" ? "Moderate" : l);
    if (loads.length < 5) return { label: floor(load >= 100 ? "Hard" : load >= 50 ? "Moderate" : "Light"), rank: "" };
    const below = loads.filter((l) => l < load).length / loads.length;
    // "Light", not "Easy": easy is a heart-rate zone (1-2) here, and a light load can still be run above it.
    const label = floor(below >= 0.9 ? "Very hard" : below >= 0.7 ? "Hard" : below >= 0.35 ? "Moderate" : "Light");
    const harder = loads.filter((l) => l > load).length;
    const easier = loads.filter((l) => l < load).length;
    const rank =
      harder === 0 ? "your hardest in 3 months"
      : harder < 5 ? `top ${harder + 1} of ${loads.length} in 3 months`
      : easier === 0 ? "the smallest effort of your last 3 months"
      : below >= 0.5 ? `harder than ${Math.round(below * 100)}% of your workouts`
      : `easier than ${Math.round((harder / loads.length) * 100)}% of your workouts`;
    return { label, rank };
  }

  /**
   * The Today screen: how you are right now, in plain words. Readiness from form (with the
   * numbers behind it explained), the last workout, and this week day by day against your usual.
   */
  async today() {
    const prof = await this.profile();
    const { today: lp, history_days } = await this.load(60);
    const rows = await this.lib.activities({ since: dayKey(Date.now() - 63 * DAY) });
    const now = Date.now();
    const minutesIn = (from: number, to: number) => rows.filter((r) => Date.parse(r.start) >= from && Date.parse(r.start) < to).reduce((n, r) => n + (r.moving_min ?? r.elapsed_min ?? 0), 0);
    const last7 = minutesIn(now - 7 * DAY, now + DAY);
    const usual7 = minutesIn(now - 35 * DAY, now - 7 * DAY) / 4;
    // Easy means zones 1-2 everywhere: the readiness advice, the intensity tip and the coach's plan.
    const easyCap = easyCeiling(prof);
    const f = lp.form;
    const [state, title, advice] =
      history_days < 14 ? ["new", "Getting to know you", "Readiness needs about two weeks of workouts. Train as planned."]
      : f < -30 ? ["tired", "Tired", `Rest today, or keep it to an easy 30 minutes below ${easyCap} bpm.`]
      : f < -10 ? ["building", "Building fitness", `Normal training is fine. Keep easy runs truly easy, below ${easyCap} bpm.`]
      : f <= 5 ? ["steady", "Balanced", "Good for any session, easy or hard."]
      : f <= 25 ? ["fresh", "Fresh", "A good day for a hard workout or a race."]
      : ["rested", "Well rested", "You've had a light stretch. A good time to build back up."];
    const vs = usual7 > 0 ? Math.round(((last7 - usual7) / usual7) * 100) : null;
    const why =
      history_days < 14 ? `${fmtMin(last7)} of training in the last 7 days.`
      : `${fmtMin(last7)} of training in the last 7 days${vs === null ? "" : Math.abs(vs) < 10 ? ", about your usual" : vs > 0 ? `, ${vs}% more than your usual ${fmtMin(usual7)}` : `, ${Math.abs(vs)}% less than your usual ${fmtMin(usual7)}`}.`;

    // The last workout, and how hard it was for you.
    const lastRow = rows[0] ?? (await this.lib.activities({ limit: 1 }))[0];
    let last = null;
    if (lastRow) {
      const t = this.trimp(lastRow, prof);
      const zones = await this.zonesFor(lastRow.id, prof).catch(() => null);
      await this.saveHrCache();
      last = { activity: lastRow, effort: t.load, estimated: t.estimated, ...(await this.effortLabel(t.load, zones)), zones };
    }

    // This week, Monday to Sunday, against the four weeks before.
    const monday = Date.parse(weekKey(now));
    const days = Array.from({ length: 7 }, (_, i) => {
      const from = monday + i * DAY;
      const xs = rows.filter((r) => Date.parse(r.start) >= from && Date.parse(r.start) < from + DAY);
      return { date: dayKey(from), km: round(xs.reduce((n, r) => n + (r.distance_km ?? 0), 0), 1)!, minutes: Math.round(xs.reduce((n, r) => n + (r.moving_min ?? 0), 0)), workouts: xs.length, future: from > now };
    });
    const weekRows = rows.filter((r) => Date.parse(r.start) >= monday);
    const prior = [1, 2, 3, 4].map((w) => rows.filter((r) => Date.parse(r.start) >= monday - w * 7 * DAY && Date.parse(r.start) < monday - (w - 1) * 7 * DAY));
    const week = {
      days,
      km: round(weekRows.reduce((n, r) => n + (r.distance_km ?? 0), 0), 1)!,
      minutes: Math.round(weekRows.reduce((n, r) => n + (r.moving_min ?? 0), 0)),
      climb: Math.round(weekRows.reduce((n, r) => n + (r.elevation_m ?? 0), 0)),
      workouts: weekRows.length,
      usual_km: round(mean(prior.map((xs) => xs.reduce((n, r) => n + (r.distance_km ?? 0), 0))), 1)!,
      usual_workouts: round(mean(prior.map((xs) => xs.length)), 1)!,
    };

    const takeaways = (await this.takeaways()).filter((t) => t.horizon === "now" && t.id !== "form");
    const targets = await this.goalProgress();
    return {
      targets,
      readiness: { state, title, advice, why, fitness: lp.fitness, fatigue: lp.fatigue, form: lp.form, history_days },
      last,
      week,
      takeaways,
    };
  }

  /** One activity for the detail screen: merged detail, chart-ready streams, zones. */
  async activityView(id: string, points = 700) {
    const prof = await this.profile();
    const detail = await this.lib.activity(id);
    const streams = await this.lib.streams(id, ["time", "distance", "heartrate", "velocity", "altitude", "latlng", "cadence", "watts"], points).catch(() => null);
    const zones = await this.zonesFor(id, prof).catch(() => null);
    await this.saveHrCache();
    const row = (await this.lib.activities()).find((r) => r.id === detail.id);
    const load = row ? { ...this.trimp(row, prof), ...(await this.effortLabel(this.trimp(row, prof).load, zones)) } : null;
    return { detail, streams, zones, load, profile: { max_hr: prof.max_hr, zones_source: prof.zones_source } };
  }

  // ------------------------------------------------------------ takeaways

  async takeaways(): Promise<Takeaway[]> {
    const out: Takeaway[] = [];
    const prof = await this.profile();
    const rows = await this.lib.activities({ since: dayKey(Date.now() - 120 * DAY) });
    if (!rows.length) {
      return [{ id: "empty", tone: "info", title: "No recent activities yet", detail: "Sync Strava or back up the watch; takeaways appear once there is a few weeks of training." }];
    }

    // Freshness: the app's main job is getting data in.
    const last = rows[0]!;
    const daysSince = Math.floor((Date.now() - Date.parse(last.start)) / DAY);
    if (daysSince >= 4) out.push({ id: "gap", tone: "watch", title: `No activity in ${daysSince} days`, detail: `Last one: ${last.name ?? last.sport} on ${dayLabel(last.start)}. If you trained since, sync again.` });

    // Volume: this week so far vs the previous four complete weeks.
    const thisWeek = Date.parse(weekKey(Date.now()));
    const weekly = (from: number, to: number) => rows.filter((r) => Date.parse(r.start) >= from && Date.parse(r.start) < to).reduce((n, r) => n + (r.distance_km ?? 0), 0);
    const prev4 = [1, 2, 3, 4].map((w) => weekly(thisWeek - w * 7 * DAY, thisWeek - (w - 1) * 7 * DAY));
    const avg4 = mean(prev4);
    const lastWeek = prev4[0]!;
    if (avg4 > 0) {
      const change = pct(lastWeek, mean(prev4.slice(1)));
      if (Math.abs(change) >= 10) {
        out.push({
          id: "volume",
          tone: change > 30 ? "watch" : change > 0 ? "good" : "info",
          title: `Last week ${change > 0 ? "up" : "down"} ${Math.abs(change)}% in distance`,
          detail: `${round(lastWeek, 1)} km against ${round(mean(prev4.slice(1)), 1)} km on average over the three weeks before.${change > 30 ? " Jumps above about 30% raise injury risk." : ""}`,
        });
      }
    }

    // Load and form.
    const { series, today, history_days } = await this.load(60);
    const weekAgo = series.at(-8);
    // A ramp only means something once the 42-day average has had time to fill.
    if (weekAgo && history_days >= 42) {
      const ramp = round(today.fitness - weekAgo.fitness, 1)!;
      if (ramp >= 5) out.push({ id: "ramp", tone: "watch", title: "Training is ramping up fast", detail: `Your fitness score rose ${ramp} points in a week. Keep easy days easy and watch for niggles.` });
      else if (ramp <= -4) out.push({ id: "ramp", tone: "info", title: "Training has eased off", detail: `Your fitness score dropped ${Math.abs(ramp)} points in a week. Fine for a recovery or taper week.` });
    }
    const form = today.form;
    const formText =
      form < -30 ? ["watch", "Heavy fatigue", "Fatigue is well above fitness. Plan recovery before the next hard session."]
      : form < -10 ? ["good", "Productive training", "You are carrying fatigue from building fitness: the zone where adaptation happens."]
      : form <= 5 ? ["info", "Holding steady", "Fitness and fatigue are balanced."]
      : form <= 25 ? ["good", "Fresh", "Fatigue has cleared: a good moment for a key workout or a race."]
      : ["watch", "Losing fitness", "Load has been low for a while; fitness is starting to fade."];
    out.push({ id: "form", tone: formText[0] as Takeaway["tone"], title: `${formText[1]} (form ${form > 0 ? "+" : ""}${form})`, detail: `${formText[2]} Fitness ${today.fitness}, fatigue ${today.fatigue}.` });

    // Long run.
    const runs = rows.filter((r) => isFootSport(r.sport) && sportFamily(r.sport) === "run");
    const recent = runs.filter((r) => Date.parse(r.start) >= Date.now() - 14 * DAY);
    const longestRecent = recent.reduce<ActivityRow | null>((b, r) => (!b || (r.distance_km ?? 0) > (b.distance_km ?? 0) ? r : b), null);
    if (longestRecent?.distance_km) {
      const before = runs.filter((r) => Date.parse(r.start) < Date.now() - 14 * DAY);
      const longerBefore = before.find((r) => (r.distance_km ?? 0) >= longestRecent.distance_km!);
      if (!longerBefore && before.length) {
        out.push({ id: "long", tone: "good", title: `Longest run in ${Math.round((Date.now() - Date.parse(before.at(-1)!.start)) / (7 * DAY))} weeks`, detail: `${longestRecent.distance_km} km on ${dayLabel(longestRecent.start)}${longestRecent.avg_pace_min_km ? ` at ${longestRecent.avg_pace_min_km} /km` : ""}.`, activity: longestRecent.id });
      }
    }

    // Efficiency trend on easy runs.
    const eff = await this.efficiency(12);
    if (eff.length >= 6) {
      const early = mean(eff.slice(0, 3).map((e) => e.m_per_beat));
      const late = mean(eff.slice(-3).map((e) => e.m_per_beat));
      const change = pct(late, early);
      if (Math.abs(change) >= 3) {
        out.push({
          id: "efficiency",
          tone: change > 0 ? "good" : "watch",
          title: `Easy-run efficiency ${change > 0 ? "up" : "down"} ${Math.abs(change)}%`,
          detail: `${round(late, 2)} m per heartbeat in recent weeks against ${round(early, 2)} m two months ago${change > 0 ? ": the same effort carries you further." : ". Fatigue, heat or illness can do this."}`,
        });
      }
    }

    // Intensity distribution over four weeks.
    const z = await this.zonesOver(28);
    const total = z.zones.reduce((n, x) => n + x.seconds, 0);
    if (total > 3 * 3600) {
      const easy = (z.zones[0]!.seconds + z.zones[1]!.seconds) / total;
      const hard = (z.zones[3]!.seconds + z.zones[4]!.seconds) / total;
      out.push({
        id: "intensity",
        tone: easy >= 0.7 ? "good" : "watch",
        title: `${Math.round(easy * 100)}% easy, ${Math.round(hard * 100)}% hard over 4 weeks`,
        // Easy is zones 1–2, hard 4–5: say where the rest of the time went, not a guess.
        detail: easy >= 0.7 ? "Close to the 80/20 split most endurance plans aim for." : `${hard >= 0.5 ? "Most of your time is in the hard zones (4–5)" : "Most of your time is in the middle zones"}. More truly easy running (below ${easyCeiling(prof)} bpm) usually pays off.`,
      });
    }

    // Fresh personal bests.
    for (const b of await this.lib.bestEfforts("run")) {
      if (Date.parse(b.date) >= Date.now() - 14 * DAY) {
        out.push({ id: `pb-${b.name}`, tone: "good", title: `New best ${b.name}: ${fmtTime(b.time_s)}`, detail: `${b.pace_min_km ? `${b.pace_min_km} /km, ` : ""}set ${dayLabel(b.date)}.`, activity: b.activity, date: b.date });
      }
    }
    const order = { watch: 0, good: 1, info: 2 };
    for (const t of out) t.horizon = TREND_TAKEAWAYS.has(t.id) ? "trend" : "now";
    return out.sort((a, b) => order[a.tone] - order[b.tone]);
  }
}

export function weekKey(t: number): string {
  const d = new Date(dayKey(t) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** "4 h 10 min", "45 min". */
function fmtMin(m: number): string {
  const r = Math.round(m);
  return r >= 60 ? `${Math.floor(r / 60)} h${r % 60 ? ` ${r % 60} min` : ""}` : `${r} min`;
}

export function fmtTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
