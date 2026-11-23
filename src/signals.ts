/**
 * Body signals: one place for each day's recovery and sleep signals, whichever brand or app
 * supplied them. Features (readiness and the morning check, Today, the coach) read only from here;
 * each source writes through `Signals.put` (the engine's `signalsPut` call, PUT /api/signals).
 *
 * A day belongs to the morning it ends in: the night that ended on the 14th, its HRV and lowest
 * heart rate, the resting heart rate and the energy on waking that morning are all the 14th's.
 * Each source keeps its own record per day; reading merges them field by field, and every merged
 * value keeps the name of the source it came from (`from`), so the screens and the coach can say
 * where a number came from. docs/signals.md says how a new source feeds the layer.
 *
 * Kept in health/signals.json (the engine's own storage, as the check-ins are), about a year.
 */
import { readJson, type Disk } from "./disk.ts";
import type { BodySigns } from "./readiness.ts";

/**
 * Who supplied a value: a watch's own feed (Garmin's watch app, Suunto's), a phone's health store,
 * the demo's sample, or `told`: the athlete said it (in chat or the morning check).
 */
export const SIGNAL_SOURCES = ["told", "garmin", "suunto", "health_connect", "apple_health", "sample"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];
export type WatchBrand = "garmin" | "suunto";

/** A stress level, for a source that gives a level rather than a number. */
export const STRESS_LEVELS = ["low", "medium", "high"] as const;
export type StressLevel = (typeof STRESS_LEVELS)[number];

/**
 * One day's signals. Every field is optional: a source sends what it has, and a missing field is
 * never shown or guessed. Units are fixed here; a source's mapping converts to them.
 */
export interface SignalValues {
  // ---- Sleep: the main night, the one that ended on the morning of `date`
  /** Into bed (or asleep, when the source doesn't say), local time "YYYY-MM-DDTHH:MM". */
  sleep_start?: string;
  /** Up for the day, local time "YYYY-MM-DDTHH:MM". */
  sleep_end?: string;
  /** Minutes asleep: light, deep and REM together, not the time awake in between. */
  sleep_min?: number;
  /** Minutes in each stage. */
  deep_min?: number;
  light_min?: number;
  rem_min?: number;
  /** Minutes awake between falling asleep and getting up (wake after sleep onset). */
  awake_min?: number;
  /** Minutes from going to bed to falling asleep (sleep onset latency). */
  latency_min?: number;
  /** The source's own sleep score, 0 (poor) to 100 (great). */
  sleep_score?: number;
  /** Minutes asleep in naps that day (outside the main night). */
  nap_min?: number;
  /** The night was estimated from heart rate and stillness, not tracked as sleep: any tracked night wins over it. */
  sleep_estimated?: boolean;
  // ---- The night
  /** Lowest heart rate overnight, bpm. */
  night_hr_min?: number;
  /** Average heart rate overnight, bpm. */
  night_hr_avg?: number;
  /** Heart-rate variability overnight: RMSSD in ms (the night's average, or the morning reading). Not SDNN. */
  hrv_ms?: number;
  /** Highest blood oxygen overnight, percent. */
  spo2_max?: number;
  /** Average breathing rate overnight, breaths a minute. */
  breathing_rate?: number;
  // ---- The morning
  /** Resting heart rate for the day, bpm. */
  resting_hr?: number;
  /**
   * Energy on waking, 0 (drained) to 100 (fully charged): Garmin's Body Battery and Suunto's
   * Resources (Balance) both map here, as they stood when the day began.
   */
  energy?: number;
  /** The day's average stress, 0 (calm) to 100 (very stressed). */
  stress?: number;
  /** Stress as a level, for a source that gives one instead of (or besides) a number. */
  stress_level?: StressLevel;
  /** Hours of recovery still to go that morning (the watch's recovery time), 0 when recovered. */
  recovery_h?: number;
  /** VO2 max for running, ml/kg/min: the estimate as of that day. */
  vo2max?: number;
}
export type SignalField = keyof SignalValues;

