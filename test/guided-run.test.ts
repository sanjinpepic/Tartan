/** Guided runs on the phone: a session talked through step by step (src/workout/guided.ts). */
import { expect, test } from "bun:test";
import { flatten, Guide, isStructured, stepDetail, stepWords, targetWord, type GuideProgress } from "../src/workout/guided.ts";
import { withFuel, DEFAULT_FUEL } from "../src/workout/from-plan.ts";
import type { Workout } from "../src/workout/guide.ts";

const session: Workout = {
  name: "Tue 3 x 800 m",
  blocks: [
    { kind: "warmup", duration_s: 600, hr: [120, 140] },
    { repeat: 3, steps: [{ kind: "run", distance_m: 800, pace: [230, 240] }, { kind: "recover", duration_s: 90 }] },
    { kind: "cooldown", duration_s: 300 },
  ],
};
const at = (active_s: number, distance_m: number, o: Partial<GuideProgress> = {}): GuideProgress => ({ active_s, distance_m, ...o });

test("repeats written out, reps counted", () => {
  const s = flatten(session);
  expect(s.map((x) => x.label)).toEqual(["Warm up", "Rep 1 of 3", "Recover", "Rep 2 of 3", "Recover", "Rep 3 of 3", "Recover", "Cool down"]);
  expect(s[3]!.rep).toEqual([2, 3]);
  expect(isStructured(session)).toBe(true);
  expect(isStructured({ name: "Sat Long", blocks: withFuel({ kind: "run", duration_s: 5400, hr: [130, 145] }, 90, DEFAULT_FUEL) })).toBe(false);
});

test("steps said the way a voice reads them; shown the way a screen does", () => {
  const s = flatten(session);
  expect(stepWords(s[0]!, true)).toBe("Warm up. 10 minutes heart rate 120 to 140.");
  expect(stepWords(s[1]!)).toBe("Rep 1 of 3. 800 metres at 3 50 to 4 00 a kilometre. Go.");
  expect(stepWords(s[2]!)).toBe("Recover. 1 minute 30 easy.");
  expect(stepDetail(s[1]!)).toBe("800 m · 3:50–4:00 /km");
  expect(stepDetail(s[0]!)).toBe("10:00 · 120–140 bpm");
  expect(stepDetail({ kind: "run", distance_m: 5000 })).toBe("5 km");
});

test("a session from warm-up to the end: time and distance move it on, countdowns, checks", () => {
  const g = new Guide(session);
  expect(g.begin(at(0, 0))).toEqual(["Guiding today's 3 x 800 m.", "Warm up. 10 minutes heart rate 120 to 140."]);
  expect(g.update(at(100, 300, { hr: 130 }))).toEqual([]);
  // Too high in the warm-up: said, then not again for 45 s.
  expect(g.update(at(200, 600, { hr: 150 }))).toEqual(["Heart rate 150: ease off."]);
  expect(g.update(at(220, 650, { hr: 150 }))).toEqual([]);
  expect(g.view(at(300, 900)).left_s).toBe(300);
  expect(g.update(at(591, 1800))).toEqual(["10 seconds. Next: rep 1 of 3."]);
  expect(g.update(at(595, 1810))).toEqual([]);
  expect(g.update(at(600, 1820))).toEqual(["Rep 1 of 3. 800 metres at 3 50 to 4 00 a kilometre. Go."]);
  // On pace at the first check: said once; too fast later.
  expect(g.update(at(640, 1990, { pace_s: 236 }))).toEqual(["On pace."]);
  expect(g.update(at(690, 2200, { pace_s: 220 }))).toEqual(["A little fast: ease off."]);
  expect(g.update(at(780, 2530))).toEqual(["100 metres to go. Next: recover."]);
  const v = g.view(at(780, 2530));
  expect(v).toMatchObject({ label: "Rep 1 of 3", left_m: 90, next: "Recover · 1:30 · easy", index: 1, total: 8, done: false });
  expect(g.update(at(790, 2620))).toEqual(["Recover. 1 minute 30 easy."]);
  // Next step, by hand: straight into rep 2.
  expect(g.skip(at(830, 2700))).toEqual(["Rep 2 of 3. 800 metres at 3 50 to 4 00 a kilometre. Go."]);
  expect(g.state).toMatchObject({ at: 3, from_s: 830, from_m: 2700 });
  // The state is plain JSON: a reopened run carries on.
  const again = new Guide(session, JSON.parse(JSON.stringify(g.state)));
  expect(again.view(at(830, 3100)).left_m).toBe(400);
  for (const _ of [4, 5, 6, 7]) again.skip(at(900, 4000));
  expect(again.step?.label).toBe("Cool down");
  expect(again.update(at(1200, 4800))).toEqual(["That's the session done. Well run. Keep recording to the end of your run, then finish."]);
  expect(again.state.done).toBe(true);
  expect(again.update(at(1300, 5000))).toEqual([]);
  expect(again.view(at(1300, 5000))).toMatchObject({ label: "Session done", done: true, share: 1 });
});

