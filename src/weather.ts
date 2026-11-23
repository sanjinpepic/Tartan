/**
 * Weather for training, from Open-Meteo (free, no key): the forecast at each session's time, and
 * what a past run was run in. Where: the start of your latest run with GPS, rounded to about a
 * kilometre (no location permission, and no more precision leaves the device than a town needs).
 *
 * Heat is judged as runners do, by temperature plus dew point in °F (Hadley's table): up to 100
 * nothing; past 180, hard running is not advised. In between, the pace to give up for the same effort.
 */
import { readJson } from "./disk.ts";
import type { Library } from "./library.ts";
import { Plans } from "./plan.ts";
import { readPrefs, slots, type BadWeather, type Slot } from "./schedule.ts";

const FORECAST = "https://api.open-meteo.com/v1/forecast";
export const PAST = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const CACHE = "cache/weather.json";
/** What's asked for each hour (forecast and the past days alike). */
export const HOURLY = "temperature_2m,dew_point_2m,precipitation_probability,precipitation,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,is_day";
const HOUR = 3_600_000;

export interface Hour {
  /** Local wall-clock "YYYY-MM-DDTHH:MM" where you run (forecast), or UTC (past). */
  time: string;
  temp_c: number;
  dew_c: number;
  rain_pct?: number;
  wind_kmh?: number;
  /** Rain (or snow as water) in that hour, mm. */
  rain_mm?: number;
  /** Gusts, km/h. */
  gust_kmh?: number;
  /** The WMO weather code (61 rain, 65 heavy rain, 66 freezing rain, 75 heavy snow, 95 thunderstorm…). */
  code?: number;
  /** Snow that hour, cm. */
  snow_cm?: number;
  /** Daylight (false: dark). */
  day?: boolean;
  /** Feels like (apparent temperature), °C, when asked for. */
  feels_c?: number;
}

export interface Heat {
  /** Temperature plus dew point, °F. */
  sum_f: number;
  /** Pace to give up for the same effort, % (low and high end), or null when it makes no difference. */
  slow_pct: [number, number] | null;
  /** Past 180: run easy or move the session. */
  too_hot: boolean;
}

const F = (c: number) => (c * 9) / 5 + 32;
const TABLE: Array<[number, [number, number]]> = [
  [110, [0, 0.5]],
  [120, [0.5, 1]],
  [130, [1, 2]],
  [140, [2, 3]],
  [150, [3, 4.5]],
  [160, [4.5, 6]],
  [170, [6, 8]],
  [180, [8, 10]],
];

export function heat(temp_c: number, dew_c: number): Heat {
  const sum_f = Math.round(F(temp_c) + F(dew_c));
  if (sum_f <= 100) return { sum_f, slow_pct: null, too_hot: false };
  const row = TABLE.find(([upTo]) => sum_f <= upTo);
  return { sum_f, slow_pct: row ? row[1] : [10, 10], too_hot: !row };
}

/** Rounded to 0.01° (about a kilometre): enough for the weather, not an address. */
const coarse = (x: number) => Math.round(x * 100) / 100;

/** Where you run: the start of the latest workout with GPS. */
export async function whereYouRun(lib: Library): Promise<{ lat: number; lon: number } | null> {
  const rows = (await lib.activities()).filter((r) => r.streams_from).slice(0, 10);
  for (const r of rows) {
    const p = await startOf(lib, r.id);
    if (p) return p;
  }
  return null;
}

