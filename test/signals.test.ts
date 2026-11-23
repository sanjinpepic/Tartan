/** The body signals (src/signals.ts): one place for each day's sleep and recovery, whoever sent it. */
import { expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { bodySignsOf, mergeDay, priority, Signals, usualBefore, type SignalDay } from "../src/signals.ts";
import { readiness, todayReadiness, CheckIns } from "../src/readiness.ts";
import { hcSignalDays, sleepSession } from "../src/health-connect.ts";
import { parseFit } from "../src/fit.ts";
import { writeFit, type FitSample } from "../src/fit-write.ts";
import { importWorkout } from "../src/import.ts";
import { Library } from "../src/library.ts";
import { LocalStore } from "../src/store.ts";

const at = (s: string) => new Date(s).getTime();

test("each field from the best source: told, the watch, the phone's store, the sample; each with its source", async () => {
  const s = new Signals(new MemoryDisk());
  await s.put([
    { date: "2026-11-20", source: "sample", resting_hr: 50, energy: 70, vo2max: 50 },
    { date: "2026-11-20", source: "health_connect", resting_hr: 52, hrv_ms: 48, sleep_min: 400, deep_min: 60, light_min: 260, rem_min: 80 },
    { date: "2026-11-20", source: "garmin", resting_hr: 49, energy: 35, sleep_min: 420, sleep_score: 61 },
  ]);
  const [d] = await s.days();
  expect(d).toMatchObject({ date: "2026-11-20", resting_hr: 49, energy: 35, hrv_ms: 48, vo2max: 50, sleep_min: 420, sleep_score: 61 });
  expect(d!.from).toMatchObject({ resting_hr: "garmin", energy: "garmin", hrv_ms: "health_connect", vo2max: "sample", sleep_min: "garmin" });
  // The night comes whole from one source: Garmin's total, no stages from Health Connect mixed in.
  expect(d!.deep_min).toBeUndefined();
  // What the athlete said wins.
  await s.put([{ date: "2026-11-20", source: "told", energy: 60 }]);
  expect((await s.day("2026-11-20")).day).toMatchObject({ energy: 60, from: { energy: "told" } });
  // null clears a field; a field left out stays.
  await s.put([{ date: "2026-11-20", source: "told", energy: null }]);
  expect((await s.day("2026-11-20")).day).toMatchObject({ energy: 35, from: { energy: "garmin" }, resting_hr: 49 });
});

test("a tracked night beats one estimated from heart rate and stillness, whoever sent it", () => {
  const d = mergeDay("2026-11-20", {
    suunto: { sleep_min: 500, sleep_estimated: true, night_hr_min: 44, resting_hr: 47 },
    health_connect: { sleep_min: 430, deep_min: 70, light_min: 280, rem_min: 80, awake_min: 25 },
  }, "suunto");
  expect(d).toMatchObject({ sleep_min: 430, deep_min: 70, awake_min: 25, night_hr_min: 44, resting_hr: 47 });
  expect(d.sleep_estimated).toBeUndefined();
  expect(d.from.sleep_min).toBe("health_connect");
  expect(d.from.night_hr_min).toBe("suunto");
});

test("the connected watch is the one that reported last; values out of range are dropped, not kept", async () => {
  const s = new Signals(new MemoryDisk());
  await s.put([{ date: "2026-11-19", source: "suunto", resting_hr: 50 }]);
  await s.put([{ date: "2026-11-20", source: "garmin", resting_hr: 48 }]);
  expect(await s.watch()).toBe("garmin");
  await s.put([{ date: "2026-11-20", source: "suunto", resting_hr: 51 }]);
  // A Suunto day as late as Garmin's latest: now it's the Suunto.
  expect(await s.watch()).toBe("suunto");
  expect((await s.day("2026-11-20")).day?.resting_hr).toBe(51);
  expect(priority("suunto").slice(0, 3)).toEqual(["told", "suunto", "garmin"]);
  const r = await s.put([{ date: "2026-11-20", source: "garmin", energy: 140, hrv_ms: 55, stress_level: "high" }]);
  expect(r.dropped).toEqual(["2026-11-20 energy"]);
  expect(r.days[0]).toMatchObject({ hrv_ms: 55, stress_level: "high" });
  await expect(s.put([{ date: "20 Nov", source: "garmin" } as never])).rejects.toThrow("date");
  await expect(s.put([{ date: "2026-11-20", source: "fitbit" } as never])).rejects.toThrow("source");
});

test("the usual is the median of the four weeks before, once there are three days; a year is kept", async () => {
  const days: SignalDay[] = [
    { date: "2026-11-20", hrv_ms: 30, from: {} },
    { date: "2026-11-19", hrv_ms: 50, resting_hr: 48, energy: 70, from: {} },
    { date: "2026-11-18", hrv_ms: 54, resting_hr: 50, from: {} },
    { date: "2026-11-10", hrv_ms: 60, from: {} },
    { date: "2026-10-01", hrv_ms: 99, from: {} },
  ];
  expect(usualBefore(days, "2026-11-20")).toEqual({ hrv_ms: 54, resting_hr: null, energy: null, sleep_min: null, breathing_rate: null });
  const s = new Signals(new MemoryDisk());
  await s.put([{ date: "2025-09-01", source: "sample", energy: 50 }], { now: at("2025-09-02T08:00:00") });
  await s.put([{ date: "2026-11-20", source: "sample", energy: 60 }], { now: at("2026-11-20T08:00:00") });
  expect((await s.days()).map((d) => d.date)).toEqual(["2026-11-20"]);
});

test("Health Connect's nights and HRV as days: the longest night, naps, stages and the day's HRV", () => {
  const night = sleepSession({
    id: "n",
    start: at("2026-11-19T23:00:00"),
    end: at("2026-11-20T07:00:00"),
    source: "x",
    stages: [
      [at("2026-11-19T23:00:00"), at("2026-11-20T01:00:00"), 4],
      [at("2026-11-20T01:00:00"), at("2026-11-20T02:30:00"), 5],
      [at("2026-11-20T02:30:00"), at("2026-11-20T03:00:00"), 1],
      [at("2026-11-20T03:00:00"), at("2026-11-20T07:00:00"), 6],
    ],
  });
  const nap = sleepSession({ id: "nap", start: at("2026-11-20T14:00:00"), end: at("2026-11-20T14:40:00"), source: "x", stages: [] });
  const days = hcSignalDays({ sleep: { n: night, nap }, hrv: [{ t: at("2026-11-20T06:00:00"), ms: 50, source: "x" }, { t: at("2026-11-20T06:30:00"), ms: 54, source: "x" }] });
  expect(days).toEqual([
    { date: "2026-11-20", source: "health_connect", sleep_start: "2026-11-19T23:00", sleep_end: "2026-11-20T07:00", sleep_min: 450, deep_min: 90, light_min: 120, rem_min: 240, awake_min: 30, nap_min: 40, hrv_ms: 52 },
  ]);
});

test("readiness: energy well below usual, a broken night and recovery time count; two body reasons at most", () => {
  const base = { resting_hr: 50, resting_baseline: 50 };
  expect(readiness(0, null, { ...base, energy: 40, energy_baseline: 72 })).toMatchObject({ level: "ready", reasons: ["energy 40, well below your usual 72"] });
  expect(readiness(0, null, { ...base, energy: 30, energy_baseline: 72 }).level).toBe("go easy");
  expect(readiness(0, null, { ...base, energy: 60, energy_baseline: 72 }).reasons).toEqual([]);
  expect(readiness(0, null, { ...base, energy: 20 }).reasons).toEqual(["low energy (20 of 100)"]);
  expect(readiness(0, null, { ...base, sleep_min: 420, awake_min: 70, deep_min: 80 }).reasons).toEqual(["a broken night (70 min awake)"]);
  expect(readiness(0, null, { ...base, sleep_min: 420, awake_min: 10, deep_min: 25 }).reasons).toEqual(["little deep sleep (25 min)"]);
  expect(readiness(0, null, { ...base, sleep_min: 420, sleep_score: 38 }).reasons).toEqual(["a poor night (sleep score 38)"]);
  // A short night says so, and only that.
  expect(readiness(0, null, { ...base, sleep_min: 290, awake_min: 70 }).reasons).toEqual(["a short night (4 h 50)"]);
  expect(readiness(0, null, { ...base, recovery_h: 30 }).reasons).toEqual(["30 h of recovery still to go"]);
  expect(readiness(0, null, { ...base, recovery_h: 50 }).level).toBe("go easy");
  // Four things at once: the strongest two are said, all four count.
  const many = readiness(0, null, { resting_hr: 58, resting_baseline: 50, sleep_min: 280, hrv_ms: 40, hrv_baseline: 60, energy: 30, energy_baseline: 75 });
  expect(many.reasons).toEqual(["a short night (4 h 40)", "HRV 33% below your usual"]);
  expect(many.level).toBe("rest");
  // The rest are told as before.
  expect(readiness(-20, { date: "2026-11-20", legs: 1 }, { resting_hr: 58, resting_baseline: 50, sleep_min: 280, energy: 30, energy_baseline: 75 }).reasons).toEqual(["carrying some fatigue", "a short night (4 h 40)", "heavy legs", "energy 30, well below your usual 75"]);
});

test("resting heart rate and breathing up together: are you getting ill?", () => {
  const r = readiness(0, null, { resting_hr: 55, resting_baseline: 50, breathing_rate: 16.2, breathing_baseline: 14.6 });
  expect(r).toMatchObject({ level: "go easy", ill: true, reasons: ["resting heart rate and breathing both up: are you getting ill?"] });
  // Either alone is no flag.
  expect(readiness(0, null, { resting_hr: 55, resting_baseline: 50, breathing_rate: 14.8, breathing_baseline: 14.6 })).toEqual({ level: "ready", reasons: [], form: 0 });
  expect(readiness(0, null, { resting_hr: 50, resting_baseline: 50, breathing_rate: 17, breathing_baseline: 14.6 }).ill).toBeUndefined();
});

test("today's readiness reads the signals, and hands them on with their sources", async () => {
  const disk = new MemoryDisk();
  const s = new Signals(disk);
  const date = "2026-11-20";
  const before = Array.from({ length: 6 }, (_, i) => ({ date: `2026-11-${String(13 + i).padStart(2, "0")}`, source: "garmin" as const, energy: 70 + i, sleep_min: 430 }));
  await s.put([...before, { date, source: "garmin", energy: 31, sleep_min: 410, deep_min: 70, light_min: 260, rem_min: 80, awake_min: 15 }]);
  const plans = { view: async () => ({ plan: null, weeks: [], today: date }) };
  const r = await todayReadiness({ plans, load: async () => ({ today: { form: 0 } }), checkins: new CheckIns(disk), signals: () => s.day(date) });
  expect(r.signals).toMatchObject({ energy: 31, from: { energy: "garmin" } });
  expect(r.usual?.energy).toBe(73);
  expect(r.sleep_measured).toBe(410);
  expect(r.readiness.reasons).toEqual(["energy 31, well below your usual 73"]);
  expect(r.readiness.level).toBe("go easy");
  expect(bodySignsOf(null, r.usual!)).toMatchObject({ energy: null, energy_baseline: 73, deep_min: null });
});

test("the PUT and GET routes: any source's day in, merged days and the usual out", async () => {
  const { createApi } = await import("../src/api.ts");
  const { Analytics } = await import("../src/analytics.ts");
  const disk = new MemoryDisk();
  const store = new LocalStore(disk);
  const library = new Library(disk);
  const api = createApi({ store, library, analytics: new Analytics(library) } as unknown as Parameters<typeof createApi>[0]);
  const call = async (path: string, init?: RequestInit) => (await api.handle(new Request(`http://x${path}`, init)))!;
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const put = await call("/api/signals", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ days: [{ date: today, source: "garmin", energy: 64, breathing_rate: 14.8 }] }) });
  expect(put.status).toBe(200);
  expect(((await put.json()) as { days: SignalDay[] }).days[0]).toMatchObject({ energy: 64, from: { energy: "garmin" } });
  expect((await call("/api/signals", { method: "PUT", body: "{}" })).status).toBe(400);
  const got = (await (await call("/api/signals?days=7")).json()) as { days: SignalDay[]; watch: string };
  expect(got.days[0]).toMatchObject({ date: today, energy: 64 });
  expect(got.watch).toBe("garmin");
  const r = (await (await call("/api/readiness")).json()) as { signals: SignalDay };
  expect(r.signals).toMatchObject({ energy: 64, breathing_rate: 14.8 });
});

