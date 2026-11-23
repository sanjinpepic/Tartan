/**
 * The training plan: written by the coach (save_training_plan), shown on the Plan tab, and
 * checked against what you actually did. One current plan (coach/plan.json); every earlier
 * version is kept under coach/plans/. Days are local calendar dates (YYYY-MM-DD).
 */
import { z } from "zod";
import { readJson } from "./disk.ts";
import type { ActivityRow, Library } from "./library.ts";
import { sportFamily } from "./merge.ts";
import { paceRange, workoutFor } from "./workout/from-plan.ts";
import { EXERCISE_IDS, EXERCISES } from "./strength/exercises.ts";
import { reviewWorkout, type SessionReview } from "./workout/review.ts";
import { shiftPaceText } from "./run-finish.ts";
import { reshape, type LifeEvent } from "./life.ts";

export const SESSION_KINDS = ["easy", "long", "tempo", "intervals", "hills", "recovery", "race", "strength", "cross", "swim", "ride", "rest"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
/** Kinds that a run fulfils; a swim takes a swim, a ride a ride, and the rest (strength, cross) any other workout. */
export const RUN_KINDS = new Set<string>(["easy", "long", "tempo", "intervals", "hills", "recovery", "race"]);
/** The sport (src/merge.ts sportFamily) that fills a session of this kind; null: any workout but a run. */
const familyFor = (k: string): string | null => (RUN_KINDS.has(k) ? "run" : k === "swim" || k === "ride" ? k : null);
/** Runs that can become a swim or a ride for about the same time: the easy ones. */
export const EASY_RUNS = new Set<string>(["easy", "long", "recovery"]);
/**
 * How a session is swapped: an easy run (a bad day), a swim or ride, the same run on the
 * treadmill, a short easy run (not feeling it), another day, or kept as it is.
 */
export type SwapTo = "easy" | "swim" | "ride" | "treadmill" | "short" | "move" | "keep";

/** A short easy version of a run, for a day you're not feeling it: 20 minutes, or 25 from a longer one. Null: it's short already. */
export function shortMinutes(s: Pick<PlanSession, "duration_min" | "distance_km">): number | null {
  const base = s.duration_min ?? (s.distance_km ? s.distance_km * 6 : 45);
  return base <= 25 ? null : base <= 40 ? 20 : 25;
}

/**
 * A run as a swim or a ride (the weather): about the same time, so about the same aerobic work.
 * A swim stops at an hour (a long run's time is a lot of swimming), a ride at two and a half.
 */
export function crossMinutes(s: Pick<PlanSession, "duration_min" | "distance_km">, to: "swim" | "ride"): number {
  const base = s.duration_min ?? (s.distance_km ? s.distance_km * 6 : 45);
  return Math.max(20, Math.round(Math.min(base, to === "swim" ? 60 : 150) / 5) * 5);
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A swim of `minutes` as the pool counts it, from the athlete's own swims (their median pace per
 * 100 m over the last eight, rests included), else 3:00 per 100 m: "about 1,000–1,250 m (40–50
 * lengths of a 25 m pool)". The coach says lengths, so the plan says them too.
 */
export function swimAmount(minutes: number, swims: Array<Pick<ActivityRow, "sport" | "distance_km" | "moving_min" | "elapsed_min">> = [], pool = 25): { low_m: number; high_m: number; words: string } {
  const paces = swims
    .filter((r) => sportFamily(r.sport) === "swim" && (r.distance_km ?? 0) >= 0.2 && (r.elapsed_min ?? r.moving_min ?? 0) > 0)
    .slice(0, 8)
    .map((r) => ((r.elapsed_min ?? r.moving_min)! * 60) / (r.distance_km! * 10))
    .sort((a, b) => a - b);
  const per100 = paces.length ? paces[Math.floor(paces.length / 2)]! : 180;
  const m = (minutes * 60 * 100) / Math.min(300, Math.max(90, per100));
  const step = pool * 2;
  const low = Math.max(step, Math.round((m * 0.9) / step) * step);
  const high = Math.max(low + step, Math.round((m * 1.1) / step) * step);
  const n = (x: number) => x.toLocaleString("en-GB");
  return { low_m: low, high_m: high, words: `about ${n(low)}–${n(high)} m (${low / pool}–${high / pool} lengths of a ${pool} m pool)` };
}

/** One part of a session as the watch runs it (src/workout/guide.ts). */
const watchStep = z.object({
  kind: z.enum(["warmup", "run", "recover", "cooldown"]),
  duration_s: z.number().int().min(10).max(36000).optional().describe("how long, in seconds (or distance_m)"),
  distance_m: z.number().int().min(50).max(100000).optional().describe("how far, in metres (or duration_s)"),
  hr: z.array(z.number().int().min(60).max(220)).length(2).optional().describe("heart-rate range to hold, [low, high] bpm"),
  pace: z.array(z.number().int().min(90).max(1200)).length(2).optional().describe("or a pace range, [fast, slow] seconds per km, e.g. [270, 300] for 4:30-5:00 /km"),
  speed: z.array(z.number().min(1).max(100)).length(2).optional().describe("or a speed range, [low, high] km/h (cycling)"),
  power: z.array(z.number().int().min(10).max(2000)).length(2).optional().describe("or a power range, [low, high] watts"),
});
const watchBlock = z.object({
  repeat: z.number().int().min(1).max(30).optional().describe("how many times to run these steps (intervals); 1 or left out: once"),
  steps: z.array(watchStep).min(1).max(4),
});
export type WatchBlock = z.infer<typeof watchBlock>;

