/**
 * One read-only view over everything Tartan has collected, with every workout
 * appearing exactly once:
 *   - Strava (full detail + time series, synced from the Strava API)
 *   - files copied off the watch over Bluetooth (FIT files are parsed)
 *   - the Suunto-cloud export earlier versions made (still read; no new ones come in)
 * Copies of the same workout are merged by ./merge.ts. This is what the MCP server,
 * the dashboards and the coach read.
 */
import { readJson, type Disk } from "./disk.ts";
import { isFit, parseFit, type FitActivity } from "./fit.ts";
import { fileSourceOf } from "./import.ts";
import { mergeActivities, migrateLinks, resolveAlias, sportFamily, type Candidate, type LinkTable, type MergedActivity, type Source } from "./merge.ts";
import { sniff } from "./protocol/sync.ts";
import { decodeStreams, decodeWorkout, feelingOf, parseDescriptors, sbemSummary, type Feeling, type SbemWorkoutFull } from "./sbem.ts";
import { loggedStart, LoggedWorkouts } from "./logged.ts";
import { RecordingStore, streams as recordingStreams, summarize } from "./recording.ts";
import { effortsFrom, type Effort } from "./run-finish.ts";
import { LocalStore } from "./store.ts";
import type { FetchLike, StravaActivityDetail, StravaActivitySummary } from "./strava/client.ts";
import { StravaStore } from "./strava/sync.ts";

export type { Source };

export interface ActivityRow {
  /** Canonical id (stable across syncs). Source ids like strava:123 are accepted too. */
  id: string;
  /** UTC start, ISO 8601. */
  start: string;
  /** Local wall-clock start where a source reported it. */
  start_local?: string;
  sport: string;
  name?: string;
  distance_km?: number;
  moving_min?: number;
  elapsed_min?: number;
  elevation_m?: number;
  avg_hr?: number;
  max_hr?: number;
  avg_pace_min_km?: string;
  avg_speed_kmh?: number;
  avg_cadence?: number;
  avg_power_w?: number;
  calories?: number;
  device?: string;
  /** Every source holding a copy of this workout. */
  sources: Source[];
  /** Which source's time series represents it. */
  streams_from?: Source;
  /** "How did it feel?", answered on the watch: 1 poor … 5 excellent. */
  feeling?: Feeling;
  /** How hard it was, 1 … 10, as the athlete told the coach (a logged workout). */
  effort?: number;
}

export interface ActivityFilter {
  since?: string;
  until?: string;
  sport?: string;
  /** Only workouts that have a copy in this source. */
  source?: Source | "all";
  limit?: number;
}

/**
 * Canonical stream channel names, whichever source they came from. Beyond the usual, a watch's
 * FIT file can bring the running dynamics (gct: ground contact time ms; vertical_oscillation mm;
 * vertical_ratio %; stance_balance: the left foot's share %; step_length mm) and rr: at each
 * sample, the beat-to-beat intervals (ms) recorded since the one before (null where none).
 */
export const CHANNELS = ["time", "distance", "latlng", "altitude", "velocity", "heartrate", "cadence", "watts", "temp", "grade", "gct", "vertical_oscillation", "vertical_ratio", "stance_balance", "step_length", "rr"] as const;

const STRAVA_CHANNEL: Record<string, string> = {
  time: "time", distance: "distance", latlng: "latlng", altitude: "altitude", velocity_smooth: "velocity",
  heartrate: "heartrate", cadence: "cadence", watts: "watts", temp: "temp", grade_smooth: "grade",
};

export const round = (n: number | undefined, d = 1) => (n === undefined || !Number.isFinite(n) ? undefined : +n.toFixed(d));
export const pace = (mps: number | undefined) => {
  if (!mps || mps <= 0) return undefined;
  const secPerKm = 1000 / mps;
  let m = Math.floor(secPerKm / 60);
  let s = Math.round(secPerKm % 60);
  if (s === 60) {
    m++;
    s = 0;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
};
export const isFootSport = (s: string) => ["run", "walk"].includes(sportFamily(s));

/** Suunto app activity IDs for the most common sports (the old cloud export). */
const SUUNTO_SPORTS: Record<number, string> = {
  0: "Walk", 1: "Run", 2: "Ride", 3: "NordicSki", 4: "Other", 5: "Other", 6: "MountainBikeRide", 7: "Hike",
  8: "RollerSki", 9: "AlpineSki", 10: "Canoeing", 11: "Rowing", 12: "Golf", 13: "Workout", 21: "Swim",
  22: "TrailRun", 23: "WeightTraining", 31: "TrailRun", 52: "Treadmill", 69: "Yoga",
};

export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
}

