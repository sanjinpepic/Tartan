import { describe, expect, test } from "bun:test";
import { lapSeconds, setsFromLaps } from "../src/strength/from-watch.ts";

const plan = [
  { id: "squat", sets: 3, rest_s: 90 },
  { id: "plank", sets: 2, rest_s: 45 },
];
const laps = (xs: number[]) => xs.map((elapsed_s) => ({ elapsed_s }));

describe("strength sets from the watch's laps", () => {
  test("a lap at every step: sets and rests alternate, rests told apart by their length", () => {
    expect(setsFromLaps(plan, laps([52, 90, 48, 91, 50, 89, 40, 45, 38]))).toEqual([
      { id: "squat", done: 3, of: 3 },
      { id: "plank", done: 2, of: 2 },
    ]);
  });
  test("laps only at the lap button: every lap a set", () => {
    expect(setsFromLaps(plan, laps([52, 48, 50, 40, 38]))).toEqual([
      { id: "squat", done: 3, of: 3 },
      { id: "plank", done: 2, of: 2 },
    ]);
  });
  test("stopped early: what was done, nothing more; stray presses don't count", () => {
    expect(setsFromLaps(plan, laps([52, 3, 90, 47]))).toEqual([
      { id: "squat", done: 2, of: 3 },
      { id: "plank", done: 0, of: 2 },
    ]);
    expect(setsFromLaps(plan, [])).toEqual([
      { id: "squat", done: 0, of: 3 },
      { id: "plank", done: 0, of: 2 },
    ]);
  });
  test("laps from Strava or a FIT file, in seconds", () => {
    expect(lapSeconds([{ elapsed_time: 52 }, { total_elapsed_time: 90_000 }, { total_timer_time: 48 }, { name: "x" }])).toEqual(laps([52, 90, 48]));
  });
});
