/**
 * Readiness: how ready you are for today's session, from your training load (form: fitness
 * minus fatigue), a two-tap morning check-in (sleep, legs) and, with a watch worn overnight,
 * this morning's resting heart rate against the usual. When it says go easy and today's
 * session is a hard one, the app offers to swap it for an easy run (Plans.swap); the swap is
 * what then shows in the plan and goes to the watch.
 */
import { readJson, type Disk } from "./disk.ts";
import { dayChoices, dayOffer, stanceFor, swapTaken, todaysSession, type Choice, type DaySession, type DaySwap, type Stance } from "./day-swap.ts";
import { bodyTags, conditionsAt, habitLines, learned, WEATHER_TAGS, type Habits, type Tendency } from "./habits.ts";
import { timeFor, type SchedulePrefs } from "./schedule.ts";
import { localNow, type Hour } from "./weather.ts";

export interface CheckIn {
  date: string;
  /** 1 badly, 2 OK, 3 well; left out when the watch measured the night. */
  sleep?: 1 | 2 | 3;
  /** 1 heavy, 2 normal, 3 fresh; left out until answered (sleep can come first). */
  legs?: 1 | 2 | 3;
  /** Something hurts: where, and 1 a niggle, 2 sore, 3 painful. */
  pain?: { area: PainArea; level: 1 | 2 | 3 };
}

export const PAIN_AREAS = ["foot", "ankle", "achilles", "calf", "shin", "knee", "hamstring", "quad", "hip", "back", "other"] as const;
export type PainArea = (typeof PAIN_AREAS)[number];
export const PAIN_NAME: Record<PainArea, string> = { foot: "foot", ankle: "ankle", achilles: "Achilles", calf: "calf", shin: "shin", knee: "knee", hamstring: "hamstring", quad: "thigh", hip: "hip", back: "back", other: "somewhere" };
export interface Readiness {
  level: "ready" | "go easy" | "rest";
  reasons: string[];
  form: number | null;
}

/** Sessions worth swapping on a bad day. */
export const HARD = new Set(["intervals", "tempo", "hills"]);

/** From the watch: this morning's resting heart rate against the usual (src/health.ts). */
export interface BodySigns {
  resting_hr: number | null;
  resting_baseline: number | null;
  /** Last night's sleep in minutes, measured (Health Connect) or estimated from the watch's log. */
  sleep_min?: number | null;
  /** This morning's HRV (RMSSD, ms) and the usual, from Health Connect. */
  hrv_ms?: number | null;
  hrv_baseline?: number | null;
}

/** Beyond the morning check: the watch's "How did it feel?" on recent runs, and a fresh niggle. */
export interface RecentSigns {
  /** The last runs' feelings (1 poor … 5 excellent), newest first, from the last few days. */
  feelings?: number[];
  /** A niggle from a run note or yesterday's check, when today's check names none. */
  niggle?: { area: PainArea; date: string } | null;
}

export function readiness(form: number | null, check: CheckIn | null, body: BodySigns | null = null, recent: RecentSigns = {}): Readiness {
  let score = 0;
  const reasons: string[] = [];
  const up = body?.resting_hr != null && body.resting_baseline != null ? body.resting_hr - body.resting_baseline : 0;
  if (up >= 7) {
    score -= up >= 10 ? 2 : 1;
    reasons.push(`resting heart rate ${up} bpm above your usual`);
  }
  if (form !== null && form < -30) {
    score -= 2;
    reasons.push("fatigue well above fitness");
  } else if (form !== null && form < -15) {
    score -= 1;
    reasons.push("carrying some fatigue");
  }
  // Sleep: what the watch measured when it did, else what you said.
  const slept = body?.sleep_min ?? null;
  if (slept !== null) {
    const h = `${Math.floor(slept / 60)} h ${String(Math.round(slept % 60)).padStart(2, "0")}`;
    if (slept < 300) {
      score -= 2;
      reasons.push(`a short night (${h})`);
    } else if (slept < 360) {
      score -= 1;
      reasons.push(`a short night (${h})`);
    }
  } else if (check?.sleep === 1) {
    score -= 1;
    reasons.push("slept badly");
  }
  if (check?.legs === 1) {
    score -= 1;
    reasons.push("heavy legs");
  }
  if (check && check.legs === 3 && !check.pain && (slept !== null ? slept >= 450 : check.sleep === 3)) score += 1;
  // HRV well below the usual: the body is still busy recovering.
  const hrv = body?.hrv_ms ?? null;
  const hrvBase = body?.hrv_baseline ?? null;
  if (hrv !== null && hrvBase) {
    const drop = Math.round((1 - hrv / hrvBase) * 100);
    if (drop >= 15) {
      score -= drop >= 25 ? 2 : 1;
      reasons.push(`HRV ${drop}% below your usual`);
    }
  }
  // How the last runs felt, as answered on the watch: flat legs show there before anywhere else.
  const felt = recent.feelings ?? [];
  if (felt[0] === 1) {
    score -= 1;
    reasons.push("your last run felt poor on the watch");
  } else if (felt.length >= 2 && felt[0]! <= 2 && felt[1]! <= 2) {
    score -= 1;
    reasons.push("your last two runs felt flat on the watch");
  }
  // Pain decides on its own: a niggle means easy, sore means go easy, painful means rest.
  const pain = check?.pain;
  if (!pain && recent.niggle) reasons.push(`a niggle in your ${PAIN_NAME[recent.niggle.area] ?? "leg"} from the last couple of days: keep it easy and see how it feels`);
  if (pain) {
    const where = PAIN_NAME[pain.area] ?? "somewhere";
    if (pain.level === 1) reasons.push(`a niggle in your ${where}: keep it easy and see how it feels`);
    else if (pain.level === 2) {
      score = Math.min(score, -2);
      reasons.push(`a sore ${where}: no hard running today`);
    } else {
      score = Math.min(score, -4);
      reasons.push(`a painful ${where}: rest, and see a physio if it lasts`);
    }
  }
  const level = score <= -4 ? "rest" : score <= -2 ? "go easy" : "ready";
  return { level, reasons, form };
}

