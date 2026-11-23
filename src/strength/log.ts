/**
 * Strength sessions as you lifted them: each exercise's sets (weight, reps or seconds, ticked
 * when done) and how many more reps you had in you at the end. One log per day
 * (strength/log.json), written as you go, so a closed app loses nothing.
 *
 * From the logs:
 * - Next time, per exercise, by a named rule with its reason in a sentence: add weight (every
 *   set done with reps to spare), more reps or a longer hold (bodyweight), hold (missed reps,
 *   nothing left, or legs still worked hard from running), ease off (missed two sessions
 *   running). Weights round to what a gym has.
 * - Records: the heaviest set, the best estimated one-rep max, the most reps, the longest hold.
 */
import type { Disk } from "../disk.ts";
import { readJson } from "../disk.ts";
import { exercise, MUSCLE_NAME, routineOf, type Dose, type Exercise, type Muscle, type PlannedExercise } from "./exercises.ts";

const FILE = "strength/log.json";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SetLog {
  reps?: number;
  seconds?: number;
  kg?: number;
  done: boolean;
}
export interface ExerciseLog {
  id: string;
  /** What was asked for: the plan's dose with the weight from progression. */
  target: { sets: number; reps?: number; seconds?: number; kg?: number; each_side?: boolean };
  sets: SetLog[];
  /** Reps left in reserve after the last set: 0, 1, 2, or 3 for three or more. */
  rir?: 0 | 1 | 2 | 3;
}
export interface LiftLog {
  date: string;
  title: string;
  started: string;
  finished?: string;
  exercises: ExerciseLog[];
}

export type Rule = "start" | "add" | "more reps" | "longer" | "hold" | "ease";
export interface Target {
  id: string;
  name: string;
  sets: number;
  reps?: number;
  seconds?: number;
  kg?: number;
  each_side?: boolean;
  /** Weighted: the logger asks for kilos. */
  loaded: boolean;
  rule: Rule;
  why: string;
  last?: { date: string; text: string };
  rest_s: number;
}

export interface Best {
  id: string;
  kind: "heaviest" | "e1rm" | "reps" | "hold";
  value: number;
  /** For the heaviest set: its reps, which break a tie. */
  reps?: number;
  date: string;
  text: string;
}
export interface Pr extends Best {
  name: string;
  /** What it beat. */
  before: string;
}

/** Barbell, dumbbell or kettlebell work takes a weight; the rest is bodyweight unless you add one. */
export const isLoaded = (ex: Exercise) => /barbell|dumbbell|kettlebell/i.test(ex.equipment ?? "");
/** The smallest jump a gym allows: 2.5 kg on a bar, 2 kg between dumbbells or bells. */
const stepOf = (ex: Exercise) => (/barbell/i.test(ex.equipment ?? "") ? 2.5 : 2);
const roundTo = (kg: number, step: number) => Math.max(step, Math.round(kg / step) * step);
/** Rest between sets: longer for heavy and explosive work, short for core and mobility. */
export function restSeconds(ex: Exercise): number {
  if (ex.kind === "power") return 120;
  if (ex.kind === "core" || ex.kind === "mobility") return 45;
  return isLoaded(ex) && /barbell/i.test(ex.equipment ?? "") ? 120 : 90;
}

const kgText = (kg: number) => `${Number.isInteger(kg) ? kg : kg.toFixed(1)} kg`;
/** "3 × 10 at 40 kg", "3 × 40 s", "2 × 8 each side". */
export function setsText(x: { sets: number; reps?: number; seconds?: number; kg?: number; each_side?: boolean }): string {
  return `${x.sets} × ${x.reps ?? `${x.seconds ?? 0} s`}${x.each_side ? " each side" : ""}${x.kg ? ` at ${kgText(x.kg)}` : ""}`;
}
/** What was done, in the target's words: "3 × 10 at 40 kg", or "10, 10, 8 at 40 kg" when sets differ. */
function doneText(e: ExerciseLog): string {
  const done = e.sets.filter((s) => s.done);
  if (!done.length) return "nothing done";
  const counts = done.map((s) => s.reps ?? s.seconds ?? 0);
  const kgs = [...new Set(done.map((s) => s.kg ?? 0))];
  const unit = done[0]!.reps === undefined ? " s" : "";
  const same = counts.every((c) => c === counts[0]);
  const reps = same ? `${done.length} × ${counts[0]}${unit}` : `${counts.join(", ")}${unit}`;
  return kgs.length === 1 ? `${reps}${kgs[0] ? ` at ${kgText(kgs[0])}` : ""}` : done.map((s) => `${s.reps ?? s.seconds}${s.kg ? `@${s.kg}` : ""}`).join(", ") + " kg";
}

