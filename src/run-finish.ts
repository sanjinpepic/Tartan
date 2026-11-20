/**
 * A run, finished: how it went against its planned session, the records it set, how it compares
 * with the last run like it, and next time by a named rule with its reason.
 *
 * - Records: the fastest 400 m, 1 k, mile, 5 k, 10 k, 15 k, half, 30 k and marathon inside the
 *   run (Strava's when it has the run, else worked out from the time series, so a run only on the
 *   watch counts too), ranked against every earlier run: best, second, third.
 * - Last time: the last run of the same planned kind, else of a similar distance, with pace, heart
 *   rate and metres per heartbeat (the same effort carrying you further is fitness).
 * - Next time, for the next session of the same kind:
 *   - paced work (tempo, intervals, hills, race pace): every rep on target or quicker → 5 s/km
 *     faster; most reps slow → 5 s/km easier; otherwise the same paces until they all are; reps
 *     missed → the same session again.
 *   - heart-rate sessions (easy, long, recovery): three quarters of the time in range → right on;
 *     mostly above → slower, the heart rate is the target.
 *   A pace change is offered, not made: you apply it to that session (and can take it back).
 */
import type { SessionReview } from "./workout/review.ts";

/** Strava's names for the standard efforts, and their distances in metres. */
export const EFFORTS: Array<[string, number]> = [
  ["400m", 400], ["1k", 1000], ["1 mile", 1609.34], ["5k", 5000], ["10k", 10000], ["15k", 15000], ["Half-Marathon", 21097.5], ["30k", 30000], ["Marathon", 42195],
];

export interface Effort {
  name: string;
  time_s: number;
}

/** The fastest stretch of each standard distance in a run, from its time (s) and distance (m) columns. */
export function effortsFrom(time: unknown[] | undefined, dist: unknown[] | undefined): Effort[] {
  if (!time || !dist) return [];
  const t: number[] = [];
  const d: number[] = [];
  for (let k = 0; k < Math.min(time.length, dist.length); k++) {
    const a = time[k];
    const b = dist[k];
    if (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && (!d.length || b >= d.at(-1)!)) {
      t.push(a);
      d.push(b);
    }
  }
  const total = d.length ? d.at(-1)! - d[0]! : 0;
  const out: Effort[] = [];
  for (const [name, D] of EFFORTS) {
    if (total < D) break;
    let best = Infinity;
    let i = 0;
    for (let j = 1; j < d.length; j++) {
      // The latest start that still covers D up to j.
      while (i + 1 < j && d[j]! - d[i + 1]! >= D) i++;
      if (d[j]! - d[i]! < D) continue;
      // Take off the overshoot at the start, at that stretch's speed.
      const over = d[j]! - d[i]! - D;
      const seg = d[i + 1]! - d[i]!;
      const cut = seg > 0 ? (over / seg) * (t[i + 1]! - t[i]!) : 0;
      best = Math.min(best, t[j]! - t[i]! - cut);
    }
    if (Number.isFinite(best) && best > 0) out.push({ name, time_s: Math.round(best) });
  }
  return out;
}

export interface RunRecord {
  name: string;
  time_s: number;
  /** 1 best, 2 second, 3 third of all your runs up to this one. */
  rank: 1 | 2 | 3;
  /** The time it beat (rank 1) or the best (2, 3). */
  vs?: number;
}

/** This run's efforts ranked against earlier runs' (none ranked when there were none before). */
export function recordsOf(mine: Effort[], earlier: Effort[][]): RunRecord[] {
  const out: RunRecord[] = [];
  for (const e of mine) {
    const times = earlier.flatMap((x) => x.filter((y) => y.name === e.name).map((y) => y.time_s)).sort((a, b) => a - b);
    if (!times.length) continue;
    // A tie isn't a record: it ranks behind the time it equals.
    const faster = times.filter((x) => x <= e.time_s).length;
    if (faster > 2) continue;
    out.push({ name: e.name, time_s: e.time_s, rank: (faster + 1) as 1 | 2 | 3, vs: times[0] });
  }
  // Best first, then the longer distance.
  return out.sort((a, b) => a.rank - b.rank || EFFORTS.findIndex(([n]) => n === b.name) - EFFORTS.findIndex(([n]) => n === a.name));
}

export interface RunLike {
  id: string;
  start: string;
  name?: string;
  distance_km?: number;
  moving_min?: number;
  avg_hr?: number;
  elevation_m?: number;
}

const paceText = (sPerKm: number) => `${Math.floor(sPerKm / 60)}:${String(Math.round(sPerKm % 60)).padStart(2, "0")}`;
const secPerKm = (r: RunLike) => (r.distance_km && r.moving_min ? (r.moving_min * 60) / r.distance_km : null);
const perBeat = (r: RunLike) => (r.distance_km && r.moving_min && r.avg_hr ? (r.distance_km * 1000) / (r.avg_hr * r.moving_min) : null);

