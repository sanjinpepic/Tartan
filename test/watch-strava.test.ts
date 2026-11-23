/** Sending watch workouts to Strava (opt in): once, never doubles, never history. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDisk } from "../src/disk-node.ts";
import { parseFit } from "../src/fit.ts";
import { Library } from "../src/library.ts";
import { LocalStore } from "../src/store.ts";
import { syncStrava } from "../src/strava/sync.ts";
import { WatchToStrava } from "../src/watch-to-strava.ts";
import { encodeFit } from "./sim/fit-fixture.ts";
import { startMockStrava } from "./sim/mock-strava.ts";

let mock: ReturnType<typeof startMockStrava>;
const FIT_START = Date.parse(parseFit(encodeFit()).startTime!);
const AFTER = FIT_START + 3 * 3600_000; // well past the grace hour

// Each case gets its own Strava, so one case's uploads don't show up in the next.
beforeEach(() => {
  mock = startMockStrava({ activities: 3 });
  // The account's history predates the watch workout (2004), as a real one predates today's run:
  // incremental syncs list what's newer than the latest activity.
  mock.activities.forEach((a, i) => {
    a.start_date = new Date(Date.UTC(2003, 0, 1 + i, 7)).toISOString();
    a.start_date_local = a.start_date.replace("Z", "");
  });
  process.env.STRAVA_API_BASE = `${mock.url}/api/v3`;
  process.env.STRAVA_OAUTH_BASE = `${mock.url}/oauth`;
});
afterEach(() => mock.stop());

async function setup(scope = "read,activity:read_all,activity:write") {
  const root = mkdtempSync(join(tmpdir(), "tartan-w2s-"));
  const local = new LocalStore(new NodeDisk(root));
  await local.saveInfo("Suunto Run 2 0042", { name: "Suunto Run 2 0042" });
  await local.sink("Suunto Run 2 0042").put("/logs/run.fit", encodeFit());
  const lib = new Library(new NodeDisk(root));
  await lib.strava.writeSecret({ clientId: "cid", clientSecret: "secret" }, "config.json");
  await (await lib.strava.client())!.exchangeCode("good-code", scope);
  await syncStrava((await lib.strava.client())!, lib.strava);
  lib.invalidate();
  return { lib, w: new WatchToStrava(lib) };
}

test("off by default; on, it sends a watch-only workout once", async () => {
  const { lib, w } = await setup();
  expect(await w.run(AFTER)).toMatchObject({ enabled: false, sent: 0 });

  await w.setEnabled(true, new Date(FIT_START - 86400_000));
  const before = mock.uploads.length;
  expect(await w.run(AFTER)).toMatchObject({ enabled: true, sent: 1, errors: [] });
  const up = mock.uploads.at(-1)!;
  expect(mock.uploads.length).toBe(before + 1);
  expect(up.external_id).toStartWith("freesuunto-watch-");
  expect(up.tcx).toContain("<Activity Sport=\"Running\">");
  expect(up.tcx).toContain("<HeartRateBpm><Value>141</Value></HeartRateBpm>");
  expect(up.tcx).toContain("<LatitudeDegrees>60.17");

  // Once only; and the Strava copy comes back as part of the same workout.
  expect(await w.run(AFTER + 3600_000)).toMatchObject({ sent: 0 });
  expect(mock.uploads.length).toBe(before + 1);
  await syncStrava((await lib.strava.client())!, lib.strava);
  lib.invalidate();
  const row = (await lib.activities({ limit: 100 })).find((r) => r.sources.includes("watch"))!;
  expect(row.sources).toEqual(expect.arrayContaining(["watch", "strava"]));
  expect((await w.status())).toMatchObject({ enabled: true, sent: 1, can_upload: true, last: { status: "done" } });
});

test("never sends what started before it was turned on, or what Strava already has", async () => {
  const before = mock.uploads.length;
  const a = await setup();
  await a.w.setEnabled(true, new Date(FIT_START + 60_000)); // turned on after the run started
  expect(await a.w.run(AFTER)).toMatchObject({ sent: 0, found: 0 });

  // The Suunto app uploads it to Strava meanwhile: found on the fresh sync right before sending.
  const b = await setup();
  await b.w.setEnabled(true, new Date(FIT_START - 86400_000));
  mock.addActivity({ ...mock.activities[0]!, id: 8888, name: "From the Suunto app", start_date: new Date(FIT_START).toISOString(), start_date_local: new Date(FIT_START).toISOString().replace("Z", ""), distance: 5000, moving_time: 1750, elapsed_time: 1800 });
  expect(await b.w.run(AFTER)).toMatchObject({ sent: 0, found: 1 });
  expect(mock.uploads.length).toBe(before);
});

test("without Strava's OK to upload it says so instead of trying", async () => {
  const { w } = await setup("read,activity:read_all");
  await w.setEnabled(true, new Date(FIT_START - 86400_000));
  const res = await w.run(AFTER);
  expect(res.sent).toBe(0);
  expect(res.blocked).toMatch(/Allow uploads/);
});

test("a workout file imported from another app is never sent: that app has its own way to Strava", async () => {
  const { importFit } = await import("../src/import.ts");
  const root = mkdtempSync(join(tmpdir(), "tartan-w2s-"));
  const local = new LocalStore(new NodeDisk(root));
  await importFit(local, "garmin.fit", encodeFit());
  const lib = new Library(new NodeDisk(root));
  await lib.strava.writeSecret({ clientId: "cid", clientSecret: "secret" }, "config.json");
  await (await lib.strava.client())!.exchangeCode("good-code", "read,activity:read_all,activity:write");
  await syncStrava((await lib.strava.client())!, lib.strava);
  lib.invalidate();
  const w = new WatchToStrava(lib);
  await w.setEnabled(true, new Date(FIT_START - 86400_000));
  const before = mock.uploads.length;
  expect(await w.run(AFTER)).toMatchObject({ sent: 0 });
  expect(mock.uploads.length).toBe(before);
});
