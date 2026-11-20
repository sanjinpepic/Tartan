/**
 * A guided run on the phone: the plan's session (the same workout a watch gets,
 * src/workout/from-plan.ts) talked through while the phone records, for people with no sports
 * watch. Each step starts with what it is ("Rep 2 of 6. 800 metres at 3 50 to 4 00 a
 * kilometre. Go."), time steps count down ("10 seconds. Next: recover."), long ones say halfway,
 * and work steps are checked against their target now and then ("A little fast: ease off.").
 * The step changes on its own by time (moving time, so a pause holds it) or distance, or by
 * Next step. After the last one the run goes on as a plain run.
 *
 * Pure: the recorder (web/recorder.ts) feeds it progress and speaks what it returns. The state
 * is plain JSON so a run reopened after a restart carries on where it was.
 */
import { spokenTime } from "../cues.ts";
import { isRepeat, type Workout, type WorkoutStep } from "./guide.ts";

export interface GuidedStep extends WorkoutStep {
  /** "Warm up", "Rep 2 of 6", "Recover", "Cool down", or the step's own title. */
  label: string;
  /** Rep i of n, for the steps of a repeat. */
  rep?: [number, number];
}

/** Where a guided run is: the step, where it began (moving seconds, metres), and what's been said in it. */
export interface GuideState {
  at: number;
  from_s: number;
  from_m: number;
  done: boolean;
  /** Last target check in this step (moving seconds). */
  checked_s?: number;
  /** Cues already said in this step ("half", "10s", "100m", "first"). */
  said: string[];
}

export interface GuideProgress {
  /** Moving seconds since the run began (paused time left out). */
  active_s: number;
  distance_m: number;
  hr?: number;
  /** Pace over the last half minute or so, seconds per km. */
  pace_s?: number;
}

/** What the screen shows: the step, how much of it is left, what comes next. */
export interface GuideView {
  name: string;
  index: number;
  total: number;
  label: string;
  /** "800 m · 3:50–4:00 /km", "1:30 · easy". */
  detail: string;
  kind: WorkoutStep["kind"];
  left_s?: number;
  left_m?: number;
  /** 0..1 through the step. */
  share: number;
  next?: string;
  done: boolean;
}

const KIND_LABEL: Record<WorkoutStep["kind"], string> = { warmup: "Warm up", run: "Run", recover: "Recover", cooldown: "Cool down" };

/** The workout as one step after another, repeats written out. */
export function flatten(w: Workout): GuidedStep[] {
  const out: GuidedStep[] = [];
  for (const b of w.blocks) {
    if (isRepeat(b)) {
      for (let i = 1; i <= b.repeat; i++)
        b.steps.forEach((s) => out.push({ ...s, label: s.kind === "run" ? `Rep ${i} of ${b.repeat}` : (s.title ?? KIND_LABEL[s.kind]), ...(s.kind === "run" ? { rep: [i, b.repeat] as [number, number] } : {}) }));
    } else out.push({ ...b, label: b.title && b.kind === "run" ? b.title : KIND_LABEL[b.kind] });
  }
  return out;
}

/** Whether a workout has structure worth guiding step by step (kilometre cues stay quiet while it runs). */
export const isStructured = (w: Workout) => w.blocks.some(isRepeat) || new Set(flatten(w).map((s) => s.kind)).size > 1;

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
/** 230 → "3 50" (a voice reads "three fifty"). */
const spokenPace = (sec: number) => `${Math.floor(sec / 60)} ${String(Math.round(sec % 60)).padStart(2, "0")}`;
const spokenLength = (s: WorkoutStep) =>
  s.distance_m !== undefined ? (s.distance_m >= 1000 && s.distance_m % 100 === 0 ? `${s.distance_m / 1000} kilometres`.replace(/^1 kilometres/, "1 kilometre") : `${s.distance_m} metres`) : spokenTime(s.duration_s ?? 0);
