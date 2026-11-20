/** The watch connection, shared by the automatic sync and Settings. */
import { workoutRunner } from "./lib/runner.ts";
import { reconcile, type SentWorkout, type WantedWorkout } from "../src/workout/from-plan.ts";
import { joinPath, WatchSession, type BleLink } from "../src/protocol/session.ts";
import { watchPoints } from "../src/protocol/route-file.ts";
import type { LngLat } from "../src/routes.ts";
import type { FacePackage } from "../src/watchface/package.ts";
import { mirror } from "../src/protocol/sync.ts";
import { newRecords, TRENDS_DIR } from "../src/health.ts";
import type { TrendRecord } from "../src/protocol/trends.ts";
import { FakeWatch } from "../src/sim/fake-watch.ts";
import { WebBluetoothLink, type WebDeviceInfo } from "../src/transport/web-bluetooth.ts";
import { recordLink } from "./lib/blackbox.ts";
import { fmtBytes } from "./lib/dom.ts";
import { app, isNative, local, log, notify } from "./state.ts";

export interface WatchState {
  connected: boolean;
  /** A connection is being set up (manual or automatic): no second one may start. */
  connecting: boolean;
  demo: boolean;
  name: string;
  facts: Array<[string, string]>;
  cwd: string;
  listing: { dirs: string[]; files: string[] } | null;
  job: { title: string; text: string; value?: number; max?: number } | null;
  running: boolean;
  /** "logbook": the watch keeps workouts in its logbook, not as listable files (the Run 2). */
  mode: "files" | "logbook";
}

const state: WatchState = { connecting: false, connected: false, demo: false, name: "", facts: [], cwd: "/", listing: null, job: null, running: false, mode: "files" };
const listeners = new Set<(s: WatchState) => void>();
let session: WatchSession | null = null;
let abort: AbortController | null = null;

export const watchOptions = { chunkSize: 20, acceptAll: false };

export function onWatch(f: (s: WatchState) => void): () => void {
  listeners.add(f);
  f(state);
  return () => listeners.delete(f);
}
const emit = () => {
  listeners.forEach((f) => f(state));
  idleCheck();
};

/**
 * The watch's battery: a link nobody is using is closed. Two minutes after the last job (a
 * backup, a route, a face) with nothing running, or as soon as the app goes to the background,
 * the connection ends; whatever needs the watch next connects again.
 */
const IDLE_MS = 2 * 60_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const busy = () => !!(state.job || state.running || state.connecting || connecting);
function idleCheck(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!state.connected || busy()) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (state.connected && !busy()) {
      log("Watch idle for two minutes: disconnected to save its battery.");
      void disconnect().catch(() => {});
    }
  }, IDLE_MS);
}
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.connected && !busy()) void disconnect().catch(() => {});
  });
const setJob = (job: WatchState["job"]) => {
  state.job = job;
  emit();
};

export const canBluetooth = () => isNative || WebBluetoothLink.supported();

/** Phone: a watch Tartan has connected to before and Android still has paired. */
export async function knowsPairedWatch(): Promise<boolean> {
  if (!isNative) return false;
  const { CapacitorBleLink } = await import("../src/transport/capacitor-ble.ts");
  return CapacitorBleLink.knowsPairedWatch();
}

const NO_FILES = "freesuunto.watch.nofiles";
const LAST_SYNC = "freesuunto.watch.lastsync";

/** The last time this phone read the watch (any backup that finished), for the status chip. */
export function lastSync(): { name: string; at: string } | null {
  try {
    return JSON.parse(localStorage.getItem(LAST_SYNC) ?? "null");
  } catch {
    return null;
  }
}
function noteSync(name: string): void {
  try {
    localStorage.setItem(LAST_SYNC, JSON.stringify({ name, at: new Date().toISOString() }));
  } catch {
    // no storage
  }
  emit();
}

