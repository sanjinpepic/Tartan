/** Milestones (src/milestones.ts) and the season recap (src/season.ts): what counts, once only, a quiet first look, the maths, an empty history. */
import { expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { detectMilestones, FILE, keepMilestones, loadMilestones, onToday, putAway, weeksOnTarget, type MilestoneActivity } from "../src/milestones.ts";
import { seasonRecap } from "../src/season.ts";
import { todayMark } from "../src/today-mark.ts";

const DAY = 86400_000;
const NOW = Date.parse("2026-11-21T18:00:00Z");
const at = (daysAgo: number, hour = 8) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10) + `T${String(hour).padStart(2, "0")}:00:00Z`;
const run = (id: string, daysAgo: number, km: number, o: Partial<MilestoneActivity> = {}): MilestoneActivity => ({ id, start: at(daysAgo), sport: "Run", distance_km: km, moving_min: km * 5.5, ...o });

/** Twelve weeks of steady running: three runs a week of 8, 8 and 12 km, the newest first. */
function steady(weeks = 12, from = 7): MilestoneActivity[] {
  const out: MilestoneActivity[] = [];
  for (let w = 0; w < weeks; w++) for (const [d, km] of [[0, 8], [2, 8], [4, 12]] as const) out.push(run(`r${w}-${d}`, from + w * 7 + d, km));
  return out;
}

test("a longest run, a first over 20 km instead of a plain longest, and nothing for the first few runs", () => {
  const acts = [...steady(), run("long", 1, 16)];
  const m = detectMilestones({ activities: acts, efforts: [], now: NOW });
  const longest = m.filter((x) => x.kind === "longest");
  expect(longest.at(-1)).toMatchObject({ id: "longest:long", title: "Longest run yet: 16 km", activity: "long", figure: "16" });
  expect(longest.at(-1)!.note).toBe("4 km past your old longest. Eat well and keep tomorrow easy.");
  expect(longest.at(-1)!.note).not.toContain("!");
  // The very first run was 12 km: no "first over 10 km" for a first run, and none later either.
  expect(m.some((x) => x.id === "first:10")).toBe(false);
  expect(detectMilestones({ activities: [run("a", 9, 5), run("b", 8, 6), run("c", 7, 5), run("d", 6, 10.4)], efforts: [], now: NOW }).map((x) => x.title)).toEqual(["First run over 10 km"]);
  const twenty = detectMilestones({ activities: [...steady(), run("big", 1, 21.3)], efforts: [], now: NOW });
  // Over 20 and the half's distance at once: the bigger one, and no plain "longest" for the same run.
  expect(twenty.filter((x) => x.activity === "big").map((x) => x.id)).toEqual(["first:half"]);
  expect(detectMilestones({ activities: [run("a", 3, 5), run("b", 2, 11)], efforts: [], now: NOW })).toEqual([]);
});

test("bests at the standard distances, once there's something to beat, led by the longest", () => {
  const e = (id: string, daysAgo: number, k5: number, k10?: number) => ({ id, start: at(daysAgo), efforts: [{ name: "5k", time_s: k5 }, ...(k10 ? [{ name: "10k", time_s: k10 }] : [])] });
  const efforts = [e("a", 40, 1500, 3100), e("b", 30, 1490, 3090), e("c", 20, 1495, 3080), e("d", 10, 1480)];
  // d: 5k beats three before it; c's 10k beat only two (not yet).
  let m = detectMilestones({ activities: [], efforts, now: NOW }).filter((x) => x.kind === "best");
  expect(m.map((x) => x.id)).toEqual(["best:d"]);
  expect(m[0]).toMatchObject({ title: "New 5 km best: 24:40", figure: "24:40", figure_label: "5 km best" });
  expect(m[0]!.note).toBe("10 s under your old best. Earned. Keep the next two days easy.");
  m = detectMilestones({ activities: [], efforts: [...efforts, e("x", 1, 1470, 3000)], now: NOW }).filter((x) => x.id === "best:x");
  expect(m[0]!.title).toBe("New 10 km best: 50:00");
  expect(m[0]!.note).toContain("with a 5 km best on the way");
});

