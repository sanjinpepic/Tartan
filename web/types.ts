/** Shapes returned by the Tartan server (see src/analytics.ts and src/library.ts). */
export interface Activity {
  id: string;
  start: string;
  start_local?: string;
  sport: string;
  name?: string;
  distance_km?: number;
  moving_min?: number;
  elapsed_min?: number;
  elevation_m?: number;
  avg_hr?: number;
  max_hr?: number;
  avg_pace_min_km?: string;
  avg_speed_kmh?: number;
  calories?: number;
  device?: string;
  sources: Array<"strava" | "watch" | "health" | "intervals" | "suunto-cloud" | "phone" | "logged">;
  streams_from?: string;
  /** "How did it feel?", answered on the watch: 1 poor … 5 excellent. */
  feeling?: 1 | 2 | 3 | 4 | 5;
  /** The weather it was done in (outdoors), once known (src/workout-weather.ts). */
  weather?: import("../src/workout-weather.ts").WorkoutWeather;
}

export interface Takeaway {
  id: string;
  tone: "good" | "watch" | "info";
  title: string;
  detail: string;
  activity?: string;
  horizon?: "now" | "trend";
}

export interface ZoneTime {
  zone: number;
  name: string;
  seconds: number;
  bpm?: [number, number];
}

export interface Goals {
  weekly_km?: number;
  weekly_workouts?: number;
  long_run_km?: number;
  race?: { name?: string; distance_km: number; date?: string; target_s?: number };
  availability?: Availability;
}

export interface Availability {
  days_per_week?: number;
  hours_per_week?: number;
  long_run_day?: string;
  notes?: string;
}

export type SessionKind = "easy" | "long" | "tempo" | "intervals" | "hills" | "recovery" | "race" | "strength" | "cross" | "swim" | "ride" | "rest";
type Brief = Pick<Activity, "id" | "name" | "sport" | "distance_km" | "moving_min">;
export interface PlanSession {
  date: string;
  kind: SessionKind;
  title: string;
  duration_min?: number;
  distance_km?: number;
  target?: string;
  notes?: string;
  /** The session as the watch guides it (structured runs). */
  steps?: Array<{ repeat?: number; steps: Array<{ kind: "warmup" | "run" | "recover" | "cooldown"; duration_s?: number; distance_m?: number; hr?: number[]; pace?: number[]; speed?: number[]; power?: number[] }> }>;
  /** Strength sessions: the exercises, from src/strength/exercises.ts. */
  exercises?: Array<{ id: string; sets: number; reps?: number; seconds?: number; each_side?: boolean }>;
  status: "done" | "missed" | "today" | "planned" | "rest";
  /** Marked done by hand (no workout recorded it). */
  manual?: boolean;
  activity?: Brief;
  /** Paces moved by a finished run's next-time rule (you applied it). */
  adjusted?: { shift_s: number; reason: string };
}
export interface PlanWeek {
  start: string;
  focus: string;
  target_km?: number;
  target_hours?: number;
  days: Array<{ date: string; sessions: PlanSession[]; extra: Brief[] }>;
  planned: { sessions: number; km: number; minutes: number };
  done: { sessions: number; km: number; minutes: number };
  when: "past" | "current" | "future";
}
/** GET /api/plan: the coach's plan, checked against your workouts. */
export interface PlanView {
  plan: {
    title: string;
    summary: string;
    advice?: string[];
    target_date?: string;
    zones?: Array<{ name: string; pace?: string; heart_rate?: string; use?: string }>;
    created: string;
    updated: string;
    conversation?: string;
    model?: string;
  } | null;
  weeks: PlanWeek[];
  today: string;
  availability: Availability;
  goals: Goals;
  coach_ready: boolean;
  /** The last four weeks, for the coach's intro. */
  recent: { days: number; workouts: number; runs: number; run_km_per_week: number; hours_per_week: number; longest_run_km: number };
  /** Strength sessions logged in the app, by date (finished or under way, with how many records). */
  lifts?: Record<string, { finished: boolean; prs: number }>;
  /** Which pair to wear for each run session ahead, keyed date:kind (only with two or more pairs in use). */
  shoe_picks?: Record<string, { id: string; name: string; why: string }>;
  /** Next time's weight, reps or seconds per exercise, for the watch. */
  lift_targets?: Record<string, { kg?: number; reps?: number; seconds?: number }>;
  /** The coach's suggested change to the plan, waiting for you (src/plan.ts planChanges). */
  proposal?: { at: string; base: string; changes: PlanChange[]; note?: string; source: "chat" | "update" | "weekly" | "agent" | "life"; model?: string; conversation?: string } | null;
  /** The last change you accepted, for a week: Undo brings the plan before it back. */
  last_change?: { at: string; changes: PlanChange[]; source: string; auto?: boolean } | null;
  /** One-tap life changes (src/life.ts): said you're ill, since when. */
  life?: { ill: { from: string } | null };
  /** How much of the coach's change goes in without you (Settings → Coach). */
  approval?: "ask" | "small" | "auto";
}
export interface PlanChange {
  type: "added" | "removed" | "moved" | "changed" | "zones" | "length";
  date?: string;
  to?: string;
  kind?: string;
  title?: string;
  detail: string;
  why?: string;
  small?: boolean;
}

