/**
 * Changing today's run, the companion way: you ask ("Different plan today?" on Today's session,
 * or the chat), or Today suggests it inside the session card when it has a reason to: something
 * you said puts you off (ice, heavy rain…) is in the forecast at the session's time, or what you
 * usually do on days like this (src/habits.ts) says so. One suggestion a day at most, Run anyway
 * always there, every change undone with one tap (Plans.swap).
 *
 *   nudge      a few words from your own data first (src/nudge.ts).
 *   instead    an easy, long or recovery run as a swim or a ride (your bad-weather choice; both
 *              without one) for about the same time, or the same run on the treadmill. Never a
 *              hard session: tempo, intervals and hills don't become a swim.
 *   short      the run as a short easy one, 20 to 25 minutes ("you can stop after 10").
 *   move       to the next free day in the plan within three (not next to another hard
 *              session; with the forecast, one without what puts you off).
 * A race stays as it is. On your side, but not a pushover (stanceFor): a key session, or a third
 * change in ten days, leads with the run; a genuine reason leads with the other ways.
 */
import { EASY_RUNS, RUN_KINDS, crossMinutes, shortMinutes } from "./plan.ts";
import type { BadWeather } from "./schedule.ts";
import { conditionsAt, learned, ordered, reasonFor, WEATHER_TAGS, type Answer, type Habits, type Pick, type Tag, type Tendency } from "./habits.ts";
import { readJson, type Disk } from "./disk.ts";
import { mondayOf, today as todayOf, type Plans } from "./plan.ts";
import { timeFor, type SchedulePrefs } from "./schedule.ts";
import type { Avoid } from "./schedule.ts";
import type { Hour } from "./weather.ts";

const HARD = new Set(["tempo", "intervals", "hills", "race"]);
const DAY = 86400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** A session as the plan's view has it (Plans.view), enough to decide. */
export interface DaySession {
  date?: string;
  kind: string;
  title: string;
  status?: string;
  duration_min?: number;
  distance_km?: number;
  swapped_from?: string;
  swap_kind?: string;
  swap_to?: string;
  swap_reason?: string;
  moved_from?: string;
  weather_kept?: boolean;
}
export type PlanDays = Array<{ date: string; sessions: DaySession[] }>;

/** One way to go instead: what, a swim's or ride's or short run's minutes, the day it moves to. */
export interface Choice {
  to: Pick;
  minutes?: number;
  day?: string;
}

/** Today's session to change: planned for today, not done, not swapped, not a race or rest. */
export function todaysSession(days: PlanDays, today: string): DaySession | null {
  const s = days.find((d) => d.date === today)?.sessions.find((x) => x.kind !== "rest" && x.status === "today");
  return s && s.kind !== "race" && !s.swapped_from ? s : null;
}

/** The next free day for a session, within three: nothing planned, no hard session either side, and (with `fine`) good weather. */
export function freeDay(days: PlanDays, today: string, fine: (date: string) => boolean = () => true): string | null {
  const busy = (date: string) => days.find((d) => d.date === date)?.sessions.some((x) => x.kind !== "rest") ?? true;
  const hardOn = (date: string) => date !== today && (days.find((d) => d.date === date)?.sessions.some((x) => HARD.has(x.kind)) ?? false);
  for (let n = 1; n <= 3; n++) {
    const d = addDays(today, n);
    if (!days.some((x) => x.date === d)) break;
    if (!busy(d) && !hardOn(addDays(d, -1)) && !hardOn(addDays(d, 1)) && fine(d)) return d;
  }
  return null;
}

/**
 * Whether to lead with the run or with the other ways, and why in one plain line. On your side,
 * but not giving in every time: with a genuine reason (a niggle or pain, a go-easy morning, or
 * something you said puts you off in the forecast) the other ways lead; when it's a key session
 * (the long run, the week's one hard session, or a race within three weeks) or you've already
 * changed two runs in the last ten days, the run leads (a shorter one first), the other ways still
 * there. `ease` wins when both hold.
 */
export interface Stance {
  lead: "run" | "others" | "either";
  line?: string;
}

const ORDINAL = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh"];

