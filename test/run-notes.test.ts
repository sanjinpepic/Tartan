/** Run notes (win, niggle, note), the watch's "How did it feel?", and what readiness makes of both. */
import { expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { CheckIns, readiness } from "../src/readiness.ts";
import { nigglePattern, recentFeelings, RunNotes } from "../src/run-notes.ts";
import { feelingOf } from "../src/sbem.ts";

test("the watch's feeling: 1-5, by number or by name; unanswered is nothing", () => {
  expect(feelingOf(3)).toBe(3);
  expect(feelingOf(0)).toBeUndefined();
  expect(feelingOf(6)).toBeUndefined();
  expect(feelingOf("Very good")).toBe(4);
  expect(feelingOf("very_good")).toBe(4);
  expect(feelingOf("poor")).toBe(1);
  expect(feelingOf(null)).toBeUndefined();
});

test("notes: add, per run, remove; a niggle needs nothing but where", async () => {
  const disk = new MemoryDisk();
  const n = new RunNotes(disk);
  await expect(n.add({ run: "r1", date: "2026-10-20", tag: "shout", text: "x" })).rejects.toThrow(/win, a niggle/);
  await expect(n.add({ run: "r1", date: "2026-10-20", tag: "note", text: "  " })).rejects.toThrow(/few words/);
  const win = await n.add({ run: "r1", date: "2026-10-20", tag: "win", text: "First sub-25 5k" });
  const nig = await n.add({ run: "r2", date: "2026-10-22", tag: "niggle", area: "calf" });
  expect(nig).toMatchObject({ tag: "niggle", area: "calf", text: "" });
  expect((await n.forRun("r1")).map((x) => x.text)).toEqual(["First sub-25 5k"]);
  // A run's niggle counts with the morning check's pain.
  const checks = new CheckIns(disk);
  await checks.save({ date: "2026-10-23", legs: 2, pain: { area: "calf", level: 2 } });
  const all = await checks.niggles(21, Date.parse("2026-10-24T08:00:00Z"));
  expect(all).toEqual([{ date: "2026-10-23", area: "calf", level: 2 }, { date: "2026-10-22", area: "calf", level: 1 }]);
  expect(nigglePattern(all)).toEqual([{ area: "calf", name: "calf", times: 2, last: "2026-10-23" }]);
  await n.remove(win.id);
  expect(await n.forRun("r1")).toEqual([]);
});

test("readiness: a run that felt poor, two that felt flat, a fresh niggle", () => {
  const poor = readiness(0, null, null, { feelings: [1, 4] });
  expect(poor.reasons).toContain("your last run felt poor on the watch");
  const flat = readiness(-20, { date: "d", legs: 1 }, null, { feelings: [2, 2, 5] });
  // Carrying fatigue, heavy legs and two flat runs: go easy.
  expect(flat).toMatchObject({ level: "go easy" });
  expect(flat.reasons).toContain("your last two runs felt flat on the watch");
  expect(readiness(0, null, null, { feelings: [3, 1] }).reasons).toEqual([]);
  const nig = readiness(0, null, null, { niggle: { area: "achilles", date: "d" } });
  expect(nig.reasons[0]).toMatch(/niggle in your Achilles/);
});

test("recent feelings: newest first, only answered ones", async () => {
  const lib = { activities: async () => [{ feeling: 2 }, {}, { feeling: 4 }] };
  expect(await recentFeelings(lib)).toEqual([2, 4]);
});