const session = z.object({
  date: z.string().describe("YYYY-MM-DD"),
  kind: z.enum(SESSION_KINDS),
  title: z.string().max(80).describe("short, without the weekday (the app shows the date), e.g. 'Easy run' or '6 × 800 m'"),
  duration_min: z.number().int().min(0).max(600).optional(),
  distance_km: z.number().min(0).max(250).optional(),
  target: z.string().max(140).optional().describe("pace or heart rate from the athlete's own numbers, in words, e.g. 'easy, 135-148 bpm' or '4:50-5:00 /km'; no zone codes like 'Z2'"),
  notes: z.string().max(300).optional().describe("how to run it, warm-up, why"),
  steps: z
    .array(watchBlock)
    .max(12)
    .optional()
    .describe("the session as the watch guides it, for sessions with structure in any sport (intervals, tempo, hills, progression, circuits): warm-up, the work (a block with repeat for intervals, e.g. repeat 6 of [run 800 m, recover 90 s]; 'run' is the work step in any sport), cool-down; every step ends after duration_s or distance_m, with one target to hold when it has one (heart rate, pace, speed or power). Leave out for a steady session: it goes to the watch as one step from its duration and target"),
  exercises: z
    .array(
      z.object({
        id: z.enum(EXERCISE_IDS).describe("an exercise from the app's library"),
        sets: z.number().int().min(1).max(8),
        reps: z.number().int().min(1).max(50).optional(),
        seconds: z.number().int().min(5).max(300).optional().describe("for holds (plank) and timed sets, instead of reps"),
        each_side: z.boolean().optional(),
      }),
    )
    .max(12)
    .optional()
    .describe("strength sessions: the exercises in order, from the app's library (it shows each with its muscles and a looping how-to, and puts them on the watch). Leave out and the app uses a runner's basic routine sized to the session"),
  why: z.string().max(160).optional().describe("when changing an existing plan: why this session changed, from the athlete's data (e.g. 'Tuesday's reps were 10 s/km slow'); the athlete sees it next to the change"),
});

/** The save_training_plan input. */
export const planInput = {
  title: z.string().max(80).describe("e.g. 'Build to the Autumn 10k'"),
  summary: z.string().max(1200).describe("2-4 sentences: what this block does and why it fits the athlete now"),
  weeks: z
    .array(
      z.object({
        start: z.string().describe("the week's Monday, YYYY-MM-DD"),
        focus: z.string().max(120).describe("the week's purpose, e.g. 'Build', 'Easier week', 'Taper'"),
        target_km: z.number().min(0).max(400).optional(),
        target_hours: z.number().min(0).max(40).optional(),
        sessions: z.array(session).max(14).describe("training sessions on their dates; rest days may be left out"),
      }),
    )
    .min(1)
    .max(26),
  advice: z.array(z.string().max(240)).max(6).optional().describe("a few short pointers for the block"),
  change_note: z.string().max(400).optional().describe("when changing an existing plan: one or two sentences on what changes and why, citing the athlete's data; shown above the list of changes they accept or not"),
  target_date: z
    .string()
    .optional()
    .describe("YYYY-MM-DD: the day the plan builds to (the athlete's target date or race), when there is one; the plan's last week is the week that contains it"),
  zones: z
    .array(
      z.object({
        name: z.string().max(40).describe("e.g. 'Easy', 'Long run', 'Tempo', 'Intervals'"),
        pace: z.string().max(60).optional().describe("e.g. '5:40-6:10 /km'"),
        heart_rate: z.string().max(60).optional().describe("e.g. '130-145 bpm (Z2)'"),
        use: z.string().max(120).optional().describe("where the plan uses it"),
      }),
    )
    .max(8)
    .optional()
    .describe("the paces and heart-rate ranges the sessions' targets come from, worked out from the athlete's data before planning"),
};
const planSchema = z.object(planInput);
export type PlanInput = z.infer<typeof planSchema>;
export type PlanSession = z.infer<typeof session>;

export interface TrainingPlan extends PlanInput {
  created: string;
  updated: string;
  /** The coach conversation that wrote it. */
  conversation?: string;
  model?: string;
}

/**
 * A session swapped on the day (Plans.swap): what it was (title, kind), as what, why; a moved
 * one says the day it came from; kept, as planned when the weather swap was offered.
 */
export interface SwapNote {
  swapped_from?: string;
  swap_kind?: string;
  swap_to?: SwapTo;
  swap_reason?: string;
  moved_from?: string;
  weather_kept?: boolean;
}

export type SessionStatus = "done" | "missed" | "today" | "planned" | "rest";

export interface PlanDay {
  date: string;
  /** `manual`: you marked it done yourself (no workout recorded it, e.g. the watch stayed home). */
  sessions: Array<PlanSession & { status: SessionStatus; manual?: boolean; activity?: Pick<ActivityRow, "id" | "name" | "sport" | "distance_km" | "moving_min"> } & SwapNote>;
  /** Workouts that day that no session asked for. */
  extra: Array<Pick<ActivityRow, "id" | "name" | "sport" | "distance_km" | "moving_min">>;
}

export interface PlanWeekView {
  start: string;
  focus: string;
  target_km?: number;
  target_hours?: number;
  days: PlanDay[];
  planned: { sessions: number; km: number; minutes: number };
  done: { sessions: number; km: number; minutes: number };
  /** Past, current or future week. */
  when: "past" | "current" | "future";
}

/**
 * How a plan is made: the in-app coach's system prompt and the MCP "training_plan" prompt share
 * these rules, so an outside agent plans the same way.
 */
