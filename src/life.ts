/**
 * One-tap life changes: "I'm ill", "Better now", "I'm away", "A busy week". Each reshapes the plan
 * by fixed rules, with no AI and no chat, and goes in like any other change: listed, with Undo for
 * a week (Plans.change). Races are never touched; past days never change.
 *
 *   ill      rest today and the next two days (the sessions are kept aside, for Better now).
 *   better   back after being ill for some days: easy running only for a while, shorter at
 *            first, the long run capped (a few days off: 3 easy days; up to a week: 7 days, the
 *            first 3 at half; longer: 2 weeks, the first at half). Sessions an "ill" tap put
 *            aside come back first, so the ramp works on the plan as it was.
 *   away     a stretch of days with no training (rest), or easy runs only (hard sessions become
 *            easy runs, strength goes); after a week or more off, two easy days on return.
 *   busy     the rest of this week shorter: easy runs at 60% (20 min at least), the long run at
 *            75%, hard sessions kept; with more than three runs left, the shortest easy one goes.
 */
import type { PlanInput, PlanSession } from "./plan.ts";

export type LifeEvent =
  | { type: "ill" }
  | { type: "better"; days: number }
  | { type: "away"; from: string; to: string; train: "none" | "easy" }
  | { type: "busy" };

const QUALITY = new Set(["tempo", "intervals", "hills"]);
const RUNS = new Set(["easy", "long", "tempo", "intervals", "hills", "recovery"]);
const DAY = 86400_000;
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const sundayOf = (date: string) => addDays(date, (7 - new Date(`${date}T00:00:00Z`).getUTCDay()) % 7);
const half = (km: number) => Math.round(km * 2) / 2;
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** The plan's easy target: its easy zone's heart rate (else pace), or words. */
function easyTarget(plan: PlanInput): string {
  const z = plan.zones?.find((x) => /easy|aerobic|z2/i.test(x.name));
  return z?.heart_rate ? `easy, ${z.heart_rate}` : z?.pace ? `easy, ${z.pace}` : "easy, conversational";
}

/** A session made shorter by `f` (time and distance alike), 20 min at least. */
function shorter(s: PlanSession, f: number, capMin?: number): PlanSession {
  if (f >= 1 && !capMin) return s;
  const mins = s.duration_min !== undefined ? Math.max(20, Math.round(Math.min(s.duration_min * f, capMin ?? Infinity))) : undefined;
  // A distance follows the time when both are set; alone, it's cut by the same share (or the cap at 6 min/km).
  const share = s.duration_min && mins !== undefined ? mins / s.duration_min : f;
  const km = s.distance_km !== undefined ? Math.max(3, half(Math.min(s.distance_km * share, capMin && !s.duration_min ? capMin / 6 : Infinity))) : undefined;
  return { ...s, ...(mins !== undefined ? { duration_min: mins } : {}), ...(km !== undefined ? { distance_km: km } : {}) };
}

/** A hard session as an easy run of the same length (steps gone), saying what it was and why. */
function asEasy(s: PlanSession, plan: PlanInput, why: string): PlanSession {
  const { steps: _s, exercises: _e, ...rest } = s;
  return { ...rest, kind: "easy", title: "Easy run", target: easyTarget(plan), notes: `Was ${s.title}: ${why.toLowerCase()}.`.slice(0, 300), why };
}

const rest = (s: PlanSession, title: string, why: string): PlanSession => ({ date: s.date, kind: "rest", title, why });

/** Every session from `from` to `to` (inclusive) through `f`; null drops it. */
function mapDays(plan: PlanInput, from: string, to: string, f: (s: PlanSession) => PlanSession | null): PlanInput {
  return {
    ...plan,
    weeks: plan.weeks.map((w) => ({
      ...w,
      sessions: w.sessions.flatMap((s) => {
        if (s.date < from || s.date > to || s.kind === "race") return [s];
        const out = f(s);
        return out ? [out] : [];
      }),
    })),
  };
}

/** Rest days that are already rest stay as they are: one per day, not one per session. */
function restDays(plan: PlanInput, from: string, to: string, title: string, why: string): PlanInput {
  const seen = new Set<string>();
  return mapDays(plan, from, to, (s) => {
    if (s.kind === "rest") return s;
    if (seen.has(s.date) || plan.weeks.some((w) => w.sessions.some((x) => x.date === s.date && x.kind === "race"))) return null;
    seen.add(s.date);
    return rest(s, title, why);
  });
}

/** The ramp back after being ill for `days`: how long, at what share, the long run's cap. */
export function rampFor(days: number): { span: number; phases: Array<{ until: number; f: number; longCap: number; strength: boolean }> } {
  if (days <= 3) return { span: 3, phases: [{ until: 3, f: 0.75, longCap: 60, strength: true }] };
  if (days <= 7) return { span: 7, phases: [{ until: 3, f: 0.5, longCap: 45, strength: false }, { until: 7, f: 0.75, longCap: 60, strength: true }] };
  return { span: 14, phases: [{ until: 7, f: 0.5, longCap: 45, strength: false }, { until: 14, f: 0.75, longCap: 75, strength: true }] };
}

export interface Reshaped {
  plan: PlanInput;
  /** One line for the screen: what changed. */
  said: string;
  /** A note for the coach's memory, so a chat later knows. */
  memory?: string;
  /** A note for the plan's change list. */
  note: string;
}

