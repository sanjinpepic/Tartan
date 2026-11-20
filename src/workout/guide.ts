/**
 * A structured workout for the Suunto Run 2, as the Suunto app's workout planner sends it
 * (HCI capture of 18 Oct 2026): a SuuntoPlus "guide", a zip of plain-text files stored without
 * compression,
 *
 *   icon.pxb       empty
 *   main.js        the step runner: Tartan's own (src/workout/runner.ts), or in the owner's
 *                  build the captured one (src/workout/suunto-runner.ts)
 *   manifest.jsn   name, author, "type":"sequence", "usage":"workout"
 *   step<N>.js     one JSON object per step, run in order by main.js
 *
 * Steps: type 1 shows a screen (the title and text of what comes next; an empty one with a
 * hidden lap starts a lap: before each repeat, each work step on its own, and the end); type 2
 * repeats the next `next` steps `count` times; a step without a type is the part you do, with
 * its target (heart rate in beats per second, pace and speed in metres per second, power in
 * watts), a duration in seconds or a distance in metres, and the lap button ending it.
 * The steps are Tartan's (this file writes them); the runner is chosen by the caller.
 */
import { zip } from "../watchface/package.ts";
import { TARTAN_RUNNER } from "./runner.ts";

export type StepKind = "warmup" | "run" | "recover" | "cooldown";
export interface WorkoutStep {
  kind: StepKind;
  /** How long, in seconds; or `distance_m`. */
  duration_s?: number;
  distance_m?: number;
  /**
   * At most one target, the range the watch alerts outside of: heart rate in bpm, pace in
   * seconds per km [fast, slow], speed in km/h, power in watts.
   */
  hr?: [number, number];
  pace?: [number, number];
  speed?: [number, number];
  power?: [number, number];
  /** The step's screen title, when not the kind's own ("Strength", "Bike"). */
  title?: string;
  /** A screen shown as the step starts (a reminder: "Fuel", "Gel and a drink"). */
  note?: { title: string; text: string };
}
export interface WorkoutRepeat {
  repeat: number;
  steps: WorkoutStep[];
  /** The screen before the repeats, when not "Set: 6 x 800 m" (a strength exercise: "Squat", "3 x 10 at 40 kg"). */
  note?: { title: string; text: string };
}
export type WorkoutBlock = WorkoutStep | WorkoutRepeat;
export interface Workout {
  name: string;
  blocks: WorkoutBlock[];
}

/** What the guide says when it ends, and who it's from (the captures carry Suunto's). */
export interface GuideOptions {
  author?: string;
  authorId?: string;
  endText?: string;
  /** Seconds since 1970. */
  modified?: number;
  /** The step runner (main.js): Tartan's own unless the owner's build picks the captured one. */
  runner?: string;
}

export const isRepeat = (b: WorkoutBlock): b is WorkoutRepeat => "repeat" in b;

/** Tartan's guides have ids "tt" and six letters or digits (the Suunto app's: eight). */
export const TARTAN_WORKOUT_ID = /^tt[a-z0-9]{6}$/;
export const newWorkoutId = () => `tt${Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")}`;

/** A random id that stands for Tartan as the author (the watch shows only the name). */
const TARTAN_AUTHOR_ID = "7a2b6c1e-3f5d-4e8a-9b0c-1d2e3f4a5b6c";


const KIND: Record<StepKind, { title: string; phase: string; hiddenLap: boolean }> = {
  warmup: { title: "Warm up", phase: "warmUp", hiddenLap: true },
  run: { title: "Interval", phase: "interval", hiddenLap: false },
  recover: { title: "Recover", phase: "rest", hiddenLap: true },
  cooldown: { title: "Cool down", phase: "coolDown", hiddenLap: true },
};

/** 900 → 15'00; 1000 m → 1.00 km (as the planner writes them). */
const length = (s: WorkoutStep) =>
  s.distance_m !== undefined ? `${(s.distance_m / 1000).toFixed(2)} km` : `${Math.floor(s.duration_s! / 60)}'${String(s.duration_s! % 60).padStart(2, "0")}`;
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
/** The target as the intro screens say it ("150 - 160 bpm", as the planner writes it). */
const bpm = (s: WorkoutStep) =>
  s.hr ? `${s.hr[0]} - ${s.hr[1]} bpm` : s.pace ? `${mmss(s.pace[0])} - ${mmss(s.pace[1])} /km` : s.speed ? `${s.speed[0]} - ${s.speed[1]} km/h` : s.power ? `${s.power[0]} - ${s.power[1]} W` : "";
