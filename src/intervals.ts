/**
 * intervals.icu as a source: it already gathers workouts from Garmin, Suunto, Coros, Polar, Wahoo
 * and Zwift through their official links, and its API takes a personal key (intervals.icu →
 * Settings → Developer Settings). Each workout comes in with its time series as a FIT file in the
 * "intervals.icu" folder (src/import.ts importWorkout), so it merges with the same workout from
 * Strava or the watch. Workouts that reached intervals.icu from Strava aren't given out by its API
 * (Strava's terms): they're counted, and left to Tartan's own Strava link.
 */
import { readJson, type Disk } from "./disk.ts";
import type { FitSample, FitWorkout } from "./fit-write.ts";
import { importWorkout } from "./import.ts";
import { icuText, icuType, workoutSeconds } from "./workout/export.ts";
import type { PlannedWorkout } from "./workout/from-plan.ts";
import type { LocalStore } from "./store.ts";
import type { FetchLike } from "./strava/client.ts";

export const INTERVALS_FOLDER = { id: "intervals-icu", name: "intervals.icu" };
const CONFIG = "intervals/config.json";
const STATE = "intervals/state.json";

export interface IntervalsConfig {
  /** "i12345"; "0" stands for the key's own athlete. */
  athlete: string;
  key: string;
  name?: string;
  base?: string;
}
export interface IntervalsState {
  /** intervals.icu ids brought in (or skipped for good). */
  done: string[];
  /** Workouts from here on (YYYY-MM-DD): two years back the first time. */
  from?: string;
  last?: { at: string; added: number; strava: number; pending: number; error?: string };
  /** The plan's coming week kept on intervals.icu as planned workouts (on once sent). */
  plan?: { on: boolean; at?: string; added?: number; removed?: number; there?: number; error?: string };
}

/** One workout as intervals.icu lists it (the fields used here). */
export interface IcuActivity {
  id: string;
  start_date?: string;
  start_date_local?: string;
  type?: string;
  name?: string;
  source?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  calories?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  total_elevation_gain?: number;
}
type Stream = { type: string; data: Array<number | null>; data2?: Array<number | null> };

