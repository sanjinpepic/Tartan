/**
 * The data tools, defined once and served two ways: by the MCP server to external agents,
 * and by the in-app coach to Claude. Read-only tools are safe to call freely.
 */
import { recentFeelings, RunNotes } from "./run-notes.ts";
import { CheckIns, todayReadiness } from "./readiness.ts";
import { loadBody } from "./fatigue.ts";
import { Lifts, nextWeights, records } from "./strength/log.ts";
import { Health } from "./health.ts";
import { Signals, SIGNAL_FIELDS, SOURCE_NAME, STRESS_LEVELS, type SignalDay, type SignalPut } from "./signals.ts";
import { z } from "zod";
import { Analytics } from "./analytics.ts";
import { durability } from "./durability.ts";
import { forecastSoon, pastSoon, upcomingWeather, Weather } from "./weather.ts";
import { bodyTags, conditionsAt, Habits } from "./habits.ts";
import { skyOf, WorkoutWeathers } from "./workout-weather.ts";
import { nudgeFacts, nudgeLines } from "./nudge.ts";
import type { Library } from "./library.ts";
import { planInput, Plans, RUN_KINDS, SESSION_KINDS, today, type PlanInput } from "./plan.ts";
import { LOGGED_SPORTS } from "./logged.ts";
import { sportFamily } from "./merge.ts";
import { AVOID, BAD_WEATHER, DAY_KEYS, readPrefs, savePrefs, slots, timeFor, toIcs } from "./schedule.ts";
import { Routes, toGpx, type LngLat } from "./routes.ts";
import { Faces } from "./faces.ts";
import { Memory, NOTE_KINDS, MAX_TEXT } from "./memory.ts";
import { PRESETS, TARTAN_TRACK_DESIGN, type FaceDesign } from "./watchface/tartan-face.ts";
import { syncStrava } from "./strava/sync.ts";
import { loadMilestones, onToday } from "./milestones.ts";
import { isSample } from "./sample.ts";
import { loadMoments } from "./run-moments.ts";

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

