/**
 * Readiness: how ready you are for today's session, from your training load (form: fitness
 * minus fatigue), a two-tap morning check-in (sleep, legs) and, with a watch worn overnight,
 * this morning's resting heart rate against the usual. When it says go easy and today's
 * session is a hard one, the app offers to swap it for an easy run (Plans.swap); the swap is
 * what then shows in the plan and goes to the watch.
 */
import { readJson, type Disk } from "./disk.ts";

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

/** Today's readiness with today's session, for the Today tab and the coach. */
export async function todayReadiness(
  deps: { feelings?: () => Promise<number[]>; body?: () => Promise<BodySigns | null>; plans: { view(): Promise<{ plan: unknown; weeks: Array<{ days: Array<{ date: string; sessions: Array<{ kind: string; title: string; status: string; swapped_from?: string; swap_kind?: string }> }> }>; today: string }> }; load(): Promise<{ today: { form: number } }>; checkins: CheckIns },
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
}> {
  const [v, load, body] = await Promise.all([deps.plans.view(), deps.load().catch(() => null), deps.body?.().catch(() => null) ?? null]);
  const date = v.today;
  const checkin = await deps.checkins.get(date);
  const [niggles, feelings] = await Promise.all([deps.checkins.niggles(), deps.feelings?.().catch(() => []) ?? []]);
  // A niggle from the last two days that today's check doesn't already cover.
  const twoDays = new Date(Date.parse(`${date}T12:00:00`) - 2 * 86400_000).toISOString().slice(0, 10);
  const fresh = niggles.find((n) => n.date >= twoDays && n.date !== date) ?? niggles.find((n) => n.date === date && !checkin?.pain) ?? null;
  const r = readiness(load ? load.today.form : null, checkin, body, { feelings, niggle: fresh });
  const s = v.weeks.flatMap((w) => w.days).find((d) => d.date === date)?.sessions.find((x) => x.kind !== "rest");
  const session = s ? { title: s.title, kind: s.kind, hard: HARD.has(s.kind), done: s.status === "done", ...(s.swapped_from ? { swapped_from: s.swapped_from, swap_kind: s.swap_kind } : {}) } : null;
  return { date, checkin, sleep_measured: body?.sleep_min ?? null, niggles, readiness: r, session, suggest_swap: !!session && session.hard && !session.done && r.level !== "ready" };
}
