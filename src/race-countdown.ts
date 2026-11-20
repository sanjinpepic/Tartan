/**
 * Your race, counted down: from about twelve weeks out until race week takes over (seven days
 * to go, src/race-week.ts), the days to go, the finish time your recent runs predict and how it
 * has moved over the last four weeks, the target and whether the prediction is on track, and in
 * the last two weeks what the taper is for.
 *
 * The race is the one in your targets when it has a date still ahead, else the plan's next race
 * session. The prediction (Riegel, exponent 1.06) is from the fastest stretches of standard
 * distances in your runs of the last twelve weeks (src/run-finish.ts efforts, the watch's runs
 * too), the year when there are none that recent: each distance from an eighth of the race up
 * predicts a time, and the quickest of them counts.
 */

/** Effort names (Strava's and Tartan's own) and their distances, m. */
export const EFFORT_M: Record<string, number> = {
  "400m": 400, "1k": 1000, "1 mile": 1609.34, "2 mile": 3218.69, "5k": 5000, "10k": 10000, "15k": 15000, "10 mile": 16093.4, "20k": 20000, "Half-Marathon": 21097.5, "30k": 30000, Marathon: 42195,
};

/** From this far out the countdown shows; race week (src/race-week.ts) takes over at 7 days. */
export const COUNTDOWN_DAYS = 84;
export const RACE_WEEK_DAYS = 7;
/** The last two weeks: the taper. */
export const TAPER_DAYS = 14;

const DAY = 86400_000;

export interface Prediction {
  time_s: number;
  from: { name: string; time_s: number; date: string; activity: string };
}

/**
 * The predicted time for `km` as of `at`, from the runs' efforts in the `days` before it (and in
 * the year before it when there are none). Null when no run has a stretch long enough.
 */
export function predictRace(runs: Array<{ id: string; start: string; efforts: Array<{ name: string; time_s: number }> }>, km: number, at: number, days = COUNTDOWN_DAYS): Prediction | null {
  const meters = km * 1000;
  const within = (span: number) => {
    const best = new Map<string, Prediction["from"]>();
    for (const r of runs) {
      const t = Date.parse(r.start);
      if (!(t <= at && t > at - span * DAY)) continue;
      for (const e of r.efforts) {
        const d = EFFORT_M[e.name];
        // Short stretches say little about a long race; longer than the race says little more.
        if (!d || d < meters / 8 || d > meters * 1.5 || !(e.time_s > 0)) continue;
        const cur = best.get(e.name);
        if (!cur || e.time_s < cur.time_s) best.set(e.name, { name: e.name, time_s: e.time_s, date: r.start, activity: r.id });
      }
    }
    let out: Prediction | null = null;
    for (const b of best.values()) {
      const time_s = Math.round(b.time_s * Math.pow(meters / EFFORT_M[b.name]!, 1.06));
      if (!out || time_s < out.time_s) out = { time_s, from: b };
    }
    return out;
  };
  return within(days) ?? within(365);
}

export interface RaceIn {
  name?: string;
  distance_km: number;
  date?: string;
  target_s?: number;
}

/** The race ahead: the targets' when it has a date from today on, else the plan's next race session with a distance. */
export function raceAhead(goal: RaceIn | undefined, sessions: Array<{ date: string; kind: string; title: string; distance_km?: number }>, today: string): (RaceIn & { from_plan?: boolean }) | null {
  if (goal?.date && goal.date >= today) return goal;
  const next = sessions.filter((s) => s.kind === "race" && s.date >= today && s.distance_km).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (next) return { name: next.title, distance_km: next.distance_km!, date: next.date, ...(goal?.target_s && goal.distance_km === next.distance_km ? { target_s: goal.target_s } : {}), from_plan: true };
  return goal ?? null;
}

const clock = (s: number) => {
  const t = Math.round(Math.abs(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

export interface Countdown {
  days_to_go: number;
  /** The prediction four weeks ago, and how it moved since (minus: quicker now). */
  predicted_then_s?: number;
  change_s?: number;
  /** Predicted against the target (minus: quicker than the target). */
  gap_s?: number;
  /** The last two weeks before race week: what the taper is for. */
  taper?: string;
  /** All of it in a few sentences (the coach, the PC). */
  text: string;
}

export const TAPER = "The taper: volume comes down, a little sharpness stays. The work is done: trust it.";

/** The countdown for a race `days_to_go` away (race week included, for the coach); null further than twelve weeks or past. */
export function countdown(r: RaceIn & { days_to_go?: number; predicted_s?: number }, predictedThen: number | null): Countdown | null {
  const d = r.days_to_go;
  if (d === undefined || d < 0 || d > COUNTDOWN_DAYS) return null;
  const name = r.name ?? `Your ${Math.round(r.distance_km * 10) / 10} km race`;
  const when = d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
  const change = r.predicted_s && predictedThen ? r.predicted_s - predictedThen : undefined;
  const gap = r.predicted_s && r.target_s ? r.predicted_s - r.target_s : undefined;
  const moved = change === undefined ? "" : Math.abs(change) < 5 ? ", the same as a month ago" : `, ${clock(change)} ${change < 0 ? "quicker" : "slower"} than a month ago`;
  const parts = [
    `${name} ${when}.`,
    r.predicted_s ? `Predicted ${clock(r.predicted_s)}${moved}.` : "No prediction yet: it needs a run of at least an eighth of the distance.",
    r.target_s ? (gap === undefined ? `Target ${clock(r.target_s)}.` : gap <= 0 ? `Target ${clock(r.target_s)}: on track.` : `Target ${clock(r.target_s)}: ${clock(gap)} to find.`) : "",
  ];
  const taper = d > RACE_WEEK_DAYS && d <= TAPER_DAYS ? TAPER : undefined;
  return {
    days_to_go: d,
    ...(predictedThen ? { predicted_then_s: predictedThen } : {}),
    ...(change !== undefined ? { change_s: change } : {}),
    ...(gap !== undefined ? { gap_s: gap } : {}),
    ...(taper ? { taper } : {}),
    text: [...parts, taper ?? ""].filter(Boolean).join(" "),
  };
}
