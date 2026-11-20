/**
 * Activity mapping: the same workout usually exists several times (the watch's own FIT
 * file, the copy the Suunto app pushed to Strava, the Suunto cloud summary). This module
 * groups those copies into ONE canonical activity:
 *
 *  - copies match when their time intervals overlap (UTC), their sports are compatible
 *    and their distances agree;
 *  - every field of the merged activity comes from exactly one source, chosen by a fixed
 *    priority, and the merged record says which source supplied what;
 *  - the time series comes from one source only (never concatenated or averaged);
 *  - canonical ids are persisted, so an activity keeps its id when a second copy appears.
 */

export type Source = "strava" | "watch" | "suunto-cloud" | "phone";

/** One copy of a workout as one source reports it (units: m, s, bpm, m/s). */
export interface Candidate {
  /** "strava:123", "watch:<watch>/<path>", "suunto-cloud:<key>" */
  key: string;
  source: Source;
  /** UTC start, ms since epoch. */
  start: number;
  elapsed_s?: number;
  moving_s?: number;
  distance_m?: number;
  sport: string;
  name?: string;
  elevation_m?: number;
  avg_hr?: number;
  max_hr?: number;
  avg_speed?: number;
  avg_cadence?: number;
  avg_power?: number;
  calories?: number;
  device?: string;
  /** This copy carries a usable time series. */
  has_streams?: boolean;
  /** "How did it feel?" from the watch, 1 poor … 5 excellent. */
  feeling?: number;
}

export interface MergedActivity {
  id: string;
  start: number;
  sport: string;
  name?: string;
  elapsed_s?: number;
  moving_s?: number;
  distance_m?: number;
  elevation_m?: number;
  avg_hr?: number;
  max_hr?: number;
  avg_speed?: number;
  avg_cadence?: number;
  avg_power?: number;
  calories?: number;
  device?: string;
  /** Copies that were merged, in priority order. */
  members: Candidate[];
  /** Field → source key that supplied it. */
  provenance: Record<string, string>;
  /** Source key whose time series represents this activity, if any. */
  streams_from?: string;
}

/** Persisted mapping from source key to canonical id. */
export type LinkTable = Record<string, string>;

type Field = Exclude<keyof Candidate, "key" | "source" | "has_streams">;

/**
 * Who is trusted for what. The watch file is the device's own record, so its measurements
 * win; Strava wins for what people edit there (title, sport type); the cloud summary only
 * fills gaps.
 */
const PRIORITY: Record<string, Source[]> = {
  name: ["strava", "suunto-cloud", "phone", "watch"],
  sport: ["strava", "watch", "phone", "suunto-cloud"],
  // A run recorded on the phone and uploaded comes back from Strava with the same data, tidied.
  default: ["watch", "strava", "phone", "suunto-cloud"],
};
const FIELDS: Field[] = [
  "start", "sport", "name", "elapsed_s", "moving_s", "distance_m", "elevation_m", "avg_hr", "max_hr",
  "avg_speed", "avg_cadence", "avg_power", "calories", "device",
];

export function sportFamily(sport: string): string {
  const s = sport.toLowerCase();
  if (/run|jog|trail|treadmill/.test(s)) return "run";
  if (/ride|cycl|bik/.test(s)) return "ride";
  if (/swim/.test(s)) return "swim";
  if (/walk|hik|mountaineer|snowshoe/.test(s)) return "walk";
  if (/ski/.test(s)) return "ski";
  if (/row|paddl|kayak|canoe/.test(s)) return "paddle";
  if (/unknown|generic|other|^sport \d+|suunto activity/.test(s)) return "?";
  return s;
}

/** Are these two copies the same workout? */
export function sameActivity(a: Candidate, b: Candidate): boolean {
  if (a.source === b.source) return false; // a source never reports one workout twice
  const fa = sportFamily(a.sport);
  const fb = sportFamily(b.sport);
  if (fa !== "?" && fb !== "?" && fa !== fb) return false;
  if (a.distance_m && b.distance_m && a.distance_m > 200 && b.distance_m > 200) {
    const rel = Math.abs(a.distance_m - b.distance_m) / Math.max(a.distance_m, b.distance_m);
    if (rel > 0.12) return false;
  }
  // Starting within a minute of each other (with the same sport and distance) is the same
  // workout, however short: the overlap rule below can't hold for a run of a few seconds when
  // two clocks disagree by a couple.
  if (Math.abs(a.start - b.start) <= 60_000) return true;
  const da = a.elapsed_s ?? a.moving_s;
  const db = b.elapsed_s ?? b.moving_s;
  if (da && db) {
    const overlap = Math.min(a.start + da * 1000, b.start + db * 1000) - Math.max(a.start, b.start);
    return overlap >= 0.5 * Math.min(da, db) * 1000;
  }
  return Math.abs(a.start - b.start) <= 3 * 60_000;
}

/**
 * Group candidates into canonical activities. `links` is read and updated in place so ids
 * stay stable across runs; returns the activities newest first.
 */
export function mergeActivities(candidates: Candidate[], links: LinkTable = {}): MergedActivity[] {
  // Sweep in start order; only nearby candidates can overlap, so this stays ~linear.
  const sorted = [...candidates].sort((a, b) => a.start - b.start);
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const WINDOW = 12 * 3600_000;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j]!.start - sorted[i]!.start < WINDOW; j++) {
      if (!sameActivity(sorted[i]!, sorted[j]!)) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri === rj) continue;
      // Never merge two copies from the same source into one group.
      const srcI = new Set(groupOf(ri).map((k) => sorted[k]!.source));
      if (groupOf(rj).some((k) => srcI.has(sorted[k]!.source))) continue;
      parent[rj] = ri;
    }
  }
  function groupOf(root: number): number[] {
    return sorted.map((_, k) => k).filter((k) => find(k) === root);
  }

  const groups = new Map<number, Candidate[]>();
  sorted.forEach((c, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  });

  const out: MergedActivity[] = [];
  for (const members of groups.values()) {
    const rank = (s: Source, order: Source[]) => order.indexOf(s);
    members.sort((a, b) => rank(a.source, PRIORITY.default!) - rank(b.source, PRIORITY.default!));
    const merged: MergedActivity = { id: "", start: 0, sport: "unknown", members, provenance: {} };
    for (const f of FIELDS) {
      const order = PRIORITY[f] ?? PRIORITY.default!;
      const pick = [...members]
        .sort((a, b) => rank(a.source, order) - rank(b.source, order))
        .find((m) => m[f] !== undefined && m[f] !== null && m[f] !== "" && !(f === "sport" && sportFamily(String(m[f])) === "?" && members.length > 1));
      const value = pick?.[f] ?? members.find((m) => m[f] !== undefined)?.[f];
      if (value === undefined) continue;
      (merged as unknown as Record<string, unknown>)[f] = value;
      merged.provenance[f] = (pick ?? members.find((m) => m[f] !== undefined))!.key;
    }
    // One time series: the device's own file when it has one, else the Strava streams.
    merged.streams_from = members.find((m) => m.source === "watch" && m.has_streams)?.key ?? members.find((m) => m.has_streams)?.key;
    merged.id = canonicalId(members, links);
    out.push(merged);
  }
  return out.sort((a, b) => b.start - a.start);
}

function canonicalId(members: Candidate[], links: LinkTable): string {
  const known = [...new Set(members.map((m) => links[m.key]).filter((x): x is string => !!x))].sort();
  const id = known[0] ?? `a${Math.round(Math.min(...members.map((m) => m.start)) / 1000).toString(36)}`;
  for (const m of members) links[m.key] = id;
  return id;
}
