/**
 * Health Connect (Android): what Tartan writes there and what it takes back.
 *
 * Out: each workout in the library as an exercise session (sport, name, route) with its heart
 * rate, distance and active energy; and the watch's 10-minute log (src/health.ts) as heart rate,
 * blood oxygen, resting heart rate, steps and active energy. Every record carries a client record
 * id ("tartan-…"), so writing it again updates it. A workout another app already put there (the
 * Suunto app, Strava) is left out: its time overlaps a session of theirs.
 *
 * In: sleep sessions with their stages, and HRV, from whichever app wrote them (the Suunto app
 * does when it's connected to Health Connect), kept in health/connect.json for the Body card; and
 * other apps' workouts with their heart rate, distance, speed and route, kept as FIT files in a
 * folder per app (hcWorkout, src/import.ts importWorkout), so any watch whose app writes to Health
 * Connect comes in without an account.
 *
 * The native side is android/app/src/main/java/dev/freesuunto/app/TartanHealthPlugin.kt; the
 * page drives it (web/lib/health-connect.ts).
 */
import { readJson, type Disk } from "./disk.ts";
import type { FitSample, FitWorkout } from "./fit-write.ts";
import { slug } from "./slug.ts";
import type { ActivityRow } from "./library.ts";
import { TREND_STEP_MS, type TrendRecord } from "./protocol/trends.ts";
import { healthDays } from "./health.ts";
import { localStamp, type SignalPut } from "./signals.ts";

export interface HcDevice {
  type: "watch" | "phone" | "unknown";
  manufacturer?: string;
  model?: string;
}
interface Base {
  /** Client record id: the same id updates the record. */
  id: string;
  version?: number;
  /** "active" for workouts, "auto" for what the watch logs by itself. */
  method: "active" | "auto";
  device: HcDevice;
}
export type HcRecord = Base &
  (
    | { type: "exercise"; start: number; end: number; exercise: string; title?: string; notes?: string; route?: Array<[number, number, number, number | null]> }
    | { type: "heartRate"; start: number; end: number; samples: Array<[number, number]> }
    | { type: "steps"; start: number; end: number; count: number }
    | { type: "distance"; start: number; end: number; meters: number }
    | { type: "activeCalories"; start: number; end: number; kcal: number }
    | { type: "oxygenSaturation"; time: number; percent: number }
    | { type: "restingHeartRate"; time: number; bpm: number }
  );

/** Health Connect's exercise type for a sport (Strava's names, or the watch's). */
export function exerciseType(sport: string): string {
  const s = sport.toLowerCase().replace(/[^a-z]/g, "");
  const table: Array<[RegExp, string]> = [
    [/virtualrun|treadmill/, "running_treadmill"],
    [/run/, "running"],
    [/virtualride|indoorcycl|spin/, "biking_stationary"],
    [/ride|cycl|bik/, "biking"],
    [/hike|trek/, "hiking"],
    [/walk/, "walking"],
    [/openwater/, "swimming_open_water"],
    [/swim/, "swimming_pool"],
    [/weight|lift/, "weightlifting"],
    [/strength|crossfit|gym/, "strength_training"],
    [/yoga/, "yoga"],
    [/pilates/, "pilates"],
    [/hiit|highintensity/, "hiit"],
    [/rowingmachine|indoorrow/, "rowing_machine"],
    [/row/, "rowing"],
    [/snowboard/, "snowboarding"],
    [/ski/, "skiing"],
    [/elliptical/, "elliptical"],
    [/stair/, "stair_climbing"],
    [/kayak|canoe|paddl/, "paddling"],
    [/skate/, "skating"],
    [/climb/, "rock_climbing"],
    [/soccer|football/, "soccer"],
    [/tennis/, "tennis"],
    [/badminton/, "badminton"],
    [/golf/, "golf"],
    [/surf/, "surfing"],
  ];
  return table.find(([re]) => re.test(s))?.[1] ?? "other";
}

