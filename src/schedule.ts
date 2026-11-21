/**
 * When you train: your usual times (weekdays after work, weekend mornings, or any day of your
 * own), turned into a start and end for every planned session. The phone uses the slots for
 * reminders and for events in your calendar; anyone can download them as an .ics file.
 * Times are local wall-clock times; nothing here needs a time zone.
 */
import { readJson, type Disk } from "./disk.ts";
import type { PlanSession, PlanWeekView } from "./plan.ts";

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

/**
 * What you'd rather do than run in bad weather (heavy rain, strong wind, ice or snow, dangerous
 * heat or cold): swim, ride, the treadmill, or run anyway (nothing is offered).
 */
export const BAD_WEATHER = ["run", "swim", "ride", "treadmill"] as const;
export type BadWeather = (typeof BAD_WEATHER)[number];
/**
 * What puts you off running (Settings, Training, or told to the coach): ice, snow or slippery
 * ground; heavy rain; strong wind; cold (below `cold_below` °C); heat; the dark. Read from the
 * forecast at the session's time (src/habits.ts conditionsAt).
 */
export const AVOID = ["ice", "rain", "wind", "cold", "heat", "dark"] as const;
export type Avoid = (typeof AVOID)[number];

export interface SchedulePrefs {
  /** "HH:MM" on Monday to Friday. */
  weekday: string;
  /** "HH:MM" on Saturday and Sunday. */
  weekend: string;
  /** A time for a particular day, over the two above (e.g. a Wednesday lunch run). */
  days?: Partial<Record<DayKey, string>>;
  /**
   * A notification this many minutes before each session; `after`: one about half an hour after
   * a session should have ended ("done? tap to bring it in"), gone once the workout is in.
   */
  remind: { on: boolean; before_min: number; after?: boolean };
  /** Sessions as events in a calendar on the phone. */
  calendar: { on: boolean; calendar_id?: string; calendar_name?: string };
  /**
   * `morning`: at `morning_at` each day, how you are and what's planned (and changes waiting for
   * you); `review`: Sunday evening, a nudge to open Tartan for the week's review; `run`: a short
   * note from the coach when a new run comes in (src/after-run.ts).
   */
  notify: { morning: boolean; morning_at: string; review: boolean; run: boolean };
  /** On a bad-weather day: what Today offers instead of the run (src/day-swap.ts). */
  bad_weather: BadWeather;
  /** What puts you off; none by default. */
  avoid: Avoid[];
  /** "Cold" is below this, °C. */
  cold_below: number;
}

export const DEFAULT_PREFS: SchedulePrefs = { weekday: "18:00", weekend: "09:00", remind: { on: false, before_min: 30, after: true }, calendar: { on: false }, notify: { morning: true, morning_at: "07:30", review: true, run: true }, bad_weather: "run", avoid: [], cold_below: 0 };
const FILE = "settings/schedule.json";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The conditions in a list, each once, in order; undefined when it isn't a list. */
const avoidList = (v: unknown): Avoid[] | undefined => (Array.isArray(v) ? AVOID.filter((a) => v.includes(a)) : undefined);
const coldBelow = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= -30 && v <= 15 ? Math.round(v) : undefined);

export async function readPrefs(disk: Disk): Promise<SchedulePrefs> {
  const p = await readJson<Partial<SchedulePrefs>>(disk, FILE);
  return { ...DEFAULT_PREFS, ...p, bad_weather: BAD_WEATHER.includes(p?.bad_weather as BadWeather) ? p!.bad_weather! : "run", avoid: avoidList(p?.avoid) ?? [], cold_below: coldBelow(p?.cold_below) ?? 0, remind: { ...DEFAULT_PREFS.remind, ...p?.remind }, calendar: { ...DEFAULT_PREFS.calendar, ...p?.calendar }, notify: { ...DEFAULT_PREFS.notify, ...p?.notify } };
}