/** Every planned set done to its reps (or seconds). */
function hit(e: ExerciseLog): boolean {
  const done = e.sets.filter((s) => s.done);
  if (done.length < e.target.sets) return false;
  return done.every((s) => (e.target.reps ? (s.reps ?? 0) >= e.target.reps : (s.seconds ?? 0) >= (e.target.seconds ?? 0)));
}

/** The most recent logs of one exercise with any set done, newest first. */
function historyOf(id: string, logs: LiftLog[], before?: string): Array<{ date: string; e: ExerciseLog }> {
  return logs
    .filter((l) => !before || l.date < before)
    .sort((a, b) => b.date.localeCompare(a.date))
    .flatMap((l) => l.exercises.filter((e) => e.id === id && e.sets.some((s) => s.done)).map((e) => ({ date: l.date, e })));
}

export interface Context {
  /** Muscles worked hard now (from src/fatigue.ts), with what did it: "Saturday's long run". */
  fatigued?: Partial<Record<Muscle, string>>;
  /** Today's verdict from the morning check. */
  readiness?: "ready" | "go easy" | "rest";
}

/** Next time for one exercise: the dose to do, the weight, and the rule with its reason. */
export function nextFor(planned: PlannedExercise, logs: LiftLog[], ctx: Context = {}, date?: string): Target | null {
  const ex = exercise(planned.id);
  if (!ex) return null;
  const dose: Dose = routineOf([planned])[0]!.dose;
  const hist = historyOf(ex.id, logs, date);
  const last = hist[0];
  const loaded = isLoaded(ex) || hist.some((h) => h.e.sets.some((s) => s.kg));
  const base = { id: ex.id, name: ex.name, sets: dose.sets, each_side: dose.each_side, loaded, rest_s: restSeconds(ex) };
  if (!last) {
    return {
      ...base,
      reps: dose.reps,
      seconds: dose.seconds,
      rule: "start",
      why: loaded ? "Pick a weight you could lift two or three more times." : dose.seconds ? "Hold it with good form, not to failure." : "Smooth reps, stopping two short of failing.",
    };
  }
  const lastDone = last.e.sets.filter((s) => s.done);
  const lastKg = Math.max(0, ...lastDone.map((s) => s.kg ?? 0)) || undefined;
  const lastReps = last.e.target.reps ?? dose.reps;
  const lastSecs = last.e.target.seconds ?? dose.seconds;
  const lastInfo = { date: last.date, text: doneText(last.e) };
  const same = { ...base, reps: dose.reps ? Math.max(dose.reps, lastReps ?? 0) : undefined, seconds: dose.seconds ? Math.max(dose.seconds, lastSecs ?? 0) : undefined, kg: lastKg, last: lastInfo };

  let rule: Rule;
  let why: string;
  let out: Target;
  if (!hit(last.e)) {
    const before = hist[1];
    if (before && !hit(before.e)) {
      rule = "ease";
      const kg = lastKg ? roundTo(lastKg * 0.9, stepOf(ex)) : undefined;
      const reps = !kg && same.reps ? Math.max(1, same.reps - 2) : same.reps;
      why = kg ? `Short of the reps two sessions running: ${kgText(kg)} to build back up.` : same.reps ? `Short of the reps two sessions running: ${reps} a set to build back up.` : "Short two sessions running: the same again, with a rest that's a little longer.";
      out = { ...same, kg, reps, rule, why };
    } else {
      rule = "hold";
      const short = lastDone.length < last.e.target.sets ? `${last.e.target.sets - lastDone.length} set${last.e.target.sets - lastDone.length > 1 ? "s" : ""} short` : "a few reps short";
      why = `Last time ${short}: the same again, and finish every set.`;
      out = { ...same, rule, why };
    }
  } else if (last.e.rir === 0) {
    out = { ...same, rule: "hold", why: "Every rep last time, but nothing left: the same until it moves easier." };
  } else if (lastKg) {
    const kg = lastKg + stepOf(ex);
    out = { ...same, kg, rule: "add", why: `All ${last.e.target.sets} sets last time${last.e.rir ? " with reps to spare" : ""}: ${kgText(kg)}.` };
  } else if (dose.seconds) {
    const s = (lastSecs ?? dose.seconds) + 5;
    out = { ...same, seconds: s, rule: "longer", why: `Held every set last time: ${s} s.` };
  } else {
    const r = (lastReps ?? dose.reps ?? 8) + 1;
    out = {
      ...same,
      reps: r,
      rule: "more reps",
      why: r >= (dose.reps ?? 8) + 5 && /squat|lunge|bridge|calf|step|split|deadlift/.test(ex.id) ? `${r} a set now: ready for a weight in your hands next.` : `All sets last time: ${r} a set.`,
    };
  }

  // Running comes first: no new load on muscles still worked hard, nor on a go-easy day.
  if (out.rule === "add" || out.rule === "more reps" || out.rule === "longer") {
    const tired = ex.primary.find((m) => ctx.fatigued?.[m]);
    if (tired) return { ...same, rule: "hold", why: `Your ${MUSCLE_NAME[tired].toLowerCase()} are still worked hard (${ctx.fatigued![tired]}): the same as last time today.` };
    if (ctx.readiness === "rest" || ctx.readiness === "go easy") return { ...same, rule: "hold", why: "A go-easy day: the same as last time, no new load." };
  }
  return out;
}

