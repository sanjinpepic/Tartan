/**
 * How each muscle is, from running and lifting together: what the last weeks put on it, fading as
 * it recovers, against what it is used to. For the You page's body map and the coach.
 *
 * - A run loads the legs by its length and how hard it was (the plan's kind for it when it was a
 *   planned session, else its heart rate): calves most, then quads, hamstrings, glutes and hip
 *   flexors; climbing adds calves and glutes, the descent that comes with it quads; speed adds
 *   hamstrings and calves. A ride loads quads and glutes, a walk a little of the legs.
 * - A strength session loads what its exercises work, by hard sets: a primary mover counts the set,
 *   a helper 0.4 of it; a muscle's sets in one session are capped at 12 (more adds little).
 *   Eight hard sets on a muscle, or about an hour's easy running for the calves, is one unit.
 * - Each muscle recovers at its own pace (a half-life: big leg muscles 48 h, calves 42 h, the
 *   upper body 30 h, the trunk and forearms 24 h).
 * - What a muscle is used to scales it: the same load reads lighter on calves that run every day
 *   than on a muscle that rarely works (its average over the last four weeks). Your usual week
 *   leaves a muscle recovering; more than usual, or a muscle that rarely works, reads worked hard.
 * - A strength session you logged counts what you did: the sets you ticked, lighter when you had
 *   three or more reps left (two: 0.85 of a hard set, three or more: 0.6).
 * - Soreness from the morning check-in is shown on its muscles, apart from the training.
 */
import type { Muscle } from "./strength/exercises.ts";
import { EXERCISES, MUSCLES, routineOf, type PlannedExercise } from "./strength/exercises.ts";
import { sportFamily } from "./merge.ts";
import type { PainArea } from "./readiness.ts";
import type { LiftLog } from "./strength/log.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const HALF_LIFE_H: Record<Muscle, number> = {
  quads: 48, hamstrings: 48, glutes: 48, glute_med: 40, adductors: 40, hip_flexors: 36, calves: 42, tibialis: 36,
  lower_back: 40, chest: 40, lats: 36, upper_back: 36, traps: 30, delts: 30, biceps: 30, triceps: 30, forearms: 24, abs: 24, obliques: 24,
};

/** An hour's running at an easy-steady effort, per muscle (units). */
const RUN_HOUR: Partial<Record<Muscle, number>> = {
  calves: 0.9, quads: 0.6, hamstrings: 0.55, glutes: 0.5, hip_flexors: 0.5, glute_med: 0.45, tibialis: 0.4, adductors: 0.25, obliques: 0.12, abs: 0.1, lower_back: 0.12,
};
const RIDE_HOUR: Partial<Record<Muscle, number>> = { quads: 0.6, glutes: 0.4, hamstrings: 0.2, calves: 0.15, hip_flexors: 0.2 };
const WALK_HOUR: Partial<Record<Muscle, number>> = { calves: 0.2, quads: 0.15, glutes: 0.15, hamstrings: 0.1, tibialis: 0.1 };

/** How hard a planned session's kind is, relative to an easy run. */
const KIND_EFFORT: Record<string, number> = { recovery: 0.6, easy: 0.75, long: 0.9, tempo: 1.1, intervals: 1.3, hills: 1.3, race: 1.5 };

/** Where a niggle is felt, on the map. */
export const PAIN_MUSCLES: Record<PainArea, Muscle[]> = {
  foot: ["calves"], ankle: ["tibialis", "calves"], achilles: ["calves"], calf: ["calves"], shin: ["tibialis"], knee: ["quads"],
  hamstring: ["hamstrings"], quad: ["quads"], hip: ["hip_flexors", "glute_med"], back: ["lower_back"], other: [],
};

export interface Workout {
  /** ISO time it started. */
  start: string;
  sport: string;
  title: string;
  minutes: number;
  elevation_m?: number;
  avg_hr?: number;
  /** The plan's kind when it was a planned session (easy, intervals, strength…). */
  kind?: string;
  /** A strength session's exercises (from the plan); none: a runner's basic routine. */
  exercises?: PlannedExercise[];
}

