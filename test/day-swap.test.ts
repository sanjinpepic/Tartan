/** Cross-training that supports a runner: swim and ride sessions, changing today's run (asked, or suggested with a reason), what Tartan learns, the nudge. */
import { expect, test } from "bun:test";
import { aheadChange, dayChoices, dayOffer, proposeAhead, stanceFor, type DaySession, type PlanDays } from "../src/day-swap.ts";
import { MemoryDisk } from "../src/disk.ts";
import { conditionsAt, daysSeen, Habits, type Answer, ordered, reasonFor, tendencies, usualPicks, type Seen, type Tag } from "../src/habits.ts";
import { Library } from "../src/library.ts";
import { nudgeLines } from "../src/nudge.ts";
import { mondayOf, Plans, today, type PlanInput } from "../src/plan.ts";
import { CheckIns, todayReadiness } from "../src/readiness.ts";
import { DEFAULT_PREFS, readPrefs, savePrefs } from "../src/schedule.ts";
import { dataTools } from "../src/tools.ts";
import type { Hour } from "../src/weather.ts";
import { FIT, hcPlanned, icuType, sportOf, workoutFit } from "../src/workout/export.ts";
import { workoutFor } from "../src/workout/from-plan.ts";

const DAY = 86400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** A day of weather, every hour the same: mild, calm and light unless told. */
const dayOf = (date: string, h: Partial<Hour> = {}): Hour[] => Array.from({ length: 24 }, (_, i) => ({ time: `${date}T${String(i).padStart(2, "0")}:00`, temp_c: 10, dew_c: 5, rain_pct: 10, rain_mm: 0, wind_kmh: 10, day: true, ...h }));
const WET = { rain_pct: 90, rain_mm: 3, wind_kmh: 40, code: 63 };
const ICY = { temp_c: -2, dew_c: -4, code: 71, snow_cm: 0.4, rain_mm: 0.3 };

// ------------------------------------------------------------------ the weather's tags

test("ice and snow from the forecast: snow codes and snowfall, freezing rain, and around zero after rain", () => {
  const at = "2026-11-20T07:00";
  expect(conditionsAt(dayOf("2026-11-20", ICY), at)).toEqual({ tags: ["ice", "cold"], words: ["Snow", "-2 °C"] });
  expect(conditionsAt(dayOf("2026-11-20", { temp_c: 0.5, code: 66 }), at).tags).toEqual(["ice"]);
  // Rain overnight, then a frost at 07:00: slippery.
  const frost = dayOf("2026-11-20", { temp_c: 3 }).map((h, i) => (i < 4 ? { ...h, rain_mm: 1.2, code: 61 } : i >= 6 ? { ...h, temp_c: 0 } : h));
  expect(conditionsAt(frost, at)).toEqual({ tags: ["ice"], words: ["Icy"] });
  // A dry frost isn't ice; a wet 3 °C isn't either.
  expect(conditionsAt(dayOf("2026-11-20", { temp_c: -1 }), at).tags).toEqual(["cold"]);
  expect(conditionsAt(dayOf("2026-11-20", { temp_c: 3, rain_mm: 1 }), at).tags).toEqual([]);
  // Heavy rain and wind, dark, heat, a set cold.
  expect(conditionsAt(dayOf("2026-11-20", WET), at)).toEqual({ tags: ["rain", "wind"], words: ["Heavy rain", "wind 40 km/h"] });
  expect(conditionsAt(dayOf("2026-11-20", { wind_kmh: 20, gust_kmh: 60 }), at).words).toEqual(["Gusts of 60 km/h"]);
  expect(conditionsAt(dayOf("2026-11-20", { day: false }), at).tags).toEqual(["dark"]);
  expect(conditionsAt(dayOf("2026-11-20", { temp_c: 30, dew_c: 20 }), at).tags).toEqual(["heat"]);
  expect(conditionsAt(dayOf("2026-11-20", { temp_c: 3 }), at, 5).tags).toEqual(["cold"]);
  expect(conditionsAt([], at).tags).toEqual([]);
});

