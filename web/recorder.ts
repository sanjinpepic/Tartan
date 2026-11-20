/**
 * Recording a run with the phone: GPS (kept alive with the screen off by a foreground service
 * in the app, plain browser geolocation elsewhere) and, optionally, heart rate from any
 * Bluetooth heart-rate sensor. The run is saved every few seconds, so a closed app loses
 * almost nothing, and an unfinished run is offered again on the next start.
 */
import { BleClient } from "@capacitor-community/bluetooth-le";
import { registerPlugin } from "@capacitor/core";
import type { BackgroundGeolocationPlugin, Location } from "@capacitor-community/background-geolocation";
import { speedNow, summarize, track, type RecordedPoint, type Recording, type RecordingSummary } from "../src/recording.ts";
import { Guide, isStructured, type GuideProgress, type GuideView } from "../src/workout/guided.ts";
import { app, isNative, log } from "./state.ts";
import { kmCue, kmsPassed } from "../src/cues.ts";
import { paceRange, plannedWeek } from "../src/workout/from-plan.ts";
import { sportOf } from "../src/workout/export.ts";
import type { PlanView } from "./types.ts";

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation");
const HRS = "0000180d-0000-1000-8000-00805f9b34fb";
const HR_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb";
const ACTIVE = "freesuunto.recording";

export type RecStatus = "idle" | "recording" | "paused" | "finished";
export interface RecState {
  status: RecStatus;
  rec: Recording | null;
  summary: RecordingSummary | null;
  /** Latest GPS accuracy (m); undefined until the first fix. */
  accuracy?: number;
  gpsError?: string;
  hr?: { bpm?: number; name: string; at: number };
  /** A guided run: the step it's on, what's left of it, what comes next. */
  guide?: GuideView | null;
}

const state: RecState = { status: "idle", rec: null, summary: null };
const listeners = new Set<(s: RecState) => void>();
let stopGps: (() => Promise<void>) | null = null;
let hrDevice: string | null = null;
let saveTimer: ReturnType<typeof setInterval> | null = null;

// ------------------------------------------------------------------ spoken cues

const CUES = "freesuunto.cues";
/** Spoken kilometre cues, on unless switched off. */
export function cuesOn(): boolean {
  try {
    return localStorage.getItem(CUES) !== "off";
  } catch {
    return true;
  }
}
export function setCues(on: boolean): void {
  try {
    if (on) localStorage.removeItem(CUES);
    else localStorage.setItem(CUES, "off");
  } catch {
    // not remembered
  }
}
let cueDist = 0;
let cueMoving = 0;
let cueTarget: [number, number] | null = null;

