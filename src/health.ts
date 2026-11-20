/**
 * Health from the watch: its 10-minute trend log (protocol/trends.ts) gathered into days.
 *
 * Each connection saves the records it hadn't saved before as one file under the watch's backup
 * (files/daily/trends/<first record ms>.json), so the phone's copy to the PC carries them too.
 * A day then gives: resting heart rate (the lowest half hour while still), the range of heart
 * rate while worn, steps and active energy, blood-oxygen readings, and the night's rest,
 * estimated from heart rate and stillness until the watch's own sleep record can be read.
 */
import { joinPath, readJson, type Disk } from "./disk.ts";
import { TREND_STEP_MS, type TrendRecord } from "./protocol/trends.ts";
import { HealthConnectStore, type FromHealthConnect, type SleepSession } from "./health-connect.ts";

export const TRENDS_DIR = "/daily/trends";

export interface Night {
  /** Local times, "2026-10-18T00:40". */
  start: string;
  end: string;
  minutes: number;
  hr_avg: number;
  hr_min: number;
  /** From heart rate and stillness, not the watch's sleep tracking. */
  estimated: true;
}

export interface HealthDay {
  date: string;
  /** Minutes the watch had heart rate. */
  worn_min: number;
  resting_hr: number | null;
  hr_min: number | null;
  hr_avg: number | null;
  hr_max: number | null;
  steps: number;
  active_kcal: number;
  spo2: Array<{ at: string; pct: number }>;
  /** The night that ended this morning, estimated from the watch's log. */
  night: Night | null;
  /** The night that ended this morning as another app recorded it (via Health Connect). */
  sleep: SleepSession | null;
  /** Average HRV (RMSSD, ms) of the day's readings from Health Connect. */
  hrv_ms: number | null;
}

