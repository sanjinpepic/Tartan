/**
 * Milestones: quiet, earned moments in the training, never gamified pressure. No points, no badges
 * for opening the app, no daily streaks (they punish rest days), no leaderboards.
 *
 * What counts, from the merged history (Library.activities, Library.runEfforts):
 * - a new best at 1 km, 5 km, 10 km, the half or the marathon (once there's something to beat);
 * - the longest run yet (after a few runs), and the first run over 10, 20 and 30 km, half and
 *   marathon distance;
 * - the biggest week or month of running, once there are eight weeks of history;
 * - a race finished: a plan's race session done, a run named as a race, or your target race's day;
 * - the weekly target met 4, 8, 12, 26 or 52 weeks running, or in 10 of the last 12 (weeks, not
 *   days: a rest day never breaks anything, and a miss is never mentioned);
 * - lightly, the support work: a first 1 km swim, ten swims or ten rides in a year.
 *
 * Each fires once: what's been found is kept in `coach/milestones.json`. The first look (and
 * anything that comes in already old, like a first Strava sync of two years) is kept quiet, so a
 * new user isn't flooded; only new ones show on Today, for a couple of days, one at a time.
 * Words are the coach's (src/coach/prompt.ts): one line of quiet credit, then what's next.
 */
import { readJson, type Disk } from "./disk.ts";
import { sportFamily } from "./merge.ts";
import type { Effort } from "./run-finish.ts";

export type MilestoneKind = "best" | "longest" | "first" | "week" | "month" | "race" | "steady" | "swim" | "ride";

export interface Milestone {
  /** Stable: the same moment always has the same id (it fires once). */
  id: string;
  kind: MilestoneKind;
  /** The day it happened (YYYY-MM-DD, local); a week's or month's last day. */
  date: string;
  /** The workout that earned it (a week's or month's longest run). */
  activity?: string;
  title: string;
  /** One line in the coach's voice. */
  note: string;
  /** The number a share card shows big ("44:10", "24.3") and what it is ("10 km best"). */
  figure?: string;
  figure_label?: string;
  /** How notable: Today shows the highest first. */
  weight: number;
}

export interface KeptMilestone extends Milestone {
  /** When Tartan first found it (ISO). */
  found: string;
  /** Found already there (the first look, or old when it came in): never shown on Today. */
  quiet?: boolean;
  /** Put away from Today (ISO). */
  seen?: string;
}

/** A workout as the detection reads it (Library's ActivityRow). */
export interface MilestoneActivity {
  id: string;
  start: string;
  start_local?: string;
  sport: string;
  name?: string;
  distance_km?: number;
  moving_min?: number;
  elapsed_min?: number;
  elevation_m?: number;
}

export interface MilestoneInput {
  /** Every workout, any sport, any order. */
  activities: MilestoneActivity[];
  /** Every run's fastest standard distances (Library.runEfforts). */
  efforts: Array<{ id: string; start: string; efforts: Effort[] }>;
  /** Complete weeks, oldest first: whether the weekly target was met (null: no target then). */
  weeks?: Array<{ week: string; met: boolean | null }>;
  /** Workouts that did a plan's race session. */
  raceIds?: string[];
  /** Your own race (goals.json): a run on its day, near its distance, finished it. */
  race?: { name?: string; distance_km: number; date?: string } | null;
  now?: number;
}

export const FILE = "coach/milestones.json";
const DAY = 86400_000;
/** How long a new one stays on Today after it's found. */
export const TODAY_DAYS = 2;
/** Older than this when found: kept quiet (a late sync, an import). */
export const FRESH_DAYS = 7;

