/** The plan's workouts for other watches: intervals.icu's text and events, FIT workout files, Health Connect. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { fitCrc } from "../src/fit-write.ts";
import { Intervals, icuExternalId } from "../src/intervals.ts";
import { FIT, fitSteps, hcPlanned, icuLength, icuTarget, icuText, icuType, workoutFit, workoutSeconds } from "../src/workout/export.ts";
import { plannedWeek, workoutFor, type PlannedWorkout, type WeekLike } from "../src/workout/from-plan.ts";
import type { Workout } from "../src/workout/guide.ts";

const intervals: Workout = {
  name: "Tue 6 x 800 m",
  blocks: [
    { kind: "warmup", duration_s: 900, hr: [120, 140] },
    { repeat: 6, steps: [{ kind: "run", distance_m: 800, pace: [230, 240] }, { kind: "recover", duration_s: 90 }] },
    { kind: "cooldown", duration_s: 600 },
  ],
};

test("lengths and targets in intervals.icu's words", () => {
  expect(icuLength({ duration_s: 600 })).toBe("10m");
  expect(icuLength({ duration_s: 90 })).toBe("1m30s");
  expect(icuLength({ duration_s: 3720 })).toBe("1h2m");
  expect(icuLength({ distance_m: 800 })).toBe("800mtr");
  expect(icuLength({ distance_m: 5000 })).toBe("5km");
  expect(icuLength({ distance_m: 1500 })).toBe("1.5km");
  expect(icuTarget({ kind: "run", duration_s: 60, hr: [133, 152] }, 190)).toBe("70-80% HR");
  expect(icuTarget({ kind: "run", duration_s: 60, hr: [133, 152] })).toBe("");
  expect(icuTarget({ kind: "run", duration_s: 60, pace: [290, 300] })).toBe("4:50-5:00/km Pace");
  expect(icuTarget({ kind: "run", duration_s: 60, speed: [10, 12] })).toBe("5:00-6:00/km Pace");
  expect(icuTarget({ kind: "run", duration_s: 60, power: [200, 250] })).toBe("200-250w");
});

test("a structured session as intervals.icu's workout text", () => {
  expect(icuText(intervals, { maxHr: 200, notes: "Run the 800s at 5k effort. 6 x 800 m in all." })).toBe(
    [
      "Run the 800s at 5k effort. 6 times 800 m in all.",
      "- Warm up 15m 60-70% HR",
      "6x\n- Run 800mtr 3:50-4:00/km Pace\n- Recover 1m30s",
      "- Cool down 10m",
    ].join("\n\n"),
  );
  // A step's own title wins, and numbers in cue words don't leak into the step.
  expect(icuText({ name: "Sat Long", blocks: [{ kind: "run", duration_s: 1800, title: "Run", note: { title: "Fuel", text: "Gel and 2 sips" } }] })).toBe("- Fuel Gel and sips 30m");
  expect(icuType("easy")).toBe("Run");
  expect(icuType("strength")).toBe("WeightTraining");
  expect(icuType("cross")).toBe("Workout");
});

/** The messages of a FIT file: global number and field values (strings as text), with the CRCs checked. */
function readFit(b: Uint8Array): Array<{ global: number; f: Record<number, number | string> }> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect(b[0]).toBe(14);
  expect(new TextDecoder().decode(b.subarray(8, 12))).toBe(".FIT");
  expect(v.getUint16(12, true)).toBe(fitCrc(b.subarray(0, 12)));
  const size = v.getUint32(4, true);
  expect(b.length).toBe(14 + size + 2);
  expect(v.getUint16(14 + size, true)).toBe(fitCrc(b.subarray(0, 14 + size)));
  const defs = new Map<number, { global: number; fields: Array<[number, number, number]> }>();
  const out: Array<{ global: number; f: Record<number, number | string> }> = [];
  let at = 14;
  while (at < 14 + size) {
    const h = b[at++]!;
    const local = h & 0x0f;
    if (h & 0x40) {
      const global = v.getUint16(at + 2, true);
      const n = b[at + 4]!;
      const fields: Array<[number, number, number]> = [];
      for (let i = 0; i < n; i++) fields.push([b[at + 5 + i * 3]!, b[at + 6 + i * 3]!, b[at + 7 + i * 3]!]);
      defs.set(local, { global, fields });
      at += 5 + n * 3;
      continue;
    }
    const d = defs.get(local)!;
    const f: Record<number, number | string> = {};
    for (const [num, sz, type] of d.fields) {
      if (type === 0x07) f[num] = new TextDecoder().decode(b.subarray(at, at + sz)).replace(/\0.*$/s, "");
      else {
        const x = sz === 1 ? b[at]! : sz === 2 ? v.getUint16(at, true) : v.getUint32(at, true);
        if (x !== 2 ** (8 * sz) - 1) f[num] = x;
      }
      at += sz;
    }
    out.push({ global: d.global, f });
  }
  return out;
}