test("biggest week and month only after eight weeks; races; the weekly target weeks running", () => {
  const acts = [...steady(10, 14), run("w1", 9, 15), run("w2", 8, 15), run("w3", 7.5, 14)];
  const m = detectMilestones({ activities: acts, efforts: [], now: NOW });
  const weeks = m.filter((x) => x.kind === "week");
  expect(weeks).toHaveLength(1);
  expect(weeks[0]!.title).toBe("Biggest week yet: 44.0 km");
  // Steady weeks of 28 km aren't each "biggest", and the first weeks don't count.
  expect(detectMilestones({ activities: steady(4), efforts: [], now: NOW }).some((x) => x.kind === "week")).toBe(false);

  const races = detectMilestones({ activities: [run("x", 3, 10.1, { name: "Autumn 10k race", elapsed_min: 46.5 }), run("p", 4, 8, { name: "Race pace tempo" }), run("q", 2, 21.2)], efforts: [], raceIds: ["q"], now: NOW }).filter((x) => x.kind === "race");
  expect(races.map((x) => x.id)).toEqual(["race:x", "race:q"]);
  expect(races[0]).toMatchObject({ title: "Race done: Autumn 10k race", note: "46:30 for 10.1 km. Well run. The easy days after it are part of the training." });
  expect(detectMilestones({ activities: [run("g", 1, 21.3)], efforts: [], race: { name: "Helsinki Half", distance_km: 21.1, date: at(1).slice(0, 10) }, now: NOW }).find((x) => x.kind === "race")?.title).toBe("Race done: Helsinki Half");

  // Weeks, never days: 4 and 8 running, and a missed week starts again quietly.
  const wk = (met: Array<boolean | null>) => met.map((x, i) => ({ week: new Date(Date.parse("2026-01-05") + i * 7 * DAY).toISOString().slice(0, 10), met: x }));
  const s = detectMilestones({ activities: [], efforts: [], weeks: wk([true, true, true, true, true, true, true, true, false, true]), now: NOW }).filter((x) => x.kind === "steady");
  expect(s.map((x) => x.title)).toEqual(["Weekly target met 4 weeks running", "Weekly target met 8 weeks running"]);
  expect(s[1]!.note).toBe("Eight weeks of doing what you said you'd do. That's how it gets built; keep the easy ones easy.");
  const ten = detectMilestones({ activities: [], efforts: [], weeks: wk([true, false, true, true, true, false, true, true, true, true, true, true]), now: NOW }).filter((x) => x.id.startsWith("steady12"));
  expect(ten).toHaveLength(1);
});

test("swims and rides, lightly", () => {
  const swim = (id: string, d: number, km: number): MilestoneActivity => ({ id, start: at(d), sport: "Swim", distance_km: km });
  const m = detectMilestones({ activities: [swim("s0", 40, 0.8), ...Array.from({ length: 9 }, (_, i) => swim(`s${i + 1}`, 30 - i, 1.2))], efforts: [], now: NOW });
  expect(m.find((x) => x.id === "swim:1k")?.activity).toBe("s1");
  expect(m.find((x) => x.id === "swims10:2026")).toMatchObject({ title: "Ten swims this year", activity: "s9" });
  expect(m.every((x) => x.weight < 30)).toBe(true);
});

test("each fires once, the first look is quiet (the demo keeps its newest), old ones come in quiet, and putting one away takes its workout's others", async () => {
  const disk = new MemoryDisk();
  const old = { id: "longest:a", kind: "longest" as const, date: "2026-10-01", activity: "a", title: "Longest run yet: 18 km", note: "n", weight: 70 };
  // First look: quiet, even a fresh one.
  let items = await keepMilestones(disk, [old, { ...old, id: "best:b", activity: "b", date: "2026-11-21", kind: "best", weight: 78 }], NOW);
  expect(items.every((x) => x.quiet)).toBe(true);
  expect(onToday(items, NOW)).toEqual([]);
  // New ones after that show; an old one coming in (a late sync) doesn't; the same id never twice.
  const fresh = [
    { ...old, id: "best:c", activity: "c", date: "2026-11-21", kind: "best" as const, weight: 78 },
    { ...old, id: "first:20", activity: "c", date: "2026-11-21", kind: "first" as const, weight: 75 },
    { ...old, id: "week:2026-09-01", activity: "z", date: "2026-09-07", kind: "week" as const, weight: 45 },
  ];
  items = await keepMilestones(disk, [old, ...fresh], NOW);
  items = await keepMilestones(disk, [old, ...fresh], NOW + 3600_000);
  expect(items).toHaveLength(5);
  expect(onToday(items, NOW).map((x) => x.id)).toEqual(["best:c", "first:20"]);
  // A couple of days on, it's gone from Today (it stays on the workout and in the season).
  expect(onToday(items, NOW + 3 * DAY)).toEqual([]);
  // Put away: the other one the same run earned goes with it.
  expect(onToday(await putAway(disk, "best:c", NOW), NOW)).toEqual([]);
  const kept = JSON.parse((await disk.readText(FILE))!) as { items: Array<{ id: string; seen?: string }> };
  expect(kept.items.filter((x) => x.seen).map((x) => x.id)).toEqual(["best:c", "first:20"]);

  // The demo's first look keeps its newest, to show.
  const demo = await keepMilestones(new MemoryDisk(), [old, fresh[0]!, fresh[2]!], NOW, { sample: true });
  expect(onToday(demo, NOW).map((x) => x.id)).toEqual(["best:c"]);
  // And the T sparks for it.
  expect(todayMark({ sessions: [], plan: true, milestone: "New 5 km best: 24:40" })).toEqual({ state: "best", label: "New 5 km best: 24:40" });
});