async function speak(text: string): Promise<void> {
  if (!cuesOn()) return;
  try {
    if (isNative) {
      const { TextToSpeech, QueueStrategy } = await import("@capacitor-community/text-to-speech");
      await TextToSpeech.speak({ text, lang: "en-GB", rate: 1.0, category: "playback", queueStrategy: QueueStrategy.Add });
    } else if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch (e) {
    log(`Spoken cue failed: ${(e as Error).message}`);
  }
}

/** Today's run target pace from the plan, for "on pace" cues. */
async function todaysTarget(): Promise<[number, number] | null> {
  const v = await app.api.json<PlanView>("/api/plan").catch(() => null);
  const s = v?.weeks.flatMap((w) => w.days).find((d) => d.date === v.today)?.sessions.find((x) => x.kind !== "rest" && x.kind !== "strength");
  return paceRange(s?.target) ?? null;
}

// ------------------------------------------------------------------ guided runs (src/workout/guided.ts)

const GUIDE = "freesuunto.guide";
/** Guide today's planned session when a run starts: on unless switched off. */
export function guideOn(): boolean {
  try {
    return localStorage.getItem(GUIDE) !== "off";
  } catch {
    return true;
  }
}
export function setGuide(on: boolean): void {
  try {
    if (on) localStorage.removeItem(GUIDE);
    else localStorage.setItem(GUIDE, "off");
  } catch {
    // not remembered
  }
}
let guide: Guide | null = null;
let guideTimer: ReturnType<typeof setInterval> | null = null;

/** Today's planned run as a workout (not done yet), or null: what a guided run follows. */
export async function todaysSession(date?: string, kind?: string): Promise<{ date: string; kind: string; workout: import("../src/workout/guide.ts").Workout } | null> {
  const v = await app.api.json<PlanView>("/api/plan").catch(() => null);
  if (!v?.plan) return null;
  const { readFuel } = await import("./lib/watch-workouts.ts");
  const list = plannedWeek(v, readFuel(), 1).filter((p) => sportOf(p.kind) === "running" && (!date || (p.date === date && p.kind === kind)));
  return list[0] ? { date: list[0].date, kind: list[0].kind, workout: list[0].workout } : null;
}

/** Moving seconds so far: the clock less the pauses (it runs between GPS fixes too). */
function activeSeconds(now = Date.now()): number {
  const r = state.rec;
  if (!r) return 0;
  const end = r.end ? Date.parse(r.end) : now;
  const paused = r.pauses.reduce((n, p) => n + ((p.to ?? end) - p.from), 0);
  return Math.max(0, (end - Date.parse(r.start) - paused) / 1000);
}

function progress(): GuideProgress {
  const speed = state.rec ? speedNow(track(state.rec)) : 0;
  const hr = state.hr?.bpm && Date.now() - state.hr.at < 5000 ? state.hr.bpm : undefined;
  return { active_s: activeSeconds(), distance_m: state.summary?.distance_m ?? 0, ...(hr ? { hr } : {}), ...(speed > 0.5 ? { pace_s: 1000 / speed } : {}) };
}

/** Follow a guide: its state kept in the recording (a reopened run carries on), a tick every second. */
function useGuide(g: Guide | null): void {
  guide = g;
  if (guideTimer) clearInterval(guideTimer);
  guideTimer = g ? setInterval(tickGuide, 1000) : null;
}

/** A reading for the guide: say what it says, mark a lap where a step begins, keep its place. */
function tickGuide(said?: string[]): void {
  if (!guide || !state.rec?.guide || state.status !== "recording") return;
  const [before, wasDone] = [guide.state.at, guide.state.done];
  const words = said ?? guide.update(progress());
  // A lap where each step begins, and one for the running after the session.
  if (guide.state.at !== before || guide.state.done !== wasDone) (state.rec.laps ??= []).push(Date.now());
  state.rec.guide.state = guide.state;
  for (const w of words) void speak(w);
  state.guide = guide.view(progress());
  listeners.forEach((f) => f(state));
}

/** Next step, by hand (a rep cut short, a recovery you don't need). */
export function nextStep(): void {
  if (!guide || state.status !== "recording") return;
  tickGuide(guide.skip(progress()));
  void save();
}

/** Start guiding today's session in the run just started (when there is one and guiding is on). */
async function startGuide(): Promise<void> {
  const s = guideOn() ? await todaysSession() : null;
  if (!s || !state.rec || state.status === "idle" || state.status === "finished") return;
  const g = new Guide(s.workout);
  const words = g.begin(progress());
  state.rec.guide = { date: s.date, kind: s.kind, name: s.workout.name, state: g.state };
  useGuide(g);
  tickGuide(words);
}

/** After each fix: a cue for every kilometre just completed. */
function cueKilometres(): void {
  const sum = state.summary;
  if (!sum || state.status !== "recording") return;
  // A structured session talks the runner through it: kilometres stay quiet until it's done.
  if (guide && isStructured(guide.workout) && !guide.state.done) return void (cueDist = sum.distance_m);
  for (const km of kmsPassed(cueDist, sum.distance_m)) {
    void speak(kmCue(km, sum.moving_s - cueMoving, sum.moving_s, { hr: state.hr?.bpm, target: cueTarget }));
    cueMoving = sum.moving_s;
  }
  cueDist = sum.distance_m;
}

export function onRecorder(f: (s: RecState) => void): () => void {
  listeners.add(f);
  f(state);
  return () => listeners.delete(f);
}
const emit = () => {
  state.summary = state.rec ? summarize(state.rec) : null;
  state.guide = guide && state.rec ? guide.view(progress()) : null;
  listeners.forEach((f) => f(state));
};

const save = async () => {
  if (!state.rec) return;
  await app.api
    .request(`/api/recordings/${state.rec.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(state.rec) })
    .catch((e) => log(`Saving the recording failed: ${(e as Error).message}`));
};

function onFix(p: RecordedPoint): void {
  state.accuracy = p.acc;
  state.gpsError = undefined;
  if (state.status !== "recording" || !state.rec) return emit();
  const last = state.rec.points.at(-1);
  if (last && p.t <= last.t) return;
  if (state.hr?.bpm && Date.now() - state.hr.at < 5000) p.hr = state.hr.bpm;
  state.rec.points.push(p);
  emit();
  cueKilometres();
  tickGuide();
}

async function startGps(): Promise<void> {
  if (isNative) {
    const id = await BackgroundGeolocation.addWatcher(
      { backgroundTitle: "Recording your run", backgroundMessage: "Tartan keeps recording with the screen off. Tap to return.", requestPermissions: true, stale: false, distanceFilter: 0 },
      (loc?: Location, err?: { code?: string; message: string }) => {
        if (err) {
          state.gpsError = err.code === "NOT_AUTHORIZED" ? "Location permission is off. Allow it for Tartan in Android settings." : err.message;
          return emit();
        }
        if (loc) onFix({ t: loc.time ?? Date.now(), lat: loc.latitude, lon: loc.longitude, alt: loc.altitude, acc: Math.round(loc.accuracy) });
      },
    );
    stopGps = () => BackgroundGeolocation.removeWatcher({ id });
    return;
  }
  if (!("geolocation" in navigator)) throw new Error("This browser has no GPS access");
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix({ t: pos.timestamp || Date.now(), lat: pos.coords.latitude, lon: pos.coords.longitude, alt: pos.coords.altitude, acc: Math.round(pos.coords.accuracy) }),
    (e) => {
      state.gpsError = e.code === e.PERMISSION_DENIED ? "Location permission is off for this site." : e.message;
      emit();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
  );
  stopGps = async () => navigator.geolocation.clearWatch(id);
}

async function stopEverything(): Promise<void> {
  await stopGps?.().catch(() => {});
  stopGps = null;
  if (saveTimer) clearInterval(saveTimer);
  saveTimer = null;
  useGuide(null);
  try {
    localStorage.removeItem(ACTIVE);
  } catch {
    // no storage
  }
}

export async function start(sport = "Run"): Promise<void> {
  if (state.status === "recording" || state.status === "paused") return;
  const now = new Date();
  const hour = now.getHours();
  const part = hour < 11 ? "Morning" : hour < 14 ? "Lunch" : hour < 18 ? "Afternoon" : "Evening";
  state.rec = { id: `rec-${now.getTime().toString(36)}`, sport, name: `${part} ${sport.toLowerCase()}`, start: now.toISOString(), points: [], hr: [], pauses: [] };
  state.status = "recording";
  try {
    localStorage.setItem(ACTIVE, state.rec.id);
  } catch {
    // resuming after a crash just won't be offered
  }
  emit();
  [cueDist, cueMoving] = [0, 0];
  void todaysTarget().then((t) => (cueTarget = t));
  void speak("Recording.");
  void startGuide().catch((e) => log(`Guided run: ${(e as Error).message}`));
  await startGps();
  await save();
  saveTimer = setInterval(() => void save(), 10_000);
}

export function pause(): void {
  if (state.status !== "recording" || !state.rec) return;
  state.rec.pauses.push({ from: Date.now() });
  state.status = "paused";
  emit();
  void speak("Paused.");
  void save();
}

export function resume(): void {
  if (state.status !== "paused" || !state.rec) return;
  const p = state.rec.pauses.at(-1);
  if (p && p.to === undefined) p.to = Date.now();
  state.status = "recording";
  emit();
  void speak("Resumed.");
  void save();
}

export async function finish(): Promise<void> {
  if (!state.rec || (state.status !== "recording" && state.status !== "paused")) return;
  const now = Date.now();
  const p = state.rec.pauses.at(-1);
  if (p && p.to === undefined) p.to = now;
  state.rec.end = new Date(now).toISOString();
  state.status = "finished";
  await stopEverything();
  await stopHeartRate();
  emit();
  await save();
}

/** Keep the finished run, optionally renamed. */
export async function keep(name?: string): Promise<string | null> {
  if (!state.rec) return null;
  if (name?.trim()) state.rec.name = name.trim().slice(0, 80);
  await save();
  const id = state.rec.id;
  reset();
  return id;
}

export async function discard(): Promise<void> {
  if (state.rec) await app.api.request(`/api/recordings/${state.rec.id}`, { method: "DELETE" }).catch(() => {});
  await stopEverything();
  await stopHeartRate();
  reset();
}

function reset(): void {
  Object.assign(state, { status: "idle", rec: null, summary: null, accuracy: undefined, gpsError: undefined });
  emit();
}

export function getRecorder(): RecState {
  return state;
}

/** After a restart: a run that was still going is reopened, paused, so it can go on or be finished. */
export async function restoreUnfinished(): Promise<void> {
  let id: string | null = null;
  try {
    id = localStorage.getItem(ACTIVE);
  } catch {
    return;
  }
  if (!id || state.rec) return;
  const r = await app.api.json<{ recording: Recording }>(`/api/recordings/${id}`).catch(() => null);
  if (!r?.recording || r.recording.end) return void localStorage.removeItem(ACTIVE);
  state.rec = r.recording;
  const last = state.rec.pauses.at(-1);
  if (!last || last.to !== undefined) state.rec.pauses.push({ from: state.rec.points.at(-1)?.t ?? Date.now() });
  state.status = "paused";
  emit();
  // Cues carry on from where the run got to, without repeating the kilometres already done.
  [cueDist, cueMoving] = [state.summary?.distance_m ?? 0, state.summary?.moving_s ?? 0];
  void todaysTarget().then((t) => (cueTarget = t));
  // A guided run carries on at the step it was on.
  const g = state.rec.guide;
  if (g) {
    const s = await todaysSession(g.date, g.kind).catch(() => null);
    if (s) {
      useGuide(new Guide(s.workout, g.state));
      emit();
    }
  }
  await startGps().catch(() => {});
  saveTimer = setInterval(() => void save(), 10_000);
}

// ------------------------------------------------------------------ heart rate (any Bluetooth HR sensor)

/** Pick a heart-rate sensor (a chest strap, or a watch sharing its heart rate) and follow it. */
export async function connectHeartRate(): Promise<void> {
  await BleClient.initialize({ androidNeverForLocation: true });
  const device = await BleClient.requestDevice({ services: [HRS] });
  await BleClient.connect(device.deviceId, () => {
    if (state.hr) state.hr = { ...state.hr, bpm: undefined };
    hrDevice = null;
    emit();
  });
  hrDevice = device.deviceId;
  state.hr = { name: device.name ?? "Heart-rate sensor", at: Date.now() };
  await BleClient.startNotifications(device.deviceId, HRS, HR_MEASUREMENT, (v: DataView) => {
    const flags = v.getUint8(0);
    const bpm = flags & 1 ? v.getUint16(1, true) : v.getUint8(1);
    if (!bpm) return;
    state.hr = { name: state.hr?.name ?? "Heart-rate sensor", bpm, at: Date.now() };
    if (state.status === "recording" && state.rec) (state.rec.hr ??= []).push({ t: Date.now(), bpm });
    emit();
  });
  emit();
}

export async function stopHeartRate(): Promise<void> {
  if (!hrDevice) return;
  const id = hrDevice;
  hrDevice = null;
  await BleClient.stopNotifications(id, HRS, HR_MEASUREMENT).catch(() => {});
  await BleClient.disconnect(id).catch(() => {});
  state.hr = undefined;
}