/**
 * The plan reshaped for a life event, from `today` on. `before` is the plan as it was before an
 * "ill" tap (for Better now to work from), when there is one.
 */
export function reshape(plan: PlanInput, e: LifeEvent, today: string, before?: PlanInput | null): Reshaped {
  switch (e.type) {
    case "ill": {
      const to = addDays(today, 2);
      return {
        plan: restDays(plan, today, to, "Rest: ill", "Rest while you're ill"),
        said: "Rest for today and the next two days. When you feel better, tap Better now and the plan eases you back in.",
        memory: `Ill from ${shortDate(today)}; rested.`,
        note: "Rest while you're ill.",
      };
    }
    case "better": {
      const days = Math.max(1, Math.min(60, Math.round(e.days)));
      const { span, phases } = rampFor(days);
      const end = addDays(today, span - 1);
      // Sessions an ill tap put aside come back first (from today on), so the ramp works on them.
      let base = plan;
      if (before) {
        const orig = new Map(before.weeks.map((w) => [w.start, w.sessions]));
        base = { ...plan, weeks: plan.weeks.map((w) => ({ ...w, sessions: [...w.sessions.filter((s) => s.date < today), ...(orig.get(w.start) ?? w.sessions).filter((s) => s.date >= today)] })) };
      }
      const why = `Back after ${days} day${days > 1 ? "s" : ""} ill`;
      const out = mapDays(base, today, end, (s) => {
        const p = phases.find((x) => daysBetween(today, s.date) < x.until)!;
        if (s.kind === "rest" || s.kind === "cross" || s.kind === "swim" || s.kind === "ride") return s;
        if (s.kind === "strength") return p.strength ? s : rest(s, "Rest", why);
        const easy = QUALITY.has(s.kind) ? asEasy(s, base, why) : s;
        const cut = shorter(easy, p.f, s.kind === "long" ? p.longCap : undefined);
        return cut === s ? s : { ...cut, why };
      });
      return {
        plan: out,
        said: `Easy running until ${shortDate(end)}${phases.length > 1 ? `, half length for the first ${phases[0]!.until} days` : ", a little shorter"}. Hard sessions after that, as planned.`,
        memory: `Ill for ${days} day${days > 1 ? "s" : ""} up to ${shortDate(addDays(today, -1))}; easing back in to ${shortDate(end)}.`,
        note: `${why}: easy running until ${shortDate(end)}.`,
      };
    }
    case "away": {
      if (!(e.from <= e.to)) throw new Error("The days away need a start before their end.");
      const from = e.from < today ? today : e.from;
      if (daysBetween(from, e.to) > 60) throw new Error("Up to two months away at a time.");
      const why = e.train === "none" ? "Away" : "Away: easy runs only";
      let out =
        e.train === "none"
          ? restDays(plan, from, e.to, "Rest: away", why)
          : mapDays(plan, from, e.to, (s) => (s.kind === "strength" ? null : QUALITY.has(s.kind) ? asEasy(s, plan, why) : s.kind === "long" ? { ...shorter(s, 1, 75), why } : s));
      // A week or more without running: two easy days back.
      // Counted from when it began, even if that's already past.
      const off = daysBetween(e.from, e.to) + 1;
      if (e.train === "none" && off >= 7) out = mapDays(out, addDays(e.to, 1), addDays(e.to, 2), (s) => (QUALITY.has(s.kind) ? asEasy(s, out, "Two easy days after time away") : s));
      const span = from === e.to ? shortDate(from) : `${shortDate(from)} to ${shortDate(e.to)}`;
      return {
        plan: out,
        said: e.train === "none" ? `No training ${span}${off >= 7 ? ", then two easy days" : ""}. The rest of the plan stays.` : `Easy runs only ${span}; the long run 75 minutes at most. The rest of the plan stays.`,
        memory: `Away ${span}${e.train === "none" ? ", no training" : ", easy runs only"}.`,
        note: `${why} ${span}.`,
      };
    }
    case "busy": {
      const end = sundayOf(today);
      const why = "A busy week: shorter";
      const left = plan.weeks.flatMap((w) => w.sessions).filter((s) => s.date >= today && s.date <= end && RUNS.has(s.kind));
      const easy = left.filter((s) => s.kind === "easy" || s.kind === "recovery");
      const drop = left.length > 3 && easy.length ? easy.reduce((a, b) => ((b.duration_min ?? (b.distance_km ?? 0) * 6) < (a.duration_min ?? (a.distance_km ?? 0) * 6) ? b : a)) : null;
      let dropped = false;
      const out = mapDays(plan, today, end, (s) => {
        if (s === drop && !dropped) {
          dropped = true;
          return null;
        }
        if (s.kind === "easy" || s.kind === "recovery") return { ...shorter(s, 0.6), why };
        if (s.kind === "long") return { ...shorter(s, 0.75), why };
        return s;
      });
      return {
        plan: out,
        said: `The rest of this week is shorter: easy runs at about 60%, the long run at 75%${drop ? `, one easy run dropped` : ""}. Hard sessions stay.`,
        note: "A busy week: shorter sessions to Sunday.",
      };
    }
  }
}
