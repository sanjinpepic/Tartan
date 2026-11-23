/**
 * Your plan on the phone outside the app: a reminder before each session, a nudge after it ("done?
 * tap to bring it in", which opens the app and so syncs the watch), and the sessions as events in
 * a calendar you pick, all at your training times (Settings → Training). The app
 * redoes them whenever the plan, the times or what's done changes; when nothing changed it
 * does nothing. Phone only: on the PC the plan goes to a calendar as an .ics file.
 */
import { app, isNative, log } from "../state.ts";
import type { ScheduleView } from "../types.ts";
import { dailies, type Daily } from "../../src/schedule.ts";

type Slot = ScheduleView["slots"][number];

/** Quick picks for the weekday time, in words people use (Settings and the intro). */
export const PRESETS: Array<[string, string]> = [["Before work", "06:30"], ["Lunch", "12:00"], ["After work", "18:00"], ["Evening", "20:00"]];

/** Reminders are set this far ahead; the rest follow as the days pass. */
const REMIND_DAYS = 30;
const SIG = "freesuunto.schedule.sig";
const EVENTS = "freesuunto.calendar.events";

const read = <T>(k: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "null") as T | null;
  } catch {
    return null;
  }
};
const write = (k: string, v: unknown) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // no storage: everything is simply redone next time
  }
};

/** "YYYY-MM-DDTHH:MM" on this phone's clock → epoch ms. */
const at = (local: string) => new Date(`${local}:00`).getTime();
/** A stable notification id per session (Android wants a 32-bit int). */
const notifId = (key: string) => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 2_000_000_000) + 1;
};
const eventSig = (s: Slot) => [s.start, s.end, s.title, s.summary, s.notes ?? ""].join("|");

let running: Promise<void> | null = null;
let again = false;

/** Bring reminders and calendar events in line with the plan. Safe to call often. */
export function syncSchedule(force = false): Promise<void> {
  // The demo's sample plan stays out of your calendar and reminders.
  if (!isNative || localStorage.getItem("tartan.demo") === "1") return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      try {
        await syncOnce(force);
      } catch (e) {
        log(`Reminders and calendar: ${(e as Error).message}`);
      }
      force = false;
    } while (again);
  })().finally(() => (running = null));
  return running;
}

async function syncOnce(force: boolean): Promise<void> {
  const v = await app.api.json<ScheduleView>("/api/schedule");
  const now = Date.now();
  const horizon = now + REMIND_DAYS * 86_400_000;
  const soon = v.slots.filter((s) => at(s.start) - v.prefs.remind.before_min * 60_000 > now && at(s.start) < horizon);
  // Done sessions aren't slots: once the workout is in, its nudge goes.
  const ends = v.prefs.remind.after !== false ? v.slots.filter((s) => at(s.end) + AFTER_MIN * 60_000 > now && at(s.end) < horizon) : [];
  const daily = dailies(v, now).map((d) => ({ ...d, id: notifId(d.idKey) }));
  const sig = JSON.stringify([v.prefs.remind, v.prefs.calendar, soon.map((s) => s.key), ends.map((s) => s.key), v.slots.map(eventSig), daily.map((d) => [d.id, d.title, d.body])]);
  if (!force && read<string>(SIG) === sig) return;
  await reminders(v.prefs.remind.on ? soon : [], v.prefs.remind.before_min, ends, daily);
  await calendar(v);
  write(SIG, sig);
}

// ------------------------------------------------------------------ reminders

/** The nudge comes this long after a session should have ended. */
const AFTER_MIN = 30;

