/**
 * The data tools, defined once and served two ways: by the MCP server to external agents,
 * and by the in-app coach to Claude. Read-only tools are safe to call freely.
 */
import { recentFeelings, RunNotes } from "./run-notes.ts";
import { CheckIns, todayReadiness } from "./readiness.ts";
import { loadBody } from "./fatigue.ts";
import { Lifts, nextWeights, records } from "./strength/log.ts";
import { bodySigns, Health } from "./health.ts";
import { z } from "zod";
import { Analytics } from "./analytics.ts";
import { durability } from "./durability.ts";
import { upcomingWeather, Weather } from "./weather.ts";
import type { Library } from "./library.ts";
import { planInput, Plans, SESSION_KINDS, type PlanInput } from "./plan.ts";
import { DAY_KEYS, readPrefs, savePrefs, slots, toIcs } from "./schedule.ts";
import { Routes, toGpx, type LngLat } from "./routes.ts";
import { Faces } from "./faces.ts";
import { Memory, NOTE_KINDS, MAX_TEXT } from "./memory.ts";
import { PRESETS, TARTAN_TRACK_DESIGN, type FaceDesign } from "./watchface/tartan-face.ts";
import { syncStrava } from "./strava/sync.ts";

export interface DataTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  readOnly: boolean;
  /** Writes only Tartan's own files (the plan), nothing outside: no network, no watch. */
  local?: boolean;
  /** Throws away state (kept as a backup, but the agent should ask first). */
  destructive?: boolean;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

import { kindOf, shoePicks, shoesNow, switchAdvice, wornOut } from "./shoes.ts";

const SOURCES = ["all", "strava", "watch", "suunto-cloud", "phone"] as const;

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  readOnly = true,
): DataTool {
  return { name, description, schema: z.object(shape) as unknown as z.ZodObject<z.ZodRawShape>, readOnly, run: run as DataTool["run"] };
}

export interface DataToolOptions {
  /** Include the tools that reach out (Strava sync, watch backup). */
  allowSync?: boolean;
  /** Bluetooth backup from this machine (Linux/BlueZ hosts only; the MCP server passes it). */
  backupWatch?: (opts: { root: string; needle?: string }) => Promise<unknown>;
}