const paceOf = (s: WorkoutStep): [number, number] | undefined => s.pace ?? (s.speed ? [Math.round(3600 / s.speed[1]), Math.round(3600 / s.speed[0])] : undefined);
const spokenTarget = (s: WorkoutStep) => {
  const p = paceOf(s);
  if (p) return `at ${spokenPace(p[0])} to ${spokenPace(p[1])} a kilometre`;
  if (s.hr) return `heart rate ${s.hr[0]} to ${s.hr[1]}`;
  return s.kind === "recover" ? "easy" : "";
};

/** "800 m · 3:50–4:00 /km" for the screen. */
export function stepDetail(s: WorkoutStep): string {
  const len = s.distance_m !== undefined ? (s.distance_m >= 1000 ? `${Number((s.distance_m / 1000).toFixed(2))} km` : `${s.distance_m} m`) : mmss(s.duration_s ?? 0);
  const p = paceOf(s);
  const t = p ? `${mmss(p[0])}–${mmss(p[1])} /km` : s.hr ? `${s.hr[0]}–${s.hr[1]} bpm` : s.kind === "recover" ? "easy" : "";
  return [len, t].filter(Boolean).join(" · ");
}

/** What a step is, said as it starts. */
export function stepWords(s: GuidedStep, first = false): string {
  const what = [s.label, [spokenLength(s), spokenTarget(s)].filter(Boolean).join(" ")].join(". ");
  const go = s.kind === "run" && !first ? " Go." : "";
  const note = s.note ? ` ${s.note.title}: ${s.note.text}.` : "";
  return `${what}.${go}${note}`;
}

/** Two steps the runner wouldn't tell apart (a steady run cut for drink reminders). */
const same = (a: WorkoutStep, b: WorkoutStep) => a.kind === b.kind && a.title === b.title && JSON.stringify([a.hr, a.pace, a.speed, a.power]) === JSON.stringify([b.hr, b.pace, b.speed, b.power]);

export class Guide {
  readonly steps: GuidedStep[];
  state: GuideState;

  constructor(
    readonly workout: Workout,
    state?: GuideState,
  ) {
    this.steps = flatten(workout);
    this.state = state && state.at < this.steps.length ? state : { at: 0, from_s: 0, from_m: 0, done: false, said: [] };
  }

  get step(): GuidedStep | undefined {
    return this.state.done ? undefined : this.steps[this.state.at];
  }

  /** What to say as the run starts: the session, then its first step. */
  begin(p: GuideProgress): string[] {
    this.state = { at: 0, from_s: p.active_s, from_m: p.distance_m, done: false, said: [] };
    return [`Guiding today's ${this.workout.name.replace(/^\w{3} /, "")}.`, stepWords(this.steps[0]!, true)];
  }

  /** How far into the step, and how much is left (seconds or metres). */
  private left(p: GuideProgress, s: GuidedStep): { left: number; share: number; by: "s" | "m" } {
    if (s.distance_m !== undefined) {
      const d = p.distance_m - this.state.from_m;
      return { left: s.distance_m - d, share: Math.min(1, Math.max(0, d / s.distance_m)), by: "m" };
    }
    const t = p.active_s - this.state.from_s;
    return { left: (s.duration_s ?? 0) - t, share: Math.min(1, Math.max(0, t / (s.duration_s || 1))), by: "s" };
  }

  /** Into the next step (or the end), with what to say about it. */
  private advance(p: GuideProgress): string[] {
    const prev = this.steps[this.state.at]!;
    const i = this.state.at + 1;
    if (i >= this.steps.length) {
      this.state = { ...this.state, at: this.steps.length - 1, done: true, said: [] };
      return ["That's the session done. Well run. Keep recording to the end of your run, then finish."];
    }
    this.state = { at: i, from_s: p.active_s, from_m: p.distance_m, done: false, said: [] };
    const s = this.steps[i]!;
    // A steady run cut for reminders goes on without a word, apart from the reminder.
    if (same(prev, s)) return s.note ? [`${s.note.title}: ${s.note.text}.`] : [];
    return [stepWords(s)];
  }