type CloudWorkout = Record<string, unknown> & { workoutKey: string };

const EFFORTS_CACHE = "cache/best-efforts.json";
/** Efforts worked out from a run's own time series (runs Strava doesn't have), by merged id. */
const RUN_EFFORTS = "cache/run-efforts.json";
type EffortsCache = Record<string, { sport: string; efforts: Array<{ name: string; elapsed_time: number; distance: number; start_date: string }> }>;

export class Library {
  readonly local: LocalStore;
  readonly strava: StravaStore;
  readonly recordings: RecordingStore;
  /** Workouts told to the coach, with no recording. */
  readonly logged: LoggedWorkouts;
  private fitCache = new Map<string, { sig: string; fit: FitActivity | null }>();
  private sbemCache = new Map<string, { sig: string; sum: { workout: SbemWorkoutFull; streams: Record<string, unknown[]> | null } | null }>();
  private memo: { sig: string; merged: MergedActivity[]; links: LinkTable } | null = null;
  /** The last merge, shared briefly: one dashboard asks for it dozens of times. */
  private recent: { at: number; p: Promise<MergedActivity[]> } | null = null;
  private effortsCache: Promise<EffortsCache> | null = null;

  /** How to reach other services (the Android app's native HTTP: some have no CORS). */
  readonly fetch?: FetchLike;

  constructor(
    readonly disk: Disk,
    opts: { fetch?: FetchLike } = {},
  ) {
    this.fetch = opts.fetch;
    this.local = new LocalStore(disk);
    this.strava = new StravaStore(disk, opts.fetch);
    this.recordings = new RecordingStore(disk);
    this.logged = new LoggedWorkouts(disk);
  }

  // ------------------------------------------------------------ overview

  async overview() {
    const index = await this.strava.index();
    const state = await this.strava.read<Record<string, unknown>>("state.json");
    const athlete = await this.strava.read<Record<string, unknown>>("athlete.json");
    const watches = await this.local.watches();
    const details = await this.strava.ids("activities");
    const merged = await this.merged();
    const bySources = countBy(merged.map((m) => [...new Set(m.members.map((x) => x.source))].sort().join(" + ")));
    return compact({
      data_dir: this.local.root,
      activities: {
        total: merged.length,
        first: merged.at(-1) ? new Date(merged.at(-1)!.start).toISOString() : undefined,
        last: merged[0] ? new Date(merged[0].start).toISOString() : undefined,
        by_sources: bySources,
        sports: countBy(merged.map((m) => m.sport)),
        note: "Copies of the same workout in Strava, on the watch and in the Suunto cloud are merged into one activity.",
      },
      strava: {
        connected: !!(await this.strava.read("tokens.json")),
        athlete: athlete ? compact({ id: athlete.id, name: `${athlete.firstname ?? ""} ${athlete.lastname ?? ""}`.trim(), city: athlete.city, weight_kg: athlete.weight }) : undefined,
        activities: index.length,
        with_full_detail: details.size,
        last_sync: state?.lastSync,
      },
      watches: watches.map((w) => ({ id: w.id, name: w.info.name, files: w.files, bytes: w.bytes, last_backup: w.info.lastBackup ?? w.info.updated })),
    });
  }

  // ------------------------------------------------------------ activities

  async activities(filter: ActivityFilter = {}): Promise<ActivityRow[]> {
    const since = filter.since ? Date.parse(filter.since) : -Infinity;
    const until = filter.until ? Date.parse(filter.until) + (filter.until.length <= 10 ? 86400_000 : 0) : Infinity;
    const sport = filter.sport?.toLowerCase();
    const src = filter.source ?? "all";
    const rows = (await this.merged())
      .filter((m) => m.start >= since && m.start < until)
      // "run" also finds Treadmill and jogs (a family name); "trail" only finds trail runs.
      .filter((m) => !sport || m.sport.toLowerCase().includes(sport) || (sportFamily(sport) === sport && sportFamily(m.sport) === sport))
      .filter((m) => src === "all" || m.members.some((x) => x.source === src))
      .map(toRow);
    return filter.limit ? rows.slice(0, filter.limit) : rows;
  }