/**
 * The paired watch refuses file listings (the Suunto Run 2: it uploads workouts to Suunto's
 * cloud itself and keeps them off Bluetooth). Automatic backups skip it; Strava brings the
 * workouts instead. A later successful connection clears it.
 */
export function noFileAccess(): string | null {
  try {
    return localStorage.getItem(NO_FILES);
  } catch {
    return null;
  }
}

/** `pairedOnly`: connect to the already-paired watch or fail, never showing the picker (automatic sync). */
let connecting: Promise<void> | null = null;

/** One connection at a time: a second call while one is being set up waits for it instead. */
export function connect(demo = false, opts: { pairedOnly?: boolean } = {}): Promise<void> {
  if (connecting) return connecting;
  if (state.connected) return Promise.resolve();
  state.connecting = true;
  emit();
  connecting = connectOnce(demo, opts).finally(() => {
    connecting = null;
    state.connecting = false;
    emit();
  });
  return connecting;
}

async function connectOnce(demo: boolean, opts: { pairedOnly?: boolean }): Promise<void> {
  let link: BleLink;
  let extra: WebDeviceInfo = {};
  if (demo) {
    link = new FakeWatch({ name: "Demo Suunto Run 2 0001", files: demoFiles(), trends: demoTrends(), notifySize: 124, readChunk: 900 });
    extra = { battery: 76 };
  } else if (isNative) {
    const { CapacitorBleLink } = await import("../src/transport/capacitor-ble.ts");
    link = await CapacitorBleLink.request(log, opts);
  } else {
    const web = await WebBluetoothLink.request(watchOptions);
    link = web;
    extra = web.extra;
  }
  const rec = recordLink(link, log);
  link = rec.link;
  try {
    session = new WatchSession(link, {
      log: rec.log,
      ...(demo ? { chunkDelayMs: 0, frameGapMs: 2 } : {}),
      onClose: (reason) => {
        log(`Link closed: ${reason}`);
        abort?.abort();
        disconnected();
      },
    });
    setJob({ title: "Connecting", text: "Reading what the watch reports about itself" });
    const info = await session.open();
    // A watch known to refuse file listings goes straight to its logbook (no minute of probing).
    let gen: Awaited<ReturnType<WatchSession["detectGeneration"]>> | null = null;
    if (demo || !noFileAccess()) {
      try {
        gen = await session.detectGeneration();
      } catch (e) {
        if (!/refused every listing/.test((e as Error).message)) throw e;
        log(`File listing refused (${(e as Error).message.slice(0, 160)}…); using the watch's logbook instead.`);
        try {
          localStorage.setItem(NO_FILES, link.name);
        } catch {
          // no storage
        }
      }
    }
    if (gen === null) {
      state.connected = true;
      state.mode = "logbook";
      state.demo = false;
      state.name = info.name;
      state.facts = [["Watch", info.name], ["Workouts", "From its logbook, as the Suunto app reads them"]];
      await local.saveInfo(info.name, { name: info.name, info: info.info, generation: "logbook", ...extra }).catch(() => {});
      return;
    }
    state.mode = "files";
    state.connected = true;
    state.demo = demo;
    state.name = info.name;
    state.facts = [
      ["Watch", info.name],
      ...(extra.battery !== undefined ? ([["Battery", `${extra.battery}%`]] as Array<[string, string]>) : []),
      ...(extra.firmware ? ([["Firmware", extra.firmware]] as Array<[string, string]>) : []),
      ["Filesystem", gen === "ng3" ? "NG3, paths start with b:/" : gen === "ng3-bare" ? "paths start with b: (no slash)" : gen === "ng1" ? "NG1, plain paths" : `paths start with ${gen.slice(-1)}:/`],
      ...(info.info.length ? ([["Reports", info.info.join(" · ")]] as Array<[string, string]>) : []),
    ];
    await local.saveInfo(info.name, { name: info.name, info: info.info, generation: gen, ...extra }).catch(() => {});
    try {
      localStorage.removeItem(NO_FILES);
    } catch {
      // no storage
    }
    await browse("/");
  } catch (e) {
    await link.close().catch(() => {});
    disconnected();
    throw e;
  } finally {
    setJob(null);
  }
}