export const PLANNING_RULES = `- You write plans with save_training_plan. They appear on the athlete's Coach tab, where every session is ticked off against their workouts; that is where the sessions live, so never list them in your answer.
- Look first: get_goals (race, date and target time; available days and hours, long-run day, notes and constraints), get_training_plan (the current plan: what was done, missed or marked done by hand), get_training_summary by week for the last 12 weeks (typical volume), get_best_efforts and get_athlete_profile (paces, heart-rate zones), get_training_load (fitness and fatigue), review_session for the last week's structured sessions (each rep against its target: too fast, too slow, on target), and get_activity for the longest recent run when it matters.
- Work out the training paces and heart-rate ranges from that data before planning (best efforts and recent easy runs for paces, their own zones for heart rate) and save them in the plan's zones. Every session's target comes from them.
- Build it progressively: weekly volume at most 10% above the previous full week (time, not distance, for other sports); every third or fourth week easier by about 20-30%; one long run a week; at most two hard sessions (intervals, tempo, hills) a week and never on consecutive days; about 80% of running time easy; a taper of one to two weeks before a race (volume down 30-50%, a little intensity kept), and race week ends with the race.
- When they say when they usually train ("after work, around 18:00", "weekend mornings"), save it with set_training_times; sessions, reminders and calendar events go at those times.
- Respect every constraint they gave: days and hours available, long-run day, and notes such as "no running on Mondays". Without availability, plan around what they actually did in the last four weeks.
- Every session gets a date, a duration or distance, and a target pace or heart-rate range. Give runs a heart-rate range in bpm in the target ("135-148 bpm"): the watch guides the run by it.
- Heart-rate ranges come from get_athlete_profile's zones (zone_limits), the same ones the app shows: easy, recovery and long runs stay in zones 1-2, so their range ends at the top of zone 2 (its readiness advice says "below <that> bpm"). Don't invent other zone numbers, and write targets in words with bpm ("easy, 130-145 bpm"), not zone codes like "Z2".
- Structured sessions in any sport (intervals, tempo, hills, circuits) also get steps, so the athlete can do them guided on the watch: warm-up, the work as a repeat block, cool-down, each step with its duration or distance and, when it has one, one target: heart rate, pace, speed or power. Run-walk (e.g. repeat 8 of [run 4 min, walk 1 min as recover]) and strides (repeat 6 of [run 20 s, recover 60 s]) are steps too. Long steady sessions don't need drink or fuel steps: the app adds those reminders itself.
- Running is the core of every plan. Swim and ride sessions (kinds swim and ride) go in only when the athlete asks for them, or as a bad-weather swap for a run on the day; never by default, and cross-training never fills a plan unasked.
- Strength sessions (kind strength) list their exercises from the app's library, two or three times a week at most, lighter in race week and never the day before a hard session: ${EXERCISES.map((e) => `${e.id} (${e.name}${e.equipment ? `; ${e.equipment.toLowerCase()}` : ""})`).join(", ")}. Use the ones that need equipment only when the athlete has it (a gym, a bar, dumbbells…): check their notes and your memory, or ask; otherwise the bodyweight ones. Prescribe sets with reps, or seconds for holds; each_side for single-leg work. 4-8 exercises for 20-40 minutes.
- Length: as many weeks as the request says. Asked in the chat without a length: to race week when a race is set, else 8 weeks. Never more than 26.
- Missing something critical (no runs in the last month, an injury mentioned without detail)? In the chat, ask up to three short questions before saving. When the request says it comes from the Plan tab, don't ask: assume sensibly, save the plan, and name your assumptions so they can correct you in the chat.
- Changing a plan (extend it, move or swap sessions, react to a missed week) means saving the whole plan again: keep the weeks and past days as they were and change only what the change needs. Sessions marked "manual" were done without the watch; count them as done.
- After saving, answer in three to five sentences: what the plan does, the paces it is built on in one line, what changed since the last plan and why (what was done, missed, fitness and fatigue), and any assumptions.`;

const PLAN = "coach/plan.json";
/**
 * Sessions you marked done by hand, by "date:kind". Kept apart from the plan, so they survive
 * the coach rewriting it.
 */
const MARKS = "coach/plan-marks.json";
type Marks = Record<string, { at: string }>;
const markKey = (date: string, kind: string) => `${date}:${kind}`;
/**
 * Sessions swapped on the day, by "date:kind" of the planned one: a hard session for an easy run
 * on a bad day (readiness); a run for a swim or a ride, the treadmill, or another day (the
 * weather); or `kept` as planned when the weather swap was offered (it isn't offered again).
 * Kept apart from the plan, like the marks, so they survive the coach rewriting it.
 */
const SWAPS = "coach/plan-swaps.json";
type Swap = {
  at: string;
  reason: string;
  /** Moved as well (or only moved, with no other change): why, in a few words. */
  moved_reason?: string;
  kept?: true;
  to?: { kind?: "easy" | "recovery" | "swim" | "ride"; title?: string; duration_min?: number; distance_km?: number; target?: string; treadmill?: true; short?: true; date?: string };
};
type Swaps = Record<string, Swap>;
/**
 * Pace changes you applied from a finished run's next-time rule (src/run-finish.ts), by
 * "date:kind": the session's paces moved by `shift_s` s/km. A new plan from the coach replaces
 * them (it saw them in the plan it rewrote).
 */
