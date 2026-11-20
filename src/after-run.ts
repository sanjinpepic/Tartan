/**
 * A short note after each run: when a new run comes in (from the watch, Health Connect,
 * intervals.icu, Strava or a recording), one or two plain lines from the coach, by rules from
 * the run's finish (src/run-finish.ts): how it went against the planned session, a record if one
 * was set, against the last run like it, and what's next ("Every rep on pace, heart rate 4 lower
 * than last time. Tomorrow stays easy."). With a cloud key and a connection the coach may put the
 * same facts in its own words (Coach.afterRunWords); the rules' words stand otherwise.
 *
 * Which runs get one: runs that started in the last 24 hours, each once. The first time this runs
 * on a phone (or after its record is gone) the runs already there are only noted as seen, so a
 * first import or a restored backup brings no flood. The record is `settings/after-run.json`.
 */
import { readJson, type Disk } from "./disk.ts";
import type { Comparison, RunFinish } from "./run-finish.ts";

const FILE = "settings/after-run.json";
/** Only runs this recent get a note. */
export const FRESH_MS = 24 * 3600_000;
/** Ids are remembered this long (well past FRESH_MS), then let go. */
const KEEP_MS = 7 * 86400_000;
/** At most this many notes at once (two runs in a day, a sync after a weekend away). */
const MAX = 3;

interface Seen {
  /** When notes began on this device. */
  since: string;
  /** Run id → when its note was made (or the run was found already there). */
  seen: Record<string, string>;
}

export interface RunRow {
  id: string;
  start: string;
  sport: string;
  distance_km?: number;
  moving_min?: number;
}

/**
 * The runs that need a note now, newest first, marked as noted in the same go (so never twice,
 * however often it's asked). The first time, everything already there is marked and none returned.
 */
export async function claimNewRuns(disk: Disk, rows: RunRow[], isRun: (sport: string) => boolean, now = Date.now()): Promise<string[]> {
  const prev = await readJson<Seen>(disk, FILE);
  const real = rows.filter((r) => isRun(r.sport) && ((r.distance_km ?? 0) >= 0.5 || (r.moving_min ?? 0) >= 5));
  const fresh = real.filter((r) => {
    const t = Date.parse(r.start);
    return Number.isFinite(t) && t <= now && now - t <= FRESH_MS;
  });
  const at = new Date(now).toISOString();
  const seen: Record<string, string> = {};
  for (const [id, when] of Object.entries(prev?.seen ?? {})) if (now - Date.parse(when) <= KEEP_MS) seen[id] = when;
  const out = prev ? fresh.filter((r) => !prev.seen[r.id]).sort((a, b) => b.start.localeCompare(a.start)).slice(0, MAX).map((r) => r.id) : [];
  // Everything fresh is seen now: the ones noted, and (the first time, or past MAX) the rest.
  for (const r of fresh) seen[r.id] ??= at;
  const next = JSON.stringify({ since: prev?.since ?? at, seen } satisfies Seen);
  if (!prev || next !== JSON.stringify(prev)) await disk.write(FILE, next);
  return out;
}

/** The day after the run in the plan: what's on it. */
export interface NextDay {
  /** "Today" or "Tomorrow" (or a weekday when it's further). */
  when: string;
  sessions: Array<{ kind: string; title: string }>;
}