test("a FIT workout file: file id, the workout, its steps with the repeat pointing back", () => {
  const msgs = readFit(workoutFit(intervals, "running", Date.parse("2026-11-10T08:00:00Z")));
  expect(msgs[0]).toMatchObject({ global: 0, f: { 0: 5, 1: 255 } });
  expect(msgs[1]).toMatchObject({ global: 26, f: { 4: 1, 6: 5, 8: "Tue 6 x 800 m" } });
  const steps = msgs.filter((m) => m.global === 27).map((m) => m.f);
  expect(steps).toHaveLength(5);
  // Warm-up: 15 min, heart rate 120-140 bpm (FIT: bpm + 100).
  expect(steps[0]).toMatchObject({ 254: 0, 0: "Warm up", 1: FIT.duration.time, 2: 900_000, 3: FIT.target.heartRate, 4: 0, 5: 220, 6: 240, 7: FIT.intensity.warmup });
  // 800 m at 3:50-4:00 /km: speed 4.167-4.348 m/s, in mm/s.
  expect(steps[1]).toMatchObject({ 1: FIT.duration.distance, 2: 80_000, 3: FIT.target.speed, 5: 4167, 6: 4348, 7: FIT.intensity.active });
  expect(steps[2]).toMatchObject({ 1: FIT.duration.time, 2: 90_000, 3: FIT.target.open, 7: FIT.intensity.recovery });
  // Repeat steps 1-2 six times.
  expect(steps[3]).toMatchObject({ 254: 3, 1: FIT.duration.repeat, 2: 1, 4: 6 });
  expect(steps[4]).toMatchObject({ 0: "Cool down", 7: FIT.intensity.cooldown });
});

test("strength as a FIT workout: training, rests as rest, the exercise named", () => {
  const r = workoutFor({ date: "2026-11-12", kind: "strength", title: "Strength", duration_min: 30, exercises: [{ id: "squat", sets: 3, reps: 10 }] as never }, []);
  expect("workout" in r).toBe(true);
  const w = (r as { workout: Workout }).workout;
  const steps = fitSteps(w, "strength");
  expect(steps.some((s) => s.intensity === FIT.intensity.rest)).toBe(true);
  expect(steps.find((s) => s.duration === FIT.duration.repeat)?.targetValue).toBe(3);
  const msgs = readFit(workoutFit(w, "strength"));
  expect(msgs[1]!.f).toMatchObject({ 4: 10, 11: 20 });
});

test("Health Connect: steps in a row share a block, repeats keep theirs, pace as speed", () => {
  const p = hcPlanned({ date: "2026-11-11", kind: "intervals", title: "6 x 800 m", notes: "Hard but even", workout: intervals }, Date.parse("2026-11-11T17:00:00Z"));
  expect(p).toMatchObject({ id: "tartan-plan-2026-11-11-intervals", title: "Tue 6 x 800 m", exercise: "running", notes: "Hard but even" });
  expect(p.blocks.map((b) => b.repetitions)).toEqual([1, 6, 1]);
  expect(p.blocks[0]!.steps[0]).toMatchObject({ phase: "warmup", duration_s: 900, hr: [120, 140] });
  expect(p.blocks[1]!.steps[0]).toMatchObject({ phase: "active", distance_m: 800, speed: [4.167, 4.348] });
  expect(p.blocks[1]!.steps[1]).toMatchObject({ phase: "recovery", duration_s: 90 });
  // 15 + 6 × (800 m at 3:55 + 1:30) + 10 minutes.
  expect(workoutSeconds(intervals)).toBe(900 + 6 * (188 + 90) + 600);
  expect(p.end - p.start).toBe(workoutSeconds(intervals) * 1000);
});