/** "Suunto Run 2" → a watch made by Suunto; "Phone" → this phone; a bike computer → unknown. */
export function deviceOf(name: string | undefined): HcDevice {
  const n = (name ?? "").trim();
  if (!n) return { type: "unknown" };
  if (/phone|tartan/i.test(n)) return { type: "phone" };
  const m = /^(Suunto|Garmin|Polar|COROS|Apple|Amazfit|Fitbit|Wahoo)\s+(.+)$/i.exec(n);
  if (!m) return { type: "unknown", model: n };
  const model = m[2]!.replace(/\s+[0-9A-F]{6,}$/i, "");
  return { type: /edge|elemnt|bolt|roam|kickr/i.test(model) ? "unknown" : "watch", manufacturer: m[1], model };
}

/** A short fingerprint of what a workout write holds, to rewrite it when it changes. */
export function workoutKey(a: ActivityRow): string {
  return [a.start, a.sport, a.name ?? "", a.elapsed_min ?? "", a.distance_km ?? "", a.avg_hr ?? "", a.streams_from ?? ""].join("|");
}

type Columns = Record<string, unknown[]>;
const nums = (a: unknown[] | undefined, i: number) => (a && typeof a[i] === "number" ? (a[i] as number) : null);

/** A workout's records: the session, its heart rate (an hour a record), distance and energy. */
export function workoutRecords(a: ActivityRow, columns: Columns | null, version = 1): HcRecord[] {
  const start = Date.parse(a.start);
  const time = columns?.time;
  const lastT = time?.length ? nums(time, time.length - 1) : null;
  const seconds = Math.max(a.elapsed_min ? a.elapsed_min * 60 : 0, lastT ?? 0, 60);
  const end = start + Math.round(seconds * 1000);
  const device = deviceOf(a.device);
  const base = { method: "active" as const, device, version };
  const id = `tartan-w-${a.id}`;
  // The route: a point every 2 s at most, 5000 at most, inside the session.
  const route: Array<[number, number, number, number | null]> = [];
  const ll = columns?.latlng;
  if (time && ll) {
    let lastAt = -Infinity;
    const stride = Math.max(1, Math.ceil(ll.length / 5000));
    for (let i = 0; i < ll.length; i += stride) {
      const p = ll[i] as [number, number] | null;
      const t = nums(time, i);
      if (!Array.isArray(p) || t === null || t - lastAt < 2) continue;
      lastAt = t;
      route.push([start + Math.round(t * 1000), p[0], p[1], nums(columns?.altitude, i)]);
    }
  }
  const out: HcRecord[] = [
    {
      ...base,
      type: "exercise",
      id,
      start,
      end,
      exercise: exerciseType(a.sport),
      ...(a.name ? { title: a.name } : {}),
      notes: "From Tartan",
      ...(route.length > 1 ? { route: route.filter((r) => r[0] >= start && r[0] < end) } : {}),
    },
  ];
  // Heart rate: every sample, in records of an hour.
  const hr = columns?.heartrate;
  if (time && hr) {
    const byHour = new Map<number, Array<[number, number]>>();
    for (let i = 0; i < hr.length; i++) {
      const t = nums(time, i);
      const b = nums(hr, i);
      if (t === null || b === null || b < 25 || b > 250) continue;
      const k = Math.floor(t / 3600);
      (byHour.get(k) ?? byHour.set(k, []).get(k)!).push([start + Math.round(t * 1000), Math.round(b)]);
    }
    for (const [k, samples] of byHour) out.push({ ...base, type: "heartRate", id: `${id}-hr-${k}`, start: samples[0]![0], end: samples.at(-1)![0] + 1000, samples });
  }
  if (a.distance_km && a.distance_km > 0) out.push({ ...base, type: "distance", id: `${id}-dist`, start, end, meters: Math.round(a.distance_km * 1000) });
  if (a.calories && a.calories > 0) out.push({ ...base, type: "activeCalories", id: `${id}-kcal`, start, end, kcal: Math.round(a.calories) });
  return out;
}

/** Whether a workout overlaps another app's session by more than half of itself. */
export function coveredBy(a: { start: number; end: number }, others: Array<{ start: number; end: number }>): boolean {
  const len = a.end - a.start;
  return others.some((o) => Math.min(a.end, o.end) - Math.max(a.start, o.start) > len / 2);
}