const FILE = "coach/checkins.json";
/** src/run-notes.ts FILE (read here directly: that module imports this one). */
const RUN_NOTES = "coach/run-notes.json";

export class CheckIns {
  constructor(private readonly disk: Disk) {}
  async get(date: string): Promise<CheckIn | null> {
    return ((await readJson<Record<string, CheckIn>>(this.disk, FILE)) ?? {})[date] ?? null;
  }
  /**
   * Pain reported in the last `days` days, newest first: the morning check's, and niggles noted
   * on runs (src/run-notes.ts, as a niggle, level 1). For the body map, readiness and the coach.
   */
  async niggles(days = 21, now = Date.now()): Promise<Array<{ date: string; area: PainArea; level: 1 | 2 | 3 }>> {
    const all = (await readJson<Record<string, CheckIn>>(this.disk, FILE)) ?? {};
    const since = new Date(now - days * 86400_000).toISOString().slice(0, 10);
    const notes = ((await readJson<Array<{ tag: string; area?: PainArea; date: string }>>(this.disk, RUN_NOTES)) ?? []).filter((n) => n.tag === "niggle" && n.area && PAIN_AREAS.includes(n.area) && n.date >= since);
    return [...Object.values(all).filter((c) => c.pain && c.date >= since).map((c) => ({ date: c.date, ...c.pain! })), ...notes.map((n) => ({ date: n.date, area: n.area!, level: 1 as const }))].sort((a, b) => b.date.localeCompare(a.date));
  }

  /** Every check-in kept (the last 120 days), by date. */
  async all(): Promise<Record<string, CheckIn>> {
    return (await readJson<Record<string, CheckIn>>(this.disk, FILE)) ?? {};
  }

  async save(c: CheckIn): Promise<CheckIn> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date) || (c.sleep !== undefined && ![1, 2, 3].includes(c.sleep)) || (c.legs !== undefined && ![1, 2, 3].includes(c.legs)) || (c.sleep === undefined && c.legs === undefined && !c.pain)) throw new Error("check-in: date, and legs 1-3 or sleep 1-3 or pain");
    const all = (await readJson<Record<string, CheckIn>>(this.disk, FILE)) ?? {};
    if (c.pain && (!PAIN_AREAS.includes(c.pain.area) || ![1, 2, 3].includes(c.pain.level))) throw new Error("check-in: pain needs an area and a level 1-3");
    all[c.date] = { date: c.date, ...(c.sleep ? { sleep: c.sleep } : {}), ...(c.legs ? { legs: c.legs } : {}), ...(c.pain ? { pain: { area: c.pain.area, level: c.pain.level } } : {}) };
    // Keep the last 120 days.
    const keep = Object.keys(all).sort().slice(-120);
    await this.disk.write(FILE, JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]!]))));
    return all[c.date]!;
  }
}

/**
 * Today's readiness with today's session, for the Today tab and the coach. With your settings
 * and what Tartan has learned (`prefs`, `habits`): the ways to change today's session when you
 * ask (`day_choices`), and the one change Today suggests inside the session card when it has a
 * reason, or the one you took (`day_swap`, src/day-swap.ts). The forecast is read only when what
 * puts you off, or a clear habit, is about the weather.
 */
