/**
 * The plan's coming week as guided workouts on the watch: which sessions go, which are already
 * there (by what this phone sent, web/watch.ts), the drink and gel reminder settings, and the
 * send itself. The Coach tab marks sessions and sends; Settings → Watch holds the reminders.
 */
import { DEFAULT_FUEL, plannedWeek, type FuelPlan, type WantedWorkout } from "../../src/workout/from-plan.ts";
import type { PlanView } from "../types.ts";
import * as watch from "../watch.ts";

const FUEL = "freesuunto.workouts.fuel";

/** Drink and gel reminders on long sessions, each on or off (an older "off" means both off). */
export function readFuel(): FuelPlan {
  try {
    const { off, ...v } = (JSON.parse(localStorage.getItem(FUEL) ?? "null") ?? {}) as Partial<FuelPlan> & { off?: boolean };
    // The flag from the single switch of an earlier build is read once and dropped.
    const plan: FuelPlan = { ...DEFAULT_FUEL, ...v, ...(off ? { gel: false, drink: false } : {}) };
    if (off !== undefined) writeFuel(plan);
    return plan;
  } catch {
    return DEFAULT_FUEL;
  }
}
export function writeFuel(v: FuelPlan): void {
  try {
    localStorage.setItem(FUEL, JSON.stringify(v));
  } catch {
    // no storage: the defaults stay
  }
}

/** The next seven days' sessions that can go to the watch, and which of them already are there. */
export function comingWeek(v: PlanView): { wanted: WantedWorkout[]; onWatch: Set<string>; keyOf: Map<string, string> } {
  const sentKeys = new Set(Object.values(watch.readSent()).map((x) => x.key));
  const wanted: WantedWorkout[] = [];
  const onWatch = new Set<string>();
  const keyOf = new Map<string, string>();
  for (const p of plannedWeek(v, readFuel())) {
    wanted.push({ date: p.date, key: p.key, workout: p.workout });
    keyOf.set(`${p.date}:${p.kind}`, p.key);
    if (sentKeys.has(p.key)) onWatch.add(`${p.date}:${p.kind}`);
  }
  return { wanted, onWatch, keyOf };
}

/**
 * Whether the watch is behind the coming week, once you've sent workouts to it: a session on it
 * that now reads differently (next time's weights after a logged session, a session the coach
 * rewrote), one whose day has passed, or one of the coming seven days not there yet.
 */
export function weekOutOfDate(v: PlanView): boolean {
  const sent = Object.values(watch.readSent()).filter((x) => !x.pinned);
  if (!Object.keys(watch.readSent()).length) return false;
  const keys = new Set(sent.map((x) => x.key));
  const wanted = comingWeek(v).wanted;
  const want = new Set(wanted.map((w) => w.key));
  return wanted.some((w) => !keys.has(w.key)) || sent.some((x) => x.date < v.today || !want.has(x.key));
}

/** Put the coming week on the watch; what changed. */
export async function sendWeek(v: PlanView, onProgress?: (text: string) => void): Promise<{ added: number; removed: number }> {
  const { wanted } = comingWeek(v);
  const res = await watch.putWorkouts(wanted, v.today, onProgress);
  return { added: res.added, removed: res.removed };
}