// ------------------------------------------------------------------ what's learned

const seen = (tags: Tag[], changed: 0 | 1, n = 1): Seen[] => Array.from({ length: n }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, tags, changed }));

test("a tendency needs evidence: a prior, three days at least, and clearly above other days", () => {
  const plain = seen([], 0, 10);
  // One or two icy days, both changed: not enough.
  expect(tendencies([...plain, ...seen(["ice"], 1, 2)]).find((t) => t.tag === "ice")).toMatchObject({ n: 2, changed: 2, p: 0.6, strong: false });
  // Three of three: (3 + 1) / (3 + 3).
  expect(tendencies([...plain, ...seen(["ice"], 1, 3)]).find((t) => t.tag === "ice")).toMatchObject({ n: 3, changed: 3, p: 0.67, strong: true });
  // Two of three: not.
  expect(tendencies([...plain, ...seen(["ice"], 1, 2), ...seen(["ice"], 0)]).find((t) => t.tag === "ice")!.strong).toBe(false);
  // Someone who changes most runs anyway: icy days aren't special.
  expect(tendencies([...seen([], 1, 10), ...seen(["ice"], 1, 4)]).find((t) => t.tag === "ice")!.strong).toBe(false);
});

test("Run anyway lowers a tendency, and an offer left alone counts as running", () => {
  const answers: Answer[] = [1, 2, 3, 4].map((d) => ({ date: `2026-11-0${d}`, kind: "easy", tags: ["ice"], pick: "swim" }));
  const plain = Array.from({ length: 8 }, (_, i) => ({ date: `2026-10-${10 + i}`, kind: "easy", done: true }));
  const learn = (a: Answer[]) => tendencies(daysSeen({ today: "2026-11-20", answers: a, runs: plain, tagsOn: () => [] })).find((t) => t.tag === "ice")!;
  expect(learn(answers).strong).toBe(true);
  const after: Answer[] = [...answers, { date: "2026-11-10", kind: "easy", tags: ["ice"], pick: "run" }, { date: "2026-11-12", kind: "easy", tags: ["ice"], offered: true }];
  expect(learn(after)).toMatchObject({ n: 6, changed: 4, strong: false });
});

test("your usual pick leads the choices, after three answers; one or two change nothing", () => {
  const a = (pick: "swim" | "ride" | "short", n: number) => Array.from({ length: n }, (_, i) => ({ date: `2026-11-0${i + 1}`, kind: "easy", tags: [] as Tag[], pick }));
  expect(usualPicks(a("ride", 2))).toEqual([]);
  expect(usualPicks([...a("ride", 2), ...a("short", 1)])).toEqual(["ride"]);
  const choices = [{ to: "nudge" as const }, { to: "swim" as const }, { to: "ride" as const }, { to: "short" as const }];
  expect(ordered(choices, ["ride"]).map((c) => c.to)).toEqual(["ride", "nudge", "swim", "short"]);
  expect(ordered(choices, []).map((c) => c.to)).toEqual(["nudge", "swim", "ride", "short"]);
});

test("the reason in one line: what you said first, else a strong habit, else nothing", () => {
  const strong = tendencies([...seen([], 0, 10), ...seen(["ice"], 1, 4)]);
  expect(reasonFor(["ice", "cold"], ["ice"], [], [])).toEqual({ reason: "You said ice and snow put you off.", tags: ["ice"], explicit: true });
  expect(reasonFor(["rain"], ["rain"], [], [])!.reason).toBe("You said heavy rain puts you off.");
  expect(reasonFor(["ice"], [], strong, ["swim"])).toEqual({ reason: "On icy or snowy days you've changed 4 of 4 runs, mostly for a swim.", tags: ["ice"], explicit: false });
  expect(reasonFor(["rain"], [], strong, [])).toBeNull();
  expect(reasonFor([], ["ice"], strong, [])).toBeNull();
});

// ------------------------------------------------------------------ today's session: asked, or suggested

