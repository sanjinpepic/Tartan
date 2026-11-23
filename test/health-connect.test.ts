import { expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { Health } from "../src/health.ts";
import { coveredBy, deviceOf, exerciseType, HealthConnectStore, sleepSession, trendRecords, workoutRecords } from "../src/health-connect.ts";
import type { ActivityRow } from "../src/library.ts";
import { TREND_STEP_MS, type TrendRecord } from "../src/protocol/trends.ts";

test("sports map to Health Connect's exercise types", () => {
  expect(["Run", "TrailRun", "VirtualRun", "Ride", "GravelRide", "VirtualRide", "Walk", "Hike", "Swim", "WeightTraining", "Yoga", "Workout", "running"].map(exerciseType)).toEqual([
    "running", "running", "running_treadmill", "biking", "biking", "biking_stationary", "walking", "hiking", "swimming_pool", "weightlifting", "yoga", "other", "running",
  ]);
});

test("devices: a watch, the phone, a bike computer", () => {
  expect(deviceOf("Suunto Run 2")).toEqual({ type: "watch", manufacturer: "Suunto", model: "Run 2" });
  expect(deviceOf("Suunto Run 2 0A1B2C")).toEqual({ type: "watch", manufacturer: "Suunto", model: "Run 2" });
  expect(deviceOf("Garmin Edge 530").type).toBe("unknown");
  expect(deviceOf("Tartan phone").type).toBe("phone");
  expect(deviceOf(undefined)).toEqual({ type: "unknown" });
});

const run: ActivityRow = { id: "a1", start: "2026-10-17T06:00:00Z", sport: "Run", name: "Easy Run", distance_km: 10.2, elapsed_min: 70, calories: 640, device: "Suunto Run 2", sources: ["strava"] };

test("a workout: its session with the route inside it, heart rate an hour a record, distance and energy", () => {
  const n = 4300;
  const columns = {
    time: Array.from({ length: n }, (_, i) => i),
    heartrate: Array.from({ length: n }, (_, i) => (i === 10 ? null : 140 + (i % 5))),
    latlng: Array.from({ length: n }, (_, i) => [60 + i * 1e-5, 24.9]),
    altitude: Array.from({ length: n }, () => 12),
  };
  const rs = workoutRecords(run, columns, 7);
  const start = Date.parse(run.start);
  const ex = rs.find((r) => r.type === "exercise")!;
  expect(ex).toMatchObject({ id: "tartan-w-a1", start, end: start + 4299_000, exercise: "running", title: "Easy Run", method: "active", version: 7, device: { type: "watch", manufacturer: "Suunto" } });
  // A point every 2 s at most.
  if (ex.type !== "exercise") throw new Error();
  expect(ex.route!.length).toBe(2150);
  expect(ex.route![1]).toEqual([start + 2000, 60.00002, 24.9, 12]);
  const hr = rs.filter((r) => r.type === "heartRate");
  expect(hr.map((r) => r.id)).toEqual(["tartan-w-a1-hr-0", "tartan-w-a1-hr-1"]);
  expect(hr.reduce((n, r) => n + (r.type === "heartRate" ? r.samples.length : 0), 0)).toBe(n - 1);
  expect(rs.find((r) => r.type === "distance")).toMatchObject({ id: "tartan-w-a1-dist", meters: 10200 });
  expect(rs.find((r) => r.type === "activeCalories")).toMatchObject({ kcal: 640 });
  // Without a time series: the session from its elapsed time, distance and energy.
  const bare = workoutRecords(run, null);
  expect(bare.map((r) => r.type)).toEqual(["exercise", "distance", "activeCalories"]);
  expect(bare[0]).toMatchObject({ end: start + 70 * 60_000 });
});

test("a workout another app has (mostly the same time) is covered", () => {
  const a = { start: 0, end: 3600_000 };
  expect(coveredBy(a, [{ start: 60_000, end: 3500_000 }])).toBe(true);
  expect(coveredBy(a, [{ start: 3000_000, end: 7200_000 }])).toBe(false);
  expect(coveredBy(a, [])).toBe(false);
});

const at = (local: string) => new Date(local).getTime();
function log(): TrendRecord[] {
  const out: TrendRecord[] = [];
  for (let t = at("2026-10-18T00:00:00"); t < at("2026-10-18T02:00:00"); t += TREND_STEP_MS) out.push({ t, steps: 0, energy_j: 0, hr: 50 });
  out.push({ t: at("2026-10-18T08:00:00"), steps: 900, energy_j: 41_840, hr: 120, spo2: 97 });
  return out;
}

test("the watch's log: a day's heart rate, readings, resting heart rate, steps and energy", () => {
  const rs = trendRecords(log(), "Suunto Run 2 0A1B2C", { vitals: true, activity: true }, at("2026-10-18T12:00:00"));
  const hr = rs.filter((r) => r.type === "heartRate");
  expect(hr).toHaveLength(1);
  expect(hr[0]).toMatchObject({ id: "tartan-t-hr-20261018", version: 13, method: "auto", device: { type: "watch", manufacturer: "Suunto", model: "Run 2" } });
  expect(rs.find((r) => r.type === "oxygenSaturation")).toMatchObject({ percent: 97, time: at("2026-10-18T08:05:00") });
  expect(rs.find((r) => r.type === "restingHeartRate")).toMatchObject({ id: "tartan-t-rhr-2026-10-18", bpm: 50, version: 250 });
  expect(rs.filter((r) => r.type === "steps")).toEqual([expect.objectContaining({ count: 900, start: at("2026-10-18T08:00:00"), end: at("2026-10-18T08:10:00") })]);
  expect(rs.find((r) => r.type === "activeCalories")).toMatchObject({ kcal: 10 });
  // Only what's switched on.
  expect(trendRecords(log(), "Suunto Run 2", { vitals: false, activity: true }).map((r) => r.type).sort()).toEqual(["activeCalories", "steps"]);
});

test("sleep from Health Connect: stages added up, kept, and shown as last night", async () => {
  const s = sleepSession({
    id: "x",
    start: at("2026-10-17T23:00:00"),
    end: at("2026-10-18T07:00:00"),
    source: "com.stt.android.suunto",
    stages: [
      [at("2026-10-17T23:00:00"), at("2026-10-18T01:00:00"), 4],
      [at("2026-10-18T01:00:00"), at("2026-10-18T02:30:00"), 5],
      [at("2026-10-18T02:30:00"), at("2026-10-18T03:00:00"), 1],
      [at("2026-10-18T03:00:00"), at("2026-10-18T07:00:00"), 6],
    ],
  });
  expect(s.minutes).toEqual({ asleep: 450, awake: 30, light: 120, deep: 90, rem: 240 });
  const disk = new MemoryDisk();
  await new HealthConnectStore(disk).add([s], [{ t: at("2026-10-18T06:00:00"), ms: 48, source: "com.stt.android.suunto" }], at("2026-10-18T09:00:00"));
  const v = await new Health(disk).view(at("2026-10-18T09:00:00"));
  expect(v.days[0]).toMatchObject({ date: "2026-10-18", sleep: { minutes: { asleep: 450, deep: 90 } }, hrv_ms: 48 });
});