export interface Cause {
  date: string;
  what: string;
  kind: "run" | "strength" | "other";
  /** Its share of what the muscle carries now, 0-1. */
  share: number;
}

export interface MuscleState {
  /** 0-4 on the heat scale. */
  level: 0 | 1 | 2 | 3 | 4;
  state: "fresh" | "recovering" | "fatigued";
  /** Hours until fresh again, when it isn't. */
  fresh_in_h: number | null;
  /** The load now relative to what the muscle is used to (fresh below 0.45, fatigued from 0.85). */
  score: number;
  /** Last day it got a real load (YYYY-MM-DD). */
  last_worked: string | null;
  causes: Cause[];
  sore?: { area: PainArea; level: 1 | 2 | 3; date: string };
}

export interface BodyState {
  at: string;
  muscles: Record<Muscle, MuscleState>;
}

/** What one workout puts on each muscle (units). */
export function stimulus(w: Workout, prof: { max_hr: number; rest_hr: number }): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  const add = (m: Muscle, v: number) => (out[m] = (out[m] ?? 0) + v);
  const fam = sportFamily(w.sport);
  const strength = w.kind === "strength" || /weight|strength|gym|crossfit|workout|training/i.test(w.sport);
  if (strength && fam !== "run") {
    const sets = new Map<Muscle, number>();
    for (const { ex, dose } of routineOf(w.exercises, w.minutes || 30)) {
      // Bodyweight sets mostly stop short of failure: three quarters of a hard set.
      const hard = dose.sets * (ex.equipment ? 1 : 0.75);
      for (const m of ex.primary) sets.set(m, (sets.get(m) ?? 0) + hard);
      for (const m of ex.secondary) sets.set(m, (sets.get(m) ?? 0) + 0.4 * hard);
    }
    for (const [m, n] of sets) add(m, Math.min(12, n) / 8);
    return out;
  }
  const hours = w.minutes / 60;
  if (hours <= 0) return out;
  if (fam === "run") {
    const hrr = w.avg_hr ? (w.avg_hr - prof.rest_hr) / Math.max(1, prof.max_hr - prof.rest_hr) : null;
    const effort: number = (w.kind ? KIND_EFFORT[w.kind] : undefined) ?? (hrr === null ? 0.8 : hrr < 0.6 ? 0.65 : hrr < 0.72 ? 0.8 : hrr < 0.82 ? 1.05 : 1.3);
    // Long runs tire more than their minutes (the last hour costs more than the first).
    const time = Math.pow(hours, 1.15);
    for (const [m, v] of Object.entries(RUN_HOUR) as Array<[Muscle, number]>) add(m, v * time * effort);
    if (effort >= 1.2) {
      add("hamstrings", 0.25 * time);
      add("calves", 0.15 * time);
    }
    const climb = (w.elevation_m ?? 0) / 100;
    if (climb > 0) {
      add("calves", 0.06 * climb);
      add("glutes", 0.05 * climb);
      add("quads", 0.08 * climb); // the way down
    }
    return out;
  }
  const table = fam === "ride" ? RIDE_HOUR : fam === "walk" ? WALK_HOUR : null;
  if (table) for (const [m, v] of Object.entries(table) as Array<[Muscle, number]>) add(m, v * hours * (fam === "walk" ? 1 + (w.elevation_m ?? 0) / 600 : 1));
  return out;
}

/**
 * What one workout worked, muscle by muscle: each one's share of the workout's heaviest load,
 * on the same 0-4 heat scale as the body (the workout sheet's small map). Most worked first.
 */
