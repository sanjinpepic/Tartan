/**
 * Workouts from any watch: a FIT file exported from Garmin Connect, Coros, Polar, Wahoo, Zwift
 * or a bike computer is kept like a file copied off a watch, under the folder "Imported files".
 * From there it is one more copy: it merges with Strava's copy of the same workout as watch
 * files do, and its time series are read the same way.
 */
import { isFit, parseFit } from "./fit.ts";
import { fillTotals, writeFit, type FitWorkout } from "./fit-write.ts";
import { isGpx, isTcx, parseTrack } from "./gpx.ts";
import { slug } from "./slug.ts";
import type { LocalStore } from "./store.ts";

export const IMPORTED = "Imported files";

export interface Imported {
  /** Where it is kept under the imported folder. */
  path: string;
  start: string;
  sport: string;
  distance_km?: number;
  minutes?: number;
  /** It was imported before (the same file): nothing was written. */
  already?: boolean;
}

/** Keep one FIT file; a file that isn't a workout (settings, a course, a sleep log) is refused in words. */
export async function importFit(store: LocalStore, name: string, data: Uint8Array): Promise<Imported> {
  if (!isFit(data)) throw new Error(`${name} isn't a FIT file. Export the workout as "Original" or ".fit" and try again.`);
  let fit;
  try {
    fit = parseFit(data);
  } catch (e) {
    throw new Error(`${name} couldn't be read: ${(e as Error).message}`);
  }
  const start = fit.startTime ?? fit.records[0]?.time;
  if (!start || (!fit.session && fit.records.length < 2)) throw new Error(`${name} has no workout in it (a course, settings or a health file?).`);
  const num = (k: string) => (typeof fit.session?.[k] === "number" ? (fit.session[k] as number) : undefined);
  const metres = num("total_distance");
  const secs = num("total_timer_time") ?? num("total_elapsed_time");
  const base = slug(name.replace(/\.fit$/i, "")).slice(0, 60);
  const path = `/imported/${start.slice(0, 10)}-${base}.fit`;
  const summary: Imported = {
    path,
    start,
    sport: fit.sport ?? "unknown",
    ...(metres ? { distance_km: Math.round(metres / 10) / 100 } : {}),
    ...(secs ? { minutes: Math.round(secs / 60) } : {}),
  };
  const sink = store.sink(IMPORTED);
  if (await sink.has(path)) return { ...summary, already: true };
  await sink.put(path, data);
  await store.saveInfo(IMPORTED, { name: IMPORTED, kind: "import" });
  return summary;
}

/**
 * Workouts Tartan was given in another shape (Health Connect, intervals.icu, a GPX file) are
 * written as FIT files into a folder of their own, one per source ("Samsung Health via Health
 * Connect", "intervals.icu"), so they merge, read and show like a watch's. These folders came
 * from another app: they aren't sent on to Strava (it has its own way there).
 */
export const IMPORT_PREFIXES = ["hc-", "apple-health-", "intervals-icu", "gpx-files", "sample-data"];
export const isImportFolder = (id: string) => id === slug(IMPORTED) || IMPORT_PREFIXES.some((p) => id.startsWith(p));

/**
 * The folders of health apps' copies (Health Connect's, Apple Health's): a source of their own
 * ("health"), so the watch's own file of the same workout merges with them whichever comes first.
 */
export const HEALTH_PREFIXES = ["hc-", "apple-health-"];
export const isHealthFolder = (id: string) => HEALTH_PREFIXES.some((p) => id.startsWith(p));
/**
 * Which source a folder of files is: the watch's own (or one imported by hand), a health app's copy,
 * or intervals.icu's copy. Each a source of its own, so the watch's file of a workout merges with
 * another app's copy of it whichever comes first (two files off one watch never merge).
 */
export const fileSourceOf = (folder: string): "watch" | "health" | "intervals" => (isHealthFolder(folder) ? "health" : folder.startsWith("intervals-icu") ? "intervals" : "watch");

/** Keep one workout as a FIT file in its source's folder; the same `id` again writes nothing. */
export async function importWorkout(store: LocalStore, folder: { id: string; name: string }, id: string, w: FitWorkout): Promise<Imported> {
  const full = fillTotals(w);
  const start = new Date(full.start).toISOString();
  const path = `/${start.slice(0, 10)}-${slug(full.sport)}-${slug(id).slice(-24)}.fit`;
  const summary: Imported = {
    path,
    start,
    sport: full.sport,
    ...(full.distance_m ? { distance_km: Math.round(full.distance_m / 10) / 100 } : {}),
    minutes: Math.round((full.moving_s ?? (full.end - full.start) / 1000) / 60),
  };
  const sink = store.sink(folder.id);
  if (await sink.has(path)) return { ...summary, already: true };
  await sink.put(path, writeFit(full));
  await store.saveInfo(folder.id, { name: folder.name, kind: "import" });
  return summary;
}

export const FILES_FOLDER = { id: "gpx-files", name: IMPORTED };

/**
 * A workout file shared with Tartan or picked in Settings: FIT kept as it is; GPX and TCX (Garmin
 * Connect, Komoot, Coros, Polar exports) read and kept as FIT. A planned route or anything else is
 * refused in words.
 */
export async function importFile(store: LocalStore, name: string, data: Uint8Array): Promise<Imported> {
  if (isFit(data)) return importFit(store, name, data);
  const text = new TextDecoder().decode(data.subarray(0, 50_000_000));
  if (!isGpx(text) && !isTcx(text)) throw new Error(`${name} isn't a workout file Tartan reads (FIT, GPX or TCX).`);
  const t = parseTrack(text);
  if (!t) throw new Error(`${name} has no timed points: a planned route rather than a workout? Add routes under Routes.`);
  return importWorkout(store, FILES_FOLDER, slug(name.replace(/\.(gpx|tcx)$/i, "")) || "track", t.workout);
}
