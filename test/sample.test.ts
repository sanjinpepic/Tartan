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