export async function disconnect(): Promise<void> {
  await session?.close();
  disconnected();
}

function disconnected(): void {
  session = null;
  Object.assign(state, { connected: false, demo: false, name: "", facts: [], listing: null, running: false, job: null, mode: "files" });
  emit();
}

export async function browse(path: string): Promise<void> {
  if (!session) return;
  state.listing = await session.listDir(path);
  state.cwd = path;
  emit();
}

export const childPath = joinPath;

export async function saveOne(path: string): Promise<void> {
  if (!session) return;
  setJob({ title: `Downloading ${path}`, text: "", value: 0 });
  try {
    const data = await session.readFile(path, (n) => setJob({ title: `Downloading ${path}`, text: fmtBytes(n) }));
    await local.sink(state.name).put(path, data);
    notify(`Saved ${path} (${fmtBytes(data.length)}).`);
    if (!isNative) {
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([data.slice()])), download: path.split("/").pop() || "file" });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
  } finally {
    setJob(null);
  }
}

export function cancel(): void {
  abort?.abort();
}

/**
 * Experimental, for watches with no readable file listing (the Run 2): open a session of its
 * own, learn the activity-log sync command, and only after the owner confirms the exact
 * command, start the watch's sync and save every workout entry it hands over.
 */
export async function readActivityLog(confirmCommand: (text: string) => boolean): Promise<number> {
  if (state.connecting || connecting) throw new Error("A connection is being set up; try again in a moment");
  if (!isNative) throw new Error("This needs the Android app");
  const { CapacitorBleLink } = await import("../src/transport/capacitor-ble.ts");
  state.connecting = true;
  emit();
  let link: BleLink | null = null;
  try {
    setJob({ title: "Reading workouts", text: "Connecting" });
    const rec = recordLink(await CapacitorBleLink.request(log), log);
    link = rec.link;
    const s = new WatchSession(link, { log: rec.log });
    const info = await s.open();
    setJob({ title: "Reading workouts", text: "Asking the watch how its sync works" });
    const opts = await s.syncCommandOptions();
    const already = await s.activityCount();
    let start = null;
    let end = null;
    if (already === null) {
      const items = opts?.items ?? [];
      start = items.find((i) => /^(start|begin|request)/i.test(i.name)) ?? null;
      end = items.find((i) => /^(stop|end|finish|complete|done)/i.test(i.name)) ?? null;
      if (!opts || !start) throw new Error(`the watch's sync command has no start option (${items.map((i) => i.name || i.value).join(", ") || "none listed"}); nothing was sent`);
      const text =
        `Tartan will send ${info.name} one command: SyncCommand = ${start.name} (${start.value})` +
        `${end ? `, and afterwards SyncCommand = ${end.name} (${end.value})` : ""}.\n\n` +
        "The Suunto app most likely sends the same when it syncs. This is experimental: the watch could restart (it recovers on its own), and the Suunto app may treat this as a sync.\n\nSend it?";
      if (!confirmCommand(text)) {
        log("[sync] cancelled: nothing was sent");
        return 0;
      }
    }
    setJob({ title: "Reading workouts", text: "Reading the activity log" });
    const sink = local.sink(info.name);
    const n = await s.activitySync(opts!, start, end, (name, data) => sink.put(name, data));
    if (!n) {
      // Nothing came through the activity log: map the rest of the watch's resources (read-only)
      // to find what the Suunto app uses instead. The branches before Message are known.
      setJob({ title: "Reading workouts", text: "Mapping the rest of the watch (about a minute)" });
      await s.mapTree({ from: "Message", force: true });
    }
    await local.saveInfo(info.name, { name: info.name, lastActivityRead: new Date().toISOString() }).catch(() => {});
    notify(n ? `Read ${n} workout entries from the watch. The details are in the activity log.` : "The watch handed over no workouts. Copy the activity log from Settings and send it along.", n ? "info" : "error");
    return n;
  } finally {
    await link?.close().catch(() => {});
    state.connecting = false;
    setJob(null);
    emit();
  }
}