export function stanceFor(o: {
  today: string;
  session: DaySession;
  days: PlanDays;
  answers: Answer[];
  /** Days to your race, when there is one ahead. */
  raceDays?: number | null;
  /** A niggle or pain in the last two days. */
  niggle?: boolean;
  /** This morning's verdict: go easy or rest. */
  tired?: boolean;
  /** Something you said puts you off is in today's forecast. */
  dislike?: boolean;
}): Stance {
  if (o.niggle) return { lead: "others", line: "With that niggle, an easy change is the right call." };
  if (o.tired) return { lead: "others", line: "Your body says go easy today, so any of these is fine." };
  if (o.dislike) return { lead: "others" };
  const since = addDays(o.today, -10);
  const changed = o.answers.filter((a) => a.date >= since && a.date < o.today && a.pick && !["run", "nudge"].includes(a.pick)).length;
  if (changed >= 2) return { lead: "run", line: `That's the ${ORDINAL[Math.min(changed + 1, 7)]} change in ten days. Do 25 easy minutes and call it a win.` };
  if (o.raceDays != null && o.raceDays >= 0 && o.raceDays <= 21) return { lead: "run", line: `Your race is in ${o.raceDays} day${o.raceDays === 1 ? "" : "s"}: this one counts. A shorter run still does.` };
  if (o.session.kind === "long") return { lead: "run", line: "It's the long run, the key one this week. Start easy and see how it goes." };
  if (["tempo", "intervals", "hills"].includes(o.session.kind)) {
    const mon = addDays(o.today, -((new Date(`${o.today}T12:00:00Z`).getUTCDay() + 6) % 7));
    const hard = o.days.filter((d) => d.date >= mon && d.date <= addDays(mon, 6)).flatMap((d) => d.sessions).filter((x) => ["tempo", "intervals", "hills"].includes(x.kind)).length;
    if (hard <= 1) return { lead: "run", line: "It's the one hard session this week. Warm up for 10 minutes, then decide." };
  }
  return { lead: "either" };
}

/** The choices led by the stance: the run (a shorter one) first, or the other ways first. */
function led(choices: Choice[], stance: Stance | undefined): Choice[] {
  if (!stance || stance.lead === "either") return choices;
  const runFirst = (c: Choice) => (c.to === "short" ? 0 : c.to === "run" ? 1 : c.to === "nudge" ? 2 : 3);
  const othersFirst = (c: Choice) => (["swim", "ride", "treadmill"].includes(c.to) ? 0 : c.to === "move" ? 1 : c.to === "short" ? 2 : c.to === "nudge" ? 3 : 4);
  const rank = stance.lead === "run" ? runFirst : othersFirst;
  return choices.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
}

/** Every way to change today's session, in your order (your usual picks first), led by the stance when it has one. */
export function dayChoices(o: { session: DaySession; today: string; days: PlanDays; choice: BadWeather; usual?: Pick[]; nudge?: boolean; fine?: (date: string) => boolean; stance?: Stance; run?: boolean }): Choice[] {
  const s = o.session;
  const out: Choice[] = [];
  if (o.nudge !== false) out.push({ to: "nudge" });
  if (EASY_RUNS.has(s.kind)) {
    if (o.choice === "swim" || o.choice === "ride") out.push({ to: o.choice, minutes: crossMinutes(s, o.choice) });
    else if (o.choice === "treadmill") out.push({ to: "treadmill" });
    else out.push({ to: "swim", minutes: crossMinutes(s, "swim") }, { to: "ride", minutes: crossMinutes(s, "ride") });
  } else if (RUN_KINDS.has(s.kind) && o.choice === "treadmill") out.push({ to: "treadmill" });
  const short = RUN_KINDS.has(s.kind) ? shortMinutes(s) : null;
  if (short) out.push({ to: "short", minutes: short });
  const day = freeDay(o.days, o.today, o.fine);
  if (day) out.push({ to: "move", day });
  if (o.run) out.push({ to: "run" });
  const mine = ordered(out, o.usual ?? []);
  // Run anyway last, unless the run leads.
  const order = o.stance?.lead === "run" ? mine : [...mine.filter((c) => c.to !== "run"), ...mine.filter((c) => c.to === "run")];
  return led(order, o.stance);
}

/** Today's change: suggested in the session card (with its reason), or taken (with Undo). */
export interface DaySwap {
  state: "offer" | "taken";
  date: string;
  /** The planned session (what Plans.swap is given) and its name. */
  kind: string;
  title: string;
  /** offer: what the day is like then ("Icy at 07:00", "Heavy legs this morning"), and why it matters to you. */
  why?: string;
  reason?: string;
  /** The tags behind it (kept with your answer). */
  tags?: Tag[];
  /** offer: the ways to go, in your order, Run anyway last. taken: the one taken. */
  choices: Choice[];
}

const BODY_WORDS: Partial<Record<Tag, string>> = { heavy_legs: "Heavy legs this morning", tired: "A go-easy morning" };