  /** One activity in full, with where each field came from. */
  async activity(id: string): Promise<Record<string, unknown>> {
    const m = await this.find(id);
    const stravaKey = m.members.find((x) => x.source === "strava")?.key;
    const file = m.members.find((x) => x.source === "watch") ?? m.members.find((x) => x.source === "health") ?? m.members.find((x) => x.source === "intervals");
    const detail = stravaKey ? await this.strava.read<StravaActivityDetail>("activities", `${stravaKey.slice(7)}.json`) : null;
    const fit = file ? await this.watchFit(fileOf(file.key)) : null;
    const laps = detail?.laps?.length ? { laps: detail.laps, laps_from: "strava" } : fit?.laps.length ? { laps: fit.laps, laps_from: file!.source } : {};
    const loggedKey = m.members.find((x) => x.source === "logged")?.key.slice(7);
    const said = loggedKey ? (await this.logged.all()).find((w) => w.id === loggedKey) : undefined;
    return compact({
      ...toRow(m),
      description: detail?.description ?? said?.note ?? undefined,
      ...laps,
      splits_metric: detail?.splits_metric,
      best_efforts: detail?.best_efforts?.map((b) => ({ name: b.name, time_s: b.elapsed_time, start: b.start_date, pr_rank: b.pr_rank })),
      gear: detail?.gear,
      // Each copy with its own numbers, so the app can show what each source measured.
      copies: m.members.map((x) =>
        compact({
          source: x.source,
          id: x.key,
          start: new Date(x.start).toISOString(),
          device: x.device,
          elapsed_s: x.elapsed_s,
          moving_s: x.moving_s,
          distance_m: x.distance_m,
          avg_hr: x.avg_hr,
          max_hr: x.max_hr,
          avg_speed: x.avg_speed,
          elevation_m: x.elevation_m,
          avg_cadence: x.avg_cadence,
          avg_power: x.avg_power,
          calories: x.calories,
          has_streams: x.has_streams,
        }),
      ),
      provenance: Object.fromEntries(Object.entries(m.provenance).map(([f, key]) => [f, key.split(":")[0]])),
      detail_synced: stravaKey ? !!detail : undefined,
    });
  }

  /**
   * Time series from the single source that represents this activity, under canonical
   * channel names, evenly downsampled to at most `maxPoints` samples.
   */
  async streams(id: string, keys?: string[], maxPoints = 300): Promise<Record<string, unknown>> {
    const m = await this.find(id);
    const raw = await this.rawStreams(m);
    if (!raw) throw new Error(m.members.some((x) => x.source === "strava") ? "time series not synced yet (run sync_strava)" : "no copy of this workout has a time series");
    let columns = raw.columns;
    if (keys?.length) columns = Object.fromEntries(Object.entries(columns).filter(([k]) => keys.includes(k)));
    const length = Math.max(0, ...Object.values(columns).map((c) => c.length));
    const step = Math.max(1, Math.ceil(length / Math.max(2, maxPoints)));
    const sampled = Object.fromEntries(Object.entries(columns).map(([k, c]) => [k, c.filter((_, i) => i % step === 0 || i === c.length - 1)]));
    return { id: m.id, from: raw.source, original_points: length, step, points: Math.ceil(length / step), available: Object.keys(raw.columns), streams: sampled };
  }

