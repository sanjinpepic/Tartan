/**
 * Moments on a finished run (src/run-moments.ts), from synthetic recordings: none on a steady easy
 * run, a climb that took the heart rate too high, a fast start, a long run's fade and its
 * decoupling, slow reps, a strong finish; nothing on hills from rough GPS altitude, nothing about
 * effort without heart rate; never more than one good and two to work on.
 */
import { beforeAll, expect, test } from "bun:test";
import { afterRunWords } from "../src/after-run.ts";
import { FILES_FOLDER, importWorkout } from "../src/import.ts";
import { Library } from "../src/library.ts";
import { LocalStore } from "../src/store.ts";
import { dataTools } from "../src/tools.ts";
import { LocalApiBackend } from "../web/local-api.ts";
import { loadMoments, onThinned, runMoments, type Moment, type MomentContext } from "../src/run-moments.ts";
import { MemoryDisk } from "../src/disk.ts";
import type { Workout } from "../src/workout/guide.ts";
import { reviewWorkout } from "../src/workout/review.ts";

/** A repeatable wobble, -1..1. */
function wobble(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return (s / 2147483648) * 2 - 1;
  };
}

interface Shape {
  km: number;
  /** s/km at a distance (m). */
  pace: (m: number) => number;
  /** bpm at a distance (m) and second; null: no heart rate. */
  hr?: ((m: number, t: number) => number) | null;
  /** Altitude at a distance (m). */
  alt?: (m: number) => number;
  /** Altitude noise, ± metres per sample (GPS). */
  altNoise?: number;
}

/** A 1 Hz recording heading north from 60° N. */
function record(s: Shape) {
  const r = wobble();
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: Array<number | null> = [];
  const altitude: number[] = [];
  const latlng: Array<[number, number]> = [];
  let t = 0;
  let d = 0;
  while (d < s.km * 1000) {
    time.push(t);
    distance.push(Math.round(d * 10) / 10);
    heartrate.push(s.hr ? Math.round(s.hr(d, t) + r() * 1.5) : null);
    altitude.push(Math.round(((s.alt?.(d) ?? 50) + (s.altNoise ? r() * s.altNoise : r() * 0.15)) * 10) / 10);
    latlng.push([60 + d / 111_000, 25]);
    const v = 1000 / (s.pace(d) * (1 + r() * 0.01));
    d += v;
    t += 1;
  }
  return { time, distance, heartrate: s.hr ? heartrate : undefined, altitude, latlng };
}

const EASY = 148;
const ctx = (o: MomentContext = {}): MomentContext => ({ easy_max: EASY, max_hr: 190, source: "watch", sport: "Run", ...o });
/** Heart rate rising over the first 5 minutes to `hr`. */
const settle = (hr: number) => (_m: number, t: number) => (t < 300 ? 110 + ((hr - 110) * t) / 300 : hr);

const capped = (ms: Moment[]) => {
  expect(ms.filter((m) => m.kind === "good").length).toBeLessThanOrEqual(1);
  expect(ms.filter((m) => m.kind === "work_on").length).toBeLessThanOrEqual(2);
  for (const m of ms) {
    // Every number the line says is one of its facts.
    const said = [...m.text.matchAll(/\d+(?:[.:]\d+)?/g)].map((x) => x[0]).filter((x) => !/^\d\/\d$/.test(x));
    const known = Object.values(m.facts).join(" ");
    for (const n of said) expect(known).toContain(n);
    expect(m.text).not.toContain("!");
    expect(m.to_m).toBeGreaterThan(m.from_m);
    expect(m.to_i).toBeGreaterThan(m.from_i);
  }
  return ms;
};

// A climb of 40 m between 3.0 and 3.6 km (6.7%), flat around it.
const hill = (m: number) => 50 + (m < 3000 ? 0 : m < 3600 ? ((m - 3000) / 600) * 40 : 40);
const hillPace = (m: number) => (m >= 3000 && m < 3600 ? 400 : 345);
const hillHr = (m: number, t: number) => (m >= 3000 && m < 3600 ? 136 + ((m - 3000) / 600) * 36 : m >= 3600 && m < 3900 ? 172 - ((m - 3600) / 300) * 36 : settle(136)(m, t));