/** The bests that count, in Strava's names, with how they read and how many earlier times a best needs. */
const BESTS: Array<{ name: string; label: string; before: number; weight: number }> = [
  { name: "1k", label: "1 km", before: 3, weight: 55 },
  { name: "5k", label: "5 km", before: 3, weight: 78 },
  { name: "10k", label: "10 km", before: 3, weight: 80 },
  { name: "Half-Marathon", label: "half marathon", before: 1, weight: 88 },
  { name: "Marathon", label: "marathon", before: 1, weight: 90 },
];
/** Firsts over a distance, shortest first (with a little room for GPS). */
const FIRSTS: Array<{ km: number; key: string; title: string; weight: number }> = [
  { km: 10, key: "10", title: "First run over 10 km", weight: 60 },
  { km: 20, key: "20", title: "First run over 20 km", weight: 75 },
  { km: 21, key: "half", title: "Half-marathon distance, first time", weight: 85 },
  { km: 30, key: "30", title: "First run over 30 km", weight: 80 },
  { km: 42, key: "marathon", title: "Marathon distance, first time", weight: 92 },
];
/** Runs before a longest run or a first over a distance counts. */
const RUNS_BEFORE = 8;
const FIRST_RUNS_BEFORE = 3;
/** Weeks of history before a biggest week or month counts. */
const HISTORY_WEEKS = 8;
const STREAKS = [4, 8, 12, 26, 52];
const WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const localDay = (a: { start: string; start_local?: string }) => (a.start_local ?? a.start).slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}
const one = (x: number) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, "");
const km1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
/** 44:10, 1:42:10. */
export function clock(s: number): string {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
/** 52 s, 1:05. */
const gap = (s: number) => (s < 60 ? `${Math.round(s)} s` : clock(s));
const isRun = (a: MilestoneActivity) => sportFamily(a.sport) === "run";
/** A run named as a race ("Helsinki Half race", "Race: 10k"), not a race-pace session. */
const RACE_NAME = /\brace\b(?!\s*(?:-|\s)?(?:pace|week|prep|sim|day prep))/i;

/** Every milestone in the history, oldest first. Pure: the same history, the same list. */
export function detectMilestones(o: MilestoneInput): Milestone[] {
  const now = o.now ?? Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const acts = [...o.activities].filter((a) => Date.parse(a.start) <= now).sort((a, b) => a.start.localeCompare(b.start));
  const runs = acts.filter(isRun);
  const byId = new Map(acts.map((a) => [a.id, a]));
  const out: Milestone[] = [];

  // Bests: per run, every standard distance it beat; one milestone per run, led by the longest.
  const efforts = [...o.efforts].filter((e) => Date.parse(e.start) <= now).sort((a, b) => a.start.localeCompare(b.start));
  const seen = new Map<string, number[]>();
  for (const r of efforts) {
    const got: Array<{ b: (typeof BESTS)[number]; t: number; was: number }> = [];
    for (const b of BESTS) {
      const e = r.efforts.find((x) => x.name === b.name);
      if (!e) continue;
      const times = seen.get(b.name) ?? [];
      if (times.length >= b.before && e.time_s < Math.min(...times)) got.push({ b, t: e.time_s, was: Math.min(...times) });
    }
    for (const e of r.efforts) seen.set(e.name, [...(seen.get(e.name) ?? []), e.time_s]);
    if (!got.length) continue;
    const lead = got.at(-1)!;
    const others = got.slice(0, -1).reverse();
    const also = others.length ? `, with ${others.length === 1 ? `a ${others[0]!.b.label} best` : `bests at ${others.map((x) => x.b.label).join(" and ")}`} on the way` : "";
    const a = byId.get(r.id);
    out.push({
      id: `best:${r.id}`,
      kind: "best",
      date: a ? localDay(a) : r.start.slice(0, 10),
      activity: r.id,
      title: `New ${lead.b.label} best: ${clock(lead.t)}`,
      note: `${gap(lead.was - lead.t)} under your old best${also}. Earned. Keep the next two days easy.`,
      figure: clock(lead.t),
      figure_label: `${lead.b.label} best`,
      weight: lead.b.weight,
    });
  }

  // Distance: a first over 10, 20, half, 30, marathon (the biggest crossed); else the longest yet.
  let longest = 0;
  const crossed = new Set<string>();
  runs.forEach((r, i) => {
    const km = r.distance_km ?? 0;
    const firsts = FIRSTS.filter((f) => km >= f.km && !crossed.has(f.key));
    const longer = i >= RUNS_BEFORE && km > longest + 0.2;
    const time = r.moving_min ? clock(r.moving_min * 60) : null;
    const f = firsts.at(-1);
    if (f && i >= FIRST_RUNS_BEFORE) {
      const note =
        f.key === "10" ? `${one(km)} km. Double figures now; the long runs build from here.`
        : f.key === "20" ? `${one(km)} km${longer ? ", the longest you've gone" : ""}. Recover properly and the next one comes easier.`
        : f.key === "30" ? `${one(km)} km. Marathon territory: eat, sleep, and keep the week gentle.`
        : `${one(km)} km${time ? ` in ${time}` : ""}. Earned. ${f.key === "marathon" ? "Rest properly; the legs will tell you when." : "Easy for a couple of days."}`;
      out.push({ id: `first:${f.key}`, kind: "first", date: localDay(r), activity: r.id, title: f.title, note, figure: one(km), figure_label: "km", weight: f.weight });
    } else if (longer) {
      out.push({ id: `longest:${r.id}`, kind: "longest", date: localDay(r), activity: r.id, title: `Longest run yet: ${one(km)} km`, note: `${one(km - longest)} km past your old longest. Eat well and keep tomorrow easy.`, figure: one(km), figure_label: "km, your longest run", weight: 70 });
    }
    for (const x of FIRSTS) if (km >= x.km) crossed.add(x.key);
    longest = Math.max(longest, km);
  });

  // The biggest week and month of running, complete ones, after eight weeks of history.
  if (runs.length) {
    const first = localDay(runs[0]!);
    const thisWeek = mondayOf(today);
    const weekKm = new Map<string, { km: number; long?: MilestoneActivity }>();
    const monthKm = new Map<string, { km: number; long?: MilestoneActivity }>();
    for (const r of runs) {
      for (const [m, k] of [[weekKm, mondayOf(localDay(r))], [monthKm, localDay(r).slice(0, 7)]] as const) {
        const b = m.get(k) ?? { km: 0 };
        b.km += r.distance_km ?? 0;
        if (!b.long || (r.distance_km ?? 0) > (b.long.distance_km ?? 0)) b.long = r;
        m.set(k, b);
      }
    }
    let best = 0;
    for (let w = mondayOf(first); w < thisWeek; w = addDays(w, 7)) {
      const b = weekKm.get(w);
      const km = b?.km ?? 0;
      const enough = Date.parse(w) - Date.parse(mondayOf(first)) >= HISTORY_WEEKS * 7 * DAY;
      if (enough && km >= best + 1 && best > 0) {
        out.push({ id: `week:${w}`, kind: "week", date: addDays(w, 6), activity: b?.long?.id, title: `Biggest week yet: ${km1(km)} km`, note: `${one(km - best)} km more than any week before. Good work; next week can come down a little.`, figure: km1(km), figure_label: "km in a week", weight: 45 });
      }
      best = Math.max(best, km);
    }
    let bestMonth = 0;
    const thisMonth = today.slice(0, 7);
    for (let m = first.slice(0, 7); m < thisMonth; m = nextMonth(m)) {
      const b = monthKm.get(m);
      const km = b?.km ?? 0;
      const enough = Date.parse(`${m}-01`) - Date.parse(first) >= HISTORY_WEEKS * 7 * DAY;
      if (enough && km >= bestMonth + 1 && bestMonth > 0) {
        const name = MONTHS[Number(m.slice(5)) - 1]!;
        out.push({ id: `month:${m}`, kind: "month", date: addDays(`${nextMonth(m)}-01`, -1), activity: b?.long?.id, title: `Biggest month yet: ${Math.round(km)} km`, note: `${Math.round(km)} km in ${name}, more than any month before. Bank it; don't chase it next month.`, figure: String(Math.round(km)), figure_label: `km in ${name}`, weight: 50 });
      }
      bestMonth = Math.max(bestMonth, km);
    }
  }

  // Races: a plan's race session done, a run named as one, or a run on your race's day.
  const raceIds = new Set(o.raceIds ?? []);
  for (const r of runs) {
    const onTheDay = !!o.race?.date && localDay(r) === o.race.date && (r.distance_km ?? 0) >= o.race.distance_km * 0.9;
    if (!raceIds.has(r.id) && !RACE_NAME.test(r.name ?? "") && !onTheDay) continue;
    const name = (onTheDay && o.race?.name) || (r.name && RACE_NAME.test(r.name) ? r.name : null) || (r.distance_km ? `${one(r.distance_km)} km race` : "Race");
    const s = (r.elapsed_min ?? r.moving_min ?? 0) * 60;
    out.push({
      id: `race:${r.id}`,
      kind: "race",
      date: localDay(r),
      activity: r.id,
      title: `Race done: ${name}`,
      note: `${s ? `${clock(s)} for ${one(r.distance_km ?? 0)} km. ` : ""}Well run. The easy days after it are part of the training.`,
      ...(s ? { figure: clock(s), figure_label: r.distance_km ? `${one(r.distance_km)} km` : "race" } : {}),
      weight: 100,
    });
  }

  // Consistency: the weekly target, weeks running (never days), or in 10 of the last 12.
  const weeks = o.weeks ?? [];
  let streak = 0;
  let lastTen = -99;
  weeks.forEach((w, i) => {
    streak = w.met ? streak + 1 : 0;
    const end = addDays(w.week, 6);
    if (w.met && STREAKS.includes(streak)) {
      const from = weeks[i - streak + 1]!.week;
      out.push({ id: `steady:${streak}:${from}`, kind: "steady", date: end, title: `Weekly target met ${streak} weeks running`, note: `${cap(WORDS[streak] ?? String(streak))} weeks of doing what you said you'd do. That's how it gets built; keep the easy ones easy.`, figure: String(streak), figure_label: "weeks on target", weight: streak >= 26 ? 68 : streak >= 12 ? 58 : streak >= 8 ? 50 : 40 });
    }
    if (i >= 11 && w.met && streak < 10) {
      const met = (k: number) => weeks.slice(k - 11, k + 1).filter((x) => x.met).length;
      if (met(i) >= 10 && met(i - 1) < 10 && i - lastTen >= 12) {
        lastTen = i;
        out.push({ id: `steady12:${w.week}`, kind: "steady", date: end, title: "Target met in 10 of the last 12 weeks", note: "Ten of twelve, with life in between. Consistent beats heroic; carry on.", figure: "10/12", figure_label: "weeks on target", weight: 40 });
      }
    }
  });

  // The support work, lightly: a first 1 km swim, ten swims or rides in a year.
  const swims = acts.filter((a) => sportFamily(a.sport) === "swim");
  const firstK = swims.find((s) => (s.distance_km ?? 0) >= 1);
  if (firstK) out.push({ id: "swim:1k", kind: "swim", date: localDay(firstK), activity: firstK.id, title: "First 1 km swim", note: "A kilometre in the water. Good support work for the running.", figure: one(firstK.distance_km!), figure_label: "km swim", weight: 20 });
  for (const [kind, list, word] of [["swim", swims, "swims"], ["ride", acts.filter((a) => sportFamily(a.sport) === "ride"), "rides"]] as const) {
    const byYear = new Map<string, MilestoneActivity[]>();
    for (const a of list) byYear.set(localDay(a).slice(0, 4), [...(byYear.get(localDay(a).slice(0, 4)) ?? []), a]);
    for (const [year, xs] of byYear) {
      const tenth = xs[9];
      if (!tenth) continue;
      out.push({ id: `${kind}s10:${year}`, kind, date: localDay(tenth), activity: tenth.id, title: `Ten ${word} this year`, note: kind === "swim" ? `Ten swims in ${year}. Easy on the legs, good for the engine.` : `Ten rides in ${year}: aerobic work that spares the legs.`, figure: "10", figure_label: `${word} in ${year}`, weight: 18 });
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date) || a.weight - b.weight);
}

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The end of the day it happened, roughly (UTC). */
const endOf = (m: Pick<Milestone, "date">) => Date.parse(`${m.date}T23:59:59Z`);

interface Store {
  /** When milestones began on this device. */
  since: string;
  items: KeptMilestone[];
}

/**
 * What's been found, with the new ones added: each id once. The first look keeps everything quiet
 * (in the demo all but the newest, so it has one to show), and so does anything already old.
 */
export async function keepMilestones(disk: Disk, found: Milestone[], now = Date.now(), o: { sample?: boolean } = {}): Promise<KeptMilestone[]> {
  const cur = await readJson<Store>(disk, FILE);
  const items = cur?.items ?? [];
  const have = new Set(items.map((x) => x.id));
  const fresh = found.filter((m) => !have.has(m.id));
  if (cur && !fresh.length) return items;
  const at = new Date(now).toISOString();
  const show = !cur && o.sample ? [...fresh].sort((a, b) => b.date.localeCompare(a.date) || b.weight - a.weight)[0]?.id : undefined;
  for (const m of fresh) {
    const quiet = m.id !== show && (!cur || now - endOf(m) > FRESH_DAYS * DAY);
    items.push({ ...m, found: at, ...(quiet ? { quiet: true } : {}) });
  }
  await disk.write(FILE, JSON.stringify({ since: cur?.since ?? at, items } satisfies Store));
  return items;
}

/** What Today shows: new, not put away, found in the last couple of days; most notable first. */
export function onToday(items: KeptMilestone[], now = Date.now()): KeptMilestone[] {
  return items
    .filter((x) => !x.quiet && !x.seen && now - Date.parse(x.found) <= TODAY_DAYS * DAY && now - endOf(x) <= FRESH_DAYS * DAY)
    .sort((a, b) => b.weight - a.weight || b.date.localeCompare(a.date));
}

/** Put one away from Today, and the others the same workout earned with it (one moment, one card). */
export async function putAway(disk: Disk, id: string, now = Date.now()): Promise<KeptMilestone[]> {
  const cur = await readJson<Store>(disk, FILE);
  if (!cur) return [];
  const hit = cur.items.find((x) => x.id === id);
  if (!hit) return cur.items;
  const at = new Date(now).toISOString();
  for (const x of cur.items) if (!x.seen && (x.id === id || (hit.activity && x.activity === hit.activity))) x.seen = at;
  await disk.write(FILE, JSON.stringify(cur));
  return cur.items;
}

/**
 * Each complete week since the first workout, oldest first: whether the weekly target was met.
 * Your own target (goals.json, as Today counts it: every workout's distance and the number of
 * workouts) when you set one; else the plan's week (its sessions done); else null.
 */
export function weeksOnTarget(
  activities: MilestoneActivity[],
  goals: { weekly_km?: number; weekly_workouts?: number },
  planWeeks: Array<{ start: string; planned: { sessions: number; km: number }; done: { sessions: number; km: number } }>,
  now = Date.now(),
): Array<{ week: string; met: boolean | null; km: number; run_km: number }> {
  if (!activities.length) return [];
  const today = new Date(now).toISOString().slice(0, 10);
  const first = mondayOf(activities.map(localDay).sort()[0]!);
  const by = new Map<string, { km: number; run: number; n: number }>();
  for (const a of activities) {
    const w = mondayOf(localDay(a));
    const b = by.get(w) ?? { km: 0, run: 0, n: 0 };
    b.km += a.distance_km ?? 0;
    if (isRun(a)) b.run += a.distance_km ?? 0;
    b.n++;
    by.set(w, b);
  }
  const plan = new Map(planWeeks.map((w) => [w.start, w]));
  const own = !!(goals.weekly_km || goals.weekly_workouts);
  const out = [];
  for (let w = first; w < mondayOf(today); w = addDays(w, 7)) {
    const b = by.get(w) ?? { km: 0, run: 0, n: 0 };
    const p = plan.get(w);
    const met = own
      ? (!goals.weekly_km || b.km >= goals.weekly_km) && (!goals.weekly_workouts || b.n >= goals.weekly_workouts)
      : p && p.planned.sessions > 0 ? p.done.sessions >= p.planned.sessions || (p.planned.km > 0 && p.done.km >= p.planned.km)
      : null;
    out.push({ week: w, met, km: Math.round(b.km * 10) / 10, run_km: Math.round(b.run * 10) / 10 });
  }
  return out;
}

/** What the loader needs from the app (Library, Plans, goals), kept small so it tests alone. */
export interface MilestoneSources {
  disk: Disk;
  activities: () => Promise<MilestoneActivity[]>;
  efforts: () => Promise<Array<{ id: string; start: string; efforts: Effort[] }>>;
  goals: () => Promise<{ weekly_km?: number; weekly_workouts?: number; race?: { name?: string; distance_km: number; date?: string } }>;
  /** The plan's weeks (Plans.view), for race sessions done and weeks on target. */
  planWeeks: () => Promise<Array<{ start: string; when?: string; planned: { sessions: number; km: number }; done: { sessions: number; km: number }; days: Array<{ sessions: Array<{ kind: string; status: string; activity?: { id: string } }> }> }>>;
  sample?: () => Promise<boolean>;
}

/** Every milestone, the new ones found and kept (src/api.ts, the coach's get_milestones). */
export async function loadMilestones(src: MilestoneSources, now = Date.now()): Promise<{ items: KeptMilestone[]; weeks: ReturnType<typeof weeksOnTarget> }> {
  const [activities, efforts, goals, planWeeks, sample] = await Promise.all([
    src.activities(),
    src.efforts().catch(() => []),
    src.goals().catch(() => ({})),
    src.planWeeks().catch(() => []),
    src.sample?.().catch(() => false) ?? Promise.resolve(false),
  ]);
  // Nothing in yet (a fresh install before its first sync): no first look, so what comes in
  // with the first sync is the first look, kept quiet.
  if (!activities.length) return { items: [], weeks: [] };
  const weeks = weeksOnTarget(activities, goals as { weekly_km?: number }, planWeeks.filter((w) => w.when !== "future"), now);
  const raceIds = planWeeks.flatMap((w) => w.days.flatMap((d) => d.sessions.filter((s) => s.kind === "race" && s.status === "done" && s.activity).map((s) => s.activity!.id)));
  const found = detectMilestones({ activities, efforts, weeks, raceIds, race: (goals as { race?: MilestoneInput["race"] }).race ?? null, now });
  return { items: await keepMilestones(src.disk, found, now, { sample }), weeks };
}