export interface TrendKinds {
  /** Heart rate, blood oxygen, resting heart rate. */
  vitals: boolean;
  /** Steps and active energy. */
  activity: boolean;
}

/**
 * The watch's 10-minute log as records: heart rate a day a record (more samples as the day goes
 * on: its version is the count, so a later write replaces it), each blood-oxygen reading, each
 * day's resting heart rate (it only falls as the day goes on: its version rises as it does),
 * steps and active energy every 10 minutes.
 */
export function trendRecords(records: TrendRecord[], watch: string, kinds: TrendKinds, now = Date.now()): HcRecord[] {
  const base = { method: "auto" as const, device: { ...deviceOf(watch), type: "watch" as const } };
  const out: HcRecord[] = [];
  if (kinds.vitals) {
    const byDay = new Map<string, Array<[number, number]>>();
    for (const r of records) {
      if (r.hr === undefined) continue;
      const d = new Date(r.t);
      const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      (byDay.get(key) ?? byDay.set(key, []).get(key)!).push([r.t + TREND_STEP_MS / 2, r.hr]);
    }
    for (const [day, samples] of byDay) out.push({ ...base, type: "heartRate", id: `tartan-t-hr-${day}`, version: samples.length, start: samples[0]![0], end: samples.at(-1)![0] + 1000, samples });
    for (const r of records) if (r.spo2 !== undefined) out.push({ ...base, type: "oxygenSaturation", id: `tartan-t-spo2-${r.t}`, time: r.t + TREND_STEP_MS / 2, percent: r.spo2 });
    for (const d of healthDays(records, 400, now)) {
      if (d.resting_hr === null) continue;
      out.push({ ...base, type: "restingHeartRate", id: `tartan-t-rhr-${d.date}`, version: 300 - d.resting_hr, time: new Date(`${d.date}T07:00:00`).getTime(), bpm: d.resting_hr });
    }
  }
  if (kinds.activity) {
    for (const r of records) {
      if (r.steps > 0) out.push({ ...base, type: "steps", id: `tartan-t-steps-${r.t}`, start: r.t, end: r.t + TREND_STEP_MS, count: r.steps });
      if (r.energy_j > 0) out.push({ ...base, type: "activeCalories", id: `tartan-t-kcal-${r.t}`, start: r.t, end: r.t + TREND_STEP_MS, kcal: Math.round((r.energy_j / 4184) * 10) / 10 });
    }
  }
  return out;
}

// ------------------------------------------------------------------ what comes back

/** Health Connect's sleep stage numbers. */
const STAGE: Record<number, "awake" | "sleeping" | "out" | "light" | "deep" | "rem" | "unknown"> = { 0: "unknown", 1: "awake", 2: "sleeping", 3: "out", 4: "light", 5: "deep", 6: "rem", 7: "awake" };

export interface SleepSession {
  id: string;
  start: number;
  end: number;
  source: string;
  /** Minutes in each stage (asleep = everything but awake and out of bed). */
  minutes: { asleep: number; awake: number; light: number; deep: number; rem: number };
}
export interface HrvReading {
  t: number;
  ms: number;
  source: string;
}

/** A sleep session from Health Connect, its stages added up. */
export function sleepSession(s: { id: string; start: number; end: number; source: string; stages: Array<[number, number, number]> }): SleepSession {
  const m = { asleep: 0, awake: 0, light: 0, deep: 0, rem: 0 };
  for (const [a, b, n] of s.stages) {
    const min = (b - a) / 60_000;
    const st = STAGE[n] ?? "unknown";
    if (st === "awake" || st === "out") m.awake += min;
    else {
      m.asleep += min;
      if (st === "light" || st === "deep" || st === "rem") m[st] += min;
    }
  }
  // Without stages, the whole session counts as asleep.
  if (!s.stages.length) m.asleep = (s.end - s.start) / 60_000;
  const r = (x: number) => Math.round(x);
  return { id: s.id, start: s.start, end: s.end, source: s.source, minutes: { asleep: r(m.asleep), awake: r(m.awake), light: r(m.light), deep: r(m.deep), rem: r(m.rem) } };
}

