import { expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { Health, healthDays, healthView, newRecords, nightOf, restingHr, TRENDS_DIR } from "../src/health.ts";
import { WatchSession } from "../src/protocol/session.ts";
import { decodeTrendPage, encodeTrendPage, TREND_STEP_MS, type TrendRecord } from "../src/protocol/trends.ts";
import { readiness } from "../src/readiness.ts";
import { FakeWatch } from "../src/sim/fake-watch.ts";

// The last page of a TrendData read on a Run 2 (capture of 18 Oct 2026), from the reply's type
// id on: 8 records, stale bytes in the absent fields, and one blood-oxygen reading.
const PAGE =
  "05ab4e25000008007a1a0c0000000066de190000000000000000e866bf4ea101000001427a1a00e07510a0222e1e00d5761018a6eb96012d00000000000000000000a88ec84ea101000000480000000000000000000000a6eb96589b7a1a012d0000000000000000000068b6d14ea10100000048000000c7d4193bfdffff002a1cf4d09b7a1a012d0f00000000000000000028deda4ea10100000165000000c59610989b7a1a0006771091c00700012d00000000000000000000e805e44ea101000001437a1a00004300a05dde1900027710c89b7a1a012d76100000000000000000a82ded4ea10100000036481e0087751001000000009c7a1af09b7a1a012d751000000000000000006855f64ea1010000009c7a1a00877510109c7a1a00de1100409c7a1a012d7a1a0000000000000000287dff4ea101000001330000016f9810ec51783f019c7a1ae5d0b0c0012d0000";
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((x) => parseInt(x, 16)));

test("a captured trend page: heart rate only where present, blood oxygen as a percentage", () => {
  // The struct starts after the type id, header and two bytes of padding.
  const rs = decodeTrendPage(bytes(PAGE).subarray(6));
  expect(rs.length).toBe(8);
  expect(rs.map((r) => new Date(r.t).toISOString().slice(11, 16))).toEqual(["11:22", "11:32", "11:42", "11:52", "12:02", "12:12", "12:22", "12:32"]);
  expect(rs.map((r) => r.hr ?? null)).toEqual([66, null, null, 101, 67, null, null, 51]);
  expect(rs.filter((r) => r.spo2 !== undefined).map((r) => r.spo2)).toEqual([97]);
  expect(rs.every((r) => r.steps === 0 && r.energy_j === 0)).toBe(true);
});

test("trend pages encode and decode the same", () => {
  const rs: TrendRecord[] = [
    { t: 1_792_239_128_000, steps: 1095, energy_j: 326_500, hr: 117 },
    { t: 1_792_239_728_000, steps: 0, energy_j: 0 },
    { t: 1_792_240_328_000, steps: 3, energy_j: 0, hr: 55, spo2: 96 },
  ];
  expect(decodeTrendPage(encodeTrendPage(rs))).toEqual(rs);
});

test("the session pages through the watch's trend log and only reads", async () => {
  const start = 1_792_239_128_000;
  const trends = Array.from({ length: 25 }, (_, i): TrendRecord => ({ t: start + i * TREND_STEP_MS, steps: i, energy_j: 0, ...(i % 3 ? { hr: 50 + i } : {}) }));
  const sent: Uint8Array[] = [];
  const lines: string[] = [];
  const watch = new FakeWatch({ name: "Suunto Run 2 0001", generation: "ng3", files: {}, trends, sent });
  const s = new WatchSession(watch, { chunkDelayMs: 0, frameGapMs: 0, log: (m) => lines.push(m) });
  await s.open();
  // Asked from a time the watch doesn't know: it answers from its oldest.
  const got = await s.readTrends(start - 86400_000);
  expect(got).toEqual(trends);
  expect(lines.some((l) => /^\[trends\] 25 records in 3 pages/.test(l))).toBe(true);
  // Nothing but reads (GET is message type 0x01 after the bring-up).
  const PUT = 0x02;
  expect(sent.filter((f) => (f[1]! & 0x1f) === PUT).length).toBe(0);
});

