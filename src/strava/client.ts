/**
 * Strava API v3 client: OAuth (authorization code + refresh), activities, streams, laps,
 * athlete stats. Your Suunto watch already pushes every workout to Strava through the
 * Suunto app, so this is the reliable "everything, fully detailed" source.
 *
 * You need your own Strava API application (free): https://www.strava.com/settings/api
 * Set "Authorization Callback Domain" to `localhost`.
 */

/** fetch, or anything shaped like it (the app's native HTTP bridge). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
  /** For tests: base of the REST API and of the OAuth endpoints. */
  apiBase?: string;
  oauthBase?: string;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
}

export interface StravaTokens {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
  athlete?: { id: number; firstname?: string; lastname?: string; username?: string };
  scope?: string;
}

export interface RateUsage {
  /** Requests used in the current 15-minute window / its limit. */
  short: [number, number];
  /** Requests used today / the daily limit. */
  daily: [number, number];
}

export class StravaRateLimitError extends Error {
  constructor(readonly usage: RateUsage | null) {
    super(
      "Strava rate limit reached" +
        (usage ? ` (${usage.short[0]}/${usage.short[1]} per 15 min, ${usage.daily[0]}/${usage.daily[1]} per day)` : "") +
        ". Sync is incremental: run it again later and it continues where it stopped.",
    );
  }
}

/** activity:write lets Tartan upload runs recorded on the phone. */
export const STRAVA_SCOPES = "read,activity:read_all,profile:read_all,activity:write";
export const STREAM_KEYS = [
  "time", "distance", "latlng", "altitude", "velocity_smooth", "heartrate", "cadence", "watts", "temp", "moving", "grade_smooth",
] as const;

export class StravaClient {
  readonly apiBase: string;
  readonly oauthBase: string;
  lastUsage: RateUsage | null = null;
  private readonly fetch: FetchLike;