const T = "2026-11-18"; // a Wednesday
const day = (date: string, ...sessions: DaySession[]) => ({ date, sessions: sessions.map((s) => ({ status: date === T ? "today" : "planned", ...s })) });
const week = (todays: DaySession, more: PlanDays = [day("2026-11-19"), day("2026-11-20", { kind: "easy", title: "Easy run" })]): PlanDays => [day("2026-11-16"), day("2026-11-17", { kind: "easy", title: "Easy run" }), day(T, todays), ...more];
const easy = { kind: "easy", title: "Easy run", duration_min: 45 };
const offer = (o: Partial<Parameters<typeof dayOffer>[0]>) =>
  dayOffer({ today: T, now: `${T}T08:00`, days: week(easy), timeFor: () => "17:00", hours: [...dayOf(T, WET), ...dayOf(addDays(T, 1)), ...dayOf(addDays(T, 2))], choice: "swim", avoid: [], coldBelow: 0, body: [], tendencies: [], usual: [], ...o });

test("no suggestion without a dislike you said or enough evidence: rough weather alone, or a weak habit, says nothing", () => {
  expect(offer({})).toBeNull();
  expect(offer({ choice: "run" })).toBeNull();
  expect(offer({ tendencies: tendencies([...seen([], 0, 10), ...seen(["rain"], 1, 2)]) })).toBeNull();
  // Heavy legs alone: nothing learned about them yet.
  expect(offer({ body: ["heavy_legs"] })).toBeNull();
});

test("a dislike you said, in the forecast: the session card suggests your swim first, with its reason, Run anyway last", () => {
  const o = offer({ avoid: ["rain"] })!;
  expect(o).toMatchObject({ state: "offer", kind: "easy", title: "Easy run", why: "Heavy rain, wind 40 km/h at 17:00", reason: "You said heavy rain puts you off." });
  expect(o.choices).toEqual([{ to: "swim", minutes: 45 }, { to: "move", day: "2026-11-19" }, { to: "short", minutes: 25 }, { to: "run" }]);
  // Without a sport chosen: a swim and a ride both. A long run's swim stops at an hour.
  expect(offer({ avoid: ["rain"], choice: "run", days: week({ kind: "long", title: "Long run", duration_min: 100 }) })!.choices.slice(0, 2)).toEqual([{ to: "swim", minutes: 60 }, { to: "ride", minutes: 100 }]);
  // A hard session never becomes a swim: shorter or another day.
  expect(offer({ avoid: ["rain"], days: week({ kind: "intervals", title: "6 × 800 m", duration_min: 55 }) })!.choices.map((c) => c.to)).toEqual(["move", "short", "run"]);
  // Not a race, not a run kept or done, not late at night.
  expect(offer({ avoid: ["rain"], days: week({ kind: "race", title: "10k" }) })).toBeNull();
  expect(offer({ avoid: ["rain"], days: week({ ...easy, weather_kept: true }) })).toBeNull();
  expect(offer({ avoid: ["rain"], days: week({ ...easy, status: "done" }) })).toBeNull();
  expect(offer({ avoid: ["rain"], now: `${T}T22:10` })).toBeNull();
});

test("a clear habit suggests it too, saying why; icy days and heavy legs alike", () => {
  const icy = tendencies([...seen([], 0, 10), ...seen(["ice"], 1, 4)]);
  const o = offer({ tendencies: icy, usual: ["swim"], hours: [...dayOf(T, ICY), ...dayOf(addDays(T, 1)), ...dayOf(addDays(T, 2))] })!;
  expect(o.why).toBe("Snow, -2 °C at 17:00");
  expect(o.reason).toBe("On icy or snowy days you've changed 4 of 4 runs, mostly for a swim.");
  expect(o.choices[0]).toEqual({ to: "swim", minutes: 45 });
  const legs = tendencies([...seen([], 0, 10), ...seen(["heavy_legs"], 1, 3)]);
  expect(offer({ tendencies: legs, body: ["heavy_legs"] })).toMatchObject({ why: "Heavy legs this morning", reason: "On heavy-legs mornings you've changed 3 of 3 runs." });
});