type ViewLike = { weeks: Array<{ days: Array<{ date: string; sessions: Array<{ kind: string; title: string; status: string }> }> }> };

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** What the plan has the day after the run (or today, when the run was yesterday). Null without a plan that far. */
export function nextDay(view: ViewLike, runDate: string, today: string): NextDay | null {
  const days = view.weeks.flatMap((w) => w.days);
  const target = [addDays(runDate, 1), today].sort().at(-1)!;
  const day = days.find((d) => d.date === target);
  if (!day) return null;
  const when = target === today ? "Today" : target === addDays(today, 1) ? "Tomorrow" : new Date(`${target}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return { when, sessions: day.sessions.filter((s) => s.kind !== "rest" && s.status !== "done").map((s) => ({ kind: s.kind, title: s.title })) };
}

const NAME: Record<string, string> = { "400m": "400 m", "1k": "1 km", "1 mile": "mile", "5k": "5 km", "10k": "10 km", "15k": "15 km", "Half-Marathon": "half marathon", "30k": "30 km", Marathon: "marathon" };
const clock = (s: number) => {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
const seconds = (pace: string | null) => {
  const m = pace ? /^(\d+):(\d{2})$/.exec(pace) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const one = (x: number) => (Math.round(x * 10) / 10).toString();

/** Against the last run like it, in a few words ("heart rate 4 lower than last time"). */
export function lastWords(c: Comparison): string | null {
  const [a, b] = [seconds(c.pace), seconds(c.now.pace)];
  const dp = a !== null && b !== null ? a - b : null; // plus: quicker now
  const dh = c.now.hr !== null && c.hr !== null ? Math.round(c.now.hr - c.hr) : null;
  const pace = dp !== null && Math.abs(dp) >= 3 ? `${Math.abs(dp)} s/km ${dp > 0 ? "quicker" : "slower"}` : null;
  const hr = dh !== null && Math.abs(dh) >= 2 ? `${Math.abs(dh)} ${dh < 0 ? "lower" : "higher"}` : null;
  if (pace && hr) return `${pace} than last time, heart rate ${hr}`;
  if (pace) return `${pace} than last time`;
  if (hr) return `heart rate ${hr} than last time`;
  return dp !== null || dh !== null ? "the same as last time" : null;
}

/** What's next, in a sentence ("Tomorrow stays easy.", "Tomorrow is a rest day."). */
export function nextWords(n: NextDay | null): string | null {
  if (!n) return null;
  if (!n.sessions.length) return `${n.when} is a rest day.`;
  if (n.sessions.every((s) => s.kind === "easy" || s.kind === "recovery")) return `${n.when} stays easy.`;
  return `${n.when}: ${n.sessions.map((s) => s.title).join(" and ")}.`;
}

export interface AfterRunWords {
  title: string;
  /** The note, by rules: one or two sentences. */
  text: string;
  /** The same facts, one per line, for the coach to put in its words. */
  facts: string[];
}

/** The note for a run from its finish and the day after it. */
export function afterRunWords(run: { name?: string; distance_km?: number; moving_min?: number; avg_hr?: number }, f: RunFinish, next: NextDay | null): AfterRunWords {
  const km = run.distance_km ? `${one(run.distance_km)} km` : null;
  const title = [f.plan?.title ?? run.name ?? "Your run", km].filter(Boolean).join(" · ");
  const parts: string[] = [];
  const facts: string[] = [`Run: ${title}${run.moving_min ? `, ${Math.round(run.moving_min)} min` : ""}${run.avg_hr ? `, average heart rate ${Math.round(run.avg_hr)}` : ""}.`];

  if (f.plan) {
    facts.push(`Planned session: ${f.plan.title} (${f.plan.kind})${f.plan.summary ? `. How it went: ${f.plan.summary}` : ""}`);
    const w = f.plan.work;
    if (w && w.total > 1) parts.push(w.onTarget >= w.total ? "every rep on pace" : `${w.onTarget} of ${w.total} reps on pace`);
    else if (w && w.total === 1 && w.onTarget === 1) parts.push("on pace all the way");
    else if (typeof f.plan.inRange === "number") {
      const pct = Math.round(f.plan.inRange * 100);
      parts.push(pct >= 75 ? "heart rate in range" : `${pct}% in the heart-rate range`);
    }
  }
  const best = f.records.find((r) => r.rank === 1);
  if (best) {
    parts.push(`a new best ${NAME[best.name] ?? best.name} in ${clock(best.time_s)}`);
    facts.push(`Records: ${f.records.map((r) => `${r.rank === 1 ? "best ever" : r.rank === 2 ? "second best" : "third best"} ${NAME[r.name] ?? r.name} ${clock(r.time_s)}`).join(", ")}.`);
  }
  if (f.last) {
    const w = lastWords(f.last);
    if (w) parts.push(w);
    facts.push(`Against the last run like it (${f.last.date}): ${f.last.text}`);
  }
  if (!parts.length && !f.plan) {
    const pace = run.distance_km && run.moving_min ? clock((run.moving_min * 60) / run.distance_km) : null;
    if (pace) parts.push(`${pace} /km${run.avg_hr ? ` at ${Math.round(run.avg_hr)} bpm` : ""}`);
  }
  const first = parts.length ? `${parts.join(", ")}.` : "Done, as planned.";
  const then = nextWords(next);
  if (then) facts.push(`Next: ${then}`);
  if (f.next) facts.push(`Next ${f.next.kind} (${f.next.date}): ${f.next.why}`);
  return { title, text: [first.charAt(0).toUpperCase() + first.slice(1), then].filter(Boolean).join(" "), facts };
}
