/**
 * A strength session done on the watch as a guided workout (src/workout/from-plan.ts): each set
 * is a work step the lap button ends, then a rest step that counts down. The recording's laps
 * follow those steps, so the sets can be read back: a lap as long as the planned rest (within a
 * few seconds) is a rest, any other lap of at least 8 s is a set done, walked through the routine
 * in order. The watch doesn't count reps, so a set done there is the planned reps and weight.
 *
 * Not yet seen on a real recording: whether the Run 2 records a lap at every step change or only
 * at the lap button. Both read the same way here (rests are told apart by their length), and the
 * app offers the result to tick, not as a fact.
 */
export interface PlannedSets {
  id: string;
  sets: number;
  /** The rest after each set, as the guide counts it down. */
  rest_s: number;
}

export interface LapLike {
  elapsed_s: number;
}

/** How many sets of each exercise the laps account for, in the routine's order. */
export function setsFromLaps(plan: PlannedSets[], laps: LapLike[]): Array<{ id: string; done: number; of: number }> {
  const done = plan.map((p) => ({ id: p.id, done: 0, of: p.sets }));
  let ex = 0;
  for (const lap of laps) {
    while (ex < plan.length && done[ex]!.done >= plan[ex]!.sets) ex++;
    if (ex >= plan.length) break;
    const s = lap.elapsed_s;
    // A countdown rest ends on time; a set is ended by hand. Too short to be anything: a stray lap press.
    if (Math.abs(s - plan[ex]!.rest_s) <= 4 || s < 8) continue;
    done[ex]!.done++;
  }
  return done;
}

/** Laps as Strava (elapsed_time) or a FIT file (total_elapsed_time, ms or s) give them. */
export function lapSeconds(laps: Array<Record<string, unknown>> | undefined): LapLike[] {
  return (laps ?? []).flatMap((l) => {
    const v = Number(l.elapsed_time ?? l.total_elapsed_time ?? l.total_timer_time ?? NaN);
    return Number.isFinite(v) && v > 0 ? [{ elapsed_s: v > 20_000 ? v / 1000 : v }] : [];
  });
}
