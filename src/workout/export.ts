/**
 * A plan session's workout (src/workout/guide.ts Workout, the same one a Suunto gets) for any
 * other watch, three ways:
 *
 *   intervals.icu   its workout text ("- 10m 65-75% HR", "6x", …) on a planned event; intervals.icu
 *                   forwards planned workouts to the watch accounts it links (Garmin Connect among
 *                   them), so the watch has the session as a guided workout.
 *   a .fit file     FIT's workout file (file type 5: workout and workout_step messages), the format
 *                   Garmin and most other watches and their apps import; copied to a Garmin over
 *                   USB it goes in GARMIN/NewFiles.
 *   Health Connect  a planned exercise session (blocks of steps with goals and targets), for the
 *                   watch apps that read planned workouts from Health Connect (Samsung and Pixel
 *                   watches, where their apps do). Written by TartanHealthPlugin from this shape.
 *
 * Apple Watch isn't here: it takes workouts only from an iPhone.
 */
import { fitCrc } from "../fit-write.ts";
import { isRepeat, plain, type Workout, type WorkoutStep } from "./guide.ts";

/** What sport the watch should start a session in, by the plan's kind. */
export type WatchSport = "running" | "strength" | "cycling" | "swimming" | "other";
export const sportOf = (kind: string): WatchSport =>
  kind === "strength" ? "strength" : kind === "swim" ? "swimming" : kind === "ride" ? "cycling" : kind === "cross" ? "other" : "running";

const STEP_TITLE: Record<WorkoutStep["kind"], string> = { warmup: "Warm up", run: "Run", recover: "Recover", cooldown: "Cool down" };

// ---------------------------------------------------------------- intervals.icu