test("a steady easy run: nothing to point at", () => {
  const c = record({ km: 8, pace: () => 345, hr: settle(136), alt: (m) => 50 + 3 * Math.sin(m / 700) });
  expect(runMoments(c, ctx())).toEqual([]);
  // The same, filling a planned easy run, or with no plan at all.
  expect(runMoments(c, ctx({ kind: "easy" }))).toEqual([]);
  expect(runMoments(c, {})).toEqual([]);
});

test("an easy run with a 40 m climb that took the heart rate to 172: one to work on, pinned at the climb", () => {
  const c = record({ km: 8, pace: hillPace, hr: hillHr, alt: hill });
  const ms = capped(runMoments(c, ctx()));
  expect(ms.length).toBe(1);
  const m = ms[0]!;
  expect(m).toMatchObject({ kind: "work_on", id: "hill_hr", where: "the climb at 3 km" });
  expect(m.facts).toMatchObject({ easy_max: EASY });
  expect(m.facts.climb_m).toBeWithin(37, 41);
  expect(m.facts.grade_pct).toBeWithin(6, 8);
  expect(m.facts.hr_peak).toBeGreaterThanOrEqual(168);
  expect(m.from_m).toBeGreaterThan(2900);
  expect(m.to_m).toBeLessThan(3700);
  expect(m.at![0]).toBeCloseTo(60 + 3300 / 111_000, 3);
  expect(c.distance[m.from_i]).toBeCloseTo(m.from_m, -1);
  expect(m.text).toBe(`The climb at 3 km took your heart rate to ${m.facts.hr_peak}; easy tops out at 148. On an easy run, slow down on hills and keep the effort, not the pace.`);
  // A long run says so.
  expect(runMoments(c, ctx({ kind: "long" }))[0]!.text).toContain("On a long run,");
  // Taken easy instead: heart rate inside easy and the pace eased: that's the good one.
  const calm = record({ km: 8, pace: hillPace, hr: (m, t) => (m >= 3000 && m < 3900 ? 144 : settle(136)(m, t)), alt: hill });
  const good = capped(runMoments(calm, ctx()));
  expect(good.map((x) => [x.kind, x.id])).toEqual([["good", "hill_steady"]]);
});

test("heart rate and altitude on rows of their own, between the rows with distance (the watch's own file)", () => {
  const c = record({ km: 8, pace: hillPace, hr: hillHr, alt: hill });
  const split = { time: [] as number[], distance: [] as Array<number | null>, heartrate: [] as Array<number | null>, altitude: [] as Array<number | null>, latlng: [] as Array<[number, number] | null> };
  c.time.forEach((t, k) => {
    split.time.push(t, t);
    split.distance.push(c.distance[k]!, null);
    split.latlng.push(c.latlng[k]!, null);
    split.heartrate.push(null, c.heartrate![k]!);
    split.altitude.push(null, c.altitude[k]!);
  });
  expect(runMoments(split, ctx()).map((m) => m.id)).toEqual(["hill_hr"]);
});

test("the same climb from the phone's GPS altitude, or from rough altitude: no hill moment", () => {
  const smooth = record({ km: 8, pace: hillPace, hr: hillHr, alt: hill });
  expect(runMoments(smooth, ctx({ source: "phone" }))).toEqual([]);
  expect(runMoments(smooth, ctx({ source: "health" }))).toEqual([]);
  const rough = record({ km: 8, pace: hillPace, hr: hillHr, alt: hill, altNoise: 6 });
  expect(runMoments(rough, ctx()).filter((m) => m.id.startsWith("hill") || m.id.startsWith("downhill"))).toEqual([]);
  // No altitude at all.
  expect(runMoments({ ...smooth, altitude: undefined }, ctx())).toEqual([]);
});