/** Copy everything new under `root`; returns how many files came in. `quiet`: no notice (automatic sync). */
export async function backup(root = "/", force = false, quiet = false): Promise<number> {
  if (!session) throw new Error("Connect the watch first");
  if (state.mode === "logbook") return backupLogbook(quiet);
  abort = new AbortController();
  let files = 0;
  let bytes = 0;
  state.running = true;
  setJob({ title: `Backing up ${root}`, text: "Listing folders" });
  try {
    const res = await mirror(session, root, local.sink(state.name), {
      force,
      signal: abort.signal,
      onEvent: (e) => {
        if (e.kind === "dir") log(`${e.path}: ${e.files} files, ${e.dirs} folders`);
        else if (e.kind === "progress") setJob({ title: `Backing up ${root}`, text: `${files} new · ${e.path} ${fmtBytes(e.bytes)}` });
        else if (e.kind === "file") {
          files++;
          bytes += e.bytes;
          log(`  saved ${e.path} (${fmtBytes(e.bytes)})`);
        } else if (e.kind === "error") log(`  failed ${e.path}: ${e.message}`);
      },
    });
    // The demo watch has a day of health data, as a Run 2 does (read there after its logbook).
    if (state.demo) await saveTrends(session).catch((e) => log(`[trends] ${(e as Error).message}`));
    await local.logEvent({ lane: "watch", kind: "backup", added: res.downloaded, ok: res.failed === 0, detail: state.name });
    await local.saveInfo(state.name, { lastBackup: new Date().toISOString() }).catch(() => {});
    if (!state.demo) noteSync(state.name);
    log(`Watch backup: ${res.downloaded} new (${fmtBytes(res.bytes)}), ${res.skipped} already saved, ${res.failed} failed.`);
    if (!quiet || res.failed)
      notify(
        res.failed ? `${res.failed} ${res.failed === 1 ? "file" : "files"} from the watch didn't come through. The activity log in Settings has why.`
        : res.downloaded ? `Backed up ${res.downloaded} new ${res.downloaded === 1 ? "file" : "files"} from the watch.`
        : "The watch is backed up: nothing new.",
        res.failed ? "error" : "info",
      );
    if (app.remote) await pushToPc().catch((e) => notify(`Sending to the PC failed: ${(e as Error).message}`, "error"));
    if (res.downloaded && !state.demo) void sendToStrava();
    return res.downloaded;
  } finally {
    abort = null;
    state.running = false;
    setJob(null);
  }
}

/**
 * The Run 2: save the workouts its logbook lists (the ones the Suunto app hasn't synced yet).
 * Read-only: Tartan never marks them synced, so the Suunto app still gets every one.
 */
