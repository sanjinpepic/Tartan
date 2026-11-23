/**
 * What the home-screen widget shows (android TodayWidget): today's session and its detail, how
 * you are (the morning check's word when it says go easy, else readiness), the week's km, and
 * the sync board's lanes. Sent after each sync and when the app goes to the background; the
 * widget draws it and keeps the "2h" times moving itself.
 */
import { registerPlugin } from "@capacitor/core";
import { dateShort, fmtDuration, num } from "./dom.ts";
import { getLanes } from "./lanes.ts";
import { app, isNative, log } from "../state.ts";
import type { PlanView, TodayView } from "../types.ts";
import * as watch from "../watch.ts";

const Widget = registerPlugin<{ update(d: Record<string, unknown>): Promise<void> }>("TartanWidget");

export async function updateWidget(): Promise<void> {
  if (!isNative) return;
  try {
    const [t, plan, r] = await Promise.all([
      app.api.json<TodayView>("/api/today"),
      app.api.json<PlanView>("/api/plan").catch(() => null),
      app.api.json<{ checkin: unknown; readiness: { level: "ready" | "go easy" | "rest" } }>("/api/readiness").catch(() => null),
    ]);
    const week = plan?.weeks.find((w) => w.when === "current");
    const day = week?.days.find((d) => d.date === plan?.today);
    const s = day?.sessions.find((x) => x.kind !== "rest");
    const what = (x: NonNullable<typeof s>) => [x.duration_min ? fmtDuration(x.duration_min) : x.distance_km ? `${num(x.distance_km, x.distance_km < 10 ? 1 : 0)} km` : "", x.target ?? ""].filter(Boolean).join(" · ");
    // A rest day: the next session, so the widget is still worth a glance.
    const next = !s ? plan?.weeks.flatMap((w) => w.days).find((d) => d.date > (plan?.today ?? "") && d.sessions.some((x) => x.kind !== "rest")) : undefined;
    const nextS = next?.sessions.find((x) => x.kind !== "rest");
    const title = !s ? "Rest day" : s.status === "done" ? `${s.title}: done` : s.title;
    const detail = s && s.status !== "done" ? what(s) : nextS ? `Next: ${nextS.title}, ${new Date(`${next!.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" })}` : plan ? "" : "Make a plan on the Coach tab.";
    const easy = !!r?.checkin && r.readiness.level !== "ready";
    const ready = easy ? (r!.readiness.level === "rest" ? "Rest or very easy" : "Go easy today") : t.readiness.state === "new" ? "Getting to know you" : t.readiness.title;
    const tone = easy || t.readiness.state === "tired" ? "warn" : t.readiness.state === "fresh" || t.readiness.state === "rested" ? "good" : "accent";
    const planned = week ? week.planned.km || week.target_km || 0 : 0;
    const km = week ? week.done.km : t.week.km;
    const lanes = getLanes();
    await Widget.update({
      when: dateShort(new Date()),
      label: s ? "Today's session" : "",
      title,
      detail,
      ready,
      tone,
      // The week as Today draws it (the widget's ring and day bars): its kilometres, the goal, each day.
      km,
      goal: planned || t.week.usual_km || 0,
      days: t.week.days.map((x) => ({ date: x.date, km: x.km, future: x.future, today: x.date === (plan?.today ?? new Date().toLocaleDateString("sv")) })),
      week: planned ? `${num(km, 1)} of ${num(planned, 0)} km this week` : `${num(km, 1)} km this week`,
      watch_on: !!watch.lastSync() || !!lanes.watch.ok,
      watch_at: lanes.watch.ok ?? 0,
      watch_failed: !!lanes.watch.error,
      strava_on: !!lanes.strava.ok,
      strava_at: lanes.strava.ok ?? 0,
      strava_failed: !!lanes.strava.error,
    });
  } catch (e) {
    log(`Widget: ${(e as Error).message}`);
  }
}