test("a fast start: the first 2 km quicker and harder than the rest", () => {
  const c = record({ km: 9, pace: (m) => (m < 2000 ? 305 : 345), hr: (m, t) => (m < 2000 ? Math.min(150, settle(150)(m, t)) : 139) });
  const ms = capped(runMoments(c, ctx()));
  expect(ms.map((m) => m.id)).toEqual(["fast_start"]);
  expect(ms[0]!.facts).toMatchObject({ first_km: 2, start_pace: "5:05", rest_pace: "5:45", rest_hr: 139 });
  expect(ms[0]!.from_m).toBe(0);
  expect(ms[0]!.text).toMatch(/^The first 2 km went at 5:05 \/km and heart rate \d+, the rest at 5:45 and 139\. Start slower/);
  // Downhill all the way out is no fast start.
  const down = record({ km: 9, pace: (m) => (m < 2000 ? 305 : 345), hr: settle(139), alt: (m) => (m < 2000 ? 150 - m * 0.05 : 50) });
  expect(runMoments(down, ctx()).map((m) => m.id)).not.toContain("fast_start");
});

test("a long run that fades, and one that decouples: the last third pinned", () => {
  const fade = record({ km: 21, pace: (m) => (m < 14000 ? 350 : 385), hr: settle(140) });
  const f = capped(runMoments(fade, ctx({ kind: "long" })));
  expect(f.map((m) => m.id)).toEqual(["fade"]);
  expect(f[0]!.facts).toMatchObject({ early_pace: "5:50", late_pace: "6:25", slower_s: 35 });
  expect(f[0]!.from_m).toBeGreaterThan(13900);
  expect(f[0]!.to_m).toBeGreaterThan(20900);
  expect(f[0]!.where).toBe(`the last ${f[0]!.facts.last_km} km`);

  // The same pace, the heart rate drifting up 140 → 154 over the last third.
  const drift = record({ km: 21, pace: () => 350, hr: (m, t) => (m < 14000 ? settle(140)(m, t) : 140 + ((m - 14000) / 7000) * 22) });
  const d = capped(runMoments(drift, ctx({ kind: "long" })));
  expect(d.map((m) => m.id)).toEqual(["decoupling"]);
  expect(d[0]!.facts.decoupling_pct).toBeGreaterThanOrEqual(5);
  expect(d[0]!.text).toContain("% decoupling.");

  // Held: even pace, even heart rate: the good one.
  const held = capped(runMoments(record({ km: 21, pace: () => 350, hr: settle(140) }), ctx({ kind: "long" })));
  expect(held.map((m) => [m.kind, m.id])).toEqual([["good", "held_long"]]);
});

test("intervals with two slow reps: both pinned; all on target: the good one", () => {
  const w: Workout = {
    name: "6 × 800 m",
    blocks: [
      { kind: "warmup", duration_s: 900 },
      { repeat: 6, steps: [{ kind: "run", distance_m: 800, pace: [240, 250] }, { kind: "recover", duration_s: 120 }] },
      { kind: "cooldown", duration_s: 600 },
    ],
  };
  const make = (slow: number[]) => {
    const time: number[] = [];
    const distance: number[] = [];
    const heartrate: number[] = [];
    const latlng: Array<[number, number]> = [];
    let t = 0;
    let d = 0;
    const go = (secs: number, v: number, hr: number) => {
      for (let k = 0; k < secs; k++) {
        time.push(t++);
        distance.push(d);
        heartrate.push(hr);
        latlng.push([60 + d / 111_000, 25]);
        d += v;
      }
    };
    go(900, 2.9, 135);
    for (let r = 1; r <= 6; r++) {
      const pace = slow.includes(r) ? 262 : 245;
      go(Math.round((800 / 1000) * pace) + 1, 1000 / pace, 170);
      go(120, 2.2, 140);
    }
    go(600, 2.8, 130);
    return { time, distance, heartrate, latlng };
  };
  const c = make([5, 6]);
  const review = reviewWorkout(w, c);
  const ms = capped(runMoments(c, ctx({ kind: "intervals", review })));
  expect(ms.map((m) => [m.kind, m.id, m.where])).toEqual([
    ["work_on", "rep_slow", "rep 5/6"],
    ["work_on", "rep_slow", "rep 6/6"],
  ]);
  expect(ms[0]!.facts).toMatchObject({ rep: "Rep 5/6", target: "4:00-4:10 /km", actual: "4:24 /km", off: "14 s/km" });
  expect(ms[0]!.text).toBe("Rep 5/6 came in at 4:24 /km against 4:00-4:10 /km, 14 s/km slow. Start the early reps at the slow end of the range so the late ones hold.");
  // Pinned on the rep itself.
  const span = review.steps.find((s) => s.label === "Rep 5/6")!.span!;
  expect([ms[0]!.from_i, ms[0]!.to_i]).toEqual(span);

  const clean = make([]);
  const good = capped(runMoments(clean, ctx({ kind: "intervals", review: reviewWorkout(w, clean) })));
  expect(good.map((m) => [m.kind, m.id, m.text])).toEqual([["good", "reps_on_target", "All 6 reps on target, 4:00-4:10 /km."]]);
  // Four slow reps: still two pinned, the slowest.
  const four = make([2, 3, 4, 5]);
  expect(capped(runMoments(four, ctx({ kind: "intervals", review: reviewWorkout(w, four) }))).length).toBe(2);
});

