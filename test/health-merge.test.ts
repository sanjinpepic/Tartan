import { describe, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { fillTotals, writeFit, type FitWorkout } from "../src/fit-write.ts";
import { hcFolder, hcWorkout, type HcSession } from "../src/health-connect.ts";
import { importWorkout } from "../src/import.ts";
import { Library } from "../src/library.ts";
import { LocalStore } from "../src/store.ts";

// One morning run: the Suunto app's copy through Health Connect, and the watch's own file.
const t0 = Date.parse("2026-11-07T06:00:00Z");
const session: HcSession = {
  id: "hc-run-1",
  start: t0 + 2000,
  end: t0 + 1800_000,
  source: "com.stt.android.suunto",
  app: "Suunto",
  sport: "running",
  hr: Array.from({ length: 180 }, (_, i) => [t0 + i * 10_000, 130 + (i % 20)] as [number, number]),
  distance: [[t0, t0 + 900_000, 2600], [t0 + 900_000, t0 + 1800_000, 2600]],
  calories: 380,
};
const watchRun = (start = t0, minutes = 30, metres = 5320, hr = 152): FitWorkout => ({
  start,
  end: start + minutes * 60_000,
  sport: "running",
  avg_hr: hr,
  max_hr: 171,
  samples: Array.from({ length: minutes * 6 + 1 }, (_, i) => ({ t: start + i * 10_000, hr: hr + (i % 5) - 2, distance: (metres * i) / (minutes * 6), lat: 60.17 + i * 0.0001, lon: 24.94 })),
});
const WATCH = "Suunto Run 2 0042";
const putWatch = async (store: LocalStore, path: string, w: FitWorkout) => {
  await store.saveInfo(WATCH, { name: WATCH });
  await store.sink(WATCH).put(path, writeFit(fillTotals(w)));
};

describe("a health app's copy and the watch's own file", () => {
  test("the health app's copy first, then the watch's file: one workout, the watch's numbers, the same id", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    await importWorkout(store, hcFolder(session), session.id, hcWorkout(session));
    const lib = new Library(disk);
    const [before, ...none] = await lib.activities();
    expect(none).toHaveLength(0);
    expect(before).toMatchObject({ sources: ["health"], distance_km: 5.2 });

    await putWatch(store, "/logs/run.fit", watchRun());
    lib.invalidate();
    const rows = await lib.activities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before!.id, sources: ["watch", "health"], distance_km: 5.32, avg_hr: 152, streams_from: "watch", device: WATCH });
    // A fresh start reads the same.
    expect((await new Library(disk).activities()).map((r) => r.id)).toEqual([before!.id]);
  });

  test("the watch's file first, then the health app's copy: one", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    await putWatch(store, "/logs/run.fit", watchRun());
    const lib = new Library(disk);
    const [first] = await lib.activities();
    await importWorkout(store, hcFolder(session), session.id, hcWorkout(session));
    lib.invalidate();
    const rows = await lib.activities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first!.id, sources: ["watch", "health"], distance_km: 5.32 });
  });

  test("two workouts close together on one watch stay two", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    await putWatch(store, "/logs/warmup.fit", watchRun(t0 - 11 * 60_000, 10, 1700, 128));
    await putWatch(store, "/logs/run.fit", watchRun());
    await importWorkout(store, hcFolder(session), session.id, hcWorkout(session));
    const rows = await new Library(disk).activities();
    expect(rows.map((r) => r.sources)).toEqual([["watch", "health"], ["watch"]]);
  });

  test("ids from when a health app's copies were watch files are kept", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    const r = await importWorkout(store, hcFolder(session), session.id, hcWorkout(session));
    const old = `watch:${hcFolder(session).id}${r.path}`;
    await disk.write("activity-links.json", JSON.stringify({ [old]: "a-before" }));
    const lib = new Library(disk);
    expect((await lib.activities()).map((x) => x.id)).toEqual(["a-before"]);
    expect(JSON.parse(new TextDecoder().decode((await disk.read("activity-links.json"))!))).toEqual({ [`health:${old.slice(6)}`]: "a-before" });
    // The key it had still finds it.
    expect((await lib.find(old)).id).toBe("a-before");
  });

  test("the same run twice (as it showed before), now one: the id seen first, the other still finds it", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    const r = await importWorkout(store, hcFolder(session), session.id, hcWorkout(session));
    await putWatch(store, "/logs/run.fit", watchRun());
    const watchId = (await store.watches()).find((w) => w.info.name === WATCH)!.id;
    await disk.write("activity-links.json", JSON.stringify({ [`watch:${hcFolder(session).id}${r.path}`]: "a-health", [`watch:${watchId}/logs/run.fit`]: "a-watch" }));
    const lib = new Library(disk);
    const rows = await lib.activities();
    expect(rows.map((x) => x.id)).toEqual(["a-health"]);
    expect((await lib.find("a-watch")).id).toBe("a-health");
    expect((await lib.activity("a-watch")).id).toBe("a-health");
  });
});

describe("intervals.icu's copy and the watch's own file", () => {
  const icu = { id: "intervals-icu", name: "intervals.icu" };
  const icuRun = (): FitWorkout => ({ ...watchRun(t0 + 3000, 30, 5300, 151), samples: watchRun(t0 + 3000, 30, 5300, 151).samples.map((x) => ({ ...x, lat: undefined, lon: undefined })) });

  test("intervals.icu's copy first, then the watch's file: one workout, the watch's numbers, the same id", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    await importWorkout(store, icu, "icu-1", icuRun());
    const lib = new Library(disk);
    const [before, ...none] = await lib.activities();
    expect(none).toHaveLength(0);
    expect(before).toMatchObject({ sources: ["intervals"] });
    await putWatch(store, "/logs/run.fit", watchRun());
    lib.invalidate();
    const rows = await lib.activities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before!.id, sources: ["watch", "intervals"], distance_km: 5.32, streams_from: "watch" });
  });

  test("the watch's file, intervals.icu's and the health app's copies: one", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    await putWatch(store, "/logs/run.fit", watchRun());
    await importWorkout(store, icu, "icu-1", icuRun());
    await importWorkout(store, hcFolder(session), session.id, hcWorkout(session));
    const rows = await new Library(disk).activities();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sources.sort()).toEqual(["health", "intervals", "watch"]);
  });

  test("ids from when intervals.icu's copies were watch files are kept", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    await importWorkout(store, icu, "icu-1", icuRun());
    const [row] = await new Library(disk).activities();
    // As links were written before: the copy keyed as a watch file.
    const links = JSON.parse(new TextDecoder().decode((await disk.read("activity-links.json"))!)) as Record<string, string>;
    const key = Object.keys(links).find((k) => k.startsWith("intervals:"))!;
    await disk.write("activity-links.json", JSON.stringify({ [`watch:${key.slice(10)}`]: links[key] }));
    const lib = new Library(disk);
    expect((await lib.activities())[0]!.id).toBe(row!.id);
    expect((await lib.find(`watch:${key.slice(10)}`)).id).toBe(row!.id);
  });
});
