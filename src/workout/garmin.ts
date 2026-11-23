/**
 * The plan for Tartan's Garmin watch app (garmin/, docs/garmin.md): today's session and the next
 * days', each the same workout a Suunto, intervals.icu or a .fit file gets (src/workout/from-plan.ts
 * plannedWeek), written out step by step the way the watch runs it. The phone sends it through
 * Garmin Connect (Android: GarminLink.kt; iPhone: GarminLink.swift) and the watch keeps it, so a run
 * works with the phone left at home.
 *
 * Small on purpose (a Connect IQ message is a few kilobytes at most, and the watch has little
 * memory): short keys, repeats written out, plain ASCII words. garmin/source/Plan.mc reads it.
 *
 *   { v: 1, made: "2026-11-23",
 *     days: [{ date, title, sport, sum, steps: [{ k, l, t | d, p | h | w, n }] }] }
 *
 * A step: k its kind, l its label ("Rep 2 of 6"), t seconds or d metres, a target (p pace in
 * seconds per km fast to slow, h heart rate in bpm, w watts) or none (easy), n a reminder shown as
 * it starts ("Fuel: Gel and a drink").
 */
import { isRepeat, plain, type StepKind, type Workout, type WorkoutStep } from "./guide.ts";
import { sportOf, type WatchSport } from "./export.ts";
import { withoutWeekday, type PlannedWorkout } from "./from-plan.ts";

export interface GarminStep {
  k: StepKind;
  l: string;
  t?: number;
  d?: number;
  p?: [number, number];
  h?: [number, number];
  w?: [number, number];
  n?: string;
}
export interface GarminDay {
  date: string;
  title: string;
  sport: WatchSport;
  /** A line for the watch's home screen: "6 x 800 m", "50 min", "12 km". */
  sum: string;
  steps: GarminStep[];
}
export interface GarminMessage {
  v: 1;
  made: string;
  days: GarminDay[];
}

const KIND_LABEL: Record<StepKind, string> = { warmup: "Warm up", run: "Run", recover: "Recover", cooldown: "Cool down" };
const short = (t: string, n: number) => plain(t).slice(0, n).trim();

/** 800 → "800 m", 5000 → "5 km", 1500 → "1.5 km"; 600 s → "10 min", 90 → "1:30". */
function lengthOf(s: Pick<WorkoutStep, "duration_s" | "distance_m">): string {
  if (s.distance_m !== undefined) return s.distance_m < 1000 ? `${s.distance_m} m` : `${Number((s.distance_m / 1000).toFixed(2))} km`;
  const t = s.duration_s ?? 0;
  return t % 60 === 0 ? `${t / 60} min` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** One step for the watch: its length, its one target (a speed range as the pace range it is). */
function stepOf(s: WorkoutStep, label: string, note?: { title: string; text: string }): GarminStep {
  const out: GarminStep = { k: s.kind, l: short(label, 20) || KIND_LABEL[s.kind] };
  if (s.duration_s !== undefined) out.t = Math.round(s.duration_s);
  else if (s.distance_m !== undefined) out.d = Math.round(s.distance_m);
  if (s.pace) out.p = [Math.round(s.pace[0]), Math.round(s.pace[1])];
  else if (s.speed) out.p = [Math.round(3600 / s.speed[1]), Math.round(3600 / s.speed[0])];
  else if (s.hr) out.h = [Math.round(s.hr[0]), Math.round(s.hr[1])];
  else if (s.power) out.w = [Math.round(s.power[0]), Math.round(s.power[1])];
  if (note) out.n = short(`${note.title}: ${note.text}`, 40);
  return out;
}

/** The workout one step after another, repeats written out, as guided.ts flatten labels them. */
export function garminSteps(w: Workout): GarminStep[] {
  const out: GarminStep[] = [];
  for (const b of w.blocks) {
    if (isRepeat(b)) {
      for (let i = 1; i <= b.repeat; i++)
        b.steps.forEach((s, j) => {
          const label = s.kind === "run" ? (s.title && s.title !== "Run" ? `${s.title} ${i}/${b.repeat}` : `Rep ${i} of ${b.repeat}`) : (s.title ?? KIND_LABEL[s.kind]);
          // The repeat's own screen (a strength exercise: "Squat: 3 x 10 at 40 kg") with its first step.
          out.push(stepOf(s, label, i === 1 && j === 0 ? (b.note ?? s.note) : s.note));
        });
    } else out.push(stepOf(b, b.title && b.kind === "run" ? b.title : KIND_LABEL[b.kind], b.note));
  }
  return out;
}

/** The home screen's line: the main set ("6 x 800 m"), else how long or how far in all. */
export function garminSummary(w: Workout): string {
  const set = w.blocks.find(isRepeat);
  if (set) {
    const work = set.steps.find((s) => s.kind === "run") ?? set.steps[0]!;
    return `${set.repeat} x ${lengthOf(work)}`;
  }
  const steps = w.blocks as WorkoutStep[];
  const time = steps.every((s) => s.duration_s !== undefined) ? steps.reduce((n, s) => n + s.duration_s!, 0) : null;
  const dist = steps.every((s) => s.distance_m !== undefined) ? steps.reduce((n, s) => n + s.distance_m!, 0) : null;
  if (time !== null) return time >= 3600 && time % 60 === 0 ? `${Math.floor(time / 3600)} h ${time % 3600 ? `${(time % 3600) / 60} min` : ""}`.trim() : lengthOf({ duration_s: time });
  if (dist !== null) return lengthOf({ distance_m: dist });
  return `${steps.length} steps`;
}

/** The days the watch gets: today's session and the next ones, in date order (plannedWeek's). */
export function garminMessage(planned: PlannedWorkout[], today: string): GarminMessage {
  const days = planned
    .filter((p) => p.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((p): GarminDay => ({ date: p.date, title: short(withoutWeekday(p.title), 24) || "Session", sport: sportOf(p.kind), sum: garminSummary(p.workout), steps: garminSteps(p.workout) }));
  return { v: 1, made: today, days };
}

/** A short fingerprint of a message, to send it again only when it changed. */
export function garminKey(m: GarminMessage): string {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(m.days)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `${m.made}-${h.toString(36)}`;
}