test("a FIT file's extras: beat-to-beat intervals, running power and dynamics, into the workout's streams", async () => {
  const start = at("2026-11-20T07:00:00Z");
  const samples: FitSample[] = Array.from({ length: 6 }, (_, i) => ({
    t: start + i * 1000,
    hr: 140 + i,
    speed: 3.2,
    distance: i * 3.2,
    power: 250 + i,
    gct: 240 + i,
    vertical_oscillation: 82.5,
    vertical_ratio: 7.8,
    stance_balance: 49.6,
    step_length: 1150,
    ...(i < 5 ? { rr: i === 2 ? [420, 425, 430, 428, 431, 433, 429] : [430, 428] } : {}),
  }));
  const fit = parseFit(writeFit({ start, end: start + 6000, sport: "running", samples }));
  expect(fit.records[0]).toMatchObject({ power: 250, gct: 240, verticalOscillation: 82.5, verticalRatio: 7.8, stanceBalance: 49.6, stepLength: 1150, rr: [430, 428] });
  expect(fit.records[2]!.rr).toEqual([420, 425, 430, 428, 431, 433, 429]);
  expect(fit.records[5]!.rr).toBeUndefined();
  expect(fit.rr).toHaveLength(15);
  // A file without them is as it was: no extra fields, nothing read.
  const plain = parseFit(writeFit({ start, end: start + 6000, sport: "running", samples: samples.map(({ t, hr }) => ({ t, hr })) }));
  expect(plain.records[0]).toEqual({ time: new Date(start).toISOString(), heartRate: 140 });
  expect(plain.rr).toBeUndefined();
  // In the workout's streams, for the aerobic-threshold and form work to come.
  const disk = new MemoryDisk();
  await importWorkout(new LocalStore(disk), { id: "test", name: "Test" }, "w1", { start, end: start + 6000, sport: "running", samples });
  const lib = new Library(disk);
  const [row] = await lib.activities();
  const st = (await lib.streams(row!.id, undefined, 100)) as { available: string[]; streams: Record<string, unknown[]> };
  expect(st.available).toEqual(expect.arrayContaining(["watts", "gct", "vertical_oscillation", "vertical_ratio", "stance_balance", "step_length", "rr"]));
  expect(st.streams.gct![1]).toBe(241);
  expect(st.streams.rr![2]).toEqual([420, 425, 430, 428, 431, 433, 429]);
  expect(st.streams.rr![5]).toBeNull();
});