/** What a source sends for one day: the date, who it is, and what it has (null clears a field it sent before). */
export type SignalPut = { date: string; source: SignalSource } & { [K in SignalField]?: SignalValues[K] | null };

/** A day as features read it: the merged values and, for each, where it came from. */
export type SignalDay = SignalValues & { date: string; from: Partial<Record<SignalField, SignalSource>> };

/** The usual (median of the four weeks before a day), for what readiness compares against. */
export interface SignalUsual {
  hrv_ms: number | null;
  resting_hr: number | null;
  energy: number | null;
  sleep_min: number | null;
  breathing_rate: number | null;
}

/** Each field: a number's range (values outside it are refused), or its kind. */
const RANGE: Record<SignalField, [number, number] | "time" | "bool" | "level"> = {
  sleep_start: "time",
  sleep_end: "time",
  sleep_min: [0, 24 * 60],
  deep_min: [0, 24 * 60],
  light_min: [0, 24 * 60],
  rem_min: [0, 24 * 60],
  awake_min: [0, 24 * 60],
  latency_min: [0, 12 * 60],
  sleep_score: [0, 100],
  nap_min: [0, 24 * 60],
  sleep_estimated: "bool",
  night_hr_min: [20, 200],
  night_hr_avg: [20, 200],
  hrv_ms: [1, 400],
  spo2_max: [50, 100],
  breathing_rate: [3, 60],
  resting_hr: [20, 200],
  energy: [0, 100],
  stress: [0, 100],
  stress_level: "level",
  recovery_h: [0, 240],
  vo2max: [10, 100],
};
export const SIGNAL_FIELDS = Object.keys(RANGE) as SignalField[];

/** The night's fields, taken together from one source so stages and totals always agree. */
export const SLEEP_GROUP: SignalField[] = ["sleep_start", "sleep_end", "sleep_min", "deep_min", "light_min", "rem_min", "awake_min", "latency_min", "sleep_estimated"];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** A value as kept, or undefined when it isn't one (wrong kind, out of range). One decimal at most. */
function clean(field: SignalField, v: unknown): SignalValues[SignalField] | undefined {
  const r = RANGE[field];
  if (r === "time") return typeof v === "string" && TIME.test(v) ? v : undefined;
  if (r === "bool") return v === true ? true : undefined;
  if (r === "level") return STRESS_LEVELS.includes(v as StressLevel) ? (v as StressLevel) : undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < r[0] || v > r[1]) return undefined;
  return Math.round(v * 10) / 10;
}

/**
 * The order sources win in, best first: what the athlete told, then the connected watch's brand
 * (the watch that reported last), the other watch brand, the phone's health stores, the sample.
 */
export function priority(watch: WatchBrand | null): SignalSource[] {
  const first: WatchBrand = watch ?? "garmin";
  return ["told", first, first === "garmin" ? "suunto" : "garmin", "health_connect", "apple_health", "sample"];
}

