/**
 * Plan sessions as watch workouts, and keeping the watch's list to the coming week.
 *
 * Every kind of session goes (not rest): the watch runs a guide in whatever sport mode it's
 * started from. A session with steps (the coach writes them for structured sessions) goes as
 * those steps; one without as a single step of its duration (or distance), at the heart-rate
 * range in its target ("135-148 bpm") or the plan's zone for that kind of run when there is one.
 */
import type { WatchBlock } from "../plan.ts";
import { checkWorkout, TARTAN_WORKOUT_ID, type Workout, type WorkoutBlock, type WorkoutStep } from "./guide.ts";
import { routineOf, type PlannedExercise } from "../strength/exercises.ts";
import { restSeconds } from "../strength/log.ts";

export interface SessionLike {
  date: string;
  kind: string;
  title: string;
  duration_min?: number;
  distance_km?: number;
  target?: string;
  steps?: WatchBlock[];
  exercises?: PlannedExercise[];
}
export interface ZoneLike {
  name: string;
  heart_rate?: string;
  pace?: string;
}

const TITLE: Record<string, string> = { strength: "Strength", cross: "Workout", swim: "Swim", ride: "Ride" };
const ZONE_FOR: Record<string, RegExp> = {
  easy: /easy|aerobic|z2/i,
  long: /long|easy|aerobic/i,
  recovery: /recover|z1|easy/i,
  tempo: /tempo|threshold/i,
  intervals: /interval|vo2|z5/i,
  hills: /hill|interval|threshold/i,
  race: /race/i,
};
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pair = (r: number[] | undefined) => (r ? ([r[0]!, r[1]!] as [number, number]) : undefined);
const asStep = (x: WatchBlock["steps"][number]): WorkoutStep => {
  const out: WorkoutStep = { kind: x.kind };
  if (x.duration_s) out.duration_s = x.duration_s;
  if (x.distance_m) out.distance_m = x.distance_m;
  // One target: heart rate, else pace, speed or power.
  if (x.hr) out.hr = pair(x.hr);
  else if (x.pace) out.pace = pair(x.pace);
  else if (x.speed) out.speed = pair(x.speed);
  else if (x.power) out.power = pair(x.power);
  return out;
};

/** "4:50-5:00 /km" → [290, 300] seconds per km (fast, slow). */
export function paceRange(text: string | undefined): [number, number] | null {
  const m = text?.match(/(\d{1,2}):(\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}):(\d{2})\s*\/\s*km/i);
  if (!m) return null;
  const [a, b] = [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
  return a === b ? null : [Math.min(a, b), Math.max(a, b)];
}

/** "Z2, 135-148 bpm" → [135, 148]; only ranges said in bpm (or a zone's heart-rate text). */
export function hrRange(text: string | undefined, bpmSaid = false): [number, number] | null {
  const m = text?.match(/(\d{2,3})\s*(?:-|–|—|to)\s*(\d{2,3})\s*(bpm|b\/min)?/i);
  if (!m || (!m[3] && !bpmSaid)) return null;
  const [lo, hi] = [Number(m[1]), Number(m[2])];
  return lo >= 60 && hi <= 220 && lo < hi ? [lo, hi] : null;
}

/** Fuel and drink reminders on long steady sessions: every so many minutes, from this long. */
export interface FuelPlan {
  /** Each reminder on or off, and how often. */
  gel: boolean;
  drink: boolean;
  gelMin: number;
  drinkMin: number;
  fromMin: number;
}
export const DEFAULT_FUEL: FuelPlan = { gel: true, drink: true, gelMin: 30, drinkMin: 15, fromMin: 75 };

/** How long a session takes, in minutes: its duration, or its distance at its pace (or 6:00 /km). */
const minutesOf = (s: SessionLike, pace: [number, number] | null) =>
  s.duration_min ?? (s.distance_km ? (s.distance_km * (pace ? (pace[0] + pace[1]) / 2 : 360)) / 60 : 0);

/**
 * A steady session cut into reminder-sized pieces: a "Drink" screen every drinkMin minutes and
 * "Fuel" every gelMin (each when switched on); the last piece runs on until the session's end
 * (its time, or the lap button).
 */