export async function todayReadiness(
  deps: {
    feelings?: () => Promise<number[]>;
    body?: () => Promise<BodySigns | null>;
    plans: { view(): Promise<{ plan: unknown; weeks: Array<{ days: Array<{ date: string; sessions: Array<DaySession & { status: string }> }> }>; today: string }> };
    load(): Promise<{ today: { form: number } }>;
    checkins: CheckIns;
    prefs?: () => Promise<SchedulePrefs>;
    habits?: Habits;
    forecast?: () => Promise<{ hours: Hour[] } | null>;
    /** The past weeks' weather (cached), for what the plan's past runs met. */
    past?: () => Promise<Hour[] | null>;
    /** Days to your race, when there's one ahead. */
    raceDays?: () => Promise<number | null>;
    now?: () => Date;
  },
): Promise<{
  date: string;
  checkin: CheckIn | null;
  /** Last night as the watch measured it (minutes): then the check-in doesn't ask about sleep. */
  sleep_measured: number | null;
  /** Pain reported in the last three weeks, newest first. */
  niggles: Array<{ date: string; area: PainArea; level: 1 | 2 | 3 }>;
  readiness: Readiness;
  session: { title: string; kind: string; hard: boolean; done: boolean; swapped_from?: string; swap_kind?: string } | null;
  suggest_swap: boolean;
  /** What you'd rather do on a bad-weather day, and what puts you off (Settings, Training). */
  bad_weather: SchedulePrefs["bad_weather"];
  avoid: SchedulePrefs["avoid"];
  day_swap: DaySwap | null;
  day_choices: { date: string; kind: string; title: string; choices: Choice[]; reason?: string; stance: Stance } | null;
  /** What's learned (src/habits.ts): each tendency, and the strong ones in words. */
  habits: { tendencies: Tendency[]; lines: string[] } | null;
}> {
  const [v, load, body, prefs] = await Promise.all([deps.plans.view(), deps.load().catch(() => null), deps.body?.().catch(() => null) ?? null, deps.prefs?.().catch(() => null) ?? null]);
  const date = v.today;
  const checkin = await deps.checkins.get(date);
  const [niggles, feelings] = await Promise.all([deps.checkins.niggles(), deps.feelings?.().catch(() => []) ?? []]);
  // A niggle from the last two days that today's check doesn't already cover.
  const twoDays = new Date(Date.parse(`${date}T12:00:00`) - 2 * 86400_000).toISOString().slice(0, 10);
  const fresh = niggles.find((n) => n.date >= twoDays && n.date !== date) ?? niggles.find((n) => n.date === date && !checkin?.pain) ?? null;
  const r = readiness(load ? load.today.form : null, checkin, body, { feelings, niggle: fresh });
  const days = v.weeks.flatMap((w) => w.days);
  const s = days.find((d) => d.date === date)?.sessions.find((x) => x.kind !== "rest");
  // A swap for an easy run (a bad day) says so here; the others show in the session card.
  const easySwap = !!s?.swapped_from && (s.swap_to ?? "easy") === "easy";
  const session = s ? { title: s.title, kind: s.kind, hard: HARD.has(s.kind), done: s.status === "done", ...(easySwap ? { swapped_from: s.swapped_from, swap_kind: s.swap_kind } : {}) } : null;
  const suggest_swap = !!session && session.hard && !session.done && r.level !== "ready" && !s?.swapped_from;
  let day_swap = swapTaken(date, days);
  let day_choices: Awaited<ReturnType<typeof todayReadiness>>["day_choices"] = null;
  let habits: Awaited<ReturnType<typeof todayReadiness>>["habits"] = null;
  const today = todaysSession(days, date);
  if (prefs && deps.habits) {
    const [answers, checks, past] = await Promise.all([deps.habits.answers(), deps.checkins.all(), deps.past?.().catch(() => null) ?? null]);
    const at = (d: string) => timeFor(prefs, d);
    const l = learned({ today: date, answers, days, past, timeFor: at, coldBelow: prefs.cold_below, legs: Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.legs])) });
    const lines = habitLines(l.tendencies, l.usual);
    habits = { tendencies: l.tendencies, lines };
    if (today) {
      // The forecast, only when the weather matters to you.
      const sky = prefs.avoid.length > 0 || l.tendencies.some((t) => t.strong && WEATHER_TAGS.includes(t.tag));
      const hours = (sky ? await deps.forecast?.().catch(() => null) : null)?.hours ?? [];
      const now = localNow(deps.now?.() ?? new Date());
      const planned = `${date}T${at(date)}`;
      const dislike = conditionsAt(hours, planned > now ? planned : `${now.slice(0, 13)}:00`, prefs.cold_below).tags.some((t) => (prefs.avoid as string[]).includes(t));
      const stance = stanceFor({ today: date, session: today, days, answers, raceDays: await deps.raceDays?.().catch(() => null), niggle: !!checkin?.pain || !!fresh, tired: r.level !== "ready", dislike });
      day_choices = { date, kind: today.kind, title: today.title, choices: dayChoices({ session: today, today: date, days, choice: prefs.bad_weather, usual: l.usual, stance }), stance, ...(lines.length ? { reason: lines.at(-1)! } : {}) };
      // One suggestion a day: not with the readiness swap on the card already, nor after a change.
      if (!day_swap && !suggest_swap) {
        day_swap = dayOffer({ today: date, now, days, timeFor: at, hours, choice: prefs.bad_weather, avoid: prefs.avoid, coldBelow: prefs.cold_below, body: bodyTags(checkin, r.level), tendencies: l.tendencies, usual: l.usual, stance });
        if (day_swap) await deps.habits.offered(date, day_swap.kind, day_swap.tags ?? []);
      }
    }
  }
  return { date, checkin, sleep_measured: body?.sleep_min ?? null, niggles, readiness: r, session, suggest_swap, bad_weather: prefs?.bad_weather ?? "run", avoid: prefs?.avoid ?? [], day_swap, day_choices, habits };
}
