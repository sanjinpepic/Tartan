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

/**
 * "watch": a file off the watch (or one imported by hand); "health": another app's copy through
 * Health Connect or Apple Health, kept as a file too (src/import.ts HEALTH_PREFIXES); "intervals":
 * intervals.icu's copy, a file in its folder; "logged": a
 * workout the athlete told the coach about, with no recording (src/logged.ts).
 */
export type Source = "strava" | "watch" | "health" | "intervals" | "suunto-cloud" | "phone" | "logged";

/** One copy of a workout as one source reports it (units: m, s, bpm, m/s). */
export interface Candidate {
  /** "strava:123", "watch:<watch>/<path>", "health:<folder>/<path>", "suunto-cloud:<key>" */
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
  /** How hard it was, 1 very easy … 10 all out, as the athlete said (a logged workout). */
  effort?: number;
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
 * win; Strava wins for what people edit there (title, sport type); a health app's copy is the
 * same recording passed through another app (resampled), so it comes after both; the cloud
 * summary only fills gaps.
 */
const PRIORITY: Record<string, Source[]> = {
  name: ["strava", "suunto-cloud", "phone", "watch", "health", "intervals", "logged"],
  sport: ["strava", "watch", "health", "intervals", "phone", "suunto-cloud", "logged"],
  // A run recorded on the phone and uploaded comes back from Strava with the same data, tidied.
  // A recording always beats what was only said.
  default: ["watch", "strava", "health", "intervals", "phone", "suunto-cloud", "logged"],
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
  // A source never reports one workout twice: two files off one watch at nearly the same time are
  // two workouts. (A health app's copy of a watch's workout is another source, so it merges.)
  if (a.source === b.source) return false;
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
  // Ids given out before, aliases included: never handed to another workout.
  const used = new Set([...Object.values(links), ...Object.keys(links).filter((k) => k.startsWith(ALIAS)).map((k) => k.slice(ALIAS.length))]);
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
    merged.id = canonicalId(members, links, used);
    out.push(merged);
  }
  return out.sort((a, b) => b.start - a.start);
}

/**
 * The group's id: the one its copies already have, else one from its start time. Two different
 * workouts can start the same second (two told to the coach for the same day, both at midday):
 * the second gets a letter after it.
 *
 * Copies that had ids of their own and now merge (a health app's copy, then the watch's file of
 * the same run, apart until the two sources merged) keep the id seen first: the link table keeps
 * the order copies were first seen in. The other id is kept as an alias (ALIAS + id → id), so a
 * reference to it still finds the workout.
 */
function canonicalId(members: Candidate[], links: LinkTable, used: Set<string>): string {
  const ids = new Set(members.map((m) => links[m.key]).filter((x): x is string => !!x));
  const known = ids.size > 1 ? firstSeen(links, ids) : [...ids];
  let id = known[0];
  for (const other of known.slice(1)) links[`${ALIAS}${other}`] = id!;
  if (!id) {
    const base = `a${Math.round(Math.min(...members.map((m) => m.start)) / 1000).toString(36)}`;
    id = base;
    for (let n = 0; used.has(id); n++) id = `${base}${String.fromCharCode(98 + (n % 24))}${n >= 24 ? Math.floor(n / 24) : ""}`;
  }
  used.add(id);
  for (const m of members) links[m.key] = id;
  return id;
}

/** A link table key for an id that merged into another: `id:<old>` → the id kept. */
export const ALIAS = "id:";

/** The ids in the order the link table first names them (its keys keep their insertion order). */
function firstSeen(links: LinkTable, ids: Set<string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(links)) if (!k.startsWith(ALIAS) && ids.has(v) && !out.includes(v)) out.push(v);
  for (const v of [...ids].sort()) if (!out.includes(v)) out.push(v);
  return out;
}

/** The id a workout has now, for an id it had before it merged with another (or itself). */
export function resolveAlias(links: LinkTable, id: string): string {
  let cur = id;
  for (let i = 0; i < 8 && links[`${ALIAS}${cur}`] && links[`${ALIAS}${cur}`] !== cur; i++) cur = links[`${ALIAS}${cur}`]!;
  return cur;
}

/**
 * Link keys from before other apps' copies were sources of their own: they were files like the
 * watch's ("watch:hc-…/…", "watch:apple-health-…/…", "watch:intervals-icu/…"). Renamed in place
 * (same order, same ids), so those workouts keep their ids. Returns whether anything changed.
 */
export function migrateLinks(links: LinkTable, sourceOf: (folder: string) => string): boolean {
  const entries = Object.entries(links);
  const rename = (k: string) => {
    const m = /^watch:([^/]+)\//.exec(k);
    const s = m ? sourceOf(m[1]!) : "watch";
    return s !== "watch" ? `${s}:${k.slice(6)}` : k;
  };
  if (!entries.some(([k]) => rename(k) !== k)) return false;
  for (const [k] of entries) delete links[k];
  for (const [k, v] of entries) {
    const n = rename(k);
    if (!(n in links)) links[n] = v;
  }
  return true;
}
