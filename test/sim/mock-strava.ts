/** A small Strava API look-alike: OAuth, token expiry, paging, `after`, rate-limit headers and 429s. */
export interface MockStravaOptions {
  activities: number;
  /** Requests allowed per 15-minute window before answering 429. */
  shortLimit?: number;
  /** Access tokens expire immediately (forces the refresh path). */
  expireTokens?: boolean;
}

export function startMockStrava(opts: MockStravaOptions) {
  let used = 0;
  let tokenSerial = 0;
  const shortLimit = opts.shortLimit ?? 600;
  const valid = new Set<string>();
  const counts = { token: 0, refresh: 0, api: 0, gear: 0 };
  const base = Date.parse("2026-01-05T06:00:00Z");
  const uploads: Array<{ id: number; external_id: string; error: string | null; activity_id: number | null; tcx?: string }> = [];
  const activities = Array.from({ length: opts.activities }, (_, i) => ({
    id: 1000 + i,
    name: i % 3 === 0 ? `Long run ${i}` : `Easy run ${i}`,
    type: "Run",
    sport_type: i % 5 === 0 ? "TrailRun" : "Run",
    start_date: new Date(base + i * 2 * 86400_000).toISOString(),
    start_date_local: new Date(base + i * 2 * 86400_000).toISOString().replace("Z", ""),
    distance: 8000 + (i % 4) * 2000,
    moving_time: 2700 + (i % 4) * 600,
    elapsed_time: 2800 + (i % 4) * 600,
    total_elevation_gain: 50 + i,
    average_speed: 3.1,
    max_speed: 4.2,
    average_heartrate: 140 + (i % 10),
    max_heartrate: 170,
    device_name: "Suunto Run 2",
    // Every other run has the athlete's one pair of shoes on it.
    gear_id: (i % 2 === 0 ? "g11" : null) as string | null,
  }));

  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, accept", "access-control-expose-headers": "x-ratelimit-limit, x-ratelimit-usage" };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      // CORS so the app's in-browser preview can reach it (the real app uses native HTTP).
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const res = await handle(req);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    },
  });
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/oauth/authorize" || url.pathname === "/oauth/mobile/authorize") {
      // The consent page, already approved: straight back to the app with a code.
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("code", "good-code");
      back.searchParams.set("scope", url.searchParams.get("scope") ?? "");
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(await req.text());
      // The tests' app, or the realistic-looking one the phone e2e types (the setup form checks the shape).
      const ok = (form.get("client_id") === "cid" && form.get("client_secret") === "secret") || (form.get("client_id") === "123456" && form.get("client_secret") === "0123456789abcdef0123456789abcdef01234567");
      if (!ok) return Response.json({ message: "Bad client" }, { status: 401 });
      if (form.get("grant_type") === "refresh_token") counts.refresh++;
      else if (form.get("code") !== "good-code") return Response.json({ message: "Bad code" }, { status: 400 });
      counts.token++;
      const access = `tok-${++tokenSerial}`;
      valid.add(access);
      return Response.json({
        token_type: "Bearer",
        access_token: access,
        refresh_token: `ref-${tokenSerial}`,
        expires_at: Math.floor(Date.now() / 1000) + (opts.expireTokens ? 0 : 21600),
        athlete: { id: 42, firstname: "Test", lastname: "Runner" },
      });
    }
    if (!url.pathname.startsWith("/api/v3/")) return new Response("nope", { status: 404 });
    const auth = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    if (!valid.has(auth)) return Response.json({ message: "Authorization Error" }, { status: 401 });
    counts.api++;
    used++;
    const headers = { "x-ratelimit-limit": `${shortLimit},2000`, "x-ratelimit-usage": `${used},${used}` };
    if (used > shortLimit) return Response.json({ message: "Rate Limit Exceeded" }, { status: 429, headers });
    const path = url.pathname.slice("/api/v3".length);
    let m: RegExpExecArray | null;
    if (path === "/uploads" && req.method === "POST") {
      // A TCX upload becomes an activity the next sync lists, like the real thing.
      const form = await req.formData();
      const ext = String(form.get("external_id") ?? "");
      const prior = uploads.find((u) => u.external_id === ext);
      const id = 900 + uploads.length;
      if (prior) {
        uploads.push({ id, external_id: ext, error: `${ext}.tcx duplicate of activity ${prior.activity_id}`, activity_id: null });
        return Response.json({ id, status: "Your activity is still being processed.", error: null, activity_id: null }, { status: 201, headers });
      }
      const tcx = await (form.get("file") as Blob).text();
      const times = [...tcx.matchAll(/<Time>([^<]+)<\/Time>/g)].map((x) => x[1]!);
      const dists = [...tcx.matchAll(/<DistanceMeters>([\d.]+)<\/DistanceMeters>/g)].map((x) => Number(x[1]));
      const moving = Number(/<TotalTimeSeconds>([\d.]+)</.exec(tcx)?.[1] ?? 0);
      const activityId = 7000 + uploads.length;
      const distance = Math.max(0, ...dists);
      activities.push({
        id: activityId, name: String(form.get("name") ?? "Run"), type: "Run", sport_type: String(form.get("sport_type") ?? "Run"),
        start_date: times[0]!, start_date_local: times[0]!.replace("Z", ""), distance, moving_time: moving, elapsed_time: moving,
        total_elevation_gain: 0, average_speed: moving ? distance / moving : 0, max_speed: 0, average_heartrate: 0, max_heartrate: 0, device_name: "Tartan (phone)", gear_id: null,
      });
      uploads.push({ id, external_id: ext, error: null, activity_id: activityId, tcx });
      return Response.json({ id, status: "Your activity is still being processed.", error: null, activity_id: null }, { status: 201, headers });
    }
    if ((m = /^\/uploads\/(\d+)$/.exec(path))) {
      const u = uploads.find((x) => x.id === Number(m![1]));
      return u ? Response.json({ id: u.id, error: u.error, activity_id: u.error ? null : u.activity_id, status: u.error ? "There was an error processing your activity." : "Your activity is ready." }, { headers }) : new Response("not found", { status: 404, headers });
    }
    if (path === "/athlete") {
      const km = activities.filter((a) => a.gear_id === "g11").reduce((n, a) => n + a.distance, 0);
      return Response.json({ id: 42, firstname: "Test", lastname: "Runner", city: "Helsinki", weight: 70, shoes: [{ id: "g11", name: "Saucony Endorphin Speed 4", nickname: null, primary: true, distance: km + 42_000, retired: false }] }, { headers });
    }
    if ((m = /^\/activities\/(\d+)$/.exec(path)) && req.method === "PUT") {
      // Setting a run's shoes: only a pair the athlete has.
      const a = activities.find((x) => x.id === Number(m![1]));
      const body = (await req.json()) as { gear_id?: string };
      if (!a) return new Response("not found", { status: 404, headers });
      if (body.gear_id !== "g11" && body.gear_id !== "none") return Response.json({ message: "Bad Request" }, { status: 400, headers });
      a.gear_id = body.gear_id === "none" ? null : body.gear_id;
      counts.gear++;
      return Response.json(a, { headers });
    }
    if (path === "/athletes/42/stats") return Response.json({ all_run_totals: { count: activities.length } }, { headers });
    if (path === "/athlete/activities") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const page = Number(url.searchParams.get("page") ?? 1);
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const list = activities.filter((a) => Date.parse(a.start_date) / 1000 > after).sort((a, b) => (after ? a.start_date.localeCompare(b.start_date) : b.start_date.localeCompare(a.start_date)));
      return Response.json(list.slice((page - 1) * per, page * per), { headers });
    }
    if ((m = /^\/activities\/(\d+)$/.exec(path))) {
      const a = activities.find((x) => x.id === Number(m![1]));
      if (!a) return new Response("not found", { status: 404, headers });
      return Response.json(
        {
          ...a,
          description: "felt good",
          laps: [{ lap_index: 1, distance: a.distance / 2 }, { lap_index: 2, distance: a.distance / 2 }],
          best_efforts: [
            { name: "1k", elapsed_time: 300 - (a.id % 7), moving_time: 300, distance: 1000, start_date: a.start_date, pr_rank: null },
            { name: "5k", elapsed_time: 1600 - (a.id % 11), moving_time: 1600, distance: 5000, start_date: a.start_date, pr_rank: null },
          ],
          map: { summary_polyline: "xyz" },
          segment_efforts: [{ big: true }],
        },
        { headers },
      );
    }
    if ((m = /^\/activities\/(\d+)\/streams$/.exec(path))) {
      // A plausible loop: heart rate drifting up with a few surges, rolling terrain. A sample
      // every 3 s for the activity's moving time (1000 samples, 50 min, when there is none).
      const act = activities.find((x) => x.id === Number(m![1]));
      const n = act?.moving_time ? Math.round(act.moving_time / 3) : 1000;
      const seed = Number(m[1]);
      const wave = (i: number, period: number, phase = 0) => Math.sin((i / n) * Math.PI * 2 * period + phase + seed);
      const speed = Array.from({ length: n }, (_, i) => +(3.1 + 0.25 * wave(i, 3) + 0.12 * wave(i, 17, 1) - 0.18 * wave(i, 5, 2)).toFixed(2));
      return Response.json(
        {
          time: { data: Array.from({ length: n }, (_, i) => i * 3) },
          heartrate: { data: Array.from({ length: n }, (_, i) => Math.round(124 + 22 * (1 - Math.exp(-i / 120)) + (i / n) * 8 + 5 * wave(i, 5, 2) + 2 * wave(i, 31))) },
          distance: { data: Array.from({ length: n }, (_, i) => +(i * 9.3).toFixed(1)) },
          velocity_smooth: { data: speed },
          altitude: { data: Array.from({ length: n }, (_, i) => +(32 + 14 * wave(i, 2, 0.5) + 5 * wave(i, 7)).toFixed(1)) },
          latlng: {
            data: Array.from({ length: n }, (_, i) => {
              const a = (i / n) * Math.PI * 2;
              const r = 0.012 + 0.003 * Math.sin(a * 3 + seed);
              return [+(60.17 + r * Math.sin(a) * 0.9).toFixed(6), +(24.94 + r * 1.9 * Math.cos(a) + 0.004 * Math.sin(a * 2)).toFixed(6)];
            }),
          },
        },
        { headers },
      );
    }
    return new Response("not found", { status: 404, headers });
  }
  return {
    url: `http://127.0.0.1:${server.port}`,
    counts,
    resetWindow: () => (used = 0),
    addActivity: (a: (typeof activities)[number]) => activities.push(a),
    activities,
    uploads,
    stop: () => server.stop(true),
  };
}
