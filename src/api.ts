/**
 * Tartan's /api, as a plain Request → Response handler with no server attached.
 * The PC serves it over HTTP (./server.ts); the Android app calls it in-process
 * (web/local-api.ts), so both run the same library, Strava sync, analytics and coach.
 */
import { loadBody, loggedSets, workoutMuscles } from "./fatigue.ts";
import { loadRunFinish } from "./run-finish.ts";
import { afterRunWords, claimNewRuns, nextDay } from "./after-run.ts";
import { listFiles, merge, pull, push, readState, receive, reconcile, remote, syncWith, transferable, writeState, type LinkState } from "./transfer.ts";
import { tunnel, type Link } from "./link.ts";
import { sportFamily } from "./merge.ts";
import { Lifts, nextWeights, prsIn, records, restSeconds, summarize as liftSummary, targetsFor, type Context } from "./strength/log.ts";
import { lapSeconds, setsFromLaps } from "./strength/from-watch.ts";
import { limitFor, shoePicks, Shoes, shoeFor, shoeRuns, shoesNow, switchAdvice, toStrava, wornOut, type ShoePick, type ShoeTotal } from "./shoes.ts";
import { StravaRateLimitError, type StravaAthlete } from "./strava/client.ts";
import { routineOf } from "./strength/exercises.ts";
import { nigglePattern, recentFeelings, RunNotes } from "./run-notes.ts";
import { CheckIns, todayReadiness } from "./readiness.ts";
import { Memory } from "./memory.ts";
import { bodySigns, Health, localDate } from "./health.ts";
import { alreadyHere, hkFolder, hkWorkout, type HkSession } from "./apple-health.ts";
import { coveredBy, HealthConnectStore, hcFolder, hcWorkout, sleepSession, trendRecords, workoutKey, workoutRecords, type HcRecord, type HcSession } from "./health-connect.ts";
import type { Analytics } from "./analytics.ts";
import { durability } from "./durability.ts";
import { makeBasicPlan, readTargetDay } from "./basic-plan.ts";
import { importFile, importWorkout } from "./import.ts";
import { Intervals } from "./intervals.ts";
import { isSample, seedSample } from "./sample.ts";
import { forecastSoon, pastSoon, upcomingWeather, Weather } from "./weather.ts";
import { bodyTags, Habits } from "./habits.ts";
import { proposeAhead } from "./day-swap.ts";
import { nudgeFacts, nudgeLines } from "./nudge.ts";
import type { Availability } from "./analytics.ts";
import type { ChatImage, Coach, CoachSettings } from "./coach.ts";
import { mondayOf, Plans, today } from "./plan.ts";
import type { LifeEvent } from "./life.ts";
import { readJson } from "./disk.ts";
import { readPrefs, savePrefs, slots, timeFor, toIcs, type SchedulePrefs } from "./schedule.ts";
import { fitName, hcPlanned, sportOf, workoutFit } from "./workout/export.ts";
import { DEFAULT_FUEL, plannedWeek, type FuelPlan } from "./workout/from-plan.ts";
import { zip } from "./watchface/package.ts";
import { Routes, toGpx, type LngLat, type RouteInput } from "./routes.ts";
import { Faces } from "./faces.ts";
import type { FaceDesign } from "./watchface/tartan-face.ts";
import { WatchToStrava } from "./watch-to-strava.ts";
import type { Library } from "./library.ts";
import type { LocalStore } from "./store.ts";
import { summarize, toTcx, type Recording } from "./recording.ts";
import { syncStrava } from "./strava/sync.ts";
import { backupName, makeBackup, readBackup, restoreBackup } from "./backup.ts";

export interface ApiOptions {
  store: LocalStore;
  library: Library;
  analytics: Analytics;
  coach: Coach;
  /** Where Strava sends the browser back to after consent. */
  stravaRedirect: (req: Request) => string;
  /** Use Strava's mobile consent flow (the Android app). */
  stravaMobile?: boolean;
}

export interface Api {
  /** null when no /api route matches. */
  handle(req: Request): Promise<Response | null>;
  /** Finish Strava OAuth: check the state we issued and trade the code for tokens. */
  stravaExchange(state: string, code: string, scope?: string): Promise<void>;
}

const MAX_FILE = 256 * 1024 * 1024;
const OAUTH_STATES = "strava/oauth-states.json";
/** The last weekly review: { week, at, text, changed, conversation }. */
const WEEKLY = "coach/weekly-review.json";

type Params = Record<string, string>;
type Handler = (req: Request, p: Params, q: URLSearchParams) => Promise<Response>;

