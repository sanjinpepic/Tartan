/**
 * Your season, briefly: this year (or this plan) in running, worth a look and worth sharing. The
 * running first (distance, time, runs), the biggest week, the longest run, the bests set, races,
 * the weeks on target as a plain row (never a streak), the swims and rides as a supporting line,
 * and one closing line in the coach's voice (by rules here; the coach may reword it, src/api.ts).
 */
import { sportFamily } from "./merge.ts";
import { clock, localDay, mondayOf, type KeptMilestone, type MilestoneActivity } from "./milestones.ts";
import type { Effort } from "./run-finish.ts";

export interface Season {
  range: "year" | "plan";
  /** "2026", or the plan's title. */
  label: string;
  /** The days it covers, YYYY-MM-DD (to: today, or the plan's last day when it's over). */
  from: string;
  to: string;
  /** Nothing in it yet: the screens say so kindly. */
  empty: boolean;
  run: { km: number; minutes: number; runs: number; climb_m: number };
  biggest_week: { week: string; km: number } | null;
  longest: { id: string; date: string; km: number; name?: string } | null;
  /** The season's best at each standard distance; `pb`: faster than anything before it. */
  bests: Array<{ name: string; label: string; time_s: number; date: string; activity: string; pb: boolean }>;
  races: Array<{ id: string; date: string; name: string; km: number; time_s: number }>;
  /** Every week in it, oldest first: running distance and whether the target was met (null: no target). */
  weeks: Array<{ week: string; km: number; met: boolean | null }>;
  weeks_met: number;
  /** Weeks that had a target. */
  weeks_with_target: number;
  cross: { swims: number; swim_km: number; rides: number; ride_km: number; other: number; line: string | null };
  milestones: number;
  /** One line from the coach. */
  closing: string;
  /** The facts behind it, for the coach's rewording. */
  facts: string[];
}