export function workoutMuscles(w: Workout, prof: { max_hr: number; rest_hr: number }): Array<{ muscle: Muscle; level: 0 | 1 | 2 | 3 | 4; share: number }> {
  const load = stimulus(w, prof);
  const top = Math.max(0, ...Object.values(load).map((v) => v ?? 0));
  if (!top) return [];
  return (Object.entries(load) as Array<[Muscle, number]>)
    .map(([muscle, v]) => ({ muscle, share: v / top, level: Math.min(4, Math.max(1, Math.ceil((v / top) * 4))) as 1 | 2 | 3 | 4 }))
    .filter((x) => x.share >= 0.08)
    .sort((a, b) => b.share - a.share);
}

const decay = (m: Muscle, ageMs: number) => Math.pow(0.5, ageMs / HOUR / HALF_LIFE_H[m]);

/** Every muscle's state at `now` from the workouts of the last five weeks and recent niggles. */
export function bodyState(
  workouts: Workout[],
  niggles: Array<{ date: string; area: PainArea; level: 1 | 2 | 3 }>,
  prof: { max_hr: number; rest_hr: number },
  now = Date.now(),
): BodyState {
  const items = workouts
    .map((w) => ({ w, t: Date.parse(w.start), s: stimulus(w, prof) }))
    .filter((x) => Number.isFinite(x.t) && x.t <= now && x.t > now - 35 * DAY);
  const muscles = {} as Record<Muscle, MuscleState>;
  for (const m of MUSCLES) {
    const loadAt = (t: number) => items.reduce((n, x) => (x.t <= t ? n + (x.s[m] ?? 0) * decay(m, t - x.t) : n), 0);
    const now_ = loadAt(now);
    // Used to: the average load over the four weeks before, sampled daily.
    let base = 0;
    for (let d = 1; d <= 28; d++) base += loadAt(now - d * DAY);
    base /= 28;
    // A steady habit sits at about 0.6 (recovering); only more than usual reads as worked hard.
    const ref = 0.5 + 1.5 * base;
    const score = now_ / ref;
    const level = (score < 0.2 ? 0 : score < 0.45 ? 1 : score < 0.65 ? 2 : score < 0.85 ? 3 : 4) as MuscleState["level"];
    const state = score < 0.45 ? "fresh" : score < 0.85 ? "recovering" : "fatigued";
    const fresh_in_h = state === "fresh" ? null : Math.round(HALF_LIFE_H[m] * Math.log2(now_ / (0.45 * ref)));
    const worked = items.filter((x) => (x.s[m] ?? 0) >= 0.1).sort((a, b) => b.t - a.t)[0];
    const causes = items
      .map((x) => ({ x, c: (x.s[m] ?? 0) * decay(m, now - x.t) }))
      .filter((y) => now_ > 0 && y.c / now_ >= 0.08)
      .sort((a, b) => b.c - a.c)
      .slice(0, 4)
      .map(({ x, c }): Cause => ({ date: new Date(x.t).toISOString().slice(0, 10), what: x.w.title, kind: x.w.kind === "strength" || (!!x.w.exercises && sportFamily(x.w.sport) !== "run") ? "strength" : sportFamily(x.w.sport) === "run" ? "run" : "other", share: Math.round((c / now_) * 100) / 100 }));
    const pain = niggles.filter((n) => PAIN_MUSCLES[n.area].includes(m) && Date.parse(`${n.date}T12:00:00`) > now - 7 * DAY).sort((a, b) => b.date.localeCompare(a.date))[0];
    muscles[m] = {
      level,
      state,
      fresh_in_h: fresh_in_h !== null && fresh_in_h > 0 ? fresh_in_h : null,
      score: Math.round(score * 100) / 100,
      last_worked: worked ? new Date(worked.t).toISOString().slice(0, 10) : null,
      causes,
      ...(pain ? { sore: pain } : {}),
    };
  }
  return { at: new Date(now).toISOString(), muscles };
}

/** Exercises from the library that work a muscle: those it drives first, then those it helps. */
export function exercisesFor(m: Muscle): Array<{ id: string; name: string; primary: boolean }> {
  const main = EXERCISES.filter((e) => e.primary.includes(m)).map((e) => ({ id: e.id, name: e.name, primary: true }));
  const help = EXERCISES.filter((e) => e.secondary.includes(m) && !e.primary.includes(m)).map((e) => ({ id: e.id, name: e.name, primary: false }));
  return [...main, ...help];
}