  /** Full-resolution canonical streams (used by analytics and the dashboards). */
  async rawStreams(m: MergedActivity): Promise<{ source: Source; columns: Record<string, unknown[]> } | null> {
    const key = m.streams_from;
    if (!key) return null;
    if (key.startsWith("phone:")) {
      const r = await this.recordings.get(key.slice(6));
      const columns = r && recordingStreams(r);
      return columns ? { source: "phone", columns } : null;
    }
    if (key.startsWith("strava:")) {
      const s = await this.strava.read<Record<string, { data: unknown[] }>>("streams", `${key.slice(7)}.json`);
      if (!s || !Object.keys(s).length) return null;
      const columns: Record<string, unknown[]> = {};
      for (const [k, v] of Object.entries(s)) if (STRAVA_CHANNEL[k]) columns[STRAVA_CHANNEL[k]!] = v.data;
      return { source: "strava", columns };
    }
    const lb = /^watch:([^/]+)(\/logbook\/\d+)$/.exec(key);
    if (lb) {
      const files = await this.local.files(lb[1]!).catch(() => []);
      const f = files.find((x) => x.path === `${lb[2]}/summary.sbem`);
      const sum = f ? await this.watchSbem(lb[1]!, lb[2]!, `${f.bytes}:${f.modified}`) : null;
      return sum?.streams ? { source: "watch", columns: sum.streams } : null;
    }
    const fit = await this.watchFit(fileOf(key));
    if (!fit?.records.length) return null;
    const records = fit.records;
    const t0 = Date.parse(records[0]!.time);
    const col = <T>(f: (r: (typeof records)[number]) => T | undefined) => records.map((r) => f(r) ?? null);
    const columns: Record<string, unknown[]> = { time: col((r) => Math.round((Date.parse(r.time) - t0) / 1000)) };
    const add = (name: string, values: unknown[]) => {
      if (values.some((v) => v !== null)) columns[name] = values;
    };
    add("distance", col((r) => r.distance));
    add("latlng", col((r) => (r.lat !== undefined && r.lon !== undefined ? [r.lat, r.lon] : undefined)));
    add("altitude", col((r) => r.altitude));
    add("velocity", col((r) => r.speed));
    add("heartrate", col((r) => r.heartRate));
    add("cadence", col((r) => r.cadence));
    add("watts", col((r) => r.power));
    add("temp", col((r) => r.temperature));
    // Running dynamics and beat-to-beat intervals, when the watch recorded them (not analysed yet).
    add("gct", col((r) => r.gct));
    add("vertical_oscillation", col((r) => r.verticalOscillation));
    add("vertical_ratio", col((r) => r.verticalRatio));
    add("stance_balance", col((r) => r.stanceBalance));
    add("step_length", col((r) => r.stepLength));
    add("rr", col((r) => r.rr));
    return { source: key.slice(0, key.indexOf(":")) as Source, columns };
  }

  /** Totals per week (Monday start), month or year over merged activities: nothing counted twice. */
  async summary(opts: { period?: "week" | "month" | "year"; since?: string; until?: string; sport?: string } = {}) {
    const rows = await this.activities({ since: opts.since, until: opts.until, sport: opts.sport });
    const period = opts.period ?? "week";
    const buckets = new Map<string, { count: number; distance_km: number; moving_h: number; elevation_m: number; hr: number[]; sports: Record<string, number> }>();
    for (const r of rows) {
      const k = bucketKey(r.start, period);
      const b = buckets.get(k) ?? { count: 0, distance_km: 0, moving_h: 0, elevation_m: 0, hr: [], sports: {} };
      b.count++;
      b.distance_km += r.distance_km ?? 0;
      b.moving_h += (r.moving_min ?? 0) / 60;
      b.elevation_m += r.elevation_m ?? 0;
      if (r.avg_hr) b.hr.push(r.avg_hr);
      b.sports[r.sport] = (b.sports[r.sport] ?? 0) + 1;
      buckets.set(k, b);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([k, b]) => ({
        [period]: k,
        activities: b.count,
        distance_km: round(b.distance_km),
        moving_hours: round(b.moving_h, 2),
        elevation_m: Math.round(b.elevation_m),
        avg_hr: b.hr.length ? Math.round(b.hr.reduce((x, y) => x + y, 0) / b.hr.length) : undefined,
        sports: b.sports,
      }));
  }

  /**
   * Best time per standard distance from Strava's best efforts (needs synced details). Each
   * detail file is read once: its efforts are kept in cache/best-efforts.json.
   */
  async bestEfforts(sport = "run") {
    const ids = await this.strava.ids("activities");
    this.effortsCache ??= readJson<EffortsCache>(this.disk, EFFORTS_CACHE).then((c) => c ?? {});
    const cache = await this.effortsCache;
    let changed = false;
    for (const id of ids) {
      if (cache[id]) continue;
      const d = await this.strava.read<StravaActivityDetail>("activities", `${id}.json`);
      cache[id] = {
        sport: d?.sport_type ?? d?.type ?? "",
        efforts: (d?.best_efforts ?? []).map((e) => ({ name: e.name, elapsed_time: e.elapsed_time, distance: e.distance, start_date: e.start_date })),
      };
      changed = true;
    }
    if (changed) await this.disk.write(EFFORTS_CACHE, JSON.stringify(cache)).catch(() => {});
    const merged = await this.merged();
    const canonical = new Map(merged.flatMap((m) => m.members.map((x) => [x.key, m.id] as const)));
    const best = new Map<string, { name: string; time_s: number; pace_min_km?: string; date: string; activity: string }>();
    for (const id of ids) {
      const d = cache[id]!;
      if (!d.efforts.length || sportFamily(d.sport) !== sportFamily(sport)) continue;
      for (const e of d.efforts) {
        const cur = best.get(e.name);
        if (!cur || e.elapsed_time < cur.time_s) {
          best.set(e.name, { name: e.name, time_s: e.elapsed_time, pace_min_km: pace(e.distance / e.elapsed_time), date: e.start_date, activity: canonical.get(`strava:${id}`) ?? `strava:${id}` });
        }
      }
    }
    return [...best.values()];
  }