/** GET /api/week: one week, Monday to Sunday. */
export interface WeekView {
  start: string;
  end: string;
  current: boolean;
  prev: string | null;
  next: string | null;
  totals: WeekTotals;
  previous: WeekTotals;
  usual: { km: number; minutes: number; workouts: number; load: number };
  days: Array<WeekTotals & { date: string; future: boolean; activities: Activity[] }>;
  zones: ZoneTime[];
  sports: Array<{ sport: string; km: number; minutes: number; workouts: number }>;
}
export interface WeekTotals {
  km: number;
  minutes: number;
  workouts: number;
  climb: number;
  load: number;
}

/** GET /api/goals: your targets and where you stand. */
export interface Targets {
  goals: Goals;
  week: { km: number; target_km?: number; workouts: number; target_workouts?: number; days_left: number; km_per_day_needed: number; hit: number; of_weeks: number } | null;
  long_run: { target_km: number; longest_km: number; activity?: string; date?: string } | null;
  race:
    | (NonNullable<Goals["race"]> & {
        days_to_go?: number;
        target_pace?: string;
        predicted_s?: number;
        predicted_pace?: string;
        from?: { name: string; time_s: number; date: string; activity: string };
        on_track?: boolean;
        /** The plan's race, when the targets have none ahead. */
        from_plan?: boolean;
        /** From twelve weeks out (src/race-countdown.ts). */
        countdown?: import("../src/race-countdown.ts").Countdown;
      })
    | null;
}

/** GET /api/today: how you are right now. */
export interface TodayView {
  readiness: { state: "new" | "tired" | "building" | "steady" | "fresh" | "rested"; title: string; advice: string; why: string; fitness: number; fatigue: number; form: number; history_days: number };
  last: { activity: Activity; effort: number; estimated: boolean; label: string; rank: string; zones: ZoneTime[] | null } | null;
  week: { days: Array<{ date: string; km: number; minutes: number; workouts: number; future: boolean }>; km: number; minutes: number; climb: number; workouts: number; usual_km: number; usual_workouts: number };
  takeaways: Takeaway[];
  targets: Targets;
  /** Tartan's T in Today's header (src/today-mark.ts): its state and a line for screen readers. */
  mark?: { state: "rest" | "session" | "best" | "tired" | "race"; label: string };
}

export interface LoadPoint {
  date: string;
  load: number;
  fitness: number;
  fatigue: number;
  form: number;
}

export interface Totals {
  activities: number;
  distance_km?: number;
  hours?: number;
  elevation_m: number;
}

export interface Dashboard {
  days: number;
  totals: { week: Totals; month: Totals; year: Totals };
  load: { series: LoadPoint[]; today: LoadPoint; estimated_share: number; since: string | null; history_days: number };
  weeks: Array<{ week: string; activities: number; distance_km?: number; moving_hours?: number; elevation_m: number; avg_hr?: number }>;
  efficiency: Array<{ week: string; m_per_beat: number; easy_pace?: string; runs: number }>;
  zones: { zones: Array<{ zone: number; name: string; seconds: number }>; activities: number };
  takeaways: Takeaway[];
  recent: Activity[];
  profile: { max_hr: number; rest_hr: number; max_hr_source: string; sex?: string };
  bests: Array<{ name: string; time_s: number; pace_min_km?: string; date: string; activity: string }>;
  targets: Targets;
}

/** One source's copy of a workout, with what that source measured. */
export interface ActivityCopy {
  source: string;
  id: string;
  start?: string;
  device?: string;
  elapsed_s?: number;
  moving_s?: number;
  distance_m?: number;
  avg_hr?: number;
  max_hr?: number;
  avg_speed?: number;
  elevation_m?: number;
  avg_cadence?: number;
  avg_power?: number;
  calories?: number;
  has_streams?: boolean;
}

export interface ActivityView {
  detail: Activity & {
    description?: string;
    laps?: Array<Record<string, unknown>>;
    laps_from?: string;
    splits_metric?: Array<{ split: number; distance: number; moving_time: number; average_speed?: number; average_heartrate?: number; elevation_difference?: number }>;
    best_efforts?: Array<{ name: string; time_s: number }>;
    copies: Array<ActivityCopy>;
    provenance: Record<string, string>;
  };
  streams: { from: string; streams: Record<string, Array<unknown>> } | null;
  zones: Array<{ zone: number; name: string; seconds: number; bpm: [number, number] }> | null;
  load: { load: number; estimated: boolean; label: string; rank: string } | null;
  profile: { max_hr: number; zones_source?: string };
  /**
   * Runs only: up to three place-specific pointers found by rules from the recording
   * (src/run-moments.ts): at most one good, two to work on, often none. Their from_i/to_i index
   * `streams.streams` above; from_m/to_m are metres from the start; `at` is [lat, lon] for the pin.
   */
  moments?: import("../src/run-moments.ts").Moment[];
}

/** GET/PUT /api/schedule: when you train, and every session ahead at that time. */
export interface ScheduleView {
  prefs: {
    weekday: string;
    weekend: string;
    days?: Partial<Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", string>>;
    remind: { on: boolean; before_min: number; after?: boolean };
    calendar: { on: boolean; calendar_id?: string; calendar_name?: string };
    notify?: { morning: boolean; morning_at: string; review: boolean; run: boolean };
  };
  today: string;
  morning?: { readiness: string | null; proposed: number; plan: boolean };
  slots: Array<{ key: string; date: string; kind: string; title: string; start: string; end: string; minutes: number; summary: string; notes?: string }>;
}