export interface HealthView {
  days: HealthDay[];
  /** Usual resting heart rate: the median of the 14 days before today, with 3 or more. */
  resting_baseline: number | null;
  /** Today's heart rate every 10 minutes, for a sparkline (null where not worn). */
  today_hr: Array<number | null>;
  latest: { at: string; hr?: number; spo2?: number } | null;
  /** The newest record saved (ms), or 0. */
  last_t: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local date and time of a moment. */
export const localDate = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localTime = (t: number) => {
  const d = new Date(t);
  return `${localDate(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : null;
};
const STILL = 20;

/** The lowest average of three back-to-back still 10-minute records with heart rate. */
export function restingHr(records: TrendRecord[]): number | null {
  let best: number | null = null;
  for (let i = 2; i < records.length; i++) {
    const w = records.slice(i - 2, i + 1);
    if (w.some((r) => r.hr === undefined || r.steps > STILL)) continue;
    if (w[2]!.t - w[0]!.t !== 2 * TREND_STEP_MS) continue;
    const avg = (w[0]!.hr! + w[1]!.hr! + w[2]!.hr!) / 3;
    if (best === null || avg < best) best = avg;
  }
  return best === null ? null : Math.round(best);
}

/**
 * The night's rest ending on `date`: the longest still stretch with heart rate between 8 pm the
 * evening before and noon, with one restless 10 minutes allowed at a time; 3 hours or more.
 */
export function nightOf(records: TrendRecord[], date: string): Night | null {
  const noon = new Date(`${date}T12:00:00`).getTime();
  const from = noon - 16 * 3600_000;
  const rs = records.filter((r) => r.t >= from && r.t < noon);
  let best: TrendRecord[] = [];
  let run: TrendRecord[] = [];
  let slips = 0;
  const still = (r: TrendRecord) => r.hr !== undefined && r.steps <= STILL;
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]!;
    const gap = run.length ? r.t - run.at(-1)!.t : 0;
    if (run.length && gap > 2 * TREND_STEP_MS) {
      run = [];
      slips = 0;
    }
    if (still(r)) {
      run.push(r);
      slips = 0;
    } else if (run.length && slips === 0 && i + 1 < rs.length && still(rs[i + 1]!)) slips = 1;
    else {
      run = [];
      slips = 0;
    }
    // Trim the run's end to its last still record when comparing.
    if (run.length > best.length) best = [...run];
  }
  if (best.length * 10 < 180) return null;
  const hrs = best.map((r) => r.hr!);
  const end = best.at(-1)!.t + TREND_STEP_MS;
  return {
    start: localTime(best[0]!.t),
    end: localTime(end),
    minutes: Math.round((end - best[0]!.t) / 60_000),
    hr_avg: Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length),
    hr_min: Math.min(...hrs),
    estimated: true,
  };
}

/** The longest sleep that ended on `date` before 6 pm (local). */
export function sleepOf(sessions: SleepSession[], date: string): SleepSession | null {
  const from = new Date(`${date}T00:00:00`).getTime();
  const to = new Date(`${date}T18:00:00`).getTime();
  return sessions.filter((s) => s.end > from && s.end <= to).sort((a, b) => b.minutes.asleep - a.minutes.asleep)[0] ?? null;
}

/** Records gathered into local days, newest first, for the last `days` days. */
export function healthDays(records: TrendRecord[], days = 14, now = Date.now(), hc: FromHealthConnect | null = null): HealthDay[] {
  const out: HealthDay[] = [];
  const byDay = new Map<string, TrendRecord[]>();
  for (const r of records) {
    const d = localDate(r.t);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(r);
  }
  for (let i = 0; i < days; i++) {
    const date = localDate(now - i * 86400_000);
    const rs = byDay.get(date) ?? [];
    const night = nightOf(records, date);
    const sleep = hc ? sleepOf(Object.values(hc.sleep), date) : null;
    const hrv = (hc?.hrv ?? []).filter((h) => localDate(h.t) === date).map((h) => h.ms);
    if (!rs.length && !night && !sleep && !hrv.length) continue;
    const hrs = rs.flatMap((r) => (r.hr === undefined ? [] : [r.hr]));
    out.push({
      date,
      worn_min: hrs.length * 10,
      resting_hr: restingHr(rs),
      hr_min: hrs.length ? Math.min(...hrs) : null,
      hr_avg: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
      hr_max: hrs.length ? Math.max(...hrs) : null,
      steps: rs.reduce((n, r) => n + r.steps, 0),
      active_kcal: Math.round(rs.reduce((n, r) => n + r.energy_j, 0) / 4184),
      spo2: rs.flatMap((r) => (r.spo2 === undefined ? [] : [{ at: localTime(r.t), pct: r.spo2 }])),
      night,
      sleep,
      hrv_ms: hrv.length ? Math.round(hrv.reduce((a, b) => a + b, 0) / hrv.length) : null,
    });
  }
  return out;
}

export function healthView(records: TrendRecord[], now = Date.now(), hc: FromHealthConnect | null = null): HealthView {
  const days = healthDays(records, 15, now, hc);
  const today = localDate(now);
  const before = days.filter((d) => d.date !== today).flatMap((d) => (d.resting_hr === null ? [] : [d.resting_hr]));
  const start = new Date(`${today}T00:00:00`).getTime();
  const slots = Math.min(144, Math.ceil((now - start) / TREND_STEP_MS));
  const at = new Map(records.filter((r) => r.t >= start).map((r) => [Math.floor((r.t - start) / TREND_STEP_MS), r.hr ?? null]));
  const last = records.at(-1);
  const lastHr = [...records].reverse().find((r) => r.hr !== undefined);
  const lastOx = [...records].reverse().find((r) => r.spo2 !== undefined);
  const latest = last ? { at: localTime(Math.max(lastHr?.t ?? 0, lastOx?.t ?? 0) || last.t), ...(lastHr ? { hr: lastHr.hr } : {}), ...(lastOx ? { spo2: lastOx.spo2 } : {}) } : null;
  return {
    days: days.slice(0, 14),
    resting_baseline: before.length >= 3 ? Math.round(median(before)!) : null,
    today_hr: Array.from({ length: slots }, (_, i) => at.get(i) ?? null),
    latest,
    last_t: last?.t ?? 0,
  };
}

/** The saved trend records, from every watch's backup. */
export class Health {
  constructor(private readonly disk: Disk) {}

  async records(sinceMs = 0): Promise<TrendRecord[]> {
    const byTime = new Map<number, TrendRecord>();
    const watches = (await this.disk.list("watches").catch(() => [])).filter((e) => e.dir);
    for (const w of watches) {
      const dir = joinPath("watches", w.name, "files", TRENDS_DIR);
      for (const f of await this.disk.list(dir).catch(() => [])) {
        const first = Number(f.name.replace(/\.json$/, ""));
        // A file holds a day at most: skip the ones that end before `sinceMs`.
        if (f.dir || !Number.isFinite(first) || first < sinceMs - 2 * 86400_000) continue;
        try {
          // Saved as bytes (the watch-file route), so read as bytes: phone storage doesn't
          // turn bytes into text.
          const raw = await this.disk.read(joinPath(dir, f.name));
          const rs = raw ? (JSON.parse(new TextDecoder().decode(raw)) as TrendRecord[]) : [];
          for (const r of rs) if (r.t >= sinceMs) byTime.set(r.t, r);
        } catch {
          // a torn file
        }
      }
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }

  async view(now = Date.now()): Promise<HealthView> {
    return healthView(await this.records(now - 17 * 86400_000), now, await new HealthConnectStore(this.disk).get());
  }

  /** The name of the watch the saved log came from (the first one with any). */
  async watchName(): Promise<string> {
    for (const w of (await this.disk.list("watches").catch(() => [])).filter((e) => e.dir)) {
      if (!(await this.disk.list(joinPath("watches", w.name, "files", TRENDS_DIR)).catch(() => [])).length) continue;
      const info = await readJson<{ name?: string }>(this.disk, joinPath("watches", w.name, "info.json"));
      return info?.name ?? w.name;
    }
    return "Suunto watch";
  }
}

/**
 * The records worth saving from a read: settled ones (the watch still fills in the newest for a
 * while) newer than the last saved.
 */
export function newRecords(read: TrendRecord[], lastSaved: number, now = Date.now()): TrendRecord[] {
  return read.filter((r) => r.t > lastSaved && r.t + 2 * TREND_STEP_MS <= now);
}

/** Today's signs for readiness: resting heart rate against the usual, and last night's sleep. */
export function bodySigns(h: HealthView, now = Date.now()): { resting_hr: number | null; resting_baseline: number | null; sleep_min: number | null; hrv_ms: number | null; hrv_baseline: number | null } {
  const date = localDate(now);
  const today = h.days.find((d) => d.date === date);
  const before = h.days.filter((d) => d.date !== date && d.hrv_ms !== null).map((d) => d.hrv_ms!);
  return {
    resting_hr: today?.resting_hr ?? null,
    resting_baseline: h.resting_baseline,
    sleep_min: today?.sleep?.minutes.asleep ?? today?.night?.minutes ?? null,
    hrv_ms: today?.hrv_ms ?? null,
    hrv_baseline: before.length >= 3 ? Math.round(median(before)!) : null,
  };
}
