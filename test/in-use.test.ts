/** What's in use (src/in-use.ts): a new user's tools wait under More tools; anything used stays where it is. */
import { expect, test } from "bun:test";
import { createApi } from "../src/api.ts";
import { Analytics } from "../src/analytics.ts";
import { MemoryDisk } from "../src/disk.ts";
import { dataFacts, inUse, NOTHING_IN_USE } from "../src/in-use.ts";
import { Library } from "../src/library.ts";
import { Routes } from "../src/routes.ts";
import { LocalStore } from "../src/store.ts";
import { Lifts } from "../src/strength/log.ts";

test("a new user: nothing in use", () => {
  expect(inUse({})).toEqual(NOTHING_IN_USE);
  expect(inUse({ routes: 0, faces: 0, facesOnWatch: 0, lifts: 0, strengthAhead: 0, icu: false, pc: false, watch: false, agentCalls: 0 })).toEqual(NOTHING_IN_USE);
});

test("each tool by what's in the data", () => {
  expect(inUse({ routes: 2 })).toEqual({ ...NOTHING_IN_USE, routes: true });
  expect(inUse({ lifts: 1 }).lift).toBe(true);
  expect(inUse({ strengthAhead: 3 }).lift).toBe(true);
  expect(inUse({ icu: true })).toEqual({ ...NOTHING_IN_USE, icu: true });
  expect(inUse({ watch: true })).toEqual({ ...NOTHING_IN_USE, watch: true });
  // A face saved or installed: faces, and the watch they're on.
  expect(inUse({ faces: 1 })).toEqual({ ...NOTHING_IN_USE, faces: true, watch: true });
  expect(inUse({ facesOnWatch: 1 })).toEqual({ ...NOTHING_IN_USE, faces: true, watch: true });
  // Agents reach the phone's data through the PC: a paired PC brings them along.
  expect(inUse({ pc: true })).toEqual({ ...NOTHING_IN_USE, pc: true, agents: true });
  expect(inUse({ agentCalls: 4 })).toEqual({ ...NOTHING_IN_USE, agents: true });
});

test("the data's half: counts, strength ahead only, agents but not the coach", async () => {
  const f = await dataFacts({
    routes: async () => [{}, {}],
    faces: async () => [],
    lifts: async () => [{}],
    plan: async () => ({ weeks: [{ sessions: [{ date: "2026-11-16", kind: "strength" }, { date: "2026-11-21", kind: "strength" }, { date: "2026-11-22", kind: "long" }, { date: "2026-11-23", kind: "strength" }] }] }),
    icu: async () => ({ connected: true }),
    events: async () => [{ lane: "agent", kind: "coach" }, { lane: "agent", kind: "list_activities" }, { lane: "strava", kind: "sync" }],
    today: "2026-11-21",
  });
  expect(f).toEqual({ routes: 2, faces: 0, lifts: 1, strengthAhead: 2, icu: true, agentCalls: 1 });
});

test("a part that can't be read counts as none", async () => {
  const fail = async (): Promise<never> => {
    throw new Error("no");
  };
  const f = await dataFacts({ routes: fail, faces: fail, lifts: fail, plan: fail, icu: fail, events: fail, today: "2026-11-21" });
  expect(inUse(f)).toEqual(NOTHING_IN_USE);
});

test("GET /api/in-use: empty for a new user, then what was saved", async () => {
  const disk = new MemoryDisk();
  const store = new LocalStore(disk);
  const library = new Library(disk);
  const api = createApi({ store, library, analytics: new Analytics(library) } as unknown as Parameters<typeof createApi>[0]);
  const read = async () => (await (await api.handle(new Request("http://x/api/in-use")))!.json()) as Record<string, unknown>;
  expect(inUse(await read())).toEqual(NOTHING_IN_USE);
  await new Routes(disk).save({ name: "Loop", waypoints: [[24.9, 60.1], [24.91, 60.11]], segments: [{ mode: "straight", coords: [[24.9, 60.1], [24.91, 60.11]] }] });
  await new Lifts(disk).save({ date: "2026-11-20", exercises: [] });
  const now = await read();
  expect(now.routes).toBe(1);
  expect(now.lifts).toBe(1);
  expect(inUse(now)).toEqual({ ...NOTHING_IN_USE, routes: true, lift: true });
});