/**
 * The suggestion for today, or null: today's session can change, and the forecast at its time
 * (or now, once that has passed) or this morning's body has something you said puts you off, or
 * that you've clearly changed runs for before. Not after 22:00.
 */
export function dayOffer(o: {
  today: string;
  /** This device's wall clock, "YYYY-MM-DDTHH:MM". */
  now: string;
  days: PlanDays;
  /** The time you train on a date, "HH:MM". */
  timeFor: (date: string) => string;
  hours: Hour[];
  choice: BadWeather;
  avoid: Avoid[];
  coldBelow: number;
  body: Tag[];
  tendencies: Tendency[];
  usual: Pick[];
  /** The stance without today's weather (stanceFor); a dislike in the forecast turns it to the other ways. */
  stance?: Stance;
}): DaySwap | null {
  const s = todaysSession(o.days, o.today);
  if (!s || s.weather_kept || o.now.slice(11, 13) >= "22") return null;
  const planned = `${o.today}T${o.timeFor(o.today)}`;
  const at = planned > o.now ? planned : `${o.now.slice(0, 13)}:00`;
  const sky = conditionsAt(o.hours, at, o.coldBelow);
  const why = reasonFor([...sky.tags, ...o.body], o.avoid, o.tendencies, o.usual);
  if (!why) return null;
  const weather = why.tags.some((t) => sky.tags.includes(t));
  const said = weather ? `${sky.words.join(", ")} at ${at.slice(11, 16)}` : why.tags.map((t) => BODY_WORDS[t]).filter(Boolean).join(", ");
  // Moving it: to a day without what put you off.
  const fine = (d: string) => !conditionsAt(o.hours, `${d}T${o.timeFor(d)}`, o.coldBelow).tags.some((t) => why.tags.includes(t)) && o.hours.some((h) => h.time.startsWith(d));
  const stance: Stance | undefined = why.explicit ? { lead: "others" } : o.stance;
  const choices = dayChoices({ session: s, today: o.today, days: o.days, choice: o.choice, usual: o.usual, nudge: false, fine: weather ? fine : undefined, stance, run: true });
  if (!choices.some((c) => c.to !== "run")) return null;
  return { state: "offer", date: o.today, kind: s.kind, title: s.title, why: said, reason: stance?.line && stance.lead === "run" ? `${why.reason} ${stance.line}` : why.reason, tags: [...new Set([...sky.tags, ...o.body])], choices };
}

/** A change taken for today (a swim, a ride, the treadmill, a shorter run, or moved away), for its Undo. */
export function swapTaken(today: string, days: PlanDays): DaySwap | null {
  for (const d of days)
    for (const s of d.sessions) {
      if (!s.swapped_from || !s.swap_kind) continue;
      const moved = s.swap_to === "move" && s.moved_from === today && s.status !== "done";
      const here = d.date === today && s.status !== "done" && ["swim", "ride", "treadmill", "short"].includes(s.swap_to ?? "");
      if (!moved && !here) continue;
      const to = s.swap_to as Pick;
      return { state: "taken", date: today, kind: s.swap_kind, title: s.swapped_from, choices: [{ to, ...(moved ? { day: d.date } : { minutes: s.duration_min }) }] };
    }
  return null;
}

/** A change to a session a few days ahead, for weather you avoid: moved to a better day, or a swim or ride instead. */
export interface AheadChange {
  date: string;
  kind: string;
  title: string;
  to: "move" | "swim" | "ride";
  /** move: the day it goes to. */
  day?: string;
  minutes?: number;
  /** One plain reason, shown with the change: "Icy on Thursday at 07:00, and you said ice puts you off." */
  why: string;
}

const weekdayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

/**
 * The first session two to four days ahead whose forecast has what puts you off (or what you've
 * clearly changed runs for), and the change for it: an easy run becomes your swim or ride when you
 * have one, else (and any other run) it moves to a free day without it. Null: nothing to change.
 */
