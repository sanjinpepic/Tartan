/**
 * GPX and TCX files (what Garmin Connect, Komoot, Coros, Polar and most route apps export): their
 * track points with time, position, height, heart rate, cadence and power, read with plain text
 * matching (no XML library here or in the WebView's engine), as a workout for src/import.ts.
 */
import type { FitSample, FitWorkout } from "./fit-write.ts";

const num = (s: string | undefined) => {
  const v = s === undefined ? NaN : Number(s);
  return Number.isFinite(v) ? v : undefined;
};
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)<\\/(?:\\w+:)?${name}>`).exec(xml);
  return m ? m[1]!.trim() : undefined;
};

export function isGpx(text: string): boolean {
  return /<gpx[\s>]/.test(text.slice(0, 4000));
}
export function isTcx(text: string): boolean {
  return /<TrainingCenterDatabase[\s>]/.test(text.slice(0, 4000));
}

/** GPX's activity type or TCX's Sport to FIT's sport. */
export function sportOf(type = ""): string {
  const t = type.toLowerCase();
  if (/run/.test(t)) return "running";
  if (/bik|cycl|ride/.test(t)) return "cycling";
  if (/hik/.test(t)) return "hiking";
  if (/walk/.test(t)) return "walking";
  if (/swim/.test(t)) return "swimming";
  return "generic";
}

/** A GPX track or a TCX activity as a workout; null when it has no timed points (a planned route). */
export function parseTrack(text: string): { workout: FitWorkout; name?: string } | null {
  const tcx = isTcx(text);
  const points = tcx ? text.match(/<Trackpoint\b[\s\S]*?<\/Trackpoint>/g) : text.match(/<trkpt\b[\s\S]*?(?:<\/trkpt>|\/>)/g);
  if (!points?.length) return null;
  const samples: FitSample[] = [];
  for (const p of points) {
    const t = Date.parse(tag(p, "Time") ?? tag(p, "time") ?? "");
    if (!Number.isFinite(t)) continue;
    const lat = tcx ? num(tag(p, "LatitudeDegrees")) : num(/\blat="([^"]+)"/.exec(p)?.[1]);
    const lon = tcx ? num(tag(p, "LongitudeDegrees")) : num(/\blon="([^"]+)"/.exec(p)?.[1]);
    const hrBlock = tcx ? /<HeartRateBpm\b[\s\S]*?<\/HeartRateBpm>/.exec(p)?.[0] : undefined;
    const s: FitSample = {
      t,
      ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
      ...((tcx ? num(tag(p, "AltitudeMeters")) : num(tag(p, "ele"))) !== undefined ? { altitude: tcx ? num(tag(p, "AltitudeMeters")) : num(tag(p, "ele")) } : {}),
    };
    const hr = tcx ? num(hrBlock && tag(hrBlock, "Value")) : num(tag(p, "hr"));
    const cad = num(tag(p, tcx ? "Cadence" : "cad")) ?? num(tag(p, "RunCadence"));
    const pow = num(tag(p, "Watts")) ?? num(tag(p, "power"));
    const dist = tcx ? num(tag(p, "DistanceMeters")) : undefined;
    const spd = num(tag(p, "Speed")) ?? num(tag(p, "speed"));
    if (hr !== undefined) s.hr = hr;
    if (cad !== undefined) s.cadence = cad;
    if (pow !== undefined) s.power = pow;
    if (dist !== undefined) s.distance = dist;
    if (spd !== undefined) s.speed = spd;
    samples.push(s);
  }
  if (samples.length < 2) return null;
  samples.sort((a, b) => a.t - b.t);
  const sport = tcx ? sportOf(/<Activity\b[^>]*Sport="([^"]+)"/.exec(text)?.[1]) : sportOf(tag(text, "type"));
  const name = tcx ? undefined : tag(text.replace(/<trkpt\b[\s\S]*$/, ""), "name");
  // TCX totals from its laps, where it has them.
  const laps = tcx ? text.match(/<Lap\b[\s\S]*?<\/Lap>/g) ?? [] : [];
  const lapSum = (k: string) => laps.reduce((n, l) => n + (num(tag(l.replace(/<Track\b[\s\S]*<\/Track>/, ""), k)) ?? 0), 0);
  const moving = lapSum("TotalTimeSeconds");
  const metres = lapSum("DistanceMeters");
  const kcal = lapSum("Calories");
  return {
    workout: {
      start: samples[0]!.t,
      end: samples.at(-1)!.t,
      sport,
      ...(moving > 0 ? { moving_s: moving } : {}),
      ...(metres > 0 ? { distance_m: metres } : {}),
      ...(kcal > 0 ? { calories: kcal } : {}),
      samples,
    },
    ...(name ? { name } : {}),
  };
}
