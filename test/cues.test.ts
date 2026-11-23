import { expect, test } from "bun:test";
import { kmCue, kmsPassed, spokenTime } from "../src/cues.ts";

test("spoken times read naturally", () => {
  expect(spokenTime(292)).toBe("4 minutes 52");
  expect(spokenTime(300)).toBe("5 minutes");
  expect(spokenTime(61)).toBe("1 minute 1");
  expect(spokenTime(45)).toBe("45 seconds");
  expect(spokenTime(3720)).toBe("1 hour 2 minutes");
});

test("a kilometre's cue: split, time, heart rate and pace against today's target", () => {
  expect(kmCue(3, 292, 870)).toBe("Kilometre 3. Split 4 minutes 52. Time 14 minutes 30.");
  expect(kmCue(1, 292, 292, { hr: 151.6, target: [290, 300] })).toBe("Kilometre 1. Split 4 minutes 52. Time 4 minutes 52. Heart rate 152. On pace.");
  expect(kmCue(1, 280, 280, { target: [290, 300] })).toContain("A little fast");
  expect(kmCue(1, 310, 310, { target: [290, 300] })).toContain("A little slow");
});

test("kilometres passed between fixes", () => {
  expect(kmsPassed(950, 1010)).toEqual([1]);
  expect(kmsPassed(1010, 1990)).toEqual([]);
  expect(kmsPassed(1990, 4005)).toEqual([2, 3, 4]);
});