test("on your side, not a pushover: a third change in ten days or a key run leads with the run; a niggle or ice leads with the others", () => {
  const answers = ["2026-11-12", "2026-11-15"].map((date) => ({ date, kind: "easy", tags: [] as Tag[], pick: "swim" as const }));
  const st = stanceFor({ today: T, session: easy, days: week(easy), answers });
  expect(st).toEqual({ lead: "run", line: "That's the third change in ten days. Do 25 easy minutes and call it a win." });
  expect(dayChoices({ session: easy, today: T, days: week(easy), choice: "swim", stance: st }).map((c) => c.to)).toEqual(["short", "nudge", "swim", "move"]);
  // One change before: no push.
  expect(stanceFor({ today: T, session: easy, days: week(easy), answers: answers.slice(1) }).lead).toBe("either");
  // The long run, the week's only hard session, a race close.
  expect(stanceFor({ today: T, session: { kind: "long", title: "Long run" }, days: week(easy), answers: [] }).lead).toBe("run");
  expect(stanceFor({ today: T, session: { kind: "tempo", title: "Tempo" }, days: week({ kind: "tempo", title: "Tempo" }), answers: [] }).line).toBe("It's the one hard session this week. Warm up for 10 minutes, then decide.");
  expect(stanceFor({ today: T, session: easy, days: week(easy), answers: [], raceDays: 12 }).line).toBe("Your race is in 12 days: this one counts. A shorter run still does.");
  // A genuine reason wins, even after changes.
  const ease = stanceFor({ today: T, session: easy, days: week(easy), answers, niggle: true });
  expect(ease.lead).toBe("others");
  expect(dayChoices({ session: easy, today: T, days: week(easy), choice: "swim", stance: ease }).map((c) => c.to)).toEqual(["swim", "move", "short", "nudge"]);
  // Ice you said puts you off: the others lead on the card, even on a long run.
  const o = offer({ avoid: ["ice"], days: week({ kind: "long", title: "Long run", duration_min: 90 }), hours: [...dayOf(T, ICY), ...dayOf(addDays(T, 1)), ...dayOf(addDays(T, 2))], stance: { lead: "run", line: "It's the long run, the key one this week. Start easy and see how it goes." } })!;
  expect(o.choices[0]).toEqual({ to: "swim", minutes: 60 });
  // A learned reason with a push: the run leads, and it says so.
  const legs = tendencies([...seen([], 0, 10), ...seen(["heavy_legs"], 1, 3)]);
  const p = offer({ tendencies: legs, body: ["heavy_legs"], stance: st })!;
  expect(p.choices.slice(0, 2).map((c) => c.to)).toEqual(["short", "run"]);
  expect(p.reason).toContain("That's the third change in ten days.");
});

test("the nudge in Tartan's own words: from the week, the race, how easy runs feel; pushing back or easing off", () => {
  const base = { session: { title: "Easy run", kind: "easy", minutes: 45 }, week: { runs: 2, km: 14.2 } };
  expect(nudgeLines(base).text).toBe("You've run 2 times this week, 14.2 km. Today keeps it going. Just start: 10 minutes easy, then decide. Coming home then is fine too.");
  expect(nudgeLines({ ...base, race: { name: "Helsinki Half", days: 30 }, easy_felt: { avg: 4.2, n: 6 } }).text).toBe(
    "30 days to Helsinki Half. Today is one small part of getting there. Your easy runs nearly always feel good by the end, going by the watch. Just start: 10 minutes easy, then decide. Coming home then is fine too.",
  );
  expect(nudgeLines({ ...base, week: { runs: 0, km: 0 }, since_last: 5, session: { title: "6 × 800 m", kind: "intervals" } }).text).toBe(
    "It's been 5 days since your last run, so the first few minutes may feel stiff. They pass. Just start: warm up for 10 minutes, then decide if the reps are on.",
  );
  const push = nudgeLines({ ...base, stance: { lead: "run", line: "That's the third change in ten days. Do 25 easy minutes and call it a win." } });
  expect(push.text.startsWith("That's the third change in ten days.")).toBe(true);
  expect(push.text.split(". ").length).toBeLessThanOrEqual(6);
  expect(nudgeLines({ ...base, stance: { lead: "others", line: "With that niggle, an easy change is the right call." } }).text).toBe("With that niggle, an easy change is the right call. Or go out for 10 easy minutes if you feel like it, and see.");
  for (const t of [push.text, nudgeLines(base).text]) expect(t).not.toContain("!");
});

