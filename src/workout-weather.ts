/**
 * The weather each outdoor workout was done in: a small, quiet detail on the activity cards, the
 * workout's sheet and for the coach ("that tempo was in 28° heat").
 *
 *   Which    runs, rides, walks and hikes (and open-water swims) with a time of day; not pool
 *            swims, the treadmill, the gym, a virtual ride, or a workout told with only its day.
 *   Where    the workout's own start when it has a route, else where you run (src/weather.ts),
 *            rounded to about a kilometre before it's sent.
 *   When     the hour nearest its start, from Open-Meteo's past forecasts (free, no key).
 *   Kept     for good in cache/workout-weather.json: the weather of the past doesn't change. A
 *            workout the service has nothing for is kept as none, so it isn't asked again.
 *   Fetched  lazily, never on a screen's way: the newest workouts first, a few requests a minute
 *            at most, one request covering every missing workout within a month at one place.
 *            Offline, nothing is fetched and nothing is shown; it's tried again a few minutes on.
 *
 * The sample data (the demo) carries made-up weather of its own, the same every time, and asks
 * nothing of the network.
 */
import { readJson } from "./disk.ts";
import { conditionsAt } from "./habits.ts";
import type { ActivityRow, Library } from "./library.ts";
import { sportFamily } from "./merge.ts";
import { isSample } from "./sample.ts";
import { timeFor, type SchedulePrefs } from "./schedule.ts";
import { hours as parseHours, HOURLY, PAST, startOf, whereYouRun, type Hour, type OpenMeteo } from "./weather.ts";

const FILE = "cache/workout-weather.json";
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Requests a minute, at most. */
const PER_MINUTE = 3;
/** The newest outdoor workouts filled on their own; older ones when opened or asked about. */
const WINDOW = 120;
/** Days one request covers at one place. */
const SPAN_DAYS = 31;
/** After a failed request (offline, the service down): wait this long before the next. */
const RETRY = 5 * 60_000;

/** The sky in one word, for the glyph. */
export type Sky = "clear" | "cloudy" | "rain" | "snow" | "fog" | "storm";
/** What made it notable (as src/habits.ts tags days): ice or snow, heavy rain, strong wind, heat. */
export type WeatherFlag = "ice" | "rain" | "wind" | "heat";

export interface WorkoutWeather {
  /** °C, to a tenth. */
  temp_c: number;
  /** Feels like, °C, when known. */
  feels_c?: number;
  condition: Sky;
  /** The sky in words: "Light rain", "Partly cloudy". */
  sky: string;
  /** Wind, km/h. */
  wind_kmh?: number;
  /** Daylight (false: dark), for a moon instead of a sun. */
  day?: boolean;
  flags: WeatherFlag[];
  /** Where it was read: the workout's own start, or where you usually run. */
  where: "start" | "usual";
}

/** WMO weather codes in a word and in words. */
const SKY: Record<number, [Sky, string]> = {
  0: ["clear", "Clear"], 1: ["clear", "Mostly clear"], 2: ["cloudy", "Partly cloudy"], 3: ["cloudy", "Overcast"],
  45: ["fog", "Fog"], 48: ["fog", "Freezing fog"],
  51: ["rain", "Light drizzle"], 53: ["rain", "Drizzle"], 55: ["rain", "Heavy drizzle"], 56: ["rain", "Freezing drizzle"], 57: ["rain", "Freezing drizzle"],
  61: ["rain", "Light rain"], 63: ["rain", "Rain"], 65: ["rain", "Heavy rain"], 66: ["rain", "Freezing rain"], 67: ["rain", "Freezing rain"],
  71: ["snow", "Light snow"], 73: ["snow", "Snow"], 75: ["snow", "Heavy snow"], 77: ["snow", "Snow grains"],
  80: ["rain", "Light showers"], 81: ["rain", "Showers"], 82: ["rain", "Heavy showers"], 85: ["snow", "Snow showers"], 86: ["snow", "Heavy snow showers"],
  95: ["storm", "Thunderstorm"], 96: ["storm", "Thunderstorm with hail"], 99: ["storm", "Thunderstorm with hail"],
};

/** The sky from a weather code, or (with none) from what fell. */
export function skyOf(h: Pick<Hour, "code" | "rain_mm" | "snow_cm">): [Sky, string] {
  const known = h.code != null ? SKY[h.code] : undefined;
  // What the swap nudge calls heavy rain (src/habits.ts) reads as heavy rain here too.
  if (known?.[0] === "rain" && (h.rain_mm ?? 0) >= 2 && !/heavy|freezing/i.test(known[1])) return ["rain", "Heavy rain"];
  if (known) return known;
  if ((h.snow_cm ?? 0) > 0) return ["snow", "Snow"];
  if ((h.rain_mm ?? 0) >= 0.2) return ["rain", "Rain"];
  return ["cloudy", "Cloudy"];
}