const week: WeekLike = {
  today: "2026-11-10",
  plan: { zones: [{ name: "Easy", heart_rate: "130-145 bpm" }] },
  weeks: [
    {
      days: [
        { date: "2026-11-09", sessions: [{ date: "2026-11-09", kind: "easy", title: "Easy run", duration_min: 40, status: "missed" }] },
        { date: "2026-11-10", sessions: [{ date: "2026-11-10", kind: "easy", title: "Easy run", duration_min: 40, status: "today" }] },
        { date: "2026-11-11", sessions: [{ date: "2026-11-11", kind: "rest", title: "Rest", status: "planned" }] },
        { date: "2026-11-12", sessions: [{ date: "2026-11-12", kind: "tempo", title: "Tempo", duration_min: 45, target: "4:50-5:00 /km", status: "planned", notes: "Steady" }] },
        { date: "2026-11-17", sessions: [{ date: "2026-11-17", kind: "easy", title: "Easy run", duration_min: 30, status: "planned" }] },
      ],
    },
  ],
};

test("the coming 7 days: today on, rest and past off, a week out not yet", () => {
  const list = plannedWeek(week, null);
  expect(list.map((p) => `${p.date}:${p.kind}`)).toEqual(["2026-11-10:easy", "2026-11-12:tempo"]);
  expect(list[0]!.workout.blocks[0]).toMatchObject({ hr: [130, 145] });
  expect(list[1]).toMatchObject({ notes: "Steady", title: "Tempo" });
});

// ---------------------------------------------------------------- intervals.icu, against a mock

let server: ReturnType<typeof Bun.serve>;
const calls: Array<{ method: string; path: string; body?: unknown }> = [];
let events: Array<{ id: number; external_id?: string; name: string }> = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.json() : undefined;
      calls.push({ method: req.method, path: u.pathname + u.search, body });
      if (req.headers.get("authorization") !== `Basic ${btoa("API_KEY:k")}`) return new Response("no", { status: 401 });
      if (u.pathname === "/api/v1/athlete/0") return Response.json({ id: "i7", name: "Sam" });
      if (u.pathname === "/api/v1/athlete/i7/events" && req.method === "GET") return Response.json(events);
      const del = u.pathname.match(/^\/api\/v1\/athlete\/i7\/events\/(\d+)$/);
      if (del && req.method === "DELETE") {
        events = events.filter((e) => e.id !== Number(del[1]));
        return new Response(null, { status: 200 });
      }
      if (u.pathname === "/api/v1/athlete/i7/events/bulk" && req.method === "POST") {
        for (const e of body as Array<{ external_id: string; name: string }>) events.push({ id: events.length + 100, ...e });
        return Response.json(body);
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

test("intervals.icu keeps the coming week: missing ones on, Tartan's stale ones off, others' never touched", async () => {
  const disk = new MemoryDisk();
  const icu = new Intervals(disk);
  await icu.connect("k", "", server.url.toString().replace(/\/$/, ""));
  const list: PlannedWorkout[] = plannedWeek(week, null);
  events = [
    { id: 1, name: "Coach's own", external_id: "trainingpeaks-1" },
    { id: 2, name: "Old Tartan", external_id: "tartan-2026-11-10-oldkey" },
    { id: 3, name: "Same", external_id: icuExternalId(list[1]!) },
    { id: 4, name: "By hand" },
  ];
  calls.length = 0;
  const r = await icu.sendPlan(list, { today: "2026-11-10", time: (d) => (d === "2026-11-10" ? "18:00" : "07:30"), maxHr: 190 });
  expect(r).toEqual({ added: 1, removed: 1, there: 2 });
  expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/athlete/i7/events?oldest=2026-11-10&newest=2027-01-09&category=WORKOUT" });
  expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/v1/athlete/i7/events/2"]);
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.path).toBe("/api/v1/athlete/i7/events/bulk?upsert=true");
  expect(post.body).toEqual([
    {
      category: "WORKOUT",
      start_date_local: "2026-11-10T18:00:00",
      type: "Run",
      name: "Easy run",
      description: "- Run 40m 68-76% HR",
      external_id: icuExternalId(list[0]!),
      moving_time: 2400,
    },
  ]);
  expect((await icu.status()).plan).toMatchObject({ on: true, added: 1, removed: 1, there: 2 });
  // Again: nothing to do.
  calls.length = 0;
  expect(await icu.sendPlan(list, { today: "2026-11-10", time: () => "18:00" })).toEqual({ added: 0, removed: 0, there: 2 });
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  // Stop: Tartan's come off, the others stay.
  expect(await icu.stopPlan("2026-11-10")).toEqual({ removed: 2 });
  expect(events.map((e) => e.id)).toEqual([1, 4]);
  expect((await icu.status()).plan).toEqual({ on: false });
});