// ------------------------------------------------------------------ in the plan, Today and the coach

const setup = async (sessions: PlanInput["weeks"][number]["sessions"], next: PlanInput["weeks"][number]["sessions"] = []) => {
  const lib = new Library(new MemoryDisk());
  await lib.strava.write([], "index.json");
  const plans = new Plans(lib);
  const t = today();
  const mon = mondayOf(t);
  await plans.save({ title: "Build", summary: "x", weeks: [{ start: mon, focus: "Base", sessions }, { start: addDays(mon, 7), focus: "Base", sessions: next }], zones: [{ name: "Easy", heart_rate: "130-145 bpm" }] });
  const tools = dataTools(lib);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const x = tools.find((y) => y.name === name)!;
    return (await x.run(x.schema.parse(args))) as Record<string, any>;
  };
  const checkins = new CheckIns(lib.disk);
  const habits = new Habits(lib.disk);
  let hours: Hour[] = [];
  const ready = () => todayReadiness({ plans, load: async () => ({ today: { form: 0 } }), checkins, habits, prefs: () => readPrefs(lib.disk), forecast: async () => ({ hours }), past: async () => null, now: () => new Date(`${t}T08:00:00`) });
  const todays = async () => (await plans.view()).weeks.flatMap((w) => w.days).find((d) => d.date === t)!.sessions;
  return { lib, plans, call, ready, todays, habits, checkins, t, setHours: (h: Hour[]) => (hours = h) };
};

test("swim and ride sessions are filled by a swim and a ride, logged ones too, before strength takes them", async () => {
  const t = today();
  const { call, todays } = await setup([
    { date: t, kind: "strength", title: "Strength", duration_min: 30 },
    { date: t, kind: "swim", title: "Easy swim", duration_min: 40 },
    { date: t, kind: "ride", title: "Easy ride", duration_min: 60 },
  ]);
  expect((await call("log_workout", { sport: "Swim", minutes: 40, distance_m: 1500 })).fills).toBe("swim: Easy swim");
  expect((await call("log_workout", { sport: "Ride", minutes: 60 })).fills).toBe("ride: Easy ride");
  const [strength, s, r] = await todays();
  expect(strength!.status).toBe("today");
  expect(s).toMatchObject({ kind: "swim", status: "done", activity: { sport: "Swim" } });
  expect(r).toMatchObject({ kind: "ride", status: "done", activity: { sport: "Ride" } });
  // A run never fills a swim.
  await call("log_workout", { sport: "Run", minutes: 30 });
  expect((await todays())[0]!.status).toBe("today");
});

test("swim and ride on the watch and other watches: pool swimming and cycling", () => {
  expect([sportOf("swim"), sportOf("ride"), sportOf("easy"), sportOf("cross")]).toEqual(["swimming", "cycling", "running", "other"]);
  expect([icuType("swim"), icuType("ride")]).toEqual(["Swim", "Ride"]);
  const r = workoutFor({ date: "2026-11-18", kind: "swim", title: "Easy swim", duration_min: 45 }, [], { drink: true, drinkMin: 20, gel: true, gelMin: 45, fromMin: 30 } as never);
  const w = (r as { workout: Parameters<typeof workoutFit>[0] }).workout;
  // One step, no drink reminders in the pool.
  expect(w.blocks).toEqual([{ kind: "run", duration_s: 2700, title: "Swim" }]);
  expect(workoutFit(w, sportOf("swim")).length).toBeGreaterThan(40);
  expect([FIT.sport.swimming, FIT.subSport.swimming, FIT.sport.cycling]).toEqual([5, 17, 2]);
  expect(hcPlanned({ date: "2026-11-18", kind: "ride", title: "Easy ride", workout: w }, 0).exercise).toBe("biking");
  expect(hcPlanned({ date: "2026-11-18", kind: "swim", title: "Easy swim", workout: w }, 0).exercise).toBe("swimming_pool");
});