export async function startOf(lib: Library, id: string): Promise<{ lat: number; lon: number } | null> {
  const raw = await lib.rawStreams(await lib.find(id)).catch(() => null);
  const ll = raw?.columns.latlng?.find((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") as [number, number] | undefined;
  return ll ? { lat: coarse(ll[0]), lon: coarse(ll[1]) } : null;
}

export interface OpenMeteo {
  hourly?: {
    time?: string[];
    temperature_2m?: Array<number | null>;
    dew_point_2m?: Array<number | null>;
    precipitation_probability?: Array<number | null>;
    wind_speed_10m?: Array<number | null>;
    precipitation?: Array<number | null>;
    wind_gusts_10m?: Array<number | null>;
    weather_code?: Array<number | null>;
    snowfall?: Array<number | null>;
    is_day?: Array<number | null>;
    apparent_temperature?: Array<number | null>;
  };
}

/** The hours in an answer from Open-Meteo, those with a temperature and dew point. */
export function hours(j: OpenMeteo): Hour[] {
  const h = j.hourly;
  if (!h?.time || !h.temperature_2m || !h.dew_point_2m) throw new Error("the weather service answered without hourly temperatures");
  const out: Hour[] = [];
  h.time.forEach((time, i) => {
    const t = h.temperature_2m![i];
    const d = h.dew_point_2m![i];
    if (t == null || d == null) return;
    const rain = h.precipitation_probability?.[i];
    const wind = h.wind_speed_10m?.[i];
    const mm = h.precipitation?.[i];
    const gust = h.wind_gusts_10m?.[i];
    const code = h.weather_code?.[i];
    const snow = h.snowfall?.[i];
    const light = h.is_day?.[i];
    const feels = h.apparent_temperature?.[i];
    out.push({ ...(feels != null ? { feels_c: feels } : {}), ...(snow != null ? { snow_cm: snow } : {}), ...(light != null ? { day: light === 1 } : {}), time, temp_c: t, dew_c: d, ...(rain != null ? { rain_pct: rain } : {}), ...(wind != null ? { wind_kmh: wind } : {}), ...(mm != null ? { rain_mm: mm } : {}), ...(gust != null ? { gust_kmh: gust } : {}), ...(code != null ? { code } : {}) });
  });
  return out;
}

export interface SessionWeather extends Hour {
  key: string;
  date: string;
  start: string;
  heat: Heat;
  /** One line for the session card and the coach. */
  note: string;
  /** A cooler hour the same day, when the heat costs 2% or more. */
  cooler?: { time: string; temp_c: number; dew_c: number };
}

/** The forecast hour a session starts in. */
const hourOf = (list: Hour[], local: string) => list.find((h) => h.time.slice(0, 13) === local.slice(0, 13));

/** Weather for each session in the forecast (about a week ahead), with a line in words. */
export function forSessions(list: Hour[], sessions: Slot[], nowLocal: string): SessionWeather[] {
  const out: SessionWeather[] = [];
  for (const s of sessions) {
    // Strength and swims are indoors.
    if (s.kind === "strength" || s.kind === "swim" || s.kind === "rest") continue;
    const h = hourOf(list, s.start);
    if (!h) continue;
    const hx = heat(h.temp_c, h.dew_c);
    let cooler: SessionWeather["cooler"];
    if (hx.slow_pct && hx.slow_pct[1] >= 2) {
      // Between 06:00 and 21:00 that day, still ahead: the hour with the least heat.
      const best = list
        .filter((x) => x.time.slice(0, 10) === s.date && x.time.slice(11, 13) >= "06" && x.time.slice(11, 13) <= "21" && x.time > nowLocal)
        .sort((a, b) => heat(a.temp_c, a.dew_c).sum_f - heat(b.temp_c, b.dew_c).sum_f)[0];
      if (best && heat(best.temp_c, best.dew_c).sum_f <= hx.sum_f - 10) cooler = { time: best.time.slice(11, 16), temp_c: best.temp_c, dew_c: best.dew_c };
    }
    out.push({ ...h, key: s.key, date: s.date, start: s.start, heat: hx, note: note(h, hx, cooler, s.kind), ...(cooler ? { cooler } : {}) });
  }
  return out;
}

function note(h: Hour, hx: Heat, cooler: SessionWeather["cooler"], kind: string): string {
  const parts = [`${Math.round(h.temp_c)} °C`];
  if (hx.slow_pct) parts.push(`dew point ${Math.round(h.dew_c)} °C`);
  if ((h.rain_pct ?? 0) >= 50) parts.push(`${h.rain_pct}% chance of rain`);
  if ((h.wind_kmh ?? 0) >= 30) parts.push(`wind ${Math.round(h.wind_kmh!)} km/h`);
  let s = parts.join(", ");
  const hard = kind === "tempo" || kind === "intervals" || kind === "race" || kind === "hills";
  if (hx.too_hot) s += hard ? ". Too hot and humid for hard running: run it easy or move it" : ". Very hot and humid: keep it easy and drink";
  else if (hx.slow_pct && hx.slow_pct[1] >= 1) s += `. Heat: about ${hx.slow_pct[0]}–${hx.slow_pct[1]}% slower for the same effort${hard ? "; go by effort, not pace" : ""}`;
  if (cooler) s += `. Cooler at ${cooler.time} (${Math.round(cooler.temp_c)} °C)`;
  else if (h.temp_c <= -10) s += ". Very cold: cover up and warm up indoors";
  return `${s}.`;
}

type Fetch = (url: string) => Promise<Response>;

interface Cache {
  at?: { lat: number; lon: number };
  /** `pinned`: the demo's rainy week (src/api.ts /api/sample/rain), kept until it's taken off. */
  forecast?: { fetched: number; lat: number; lon: number; hours: Hour[]; pinned?: boolean };
  /** Past runs by activity id: the hour the run was in the middle of. */
  runs?: Record<string, Hour | null>;
  /** The last weeks' weather by the hour where you run (local times), fetched at most once a day. */
  past?: { fetched: number; from: string; to: string; hours: Hour[] };
}

/** The forecast and past weather, kept for an hour (forecast) or for good (past runs). */
export class Weather {
  constructor(
    private readonly lib: Library,
    private readonly fetch: Fetch = (u) => globalThis.fetch(u),
  ) {}

  private async cache(): Promise<Cache> {
    return (await readJson<Cache>(this.lib.disk, CACHE)) ?? {};
  }
  private async save(c: Cache): Promise<void> {
    await this.lib.disk.write(CACHE, JSON.stringify(c)).catch(() => {});
  }

  /** Hourly forecast where you run, about a week ahead (local times there). Null: nowhere to look (no GPS run yet). */
  async forecast(now = Date.now()): Promise<{ where: { lat: number; lon: number }; hours: Hour[] } | null> {
    const c = await this.cache();
    const f = c.forecast;
    if (f && (f.pinned || now - f.fetched < HOUR)) return { where: { lat: f.lat, lon: f.lon }, hours: f.hours };
    const where = (await whereYouRun(this.lib)) ?? c.at ?? null;
    if (!where) return null;
    const res = await this.fetch(`${FORECAST}?latitude=${where.lat}&longitude=${where.lon}&hourly=${HOURLY}&forecast_days=8&timezone=auto`);
    if (!res.ok) throw new Error(`the weather service answered ${res.status}`);
    const list = hours((await res.json()) as OpenMeteo);
    await this.save({ ...c, at: where, forecast: { fetched: now, ...where, hours: list } });
    return { where, hours: list };
  }

  /**
   * The demo's rainy week (screenshots of Today's weather swap): this forecast stays until it's
   * taken off (null), whatever the hour.
   */
  async pin(hours: Hour[] | null): Promise<void> {
    const c = await this.cache();
    if (!hours) {
      if (c.forecast?.pinned) delete c.forecast;
      return this.save(c);
    }
    const where = c.at ?? (await whereYouRun(this.lib)) ?? { lat: 60.18, lon: 24.93 };
    await this.save({ ...c, at: where, forecast: { fetched: Date.now(), ...where, hours, pinned: true } });
  }

  /** Whether the demo's rainy week is pinned (screenshots). */
  async pinned(): Promise<boolean> {
    return !!(await this.cache()).forecast?.pinned;
  }

  /**
   * The weather of the last `days` days where you run, by the hour in local time: one request a
   * day at most (src/habits.ts reads what your planned runs met). Null: nowhere to look.
   */
  async pastDays(days = 84, now = Date.now()): Promise<Hour[] | null> {
    const c = await this.cache();
    if (c.past && now - c.past.fetched < 20 * HOUR) return c.past.hours;
    const where = c.at ?? (await whereYouRun(this.lib));
    if (!where) return null;
    const to = new Date(now - 86400_000).toISOString().slice(0, 10);
    const from = new Date(now - days * 86400_000).toISOString().slice(0, 10);
    const res = await this.fetch(`${PAST}?latitude=${where.lat}&longitude=${where.lon}&start_date=${from}&end_date=${to}&hourly=${HOURLY}&timezone=auto`);
    if (!res.ok) throw new Error(`the weather service answered ${res.status}`);
    const list = hours((await res.json()) as OpenMeteo);
    const fresh = await this.cache();
    await this.save({ ...fresh, past: { fetched: now, from, to, hours: list } });
    return list;
  }

  /** What one past run was run in (the hour in its middle), or null when it had no GPS. */
  async run(id: string): Promise<Hour | null> {
    const c = await this.cache();
    if (c.runs && id in c.runs) return c.runs[id]!;
    const m = await this.lib.find(id);
    const row = (await this.lib.activities()).find((r) => r.id === m.id);
    const at = await startOf(this.lib, id);
    let hit: Hour | null = null;
    if (row && at) {
      const mid = new Date(Date.parse(row.start) + ((row.elapsed_min ?? row.moving_min ?? 0) * 60_000) / 2);
      const day = mid.toISOString().slice(0, 10);
      const res = await this.fetch(`${PAST}?latitude=${at.lat}&longitude=${at.lon}&start_date=${day}&end_date=${day}&hourly=temperature_2m,dew_point_2m,wind_speed_10m&timezone=GMT`);
      if (!res.ok) throw new Error(`the weather service answered ${res.status}`);
      hit = hourOf(hours((await res.json()) as OpenMeteo), mid.toISOString()) ?? null;
    }
    const fresh = await this.cache();
    await this.save({ ...fresh, runs: { ...fresh.runs, [m.id]: hit } });
    return hit;
  }
}

/** This device's wall clock as "YYYY-MM-DDTHH:MM". */
export const localNow = (now: Date) => new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** The forecast for every planned session in the next week or so, at your training times. */
export async function upcomingWeather(lib: Library, weather = new Weather(lib), now = new Date()): Promise<{ where: { lat: number; lon: number } | null; sessions: SessionWeather[]; note?: string; bad_weather: BadWeather }> {
  const [prefs, v] = await Promise.all([readPrefs(lib.disk), new Plans(lib).view()]);
  const f = await weather.forecast(now.getTime());
  if (!f) return { where: null, sessions: [], note: "No workout with GPS yet: the forecast needs to know where you run.", bad_weather: prefs.bad_weather };
  return { where: f.where, sessions: forSessions(f.hours, slots(v.weeks, prefs, v.today), localNow(now)), bad_weather: prefs.bad_weather };
}

/** The past weeks' weather for what Tartan learns (src/habits.ts), or null when it can't be had within a few seconds. */
export async function pastSoon(weather: Weather, ms = 4000): Promise<Hour[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
  try {
    return await Promise.race([weather.pastDays().catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The forecast for Today's weather swap, or null when it can't be had within a few seconds (offline, slow). */
export async function forecastSoon(weather: Weather, ms = 4000): Promise<{ hours: Hour[] } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
  try {
    return await Promise.race([weather.forecast().catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}
