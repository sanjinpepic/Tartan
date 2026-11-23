/**
 * A plan without AI: the same rules the coach is given (PLANNING_RULES in plan.ts), applied by
 * hand, for anyone without an AI key. At most 10% more a week, every fourth week about a quarter
 * easier, one long run, at most two hard sessions a week and never on consecutive days, most of
 * the time easy, and a two-week taper that ends with the race. Paces come from what your recent
 * runs say you could race over 5 km; heart-rate ranges from your own zones.
 *
 * It is a fair plan, not a coach: it doesn't read how sessions went or change itself. With an AI
 * key the coach can take it over and adjust it.
 */
import { easyCeiling, type Analytics, type Availability, type Goals } from "./analytics.ts";
import { mondayOf, type PlanInput, type Plans, type TrainingPlan } from "./plan.ts";
import { fmtTime } from "./analytics.ts";

type Session = PlanInput["weeks"][number]["sessions"][number];

export interface BasicInput {
  /** Local date, YYYY-MM-DD. */
  today: string;
  availability: Availability;
  race?: Goals["race"];
  /** The last four weeks. */
  recent: { runs: number; run_km_per_week: number; longest_run_km: number };
  /** Heart-rate zone limits (lower bounds of zones 2-5) and max. */
  hr: { max_hr: number; zone_limits?: [number, number, number, number] };
  /** What recent runs say you could race 5 km in, seconds; none: heart rate only. */
  five_k_s?: number;
  /** Build to this date (YYYY-MM-DD) without a race; none: 8 weeks. */
  until?: string;
}

const DAY = 86_400_000;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const pace = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/**
 * Training days by count, Monday = 0, for a Sunday long run (turned to fit another long-run
 * day): q are the hard days, two days apart and never next to each other.
 */
const PATTERNS: Record<number, { days: number[]; q: number[] }> = {
  2: { days: [2, 6], q: [] },
  3: { days: [1, 3, 6], q: [1] },
  4: { days: [1, 3, 5, 6], q: [1, 3] },
  5: { days: [0, 1, 3, 4, 6], q: [1, 3] },
  6: { days: [0, 1, 2, 3, 4, 6], q: [1, 3] },
  7: { days: [0, 1, 2, 3, 4, 5, 6], q: [1, 3] },
};