  /**
   * Every run's fastest standard distances (the last two years), oldest first: Strava's own when
   * it has the run, else worked out once from the run's time series and kept.
   */
  async runEfforts(): Promise<Array<{ id: string; start: string; efforts: Effort[] }>> {
    await this.bestEfforts("run"); // fills Strava's into the cache
    const strava = (await this.effortsCache) ?? {};
    const own = (await readJson<Record<string, Effort[]>>(this.disk, RUN_EFFORTS)) ?? {};
    let changed = false;
    const rows = (await this.activities({ since: new Date(Date.now() - 730 * 86400_000).toISOString().slice(0, 10), limit: 5000 })).filter((r) => sportFamily(r.sport) === "run");
    const out: Array<{ id: string; start: string; efforts: Effort[] }> = [];
    for (const r of rows) {
      const m = await this.find(r.id);
      const sid = m.members.find((x) => x.source === "strava")?.key.slice(7);
      const fromStrava = sid ? strava[sid]?.efforts : undefined;
      let efforts: Effort[] | undefined = fromStrava?.length ? fromStrava.map((e) => ({ name: e.name, time_s: e.elapsed_time })) : own[r.id];
      if (!efforts) {
        const raw = await this.rawStreams(m).catch(() => null);
        efforts = raw ? effortsFrom(raw.columns.time, raw.columns.distance) : [];
        // Kept once worked out; a run whose time series hasn't arrived yet is tried again later.
        if (raw) {
          own[r.id] = efforts;
          changed = true;
        }
      }
      out.push({ id: r.id, start: r.start, efforts });
    }
    if (changed) await this.disk.write(RUN_EFFORTS, JSON.stringify(own)).catch(() => {});
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  // ------------------------------------------------------------ watch files

  async watchFiles(watch?: string) {
    const watches = await this.local.watches();
    const out = [];
    for (const w of watches) {
      if (watch && w.id !== watch && w.info.name !== watch) continue;
      out.push({ watch: w.id, name: w.info.name, files: await this.local.files(w.id) });
    }
    return out;
  }

  /** A watch file: FIT is parsed, text is returned as text, binary as a hex preview. */
  async readWatchFile(watch: string, path: string, maxBytes = 65536) {
    const data = await this.local.readWatchFile(watch, path);
    if (!data) throw new Error(`no file ${path} saved from ${watch}`);
    const size = data.length;
    if (isFit(data)) {
      const fit = parseFit(data);
      const merged = (await this.merged()).find((m) => m.members.some((x) => fileOf(x.key) === `${watch}${path}`));
      return { path, bytes: size, kind: "FIT activity file", activity: merged?.id, session: fit.session, laps: fit.laps, samples: fit.records.length };
    }
    const kind = sniff(data);
    const slice = data.subarray(0, maxBytes);
    if (kind === "JSON" || kind === "text" || kind.startsWith("XML")) {
      return { path, bytes: size, kind, truncated: size > maxBytes, text: new TextDecoder().decode(slice) };
    }
    const hex = Array.from(slice.subarray(0, 2048), (b) => b.toString(16).padStart(2, "0")).join("");
    return { path, bytes: size, kind, note: "binary file; first 2 KB as hex", hex };
  }

  // ------------------------------------------------------------ merging

  /** Forget the shared merge (after a sync or a backup wrote new data). */
  invalidate(): void {
    this.recent = null;
  }

  /** Each workout with a copy on Strava: its id here → its Strava activity id. */
  async stravaIds(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const m of await this.merged()) {
      const k = m.members.find((x) => x.source === "strava")?.key;
      if (k) out.set(m.id, k.slice(7));
    }
    return out;
  }

  /** Every workout once, newest first. Cached until any source changes. */
  merged(): Promise<MergedActivity[]> {
    if (this.recent && Date.now() - this.recent.at < 1500) return this.recent.p;
    const p = this.computeMerged();
    this.recent = { at: Date.now(), p };
    p.catch(() => (this.recent = null));
    return p;
  }