export function withFuel(step: WorkoutStep, minutes: number, fuel: FuelPlan): WorkoutStep[] {
  const gel = fuel.gel !== false && fuel.gelMin >= 5;
  const drink = fuel.drink !== false && fuel.drinkMin >= 5;
  if (minutes < fuel.fromMin || (!gel && !drink)) return [step];
  const every = gel && drink ? Math.min(fuel.drinkMin, fuel.gelMin) : gel ? fuel.gelMin : fuel.drinkMin;
  const n = Math.floor(minutes / every);
  const { distance_m: _d, duration_s: _t, ...rest } = step;
  const out: WorkoutStep[] = [];
  for (let i = 0; i < n; i++) {
    const at = i * every;
    const last = i === n - 1;
    // Whole minutes; the last piece takes what's left, plus slack when the session is a distance.
    const length = last ? Math.round((minutes - at) * 60 + (step.distance_m ? 1800 : 0)) : every * 60;
    const note =
      at === 0 ? undefined
      : gel && at % fuel.gelMin === 0 ? { title: "Fuel", text: drink ? "Gel and a drink" : "Take a gel" }
      : drink && at % fuel.drinkMin === 0 ? { title: "Drink", text: "A few sips" }
      : undefined;
    out.push({ ...rest, duration_s: length, ...(note ? { note } : {}) });
  }
  return out;
}

/** "Sunday Long Run" → "Long Run" (the name gets its day in front once). */
export function withoutWeekday(title: string): string {
  const day = "(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\\.?";
  const t = title
    .replace(new RegExp(`^${day}(?:\\s*[:,·–—-])?\\s+`, "i"), "")
    .replace(new RegExp(`\\s*(?:[(,·–—-]\\s*)?${day}\\)?$`, "i"), "")
    .trim();
  return t || title;
}

/** Next time's weight, reps or seconds per exercise, from your logs (src/strength/log.ts nextWeights). */
export type LiftTargets = Record<string, { kg?: number; reps?: number; seconds?: number }>;

/** The watch workout for a session, or why there isn't one. */
export function workoutFor(s: SessionLike, zones: ZoneLike[] = [], fuel: FuelPlan | null = null, lifts: LiftTargets = {}): { workout: Workout } | { reason: string } {
  if (s.kind === "rest") return { reason: "a rest day" };
  const name = `${WEEKDAY[new Date(`${s.date}T12:00:00`).getDay()]} ${withoutWeekday(s.title)}`;
  let blocks: WorkoutBlock[];
  if (s.steps?.length) {
    blocks = s.steps.flatMap((b): WorkoutBlock[] =>
      (b.repeat ?? 1) >= 2
        ? [{ repeat: b.repeat!, steps: b.steps.map(asStep) }]
        : b.steps.map(asStep),
    );
  } else if (s.kind === "strength") {
    // A strength session: each exercise a screen (what, how many, the weight), then its sets,
    // each a work step that the lap button ends and a rest that counts down to the next.
    blocks = routineOf(s.exercises, s.duration_min).map(({ ex, dose }): WorkoutBlock => {
      const t = lifts[ex.id] ?? {};
      const reps = t.reps ?? dose.reps;
      const secs = t.seconds ?? dose.seconds;
      const name = ex.name.slice(0, 20);
      const text = `${dose.sets} x ${reps ?? `${secs} s`}${dose.each_side ? " each side" : ""}${t.kg ? ` at ${t.kg} kg` : ""}`;
      // Time enough for the set (3 s a rep, both sides), then it runs on until the lap button.
      const work: WorkoutStep = { kind: "run", title: name, duration_s: Math.min(600, Math.max(30, Math.round(((reps ? reps * 3 : (secs ?? 30)) * (dose.each_side ? 2 : 1)) + 30))) };
      const rest: WorkoutStep = { kind: "recover", title: "Rest", duration_s: restSeconds(ex) };
      return dose.sets >= 2 ? { repeat: Math.min(30, dose.sets), steps: [work, rest], note: { title: name, text } } : { ...work, note: { title: name, text } };
    });
  } else {
    // The target: a bpm range in the session's target, else a pace range there, else the
    // plan's zone for that kind of run (its heart rate, else its pace).
    const zone = ZONE_FOR[s.kind] ? zones.find((z) => ZONE_FOR[s.kind]!.test(z.name)) : undefined;
    const hr = hrRange(s.target);
    const pace = hr ? null : paceRange(s.target);
    const zoneHr = hr || pace ? null : hrRange(zone?.heart_rate, true);
    const zonePace = hr || pace || zoneHr ? null : paceRange(zone?.pace);
    const target = hr ? { hr } : pace ? { pace } : zoneHr ? { hr: zoneHr } : zonePace ? { pace: zonePace } : {};
    const len = s.duration_min ? { duration_s: Math.round(s.duration_min * 60) } : s.distance_km ? { distance_m: Math.round(s.distance_km * 1000) } : null;
    if (!len) return { reason: "it has no duration or distance" };
    const step: WorkoutStep = { kind: "run", ...len, ...target, title: TITLE[s.kind] ?? "Run" };
    // Long steady runs and rides get fuel and drink reminders.
    blocks = fuel && s.kind !== "strength" && s.kind !== "swim" ? withFuel(step, minutesOf(s, target.pace ?? null), fuel) : [step];
  }
  const workout = { name, blocks };
  try {
    checkWorkout(workout);
  } catch (e) {
    return { reason: (e as Error).message.replace(/^Workout: /, "") };
  }
  return { workout };
}