test("a strong finish: the last km the fastest at a controlled heart rate", () => {
  const c = record({ km: 8, pace: (m) => (m >= 7000 ? 315 : 345), hr: (m, t) => (m >= 7000 ? 146 : settle(138)(m, t)) });
  const ms = capped(runMoments(c, ctx()));
  expect(ms.map((m) => [m.kind, m.id])).toEqual([["good", "strong_finish"]]);
  expect(ms[0]!.facts).toMatchObject({ last_pace: "5:15", usual_pace: "5:45" });
  expect(ms[0]!.to_m).toBeGreaterThan(7990);
  // A sprint at 175 on an easy day isn't controlled.
  const hard = record({ km: 8, pace: (m) => (m >= 7000 ? 315 : 345), hr: (m, t) => (m >= 7000 ? 175 : settle(138)(m, t)) });
  expect(runMoments(hard, ctx()).map((m) => m.id)).not.toContain("strong_finish");
});

test("no heart rate: no claim about effort", () => {
  // The climb, the strong finish and the long run's drift all need heart rate.
  for (const c of [
    record({ km: 8, pace: hillPace, hr: null, alt: hill }),
    record({ km: 8, pace: (m) => (m >= 7000 ? 315 : 345), hr: null }),
    record({ km: 21, pace: () => 350, hr: null }),
  ]) {
    const ms = capped(runMoments(c, ctx({ kind: "long" })));
    for (const m of ms) {
      expect(Object.keys(m.facts).filter((k) => /hr|decoupling|drift/.test(k))).toEqual([]);
      expect(m.text).not.toMatch(/heart|bpm|effort/i);
    }
    expect(ms.filter((m) => ["hill_hr", "hill_steady", "decoupling", "held_long", "strong_finish"].includes(m.id))).toEqual([]);
  }
  // A fast start by pace alone is still a fact about pace.
  const fast = capped(runMoments(record({ km: 9, pace: (m) => (m < 2000 ? 305 : 345), hr: null }), ctx()));
  expect(fast.map((m) => m.id)).toEqual(["fast_start"]);
  expect(Object.keys(fast[0]!.facts)).toEqual(["first_km", "start_pace", "rest_pace"]);
});

test("never more than one good and two to work on, and nothing on a short jog", () => {
  // A hard-starting, hill-spiking long run that also fades and finishes... everything at once.
  const c = record({
    km: 21,
    pace: (m) => (m < 2000 ? 300 : m >= 3000 && m < 3600 ? 400 : m < 14000 ? 345 : 390),
    hr: (m, t) => (m < 2000 ? Math.min(152, settle(152)(m, t)) : hillHr(m, t)),
    alt: hill,
  });
  const ms = capped(runMoments(c, ctx({ kind: "long" })));
  expect(ms.filter((m) => m.kind === "work_on").length).toBe(2);
  // In order along the route.
  expect(ms.map((m) => m.from_m)).toEqual([...ms.map((m) => m.from_m)].sort((a, b) => a - b));
  expect(runMoments(record({ km: 1.5, pace: () => 300, hr: settle(150) }), ctx())).toEqual([]);
  expect(runMoments({}, ctx())).toEqual([]);
});