  private async computeMerged(): Promise<MergedActivity[]> {
    const candidates = await this.candidates();
    const sig = `${candidates.filter((c) => c.source === "logged").map((c) => c.key).join(",")}|${candidates.length}|${candidates.map((c) => `${c.key}@${c.start}`).join(",").length}|${candidates.reduce((n, c) => n + c.start / 1e6 + (c.has_streams ? 1 : 0) + (c.feeling ?? 0) / 7, 0)}`;
    if (this.memo?.sig === sig) return this.memo.merged;
    const file = "activity-links.json";
    const links = (await readJson<LinkTable>(this.disk, file)) ?? {};
    const before = JSON.stringify(links);
    // Health apps' copies were watch files before they were a source of their own: same ids.
    migrateLinks(links, fileSourceOf);
    const merged = mergeActivities(candidates, links);
    if (JSON.stringify(links) !== before) {
      await this.disk.write(file, JSON.stringify(links));
    }
    this.memo = { sig, merged, links };
    return merged;
  }

  async find(id: string): Promise<MergedActivity> {
    const merged = await this.merged();
    const key = /^\d+$/.test(id) ? `strava:${id}` : id;
    const alias = this.memo ? resolveAlias(this.memo.links, key) : key;
    // A key from before health apps' copies were a source of their own ("watch:hc-…/…").
    const was = key.startsWith("watch:") ? fileSourceOf(fileOf(key).split("/")[0]!) : "watch";
    const legacy = was !== "watch" ? `${was}:${fileOf(key)}` : key;
    const hit =
      merged.find((m) => m.id === key || m.members.some((x) => x.key === key || x.key === legacy)) ??
      merged.find((m) => m.id === alias);
    if (!hit) throw new Error(`unknown activity ${id}; use the ids returned by list_activities`);
    return hit;
  }