const BESTS: Array<[string, string]> = [["1k", "1 km"], ["5k", "5 km"], ["10k", "10 km"], ["Half-Marathon", "Half marathon"], ["Marathon", "Marathon"]];
const one = (x: number) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function seasonRecap(o: {
  range: "year" | "plan";
  label: string;
  from: string;
  to: string;
  activities: MilestoneActivity[];
  efforts: Array<{ id: string; start: string; efforts: Effort[] }>;
  weeks: Array<{ week: string; met: boolean | null }>;
  milestones: KeptMilestone[];
}): Season {
  const inRange = (d: string) => d >= o.from && d <= o.to;
  const acts = o.activities.filter((a) => inRange(localDay(a)));
  const runs = acts.filter((a) => sportFamily(a.sport) === "run");
  const km = runs.reduce((n, r) => n + (r.distance_km ?? 0), 0);
  const minutes = runs.reduce((n, r) => n + (r.moving_min ?? 0), 0);
  const climb = runs.reduce((n, r) => n + (r.elevation_m ?? 0), 0);

  // Weeks: every Monday from the first one touching the range (or, for someone who started this
  // season, the week of their first workout), to the week of `to`.
  const firstEver = o.activities.map(localDay).sort()[0];
  const start = firstEver && mondayOf(firstEver) > mondayOf(o.from) ? mondayOf(firstEver) : mondayOf(o.from);
  const byWeek = new Map<string, number>();
  for (const r of runs) byWeek.set(mondayOf(localDay(r)), (byWeek.get(mondayOf(localDay(r))) ?? 0) + (r.distance_km ?? 0));
  const met = new Map(o.weeks.map((w) => [w.week, w.met]));
  const weeks: Season["weeks"] = [];
  for (let w = start; w <= o.to; w = new Date(Date.parse(`${w}T12:00:00Z`) + 7 * 86400_000).toISOString().slice(0, 10)) {
    weeks.push({ week: w, km: Math.round((byWeek.get(w) ?? 0) * 10) / 10, met: met.get(w) ?? null });
  }
  const big = [...byWeek.entries()].sort((a, b) => b[1] - a[1])[0];
  const long = runs.reduce<MilestoneActivity | null>((b, r) => (!b || (r.distance_km ?? 0) > (b.distance_km ?? 0) ? r : b), null);

  // Bests: the season's fastest at each distance, and whether it beat everything before it.
  const before = o.efforts.filter((e) => localDay({ start: e.start }) < o.from);
  const during = o.efforts.filter((e) => inRange(localDay(o.activities.find((a) => a.id === e.id) ?? { start: e.start })));
  const bests: Season["bests"] = [];
  for (const [name, label] of BESTS) {
    let top: { t: number; id: string; start: string } | null = null;
    for (const e of during) {
      const x = e.efforts.find((y) => y.name === name);
      if (x && (!top || x.time_s < top.t)) top = { t: x.time_s, id: e.id, start: e.start };
    }
    if (!top) continue;
    const old = before.flatMap((e) => e.efforts.filter((y) => y.name === name).map((y) => y.time_s));
    const a = o.activities.find((x) => x.id === top!.id);
    bests.push({ name, label, time_s: top.t, date: a ? localDay(a) : top.start.slice(0, 10), activity: top.id, pb: old.length > 0 && top.t < Math.min(...old) });
  }

  const races = o.milestones
    .filter((m) => m.kind === "race" && inRange(m.date) && m.activity)
    .map((m) => {
      const a = o.activities.find((x) => x.id === m.activity);
      return { id: m.activity!, date: m.date, name: m.title.replace(/^Race done: /, ""), km: Math.round((a?.distance_km ?? 0) * 10) / 10, time_s: Math.round(((a?.elapsed_min ?? a?.moving_min) ?? 0) * 60) };
    });

  const swims = acts.filter((a) => sportFamily(a.sport) === "swim");
  const rides = acts.filter((a) => sportFamily(a.sport) === "ride");
  const other = acts.length - runs.length - swims.length - rides.length;
  const swimKm = swims.reduce((n, a) => n + (a.distance_km ?? 0), 0);
  const rideKm = rides.reduce((n, a) => n + (a.distance_km ?? 0), 0);
  const bits = [swims.length ? `${plural(swims.length, "swim")}${swimKm ? ` (${one(swimKm)} km)` : ""}` : "", rides.length ? `${plural(rides.length, "ride")}${rideKm ? ` (${Math.round(rideKm)} km)` : ""}` : ""].filter(Boolean);
  const line = bits.length ? `Alongside the running: ${bits.join(" and ")}.` : null;

  const withTarget = weeks.filter((w) => w.met !== null && w.week < mondayOf(o.to));
  const weeksMet = withTarget.filter((w) => w.met).length;
  const pbs = bests.filter((b) => b.pb);
  const empty = runs.length === 0 && swims.length === 0 && rides.length === 0;
  const where = o.range === "year" ? `${o.label} so far` : "this plan so far";

  const facts = [
    `${o.range === "year" ? `The year ${o.label}` : `The plan "${o.label}"`} from ${o.from} to ${o.to}.`,
    `Running: ${plural(runs.length, "run")}, ${Math.round(km)} km, ${Math.round(minutes / 60)} hours.`,
    ...(big ? [`Biggest week: ${one(big[1])} km.`] : []),
    ...(long?.distance_km ? [`Longest run: ${one(long.distance_km)} km.`] : []),
    ...(pbs.length ? [`New bests: ${pbs.map((b) => `${b.label} ${clock(b.time_s)}`).join(", ")}.`] : []),
    ...(races.length ? [`Races: ${races.map((r) => `${r.name} ${clock(r.time_s)}`).join(", ")}.`] : []),
    ...(withTarget.length ? [`Weekly target met in ${weeksMet} of ${withTarget.length} weeks.`] : []),
    ...(line ? [line] : []),
  ];

  // The closing line, by rules: one line of quiet credit, then what's next.
  const steady = withTarget.length >= 4 && weeksMet / withTarget.length >= 0.75;
  const closing = empty
    ? o.range === "year" ? "Nothing in the season yet. It starts with the first run, however short." : "The plan is just starting. This fills in as the weeks go."
    : races.length
      ? `${plural(races.length, "race")} and ${Math.round(km)} km in ${where}. Well run; rest a little before you build again.`
      : pbs.length
        ? `${Math.round(km)} km and ${pbs.length === 1 ? "a new best" : `${pbs.length} new bests`}. Consistency did that, not luck; keep the easy days easy and it carries on.`
        : steady
          ? `The target met in ${weeksMet} of ${withTarget.length} weeks. That's the work, done plainly; the next block takes care of itself.`
          : runs.length
            ? `${plural(runs.length, "run")} and ${Math.round(km)} km in ${where}. Steady counts for more than heroic; keep it coming.`
            : `No running in ${where}, but ${bits.join(" and ")} kept the engine going. A short easy run is a fine way back.`;

  return {
    range: o.range,
    label: o.label,
    from: o.from,
    to: o.to,
    empty,
    run: { km: Math.round(km * 10) / 10, minutes: Math.round(minutes), runs: runs.length, climb_m: Math.round(climb) },
    biggest_week: big ? { week: big[0], km: Math.round(big[1] * 10) / 10 } : null,
    longest: long?.distance_km ? { id: long.id, date: localDay(long), km: Math.round(long.distance_km * 10) / 10, ...(long.name ? { name: long.name } : {}) } : null,
    bests,
    races,
    weeks,
    weeks_met: weeksMet,
    weeks_with_target: withTarget.length,
    cross: { swims: swims.length, swim_km: Math.round(swimKm * 10) / 10, rides: rides.length, ride_km: Math.round(rideKm), other, line },
    milestones: o.milestones.filter((m) => inRange(m.date)).length,
    closing,
    facts,
  };
}