test("a long steady run cut for drinks: only the reminders, halfway, no countdown between pieces", () => {
  const w: Workout = { name: "Sun Long run", blocks: withFuel({ kind: "run", duration_s: 5400, title: "Run", hr: [130, 145] }, 90, DEFAULT_FUEL) };
  const g = new Guide(w);
  g.begin(at(0, 0));
  expect(g.update(at(895, 2800))).toEqual([]);
  expect(g.update(at(900, 2810))).toEqual(["Drink: A few sips."]);
  expect(g.update(at(1800, 5600))).toEqual(["Fuel: Gel and a drink."]);
});

test("target words: pace with slack, heart rate over and under", () => {
  const run = { kind: "run" as const, duration_s: 600, pace: [290, 300] as [number, number] };
  expect(targetWord(run, at(0, 0, { pace_s: 296 }))).toBeNull();
  expect(targetWord(run, at(0, 0, { pace_s: 284 }))).toBe("A little fast: ease off.");
  expect(targetWord(run, at(0, 0, { pace_s: 310 }))).toBe("A little slow: pick it up.");
  // Slow in a recovery is fine.
  expect(targetWord({ ...run, kind: "recover" }, at(0, 0, { pace_s: 400 }))).toBeNull();
  const hr = { kind: "run" as const, duration_s: 600, hr: [140, 150] as [number, number] };
  expect(targetWord(hr, at(0, 0, { hr: 152 }))).toBeNull();
  expect(targetWord(hr, at(0, 0, { hr: 154 }))).toBe("Heart rate 154: ease off.");
  expect(targetWord(hr, at(0, 0, { hr: 130 }))).toBe("Heart rate 130: you can push a little.");
});

test("a guided run's steps go to Strava as laps (TCX); a plain run stays one lap", async () => {
  const { toTcx } = await import("../src/recording.ts");
  const t0 = Date.parse("2026-11-10T17:00:00Z");
  // North at 3 m/s, a fix a second for 5 minutes; steps began at 60 s and 180 s.
  const points = Array.from({ length: 301 }, (_, i) => ({ t: t0 + i * 1000, lat: 60.17 + (i * 3) / 111_195, lon: 24.94, acc: 5 }));
  const base = { id: "rec-guided", sport: "Run", name: "Guided", start: new Date(t0).toISOString(), end: new Date(t0 + 300_000).toISOString(), points, pauses: [] };
  const plain = toTcx(base);
  expect(plain.match(/<Lap /g)).toHaveLength(1);
  const tcx = toTcx({ ...base, laps: [t0 + 60_000, t0 + 180_000] });
  expect(tcx.match(/<Lap /g)).toHaveLength(3);
  const times = [...tcx.matchAll(/<TotalTimeSeconds>(\d+)<\/TotalTimeSeconds>/g)].map((m) => Number(m[1]));
  expect(times).toEqual([60, 120, 120]);
  const dist = [...tcx.matchAll(/<Lap [^>]*><TotalTimeSeconds>\d+<\/TotalTimeSeconds><DistanceMeters>(\d+)/g)].map((m) => Number(m[1]));
  expect(dist.reduce((a, b) => a + b, 0)).toBeGreaterThan(890);
  expect(Math.abs(dist[1]! - 360)).toBeLessThan(10);
  expect(tcx.match(/<Trackpoint>/g)).toHaveLength(301);
});
