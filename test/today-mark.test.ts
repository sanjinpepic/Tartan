/** Tartan's T on Today (src/today-mark.ts): the day's state, in order, and a best from the last day. */
import { expect, test } from "bun:test";
import { freshBest, todayMark } from "../src/today-mark.ts";

test("the mark takes on the day: a best, race day, a go-easy morning, race week, a session, rest", () => {
  const tempo = [{ title: "Tempo" }];
  expect(todayMark({ sessions: [], plan: true })).toEqual({ state: "rest", label: "Rest day" });
  expect(todayMark({ sessions: [], plan: false })).toEqual({ state: "rest", label: "Nothing planned today" });
  expect(todayMark({ sessions: tempo, plan: true, level: "ready" })).toEqual({ state: "session", label: "Tempo today" });
  expect(todayMark({ sessions: tempo, plan: true, level: "go easy" })).toEqual({ state: "tired", label: "Go easy today" });
  expect(todayMark({ sessions: [], plan: true, level: "rest" }).state).toBe("tired");
  expect(todayMark({ sessions: tempo, plan: true, raceDays: 4 })).toEqual({ state: "race", label: "Race week: 4 days to go" });
  expect(todayMark({ sessions: [{ title: "Race" }], plan: true, raceDays: 0, level: "go easy" })).toEqual({ state: "race", label: "Race day" });
  // A tired morning in race week is the quieter one; a best outranks everything.
  expect(todayMark({ sessions: tempo, plan: true, raceDays: 4, level: "go easy" }).state).toBe("tired");
  expect(todayMark({ sessions: tempo, plan: true, raceDays: 0, level: "rest", best: "5k" })).toEqual({ state: "best", label: "New best today: 5 km" });
  expect(todayMark({ sessions: [], plan: true, raceDays: 30 }).state).toBe("rest");
});

test("a best from the last day: beats every earlier run, not a first effort, not older", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const run = (start: string, five: number, ten?: number) => ({ start, efforts: [{ name: "5k", time_s: five }, ...(ten ? [{ name: "10k", time_s: ten }] : [])] });
  const before = [run("2026-11-01T07:00:00Z", 1500, 3100), run("2026-11-10T07:00:00Z", 1480)];
  expect(freshBest([...before, run("2026-11-21T07:00:00Z", 1470)], now)).toBe("5k");
  // The longer distance when both are bests.
  expect(freshBest([...before, run("2026-11-21T07:00:00Z", 1470, 3050)], now)).toBe("10k");
  expect(freshBest([...before, run("2026-11-21T07:00:00Z", 1490)], now)).toBeNull();
  // Two days ago is not today's.
  expect(freshBest([...before, run("2026-11-19T07:00:00Z", 1470)], now)).toBeNull();
  // The very first run has nothing to beat.
  expect(freshBest([run("2026-11-21T07:00:00Z", 1470)], now)).toBeNull();
});