export function basicPlan(i: BasicInput): PlanInput {
  const longDay = Math.max(0, DOW.indexOf((i.availability.long_run_day ?? "Sun") as (typeof DOW)[number]));
  const shift = longDay - 6;
  const n = Math.max(2, Math.min(7, i.availability.days_per_week ?? Math.min(5, Math.max(3, Math.round(i.recent.runs / 4)))));
  const pattern = PATTERNS[n]!;
  const turn = (d: number) => (d + shift + 7) % 7;

  // Paces (seconds per km): from a recent 5 km, else heart rate alone.
  const k5 = i.five_k_s ? i.five_k_s / 5 : null;
  const easyPace = k5 ? ([Math.round(k5 * 1.22), Math.round(k5 * 1.35)] as const) : null;
  const tempoPace = k5 ? ([Math.round(k5 * 1.05), Math.round(k5 * 1.09)] as const) : null;
  const repPace = k5 ? ([Math.round(k5 * 0.98), Math.round(k5 * 1.02)] as const) : null;
  const top2 = easyCeiling(i.hr);
  const limits = i.hr.zone_limits ?? ([0.6, 0.7, 0.8, 0.9].map((f) => Math.round(f * i.hr.max_hr)) as [number, number, number, number]);
  const easyHr: [number, number] = [Math.min(limits[0], top2 - 10), top2];
  const tempoHr: [number, number] = [limits[2], limits[3] - 1];
  const easyTarget = `easy, ${easyHr[0]}–${easyHr[1]} bpm${easyPace ? ` (about ${pace(easyPace[0])}–${pace(easyPace[1])} /km)` : ""}`;

  // Weeks: this one to the race's (or the date's, or 8), at most 26.
  const first = mondayOf(i.today);
  const endDate = i.race?.date && i.race.date >= i.today ? i.race.date : i.until && i.until > i.today ? i.until : null;
  const weeks = endDate ? Math.max(1, Math.min(26, Math.round((Date.parse(mondayOf(endDate)) - Date.parse(first)) / (7 * DAY)) + 1)) : 8;

  // Volume in minutes: from the last four weeks at easy pace, within the hours there are.
  const perKm = easyPace ? (easyPace[0] + easyPace[1]) / 2 / 60 : 6.5;
  const cap = i.availability.hours_per_week ? i.availability.hours_per_week * 60 : Infinity;
  let base = Math.min(cap, Math.max(n * 30, Math.round(i.recent.run_km_per_week * perKm)));
  const longCap = Math.max(45, Math.round(Math.max(i.recent.longest_run_km * perKm * 1.1, 60)));

  const raceWeek = i.race?.date && endDate === i.race.date ? weeks - 1 : -1;
  const out: PlanInput["weeks"] = [];
  let built = base;
  // It builds toward half as much again as now, at most: past that a template is guessing, and
  // without hours given (cap is Infinity) 8% a week compounds to triple over a long plan.
  const peak = Math.min(cap, Math.round(base * 1.5));
  for (let w = 0; w < weeks; w++) {
    const start = addDays(first, 7 * w);
    const taper = raceWeek >= 0 ? raceWeek - w : 99; // 1: the week before the race, 0: race week
    const easier = taper > 1 && w > 0 && (w + 1) % 4 === 0;
    let minutes: number;
    let focus: string;
    if (taper === 0) [minutes, focus] = [Math.round(built * 0.5), "Race week"];
    else if (taper === 1) [minutes, focus] = [Math.round(built * 0.7), "Taper"];
    else if (easier) [minutes, focus] = [Math.round(built * 0.75), "Easier week"];
    else {
      if (w > 0) built = Math.min(peak, Math.round(built * 1.08));
      [minutes, focus] = [built, w === 0 ? "Getting going" : "Build"];
    }
    // One hard session in the first week, easier weeks, the taper and race week; else the pattern's.
    const hard = w === 0 || easier || taper <= 1 ? pattern.q.slice(0, 1) : pattern.q;
    const longMin = taper === 0 ? 0 : Math.min(150, longCap + (taper > 1 && !easier ? w * 5 : 0), Math.round(minutes * 0.35));
    const qMin = 45;
    const easyDays = pattern.days.filter((d) => d !== 6 && !hard.includes(d));
    // An easy run is 25 to 90 minutes: more time than that goes unplanned, not into one run.
    const easyMin = Math.min(90, Math.max(25, Math.round((minutes - longMin - hard.length * qMin) / Math.max(1, easyDays.length))));

    const sessions: Session[] = [];
    for (const d of pattern.days) {
      const date = addDays(start, turn(d));
      if (date < i.today) continue;
      if (taper === 0 && i.race?.date) {
        if (date > i.race.date) continue;
        if (date === i.race.date) {
          sessions.push({ date, kind: "race", title: i.race.name ?? `${i.race.distance_km} km race`, distance_km: i.race.distance_km, ...(i.race.target_s ? { target: `${fmtTime(i.race.target_s)}, even effort` } : {}), notes: "Easy first kilometre, settle in, then race." });
          continue;
        }
        if (date === addDays(i.race.date, -1)) continue; // rest the day before
      }
      if (d === 6 && taper !== 0) sessions.push({ date, kind: "long", title: "Long run", duration_min: longMin, target: easyTarget, notes: "Steady and easy the whole way; it's the time on your feet that counts." });
      else if (hard.includes(d)) sessions.push(quality(date, w, hard.indexOf(d), taper, { repPace, tempoPace, tempoHr }));
      else sessions.push({ date, kind: "easy", title: "Easy run", duration_min: taper === 0 ? Math.min(30, easyMin) : easyMin, target: easyTarget });
    }
    if (taper === 0 && i.race?.date && !sessions.some((s) => s.kind === "race")) sessions.push({ date: i.race.date, kind: "race", title: i.race.name ?? `${i.race.distance_km} km race`, distance_km: i.race.distance_km });
    out.push({ start, focus, target_hours: Math.round((minutes / 60) * 10) / 10, sessions: sessions.sort((a, b) => a.date.localeCompare(b.date)) });
  }

  const zones = [
    { name: "Easy", heart_rate: `${easyHr[0]}-${easyHr[1]} bpm`, ...(easyPace ? { pace: `${pace(easyPace[0])}-${pace(easyPace[1])} /km` } : {}), use: "easy and long runs" },
    { name: "Tempo", heart_rate: `${tempoHr[0]}-${tempoHr[1]} bpm`, ...(tempoPace ? { pace: `${pace(tempoPace[0])}-${pace(tempoPace[1])} /km` } : {}), use: "tempo runs" },
    ...(repPace ? [{ name: "Intervals", pace: `${pace(repPace[0])}-${pace(repPace[1])} /km`, use: "3-minute repeats, about 5 km race pace" }] : []),
  ];
  const what = i.recent.runs ? `about ${Math.round(i.recent.run_km_per_week)} km a week over ${i.recent.runs} runs in the last four weeks` : "no runs in the last four weeks, so it starts gently";
  return {
    title: i.race?.date && endDate === i.race.date ? `Build to ${i.race.name ?? `the ${i.race.distance_km} km`}` : `${weeks} weeks of steady building`,
    summary: `Made by Tartan's own rules, without AI, from ${what}. ${n} days a week with the long run on ${DOW[longDay]}; about 10% more each week, every fourth week easier${raceWeek >= 0 ? ", and two weeks of taper before the race" : ""}. ${k5 ? `Paces come from what your recent runs say you could race 5 km in (${fmtTime(i.five_k_s!)}).` : "Without a recent 5 km to go by, sessions are paced by heart rate."}`,
    weeks: out,
    advice: ["Easy means easy: if you can't talk in full sentences, slow down.", "Feeling run down or sore? Swap a hard session for an easy one, or rest.", "Ask your coach to move, shorten or swap a session as you go: it changes the plan for you."],
    zones,
    ...(endDate ? { target_date: endDate } : {}),
  };
}

