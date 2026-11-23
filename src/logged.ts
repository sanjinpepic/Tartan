/**
 * Workouts logged by word ("I swam 25x25m today"): the coach saves what the athlete says, with
 * no recording behind it, in logged/workouts.json. They join the other sources as workouts of
 * their own, so they show in Activities, fill a planned session and count in the load. A
 * logged workout steps aside once a recording of the same sport turns up for that day.
 */
import { readJson, type Disk } from "./disk.ts";

export interface LoggedWorkout {
  id: string;
  /** Local day, YYYY-MM-DD. */
  date: string;
  /** Local start time, HH:MM, when it was said; else midday. */
  time?: string;
  /** Strava-style sport type: Run, Swim, Ride, Walk, WeightTraining, Workout… */
  sport: string;
  name: string;
  minutes?: number;
  distance_m?: number;
  /** How hard it felt, 1 (very easy) to 10 (all out). */
  effort?: number;
  note?: string;
  /** ISO, when it was logged. */
  logged: string;
}

const FILE = "logged/workouts.json";

/** The sport types a logged workout takes, by what people say. */
export const LOGGED_SPORTS = ["Run", "Swim", "Ride", "Walk", "Hike", "WeightTraining", "Yoga", "Rowing", "NordicSki", "Workout"] as const;

/** The local start, epoch ms. */
export const loggedStart = (w: Pick<LoggedWorkout, "date" | "time">): number => new Date(`${w.date}T${w.time ?? "12:00"}:00`).getTime();

export class LoggedWorkouts {
  constructor(private readonly disk: Disk) {}

  async all(): Promise<LoggedWorkout[]> {
    return (await readJson<LoggedWorkout[]>(this.disk, FILE)) ?? [];
  }

  async add(w: Omit<LoggedWorkout, "id" | "logged">): Promise<LoggedWorkout> {
    const all = await this.all();
    const saved: LoggedWorkout = { ...w, id: crypto.randomUUID().slice(0, 8), logged: new Date().toISOString() };
    await this.write([...all, saved]);
    return saved;
  }

  /** Takes one back; false when there was no such workout. */
  async remove(id: string): Promise<boolean> {
    const all = await this.all();
    const left = all.filter((w) => w.id !== id);
    if (left.length === all.length) return false;
    await this.write(left);
    return true;
  }

  private write(all: LoggedWorkout[]): Promise<void> {
    return this.disk.write(FILE, JSON.stringify(all.sort((a, b) => loggedStart(a) - loggedStart(b))));
  }
}
