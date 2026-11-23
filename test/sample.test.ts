/** The demo's sample data: ten weeks of training that every screen can show. */
import { expect, test } from "bun:test";
import { Analytics } from "../src/analytics.ts";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import { isSample, seedSample } from "../src/sample.ts";
import { LocalStore } from "../src/store.ts";

test("ten weeks of runs and gym sessions, with heart rate and routes; sleep and HRV; marked as the sample", async () => {
  const disk = new MemoryDisk();
  const now = Date.parse("2026-11-09T12:00:00Z");
  const n = await seedSample(new LocalStore(disk), disk, now);
  expect(n).toBeGreaterThan(45);
  expect(await isSample(disk)).toBe(true);
  const lib = new Library(disk);
  const rows = await lib.activities();
  expect(rows.length).toBe(n);
  const runs = rows.filter((r) => /run/i.test(r.sport));
  expect(runs.length).toBeGreaterThan(30);
  const long = runs.reduce((a, b) => ((b.distance_km ?? 0) > (a.distance_km ?? 0) ? b : a));
  expect(long.distance_km).toBeGreaterThan(17);
  const s = await lib.streams(long.id, ["heartrate", "latlng"]);
  expect((s.streams as { latlng: unknown[] }).latlng.length).toBeGreaterThan(50);
  // Today has something to say.
  const today = await new Analytics(lib).today();
  expect(today).toBeTruthy();
  // The same every time.
  const again = new MemoryDisk();
  expect(await seedSample(new LocalStore(again), again, now)).toBe(n);
});

test("up to yesterday, whatever the hour: today's session is still ahead (the screenshots need it)", async () => {
  for (const at of ["2026-11-21T06:00:00Z", "2026-11-21T19:30:00Z", "2026-11-21T23:30:00Z"]) {
    const disk = new MemoryDisk();
    await seedSample(new LocalStore(disk), disk, Date.parse(at));
    const days = (await new Library(disk).activities()).map((r) => String(r.start).slice(0, 10)).sort();
    expect(days.at(-1)! < "2026-11-21").toBe(true);
    // The week so far is there: Thursday's tempo at least.
    expect(days.at(-1)! >= "2026-11-19").toBe(true);
  }
});

test("Saturday's hill loop, pushed up the hill: the rules find the climb and the quicker finish (the sheet's moments)", async () => {
  const { createApi } = await import("../src/api.ts");
  const disk = new MemoryDisk();
  const store = new LocalStore(disk);
  const library = new Library(disk);
  await seedSample(store, disk, Date.parse("2026-11-22T12:00:00Z"));
  const api = createApi({ store, library, analytics: new Analytics(library) } as unknown as Parameters<typeof createApi>[0]);
  const call = async (path: string) => (await api.handle(new Request(`http://x${path}`)))!.json();
  const runs = (await library.activities()).filter((r) => /run/i.test(r.sport)).sort((a, b) => String(b.start).localeCompare(String(a.start)));
  const sat = runs.find((r) => new Date(r.start).getUTCDay() === 6)!;
  const v = (await call(`/api/activity/${encodeURIComponent(sat.id)}`)) as { moments?: Array<{ kind: string; id: string; from_i: number; to_i: number; at?: number[] }>; streams: { streams: { latlng: unknown[] } } };
  expect(v.moments?.map((m) => `${m.kind}:${m.id}`)).toEqual(["work_on:hill_hr", "good:strong_finish"]);
  for (const m of v.moments!) {
    expect(m.at).toHaveLength(2);
    expect(m.to_i).toBeLessThan(v.streams.streams.latlng.length);
  }
  // A park loop on a weekday: nothing to say.
  const wed = runs.find((r) => new Date(r.start).getUTCDay() === 3)!;
  expect(((await call(`/api/activity/${encodeURIComponent(wed.id)}`)) as { moments?: unknown[] }).moments ?? []).toEqual([]);
});