async function backupLogbook(quiet: boolean): Promise<number> {
  const s = session!;
  state.running = true;
  setJob({ title: "Reading workouts", text: "Asking the watch's logbook" });
  try {
    const res = await s.logbookBackup(local.sink(state.name), (id, bytes) => setJob({ title: "Reading workouts", text: `Workout ${id}: ${fmtBytes(bytes)}` }));
    // The watch's 10-minute log (heart rate, blood oxygen, steps): it keeps about a day, so each
    // connection saves what's new (src/health.ts).
    if (!state.demo) {
      setJob({ title: "Reading health", text: "Heart rate, blood oxygen and steps" });
      await saveTrends(s).catch((e) => log(`[trends] ${(e as Error).message}`));
    }
    // Sleep, kept as the watch sends it (to be read once its form is known). 204 is "nothing
    // since then", so after an empty answer for the last three days it's asked for everything.
    if (!state.demo) {
      for (const [label, since] of [["3 days", Date.now() - 3 * 86400_000], ["all", 0]] as const) {
        const sleep = await s.readSleep(since).catch(() => null);
        const got = !!sleep && (sleep.status === 200 || sleep.status === 202 || sleep.status === 100) && sleep.data.length > 20;
        log(`[sleep] ${label}: ${sleep ? `${sleep.status}, ${sleep.data.length} bytes${got ? `: ${Array.from(sleep.data.subarray(14, 78), (b) => b.toString(16).padStart(2, "0")).join("")}` : ""}` : "no answer"}`);
        if (got) {
          await local.sink(state.name).put(`/daily/sleep-${new Date().toISOString().slice(0, 10)}.bin`, sleep.data).catch(() => {});
          break;
        }
      }
    }
    await local.logEvent({ lane: "watch", kind: "backup", added: res.downloaded, ok: res.failed === 0, detail: state.name });
    await local.saveInfo(state.name, { lastBackup: new Date().toISOString() }).catch(() => {});
    if (!state.demo) noteSync(state.name);
    if (!quiet || res.failed) {
      notify(
        res.downloaded
          ? `${res.downloaded} new ${res.downloaded === 1 ? "workout" : "workouts"} from the watch${res.failed ? `; ${res.failed} didn't come through (the activity log in Settings has why)` : ""}.`
          : res.failed
            ? `Watch: ${res.failed} workouts failed to download (see the log in Settings).`
            : `Watch: no new workouts${res.skipped ? `; ${res.skipped} already saved` : ""}. The Suunto app usually takes them within minutes of a workout, so open Tartan first.`,
        res.failed ? "error" : "info",
      );
    }
    if (app.remote) await pushToPc().catch((e) => notify(`Sending to the PC failed: ${(e as Error).message}`, "error"));
    if (res.downloaded && !state.demo) void sendToStrava();
    return res.downloaded;
  } finally {
    state.running = false;
    setJob(null);
  }
}

/** Read the watch's trend log and save the finished records not saved before, as one file. */
async function saveTrends(s: WatchSession): Promise<number> {
  const last = (await app.api.json<{ last_t: number }>("/api/health").catch(() => null))?.last_t ?? 0;
  const read = await s.readTrends(last || Date.now() - 86400_000);
  const fresh = newRecords(read, last);
  if (fresh.length) await local.sink(state.name).put(`${TRENDS_DIR}/${fresh[0]!.t}.json`, new TextEncoder().encode(JSON.stringify(fresh)));
  log(`[trends] saved ${fresh.length} new of ${read.length}`);
  void remindToSync();
  return fresh.length;
}

/**
 * The watch keeps only about a day of its log: if Tartan hasn't read it again by this time
 * tomorrow, a notification says so. Each read moves it on a day; nothing is asked for (no
 * notification permission, no reminder).
 */
async function remindToSync(): Promise<void> {
  if (!isNative) return;
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const ID = 424242;
    await LocalNotifications.cancel({ notifications: [{ id: ID }] }).catch(() => {});
    if ((await LocalNotifications.checkPermissions()).display !== "granted") return;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: ID,
          title: "Your watch is waiting",
          body: "It keeps only a day of heart rate and blood oxygen. Open Tartan to keep it.",
          schedule: { at: new Date(Date.now() + 22 * 3600_000), allowWhileIdle: true },
          isExactNotification: false,
          extra: { tartanSync: true },
        },
      ],
    });
  } catch (e) {
    log(`[trends] reminder: ${(e as Error).message}`);
  }
}

/**
 * Put a route on the watch over Bluetooth (src/protocol/route-send.ts). Connects first when it
 * isn't connected (the paired watch, or the picker), and lets go afterwards if it connected
 * only for this.
 */