/** 600 → "10m", 90 → "1m30s", 3600 → "1h"; 800 m → "800mtr" (intervals.icu's "m" is minutes), 5000 → "5km". */
export function icuLength(s: Pick<WorkoutStep, "duration_s" | "distance_m">): string {
  if (s.distance_m !== undefined) {
    const m = Math.round(s.distance_m);
    return m >= 1000 && m % 10 === 0 ? `${String(Number((m / 1000).toFixed(2)))}km` : `${m}mtr`;
  }
  const t = Math.round(s.duration_s ?? 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${sec ? `${sec}s` : ""}` || "0s";
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

/**
 * A step's target as intervals.icu writes it: heart rate as % of max (its HR targets are relative
 * to the athlete's max there; Tartan's own max is the best guess of it), pace per km, watts.
 */
export function icuTarget(s: WorkoutStep, maxHr?: number): string {
  if (s.hr) return maxHr ? `${Math.round((s.hr[0] / maxHr) * 100)}-${Math.round((s.hr[1] / maxHr) * 100)}% HR` : "";
  const pace = s.pace ?? (s.speed ? ([3600 / s.speed[1], 3600 / s.speed[0]] as [number, number]) : undefined);
  if (pace) return `${mmss(pace[0])}-${mmss(pace[1])}/km Pace`;
  if (s.power) return `${s.power[0]}-${s.power[1]}w`;
  return "";
}

/** Words for a step's cue, without anything intervals.icu would read as a number or a target. */
const cue = (t: string) =>
  plain(t)
    .replace(/[0-9%]/g, "")
    .replace(/\b(x|w|km|mtr|m|s|h|z)\b/gi, "")
    .replace(/[-:/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The workout as intervals.icu's workout text: one "- cue length target" line per step, "Nx" before repeats. */
export function icuText(w: Workout, o: { maxHr?: number; notes?: string } = {}): string {
  const line = (s: WorkoutStep) => `- ${[cue(s.note ? `${s.note.title} ${s.note.text}` : (s.title ?? STEP_TITLE[s.kind])), icuLength(s), icuTarget(s, o.maxHr)].filter(Boolean).join(" ")}`;
  const parts: string[] = [];
  // The session's notes on top as plain words (one line, no step or repeat syntax in it).
  const notes = o.notes ? plain(o.notes).replace(/^[-\s]+/, "").replace(/\b(\d+)\s*x\b/gi, "$1 times") : "";
  if (notes) parts.push(notes);
  let run: string[] = [];
  const flush = () => {
    if (run.length) parts.push(run.join("\n"));
    run = [];
  };
  for (const b of w.blocks) {
    if (isRepeat(b)) {
      flush();
      parts.push([`${b.note ? `${cue(b.note.title)} ` : ""}${b.repeat}x`, ...b.steps.map(line)].join("\n"));
    } else run.push(line(b));
  }
  flush();
  return parts.join("\n\n");
}

/** intervals.icu's activity type for a session. */
export const icuType = (kind: string) => ({ running: "Run", strength: "WeightTraining", cycling: "Ride", swimming: "Swim", other: "Workout" })[sportOf(kind)];

// ---------------------------------------------------------------- FIT workout file

const ENUM = 0x00, U16 = 0x84, U32 = 0x86, STR = 0x07;
type Field = [num: number, type: number, size?: number];
const SIZE: Record<number, number> = { [ENUM]: 1, [U16]: 2, [U32]: 4 };
const INVALID: Record<number, number> = { [ENUM]: 0xff, [U16]: 0xffff, [U32]: 0xffffffff };
const FILE_ID: Field[] = [[0, ENUM], [1, U16], [2, U16], [4, U32]];
const WORKOUT: Field[] = [[4, ENUM], [11, ENUM], [6, U16], [8, STR, 32]];
const STEP: Field[] = [[254, U16], [0, STR, 16], [1, ENUM], [2, U32], [3, ENUM], [4, U32], [5, U32], [6, U32], [7, ENUM], [8, STR, 48]];
const FIT_EPOCH_MS = 631065600_000;

/** FIT's names for what's used here. */
export const FIT = {
  // Swimming in a pool (lap swimming, 17); cycling of any kind (generic, 0).
  sport: { running: 1, strength: 10, cycling: 2, swimming: 5, other: 0 } as Record<WatchSport, number>,
  subSport: { running: 0, strength: 20, cycling: 0, swimming: 17, other: 0 } as Record<WatchSport, number>,
  duration: { time: 0, distance: 1, open: 5, repeat: 6 },
  target: { speed: 0, heartRate: 1, open: 2, power: 4 },
  intensity: { active: 0, rest: 1, warmup: 2, cooldown: 3, recovery: 4 },
};

/** A FIT workout step's values (FIT's units: ms, cm, mm/s, bpm + 100, W + 1000). */
export interface FitStep {
  name?: string;
  duration: number;
  value?: number;
  target: number;
  targetValue?: number;
  low?: number;
  high?: number;
  intensity?: number;
  notes?: string;
}

/** The workout's steps as FIT writes them: a repeat is a step after its group pointing back at it. */
export function fitSteps(w: Workout, sport: WatchSport): FitStep[] {
  const out: FitStep[] = [];
  const step = (s: WorkoutStep): FitStep => {
    const intensity =
      s.kind === "warmup" ? FIT.intensity.warmup
      : s.kind === "cooldown" ? FIT.intensity.cooldown
      : s.kind === "recover" ? (sport === "strength" ? FIT.intensity.rest : FIT.intensity.recovery)
      : FIT.intensity.active;
    const len = s.distance_m !== undefined ? { duration: FIT.duration.distance, value: Math.round(s.distance_m * 100) } : { duration: FIT.duration.time, value: Math.round((s.duration_s ?? 0) * 1000) };
    const speed = s.pace ? ([1000 / s.pace[1], 1000 / s.pace[0]] as const) : s.speed ? ([s.speed[0] / 3.6, s.speed[1] / 3.6] as const) : null;
    const target =
      s.hr ? { target: FIT.target.heartRate, targetValue: 0, low: s.hr[0] + 100, high: s.hr[1] + 100 }
      : speed ? { target: FIT.target.speed, targetValue: 0, low: Math.round(speed[0] * 1000), high: Math.round(speed[1] * 1000) }
      : s.power ? { target: FIT.target.power, targetValue: 0, low: s.power[0] + 1000, high: s.power[1] + 1000 }
      : { target: FIT.target.open };
    const notes = s.note ? `${s.note.title}: ${s.note.text}` : undefined;
    return { name: plain(s.title ?? STEP_TITLE[s.kind]), ...len, ...target, intensity, ...(notes ? { notes: plain(notes) } : {}) };
  };
  for (const b of w.blocks) {
    if (isRepeat(b)) {
      const first = out.length;
      b.steps.forEach((s, i) => out.push({ ...step(s), ...(i === 0 && b.note ? { notes: plain(`${b.note.title}: ${b.note.text}`) } : {}) }));
      out.push({ duration: FIT.duration.repeat, value: first, target: FIT.target.open, targetValue: b.repeat });
    } else out.push(step(b));
  }
  return out;
}

/** The workout as a FIT workout file (what a Garmin, a Coros or their apps import). */
export function workoutFit(w: Workout, sport: WatchSport, created = Date.now()): Uint8Array {
  const bytes: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = 0; i < n; i++) bytes.push(Math.floor(v / 2 ** (8 * i)) & 0xff);
  };
  const size = ([, type, n]: Field) => n ?? SIZE[type]!;
  const define = (local: number, global: number, fields: Field[]) => {
    bytes.push(0x40 | local, 0, 0);
    put(global, 2);
    bytes.push(fields.length);
    for (const f of fields) bytes.push(f[0], size(f), f[1]);
  };
  const message = (local: number, fields: Field[], values: Record<number, number | string | undefined>) => {
    bytes.push(local);
    for (const f of fields) {
      const v = values[f[0]];
      if (f[1] === STR) {
        // UTF-8, cut to fit with its terminating zero.
        const enc = new TextEncoder().encode(typeof v === "string" ? v : "").subarray(0, size(f) - 1);
        for (let i = 0; i < size(f); i++) bytes.push(enc[i] ?? 0);
      } else put(typeof v === "number" && Number.isFinite(v) ? Math.round(v) : INVALID[f[1]]!, size(f));
    }
  };
  const steps = fitSteps(w, sport);
  define(0, 0, FILE_ID);
  message(0, FILE_ID, { 0: 5, 1: 255, 2: 0, 4: Math.round((created - FIT_EPOCH_MS) / 1000) });
  define(1, 26, WORKOUT);
  message(1, WORKOUT, { 4: FIT.sport[sport], 11: FIT.subSport[sport], 6: steps.length, 8: plain(w.name) });
  define(2, 27, STEP);
  steps.forEach((s, i) => message(2, STEP, { 254: i, 0: s.name, 1: s.duration, 2: s.value, 3: s.target, 4: s.targetValue, 5: s.low, 6: s.high, 7: s.intensity, 8: s.notes }));

  const data = Uint8Array.from(bytes);
  const out = new Uint8Array(14 + data.length + 2);
  const v = new DataView(out.buffer);
  out[0] = 14;
  out[1] = 0x20;
  v.setUint16(2, 2132, true);
  v.setUint32(4, data.length, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8);
  v.setUint16(12, fitCrc(out.subarray(0, 12)), true);
  out.set(data, 14);
  v.setUint16(14 + data.length, fitCrc(out.subarray(0, 14 + data.length)), true);
  return out;
}

/** "2026-11-12 Tue Long Run.fit" → a file name any phone or PC keeps. */
export const fitName = (date: string, w: Workout) => `${date} ${plain(w.name).replace(/[^\w\- ]+/g, "").trim() || "workout"}.fit`;

// ---------------------------------------------------------------- Health Connect

/** A planned exercise session as TartanHealthPlugin writes it (PlannedExerciseSessionRecord). */
export interface HcPlanned {
  /** Client record id: one per session. */
  id: string;
  /** ms since 1970. */
  start: number;
  end: number;
  title: string;
  notes?: string;
  exercise: "running" | "strength_training" | "biking" | "swimming_pool" | "other";
  blocks: Array<{
    repetitions: number;
    description?: string;
    steps: Array<{
      phase: "warmup" | "active" | "recovery" | "rest" | "cooldown";
      description?: string;
      duration_s?: number;
      distance_m?: number;
      /** bpm. */
      hr?: [number, number];
      /** m/s, slow to fast. */
      speed?: [number, number];
      /** W. */
      power?: [number, number];
    }>;
  }>;
}

/** How long a workout takes, in seconds (distances at its pace, else 6:00 /km). */
export function workoutSeconds(w: Workout): number {
  const one = (s: WorkoutStep) => s.duration_s ?? ((s.distance_m ?? 0) / 1000) * (s.pace ? (s.pace[0] + s.pace[1]) / 2 : s.speed ? 7200 / (s.speed[0] + s.speed[1]) : 360);
  return Math.round(w.blocks.reduce((t, b) => t + (isRepeat(b) ? b.repeat * b.steps.reduce((x, s) => x + one(s), 0) : one(b)), 0));
}

/** A session as a Health Connect planned session, starting at `start` (ms, the time you train). */
export function hcPlanned(p: { date: string; kind: string; title: string; notes?: string; workout: Workout }, start: number): HcPlanned {
  const sport = sportOf(p.kind);
  const step = (s: WorkoutStep): HcPlanned["blocks"][number]["steps"][number] => {
    const speed = s.pace ? ([1000 / s.pace[1], 1000 / s.pace[0]] as [number, number]) : s.speed ? ([s.speed[0] / 3.6, s.speed[1] / 3.6] as [number, number]) : undefined;
    return {
      phase: s.kind === "warmup" ? "warmup" : s.kind === "cooldown" ? "cooldown" : s.kind === "recover" ? (sport === "strength" ? "rest" : "recovery") : "active",
      ...(s.note ? { description: plain(`${s.note.title}: ${s.note.text}`) } : s.title ? { description: plain(s.title) } : {}),
      ...(s.distance_m !== undefined ? { distance_m: s.distance_m } : { duration_s: s.duration_s }),
      ...(s.hr ? { hr: s.hr } : speed ? { speed: [Number(speed[0].toFixed(3)), Number(speed[1].toFixed(3))] as [number, number] } : s.power ? { power: s.power } : {}),
    };
  };
  const blocks: HcPlanned["blocks"] = [];
  for (const b of p.workout.blocks) {
    if (isRepeat(b)) blocks.push({ repetitions: b.repeat, ...(b.note ? { description: plain(`${b.note.title}: ${b.note.text}`) } : {}), steps: b.steps.map(step) });
    else {
      // Steps in a row share one block, as Health Connect's own examples do.
      const last = blocks.at(-1);
      if (last && last.repetitions === 1 && !last.description) last.steps.push(step(b));
      else blocks.push({ repetitions: 1, steps: [step(b)] });
    }
  }
  return {
    id: `tartan-plan-${p.date}-${p.kind}`,
    start,
    end: start + Math.max(60, workoutSeconds(p.workout)) * 1000,
    title: plain(p.workout.name),
    ...(p.notes ? { notes: p.notes.slice(0, 1000) } : {}),
    exercise: ({ running: "running", strength: "strength_training", cycling: "biking", swimming: "swimming_pool", other: "other" } as const)[sport],
    blocks,
  };
}