/** A short fingerprint of what a workout is (and when), to tell a changed session from the same. */
export function workoutKey(date: string, w: Workout): string {
  let h = 0x811c9dc5;
  for (const ch of `${date}|${JSON.stringify(w)}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}

export interface SentWorkout {
  date: string;
  key: string;
  name: string;
  /** Kept whatever the week holds (a race's pacing). */
  pinned?: boolean;
}
export interface WantedWorkout {
  date: string;
  key: string;
  workout: Workout;
}

/**
 * What to change on the watch: Tartan workouts whose day has passed or whose session changed
 * come off, and so do Tartan workouts this phone has no record of (left by a send that broke
 * off, or from before its record was lost), so none doubles up; sessions in the window not on
 * the watch go on. Pinned ones (a race's pacing) stay; the Suunto app's are never touched.
 */
export function reconcile(onWatch: string[], sent: Record<string, SentWorkout>, wanted: WantedWorkout[], today: string): { remove: string[]; install: WantedWorkout[] } {
  const keys = new Set(wanted.map((w) => w.key));
  const ours = onWatch.filter((id) => TARTAN_WORKOUT_ID.test(id));
  const remove = ours.filter((id) => {
    const s = sent[id];
    return !s || (!s.pinned && (s.date < today || !keys.has(s.key)));
  });
  const kept = new Set(ours.filter((id) => !remove.includes(id)).map((id) => sent[id]!.key));
  // Each wanted session once, even if the plan lists the same one twice.
  const seen = new Set<string>();
  const install = wanted.filter((w) => !kept.has(w.key) && !seen.has(w.key) && (seen.add(w.key), true));
  return { remove, install };
}

/** A session of the coming week as a workout, for any watch (src/workout/export.ts). */
export interface PlannedWorkout extends WantedWorkout {
  kind: string;
  title: string;
  notes?: string;
}
/** What plannedWeek reads of the plan's view (GET /api/plan). */
export interface WeekLike {
  today: string;
  plan?: { zones?: ZoneLike[] } | null;
  weeks: Array<{ days: Array<{ date: string; sessions: Array<SessionLike & { status?: string; notes?: string }> }> }>;
  lift_targets?: LiftTargets;
}

/**
 * The next `days` days' sessions that make a workout (today's included; not rest, not done), each
 * with its key: what Tartan sends to a Suunto, intervals.icu, Health Connect or a file.
 */
export function plannedWeek(v: WeekLike, fuel: FuelPlan | null = DEFAULT_FUEL, days = 7): PlannedWorkout[] {
  const end = new Date(Date.parse(`${v.today}T12:00:00Z`) + (days - 1) * 86400_000).toISOString().slice(0, 10);
  const out: PlannedWorkout[] = [];
  for (const w of v.weeks)
    for (const d of w.days) {
      if (d.date < v.today || d.date > end) continue;
      for (const s of d.sessions) {
        if (s.kind === "rest" || (s.status !== undefined && s.status !== "today" && s.status !== "planned")) continue;
        const r = workoutFor({ ...s, date: d.date }, v.plan?.zones ?? [], fuel, v.lift_targets);
        if (!("workout" in r)) continue;
        out.push({ date: d.date, kind: s.kind, title: s.title, ...(s.notes ? { notes: s.notes } : {}), key: workoutKey(d.date, r.workout), workout: r.workout });
      }
    }
  return out;
}
