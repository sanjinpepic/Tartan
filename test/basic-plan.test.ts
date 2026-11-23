import { describe, expect, test } from "bun:test";
import { Analytics } from "../src/analytics.ts";
import { basicPlan, makeBasicPlan, type BasicInput } from "../src/basic-plan.ts";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import { Plans, type PlanInput } from "../src/plan.ts";

const HARD = new Set(["intervals", "tempo", "hills"]);
const input = (o: Partial<BasicInput> = {}): BasicInput => ({
  today: "2026-10-27",
  availability: { days_per_week: 4, hours_per_week: 5, long_run_day: "Sun" },
  recent: { runs: 14, run_km_per_week: 28, longest_run_km: 14 },
  hr: { max_hr: 190, zone_limits: [114, 133, 152, 171] },
  five_k_s: 25 * 60,
  ...o,
});
const all = (p: PlanInput) => p.weeks.flatMap((w) => w.sessions);
const dow = (d: string) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;

/** The coach's rules, checked on any plan. */
function followsTheRules(p: PlanInput, i: BasicInput) {
  const s = all(p);
  expect(s.every((x) => x.date >= i.today)).toBe(true);
  // Never two hard days running, across weeks too.
  const hard = s.filter((x) => HARD.has(x.kind)).map((x) => Date.parse(x.date));
  for (let k = 1; k < hard.length; k++) expect(hard[k]! - hard[k - 1]!).toBeGreaterThan(86_400_000);
  for (const w of p.weeks) {
    expect(w.sessions.filter((x) => HARD.has(x.kind)).length).toBeLessThanOrEqual(2);
    expect(w.sessions.filter((x) => x.kind === "long").length).toBeLessThanOrEqual(1);
    if (i.availability.days_per_week) expect(w.sessions.length).toBeLessThanOrEqual(i.availability.days_per_week);
    if (i.availability.hours_per_week) expect(w.target_hours!).toBeLessThanOrEqual(i.availability.hours_per_week);
  }
  // At most 10% more than the previous full week (easier, taper and race weeks aren't full).
  const full = (f: string) => f === "Build" || f === "Getting going";
  for (let k = 1; k < p.weeks.length; k++) {
    const prev = p.weeks.slice(0, k).filter((w) => full(w.focus)).at(-1);
    if (prev) expect(p.weeks[k]!.target_hours!).toBeLessThanOrEqual(prev.target_hours! * 1.1 + 0.05);
  }
  // About 80% of running time easy: in a hard session only its work steps are hard (not the warm-up, jogs or cool-down).
  const work = (x: (typeof s)[number]) => (x.steps ?? []).reduce((n, b) => n + (b.repeat ?? 1) * b.steps.filter((st) => st.kind === "run").reduce((m, st) => m + (st.duration_s ?? 0) / 60, 0), 0);
  const total = s.filter((x) => x.kind !== "race").reduce((n, x) => n + (x.duration_min ?? 0), 0);
  const hardMin = s.filter((x) => HARD.has(x.kind)).reduce((n, x) => n + work(x), 0);
  expect(1 - hardMin / total).toBeGreaterThan(0.75);
}