export async function sendRoute(
  route: { name: string; line: LngLat[]; elevation?: number[]; waypoints: LngLat[]; named?: Array<{ point: LngLat; name: string }> },
  onProgress?: (text: string) => void,
): Promise<{ id: number; points: number }> {
  if (!canBluetooth()) throw new Error("This device can't reach the watch over Bluetooth");
  const own = !state.connected;
  if (own) {
    onProgress?.("Connecting to the watch…");
    await connect(false, { pairedOnly: await knowsPairedWatch() });
  }
  if (!session || state.demo) throw new Error("Connect your watch first (the demo watch can't take routes)");
  const { points, distance_m } = watchPoints(route.line, { elevation: route.elevation, waypoints: route.waypoints, named: route.named });
  state.running = true;
  setJob({ title: "Sending a route", text: route.name });
  try {
    const res = await session.sendRoute({ name: route.name, points, distance_m }, (p) => {
      const text = p.stage === "checking" ? "Checking the watch…" : p.stage === "saving" ? "Saving on the watch…" : `Sending… ${Math.round(((p.sent ?? 0) / (p.total || 1)) * 100)}%`;
      setJob({ title: "Sending a route", text });
      onProgress?.(text);
    });
    log(`Route "${route.name}" is on the watch as route ${res.id} (${points.length} points, ${fmtBytes(res.bytes)}).`);
    return { id: res.id, points: points.length };
  } finally {
    state.running = false;
    setJob(null);
    if (own) await disconnect().catch(() => {});
  }
}

/** Install a watch face (src/protocol/face-send.ts); connects first if needed, like sendRoute. */
export async function installFace(pkg: FacePackage, onProgress?: (text: string) => void): Promise<{ id: string }> {
  if (!canBluetooth()) throw new Error("This device can't reach the watch over Bluetooth");
  const own = !state.connected;
  if (own) {
    onProgress?.("Connecting to the watch…");
    await connect(false, { pairedOnly: await knowsPairedWatch() });
  }
  if (!session || state.demo) throw new Error("Connect your watch first (the demo watch can't take faces)");
  state.running = true;
  setJob({ title: "Installing a watch face", text: pkg.name });
  try {
    const res = await session.installFace(pkg, (p) => {
      const text = p.stage === "checking" ? "Checking the watch…" : p.stage === "installing" ? "Installing…" : `Sending… ${Math.round(((p.sent ?? 0) / (p.total || 1)) * 100)}%`;
      setJob({ title: "Installing a watch face", text });
      onProgress?.(text);
    });
    log(`Watch face "${pkg.name}" installed as ${res.id} (${fmtBytes(res.bytes)}).`);
    return { id: res.id };
  } finally {
    state.running = false;
    setJob(null);
    if (own) await disconnect().catch(() => {});
  }
}

/** Connect if needed, run `job` with the session, and disconnect again if this connected. */
async function withWatch<T>(title: string, text: string, job: (s: NonNullable<typeof session>) => Promise<T>): Promise<T> {
  if (!canBluetooth()) throw new Error("This device can't reach the watch over Bluetooth");
  const own = !state.connected;
  if (own) await connect(false, { pairedOnly: await knowsPairedWatch() });
  if (!session || state.demo) throw new Error("Connect your watch first (the demo watch has no faces)");
  state.running = true;
  setJob({ title, text });
  try {
    return await job(session);
  } finally {
    state.running = false;
    setJob(null);
    if (own) await disconnect().catch(() => {});
  }
}

/**
 * The coming week's sessions on the watch as guided workouts: Tartan workouts whose day has
 * passed or whose session changed come off, the rest go on (src/workout/from-plan.ts).
 * `sent` is what this phone put there before; the updated record comes back.
 */
/** What this phone put on the watch, by workout id (kept in localStorage). */
const SENT = "freesuunto.workouts.sent";
export const readSent = (): Record<string, SentWorkout> => {
  try {
    return JSON.parse(localStorage.getItem(SENT) ?? "{}") as Record<string, SentWorkout>;
  } catch {
    return {};
  }
};
const writeSent = (v: Record<string, SentWorkout>) => {
  try {
    localStorage.setItem(SENT, JSON.stringify(v));
  } catch {
    // no storage: the next send clears up what it doesn't know
  }
};