/** One day's records, one per source, merged: each field from the best source that has it; the night as one. */
export function mergeDay(date: string, bySource: Partial<Record<SignalSource, SignalValues>>, watch: WatchBrand | null = null): SignalDay {
  const order = priority(watch).filter((s) => bySource[s]);
  const out: SignalDay = { date, from: {} };
  const set = (f: SignalField, s: SignalSource) => {
    const v = bySource[s]![f];
    if (v === undefined) return;
    (out as unknown as Record<string, unknown>)[f] = v;
    out.from[f] = s;
  };
  // The night: a tracked night beats an estimated one, then the order.
  const nights = order.filter((s) => bySource[s]!.sleep_min !== undefined);
  const night = nights.find((s) => !bySource[s]!.sleep_estimated) ?? nights[0];
  if (night) for (const f of SLEEP_GROUP) set(f, night);
  for (const f of SIGNAL_FIELDS) {
    if (SLEEP_GROUP.includes(f)) continue;
    const s = order.find((x) => bySource[x]![f] !== undefined);
    if (s) set(f, s);
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : null;
};

/** Days before `date` that count towards its usual. */
export const USUAL_DAYS = 28;
/** Fewest days with a value for a usual to mean anything. */
export const USUAL_MIN = 3;

/**
 * The usual before `date`: the median of each field over the 28 days before it (that day itself
 * left out), once 3 or more days have it. The one place baselines are worked out.
 */
export function usualBefore(days: SignalDay[], date: string): SignalUsual {
  const from = new Date(Date.parse(`${date}T12:00:00Z`) - USUAL_DAYS * 86400_000).toISOString().slice(0, 10);
  const span = days.filter((d) => d.date < date && d.date >= from);
  const of = (f: "hrv_ms" | "resting_hr" | "energy" | "sleep_min" | "breathing_rate", digits = 0) => {
    const xs = span.flatMap((d) => (typeof d[f] === "number" && !(f === "sleep_min" && d.sleep_estimated) ? [d[f] as number] : []));
    const m = xs.length >= USUAL_MIN ? median(xs) : null;
    return m === null ? null : Math.round(m * 10 ** digits) / 10 ** digits;
  };
  return { hrv_ms: of("hrv_ms"), resting_hr: of("resting_hr"), energy: of("energy"), sleep_min: of("sleep_min"), breathing_rate: of("breathing_rate", 1) };
}

/** How long a day is kept. */
export const KEEP_DAYS = 400;
const FILE = "health/signals.json";

interface Stored {
  v: 1;
  /** date → source → its values, and when they came (ms). */
  days: Record<string, Partial<Record<SignalSource, SignalValues & { at?: number }>>>;
  /** The watch brand that reported last: the connected watch, whose values win. */
  watch?: WatchBrand;
}

/** Writes to one storage, one at a time (two feeds at once must not lose each other's day). */
const queues = new WeakMap<Disk, Promise<unknown>>();

export class Signals {
  constructor(private readonly disk: Disk) {}

  private async stored(): Promise<Stored> {
    const s = await readJson<Stored>(this.disk, FILE);
    return s && s.v === 1 && s.days ? s : { v: 1, days: {} };
  }

  /**
   * Add or change days from a source. Each field given replaces that source's value for the day,
   * null clears it, a field left out stays as it was. Refuses a day without a date or a known
   * source; a value of the wrong kind or out of range is dropped (and named in `dropped`).
   * With `replace`, what's sent is the source's whole day (a feed that works days out afresh).
   * Returns the days as they now read, merged.
   */
  async put(days: SignalPut[], opts: { replace?: boolean; now?: number } = {}): Promise<{ days: SignalDay[]; dropped: string[] }> {
    const now = opts.now ?? Date.now();
    for (const d of days) {
      if (!d || typeof d !== "object" || !DATE.test(String(d.date)) || !SIGNAL_SOURCES.includes(d.source)) throw new Error("signals: each day needs a date (YYYY-MM-DD) and a source (" + SIGNAL_SOURCES.join(", ") + ")");
    }
    const run = async () => {
      const s = await this.stored();
      const dropped: string[] = [];
      let changed = false;
      for (const d of days) {
        const day = s.days[d.date] ?? {};
        const { at: _at, ...kept }: SignalValues & { at?: number } = { ...(day[d.source] ?? {}) };
        const before = canonical(kept);
        const cur: SignalValues = opts.replace ? {} : kept;
        for (const [k, v] of Object.entries(d)) {
          if (k === "date" || k === "source") continue;
          if (!(k in RANGE)) {
            dropped.push(`${d.date} ${k}`);
            continue;
          }
          const f = k as SignalField;
          if (v === null || (f === "sleep_estimated" && v === false)) {
            delete cur[f];
            continue;
          }
          const c = clean(f, v);
          if (c === undefined) dropped.push(`${d.date} ${f}`);
          else (cur as Record<string, unknown>)[f] = c;
        }
        if (canonical(cur) === before) continue;
        changed = true;
        if (Object.keys(cur).length) day[d.source] = { ...cur, at: now };
        else delete day[d.source];
        if (Object.keys(day).length) s.days[d.date] = day;
        else delete s.days[d.date];
        // New values from a watch, for a day as late as the other brand's latest: that's the watch now.
        if ((d.source === "garmin" || d.source === "suunto") && Object.keys(cur).length && d.date >= (latestDate(s, d.source === "garmin" ? "suunto" : "garmin") ?? "")) s.watch = d.source;
      }
      if (changed) {
        // About a year.
        const keep = new Date(now - KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
        for (const k of Object.keys(s.days)) if (k < keep) delete s.days[k];
        await this.disk.write(FILE, JSON.stringify(s));
      }
      const dates = [...new Set(days.map((d) => d.date))];
      return { days: dates.flatMap((k) => (s.days[k] ? [mergeDay(k, s.days[k]!, s.watch ?? null)] : [])), dropped };
    };
    const next = (queues.get(this.disk) ?? Promise.resolve()).catch(() => {}).then(run);
    queues.set(this.disk, next);
    return next;
  }

  /** Every day kept, merged, newest first; `since` (YYYY-MM-DD) to stop there. */
  async days(since?: string): Promise<SignalDay[]> {
    await (queues.get(this.disk) ?? Promise.resolve()).catch(() => {});
    const s = await this.stored();
    return Object.keys(s.days)
      .filter((k) => !since || k >= since)
      .sort((a, b) => b.localeCompare(a))
      .map((k) => mergeDay(k, s.days[k]!, s.watch ?? null));
  }

  /** One day, merged (null when nothing was sent for it), with the usual before it. */
  async day(date: string): Promise<{ day: SignalDay | null; usual: SignalUsual }> {
    const since = new Date(Date.parse(`${date}T12:00:00Z`) - (USUAL_DAYS + 1) * 86400_000).toISOString().slice(0, 10);
    const all = (await this.days(since)).filter((d) => d.date <= date);
    return { day: all.find((d) => d.date === date) ?? null, usual: usualBefore(all, date) };
  }

  /** The connected watch's brand, as the signals know it (the watch that reported last). */
  async watch(): Promise<WatchBrand | null> {
    return (await this.stored()).watch ?? null;
  }

  /** What one source sent, by day (for a feed to see what it sent; features read `days`). */
  async from(source: SignalSource): Promise<Record<string, SignalValues>> {
    const s = await this.stored();
    return Object.fromEntries(Object.entries(s.days).flatMap(([k, d]) => (d[source] ? [[k, (({ at: _a, ...v }) => v)(d[source]!)]] : [])));
  }
}

/** A source's values as text, keys sorted: to tell whether anything changed. */
const canonical = (v: SignalValues) => JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));