describe("a plan without AI", () => {
  test("eight weeks without a race: four days, Sunday long run, every fourth week easier", () => {
    const i = input();
    const p = basicPlan(i);
    expect(p.weeks).toHaveLength(8);
    expect(p.weeks[0]!.start).toBe("2026-10-26");
    expect(p.weeks.map((w) => w.focus)).toEqual(["Getting going", "Build", "Build", "Easier week", "Build", "Build", "Build", "Easier week"]);
    expect(all(p).filter((x) => x.kind === "long").every((x) => dow(x.date) === 6)).toBe(true);
    expect(p.zones?.map((z) => z.name)).toEqual(["Easy", "Tempo", "Intervals"]);
    expect(p.zones![0]).toMatchObject({ heart_rate: "114-132 bpm", pace: "6:06-6:45 /km" });
    followsTheRules(p, i);
  });

  test("to a race: a taper, race week ends with the race, rest the day before", () => {
    const i = input({ race: { name: "Autumn 10k", distance_km: 10, date: "2026-12-13", target_s: 50 * 60 }, availability: { days_per_week: 5, long_run_day: "Sat" } });
    const p = basicPlan(i);
    expect(p.weeks.at(-1)!.focus).toBe("Race week");
    expect(p.weeks.at(-2)!.focus).toBe("Taper");
    const last = all(p).at(-1)!;
    expect(last).toMatchObject({ date: "2026-12-13", kind: "race", title: "Autumn 10k", distance_km: 10, target: "50:00, even effort" });
    expect(all(p).some((x) => x.date === "2026-12-12")).toBe(false);
    expect(all(p).filter((x) => x.kind === "long").every((x) => dow(x.date) === 5)).toBe(true);
    expect(p.target_date).toBe("2026-12-13");
    followsTheRules(p, i);
  });

  test("no runs lately and no 5 km to go by: gentle, by heart rate, steps for the watch", () => {
    const i = input({ recent: { runs: 0, run_km_per_week: 0, longest_run_km: 0 }, five_k_s: undefined, availability: { days_per_week: 3 } });
    const p = basicPlan(i);
    const q = all(p).find((x) => HARD.has(x.kind))!;
    expect(q.steps?.length).toBeGreaterThan(0);
    expect(JSON.stringify(q.steps)).toContain('"hr"');
    expect(p.summary).toContain("paced by heart rate");
    followsTheRules(p, i);
  });

  test("saved as a real plan the app checks; refused when there is one already", async () => {
    const lib = new Library(new MemoryDisk());
    const plans = new Plans(lib);
    const saved = await makeBasicPlan(new Analytics(lib), plans, { today: "2026-10-27" });
    expect(saved.model).toBe("Tartan's rules (no AI)");
    expect(saved.weeks).toHaveLength(8);
    await expect(makeBasicPlan(new Analytics(lib), plans, { today: "2026-10-27" })).rejects.toThrow(/plan already/);
  });
});

test("a target date in words, read without AI", async () => {
  const { readTargetDay } = await import("../src/basic-plan.ts");
  const t = "2026-10-27";
  expect(readTargetDay("14 March", t)).toBe("2027-03-14");
  expect(readTargetDay("March 14, 2028", t)).toBe("2028-03-14");
  expect(readTargetDay("1st Dec", t)).toBe("2026-12-01");
  expect(readTargetDay("end of June", t)).toBe("2027-06-30");
  expect(readTargetDay("February", t)).toBe("2027-02-28");
  expect(readTargetDay("2027-05-02", t)).toBe("2027-05-02");
  expect(readTargetDay("31 February", t)).toBeNull();
  expect(readTargetDay("whenever", t)).toBeNull();
  // Without a race, the plan runs to that week.
  const p = basicPlan(input({ until: "2026-12-20" }));
  expect(p.weeks.at(-1)!.start).toBe("2026-12-14");
  expect(p.target_date).toBe("2026-12-20");
});

test("a long plan for a big week with no hours given: it stops building, and no run is endless", async () => {
  // 70 km weeks, 3 days, a date 18 weeks off: 8% a week used to compound to 10-hour easy runs.
  const i = input({ availability: { days_per_week: 3, long_run_day: "Sun" }, recent: { runs: 30, run_km_per_week: 70, longest_run_km: 24 }, until: "2027-02-28" });
  const p = basicPlan(i);
  expect(p.weeks.length).toBeGreaterThan(15);
  const first = p.weeks[0]!.target_hours!;
  expect(Math.max(...p.weeks.map((w) => w.target_hours!))).toBeLessThanOrEqual(first * 1.5 + 0.1);
  expect(all(p).every((x) => (x.duration_min ?? 0) <= 150)).toBe(true);
  // And it saves (the plan's own checks allow up to 600 minutes a session).
  const lib = new Library(new MemoryDisk());
  await expect(new Plans(lib).save(p)).resolves.toBeDefined();
});
