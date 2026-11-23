/**
 * Sample data, to try Tartan before connecting anything (the intro's "Try it with sample data"):
 * ten weeks of a runner building towards a half marathon (easy runs, tempo, intervals, a long run
 * on Sundays, a weekly gym session, the odd missed day), each with heart rate, pace and a route
 * around a park (on Saturdays a hillier loop, pushed up the hill, so the sheet has moments to
 * show), plus two weeks of body signals (sleep, HRV, energy, src/signals.ts). It lives in its own storage on the phone
 * (web/disk-capacitor.ts), never with your data; leaving the demo deletes it.
 */
import type { Disk } from "./disk.ts";
import type { FitSample, FitWorkout } from "./fit-write.ts";
import { localStamp, Signals, type SignalPut } from "./signals.ts";
import { importWorkout } from "./import.ts";
import type { LocalStore } from "./store.ts";

export const SAMPLE_FOLDER = { id: "sample-data", name: "Sample data" };
export const SAMPLE_MARK = "sample.json";

/** A small, steady pseudo-random sequence: the same sample data every time. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Kind = "easy" | "tempo" | "intervals" | "long" | "gym";
/** The week: Tuesday intervals, Wednesday easy, Thursday tempo, Saturday easy, Sunday long, Monday gym. */
const WEEK: Array<[day: number, kind: Kind]> = [[0, "gym"], [1, "intervals"], [2, "easy"], [3, "tempo"], [5, "easy"], [6, "long"]];

/**
 * The Saturday loop: 8.2 km once round Central Park and up the hill at Paloheinä (38 m in 600 m
 * from 2.8 km), down gently over 2 km, flat home. Metres along → [lat, lon, altitude].
 */
const HILL_LOOP_M = 8200;
function hillLoop(d: number): [number, number, number] {
  const a = (d / HILL_LOOP_M) * 2 * Math.PI;
  const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const alt = 18 + 38 * ease((d - 2800) / 600) - 38 * ease((d - 4200) / 2200) + 0.5 * Math.sin(d / 180);
  return [60.205 - 0.0115 * Math.cos(a) + 0.0012 * Math.sin(3 * a), 24.915 + 0.0225 * Math.sin(a) + 0.0018 * Math.cos(5 * a), alt];
}

/**
 * One run, pace and heart rate by its kind: round a 1.6 km park loop (Helsinki's Central Park), or
 * on Saturdays the hill loop above, pushed up the hill as easy runners do (the pace kept, the
 * heart rate over easy) and finished quicker. Heart rate follows the slope, about 4 bpm a percent
 * up, a few seconds behind, as it does.
 */
function run(kind: Exclude<Kind, "gym">, start: number, week: number, rnd: () => number, hill = false): FitWorkout {
  const fit = 1 - week * 0.006; // ten weeks a little fitter
  const km = hill ? (rnd(), HILL_LOOP_M / 1000) : { easy: 7 + rnd() * 2, tempo: 9, intervals: 8, long: 14 + week * 0.6 }[kind];
  const pace = { easy: 345, tempo: 290, intervals: 320, long: 355 }[kind] * fit; // s per km
  // Easy and long in easy (zone 2 tops out at 121 for the sample's max of 175).
  const hrBase = { easy: 114, tempo: 162, intervals: 150, long: 116 }[kind];
  const samples: FitSample[] = [];
  let d = 0;
  let t = start;
  const loop = 1600;
  let lagged = 0;
  let before: [d: number, alt: number] | null = null;
  while (d < km * 1000) {
    const sec = (t - start) / 1000;
    // Intervals: 6 × 3 minutes hard after a 15-minute warm-up.
    const hard = kind === "intervals" && sec > 900 && sec < 900 + 6 * 300 && (sec - 900) % 300 < 180;
    const a = ((d % loop) / loop) * 2 * Math.PI;
    const [lat, lon, altitude] = hill ? hillLoop(d) : [60.195 + 0.0045 * Math.sin(a), 24.905 + 0.009 * Math.cos(a), 22 + 3 * Math.sin(a * 2)];
    const grade = before && d > before[0] ? ((altitude - before[1]) / (d - before[0])) * 100 : 0;
    before = [d, altitude];
    // Uphill a little slower, not enough; the last km of the hill loop quicker.
    const home = hill && d > km * 1000 - 1000;
    const slope = 1 + 0.006 * Math.max(-2, grade);
    const speed = (1000 / (hard ? 255 * fit : pace * slope * (home ? 0.92 : 1))) * (0.97 + rnd() * 0.06);
    lagged += ((grade >= 0 ? 4 : 1.5) * grade - lagged) * (5 / 35);
    const drift = kind === "long" ? (sec / 3600) * 5 : 0;
    const hr = Math.round((hard ? 172 : hrBase) + drift + lagged + (home ? 6 : 0) + Math.min(1, sec / 300) * 4 - 4 + rnd() * 3);
    samples.push({ t, lat, lon, altitude, hr, speed, distance: d, cadence: hard ? 88 : 84 });
    t += 5000;
    d += speed * 5;
  }
  return { start, end: t, sport: "running", distance_m: d, samples };
}