const FILE = "health/connect.json";
export interface FromHealthConnect {
  sleep: Record<string, SleepSession>;
  hrv: HrvReading[];
  /** When Tartan last read from Health Connect (ms). */
  read_at?: number;
}

export class HealthConnectStore {
  constructor(private readonly disk: Disk) {}
  async get(): Promise<FromHealthConnect> {
    return (await readJson<FromHealthConnect>(this.disk, FILE)) ?? { sleep: {}, hrv: [] };
  }
  /** Keep what was read: sleep by id, HRV by time; 120 days of each. */
  async add(sleep: SleepSession[], hrv: HrvReading[], now = Date.now()): Promise<FromHealthConnect> {
    const cur = await this.get();
    const keep = now - 120 * 86400_000;
    for (const s of sleep) cur.sleep[s.id] = s;
    for (const [id, s] of Object.entries(cur.sleep)) if (s.end < keep) delete cur.sleep[id];
    const byT = new Map(cur.hrv.map((h) => [`${h.t}|${h.source}`, h]));
    for (const h of hrv) byT.set(`${h.t}|${h.source}`, h);
    cur.hrv = [...byT.values()].filter((h) => h.t >= keep).sort((a, b) => a.t - b.t);
    cur.read_at = now;
    await this.disk.write(FILE, JSON.stringify(cur));
    return cur;
  }
}

/** Local date of a moment. */
const dayOf = (t: number) => localStamp(t).slice(0, 10);

/**
 * What Health Connect holds as body-signal days (src/signals.ts), one a day with a night or HRV:
 * the night is the longest sleep that ended that day before 6 pm (its stages when it has them),
 * shorter sleeps ending that day are naps, and HRV is the average of the day's readings.
 * `dates` limits it to those days.
 */
export function hcSignalDays(hc: FromHealthConnect, dates?: Set<string>): SignalPut[] {
  const by = new Map<string, { sleep: SleepSession[]; hrv: number[] }>();
  const at = (d: string) => by.get(d) ?? by.set(d, { sleep: [], hrv: [] }).get(d)!;
  for (const s of Object.values(hc.sleep)) at(dayOf(s.end)).sleep.push(s);
  for (const h of hc.hrv) at(dayOf(h.t)).hrv.push(h.ms);
  const out: SignalPut[] = [];
  for (const [date, d] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    if (dates && !dates.has(date)) continue;
    const six = new Date(`${date}T18:00:00`).getTime();
    const night = d.sleep.filter((s) => s.end <= six).sort((a, b) => b.minutes.asleep - a.minutes.asleep)[0];
    const naps = d.sleep.filter((s) => s !== night && s.minutes.asleep < 180);
    const staged = !!night && night.minutes.light + night.minutes.deep + night.minutes.rem > 0;
    const put: SignalPut = { date, source: "health_connect" };
    if (night) {
      Object.assign(put, { sleep_start: localStamp(night.start), sleep_end: localStamp(night.end), sleep_min: night.minutes.asleep });
      if (staged) Object.assign(put, { deep_min: night.minutes.deep, light_min: night.minutes.light, rem_min: night.minutes.rem, awake_min: night.minutes.awake });
    }
    if (naps.length) put.nap_min = naps.reduce((n, s) => n + s.minutes.asleep, 0);
    if (d.hrv.length) put.hrv_ms = Math.round(d.hrv.reduce((a, b) => a + b, 0) / d.hrv.length);
    if (Object.keys(put).length > 2) out.push(put);
  }
  return out;
}

// ------------------------------------------------------------------ other apps' workouts, in full

/**
 * A workout another app put in Health Connect (Samsung Health, the Suunto app, Fitbit, Coros,
 * Polar…), with what came with it: heart rate, distance, speed and the route (where Health Connect
 * lets Tartan read it). `sport` is Health Connect's name (TartanHealthPlugin.exerciseName).
 */
