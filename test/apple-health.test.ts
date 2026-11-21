import { describe, expect, test } from "bun:test";
import { alreadyHere, hkApp, hkFolder, hkWorkout, type HkSession } from "../src/apple-health.ts";
import { MemoryDisk } from "../src/disk.ts";
import { importWorkout, isImportFolder } from "../src/import.ts";
import { Library } from "../src/library.ts";
import { LocalStore } from "../src/store.ts";

const t0 = Date.parse("2026-11-14T07:00:00Z");
const run = (over: Partial<HkSession> = {}): HkSession => ({
  id: "6F1C2B9A-0D3E-4C55-9A61-2B7E8F00A1C3",
  start: t0,
  end: t0 + 2400_000,
  source: "com.apple.health.81C4D2E0",
  app: "Sanna's Apple Watch",
  product: "Watch7,1",
  sport: "running",
  hr: Array.from({ length: 480 }, (_, i) => [t0 + i * 5000, 135 + (i % 25)] as [number, number]),
  distance: Array.from({ length: 40 }, (_, i) => [t0 + i * 60_000, t0 + (i + 1) * 60_000, 160] as [number, number, number]),
  route: Array.from({ length: 2400 }, (_, i) => [t0 + i * 1000, 60.17 + i * 0.00002, 24.94, 14] as [number, number, number, number]),
  distance_m: 6400,
  calories: 420,
  avg_hr: 148.4,
  max_hr: 171,
  ...over,
});

describe("workouts from Apple Health", () => {
  test("an Apple Watch run comes in whole, once, as the Apple Watch (never its owner's name for it)", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    const s = run();
    expect(hkFolder(s)).toEqual({ id: "apple-health-Apple-Watch", name: "Apple Watch via Apple Health" });
    expect(isImportFolder(hkFolder(s).id)).toBe(true);
    const r = await importWorkout(store, hkFolder(s), s.id, hkWorkout(s));
    expect(r).toMatchObject({ sport: "running", distance_km: 6.4, minutes: 40 });
    expect((await importWorkout(store, hkFolder(s), s.id, hkWorkout(s))).already).toBe(true);
    const lib = new Library(disk);
    const rows = await lib.activities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ distance_km: 6.4, avg_hr: 148, max_hr: 171, sources: ["watch"], device: "Apple Watch via Apple Health" });
    const st = await lib.streams(rows[0]!.id, ["heartrate", "latlng"]);
    expect((st.streams as { heartrate: number[] }).heartrate.length).toBeGreaterThan(200);
    expect((st.streams as { latlng: unknown[] }).latlng.length).toBeGreaterThan(200);
  });

  test("a summary with nothing else (an app that saves only totals) still counts, with its distance and heart rate", async () => {
    const disk = new MemoryDisk();
    const s = run({ source: "com.nike.nikeplus-gps", app: "Nike Run Club", product: "iPhone16,1", hr: undefined, distance: undefined, route: undefined });
    expect(hkApp(s)).toBe("Nike Run Club");
    const w = hkWorkout(s);
    expect(w).toMatchObject({ sport: "running", distance_m: 6400, avg_hr: 148, max_hr: 171, calories: 420 });
    await importWorkout(new LocalStore(disk), hkFolder(s), s.id, w);
    const rows = await new Library(disk).activities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ distance_km: 6.4, avg_hr: 148, device: "Nike Run Club via Apple Health" });
  });

  test("sports: a treadmill run, a pool swim, strength, a ride; an iPhone workout is the iPhone", () => {
    expect(hkWorkout(run({ sport: "running_treadmill", route: undefined })).sport).toBe("running");
    expect(hkWorkout(run({ sport: "swimming_pool" })).sport).toBe("swimming");
    expect(hkWorkout(run({ sport: "weightlifting", distance: undefined, distance_m: undefined, route: undefined })).sport).toBe("training");
    expect(hkWorkout(run({ sport: "biking" })).sport).toBe("cycling");
    expect(hkWorkout(run({ sport: "cross_country_skiing" })).sport).toBe("cross_country_skiing");
    expect(hkApp({ source: "com.apple.health.123", app: "Sanna's iPhone", product: "iPhone17,1" })).toBe("iPhone");
  });

  test("a run the watch's own file already brought is left out; one only on Strava is not", () => {
    const s = run();
    const row = { start: new Date(t0 + 20_000).toISOString(), sport: "Run", elapsed_min: 40, distance_km: 6.38 };
    expect(alreadyHere(s, [{ ...row, sources: ["watch"] }])).toBe(true);
    expect(alreadyHere(s, [{ ...row, sources: ["strava"] }])).toBe(false);
    expect(alreadyHere(s, [{ ...row, start: new Date(t0 + 3 * 3600_000).toISOString(), sources: ["watch"] }])).toBe(false);
    expect(alreadyHere(s, [{ ...row, sport: "Ride", sources: ["watch"] }])).toBe(false);
  });
});