const ADJUST = "coach/plan-adjust.json";
/** The coach's proposed plan, waiting for the athlete; and the last change they accepted (to undo). */
const PROPOSAL = "coach/plan-proposal.json";
const LAST_CHANGE = "coach/plan-last-change.json";
export type ProposalSource = "chat" | "update" | "weekly" | "agent" | "life" | "weather";
export interface PlanChange {
  type: "added" | "removed" | "moved" | "changed" | "zones" | "length";
  date?: string;
  to?: string;
  kind?: string;
  title?: string;
  /** What changed, in words: "40 → 50 min", "4:50-5:00 → 4:45-4:55 /km". */
  detail: string;
  /** The coach's reason for this one, when it gave one. */
  why?: string;
  /**
   * A small change: a session moved within its week, its time or distance by at most a quarter,
   * its paces by at most 10 s/km, or renamed. New and dropped sessions, other structure or
   * exercises, zones and the plan's length are not.
   */
  small: boolean;
}
/** How much of the coach's change goes in without you: all of it asks, small ones go in, or all of it does. */
export type Approval = "ask" | "small" | "auto";
export interface Proposal {
  at: string;
  /** The plan it was made against (its `updated`): it can only replace that one. */
  base: string;
  plan: PlanInput;
  changes: PlanChange[];
  source: ProposalSource;
  conversation?: string;
  model?: string;
}
export interface LastChange {
  at: string;
  previous: string;
  changes: PlanChange[];
  source: ProposalSource;
  /** Went in without asking (your setting). */
  auto?: boolean;
}
const APPROVAL = "coach/plan-approval.json";
/** One-tap life changes (src/life.ts): while ill, since when and the plan from before (for Better now). */
const LIFE = "coach/plan-life.json";
type LifeState = { ill?: { from: string; before: string } };
type Adjust = { at: string; shift_s: number; reason: string; from?: string };
type Adjusts = Record<string, Adjust>;
const DAY = 86400_000;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Local calendar date of a workout. */
const localDay = (r: ActivityRow) => (r.start_local ?? r.start).slice(0, 10);
const KIND_NAME: Record<string, string> = { easy: "easy run", long: "long run", tempo: "tempo", intervals: "intervals", hills: "hills", recovery: "recovery run", race: "race", strength: "strength", cross: "cross-training", swim: "swim", ride: "ride", rest: "rest" };
const minText = (m?: number) => (m === undefined ? "" : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ""}` : `${m} min`);

/**
 * What a new plan changes from the current one, from `from` (today) on: sessions added, removed,
 * moved to another day (same kind and title within the week), or changed (time, distance, target,
 * steps, exercises, kind, name); the zones; the plan's length. The app works this out itself, so
 * every change is shown whatever the coach says about it.
 */
export function planChanges(cur: PlanInput, next: PlanInput, from: string): PlanChange[] {
  const out: PlanChange[] = [];
  type S = PlanSession;
  const list = (p: PlanInput) => p.weeks.flatMap((w) => w.sessions).filter((x) => x.date >= from && x.kind !== "rest");
  const a = list(cur);
  const b = list(next);
  const key = (x: S) => `${x.date}:${x.kind}`;
  const left = new Map<string, S[]>();
  for (const x of a) left.set(key(x), [...(left.get(key(x)) ?? []), x]);
  const added: S[] = [];
  const pairs: Array<[S, S]> = [];
  for (const y of b) {
    const m = left.get(key(y));
    if (m?.length) pairs.push([m.shift()!, y]);
    else added.push(y);
  }
  const removed = [...left.values()].flat();
  // Moved: the same kind and title on another day of the same week.
  for (const y of [...added]) {
    const i = removed.findIndex((x) => x.kind === y.kind && x.title === y.title && mondayOf(x.date) === mondayOf(y.date));
    if (i < 0) continue;
    const [x] = removed.splice(i, 1);
    added.splice(added.indexOf(y), 1);
    out.push({ type: "moved", date: x!.date, to: y.date, kind: y.kind, title: y.title, detail: `${weekday(x!.date)} → ${weekday(y.date)}`, ...(y.why ? { why: y.why } : {}), small: true });
    pairs.push([{ ...x!, date: y.date }, y]);
  }
  const near = (a?: number, b?: number) => a !== undefined && b !== undefined && Math.abs(b - a) <= 0.25 * a;
  const paceShift = (a: string, b: string) => {
    const [pa, pb] = [paceRange(a), paceRange(b)];
    return pa && pb && a.replace(/\d{1,2}:\d{2}/g, "") === b.replace(/\d{1,2}:\d{2}/g, "") ? Math.max(Math.abs(pa[0] - pb[0]), Math.abs(pa[1] - pb[1])) : Infinity;
  };
  for (const [x, y] of pairs) {
    const d: string[] = [];
    let big = false;
    if (x.duration_min !== y.duration_min && !near(x.duration_min, y.duration_min)) big = true;
    if (x.distance_km !== y.distance_km && !near(x.distance_km, y.distance_km)) big = true;
    if ((x.target ?? "") !== (y.target ?? "") && paceShift(x.target ?? "", y.target ?? "") > 10) big = true;
    if (JSON.stringify(x.exercises ?? null) !== JSON.stringify(y.exercises ?? null)) big = true;
    if (x.title !== y.title) d.push(`now "${y.title}"`);
    if (x.duration_min !== y.duration_min) d.push(x.duration_min && y.duration_min ? `${minText(x.duration_min)} → ${minText(y.duration_min)}` : y.duration_min ? minText(y.duration_min) : "no set time");
    if (x.distance_km !== y.distance_km) d.push(x.distance_km && y.distance_km ? `${x.distance_km} → ${y.distance_km} km` : y.distance_km ? `${y.distance_km} km` : "no set distance");
    if ((x.target ?? "") !== (y.target ?? "")) d.push(y.target ? `${x.target ? `${x.target} → ` : "target "}${y.target}` : "no target");
    if (JSON.stringify(x.steps ?? null) !== JSON.stringify(y.steps ?? null)) {
      // Only the paces moved: say how; anything else is a new structure.
      const bare = (st?: PlanSession["steps"]) => JSON.stringify((st ?? []).map((b) => ({ ...b, steps: b.steps.map(({ pace: _p, ...r }) => r) })));
      const paces = (st?: PlanSession["steps"]) => (st ?? []).flatMap((b) => b.steps.filter((q) => q.kind === "run" && q.pace).map((q) => q.pace!));
      const [pa, pb] = [paces(x.steps), paces(y.steps)];
      const mmss = (v: number) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
      if (bare(x.steps) === bare(y.steps) && pa.length && pa.length === pb.length && new Set(pb.map(String)).size === 1 && new Set(pa.map(String)).size === 1) {
        d.push(`reps ${mmss(pa[0]![0]!)}-${mmss(pa[0]![1]!)} → ${mmss(pb[0]![0]!)}-${mmss(pb[0]![1]!)} /km`);
        if (Math.max(Math.abs(pa[0]![0]! - pb[0]![0]!), Math.abs(pa[0]![1]! - pb[0]![1]!)) > 10) big = true;
      } else {
        d.push("new structure");
        big = true;
      }
    }
    if (JSON.stringify(x.exercises ?? null) !== JSON.stringify(y.exercises ?? null)) d.push("other exercises");
    if (!d.length) continue;
    if (out.some((c) => c.type === "moved" && c.to === y.date && c.kind === y.kind)) {
      const m = out.find((c) => c.type === "moved" && c.to === y.date && c.kind === y.kind)!;
      m.detail += `, ${d.join(", ")}`;
      m.small = m.small && !big;
      continue;
    }
    out.push({ type: "changed", date: y.date, kind: y.kind, title: y.title, detail: d.join(", "), ...(y.why ? { why: y.why } : {}), small: !big });
  }
  for (const y of added) out.push({ type: "added", date: y.date, kind: y.kind, title: y.title, detail: [KIND_NAME[y.kind], minText(y.duration_min), y.distance_km ? `${y.distance_km} km` : ""].filter(Boolean).join(" · "), ...(y.why ? { why: y.why } : {}), small: false });
  for (const x of removed) out.push({ type: "removed", date: x.date, kind: x.kind, title: x.title, detail: KIND_NAME[x.kind] ?? x.kind, small: false });
  const z = (p: PlanInput) => JSON.stringify((p.zones ?? []).map((x) => [x.name, x.pace ?? "", x.heart_rate ?? ""]));
  if (z(cur) !== z(next)) out.push({ type: "zones", detail: (next.zones ?? []).map((x) => `${x.name} ${[x.pace, x.heart_rate].filter(Boolean).join(", ")}`).join(" · ") || "no zones", small: false });
  const end = (p: PlanInput) => p.weeks.map((w) => w.start).sort().at(-1)!;
  if (end(cur) !== end(next) || (cur.target_date ?? "") !== (next.target_date ?? "")) out.push({ type: "length", detail: `now through the week of ${end(next)}${next.target_date ? `, to ${next.target_date}` : ""}`, small: false });
  return out.sort((p, q) => (p.date ?? "9").localeCompare(q.date ?? "9"));
}

const weekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });

export function today(now = new Date()): string {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export class Plans {
  constructor(private readonly lib: Library) {}

  async current(): Promise<TrainingPlan | null> {
    return readJson<TrainingPlan>(this.lib.disk, PLAN);
  }

  /** A plan from the coach, checked: dates, weeks on Mondays, the target date in the last week. */
  private check(input: PlanInput): PlanInput {
    const p = planSchema.parse(input);
    const bad: string[] = [];
    for (const w of p.weeks) {
      if (!DATE.test(w.start) || mondayOf(w.start) !== w.start) bad.push(`week start ${w.start} is not a Monday (YYYY-MM-DD)`);
      for (const s of w.sessions) {
        if (!DATE.test(s.date) || Number.isNaN(Date.parse(s.date))) bad.push(`session date ${s.date} is not YYYY-MM-DD`);
        else if (s.date < w.start || s.date > addDays(w.start, 6)) bad.push(`session ${s.date} is outside the week of ${w.start}`);
      }
    }
    if (p.target_date !== undefined) {
      const last = [...p.weeks].sort((a, b) => a.start.localeCompare(b.start)).at(-1)!.start;
      if (!DATE.test(p.target_date) || Number.isNaN(Date.parse(p.target_date))) bad.push(`target_date ${p.target_date} is not YYYY-MM-DD`);
      else if (p.target_date < today()) bad.push(`target_date ${p.target_date} is in the past`);
      // Up to the week holding the target date; a target beyond half a year gets the full 26 weeks.
      else if (mondayOf(p.target_date) !== last && !(p.weeks.length === 26 && mondayOf(p.target_date) > last))
        bad.push(`the last week starts ${last}, but the target date ${p.target_date} falls in the week of ${mondayOf(p.target_date)}: plan through that week`);
    }
    if (bad.length) throw new Error(`Plan not saved: ${bad.slice(0, 5).join("; ")}`);
    return p;
  }

  /**
   * A plan from the coach. The first plan is saved; once there is one, a new one is a proposal
   * the athlete accepts or not (`proposal()`): the changes worked out here, from today on.
   */
  async submit(input: PlanInput, meta: { conversation?: string; model?: string; source?: ProposalSource } = {}, now = new Date()): Promise<{ saved: TrainingPlan; applied?: PlanChange[] } | { proposed: Proposal } | { unchanged: true }> {
    const p = this.check(input);
    const cur = await this.current();
    if (!cur) return { saved: await this.save(p, meta) };
    const changes = planChanges(cur, p, today(now));
    if (!changes.length) return { unchanged: true };
    const { source, ...rest } = meta;
    const proposal: Proposal = { at: now.toISOString(), base: cur.updated, plan: p, changes, source: source ?? "chat", ...rest };
    await this.lib.disk.write(PROPOSAL, JSON.stringify(proposal));
    // Your setting: small changes (or all of them) go in at once, with Undo for a week.
    const mode = await this.approval();
    if (mode === "auto" || (mode === "small" && changes.every((c) => c.small))) return { saved: await this.accept(cur.updated, now, true), applied: changes };
    return { proposed: proposal };
  }

  async approval(): Promise<Approval> {
    const m = await readJson<{ mode?: Approval }>(this.lib.disk, APPROVAL);
    return m?.mode === "small" || m?.mode === "auto" ? m.mode : "ask";
  }

  async setApproval(mode: Approval): Promise<Approval> {
    if (!["ask", "small", "auto"].includes(mode)) throw new Error("ask, small or auto");
    await this.lib.disk.write(APPROVAL, JSON.stringify({ mode }));
    return mode;
  }

  /** The coach's proposed change to the plan, if one is waiting (and still fits the plan it was made for). */
  async proposal(): Promise<Proposal | null> {
    const p = await readJson<Proposal>(this.lib.disk, PROPOSAL);
    if (!p) return null;
    const cur = await this.current();
    return cur && cur.updated === p.base ? p : null;
  }

  /**
   * Take the proposal: the new plan, with the days before today kept as they were (the coach
   * can't rewrite what happened). The plan it replaces can come back with `revert()` for a week.
   */
  async accept(base: string, now = new Date(), auto = false): Promise<TrainingPlan> {
    const p = await readJson<Proposal>(this.lib.disk, PROPOSAL);
    const cur = await this.current();
    if (!p || !cur || p.base !== base || cur.updated !== base) throw new Error("The plan changed since this was suggested: ask your coach again.");
    const t = today(now);
    const past = new Map(cur.weeks.map((w) => [w.start, w.sessions.filter((x) => x.date < t)]));
    const weeks = p.plan.weeks.map((w) => ({ ...w, sessions: [...(past.get(w.start) ?? []), ...w.sessions.filter((x) => x.date >= t)] }));
    // Weeks of the old plan before the new one starts stay too.
    const first = weeks.map((w) => w.start).sort()[0]!;
    const before = cur.weeks.filter((w) => w.start < first && w.start <= t);
    const saved = await this.save({ ...p.plan, weeks: [...before, ...weeks] }, { conversation: p.conversation, model: p.model });
    await this.lib.disk.write(PROPOSAL, "null");
    await this.lib.disk.write(LAST_CHANGE, JSON.stringify({ at: now.toISOString(), previous: cur.updated, changes: p.changes, source: p.source, ...(auto ? { auto } : {}) } satisfies LastChange));
    return saved;
  }

  /** Not now: the proposal goes. */
  async decline(): Promise<void> {
    await this.lib.disk.write(PROPOSAL, "null");
  }

  /** The last accepted change, while it can still be taken back (a week). */
  async lastChange(now = Date.now()): Promise<LastChange | null> {
    const l = await readJson<LastChange>(this.lib.disk, LAST_CHANGE);
    const cur = await this.current();
    return l && cur && now - Date.parse(l.at) < 7 * DAY ? l : null;
  }

  /** Undo the last accepted change: the plan before it comes back (the changed one is kept too). */
  async revert(now = Date.now()): Promise<TrainingPlan> {
    const l = await this.lastChange(now);
    if (!l) throw new Error("Nothing to undo.");
    const old = await readJson<TrainingPlan>(this.lib.disk, `coach/plans/${l.previous.replace(/[:.]/g, "-")}.json`);
    if (!old) throw new Error("The earlier plan isn't kept any more.");
    const { created: _c, updated: _u, ...input } = old;
    const saved = await this.save(input, { conversation: old.conversation, model: old.model });
    await this.lib.disk.write(LAST_CHANGE, "null");
    // Undoing "I'm ill" takes the ill state with it.
    const life = await readJson<LifeState>(this.lib.disk, LIFE);
    if (l.source === "life" && life?.ill?.before === l.previous) await this.lib.disk.write(LIFE, "{}");
    return saved;
  }

  /** Whether you said you're ill (and since when): the Coach tab offers Better now first. */
  async life(): Promise<{ ill: { from: string } | null }> {
    const l = await readJson<LifeState>(this.lib.disk, LIFE);
    return { ill: l?.ill ? { from: l.ill.from } : null };
  }

  /**
   * A one-tap life change (src/life.ts): the plan reshaped by rules and taken at once, listed
   * with Undo like any change. What to say, the changes, and a note for the coach's memory.
   */
  async applyLife(e: LifeEvent, now = new Date()): Promise<{ said: string; changes: PlanChange[]; memory?: string }> {
    const cur = await this.current();
    if (!cur) throw new Error("There's no plan to change yet.");
    const t = today(now);
    const life = (await readJson<LifeState>(this.lib.disk, LIFE)) ?? {};
    const strip = (p: TrainingPlan): PlanInput => {
      const { created: _c, updated: _u, conversation: _v, model: _m, ...input } = p;
      return input;
    };
    const before = e.type === "better" && life.ill ? await readJson<TrainingPlan>(this.lib.disk, `coach/plans/${life.ill.before.replace(/[:.]/g, "-")}.json`) : null;
    const r = reshape(strip(cur), e, t, before ? strip(before) : null);
    const next = this.check({ ...r.plan, change_note: r.note });
    const changes = planChanges(cur, next, t);
    if (e.type === "ill") await this.lib.disk.write(LIFE, JSON.stringify({ ill: life.ill ?? { from: t, before: cur.updated } } satisfies LifeState));
    if (e.type === "better") await this.lib.disk.write(LIFE, "{}");
    if (!changes.length) return { said: e.type === "ill" ? r.said : "Nothing in the plan needed changing for that.", changes, memory: r.memory };
    await this.lib.disk.write(PROPOSAL, JSON.stringify({ at: now.toISOString(), base: cur.updated, plan: next, changes, source: "life" } satisfies Proposal));
    await this.accept(cur.updated, now);
    return { said: r.said, changes, memory: r.memory };
  }

  /** Validate and store a plan; the previous one is kept under coach/plans/. */
  async save(input: PlanInput, meta: { conversation?: string; model?: string } = {}): Promise<TrainingPlan> {
    const p = this.check(input);
    const prev = await this.current();
    if (prev) await this.lib.disk.write(`coach/plans/${prev.updated.replace(/[:.]/g, "-")}.json`, JSON.stringify(prev));
    const now = new Date().toISOString();
    const plan: TrainingPlan = {
      ...p,
      weeks: [...p.weeks].sort((a, b) => a.start.localeCompare(b.start)).map((w) => ({ ...w, sessions: [...w.sessions].sort((a, b) => a.date.localeCompare(b.date)) })),
      created: prev?.created ?? now,
      updated: now,
      ...meta,
    };
    await this.lib.disk.write(PLAN, JSON.stringify(plan));
    await this.lib.disk.write(ADJUST, "{}");
    return plan;
  }

  /** Move a session's paces by a finished run's rule (minus: faster), or take it back (`undo`). */
  async adjust(date: string, kind: string, shift_s: number, reason: string, from?: string, undo = false): Promise<void> {
    if (!DATE.test(date)) throw new Error("date must be YYYY-MM-DD");
    const all = (await readJson<Adjusts>(this.lib.disk, ADJUST)) ?? {};
    if (undo) delete all[markKey(date, kind)];
    else {
      if (!Number.isInteger(shift_s) || Math.abs(shift_s) > 30 || !shift_s) throw new Error("a shift of 1 to 30 s/km");
      const plan = await this.current();
      if (!plan?.weeks.some((w) => w.sessions.some((x) => x.date === date && x.kind === kind))) throw new Error("no such session in the plan");
      all[markKey(date, kind)] = { at: new Date().toISOString(), shift_s, reason: reason.slice(0, 160), ...(from ? { from } : {}) };
    }
    await this.lib.disk.write(ADJUST, JSON.stringify(all));
  }

  /** Clear the plan (kept under coach/plans/ like every earlier version). Marks stay: they are your history. */
  async reset(): Promise<boolean> {
    const prev = await this.current();
    if (!prev) return false;
    await this.lib.disk.write(`coach/plans/${prev.updated.replace(/[:.]/g, "-")}.json`, JSON.stringify(prev));
    await this.lib.disk.write(PLAN, "null");
    return true;
  }

  /** The plan as CSV, one row per session (rest days included when planned), with how it went. */
  async csv(now = new Date()): Promise<string> {
    const v = await this.view(now);
    const cell = (x: unknown) => {
      const t = x === undefined || x === null ? "" : String(x);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const head = ["week", "week_start", "week_focus", "date", "weekday", "kind", "title", "duration_min", "distance_km", "target", "notes", "status", "done_with", "done_km", "done_min"];
    const rows = v.weeks.flatMap((w, i) =>
      w.days.flatMap((d) =>
        d.sessions.map((s) => [
          i + 1, w.start, w.focus, d.date, new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }),
          s.kind, s.title, s.duration_min, s.distance_km, s.target, s.notes, s.status,
          s.activity ? s.activity.id : s.manual ? "marked by hand" : "", s.activity?.distance_km, s.activity?.moving_min ? Math.round(s.activity.moving_min) : undefined,
        ]),
      ),
    );
    return [head, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
  }

  /** Mark a session done by hand (a workout the watch didn't record), or take the mark back. */
  async mark(date: string, kind: string, done: boolean, now = new Date()): Promise<void> {
    if (!DATE.test(date) || Number.isNaN(Date.parse(date))) throw new Error("date must be YYYY-MM-DD");
    if (!SESSION_KINDS.includes(kind as SessionKind) || kind === "rest") throw new Error("not a session kind");
    if (done && date > today(now)) throw new Error("Only today's and earlier sessions can be marked done.");
    const marks = (await readJson<Marks>(this.lib.disk, MARKS)) ?? {};
    if (done) marks[markKey(date, kind)] = { at: now.toISOString() };
    else delete marks[markKey(date, kind)];
    await this.lib.disk.write(MARKS, JSON.stringify(marks));
  }

  /**
   * Swap a session on the day (or take the swap back, `undo`). `to` easy (the default): an easy
   * run as long as the session (at most 45 min) at the plan's easy zone. swim or ride: an easy,
   * long or recovery run as an easy swim or ride of about the same time (crossMinutes). treadmill:
   * the same run, on the treadmill. short: a run as a short easy run (shortMinutes), for a day
   * you're not feeling it. move: to `day`, a free day later in the plan. keep: as
   * planned, and the weather swap isn't offered again for it.
   */
  async swap(date: string, kind: string, reason: string, undo = false, to: SwapTo = "easy", day?: string, own: { target?: string; minutes?: number } = {}): Promise<void> {
    if (!DATE.test(date)) throw new Error("date must be YYYY-MM-DD");
    const swaps = (await readJson<Swaps>(this.lib.disk, SWAPS)) ?? {};
    const key = markKey(date, kind);
    if (undo) delete swaps[key];
    else {
      const plan = await this.current();
      const all = plan?.weeks.flatMap((w) => w.sessions) ?? [];
      const s = all.find((x) => x.date === date && x.kind === kind);
      if (!s) throw new Error("no such session in the plan");
      const at = new Date().toISOString();
      const why = reason.slice(0, 120);
      const easy = plan!.zones?.find((z) => /easy|aerobic|z2/i.test(z.name));
      const prev = swaps[key]?.kept ? undefined : swaps[key];
      // The day it goes to: later, in the plan, and free (nothing but rest, counting sessions already moved there).
      const checkDay = (d: string) => {
        if (!DATE.test(d) || d <= date) throw new Error("move needs a later day, YYYY-MM-DD");
        if (kind === "race") throw new Error("A race stays on its day.");
        const end = addDays([...plan!.weeks].sort((a, b) => a.start.localeCompare(b.start)).at(-1)!.start, 6);
        if (d > end) throw new Error("That day is after the plan ends.");
        const there = all.filter((x) => x.kind !== "rest" && markKey(x.date, x.kind) !== key && (swaps[markKey(x.date, x.kind)]?.to?.date ?? x.date) === d);
        if (there.length) throw new Error("That day already has a session.");
        return d;
      };
      // What they already picked stays picked: a swim moved to tomorrow is still a swim, and a
      // session already moved keeps its day when it becomes a swim.
      const date2 = day ? checkDay(day) : to === "move" ? undefined : prev?.to?.date;
      const moved = date2 ? { date: date2 } : {};
      const movedWhy = day ? { moved_reason: why } : prev?.moved_reason ? { moved_reason: prev.moved_reason } : {};
      const mins = (m: number) => (own.minutes ? Math.round(own.minutes) : m);
      if (to === "keep") swaps[key] = { at, reason: why, kept: true };
      else if (to === "swim" || to === "ride") {
        if (!EASY_RUNS.has(kind)) throw new Error("Only an easy, long or recovery run becomes a swim or a ride. A hard session can move to a better day instead.");
        const minutes = mins(crossMinutes(s, to));
        const swims = to === "swim" ? await this.lib.activities({ sport: "swim", limit: 20 }).catch(() => []) : [];
        const words = to === "swim" ? `easy, smooth and steady: ${swimAmount(minutes, swims).words}` : "easy, you could talk all the way";
        swaps[key] = { at, reason: why, ...movedWhy, to: { kind: to, title: to === "swim" ? "Easy swim" : "Easy ride", duration_min: minutes, target: own.target ?? words, ...moved } };
      } else if (to === "short") {
        const minutes = RUN_KINDS.has(kind) && kind !== "race" ? shortMinutes(s) : null;
        if (!minutes) throw new Error("Only a run longer than 25 minutes has a shorter version (not a race).");
        swaps[key] = { at, reason: why, ...movedWhy, to: { kind: kind === "recovery" ? "recovery" : "easy", title: "Short easy run", duration_min: mins(minutes), target: own.target ?? (easy?.heart_rate ? `easy, ${easy.heart_rate}` : "easy, conversational"), short: true, ...moved } };
      } else if (to === "treadmill") {
        if (!RUN_KINDS.has(kind) || kind === "race") throw new Error("Only a run goes on the treadmill (not a race).");
        swaps[key] = { at, reason: why, ...movedWhy, to: { treadmill: true, ...moved } };
      } else if (to === "move") {
        if (!day) throw new Error("move needs a later day, YYYY-MM-DD");
        // Only the day changes; a swap already made (a swim, a ride, a shorter run, the treadmill) goes with it.
        const kept = prev?.to ? { ...prev.to } : {};
        delete kept.date;
        if (own.target && kept.kind) kept.target = own.target;
        if (own.minutes && kept.kind) kept.duration_min = Math.round(own.minutes);
        swaps[key] = prev?.to && Object.keys(kept).length ? { at, reason: prev.reason, moved_reason: why, to: { ...kept, date: day } } : { at, reason: why, to: { date: day } };
      } else {
        const minutes = Math.min(45, s.duration_min ?? 40);
        swaps[key] = { at, reason: why, ...movedWhy, to: { title: "Easy run", duration_min: mins(minutes), target: own.target ?? easy?.heart_rate ?? easy?.pace ?? "easy, conversational", ...moved } };
      }
    }
    await this.lib.disk.write(SWAPS, JSON.stringify(swaps));
  }

  /** The plan with every session checked against your workouts and your own marks. */
  /**
   * How a done session went against its plan: its workout (the steps, or one step from its
   * target) laid over the recorded workout that ticked it off.
   */
  async review(date: string, kind: string, now = new Date()): Promise<(SessionReview & { title: string; activity: string }) | { error: string }> {
    const v = await this.view(now);
    const s = v.weeks.flatMap((w) => w.days).find((d) => d.date === date)?.sessions.find((x) => x.kind === kind);
    if (!s) return { error: "no such session in the plan" };
    if (!s.activity) return { error: "no recorded workout for it yet" };
    const w = workoutFor({ ...s, date }, v.plan?.zones ?? []);
    if (!("workout" in w)) return { error: `nothing to compare: ${w.reason}` };
    const m = await this.lib.find(s.activity.id);
    const raw = await this.lib.rawStreams(m);
    if (!raw) return { error: "the workout has no time series (sync Strava or back up the watch)" };
    return { title: s.title, activity: s.activity.id, ...reviewWorkout(w.workout, raw.columns) };
  }

  async view(now = new Date()) {
    const plan = await this.current();
    if (!plan) return { plan: null, weeks: [] as PlanWeekView[], today: today(now) };
    const marks = (await readJson<Marks>(this.lib.disk, MARKS)) ?? {};
    const swaps = (await readJson<Swaps>(this.lib.disk, SWAPS)) ?? {};
    const adjusts = (await readJson<Adjusts>(this.lib.disk, ADJUST)) ?? {};
    const first = plan.weeks[0]!.start;
    const rows = await this.lib.activities({ since: addDays(first, -1), limit: 2000 });
    const byDay = new Map<string, ActivityRow[]>();
    for (const r of rows) byDay.set(localDay(r), [...(byDay.get(localDay(r)) ?? []), r]);
    const t = today(now);
    const brief = (r: ActivityRow) => ({ id: r.id, name: r.name, sport: r.sport, distance_km: r.distance_km, moving_min: r.moving_min });

    // A session moved to another day (the weather) is on that day.
    const all = plan.weeks.flatMap((w) => w.sessions);
    const dayOf = (s: PlanSession) => swaps[markKey(s.date, s.kind)]?.to?.date ?? s.date;

    const weeks: PlanWeekView[] = plan.weeks.map((w) => {
      const days: PlanDay[] = Array.from({ length: 7 }, (_, i) => {
        const date = addDays(w.start, i);
        const left = [...(byDay.get(date) ?? [])].sort((a, b) => a.start.localeCompare(b.start));
        const take = (k: string) => {
          const fam = familyFor(k);
          const at = left.findIndex((r) => (fam ? sportFamily(r.sport) === fam : sportFamily(r.sport) !== "run"));
          return at >= 0 ? left.splice(at, 1)[0] : undefined;
        };
        const planned = all
          .filter((s) => dayOf(s) === date)
          // An applied pace change: the target's paces and the steps' moved, saying why.
          .map((s): PlanSession & { adjusted?: { shift_s: number; reason: string } } => {
            const a = adjusts[markKey(s.date, s.kind)];
            if (!a) return s;
            return {
              ...s,
              ...(s.target ? { target: shiftPaceText(s.target, a.shift_s) } : {}),
              ...(s.steps ? { steps: s.steps.map((b) => ({ ...b, steps: b.steps.map((x) => (x.pace ? { ...x, pace: [x.pace[0]! + a.shift_s, x.pace[1]! + a.shift_s] } : x)) })) } : {}),
              adjusted: { shift_s: a.shift_s, reason: a.reason },
            };
          })
          // A swapped session says what it replaced and why: an easy run, a swim or a ride; the
          // same run on the treadmill; or the run moved here from its day. Kept: as planned.
          .map((s): PlanSession & SwapNote => {
            const sw = swaps[markKey(s.date, s.kind)];
            if (!sw) return s;
            if (sw.kept) return { ...s, weather_kept: true };
            const was = { swapped_from: s.title, swap_kind: s.kind, swap_reason: sw.reason };
            const notes = (head: string) => [head, s.notes].filter(Boolean).join(" ").slice(0, 300);
            const only = !!sw.to?.date && !sw.to.treadmill && !sw.to.kind && !sw.to.title;
            if (only) return { ...s, date: sw.to!.date!, notes: notes(`Moved from ${weekday(s.date)}: ${sw.reason}.`), ...was, swap_to: "move", moved_from: s.date };
            // Swapped, and maybe moved as well: says both.
            const away = sw.to?.date ? { date: sw.to.date, moved_from: s.date } : {};
            const movedLine = sw.to?.date ? ` Moved from ${weekday(s.date)}${sw.moved_reason && sw.moved_reason !== sw.reason ? `: ${sw.moved_reason}` : ""}.` : "";
            if (sw.to?.treadmill) return { ...s, ...away, notes: notes(`On the treadmill: ${sw.reason}.${movedLine}`), ...was, swap_to: "treadmill" };
            const { steps: _steps, distance_km: _d, exercises: _e, ...rest } = s;
            const kind = sw.to?.kind ?? "easy";
            const stop = sw.to?.short ? " You can stop after 10 minutes, and that still counts." : "";
            return { ...rest, ...away, kind, title: sw.to?.title ?? "Easy run", duration_min: sw.to?.duration_min, target: sw.to?.target, notes: `Swapped from ${s.title}: ${sw.reason}.${movedLine}${stop}`, ...was, swap_to: sw.to?.short ? "short" : kind === "recovery" ? "easy" : kind };
          });
        // Each workout fills one session: runs, swims and rides first, then the sessions any
        // other workout fills (strength, cross), so a swim goes to the planned swim.
        const got = new Map<number, ActivityRow>();
        if (date <= t)
          for (const n of planned.map((_, k) => k).sort((a, b) => Number(!familyFor(planned[a]!.kind)) - Number(!familyFor(planned[b]!.kind)))) {
            if (planned[n]!.kind === "rest") continue;
            const a = take(planned[n]!.kind);
            if (a) got.set(n, a);
          }
        const sessions = planned.map((s, n) => {
          if (s.kind === "rest") return { ...s, status: "rest" as const };
          const a = got.get(n);
          const manual = !a && date <= t && !!marks[markKey(date, s.kind)];
          const status: SessionStatus = a || manual ? "done" : date < t ? "missed" : date === t ? "today" : "planned";
          return { ...s, status, ...(a ? { activity: brief(a) } : {}), ...(manual ? { manual } : {}) };
        });
        return { date, sessions, extra: left.map(brief) };
      });
      const work = w.sessions.filter((s) => s.kind !== "rest");
      // A session marked by hand counts with its planned distance and time.
      const done = days.flatMap((d) => [
        ...d.sessions.filter((s) => s.activity).map((s) => s.activity!),
        ...d.sessions.filter((s) => s.manual).map((s) => ({ distance_km: s.distance_km, moving_min: s.duration_min })),
        ...d.extra,
      ]);
      return {
        start: w.start,
        focus: w.focus,
        target_km: w.target_km,
        target_hours: w.target_hours,
        days,
        planned: { sessions: work.length, km: r1(work.reduce((n, s) => n + (s.distance_km ?? 0), 0)), minutes: work.reduce((n, s) => n + (s.duration_min ?? 0), 0) },
        done: { sessions: days.reduce((n, d) => n + d.sessions.filter((s) => s.status === "done").length, 0), km: r1(done.reduce((n, a) => n + (a.distance_km ?? 0), 0)), minutes: Math.round(done.reduce((n, a) => n + (a.moving_min ?? 0), 0)) },
        when: addDays(w.start, 6) < t ? "past" : w.start > t ? "future" : "current",
      };
    });
    return { plan, weeks, today: t };
  }
}
