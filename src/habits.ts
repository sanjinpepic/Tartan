/**
 * What Tartan learns about your days, plainly and on the phone: which conditions make you change
 * a planned run, and what you pick when you do. Nothing here is a black box: every tendency is
 * counts with a stated reason ("On icy days you've changed 4 of 5 runs").
 *
 *   Tags     what a day was like at the session's time: weather (ice, rain, wind, cold, heat,
 *            dark, read from the forecast or the past weather) and the body (heavy legs in the
 *            morning check, a go-easy morning).
 *   Answers  what you chose when Today offered or you asked (a swim, a ride, the treadmill, a
 *            shorter run, another day, a nudge, or Run anyway), kept in coach/habits.json. An
 *            offer left alone counts as running anyway.
 *   History  your planned runs and whether they were done, with the weather they met. A missed
 *            run counts as changed; it's never shown as "skipped".
 *
 * A tendency acts only with enough evidence: a prior of one changed run in three (most days you
 * run as planned), at least three days like it, and changing clearly more often than on other
 * days. Run anyway lowers it, so a suggestion you keep turning down stops coming. What you've said
 * puts you off (Settings, or told to the coach) acts at once.
 */
import { readJson, type Disk } from "./disk.ts";
import { heat, type Hour } from "./weather.ts";
import type { Avoid } from "./schedule.ts";
import { RUN_KINDS } from "./plan.ts";

export const TAGS = ["ice", "rain", "wind", "cold", "heat", "dark", "heavy_legs", "tired"] as const;
export type Tag = (typeof TAGS)[number];
/** The weather's tags (the ones a forecast can say ahead). */
export const WEATHER_TAGS: readonly Tag[] = ["ice", "rain", "wind", "cold", "heat", "dark"];

/** What you can pick instead of the run as planned. */
export type Pick = "swim" | "ride" | "treadmill" | "short" | "move" | "nudge" | "run";

const SNOW = new Set([71, 73, 75, 77, 85, 86]);
const FREEZING = new Set([56, 57, 66, 67]);
const HEAVY_RAIN = new Set([63, 65, 81, 82]);

/**
 * The weather's tags at a local time ("YYYY-MM-DDTHH:MM"), with words for each ("Icy", "Heavy
 * rain"). Ice: snow falling or lying fresh, freezing rain, or around zero after rain or snow in
 * the hours before (slippery). Rain: 2 mm an hour or more. Wind: 30 km/h or gusts of 55. Cold:
 * below `coldBelow`. Heat: hot and humid enough to cost pace (temperature plus dew point past
 * 150 °F). Dark: before sunrise or after sunset.
 */
export function conditionsAt(hours: Hour[], local: string, coldBelow = 0): { tags: Tag[]; words: string[] } {
  const i = hours.findIndex((h) => h.time.slice(0, 13) === local.slice(0, 13));
  if (i < 0) return { tags: [], words: [] };
  const h = hours[i]!;
  const before = hours.slice(Math.max(0, i - 12), i + 1);
  const code = h.code ?? -1;
  const tags: Tag[] = [];
  const words: string[] = [];
  const wet = (x: Hour) => (x.rain_mm ?? 0) >= 0.3 || (x.snow_cm ?? 0) > 0 || SNOW.has(x.code ?? -1);
  const ice = SNOW.has(code) || FREEZING.has(code) || (h.snow_cm ?? 0) > 0 || (h.temp_c <= 1 && before.some(wet) && before.some((x) => x.temp_c <= 1));
  if (ice) (tags.push("ice"), words.push(SNOW.has(code) || (h.snow_cm ?? 0) > 0 ? "Snow" : "Icy"));
  else if ((h.rain_mm ?? 0) >= 2 || HEAVY_RAIN.has(code)) (tags.push("rain"), words.push("Heavy rain"));
  const wind = Math.round(Math.max(h.wind_kmh ?? 0, 0));
  if (wind >= 30) (tags.push("wind"), words.push(`wind ${wind} km/h`));
  else if ((h.gust_kmh ?? 0) >= 55) (tags.push("wind"), words.push(`gusts of ${Math.round(h.gust_kmh!)} km/h`));
  if (h.temp_c < coldBelow) (tags.push("cold"), words.push(`${Math.round(h.temp_c)} °C`));
  if (heat(h.temp_c, h.dew_c).sum_f >= 150) (tags.push("heat"), words.push(`hot, ${Math.round(h.temp_c)} °C`));
  if (h.day === false) (tags.push("dark"), words.push("dark"));
  const said = words.map((w, k) => (k === 0 ? w[0]!.toUpperCase() + w.slice(1) : w));
  return { tags, words: said };
}

/** The body's tags this morning: heavy legs in the check, a go-easy (or rest) verdict. */
export function bodyTags(check: { legs?: number } | null, level: string | null): Tag[] {
  return [...(check?.legs === 1 ? (["heavy_legs"] as Tag[]) : []), ...(level && level !== "ready" ? (["tired"] as Tag[]) : [])];
}