test("the loader: a backfilled history, then a new run's milestone found once", async () => {
  const disk = new MemoryDisk();
  let acts = steady();
  const src = { disk, activities: async () => acts, efforts: async () => [], goals: async () => ({ weekly_km: 25 }), planWeeks: async () => [] };
  const first = await loadMilestones(src, NOW - 2 * DAY);
  expect(first.items.length).toBeGreaterThan(0);
  expect(first.items.every((x) => x.quiet)).toBe(true);
  // Twelve weeks over 25 km: 4, 8 and 12 running (all quiet, from the first look).
  expect(first.items.filter((x) => x.kind === "steady").map((x) => x.id.split(":")[1])).toEqual(["4", "8", "12"]);
  acts = [...acts, run("today", 0, 17)];
  const next = await loadMilestones(src, NOW);
  expect(onToday(next.items, NOW).map((x) => x.id)).toEqual(["longest:today"]);
  expect((await loadMilestones(src, NOW)).items).toHaveLength(next.items.length);
  // Weeks on target: complete weeks only, oldest first.
  expect(first.weeks.at(-1)).toMatchObject({ met: true, run_km: 28 });
});

test("an empty history: nothing found, a kind empty season", async () => {
  const disk = new MemoryDisk();
  const r = await loadMilestones({ disk, activities: async () => [], efforts: async () => [], goals: async () => ({}), planWeeks: async () => [] }, NOW);
  expect(r).toEqual({ items: [], weeks: [] });
  // No first look without anything in: the first sync's history is the first look, quiet.
  expect(await disk.readText(FILE)).toBeNull();
  expect(weeksOnTarget([], {}, [], NOW)).toEqual([]);
  const s = seasonRecap({ range: "year", label: "2026", from: "2026-01-01", to: "2026-11-21", activities: [], efforts: [], weeks: [], milestones: [] });
  expect(s.empty).toBe(true);
  expect(s.closing).toBe("Nothing in the season yet. It starts with the first run, however short.");
  expect(s.biggest_week).toBeNull();
  expect(s.longest).toBeNull();
  expect(s.weeks.length).toBe(47);
  expect(s.weeks.every((w) => w.km === 0 && w.met === null)).toBe(true);
});

test("the season's maths: totals, biggest week, longest, bests against before, races, weeks on target, the cross-training line", () => {
  const acts: MilestoneActivity[] = [
    run("old", 400, 30),
    run("a", 19, 10, { elevation_m: 50 }),
    run("b", 18, 12),
    run("c", 10, 21.2, { name: "Helsinki Half race", elapsed_min: 105 }),
    { id: "s", start: at(5), sport: "Swim", distance_km: 1.5, moving_min: 35 },
    { id: "s2", start: at(4), sport: "Swim", distance_km: 1, moving_min: 25 },
    { id: "bike", start: at(3), sport: "Ride", distance_km: 42.4, moving_min: 90 },
  ];
  const efforts = [
    { id: "old", start: at(400), efforts: [{ name: "5k", time_s: 1400 }] },
    { id: "a", start: at(19), efforts: [{ name: "5k", time_s: 1450 }] },
    { id: "c", start: at(10), efforts: [{ name: "5k", time_s: 1380 }, { name: "Half-Marathon", time_s: 6290 }] },
  ];
  const weeks = weeksOnTarget(acts, { weekly_km: 20 }, [], NOW);
  const milestones = detectMilestones({ activities: acts, efforts, weeks, now: NOW }).map((m) => ({ ...m, found: "x" }));
  const s = seasonRecap({ range: "year", label: "2026", from: "2026-01-01", to: "2026-11-21", activities: acts, efforts, weeks, milestones });
  expect(s.run).toEqual({ km: 43.2, minutes: Math.round(43.2 * 5.5), runs: 3, climb_m: 50 });
  expect(s.longest).toMatchObject({ id: "c", km: 21.2 });
  expect(s.biggest_week!.km).toBe(22);
  expect(s.bests.map((b) => [b.name, b.time_s, b.pb])).toEqual([["5k", 1380, true], ["Half-Marathon", 6290, false]]);
  expect(s.races).toEqual([{ id: "c", date: at(10).slice(0, 10), name: "Helsinki Half race", km: 21.2, time_s: 6300 }]);
  expect(s.cross).toMatchObject({ swims: 2, swim_km: 2.5, rides: 1, ride_km: 42, line: "Alongside the running: 2 swims (2.5 km) and 1 ride (42 km)." });
  expect(s.weeks_met).toBe(2);
  expect(s.weeks_with_target).toBeGreaterThan(40);
  expect(s.closing).toBe("1 race and 43 km in 2026 so far. Well run; rest a little before you build again.");
  expect(s.closing).not.toContain("!");
  // A plan's season: only its weeks.
  const p = seasonRecap({ range: "plan", label: "Build to the half", from: at(21).slice(0, 10), to: at(0).slice(0, 10), activities: acts, efforts, weeks, milestones });
  expect(p.weeks.length).toBeLessThanOrEqual(5);
  expect(p.run.runs).toBe(3);
  // Someone who started this season: their weeks from their first workout, not from January.
  const fresh = acts.filter((a) => a.id !== "old");
  expect(seasonRecap({ range: "year", label: "2026", from: "2026-01-01", to: "2026-11-21", activities: fresh, efforts: [], weeks: [], milestones: [] }).weeks[0]!.week).toBe("2026-11-02");
});