export async function putWorkouts(
  wanted: WantedWorkout[],
  today: string,
  onProgress?: (text: string) => void,
): Promise<{ sent: Record<string, SentWorkout>; added: number; removed: number }> {
  const { guidePackage, newWorkoutId } = await import("../src/workout/guide.ts");
  const runner = await workoutRunner();
  return withWatch("Workouts to the watch", "Checking the watch…", async (s) => {
    const onWatch = await s.workoutIds();
    const sent = readSent();
    const { remove, install } = reconcile(onWatch, sent, wanted, today);
    // Forget what's no longer there; the record is saved after every change, so a send that
    // breaks off leaves nothing unknown behind.
    const next: Record<string, SentWorkout> = Object.fromEntries(Object.entries(sent).filter(([id]) => onWatch.includes(id)));
    writeSent(next);
    for (const id of remove) {
      onProgress?.(`Removing ${next[id]?.name ?? "an old workout"}…`);
      await s.removeWorkout(id);
      delete next[id];
      writeSent(next);
    }
    for (const [i, w] of install.entries()) {
      const id = newWorkoutId();
      onProgress?.(`Sending ${w.workout.name} (${i + 1} of ${install.length})…`);
      setJob({ title: "Workouts to the watch", text: w.workout.name });
      await s.installWorkout(id, await guidePackage(w.workout, { runner }));
      next[id] = { date: w.date, key: w.key, name: w.workout.name };
      writeSent(next);
    }
    log(`Workouts on the watch: ${install.length} added, ${remove.length} removed.`);
    return { sent: next, added: install.length, removed: remove.length };
  });
}

/** Put one workout on the watch (a race's pacing): a new Tartan id each time. */
export async function putWorkout(workout: import("../src/workout/guide.ts").Workout, onProgress?: (text: string) => void): Promise<string> {
  const { guidePackage, newWorkoutId } = await import("../src/workout/guide.ts");
  const runner = await workoutRunner();
  return withWatch("Workout to the watch", workout.name, async (s) => {
    const id = newWorkoutId();
    onProgress?.(`Sending ${workout.name}…`);
    await s.installWorkout(id, await guidePackage(workout, { runner }));
    // Pinned: sending the week leaves it alone.
    writeSent({ ...readSent(), [id]: { date: "9999-12-31", key: `pinned:${id}`, name: workout.name, pinned: true } });
    log(`Workout "${workout.name}" on the watch as ${id}.`);
    return id;
  });
}

/**
 * Put a face on the watch in place of the one with its id (the week face, redrawn): the old
 * one comes off first. If it was the face you wore, the watch falls back to another until you
 * pick this one again.
 */
export async function replaceFace(pkg: FacePackage, onProgress?: (text: string) => void): Promise<{ replaced: boolean }> {
  return withWatch("Watch face", pkg.name, async (s) => {
    const ids = await s.faceIds();
    const replaced = ids.includes(pkg.id);
    if (replaced) {
      onProgress?.("Taking last week's off…");
      await s.removeFace(pkg.id);
    }
    await s.installFace(pkg, (p) => onProgress?.(p.stage === "sending" ? `Sending… ${Math.round(((p.sent ?? 0) / (p.total || 1)) * 100)}%` : p.stage === "installing" ? "Installing…" : "Checking the watch…"));
    log(`Week face "${pkg.name}" ${replaced ? "replaced" : "installed"} as ${pkg.id}.`);
    return { replaced };
  });
}

/** The ids of the faces on the watch. */
export const watchFaceIds = () => withWatch("Watch faces", "Reading the list…", (s) => s.faceIds());

/** Remove a face Tartan installed (only Tartan's; the session refuses others). */
export async function removeFace(id: string, name: string): Promise<boolean> {
  const { removed } = await withWatch("Removing a watch face", name, (s) => s.removeFace(id));
  log(removed ? `Watch face "${name}" (${id}) removed from the watch.` : `Watch face "${name}" (${id}) wasn't on the watch.`);
  return removed;
}