  private async candidates(): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const streamIds = await this.strava.ids("streams");
    for (const a of await this.strava.index()) out.push(stravaCandidate(a, streamIds.has(String(a.id))));
    for (const r of await this.recordings.all()) {
      if (!r.end) continue; // still recording
      const s = summarize(r);
      out.push(
        compact({
          key: `phone:${r.id}`,
          source: "phone" as const,
          start: Date.parse(r.start),
          elapsed_s: s.elapsed_s,
          moving_s: s.moving_s,
          distance_m: s.distance_m,
          sport: r.sport,
          name: r.name,
          elevation_m: s.elevation_m,
          avg_hr: s.avg_hr,
          max_hr: s.max_hr,
          avg_speed: s.moving_s ? s.distance_m / s.moving_s : undefined,
          device: "Phone",
          has_streams: s.points > 1,
        }),
      );
    }
    for (const w of await this.cloudWorkouts()) {
      const c = cloudCandidate(w);
      if (c) out.push(c);
    }
    const said = await this.logged.all();
    for (const w of await this.local.watches()) {
      for (const f of await this.local.files(w.id)) {
        // The Run 2's logbook workouts (SBEM): start, duration and sport so far.
        const lb = /^\/logbook\/(\d+)\/summary\.sbem$/.exec(f.path);
        if (lb) {
          const sum = await this.watchSbem(w.id, `/logbook/${lb[1]}`, `${f.bytes}:${f.modified}`);
          if (sum) {
            out.push(
              compact({
                key: `watch:${w.id}/logbook/${lb[1]}`,
                source: "watch" as const,
                start: sum.workout.start,
                elapsed_s: sum.workout.duration_s,
                moving_s: sum.workout.moving_s ?? sum.workout.duration_s,
                distance_m: sum.workout.distance_m,
                sport: sum.workout.sport,
                elevation_m: sum.workout.ascent_m,
                avg_hr: sum.workout.avg_hr,
                max_hr: sum.workout.max_hr,
                avg_speed: sum.workout.avg_speed,
                avg_cadence: sum.workout.avg_cadence,
                avg_power: sum.workout.avg_power,
                calories: sum.workout.calories,
                device: typeof w.info.name === "string" ? w.info.name : undefined,
                has_streams: !!sum.streams,
                feeling: sum.workout.feeling,
              }),
            );
          }
          continue;
        }
        if (f.kind !== "FIT activity file") continue;
        const fit = await this.watchFit(`${w.id}${f.path}`, `${f.bytes}:${f.modified}`);
        if (fit) {
          const c = fitCandidate(`${w.id}${f.path}`, fit, typeof w.info.name === "string" ? w.info.name : undefined, fileSourceOf(w.id));
          if (c) out.push(c);
        }
      }
    }
    // Logged by word: until a recording of the same sport turns up that day (then it's that one).
    const dayOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const recorded = new Set(out.map((c) => `${dayOf(c.start)}|${sportFamily(c.sport)}`));
    for (const w of said) {
      if (recorded.has(`${w.date}|${sportFamily(w.sport)}`)) continue;
      out.push(
        compact({
          key: `logged:${w.id}`,
          source: "logged" as const,
          start: loggedStart(w),
          elapsed_s: w.minutes ? w.minutes * 60 : undefined,
          moving_s: w.minutes ? w.minutes * 60 : undefined,
          distance_m: w.distance_m,
          sport: w.sport,
          name: w.name,
          avg_speed: w.distance_m && w.minutes ? w.distance_m / (w.minutes * 60) : undefined,
          device: "Told to the coach",
          effort: w.effort,
        }),
      );
    }
    return out;
  }

  private async cloudWorkouts(): Promise<CloudWorkout[]> {
    return (await readJson<CloudWorkout[]>(this.disk, this.local.cloudPath("workouts.json"))) ?? [];
  }

  /**
   * The heart-rate settings on the watch, from its newest logbook workout that carries them:
   * zone 2–5 lower limits and the personal max / resting heart rate (bpm).
   */
  async watchHeartRate(): Promise<{ zones: [number, number, number, number]; max_hr?: number; rest_hr?: number; at: number } | null> {
    let best: { zones: [number, number, number, number]; max_hr?: number; rest_hr?: number; at: number } | null = null;
    for (const w of await this.local.watches()) {
      for (const f of await this.local.files(w.id)) {
        const lb = /^\/logbook\/(\d+)\/summary\.sbem$/.exec(f.path);
        if (!lb) continue;
        const sum = await this.watchSbem(w.id, `/logbook/${lb[1]}`, `${f.bytes}:${f.modified}`);
        const wk = sum?.workout;
        if (wk?.hr_zones && (!best || wk.start > best.at)) best = { zones: wk.hr_zones, max_hr: wk.personal_max_hr, rest_hr: wk.personal_rest_hr, at: wk.start };
      }
    }
    return best;
  }

  /**
   * A logbook workout (`dir` = /logbook/<id>): decoded with its descriptors when the backup
   * saved them (all values and the samples), else the start, duration and sport alone.
   */
  private async watchSbem(watch: string, dir: string, sig: string): Promise<{ workout: SbemWorkoutFull; streams: Record<string, unknown[]> | null } | null> {
    const key = `${watch}${dir}`;
    const cached = this.sbemCache.get(key);
    if (cached && cached.sig === sig) return cached.sum;
    let sum: { workout: SbemWorkoutFull; streams: Record<string, unknown[]> | null } | null = null;
    try {
      const summary = await this.local.readWatchFile(watch, `${dir}/summary.sbem`);
      const desc = await this.local.readWatchFile(watch, `${dir}/descriptors.sbem`).catch(() => null);
      const descriptors = desc ? parseDescriptors(desc) : null;
      const workout = summary ? ((descriptors && decodeWorkout(summary, descriptors)) ?? sbemSummary(summary)) : null;
      if (workout) {
        const data = descriptors ? await this.local.readWatchFile(watch, `${dir}/data.sbem`).catch(() => null) : null;
        const streams = data && descriptors ? decodeStreams(data, descriptors, workout.start + workout.offsetMin * 60_000) : null;
        sum = { workout, streams };
      }
    } catch {
      sum = null;
    }
    this.sbemCache.set(key, { sig, sum });
    return sum;
  }

  private async watchFit(key: string, sig?: string): Promise<FitActivity | null> {
    const cached = this.fitCache.get(key);
    if (cached && (!sig || cached.sig === sig)) return cached.fit;
    const slash = key.indexOf("/");
    if (slash < 0) return null;
    let fit: FitActivity | null = null;
    try {
      const data = await this.local.readWatchFile(key.slice(0, slash), key.slice(slash));
      fit = data ? parseFit(data) : null;
    } catch {
      fit = null; // unreadable or truncated FIT
    }
    this.fitCache.set(key, { sig: sig ?? "", fit });
    return fit;
  }
}

// ------------------------------------------------------------------ candidates per source

function stravaCandidate(a: StravaActivitySummary, hasStreams: boolean): Candidate {
  return compact({
    key: `strava:${a.id}`,
    source: "strava" as const,
    start: Date.parse(a.start_date),
    elapsed_s: a.elapsed_time,
    moving_s: a.moving_time,
    distance_m: a.distance,
    sport: a.sport_type ?? a.type,
    name: a.name,
    elevation_m: a.total_elevation_gain,
    avg_hr: a.average_heartrate,
    max_hr: a.max_heartrate,
    avg_speed: a.average_speed,
    avg_cadence: a.average_cadence,
    avg_power: a.average_watts,
    calories: (a as { calories?: number }).calories,
    device: a.device_name,
    has_streams: hasStreams,
    start_local: a.start_date_local,
  } as Candidate & { start_local?: string });
}

