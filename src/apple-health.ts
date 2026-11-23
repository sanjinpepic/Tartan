/**
 * Apple Health (iPhone), read only: workouts other apps keep there (the Apple Watch's own, and
 * any watch app that shares with Health: Garmin Connect, Suunto, Coros, Polar…) come in with
 * their heart rate, distance, energy and route, each kept once as a FIT file in a folder per app
 * (src/import.ts importWorkout), as Health Connect's do on Android (src/health-connect.ts). From
 * there they merge with the other copies of the same workout (Strava's, the watch's own file).
 * Tartan writes nothing to Apple Health.
 *
 * The native side is ios/App/App/TartanAppleHealthPlugin.swift; the page drives it
 * (web/lib/apple-health.ts).
 */
import type { FitWorkout } from "./fit-write.ts";
import { fitSport, hcWorkout } from "./health-connect.ts";
import type { ActivityRow } from "./library.ts";
import { sameActivity } from "./merge.ts";
import { slug } from "./slug.ts";

/**
 * A workout as the iPhone reads it from Apple Health. `sport` is Health Connect's name for it
 * (the plugin maps HealthKit's activity types to those), so both read the same way. Heart rate,
 * distance and route come when Apple Health has them; a workout with nothing but its summary
 * (an app that only saves totals) still comes in.
 */
export interface HkSession {
  /** HealthKit's id for the workout. */
  id: string;
  start: number;
  end: number;
  /** The app that saved it: its bundle id and its name. */
  source: string;
  app?: string;
  /** The device it was recorded on ("Watch7,1", "iPhone17,1"), when Apple Health says. */
  product?: string;
  sport: string;
  title?: string;
  /** [time ms, bpm] */
  hr?: Array<[number, number]>;
  /** [start ms, end ms, metres] */
  distance?: Array<[number, number, number]>;
  /** [time ms, lat, lon, altitude m | null] */
  route?: Array<[number, number, number, number | null]>;
  /** The totals Apple Health keeps with the workout. */
  distance_m?: number;
  calories?: number;
  avg_hr?: number;
  max_hr?: number;
}

/** Apple Health's sport (Health Connect's names) to FIT's. */
export function hkSport(sport: string): string {
  if (sport === "cross_country_skiing") return "cross_country_skiing";
  if (sport === "rowing_machine") return "rowing";
  return fitSport(sport);
}

/**
 * The workout as samples (see hcWorkout): heart rate and route as recorded, distance from its
 * records, or spread over the time from the total when that's all there is. Apple Health's own
 * averages win over what the samples add up to.
 */
export function hkWorkout(s: HkSession): FitWorkout {
  const records = s.distance?.filter((d) => d[2] > 0) ?? [];
  const distance = records.length ? records : s.distance_m && s.distance_m > 0 ? [[s.start, s.end, s.distance_m] as [number, number, number]] : undefined;
  const w = hcWorkout({ ...s, distance });
  const n = (x: number | undefined) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.round(x) : undefined);
  const avg = n(s.avg_hr);
  const max = n(s.max_hr);
  return {
    ...w,
    sport: hkSport(s.sport),
    ...(avg ? { avg_hr: avg } : {}),
    ...(max ? { max_hr: max } : {}),
  };
}

/** Who recorded it, in words: Apple's own apps are the Apple Watch (or this iPhone), never its owner's name for it. */
export function hkApp(s: Pick<HkSession, "source" | "app" | "product">): string {
  if (/^com\.apple\./i.test(s.source)) return /^iphone/i.test(s.product ?? "") ? "iPhone" : "Apple Watch";
  return (s.app ?? "").trim() || s.source.split(".").slice(-1)[0] || "Another app";
}

/** The folder an app's workouts go in ("apple-health-Apple-Watch", named "Apple Watch via Apple Health"). */
export function hkFolder(s: Pick<HkSession, "source" | "app" | "product">): { id: string; name: string } {
  const name = hkApp(s);
  return { id: `apple-health-${slug(name)}`.slice(0, 48), name: `${name} via Apple Health` };
}

/**
 * Whether a watch's copy of this workout is here already (its file off the watch, or another app's
 * copy through Apple Health or intervals.icu): then this one adds nothing (and two health apps'
 * copies would show twice, as the library never merges two of one source). A copy from Strava or
 * the phone is no reason to leave it out: it merges with those, and brings its heart rate and
 * route. (A watch file that comes after this copy merges with it: src/merge.ts.)
 */
export function alreadyHere(s: HkSession, rows: Array<Pick<ActivityRow, "start" | "sport" | "elapsed_min" | "moving_min" | "distance_km" | "sources">>): boolean {
  const w = hkWorkout(s);
  // As a copy of another kind, so the two are compared at all.
  const it = { key: s.id, source: "phone" as const, start: s.start, elapsed_s: (s.end - s.start) / 1000, sport: w.sport, ...(w.distance_m ? { distance_m: w.distance_m } : {}) };
  return rows.some(
    (r) =>
      (r.sources.includes("watch") || r.sources.includes("health")) &&
      sameActivity(it, {
        key: "row",
        source: "watch",
        start: Date.parse(r.start),
        sport: r.sport,
        ...(r.elapsed_min ?? r.moving_min ? { elapsed_s: (r.elapsed_min ?? r.moving_min)! * 60 } : {}),
        ...(r.distance_km ? { distance_m: r.distance_km * 1000 } : {}),
      }),
  );
}