/** Phone: copy backups the PC doesn't have yet, so its library and agents see them. */
export async function pushToPc(): Promise<number> {
  const pc = app.remote;
  if (!pc) return 0;
  let sent = 0;
  for (const w of await local.watches()) {
    const sink = pc.sink(w.info.name ?? w.id);
    await pc.saveInfo(w.info.name ?? w.id, w.info);
    for (const f of await local.files(w.id)) {
      if (await sink.has(f.path)) continue;
      await sink.put(f.path, await local.readFile(w.id, f.path));
      sent++;
    }
  }
  if (sent) await pc.logEvent({ lane: "watch", kind: "from-phone", added: sent, ok: true });
  log(`Sent ${sent} new files to the PC.`);
  return sent;
}

export function getState(): WatchState {
  return state;
}

/**
 * A day of the demo watch's 10-minute log: a night's sleep (low, steady heart rate, one
 * restless moment), a morning run, an ordinary day, and two blood-oxygen readings overnight.
 */
function demoTrends(): TrendRecord[] {
  const step = 600_000;
  const end = Math.floor(Date.now() / step) * step;
  const out: TrendRecord[] = [];
  for (let t = end - 26 * 3600_000; t < end; t += step) {
    const d = new Date(t);
    const h = d.getHours() + d.getMinutes() / 60;
    const wave = Math.round(3 * Math.sin(t / 2_700_000));
    const asleep = h >= 23.2 || h < 6.8;
    const run = h >= 7.5 && h < 8.2;
    const restless = Math.abs(h - 2.5) < 0.05;
    if (asleep) out.push({ t, steps: restless ? 40 : 0, energy_j: 0, hr: (h > 2 && h < 4.5 ? 47 : 51) + wave, ...(Math.abs(h - 3) < 0.05 ? { spo2: 96 } : Math.abs(h - 5) < 0.05 ? { spo2: 97 } : {}) });
    else if (run) out.push({ t, steps: 1700, energy_j: 410_000, hr: 146 + wave * 2 });
    else out.push({ t, steps: 30 + Math.abs(wave) * 25, energy_j: 6_000, hr: 72 + wave * 3 });
  }
  return out;
}

function demoFiles(): Record<string, Uint8Array> {
  const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * seed + (i >> 3)) & 0xff);
  const text = (s: string) => new TextEncoder().encode(s);
  return {
    "/logs/demo-log-1.bin": bytes(9000, 7),
    "/logs/demo-log-2.bin": bytes(4200, 11),
    "/sleepln/demo-night.json": text('{"demo":true,"sleep":{"durationMin":452}}'),
    "/settings/demo-user.json": text('{"demo":true,"units":"metric"}'),
    "/zapp/demo.db": bytes(700, 3),
  };
}

/**
 * After a watch sync saved new workouts: send the ones Strava doesn't have, if that's switched
 * on (Settings → Sources). It runs only here, never on a timer; the server checks the switch.
 */
async function sendToStrava(): Promise<void> {
  try {
    const res = await app.api.request("/api/strava/send-watch/run", { method: "POST" });
    const r = (await res.json()) as { enabled: boolean; sent: number; found: number; errors: string[]; blocked?: string };
    if (!r.enabled) return;
    if (r.sent) notify(`Sent ${r.sent} watch ${r.sent === 1 ? "workout" : "workouts"} to Strava.`);
    if (r.blocked) notify(`Not sent to Strava: ${r.blocked}`, "error");
    for (const e of r.errors) log(`Strava upload: ${e}`);
    if (r.errors.length) notify(`${r.errors.length} watch ${r.errors.length === 1 ? "workout" : "workouts"} couldn't go to Strava; Tartan tries again after the next watch sync.`, "error");
  } catch (e) {
    log(`Sending to Strava: ${(e as Error).message}`);
  }
}