// A night and a morning in local time: awake until 22:00, still with a low heart rate until
// 07:00 (one restless 10 minutes at 02:00), then walking.
const at = (local: string) => new Date(local).getTime();
function night(): TrendRecord[] {
  const out: TrendRecord[] = [];
  for (let t = at("2026-10-17T20:00:00"); t < at("2026-10-18T09:00:00"); t += TREND_STEP_MS) {
    const asleep = t >= at("2026-10-17T22:00:00") && t < at("2026-10-18T07:00:00");
    const restless = t === at("2026-10-18T02:00:00");
    const deep = t >= at("2026-10-18T03:00:00") && t < at("2026-10-18T03:30:00");
    out.push({ t, steps: asleep && !restless ? 0 : 400, energy_j: asleep ? 0 : 20_000, hr: deep ? 46 : asleep ? 52 : 88 });
  }
  return out;
}

test("the night's rest: the longest still stretch, one restless 10 minutes allowed", () => {
  const n = nightOf(night(), "2026-10-18");
  expect(n).toMatchObject({ start: "2026-10-17T22:00", end: "2026-10-18T07:00", minutes: 540, hr_min: 46, estimated: true });
  // Not worn (no heart rate): no night.
  expect(nightOf(night().map(({ hr: _, ...r }) => r), "2026-10-18")).toBeNull();
});

test("resting heart rate is the lowest still half hour", () => {
  expect(restingHr(night())).toBe(46);
  // Moving the whole time: none.
  expect(restingHr(night().map((r) => ({ ...r, steps: 400 })))).toBeNull();
});

test("a day: steps, active energy, worn time, blood oxygen", () => {
  const rs = night().map((r, i) => (i === 40 ? { ...r, spo2: 95 } : r));
  const [day] = healthDays(rs, 1, at("2026-10-18T10:00:00"));
  expect(day!.date).toBe("2026-10-18");
  // 00:00 to 09:00: 54 records, 12 of them after 07:00 walking, one restless at 02:00.
  expect(day!.worn_min).toBe(540);
  expect(day!.steps).toBe(13 * 400);
  expect(day!.active_kcal).toBe(Math.round((12 * 20_000) / 4184));
  expect(day!.resting_hr).toBe(46);
  expect(day!.spo2).toEqual([{ at: "2026-10-18T02:40", pct: 95 }]);
  expect(day!.night?.minutes).toBe(540);
});

test("saved records from every watch, a usual resting heart rate, and readiness when it's up", async () => {
  const disk = new MemoryDisk();
  const now = at("2026-10-18T10:00:00");
  const days: TrendRecord[][] = [];
  // Five mornings at 48 bpm, then this one at 57.
  for (let d = 5; d >= 0; d--) {
    const base = at("2026-10-18T04:00:00") - d * 86400_000;
    days.push(Array.from({ length: 4 }, (_, i) => ({ t: base + i * TREND_STEP_MS, steps: 0, energy_j: 0, hr: d ? 48 : 57 })));
  }
  await disk.write(`watches/run-2/files${TRENDS_DIR}/${days[0]![0]!.t}.json`, JSON.stringify(days.slice(0, 3).flat()));
  await disk.write(`watches/run-2/files${TRENDS_DIR}/${days[3]![0]!.t}.json`, JSON.stringify(days.slice(3).flat()));
  const view = await new Health(disk).view(now);
  expect(view.days[0]).toMatchObject({ date: "2026-10-18", resting_hr: 57 });
  expect(view.resting_baseline).toBe(48);
  expect(view.last_t).toBe(days[5]!.at(-1)!.t);
  expect(view.latest).toMatchObject({ hr: 57 });
  const r = readiness(0, null, { resting_hr: 57, resting_baseline: 48 });
  expect(r.level).toBe("ready");
  expect(r.reasons).toEqual(["resting heart rate 9 bpm above your usual"]);
  expect(readiness(0, { date: "2026-10-18", sleep: 1, legs: 2 }, { resting_hr: 59, resting_baseline: 48 })).toMatchObject({ level: "go easy", reasons: ["resting heart rate 11 bpm above your usual", "slept badly"] });
  expect(readiness(0, null, { resting_hr: 50, resting_baseline: 48 }).reasons).toEqual([]);
});

test("only settled records newer than the last saved are saved", () => {
  const now = at("2026-10-18T12:39:00");
  const rs = [10, 20, 30, 40].map((m) => ({ t: at("2026-10-18T12:00:00") + (m - 10) * 60_000, steps: 0, energy_j: 0 }));
  // 12:00 saved already; 12:10 settled; 12:20 and 12:30 still being filled in.
  expect(newRecords(rs, rs[0]!.t, now).map((r) => r.t)).toEqual([rs[1]!.t]);
});

