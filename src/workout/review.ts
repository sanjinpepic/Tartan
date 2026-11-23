/**
 * How a guided session went: the planned steps laid over what was recorded. The recording is
 * walked from its start, each step taking its time or distance in turn (as the watch's guide
 * does), and each step's average heart rate, pace, speed or power is set against its target.
 */
import { isRepeat, type Workout, type WorkoutStep } from "./guide.ts";

export interface StepReview {
  label: string;
  kind: WorkoutStep["kind"];
  /** What was asked: "4:30-4:40 /km", "150-160 bpm", or "" without a target. */
  target: string;
  /** What was done, in the target's terms ("4:36 /km"), or "" when there's nothing to compare. */
  actual: string;
  /** Share of the step's time inside the target, 0-1 (null without a target or data). */
  inRange: number | null;
  verdict: "on target" | "fast" | "slow" | "high" | "low" | "no data" | "not done" | "done";
  /** How far off, in the target's unit ("8 s/km", "6 bpm"), when off. */
  off: string;
  seconds: number;
  metres: number;
  /** Where in the recording: its first and last sample (indexes into the columns reviewed), when done. */
  span?: [number, number];
}
export interface SessionReview {
  steps: StepReview[];
  /** Work steps (the reps) on target, of those done with a target. */
  work: { onTarget: number; total: number };
  /** Share of all targeted time spent in range. */
  inRange: number | null;
  summary: string;
}

export interface Columns {
  time?: unknown[];
  distance?: unknown[];
  heartrate?: unknown[];
  velocity?: unknown[];
  watts?: unknown[];
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
const LABEL: Record<WorkoutStep["kind"], string> = { warmup: "Warm up", run: "Run", recover: "Recover", cooldown: "Cool down" };

/** The steps in the order the watch runs them, repeats written out. */
function flatten(w: Workout): Array<{ step: WorkoutStep; label: string }> {
  const out: Array<{ step: WorkoutStep; label: string }> = [];
  let set = 0;
  const sets = w.blocks.filter(isRepeat).length;
  for (const b of w.blocks) {
    if (isRepeat(b)) {
      set++;
      for (let r = 1; r <= b.repeat; r++)
        for (const s of b.steps) out.push({ step: s, label: `${s.kind === "run" ? "Rep" : LABEL[s.kind]} ${r}/${b.repeat}${sets > 1 ? ` (set ${set})` : ""}` });
    } else out.push({ step: b, label: b.title ?? LABEL[b.kind] });
  }
  return out;
}

export function reviewWorkout(w: Workout, c: Columns): SessionReview {
  const num = (a: unknown[] | undefined, i: number) => (a && typeof a[i] === "number" ? (a[i] as number) : null);
  const n = c.time?.length ?? 0;
  const steps: StepReview[] = [];
  let i = 0;
  for (const { step, label } of flatten(w)) {
    const target = step.hr ? `${step.hr[0]}-${step.hr[1]} bpm` : step.pace ? `${mmss(step.pace[0])}-${mmss(step.pace[1])} /km` : step.speed ? `${step.speed[0]}-${step.speed[1]} km/h` : step.power ? `${step.power[0]}-${step.power[1]} W` : "";
    if (i >= n - 1) {
      steps.push({ label, kind: step.kind, target, actual: "", inRange: null, verdict: "not done", off: "", seconds: 0, metres: 0 });
      continue;
    }
    // This step's samples: until its time or distance is up.
    const t0 = num(c.time, i)!;
    const d0 = num(c.distance, i) ?? 0;
    let j = i;
    while (j < n - 1) {
      const dt = num(c.time, j + 1)! - t0;
      const dd = (num(c.distance, j + 1) ?? d0) - d0;
      if (step.duration_s !== undefined ? dt > step.duration_s : dd > (step.distance_m ?? 0)) break;
      j++;
    }
    const seconds = num(c.time, j)! - t0;
    const metres = (num(c.distance, j) ?? d0) - d0;
    // Time-weighted average and share in range of the step's measure.
    const measure = (k: number): number | null => {
      if (step.hr) return num(c.heartrate, k);
      if (step.power) return num(c.watts, k);
      const v = num(c.velocity, k);
      if (v === null) return null;
      return step.pace ? (v > 0.3 ? 1000 / v : null) : v * 3.6;
    };
    const range: [number, number] | null = step.hr ?? step.pace ?? step.speed ?? step.power ?? null;
    let sum = 0;
    let weight = 0;
    let inside = 0;
    for (let k = i; k < j; k++) {
      const v = measure(k);
      const dt = num(c.time, k + 1)! - num(c.time, k)!;
      if (v === null || !(dt > 0) || dt > 30) continue;
      sum += v * dt;
      weight += dt;
      if (range && v >= range[0] && v <= range[1]) inside += dt;
    }
    let avg = weight ? sum / weight : null;
    // Pace from the distance covered is steadier than averaging speeds.
    if (step.pace && metres > 50 && seconds > 0) avg = seconds / (metres / 1000);
    let verdict: StepReview["verdict"] = "done";
    let off = "";
    let actual = "";
    if (range && avg === null) verdict = "no data";
    else if (range && avg !== null) {
      const unit = step.hr ? "bpm" : step.pace ? "s/km" : step.speed ? "km/h" : "W";
      actual = step.pace ? `${mmss(avg)} /km` : `${Math.round(avg)} ${unit}`;
      const below = avg < range[0];
      const above = avg > range[1];
      verdict = !below && !above ? "on target" : step.pace ? (below ? "fast" : "slow") : below ? "low" : "high";
      if (below || above) off = `${Math.round(below ? range[0] - avg : avg - range[1])} ${unit}`;
    }
    steps.push({ label, kind: step.kind, target, actual, inRange: range && weight ? inside / weight : null, verdict, off, seconds: Math.round(seconds), metres: Math.round(metres), span: [i, j] });
    i = j;
  }
  const work = steps.filter((s) => s.kind === "run" && s.target && s.verdict !== "not done" && s.verdict !== "no data");
  const targeted = steps.filter((s) => s.inRange !== null);
  const totalTime = targeted.reduce((t, s) => t + s.seconds, 0);
  const inRange = totalTime ? targeted.reduce((t, s) => t + s.inRange! * s.seconds, 0) / totalTime : null;
  const onTarget = work.filter((s) => s.verdict === "on target").length;
  const missed = steps.filter((s) => s.verdict === "not done").length;
  const offSteps = work.filter((s) => s.verdict !== "on target");
  const summary = !work.length
    ? missed === steps.length
      ? "Nothing recorded to compare."
      : "Done; no targets to compare."
    : work.length === 1 && steps.length === 1
      ? work[0]!.verdict === "on target"
        ? "On target."
        : `${work[0]!.verdict[0]!.toUpperCase()}${work[0]!.verdict.slice(1)} by ${work[0]!.off}.`
      : `${onTarget} of ${work.length} ${work.length === 1 ? "work step" : "reps"} on target${offSteps.length ? `; ${offSteps.map((s) => `${s.label.toLowerCase()} ${s.off} ${s.verdict}`).slice(0, 2).join(", ")}` : ""}${missed ? `; ${missed} step${missed === 1 ? "" : "s"} not done` : ""}.`;
  return { steps, work: { onTarget, total: work.length }, inRange, summary };
}