/** Done outdoors: a run, ride, walk or hike (an open-water swim), not on a treadmill, a trainer or in a pool. */
export function outdoor(r: Pick<ActivityRow, "sport">): boolean {
  const s = r.sport.toLowerCase();
  if (/treadmill|indoor|virtual|trainer|elliptical|stair|spin|pool/.test(s)) return false;
  const fam = sportFamily(r.sport);
  return fam === "run" || fam === "ride" || fam === "walk" || (fam === "swim" && /open/.test(s));
}

const tenth = (x: number) => Math.round(x * 10) / 10;

/** The weather at the hour nearest `at` (epoch ms), from hours in UTC; null when the hours don't have it. */
export function weatherAt(list: Hour[], at: number, where: WorkoutWeather["where"]): WorkoutWeather | null {
  const key = new Date(Math.round(at / HOUR) * HOUR).toISOString().slice(0, 13);
  const h = list.find((x) => x.time.slice(0, 13) === key);
  if (!h) return null;
  const tags = conditionsAt(list, key).tags;
  const flags = (["ice", "rain", "wind", "heat"] as const).filter((t) => tags.includes(t));
  const [condition, sky] = skyOf(h);
  return {
    temp_c: tenth(h.temp_c),
    ...(h.feels_c != null ? { feels_c: tenth(h.feels_c) } : {}),
    condition,
    sky,
    ...(h.wind_kmh != null ? { wind_kmh: Math.round(h.wind_kmh) } : {}),
    ...(h.day != null ? { day: h.day } : {}),
    flags,
    where,
  };
}

/**
 * A planned session's expected weather, read the same way as a workout's (the same sky words and
 * glyph) with the hour it's for: "at": "17:00", your usual training time that day (src/schedule.ts).
 */
export type SessionForecast = Omit<WorkoutWeather, "where" | "flags"> & { at: string };

/** Sessions that meet no weather: rest, the gym, the pool, cross-training (anywhere), the treadmill. */
const INDOOR_KINDS = new Set(["rest", "strength", "swim", "cross"]);
const INDOOR_WORDS = /treadmill|indoor|pool|gym|trainer|virtual/i;

/**
 * The plan's weeks with each session still ahead in the forecast carrying its `weather` (Today's
 * card, the session's sheet, Coach's week): from hours in local time at the place you run. Done,
 * missed and indoor sessions, and those past the forecast's end, get none.
 */
type ForecastDay = { date: string; sessions: Array<{ kind: string; title: string; status?: string; target?: string; swap_to?: string }> };
export function withForecast<W extends { days: ForecastDay[] }>(weeks: W[], prefs: SchedulePrefs, today: string, list: Hour[]): W[] {
  if (!list.length) return weeks;
  const byHour = new Map(list.map((h) => [h.time.slice(0, 13), h]));
  return weeks.map((w): W => ({
    ...w,
    days: w.days.map((d) => {
      if (d.date < today) return d;
      const at = timeFor(prefs, d.date);
      const h = byHour.get(`${d.date}T${at.slice(0, 2)}`);
      if (!h) return d;
      const [condition, sky] = skyOf(h);
      const weather: SessionForecast = {
        temp_c: tenth(h.temp_c),
        ...(h.feels_c != null ? { feels_c: tenth(h.feels_c) } : {}),
        condition,
        sky,
        ...(h.wind_kmh != null ? { wind_kmh: Math.round(h.wind_kmh) } : {}),
        ...(h.day != null ? { day: h.day } : {}),
        at,
      };
      return {
        ...d,
        sessions: d.sessions.map((s) => {
          const indoors = INDOOR_KINDS.has(s.kind) || s.swap_to === "treadmill" || INDOOR_WORDS.test(`${s.title} ${s.target ?? ""}`);
          return indoors || s.status === "done" || s.status === "missed" || s.status === "rest" ? s : { ...s, weather };
        }),
      };
    }),
  }));
}

/**
 * A word for the coach's notes on a run, when the weather explains something: heat, ice or snow,
 * strong wind. "in 28° heat", "on snow and ice", "into a 32 km/h wind"; null when it was ordinary.
 */
export function notableWords(w: WorkoutWeather | null | undefined): string | null {
  if (!w) return null;
  if (w.flags.includes("heat")) return `in ${Math.round(w.temp_c)}° heat`;
  if (w.flags.includes("ice")) return w.condition === "snow" ? "in the snow" : "on icy ground";
  if (w.flags.includes("wind") && w.wind_kmh) return `in a ${w.wind_kmh} km/h wind`;
  return null;
}

