/**
 * Tartan's own workout runner (src/workout/runner.ts, written clean-room from
 * docs/cleanroom/workout-runner-spec.md) against the captured one: both get the same stand-ins
 * for the watch's functions and the same events, and every call to the watch must match, in
 * order and with the same arguments, and so must what they answer.
 */
import { expect, test } from "bun:test";
import { guideSteps, type Workout } from "../src/workout/guide.ts";
import { MAIN_JS } from "../src/workout/suunto-runner.ts";

// Suunto's runner is only in the owner's checkout (scripts/owner-overlay.sh): skipped elsewhere.
const RUNNER = MAIN_JS ?? "";
const captured = test.skipIf(!RUNNER);
import { TARTAN_RUNNER } from "../src/workout/runner.ts";

type Trace = string[];

/** Load a runner as the watch would (the file is a function body that returns the handler). */
function boot(source: string, steps: string[], trace: Trace): (event: number) => unknown {
  const env: Record<string, unknown> = {
    evalFile: (path: string) => {
      trace.push(`evalFile ${path}`);
      const n = Number(/step(\d+)\.js$/.exec(path)?.[1]);
      // Past the last step there is no file: nothing comes back.
      return steps[n] !== undefined ? JSON.parse(steps[n]!) : undefined;
    },
    initStep: (...a: unknown[]) => void trace.push(`initStep ${JSON.stringify(a)}`),
    open: (...a: unknown[]) => void trace.push(`open ${JSON.stringify(a)}`),
    close: (...a: unknown[]) => void trace.push(`close ${JSON.stringify(a)}`),
    unload: (...a: unknown[]) => void trace.push(`unload ${JSON.stringify(a)}`),
    playIndication: (...a: unknown[]) => void trace.push(`playIndication ${JSON.stringify(a)}`),
    $: { put: (...a: unknown[]) => void trace.push(`put ${JSON.stringify(a)}`) },
  };
  let popup: unknown;
  Object.defineProperty(env, "zPopupShown", { get: () => popup, set: (v) => (trace.push(`zPopupShown=${v}`), (popup = v)), enumerable: true });
  // Sloppy-mode `with`, so the runner's bare names (and its zPopupShown) land on the stand-ins.
  const handler = new Function("env", `with (env) { ${source.replace(/^\/\/.*\n/, "")} }`)(env) as (e: number, i?: unknown, d?: unknown) => unknown;
  return (event) => {
    try {
      const out = handler(event, {}, 0);
      if (out !== undefined) trace.push(`returns ${JSON.stringify(out)}`);
      return out;
    } catch (e) {
      trace.push(`throws ${(e as Error).name}`);
      return undefined;
    }
  };
}

function compare(steps: string[], events: number[]): { mine: Trace; theirs: Trace } {
  const mine: Trace = [];
  const theirs: Trace = [];
  const a = boot(TARTAN_RUNNER, steps, mine);
  const b = boot(RUNNER, steps, theirs);
  for (const e of events) {
    mine.push(`-- ${e}`);
    theirs.push(`-- ${e}`);
    a(e);
    b(e);
  }
  return { mine, theirs };
}

const WARM = { kind: "warmup", duration_s: 600, hr: [120, 140] } as const;
const COOL = { kind: "cooldown", duration_s: 300 } as const;
const REPS = (n: number) => ({ repeat: n, steps: [{ kind: "run", distance_m: 800, pace: [230, 250] }, { kind: "recover", duration_s: 90 }] });
const WORKOUTS: Workout[] = [
  { name: "Intervals", blocks: [WARM, REPS(5), COOL] as never },
  { name: "Two sets", blocks: [WARM, REPS(3), { kind: "recover", duration_s: 180 }, REPS(2), COOL] as never },
  { name: "Easy", blocks: [{ kind: "run", duration_s: 2700, hr: [130, 145] }] as never },
  { name: "Long with fuel", blocks: [WARM, { kind: "run", distance_m: 16000, note: { title: "Fuel", text: "Gel and a drink" } }, COOL] as never },
  { name: "Strength", blocks: [{ repeat: 3, note: { title: "Squat", text: "3 x 10 at 40 kg" }, steps: [{ kind: "run", duration_s: 60, title: "Squat" }, { kind: "recover", duration_s: 90 }] }] as never },
];

/** Hand-made step lists that reach what Tartan's own workouts don't: a bare screen (the beep), a text-only screen, views as arrays, nested-looking repeats. */
const RAW: string[][] = [
  // Every step but a repeat marker has a view (Tartan writes none without; the spec says so).
  [{ target: [1], view: { field: ["HR"] } }, { type: 2, count: 2, next: 2 }, { type: 1, view: {} }, { endOnLap: true, target: [2], view: { title: "Run" } }, { type: 1, view: { text: "Done" } }, { view: [{ title: "a" }, { field: ["HR"] }] }],
  [{ type: 1, view: { title: "Go" } }, { type: 1, view: {} }, { lap: {}, endOnLap: true, view: { title: "Lap" } }, { type: 2, count: 3, next: 1 }, { type: 1, view: {}, lap: {} }, { type: 1, view: { title: "x", text: "y" } }, { view: { text: "end" } }],
].map((l) => l.map((x) => JSON.stringify(x)));

test("the runner is small, ES5 and starts as the watch expects", () => {
  expect(TARTAN_RUNNER.startsWith("// 20613\n")).toBe(true);
  expect(new TextEncoder().encode(TARTAN_RUNNER).length).toBeLessThan(2200);
  expect(TARTAN_RUNNER).not.toMatch(/=>|`|\blet\b|\bconst\b|\bclass\b|\bDate\b/);
  expect(TARTAN_RUNNER).not.toBe(RUNNER);
});

captured("a workout run through as on the watch: same calls, same answers", () => {
  for (const w of WORKOUTS) {
    const steps = guideSteps(w);
    // Start, the first tick starts step 0, then each step ends by its target or the lap button,
    // with the view asked for and ticks between, to the end.
    const events = [128, 1, 4096];
    for (let i = 0; i < steps.length * 2; i++) events.push(1, 1, 1, 1, i % 3 === 2 ? 4 : 16384, 4096, 4, 1);
    const { mine, theirs } = compare(steps, events);
    expect(mine).toEqual(theirs);
  }
});

captured("random events (ticks, laps, targets reached, view asked) give the same calls", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = [1, 1, 1, 4, 16384, 4096, 128];
  const lists = [...WORKOUTS.map((w) => guideSteps(w)), ...RAW];
  for (let round = 0; round < 600; round++) {
    const steps = lists[round % lists.length]!;
    const events = [128, ...Array.from({ length: 60 }, () => pick[Math.floor(rand() * pick.length)]!)];
    const { mine, theirs } = compare(steps, events);
    expect(mine).toEqual(theirs);
  }
});