/** One day as seen: its tags and whether the run was changed (1) or run as planned (0). */
export interface Seen {
  date: string;
  tags: Tag[];
  changed: 0 | 1;
}

export interface Tendency {
  tag: Tag;
  /** Days like it, and on how many the run was changed. */
  n: number;
  changed: number;
  /** With the prior: (changed + 1) / (n + 3). */
  p: number;
  /** Enough to act on: three days at least, p 0.6 and over, and clearly above other days. */
  strong: boolean;
}

export const MIN_DAYS = 3;
const PRIOR_CHANGED = 1;
const PRIOR_DAYS = 3;
const rate = (changed: number, n: number) => (changed + PRIOR_CHANGED) / (n + PRIOR_DAYS);

/** Each tag's tendency, from the days seen. */
export function tendencies(seen: Seen[]): Tendency[] {
  const out: Tendency[] = [];
  for (const tag of TAGS) {
    const with_ = seen.filter((s) => s.tags.includes(tag));
    if (!with_.length) continue;
    const others = seen.filter((s) => !s.tags.includes(tag));
    const changed = with_.reduce((n, s) => n + s.changed, 0);
    const p = rate(changed, with_.length);
    const base = rate(others.reduce((n, s) => n + s.changed, 0), others.length);
    out.push({ tag, n: with_.length, changed, p: Math.round(p * 100) / 100, strong: with_.length >= MIN_DAYS && p >= 0.6 && p >= base + 0.15 });
  }
  return out;
}

const TAG_DAYS: Record<Tag, string> = {
  ice: "icy or snowy days", rain: "days of heavy rain", wind: "windy days", cold: "cold days", heat: "hot days", dark: "runs in the dark",
  heavy_legs: "heavy-legs mornings", tired: "go-easy mornings",
};
const AVOID_WORDS: Record<Avoid, string> = { ice: "ice and snow", rain: "heavy rain", wind: "strong wind", cold: "the cold", heat: "the heat", dark: "the dark" };
const PICK_WORDS: Partial<Record<Pick, string>> = { swim: "a swim", ride: "a ride", treadmill: "the treadmill", short: "a shorter run", move: "another day" };

/** One answer kept: the day, the session, what it was like, what was offered (proactive) and what you picked. */
export interface Answer {
  date: string;
  kind: string;
  tags: Tag[];
  /** Today offered it unasked. */
  offered?: boolean;
  /** What you picked; none yet (an offer not answered). */
  pick?: Pick;
}

const FILE = "coach/habits.json";

export class Habits {
  constructor(private readonly disk: Disk) {}

  async answers(): Promise<Answer[]> {
    return (await readJson<Answer[]>(this.disk, FILE)) ?? [];
  }

  /** An offer shown today (once a day; an answer later fills it in). */
  async offered(date: string, kind: string, tags: Tag[]): Promise<void> {
    const all = await this.answers();
    if (all.some((a) => a.date === date && a.kind === kind)) return;
    await this.write([...all, { date, kind, tags, offered: true }]);
  }

  /** What you picked for a day's session (the last answer for the day stands; a nudge doesn't replace a pick). */
  async answer(date: string, kind: string, tags: Tag[], pick: Pick): Promise<void> {
    const all = await this.answers();
    const i = all.findIndex((a) => a.date === date && a.kind === kind);
    if (i >= 0) {
      if (pick === "nudge" && all[i]!.pick && all[i]!.pick !== "nudge") return;
      all[i] = { ...all[i]!, tags: all[i]!.tags.length ? all[i]!.tags : tags, pick };
    } else all.push({ date, kind, tags, pick });
    await this.write(all);
  }

  /** An answer taken back (Undo): the day goes back to offered, or goes. */
  async undo(date: string, kind: string): Promise<void> {
    const all = await this.answers();
    await this.write(all.flatMap((a) => (a.date === date && a.kind === kind ? (a.offered ? [{ date: a.date, kind: a.kind, tags: a.tags, offered: true }] : []) : [a])));
  }

  private write(all: Answer[]): Promise<void> {
    // The last 400 days.
    return this.disk.write(FILE, JSON.stringify(all.sort((a, b) => a.date.localeCompare(b.date)).slice(-400)));
  }
}

/**
 * The days seen, from your answers and your plan's past runs: an answer counts for its day (a pick
 * other than Run anyway or a nudge: changed; Run anyway, or an offer left alone: as planned); a
 * nudge alone counts by whether the run was done; any other past run counts by done (as planned)
 * or not (changed), with the tags its day had.
 */
