/**
 * Tartan's T on Today: the mark sits small in the header and takes on the day, quietly. Never a
 * mascot: a rest day keeps it still and calm, a session planned has it steady, a new best gives
 * it one small spark when Today opens (so does a new milestone, src/milestones.ts), a go-easy morning dims it, and race week sharpens it with
 * a fine outline. The engine says which (here); the native screens draw it (TodayMark.kt,
 * TodayMark.swift). It never notifies or asks anything.
 */
import { recordsOf, type Effort } from "./run-finish.ts";

export type MarkState = "rest" | "session" | "best" | "tired" | "race";

export interface TodayMark {
  state: MarkState;
  /** One line for screen readers ("Rest day", "New best today: 5 km"). */
  label: string;
}

/** How recent a best has to be to spark the mark. */
export const BEST_MS = 24 * 3600_000;
/** Race week: this many days out and less. */
const RACE_DAYS = 7;

const NAME: Record<string, string> = { "400m": "400 m", "1k": "1 km", "1 mile": "mile", "5k": "5 km", "10k": "10 km", "15k": "15 km", "Half-Marathon": "half marathon", "30k": "30 km", Marathon: "marathon" };

/**
 * The best set in the last day, if any: a run that started then whose effort at a standard
 * distance beats every earlier run's (the longest such distance). From the runs' efforts, oldest
 * first (Library.runEfforts).
 */
export function freshBest(runs: Array<{ start: string; efforts: Effort[] }>, now = Date.now()): string | null {
  const sorted = [...runs].sort((a, b) => a.start.localeCompare(b.start));
  let found: string | null = null;
  sorted.forEach((r, i) => {
    const t = Date.parse(r.start);
    if (!Number.isFinite(t) || t > now || now - t > BEST_MS) return;
    const best = recordsOf(r.efforts, sorted.slice(0, i).map((x) => x.efforts)).find((x) => x.rank === 1);
    if (best) found = best.name;
  });
  return found;
}

/**
 * The mark's state, in this order: a new best (or milestone), race day, a go-easy or rest morning, race week, a
 * session planned (or done) today, else a rest day (or nothing planned, without a plan).
 */
export function todayMark(o: {
  /** Today's sessions in the plan, rest days left out. */
  sessions: Array<{ title: string }>;
  /** There is a plan covering today. */
  plan: boolean;
  /** This morning's readiness (src/readiness.ts). */
  level?: "ready" | "go easy" | "rest" | null;
  /** The distance of a best set in the last day (freshBest). */
  best?: string | null;
  /** Days to your race, when one is ahead. */
  raceDays?: number | null;
  /** A new milestone on Today (src/milestones.ts): its title. It sparks the mark as a best does. */
  milestone?: string | null;
}): TodayMark {
  const d = o.raceDays ?? -1;
  if (o.best) return { state: "best", label: `New best today: ${NAME[o.best] ?? o.best}` };
  if (o.milestone) return { state: "best", label: o.milestone };
  if (d === 0) return { state: "race", label: "Race day" };
  if (o.level === "rest") return { state: "tired", label: "Rest or go very easy today" };
  if (o.level === "go easy") return { state: "tired", label: "Go easy today" };
  if (d > 0 && d <= RACE_DAYS) return { state: "race", label: `Race week: ${d} day${d === 1 ? "" : "s"} to go` };
  if (o.sessions.length) return { state: "session", label: `${o.sessions.map((s) => s.title).join(" and ")} today` };
  return { state: "rest", label: o.plan ? "Rest day" : "Nothing planned today" };
}
