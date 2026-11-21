/**
 * The contract between the native screens (android/…/shell, an iOS port later) and the engine
 * (this page): every call the screens make, what each takes, and the events each side sends.
 * lib/shell.ts implements EngineCalls (`satisfies` it, so a call that drifts is a compile error);
 * EngineResults is what each answers, read off the implementation. test/contract.test.ts checks the
 * Kotlin side calls only what exists here; docs/engine-contract.md is generated from this file
 * (bun scripts/contract-doc.ts).
 *
 * Transport (TartanShellPlugin ↔ startShell): the screens send `api` events {id, method, path,
 * body?, stream?}; a path `rpc:<name>` is one of EngineCalls with the body as its args (JSON), any
 * other path goes to the engine's HTTP API (src/api.ts, the same routes the PC serves). The engine
 * answers with Shell.reply({id, status, body}) (and Shell.chunk for streamed lines); an RPC that
 * throws answers 500 with {error}.
 */
import type { routineOf } from "../../src/strength/exercises.ts";
import type { raceWeek } from "../../src/race-week.ts";
import type { HcKind } from "./health-connect.ts";

/** [longitude, latitude]. */
export type LngLat = [number, number];
/** A choice of none: what an RPC with nothing to say takes. */
type None = Record<string, never>;

/** Every call the native screens make into the engine (rpc:<name>), by what it takes. */
export interface EngineCalls {
  // ---- Settings: preferences kept by the engine
  prefs: None;
  colours: { choice: "tartan" | "wallpaper" };
  weekly: { on: boolean };
  demos: { choice: string };
  /** Reminders and the calendar: Android's notification permission, the calendars it may write. */
  allowReminders: None;
  calendars: None;
  // ---- Strength: a session's exercises with their doses
  routine: { exercises?: Parameters<typeof routineOf>[0]; minutes?: number };
  exercises: None;
  /** The 3D body (lib/body3d.ts) as WebP frames: an exercise's move, or muscles lit. */
  body: { key?: string; exercise?: string; primary?: string[]; secondary?: string[]; width?: number; height?: number; loop?: number; turn?: number };
  restNote: { at?: number; next?: string };
  // ---- The watch over Bluetooth (web/watch.ts)
  watchConnect: None;
  watchBackup: { path?: string; force?: boolean };
  watchDisconnect: None;
  watchCancel: None;
  watchBrowse: { path?: string };
  watchSaveOne: { path: string };
  /** The coming 7 days as guided workouts; with send, send them. */
  watchWeek: { send?: boolean };
  fuel: { set?: Partial<{ drink: boolean; drinkMin: number; gel: boolean; gelMin: number }> };
  // ---- The plan on other watches (lib/plan-out.ts): intervals.icu (Garmin…), Health Connect (Samsung, Pixel…), .fit files
  /** Where the coming week can go besides a Suunto, and how each stands; an op sends, stops or shares. */
  planOut: { op?: "state" | "intervals" | "intervalsOff" | "hc" | "hcOff" | "files" };
  /** One session as a .fit workout file through the share sheet. */
  sessionFile: { date: string; kind: string };
  runner: { set?: "suunto" | "tartan" };
  // ---- Strava
  stravaSync: { full?: boolean };
  stravaConnect: { clientId?: string; clientSecret?: string };
  openUrl: { url: string };
  // ---- Files and Health Connect
  importFit: { name: string; data: string };
  hc: { op?: "state" | "toggle" | "connect" | "share" | "manage" | "stop"; kind?: HcKind; remove?: boolean };
  /** Apple Health on iPhone, read only: its state; connect, bring in now, open the Health app, stop. */
  ah: { op?: "state" | "connect" | "sync" | "open" | "stop" };
  saveFile: { path: string; name: string; type: string };
  // ---- The PC: pairing and syncing (lib/pairing.ts)
  pcState: None;
  pcPair: { urls: string; code: string };
  pcSync: None;
  pcUnpair: None;
  pairCheck: { urls: string[] };
  pairConnect: { urls: string[]; code: string };
  pairSync: None;
  scanPair: None;
  reopen: None;
  // ---- The coach on the phone
  /** Model Hub (lib/modelhub.ts): its state, Android's permission prompt, opening it or its Updates. */
  /** With "dropOld", Tartan's own model file from before 2.37 goes (Model Hub holds the models now). */
  modelHub: { op?: "state" | "allow" | "open" | "updates" | "dropOld" };
  // ---- Watch faces (lib/faces.ts, lib/face-install.ts)
  faces: { size?: number };
  faceInstall: { id: string; builtin?: boolean };
  facesOnWatch: None;
  faceRemove: { id: string; name: string };
  faceStart: { arg: string; size?: number };
  facePreview: { design: unknown; size?: number; data?: boolean };
  faceSurprise: { id: string };
  faceSave: { design: unknown; saved: boolean };
  facePackage: { id: string };
  weekFace: { base?: string; keep?: boolean; send?: boolean; size?: number };
  // ---- Backups, the intro, diagnostics
  backup: { op?: "state" | "setPass" | "now" | "weekly" | "change" | "restore"; pass?: string; on?: boolean; name?: string; data?: string };
  replayIntro: None;
  introStep: { step: number };
  introDone: { reload?: boolean };
  demo: { op?: "start" | "leave" | "state" };
  recorder: { op?: "state" | "arm" | "cancel" | "share" };
  log: None;
  syncSchedule: None;
  // ---- Routes (lib/routing.ts, src/routes.ts, src/race-pace.ts)
  routePath: { a: LngLat; b: LngLat };
  routeHeights: { line: LngLat[] };
  routeLoops: { start: LngLat; km: number };
  routeToWatch: { name: string; line: LngLat[]; waypoints: unknown[] };
  routeGpx: { id: string };
  racePacing: { line: LngLat[]; elevation?: number[] | null; time: string };
  courseToWatch: { name: string; line: LngLat[]; marks: Array<{ point: LngLat; name: string }> };
  splitsToWatch: { name: string; splits: unknown };
  raceWeek: { race: Parameters<typeof raceWeek>[0] };
  pacingToWatch: { name: string; distance_km: number; time_s: number };
  // ---- Recording a run on the phone (web/recorder.ts)
  recStart: None;
  recPause: None;
  recResume: None;
  recFinish: None;
  recKeep: { name?: string; strava?: boolean };
  recDiscard: None;
  recUpload: { id: string };
  recHeart: None;
  recCues: { on?: boolean };
  /** Guide today's planned session when a run starts (on or off, with `on`): whether, and the session. */
  recGuide: { on?: boolean };
  /** A guided run: on to the next step now. */
  recLap: None;
}

