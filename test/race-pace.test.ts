import { expect, test } from "bun:test";
import { clock, effort, minetti, pacingWorkout, parseTime, raceSplits } from "../src/race-pace.ts";
import { checkWorkout } from "../src/workout/guide.ts";
import { metres, type LngLat } from "../src/routes.ts";

// A 10.5 km course due east from a start; a 60 m hill over km 3-4, back down over km 5.
const start: LngLat = [24.9, 60.17];
const east = (m: number): LngLat => [start[0] + m / (111_320 * Math.cos((start[1] * Math.PI) / 180)), start[1]];
const line = Array.from({ length: 106 }, (_, i) => east(i * 100));
const ele = line.map((_, i) => (i <= 20 ? 0 : i <= 40 ? (i - 20) * 3 : i <= 50 ? 60 - (i - 40) * 6 : 0));

test("the cost of a slope: Minetti on the flat, uphill dearer, half the downhill saving", () => {
  expect(minetti(0)).toBeCloseTo(3.6, 5);
  expect(effort(0)).toBe(1);
  expect(effort(0.05)).toBeGreaterThan(1.2);
  expect(effort(-0.05)).toBeLessThan(1);
  expect(effort(-0.05)).toBeGreaterThan(0.8);
  expect(clock(2900)).toBe("48:20");
  expect(clock(6300)).toBe("1:45:00");
  expect(parseTime("1:45:00")).toBe(6300);
  expect(parseTime("48:20")).toBe(2900);
  expect(parseTime("50")).toBe(3000);
  expect(parseTime("soon")).toBeNull();
});

test("even-effort splits add up to the target, slower up the hill, a named point every km", () => {
  const { splits, marks, line: withMarks } = raceSplits(line, ele, 50 * 60);
  expect(splits).toHaveLength(11);
  const total = line.reduce((n, p, i) => (i ? n + metres(line[i - 1]!, p) : 0), 0);
  expect(splits.at(-1)!.distance_m).toBe(Math.round(total - 10_000));
  expect(splits.at(-1)!.cumulative_s).toBeCloseTo(3000, 3);
  const flat = splits[0]!.pace_s;
  expect(splits[2]!.pace_s).toBeGreaterThan(flat + 10); // climbing
  expect(splits[4]!.pace_s).toBeLessThan(flat); // coming down
  expect(splits[2]!.climb_m).toBe(30);
  // Ten points at whole kilometres, on the line, named with the race time there.
  expect(marks).toHaveLength(10);
  expect(marks[0]!.name).toBe(`1k ${clock(splits[0]!.cumulative_s)}`);
  expect(metres(start, marks[4]!.point)).toBeCloseTo(5000, -1);
  expect(withMarks.length).toBe(line.length + 10);
  // Without heights: an even pace.
  const even = raceSplits(line, null, (total / 1000) * 300).splits;
  expect(even[0]!.pace_s).toBeCloseTo(300, 1);
  expect(even[7]!.pace_s).toBeCloseTo(300, 1);
});

test("the pacing workout: a step per km at its pace, the watch can take it", () => {
  const { splits } = raceSplits(line, ele, 3000);
  const w = pacingWorkout("Course pacing", splits);
  expect(w.blocks).toHaveLength(11);
  const first = w.blocks[0] as { distance_m: number; pace: [number, number]; title: string };
  expect(first).toMatchObject({ distance_m: 1000, title: "Km 1" });
  expect(first.pace[1] - first.pace[0]).toBe(10);
  expect(() => checkWorkout(w)).not.toThrow();
  // A 100 km course: two km a step.
  const long = Array.from({ length: 1001 }, (_, i) => east(i * 100));
  expect(pacingWorkout("Ultra", raceSplits(long, null, 36_000).splits).blocks).toHaveLength(50);
});