function cloudCandidate(w: CloudWorkout): Candidate | null {
  const start = Number(w.startTime);
  if (!Number.isFinite(start)) return null;
  const hr = (w.hrdata ?? {}) as { avg?: number; max?: number; hrAvg?: number; hrMax?: number };
  const distance = Number(w.totalDistance) || undefined;
  const time = Number(w.totalTime) || undefined;
  return compact({
    key: `suunto-cloud:${w.workoutKey}`,
    source: "suunto-cloud" as const,
    start,
    elapsed_s: time,
    distance_m: distance,
    sport: SUUNTO_SPORTS[Number(w.activityId)] ?? `Suunto activity ${w.activityId}`,
    elevation_m: Number(w.totalAscent) || undefined,
    avg_hr: hr.avg ?? hr.hrAvg,
    max_hr: hr.max ?? hr.hrMax,
    avg_speed: distance && time ? distance / time : undefined,
    calories: Number(w.energyConsumption) || undefined,
    has_streams: false,
    // The Suunto app keeps the watch's "How did it feel?" with the workout.
    feeling: feelingOf(w.feeling),
  });
}

/** The file a "watch:", "health:" or "intervals:" key names: "<folder>/<path>". */
const fileOf = (key: string) => key.slice(key.indexOf(":") + 1);

function fitCandidate(key: string, fit: FitActivity, watchName?: string, source: "watch" | "health" | "intervals" = "watch"): Candidate | null {
  const s = fit.session ?? {};
  const num = (k: string) => (typeof s[k] === "number" ? (s[k] as number) : undefined);
  const startIso = fit.startTime ?? fit.records[0]?.time;
  if (!startIso) return null;
  return compact({
    key: `${source}:${key}`,
    source,
    start: Date.parse(startIso),
    elapsed_s: num("total_elapsed_time"),
    moving_s: num("total_timer_time"),
    distance_m: num("total_distance"),
    sport: fit.sport ?? "unknown",
    elevation_m: num("total_ascent"),
    avg_hr: num("avg_heart_rate"),
    max_hr: num("max_heart_rate"),
    avg_speed: num("enhanced_avg_speed") ?? num("avg_speed"),
    avg_cadence: num("avg_cadence"),
    avg_power: num("avg_power"),
    calories: num("total_calories"),
    device: watchName,
    has_streams: fit.records.length > 1,
  });
}

function toRow(m: MergedActivity): ActivityRow {
  const sport = m.sport;
  const speed = m.avg_speed ?? (m.distance_m && m.moving_s ? m.distance_m / m.moving_s : undefined);
  const local = (m.members.find((x) => x.source === "strava") as (Candidate & { start_local?: string }) | undefined)?.start_local;
  return compact({
    id: m.id,
    start: new Date(m.start).toISOString(),
    start_local: local,
    sport,
    name: m.name,
    distance_km: m.distance_m !== undefined ? round(m.distance_m / 1000, 2) : undefined,
    moving_min: m.moving_s !== undefined ? round(m.moving_s / 60) : undefined,
    elapsed_min: m.elapsed_s !== undefined ? round(m.elapsed_s / 60) : undefined,
    elevation_m: round(m.elevation_m, 0),
    avg_hr: round(m.avg_hr, 0),
    max_hr: round(m.max_hr, 0),
    avg_pace_min_km: isFootSport(sport) ? pace(speed) : undefined,
    avg_speed_kmh: speed ? round(speed * 3.6) : undefined,
    avg_cadence: round(m.avg_cadence, 0),
    avg_power_w: round(m.avg_power, 0),
    calories: round(m.calories, 0),
    device: m.device,
    sources: [...new Set(m.members.map((x) => x.source))],
    streams_from: m.streams_from?.split(":")[0] as Source | undefined,
    feeling: m.members.find((x) => x.feeling)?.feeling as Feeling | undefined,
    effort: m.members.find((x) => x.effort)?.effort,
  });
}

function bucketKey(iso: string, period: "week" | "month" | "year"): string {
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  if (period === "year") return iso.slice(0, 4);
  if (period === "month") return iso.slice(0, 7);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function countBy(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}
