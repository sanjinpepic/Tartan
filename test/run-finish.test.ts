import { describe, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import { Plans } from "../src/plan.ts";
import { compareRuns, effortsFrom, lastLike, recordsOf, runRule, shiftPaceText } from "../src/run-finish.ts";
import type { SessionReview, StepReview } from "../src/workout/review.ts";

const step = (verdict: StepReview["verdict"], target = "4:30-4:45 /km", seconds = 200): StepReview => ({ label: "Rep", kind: "run", target, actual: "", inRange: null, verdict, off: "", seconds, metres: 800 });
const review = (steps: StepReview[], inRange: number | null = null): SessionReview => ({ steps, work: { onTarget: steps.filter((s) => s.verdict === "on target").length, total: steps.length }, inRange, summary: "" });

describe("next time for a run", () => {
  test("every rep on target or quicker: 5 s/km faster", () => {
    expect(runRule("intervals", review([...Array(5)].map(() => step("on target")).concat(step("fast"))))).toEqual({ rule: "faster", why: "All 6 reps on target or quicker: 5 s/km faster next time.", shift_s: -5 });
  });
  test("most reps slow: 5 s/km easier; some off: the same; reps missed: the same session", () => {
    expect(runRule("intervals", review([step("slow"), step("slow"), step("slow"), step("on target")]))).toMatchObject({ rule: "easier", shift_s: 5 });
    expect(runRule("intervals", review([step("on target"), step("on target"), step("slow"), step("on target")]))).toMatchObject({ rule: "hold", why: "3 of 4 reps on target: the same paces until they all are." });
    expect(runRule("intervals", review([step("on target"), step("not done"), step("not done"), step("not done")]))).toMatchObject({ rule: "hold", why: "1 of 4 reps done: the same session again." });
  });
  test("heart-rate sessions: right on, or slow down when above", () => {
    const hr = (v: StepReview["verdict"], inRange: number) => review([step(v, "130-148 bpm", 2400)], inRange);
    expect(runRule("easy", hr("on target", 0.9))).toMatchObject({ rule: "on target", why: "90% of it in the heart-rate range: right on." });
    expect(runRule("easy", hr("high", 0.3))).toMatchObject({ rule: "slow down" });
    expect(runRule("easy", hr("on target", 0.55))!.why).toBe("On average in range, but only 55% of the time: start slower so it stays there.");
    expect(runRule("easy", null)).toBeNull();
  });
  test("a pace change moves every pace range in the target", () => {
    expect(shiftPaceText("6 × 800 m at 4:30-4:45 /km, then 5:00 – 5:10/km", -5)).toBe("6 × 800 m at 4:25-4:40 /km, then 4:55 – 5:05/km");
  });
});

describe("records and last time", () => {
  test("the fastest stretch of each distance, from the time series", () => {
    // 6 km: 5:00 /km, with the third km at 4:00.
    const t: number[] = [];
    const d: number[] = [];
    let time = 0;
    for (let m = 0; m <= 6000; m += 10) {
      t.push(time);
      d.push(m);
      time += m >= 2000 && m < 3000 ? 2.4 : 3;
    }
    const e = effortsFrom(t, d);
    expect(e.map((x) => x.name)).toEqual(["400m", "1k", "1 mile", "5k"]);
    expect(e.find((x) => x.name === "1k")!.time_s).toBe(240);
    expect(e.find((x) => x.name === "5k")!.time_s).toBe(1440);
  });
  test("ranked against earlier runs; a tie or a first time is no record", () => {
    const earlier = [[{ name: "5k", time_s: 1500 }], [{ name: "5k", time_s: 1480 }, { name: "1k", time_s: 270 }]];
    expect(recordsOf([{ name: "5k", time_s: 1470 }, { name: "1k", time_s: 280 }, { name: "10k", time_s: 3000 }], earlier)).toEqual([
      { name: "5k", time_s: 1470, rank: 1, vs: 1480 },
      { name: "1k", time_s: 280, rank: 2, vs: 270 },
    ]);
    expect(recordsOf([{ name: "5k", time_s: 1480 }], earlier)).toEqual([{ name: "5k", time_s: 1480, rank: 2, vs: 1480 }]);
  });
  test("against the last run like it: more distance per heartbeat is fitter", () => {
    const prev = { id: "a", start: "2026-10-12T07:00:00Z", distance_km: 8, moving_min: 44, avg_hr: 145 };
    const now = { id: "b", start: "2026-10-19T07:00:00Z", distance_km: 8, moving_min: 43, avg_hr: 140 };
    const c = compareRuns(now, prev);
    expect(c).toMatchObject({ verdict: "fitter", pace: "5:30", now: { pace: "5:23", hr: 140 } });
    expect(c.text).toBe("8 s/km faster at 5 bpm lower: 6% more distance per heartbeat. Fitter.");
    const kinds: Record<string, string> = { b: "easy", c: "tempo" };
    const tempo = { id: "c", start: "2026-10-15T07:00:00Z", distance_km: 8 };
    expect(lastLike(now, [prev, tempo, now], (id) => kinds[id])!.id).toBe("a");
  });
});

test("a pace change is applied to the session, shows why, and comes off with undo or a new plan", async () => {
  const lib = new Library(new MemoryDisk());
  const plans = new Plans(lib);
  const mon = "2026-10-19";
  const plan = { title: "P", summary: "S", weeks: [{ start: mon, focus: "Build", sessions: [{ date: "2026-10-21", kind: "intervals" as const, title: "6 × 800 m", target: "4:30-4:45 /km", steps: [{ repeat: 6, steps: [{ kind: "run" as const, distance_m: 800, pace: [270, 285] }, { kind: "recover" as const, duration_s: 90 }] }] }] }] };
  await plans.save(plan);
  await plans.adjust("2026-10-21", "intervals", -5, "All 6 reps on target: 5 s/km faster next time.");
  const s = async () => (await plans.view(new Date("2026-10-19T12:00:00"))).weeks[0]!.days[2]!.sessions[0] as unknown as { target: string; steps: Array<{ steps: Array<{ pace?: number[] }> }>; adjusted?: { shift_s: number } };
  expect((await s()).target).toBe("4:25-4:40 /km");
  expect((await s()).steps[0]!.steps[0]!.pace).toEqual([265, 280]);
  expect((await s()).adjusted).toMatchObject({ shift_s: -5 });
  await plans.adjust("2026-10-21", "intervals", 0, "", undefined, true);
  expect((await s()).target).toBe("4:30-4:45 /km");
  await plans.adjust("2026-10-21", "intervals", 5, "slow");
  await plans.save(plan);
  expect((await s()).adjusted).toBeUndefined();
  await expect(plans.adjust("2026-10-22", "intervals", 5, "x")).rejects.toThrow();
});
