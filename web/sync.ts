/** Strava sync, Strava sign-in, and the automatic sync that replaces a Sync button. */
import { syncHc } from "./lib/health-connect.ts";
import { syncAh } from "./lib/apple-health.ts";
import { inDemo } from "./lib/demo.ts";
import { weeklyBackup } from "./lib/backup.ts";
import { keepWeekFace } from "./lib/week-face.ts";
import { updateWidget } from "./lib/widget.ts";
import { getLanes, laneFailed, laneOk, laneRunning } from "./lib/lanes.ts";
import { sendWeek, weekOutOfDate } from "./lib/watch-workouts.ts";
import type { PlanView } from "./types.ts";
import { reviewWeek, WEEKLY_OFF } from "./lib/weekly.ts";
import { app, hooks, isNative, log, notify, readNdjson } from "./state.ts";
import * as watch from "./watch.ts";
import { openPairLink } from "./lib/pairing.ts";
import { localNetwork } from "./lib/local-network.ts";

export interface StravaStatus {
  configured: boolean;
  clientId?: string;
  connected: boolean;
  /** Upload permission granted (activity:write). */
  can_upload?: boolean;
  athlete?: { firstname?: string; lastname?: string };
  activities: number;
  lastSync?: string;
  pendingDetails?: number;
  stoppedForRateLimit?: boolean;
}

export async function stravaStatus(): Promise<StravaStatus | null> {
  return app.api.json<StravaStatus>("/api/strava/status").catch(() => null);
}

export interface StravaSyncResult {
  added: number;
  total: number;
  pendingDetails: number;
}