test("today's heart rate for the sparkline, every 10 minutes from midnight", () => {
  const v = healthView(night(), at("2026-10-18T01:00:00"));
  expect(v.today_hr).toEqual([52, 52, 52, 52, 52, 52]);
});

test("measured sleep takes the place of the sleep answer", () => {
  const body = (sleep_min: number | null) => ({ resting_hr: null, resting_baseline: null, sleep_min });
  // A short night counts whatever was answered; a long one doesn't.
  expect(readiness(0, { date: "2026-10-18", sleep: 3, legs: 2 }, body(280))).toMatchObject({ level: "go easy", reasons: ["a short night (4 h 40)"] });
  expect(readiness(0, { date: "2026-10-18", legs: 2 }, body(340)).reasons).toEqual(["a short night (5 h 40)"]);
  expect(readiness(0, { date: "2026-10-18", sleep: 1, legs: 2 }, body(470)).reasons).toEqual([]);
  // A full night and fresh legs: a step up, as "slept well" was.
  expect(readiness(-20, { date: "2026-10-18", legs: 3 }, body(480)).level).toBe("ready");
  // Nothing measured: the answer counts.
  expect(readiness(0, { date: "2026-10-18", sleep: 1, legs: 2 }, body(null)).reasons).toEqual(["slept badly"]);
});

test("today's body signs: resting heart rate, the usual, and last night", async () => {
  const { watchLogDays } = await import("../src/health.ts");
  const { Signals, bodySignsOf } = await import("../src/signals.ts");
  const signals = new Signals(new MemoryDisk());
  await signals.put(watchLogDays(night(), at("2026-10-18T09:30:00")), { replace: true });
  const { day, usual } = await signals.day("2026-10-18");
  expect(day).toMatchObject({ resting_hr: 46, sleep_min: 540, sleep_estimated: true, from: { resting_hr: "suunto", sleep_min: "suunto" } });
  expect(bodySignsOf(day, usual)).toMatchObject({ resting_hr: 46, resting_baseline: null, sleep_min: 540, hrv_ms: null, hrv_baseline: null });
});

test("pain decides on its own, and HRV well below the usual counts", () => {
  const day = "2026-10-18";
  expect(readiness(0, { date: day, legs: 2, pain: { area: "calf", level: 1 } })).toMatchObject({ level: "ready", reasons: ["a niggle in your calf: keep it easy and see how it feels"] });
  expect(readiness(5, { date: day, legs: 3, pain: { area: "knee", level: 2 } }).level).toBe("go easy");
  expect(readiness(5, { date: day, legs: 3, pain: { area: "achilles", level: 3 } })).toMatchObject({ level: "rest", reasons: ["a painful Achilles: rest, and see a physio if it lasts"] });
  const body = (hrv_ms: number) => ({ resting_hr: null, resting_baseline: null, hrv_ms, hrv_baseline: 60 });
  expect(readiness(0, null, body(48)).reasons).toEqual(["HRV 20% below your usual"]);
  expect(readiness(0, null, body(42)).level).toBe("go easy");
  expect(readiness(0, null, body(56)).reasons).toEqual([]);
});

test("check-ins keep pain, and the coach gets the last three weeks of it", async () => {
  const { CheckIns } = await import("../src/readiness.ts");
  const c = new CheckIns(new MemoryDisk());
  await c.save({ date: "2026-10-10", legs: 2, pain: { area: "shin", level: 1 } });
  await c.save({ date: "2026-10-16", legs: 1, pain: { area: "calf", level: 2 } });
  await c.save({ date: "2026-10-17", legs: 2 });
  await expect(c.save({ date: "2026-10-18", legs: 2, pain: { area: "elbow" as never, level: 2 } })).rejects.toThrow(/pain/);
  // Sleep can be answered before legs: nothing is filled in for the question left open.
  await c.save({ date: "2026-10-19", sleep: 3 });
  expect((await c.get("2026-10-19"))).toEqual({ date: "2026-10-19", sleep: 3 });
  await expect(c.save({ date: "2026-10-20" })).rejects.toThrow(/check-in/);
  expect(await c.niggles(21, at("2026-10-18T09:00:00"))).toEqual([{ date: "2026-10-16", area: "calf", level: 2 }, { date: "2026-10-10", area: "shin", level: 1 }]);
  expect(await c.niggles(5, at("2026-10-18T09:00:00"))).toEqual([{ date: "2026-10-16", area: "calf", level: 2 }]);
});