export class IntervalsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class Intervals {
  constructor(
    private readonly disk: Disk,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  config = () => readJson<IntervalsConfig>(this.disk, CONFIG);
  async state(): Promise<IntervalsState> {
    return (await readJson<IntervalsState>(this.disk, STATE)) ?? { done: [] };
  }
  private save = (s: IntervalsState) => this.disk.write(STATE, JSON.stringify(s));

  async status() {
    const c = await this.config();
    const s = await this.state();
    return { connected: !!c, athlete: c?.athlete ?? null, name: c?.name ?? null, last: s.last ?? null, workouts: s.done.length, plan: s.plan ?? { on: false } };
  }

  private get<T>(c: IntervalsConfig, path: string): Promise<T> {
    return this.req<T>(c, "GET", path);
  }
  private async req<T>(c: IntervalsConfig, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${c.base ?? "https://intervals.icu"}/api/v1${path}`, {
      method,
      headers: { authorization: `Basic ${btoa(`API_KEY:${c.key}`)}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 || res.status === 403) throw new IntervalsError("intervals.icu didn't accept the key: check the API key (and athlete ID) in Settings → Developer Settings there.", res.status);
    if (res.status === 404) throw new IntervalsError("intervals.icu doesn't know that athlete: copy the athlete ID (i12345) from Settings → Developer Settings there.", 404);
    if (!res.ok) throw new IntervalsError(`intervals.icu answered ${res.status}.`, res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Check the key (and athlete, "0" for the key's own) and keep them; the athlete's name. */
  async connect(key: string, athlete = "0", base?: string): Promise<{ athlete: string; name: string | null }> {
    const c: IntervalsConfig = { athlete: athlete.trim() || "0", key: key.trim(), ...(base ? { base } : {}) };
    if (!c.key) throw new IntervalsError("Paste the API key from intervals.icu → Settings → Developer Settings.");
    const me = await this.get<{ id?: string; name?: string; firstname?: string }>(c, `/athlete/${encodeURIComponent(c.athlete)}`);
    const saved = { ...c, athlete: me.id ?? c.athlete, name: me.name ?? me.firstname ?? undefined };
    await this.disk.write(CONFIG, JSON.stringify(saved), { secret: true });
    return { athlete: saved.athlete, name: saved.name ?? null };
  }

  async disconnect(): Promise<void> {
    await this.disk.write(CONFIG, "null", { secret: true });
    await this.save({ done: [] });
  }

  /**
   * New workouts in, newest first, at most `max` a round (the rest next time); the first time,
   * two years back. Strava's copies at intervals.icu are counted and skipped.
   */
  async sync(store: LocalStore, o: { max?: number; now?: number; log?: (m: string) => void } = {}): Promise<{ added: number; strava: number; pending: number }> {
    const c = await this.config();
    if (!c) throw new IntervalsError("intervals.icu isn't connected.");
    const now = o.now ?? Date.now();
    const s = await this.state();
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const from = s.from ?? day(now - 730 * 86400_000);
    try {
      const list = await this.get<IcuActivity[]>(c, `/athlete/${encodeURIComponent(c.athlete)}/activities?oldest=${from}&newest=${day(now + 86400_000)}`);
      const done = new Set(s.done);
      const todo = list.filter((a) => a?.id && !done.has(String(a.id))).sort((a, b) => startOf(b) - startOf(a));
      let added = 0;
      let strava = 0;
      for (const a of todo.slice(0, o.max ?? 60)) {
        const id = String(a.id);
        // Reached intervals.icu from Strava: its API doesn't give these out.
        if (a.source === "STRAVA" && !a.moving_time && !a.elapsed_time) {
          strava++;
          done.add(id);
          continue;
        }
        const streams = await this.get<Stream[]>(c, `/activity/${encodeURIComponent(id)}/streams.json?types=time,latlng,altitude,heartrate,distance,velocity_smooth,cadence,watts`).catch(() => [] as Stream[]);
        const w = icuWorkout(a, streams);
        if (w) {
          const r = await importWorkout(store, INTERVALS_FOLDER, `icu-${id}`, w);
          if (!r.already) added++;
        }
        done.add(id);
      }
      const pending = Math.max(0, todo.length - (o.max ?? 60));
      // Next time from a few days before the newest, unless there's history still to come.
      const newest = list.reduce((m, a) => Math.max(m, startOf(a) || 0), 0);
      const next = pending ? from : day(Math.max(Date.parse(from), (newest || now) - 7 * 86400_000));
      await this.save({ done: [...done].slice(-20000), from: next, last: { at: new Date(now).toISOString(), added, strava, pending } });
      if (added) o.log?.(`[intervals.icu] ${added} new workouts${pending ? `, ${pending} more next time` : ""}`);
      return { added, strava, pending };
    } catch (e) {
      await this.save({ ...s, last: { at: new Date(now).toISOString(), added: 0, strava: 0, pending: 0, error: (e as Error).message } });
      throw e;
    }
  }

  /**
   * The coming sessions as planned workouts on intervals.icu (which forwards them to the watch
   * accounts it links, Garmin Connect among them): Tartan's events (external id "tartan-…") that
   * aren't wanted any more come off, the missing ones go on; others' events are never touched.
   * Each session starts at `time(date)` ("HH:MM", the time you train).
   */
  async sendPlan(planned: PlannedWorkout[], o: { today: string; time: (date: string) => string; maxHr?: number; now?: number }): Promise<{ added: number; removed: number; there: number }> {
    const c = await this.config();
    if (!c) throw new IntervalsError("intervals.icu isn't connected.");
    const a = encodeURIComponent(c.athlete);
    const s = await this.state();
    const at = new Date(o.now ?? Date.now()).toISOString();
    try {
      const until = new Date(Date.parse(`${o.today}T12:00:00Z`) + 60 * 86400_000).toISOString().slice(0, 10);
      const events = (await this.get<IcuEvent[]>(c, `/athlete/${a}/events?oldest=${o.today}&newest=${until}&category=WORKOUT`)) ?? [];
      const ours = events.filter((e) => typeof e.external_id === "string" && e.external_id.startsWith(ICU_PREFIX));
      const want = new Map(planned.map((p) => [icuExternalId(p), p]));
      const stale = ours.filter((e) => !want.has(e.external_id!));
      for (const e of stale) await this.req(c, "DELETE", `/athlete/${a}/events/${encodeURIComponent(String(e.id))}`);
      const there = new Set(ours.map((e) => e.external_id));
      const add = [...want.entries()].filter(([id]) => !there.has(id)).map(([id, p]) => icuEvent(p, id, o.time(p.date), o.maxHr));
      if (add.length) await this.req(c, "POST", `/athlete/${a}/events/bulk?upsert=true`, add);
      const r = { added: add.length, removed: stale.length, there: want.size };
      await this.save({ ...(await this.state()), plan: { on: true, at, ...r } });
      return r;
    } catch (e) {
      await this.save({ ...s, plan: { ...(s.plan ?? { on: true }), at, error: (e as Error).message } });
      throw e;
    }
  }

  /** Stop keeping the plan there, and take Tartan's planned workouts from today on off it. */
  async stopPlan(today: string): Promise<{ removed: number }> {
    const c = await this.config();
    let removed = 0;
    if (c) {
      const a = encodeURIComponent(c.athlete);
      const until = new Date(Date.parse(`${today}T12:00:00Z`) + 400 * 86400_000).toISOString().slice(0, 10);
      const events = (await this.get<IcuEvent[]>(c, `/athlete/${a}/events?oldest=${today}&newest=${until}&category=WORKOUT`)) ?? [];
      for (const e of events.filter((x) => x.external_id?.startsWith(ICU_PREFIX))) {
        await this.req(c, "DELETE", `/athlete/${a}/events/${encodeURIComponent(String(e.id))}`);
        removed++;
      }
    }
    await this.save({ ...(await this.state()), plan: { on: false } });
    return { removed };
  }
}

const startOf = (a: IcuActivity) => Date.parse(a.start_date ?? (a.start_date_local ? `${a.start_date_local}` : "")) || 0;

/** intervals.icu's sport to FIT's. */
export function icuSport(type = ""): string {
  const t = type.toLowerCase();
  if (/run/.test(t)) return "running";
  if (/ride|cycl|bike/.test(t)) return "cycling";
  if (/swim/.test(t)) return "swimming";
  if (/hike/.test(t)) return "hiking";
  if (/walk/.test(t)) return "walking";
  if (/row/.test(t)) return "rowing";
  if (/nordicski|backcountry/.test(t)) return "cross_country_skiing";
  if (/alpineski|snowboard/.test(t)) return "alpine_skiing";
  if (/weight|workout|crossfit|yoga|pilates|hiit/.test(t)) return "training";
  if (/kayak|canoe|paddl/.test(t)) return "paddling";
  return "generic";
}

/** A workout from its summary and streams (time in seconds from the start). Null without a start. */
export function icuWorkout(a: IcuActivity, streams: Stream[]): FitWorkout | null {
  const start = startOf(a);
  if (!start) return null;
  const col = (k: string) => streams.find((x) => x.type === k);
  const time = col("time")?.data ?? [];
  const ll = col("latlng");
  const pick = (k: string) => col(k)?.data ?? [];
  const [alt, hr, dist, vel, cad, pow] = ["altitude", "heartrate", "distance", "velocity_smooth", "cadence", "watts"].map(pick);
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const samples: FitSample[] = time.map((t, i) => {
    const lat = n(ll?.data[i]);
    const lon = n(ll?.data2?.[i]);
    return {
      t: start + (n(t) ?? i) * 1000,
      ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
      ...(n(alt![i]) !== undefined ? { altitude: n(alt![i]) } : {}),
      ...(n(hr![i]) !== undefined ? { hr: n(hr![i]) } : {}),
      ...(n(dist![i]) !== undefined ? { distance: n(dist![i]) } : {}),
      ...(n(vel![i]) !== undefined ? { speed: n(vel![i]) } : {}),
      ...(n(cad![i]) !== undefined ? { cadence: n(cad![i]) } : {}),
      ...(n(pow![i]) !== undefined ? { power: n(pow![i]) } : {}),
    };
  });
  const elapsed = a.elapsed_time ?? a.moving_time ?? (samples.length ? (samples.at(-1)!.t - start) / 1000 : 0);
  return {
    start,
    end: start + Math.max(1, elapsed) * 1000,
    sport: icuSport(a.type),
    ...(a.moving_time ? { moving_s: a.moving_time } : {}),
    ...(a.distance ? { distance_m: a.distance } : {}),
    ...(a.calories ? { calories: a.calories } : {}),
    ...(a.average_heartrate ? { avg_hr: Math.round(a.average_heartrate) } : {}),
    ...(a.max_heartrate ? { max_hr: Math.round(a.max_heartrate) } : {}),
    ...(a.total_elevation_gain ? { ascent_m: Math.round(a.total_elevation_gain) } : {}),
    samples,
  };
}

/** A planned event on intervals.icu, as its API lists them (the fields used here). */
export interface IcuEvent {
  id: number | string;
  external_id?: string;
  start_date_local?: string;
  name?: string;
  category?: string;
}

const ICU_PREFIX = "tartan-";
/** One per session and what it is: a session that changes gets a new id (and replaces the old). */
export const icuExternalId = (p: Pick<PlannedWorkout, "date" | "key">) => `${ICU_PREFIX}${p.date}-${p.key}`;

/** A session as an intervals.icu planned workout (its description is the workout text). */
export function icuEvent(p: PlannedWorkout, externalId: string, time: string, maxHr?: number) {
  const secs = workoutSeconds(p.workout);
  return {
    category: "WORKOUT",
    start_date_local: `${p.date}T${time}:00`,
    type: icuType(p.kind),
    name: p.workout.name.replace(/^\w{3} /, ""),
    description: icuText(p.workout, { maxHr, notes: p.notes }),
    external_id: externalId,
    ...(secs ? { moving_time: secs } : {}),
  };
}