  /** Skip to the next step (Next step on the screen): what to say. */
  skip(p: GuideProgress): string[] {
    return this.state.done ? [] : this.advance(p);
  }

  /** A new reading: whatever there is to say now (most of the time, nothing). */
  update(p: GuideProgress): string[] {
    const s = this.step;
    if (!s) return [];
    const { left, share, by } = this.left(p, s);
    if (left <= 0) return this.advance(p);
    const out: string[] = [];
    const once = (key: string, text: string) => {
      if (this.state.said.includes(key)) return;
      this.state.said.push(key);
      out.push(text);
    };
    const next = this.steps[this.state.at + 1];
    const changes = !next || !same(s, next);
    // Countdown to a change of step: 10 seconds, or 100 metres, with what comes next.
    if (changes) {
      const tell = next ? ` Next: ${next.label.toLowerCase()}.` : "";
      if (by === "s" && (s.duration_s ?? 0) >= 40 && left <= 10) once("10s", `10 seconds.${tell}`);
      if (by === "m" && (s.distance_m ?? 0) >= 400 && left <= 100) once("100m", `100 metres to go.${tell}`);
    }
    // Halfway through a long step.
    // (Not in a piece of a steady run cut for reminders: those carry their own words.)
    const prev = this.steps[this.state.at - 1];
    const piece = !changes || (prev !== undefined && same(prev, s));
    if (!piece && share >= 0.5 && share < 0.75 && ((by === "s" && (s.duration_s ?? 0) >= 360) || (by === "m" && (s.distance_m ?? 0) >= 2000))) once("half", "Halfway.");
    // The target, now and then: from 30 s into the step, every 45 s at most, said only when off it.
    const into = p.active_s - this.state.from_s;
    const pace = paceOf(s);
    const checkable = (pace && p.pace_s) || (s.hr && p.hr);
    if (checkable && into >= 30 && left > (by === "s" ? 15 : 80) && (this.state.checked_s === undefined || p.active_s - this.state.checked_s >= 45)) {
      this.state.checked_s = p.active_s;
      const word = targetWord(s, p);
      if (word) out.push(word);
      else if (s.kind === "run") once("first", pace ? "On pace." : "Heart rate on target.");
    }
    return out;
  }

  view(p: GuideProgress): GuideView {
    const s = this.steps[this.state.at]!;
    const done = this.state.done;
    const { left, share, by } = this.left(p, s);
    const next = this.steps[this.state.at + 1];
    return {
      name: this.workout.name,
      index: this.state.at,
      total: this.steps.length,
      label: done ? "Session done" : s.label,
      detail: done ? "Keep recording to the end of your run, then finish." : stepDetail(s),
      kind: s.kind,
      ...(done ? {} : by === "s" ? { left_s: Math.max(0, Math.round(left)) } : { left_m: Math.max(0, Math.round(left)) }),
      share: done ? 1 : share,
      ...(next && !done ? { next: `${next.label} · ${stepDetail(next)}` } : {}),
      done,
    };
  }
}

/** Off the target: a pace (5 s/km of slack) or heart rate (3 bpm over, 5 under) word; null when on it. */
export function targetWord(s: WorkoutStep, p: GuideProgress): string | null {
  const pace = paceOf(s);
  if (pace && p.pace_s) {
    if (p.pace_s < pace[0] - 5) return "A little fast: ease off.";
    if (p.pace_s > pace[1] + 5) return s.kind === "run" ? "A little slow: pick it up." : null;
    return null;
  }
  if (s.hr && p.hr) {
    if (p.hr > s.hr[1] + 3) return `Heart rate ${Math.round(p.hr)}: ease off.`;
    if (p.hr < s.hr[0] - 5 && s.kind === "run") return `Heart rate ${Math.round(p.hr)}: you can push a little.`;
  }
  return null;
}