export interface HcSession {
  id: string;
  start: number;
  end: number;
  /** The app that wrote it: package and name. */
  source: string;
  app?: string;
  sport: string;
  title?: string;
  /** [time ms, bpm] */
  hr?: Array<[number, number]>;
  /** [start ms, end ms, metres] */
  distance?: Array<[number, number, number]>;
  /** [time ms, m/s] */
  speed?: Array<[number, number]>;
  /** [time ms, lat, lon, altitude m | null] */
  route?: Array<[number, number, number, number | null]>;
  calories?: number;
}

/** Health Connect's sport to FIT's. */
export function fitSport(hc: string): string {
  const s = hc.toLowerCase();
  if (s.startsWith("running")) return "running";
  if (s.startsWith("biking")) return "cycling";
  if (s.startsWith("swimming")) return "swimming";
  if (s.startsWith("rowing")) return "rowing";
  if (/strength|weightlifting|calisthenics|hiit|pilates|yoga/.test(s)) return "training";
  if (s === "skiing") return "alpine_skiing";
  if (["walking", "hiking", "paddling"].includes(s)) return s;
  return "generic";
}

/**
 * The workout as samples: one per moment anything was measured (a route point, a heart-rate or a
 * speed reading), heart rate and speed carried a few seconds to the moments around them, distance
 * from the start added up from the distance records (else along the route).
 */
export function hcWorkout(s: HcSession): FitWorkout {
  const times = new Set<number>();
  for (const p of s.route ?? []) times.add(p[0]);
  for (const p of s.hr ?? []) times.add(p[0]);
  for (const p of s.speed ?? []) times.add(p[0]);
  const ts = [...times].filter((t) => t >= s.start - 60_000 && t <= s.end + 60_000).sort((a, b) => a - b);
  // Thinned to at most one a second (a phone's GPS and an optical sensor both run faster).
  const kept: number[] = [];
  for (const t of ts) if (!kept.length || t - kept.at(-1)! >= 1000) kept.push(t);
  const at = <T extends [number, ...unknown[]]>(list: T[] | undefined, within: number) => {
    const sorted = [...(list ?? [])].sort((a, b) => a[0] - b[0]);
    let i = 0;
    return (t: number): T | undefined => {
      while (i + 1 < sorted.length && sorted[i + 1]![0] <= t) i++;
      const p = sorted[i];
      return p && p[0] <= t && t - p[0] <= within ? p : undefined;
    };
  };
  const hrAt = at(s.hr, 15_000);
  const speedAt = at(s.speed, 10_000);
  const routeAt = at(s.route, 0);
  // Distance so far: whole records before t, and the part of the one t falls in.
  const dist = [...(s.distance ?? [])].sort((a, b) => a[0] - b[0]);
  const distAt = (t: number): number | undefined => {
    if (!dist.length) return undefined;
    let d = 0;
    for (const [a, b, m] of dist) {
      if (b <= t) d += m;
      else if (a < t) d += (m * (t - a)) / Math.max(1, b - a);
    }
    return d;
  };
  const samples: FitSample[] = kept.map((t) => {
    const r = routeAt(t);
    const h = hrAt(t);
    const v = speedAt(t);
    return {
      t,
      ...(r ? { lat: r[1], lon: r[2], ...(r[3] !== null ? { altitude: r[3] } : {}) } : {}),
      ...(h ? { hr: h[1] } : {}),
      ...(v ? { speed: v[1] } : {}),
      ...(dist.length ? { distance: distAt(t) } : {}),
    };
  });
  const total = dist.reduce((n, [, , m]) => n + m, 0);
  return { start: s.start, end: s.end, sport: fitSport(s.sport), ...(total > 0 ? { distance_m: total } : {}), ...(s.calories ? { calories: Math.round(s.calories) } : {}), samples };
}

/** The folder a source app's workouts go in ("hc-samsung-health", named "Samsung Health via Health Connect"). */
export function hcFolder(s: HcSession): { id: string; name: string } {
  const name = s.app || s.source.split(".").slice(-2).join(" ");
  return { id: `hc-${slug(name)}`.slice(0, 48), name: `${name} via Health Connect` };
}