export async function savePrefs(disk: Disk, next: Partial<SchedulePrefs>): Promise<SchedulePrefs> {
  const cur = await readPrefs(disk);
  const time = (v: unknown, fallback: string) => (typeof v === "string" && HHMM.test(v) ? v : fallback);
  const days: Partial<Record<DayKey, string>> = {};
  for (const d of DAY_KEYS) {
    const v = (next.days ?? cur.days ?? {})[d];
    if (typeof v === "string" && HHMM.test(v)) days[d] = v;
  }
  const before = Number(next.remind?.before_min ?? cur.remind.before_min);
  const p: SchedulePrefs = {
    weekday: time(next.weekday, cur.weekday),
    weekend: time(next.weekend, cur.weekend),
    days,
    remind: { on: next.remind?.on ?? cur.remind.on, before_min: Number.isFinite(before) && before >= 0 && before <= 24 * 60 ? Math.round(before) : 30, after: next.remind?.after ?? cur.remind.after ?? true },
    calendar: {
      on: next.calendar?.on ?? cur.calendar.on,
      calendar_id: next.calendar && "calendar_id" in next.calendar ? next.calendar.calendar_id || undefined : cur.calendar.calendar_id,
      calendar_name: next.calendar && "calendar_name" in next.calendar ? next.calendar.calendar_name || undefined : cur.calendar.calendar_name,
    },
    notify: {
      morning: next.notify?.morning ?? cur.notify.morning,
      morning_at: time(next.notify?.morning_at, cur.notify.morning_at),
      review: next.notify?.review ?? cur.notify.review,
      run: next.notify?.run ?? cur.notify.run,
    },
    bad_weather: BAD_WEATHER.includes(next.bad_weather as BadWeather) ? next.bad_weather! : cur.bad_weather,
    avoid: avoidList(next.avoid) ?? cur.avoid,
    cold_below: coldBelow(next.cold_below) ?? cur.cold_below,
  };
  await disk.write(FILE, JSON.stringify(p));
  return p;
}

/** The time you train on this date ("HH:MM"). */
export function timeFor(prefs: SchedulePrefs, date: string): string {
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  return prefs.days?.[DAY_KEYS[dow]!] ?? (dow >= 5 ? prefs.weekend : prefs.weekday);
}

export interface Slot {
  /** "date:kind", the same key the plan's marks use. */
  key: string;
  date: string;
  kind: string;
  title: string;
  /** Local wall-clock start and end, "YYYY-MM-DDTHH:MM". */
  start: string;
  end: string;
  minutes: number;
  /** One line: kind, length, target. */
  summary: string;
  notes?: string;
}

const KIND: Record<string, string> = {
  easy: "Easy", long: "Long run", tempo: "Tempo", intervals: "Intervals", hills: "Hills", recovery: "Recovery", race: "Race", strength: "Strength", cross: "Cross-training", swim: "Swim", ride: "Ride",
};

/** How long a session takes: its duration, else its distance at an easy 6 min/km, else 45 minutes. */
export function minutesOf(s: Pick<PlanSession, "duration_min" | "distance_km">): number {
  return Math.round(s.duration_min ?? (s.distance_km ? s.distance_km * 6 : 45));
}

const addMinutes = (local: string, min: number) => {
  const d = new Date(`${local}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + min);
  return d.toISOString().slice(0, 16);
};

/** Every session still ahead (today's included), with its time. Rest days and done sessions are left out. */
export function slots(weeks: PlanWeekView[], prefs: SchedulePrefs, today: string): Slot[] {
  const out: Slot[] = [];
  const seen = new Map<string, number>();
  for (const w of weeks)
    for (const d of w.days) {
      if (d.date < today) continue;
      for (const s of d.sessions) {
        if (s.kind === "rest" || s.status === "done") continue;
        const minutes = minutesOf(s);
        const start = `${d.date}T${timeFor(prefs, d.date)}`;
        // Two sessions of a kind on one day (a double) each keep their own key.
        const base = `${d.date}:${s.kind}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        out.push({
          key: n > 1 ? `${base}#${n}` : base,
          date: d.date,
          kind: s.kind,
          title: s.title,
          start,
          end: addMinutes(start, minutes),
          minutes,
          summary: [KIND[s.kind] ?? s.kind, s.duration_min ? `${s.duration_min} min` : null, s.distance_km ? `${s.distance_km} km` : null, s.target].filter(Boolean).join(" · "),
          notes: s.notes,
        });
      }
    }
  return out;
}

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** Lines over 75 octets fold onto continuation lines, as RFC 5545 asks (never inside a character). */
const fold = (line: string) => {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > 75) {
      out.push(cur);
      cur = " ";
      size = 1;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join("\r\n");
};
const stamp = (local: string) => local.replace(/[-:]/g, "") + "00";

