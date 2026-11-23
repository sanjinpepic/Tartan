/**
 * The phone's engine (Tartan 2). Every screen is native (android/…/shell); this page draws
 * nothing. It answers the screens' API calls and RPCs (lib/shell.ts), syncs the watch and Strava,
 * keeps reminders, the widget and the recorder, and says where the app is (the address) so the
 * native screens follow. The PC keeps the web app (app.ts).
 */
import { hooks, log, notify } from "./state.ts";
import { autoSync, finishStravaReturn, listenForStravaReturn } from "./sync.ts";
import { listenForReminderTaps, syncSchedule } from "./lib/schedule.ts";
import { afterRunSoon } from "./lib/after-run.ts";
import { onDataChanged } from "./lib/read-cache.ts";
import { updateWidget } from "./lib/widget.ts";
import * as recorder from "./recorder.ts";
import { maybeOnboard } from "./lib/intro.ts";
import { boardModel, followBoard } from "./lib/board.ts";
import { shellBoard, shellRoute, shellWorkout, startShell } from "./lib/shell.ts";

/** The places the native screens know (the web app's views, by the same names). */
const VIEWS = ["today", "you", "coach", "activities", "routes", "trends", "settings", "record", "chat", "route", "lift", "face"];

/** Where the app is now: the native screens follow the address. */
function route(): void {
  // #sync is where Strava's sign-in comes back (Settings → Sources); #plan was the Plan tab.
  const raw = location.hash.slice(1);
  const hash = (raw === "sync" ? "settings" : raw === "plan" ? "coach" : raw).split("/")[0]!;
  shellRoute(VIEWS.includes(hash) ? hash : "today");
}

hooks.openActivity = (id) => void shellWorkout(id);
// New data: reminders follow (the native screens hear of it through Shell.changed), and a new
// run gets its note (from the watch's backup, which writes no API; every other source writes one).
hooks.refresh = () => {
  void syncSchedule();
  afterRunSoon();
};
onDataChanged(() => afterRunSoon());

// The sync board, for native Today's chip and its sheet.
followBoard(() => shellBoard(boardModel().map(({ id, state, text, glyph, name, status, failed }) => ({ id, state, text, glyph, name, status, failed }))));

void recorder.restoreUnfinished();
declare const BUILD_ID: string;
log(`Tartan build ${typeof BUILD_ID === "string" ? BUILD_ID : "dev"} (engine)`);

window.addEventListener("hashchange", route);
window.addEventListener("unhandledrejection", (e) => notify(String((e.reason as Error)?.message ?? e.reason), "error"));

void startShell();
// The demo: its sample written the first time, then every screen reads it.
// (A write: the native screens hear of it and read again.)
void import("./lib/demo.ts").then((d) => d.seedDemo());
void finishStravaReturn().finally(() => {
  route();
  void autoSync(false, "open");
  // First run: the intro (native), resumed after Strava's sign-in brings you back.
  void maybeOnboard();
  void syncSchedule();
  // The note after a run: anything new since last time (the first time, what's here is only noted).
  afterRunSoon(5000);
});
// A reminder opens Today; the nudge after a session syncs now and opens its strength log, or Today;
// the note after a run opens that run.
void listenForReminderTaps((t) => {
  if (t.key === "run" && t.activity) {
    // Opened from the notification, the native screens may still be starting: try for a few seconds.
    // The note points to the run's moments on the map: the sheet opens at them.
    const id = t.activity;
    let tries = 0;
    const open = () => void (shellWorkout(id, "moments") || (++tries < 20 && setTimeout(open, 300)));
    return open();
  }
  location.hash = t.after && t.kind === "strength" && t.date ? `#lift/${t.date}` : t.key === "review" ? "#coach" : "#today";
  // After a session: bring it in. Sunday's review: it runs with the sync.
  if (t.after || t.key === "review") void autoSync(true, "open");
});
// Data comes in when the app opens, when you come back to it, and half-hourly.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void updateWidget();
  void autoSync(false, "resume");
  if (document.visibilityState === "visible") void syncSchedule();
});
setInterval(() => void autoSync(false, "tick"), 30 * 60_000);
void listenForStravaReturn();