test("on the sheet's thinned streams, kept per run, and a word in the note after the run", async () => {
  const c = record({ km: 8, pace: hillPace, hr: hillHr, alt: hill });
  const ms = runMoments(c, ctx());
  const thin = onThinned(ms, 4, Math.ceil(c.time.length / 4));
  expect(thin[0]!.from_i).toBe(Math.floor(ms[0]!.from_i / 4));
  expect(thin[0]!.to_i).toBe(Math.ceil(ms[0]!.to_i / 4));

  const disk = new MemoryDisk();
  let reads = 0;
  const deps = {
    disk,
    find: async (id: string) => ({ id, sport: "Run", streams_from: "watch:x" }),
    rawStreams: async () => (reads++, { source: "watch", columns: c as unknown as Record<string, unknown[]> }),
    view: async () => ({ weeks: [] }),
    review: async () => ({ error: "none" }),
    profile: async () => ({ max_hr: 190, zone_limits: [120, 149, 165, 178] as [number, number, number, number] }),
    family: (s: string) => (s === "Run" ? "run" : "other"),
  };
  expect((await loadMoments(deps, "a"))!.map((m) => m.id)).toEqual(["hill_hr"]);
  expect((await loadMoments(deps, "a"))!.map((m) => m.id)).toEqual(["hill_hr"]);
  expect(reads).toBe(1);
  expect(await loadMoments({ ...deps, find: async (id: string) => ({ id, sport: "Swim", streams_from: "watch:x" }) }, "b")).toBeNull();

  const w = afterRunWords({ distance_km: 8, moving_min: 47, avg_hr: 140 }, { id: "a", start: "2026-11-18T07:00:00Z", records: [] }, { when: "Tomorrow", sessions: [] }, ms);
  expect(w.text).toBe("5:53 /km at 140 bpm. One thing on the map: the climb at 3 km. Tomorrow is a rest day.");
  expect(w.facts.some((x) => x.startsWith("Moment 1 (to work on, the climb at 3 km"))).toBe(true);
  // None: the note as before.
  expect(afterRunWords({ distance_km: 8, moving_min: 47, avg_hr: 140 }, { id: "a", start: "2026-11-18T07:00:00Z", records: [] }, null, []).text).toBe("5:53 /km at 140 bpm.");
});

beforeAll(() => {
  (globalThis as { location?: unknown }).location = new URL("http://localhost/");
});

test("the workout sheet gets them on its own thinned streams; the coach's get_activity without pins", async () => {
  const disk = new MemoryDisk();
  const store = new LocalStore(disk);
  const start = Date.now() - 3 * 3600_000;
  const c = record({ km: 8, pace: hillPace, hr: hillHr, alt: hill });
  const samples = c.time.map((t, k) => ({ t: start + t * 1000, lat: c.latlng[k]![0], lon: c.latlng[k]![1], altitude: c.altitude[k], hr: c.heartrate![k]!, distance: c.distance[k] }));
  await importWorkout(store, FILES_FOLDER, "hill", { start, end: start + c.time.at(-1)! * 1000, sport: "running", samples });
  const id = (await new Library(disk).activities())[0]!.id;
  const app = new LocalApiBackend(disk, false);
  // Zones from a max of 212: easy up to 147 (the highest heart rate in the data would make them all too low).
  await app.request("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ max_hr: 212 }) });
  type View = { streams: { step: number; streams: { distance: number[] } }; moments?: Moment[] };
  const v = await app.json<View>(`/api/activity/${encodeURIComponent(id)}`);
  expect(v.moments!.map((m) => m.id)).toEqual(["hill_hr"]);
  const m = v.moments![0]!;
  // The indexes land on the sheet's streams, where the stretch is.
  expect(v.streams.step).toBeGreaterThan(1);
  expect(v.streams.streams.distance[m.from_i]).toBeWithin(m.from_m - 50, m.from_m + 1);
  expect(v.streams.streams.distance[m.to_i]).toBeWithin(m.to_m - 1, m.to_m + 50);
  expect(await disk.readText("cache/run-moments.json")).toContain("hill_hr");

  const get = dataTools(new Library(disk)).find((t) => t.name === "get_activity")!;
  const d = (await get.run({ id })) as { moments?: Array<Record<string, unknown>> };
  expect(d.moments!.map((x) => x.id)).toEqual(["hill_hr"]);
  expect(Object.keys(d.moments![0]!)).not.toContain("from_i");
  expect(Object.keys(d.moments![0]!)).not.toContain("at");
});
