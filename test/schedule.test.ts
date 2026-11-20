import { expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import type { PlanWeekView } from "../src/plan.ts";
import { DEFAULT_PREFS, readPrefs, savePrefs, slots, timeFor, toIcs } from "../src/schedule.ts";

// 2026-10-19 is a Monday.
const week = (sessions: Array<[string, string, Record<string, unknown>?]>, status: Record<string, string> = {}): PlanWeekView[] => {
  const days = new Map<string, PlanWeekView["days"][number]>();
  for (const [date, kind, extra] of sessions) {
    const d = days.get(date) ?? { date, sessions: [], extra: [] };
    d.sessions.push({ date, kind, title: `${kind} session`, status: (status[`${date}:${kind}`] ?? "planned") as never, ...extra } as never);
    days.set(date, d);
  }
  return [{ start: "2026-10-19", focus: "Build", days: [...days.values()], planned: { sessions: 0, km: 0, minutes: 0 }, done: { sessions: 0, km: 0, minutes: 0 }, when: "current" }];
};

test("weekdays and weekends get their own times, and a day of its own wins", () => {
  const p = { ...DEFAULT_PREFS, weekday: "18:00", weekend: "09:30", days: { wed: "12:00" } };
  expect(timeFor(p, "2026-10-19")).toBe("18:00"); // Monday
  expect(timeFor(p, "2026-10-21")).toBe("12:00"); // Wednesday, its own
  expect(timeFor(p, "2026-10-23")).toBe("18:00"); // Friday
  expect(timeFor(p, "2026-10-24")).toBe("09:30"); // Saturday
  expect(timeFor(p, "2026-10-25")).toBe("09:30"); // Sunday
});

test("slots: future sessions at your time, rest days, done and past ones left out", () => {
  const weeks = week(
    [
      ["2026-10-19", "easy", { duration_min: 40 }],
      ["2026-10-20", "rest"],
      ["2026-10-21", "intervals", { duration_min: 50, target: "4:10/km" }],
      ["2026-10-22", "tempo", { duration_min: 45 }],
      ["2026-10-25", "long", { distance_km: 18 }],
    ],
    { "2026-10-22:tempo": "done" },
  );
  const list = slots(weeks, { ...DEFAULT_PREFS, weekday: "18:00", weekend: "09:00" }, "2026-10-20");
  expect(list.map((s) => s.key)).toEqual(["2026-10-21:intervals", "2026-10-25:long"]);
  expect(list[0]).toMatchObject({ start: "2026-10-21T18:00", end: "2026-10-21T18:50", minutes: 50, summary: "Intervals · 50 min · 4:10/km" });
  // 18 km at an easy 6 min/km.
  expect(list[1]).toMatchObject({ start: "2026-10-25T09:00", end: "2026-10-25T10:48", minutes: 108 });
});

test("a session running past midnight ends the next day", () => {
  const list = slots(week([["2026-10-19", "easy", { duration_min: 90 }]]), { ...DEFAULT_PREFS, weekday: "23:30" }, "2026-10-19");
  expect(list[0]!.end).toBe("2026-10-20T01:00");
});

test("two sessions of a kind on one day keep separate keys", () => {
  const list = slots(week([["2026-10-19", "easy"], ["2026-10-19", "easy"]]), DEFAULT_PREFS, "2026-10-19");
  expect(list.map((s) => s.key)).toEqual(["2026-10-19:easy", "2026-10-19:easy#2"]);
});

test("prefs: saved, merged and checked", async () => {
  const disk = new MemoryDisk();
  expect(await readPrefs(disk)).toEqual(DEFAULT_PREFS);
  await savePrefs(disk, { weekday: "18:15", remind: { on: true, before_min: 60 } });
  // Bad values keep what was there.
  const p = await savePrefs(disk, { weekend: "25:00", days: { tue: "07:00", wed: "noon" } as never, calendar: { on: true, calendar_id: "3", calendar_name: "Personal" } });
  expect(p).toEqual({ weekday: "18:15", weekend: "09:00", days: { tue: "07:00" }, remind: { on: true, before_min: 60, after: true }, calendar: { on: true, calendar_id: "3", calendar_name: "Personal" }, notify: { morning: true, morning_at: "07:30", review: true, run: true } });
  expect(await readPrefs(disk)).toEqual(p);
  // The morning's time: a bad one keeps the last.
  expect((await savePrefs(disk, { notify: { morning: false, morning_at: "6am", review: true, run: false } })).notify).toEqual({ morning: false, morning_at: "07:30", review: true, run: false });
  // Clearing a day goes back to the weekday time.
  expect((await savePrefs(disk, { days: { tue: undefined } })).days).toEqual({});
});

test("ics: one event per session at local time, stable ids, an alarm when reminders are on", () => {
  const list = slots(week([["2026-10-21", "intervals", { duration_min: 50, title: "6 × 800 m, rest 90 s", notes: "Warm up 15 min; cool down 10" }]]), DEFAULT_PREFS, "2026-10-20");
  const prefs = { ...DEFAULT_PREFS, remind: { on: true, before_min: 30 } };
  const ics = toIcs(list, prefs, new Date("2026-10-16T08:00:00Z"));
  expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  expect(ics).toContain("UID:2026-10-21:intervals@tartan\r\n");
  expect(ics).toContain("DTSTART:20261021T180000\r\n");
  expect(ics).toContain("DTEND:20261021T185000\r\n");
  expect(ics).toContain("SUMMARY:6 × 800 m\\, rest 90 s\r\n");
  expect(ics).toContain("Warm up 15 min\\; cool down 10");
  expect(ics).toContain("TRIGGER:-PT30M");
  expect(toIcs(list, DEFAULT_PREFS)).not.toContain("VALARM");
  // No line over 75 octets, and unfolding gives the text back.
  for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  expect(ics.replace(/\r\n /g, "")).toContain("DESCRIPTION:Intervals · 50 min\\nWarm up 15 min\\; cool down 10\\nFrom your Tartan plan\r\n");
});