/**
 * The run-against-last-time line (src/run-finish.ts) with the weather in it, once and only when it
 * fits: a harder run in heat, snow or wind says so instead of guessing; a run that held up says
 * it did so in it.
 */
export function withWeather<T extends { verdict: string; text: string }>(last: T, w: WorkoutWeather | null | undefined): T {
  const words = notableWords(w);
  if (!words) return last;
  if (last.verdict === "harder" && /\. Fatigue, heat or a short night can do this\.$/.test(last.text)) {
    return { ...last, text: last.text.replace(/\. Fatigue, heat or a short night can do this\.$/, `, ${words}: that explains much of it.`) };
  }
  if (last.verdict === "fitter" || last.verdict === "same") return { ...last, text: `${last.text} ${words[0]!.toUpperCase()}${words.slice(1)}, too.` };
  return last;
}

type Fetch = (url: string) => Promise<Response>;
type Kept = Record<string, WorkoutWeather | null>;

/** How many requests went out lately, and when one last failed: one budget for the whole app. */
export interface Limiter {
  sent: number[];
  failedAt: number;
}
const shared: Limiter = { sent: [], failedAt: -Infinity };

/** The sample's weather: a November in Helsinki, the same every time, the newest run in light rain. */
const SAMPLE: Array<Omit<WorkoutWeather, "where">> = [
  { temp_c: 4, feels_c: 0, condition: "rain", sky: "Light rain", wind_kmh: 18, day: false, flags: [] },
  { temp_c: 2, feels_c: -3, condition: "cloudy", sky: "Overcast", wind_kmh: 32, day: false, flags: ["wind"] },
  { temp_c: 6, feels_c: 3, condition: "cloudy", sky: "Partly cloudy", wind_kmh: 12, day: false, flags: [] },
  { temp_c: -1, feels_c: -5, condition: "snow", sky: "Light snow", wind_kmh: 14, day: false, flags: ["ice"] },
  { temp_c: 7, feels_c: 5, condition: "clear", sky: "Clear", wind_kmh: 8, day: false, flags: [] },
  { temp_c: 5, feels_c: 3, condition: "fog", sky: "Fog", wind_kmh: 5, day: false, flags: [] },
];

export class WorkoutWeathers {
  private running: Promise<number> | null = null;

  constructor(
    private readonly lib: Library,
    private readonly opts: {
      fetch?: Fetch;
      /** Called when new weather was kept: the screens read again. */
      added?: () => void;
      clock?: () => number;
      limiter?: Limiter;
    } = {},
  ) {}

  private get now() {
    return (this.opts.clock ?? Date.now)();
  }
  private get limiter() {
    return this.opts.limiter ?? shared;
  }

  private async read(): Promise<Kept> {
    return (await readJson<{ by?: Kept }>(this.lib.disk, FILE).catch(() => null))?.by ?? {};
  }

  /** Every workout's weather known so far (none: looked, nothing to have). */
  async known(): Promise<Kept> {
    if (await isSample(this.lib.disk).catch(() => false)) return this.sample();
    return this.read();
  }

  /** The sample's workouts, each with its made-up weather by how recent it is. */
  private async sample(): Promise<Kept> {
    const rows = (await this.lib.activities()).filter(outdoor);
    return Object.fromEntries(rows.map((r, i) => [r.id, { ...SAMPLE[i % SAMPLE.length]!, where: "start" as const }]));
  }

  /** The rows with their weather where it's known (nothing fetched). */
  async attach<T extends { id: string }>(rows: T[]): Promise<Array<T & { weather?: WorkoutWeather }>> {
    const kept = await this.known().catch((): Kept => ({}));
    return rows.map((r) => (kept[r.id] ? { ...r, weather: kept[r.id]! } : r));
  }