test("Today: nothing suggested by default; with a dislike ticked, suggested in the card; taken, undone, Run anyway", async () => {
  const t = today();
  const { lib, plans, ready, todays, habits, setHours } = await setup([{ date: t, kind: "easy", title: "Easy run", duration_min: 50, target: "easy, 130-145 bpm" }]);
  setHours(dayOf(t, WET));
  expect([DEFAULT_PREFS.bad_weather, DEFAULT_PREFS.avoid]).toEqual(["run", []]);
  let r = await ready();
  expect(r.day_swap).toBeNull();
  // Asked for: the choices are there all the same, a nudge first.
  expect(r.day_choices!.choices.map((c) => c.to).slice(0, 4)).toEqual(["nudge", "swim", "ride", "short"]);
  // A swim preferred, but nothing ticked: still nothing unasked.
  await savePrefs(lib.disk, { bad_weather: "swim", weekday: "17:00", weekend: "17:00" });
  expect((await ready()).day_swap).toBeNull();
  await savePrefs(lib.disk, { avoid: ["rain"] });
  r = await ready();
  expect(r.day_swap).toMatchObject({ state: "offer", kind: "easy", why: "Heavy rain, wind 40 km/h at 17:00", reason: "You said heavy rain puts you off." });
  expect(r.day_swap!.choices[0]).toEqual({ to: "swim", minutes: 50 });
  expect((await habits.answers())[0]).toMatchObject({ date: t, kind: "easy", offered: true });
  // Swim instead.
  await plans.swap(t, "easy", "the weather", false, "swim");
  expect((await todays())[0]).toMatchObject({ kind: "swim", title: "Easy swim", duration_min: 50, swapped_from: "Easy run", swap_to: "swim", notes: "Swapped from Easy run: the weather." });
  r = await ready();
  expect(r.day_swap).toEqual({ state: "taken", date: t, kind: "easy", title: "Easy run", choices: [{ to: "swim", minutes: 50 }] });
  expect(r.session!.swapped_from).toBeUndefined();
  // Undo: the run is back, and so is the suggestion.
  await plans.swap(t, "easy", "", true);
  expect((await ready()).day_swap).toMatchObject({ state: "offer" });
  // Run anyway: nothing more today.
  await plans.swap(t, "easy", "the weather", false, "keep");
  expect((await todays())[0]).toMatchObject({ kind: "easy", weather_kept: true });
  expect((await ready()).day_swap).toBeNull();
});

test("a shorter version and moving it: swapped with a note, and undone", async () => {
  const t = today();
  const { plans, todays, ready } = await setup(
    [{ date: t, kind: "long", title: "Long run", duration_min: 90 }, { date: addDays(t, 2), kind: "easy", title: "Easy run", duration_min: 40 }].filter((s) => s.date < addDays(mondayOf(t), 7)) as never,
    [{ date: addDays(t, 2), kind: "easy", title: "Easy run", duration_min: 40 }].filter((s) => s.date >= addDays(mondayOf(t), 7)) as never,
  );
  await plans.swap(t, "long", "not feeling it", false, "short");
  expect((await todays())[0]).toMatchObject({ kind: "easy", title: "Short easy run", duration_min: 25, swap_to: "short", notes: "Swapped from Long run: not feeling it. You can stop after 10 minutes, and that still counts." });
  expect((await ready()).day_swap).toMatchObject({ state: "taken", choices: [{ to: "short", minutes: 25 }] });
  await plans.swap(t, "long", "", true);
  await expect(plans.swap(t, "long", "x", false, "move", addDays(t, 2))).rejects.toThrow(/already has a session/);
  await plans.swap(t, "long", "not feeling it", false, "move", addDays(t, 1));
  const days = (await plans.view()).weeks.flatMap((w) => w.days);
  expect(days.find((d) => d.date === t)!.sessions).toEqual([]);
  expect(days.find((d) => d.date === addDays(t, 1))!.sessions[0]).toMatchObject({ kind: "long", date: addDays(t, 1), moved_from: t, swap_to: "move" });
  expect((await ready()).day_swap).toMatchObject({ state: "taken", choices: [{ to: "move", day: addDays(t, 1) }] });
  await plans.swap(t, "long", "", true);
  expect((await todays())[0]).toMatchObject({ kind: "long", status: "today" });
});