/** A logged workout's title when none was said. */
const LOGGED_NAMES: Record<(typeof LOGGED_SPORTS)[number], string> = { Run: "Run", Swim: "Swim", Ride: "Ride", Walk: "Walk", Hike: "Hike", WeightTraining: "Gym session", Yoga: "Yoga", Rowing: "Row", NordicSki: "Ski", Workout: "Workout" };
const SOURCES = ["all", "strava", "watch", "health", "intervals", "suunto-cloud", "phone", "logged"] as const;

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
  const habits = new Habits(lib.disk);
  const raceDays = async () => {
    const d = (await analytics.goals()).race?.date;
    const n = d ? Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today()}T12:00:00Z`)) / 86400_000) : -1;
    return n >= 0 ? n : null;
  };
  const readyNow = () => todayReadiness({ plans, load: () => analytics.load(60), checkins, signals: signalsToday, feelings: () => recentFeelings(lib), prefs: () => readPrefs(lib.disk), habits, forecast: () => forecastSoon(new Weather(lib)), past: () => pastSoon(new Weather(lib)), raceDays });
  const health = new Health(lib.disk);
  const signals = new Signals(lib.disk);
  const signalsToday = async () => {
    await health.feed().catch(() => {});
    return signals.day(today());
  };
  /** A day for the coach: only what was measured, each value with where it came from in words. */
  const forCoach = (d: SignalDay) => {
    const { from, ...values } = d;
    return { ...values, from: Object.fromEntries(Object.entries(from).map(([k, v]) => [k, SOURCE_NAME[v]])) };
  };
  const routes = new Routes(lib.disk);
  const memory = new Memory(lib.disk);
  const faces = new Faces(lib.disk);
  const lifts = new Lifts(lib.disk);
  const workoutWeather = new WorkoutWeathers(lib);
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
      "List workouts newest first; each workout once, with `sources` naming every copy (strava, watch, suunto-cloud, phone; logged for one the athlete told you about, with no recording). Rows: id, start (UTC), start_local, sport, name, distance_km, moving_min, elevation_m, avg/max HR, pace, and for outdoor workouts the weather they were done in once known (temp_c, feels_c, condition, sky, wind_kmh, flags: ice, rain (heavy), wind (strong), heat). Mention it when it explains something (\"that tempo was in 28° heat\"), not otherwise.",
      {
        since: z.string().optional().describe("ISO date or datetime, inclusive, e.g. 2026-09-01"),
        until: z.string().optional().describe("ISO date or datetime, inclusive for whole dates"),
        sport: z.string().optional().describe("e.g. Run (includes trail and treadmill), TrailRun, Ride, Swim"),
        source: z.enum(SOURCES).optional().describe("only workouts that have a copy in this source (default all)"),
        limit: z.number().int().min(1).max(2000).optional().describe("default 50"),
      },
      async (a) => {
        const rows = await workoutWeather.attach(await lib.activities({ ...a, limit: a.limit ?? 50 }));
        void workoutWeather.fill().catch(() => 0);
        return rows;
      },
    ),

    tool(
      "get_activity",
      "Full detail for one workout: merged summary, description, laps, per-km splits, best efforts, its copies, provenance (which source supplied each field), and the weather it was done in when outdoors (as in list_activities). For a run with a recording, `moments`: the place-specific pointers Tartan's rules found in the recording against the session it filled (at most one `good`, two `work_on`; none is normal for a steady run), each with where along the run (from_m/to_m, `where`), its facts with their numbers and one line. They are the only moments on the route you may point to: reword them if you like, but never add one, move one or change its numbers.",
      { id: z.string().describe("an id from list_activities (source ids like strava:123 also work)") },
      async (a) => {
        const d = await lib.activity(a.id);
        const id = String(d.id);
        const [w, ms] = await Promise.all([
          workoutWeather.of(id, 4000).catch(() => null),
          loadMoments(
            { disk: lib.disk, find: (x) => lib.find(x), rawStreams: (m) => lib.rawStreams(m as Parameters<typeof lib.rawStreams>[0]), view: () => plans.view(), review: (date, kind) => plans.review(date, kind), profile: () => analytics.profile(), family: sportFamily },
            id,
          ).catch(() => null),
        ]);
        // The tool's answer carries no sample indexes or pins: those are for the app's map.
        const moments = ms?.map(({ from_i: _a, to_i: _b, at: _c, ...m }) => m);
        return { ...d, ...(w ? { weather: w } : {}), ...(moments ? { moments } : {}) };
      },
    ),

    tool(
      "get_activity_streams",
      "Time series for one workout from its single best source (the watch's own file when present, else Strava), with canonical channels: time (s), distance (m), latlng, altitude (m), velocity (m/s), heartrate, cadence, watts, temp, grade, and from a watch's file when it recorded them the running dynamics (gct ground contact ms, vertical_oscillation mm, vertical_ratio %, stance_balance left %, step_length mm) and rr (beat-to-beat intervals in ms since the sample before). Evenly downsampled (rr thins with it: ask for a high max_points to read beats).",
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
      "The forecast at each planned session in the next week, at the athlete's training times, where they run (the start of their latest GPS workout, to about a kilometre): temperature, dew point, chance of rain, wind, and heat as temperature plus dew point in °F with the pace to give up for the same effort (Hadley's table; past 180 °F, no hard running), plus a cooler hour that day when heat costs 2% or more. Use it to move or soften hard sessions on hot days. With `bad_weather`, the athlete's choice for a rough day (swim, ride, treadmill, or run anyway). From Open-Meteo.",
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
      "get_milestones",
      "Moments the athlete has earned (Tartan's milestones): new bests at 1 km, 5 km, 10 km, half and marathon, the longest run yet and first runs over 10/20/30 km, half and marathon distance, the biggest week or month of running, races finished, the weekly target met weeks running (never days), and lightly the support work (a first 1 km swim, ten swims or rides in a year). Each with its date, workout, title and a one-line note. `new`: the ones just earned (on Today now); `recent`: the last 90 days. When one is new, give it one line of quiet credit in passing, then get on with the answer; never invent one, never make a fuss.",
      {},
      async () => {
        const { items } = await loadMilestones({ disk: lib.disk, activities: () => lib.activities(), efforts: () => lib.runEfforts(), goals: () => analytics.goals(), planWeeks: async () => (await plans.view()).weeks, sample: () => isSample(lib.disk) });
        const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
        const brief = ({ found: _f, quiet: _q, seen: _s, figure: _x, figure_label: _l, weight: _w, ...m }: (typeof items)[number]) => m;
        return { new: onToday(items).map(brief), recent: items.filter((m) => m.date >= since).sort((a, b) => b.date.localeCompare(a.date)).map(brief), total: items.length };
      },
    ),

    tool(
      "get_goals",
      "The athlete's own targets (weekly distance and workouts, long run, a race with distance, date and target time, and `availability`: training days and hours a week they have, preferred long-run day, notes; `bad_weather`: what they'd rather do than run in bad weather, swim, ride, treadmill or run, their setting) and progress: this week so far, weeks the target was met (of the last 12), the longest recent run, and the race (the targets' while it's ahead, else the training plan's next race session): days to go, a predicted finish time from the last 12 weeks' runs, and from 12 weeks out `countdown`: how the prediction moved over the last 4 weeks, the gap to the target, and the taper in the last two weeks.",
      {},
      async () => ({ ...(await analytics.goalProgress()), bad_weather: (await readPrefs(lib.disk)).bad_weather }),
    ),

    tool(
      "get_training_plan",
      "The current training plan (made by the coach) and how it is going: every week with its sessions by date, each marked done (with the workout that did it, or `manual` when the athlete ticked it off without a recording), missed, today, planned or rest, plus workouts nobody planned, and planned against done totals per week. Null when there is no plan yet.",
      {},
      () => plans.view(),
    ),

    tool(
      "get_readiness",
      "Today's readiness: the athlete's morning check-in (legs 1 heavy to 3 fresh; sleep 1-3 only when the watch didn't measure the night; pain with where and 1 a niggle, 2 sore, 3 painful), the niggles they reported in the last three weeks, their form (fitness minus fatigue), this morning's body signals when measured (`signals`: last night's sleep and its stages, resting heart rate, HRV, energy on waking, recovery time, breathing rate and more, each with its source in `from`: garmin, suunto, health_connect, apple_health, told or sample; `usual`: the median of the four weeks before; a field that isn't there wasn't measured, so never invent it), the verdict (ready, go easy, rest) with its reasons (`ill`: resting heart rate and breathing both up, ask how they feel before anything hard), and today's session (hard or not, done, or swapped for an easy run on a bad day), plus `day_choices` (the ways to change today's session, in the athlete's order, with `stance`: lead with the run or ease off, and why) and `day_swap` (the change Today suggests in the session card, with its reason, or the one they took). Plan around niggles: a recurring one means less load on it, not more.",
      {},
      () => readyNow(),
    ),

    tool(
      "get_habits",
      "What Tartan has learned about the athlete's days, plainly: what puts them off (their setting, `avoid`, and `bad_weather`, their usual swap), each condition's tendency (ice, rain, wind, cold, heat, dark, heavy legs, go-easy mornings: days like it, how many runs they changed, and `strong` once there's enough evidence), the strong ones in words, and today: the ways to change today's session in their order with the stance (lead with the run on a key session or after two changes in ten days; ease off with a niggle, a go-easy morning or a dislike in the forecast) and a nudge from their data in Tartan's words. Use it when they aren't feeling it: give a short pep from it in your own words (no guilt, no exclamation marks), offer the choices, and change the plan with swap_plan_session only when they pick one.",
      {},
      async () => {
        const [r, prefs, view, answers, goals] = await Promise.all([readyNow(), readPrefs(lib.disk), plans.view(), habits.answers(), analytics.goals()]);
        const c = r.day_choices;
        const nudge = c ? nudgeLines(await nudgeFacts({ lib, view, session: c, answers, race: goals.race, stance: c.stance })).text : null;
        return { avoid: prefs.avoid, cold_below: prefs.cold_below, bad_weather: prefs.bad_weather, tendencies: r.habits?.tendencies ?? [], learned: r.habits?.lines ?? [], today: c ? { ...c, nudge } : null, suggested: r.day_swap };
      },
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
      "get_body_signals",
      "The athlete's body signals by day (newest first), whichever watch or app measured them (their Garmin, their Suunto, Health Connect, Apple Health, what they told you, or the sample data in the demo): the night that ended that morning (sleep_start/end local, sleep_min asleep, deep/light/rem/awake minutes, latency_min to fall asleep, sleep_score 0-100, nap_min, sleep_estimated when worked out from heart rate and stillness rather than tracked), the night's lowest and average heart rate, HRV (RMSSD ms), highest blood oxygen %, breathing rate (breaths/min), resting heart rate, energy on waking 0-100 (Body Battery or Resources), stress 0-100 or a level, recovery hours still to go, VO2 max. `from` names where each value came from: say it when it matters (\"your Garmin had you at 31 energy\"). `usual` is the median of the four weeks before today. Only what was measured is there: a missing field means no reading, never zero. Never invent or estimate a value that isn't there.",
      { days: z.number().int().min(1).max(400).optional().describe("how far back, default 14") },
      async ({ days }) => {
        await health.feed().catch(() => {});
        const since = new Date(Date.parse(`${today()}T12:00:00Z`) - ((days ?? 14) - 1) * 86400_000).toISOString().slice(0, 10);
        const [list, now] = await Promise.all([signals.days(since), signals.day(today())]);
        return { today: today(), days: list.map(forCoach), usual: now.usual };
      },
    ),
    {
      ...tool(
        "note_body_signals",
        "Keep a body signal the athlete told you in their own words (\"my Body Battery was 30 this morning\", \"I only slept 5 hours\", \"resting heart rate 58 today\"), for that day: it counts in readiness and wins over a watch's number for that field. Only numbers they said, in these units: sleep_min (minutes asleep), resting_hr (bpm), energy (0-100), hrv_ms (RMSSD ms), stress (0-100), recovery_h (hours to go), breathing_rate (breaths/min), vo2max. Never a number you worked out or guessed.",
        {
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today"),
          sleep_min: z.number().min(0).max(1440).optional(),
          resting_hr: z.number().min(20).max(200).optional(),
          energy: z.number().min(0).max(100).optional(),
          hrv_ms: z.number().min(1).max(400).optional(),
          stress: z.number().min(0).max(100).optional(),
          stress_level: z.enum(STRESS_LEVELS).optional(),
          recovery_h: z.number().min(0).max(240).optional(),
          breathing_rate: z.number().min(3).max(60).optional(),
          vo2max: z.number().min(10).max(100).optional(),
        },
        async (a) => {
          const date = a.date ?? today();
          if (date > today()) return { error: "Not a day ahead." };
          const put = { date, source: "told" } as SignalPut;
          for (const f of SIGNAL_FIELDS) if ((a as Record<string, unknown>)[f] !== undefined) (put as Record<string, unknown>)[f] = (a as Record<string, unknown>)[f];
          if (Object.keys(put).length <= 2) return { error: "Nothing to keep: give at least one value they said." };
          const r = await signals.put([put]);
          return { kept: r.days.map(forCoach)[0] ?? null };
        },
        false,
      ),
      local: true,
    },
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
        "swap_plan_session",
        "Change a planned session, once you and the athlete have settled it (\"swap today's run for a swim\", \"a shorter one then\", \"can I do the intervals tomorrow?\"): swim or ride, an easy, long or recovery run as an easy swim or ride of about the same time (a swim an hour at most; a swim's target counts metres and 25 m lengths from their own swims), never a hard session; treadmill, the same run on the treadmill; short, a short easy run of 20-25 min (\"you can stop after 10\"); move, to a later free day in the plan (`day`; get_habits today.choices has the next free one); easy, a hard session as an easy run on a bad day. A change keeps the one made before: moving a session already swapped for a swim moves the swim, and a swap with `day` is swapped and moved at once (\"I'll swim tomorrow instead\"). Always pass the planned date and kind (swap_kind and moved_from once changed). Put your own numbers on it with `target` and `minutes` when you give some in words (\"40-50 lengths easy, 45 min\"), so the plan says what you said. undo takes it all back. The result has the new day's forecast at their training time and what in it puts them off (`puts_off`): if the day it goes to is as bad, say so. It shows on the Coach tab and Today at once and goes to the watch with the week; what they picked is kept for what Tartan learns. Running is the core: never fill the plan with cross-training.",
        {
          date: z.string().describe("the planned session's date, YYYY-MM-DD"),
          kind: z.enum(SESSION_KINDS).describe("its kind as planned, as in get_training_plan (swap_kind once swapped)"),
          to: z.enum(["swim", "ride", "treadmill", "short", "move", "easy"]).optional().describe("default easy"),
          day: z.string().optional().describe("the day it goes to, YYYY-MM-DD, later and free in the plan: needed for move, and with any other change it moves as well"),
          reason: z.string().max(120).optional().describe("in a few words, shown with the session, e.g. 'the weather'"),
          target: z.string().max(160).optional().describe("your own words for the swapped session's target, e.g. 'easy: 40-50 lengths of 25 m, steady, rest at the wall when you need'"),
          minutes: z.number().int().min(10).max(240).optional().describe("your own length for the swapped session, minutes"),
          undo: z.boolean().optional(),
        },
        async (a) => {
          try {
            await plans.swap(a.date, a.kind, a.reason ?? (a.to && a.to !== "easy" ? "not feeling it" : "a hard day"), a.undo === true, a.to ?? "easy", a.day, { target: a.target, minutes: a.minutes });
          } catch (e) {
            return { error: (e as Error).message };
          }
          if (a.undo) await habits.undo(a.date, a.kind);
          else if (a.to && a.to !== "easy") {
            const c = await checkins.get(a.date);
            await habits.answer(a.date, a.kind, bodyTags(c, null), a.to);
          }
          const v = await plans.view();
          const s = v.weeks.flatMap((w) => w.days).flatMap((d) => d.sessions.map((x) => ({ ...x, on: d.date }))).find((x) => (x.swap_kind === a.kind && (x.moved_from ?? x.on) === a.date) || (x.kind === a.kind && x.on === a.date));
          // A run that lands outdoors on another day: that day's forecast at their time, and what in it puts them off.
          let forecast: Record<string, unknown> | undefined;
          if (s && !a.undo && s.on !== a.date && RUN_KINDS.has(s.kind) && s.swap_to !== "treadmill") {
            const [hours, prefs] = await Promise.all([forecastSoon(new Weather(lib), 2500).then((f) => f?.hours ?? []).catch(() => []), readPrefs(lib.disk)]);
            const at = timeFor(prefs, s.on);
            const h = hours.find((x) => x.time.slice(0, 13) === `${s.on}T${at.slice(0, 2)}`);
            if (h) {
              const tags = conditionsAt(hours, `${s.on}T${at}`, prefs.cold_below).tags;
              forecast = { at, sky: skyOf(h)[1], temp_c: Math.round(h.temp_c), wind_kmh: Math.round(h.wind_kmh ?? 0), puts_off: tags.filter((t) => (prefs.avoid as string[] | undefined)?.includes(t)) };
            }
          }
          return { ok: true, ...(s ? { session: { date: s.on, kind: s.kind, title: s.title, duration_min: s.duration_min, target: s.target, notes: s.notes } } : {}), ...(forecast ? { forecast } : {}) };
        },
        false,
      ),
      local: true,
    },
    {
      ...tool(
        "log_workout",
        "Log a workout the athlete tells you about that nothing recorded (\"I swam 25x25m today\", \"did 40 min on the bike\", \"ran 5 k, left the watch at home\"). It's saved as a workout of its own: it shows in their activities, fills that day's planned session of its kind (a swim fills a planned swim, a ride a planned ride, else either fills cross training; a gym session strength, a run a run) and counts in their load. Work out what you can from their words (25 lengths of 25 m is 625 m) and log it at once, without questions: with no time or distance it still ticks the day off (it just can't count in the load; a passing word that the time would help is enough, never a question). Not for a workout already recorded that day (it says so). Say in a few words what you logged.",
        {
          sport: z.enum(LOGGED_SPORTS).describe("WeightTraining for the gym, Workout for anything else"),
          date: z.string().optional().describe("YYYY-MM-DD, default today; not in the future"),
          time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("local start HH:MM, when they said"),
          minutes: z.number().min(1).max(1440).optional(),
          distance_m: z.number().min(1).max(500_000).optional().describe("metres (a 5 k run is 5000)"),
          effort: z.number().int().min(1).max(10).optional().describe("how hard it felt, 1 very easy … 10 all out, when they said"),
          name: z.string().max(60).optional().describe("a short title, e.g. Pool swim; default from the sport"),
          note: z.string().max(300).optional().describe("anything else worth keeping, e.g. 25 × 25 m"),
        },
        async (a) => {
          const day = a.date ?? today();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today()) return { error: "The date must be YYYY-MM-DD, today or earlier." };
          const family = sportFamily(a.sport);
          const already = (await lib.activities({ since: new Date(`${day}T00:00:00`).toISOString(), until: new Date(`${day}T23:59:59.999`).toISOString() })).find((r) => sportFamily(r.sport) === family && !(r.sources.length === 1 && r.sources[0] === "logged"));
          if (already) return { already_recorded: { id: already.id, name: already.name, distance_km: already.distance_km, moving_min: already.moving_min }, note: "That day already has this workout from a recording; nothing logged." };
          const saved = await lib.logged.add({ date: day, ...(a.time ? { time: a.time } : {}), sport: a.sport, name: a.name?.trim() || LOGGED_NAMES[a.sport], ...(a.minutes ? { minutes: a.minutes } : {}), ...(a.distance_m ? { distance_m: a.distance_m } : {}), ...(a.effort ? { effort: a.effort } : {}), ...(a.note ? { note: a.note } : {}) });
          lib.invalidate();
          const row = await lib.find(`logged:${saved.id}`).catch(() => null);
          const v = await plans.view().catch(() => null);
          const filled = v?.weeks.flatMap((w) => w.days).find((d) => d.date === day)?.sessions.find((x) => row && x.activity?.id === row.id);
          return { logged: { id: saved.id, date: day, sport: saved.sport, name: saved.name, minutes: saved.minutes, distance_m: saved.distance_m, effort: saved.effort }, ...(filled ? { fills: `${filled.kind}: ${filled.title}` } : {}) };
        },
        false,
      ),
      local: true,
    },
    {
      ...tool(
        "remove_logged_workout",
        "Take back a workout logged with log_workout (a mistake, or logged twice). Its id is the one log_workout gave, or list_activities with source \"logged\" (ids there look like logged:abc123; either form works). Recorded workouts can't be removed this way.",
        { id: z.string() },
        async (a) => {
          lib.invalidate();
          const id = a.id.replace(/^logged:/, "");
          const own = (await lib.logged.all()).find((w) => w.id === id) ?? (await lib.find(a.id).then((m) => m.members.find((x) => x.source === "logged")?.key.slice(7)).then((k) => (k ? { id: k } : null)).catch(() => null));
          const done = own ? await lib.logged.remove(own.id) : false;
          lib.invalidate();
          return done ? { removed: true } : { error: "No logged workout with that id." };
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
        return { weekday: prefs.weekday, weekend: prefs.weekend, days: prefs.days ?? {}, reminders: prefs.remind, bad_weather: prefs.bad_weather, avoid: prefs.avoid, cold_below: prefs.cold_below, upcoming: slots(v.weeks, prefs, v.today).slice(0, a.limit ?? 14) };
      },
    ),
    {
      ...tool(
        "set_training_times",
        "Set when the athlete usually trains, e.g. weekdays 18:00 after work and weekends 09:00; a day can have its own time (an empty string goes back to the weekday or weekend time); bad_weather, what they'd rather do than run in bad weather (\"I swim when it pours\"); and avoid, what puts them off (\"I hate running on ice\"). Only the fields given change. The app's reminders and calendar events follow.",
        {
          weekday: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("HH:MM, Monday to Friday"),
          weekend: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("HH:MM, Saturday and Sunday"),
          days: z.object(Object.fromEntries(DAY_KEYS.map((d) => [d, z.string().optional()]))).optional().describe('a day with its own time, e.g. {"wed": "12:00"}; "" clears a day'),
          bad_weather: z.enum(BAD_WEATHER).optional().describe("on a bad-weather day they'd rather: swim, ride, treadmill, or run anyway"),
          avoid: z.array(z.enum(AVOID)).optional().describe("what puts them off running, the whole list: ice (ice, snow, slippery ground), rain (heavy), wind (strong), cold, heat, dark. Set it from their own words (\"I hate running on ice\"); Today then suggests a change on such days, at once"),
          cold_below: z.number().int().min(-30).max(15).optional().describe("cold is below this, °C (default 0)"),
        },
        async (a) => {
          const cur = await readPrefs(lib.disk);
          const p = await savePrefs(lib.disk, { weekday: a.weekday, weekend: a.weekend, ...(a.days ? { days: { ...cur.days, ...(a.days as Record<string, string | undefined>) } } : {}), ...(a.bad_weather ? { bad_weather: a.bad_weather } : {}), ...(a.avoid ? { avoid: a.avoid } : {}), ...(a.cold_below !== undefined ? { cold_below: a.cold_below } : {}) });
          return { weekday: p.weekday, weekend: p.weekend, days: p.days ?? {}, bad_weather: p.bad_weather, avoid: p.avoid, cold_below: p.cold_below };
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