export function aheadChange(o: { today: string; days: PlanDays; hours: Hour[]; timeFor: (date: string) => string; choice: BadWeather; avoid: Avoid[]; coldBelow: number; tendencies: Tendency[] }): AheadChange | null {
  for (let n = 2; n <= 4; n++) {
    const date = addDays(o.today, n);
    const s = o.days.find((d) => d.date === date)?.sessions.find((x) => RUN_KINDS.has(x.kind) && x.kind !== "race" && x.status === "planned" && !x.swapped_from);
    if (!s) continue;
    const at = `${date}T${o.timeFor(date)}`;
    const sky = conditionsAt(o.hours, at, o.coldBelow);
    const why = reasonFor(sky.tags, o.avoid, o.tendencies, []);
    if (!why) continue;
    const said = `${sky.words.join(", ")} on ${weekdayName(date)} at ${at.slice(11, 16)}. ${why.reason}`;
    if (EASY_RUNS.has(s.kind) && (o.choice === "swim" || o.choice === "ride")) return { date, kind: s.kind, title: s.title, to: o.choice, minutes: crossMinutes(s, o.choice), why: said };
    const day = freeDay(o.days, date, (d) => o.hours.some((h) => h.time.startsWith(d)) && !conditionsAt(o.hours, `${d}T${o.timeFor(d)}`, o.coldBelow).tags.some((t) => why.tags.includes(t)));
    if (day) return { date, kind: s.kind, title: s.title, to: "move", day, why: said };
  }
  return null;
}

/** The plan with that change in it, saying why (for the plan's usual proposal, accepted or not by your setting). */
export function withAheadChange<P extends { weeks: Array<{ start: string; sessions: Array<{ date: string; kind: string; title: string; duration_min?: number; distance_km?: number; steps?: unknown; target?: string; notes?: string; why?: string }> }> }>(plan: P, c: AheadChange): P {
  const weeks = plan.weeks.map((w) => ({ ...w, sessions: [...w.sessions] }));
  const from = weeks.find((w) => w.sessions.some((s) => s.date === c.date && s.kind === c.kind));
  if (!from) return plan;
  const i = from.sessions.findIndex((s) => s.date === c.date && s.kind === c.kind);
  const s = from.sessions[i]!;
  const why = c.why.slice(0, 160);
  if (c.to === "move") {
    const to = weeks.find((w) => w.start <= c.day! && addDays(w.start, 6) >= c.day!);
    if (!to) return plan;
    from.sessions.splice(i, 1);
    to.sessions.push({ ...s, date: c.day!, why });
  } else {
    const { steps: _s, distance_km: _d, ...rest } = s;
    from.sessions[i] = { ...rest, kind: c.to, title: c.to === "swim" ? "Easy swim" : "Easy ride", duration_min: c.minutes, target: c.to === "swim" ? "easy, smooth and steady, breathing easily" : "easy, you could talk all the way", why };
  }
  return { ...plan, weeks } as P;
}

const AHEAD = "coach/weather-ahead.json";

/**
 * A few days ahead, weather you avoid at a planned run (what you said, or a clear habit): one
 * change through the plan's usual proposal (your setting may take it in at once, with Undo and
 * its reason), at most once a week, and not while another change waits. What it did, or null.
 */
export async function proposeAhead(d: {
  disk: Disk;
  plans: Plans;
  habits: Habits;
  checkins: { all(): Promise<Record<string, { legs?: number }>> };
  prefs: () => Promise<SchedulePrefs>;
  forecast: () => Promise<{ hours: Hour[] } | null>;
  past: () => Promise<Hour[] | null>;
  now?: Date;
}): Promise<AheadChange | null> {
  const t = todayOf(d.now);
  const mark = (await readJson<{ week?: string }>(d.disk, AHEAD)) ?? {};
  if (mark.week === mondayOf(t) || (await d.plans.proposal())) return null;
  const [prefs, v, answers, checks] = await Promise.all([d.prefs(), d.plans.view(d.now), d.habits.answers(), d.checkins.all()]);
  if (!v.plan) return null;
  const days = v.weeks.flatMap((w) => w.days);
  const at = (x: string) => timeFor(prefs, x);
  const past = await d.past().catch(() => null);
  const l = learned({ today: t, answers, days, past, timeFor: at, coldBelow: prefs.cold_below, legs: Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.legs])) });
  if (!prefs.avoid.length && !l.tendencies.some((x) => x.strong && WEATHER_TAGS.includes(x.tag))) return null;
  const f = await d.forecast().catch(() => null);
  if (!f) return null;
  const c = aheadChange({ today: t, days, hours: f.hours, timeFor: at, choice: prefs.bad_weather, avoid: prefs.avoid, coldBelow: prefs.cold_below, tendencies: l.tendencies });
  if (!c) return null;
  const { created: _c, updated: _u, conversation: _v, model: _m, ...input } = v.plan;
  await d.disk.write(AHEAD, JSON.stringify({ week: mondayOf(t), at: (d.now ?? new Date()).toISOString(), change: c }));
  await d.plans.submit({ ...withAheadChange(input, c), change_note: c.why.slice(0, 400) }, { source: "weather" }, d.now).catch(() => null);
  return c;
}
