import { describe, expect, test } from "bun:test";
import { drift, verdict } from "../src/durability.ts";
import { effort } from "../src/race-pace.ts";

/** A run sampled every second: speed (m/s), heart rate and altitude as functions of the second. */
function run(minutes: number, speed: (t: number) => number, hr: (t: number) => number, alt?: (d: number) => number) {
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] = [];
  const altitude: number[] = [];
  let d = 0;
  for (let t = 0; t <= minutes * 60; t++) {
    if (t) d += speed(t);
    time.push(t);
    distance.push(d);
    heartrate.push(Math.round(hr(t)));
    if (alt) altitude.push(alt(d));
  }
  return { time, distance, heartrate, ...(alt ? { altitude } : {}) };
}

describe("durability", () => {
  test("an even run at an even heart rate holds to the end", () => {
    const d = drift(run(90, () => 3, () => 145))!;
    expect(d.drift_pct).toBe(0);
    expect(d.holds_until_min).toBeNull();
    expect(d.steady).toBe(true);
    expect(d.minutes).toBe(90);
    expect(verdict(d.drift_pct)).toBe("held");
  });

  test("heart rate creeping up from minute 50 at the same pace: drift, and where it started", () => {
    const d = drift(run(100, () => 3, (t) => (t < 3000 ? 140 : 140 + (t - 3000) / 120)))!;
    expect(d.drift_pct).toBeGreaterThan(5);
    expect(verdict(d.drift_pct)).not.toBe("held");
    // The fall below the opening 20 minutes shows a little after it starts (5% takes a while).
    expect(d.holds_until_min).toBeGreaterThanOrEqual(50);
    expect(d.holds_until_min).toBeLessThan(75);
  });

  test("hills: an even effort up and down isn't counted as drift (it would be without the altitude)", () => {
    // Flat for 45 minutes, then 1 km up at 6% and 1 km down, over and over, at an even effort:
    // slower up, quicker down (by the same cost the analysis uses), the same heart rate.
    const hillsFrom = 45 * 60 * 3;
    const grade = (d: number) => (d < hillsFrom ? 0 : (d - hillsFrom) % 2000 < 1000 ? 0.06 : -0.06);
    const alt = (d: number) => (d < hillsFrom ? 0 : (d - hillsFrom) % 2000 < 1000 ? ((d - hillsFrom) % 2000) * 0.06 : 60 - (((d - hillsFrom) % 2000) - 1000) * 0.06);
    let d = 0;
    const r = run(
      100,
      () => {
        const v = 3 / effort(grade(d));
        d += v;
        return v;
      },
      () => 145,
      alt,
    );
    const adjusted = drift(r)!;
    expect(adjusted.hills_adjusted).toBe(true);
    expect(Math.abs(adjusted.drift_pct)).toBeLessThan(2);
    const { altitude: _a, ...flat } = r;
    expect(drift(flat)!.drift_pct).toBeGreaterThan(3);
  });

  test("intervals aren't steady; under an hour, no heart rate or standing still gives nothing", () => {
    const reps = drift(run(70, (t) => (Math.floor(t / 180) % 2 ? 2 : 4.5), () => 150))!;
    expect(reps.steady).toBe(false);
    expect(drift(run(45, () => 3, () => 145))).toBeNull();
    expect(drift({ time: [0, 1, 2], distance: [0, 3, 6] })).toBeNull();
    expect(drift(run(90, () => 0.2, () => 100))).toBeNull();
  });

  test("speed alone (no distance column) is enough", () => {
    const r = run(70, () => 3, () => 145);
    const d = drift({ time: r.time, heartrate: r.heartrate, velocity: r.time.map(() => 3) })!;
    expect(d.minutes).toBe(70);
    expect(d.drift_pct).toBe(0);
  });
});

test("the summary reads as one thought: drift, what it means, where it slipped", async () => {
  const { durability } = await import("../src/durability.ts");
  const { Library } = await import("../src/library.ts");
  const { MemoryDisk } = await import("../src/disk.ts");
  const empty = await durability(new Library(new MemoryDisk()));
  expect(empty.runs).toEqual([]);
  expect(empty.summary).toMatch(/No steady run of an hour/);
});
