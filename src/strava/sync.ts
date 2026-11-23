import { env, joinPath, readJson, type Disk } from "../disk.ts";
import { StravaClient, StravaRateLimitError, type FetchLike, type StravaActivitySummary, type StravaConfig, type StravaTokens } from "./client.ts";

/**
 * strava/ in the data folder:
 *   config.json          your API app's client id + secret (owner-only)
 *   tokens.json          OAuth tokens (owner-only)
 *   athlete.json, stats.json
 *   index.json           every activity summary, newest first
 *   activities/<id>.json full detail (laps, splits, best efforts, gear)
 *   streams/<id>.json    time series (time, latlng, HR, pace, cadence, power, altitude…)
 */
export class StravaStore {
  constructor(
    readonly disk: Disk,
    /** How to reach Strava (the Android app passes a native HTTP client: Strava has no CORS). */
    private readonly fetchImpl?: FetchLike,
  ) {}

  path(...p: string[]): string {
    return joinPath("strava", ...p);
  }

  read<T>(...p: string[]): Promise<T | null> {
    return readJson<T>(this.disk, this.path(...p));
  }

  async write(data: unknown, ...p: string[]): Promise<void> {
    await this.disk.write(this.path(...p), JSON.stringify(data));
  }

  async writeSecret(data: unknown, name: string): Promise<void> {
    await this.disk.write(this.path(name), JSON.stringify(data), { secret: true });
  }

  async index(): Promise<StravaActivitySummary[]> {
    return (await this.read<StravaActivitySummary[]>("index.json")) ?? [];
  }

  async has(kind: "activities" | "streams", id: number | string): Promise<boolean> {
    const files = await this.ids(kind);
    return files.has(String(id));
  }

  private cache = new Map<string, Set<string>>();
  async ids(kind: "activities" | "streams"): Promise<Set<string>> {
    let set = this.cache.get(kind);
    if (!set) {
      const names = (await this.disk.list(this.path(kind))).map((e) => e.name);
      set = new Set(names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)));
      this.cache.set(kind, set);
    }
    return set;
  }

  async putDetail(kind: "activities" | "streams", id: number, data: unknown): Promise<void> {
    await this.write(data, kind, `${id}.json`);
    (await this.ids(kind)).add(String(id));
  }

  /** After setting a run's shoes on Strava: the same pair in the copies kept here. */
  async setGear(id: string, gear: string | null): Promise<void> {
    const index = await this.index();
    const a = index.find((x) => String(x.id) === id);
    if (a) {
      a.gear_id = gear;
      await this.write(index, "index.json");
    }
    const d = await this.read<Record<string, unknown>>("activities", `${id}.json`);
    if (d) await this.write({ ...d, gear_id: gear }, "activities", `${id}.json`);
  }

  /** A ready client if config + tokens exist (tokens are re-saved on refresh). */
  async client(overrides: Partial<StravaConfig> = {}): Promise<StravaClient | null> {
    const cfg = await this.read<StravaConfig>("config.json");
    const clientId = overrides.clientId ?? cfg?.clientId ?? env("STRAVA_CLIENT_ID");
    const clientSecret = overrides.clientSecret ?? cfg?.clientSecret ?? env("STRAVA_CLIENT_SECRET");
    if (!clientId || !clientSecret) return null;
    const tokens = await this.read<StravaTokens>("tokens.json");
    return new StravaClient(
      {
        clientId,
        clientSecret,
        apiBase: overrides.apiBase ?? env("STRAVA_API_BASE"),
        oauthBase: overrides.oauthBase ?? env("STRAVA_OAUTH_BASE"),
        fetch: overrides.fetch ?? this.fetchImpl,
      },
      tokens,
      (t) => this.writeSecret(t, "tokens.json"),
    );
  }
}

export interface StravaSyncOptions {
  /** Fetch full detail + streams for activities that don't have them yet (default true). */
  details?: boolean;
  /** Re-list the whole history instead of only new activities. */
  full?: boolean;
  /** Stop detail downloads when this many requests remain in the 15-minute window. */
  reserve?: number;
  log?: (m: string) => void;
}

