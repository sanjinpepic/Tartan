/** The morning notification and Sunday's review (web/lib/schedule.ts dailies). */
import { expect, test } from "bun:test";
import { dailies } from "../src/schedule.ts";
import type { ScheduleView } from "../web/types.ts";

const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  prefs: { weekday: "18:00", weekend: "09:00", remind: { on: false, before_min: 30 }, calendar: { on: false }, notify: { morning: true, morning_at: "07:30", review: true, run: true } },
  today: "2026-11-09",
  slots: [{ key: "2026-11-10:tempo", date: "2026-11-10", kind: "tempo", title: "Tempo", start: "2026-11-10T18:00", end: "2026-11-10T18:50", minutes: 50, summary: "9 km, 4:50/km" }],
  morning: { readiness: "Balanced", proposed: 2, plan: true },
  ...over,
});

test("the next three mornings: how you are and changes waiting on the first, what's planned on each; Sunday's review", () => {
  const now = new Date("2026-11-09T12:00:00").getTime(); // a Monday, after the morning
  const d = dailies(view(), now);
  const mornings = d.filter((x) => x.key === "morning");
  expect(mornings).toHaveLength(3);
  expect(mornings[0]).toMatchObject({ title: "Today: Tempo", body: "Balanced. Tempo: 9 km, 4:50/km 2 changes to your plan to look at." });
  expect(mornings[0]!.at.getDate()).toBe(10);
  expect(mornings[1]).toMatchObject({ title: "Good morning", body: "A rest day." });
  const review = d.find((x) => x.key === "review")!;
  expect(review.at.getDay()).toBe(0);
  expect(review.at.getHours()).toBe(19);
});

test("turned off, or no plan: no review; mornings off: none", () => {
  const now = new Date("2026-11-09T06:00:00").getTime();
  expect(dailies(view({ morning: { readiness: null, proposed: 0, plan: false } }), now).filter((x) => x.key === "review")).toHaveLength(0);
  const off = view();
  off.prefs.notify = { morning: false, morning_at: "07:30", review: false, run: false };
  expect(dailies(off, now)).toHaveLength(0);
  // Before the time today: today's is the first.
  expect(dailies(view(), now)[0]!.at.getDate()).toBe(9);
});