/** The plan as an .ics calendar (floating local times; stable UIDs, so a re-import updates instead of duplicating). */
export function toIcs(list: Slot[], prefs: SchedulePrefs, now = new Date()): string {
  const dtstamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tartan//Training plan//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Tartan training"];
  for (const s of list) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.key}@tartan`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${stamp(s.start)}`,
      `DTEND:${stamp(s.end)}`,
      fold(`SUMMARY:${icsText(s.title)}`),
      fold(`DESCRIPTION:${icsText([s.summary, s.notes, "From your Tartan plan"].filter(Boolean).join("\n"))}`),
      "CATEGORIES:Training",
    );
    if (prefs.remind.on) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", fold(`DESCRIPTION:${icsText(s.title)}`), `TRIGGER:-PT${prefs.remind.before_min}M`, "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/** "YYYY-MM-DDTHH:MM" on this device's clock → epoch ms. */
const local = (s: string) => new Date(`${s}:00`).getTime();

/** A notification of the day's own, not a session's: the morning's, Sunday's review. */
export interface Daily {
  /** What it's for ("morning", "review") and a key per day for its notification id. */
  key: string;
  idKey: string;
  title: string;
  body: string;
  at: Date;
}

/**
 * The next three mornings (from tomorrow, or today while it's before the time): how you are (the
 * first one; later ones can't know yet), what's planned, and changes waiting on the Coach tab.
 * And next Sunday at 19:00, the week's review, when there's a plan.
 */
export function dailies(
  v: { prefs: { notify?: SchedulePrefs["notify"] }; slots: Array<{ date: string; title: string; summary: string }>; morning?: { readiness: string | null; proposed: number; plan: boolean } },
  now: number,
): Daily[] {
  const n = v.prefs.notify ?? { morning: true, morning_at: "07:30", review: true, run: true };
  const out: Daily[] = [];
  const day = (d: Date) => d.toLocaleDateString("sv");
  if (n.morning) {
    for (let i = 0, made = 0; i < 4 && made < 3; i++) {
      const d = new Date(now + i * 86_400_000);
      const when = local(`${day(d)}T${n.morning_at}`);
      if (when <= now) continue;
      const planned = v.slots.filter((s) => s.date === day(d));
      const first = made === 0;
      const ready = first && v.morning?.readiness ? `${v.morning.readiness}. ` : "";
      const what = planned.length ? planned.map((s) => `${s.title}: ${s.summary}`).join(" · ") : v.morning?.plan ? "A rest day." : "Nothing planned: a plan is a tap away on the Coach tab.";
      const waiting = first && v.morning?.proposed ? ` ${v.morning.proposed} change${v.morning.proposed > 1 ? "s" : ""} to your plan to look at.` : "";
      out.push({ idKey: `morning:${day(d)}`, key: "morning", title: planned.length ? `Today: ${planned.map((s) => s.title).join(", ")}` : "Good morning", body: `${ready}${what}${waiting}`, at: new Date(when) });
      made++;
    }
  }
  if (n.review && v.morning?.plan) {
    const d = new Date(now);
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
    let when = local(`${day(d)}T19:00`);
    if (when <= now) when += 7 * 86_400_000;
    out.push({ idKey: `review:${new Date(when).toLocaleDateString("sv")}`, key: "review", title: "Your week, looked back on", body: "Open Tartan: the coach goes over the week and sets up the next one.", at: new Date(when) });
  }
  return out;
}