export function daysSeen(o: {
  today: string;
  answers: Answer[];
  /** The plan's past runs: date, kind, done or not. */
  runs: Array<{ date: string; kind: string; done: boolean }>;
  /** A past day's tags (its weather at the training time, the morning's check). */
  tagsOn: (date: string) => Tag[];
}): Seen[] {
  const out: Seen[] = [];
  const answered = new Set<string>();
  const runDone = new Map(o.runs.map((r) => [`${r.date}:${r.kind}`, r.done]));
  for (const a of o.answers) {
    if (a.date >= o.today && !a.pick) continue;
    if (a.pick === "nudge") {
      const done = runDone.get(`${a.date}:${a.kind}`);
      if (done === undefined) continue;
      out.push({ date: a.date, tags: a.tags, changed: done ? 0 : 1 });
    } else out.push({ date: a.date, tags: a.tags, changed: a.pick && a.pick !== "run" ? 1 : 0 });
    answered.add(`${a.date}:${a.kind}`);
  }
  for (const r of o.runs) {
    if (r.date >= o.today || answered.has(`${r.date}:${r.kind}`)) continue;
    out.push({ date: r.date, tags: o.tagsOn(r.date), changed: r.done ? 0 : 1 });
  }
  return out;
}

/** What you usually pick instead, once you have picked something at least twice of three answers or more. */
export function usualPicks(answers: Answer[]): Pick[] {
  const picks = answers.map((a) => a.pick).filter((p): p is Pick => !!p && p !== "run" && p !== "nudge");
  if (picks.length < MIN_DAYS) return [];
  const count = new Map<Pick, number>();
  for (const p of picks) count.set(p, (count.get(p) ?? 0) + 1);
  return [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

/** The choices in your order: your usual picks first, the rest as they came. */
export function ordered<T extends { to: Pick }>(choices: T[], usual: Pick[]): T[] {
  const rank = (p: Pick) => (usual.includes(p) ? usual.indexOf(p) : usual.length + choices.findIndex((c) => c.to === p));
  return [...choices].sort((a, b) => rank(a.to) - rank(b.to));
}

/**
 * Why Today suggests a change, in one line, or null when nothing should: what you said puts you
 * off comes first ("You said ice and snow put you off."); else the strongest learned tendency
 * among today's tags ("On icy or snowy days you've changed 4 of 5 runs, mostly for a swim.").
 */
export function reasonFor(tags: Tag[], avoid: Avoid[], tend: Tendency[], usual: Pick[]): { reason: string; tags: Tag[]; explicit: boolean } | null {
  const told = avoid.filter((a) => tags.includes(a));
  if (told.length) return { reason: `You said ${told.map((a) => AVOID_WORDS[a]).join(" and ")} put${told.length === 1 && !/ and /.test(AVOID_WORDS[told[0]!]) ? "s" : ""} you off.`, tags: told, explicit: true };
  const t = tend.filter((x) => x.strong && tags.includes(x.tag)).sort((a, b) => b.p - a.p)[0];
  if (!t) return null;
  const mostly = usual[0] && PICK_WORDS[usual[0]] ? `, mostly for ${PICK_WORDS[usual[0]]}` : "";
  return { reason: `On ${TAG_DAYS[t.tag]} you've changed ${t.changed} of ${t.n} runs${mostly}.`, tags: [t.tag], explicit: false };
}

/** The tendencies in words, for the coach (get_habits) and the sheet: the strong ones. */
export function habitLines(tend: Tendency[], usual: Pick[]): string[] {
  const lines = tend.filter((t) => t.strong).map((t) => `On ${TAG_DAYS[t.tag]} you've changed ${t.changed} of ${t.n} runs.`);
  if (usual[0] && PICK_WORDS[usual[0]]) lines.push(`When you change a run, you usually pick ${PICK_WORDS[usual[0]]}.`);
  return lines;
}

/**
 * What's learned now: the days seen (your answers, and the plan's past runs with the weather they
 * met at your training time and the morning's legs), each tag's tendency, and your usual picks.
 */
export function learned(o: {
  today: string;
  answers: Answer[];
  days: Array<{ date: string; sessions: Array<{ kind: string; status?: string; swap_kind?: string }> }>;
  /** The past weeks' weather by the hour (Weather.pastDays), when there is some. */
  past: Hour[] | null;
  timeFor: (date: string) => string;
  coldBelow: number;
  /** The morning check's legs by date (1 heavy). */
  legs: Record<string, number | undefined>;
}): { seen: Seen[]; tendencies: Tendency[]; usual: Pick[] } {
  const runs = o.days.flatMap((d) => d.sessions.filter((s) => RUN_KINDS.has(s.swap_kind ?? s.kind) && d.date < o.today).map((s) => ({ date: d.date, kind: s.swap_kind ?? s.kind, done: s.status === "done" })));
  const tagsOn = (date: string): Tag[] => [...(o.past ? conditionsAt(o.past, `${date}T${o.timeFor(date)}`, o.coldBelow).tags : []), ...(o.legs[date] === 1 ? (["heavy_legs"] as Tag[]) : [])];
  const seen = daysSeen({ today: o.today, answers: o.answers, runs, tagsOn });
  return { seen, tendencies: tendencies(seen), usual: usualPicks(o.answers) };
}