export interface Comparison {
  id: string;
  date: string;
  name?: string;
  pace: string | null;
  hr: number | null;
  now: { pace: string | null; hr: number | null };
  /** Metres per heartbeat, this run against that one, in percent. */
  change: number | null;
  verdict: "fitter" | "same" | "harder";
  text: string;
}

/** This run against the last one like it: pace, heart rate, and what the two say together. */
export function compareRuns(now: RunLike, prev: RunLike): Comparison {
  const [a, b] = [perBeat(now), perBeat(prev)];
  const change = a && b ? Math.round(((a - b) / b) * 1000) / 10 : null;
  const [pn, pp] = [secPerKm(now), secPerKm(prev)];
  const climbs = Math.abs((now.elevation_m ?? 0) / (now.distance_km || 1) - (prev.elevation_m ?? 0) / (prev.distance_km || 1)) > 8;
  const verdict = change === null ? "same" : change >= 3 ? "fitter" : change <= -3 ? "harder" : "same";
  const dp = pn && pp ? Math.round(pp - pn) : null;
  const dh = now.avg_hr && prev.avg_hr ? Math.round(now.avg_hr - prev.avg_hr) : null;
  const moves = [dp !== null && Math.abs(dp) >= 3 ? `${Math.abs(dp)} s/km ${dp > 0 ? "faster" : "slower"}` : dp !== null ? "the same pace" : "", dh !== null && Math.abs(dh) >= 2 ? `${Math.abs(dh)} bpm ${dh < 0 ? "lower" : "higher"}` : dh !== null ? "the same heart rate" : ""].filter(Boolean).join(" at ");
  const text =
    change === null ? (moves ? `${moves.replace(/^./, (c) => c.toUpperCase())}.` : "No heart rate to compare.")
    : verdict === "fitter" ? `${moves.replace(/^./, (c) => c.toUpperCase())}: ${Math.abs(change)}% more distance per heartbeat. Fitter.`
    : verdict === "harder" ? `${moves.replace(/^./, (c) => c.toUpperCase())}: ${Math.abs(change)}% less distance per heartbeat${climbs ? " (more climbing)" : ". Fatigue, heat or a short night can do this"}.`
    : `${moves.replace(/^./, (c) => c.toUpperCase())}: about the same effort for the distance.`;
  return { id: prev.id, date: prev.start.slice(0, 10), name: prev.name, pace: pp ? paceText(pp) : null, hr: prev.avg_hr ?? null, now: { pace: pn ? paceText(pn) : null, hr: now.avg_hr ?? null }, change, verdict, text };
}

/** The last earlier run like this one: the same planned kind if known, else within a fifth of its distance. */
export function lastLike(now: RunLike, runs: RunLike[], kindOf: (id: string) => string | undefined): RunLike | null {
  const t = Date.parse(now.start);
  const before = runs.filter((r) => r.id !== now.id && Date.parse(r.start) < t && Date.parse(r.start) > t - 120 * 86400_000).sort((a, b) => b.start.localeCompare(a.start));
  const kind = kindOf(now.id);
  if (kind) {
    const same = before.find((r) => kindOf(r.id) === kind);
    if (same) return same;
  }
  const km = now.distance_km ?? 0;
  // A run planned as something else isn't like this one.
  return before.find((r) => r.distance_km && Math.abs(r.distance_km - km) <= 0.2 * km && (!kind || !kindOf(r.id) || kindOf(r.id) === kind)) ?? null;
}

export type RunRule = "faster" | "easier" | "hold" | "on target" | "slow down";
const PACED = new Set(["tempo", "intervals", "hills", "race"]);

/** Next time's rule for a planned session from how it went, with its reason; a pace shift (s/km, minus is faster) when it changes one. */
export function runRule(kind: string, r: SessionReview | null): { rule: RunRule; why: string; shift_s?: number } | null {
  if (!r) return null;
  const work = r.steps.filter((s) => s.kind === "run" && s.target);
  const paced = work.filter((s) => s.target.includes("/km"));
  if (PACED.has(kind) && paced.length) {
    const done = paced.filter((s) => s.verdict !== "not done" && s.verdict !== "no data");
    const n = paced.length;
    if (done.length < 0.75 * n) return { rule: "hold", why: `${done.length} of ${n} ${n > 1 ? "reps" : "parts"} done: the same session again.` };
    const good = done.filter((s) => s.verdict === "on target" || s.verdict === "fast");
    const slow = done.filter((s) => s.verdict === "slow").length;
    const rep = n > 1 ? "reps" : "of it";
    if (good.length === done.length) return { rule: "faster", why: n > 1 ? `All ${n} reps on target${good.some((s) => s.verdict === "fast") ? " or quicker" : ""}: 5 s/km faster next time.` : "On target all the way: 5 s/km faster next time.", shift_s: -5 };
    if (slow > done.length / 2) return { rule: "easier", why: `${slow} of ${n} ${rep} slower than asked: 5 s/km easier, then build back.`, shift_s: 5 };
    return { rule: "hold", why: `${good.length} of ${n} ${rep} on target: the same paces until they all are.` };
  }
  if (r.inRange !== null && work.some((s) => s.target.includes("bpm"))) {
    const pct = Math.round(r.inRange * 100);
    if (r.inRange >= 0.75) return { rule: "on target", why: `${pct}% of it in the heart-rate range: right on.` };
    const high = work.filter((s) => s.verdict === "high").reduce((n, s) => n + s.seconds, 0);
    const low = work.filter((s) => s.verdict === "low").reduce((n, s) => n + s.seconds, 0);
    const avgIn = work.some((s) => s.verdict === "on target");
    if (high >= low)
      return {
        rule: "slow down",
        why: avgIn ? `On average in range, but only ${pct}% of the time: start slower so it stays there.` : `${pct}% in the heart-rate range, mostly above it: slower next time. The heart rate is the target; the pace comes by itself.`,
      };
    return { rule: "on target", why: `${pct}% in range, the rest below it: fine for an easy day.` };
  }
  return null;
}