/** The body as it is now, from the library's workouts (with the plan's kind and exercises for planned ones) and the check-ins. */
export async function loadBody(deps: {
  lib: { activities(f: { since?: string }): Promise<Array<{ id: string; start: string; sport: string; name?: string; moving_min?: number; elapsed_min?: number; elevation_m?: number; avg_hr?: number }>> };
  plans: { view(): Promise<{ weeks: Array<{ days: Array<{ date: string; sessions: Array<{ kind: string; title: string; status: string; duration_min?: number; exercises?: PlannedExercise[]; manual?: boolean; activity?: { id: string } }> }> }> }> };
  profile(): Promise<{ max_hr: number; rest_hr: number }>;
  checkins: { niggles(days?: number): Promise<Array<{ date: string; area: PainArea; level: 1 | 2 | 3 }>> };
  lifts?: { all(): Promise<LiftLog[]> };
  /** Leave out the log of this day (the session being planned). */
  without?: string;
}, now = Date.now()): Promise<BodyState> {
  const since = new Date(now - 36 * DAY).toISOString().slice(0, 10);
  const [rows, view, prof, niggles, logs] = await Promise.all([deps.lib.activities({ since }), deps.plans.view(), deps.profile(), deps.checkins.niggles(10), deps.lifts?.all() ?? []]);
  const lifted = new Map(logs.filter((l) => l.date >= since && l.date !== deps.without && l.exercises.some((e) => e.sets.some((x) => x.done))).map((l) => [l.date, l]));
  const planned = new Map<string, { kind: string; title: string; exercises?: PlannedExercise[] }>();
  const ticked: Workout[] = [];
  for (const w of view.weeks)
    for (const d of w.days)
      for (const s of d.sessions) {
        if (s.status !== "done" || s.kind === "rest") continue;
        if (s.activity) planned.set(s.activity.id, s);
        // Ticked off without a recording: the session as planned, late afternoon that day.
        else if (s.manual) ticked.push({ start: new Date(`${d.date}T17:00:00`).toISOString(), sport: s.kind === "strength" ? "strength" : s.kind === "cross" ? "workout" : "run", title: s.title, minutes: s.duration_min ?? 30, kind: s.kind, exercises: s.exercises });
      }
  const workouts: Workout[] = rows.map((r) => {
    const s = planned.get(r.id);
    return { start: r.start, sport: r.sport, title: s?.title ?? r.name ?? r.sport, minutes: r.moving_min ?? r.elapsed_min ?? 0, elevation_m: r.elevation_m, avg_hr: r.avg_hr, kind: s?.kind, exercises: s?.exercises };
  });
  // Logged sessions: their sets, on the day's strength workout (the watch's or Strava's), else at their own time.
  const day = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const all = [...workouts, ...ticked];
  for (const [date, l] of lifted) {
    const exercises = loggedSets(l);
    const w = all.find((x) => day(x.start) === date && sportFamily(x.sport) !== "run" && (x.kind === "strength" || /weight|strength|gym|crossfit|workout|training/i.test(x.sport)));
    if (w) Object.assign(w, { kind: "strength", exercises, title: w.title || l.title });
    else all.push({ start: l.started, sport: "strength", title: l.title, minutes: 45, kind: "strength", exercises });
  }
  return bodyState(all, niggles, prof, now);
}

/** A log as the hard sets it stands for: ticked sets, less when reps were left in the tank. */
export function loggedSets(l: LiftLog): PlannedExercise[] {
  return l.exercises.flatMap((e) => {
    const n = e.sets.filter((x) => x.done).length;
    const k = e.rir === undefined || e.rir <= 1 ? 1 : e.rir === 2 ? 0.85 : 0.6;
    return n ? [{ id: e.id, sets: n * k }] : [];
  });
}