async function reminders(list: Slot[], before: number, ends: Slot[] = [], daily: Array<Daily & { id: number }> = []): Promise<void> {
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  // Ours are the ones marked tartan; anything else pending is left alone.
  const pending = await LocalNotifications.getPending();
  const ours = pending.notifications.filter((n) => (n.extra as { tartan?: boolean } | undefined)?.tartan);
  if (ours.length) await LocalNotifications.cancel({ notifications: ours.map((n) => ({ id: n.id })) });
  if (!list.length && !ends.length && !daily.length) return;
  if ((await LocalNotifications.checkPermissions()).display !== "granted") return;
  // Their own channels (Android's notification settings name them), shown in full on the lock
  // screen: a session's time and what it is aren't secrets.
  await LocalNotifications.createChannel({ id: "tartan-sessions", name: "Your sessions", description: "Before a session, and after it to bring it in.", importance: 4, visibility: 1 }).catch(() => {});
  await LocalNotifications.createChannel({ id: "tartan-daily", name: "Mornings and Sunday's review", description: "How you are and today's plan; the week looked back on.", importance: 3, visibility: 1 }).catch(() => {});
  await LocalNotifications.schedule({
    notifications: [
      ...list.map((s) => ({
      id: notifId(s.key),
      title: `${s.title} at ${s.start.slice(11)}`,
      body: before >= 60 ? `${s.summary}` : `In ${before} minutes · ${s.summary}`,
      schedule: { at: new Date(at(s.start) - before * 60_000), allowWhileIdle: true },
      // Inexact: a minute either way is fine, and it needs no "Alarms & reminders" permission.
      isExactNotification: false,
      channelId: "tartan-sessions",
      extra: { tartan: true, key: s.key },
    })),
      ...ends.map((s) => ({
        id: notifId(`${s.key}:after`),
        title: `${s.title} done?`,
        body: s.kind === "strength" ? "Tap to bring it in and log your sets." : "Tap to bring it in from your watch.",
        schedule: { at: new Date(at(s.end) + AFTER_MIN * 60_000), allowWhileIdle: true },
        isExactNotification: false,
        channelId: "tartan-sessions",
        extra: { tartan: true, key: s.key, after: true, date: s.date, kind: s.kind },
      })),
      ...daily.map((d) => ({ id: d.id, title: d.title, body: d.body, largeBody: d.body, schedule: { at: d.at, allowWhileIdle: true }, isExactNotification: false, channelId: "tartan-daily", extra: { tartan: true, key: d.key } })),
    ],
  });
}

export interface ReminderTap {
  key: string;
  /** The nudge after a session, not the reminder before it. */
  after?: boolean;
  date?: string;
  kind?: string;
  /** The note after a run: the run. */
  activity?: string;
}
/** A tap on a reminder or a nudge: the app handles where to go (and to sync after a session). */
export async function listenForReminderTaps(onTap: (t: ReminderTap) => void): Promise<void> {
  if (!isNative) return;
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  await LocalNotifications.addListener("localNotificationActionPerformed", (a) => {
    const x = a.notification.extra as (ReminderTap & { tartan?: boolean }) | undefined;
    if (x?.tartan) onTap(x);
  });
}

/** Ask for permission to post notifications; true when allowed. */
export async function allowReminders(): Promise<boolean> {
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  const cur = await LocalNotifications.checkPermissions();
  if (cur.display === "granted") return true;
  return (await LocalNotifications.requestPermissions()).display === "granted";
}

// ------------------------------------------------------------------ calendar

interface EventMap {
  calendar_id?: string;
  events: Record<string, { id: string; sig: string; start: string }>;
}

/** Calendars this phone can write to, for the picker. Asks for calendar access first. */
export async function writableCalendars(): Promise<Array<{ id: string; title: string; account?: string }> | null> {
  const { CapacitorCalendar } = await import("@ebarooni/capacitor-calendar");
  if ((await CapacitorCalendar.requestFullCalendarAccess()).result !== "granted") return null;
  const { result } = await CapacitorCalendar.listCalendars();
  return result
    .filter((c) => c.allowsContentModifications !== false && c.isImmutable !== true)
    .map((c) => ({ id: c.id, title: c.title ?? c.internalTitle ?? "Calendar", account: c.accountName ?? undefined }));
}

async function calendar(v: ScheduleView): Promise<void> {
  const map = read<EventMap>(EVENTS) ?? { events: {} };
  const want = v.prefs.calendar.on && v.prefs.calendar.calendar_id ? v.prefs.calendar.calendar_id : undefined;
  if (!want && !Object.keys(map.events).length) return;
  const { CapacitorCalendar } = await import("@ebarooni/capacitor-calendar");
  const now = Date.now();
  const drop: string[] = [];
  // Another calendar, or off: take ours out of the old one (past sessions stay as a record).
  const moved = map.calendar_id !== want;
  const byKey = new Map(v.slots.map((s) => [s.key, s]));
  for (const [key, e] of Object.entries(map.events)) {
    const s = byKey.get(key);
    if (!moved && s && eventSig(s) === e.sig) continue;
    if (at(e.start) > now) drop.push(e.id);
    delete map.events[key];
  }
  if (drop.length) await CapacitorCalendar.deleteEventsById({ ids: drop }).catch(() => undefined);
  map.calendar_id = want;
  if (want) {
    for (const s of v.slots) {
      if (map.events[s.key] || at(s.end) <= now) continue;
      const { id } = await CapacitorCalendar.createEvent({
        title: s.title,
        startDate: at(s.start),
        endDate: at(s.end),
        calendarId: want,
        // No alarm on the event: the reminder comes from Tartan, once.
        description: [s.summary, s.notes, "From your Tartan plan"].filter(Boolean).join("\n\n"),
      });
      if (id) map.events[s.key] = { id, sig: eventSig(s), start: s.start };
    }
  }
  write(EVENTS, Object.keys(map.events).length ? map : null);
}