const join = (...parts: string[]) => parts.filter(Boolean).join(" ");

/** The watch's font is plain: names and texts in printable ASCII. */
export const plain = (t: string) =>
  t
    .replace(/[×✕]/g, "x")
    .replace(/[–—]/g, "-")
    .replace(/[·•]/g, "-")
    .replace(/[’‘]/g, "'")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Refuses what the watch format (as captured) can't say. */
export function checkWorkout(w: Workout): void {
  const fail = (why: string): never => {
    throw new Error(`Workout: ${why}`);
  };
  if (!plain(w.name)) fail("it needs a name");
  if (!w.blocks.length || w.blocks.length > 60) fail("1 to 60 parts");
  const step = (s: WorkoutStep) => {
    if (!KIND[s.kind]) fail(`unknown step "${s.kind}"`);
    if ((s.duration_s === undefined) === (s.distance_m === undefined)) fail("each step ends after a time or a distance");
    if (s.duration_s !== undefined && !(Number.isInteger(s.duration_s) && s.duration_s >= 10 && s.duration_s <= 36_000)) fail("a step lasts 10 s to 10 h");
    if (s.distance_m !== undefined && !(Number.isInteger(s.distance_m) && s.distance_m >= 50 && s.distance_m <= 100_000)) fail("a step is 50 m to 100 km");
    const range = (r: unknown, lo: number, hi: number) => Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi) && r[0] < r[1];
    if (s.hr !== undefined && !(range(s.hr, 60, 220) && s.hr.every(Number.isInteger))) fail("a heart-rate range goes low to high, in bpm");
    if (s.pace !== undefined && !range(s.pace, 90, 1200)) fail("a pace range goes fast to slow, in seconds per km");
    if (s.speed !== undefined && !range(s.speed, 1, 100)) fail("a speed range goes low to high, in km/h");
    if (s.power !== undefined && !(range(s.power, 10, 2000) && s.power.every(Number.isInteger))) fail("a power range goes low to high, in watts");
    if ([s.hr, s.pace, s.speed, s.power].filter((x) => x !== undefined).length > 1) fail("one target per step");
    if (s.title !== undefined && !plain(s.title)) fail("a step title in plain letters");
    if (s.note !== undefined && !(plain(s.note.title) && plain(s.note.text))) fail("a reminder needs a title and a text");
  };
  for (const b of w.blocks) {
    if (isRepeat(b)) {
      if (!(Number.isInteger(b.repeat) && b.repeat >= 2 && b.repeat <= 30)) fail("a repeat is 2 to 30 times");
      if (!b.steps.length || b.steps.length > 4) fail("a repeat holds 1 to 4 steps");
      if (b.note !== undefined && !(plain(b.note.title) && plain(b.note.text))) fail("a repeat's screen needs a title and a text");
      b.steps.forEach(step);
    } else step(b);
  }
}