/** Write the sample: ten weeks up to yesterday, and two weeks of body signals. How many workouts. */
export async function seedSample(store: LocalStore, disk: Disk, now = Date.now()): Promise<number> {
  const rnd = random(20261109);
  // Which sessions were missed: a sequence of its own, so they stay put whatever the runs hold.
  const missed = random(20261110);
  const day = 86400_000;
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * day - 9 * 7 * day;
  // Today's start, the earlier of the UTC day's and this device's (the workouts are placed in UTC).
  const local = new Date(now);
  local.setHours(0, 0, 0, 0);
  const todayStart = Math.min(today.getTime(), local.getTime());
  let n = 0;
  for (let w = 0; w < 10; w++) {
    for (const [d, kind] of WEEK) {
      const at = monday + (w * 7 + d) * day + (kind === "long" ? 8.5 : 17.5) * 3600_000;
      // Up to yesterday: today's session is always still ahead, whatever the hour the demo starts
      // (the screenshots of today's session, its suggestion and its choices need it undone).
      if (at >= todayStart) continue;
      // A missed session now and then, as weeks go.
      if (kind !== "long" && missed() < 0.08) continue;
      const workout: FitWorkout = kind === "gym" ? { start: at, end: at + 50 * 60_000, sport: "training", samples: [] } : run(kind, at, w, rnd, kind === "easy" && d === 5);
      await importWorkout(store, SAMPLE_FOLDER, `sample-${w}-${d}`, workout);
      n++;
    }
  }
  // Two weeks of body signals for the Body card, readiness and Today (src/signals.ts), as a watch
  // would send them: a rough night three days ago, a low-energy morning two days ago.
  const body = random(20261123);
  const days: SignalPut[] = [];
  for (let i = 14; i >= 1; i--) {
    const end = today.getTime() - (i - 1) * day + 6.6 * 3600_000;
    let hours = 6.6 + rnd() * 1.6;
    let hrv = Math.round((52 + rnd() * 14) * 10) / 10;
    const rough = i === 4;
    const drained = i === 3;
    if (rough) hours = 5.3;
    if (drained) hrv = Math.round(hrv * 0.9 * 10) / 10;
    const awake = rough ? 64 : Math.round(12 + body() * 16);
    const asleep = Math.round(hours * 60 - awake);
    const deep = Math.round(asleep * (rough ? 0.09 : 0.16 + body() * 0.05));
    const rem = Math.round(asleep * (0.2 + body() * 0.04));
    days.push({
      date: localStamp(end).slice(0, 10),
      source: "sample",
      sleep_start: localStamp(end - hours * 3600_000),
      sleep_end: localStamp(end),
      sleep_min: asleep,
      deep_min: deep,
      rem_min: rem,
      light_min: asleep - deep - rem,
      awake_min: awake,
      latency_min: Math.round(6 + body() * 10),
      sleep_score: rough ? 41 : Math.round(72 + body() * 16),
      night_hr_min: Math.round(43 + body() * 3) + (rough ? 3 : 0),
      night_hr_avg: Math.round(49 + body() * 3) + (rough ? 4 : 0),
      hrv_ms: hrv,
      spo2_max: Math.round(96 + body() * 3),
      breathing_rate: Math.round((14.2 + body() * 0.6) * 10) / 10,
      resting_hr: Math.round(47 + body() * 3) + (rough ? 2 : 0),
      energy: drained ? 27 : rough ? 52 : Math.round(66 + body() * 16),
      stress: Math.round((drained ? 45 : 22) + body() * 12),
      recovery_h: Math.round(body() * 18),
      vo2max: 51,
    });
  }
  await new Signals(disk).put(days, { replace: true, now });
  await disk.write(SAMPLE_MARK, JSON.stringify({ seeded: new Date(now).toISOString(), workouts: n }));
  return n;
}

/** Whether this storage is the sample's. */
export const isSample = async (disk: Disk) => (await disk.stat(SAMPLE_MARK)) !== null;
