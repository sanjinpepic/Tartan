import { expect, test } from "bun:test";
import { evenSplits, raceWeek } from "../src/race-week.ts";

test("race week: only in the last seven days, with the day's focus", () => {
  expect(raceWeek({ distance_km: 10, days_to_go: 8 })).toBeNull();
  expect(raceWeek({ distance_km: 10, days_to_go: -1 })).toBeNull();
  expect(raceWeek({ distance_km: 10, days_to_go: 6 })!.focus.title).toBe("Taper");
  expect(raceWeek({ distance_km: 10, days_to_go: 2 })!.focus.title).toBe("Short and sharp");
  expect(raceWeek({ distance_km: 10, days_to_go: 1 })!.focus.title).toBe("Rest, or a shake-out");
  expect(raceWeek({ distance_km: 10, days_to_go: 0 })!.focus.title).toBe("Race day");
});

test("even pacing from the target, else the prediction; checkpoints on the way", () => {
  const w = raceWeek({ distance_km: 10, target_s: 3000, days_to_go: 3 })!;
  expect(w.pacing).toMatchObject({ pace_s: 300, from: "target", checkpoints: [{ at_km: 5, time_s: 1500 }] });
  const half = raceWeek({ distance_km: 21.0975, predicted_s: 6300, days_to_go: 3 })!;
  expect(half.pacing!.from).toBe("predicted");
  expect(half.pacing!.checkpoints.map((c) => c.at_km)).toEqual([5, 10, 10.55]);
  expect(raceWeek({ distance_km: 10, days_to_go: 3 })!.pacing).toBeNull();
});

test("fuel by how long the race takes", () => {
  expect(raceWeek({ distance_km: 10, target_s: 3000, days_to_go: 3 })!.fuel.during[0]).toContain("Nothing needed");
  const marathon = raceWeek({ distance_km: 42.195, target_s: 4 * 3600, days_to_go: 3 })!;
  expect(marathon.fuel.during[0]).toContain("60 to 90 g");
  expect(marathon.fuel.before[0]).toContain("8 to 10 g per kg");
  expect(marathon.checklist).toContain("Gels counted and packed");
});

test("even splits: a kilometre each, the last what's left", () => {
  const s = evenSplits(10.5, 3150);
  expect(s).toHaveLength(11);
  expect(s.at(-1)).toMatchObject({ km: 11, distance_m: 500, pace_s: 300 });
  expect(Math.round(s.at(-1)!.cumulative_s)).toBe(3150);
});