  /** One workout's weather, when it's known; else fetched in the background (or waited for up to `wait` ms). */
  async of(id: string, wait = 0): Promise<WorkoutWeather | null> {
    const kept = await this.known().catch((): Kept => ({}));
    if (id in kept) return kept[id] ?? null;
    const filling = this.fill([id]).catch(() => 0);
    if (wait <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([filling, new Promise((r) => (timer = setTimeout(r, wait)))]);
    clearTimeout(timer);
    return (await this.read())[id] ?? null;
  }

  /**
   * Fetch what's missing, a few requests at most (the budget is a few a minute): `first` (a
   * workout opened), then the newest outdoor workouts. How many workouts it settled. One at a time:
   * a call while one runs gets that one.
   */
  fill(first: string[] = []): Promise<number> {
    if (!this.running) this.running = this.fillNow(first).finally(() => (this.running = null));
    return this.running;
  }

  private budget(): boolean {
    const l = this.limiter;
    const now = this.now;
    l.sent = l.sent.filter((t) => now - t < 60_000);
    return l.sent.length < PER_MINUTE && now - l.failedAt >= RETRY;
  }

  private async fillNow(first: string[]): Promise<number> {
    if (await isSample(this.lib.disk).catch(() => false)) return 0;
    if (!this.budget()) return 0;
    const kept = await this.read();
    const rows = await this.lib.activities();
    const outside = rows.filter(outdoor);
    const firstSet = new Set(first);
    const queue = [...outside.filter((r) => firstSet.has(r.id)), ...outside.slice(0, WINDOW).filter((r) => !firstSet.has(r.id))].filter((r) => !(r.id in kept));
    if (!queue.length) return 0;

    const found: Kept = {};
    // Told to the coach with only its day: no hour to look at, ever.
    const timed: ActivityRow[] = [];
    for (const r of queue) {
      if (r.sources.length === 1 && r.sources[0] === "logged" && !(await this.hasTime(r.id))) found[r.id] = null;
      else timed.push(r);
    }

    let usual: { lat: number; lon: number } | null | undefined;
    const places = new Map<string, { lat: number; lon: number; where: WorkoutWeather["where"] } | null>();
    const placeOf = async (r: ActivityRow) => {
      if (places.has(r.id)) return places.get(r.id)!;
      const own = r.streams_from ? await startOf(this.lib, r.id).catch(() => null) : null;
      if (!own && usual === undefined) usual = await whereYouRun(this.lib).catch(() => null);
      const p = own ? { ...own, where: "start" as const } : usual ? { ...usual, where: "usual" as const } : null;
      places.set(r.id, p);
      return p;
    };

    let left = timed;
    while (left.length && this.budget()) {
      const head = left[0]!;
      const at = await placeOf(head);
      if (!at) {
        // Nowhere known yet (no workout with GPS): later, once there is.
        left = left.slice(1);
        continue;
      }
      // Every missing workout in the month up to it, at about the same place (5 km): one request.
      const t0 = Date.parse(head.start);
      const group: Array<{ r: ActivityRow; where: WorkoutWeather["where"] }> = [];
      for (const r of left.slice(0, 40)) {
        const back = t0 - Date.parse(r.start);
        if (back < -DAY || back > (SPAN_DAYS - 2) * DAY) continue;
        const p = await placeOf(r);
        if (p && Math.abs(p.lat - at.lat) <= 0.05 && Math.abs(p.lon - at.lon) <= 0.1) group.push({ r, where: p.where });
      }
      const starts = group.map((g) => Date.parse(g.r.start));
      // From the day before (for ice: rain or snow in the hours before) to the hour after the last start.
      const from = new Date(Math.min(...starts) - DAY).toISOString().slice(0, 10);
      const to = new Date(Math.max(...starts) + HOUR).toISOString().slice(0, 10);
      const url = `${PAST}?latitude=${at.lat}&longitude=${at.lon}&start_date=${from}&end_date=${to}&hourly=${HOURLY},apparent_temperature&timezone=GMT`;
      this.limiter.sent.push(this.now);
      let res: Response;
      try {
        res = await (this.opts.fetch ?? ((u: string) => globalThis.fetch(u)))(url);
      } catch {
        this.limiter.failedAt = this.now;
        break;
      }
      let list: Hour[] | null = null;
      if (res.ok) {
        try {
          list = parseHours((await res.json()) as OpenMeteo);
        } catch {
          list = [];
        }
      } else if (res.status === 400) {
        // Outside what the service has (too long ago): none, for good.
        list = [];
      } else {
        this.limiter.failedAt = this.now;
        break;
      }
      for (const g of group) found[g.r.id] = weatherAt(list, Date.parse(g.r.start), g.where);
      const done = new Set(group.map((g) => g.r.id));
      left = left.filter((r) => !done.has(r.id));
    }

    const n = Object.keys(found).length;
    if (!n) return 0;
    // Read again: another fill (the PC's, an earlier one) may have kept some meanwhile.
    const fresh = await this.read();
    await this.lib.disk.write(FILE, JSON.stringify({ by: { ...fresh, ...found } })).catch(() => {});
    if (Object.values(found).some(Boolean)) this.opts.added?.();
    return n;
  }

  /** A logged workout told with its time of day. */
  private async hasTime(id: string): Promise<boolean> {
    const m = await this.lib.find(id).catch(() => null);
    const key = m?.members.find((x) => x.source === "logged")?.key.slice(7);
    if (!key) return false;
    return !!(await this.lib.logged.all()).find((w) => w.id === key)?.time;
  }
}