/** The step files, in order: step0.js, step1.js, … */
export function guideSteps(w: Workout, o: GuideOptions = {}): string[] {
  checkWorkout(w);
  const out: object[] = [];
  const title = (s: WorkoutStep) => (s.title ? plain(s.title).slice(0, 20) : KIND[s.kind].title);
  /** The target, its screen fields (the planner's, per kind), as captured. */
  const aim = (s: WorkoutStep): { input: string; value: number; low: number; high: number; fields: unknown[] } | null =>
    s.hr ? { input: "HeartRate", value: (s.hr[0] + s.hr[1]) / 2 / 60, low: s.hr[0] / 60, high: s.hr[1] / 60, fields: ["HeartRate"] }
    : s.pace ? { input: "Pace", value: 1000 / ((s.pace[0] + s.pace[1]) / 2), low: 1000 / s.pace[1], high: 1000 / s.pace[0], fields: ["Pace"] }
    : s.speed ? { input: "Speed", value: (s.speed[0] / 3.6 + s.speed[1] / 3.6) / 2, low: s.speed[0] / 3.6, high: s.speed[1] / 3.6, fields: ["Speed", "HeartRate"] }
    : s.power ? { input: "Power", value: (s.power[0] + s.power[1]) / 2, low: s.power[0], high: s.power[1], fields: ["Power", "HeartRate"] }
    : null;
  const active = (s: WorkoutStep) => {
    const k = KIND[s.kind];
    const by = s.distance_m !== undefined ? "Distance" : "Duration";
    const length = { input: `Step ${by}`, value: s.distance_m ?? s.duration_s, onReach: 1 };
    // With a target as captured; without one, the same with the target left out (its
    // targets renumbered), which no capture shows yet.
    const t = aim(s);
    return {
      endOnLap: true,
      ...(k.hiddenLap ? { lap: { hidden: true } } : {}),
      phase: k.phase,
      view: t
        ? { title: title(s), field: [{ input: `Target ${t.input}`, title: "target", targetIndex: "0" }, ...t.fields, { input: `Remaining Step ${by}`, targetIndex: "1" }] }
        : { title: title(s), field: ["HeartRate", { input: `Remaining Step ${by}`, targetIndex: "0" }] },
      target: t
        ? [{ input: t.input, value: t.value, low: t.low, high: t.high, index: 0 }, { ...length, index: 1 }, { input: "ManualLap", onReach: 1 }]
        : [{ ...length, index: 0 }, { input: "ManualLap", onReach: 1 }],
    };
  };
  const sets = w.blocks.filter(isRepeat).length;
  let set = 0;
  for (const b of w.blocks) {
    if (isRepeat(b)) {
      set++;
      const [first, second] = b.steps;
      const text = `${b.repeat} x ${length(first!)}\f${join(second ? length(second) : "", bpm(first!))}`;
      out.push({ type: 1, view: b.note ? { title: plain(b.note.title).slice(0, 20), text: plain(b.note.text).slice(0, 60) } : { title: sets > 1 ? `Set ${set}` : "Set", text } });
      out.push({ type: 2, count: b.repeat, next: b.steps.length + 1 });
      out.push({ type: 1, lap: { hidden: true }, view: {} });
      for (const s of b.steps) out.push(active(s));
    } else if (b.note) {
      // A reminder: the planner's screen shape (as before a warm-up), with the reminder's words.
      out.push({ type: 1, view: { title: plain(b.note.title).slice(0, 20), text: plain(b.note.text).slice(0, 60) } });
      out.push(active(b));
    } else if (b.kind === "run") {
      // A work step on its own starts a lap, without a screen first (as the planner does it).
      out.push({ type: 1, lap: { hidden: true }, view: {} });
      out.push(active(b));
    } else {
      out.push({ type: 1, view: { title: title(b), text: join(length(b), bpm(b)) } });
      out.push(active(b));
    }
  }
  const end = o.endText ?? "Workout done";
  out.push({ type: 1, lap: { hidden: true }, view: {} });
  out.push({ phase: "finished", view: { title: "Finished", text: end } });
  out.push({ view: { text: end, field: ["Duration"] } });
  return out.map((x) => JSON.stringify(x));
}

export function guideManifest(w: Workout, o: GuideOptions = {}): string {
  return JSON.stringify({
    name: plain(w.name).slice(0, 30),
    version: "1.0",
    author: o.author ?? "Tartan",
    type: "sequence",
    usage: "workout",
    authorId: o.authorId ?? TARTAN_AUTHOR_ID,
    modificationTime: o.modified ?? Math.floor(Date.now() / 1000),
    image: [{ name: "icon.a64.png", type: "a64" }],
  });
}

/** The zip the watch takes: every file stored, in name order, as the planner packs it. */
export async function guidePackage(w: Workout, o: GuideOptions = {}): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const files = [
    { name: "icon.pxb", data: new Uint8Array(0) },
    { name: "main.js", data: enc.encode(o.runner ?? TARTAN_RUNNER) },
    { name: "manifest.jsn", data: enc.encode(guideManifest(w, o)) },
    ...guideSteps(w, o).map((s, i) => ({ name: `step${i}.js`, data: enc.encode(s) })),
  ].sort((a, b) => (a.name < b.name ? -1 : 1));
  return zip(files, o.modified ? new Date(o.modified * 1000) : new Date(), { store: true, unix: true });
}
