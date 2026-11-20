/** intervals.icu as a source, against a mock of its API. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { Intervals } from "../src/intervals.ts";
import { Library } from "../src/library.ts";
import { LocalStore } from "../src/store.ts";

let server: ReturnType<typeof Bun.serve>;
const calls: string[] = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      calls.push(u.pathname + u.search);
      if (req.headers.get("authorization") !== `Basic ${btoa("API_KEY:good-key")}`) return new Response("no", { status: 401 });
      if (u.pathname === "/api/v1/athlete/0") return Response.json({ id: "i4242", name: "Sam Runner" });
      if (u.pathname === "/api/v1/athlete/i4242/activities")
        return Response.json([
          { id: "i1", start_date: "2026-11-01T07:00:00Z", type: "Run", name: "Garmin run", source: "GARMIN_CONNECT", distance: 6000, moving_time: 1800, elapsed_time: 1850, average_heartrate: 144, max_heartrate: 160, calories: 420 },
          { id: "i2", start_date_local: "2026-11-03T18:00:00", source: "STRAVA", _note: "STRAVA activities are not available via the API" },
          { id: "i3", start_date: "2026-11-04T17:00:00Z", type: "WeightTraining", name: "Gym", source: "OAUTH_CLIENT", elapsed_time: 2700, moving_time: 2700 },
        ]);
      if (u.pathname === "/api/v1/activity/i1/streams.json")
        return Response.json([
          { type: "time", data: [0, 10, 20, 30] },
          { type: "heartrate", data: [120, 140, 150, null] },
          { type: "latlng", data: [60.1, 60.1001, 60.1002, 60.1003], data2: [24.9, 24.9, 24.9, 24.9] },
          { type: "distance", data: [0, 30, 60, 90] },
        ]);
      if (u.pathname.startsWith("/api/v1/activity/")) return Response.json([]);
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
const base = () => server.url.toString().replace(/\/$/, "");

test("a wrong key is said plainly", async () => {
  const icu = new Intervals(new MemoryDisk());
  await expect(icu.connect("bad-key", "", base())).rejects.toThrow(/didn't accept the key/);
});

test("connect with the key alone, then workouts come in whole; Strava's copies are skipped; once each", async () => {
  const disk = new MemoryDisk();
  const icu = new Intervals(disk);
  expect(await icu.connect("good-key", "", base())).toEqual({ athlete: "i4242", name: "Sam Runner" });
  const r = await icu.sync(new LocalStore(disk), { now: Date.parse("2026-11-09T12:00:00Z") });
  expect(r).toEqual({ added: 2, strava: 1, pending: 0 });
  expect(calls.some((c) => c.startsWith("/api/v1/athlete/i4242/activities?oldest=2024-11-09&newest=2026-11-10"))).toBe(true);
  expect((await icu.sync(new LocalStore(disk), { now: Date.parse("2026-11-09T13:00:00Z") })).added).toBe(0);
  const rows = await new Library(disk).activities();
  expect(rows).toHaveLength(2);
  const run = rows.find((x) => /run/i.test(x.sport))!;
  expect(run).toMatchObject({ distance_km: 6, device: "intervals.icu" });
  const s = await new Library(disk).streams(run.id, ["heartrate"]);
  expect((s.streams as { heartrate: Array<number | null> }).heartrate.slice(0, 3)).toEqual([120, 140, 150]);
  expect((await icu.status())).toMatchObject({ connected: true, name: "Sam Runner", workouts: 3 });
});