export function ndjson(work: (send: (o: object) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(ctrl) {
        const send = (o: object) => ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        try {
          await work(send);
        } catch (e) {
          send({ error: (e as Error).message });
        }
        ctrl.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

/** The backup passphrase from its header (base64 of UTF-8). */
function passphraseOf(req: Request): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(req.headers.get("x-passphrase") ?? ""), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

export function createApi(o: ApiOptions): Api {
  const { store, library, analytics, coach } = o;
  const plans = new Plans(library);
  const watchToStrava = new WatchToStrava(library);
  const disk = store.disk;
  // intervals.icu, over the app's HTTP (native on the phone).
  const intervals = () => new Intervals(disk, library.fetch ?? ((u, i) => fetch(u, i)));
  const noContent = () => new Response(null, { status: 204 });
  const savedRoutes = new Routes(disk);
  const faces = new Faces(disk);
  const checkins = new CheckIns(disk);
  const notes = new RunNotes(disk);
  const health = new Health(disk);
  const memory = new Memory(disk);
  const body = async () => bodySigns(await health.view());
  const weather = new Weather(library);
  const habits = new Habits(disk);
  /** Days to your race (your target's), when it's ahead. */
  const raceDays = async () => {
    const d = (await analytics.goals()).race?.date;
    const n = d ? Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today()}T12:00:00Z`)) / 86400_000) : -1;
    return n >= 0 ? n : null;
  };
  const ready = () =>
    todayReadiness({ plans, load: () => analytics.load(60), checkins, body, feelings: () => recentFeelings(library), prefs: () => readPrefs(disk), habits, forecast: () => forecastSoon(weather), past: () => pastSoon(weather), raceDays });
  const ahead = () => proposeAhead({ disk, plans, habits, checkins, prefs: () => readPrefs(disk), forecast: () => forecastSoon(weather), past: () => pastSoon(weather) });
  const lifts = new Lifts(disk);
  const bodyNow = (without?: string) => loadBody({ lib: library, plans, profile: () => analytics.profile(), checkins, lifts, without });
  /** A day's strength session to lift: the plan's (else the basic routine), your log so far, and each exercise's next step. */
  const liftSession = async (date: string) => {
    const [view, logs, log] = await Promise.all([plans.view(), lifts.all(), lifts.get(date)]);
    const s = view.weeks.flatMap((w) => w.days).find((d) => d.date === date)?.sessions.find((x) => x.kind === "strength");
    // Today, running comes first: fatigued legs and a go-easy morning hold the weights.
    const ctx: Context = {};
    if (date === today()) {
      const [b, r] = await Promise.all([bodyNow(date), ready().catch(() => null)]);
      const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long" });
      ctx.fatigued = Object.fromEntries(
        Object.entries(b.muscles)
          .filter(([, m]) => m.state === "fatigued")
          .map(([k, m]) => [k, m.causes[0] ? `${m.causes[0].what}, ${m.causes[0].date === date ? "today" : day(m.causes[0].date)}` : "the last few days"]),
      );
      if (r) ctx.readiness = r.readiness.level;
    }
    return { date, title: s?.title ?? log?.title ?? "Strength", planned: !!s, log, targets: targetsFor(s?.exercises, s?.duration_min, logs, ctx, date) };
  };
  /** Where you usually run: the start of your latest workout with GPS, for where the map opens. */
  let home: Promise<LngLat | null> | null = null;
  const findHome = async (): Promise<LngLat | null> => {
    for (const row of await library.activities({ limit: 15 })) {
      const raw = await library.rawStreams(await library.find(row.id)).catch(() => null);
      const ll = (raw?.columns.latlng ?? []).find((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) as [number, number] | undefined;
      if (ll) return [ll[1], ll[0]];
    }
    return null;
  };
  const gpxName = (name: string) => `${name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "route"}.gpx`;
  /** Your training times and every session ahead at them (reminders and calendar events are made from these). */
  const schedule = async (prefs?: SchedulePrefs) => {
    const [p, v] = await Promise.all([prefs ?? readPrefs(disk), plans.view()]);
    // Which pair to wear goes in the reminder, when you have more than one.
    const picks = await shoePicks(library, v.weeks.flatMap((w) => w.days.flatMap((d) => d.sessions.map((s) => ({ date: d.date, kind: s.kind, title: s.title })))), v.today).catch(() => ({}) as Record<string, ShoePick>);
    const list = slots(v.weeks, p, v.today).map((x) => (picks[`${x.date}:${x.kind}`] ? { ...x, summary: `${x.summary} · ${picks[`${x.date}:${x.kind}`]!.name}` } : x));
    // For the morning notification: how you are now, and changes waiting on the Coach tab.
    const [ready, proposal] = await Promise.all([analytics.today().catch(() => null), plans.proposal().catch(() => null)]);
    return { prefs: p, today: v.today, slots: list, morning: { readiness: ready?.readiness?.title ?? null, proposed: proposal?.changes?.length ?? 0, plan: v.weeks.length > 0 } };
  };

  /**
   * The coming sessions as workouts for any watch (src/workout/export.ts): the next `days` days,
   * with next time's weights and the drink and gel reminders the phone keeps (`fuel`; null: none).
   */
  const planned = async (fuel?: Partial<FuelPlan> | null, days = 7) => {
    const [view, logs, prefs] = await Promise.all([plans.view(), lifts.all(), readPrefs(disk)]);
    const list = plannedWeek({ ...view, lift_targets: nextWeights(logs) }, fuel === null ? null : { ...DEFAULT_FUEL, ...fuel }, days);
    return { view, list, time: (date: string) => timeFor(prefs, date) };
  };
  const fuelParam = (q: URLSearchParams): Partial<FuelPlan> | null | undefined => {
    const f = q.get("fuel");
    if (f === null) return undefined;
    if (f === "none") return null;
    try {
      return JSON.parse(f) as Partial<FuelPlan>;
    } catch {
      return undefined;
    }
  };

  // OAuth states live on disk: in the app, the WebView leaves for strava.com and comes back
  // as a fresh page load.
  const states = async () => ((await library.strava.read<Array<{ state: string; at: number }>>("oauth-states.json")) ?? []).filter((s) => Date.now() - s.at < 3600_000);
  const issueState = async () => {
    const state = crypto.randomUUID();
    await disk.write(OAUTH_STATES, JSON.stringify([...(await states()).slice(-4), { state, at: Date.now() }]));
    return state;
  };
  const takeState = async (state: string) => {
    const all = await states();
    if (!state || !all.some((s) => s.state === state)) return false;
    await disk.write(OAUTH_STATES, JSON.stringify(all.filter((s) => s.state !== state)));
    return true;
  };

  const routes: Array<[string, string, Handler]> = [
    // ---------------------------------------------------------------- watch backups
    ["GET", "/api/watches", async () => Response.json(await store.watches())],
    ["GET", "/api/watches/:id/files", async (_r, p) => Response.json(await store.files(p.id!))],
    [
      "PUT",
      "/api/watches/:id/info",
      async (req, p) => {
        await store.saveInfo(p.id!, (await req.json()) as object);
        return noContent();
      },
    ],
    ["GET", "/api/watches/:id/exists", async (_r, p, q) => Response.json({ exists: await store.sink(p.id!).has(q.get("path") ?? "") })],
    [
      "GET",
      "/api/watches/:id/file",
      async (_r, p, q) => {
        const path = q.get("path") ?? "";
        const data = await store.readWatchFile(p.id!, path);
        if (!data) return new Response("not found", { status: 404 });
        const name = (path.split("/").pop() || "file").replace(/"/g, "");
        return new Response(data.slice(), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` } });
      },
    ],
    [
      "PUT",
      "/api/watches/:id/file",
      async (req, p, q) => {
        const data = new Uint8Array(await req.arrayBuffer());
        if (data.length > MAX_FILE) return new Response("too large", { status: 413 });
        await store.sink(p.id!).put(q.get("path") ?? "", data);
        library.invalidate();
        return noContent();
      },
    ],

    // ---------------------------------------------------------------- library (what the MCP sees)
    ["GET", "/api/library/overview", async () => Response.json(await library.overview())],
    [
      "GET",
      "/api/library/activities",
      async (_r, _p, q) => Response.json(await library.activities({ since: q.get("since") ?? undefined, sport: q.get("sport") ?? undefined, limit: Number(q.get("limit") ?? 100) })),
    ],
    ["GET", "/api/library/summary", async () => Response.json(await library.summary({ period: "week" }))],
    ["GET", "/api/dashboard", async (_r, _p, q) => Response.json(await analytics.dashboard(Number(q.get("days") ?? 84)))],
    // What your runs say you could race, week by week (Progress → Race shape).
    ["GET", "/api/weather", async () => Response.json(await upcomingWeather(library))],
    ["GET", "/api/durability", async (_r, _p, q) => Response.json(await durability(library, Math.max(4, Math.min(104, Number(q.get("weeks") ?? 26))), Date.now(), new Weather(library)))],
    ["GET", "/api/race-shape", async (_r, _p, q) => Response.json(await analytics.raceShape(Math.max(4, Math.min(52, Number(q.get("weeks") ?? 26)))))],
    // Every day's effort, for Progress's year at a glance.
    ["GET", "/api/days", async (_r, _p, q) => Response.json(await analytics.days(Math.max(7, Math.min(400, Number(q.get("days") ?? 371)))))],
    [
      "GET",
      "/api/today",
      async () => {
        const t = await analytics.today();
        // Shoes near their limit, in "Worth knowing".
        const all = (await shoesNow(library).catch(() => ({ shoes: [] as ShoeTotal[] }))).shoes;
        for (const s of wornOut(all)) t.takeaways.push({ id: `shoes-${s.id}`, tone: "watch", title: `${s.name}: ${Math.round(s.km)} km`, detail: switchAdvice(s, all) });
        // The same place niggling again (run notes and morning checks): a pattern worth acting on.
        for (const p of nigglePattern(await checkins.niggles(21).catch(() => []))) t.takeaways.push({ id: `niggle-${p.area}`, tone: "watch", title: `Your ${p.name}: ${p.times} niggles in three weeks`, detail: `Noted after runs and in your morning checks. Keep runs easy and flat until it's quiet, and see a physio if it keeps coming back.` });
        // The sample's storage (the demo): Today says so, with the way out.
        return Response.json({ ...t, ...((await isSample(disk)) ? { sample: true } : {}) });
      },
    ],
    [
      // The demo's sample data, written once into the demo's own storage (never next to real workouts).
      "POST",
      "/api/sample/seed",
      async () => {
        if (await isSample(disk)) return Response.json({ workouts: 0, already: true });
        if ((await library.activities()).length) return Response.json({ error: "There's data here already: the sample only goes in the demo's own storage." }, { status: 409 });
        const workouts = await seedSample(store, disk);
        library.invalidate();
        return Response.json({ workouts });
      },
    ],
    [
      // The demo only (screenshots): a wet, windy week, a swim on bad days with rain and wind
      // ticked as what puts you off, and an easy run today, so Today's session suggests the swim.
      // {off: true} takes the weather and the choices back.
      "POST",
      "/api/sample/rain",
      async (req) => {
        if (!(await isSample(disk))) return Response.json({ error: "Only in the demo." }, { status: 409 });
        const b = (await req.json().catch(() => ({}))) as { off?: boolean };
        if (b.off) {
          await weather.pin(null);
          await savePrefs(disk, { bad_weather: "run", avoid: [] });
          // A change the rainy week suggested ahead goes with it.
          if ((await plans.proposal())?.source === "weather") await plans.decline();
          return Response.json(await ready());
        }
        const now = new Date();
        const start = Date.parse(`${today(now)}T00:00:00Z`);
        await weather.pin(Array.from({ length: 24 * 8 }, (_, h) => ({ time: new Date(start + h * 3600_000).toISOString().slice(0, 16), temp_c: 9, dew_c: 7, rain_pct: 90, rain_mm: 2.5, wind_kmh: 40, gust_kmh: 62, code: 63 })));
        await savePrefs(disk, { bad_weather: "swim", avoid: ["rain", "wind"] });
        const plan = await plans.current();
        const t = today(now);
        if (plan) {
          const s = plan.weeks.flatMap((w) => w.sessions).find((x) => x.date === t && x.kind !== "rest");
          if (s) await plans.swap(t, s.kind, "", true);
          if (!s || !["easy", "long", "recovery"].includes(s.kind)) {
            const { created: _c, updated: _u, ...input } = plan;
            const easy = plan.zones?.find((z) => /easy/i.test(z.name));
            await plans.save({ ...input, weeks: plan.weeks.map((w) => ({ ...w, sessions: [...w.sessions.filter((x) => x.date !== t), ...(w.start === mondayOf(t) ? [{ date: t, kind: "easy" as const, title: "Easy run", duration_min: 45, target: easy?.heart_rate ? `easy, ${easy.heart_rate}` : "easy, conversational" }] : [])] })) });
          }
        }
        return Response.json(await ready());
      },
    ],
    // ---------------------------------------------------------------- run notes (src/run-notes.ts)
    [
      // A run's notes, and how it felt on the watch.
      "GET",
      "/api/notes",
      async (_r, _p, q) => {
        const run = String(q.get("run") ?? "");
        const a = run ? await library.find(run).catch(() => null) : null;
        return Response.json({ notes: a ? await notes.forRun(a.id) : run ? [] : await notes.all(), feeling: a?.members.find((x) => x.feeling)?.feeling ?? null });
      },
    ],
    [
      "POST",
      "/api/notes",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { run?: string; tag?: string; text?: string; area?: string };
        try {
          const a = await library.find(String(b.run ?? ""));
          const d = new Date(a.start);
          const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          await notes.add({ run: a.id, date, tag: String(b.tag ?? ""), text: b.text, area: b.area });
          return Response.json({ notes: await notes.forRun(a.id) });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    ["DELETE", "/api/notes/:id", async (_r, p) => (await notes.remove(p.id!), Response.json({ ok: true }))],
    // ---------------------------------------------------------------- shoes (src/shoes.ts)
    ["GET", "/api/shoes", async () => Response.json(await shoesNow(library))],
    [
      "PUT",
      "/api/shoes",
      async (req) => {
        try {
          await new Shoes(disk).put((await req.json()) as { name: string });
          return Response.json(await shoesNow(library));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    ["DELETE", "/api/shoes/:id", async (_r, p) => (await new Shoes(disk).remove(p.id!), Response.json(await shoesNow(library)))],
    [
      // Which pair a run counts to, and moving it: {run, shoe: id | null (none) | undefined (automatic)}.
      "GET",
      "/api/shoes/run",
      async (_r, _p, q) => {
        const id = String(q.get("id") ?? "");
        const a = await library.find(id).catch(() => null);
        const view = await shoesNow(library);
        if (!a || !view.shoes.length) return Response.json({ shoe: null, shoes: view.shoes, moved: false });
        const strava = (await library.stravaIds()).get(id);
        const gear = strava ? ((await library.strava.index()).find((x) => String(x.id) === strava)?.gear_id ?? null) : undefined;
        const run = { id, start: new Date(a.start).toISOString(), km: 0, ...(strava ? { strava, gear } : {}) };
        return Response.json({ shoe: shoeFor(run, view), shoes: view.shoes, moved: id in view.assign, on_strava: !!strava, strava: view.strava });
      },
    ],
    [
      // Moving a run to a pair that's linked to Strava sets it on Strava too (when allowed).
      "PUT",
      "/api/shoes/run",
      async (req) => {
        const b = (await req.json()) as { run?: string; shoe?: string | null };
        if (!b.run) return Response.json({ error: "which run?" }, { status: 400 });
        const data = await new Shoes(disk).assign(b.run, b.shoe);
        const pair = b.shoe ? data.shoes.find((s) => s.id === b.shoe) : undefined;
        const sid = (await library.stravaIds()).get(b.run);
        let strava: "set" | "same" | "not-linked" | "not-allowed" | "failed" | null = null;
        if (sid && pair) {
          const client = await library.strava.client();
          const gear = (await library.strava.index()).find((x) => String(x.id) === sid)?.gear_id ?? null;
          if (!pair.strava_id) strava = "not-linked";
          else if (gear === pair.strava_id) strava = "same";
          else if (!client?.canUpload) strava = "not-allowed";
          else
            strava = await client
              .updateActivity(sid, { gear_id: pair.strava_id })
              .then(() => library.strava.setGear(sid, pair.strava_id!))
              .then(() => "set" as const)
              .catch((e: Error) => (console.warn(`[shoes] Strava: ${e.message}`), "failed" as const));
        }
        return Response.json({ ...(await shoesNow(library)), strava });
      },
    ],
    [
      // What shoe is in a photo, on the coach's key (src/coach.ts recogniseShoe).
      "POST",
      "/api/shoes/recognise",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { photo?: string };
        try {
          const r = await coach.recogniseShoe(String(b.photo ?? ""));
          return Response.json({ ...r, limit_km: limitFor(r.kind) });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    [
      // Strava's pairs into Tartan (after each Strava sync): linked by name, or added.
      "POST",
      "/api/shoes/import",
      async () => {
        const athlete = await library.strava.read<StravaAthlete>("athlete.json");
        if (!athlete?.shoes?.length) return Response.json({ added: [], linked: [] });
        return Response.json(await new Shoes(disk).importStrava(athlete.shoes, await shoeRuns(library)));
      },
    ],
    [
      // Set a linked pair on the runs Strava has on another or none, a batch at a time (Strava's
      // limit is 100 requests in 15 minutes, shared with the sync).
      "POST",
      "/api/shoes/strava",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { shoe?: string };
        const data = await new Shoes(disk).read();
        const pair = data.shoes.find((s) => s.id === b.shoe);
        if (!pair?.strava_id) return Response.json({ error: "That pair isn't on Strava yet." }, { status: 400 });
        const client = await library.strava.client();
        if (!client?.canUpload) return Response.json({ error: "Strava hasn't allowed Tartan to change activities. Reconnect Strava in Settings and approve uploads." }, { status: 403 });
        const runs = toStrava(await shoeRuns(library), data, pair.id);
        let done = 0;
        let stopped: string | undefined;
        for (const r of runs.slice(0, 30)) {
          try {
            await client.updateActivity(r.strava!, { gear_id: pair.strava_id });
            await library.strava.setGear(r.strava!, pair.strava_id);
            done++;
          } catch (e) {
            stopped = e instanceof StravaRateLimitError ? "Strava's limit for now: the rest in 15 minutes." : (e as Error).message;
            break;
          }
        }
        return Response.json({ done, left: runs.length - done, stopped });
      },
    ],
    ["GET", "/api/goals", async () => Response.json(await analytics.goalProgress())],
    [
      "PUT",
      "/api/goals",
      async (req) => {
        await analytics.saveGoals((await req.json()) as object);
        return Response.json(await analytics.goalProgress());
      },
    ],
    ["GET", "/api/week", async (_r, _p, q) => Response.json(await analytics.week(q.get("start") ?? undefined))],

    // ---------------------------------------------------------------- the coach's training plan
    [
      "GET",
      "/api/plan",
      async () => {
        const [view, goals, status, recent, logs] = await Promise.all([plans.view(), analytics.goals(), coach.status(), analytics.recent(), lifts.all()]);
        // Each logged day (done or under way, with its records) and next time's weights for the watch.
        const lifted = Object.fromEntries(logs.filter((l) => l.date >= (view.weeks[0]?.start ?? "")).map((l) => [l.date, { finished: !!l.finished, prs: l.finished ? prsIn(l, logs.filter((x) => x.date !== l.date)).length : 0 }]));
        const [proposal, last_change, approval, life] = await Promise.all([plans.proposal(), plans.lastChange(), plans.approval(), plans.life()]);
        // Which pair suits each session ahead (src/shoes.ts pickShoe), keyed date:kind.
        const shoe_picks = await shoePicks(library, view.weeks.flatMap((w) => w.days.flatMap((d) => d.sessions.map((s) => ({ date: d.date, kind: s.kind, title: s.title })))), view.today).catch(() => ({}));
        return Response.json({
          shoe_picks,
          ...view, availability: goals.availability ?? {}, goals, coach_ready: status.ready, recent, lifts: lifted, lift_targets: nextWeights(logs),
          // The coach's suggested change, waiting (without the whole new plan), and the last one taken, to undo.
          proposal: proposal ? { at: proposal.at, base: proposal.base, changes: proposal.changes, note: proposal.plan.change_note, source: proposal.source, model: proposal.model, conversation: proposal.conversation } : null,
          last_change,
          approval,
          life,
        });
      },
    ],
    [
      "PUT",
      "/api/plan/availability",
      async (req) => Response.json((await analytics.saveAvailability((await req.json()) as Availability)) ?? {}),
    ],
    [
      "POST",
      "/api/plan/update",
      async (req) => {
        const body = (await req.json().catch(() => ({}))) as { note?: string; target?: string };
        return ndjson(async (send) => {
          for await (const ev of coach.updatePlan(typeof body.note === "string" ? body.note : undefined, typeof body.target === "string" ? body.target : undefined)) send(ev);
        });
      },
    ],
    [
      // A plan by Tartan's own rules, for anyone without an AI key (src/basic-plan.ts).
      "POST",
      "/api/plan/basic",
      async (req) => {
        const body = (await req.json().catch(() => ({}))) as { target?: string };
        const now = today();
        const until = typeof body.target === "string" && body.target.trim() ? readTargetDay(body.target, now) : undefined;
        if (until === null) return Response.json({ error: `Couldn't read "${body.target}" as a date: try "14 March" or "end of June".` }, { status: 400 });
        try {
          return Response.json(await makeBasicPlan(analytics, plans, { today: now, until }));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 409 });
        }
      },
    ],
    ["GET", "/api/plan/life", async () => Response.json(await plans.life())],
    [
      // A one-tap life change (src/life.ts): ill, better, away, a busy week. Taken at once, with Undo.
      "POST",
      "/api/plan/life",
      async (req) => {
        const e = (await req.json().catch(() => ({}))) as LifeEvent;
        if (!["ill", "better", "away", "busy"].includes(String(e?.type))) return Response.json({ error: "ill, better, away or busy" }, { status: 400 });
        try {
          const r = await plans.applyLife(e);
          // So a chat later knows (the coach's memory; it reads these before planning).
          if (r.memory) await memory.remember(r.memory, e.type === "away" ? "athlete" : "health").catch(() => {});
          return Response.json({ said: r.said, changes: r.changes.length });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    ["POST", "/api/plan/reset", async () => Response.json({ cleared: await plans.reset() })],
    [
      // The coach's suggested change: take it (only against the plan it was made for), or not now.
      "POST",
      "/api/plan/proposal",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { accept?: boolean; base?: string };
        try {
          if (b.accept) await plans.accept(String(b.base ?? ""));
          else await plans.decline();
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 409 });
        }
        return Response.json({ ok: true });
      },
    ],
    [
      // How much of the coach's change goes in without asking: ask, small or auto.
      "PUT",
      "/api/plan/approval",
      async (req) => {
        try {
          return Response.json({ mode: await plans.setApproval(String(((await req.json()) as { mode?: string }).mode) as "ask") });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    [
      "POST",
      "/api/plan/revert",
      async () => {
        try {
          await plans.revert();
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 409 });
        }
        return Response.json({ ok: true });
      },
    ],
    ["GET", "/api/plan/weekly", async () => Response.json((await readJson(disk, WEEKLY)) ?? null)],
    [
      // The weekly review (web/sync.ts runs it on Sunday evening): streams like the plan update,
      // and keeps what the coach said and whether it changed the plan.
      "POST",
      "/api/plan/weekly",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { week?: string };
        const week = /^\d{4}-\d{2}-\d{2}$/.test(b.week ?? "") ? b.week! : mondayOf(today());
        return ndjson(async (send) => {
          const before = (await plans.current())?.updated;
          let text = "";
          let conversation: string | undefined;
          for await (const ev of coach.weeklyReview(week)) {
            if (ev.type === "text") text += ev.delta;
            if (ev.type === "conversation") conversation = ev.id;
            if (ev.type === "error") {
              send(ev);
              return;
            }
            send(ev);
          }
          const after = (await plans.current())?.updated;
          // Its changes wait for the athlete as a proposal (made during this review).
          const proposal = await plans.proposal();
          const proposed = proposal && proposal.source === "weekly" && proposal.conversation === conversation ? proposal.changes.length : 0;
          const record = { week, at: new Date().toISOString(), text: text.trim(), changed: !!after && after !== before, proposed, conversation };
          await disk.write(WEEKLY, JSON.stringify(record, null, 2));
          send({ type: "weekly", ...record });
        });
      },
    ],
    [
      "GET",
      "/api/readiness",
      async () => {
        // Weather you avoid a few days ahead: a change waits on the Coach tab (once a week at most).
        await ahead().catch(() => {});
        return Response.json(await ready());
      },
    ],
    [
      // "Give me a nudge" (Today's Different plan today?): a few words from your own data; the
      // cloud coach words them when it can, Tartan's rules otherwise.
      "POST",
      "/api/today/nudge",
      async () => {
        const r = await ready();
        const c = r.day_choices;
        if (!c) return Response.json({ error: "No session to nudge you for today." }, { status: 400 });
        const [view, answers, goals] = await Promise.all([plans.view(), habits.answers(), analytics.goals()]);
        const rules = nudgeLines(await nudgeFacts({ lib: library, view, session: c, answers, race: goals.race, stance: c.stance }));
        const worded = await coach.nudgeWords(rules.text, rules.facts).catch(() => null);
        await habits.answer(c.date, c.kind, bodyTags(r.checkin, r.readiness.level), "nudge");
        return Response.json({ text: worded ?? rules.text, from: worded ? "coach" : "rules" });
      },
    ],
    ["GET", "/api/health", async () => Response.json(await health.view())],
    ["GET", "/api/body", async () => Response.json(await bodyNow())],
    // ---------------------------------------------------------------- encrypted backup (src/backup.ts)
    // The passphrase rides base64 in a header (any characters survive), so the file can be the raw body.
    [
      "POST",
      "/api/backup",
      async (req) => {
        const pass = passphraseOf(req);
        const app = ((await req.json().catch(() => ({}))) as { app?: Record<string, string> }).app ?? {};
        try {
          const file = await makeBackup(disk, pass, app);
          return new Response(file as BodyInit, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${backupName()}"` } });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    [
      "POST",
      "/api/backup/restore",
      async (req) => {
        try {
          const b = await readBackup(new Uint8Array(await req.arrayBuffer()), passphraseOf(req));
          const files = await restoreBackup(disk, b);
          return Response.json({ files, created: b.created, app: b.app });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    [
      // A workout file from another app (Garmin, Coros, Polar…): the name in x-filename, the bytes as the body.
      "POST",
      "/api/import/fit",
      async (req) => {
        try {
          const name = decodeURIComponent(req.headers.get("x-filename") ?? "workout.fit");
          const r = await importFile(store, name, new Uint8Array(await req.arrayBuffer()));
          library.invalidate();
          return Response.json(r);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    [
      // One workout's muscles, for its sheet: what it worked, most first (a lift log's sets when that day has one).
      "GET",
      "/api/body/workout",
      async (_r, _p, q) => {
        const a = await library.find(String(q.get("id") ?? "")).catch(() => null);
        if (!a) return Response.json({ error: "no such workout" }, { status: 404 });
        const at = new Date(a.start);
        const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
        const strength = !/run|jog|trail|treadmill|ride|cycl|bike|walk|hike/i.test(a.sport);
        const log = strength ? (await lifts.all()).find((l) => l.date === day && l.exercises.some((e) => e.sets.some((x) => x.done))) : undefined;
        const w = { start: at.toISOString(), sport: a.sport, title: a.name ?? a.sport, minutes: (a.moving_s ?? a.elapsed_s ?? 0) / 60, elevation_m: a.elevation_m, avg_hr: a.avg_hr, ...(log ? { kind: "strength", exercises: loggedSets(log) } : {}) };
        return Response.json({ muscles: workoutMuscles(w, await analytics.profile()) });
      },
    ],
    // ---------------------------------------------------------------- phone ⇄ PC (src/transfer.ts, over src/link.ts)
    ["GET", "/api/transfer/list", async (_r, _p, q) => Response.json(await listFiles(disk, "", q.get("hash") === "1"))],
    [
      "GET",
      "/api/transfer/file",
      async (_r, _p, q) => {
        const path = q.get("path") ?? "";
        const data = transferable(path) ? await disk.read(path) : null;
        return data ? new Response(data.slice() as BodyInit, { headers: { "content-type": "application/octet-stream" } }) : new Response("not found", { status: 404 });
      },
    ],
    [
      // From the paired phone (through the tunnel): a file it sends, kept unless something newer is here.
      "PUT",
      "/api/transfer/file",
      async (req, _p, q) => Response.json({ saved: await receive(disk, q.get("path") ?? "", new Uint8Array(await req.arrayBuffer()), Number(q.get("mtime") ?? 0)) }),
    ],
    ["GET", "/api/link/state", async () => Response.json(await readState(disk))],
    [
      // The phone: send its data to the paired PC (Tartan started on the phone), with progress.
      "POST",
      "/api/link/push",
      async (req) => {
        const { link } = (await req.json()) as { link: Link };
        return ndjson(async (send) => {
          let last = 0;
          const r = await push(disk, remote(tunnel(link)), (p) => {
            if (Date.now() - last > 150 || p.done === p.total) {
              last = Date.now();
              send({ type: "progress", ...p });
            }
          });
          send({ type: "done", ...r });
        });
      },
    ],
    [
      "PUT",
      "/api/link/state",
      async (req) => {
        const theirs = (await req.json()) as LinkState;
        await writeState(disk, merge(await readState(disk), theirs));
        return Response.json({ ok: true });
      },
    ],
    [
      // The phone: copy everything from the paired PC, with progress.
      "POST",
      "/api/link/pull",
      async (req) => {
        const { link } = (await req.json()) as { link: Link };
        return ndjson(async (send) => {
          let last = 0;
          const r = await pull(disk, remote(tunnel(link)), (p) => {
            if (Date.now() - last > 150 || p.done === p.total) {
              last = Date.now();
              send({ type: "progress", ...p });
            }
          });
          send({ type: "done", ...r });
        });
      },
    ],
    [
      // The phone: bring both to the latest, whatever is where (with progress).
      "POST",
      "/api/link/reconcile",
      async (req) => {
        const { link } = (await req.json()) as { link: Link };
        return ndjson(async (send) => {
          let last = 0;
          const r = await reconcile(disk, remote(tunnel(link)), (p) => {
            if (Date.now() - last > 150 || p.done === p.total) {
              last = Date.now();
              send({ type: "progress", ...p });
            }
          });
          send({ type: "done", ...r });
        });
      },
    ],
    [
      // The phone: one round with the PC (plan, lifts, check-ins), both ways.
      "POST",
      "/api/link/sync",
      async (req) => {
        const { link } = (await req.json()) as { link: Link };
        return Response.json({ changed: await syncWith(disk, remote(tunnel(link))) });
      },
    ],
    // ---------------------------------------------------------------- strength sessions as lifted
    [
      "GET",
      "/api/lifts",
      async () => {
        const logs = await lifts.all();
        return Response.json({ logs: logs.slice(-60), records: records(logs), next: nextWeights(logs) });
      },
    ],
    [
      // A strength session done on the watch as a guided workout: the sets its laps account for
      // (src/strength/from-watch.ts), for the Lift screen to offer. null when there's no such recording.
      "GET",
      "/api/lifts/from-watch",
      async (_r, _p, q) => {
        const date = q.get("date") ?? "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json(null);
        const s = (await plans.view()).weeks.flatMap((w) => w.days).find((d) => d.date === date)?.sessions.find((x) => x.kind === "strength");
        const local = (iso: string) => {
          const d = new Date(iso);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        };
        const rows = (await library.activities({ since: date, until: date })).filter((r) => local(r.start) === date && !/run|jog|trail|treadmill|ride|cycl|bike|walk|hike|swim/i.test(r.sport));
        for (const r of rows) {
          const a = (await library.activity(r.id).catch(() => null)) as { laps?: Array<Record<string, unknown>> } | null;
          const laps = lapSeconds(a?.laps);
          if (laps.length < 2) continue;
          const plan = routineOf(s?.exercises, s?.duration_min).map(({ ex, dose }) => ({ id: ex.id, sets: dose.sets, rest_s: restSeconds(ex) }));
          const sets = setsFromLaps(plan, laps);
          if (!sets.some((x) => x.done)) continue;
          return Response.json({ activity: { id: r.id, name: r.name ?? r.sport, minutes: Math.round(r.moving_min ?? r.elapsed_min ?? 0) }, laps: laps.length, sets });
        }
        return Response.json(null);
      },
    ],
    ["GET", "/api/lifts/session", async (_r, _p, q) => Response.json(await liftSession(/^\d{4}-\d{2}-\d{2}$/.test(q.get("date") ?? "") ? q.get("date")! : today()))],
    [
      // Saved as you go; finished, it ticks the plan's session off and says how it went.
      "PUT",
      "/api/lifts",
      async (req) => {
        let log;
        try {
          log = await lifts.save(await req.json());
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
        if (!log.finished) return Response.json({ log });
        const v = await plans.view();
        const s = v.weeks.flatMap((w) => w.days).find((d) => d.date === log.date)?.sessions.find((x) => x.kind === "strength");
        if (s && s.status !== "done" && log.date <= today()) await plans.mark(log.date, "strength", true).catch(() => {});
        return Response.json({ log, summary: liftSummary(log, await lifts.all()) });
      },
    ],
    ["DELETE", "/api/lifts/:date", async (_r, p) => ((await lifts.remove(p.date!)) ? noContent() : new Response("not found", { status: 404 }))],
    [
      // Health Connect, out: the records to write (the phone writes them). `sent` is what was
      // written before (workout id → its key); `others` are other apps' sessions, so a workout
      // they have isn't written twice.
      "POST",
      "/api/health-connect/out",
      async (req) => {
        const b = (await req.json()) as {
          since?: number;
          sent?: Record<string, string>;
          trends_after?: number;
          kinds?: { workouts?: boolean; vitals?: boolean; activity?: boolean };
          others?: Array<{ start: number; end: number }>;
        };
        const kinds = { workouts: b.kinds?.workouts !== false, vitals: b.kinds?.vitals !== false, activity: b.kinds?.activity !== false };
        const records: HcRecord[] = [];
        const sent: Record<string, string> = {};
        let covered = 0;
        if (kinds.workouts) {
          const since = new Date(b.since ?? Date.now() - 30 * 86400_000).toISOString();
          for (const a of await library.activities({ since, limit: 500 })) {
            const key = workoutKey(a);
            if (b.sent?.[a.id] === key) continue;
            const start = Date.parse(a.start);
            if (coveredBy({ start, end: start + (a.elapsed_min ?? 1) * 60_000 }, b.others ?? [])) {
              covered++;
              sent[a.id] = key;
              continue;
            }
            const raw = await library.rawStreams(await library.find(a.id)).catch(() => null);
            records.push(...workoutRecords(a, raw?.columns ?? null, Date.now()));
            sent[a.id] = key;
          }
        }
        let trendsLast = b.trends_after ?? 0;
        if (kinds.vitals || kinds.activity) {
          // Whole days around what's new, so each day's heart rate and resting heart rate are whole.
          const after = b.trends_after ?? Date.now() - 30 * 86400_000;
          const all = await health.records(after - 2 * 86400_000);
          const fresh = all.filter((r) => r.t > after);
          if (fresh.length) {
            const days = new Set(fresh.map((r) => localDate(r.t)));
            const touched = all.filter((r) => days.has(localDate(r.t)));
            const watch = await health.watchName();
            const out = trendRecords(touched, watch, { vitals: kinds.vitals, activity: kinds.activity });
            // Steps, energy and readings only for what's new; heart rate and resting heart rate per day.
            const isNew = (r: HcRecord) => (r.type === "oxygenSaturation" ? r.time > after : r.type === "steps" || r.type === "activeCalories" ? r.start > after : true);
            records.push(...out.filter(isNew));
            trendsLast = fresh.at(-1)!.t;
          }
        }
        return Response.json({ records, sent, covered, trends_last: trendsLast });
      },
    ],
    [
      // Health Connect, in: other apps' workouts in full, each kept as a FIT file in its app's folder.
      "POST",
      "/api/health-connect/workouts",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { sessions?: HcSession[] };
        let added = 0;
        let already = 0;
        const done: string[] = [];
        for (const s of b.sessions ?? []) {
          if (!s?.id || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) continue;
          const r = await importWorkout(store, hcFolder(s), s.id, hcWorkout(s));
          if (r.already) already++;
          else added++;
          done.push(s.id);
        }
        if (added) library.invalidate();
        return Response.json({ added, already, done });
      },
    ],
    [
      // Apple Health, in (iPhone): other apps' workouts in full, each kept as a FIT file in its app's folder.
      "POST",
      "/api/apple-health/workouts",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { sessions?: HkSession[] };
        let added = 0;
        let already = 0;
        const done: string[] = [];
        const sessions = (b.sessions ?? []).filter((s) => s?.id && s.source && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
        const first = Math.min(...sessions.map((s) => s.start));
        const rows = sessions.length ? await library.activities({ since: new Date(first - 86400_000).toISOString(), limit: 5000 }) : [];
        for (const s of sessions) {
          // The watch's own copy is here already (its file, or the same run through another app).
          if (alreadyHere(s, rows)) {
            already++;
            done.push(s.id);
            continue;
          }
          const r = await importWorkout(store, hkFolder(s), s.id, hkWorkout(s));
          if (r.already) already++;
          else {
            added++;
            rows.push({ start: new Date(s.start).toISOString(), sport: r.sport, elapsed_min: (s.end - s.start) / 60_000, ...(r.distance_km ? { distance_km: r.distance_km } : {}), sources: ["watch"] } as never);
          }
          done.push(s.id);
        }
        if (added) library.invalidate();
        return Response.json({ added, already, done });
      },
    ],
    [
      // Health Connect, in: sleep sessions and HRV readings the phone read there.
      "POST",
      "/api/health-connect/in",
      async (req) => {
        const b = (await req.json()) as { sleep?: Array<{ id: string; start: number; end: number; source: string; stages: Array<[number, number, number]> }>; hrv?: Array<[number, number, string]> };
        const got = await new HealthConnectStore(disk).add(
          (b.sleep ?? []).map(sleepSession),
          (b.hrv ?? []).map(([t, ms, source]) => ({ t, ms: Math.round(ms * 10) / 10, source })),
        );
        return Response.json({ sleep: Object.keys(got.sleep).length, hrv: got.hrv.length });
      },
    ],
    [
      "PUT",
      "/api/readiness",
      async (req) => {
        const b = (await req.json()) as { sleep?: number; legs?: number; pain?: { area: string; level: number } | null };
        const date = (await ready()).date;
        try {
          await checkins.save({ date, ...(b.sleep ? { sleep: b.sleep as 1 | 2 | 3 } : {}), ...(b.legs ? { legs: b.legs as 1 | 2 | 3 } : {}), ...(b.pain ? { pain: b.pain as never } : {}) });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
        return Response.json(await ready());
      },
    ],
    [
      "POST",
      "/api/plan/swap",
      async (req) => {
        // `to`: easy (a bad day, the default), or swim, ride, treadmill, short, move (to `day`) or
        // keep (Run anyway). What you pick is kept for what Tartan learns (src/habits.ts).
        const b = (await req.json()) as { date?: string; kind?: string; reason?: string; undo?: boolean; to?: string; day?: string };
        const to = (["easy", "swim", "ride", "treadmill", "short", "move", "keep"] as const).find((x) => x === b.to) ?? "easy";
        const date = String(b.date ?? "");
        const kind = String(b.kind ?? "");
        const before = !b.undo && to !== "easy" ? await ready().catch(() => null) : null;
        try {
          await plans.swap(date, kind, String(b.reason ?? (to === "easy" ? "a hard day" : "not feeling it")), b.undo === true, to, b.day);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
        if (b.undo) await habits.undo(date, kind);
        else if (to !== "easy") {
          const tags = before?.day_swap?.state === "offer" ? (before.day_swap.tags ?? []) : bodyTags(before?.checkin ?? null, before?.readiness.level ?? null);
          await habits.answer(date, kind, tags, to === "keep" ? "run" : to);
        }
        return Response.json(await ready());
      },
    ],
    [
      "GET",
      "/api/plan/review",
      async (req) => {
        const q = new URL(req.url).searchParams;
        return Response.json(await plans.review(q.get("date") ?? "", q.get("kind") ?? ""));
      },
    ],
    [
      "GET",
      "/api/plan/export.csv",
      async () => new Response(await plans.csv(), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="training-plan.csv"' } }),
    ],
    [
      "GET",
      "/api/plan/calendar.ics",
      async () => {
        const s = await schedule();
        return new Response(toIcs(s.slots, s.prefs), { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="tartan-training.ics"' } });
      },
    ],
    ["GET", "/api/schedule", async () => Response.json(await schedule())],
    ["PUT", "/api/schedule", async (req) => Response.json(await schedule(await savePrefs(disk, (await req.json()) as Partial<SchedulePrefs>)))],
    [
      "PUT",
      "/api/plan/mark",
      async (req) => {
        const b = (await req.json()) as { date?: string; kind?: string; done?: boolean };
        try {
          await plans.mark(String(b.date ?? ""), String(b.kind ?? ""), b.done !== false);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
        return Response.json(await plans.view());
      },
    ],
    // ---------------------------------------------------------------- routes you draw (or import as GPX)
    [
      "GET",
      "/api/routes",
      async () => {
        home ??= findHome().catch(() => null);
        return Response.json({ routes: await savedRoutes.list(), home: await home });
      },
    ],
    [
      "POST",
      "/api/routes/import",
      async (req, _p, q) => {
        try {
          return Response.json(await savedRoutes.importGpx(await req.text(), q.get("name") ?? undefined));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    [
      "GET",
      "/api/routes/:id",
      async (_r, p) => {
        const r = await savedRoutes.get(p.id!);
        return r ? Response.json(r) : new Response("not found", { status: 404 });
      },
    ],
    [
      "PUT",
      "/api/routes/:id",
      async (req, p) => {
        try {
          const body = (await req.json()) as RouteInput;
          return Response.json(await savedRoutes.save({ ...body, id: p.id === "new" ? undefined : p.id }));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    ["DELETE", "/api/routes/:id", async (_r, p) => ((await savedRoutes.remove(p.id!)) ? noContent() : new Response("not found", { status: 404 }))],
    [
      "GET",
      "/api/routes/:id/gpx",
      async (_r, p) => {
        const r = await savedRoutes.get(p.id!);
        if (!r) return new Response("not found", { status: 404 });
        return new Response(toGpx(r), { headers: { "content-type": "application/gpx+xml; charset=utf-8", "content-disposition": `attachment; filename="${gpxName(r.name)}"` } });
      },
    ],
    // ---------------------------------------------------------------- watch faces from the face builder
    ["GET", "/api/faces", async () => Response.json(await faces.list())],
    [
      "GET",
      "/api/faces/:id",
      async (_r, p) => {
        const f = await faces.get(p.id!);
        return f ? Response.json(f) : new Response("not found", { status: 404 });
      },
    ],
    [
      "PUT",
      "/api/faces/:id",
      async (req, p) => {
        try {
          const body = (await req.json()) as Partial<FaceDesign>;
          return Response.json(await faces.save({ ...body, id: p.id === "new" ? undefined : p.id }));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    ["DELETE", "/api/faces/:id", async (_r, p) => ((await faces.remove(p.id!)) ? noContent() : new Response("not found", { status: 404 }))],
    ["GET", "/api/activity/:id", async (_r, p) => Response.json(await analytics.activityView(p.id!))],
    [
      // A run, finished: how it went against the plan, records, last time, next time.
      "GET",
      "/api/activity/:id/finish",
      async (_r, p) =>
        Response.json(
          await loadRunFinish(
            {
              runs: () => library.activities({ since: new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10), limit: 5000 }),
              efforts: () => library.runEfforts(),
              view: () => plans.view(),
              review: (date, kind) => plans.review(date, kind),
              family: sportFamily,
            },
            (await library.find(p.id!)).id,
          ),
        ),
    ],
    [
      // New runs of the last day that haven't had their note yet (src/after-run.ts), each claimed
      // once: the phone posts them. With `coach=1`, the coach may word them (a cloud key, online).
      // A GET, though it notes what it hands out: a write would have every screen read again.
      "GET",
      "/api/after-run",
      async (_r, _p, q) => {
        const b = { coach: q.get("coach") === "1" };
        if (await isSample(disk)) return Response.json({ notes: [] });
        const rows = await library.activities({ since: new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10) });
        const ids = await claimNewRuns(disk, rows, (s) => sportFamily(s) === "run");
        if (!ids.length || (await readPrefs(disk)).notify.run === false) return Response.json({ notes: [] });
        const view = await plans.view();
        const notes = [];
        for (const id of ids) {
          const run = rows.find((r) => r.id === id)!;
          const f = await loadRunFinish(
            {
              runs: () => library.activities({ since: new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10), limit: 5000 }),
              efforts: () => library.runEfforts(),
              view: async () => view,
              review: (date, kind) => plans.review(date, kind),
              family: sportFamily,
            },
            id,
          ).catch(() => null);
          if (!f) continue;
          const w = afterRunWords(run, f, nextDay(view, new Date(run.start).toLocaleDateString("sv"), view.today));
          const worded = b.coach ? await coach.afterRunWords(w.text, w.facts).catch(() => null) : null;
          notes.push({ id, title: w.title, text: worded ?? w.text, by: worded ? "coach" : "rules" });
        }
        return Response.json({ notes });
      },
    ],
    [
      // Apply a finished run's next-time pace change to that session, or take it back.
      "PUT",
      "/api/plan/adjust",
      async (req) => {
        const b = (await req.json()) as { date?: string; kind?: string; shift_s?: number; reason?: string; from?: string; undo?: boolean };
        try {
          await plans.adjust(String(b.date ?? ""), String(b.kind ?? ""), Number(b.shift_s ?? 0), String(b.reason ?? ""), b.from, b.undo === true);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
        return Response.json({ ok: true });
      },
    ],
    ["GET", "/api/profile", async () => Response.json(await analytics.profile())],
    [
      "PUT",
      "/api/profile",
      async (req) => {
        await analytics.saveProfile((await req.json()) as object);
        return Response.json(await analytics.profile());
      },
    ],

    // ---------------------------------------------------------------- coach (Claude, your key)
    ["GET", "/api/coach/status", async () => Response.json(await coach.status())],
    [
      "PUT",
      "/api/coach/settings",
      async (req) => {
        await coach.saveSettings((await req.json()) as CoachSettings);
        return Response.json(await coach.status());
      },
    ],
    [
      "POST",
      "/api/coach/check-key",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { provider?: string; key?: string };
        return Response.json(await coach.checkKey(b.provider === "anthropic" ? "anthropic" : "google", String(b.key ?? "")));
      },
    ],
    [
      "GET",
      "/api/coach/models",
      async (_req, _p, url) => {
        const asked = url.get("provider");
        const provider = asked === "google" || asked === "modelhub" ? asked : "anthropic";
        try {
          return Response.json(await coach.listModels(provider));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    // The coach's memory (src/memory.ts). GET gives every note, forgotten ones too (what a sync
    // sends); POST merges notes from the other side (phone or PC) and answers with the result.
    ["GET", "/api/coach/memory", async () => Response.json({ notes: await memory.all() })],
    [
      "POST",
      "/api/coach/memory",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { notes?: unknown };
        return Response.json({ notes: await memory.merge(b.notes) });
      },
    ],
    [
      "PUT",
      "/api/coach/memory/:id",
      async (req, p) => {
        const b = (await req.json().catch(() => ({}))) as { text?: string };
        try {
          return Response.json(await memory.update(p.id!, { text: String(b.text ?? "") }));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    ["DELETE", "/api/coach/memory/:id", async (_r, p) => ((await memory.forget(p.id!)) ? noContent() : new Response("not found", { status: 404 }))],
    ["GET", "/api/coach/conversations", async () => Response.json(await coach.conversations())],
    [
      "GET",
      "/api/coach/conversations/:id",
      async (_r, p) => {
        const c = await coach.conversation(p.id!);
        return c ? Response.json(c) : new Response("not found", { status: 404 });
      },
    ],
    // A coach's answer flagged by the athlete (long press → Report reply).
    [
      "POST",
      "/api/coach/report",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { conversation?: string; index?: number; reason?: string; note?: string };
        const r = typeof b.conversation === "string" && Number.isInteger(b.index) ? await coach.report(b.conversation, b.index!, String(b.reason ?? ""), b.note) : null;
        return r ? Response.json(r) : new Response("not found", { status: 404 });
      },
    ],
    // The chat screen opened: on Model Hub, get the chat ready before its question.
    [
      "POST",
      "/api/coach/prepare",
      async (req) => {
        const body = (await req.json().catch(() => ({}))) as { conversation?: string | null };
        return Response.json({ prepared: await coach.prepare(body.conversation ?? null).catch(() => null) });
      },
    ],
    [
      "POST",
      "/api/coach/chat",
      async (req) => {
        const body = (await req.json()) as { conversation?: string | null; message?: string; images?: ChatImage[] };
        return ndjson(async (send) => {
          for await (const ev of coach.chat(body.conversation ?? null, String(body.message ?? ""), { images: Array.isArray(body.images) ? body.images : undefined })) send(ev);
        });
      },
    ],

    // ---------------------------------------------------------------- Strava
    // Opt in: send watch workouts Strava doesn't have (src/watch-to-strava.ts).
    ["GET", "/api/strava/send-watch", async () => Response.json(await watchToStrava.status())],
    [
      "PUT",
      "/api/strava/send-watch",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { enabled?: boolean };
        await watchToStrava.setEnabled(b.enabled === true);
        return Response.json(await watchToStrava.status());
      },
    ],
    ["POST", "/api/strava/send-watch/run", async () => Response.json(await watchToStrava.run())],
    [
      "GET",
      "/api/strava/status",
      async () => {
        const cfg = await library.strava.read<{ clientId: string }>("config.json");
        const client = await library.strava.client();
        const state = await library.strava.read<Record<string, unknown>>("state.json");
        return Response.json({
          configured: !!cfg?.clientId,
          clientId: cfg?.clientId,
          connected: !!client?.connected,
          can_upload: !!client?.canUpload,
          athlete: client?.athlete,
          activities: (await library.strava.index()).length,
          ...state,
        });
      },
    ],
    [
      "POST",
      "/api/strava/connect",
      async (req) => {
        const body = (await req.json()) as { clientId?: string; clientSecret?: string };
        const existing = await library.strava.read<{ clientId: string; clientSecret: string }>("config.json");
        const clientId = body.clientId?.trim() || existing?.clientId;
        const clientSecret = body.clientSecret?.trim() || existing?.clientSecret;
        if (!clientId || !clientSecret) return Response.json({ error: "Client ID and Client Secret are required" }, { status: 400 });
        await library.strava.writeSecret({ clientId, clientSecret }, "config.json");
        const client = (await library.strava.client())!;
        return Response.json({ authorizeUrl: client.authorizeUrl(o.stravaRedirect(req), await issueState(), { mobile: o.stravaMobile }) });
      },
    ],
    [
      "POST",
      "/api/strava/exchange",
      async (req) => {
        const body = (await req.json()) as { state?: string; code?: string; scope?: string };
        await stravaExchange(String(body.state ?? ""), String(body.code ?? ""), body.scope ?? undefined);
        return noContent();
      },
    ],
    [
      "POST",
      "/api/strava/sync",
      async (req) => {
        const body = (await req.json().catch(() => ({}))) as { full?: boolean };
        return ndjson(async (send) => {
          const client = await library.strava.client();
          if (!client?.connected) throw new Error("Strava is not connected");
          const res = await syncStrava(client, library.strava, { full: body.full, log: (m) => send({ log: m }) });
          library.invalidate();
          send({ done: res });
        });
      },
    ],

    // ---------------------------------------------------------------- intervals.icu
    ["GET", "/api/intervals/status", async () => Response.json(await intervals().status())],
    [
      // Connect with the key (and athlete ID; "0", the key's own): checked against intervals.icu first.
      "PUT",
      "/api/intervals/config",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { key?: string; athlete?: string };
        try {
          return Response.json(await intervals().connect(String(b.key ?? ""), String(b.athlete ?? "")));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],
    ["DELETE", "/api/intervals/config", async () => (await intervals().disconnect(), noContent())],
    [
      "POST",
      "/api/intervals/sync",
      async () => {
        try {
          const r = await intervals().sync(store);
          if (r.added) library.invalidate();
          return Response.json(r);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],

    [
      // The coming week as planned workouts on intervals.icu (and from there, Garmin and the
      // other watches it links); {off: true} stops and takes Tartan's off.
      "POST",
      "/api/intervals/plan",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { fuel?: Partial<FuelPlan> | null; off?: boolean };
        try {
          if (b.off) return Response.json(await intervals().stopPlan(today()));
          const [{ view, list, time }, prof] = await Promise.all([planned(b.fuel), analytics.profile()]);
          return Response.json(await intervals().sendPlan(list, { today: view.today, time, maxHr: prof.max_hr }));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
    ],

    // ---------------------------------------------------------------- the plan's workouts for any watch
    [
      // One session as a FIT workout file (Garmin, Coros and their apps import it).
      "GET",
      "/api/plan/workout.fit",
      async (_r, _p, q) => {
        const { list } = await planned(fuelParam(q), 400);
        const p = list.find((x) => x.date === q.get("date") && x.kind === q.get("kind"));
        if (!p) return Response.json({ error: "no workout for that session (a rest day, done, or past)" }, { status: 404 });
        return new Response(workoutFit(p.workout, sportOf(p.kind)).slice(), { headers: { "content-type": "application/vnd.ant.fit", "content-disposition": `attachment; filename="${fitName(p.date, p.workout)}"` } });
      },
    ],
    [
      // The coming 7 days as FIT workout files in one zip (for GARMIN/NewFiles over USB, or an app).
      "GET",
      "/api/plan/week.zip",
      async (_r, _p, q) => {
        const { list, view } = await planned(fuelParam(q));
        if (!list.length) return Response.json({ error: "no sessions in the coming week" }, { status: 404 });
        const data = await zip(list.map((p) => ({ name: fitName(p.date, p.workout), data: workoutFit(p.workout, sportOf(p.kind)) })), new Date(), { unix: true });
        return new Response(data.slice(), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="tartan-week-${view.today}.zip"` } });
      },
    ],
    [
      // The coming week as Health Connect planned sessions (the phone writes them), at your training times.
      "POST",
      "/api/health-connect/plan",
      async (req) => {
        const b = (await req.json().catch(() => ({}))) as { fuel?: Partial<FuelPlan> | null };
        const { list, time } = await planned(b.fuel);
        const records = list.map((p) => hcPlanned(p, new Date(`${p.date}T${time(p.date)}:00`).getTime()));
        return Response.json({ records, key: list.map((p) => `${p.date}${p.key}${time(p.date)}`).join(",") });
      },
    ],

    // ---------------------------------------------------------------- runs recorded on the phone
    ["GET", "/api/recordings", async () => Response.json((await library.recordings.all()).map(summarize))],
    [
      "GET",
      "/api/recordings/:id",
      async (_r, p) => {
        const r = await library.recordings.get(p.id!);
        return r ? Response.json({ recording: r, summary: summarize(r) }) : new Response("not found", { status: 404 });
      },
    ],
    [
      "PUT",
      "/api/recordings/:id",
      async (req, p) => {
        const r = (await req.json()) as Recording;
        if (r.id !== p.id || !Array.isArray(r.points) || !Array.isArray(r.pauses) || Number.isNaN(Date.parse(r.start))) return new Response("bad recording", { status: 400 });
        const prev = await library.recordings.get(r.id);
        await library.recordings.put({ ...r, strava: r.strava ?? prev?.strava });
        if (r.end) library.invalidate();
        return noContent();
      },
    ],
    [
      "DELETE",
      "/api/recordings/:id",
      async (_r, p) => {
        await library.recordings.remove(p.id!);
        library.invalidate();
        return noContent();
      },
    ],
    [
      "POST",
      "/api/recordings/:id/upload",
      async (_r, p) => {
        const r = await library.recordings.get(p.id!);
        if (!r?.end) return Response.json({ error: "Finish the recording first" }, { status: 400 });
        if (r.strava?.status === "done") return Response.json(r.strava);
        const client = await library.strava.client();
        if (!client?.connected) return Response.json({ error: "Connect Strava in Settings first" }, { status: 400 });
        const s = summarize(r);
        if (s.distance_m < 50) return Response.json({ error: "This recording has no distance to upload" }, { status: 400 });
        try {
          const res = await client.upload({ data: toTcx(r), dataType: "tcx", externalId: `freesuunto-${r.id}`, name: r.name || "Run", sport: r.sport, description: "Recorded with Tartan" });
          r.strava = { status: "done", upload_id: res.upload_id, activity_id: res.activity_id, at: new Date().toISOString() };
        } catch (e) {
          r.strava = { status: "error", error: (e as Error).message, at: new Date().toISOString() };
        }
        await library.recordings.put(r);
        return Response.json(r.strava, { status: r.strava.status === "done" ? 200 : 502 });
      },
    ],

    // ---------------------------------------------------------------- freshness strip
    ["GET", "/api/events", async (_r, _p, q) => Response.json(await store.events(Number(q.get("days") ?? 14)))],
    [
      "POST",
      "/api/events",
      async (req) => {
        const e = (await req.json()) as { lane?: string; kind?: string; added?: number; ok?: boolean; detail?: string };
        if (e.lane !== "watch" && e.lane !== "strava" && e.lane !== "agent") return new Response("bad lane", { status: 400 });
        await store.logEvent({ lane: e.lane, kind: String(e.kind ?? "sync").slice(0, 40), added: Number(e.added) || 0, ok: e.ok !== false, detail: e.detail?.slice(0, 120) });
        return noContent();
      },
    ],
  ];

  async function stravaExchange(state: string, code: string, scope?: string): Promise<void> {
    if (!(await takeState(state))) throw new Error("This Strava sign-in link is stale. Press Connect Strava again.");
    const client = await library.strava.client();
    if (!client) throw new Error("Enter the Strava Client ID and Secret first");
    await client.exchangeCode(code, scope);
  }

  const compiled = routes.map(([method, pattern, fn]) => ({ method, parts: pattern.split("/"), fn }));

  return {
    stravaExchange,
    async handle(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/");
      for (const r of compiled) {
        if (r.method !== req.method || r.parts.length !== parts.length) continue;
        const params: Params = {};
        if (!r.parts.every((seg, i) => (seg.startsWith(":") ? ((params[seg.slice(1)] = decodeURIComponent(parts[i]!)), true) : seg === parts[i]))) continue;
        try {
          return await r.fn(req, params, url.searchParams);
        } catch (e) {
          const message = (e as Error).message;
          return Response.json({ error: message }, { status: message.startsWith("refusing path") ? 400 : 500 });
        }
      }
      return null;
    },
  };
}