export function dataTools(lib: Library, opts: DataToolOptions = {}): DataTool[] {
  const analytics = new Analytics(lib);
  const plans = new Plans(lib);
  const checkins = new CheckIns(lib.disk);
  const health = new Health(lib.disk);
  const body = async () => bodySigns(await health.view());
  const routes = new Routes(lib.disk);
  const memory = new Memory(lib.disk);
  const faces = new Faces(lib.disk);
  const lifts = new Lifts(lib.disk);
  const tools: DataTool[] = [
    tool(
      "get_run_notes",
      "The athlete's own notes on their runs, newest first: wins, niggles (with where it hurt) and plain notes, each with the run's day and name. Niggles in the same place again and again are a pattern worth acting on (easier, flatter running; a physio if it persists). How each run felt on the watch (1 poor … 5 excellent) is the feeling field in list_activities.",
      { days: z.number().int().min(1).max(365).optional().describe("how far back, default 60") },
      async ({ days }) => {
        const since = new Date(Date.now() - (days ?? 60) * 86400_000).toISOString().slice(0, 10);
        const list = (await new RunNotes(lib.disk).all()).filter((n) => n.date >= since).sort((a, b) => b.date.localeCompare(a.date));
        const rows = new Map((await lib.activities({ since })).map((r) => [r.id, r]));
        return { notes: list.map((n) => ({ date: n.date, tag: n.tag, text: n.text, ...(n.area ? { where: n.area } : {}), run: rows.get(n.run)?.name ?? rows.get(n.run)?.sport ?? n.run, feeling: rows.get(n.run)?.feeling })) };
      },
    ),
    tool(
      "get_shoes",
      "The athlete's running shoes: each pair's type (daily, racing, trail), kilometres (runs count to the pair worn then), its limit and whether it's retired; which pair suits each run session in the next two weeks (racing shoes for races and fast days, trail shoes for trails, the freshest daily pair otherwise); and advice for pairs near their limit. Worth a word before a race, a key session, or when a pair should be switched.",
      {},
      async () => {
        const { shoes } = await shoesNow(lib);
        const v = await new Plans(lib).view().catch(() => null);
        const until = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
        const sessions = (v?.weeks ?? []).flatMap((w) => w.days.flatMap((d) => d.sessions.map((s) => ({ date: d.date, kind: s.kind, title: s.title })))).filter((x) => x.date <= until);
        return {
          pairs: shoes.map(({ photo: _photo, ...s }) => ({ ...s, kind: kindOf(s), used_pct: Math.round(s.used * 100) })),
          wear_next: v ? await shoePicks(lib, sessions, v.today) : {},
          switch: Object.fromEntries(wornOut(shoes).map((s) => [s.name, switchAdvice(s, shoes)])),
        };
      },
    ),
    tool("get_overview", "What data is available: merged activity counts and date range, sources, Strava athlete, last syncs, watches backed up over Bluetooth.", {}, () => lib.overview()),

    tool(
      "get_takeaways",
      "The most useful things to know right now, computed from the data: data freshness, volume change, fitness ramp, form, longest run, easy-run efficiency trend, intensity split, new personal bests. Each has a tone (good / watch / info) and the numbers behind it.",
      {},
      () => analytics.takeaways(),
    ),

    tool(
      "list_activities",
      "List workouts newest first; each workout once, with `sources` naming every copy (strava, watch, suunto-cloud). Rows: id, start (UTC), start_local, sport, name, distance_km, moving_min, elevation_m, avg/max HR, pace.",
      {
        since: z.string().optional().describe("ISO date or datetime, inclusive, e.g. 2026-09-01"),
        until: z.string().optional().describe("ISO date or datetime, inclusive for whole dates"),
        sport: z.string().optional().describe("e.g. Run (includes trail and treadmill), TrailRun, Ride, Swim"),
        source: z.enum(SOURCES).optional().describe("only workouts that have a copy in this source (default all)"),
        limit: z.number().int().min(1).max(2000).optional().describe("default 50"),
      },
      (a) => lib.activities({ ...a, limit: a.limit ?? 50 }),
    ),

    tool(
      "get_activity",
      "Full detail for one workout: merged summary, description, laps, per-km splits, best efforts, its copies, and provenance (which source supplied each field).",
      { id: z.string().describe("an id from list_activities (source ids like strava:123 also work)") },
      (a) => lib.activity(a.id),
    ),

    tool(
      "get_activity_streams",
      "Time series for one workout from its single best source (the watch's own file when present, else Strava), with canonical channels: time (s), distance (m), latlng, altitude (m), velocity (m/s), heartrate, cadence, watts, temp, grade. Evenly downsampled.",
      {
        id: z.string(),
        keys: z.array(z.string()).optional().describe("which channels; default all available"),
        max_points: z.number().int().min(10).max(5000).optional().describe("default 300"),
      },
      (a) => lib.streams(a.id, a.keys, a.max_points ?? 300),
    ),

    tool(
      "get_training_summary",
      "Totals per week (Monday start), month or year: activity count, distance, moving hours, elevation, average HR, sports mix. Each workout counted once.",
      {
        period: z.enum(["week", "month", "year"]).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        sport: z.string().optional(),
      },
      (a) => lib.summary(a),
    ),

    tool(
      "get_training_load",
      "Daily training load (Banister TRIMP from heart rate) with fitness (42-day average), fatigue (7-day average) and form (fitness minus fatigue). Positive form means fresh; below about -30 means heavy fatigue.",
      { days: z.number().int().min(14).max(730).optional().describe("default 90") },
      async (a) => {
        const l = await analytics.load(a.days ?? 90);
        return { today: l.today, estimated_share: l.estimated_share, series: l.series, profile: await analytics.profile() };
      },
    ),

    tool(
      "get_hr_zones",
      "Time in heart-rate zones (percent of max HR: Z1 50-60, Z2 60-70, Z3 70-80, Z4 80-90, Z5 90+), for one activity (id) or summed over the last N days.",
      { id: z.string().optional(), days: z.number().int().min(1).max(365).optional().describe("default 28 when no id") },
      async (a) => (a.id ? { id: a.id, zones: await analytics.zonesFor(a.id) } : analytics.zonesOver(a.days ?? 28)),
    ),

    tool(
      "get_efficiency_trend",
      "Weekly aerobic efficiency on easy runs (metres per heartbeat, and average easy pace). Rising means the same effort carries you further.",
      { weeks: z.number().int().min(4).max(104).optional() },
      (a) => analytics.efficiency(a.weeks ?? 16),
    ),

    tool(
      "get_weather",
      "The forecast at each planned session in the next week, at the athlete's training times, where they run (the start of their latest GPS workout, to about a kilometre): temperature, dew point, chance of rain, wind, and heat as temperature plus dew point in °F with the pace to give up for the same effort (Hadley's table; past 180 °F, no hard running), plus a cooler hour that day when heat costs 2% or more. Use it to move or soften hard sessions on hot days. From Open-Meteo.",
      {},
      () => upcomingWeather(lib),
    ),

    tool(
      "get_durability",
      "How well the effort holds on runs of an hour or more: per run, heart-rate drift for the same hill-adjusted pace between the halves after a 10-minute warm-up (Pa:HR decoupling: under 5% held, under 10% drifted, more faded), the minute the effort stopped holding (null: held to the end), and whether the run was steady enough to count (intervals aren't). Plus the trend over the last three steady long runs against the three before, and a summary in words. Heat, fatigue and fuelling also raise drift.",
      { weeks: z.number().int().min(4).max(104).optional() },
      (a) => durability(lib, a.weeks ?? 26, Date.now(), new Weather(lib)),
    ),

    tool(
      "get_best_efforts",
      "Personal bests per standard distance (400m, 1k, 1 mile, 5k, 10k, half marathon…) from Strava best efforts across all synced runs.",
      { sport: z.string().optional().describe("default run") },
      (a) => lib.bestEfforts(a.sport ?? "run"),
    ),

    tool(
      "get_goals",
      "The athlete's own targets (weekly distance and workouts, long run, a race with distance, date and target time, and `availability`: training days and hours a week they have, preferred long-run day, notes) and progress: this week so far, weeks the target was met (of the last 12), the longest recent run, and the race (the targets' while it's ahead, else the training plan's next race session): days to go, a predicted finish time from the last 12 weeks' runs, and from 12 weeks out `countdown`: how the prediction moved over the last 4 weeks, the gap to the target, and the taper in the last two weeks.",
      {},
      () => analytics.goalProgress(),
    ),

    tool(
      "get_training_plan",
      "The current training plan (made by the coach) and how it is going: every week with its sessions by date, each marked done (with the workout that did it, or `manual` when the athlete ticked it off without a recording), missed, today, planned or rest, plus workouts nobody planned, and planned against done totals per week. Null when there is no plan yet.",
      {},
      () => plans.view(),
    ),

    tool(
      "get_readiness",
      "Today's readiness: the athlete's morning check-in (legs 1 heavy to 3 fresh; sleep 1-3 only when the watch didn't measure the night; pain with where and 1 a niggle, 2 sore, 3 painful), the niggles they reported in the last three weeks, their form (fitness minus fatigue), last night's sleep, resting heart rate and HRV against their usual when measured, the verdict (ready, go easy, rest) with its reasons, and today's session (hard or not, done, or swapped for an easy run on a bad day). Plan around niggles: a recurring one means less load on it, not more.",
      {},
      () => todayReadiness({ plans, load: () => analytics.load(60), checkins, body, feelings: () => recentFeelings(lib) }),
    ),

    tool(
      "get_body",
      "Muscle by muscle (traps, delts, chest, biceps, triceps, forearms, lats, upper_back, lower_back, abs, obliques, hip_flexors, glutes, glute_med, adductors, quads, hamstrings, calves, tibialis): how fatigued each is from the last weeks of running AND strength together (runs load the legs by length, effort and climbing; strength sessions by hard sets of their exercises), relative to what that muscle is used to. Each has a state (fresh, recovering, fatigued), a 0-4 level, hours until fresh, the day it last got a real load, the workouts behind its fatigue with their share, and soreness from the morning check-in. Use it to place strength sessions (not heavy legs on fatigued legs before a key run), to choose exercises, and to explain how the athlete feels.",
      {},
      () => loadBody({ lib, plans, profile: () => analytics.profile(), checkins, lifts }),
    ),

    tool(
      "get_lifts",
      "Strength sessions as the athlete logged them in the app (newest last): per exercise (library ids) the target (sets, reps or seconds, kg), each set done with its kg and reps or seconds, and reps in reserve after the last set (0-3, 3 meaning three or more). With each exercise's records (heaviest set, estimated one-rep max, most reps, longest hold) and next time's weight or reps by the app's progression (add 2.5 kg on a bar or 2 kg on dumbbells after every set done with reps to spare; hold after missed reps or none left; 10% off after two misses running; bodyweight: a rep more, a hold 5 s longer). Use it before changing strength sessions; keep exercises that are progressing.",
      { weeks: z.number().int().min(1).max(104).optional().describe("how far back, default 12") },
      async ({ weeks }) => {
        const all = await lifts.all();
        const since = new Date(Date.now() - (weeks ?? 12) * 7 * 86400_000).toISOString().slice(0, 10);
        return { logs: all.filter((l) => l.date >= since), records: records(all), next: nextWeights(all) };
      },
    ),

    tool(
      "get_health",
      "Health from the watch's 10-minute log, by day (last 14): resting heart rate (lowest still half hour) and its usual level, heart rate range while worn, minutes worn, steps, active kcal, blood-oxygen readings (percent, when the watch measured), the night's rest estimated from heart rate and stillness (start, end, minutes, average and lowest heart rate), and, when connected to Health Connect, sleep as other apps recorded it (asleep, awake, light, deep and REM minutes) and HRV (RMSSD ms). Empty until the watch has been connected to the phone app.",
      {},
      () => health.view(),
    ),

    tool(
      "review_session",
      "How a done plan session went against its plan: its steps (warm-up, each rep, recoveries, cool-down) laid over the recorded workout, each with its target, what was done (average heart rate, pace, speed or power), the share of time in range and whether it was on target, fast, slow, high or low. Use it before changing the plan after hard sessions.",
      { date: z.string().describe("the session's date, YYYY-MM-DD"), kind: z.string().describe("the session's kind, e.g. intervals") },
      (a) => plans.review(a.date, a.kind),
    ),

    tool(
      "get_week",
      "One week Monday to Sunday (default this week): totals (km, minutes, workouts, climb, load), each day with its workouts, time in heart-rate zones, sports mix, against the week before and the usual of the four before.",
      { start: z.string().optional().describe("any date in the week, YYYY-MM-DD") },
      (a) => analytics.week(a.start),
    ),

    // ---- the training plan: an outside agent can coach too (same plan the app shows)
    {
      ...tool(
        "save_training_plan",
        "Save the athlete's training plan. Weeks start on Monday; sessions carry their date; rest days may be left out. Set target_date when the plan builds to a date (its last week must contain it), and zones with the paces and heart-rate ranges the targets come from. Shown on the app's Coach tab and checked against their workouts. The first plan is saved at once; once there is one, a new plan is a proposal the athlete accepts or not in the app (every change from today on is listed for them; their setting may let small changes, or all, go in at once, with undo), so give change_note and each changed session's why. Days before today stay as they were. Use the training_plan prompt for how to plan.",
        planInput,
        async (a) => {
          const r = await plans.submit(a as PlanInput, { model: "an MCP agent", source: "agent" });
          if ("saved" in r) return { saved: true, ...(r.applied ? { applied: r.applied, note: "Saved at once (the athlete's setting); they can undo it in the app for a week." } : { weeks: r.saved.weeks.length, sessions: r.saved.weeks.reduce((n, w) => n + w.sessions.length, 0) }) };
          if ("unchanged" in r) return { unchanged: true };
          return { proposed: true, changes: r.proposed.changes, note: "Waiting for the athlete to accept it on the app's Coach tab." };
        },
        false,
      ),
      local: true,
    },
    {
      ...tool(
        "mark_plan_session",
        "Tick a planned session off by hand (done without a recording, e.g. the watch stayed home), or take the mark back with done=false. Today's and earlier sessions only.",
        {
          date: z.string().describe("YYYY-MM-DD"),
          kind: z.enum(SESSION_KINDS).describe("the session's kind, as in get_training_plan"),
          done: z.boolean().optional().describe("default true"),
        },
        async (a) => {
          await plans.mark(a.date, a.kind, a.done !== false);
          return { ok: true };
        },
        false,
      ),
      local: true,
    },
    {
      ...tool(
        "set_training_availability",
        "Set the time the athlete has for training (replaces what was there): days and hours a week, long-run day, and notes such as 'no running on Thursdays'. Plans are built around it.",
        {
          days_per_week: z.number().int().min(1).max(7).optional(),
          hours_per_week: z.number().min(0.5).max(40).optional(),
          long_run_day: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]).optional(),
          notes: z.string().max(300).optional(),
        },
        async (a) => ({ availability: (await analytics.saveAvailability(a)) ?? null }),
        false,
      ),
      local: true,
    },
    {
      ...tool(
        "reset_training_plan",
        "Clear the current training plan (it is kept as an earlier version; marks the athlete made stay). Ask the athlete before calling this.",
        {},
        async () => ({ cleared: await plans.reset() }),
        false,
      ),
      local: true,
      destructive: true,
    },
    // The coach's memory (src/memory.ts): notes that outlast a conversation.
    tool(
      "get_memory",
      "The coach's notes about the athlete that carry across conversations: injuries and niggles, preferences, constraints, what has worked. Each has an id for update_memory and forget_memory.",
      {},
      async () => ({ notes: (await memory.notes()).map(({ id, kind, text, updated }) => ({ id, kind, text, updated: updated.slice(0, 10) })) }),
    ),
    {
      ...tool(
        "remember",
        `Keep a note about the athlete for later conversations: something lasting that the training data doesn't show (an injury history, a preference, a constraint, how they respond to training, a lesson from a race). One short sentence, at most ${MAX_TEXT} characters. Change an existing note with update_memory instead of adding a near copy.`,
        { text: z.string().min(1).describe("the note, one short sentence"), kind: z.enum(NOTE_KINDS).optional().describe("athlete (default), health, preference, goal or lesson") },
        async (a) => {
          const n = await memory.remember(a.text, a.kind);
          return { saved: true, id: n.id };
        },
        false,
      ),
      local: true,
    },
    {
      ...tool(
        "update_memory",
        "Change one of the coach's notes (when something changed: the knee is better, the long run moved to Saturday).",
        { id: z.string().describe("the note's id from get_memory"), text: z.string().min(1).optional(), kind: z.enum(NOTE_KINDS).optional() },
        async (a) => {
          const n = await memory.update(a.id, { text: a.text, kind: a.kind });
          return { saved: true, id: n.id, text: n.text };
        },
        false,
      ),
      local: true,
    },
    {
      ...tool(
        "forget_memory",
        "Forget one of the coach's notes (no longer true, or the athlete asked).",
        { id: z.string().describe("the note's id from get_memory") },
        async (a) => ({ forgotten: await memory.forget(a.id) }),
        false,
      ),
      local: true,
    },
    tool(
      "get_training_times",
      "When the athlete usually trains (weekday and weekend times, any day with its own time) and the next planned sessions at those times. The app's reminders and calendar events use them.",
      { limit: z.number().int().min(1).max(100).optional().describe("sessions to list, default 14") },
      async (a) => {
        const [prefs, v] = await Promise.all([readPrefs(lib.disk), plans.view()]);
        return { weekday: prefs.weekday, weekend: prefs.weekend, days: prefs.days ?? {}, reminders: prefs.remind, upcoming: slots(v.weeks, prefs, v.today).slice(0, a.limit ?? 14) };
      },
    ),
    {
      ...tool(
        "set_training_times",
        "Set when the athlete usually trains, e.g. weekdays 18:00 after work and weekends 09:00; a day can have its own time (an empty string goes back to the weekday or weekend time). Only the fields given change. The app's reminders and calendar events follow.",
        {
          weekday: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("HH:MM, Monday to Friday"),
          weekend: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("HH:MM, Saturday and Sunday"),
          days: z.object(Object.fromEntries(DAY_KEYS.map((d) => [d, z.string().optional()]))).optional().describe('a day with its own time, e.g. {"wed": "12:00"}; "" clears a day'),
        },
        async (a) => {
          const cur = await readPrefs(lib.disk);
          const p = await savePrefs(lib.disk, { weekday: a.weekday, weekend: a.weekend, ...(a.days ? { days: { ...cur.days, ...(a.days as Record<string, string | undefined>) } } : {}) });
          return { weekday: p.weekday, weekend: p.weekend, days: p.days ?? {} };
        },
        false,
      ),
      local: true,
    },
    tool(
      "export_training_plan_ics",
      "The sessions ahead as an iCalendar (.ics) file at the athlete's training times, for importing into Google Calendar, Outlook or Apple Calendar. Stable event ids: importing again updates instead of duplicating.",
      {},
      async () => {
        const [prefs, v] = await Promise.all([readPrefs(lib.disk), plans.view()]);
        return { ics: toIcs(slots(v.weeks, prefs, v.today), prefs) };
      },
    ),
    tool(
      "export_training_plan_csv",
      "The training plan as CSV, one row per session: week, dates, kind, title, duration, distance, target, notes, and how it went (status, the workout that did it or 'marked by hand').",
      {},
      async () => ({ csv: await plans.csv() }),
    ),

    // ---- routes drawn in the app (or imported as GPX), for running and for the watch
    tool(
      "list_routes",
      "The athlete's saved routes, newest first: id, name, distance, climb and descent, whether it's a loop.",
      {},
      async () => (await routes.list()).map(({ preview: _p, ...r }) => ({ ...r, distance_km: Math.round(r.distance_m / 100) / 10 })),
    ),
    tool(
      "get_route",
      "One saved route: its points (longitude, latitude), distance and climb; with gpx=true also the GPX file (what the Suunto app imports to put a route on the watch).",
      { id: z.string(), gpx: z.boolean().optional() },
      async (a) => {
        const r = await routes.get(a.id);
        if (!r) throw new Error(`No route ${a.id}.`);
        const { segments, elevation: _e, ...rest } = r;
        const line = segments.flatMap((s, i) => (i ? s.coords.slice(1) : s.coords));
        return { ...rest, points: line.length > 400 ? line.filter((_, i) => i % Math.ceil(line.length / 400) === 0) : line, ...(a.gpx ? { gpx: toGpx(r) } : {}) };
      },
    ),
    {
      ...tool(
        "save_route",
        "Save a route from a line of points, e.g. the GPS track of a workout the athlete wants to run again (get_activity_streams latlng; note it is [lat, lng] there, while this takes [lng, lat]). It appears in the app's Routes, ready to edit or send to the watch.",
        {
          name: z.string().max(80),
          points: z.array(z.tuple([z.number(), z.number()])).min(2).max(50_000).describe("[longitude, latitude] pairs in order"),
        },
        async (a) => {
          const line = a.points as LngLat[];
          const r = await routes.save({ name: a.name, waypoints: [line[0]!, line.at(-1)!], segments: [{ mode: "straight", coords: line }] });
          return { id: r.id, name: r.name, distance_km: Math.round(r.distance_m / 100) / 10 };
        },
        false,
      ),
      local: true,
    },

    // ---- watch faces (the face builder's designs; the phone installs them)
    tool(
      "list_watch_faces",
      "Watch faces designed in the app's face builder (Settings → More → Advanced → Watch face builder) and Tartan's own Tartan Track, with their designs (colours, track style, marks, hands, background kind, the seven seconds colours). Photos are left out.",
      {},
      async () => ({ builtin: TARTAN_TRACK_DESIGN, presets: PRESETS, faces: await faces.list() }),
    ),
    {
      ...tool(
        "save_watch_face",
        "Save a watch-face design for the Suunto Run 2 (it appears in the app under Settings → More → Advanced → Watch face builder, ready to install from the phone). Colours are #rrggbb. Keep AMOLED in mind: a black background with few lit pixels saves battery. Give an id to change a saved face; leave it out for a new one.",
        {
          id: z.string().regex(/^\d{6,10}$/).optional(),
          name: z.string().max(30),
          background: z.union([
            z.object({ kind: z.literal("black") }),
            z.object({ kind: z.literal("colour"), colour: z.string() }),
            z.object({ kind: z.literal("gradient"), from: z.string(), to: z.string() }),
            z.object({ kind: z.literal("tartan"), colour: z.string(), dim: z.number().min(0).max(0.9) }),
          ]),
          art: z.enum(["none", "sunburst", "stripes", "split", "rings", "zones", "contours", "checker", "lanes", "halftone", "watermark"]).optional().describe("a pattern over the background, in colours.art (zones: heart-rate colours round the rim)"),
          track: z.enum(["lanes", "filled", "single", "dashed", "bezel", "none"]),
          finish: z.boolean().optional().describe("the finish line across the track at 12"),
          marks: z.enum(["all", "fives", "quarters", "none"]),
          markShape: z.enum(["line", "bar", "dot"]).optional(),
          numerals: z.enum(["none", "arabic", "roman", "big"]).optional().describe("arabic and roman: at 12 and 9 only (the watch draws its data elsewhere); big: one large 12 in place of the logo"),
          logo: z.enum(["top", "text", "none"]).optional().describe("above the centre: the T, the text, or nothing"),
          text: z.string().max(6).optional().describe("up to 6 characters, shown when logo is text"),
          hands: z.enum(["classic", "slim", "baton", "sword", "arrow", "skeleton", "dauphine", "block", "pencil"]),
          secondsStyle: z.enum(["needle", "lollipop", "arrow", "plain"]).optional(),
          caps: z.enum(["dot", "ring", "none"]).optional(),
          colours: z.object({ track: z.string(), finish: z.string(), marks: z.string(), minor: z.string(), numerals: z.string().optional(), logo: z.string(), text: z.string().optional(), hands: z.string(), caps: z.string(), art: z.string().optional() }),
          seconds: z.array(z.string()).length(7).describe("seven #rrggbb colours for the seconds hand; the first is the default"),
        },
        async (a) => {
          const f = await faces.save(a as Partial<FaceDesign>);
          return { id: f.id, name: f.name };
        },
        false,
      ),
      local: true,
    },

    tool("get_athlete_profile", "Strava profile, all-time / year-to-date totals, and the heart-rate settings used for zones and load.", {}, async () => ({
      athlete: await lib.strava.read("athlete.json"),
      stats: await lib.strava.read("stats.json"),
      heart_rate: await analytics.profile(),
    })),

    tool(
      "list_watch_files",
      "Files copied off the watch over Bluetooth, with type (FIT, JSON, text, binary) and size.",
      { watch: z.string().optional().describe("watch id or name; default all") },
      (a) => lib.watchFiles(a.watch),
    ),

    tool(
      "read_watch_file",
      "Read one file copied off the watch. FIT files are parsed into session + laps; text/JSON returned as text; binary as a hex preview.",
      { watch: z.string().describe("watch id from list_watch_files"), path: z.string().describe("path on the watch, e.g. /logs/x.fit") },
      (a) => lib.readWatchFile(a.watch, a.path),
    ),
  ];

  if (opts.allowSync !== false) {
    tools.push(
      tool(
        "sync_strava",
        "Fetch new activities (and full detail + streams for ones missing them) from Strava. Incremental; pauses near the Strava rate limit and continues next time.",
        { full: z.boolean().optional().describe("re-list the entire history") },
        async (a) => {
          const client = await lib.strava.client();
          if (!client?.connected) throw new Error("Strava is not connected. The user must run `tartan strava-auth` or connect in the app first.");
          const log: string[] = [];
          const res = await syncStrava(client, lib.strava, { full: a.full, log: (m) => log.push(m) });
          lib.invalidate();
          return { ...res, log: log.slice(-20) };
        },
        false,
      ),
    );
  }
  if (opts.allowSync !== false && opts.backupWatch) {
    const backupWatch = opts.backupWatch;
    tools.push(
      tool(
        "backup_watch",
        "Copy new files off the watch over Bluetooth (Linux host with BlueZ; the watch must be awake, bonded, and the phone's Bluetooth off). Takes minutes for large folders.",
        {
          path: z.string().optional().describe("folder on the watch, default /"),
          needle: z.string().optional().describe("part of the watch name if several are in range"),
        },
        (a) => backupWatch({ root: a.path ?? "/", needle: a.needle }),
        false,
      ),
    );
  }
  return tools;
}