/** The week's `nth` hard session: intervals and tempo take turns (in the week and week to week); the taper keeps a little speed. */
function quality(date: string, w: number, nth: number, taper: number, p: { repPace: readonly [number, number] | null; tempoPace: readonly [number, number] | null; tempoHr: [number, number] }): Session {
  const warm = { kind: "warmup" as const, duration_s: 12 * 60 };
  const cool = { kind: "cooldown" as const, duration_s: 10 * 60 };
  if (taper <= 1 || (w + nth) % 2 === 0) {
    const reps = taper <= 1 ? 4 : Math.min(8, 4 + Math.floor(w / 2));
    const target = p.repPace ? { pace: [p.repPace[0], p.repPace[1]] } : { hr: [p.tempoHr[1] - 5, p.tempoHr[1] + 8] };
    return {
      date,
      kind: "intervals",
      title: `${reps} × 3 min`,
      duration_min: 22 + reps * 5,
      target: p.repPace ? `${pace(p.repPace[0])}-${pace(p.repPace[1])} /km` : "hard but controlled",
      notes: "Warm up 12 minutes, then each 3 minutes at about 5 km race effort with 2 minutes' easy jog between, then cool down.",
      steps: [{ steps: [warm] }, { repeat: reps, steps: [{ kind: "run", duration_s: 180, ...target }, { kind: "recover", duration_s: 120 }] }, { steps: [cool] }],
    };
  }
  const min = Math.min(30, 15 + w * 2);
  const target = p.tempoPace ? { pace: [p.tempoPace[0], p.tempoPace[1]] } : { hr: p.tempoHr };
  return {
    date,
    kind: "tempo",
    title: `${min} min tempo`,
    duration_min: 22 + min,
    target: p.tempoPace ? `${pace(p.tempoPace[0])}-${pace(p.tempoPace[1])} /km, ${p.tempoHr[0]}-${p.tempoHr[1]} bpm` : `comfortably hard, ${p.tempoHr[0]}-${p.tempoHr[1]} bpm`,
    notes: "Warm up 12 minutes, then comfortably hard: you could say a few words, not chat. Cool down.",
    steps: [{ steps: [warm] }, { steps: [{ kind: "run", duration_s: min * 60, ...target }] }, { steps: [cool] }],
  };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A target date typed in the plan's intro, read without AI: "2027-03-14", "14 March", "March 14,
 * 2027", "end of June" or "June" (its last day). The next such day from today; null when unread.
 */
export function readTargetDay(text: string, today: string): string | null {
  const t = text.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const month = (w: string) => MONTHS.findIndex((m) => w.startsWith(m));
  let d: number | null = null;
  let m = -1;
  let y: number | null = null;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)(?: (\d{4}))?$/.exec(t))) [d, m, y] = [Number(r[1]), month(r[2]!), r[3] ? Number(r[3]) : null];
  else if ((r = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(t))) [d, m, y] = [Number(r[2]), month(r[1]!), r[3] ? Number(r[3]) : null];
  else if ((r = /^(?:(?:the )?end of )?([a-z]+)(?: (\d{4}))?$/.exec(t))) [m, y] = [month(r[1]!), r[2] ? Number(r[2]) : null];
  if (m < 0) return null;
  const iso = (year: number) => {
    const day = d ?? new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
    const date = new Date(Date.UTC(year, m, day));
    return date.getUTCMonth() === m ? date.toISOString().slice(0, 10) : null;
  };
  const year = Number(today.slice(0, 4));
  if (y) return iso(y);
  const first = iso(year);
  return first && first > today ? first : iso(year + 1);
}

/** Gather what the plan needs, make it and save it (only where there is no plan yet). */
/** A plan by Tartan's rules from the athlete's targets, time and recent weeks (not saved). */
export async function basicPlanFor(analytics: Analytics, opts: { today: string; until?: string }): Promise<PlanInput> {
  const [goals, recent, prof, shape] = await Promise.all([analytics.goals(), analytics.recent(), analytics.profile(), analytics.raceShape(12).catch(() => null)]);
  const k5 = shape?.distances.find((d) => d.name === "5k")?.weeks.filter((w) => w.s).at(-1)?.s ?? undefined;
  return basicPlan({ today: opts.today, availability: goals.availability ?? {}, race: goals.race, recent, hr: prof, five_k_s: k5, until: opts.until });
}

export async function makeBasicPlan(analytics: Analytics, plans: Plans, opts: { today: string; until?: string }): Promise<TrainingPlan> {
  if (await plans.current()) throw new Error("There is a plan already: change it in the chat, or reset it in Settings → Training first.");
  return plans.save(await basicPlanFor(analytics, opts), { model: "Tartan's rules (no AI)" });
}