/** A session's targets: its exercises (or the basic routine) with each one's next step. */
export function targetsFor(exercises: PlannedExercise[] | undefined, minutes: number | undefined, logs: LiftLog[], ctx: Context = {}, date?: string): Target[] {
  const list = exercises?.length ? exercises : routineOf(undefined, minutes).map(({ ex, dose }) => ({ id: ex.id, ...dose }));
  return list.map((p) => nextFor(p, logs, ctx, date)).filter((t): t is Target => !!t);
}

/** An exercise's records in one log entry. */
function recordsOf(e: ExerciseLog, date: string): Best[] {
  const done = e.sets.filter((s) => s.done);
  const out: Best[] = [];
  const heavy = done.filter((s) => s.kg && s.reps).sort((a, b) => b.kg! - a.kg! || b.reps! - a.reps!)[0];
  if (heavy) out.push({ id: e.id, kind: "heaviest", value: heavy.kg!, reps: heavy.reps, date, text: `${kgText(heavy.kg!)} × ${heavy.reps}` });
  // Epley's estimate, trusted up to 12 reps.
  const e1 = Math.max(0, ...done.filter((s) => s.kg && s.reps && s.reps <= 12).map((s) => s.kg! * (1 + s.reps! / 30)));
  if (e1) out.push({ id: e.id, kind: "e1rm", value: Math.round(e1 * 2) / 2, date, text: `${kgText(Math.round(e1 * 2) / 2)} estimated max` });
  const reps = Math.max(0, ...done.filter((s) => !s.kg && s.reps).map((s) => s.reps!));
  if (reps) out.push({ id: e.id, kind: "reps", value: reps, date, text: `${reps} reps` });
  const hold = Math.max(0, ...done.filter((s) => s.seconds).map((s) => s.seconds!));
  if (hold) out.push({ id: e.id, kind: "hold", value: hold, date, text: `${hold} s` });
  return out;
}

/** Each exercise's best of each kind, over all logs (or those before a date). */
export function records(logs: LiftLog[], before?: string): Best[] {
  const best = new Map<string, Best>();
  for (const l of logs) {
    if (before && l.date >= before) continue;
    for (const e of l.exercises)
      for (const r of recordsOf(e, l.date)) {
        const k = `${r.id}:${r.kind}`;
        const b = best.get(k);
        if (!b || r.value > b.value || (r.value === b.value && (r.reps ?? 0) > (b.reps ?? 0))) best.set(k, r);
      }
  }
  return [...best.values()];
}

/** What a log beat: records over earlier ones (a first time sets none). */
export function prsIn(log: LiftLog, logs: LiftLog[]): Pr[] {
  const before = new Map(records(logs, log.date).map((r) => [`${r.id}:${r.kind}`, r]));
  const out: Pr[] = [];
  for (const e of log.exercises) {
    const mine = recordsOf(e, log.date);
    // The estimate only counts when the heaviest set didn't already say it.
    for (const r of mine) {
      const b = before.get(`${r.id}:${r.kind}`);
      if (!b || r.value <= b.value) continue;
      if (r.kind === "e1rm" && out.some((p) => p.id === r.id && p.kind === "heaviest")) continue;
      out.push({ ...r, name: exercise(r.id)?.name ?? r.id, before: b.text });
    }
  }
  return out;
}

export interface Summary {
  minutes: number;
  sets: number;
  volume_kg: number;
  prs: Pr[];
  next: Array<{ id: string; name: string; last: string; next: string; rule: Rule; why: string }>;
}