/** Pull new activities from Strava; `quiet` skips the notice (the automatic sync announces its own). */
export async function stravaSync(full = false, onLine?: (line: string) => void, quiet = false): Promise<StravaSyncResult | null> {
  let done: StravaSyncResult | null = null;
  // Every round, by hand or automatic, lands on the board's Strava lane.
  laneRunning("strava", true);
  try {
    const res = await app.api.request("/api/strava/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full }) });
    await readNdjson(res, (m) => {
      if (m.log) {
        log(String(m.log));
        onLine?.(String(m.log));
      }
      if (m.error) throw new Error(String(m.error));
      if (m.done) done = m.done as StravaSyncResult;
    });
    laneOk("strava");
  } catch (e) {
    laneFailed("strava", e);
    throw e;
  }
  // Pairs on Strava come in as shoes (src/shoes.ts); Today says so once.
  await app.api.request("/api/shoes/import", { method: "POST" }).catch((e: Error) => log(`Shoes from Strava: ${e.message}`));
  const d = done as StravaSyncResult | null;
  if (d && !quiet) notify(`Strava: ${d.added} new, ${d.total} in total${d.pendingDetails ? `, ${d.pendingDetails} still waiting for detail` : ""}.`);
  return d;
}

/** Trade the code Strava sent back for tokens; the result for the ?strava= notice in Settings. */
async function completeStrava(q: URLSearchParams): Promise<string> {
  if (q.has("error") || !q.get("code")) return "denied";
  try {
    const res = await app.api.request("/api/strava/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: q.get("state"), code: q.get("code"), scope: q.get("scope") }) });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `exchange failed (${res.status})`);
    return "connected";
  } catch (e) {
    return `error&message=${encodeURIComponent((e as Error).message)}`;
  }
}

/** Back on the page with ?code&state (the desktop preview, where Strava returns to the page itself). */
export async function finishStravaReturn(): Promise<void> {
  const q = new URLSearchParams(location.search);
  if (!q.has("state") || !(q.has("code") || q.has("error"))) return;
  const result = await completeStrava(q);
  for (const k of ["state", "code", "scope", "error"]) q.delete(k);
  history.replaceState(null, "", `${location.pathname}?${q.toString() ? `${q}&` : ""}strava=${result}#sync`);
}

/**
 * Strava's consent in the app: a browser tab over the app (Chrome Custom Tab) showing the
 * address, with a close button and "open in browser" in its menu. Not the Strava app, which
 * opens its home screen instead of the consent page. Strava returns to tartan://localhost/strava.
 */
export async function openStravaConsent(url: string): Promise<void> {
  if (!isNative) {
    location.href = url;
    return;
  }
  const { Browser } = await import("@capacitor/browser");
  await Browser.open({ url, toolbarColor: "#14161a" });
}

/** App: finish a Strava sign-in when Android hands us the tartan:// link (or freesuunto://, from a sign-in started before the rename) (app running or cold-started by it). */
export async function listenForStravaReturn(): Promise<void> {
  if (!isNative) return;
  const { App } = await import("@capacitor/app");
  const handled = new Set<string>();
  const onUrl = async (url: string | undefined) => {
    if (!(url?.startsWith("tartan://") || url?.startsWith("freesuunto://")) || handled.has(url)) return;
    handled.add(url);
    // The PC's QR code: pair with it (tartan://localhost/pair?url=…&code=…).
    const u = new URL(url);
    if (u.pathname === "/pair") return openPairLink(u.searchParams.getAll("url"), u.searchParams.get("code") ?? "");
    const { Browser } = await import("@capacitor/browser");
    await Browser.close().catch(() => {});
    const result = await completeStrava(new URL(url).searchParams);
    // Tartan 2: Sources is native; it hears the result here, and the page says it.
    const { shellParts } = await import("./lib/shell.ts");
    if (shellParts().settings) {
      if (result === "connected") {
        notify("Strava is connected. Downloading your workouts…");
        void autoSync(true);
      } else notify(result === "denied" ? "Strava access was not granted." : "Strava connection failed.", "error");
      location.hash = "settings/sources";
      return;
    }
    history.replaceState(null, "", `${location.pathname}?strava=${result}#sync`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  await App.addListener("appUrlOpen", (e) => void onUrl(e.url));
  await onUrl((await App.getLaunchUrl())?.url);
}

const STRAVA_EVERY = 15 * 60_000;
/** Everything with the paired PC (workouts, routes, backups, settings): a few times a day. */
const PC_FULL_EVERY = 6 * 3600_000;
/**
 * The watch: every time the app opens (a couple of minutes apart at most), when you come back to
 * it after 20 minutes away, and hourly while it stays open. Each is a short connection that reads
 * only what's new, then lets go.
 */
const WATCH_EVERY = { open: 2 * 60_000, resume: 20 * 60_000, tick: 60 * 60_000 } as const;
export type SyncReason = keyof typeof WATCH_EVERY;
let autoRunning = false;
/** A forced sync asked for while one was running (a nudge tapped as the app came back): it runs next. */
let forceNext = false;

function due(what: "strava" | "watch" | "memory" | "pcfull" | "intervals", every: number): boolean {
  try {
    const last = Number(localStorage.getItem(`freesuunto.auto.${what}`) ?? 0);
    if (Date.now() - last < every) return false;
    localStorage.setItem(`freesuunto.auto.${what}`, String(Date.now()));
  } catch {
    // no storage: sync anyway
  }
  return true;
}

/**
 * New data comes in on its own: when the app opens, when you come back to it, and every half
 * hour while it's open. Neither Strava nor the watch can push to a phone app, so this asks them.
 * Strava at most every 15 minutes; the phone's already-paired watch on every open, after 20
 * minutes away, and hourly (WATCH_EVERY), only once you have backed it up here before (never a
 * picker, never a pairing dialog).
 */
export interface WeeklyReview {
  week: string;
  at: string;
  text: string;
  changed: boolean;
  /** Changes it suggests, waiting for you on the Coach tab. */
  proposed?: number;
  conversation?: string;
}
/** Once a week, when there's a plan and a coach: the review, quietly; what it said comes back as a notice. */
async function weeklyReview(): Promise<WeeklyReview | null> {
  try {
    if (localStorage.getItem(WEEKLY_OFF) === "1") return null;
  } catch {
    // no storage: on
  }
  const week = reviewWeek();
  if (!week) return null;
  const last = await app.api.json<WeeklyReview | null>("/api/plan/weekly").catch(() => null);
  if (last?.week === week) return null;
  const [plan, coach] = await Promise.all([app.api.json<PlanView>("/api/plan").catch(() => null), app.api.json<{ ready: boolean }>("/api/coach/status").catch(() => null)]);
  if (!plan?.plan || !coach?.ready) return null;
  let done: WeeklyReview | null = null;
  const res = await app.api.request("/api/plan/weekly", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ week }) });
  await readNdjson(res, (m) => {
    if (m.type === "error") throw new Error(String(m.message));
    if (m.type === "weekly") done = m as unknown as WeeklyReview;
  });
  const r = done as WeeklyReview | null;
  if (r) {
    log(`Weekly review (${week}): ${r.proposed ? `${r.proposed} changes suggested` : r.changed ? "plan changed" : "plan kept"}. ${r.text}`);
    notify(r.proposed ? `Your coach suggests ${r.proposed} change${r.proposed > 1 ? "s" : ""} for next week. Review them on the Coach tab.` : r.changed ? "Your coach adjusted next week. See the Coach tab." : "Your coach reviewed the week: next week stays as planned.");
    hooks.refresh();
  }
  return r;
}

/**
 * Phone and PC share one coach memory: with a linked PC, send the phone's notes, take back the
 * merged set (src/memory.ts). One small request each way, and only alongside the other syncs.
 */
export async function syncMemory(): Promise<void> {
  const pc = app.remote;
  if (!pc) return;
  const mine = await app.api.json<{ notes: Array<{ id: string; updated: string }> }>("/api/coach/memory");
  const both = await pc.json<{ notes: Array<{ id: string; updated: string }> }>("/api/coach/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mine) });
  const key = (n: { notes: Array<{ id: string; updated: string }> }) => n.notes.map((x) => x.id + x.updated).sort().join();
  if (key(both) !== key(mine)) await app.api.json("/api/coach/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(both) });
}

/**
 * One short round with the paired watch: read only what's new, keep the coming week on it, let go.
 * Returns how many files came off the watch.
 */
async function syncWatch(resend = false): Promise<number> {
  laneRunning("watch", true);
  try {
    await watch.connect(false, { pairedOnly: true });
    const files = await watch.backup("/", false, true);
    // Once you've sent workouts to the watch, it keeps the coming week: new days go on, past
    // ones come off, and sessions that changed (the coach's review, next time's weights) update.
    if (Object.keys(watch.readSent()).length) {
      const v = await app.api.json<PlanView>("/api/plan");
      if (resend || weekOutOfDate(v)) {
        const r = await sendWeek(v);
        if (r.added || r.removed) log(`${resend ? "Weekly review: the new week" : "The coming week"} on the watch (${r.added} on, ${r.removed} off).`);
      }
    }
    // The week face, when it's kept up to date and no longer shows this week (at most once a week).
    const plan = await app.api.json<PlanView>("/api/plan").catch(() => null);
    if (plan) await keepWeekFace(plan).catch((e) => log(`Week face: ${(e as Error).message}`));
    laneOk("watch");
    return files;
  } catch (e) {
    laneFailed("watch", e);
    throw e;
  } finally {
    await watch.disconnect().catch(() => {});
  }
}

/** The board's Watch lane, tapped: sync the watch now, whatever the schedule says, and say how it went. */
export async function syncWatchNow(): Promise<void> {
  const s = watch.getState();
  if (s.job || s.connecting || s.running) return notify("The watch is already syncing.");
  if (watch.readBrand().brand === "garmin") return notify("Your Garmin gets today's session through Garmin Connect; its runs come in from intervals.icu, Strava or Health Connect.");
  if (!s.connected && (!isNative || !(await watch.knowsPairedWatch()))) {
    location.hash = "#settings/sources";
    return;
  }
  try {
    // Already connected (you opened it in Settings): read what's new and stay connected.
    let files: number;
    if (s.connected) {
      laneRunning("watch", true);
      files = await watch.backup("/", false, true).catch((e) => {
        laneFailed("watch", e);
        throw e;
      });
      laneOk("watch");
    } else files = await syncWatch();
    try {
      localStorage.setItem("freesuunto.auto.watch", String(Date.now()));
    } catch {
      // no storage: the schedule just runs again sooner
    }
    notify(files ? `Backed up ${files} new ${files === 1 ? "file" : "files"} from the watch.` : "The watch is up to date.");
    if (files) hooks.refresh();
  } catch (e) {
    log(`Watch sync: ${(e as Error).message}`);
    const err = getLanes().watch.error;
    notify(err ? `${err.text} ${err.fix ?? ""}`.trim() : "The watch sync didn't finish.", "error");
  }
}

/** The board's Strava lane, tapped: new activities now, and a word on how it went. */
export async function syncStravaNow(): Promise<void> {
  if (getLanes().strava.running) return notify("Strava is already syncing.");
  if (!(await stravaStatus())?.connected) {
    location.hash = "#settings/sources";
    return;
  }
  try {
    const r = await stravaSync(false, undefined, true);
    try {
      localStorage.setItem("freesuunto.auto.strava", String(Date.now()));
    } catch {
      // no storage: the schedule just runs again sooner
    }
    notify(r?.added ? `${r.added} new ${r.added === 1 ? "workout" : "workouts"} from Strava.` : "Strava is up to date.");
    if (r?.added) hooks.refresh();
  } catch (e) {
    log(`Strava sync: ${(e as Error).message}`);
    const err = getLanes().strava.error;
    notify(err ? `${err.text} ${err.fix ?? ""}`.trim() : "The Strava sync didn't finish.", "error");
  }
}

/** Pulled down on Today: everything now, and an answer even when nothing was new. */
export async function syncAllNow(): Promise<void> {
  // A tap: the moment to ask Android 17 for the home network, when there's a PC to reach.
  if (app.remote) await localNetwork(true);
  const r = await autoSync(true, "open");
  if (!r) return;
  const failed = (["watch", "strava"] as const).filter((l) => getLanes()[l].error && (getLanes()[l].error!.at >= r.started));
  if (failed.length) notify(failed.map((l) => getLanes()[l].error!.text).join(" "), "error");
  else if (!r.workouts && !r.files) notify("Up to date.");
}

export async function autoSync(force = false, why: SyncReason = "tick"): Promise<{ workouts: number; files: number; started: number } | null> {
  if (autoRunning && force) forceNext = true;
  if (autoRunning || document.hidden) return null;
  // The demo's sample data: nothing comes in from outside while it's on.
  if (inDemo()) return null;
  autoRunning = true;
  const started = Date.now();
  let workouts = 0;
  let files = 0;
  try {
    if ((await stravaStatus())?.connected && (force || due("strava", STRAVA_EVERY))) {
      workouts += (await stravaSync(false, undefined, true).catch((e) => void log(`Automatic Strava sync: ${(e as Error).message}`)))?.added ?? 0;
    }
    // intervals.icu, when connected: new workouts (and history still to come) every 15 minutes at most.
    if ((force || due("intervals", STRAVA_EVERY)) && (await app.api.json<{ connected: boolean }>("/api/intervals/status").catch(() => null))?.connected) {
      const r = await app.api.json<{ added: number }>("/api/intervals/sync", { method: "POST" }).catch((e: Error) => void log(`intervals.icu: ${e.message}`));
      workouts += r?.added ?? 0;
      // Once the plan goes there, the coming week stays up to date (Garmin and others get it from there).
      await (await import("./lib/plan-out.ts")).keepIntervals().catch((e: Error) => void log(`Plan to intervals.icu: ${e.message}`));
    }
    // The coach's memory, with the linked PC (before the review, which reads and adds to it).
    if (force || due("memory", STRAVA_EVERY)) {
      await syncMemory().catch((e) => void log(`Coach memory with the PC: ${(e as Error).message}`));
      // The plan, lifts and morning checks, both ways (end to end encrypted); every few hours, everything.
      if (app.link && (force || due("pcfull", PC_FULL_EVERY))) {
        const r = await app.api.request("/api/link/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: app.link }) }).catch((e: Error) => void log(`Sync with the PC: ${e.message}`));
        let changed = false;
        if (r) await readNdjson(r, (m) => void (m.type === "done" && (changed = !!m.changed))).catch((e: Error) => void log(`Sync with the PC: ${e.message}`));
        if (changed) hooks.refresh();
      } else if (app.link) {
        const r = await app.api.json<{ changed: boolean }>("/api/link/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: app.link }) }).catch((e: Error) => void log(`Sync with the PC: ${e.message}`));
        if (r?.changed) hooks.refresh();
      }
    }
    // Sunday evening: the coach looks back at the week and adjusts the next one.
    const review = await weeklyReview().catch((e) => void log(`Weekly review: ${(e as Error).message}`));
    const resend = !!review?.changed && Object.keys(watch.readSent()).length > 0;
    if (isNative && !watch.getState().connected && !watch.getState().connecting && (await watch.knowsPairedWatch()) && (force || resend || due("watch", WATCH_EVERY[why]))) {
      files += await syncWatch(resend).catch((e) => (log(`Automatic watch backup skipped: ${(e as Error).message}`), 0));
    }
    // Health Connect: what's new since the last round (at most every 30 minutes; nothing when off).
    if (isNative) await syncHc(force).catch(() => {});
    // Apple Health (iPhone): new workouts from other apps (at most every 30 minutes; nothing when off).
    if (isNative) workouts += (await syncAh(force).catch(() => undefined))?.added ?? 0;
    // The weekly encrypted backup, once the passphrase is set (Documents/Tartan; it says when it fails).
    await weeklyBackup();
  } finally {
    autoRunning = false;
    if (forceNext) {
      forceNext = false;
      void autoSync(true, why);
    }
  }
  if (workouts) notify(`${workouts} new ${workouts === 1 ? "workout" : "workouts"}.`);
  else if (files) notify(`Backed up ${files} new ${files === 1 ? "file" : "files"} from the watch.`);
  if (workouts || files) hooks.refresh();
  // The home-screen widget: today's session, the week and when each source last came in.
  void updateWidget();
  return { workouts, files, started };
}
