import { describe, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import { planChanges, Plans, type PlanInput } from "../src/plan.ts";

const reps = (pace: [number, number]) => [{ repeat: 6, steps: [{ kind: "run" as const, distance_m: 800, pace }, { kind: "recover" as const, duration_s: 90 }] }];
const base = (): PlanInput => ({
  title: "10k",
  summary: "Build.",
  weeks: [
    { start: "2026-10-12", focus: "Build", sessions: [{ date: "2026-10-14", kind: "tempo", title: "Tempo", duration_min: 40 }] },
    {
      start: "2026-10-19",
      focus: "Build",
      sessions: [
        { date: "2026-10-21", kind: "intervals", title: "6 × 800 m", steps: reps([270, 285]) },
        { date: "2026-10-23", kind: "easy", title: "Easy run", duration_min: 45 },
        { date: "2026-10-24", kind: "strength", title: "Gym", duration_min: 40 },
      ],
    },
  ],
});
const NOW = new Date("2026-10-20T09:00:00");

describe("what a new plan changes", () => {
  test("moved, changed, added, removed, from today on; the past isn't looked at", () => {
    const next = base();
    next.weeks[0]!.sessions[0]!.duration_min = 99;
    next.weeks[1]!.sessions = [
      { date: "2026-10-22", kind: "intervals", title: "6 × 800 m", steps: reps([275, 290]), why: "Reps ran slow." },
      { date: "2026-10-23", kind: "easy", title: "Easy run", duration_min: 35 },
      { date: "2026-10-25", kind: "long", title: "Long run", duration_min: 90 },
    ];
    expect(planChanges(base(), next, "2026-10-20")).toEqual([
      { type: "moved", date: "2026-10-21", to: "2026-10-22", kind: "intervals", title: "6 × 800 m", detail: "Wed → Thu, reps 4:30-4:45 → 4:35-4:50 /km", why: "Reps ran slow.", small: true },
      { type: "changed", date: "2026-10-23", kind: "easy", title: "Easy run", detail: "45 min → 35 min", small: true },
      { type: "removed", date: "2026-10-24", kind: "strength", title: "Gym", detail: "strength", small: false },
      { type: "added", date: "2026-10-25", kind: "long", title: "Long run", detail: "long run · 1 h 30", small: false },
    ]);
  });
  test("zones and length count; the same plan changes nothing", () => {
    const next = base();
    next.zones = [{ name: "Easy", heart_rate: "130-148 bpm" }];
    next.weeks.push({ start: "2026-10-26", focus: "Build", sessions: [] });
    expect(planChanges(base(), next, "2026-10-20").map((c) => c.type)).toEqual(["zones", "length"]);
    expect(planChanges(base(), base(), "2026-10-20")).toEqual([]);
  });
});

describe("proposals", () => {
  const setup = async () => {
    const plans = new Plans(new Library(new MemoryDisk()));
    const first = await plans.submit(base(), {}, NOW);
    return { plans, first };
  };
  test("the first plan is saved; a change to it waits as a proposal; the same plan is no proposal", async () => {
    const { plans, first } = await setup();
    expect("saved" in first).toBe(true);
    const next = base();
    next.weeks[1]!.sessions[1]!.duration_min = 30;
    next.change_note = "Shorter easy run after a hot one.";
    const r = await plans.submit(next, { source: "weekly" }, NOW);
    expect("proposed" in r && r.proposed.changes).toHaveLength(1);
    expect((await plans.current())!.weeks[1]!.sessions[1]!.duration_min).toBe(45);
    expect((await plans.proposal())!.source).toBe("weekly");
    expect(await plans.submit(base(), {}, NOW)).toEqual({ unchanged: true });
  });
  test("accepted: the new plan with the past kept as it was; undo brings the old one back for a week", async () => {
    const { plans } = await setup();
    const next = base();
    next.weeks[0]!.sessions[0]!.duration_min = 99;
    next.weeks[1]!.sessions[1]!.duration_min = 30;
    await plans.submit(next, {}, NOW);
    const p = (await plans.proposal())!;
    await plans.accept(p.base, NOW);
    const cur = (await plans.current())!;
    expect(cur.weeks[0]!.sessions[0]!.duration_min).toBe(40);
    expect(cur.weeks[1]!.sessions.find((s) => s.kind === "easy")!.duration_min).toBe(30);
    expect(await plans.proposal()).toBeNull();
    expect((await plans.lastChange(NOW.getTime()))!.changes).toHaveLength(1);
    await plans.revert(NOW.getTime());
    expect((await plans.current())!.weeks[1]!.sessions.find((s) => s.kind === "easy")!.duration_min).toBe(45);
    await expect(plans.revert(NOW.getTime())).rejects.toThrow("Nothing to undo");
  });
  test("a proposal made for an older plan can't be taken; not now drops it", async () => {
    const { plans } = await setup();
    const next = base();
    next.weeks[1]!.sessions[1]!.duration_min = 30;
    await plans.submit(next, {}, NOW);
    const p = (await plans.proposal())!;
    await expect(plans.accept("2020-01-01T00:00:00.000Z", NOW)).rejects.toThrow("changed since");
    // The plan moves on (saved another way): the proposal no longer fits.
    await new Promise((r) => setTimeout(r, 2));
    await plans.save(base());
    expect(await plans.proposal()).toBeNull();
    await expect(plans.accept(p.base, NOW)).rejects.toThrow("changed since");
    await plans.submit(next, {}, NOW);
    await plans.decline();
    expect(await plans.proposal()).toBeNull();
  });
});

describe("how much goes in without you", () => {
  const plansWith = async (mode: "ask" | "small" | "auto") => {
    const plans = new Plans(new Library(new MemoryDisk()));
    await plans.submit(base(), {}, NOW);
    await plans.setApproval(mode);
    return plans;
  };
  const shorter = () => {
    const n = base();
    n.weeks[1]!.sessions[1]!.duration_min = 40;
    return n;
  };
  const bigger = () => {
    const n = shorter();
    n.weeks[1]!.sessions.push({ date: "2026-10-25", kind: "long", title: "Long run", duration_min: 90 });
    return n;
  };
  test("ask: everything waits", async () => {
    const plans = await plansWith("ask");
    expect("proposed" in (await plans.submit(shorter(), {}, NOW))).toBe(true);
  });
  test("small: a small change goes in at once (and can be undone), a bigger one waits", async () => {
    const plans = await plansWith("small");
    const r = await plans.submit(shorter(), {}, NOW);
    expect("saved" in r && r.applied).toHaveLength(1);
    expect((await plans.current())!.weeks[1]!.sessions[1]!.duration_min).toBe(40);
    expect((await plans.lastChange(NOW.getTime()))!.auto).toBe(true);
    expect(await plans.proposal()).toBeNull();
    expect("proposed" in (await plans.submit(bigger(), {}, NOW))).toBe(true);
    // A quarter of the time or more is no longer small; nor are paces more than 10 s/km.
    const far = base();
    far.weeks[1]!.sessions[1]!.duration_min = 30;
    expect(planChanges(base(), far, "2026-10-20")[0]!.small).toBe(false);
  });
  test("auto: every change goes in", async () => {
    const plans = await plansWith("auto");
    expect("saved" in (await plans.submit(bigger(), {}, NOW))).toBe(true);
    expect(await plans.approval()).toBe("auto");
  });
});