/** A finished session: how much, what it beat, and next time for each exercise. */
export function summarize(log: LiftLog, logs: LiftLog[]): Summary {
  const others = logs.filter((l) => l.date !== log.date);
  const all = [...others, log];
  const done = log.exercises.flatMap((e) => e.sets.filter((s) => s.done));
  const end = log.finished ? Date.parse(log.finished) : Date.now();
  return {
    minutes: Math.max(1, Math.round((end - Date.parse(log.started)) / 60_000)),
    sets: done.length,
    volume_kg: Math.round(done.reduce((n, s) => n + (s.kg ?? 0) * (s.reps ?? 0), 0)),
    prs: prsIn(log, others),
    next: log.exercises
      .filter((e) => e.sets.some((s) => s.done))
      .flatMap((e) => {
        const t = nextFor({ id: e.id, sets: e.target.sets, reps: e.target.reps, seconds: e.target.seconds, each_side: e.target.each_side }, all);
        return t ? [{ id: e.id, name: t.name, last: doneText(e), next: setsText(t), rule: t.rule, why: t.why }] : [];
      }),
  };
}

/** Next time per exercise ever logged (no fatigue or readiness: those are for the day itself). For the watch. */
export function nextWeights(logs: LiftLog[]): Record<string, { kg?: number; reps?: number; seconds?: number }> {
  const ids = [...new Set(logs.flatMap((l) => l.exercises.map((e) => e.id)))];
  const out: Record<string, { kg?: number; reps?: number; seconds?: number }> = {};
  for (const id of ids) {
    const last = historyOf(id, logs)[0];
    if (!last) continue;
    const t = nextFor({ id, sets: last.e.target.sets, reps: last.e.target.reps, seconds: last.e.target.seconds, each_side: last.e.target.each_side }, logs);
    if (t) out[id] = { ...(t.kg ? { kg: t.kg } : {}), ...(t.reps ? { reps: t.reps } : {}), ...(t.seconds ? { seconds: t.seconds } : {}) };
  }
  return out;
}

const num = (x: unknown, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : undefined);

/** A log from the app, checked and trimmed to what it may hold. */
export function cleanLog(x: unknown): LiftLog {
  const l = x as Partial<LiftLog>;
  if (!l || typeof l !== "object" || !DATE.test(l.date ?? "")) throw new Error("lift log: date YYYY-MM-DD");
  if (!Array.isArray(l.exercises) || l.exercises.length > 20) throw new Error("lift log: 1 to 20 exercises");
  const started = typeof l.started === "string" && !Number.isNaN(Date.parse(l.started)) ? l.started : new Date().toISOString();
  return {
    date: l.date!,
    title: String(l.title ?? "Strength").slice(0, 80),
    started,
    ...(typeof l.finished === "string" && !Number.isNaN(Date.parse(l.finished)) ? { finished: l.finished } : {}),
    exercises: l.exercises.flatMap((e): ExerciseLog[] => {
      if (!e || !exercise(e.id) || !Array.isArray(e.sets)) return [];
      const t = e.target ?? ({} as ExerciseLog["target"]);
      const rir = e.rir;
      return [
        {
          id: e.id,
          target: { sets: num(t.sets, 1, 10) ?? e.sets.length, ...(num(t.reps, 1, 100) ? { reps: t.reps } : {}), ...(num(t.seconds, 1, 600) ? { seconds: t.seconds } : {}), ...(num(t.kg, 0.5, 500) ? { kg: t.kg } : {}), ...(t.each_side ? { each_side: true } : {}) },
          sets: e.sets.slice(0, 10).map((s) => ({ done: !!s?.done, ...(num(s?.reps, 0, 100) !== undefined ? { reps: s.reps } : {}), ...(num(s?.seconds, 0, 600) !== undefined ? { seconds: s.seconds } : {}), ...(num(s?.kg, 0.5, 500) ? { kg: s.kg } : {}) })),
          ...(rir === 0 || rir === 1 || rir === 2 || rir === 3 ? { rir } : {}),
        },
      ];
    }),
  };
}

export class Lifts {
  constructor(private readonly disk: Disk) {}

  async all(): Promise<LiftLog[]> {
    const m = (await readJson<Record<string, LiftLog>>(this.disk, FILE)) ?? {};
    return Object.values(m).sort((a, b) => a.date.localeCompare(b.date));
  }

  async get(date: string): Promise<LiftLog | null> {
    return ((await readJson<Record<string, LiftLog>>(this.disk, FILE)) ?? {})[date] ?? null;
  }

  async save(x: unknown): Promise<LiftLog> {
    const log = cleanLog(x);
    const m = (await readJson<Record<string, LiftLog>>(this.disk, FILE)) ?? {};
    m[log.date] = log;
    // Two years of sessions.
    const keep = Object.keys(m).sort().slice(-730);
    await this.disk.write(FILE, JSON.stringify(Object.fromEntries(keep.map((k) => [k, m[k]!]))));
    return log;
  }

  async remove(date: string): Promise<boolean> {
    const m = (await readJson<Record<string, LiftLog>>(this.disk, FILE)) ?? {};
    if (!m[date]) return false;
    delete m[date];
    await this.disk.write(FILE, JSON.stringify(m));
    return true;
  }
}