  constructor(
    readonly config: StravaConfig,
    private tokens: StravaTokens | null = null,
    /** Called whenever tokens change (persist them). */
    private readonly onTokens: (t: StravaTokens) => void | Promise<void> = () => {},
  ) {
    this.apiBase = (config.apiBase ?? "https://www.strava.com/api/v3").replace(/\/$/, "");
    this.oauthBase = (config.oauthBase ?? "https://www.strava.com/oauth").replace(/\/$/, "");
    this.fetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  get connected(): boolean {
    return !!this.tokens;
  }

  get athlete() {
    return this.tokens?.athlete;
  }

  /**
   * The consent page. `mobile` is Strava's mobile flow: on Android, opening it outside the app
   * goes to the Strava app when it is installed (else the browser), and it may return to a
   * custom-scheme redirect such as tartan://localhost.
   */
  authorizeUrl(redirectUri: string, state: string, opts: { mobile?: boolean } = {}): string {
    const u = new URL(`${this.oauthBase}/${opts.mobile ? "mobile/" : ""}authorize`);
    u.searchParams.set("client_id", this.config.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("approval_prompt", "auto");
    u.searchParams.set("scope", STRAVA_SCOPES);
    u.searchParams.set("state", state);
    return u.toString();
  }

  /** `scope`: what the athlete actually granted (Strava returns it on the redirect). */
  async exchangeCode(code: string, scope?: string): Promise<StravaTokens> {
    return this.tokenRequest({ grant_type: "authorization_code", code }, scope);
  }

  /** Was upload permission granted? Unknown (connected before uploads existed) counts as no. */
  get canUpload(): boolean {
    return !!this.tokens?.scope?.split(",").includes("activity:write");
  }

  /**
   * Upload a recorded activity file and wait (up to about a minute) for Strava to process it.
   * Returns the new activity's id. A file Strava already has counts as uploaded.
   */
  async upload(file: { data: string; name?: string; dataType: "tcx" | "gpx"; externalId: string; sport?: string; description?: string }): Promise<{ upload_id: number; activity_id?: number }> {
    const boundary = `----tartan${Math.random().toString(36).slice(2)}`;
    const part = (k: string, v: string, filename?: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"${filename ? `; filename="${filename}"` : ""}\r\n${filename ? "Content-Type: application/octet-stream\r\n" : ""}\r\n${v}\r\n`;
    const body =
      part("data_type", file.dataType) +
      part("external_id", file.externalId) +
      (file.name ? part("name", file.name) : "") +
      (file.sport ? part("sport_type", file.sport) : "") +
      (file.description ? part("description", file.description) : "") +
      part("file", file.data, `${file.externalId}.${file.dataType}`) +
      `--${boundary}--\r\n`;
    const res = await this.fetch(`${this.apiBase}/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": `multipart/form-data; boundary=${boundary}`, accept: "application/json" },
      body,
    });
    this.lastUsage = parseUsage(res.headers);
    if (res.status === 401 || res.status === 403) throw new Error("Strava hasn't allowed Tartan to upload. Reconnect Strava in Settings and approve uploads.");
    if (res.status === 429) throw new StravaRateLimitError(this.lastUsage);
    const first = (await res.json().catch(() => ({}))) as { id?: number; error?: string | null; activity_id?: number | null };
    if (!res.ok || !first.id) throw new Error(`Strava upload failed (${res.status}): ${first.error ?? JSON.stringify(first).slice(0, 200)}`);
    let st = first;
    for (let i = 0; i < 30 && !st.activity_id && !st.error; i++) {
      await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 2000));
      st = await this.get<typeof first>(`/uploads/${first.id}`);
    }
    if (st.error) {
      const dup = /duplicate of activity (\d+)/i.exec(st.error);
      if (dup) return { upload_id: first.id, activity_id: Number(dup[1]) };
      throw new Error(`Strava couldn't process the upload: ${st.error}`);
    }
    return { upload_id: first.id, activity_id: st.activity_id ?? undefined };
  }

  private async tokenRequest(params: Record<string, string>, grantedScope?: string): Promise<StravaTokens> {
    const res = await this.fetch(`${this.oauthBase}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<StravaTokens> & { message?: string };
    if (!res.ok || !body.access_token || !body.refresh_token) {
      throw new Error(`Strava token request failed (${res.status}): ${body.message ?? JSON.stringify(body)}`);
    }
    const tokens: StravaTokens = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
      athlete: body.athlete ?? this.tokens?.athlete,
      scope: grantedScope ?? this.tokens?.scope,
    };
    this.tokens = tokens;
    await this.onTokens(tokens);
    return tokens;
  }

  private async accessToken(): Promise<string> {
    if (!this.tokens) throw new Error("Strava is not connected yet. Run `tartan strava-auth` or use the web app.");
    if (this.tokens.expires_at - 120 < Date.now() / 1000) {
      await this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.tokens.refresh_token });
    }
    return this.tokens.access_token;
  }

  async get<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, { headers: { authorization: `Bearer ${await this.accessToken()}`, accept: "application/json" } });
      this.lastUsage = parseUsage(res.headers);
      if (res.status === 401 && attempt === 0 && this.tokens) {
        // Token revoked or clock skew: force one refresh.
        this.tokens.expires_at = 0;
        continue;
      }
      if (res.status === 429) throw new StravaRateLimitError(this.lastUsage);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Strava GET ${url.pathname} → ${res.status} ${text.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    }
  }

  /** Change an activity (here: which pair of shoes it used). Needs activity:write. */
  async updateActivity(id: number | string, body: { gear_id?: string }): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(`${this.apiBase}/activities/${id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      this.lastUsage = parseUsage(res.headers);
      if (res.status === 401 && attempt === 0 && this.tokens) {
        this.tokens.expires_at = 0;
        continue;
      }
      if (res.status === 403) throw new Error("Strava hasn't allowed Tartan to change activities. Reconnect Strava in Settings and approve uploads.");
      if (res.status === 429) throw new StravaRateLimitError(this.lastUsage);
      if (!res.ok) throw new Error(`Strava PUT /activities/${id} → ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return;
    }
  }

  /** Who Tartan is connected as, with their shoes (profile:read_all) and bikes. */
  getAthlete() {
    return this.get<StravaAthlete>("/athlete");
  }

  getStats(athleteId: number) {
    return this.get<Record<string, unknown>>(`/athletes/${athleteId}/stats`);
  }

  /** One page of activities, newest first unless `after` is given. */
  listActivities(opts: { after?: number; before?: number; page?: number; perPage?: number } = {}) {
    return this.get<StravaActivitySummary[]>("/athlete/activities", {
      after: opts.after,
      before: opts.before,
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 100,
    });
  }

  getActivity(id: number | string) {
    return this.get<StravaActivityDetail>(`/activities/${id}`, { include_all_efforts: false });
  }

  getStreams(id: number | string, keys: readonly string[] = STREAM_KEYS) {
    return this.get<Record<string, { data: unknown[]; series_type?: string; resolution?: string }>>(`/activities/${id}/streams`, {
      keys: keys.join(","),
      key_by_type: true,
    });
  }

  getZones(id: number | string) {
    return this.get<unknown[]>(`/activities/${id}/zones`);
  }
}

function parseUsage(h: Headers): RateUsage | null {
  // Read-endpoint limits are reported separately on newer apps; take the stricter of the two.
  const pair = (s: string | null) => (s ? (s.split(",").map(Number) as [number, number]) : null);
  const usage = pair(h.get("x-readratelimit-usage")) ?? pair(h.get("x-ratelimit-usage"));
  const limit = pair(h.get("x-readratelimit-limit")) ?? pair(h.get("x-ratelimit-limit"));
  if (!usage || !limit) return null;
  return { short: [usage[0], limit[0]], daily: [usage[1], limit[1]] };
}

export interface StravaAthlete {
  id: number;
  username?: string;
  firstname?: string;
  lastname?: string;
  city?: string;
  country?: string;
  sex?: string;
  weight?: number;
  ftp?: number;
  shoes?: Array<{ id: string; name?: string; nickname?: string | null; primary?: boolean; distance?: number; retired?: boolean }>;
  [k: string]: unknown;
}

export interface StravaActivitySummary {
  id: number;
  name: string;
  type: string;
  sport_type?: string;
  start_date: string;
  start_date_local?: string;
  timezone?: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain?: number;
  average_speed?: number;
  max_speed?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  average_watts?: number;
  kilojoules?: number;
  suffer_score?: number;
  device_name?: string;
  gear_id?: string | null;
  [k: string]: unknown;
}

export interface StravaActivityDetail extends StravaActivitySummary {
  description?: string | null;
  calories?: number;
  laps?: unknown[];
  splits_metric?: unknown[];
  best_efforts?: Array<{ name: string; elapsed_time: number; moving_time: number; distance: number; start_date: string; pr_rank?: number | null }>;
  gear?: unknown;
}