export interface StravaSyncResult {
  total: number;
  added: number;
  detailed: number;
  pendingDetails: number;
  stoppedForRateLimit: boolean;
}

export async function syncStrava(client: StravaClient, store: StravaStore, opts: StravaSyncOptions = {}): Promise<StravaSyncResult> {
  const log = opts.log ?? (() => {});
  const reserve = opts.reserve ?? 3;
  const result: StravaSyncResult = { total: 0, added: 0, detailed: 0, pendingDetails: 0, stoppedForRateLimit: false };

  const nearLimit = () => {
    const u = client.lastUsage;
    return !!u && (u.short[0] >= u.short[1] - reserve || u.daily[0] >= u.daily[1] - reserve);
  };

  let todoCount = 0;
  try {
    const athlete = await client.getAthlete();
    await store.write(athlete, "athlete.json");
    await store.write(await client.getStats(athlete.id), "stats.json");
    log(`[strava] athlete ${athlete.firstname ?? ""} ${athlete.lastname ?? ""} (${athlete.id})`.replace(/\s+/g, " "));

    // 1. Activity list: everything the first time, then only what's new (with a week of overlap
    //    so late uploads and edits are caught).
    const byId = new Map((await store.index()).map((a) => [a.id, a]));
    const newest = Math.max(0, ...[...byId.values()].map((a) => Date.parse(a.start_date) / 1000));
    const after = opts.full || !byId.size ? undefined : Math.floor(newest - 7 * 86400);
    for (let page = 1; ; page++) {
      const batch = await client.listActivities({ after, page, perPage: 100 });
      for (const a of batch) {
        if (!byId.has(a.id)) result.added++;
        byId.set(a.id, a);
      }
      log(`[strava] listed page ${page} (${batch.length} activities)`);
      if (batch.length < 100) break;
    }
    const index = [...byId.values()].sort((a, b) => b.start_date.localeCompare(a.start_date));
    await store.write(index, "index.json");
    result.total = index.length;

    // 2. Detail + streams, newest first, until done or close to the rate limit.
    if (opts.details !== false) {
      const haveDetail = await store.ids("activities");
      const haveStreams = await store.ids("streams");
      const todo = index.filter((a) => !haveDetail.has(String(a.id)) || !haveStreams.has(String(a.id)));
      todoCount = todo.length;
      for (const a of todo) {
        if (nearLimit()) {
          result.stoppedForRateLimit = true;
          break;
        }
        if (!haveDetail.has(String(a.id))) await store.putDetail("activities", a.id, await client.getActivity(a.id));
        if (!haveStreams.has(String(a.id))) {
          // Manual activities have no streams; store an empty object so we don't retry forever.
          const streams = await client.getStreams(a.id).catch((e: Error) => {
            if (/→ 404/.test(e.message)) return {};
            throw e;
          });
          await store.putDetail("streams", a.id, streams);
        }
        result.detailed++;
        log(`[strava] ${a.start_date.slice(0, 10)} ${a.sport_type ?? a.type} "${a.name}"`);
      }
    }
  } catch (e) {
    if (!(e instanceof StravaRateLimitError)) throw e;
    result.stoppedForRateLimit = true;
    log(`[strava] ${e.message}`);
  }
  result.pendingDetails = Math.max(0, todoCount - result.detailed);
  await store.write({ lastSync: new Date().toISOString(), ...result }, "state.json");
  await store.disk.append("events.jsonl", JSON.stringify({ at: new Date().toISOString(), lane: "strava", kind: "sync", added: result.added, ok: true }) + "\n").catch(() => {});
  if (result.stoppedForRateLimit) {
    log(`[strava] paused for the rate limit; ${result.pendingDetails} activities still need detail. Run sync again in 15 minutes.`);
  }
  return result;
}