function latestDate(s: Stored, source: SignalSource): string | null {
  return Object.keys(s.days).filter((k) => s.days[k]![source]).sort().at(-1) ?? null;
}

/** "7 h 05". */
export function hm(min: number): string {
  return `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")}`;
}

/** A source in words, for the screens and the coach ("your Garmin", "Health Connect"). */
export const SOURCE_NAME: Record<SignalSource, string> = {
  told: "what you said",
  garmin: "your Garmin",
  suunto: "your Suunto",
  health_connect: "Health Connect",
  apple_health: "Apple Health",
  sample: "the sample data",
};

/** Local time of a moment, "YYYY-MM-DDTHH:MM" (the sleep fields' form). */
export function localStamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** What readiness reads from a day and its usual (src/readiness.ts BodySigns). */
export function bodySignsOf(day: SignalDay | null, usual: SignalUsual): BodySigns {
  const n = (x: number | undefined) => (typeof x === "number" ? x : null);
  const staged = day?.deep_min !== undefined || day?.light_min !== undefined || day?.rem_min !== undefined;
  return {
    resting_hr: n(day?.resting_hr),
    resting_baseline: usual.resting_hr,
    sleep_min: n(day?.sleep_min),
    hrv_ms: n(day?.hrv_ms),
    hrv_baseline: usual.hrv_ms,
    deep_min: staged ? n(day?.deep_min) ?? 0 : null,
    awake_min: n(day?.awake_min),
    sleep_score: n(day?.sleep_score),
    energy: n(day?.energy),
    energy_baseline: usual.energy,
    recovery_h: n(day?.recovery_h),
    breathing_rate: n(day?.breathing_rate),
    breathing_baseline: usual.breathing_rate,
  };
}
