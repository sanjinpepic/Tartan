import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { checkWorkout, guideManifest, guidePackage, guideSteps, type Workout } from "../src/workout/guide.ts";
import { MAIN_JS } from "../src/workout/suunto-runner.ts";

// Captured from the Suunto app, so only in the owner's checkout (scripts/owner-overlay.sh): the
// tests against them are skipped elsewhere.
const FIXTURE = new URL("./fixtures/suunto-workouts.json", import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixtures: any = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;
const RUNNER = MAIN_JS ?? "";
const captured = test.skipIf(!fixtures || !MAIN_JS);

// The two workouts made in the Suunto app's planner for the capture of 18 Oct 2026.
const WARM = { kind: "warmup", duration_s: 900, hr: [130, 140] } as const;
const REPS = (n: number) => ({ repeat: n, steps: [{ kind: "run", distance_m: 1000, hr: [150, 160] }, { kind: "recover", duration_s: 60, hr: [100, 110] }] }) as const;
const COOL = { kind: "cooldown", duration_s: 900, hr: [100, 110] } as const;
const SUUNTO = { endText: "SuuntoPlus™ guide ended" };

captured("the step runner is the captured one", () => {
  expect(createHash("sha256").update(RUNNER).digest("hex")).toBe(fixtures.main_js_sha256);
});

captured("a workout's steps are the planner's, byte for byte", () => {
  const one: Workout = { name: "test", blocks: [WARM, REPS(5), COOL] as never };
  expect(guideSteps(one, SUUNTO)).toEqual(fixtures.ua82weak.steps);
  // Two sets (titled Set 1 and Set 2), the cool-down between them as it was planned.
  const two: Workout = { name: "test 4", blocks: [WARM, REPS(5), COOL, REPS(3)] as never };
  expect(guideSteps(two, SUUNTO)).toEqual(fixtures.yzrm8dyx.steps);
  // Speed (27-30 km/h), pace (4:30-5:00 /km) and power (200-210 W) targets, each a work step
  // on its own between the sets.
  const three: Workout = {
    name: "test 4",
    blocks: [
      WARM, REPS(5), COOL,
      { kind: "run", duration_s: 300, speed: [27, 30] },
      { kind: "run", duration_s: 300, pace: [270, 300] },
      { kind: "run", distance_m: 1000, power: [200, 210] },
      REPS(3),
    ] as never,
  };
  expect(guideSteps(three, SUUNTO)).toEqual(fixtures.sr89ubaw.steps);
});

test("a single run, and what the watch can't take", () => {
  const easy = guideSteps({ name: "Easy", blocks: [{ kind: "run", duration_s: 2700, hr: [130, 145], title: "Run" }] });
  expect(JSON.parse(easy[0]!)).toEqual({ type: 1, lap: { hidden: true }, view: {} });
  expect(JSON.parse(easy[1]!).view.title).toBe("Run");
  expect(JSON.parse(easy[1]!).target[1]).toEqual({ input: "Step Duration", value: 2700, onReach: 1, index: 1 });
  expect(JSON.parse(easy.at(-2)!)).toEqual({ phase: "finished", view: { title: "Finished", text: "Workout done" } });
  expect(() => checkWorkout({ name: "x", blocks: [{ kind: "run", duration_s: 600, hr: [150, 140] }] })).toThrow(/low to high/);
  expect(() => checkWorkout({ name: "x", blocks: [{ kind: "run", duration_s: 600, hr: [140, 150], pace: [270, 300] }] })).toThrow(/one target/);
  expect(() => checkWorkout({ name: "x", blocks: [{ kind: "run", duration_s: 600, pace: [300, 270] }] })).toThrow(/fast to slow/);
  expect(() => checkWorkout({ name: "x", blocks: [{ kind: "run", hr: [120, 130] }] })).toThrow(/time or a distance/);
  expect(() => checkWorkout({ name: "x", blocks: [{ repeat: 1, steps: [WARM] }] as never })).toThrow(/2 to 30/);
});

test("a step without a heart-rate range: the captured shape with the range left out", () => {
  const [intro, step] = guideSteps({ name: "Gym", blocks: [{ kind: "run", duration_s: 1800, title: "Strength" }] }).map((x) => JSON.parse(x));
  expect(intro).toEqual({ type: 1, lap: { hidden: true }, view: {} });
  expect(step).toEqual({
    endOnLap: true,
    phase: "interval",
    view: { title: "Strength", field: ["HeartRate", { input: "Remaining Step Duration", targetIndex: "0" }] },
    target: [{ input: "Step Duration", value: 1800, onReach: 1, index: 0 }, { input: "ManualLap", onReach: 1 }],
  });
});

test("the manifest and the zip: stored files in name order, the name in plain letters", async () => {
  const w: Workout = { name: "Tue 6 × 800 m – hills", blocks: [WARM, REPS(6), COOL] as never };
  expect(JSON.parse(guideManifest(w, { modified: 1792322109 }))).toMatchObject({ name: "Tue 6 x 800 m - hills", author: "Tartan", type: "sequence", usage: "workout", modificationTime: 1792322109 });
  const z = await guidePackage(w, { modified: 1792322109 });
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const end = z.length - 22;
  let at = dv.getUint32(end + 16, true);
  const names: string[] = [];
  for (let i = 0; i < dv.getUint16(end + 10, true); i++) {
    expect(dv.getUint16(at + 10, true)).toBe(0); // stored
    expect(dv.getUint32(at + 38, true)).toBe(0x81a40000);
    const len = dv.getUint16(at + 28, true);
    names.push(new TextDecoder().decode(z.subarray(at + 46, at + 46 + len)));
    at += 46 + len;
  }
  expect(names).toEqual(["icon.pxb", "main.js", "manifest.jsn", "step0.js", "step1.js", "step10.js", "step11.js", "step2.js", "step3.js", "step4.js", "step5.js", "step6.js", "step7.js", "step8.js", "step9.js"]);
});

// ------------------------------------------------------------------ on a simulated Run 2

import { WatchSession } from "../src/protocol/session.ts";
import { FakeWatch, type FakeWatchOptions } from "../src/sim/fake-watch.ts";

const sim = (folder?: string) => {
  const nav = {
    ids: [], descriptor: "", types: {}, writes: [] as string[],
    plugins: { ids: ["ua82weak"], dirs: ["emmc", "emmc/data", "emmc/data/Data"], files: {}, folder },
  } as NonNullable<FakeWatchOptions["navigation"]>;
  return { nav, s: new WatchSession(new FakeWatch({ name: "Suunto Run 2", files: {}, navigation: nav, notifySize: 120 }), { chunkDelayMs: 0, frameGapMs: 0 }) };
};

test("puts a workout on the watch as the Suunto app does, and takes it off", async () => {
  const { nav, s } = sim();
  await s.open();
  const zip = await guidePackage({ name: "Tue 6 x 800 m", blocks: [WARM, REPS(6), COOL] as never });
  const seen: number[] = [];
  await s.installWorkout("tt4k2m9x", zip, (p) => p.sent && seen.push(p.sent));
  const p = nav.plugins!;
  expect(p.ids).toEqual(["ua82weak", "tt4k2m9x"]);
  expect(p.dirs).toContain("emmc/data/Data/Structured");
  expect(Buffer.from(p.files["/emmc/data/Data/Structured/tt4k2m9x.zip"]!).equals(Buffer.from(zip))).toBe(true);
  expect(seen.at(-1)).toBe(zip.length);
  expect([...new Set(nav.writes)].sort()).toEqual(["/Dev/FileSystem/DirectoryCreate", "/Dev/FileSystem/Stream", "/Plugin/Install"]);
  // Again: it's there, nothing sent.
  nav.writes!.length = 0;
  await expect(s.installWorkout("tt4k2m9x", zip)).rejects.toThrow(/already/);
  expect(nav.writes).toEqual([]);
  // Off again; the Suunto app's own is never touched.
  await s.removeWorkout("tt4k2m9x");
  expect(p.ids).toEqual(["ua82weak"]);
  await expect(s.removeWorkout("ua82weak")).rejects.toThrow(/didn't make/);
  expect(p.ids).toEqual(["ua82weak"]);
  expect(nav.writes).toEqual(["/Plugin/Uninstall"]);
});

test("writes nothing when the watch keeps workouts elsewhere", async () => {
  const { nav, s } = sim("/emmc/other");
  await s.open();
  await expect(s.installWorkout("tt4k2m9x", await guidePackage({ name: "x", blocks: [WARM] as never }))).rejects.toThrow(/nothing was sent/);
  expect(nav.writes).toEqual([]);
});

// ------------------------------------------------------------------ from the plan, the coming week

import { hrRange, paceRange, reconcile, workoutFor, workoutKey } from "../src/workout/from-plan.ts";

test("plan sessions become watch workouts", () => {
  expect(hrRange("Z2, 135-148 bpm")).toEqual([135, 148]);
  expect(hrRange("4:50-5:00 /km")).toBeNull();
  expect(hrRange("130–145", true)).toEqual([130, 145]);
  expect(paceRange("4:35-4:45 /km, 2 min jog between")).toEqual([275, 285]);
  expect(paceRange("Z2, 135-148 bpm")).toBeNull();
  // Steady: one step from the duration and the target's range; the name gets its weekday.
  const easy = workoutFor({ date: "2026-10-20", kind: "easy", title: "Easy run", duration_min: 45, target: "Z2, 135-148 bpm" });
  expect(easy).toEqual({ workout: { name: "Tue Easy run", blocks: [{ kind: "run", duration_s: 2700, hr: [135, 148], title: "Run" }] } });
  // The session's own pace range comes before the zone; no range at all: the plan's zone.
  const zones = [{ name: "Long run", heart_rate: "130-142 bpm" }];
  expect(workoutFor({ date: "2026-10-25", kind: "long", title: "Long run", distance_km: 18, target: "5:50-6:10 /km" }, zones)).toMatchObject({ workout: { blocks: [{ distance_m: 18000, pace: [350, 370] }] } });
  expect(workoutFor({ date: "2026-10-25", kind: "long", title: "Long run", distance_km: 18, target: "Z2, last 2 km steady" }, zones)).toMatchObject({ workout: { blocks: [{ distance_m: 18000, hr: [130, 142] }] } });
  // Steps from the coach: a repeat of one becomes plain steps, of more a repeat.
  const reps = workoutFor({
    date: "2026-10-22", kind: "intervals", title: "6 × 800 m", target: "3:50 /km",
    steps: [{ steps: [WARM as never] }, { repeat: 6, steps: [{ kind: "run", distance_m: 800, hr: [165, 175] }, { kind: "recover", duration_s: 90, hr: [110, 130] }] }, { repeat: 1, steps: [COOL as never] }],
  });
  expect(reps).toMatchObject({ workout: { name: "Thu 6 × 800 m", blocks: [{ kind: "warmup" }, { repeat: 6 }, { kind: "cooldown" }] } });
  // Strength: each exercise a screen saying what and how many, then its sets, each a work step
  // the lap button ends and a rest counting down (a runner's basic routine sized to the session
  // when the coach named none).
  const gym = workoutFor({ date: "2026-10-21", kind: "strength", title: "Gym", duration_min: 30 }) as { workout: Workout };
  expect(gym.workout.name).toBe("Wed Gym");
  expect(gym.workout.blocks).toHaveLength(6);
  expect(gym.workout.blocks[0]).toEqual({ repeat: 3, note: { title: "Squat", text: "3 x 12" }, steps: [{ kind: "run", title: "Squat", duration_s: 66 }, { kind: "recover", title: "Rest", duration_s: 90 }] });
  // With your logs: next time's weight on the screen.
  const loaded = workoutFor({ date: "2026-10-21", kind: "strength", title: "Gym", exercises: [{ id: "back_squat", sets: 4, reps: 6 }] }, [], null, { back_squat: { kg: 62.5 } }) as { workout: Workout };
  expect(loaded.workout.blocks[0]).toMatchObject({ repeat: 4, note: { text: "4 x 6 at 62.5 kg" }, steps: [{ title: "Back squat" }, { kind: "recover", duration_s: 120 }] });
  expect(guideSteps(loaded.workout)[0]).toBe(JSON.stringify({ type: 1, view: { title: "Back squat", text: "4 x 6 at 62.5 kg" } }));
  const named = workoutFor({ date: "2026-10-21", kind: "strength", title: "Gym", exercises: [{ id: "plank", sets: 2, seconds: 45 }, { id: "single_leg_rdl", sets: 3, reps: 6, each_side: true }] }) as { workout: Workout };
  expect(named.workout.blocks.map((b) => (b as { note?: { text: string } }).note?.text)).toEqual(["2 x 45 s", "3 x 6 each side"]);
  expect(workoutFor({ date: "2026-10-21", kind: "easy", title: "Easy", duration_min: 40, target: "5:40 /km" })).toMatchObject({ workout: { blocks: [{ duration_s: 2400, title: "Run" }] } });
  // A pace range in the target; the zone's pace when there's nothing else.
  expect(workoutFor({ date: "2026-10-21", kind: "tempo", title: "Tempo", duration_min: 20, target: "4:50-5:00 /km" })).toMatchObject({ workout: { blocks: [{ pace: [290, 300] }] } });
  expect(workoutFor({ date: "2026-10-21", kind: "intervals", title: "Reps", distance_km: 5 }, [{ name: "Interval", pace: "4:35-4:45 /km" }])).toMatchObject({ workout: { blocks: [{ pace: [275, 285] }] } });
  // Speed and power from the coach's steps.
  expect(workoutFor({ date: "2026-10-21", kind: "cross", title: "Bike", steps: [{ steps: [{ kind: "run", duration_s: 3600, speed: [27, 30] }] }, { repeat: 4, steps: [{ kind: "run", duration_s: 300, power: [250, 270] }, { kind: "recover", duration_s: 180 }] }] })).toMatchObject({ workout: { blocks: [{ speed: [27, 30] }, { repeat: 4, steps: [{ power: [250, 270] }, { kind: "recover" }] }] } });
  expect(workoutFor({ date: "2026-10-21", kind: "cross", title: "Gym" })).toEqual({ reason: "it has no duration or distance" });
  expect(workoutFor({ date: "2026-10-21", kind: "rest", title: "Rest" })).toEqual({ reason: "a rest day" });
});

test("the watch keeps the coming week: past, changed and unknown Tartan ones off, new ones on, the Suunto app's and pinned ones left", () => {
  const w = (name: string) => ({ name, blocks: [{ kind: "run", duration_s: 1800, hr: [130, 140] }] }) as Workout;
  const tue = { date: "2026-10-20", key: workoutKey("2026-10-20", w("Tue")), workout: w("Tue") };
  const thu = { date: "2026-10-22", key: workoutKey("2026-10-22", w("Thu")), workout: w("Thu") };
  const sent = {
    ttold001: { date: "2026-10-17", key: "x", name: "Sat" }, // its day has passed
    tttue001: { date: tue.date, key: tue.key, name: "Tue" }, // still wanted: stays
    ttthu001: { date: thu.date, key: "changed", name: "Thu" }, // the coach changed it
    ttpace01: { date: "9999-12-31", key: "pinned:ttpace01", name: "Race pacing", pinned: true }, // stays
  };
  // ttelse01: Tartan's, but this phone has no record of it (a broken-off send): off, so nothing doubles.
  const onWatch = ["ua82weak", "ttold001", "tttue001", "ttthu001", "ttelse01", "ttpace01"];
  const { remove, install } = reconcile(onWatch, sent, [tue, thu, thu], "2026-10-19");
  expect(remove.sort()).toEqual(["ttelse01", "ttold001", "ttthu001"]);
  // Thursday once, though the plan listed it twice.
  expect(install).toEqual([thu]);
});

test("long steady sessions remind you to drink and fuel", () => {
  const fuel = { gel: true, drink: true, gelMin: 30, drinkMin: 15, fromMin: 75 };
  const r = workoutFor({ date: "2026-10-25", kind: "long", title: "Long run", duration_min: 100, target: "Z2, 130-142 bpm" }, [], fuel);
  if (!("workout" in r)) throw new Error(r.reason);
  const b = r.workout.blocks as Array<{ duration_s: number; note?: { title: string } }>;
  expect(b.map((x) => x.duration_s)).toEqual([900, 900, 900, 900, 900, 1500]);
  expect(b.map((x) => x.note?.title ?? "")).toEqual(["", "Drink", "Fuel", "Drink", "Fuel", "Drink"]);
  // On the watch: the reminder screen, then the step; the first piece starts a lap.
  const steps = guideSteps(r.workout).map((x) => JSON.parse(x));
  expect(steps[0]).toEqual({ type: 1, lap: { hidden: true }, view: {} });
  expect(steps[2]).toEqual({ type: 1, view: { title: "Drink", text: "A few sips" } });
  expect(steps[4]).toEqual({ type: 1, view: { title: "Fuel", text: "Gel and a drink" } });
  // Short runs stay one step; a distance-only long run is timed from its pace.
  expect((workoutFor({ date: "2026-10-25", kind: "easy", title: "Easy", duration_min: 45 }, [], fuel) as { workout: Workout }).workout.blocks).toHaveLength(1);
  const dist = workoutFor({ date: "2026-10-25", kind: "long", title: "Long", distance_km: 20, target: "5:50-6:10 /km" }, [], fuel) as { workout: Workout };
  expect(dist.workout.blocks).toHaveLength(8); // 120 min in 15-minute pieces
  // Gels only: a piece every 30 min; drinks only: every 15, no gels; both off: one step.
  const only = (f: Partial<typeof fuel>) => (workoutFor({ date: "2026-10-25", kind: "long", title: "Long", duration_min: 100 }, [], { ...fuel, ...f }) as { workout: Workout }).workout.blocks as Array<{ note?: { title: string; text: string } }>;
  expect(only({ drink: false }).map((x) => x.note?.text ?? "")).toEqual(["", "Take a gel", "Take a gel"]);
  expect(only({ gel: false }).map((x) => x.note?.title ?? "")).toEqual(["", "Drink", "Drink", "Drink", "Drink", "Drink"]);
  expect(only({ gel: false, drink: false })).toHaveLength(1);
});

// ------------------------------------------------------------------ how it went

import { reviewWorkout } from "../src/workout/review.ts";

test("a session laid over its recording: each rep against its target", () => {
  // 10 min warm-up, then 3 × (1 km at 4:30-4:40 /km, 2 min easy), 1 s samples.
  const w: Workout = {
    name: "Reps",
    blocks: [
      { kind: "warmup", duration_s: 600, hr: [120, 140] },
      { repeat: 3, steps: [{ kind: "run", distance_m: 1000, pace: [270, 280] }, { kind: "recover", duration_s: 120 }] },
    ],
  };
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] = [];
  const velocity: number[] = [];
  let t = 0;
  let d = 0;
  const run = (secs: number, v: number, hr: number) => {
    for (let k = 0; k < secs; k++) {
      time.push(t++);
      distance.push(d);
      velocity.push(v);
      heartrate.push(hr);
      d += v;
    }
  };
  run(600, 2.8, 132); // warm-up in range
  run(272, 1000 / 272, 165); // rep 1: 4:32 /km, on target
  run(120, 2.5, 140);
  run(276, 1000 / 276, 168); // rep 2: 4:36, on target
  run(120, 2.5, 140);
  run(292, 1000 / 292, 170); // rep 3: 4:52, 12 s slow
  run(60, 2.5, 140); // stopped during the last recovery
  const r = reviewWorkout(w, { time, distance, heartrate, velocity });
  expect(r.steps.map((s) => s.label)).toEqual(["Warm up", "Rep 1/3", "Recover 1/3", "Rep 2/3", "Recover 2/3", "Rep 3/3", "Recover 3/3"]);
  expect(r.steps[0]).toMatchObject({ verdict: "on target", actual: "132 bpm" });
  expect(r.steps[1]).toMatchObject({ verdict: "on target", actual: "4:32 /km" });
  expect(r.steps[5]).toMatchObject({ verdict: "slow", off: "12 s/km" });
  expect(r.steps[6]!.seconds).toBeLessThan(120);
  expect(r.work).toEqual({ onTarget: 2, total: 3 });
  expect(r.summary).toBe("2 of 3 reps on target; rep 3/3 12 s/km slow.");
  // Nothing recorded: every step not done.
  expect(reviewWorkout(w, {}).summary).toBe("Nothing recorded to compare.");
});

import { withoutWeekday } from "../src/workout/from-plan.ts";

test("the day goes in front of a workout's name once", () => {
  expect(withoutWeekday("Sunday Long Run")).toBe("Long Run");
  expect(withoutWeekday("Tuesday Easy Run")).toBe("Easy Run");
  expect(withoutWeekday("Thu: Tempo")).toBe("Tempo");
  expect(withoutWeekday("Long run (Saturday)")).toBe("Long run");
  expect(withoutWeekday("Easy run - Wed")).toBe("Easy run");
  expect(withoutWeekday("Gym Strength")).toBe("Gym Strength");
  expect(withoutWeekday("Sunrise run")).toBe("Sunrise run");
  expect(withoutWeekday("Saturday")).toBe("Saturday");
  expect((workoutFor({ date: "2026-10-18", kind: "long", title: "Sunday Long Run", duration_min: 60 }) as { workout: Workout }).workout.name).toBe("Sun Long Run");
});