test("a few days ahead: one change through the plan's proposal for weather you avoid, at most once a week", async () => {
  const t = today();
  const target = addDays(t, 2);
  const mon = mondayOf(t);
  const inWeek = (d: string) => (d < addDays(mon, 7) ? 0 : 1);
  const s = { date: target, kind: "easy" as const, title: "Easy run", duration_min: 45 };
  const { lib, plans, habits, checkins } = await setup(inWeek(target) === 0 ? [s] : [], inWeek(target) === 1 ? [s] : []);
  await savePrefs(lib.disk, { bad_weather: "swim", avoid: ["ice"], weekday: "07:00", weekend: "07:00" });
  const hours = [0, 1, 2, 3, 4, 5].flatMap((n) => dayOf(addDays(t, n), n === 2 ? ICY : {}));
  const deps = { disk: lib.disk, plans, habits, checkins, prefs: () => readPrefs(lib.disk), forecast: async () => ({ hours }), past: async () => null };
  const c = await proposeAhead(deps);
  expect(c).toMatchObject({ date: target, kind: "easy", to: "swim", minutes: 45 });
  expect(c!.why).toMatch(/^Snow, -2 °C on \w+ at 07:00\. You said ice and snow put you off\.$/);
  const p = await plans.proposal();
  expect(p).toMatchObject({ source: "weather" });
  expect(p!.changes.some((x) => x.date === target)).toBe(true);
  // Declined: still nothing more this week.
  await plans.decline();
  expect(await proposeAhead(deps)).toBeNull();
  expect(await plans.proposal()).toBeNull();
  // Without a dislike or a habit: nothing at all.
  expect(aheadChange({ today: t, days: (await plans.view()).weeks.flatMap((w) => w.days), hours, timeFor: () => "07:00", choice: "swim", avoid: [], coldBelow: 0, tendencies: [] })).toBeNull();
});

test("the coach: changes a run when they pick, knows the settings and habits, saves a dislike", async () => {
  const t = today();
  const { call, todays } = await setup([{ date: t, kind: "long", title: "Long run", duration_min: 90 }]);
  expect((await call("get_goals")).bad_weather).toBe("run");
  expect(await call("set_training_times", { bad_weather: "ride", avoid: ["ice"] })).toMatchObject({ bad_weather: "ride", avoid: ["ice"], cold_below: 0 });
  expect((await call("get_training_times")).avoid).toEqual(["ice"]);
  const h = await call("get_habits");
  expect(h).toMatchObject({ avoid: ["ice"], bad_weather: "ride", today: { kind: "long", stance: { lead: "run" } } });
  expect(h.today.choices[0]).toEqual({ to: "short", minutes: 25 });
  expect(h.today.nudge).toContain("long run");
  const r = await call("swap_plan_session", { date: t, kind: "long", to: "swim" });
  expect(r.session).toMatchObject({ kind: "swim", title: "Easy swim", duration_min: 60 });
  expect((await todays())[0]!.notes).toBe("Swapped from Long run: not feeling it.");
  expect((await call("swap_plan_session", { date: t, kind: "long", undo: true })).session).toMatchObject({ kind: "long" });
  expect((await call("swap_plan_session", { date: t, kind: "long", to: "short" })).session).toMatchObject({ title: "Short easy run", duration_min: 25 });
  expect((await call("swap_plan_session", { date: t, kind: "tempo", to: "swim" })).error).toMatch(/no such session/);
});
