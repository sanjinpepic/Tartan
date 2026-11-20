/**
 * Sample data, to try Tartan before connecting anything (the intro's "Try it with sample data"):
 * ten weeks of a runner building towards a half marathon (easy runs, tempo, intervals, a long run
 * on Sundays, a weekly gym session, the odd missed day), each with heart rate, pace and a route
 * around a park, plus two weeks of sleep and HRV. It lives in its own storage on the phone
 * (web/disk-capacitor.ts), never with your data; leaving the demo deletes it.
 */
import type { Disk } from "./disk.ts";
import type { FitSample, FitWorkout } from "./fit-write.ts";
import { HealthConnectStore } from "./health-connect.ts";
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

/** One run around a 1.6 km park loop (Helsinki's Central Park), pace and heart rate by its kind. */
function run(kind: Exclude<Kind, "gym">, start: number, week: number, rnd: () => number): FitWorkout {
  const fit = 1 - week * 0.006; // ten weeks a little fitter
  const km = { easy: 7 + rnd() * 2, tempo: 9, intervals: 8, long: 14 + week * 0.6 }[kind];
  const pace = { easy: 345, tempo: 290, intervals: 320, long: 355 }[kind] * fit; // s per km
  const hrBase = { easy: 138, tempo: 162, intervals: 150, long: 142 }[kind];
  const samples: FitSample[] = [];
  let d = 0;
  let t = start;
  const loop = 1600;
  while (d < km * 1000) {
    const sec = (t - start) / 1000;
    // Intervals: 6 × 3 minutes hard after a 15-minute warm-up.
    const hard = kind === "intervals" && sec > 900 && sec < 900 + 6 * 300 && (sec - 900) % 300 < 180;
    const speed = 1000 / (hard ? 255 * fit : pace) * (0.97 + rnd() * 0.06);
    const drift = kind === "long" ? (sec / 3600) * 8 : 0;
    const hr = Math.round((hard ? 172 : hrBase) + drift + Math.min(1, sec / 300) * 4 - 4 + rnd() * 3);
    const a = ((d % loop) / loop) * 2 * Math.PI;
    samples.push({ t, lat: 60.195 + 0.0045 * Math.sin(a), lon: 24.905 + 0.009 * Math.cos(a), altitude: 22 + 8 * Math.sin(a * 2), hr, speed, distance: d, cadence: hard ? 88 : 84 });
    t += 5000;
    d += speed * 5;
  }
  return { start, end: t, sport: "running", distance_m: d, samples };
}

/** Write the sample: ten weeks to `now`, and two weeks of sleep and HRV. How many workouts. */
export async function seedSample(store: LocalStore, disk: Disk, now = Date.now()): Promise<number> {
  const rnd = random(20261109);
  const day = 86400_000;
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * day - 9 * 7 * day;
  let n = 0;
  for (let w = 0; w < 10; w++) {
    for (const [d, kind] of WEEK) {
      const at = monday + (w * 7 + d) * day + (kind === "long" ? 8.5 : 17.5) * 3600_000;
      if (at > now - 3600_000) continue;
      // A missed session now and then, as weeks go.
      if (kind !== "long" && rnd() < 0.08) continue;
      const workout: FitWorkout = kind === "gym" ? { start: at, end: at + 50 * 60_000, sport: "training", samples: [] } : run(kind, at, w, rnd);
      await importWorkout(store, SAMPLE_FOLDER, `sample-${w}-${d}`, workout);
      n++;
    }
  }
  // Sleep and HRV for the Body card and readiness.
  const sleep = [];
  const hrv = [];
  for (let i = 14; i >= 1; i--) {
    const end = today.getTime() - (i - 1) * day + 6.6 * 3600_000;
    const hours = 6.6 + rnd() * 1.6;
    sleep.push({ id: `sample-sleep-${i}`, start: end - hours * 3600_000, end, source: "Sample data", minutes: { asleep: Math.round(hours * 60 - 20), awake: 20, light: Math.round(hours * 30), deep: Math.round(hours * 12), rem: Math.round(hours * 14) } });
    hrv.push({ t: end - 1800_000, ms: Math.round((52 + rnd() * 14) * 10) / 10, source: "Sample data" });
  }
  await new HealthConnectStore(disk).add(sleep, hrv, now);
  await disk.write(SAMPLE_MARK, JSON.stringify({ seeded: new Date(now).toISOString(), workouts: n }));
  return n;
}

/** Whether this storage is the sample's. */
export const isSample = async (disk: Disk) => (await disk.stat(SAMPLE_MARK)) !== null;