/** "4:50-5:00 /km" with a shift in s/km (minus: faster). */
export function shiftPaceText(text: string, shift: number): string {
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return text.replace(/(\d{1,2}):(\d{2})(\s*(?:-|–|—|to)\s*)(\d{1,2}):(\d{2})(\s*\/\s*km)/g, (_m, a, b, sep, c, d, unit) => `${mmss(Number(a) * 60 + Number(b) + shift)}${sep}${mmss(Number(c) * 60 + Number(d) + shift)}${unit}`);
}

export interface RunFinish {
  id: string;
  start: string;
  name?: string;
  /** The planned session it ticked off, and how it went. */
  plan?: { date: string; kind: string; title: string; summary?: string; work?: { onTarget: number; total: number }; inRange?: number | null };
  records: RunRecord[];
  last?: Comparison;
  /** The next session of the same kind, with the rule for it. */
  next?: { date: string; kind: string; title: string; rule: RunRule; why: string; shift_s?: number; applied: boolean; target?: string };
}

type PlanViewLike = {
  weeks: Array<{ days: Array<{ date: string; sessions: Array<{ kind: string; title: string; status: string; target?: string; steps?: Array<{ steps: Array<{ pace?: number[] }> }>; activity?: { id: string }; adjusted?: { shift_s: number; reason: string } }> }> }>;
};

/** One run, finished: the plan, records, last time and next time. Null for anything but a run. */
export async function loadRunFinish(
  deps: {
    runs(): Promise<Array<RunLike & { sport: string }>>;
    efforts(): Promise<Array<{ id: string; start: string; efforts: Effort[] }>>;
    view(): Promise<PlanViewLike>;
    review(date: string, kind: string): Promise<(SessionReview & { title: string }) | { error: string }>;
    family(sport: string): string;
  },
  id: string,
): Promise<RunFinish | null> {
  const [runs, view] = await Promise.all([deps.runs(), deps.view()]);
  const run = runs.find((r) => r.id === id);
  if (!run || deps.family(run.sport) !== "run") return null;
  const days = view.weeks.flatMap((w) => w.days);
  const kindOf = new Map(days.flatMap((d) => d.sessions.filter((s) => s.activity).map((s) => [s.activity!.id, s.kind] as const)));
  const at = days.flatMap((d) => d.sessions.map((s) => ({ d, s }))).find((x) => x.s.activity?.id === id);

  const out: RunFinish = { id, start: run.start, name: run.name, records: [] };
  let rule: ReturnType<typeof runRule> = null;
  if (at) {
    const r = await deps.review(at.d.date, at.s.kind).catch(() => ({ error: "no review" }));
    const ok = "steps" in r ? r : null;
    out.plan = { date: at.d.date, kind: at.s.kind, title: at.s.title, ...(ok ? { summary: ok.summary, work: ok.work, inRange: ok.inRange } : {}) };
    rule = runRule(at.s.kind, ok);
    const next = days
      .filter((d) => d.date > at.d.date)
      .flatMap((d) => d.sessions.filter((s) => s.kind === at.s.kind && (s.status === "planned" || s.status === "today")).map((s) => ({ d, s })))[0];
    if (rule && next) {
      const paced = /\d:\d\d\s*(?:-|–|—|to)\s*\d{1,2}:\d\d\s*\/\s*km/.test(next.s.target ?? "") || !!next.s.steps?.some((b) => b.steps.some((x) => x.pace));
      out.next = {
        date: next.d.date,
        kind: next.s.kind,
        title: next.s.title,
        rule: rule.rule,
        why: rule.why,
        ...(rule.shift_s && paced ? { shift_s: rule.shift_s } : {}),
        applied: !!next.s.adjusted,
        ...(next.s.target ? { target: next.s.target } : {}),
      };
    }
  }

  const all = await deps.efforts();
  const mine = all.find((x) => x.id === id);
  if (mine) out.records = recordsOf(mine.efforts, all.filter((x) => x.start < run.start).map((x) => x.efforts));

  const prev = lastLike(run, runs, (x) => kindOf.get(x));
  if (prev) out.last = compareRuns(run, prev);
  return out;
}
