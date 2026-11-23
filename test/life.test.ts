/** One-tap life changes (src/life.ts): ill, better, away, a busy week; taken with Undo (Plans.applyLife). */
import { expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import { rampFor, reshape } from "../src/life.ts";
import { Plans, type PlanInput, type PlanSession } from "../src/plan.ts";

const TODAY = "2026-11-10"; // a Tuesday
const plan = (): PlanInput => ({
  title: "10k",
  summary: "Build.",
  zones: [{ name: "Easy", heart_rate: "130-145 bpm" }],
  weeks: [
    {
      start: "2026-11-09",
      focus: "Build",
      sessions: [
        { date: "2026-11-09", kind: "easy", title: "Easy run", duration_min: 40 },
        { date: "2026-11-10", kind: "intervals", title: "6 × 800 m", duration_min: 55, steps: [{ repeat: 6, steps: [{ kind: "run", distance_m: 800, pace: [230, 240] }, { kind: "recover", duration_s: 90 }] }] },
        { date: "2026-11-11", kind: "easy", title: "Easy run", duration_min: 45, distance_km: 8 },
        { date: "2026-11-12", kind: "strength", title: "Gym", duration_min: 40 },
        { date: "2026-11-13", kind: "tempo", title: "Tempo", duration_min: 50 },
        { date: "2026-11-14", kind: "easy", title: "Easy run", duration_min: 30 },
        { date: "2026-11-15", kind: "long", title: "Long run", duration_min: 100, distance_km: 18 },
      ],
    },
    {
      start: "2026-11-16",
      focus: "Build",
      sessions: [
        { date: "2026-11-17", kind: "intervals", title: "5 × 1 km", duration_min: 55 },
        { date: "2026-11-19", kind: "easy", title: "Easy run", duration_min: 45 },
        { date: "2026-11-22", kind: "race", title: "Autumn 10k", distance_km: 10 },
      ],
    },
  ],
});
const all = (p: PlanInput) => p.weeks.flatMap((w) => w.sessions);
const on = (p: PlanInput, date: string) => all(p).filter((s) => s.date === date);

test("ill: rest today and the next two days; the past and other days as they were", () => {
  const r = reshape(plan(), { type: "ill" }, TODAY);
  expect(on(r.plan, "2026-11-09")[0]!.kind).toBe("easy");
  for (const d of ["2026-11-10", "2026-11-11", "2026-11-12"]) expect(on(r.plan, d).map((s) => [s.kind, s.title])).toEqual([["rest", "Rest: ill"]]);
  expect(on(r.plan, "2026-11-13")[0]!.kind).toBe("tempo");
  expect(r.memory).toBe("Ill from 10 Nov; rested.");
});

test("better after a few days: easy and a little shorter for 3 days, the long run capped", () => {
  expect(rampFor(2).span).toBe(3);
  const r = reshape(plan(), { type: "better", days: 2 }, "2026-11-13");
  const [tempo] = on(r.plan, "2026-11-13");
  expect(tempo).toMatchObject({ kind: "easy", title: "Easy run", duration_min: 38, target: "easy, 130-145 bpm", why: "Back after 2 days ill" });
  expect(tempo!.notes).toBe("Was Tempo: back after 2 days ill.");
  expect(on(r.plan, "2026-11-14")[0]).toMatchObject({ duration_min: 23 });
  // 100 min → 60 at most; the distance follows (18 km × 0.6 → 11 km).
  expect(on(r.plan, "2026-11-15")[0]).toMatchObject({ kind: "long", duration_min: 60, distance_km: 11 });
  // After the ramp: as planned.
  expect(on(r.plan, "2026-11-17")[0]!.kind).toBe("intervals");
});

test("better after a week: half for 3 days (no gym), then three quarters; after longer, two weeks; races never touched", () => {
  const week = reshape(plan(), { type: "better", days: 6 }, "2026-11-11");
  expect(on(week.plan, "2026-11-11")[0]).toMatchObject({ kind: "easy", duration_min: 23, distance_km: 4 });
  expect(on(week.plan, "2026-11-12")[0]).toMatchObject({ kind: "rest" });
  expect(on(week.plan, "2026-11-13")[0]).toMatchObject({ kind: "easy", duration_min: 25 });
  expect(on(week.plan, "2026-11-14")[0]).toMatchObject({ duration_min: 23 });
  // Seven days from the 11th take in the 17th: still easy, at three quarters.
  expect(on(week.plan, "2026-11-17")[0]).toMatchObject({ kind: "easy", duration_min: 41 });
  expect(on(week.plan, "2026-11-19")[0]).toMatchObject({ kind: "easy", duration_min: 45 });
  const long = reshape(plan(), { type: "better", days: 10 }, "2026-11-11");
  // Two weeks: the first at half (the 17th is day 7), the second at three quarters.
  expect(on(long.plan, "2026-11-17")[0]).toMatchObject({ kind: "easy", duration_min: 28 });
  expect(on(long.plan, "2026-11-19")[0]).toMatchObject({ kind: "easy", duration_min: 34 });
  expect(on(long.plan, "2026-11-22")[0]).toMatchObject({ kind: "race", title: "Autumn 10k" });
});

test("away: no training is rest, easy only keeps runs easy and drops the gym; a week off brings two easy days", () => {
  const none = reshape(plan(), { type: "away", from: "2026-11-11", to: "2026-11-13", train: "none" }, TODAY);
  expect(["2026-11-11", "2026-11-12", "2026-11-13"].map((d) => on(none.plan, d)[0]!.title)).toEqual(["Rest: away", "Rest: away", "Rest: away"]);
  expect(on(none.plan, "2026-11-14")[0]!.kind).toBe("easy");
  expect(none.said).toBe("No training 11 Nov to 13 Nov. The rest of the plan stays.");
  const easy = reshape(plan(), { type: "away", from: "2026-11-12", to: "2026-11-15", train: "easy" }, TODAY);
  expect(on(easy.plan, "2026-11-12")).toEqual([]);
  expect(on(easy.plan, "2026-11-13")[0]).toMatchObject({ kind: "easy", duration_min: 50 });
  expect(on(easy.plan, "2026-11-15")[0]).toMatchObject({ kind: "long", duration_min: 75 });
  const week = reshape(plan(), { type: "away", from: "2026-11-09", to: "2026-11-15", train: "none" }, TODAY);
  // Started in the past: from today. Back on Monday: Tuesday's intervals become easy.
  expect(on(week.plan, "2026-11-09")[0]!.kind).toBe("easy");
  expect(on(week.plan, "2026-11-17")[0]).toMatchObject({ kind: "easy", why: "Two easy days after time away" });
  expect(() => reshape(plan(), { type: "away", from: "2026-11-15", to: "2026-11-11", train: "none" }, TODAY)).toThrow(/start before/);
});

test("a busy week: easy runs at 60%, the long run at 75%, hard ones kept, the shortest easy run dropped", () => {
  const r = reshape(plan(), { type: "busy" }, TODAY);
  const week = all(r.plan).filter((s) => s.date >= TODAY && s.date <= "2026-11-15");
  expect(week.map((s: PlanSession) => [s.date, s.kind, s.duration_min])).toEqual([
    ["2026-11-10", "intervals", 55],
    ["2026-11-11", "easy", 27],
    ["2026-11-12", "strength", 40],
    ["2026-11-13", "tempo", 50],
    ["2026-11-15", "long", 75],
  ]);
  expect(on(r.plan, "2026-11-19")[0]!.duration_min).toBe(45);
});

test("taken at once with Undo; ill then Better now works on the sessions from before", async () => {
  const lib = new Library(new MemoryDisk());
  const plans = new Plans(lib);
  await plans.save(plan());
  const now = new Date(`${TODAY}T08:00:00`);
  const ill = await plans.applyLife({ type: "ill" }, now);
  expect(ill.changes.map((c) => `${c.type} ${c.date}`)).toEqual(["removed 2026-11-10", "removed 2026-11-11", "removed 2026-11-12"]);
  expect(await plans.life()).toEqual({ ill: { from: TODAY } });
  expect((await plans.lastChange(now.getTime()))?.source).toBe("life");
  // Two days later, better: Thursday's gym (put aside by the ill tap) comes back, and the days
  // after are eased.
  const later = new Date("2026-11-12T08:00:00");
  const back = await plans.applyLife({ type: "better", days: 2 }, later);
  expect(back.said).toMatch(/^Easy running until 14 Nov/);
  const cur = (await plans.current())!;
  expect(on(cur, "2026-11-12")[0]).toMatchObject({ kind: "strength" });
  expect(on(cur, "2026-11-13")[0]).toMatchObject({ kind: "easy", duration_min: 38 });
  // The days before stay as they were (the ill rest on the 10th and 11th).
  expect(on(cur, "2026-11-10")[0]!.title).toBe("Rest: ill");
  expect(await plans.life()).toEqual({ ill: null });
  // Undo takes the last change back: the plan as the ill tap left it.
  await plans.revert(later.getTime());
  expect(on((await plans.current())!, "2026-11-12")[0]!.title).toBe("Rest: ill");
  expect(on((await plans.current())!, "2026-11-13")[0]!.kind).toBe("tempo");
});

test("undoing I'm ill takes the ill state with it", async () => {
  const plans = new Plans(new Library(new MemoryDisk()));
  await plans.save(plan());
  const now = new Date(`${TODAY}T08:00:00`);
  await plans.applyLife({ type: "ill" }, now);
  await plans.revert(now.getTime());
  expect(await plans.life()).toEqual({ ill: null });
  expect(on((await plans.current())!, TODAY)[0]!.kind).toBe("intervals");
});
