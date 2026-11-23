import { describe, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { importFit, IMPORTED } from "../src/import.ts";
import { Library } from "../src/library.ts";
import { LocalStore } from "../src/store.ts";
import { encodeFit } from "./sim/fit-fixture.ts";

describe("workout files from other apps", () => {
  test("a FIT run is kept, shows up as one workout with its time series, and a second import writes nothing", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    const r = await importFit(store, "Morning Run (Garmin).fit", encodeFit());
    expect(r).toEqual({ path: "/imported/2024-11-08-Morning-Run-Garmin.fit", start: "2024-11-08T11:33:20.000Z", sport: "running", distance_km: 5, minutes: 29 });
    expect((await importFit(store, "Morning Run (Garmin).fit", encodeFit())).already).toBe(true);

    const lib = new Library(disk);
    const rows = await lib.activities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ distance_km: 5, sources: ["watch"], device: IMPORTED });
    expect(rows[0]!.sport).toMatch(/run/i);
    const s = await lib.streams(rows[0]!.id, ["heartrate"]);
    expect((s.streams as { heartrate: number[] }).heartrate).toEqual([140, 141, 142]);
  });

  test("anything else is refused in words", async () => {
    const store = new LocalStore(new MemoryDisk());
    await expect(importFit(store, "route.gpx", new TextEncoder().encode("<gpx/>"))).rejects.toThrow(/isn't a FIT file/);
    const fit = encodeFit();
    await expect(importFit(store, "cut.fit", fit.subarray(0, 30))).rejects.toThrow(/couldn't be read|no workout/);
  });
});

describe("workouts from other apps through Health Connect", () => {
  test("a Samsung Health run comes in whole (heart rate, route, distance), once, in its app's folder", async () => {
    const { hcFolder, hcWorkout } = await import("../src/health-connect.ts");
    const { importWorkout } = await import("../src/import.ts");
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    const t0 = Date.parse("2026-11-07T06:00:00Z");
    const session = {
      id: "hc-abc-123",
      start: t0,
      end: t0 + 1800_000,
      source: "com.sec.android.app.shealth",
      app: "Samsung Health",
      sport: "running",
      title: "Morning run",
      hr: Array.from({ length: 180 }, (_, i) => [t0 + i * 10_000, 130 + (i % 20)] as [number, number]),
      distance: [[t0, t0 + 900_000, 2600], [t0 + 900_000, t0 + 1800_000, 2700]] as Array<[number, number, number]>,
      route: Array.from({ length: 360 }, (_, i) => [t0 + i * 5000, 60.17 + i * 0.00004, 24.94, 12] as [number, number, number, number]),
      calories: 380,
    };
    const r = await importWorkout(store, hcFolder(session), session.id, hcWorkout(session));
    expect(r).toMatchObject({ sport: "running", distance_km: 5.3, minutes: 30 });
    expect((await importWorkout(store, hcFolder(session), session.id, hcWorkout(session))).already).toBe(true);
    const lib = new Library(disk);
    const rows = await lib.activities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ distance_km: 5.3, sources: ["health"], device: "Samsung Health via Health Connect" });
    const s = await lib.streams(rows[0]!.id, ["heartrate", "latlng"]);
    expect((s.streams as { heartrate: number[] }).heartrate.length).toBeGreaterThan(100);
    expect((s.streams as { latlng: unknown[] }).latlng.length).toBeGreaterThan(100);
  });

  test("a gym session with nothing but its time still counts", async () => {
    const { hcFolder, hcWorkout } = await import("../src/health-connect.ts");
    const { importWorkout } = await import("../src/import.ts");
    const disk = new MemoryDisk();
    const t0 = Date.parse("2026-11-07T17:00:00Z");
    const s = { id: "gym-1", start: t0, end: t0 + 3000_000, source: "com.google.android.apps.fitness", app: "Fit", sport: "strength_training" };
    await importWorkout(new LocalStore(disk), hcFolder(s), s.id, hcWorkout(s));
    const rows = await new Library(disk).activities();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sport).toBe("training");
  });
});

describe("GPX and TCX files", () => {
  const gpx = (points: string) => `<?xml version="1.0"?><gpx version="1.1" creator="Garmin Connect" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><metadata><name>Lunch Run</name></metadata><trk><name>Lunch Run</name><type>running</type><trkseg>${points}</trkseg></trk></gpx>`;
  const pt = (i: number) => `<trkpt lat="${60.17 + i * 0.0002}" lon="24.94"><ele>${10 + i}</ele><time>2026-11-05T11:${String(i).padStart(2, "0")}:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${130 + i}</gpxtpx:hr><gpxtpx:cad>88</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>`;

  test("a Garmin GPX run comes in with its route, heart rate and climb", async () => {
    const { importFile } = await import("../src/import.ts");
    const disk = new MemoryDisk();
    const r = await importFile(new LocalStore(disk), "Lunch_Run.gpx", new TextEncoder().encode(gpx(Array.from({ length: 31 }, (_, i) => pt(i)).join(""))));
    expect(r).toMatchObject({ sport: "running", minutes: 30 });
    expect(r.distance_km).toBeGreaterThan(0.6);
    const rows = await new Library(disk).activities();
    expect(rows).toHaveLength(1);
    const s = await new Library(disk).streams(rows[0]!.id, ["heartrate"]);
    expect((s.streams as { heartrate: number[] }).heartrate.at(-1)).toBe(160);
  });

  test("a TCX ride: its laps' totals and track", async () => {
    const { importFile } = await import("../src/import.ts");
    const tp = (i: number) => `<Trackpoint><Time>2026-11-06T08:${String(i).padStart(2, "0")}:00Z</Time><Position><LatitudeDegrees>${60 + i * 0.001}</LatitudeDegrees><LongitudeDegrees>25</LongitudeDegrees></Position><AltitudeMeters>20</AltitudeMeters><DistanceMeters>${i * 400}</DistanceMeters><HeartRateBpm><Value>${120 + i}</Value></HeartRateBpm></Trackpoint>`;
    const tcx = `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Biking"><Id>2026-11-06T08:00:00Z</Id><Lap StartTime="2026-11-06T08:00:00Z"><TotalTimeSeconds>1200</TotalTimeSeconds><DistanceMeters>8000</DistanceMeters><Calories>300</Calories><Track>${Array.from({ length: 21 }, (_, i) => tp(i)).join("")}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const r = await importFile(new LocalStore(new MemoryDisk()), "ride.tcx", new TextEncoder().encode(tcx));
    expect(r).toMatchObject({ sport: "cycling", distance_km: 8, minutes: 20 });
  });

  test("a planned route (no times) and other files are refused in words", async () => {
    const { importFile } = await import("../src/import.ts");
    const store = new LocalStore(new MemoryDisk());
    await expect(importFile(store, "route.gpx", new TextEncoder().encode(gpx(`<trkpt lat="60" lon="24"><ele>1</ele></trkpt><trkpt lat="60.1" lon="24"></trkpt>`)))).rejects.toThrow(/no timed points/);
    await expect(importFile(store, "notes.txt", new TextEncoder().encode("hello"))).rejects.toThrow(/FIT, GPX or TCX/);
  });
});