/** What implements EngineCalls: one async handler per call, taking its args. */
export type EngineHandlers = { [K in keyof EngineCalls]: (a: EngineCalls[K]) => Promise<unknown> };

/**
 * What the engine tells the native screens (the TartanShell plugin's methods). The screens answer
 * none of these except `parts`, `configure`, `scan` (the text read) and the replies' acks.
 */
export interface ScreenCalls {
  parts: None;
  configure: { colours?: string };
  /** Where the app is: the view, the address, whether something of the page's is open. */
  route: { view: string; hash: string; hidden: boolean; colours: string };
  reply: { id: string; status: number; body: string };
  chunk: { id: string; line: string };
  chat: { conversation?: string | null; prefill?: string };
  workout: { id: string };
  /** The sync board's lanes, for the chip and its sheet. */
  board: { lanes: Array<{ id: string; state: string; text: string; glyph: string; name: string; status: string; failed: boolean }> };
  /** State pushed on every change (JSON strings, parsed natively). */
  watch: { state: string };
  recorder: { state: string };
  intro: { step: number };
  snack: { id: number; text: string; error: boolean; action?: string; ms?: number };
  pair: { urls: string[]; code: string; ask: boolean };
  scan: { hint: string };
  feel: { kind: "detent" | "click" | "confirm" };
  changed: None;
  leave: None;
}

/** What the native screens tell the engine (plugin events the page listens to). */
export interface ScreenEvents {
  /** Go somewhere (an address), or an action: board, laneSync, chat, sync. */
  go: { hash: string; activity?: string; session?: string; kind?: string; action?: string; conversation?: string; prefill?: string; lane?: string };
  back: None;
  api: { id: string; method: string; path: string; body?: string; stream?: boolean };
  /** A snackbar's action was tapped. */
  snack: { id: number };
  /** A native screen is (or isn't) showing: the page goes see-through. */
  screen: { native: boolean };
  parts: Record<string, boolean>;
}
