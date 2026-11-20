/**
 * Tartan 2 (the tartan-2 branch): native Compose screens over the web app, one at a time.
 * TartanShellPlugin draws the floating bar and native Today on top of this WebView; the web app
 * still runs everything else and answers the native screens' API calls (the same /api routes,
 * through `app.api`, so the phone's own data or a paired PC's). Settings → More → Tartan 2 turns
 * each native part on or off, so the two can be compared on the same phone.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { app, isNative } from "../state.ts";
import { allowReminders, syncSchedule, writableCalendars } from "./schedule.ts";
import { saveFile } from "./files.ts";
import { WEEKLY_OFF } from "./weekly.ts";
import { demoChoice, setDemoChoice } from "./demo-body.ts";
import pkg from "../../package.json";
import type { PlanView } from "../types.ts";
import { tick, thud } from "./haptics.ts";
import { onDataChanged } from "./read-cache.ts";
import { syncAllNow, syncStravaNow, syncWatchNow } from "../sync.ts";
import { colourChoice, setColourChoice } from "./theme.ts";
import { demoBody } from "./demo-body.ts";
import type { HcKind } from "./health-connect.ts";
import type { EngineCalls, EngineHandlers } from "./contract.ts";
import { MUSCLE_NAME, doseText, musclesOf, routineOf } from "../../src/strength/exercises.ts";
import { evenSplits, raceWeek } from "../../src/race-week.ts";

export interface ShellParts {
  /** The floating bar, native. */
  nav: boolean;
  /** Today, native. */
  today: boolean;
  /** Coach (with a plan), native. */
  coach: boolean;
  /** The coach's chat, native. */
  chat: boolean;
  /** Activities (the workouts; Routes stay the page's), native. */
  activities: boolean;
  /** Progress, native. */
  progress: boolean;
  /** Settings, every group, native. */
  settings: boolean;
  /** A workout's sheet, native. */
  workout: boolean;
  /** Body (muscles, sleep and vitals), native. */
  body: boolean;
  /** Routes and the route editor, native. */
  routes: boolean;
  /** Record (a run on the phone) and Lift (a strength session as you do it), native. */
  record: boolean;
}

interface ShellPlugin {
  parts(): Promise<ShellParts & { available: boolean }>;
  configure(o: Partial<ShellParts> & { colours?: string }): Promise<ShellParts>;
  route(o: { view: string; hash: string; hidden: boolean; colours: string }): Promise<void>;
  reply(o: { id: string; status: number; body: string }): Promise<void>;
  /** One line of a streamed answer (NDJSON), as it comes. */
  chunk(o: { id: string; line: string }): Promise<void>;
  chat(o: { conversation?: string | null; prefill?: string }): Promise<void>;
  workout(o: { id: string }): Promise<{ native: boolean }>;
  watch(o: { state: string }): Promise<void>;
  recorder(o: { state: string }): Promise<void>;
  intro(o: { step: number }): Promise<void>;
  snack(o: { id: number; text: string; error: boolean; action?: string; ms?: number }): Promise<void>;
  pair(o: { urls: string[]; code: string; ask: boolean }): Promise<void>;
  scan(o: { hint: string }): Promise<{ text: string | null }>;
  feel(o: { kind: "detent" | "click" | "confirm" }): Promise<void>;
  leave(): Promise<void>;
  changed(): Promise<void>;
  board(o: { lanes: ShellLane[] }): Promise<void>;
  addListener(event: "go", fn: (e: { hash: string; activity?: string; session?: string; kind?: string; action?: string; conversation?: string; prefill?: string; lane?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "back", fn: () => void): Promise<PluginListenerHandle>;
  addListener(event: "snack", fn: (e: { id: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "parts", fn: (e: ShellParts) => void): Promise<PluginListenerHandle>;
  addListener(event: "screen", fn: (e: { native: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(event: "api", fn: (e: { id: string; method: string; path: string; body?: string; stream?: boolean }) => void): Promise<PluginListenerHandle>;
}

const Shell = registerPlugin<ShellPlugin>("TartanShell");
const has = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("TartanShell");
/** Settles once startShell knows which parts are native (or that none are). */
let markReady = () => {};
const ready = new Promise<void>((r) => (markReady = r));

let parts: ShellParts = { nav: false, today: false, coach: false, chat: false, activities: false, progress: false, settings: false, workout: false, body: false, routes: false, record: false };
let view = "today";

/**
 * What the native bar needs to hide for: the keyboard, or a sheet or dialog over the page (or the
 * web's intro, which iPhone shows: Android's is native). On iPhone the page then comes on top of
 * the native screen, see-through, so what it opened shows.
 */
const hidden = () => document.documentElement.classList.contains("kb-open") || !!document.querySelector("dialog[open], .onboard");

function mark(): void {
  document.documentElement.classList.toggle("native-nav", parts.nav);
}

/** Tell the native side where the web app is (after each route, and when a sheet or the keyboard comes or goes). */
export function shellRoute(id = view): void {
  view = id;
  if (!has) return;
  void Shell.route({ view, hash: location.hash.slice(1), hidden: hidden(), colours: colourChoice() }).catch(() => {});
}

/**
 * A click you feel: the same short, deep one as the native bar (Android's low tick) where Tartan 2
 * runs; else the app's usual haptics.
 */
export function feel(kind: "detent" | "click" | "confirm"): void {
  if (has) void Shell.feel({ kind }).catch(() => {});
  else if (kind === "detent") tick();
  else thud();
}

/** A lane of the sync board as the web chip shows it, for native Today's copy of the chip. */
export interface ShellLane {
  id: string;
  state: string;
  text: string;
  glyph: string;
  /** For the board's sheet: the source, its line in words (when, or what went wrong and what to try). */
  name: string;
  status: string;
  failed: boolean;
}

let lastBoard = "";
export function shellBoard(lanes: ShellLane[]): void {
  if (!has) return;
  const said = JSON.stringify(lanes);
  if (said === lastBoard) return;
  lastBoard = said;
  void Shell.board({ lanes }).catch(() => {});
}

/** The chat is native: where to open it (a conversation, null for a new one; words to start with). False when it isn't. */
export function shellChat(o: { conversation?: string | null; prefill?: string }): boolean {
  if (!has || !parts.chat) return false;
  void Shell.chat(o).catch(() => {});
  return true;
}

/** A workout's sheet is native: open it there. False when it isn't (the page opens its own). */
export function shellWorkout(id: string): boolean {
  if (!has || !parts.workout) return false;
  void Shell.workout({ id }).catch(() => {});
  return true;
}

/**
 * The web's own screens, when the app has them (the PC's, set by web/app.ts): what a native
 * screen asks for goes to them instead. The phone's engine-only build has none.
 */
export const webUi: {
  openActivity?: (id: string) => unknown;
  openPlanSession?: (date: string, kind?: string) => Promise<boolean>;
  openChat?: (o: { conversation?: string | null; prefill?: string; focus?: boolean }) => void;
} = {};

/** The PC's pairing link (its QR code, scanned or opened): the native sheet takes it, when Settings is native. */
export async function shellPair(urls: string[], code: string, ask: boolean): Promise<boolean> {
  if (!has) return false;
  await ready;
  if (!parts.settings) return false;
  return Shell.pair({ urls, code, ask }).then(() => true, () => false);
}

/** A QR code read with the native scanner; undefined when there is none (the page's own then). */
export async function shellScan(hint: string): Promise<string | null | undefined> {
  if (!has) return undefined;
  await ready;
  if (!parts.settings) return undefined;
  return Shell.scan({ hint }).then((r) => r.text ?? null, () => undefined);
}

/** The intro, native (Today native too): true when it opened there. */
export async function shellIntro(step: number): Promise<boolean> {
  if (!has) return false;
  await ready;
  if (!parts.today) return false;
  return Shell.intro({ step }).then(() => true, () => false);
}

export function shellAvailable(): boolean {
  return has;
}

export function shellParts(): ShellParts {
  return parts;
}

export async function setShellParts(p: Partial<ShellParts>): Promise<void> {
  if (!has) return;
  parts = await Shell.configure({ ...p, colours: colourChoice() });
  mark();
  shellRoute();
}

const TABS = ["today", "coach", "activities", "trends"];
/** The tab a screen opens from (a chat from Coach, a route from Activities…). */
const PARENT: Record<string, string> = { chat: "coach", route: "activities", routes: "activities", lift: "today", you: "today", record: "today", face: "settings", settings: "today" };

/**
 * Back, the Android way: an open sheet closes; the keyboard goes; a screen opened from a tab
 * returns to it; any other tab goes to Today; Today leaves the app.
 */
function onBack(): void {
  const sheets = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
  const top = sheets.at(-1);
  if (top) {
    // Its own way out (the sheet's slide down), as Escape would.
    const d = top as HTMLDialogElement & { requestClose?: () => void };
    if (d.requestClose) d.requestClose();
    else d.close();
    return;
  }
  const field = document.activeElement as HTMLElement | null;
  if (document.documentElement.classList.contains("kb-open") && field?.blur) {
    field.blur();
    return;
  }
  const v = (location.hash.slice(1).split("/")[0] || "today").replace(/^plan$/, "coach").replace(/^sync$/, "settings");
  if (v === "today") void Shell.leave().catch(() => {});
  else if (TABS.includes(v)) location.hash = "today";
  else if (v === "settings" && location.hash.includes("/")) location.hash = "settings";
  else location.hash = PARENT[v] ?? "today";
}

declare const BUILD_ID: string;

/**
 * What only the page can do, for the native screens: Android's permission prompts and the
 * calendar list through the page's plugins, saving a file through its share sheet, and the
 * choices it keeps in its own storage. Asked as `rpc:<name>` over the API bridge.
 */
const RPC = {
  prefs: async () => ({ colours: colourChoice(), weekly: localStorage.getItem(WEEKLY_OFF) !== "1", demos: demoChoice(), version: pkg.version, build: typeof BUILD_ID === "string" ? BUILD_ID : "dev", paired: !!app.link }),
  colours: async (a) => setColourChoice(a.choice === "tartan" ? "tartan" : "wallpaper"),
  weekly: async (a) => (a.on ? localStorage.removeItem(WEEKLY_OFF) : localStorage.setItem(WEEKLY_OFF, "1")),
  demos: async (a) => setDemoChoice(String(a.choice) as Parameters<typeof setDemoChoice>[0]),
  allowReminders: async () => allowReminders(),
  calendars: async () => writableCalendars(),
  /** A strength session's exercises in order, with how much of each and what they work (src/strength). */
  routine: async (a) => {
    const items = routineOf(a.exercises as Parameters<typeof routineOf>[0], a.minutes as number | undefined);
    const m = musclesOf(items);
    return {
      basic: !(a.exercises as unknown[] | undefined)?.length,
      primary: m.primary,
      secondary: m.secondary,
      names: MUSCLE_NAME,
      items: items.map(({ ex, dose }) => ({ id: ex.id, name: ex.name, kind: ex.kind, equipment: ex.equipment ?? null, dose: doseText(dose), cues: ex.cues, why: ex.why, primary: ex.primary, secondary: ex.secondary })),
    };
  },
  // ---------------------------------------------------------------- Sources (Settings)
  watchConnect: async () => (await import("../watch.ts")).connect().then(() => true),
  watchBackup: async (a) => (await import("../watch.ts")).backup(String(a.path ?? "/"), !!a.force),
  watchDisconnect: async () => (await import("../watch.ts")).disconnect().then(() => true),
  watchCancel: async () => ((await import("../watch.ts")).cancel(), true),
  watchBrowse: async (a) => (await import("../watch.ts")).browse(String(a.path ?? "/")).then(() => true),
  watchSaveOne: async (a) => (await import("../watch.ts")).saveOne(String(a.path)).then(() => true),
  /** A Strava sync by hand: what it did, line by line, and how many came in. */
  stravaSync: async (a) => {
    const { stravaSync } = await import("../sync.ts");
    const lines: string[] = [];
    const result = await stravaSync(!!a.full, (l) => lines.push(l));
    return { lines, result };
  },
  /** Start Strava's sign-in (with your API app's ID and secret, or none to add upload access): its page opens. */
  stravaConnect: async (a) => {
    const res = await app.api.request("/api/strava/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a.clientId ? { clientId: a.clientId, clientSecret: a.clientSecret } : {}) });
    const body = (await res.json()) as { authorizeUrl?: string; error?: string };
    if (!body.authorizeUrl) throw new Error(body.error ?? "Could not start the Strava connection.");
    const { openStravaConsent } = await import("../sync.ts");
    await openStravaConsent(body.authorizeUrl);
    return { url: body.authorizeUrl };
  },
  openUrl: async (a) => {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url: String(a.url) });
    return true;
  },
  /** A .fit file from another watch or app (src/import.ts), as base64. */
  importFit: async (a) => {
    const bytes = Uint8Array.from(atob(String(a.data)), (c) => c.charCodeAt(0));
    const res = await app.api.request("/api/import/fit", { method: "POST", headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(String(a.name)) }, body: bytes });
    const r = (await res.json()) as { already?: boolean; error?: string };
    if (!res.ok) throw new Error(r.error ?? `${a.name}: ${res.status}`);
    return r;
  },
  /** Health Connect (lib/health-connect.ts): its state, and each thing you can do with it. */
  hc: async (a) => {
    const hc = await import("./health-connect.ts");
    const op = String(a.op ?? "state");
    let note: string | null = null;
    if (op === "toggle") {
      const kind = String(a.kind) as HcKind;
      const s = hc.readHc();
      const kinds = { ...s.kinds, [kind]: !s.kinds[kind] };
      hc.writeHc({ ...s, kinds });
      if (s.on && kinds[kind]) await hc.connectHc(kinds);
    } else if (op === "connect") {
      const got = await hc.connectHc();
      if (!got.length) throw new Error("Nothing was allowed. Tap Connect again and allow what you want to share.");
      const last = await hc.syncHc(true);
      note = last?.error ? `Health Connect: ${last.error}` : `Health Connect: shared ${last?.written ?? 0} records.`;
    } else if (op === "allow") {
      await hc.connectHc();
      const last = await hc.syncHc(true);
      if (last?.error) throw new Error(last.error);
    } else if (op === "share") {
      const last = await hc.syncHc(true);
      if (last?.error) throw new Error(last.error);
    } else if (op === "manage") await hc.openHcSettings();
    else if (op === "stop") {
      await hc.disconnectHc(!!a.remove);
      note = a.remove ? "Stopped sharing, and removed Tartan's records from Health Connect." : "Stopped sharing with Health Connect.";
    }
    const status = await hc.hcStatus();
    const s = hc.readHc();
    const granted = new Set(s.on ? await hc.hcGranted() : []);
    // The plan's week is chosen in Plan on your watch (planOut), not with these.
    const kinds = (Object.keys(hc.PERMISSIONS) as Array<keyof typeof hc.PERMISSIONS>).filter((k) => k !== "plan");
    const missing = Object.fromEntries(kinds.map((k) => [k, s.on && s.kinds[k] && !hc.PERMISSIONS[k].filter((p) => !p.endsWith("ROUTE") && !hc.OPTIONAL(p)).every((p) => granted.has(p))]));
    return { status, on: s.on, kinds: Object.fromEntries(kinds.map((k) => [k, s.kinds[k]])), missing, last: s.last ?? null, note };
  },
  /** The PC this phone is paired with, if any. */
  pcState: async () => (app.link ? { url: app.link.url, name: app.link.name ?? null } : null),
  /** Pair with the PC at these addresses with its code (views/pc-link.ts). */
  pcPair: async (a) => {
    const { pairPhone } = await import("./pairing.ts");
    const link = await pairPhone(String(a.urls ?? ""), String(a.code ?? ""));
    return { url: link.url, name: link.name ?? null };
  },
  /** Bring this phone and the PC to the latest; the line it ends on. */
  pcSync: async () => {
    const { syncBoth, summary } = await import("./pairing.ts");
    const r = await syncBoth();
    return summary(r);
  },
  pcUnpair: async () => (app.setLink(null), true),
  /** A pairing link, before pairing: the addresses on the home network, and whether it replaces the PC paired now. */
  pairCheck: async (a) => {
    const { isHomeAddress } = await import("../../src/link.ts");
    const home = ((a.urls as string[]) ?? []).filter(isHomeAddress);
    const replacing = !!app.link && !home.some((u) => u.replace(/\/$/, "") === app.link!.url.replace(/\/$/, ""));
    return { home, replacing, current: app.link ? (app.link.name ?? app.link.url.replace(/^https?:\/\//, "")) : null };
  },
  /** Find the PC on this Wi-Fi and pair with it (end to end encrypted): where, and its name. */
  pairConnect: async (a) => {
    const { LOCAL_NETWORK_DENIED, localNetwork } = await import("./local-network.ts");
    const { findPc, pairWith } = await import("../../src/link.ts");
    const { phoneName } = await import("./pairing.ts");
    if (!(await localNetwork(true))) throw new Error(LOCAL_NETWORK_DENIED);
    const url = await findPc((a.urls as string[]) ?? []);
    const link = await pairWith(url, String(a.code ?? ""), phoneName());
    app.setLink(link);
    return { url, name: link.name ?? null };
  },
  /** Both up to date after pairing: what came over, and the line it ends on. */
  pairSync: async () => {
    const { syncBoth, summary } = await import("./pairing.ts");
    const r = await syncBoth();
    return { ...r, line: summary(r) };
  },
  /** Start the app again (after a copy from the PC), the intro done. */
  reopen: async () => {
    try {
      localStorage.setItem("freesuunto.onboarded", "1");
      localStorage.removeItem("freesuunto.onboard.step");
    } catch {
      // nothing kept: the intro may show once more
    }
    setTimeout(() => location.reload(), 300);
    return true;
  },
  /** Model Hub, which holds the phone's models for every app (lib/modelhub.ts). */
  modelHub: async (a) => {
    const h = await import("./modelhub.ts");
    if (a.op === "allow") return h.allowModelHub();
    if (a.op === "open" || a.op === "updates") return (await h.openModelHub(a.op === "open" ? "app" : "updates"), true);
    if (a.op === "dropOld") return (await h.dropOldModelFile(), true);
    return h.hubState();
  },
  // ---------------------------------------------------------------- Watch (Settings)
  /** Watch faces: Tartan Track and yours, each as a picture, and which are on the watch. */
  faces: async (a) => {
    const { facePicture } = await import("./faces.ts");
    const { installed } = await import("./face-install.ts");
    const { TARTAN_TRACK_DESIGN } = await import("../../src/watchface/tartan-face.ts");
    const w = await import("../watch.ts");
    const list = await app.api.json<Array<{ id: string; name: string } & Parameters<typeof facePicture>[0]>>("/api/faces").catch(() => []);
    const on = installed();
    const size = Number(a.size ?? 160);
    return {
      canBluetooth: w.canBluetooth(),
      faces: [
        { id: TARTAN_TRACK_DESIGN.id, name: TARTAN_TRACK_DESIGN.name, builtin: true, onWatch: !!on[TARTAN_TRACK_DESIGN.id], picture: await facePicture(TARTAN_TRACK_DESIGN, { size }) },
        ...(await Promise.all(list.map(async (f) => ({ id: f.id, name: f.name, builtin: false, onWatch: !!on[f.id], picture: await facePicture(f, { size }).catch(() => null) })))),
      ],
    };
  },
  /** A face onto the watch over Bluetooth; what it said. */
  faceInstall: async (a) => {
    const { installFace } = await import("./face-install.ts");
    const { TARTAN_TRACK_DESIGN } = await import("../../src/watchface/tartan-face.ts");
    const d = a.builtin ? TARTAN_TRACK_DESIGN : await app.api.json<Parameters<typeof installFace>[0]>(`/api/faces/${encodeURIComponent(String(a.id))}`);
    return installFace(d);
  },
  /** Tartan's faces on the watch now (each removable), and how many faces it has. */
  facesOnWatch: async () => {
    const w = await import("../watch.ts");
    const { installed, setInstalled } = await import("./face-install.ts");
    const { isTartanFaceId } = await import("../../src/protocol/face-send.ts");
    const { TARTAN_TRACK_DESIGN } = await import("../../src/watchface/tartan-face.ts");
    const list = await app.api.json<Array<{ id: string; name: string }>>("/api/faces").catch(() => []);
    const ids = await w.watchFaceIds();
    const names = new Map<string, string>([[TARTAN_TRACK_DESIGN.id, TARTAN_TRACK_DESIGN.name], ...list.map((f) => [f.id, f.name] as [string, string])]);
    const mine = ids.filter(isTartanFaceId);
    const now = installed();
    for (const id of Object.keys(now)) if (!ids.includes(id)) delete now[id];
    for (const id of mine) now[id] ??= new Date().toISOString();
    setInstalled(now);
    return { total: ids.length, mine: mine.map((id) => ({ id, name: names.get(id) ?? `Tartan face ${id}` })) };
  },
  faceRemove: async (a) => {
    const w = await import("../watch.ts");
    const { unmarkInstalled } = await import("./face-install.ts");
    const removed = await w.removeFace(String(a.id), String(a.name));
    unmarkInstalled(String(a.id));
    return removed;
  },
  /** The face builder (#face/<id>, new, copy): the design to start from, the presets as pictures. */
  faceStart: async (a) => {
    const { facePicture } = await import("./faces.ts");
    const { PRESETS, TARTAN_TRACK_DESIGN, checkDesign, newFaceId } = await import("../../src/watchface/tartan-face.ts");
    const w = await import("../watch.ts");
    const arg = String(a.arg ?? "new");
    const saved = /^\d{6,10}$/.test(arg);
    const design = saved
      ? checkDesign(await app.api.json(`/api/faces/${arg}`))
      : arg === "copy" ? { ...structuredClone(TARTAN_TRACK_DESIGN), id: newFaceId(), name: "My Tartan Track" }
      : { ...structuredClone(PRESETS[0]!), id: newFaceId(), name: "My face" };
    const size = Number(a.size ?? 200);
    const presets = await Promise.all(PRESETS.map(async (p, i) => ({ i, name: p.name, design: p, picture: await facePicture({ ...p, id: "0" } as Parameters<typeof facePicture>[0], { size, data: false }).catch(() => null) })));
    return { design, saved, presets, canBluetooth: w.canBluetooth() };
  },
  /** A design as it stands in the builder, drawn at a time (now) as a picture. */
  facePreview: async (a) => {
    const { facePicture } = await import("./faces.ts");
    const now = new Date();
    return facePicture(a.design as Parameters<typeof facePicture>[0], { size: Number(a.size ?? 466), data: a.data !== false, at: { h: now.getHours(), m: now.getMinutes(), s: now.getSeconds() }, date: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][now.getDay()] });
  },
  faceSurprise: async (a) => (await import("../../src/watchface/tartan-face.ts")).surprise(String(a.id)),
  /** Save the builder's design (new or over the saved one): the face as saved. */
  faceSave: async (a) => {
    const { checkDesign } = await import("../../src/watchface/tartan-face.ts");
    const d = a.design as { id: string; background: { kind: string; image?: string } };
    if (d.background.kind === "photo" && !d.background.image) throw new Error("Choose a photo, or pick another background");
    const res = await app.api.request(`/api/faces/${a.saved ? d.id : "new"}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(checkDesign(d)) });
    const f = (await res.json()) as { id: string; error?: string };
    if (!res.ok) throw new Error(f.error ?? `HTTP ${res.status}`);
    return f;
  },
  /** A saved face as a package (.zip) to keep. */
  facePackage: async (a) => {
    const { packageFor } = await import("./faces.ts");
    const { checkDesign } = await import("../../src/watchface/tartan-face.ts");
    const { saveBytes } = await import("./files.ts");
    const pkg = await packageFor(checkDesign(await app.api.json(`/api/faces/${encodeURIComponent(String(a.id))}`)));
    await saveBytes(`${pkg.id}.zip`, pkg.zip, "application/zip");
    return true;
  },
  /** Drink and gel reminders in guided workouts (lib/watch-workouts.ts); with `set`, change them. */
  fuel: async (a) => {
    const { readFuel, writeFuel } = await import("./watch-workouts.ts");
    if (a.set) writeFuel({ ...readFuel(), ...(a.set as object) });
    const { DEFAULT_FUEL } = await import("../../src/workout/from-plan.ts");
    return { ...readFuel(), fromMin: DEFAULT_FUEL.fromMin };
  },
  /** The owner's build only: whose step runner workouts carry. */
  runner: async (a) => {
    const r = await import("./runner.ts");
    if (a.set === "suunto" || a.set === "tartan") r.setRunnerChoice(a.set);
    return { public: r.publicBuild(), choice: r.runnerChoice() };
  },
  /** The week on a face (lib/week-face.ts): its preview on a base, the bases, keep it up to date, send it. */
  weekFace: async (a) => {
    const wf = await import("./week-face.ts");
    const { facePicture } = await import("./faces.ts");
    const { TARTAN_TRACK_DESIGN, checkDesign } = await import("../../src/watchface/tartan-face.ts");
    const v = await app.api.json<PlanView>("/api/plan").catch(() => null);
    const week = v?.plan ? wf.weekOnFace(v) : null;
    if (!week || !v) return null;
    if (a.keep !== undefined) wf.setKeepsWeekFace(!!a.keep);
    if (typeof a.base === "string") localStorage.setItem(wf.WEEK_BASE, a.base);
    const list = await app.api.json<Array<{ id: string; name: string }>>("/api/faces").catch(() => []);
    const want = localStorage.getItem(wf.WEEK_BASE) ?? TARTAN_TRACK_DESIGN.id;
    const base = want !== TARTAN_TRACK_DESIGN.id && list.some((f) => f.id === want) ? checkDesign(await app.api.json(`/api/faces/${want}`)) : TARTAN_TRACK_DESIGN;
    let said: string | null = null;
    if (a.send) {
      const { replaced } = await wf.sendWeekFace(v, base);
      said = replaced ? "Updated. If you were wearing it, pick Tartan Week again on the watch." : "On your watch: pick Tartan Week where you change faces.";
    }
    const day = new Date(`${v.today}T12:00:00`).toLocaleDateString([], { weekday: "short" }).toUpperCase();
    return {
      picture: await facePicture(base, { size: Number(a.size ?? 296), week, date: day }),
      bases: [{ id: TARTAN_TRACK_DESIGN.id, name: "Tartan Track" }, ...list.slice(0, 3).map((f) => ({ id: f.id, name: f.name }))],
      base: base.id,
      keep: wf.keepsWeekFace(),
      said,
    };
  },
  // ---------------------------------------------------------------- More (Settings)
  /** Backups (lib/backup.ts): their state (never the passphrase), and each thing you can do. */
  backup: async (a) => {
    const b = await import("./backup.ts");
    const { MIN_PASSPHRASE } = await import("../../src/backup.ts");
    let said: string | null = null;
    let restored = false;
    if (a.op === "setPass") {
      const pass = String(a.pass ?? "");
      if (pass.length < MIN_PASSPHRASE) throw new Error(`At least ${MIN_PASSPHRASE} characters.`);
      b.setBackupPrefs({ ...b.backupPrefs(), pass, weekly: isNative });
      said = "Passphrase set. Tartan backs up every week by itself; Back up now makes one today.";
    } else if (a.op === "now") {
      const bytes = await b.backupNow(b.backupPrefs().pass!);
      said = `Backup made (${Math.max(1, Math.round(bytes / 1024))} KB). Keep it somewhere other than this phone.`;
    } else if (a.op === "weekly") {
      b.setBackupPrefs({ ...b.backupPrefs(), weekly: !!a.on });
      if (a.on) await b.weeklyBackup();
    } else if (a.op === "change") b.setBackupPrefs({ ...b.backupPrefs(), pass: undefined });
    else if (a.op === "restore") {
      const bytes = Uint8Array.from(atob(String(a.data)), (c) => c.charCodeAt(0));
      const r = await b.restoreFrom(new File([bytes], String(a.name ?? "backup.tartan")), String(a.pass ?? ""));
      setTimeout(() => location.reload(), 1500);
      // Everything's back: no intro after the restart.
      (await import("./intro.ts")).introDone(false, false);
      restored = true;
      said = `Restored ${r.files} files from the backup of ${new Date(r.created).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}. Starting again with it…`;
    }
    const p = b.backupPrefs();
    return { pass: !!p.pass, weekly: !!p.weekly, last: p.last ?? null, where: p.where ?? null, failed: p.failed ?? null, min: MIN_PASSPHRASE, said, restored };
  },
  /** The intro again (lib/intro.ts). */
  replayIntro: async () => {
    const { maybeOnboard } = await import("./intro.ts");
    void maybeOnboard(true);
    return true;
  },
  /** The coming 7 days' sessions as guided workouts on the watch (lib/watch-workouts.ts): how many are on it; with `send`, send them. */
  watchWeek: async (a) => {
    const w = await import("../watch.ts");
    const ww = await import("./watch-workouts.ts");
    const v = await app.api.json<PlanView>("/api/plan");
    if (!v.plan) return { canBluetooth: w.canBluetooth(), wanted: 0, onWatch: 0 };
    if (a.send) {
      const r = await ww.sendWeek(v);
      return { sent: true, line: r.added || r.removed ? `${r.added} on your watch${r.removed ? `, ${r.removed} old ${r.removed === 1 ? "one" : "ones"} off` : ""}. Start one from the sport mode's workout options.` : "Your watch already has the coming week." };
    }
    const { wanted, onWatch } = ww.comingWeek(v);
    return { canBluetooth: w.canBluetooth(), wanted: wanted.length, onWatch: Math.min(onWatch.size, wanted.length) };
  },
  /**
   * The coming week for other watches (lib/plan-out.ts): intervals.icu (it forwards to Garmin and
   * the others it links), Health Connect's planned workouts (Samsung, Pixel…), .fit files. How each
   * stands; with an op, send (and keep it up to date), stop, or share the week's files. `line` says how it went.
   */
  planOut: async (a) => (await import("./plan-out.ts")).planOut(a.op ?? "state"),
  /** One session as a .fit workout file through the share sheet: its file name. */
  sessionFile: async (a) => ({ name: await (await import("./plan-out.ts")).shareSessionFile(String(a.date), String(a.kind)) }),
  /** The demo with sample data (lib/demo.ts): start, leave, or whether it's on. */
  demo: async (a) => {
    const d = await import("./demo.ts");
    if (a.op === "start") d.startDemo();
    else if (a.op === "leave") await d.leaveDemo();
    return { on: d.inDemo() };
  },
  /** Reminders and calendar events follow a new plan (lib/schedule.ts). */
  syncSchedule: async () => ((await import("./schedule.ts")).syncSchedule(), true),
  introStep: async (a) => ((await import("./intro.ts")).introStep(Number(a.step ?? 0)), true),
  introDone: async (a) => {
    const { introDone } = await import("./intro.ts");
    // After the answer has gone back.
    setTimeout(() => introDone(!!a.reload), 50);
    return true;
  },
  /** The watch recorder (lib/blackbox.ts): arm, cancel, share; its state. */
  recorder: async (a) => {
    const r = await import("./blackbox.ts");
    if (a.op === "arm") r.armRecorder(true);
    else if (a.op === "cancel") r.armRecorder(false);
    else if (a.op === "share") await r.shareRecording();
    return r.recorder();
  },
  /** The activity log so far, with the version and build. */
  log: async () => {
    const { onLog } = await import("../state.ts");
    let text = "";
    onLog((t) => (text = t))();
    return { text, version: pkg.version, build: typeof BUILD_ID === "string" ? BUILD_ID : "dev" };
  },
  // ---------------------------------------------------------------- Routes
  /** The way on foot from a to b (lib/routing.ts footpath). */
  routePath: async (a) => (await import("./routing.ts")).footpath(a.a as [number, number], a.b as [number, number]),
  /** Heights along a line, one per point; null when the service can't be reached. */
  routeHeights: async (a) => (await import("./routing.ts")).heights(a.line as Array<[number, number]>),
  /** Three loops of a distance from a start (src/route-loop.ts makeLoops). */
  routeLoops: async (a) => {
    const { footpath, footloop } = await import("./routing.ts");
    const { makeLoops } = await import("../../src/route-loop.ts");
    return makeLoops(a.start as [number, number], Number(a.km), async (x, y) => (await footpath(x, y)).line, { loop: footloop });
  },
  /** A route onto the watch over Bluetooth: its id there. */
  routeToWatch: async (a) => (await import("../watch.ts")).sendRoute(a as Parameters<typeof import("../watch.ts").sendRoute>[0]),
  /** A saved route as a GPX file, through the share sheet (for the Suunto app). */
  routeGpx: async (a) => {
    const { toGpx } = await import("../../src/routes.ts");
    const r = await app.api.json<Parameters<typeof toGpx>[0] & { name: string }>(`/api/routes/${encodeURIComponent(String(a.id))}`);
    await saveFile(`${r.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "route"}.gpx`, toGpx(r), "application/gpx+xml", "Open in the Suunto app");
    return true;
  },
  /** Race pacing over a course (src/race-pace.ts): even effort for a target time. */
  racePacing: async (a) => {
    const rp = await import("../../src/race-pace.ts");
    const target = rp.parseTime(String(a.time ?? ""));
    if (!target) throw new Error("Type a time like 1:45:00, 48:30 or 50 (minutes).");
    const r = rp.raceSplits(a.line as Array<[number, number]>, (a.elevation as number[] | null) ?? null, target);
    return { target, ...r };
  },
  /** The race course onto the watch with a named split every km. */
  courseToWatch: async (a) => (await import("../watch.ts")).sendRoute({ name: String(a.name), line: a.line as Array<[number, number]>, waypoints: [], named: a.marks as Array<{ point: [number, number]; name: string }> }),
  /** Even splits as a guided pacing workout on the watch. */
  splitsToWatch: async (a) => {
    const { pacingWorkout } = await import("../../src/race-pace.ts");
    const { putWorkout } = await import("../watch.ts");
    await putWorkout(pacingWorkout(String(a.name).slice(0, 30), a.splits as Parameters<typeof pacingWorkout>[1]));
    return true;
  },
  // ---------------------------------------------------------------- Record and Lift
  recStart: async () => (await (await import("../recorder.ts")).start(), true),
  recPause: async () => ((await import("../recorder.ts")).pause(), true),
  recResume: async () => ((await import("../recorder.ts")).resume(), true),
  recFinish: async () => (await (await import("../recorder.ts")).finish(), true),
  /** Keep the finished run (renamed), and send it to Strava when asked: what to say. */
  recKeep: async (a) => {
    const rec = await import("../recorder.ts");
    const id = await rec.keep(String(a.name ?? ""));
    if (!id) return { said: null };
    if (!a.strava) return { said: "Run saved." };
    return { said: await uploadRecording(id) };
  },
  recDiscard: async () => (await (await import("../recorder.ts")).discard(), true),
  recUpload: async (a) => uploadRecording(String(a.id)),
  recHeart: async () => (await (await import("../recorder.ts")).connectHeartRate(), true),
  /** Spoken cues every km: on or off (with `on`), and which. */
  recCues: async (a) => {
    const rec = await import("../recorder.ts");
    if (typeof a.on === "boolean") rec.setCues(a.on);
    return rec.cuesOn();
  },
  /** Guided runs (src/workout/guided.ts): on or off; today's session it would follow ({name, steps, first}), or null. */
  recGuide: async (a) => {
    const rec = await import("../recorder.ts");
    if (typeof a.on === "boolean") rec.setGuide(a.on);
    const s = await rec.todaysSession().catch(() => null);
    const { flatten, stepDetail, isStructured } = await import("../../src/workout/guided.ts");
    const steps = s ? flatten(s.workout) : [];
    return { on: rec.guideOn(), session: s ? { name: s.workout.name, steps: steps.length, structured: isStructured(s.workout), first: `${steps[0]!.label} · ${stepDetail(steps[0]!)}` } : null };
  },
  recLap: async () => ((await import("../recorder.ts")).nextStep(), true),
  /** A notification when the rest between sets is over (the screen may be off), or none. */
  restNote: async (a) => {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    await LocalNotifications.cancel({ notifications: [{ id: 7301 }] }).catch(() => {});
    if (!a.at) return true;
    let perm = (await LocalNotifications.checkPermissions()).display;
    if (perm === "prompt" || perm === "prompt-with-rationale") perm = (await LocalNotifications.requestPermissions()).display;
    if (perm !== "granted") return false;
    await LocalNotifications.schedule({ notifications: [{ id: 7301, title: "Rest's over", body: String(a.next ?? ""), schedule: { at: new Date(Number(a.at)), allowWhileIdle: true } }] });
    return true;
  },
  /** Every exercise (src/strength/exercises.ts), and which body to draw for you. */
  exercises: async () => {
    const { EXERCISES } = await import("../../src/strength/exercises.ts");
    const { yourBody } = await import("./demo-body.ts");
    return { figure: await yourBody(), items: EXERCISES.map((ex) => ({ id: ex.id, name: ex.name, kind: ex.kind, equipment: ex.equipment ?? null, dose: doseText(ex.dose), cues: ex.cues, why: ex.why, primary: ex.primary, secondary: ex.secondary })) };
  },
  /** The body as pictures (lib/body3d.ts bodyFrames): its move as a loop, its key pose all round. Null without WebGL. */
  body: async (a) => {
    const { bodyFrames, canDraw3d } = await import("./body3d.ts");
    if (!canDraw3d()) return null;
    const exercise = typeof a.exercise === "string" ? a.exercise : undefined;
    const body = await demoBody(String(a.key ?? exercise ?? "body"));
    return bodyFrames({ body, exercise, primary: (a.primary ?? []) as never, secondary: (a.secondary ?? []) as never, width: Number(a.width ?? 360), height: Number(a.height ?? 300), loop: Number(a.loop ?? 0), turn: Number(a.turn ?? 0) });
  },
  /** Race week (src/race-week.ts): focus, pacing, fuel and the checklist; null outside it. */
  raceWeek: async (a) => raceWeek(a.race as Parameters<typeof raceWeek>[0]),
  /** The race's even-pace workout onto the watch, over Bluetooth. */
  pacingToWatch: async (a) => {
    const { pacingWorkout } = await import("../../src/race-pace.ts");
    const { putWorkout } = await import("../watch.ts");
    await putWorkout(pacingWorkout(String(a.name).slice(0, 30), evenSplits(Number(a.distance_km), Number(a.time_s))));
    return true;
  },
  /** Pair with a PC: scan its code (views/pc-link.ts). */
  scanPair: async () => {
    const { scanAndPair } = await import("./pairing.ts");
    await scanAndPair();
    return true;
  },
  saveFile: async (a) => {
    const res = await app.api.request(String(a.path));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await saveFile(String(a.name), await res.text(), String(a.type));
  },
} satisfies EngineHandlers;

/** What each call answers, read off the engine itself (see lib/contract.ts). */
export type EngineResults = { [K in keyof typeof RPC]: Awaited<ReturnType<(typeof RPC)[K]>> };

/** A recorded run to Strava (web/views/record.ts upload): what to say about it. */
async function uploadRecording(id: string): Promise<string> {
  const { stravaStatus } = await import("../sync.ts");
  const st = await stravaStatus();
  if (!st?.connected) return "Saved on the phone. Connect Strava in Settings to send it there.";
  if (!st.can_upload) return "Saved. Strava needs your OK for uploads: in Settings, tap Allow uploads, then send it from Record.";
  const res = await app.api.request(`/api/recordings/${id}/upload`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  if (body.status === "done") return "On Strava now. It joins your library with the next sync, as one workout.";
  throw new Error(`Strava upload failed: ${body.error ?? res.status}`);
}

/** At start: which parts are on, and answer the native screens' calls. */
export async function startShell(): Promise<void> {
  if (!has) return markReady();
  const p = await Shell.parts().catch(() => null);
  if (!p?.available) return markReady();
  parts = { nav: p.nav, today: p.today, coach: p.coach, chat: p.chat, activities: p.activities, progress: p.progress, settings: p.settings, workout: p.workout ?? false, body: p.body ?? false, routes: p.routes ?? false, record: p.record ?? false };
  markReady();
  mark();
  await Shell.addListener("go", (e) => {
    if (e.action === "board") document.getElementById("conn")?.click();
    else if (e.action === "laneSync") void (e.lane === "watch" ? syncWatchNow() : syncStravaNow()).finally(() => void Shell.changed().catch(() => {}));
    else if (e.action === "chat") {
      // The native chat when it's on (the iPhone has the page's too); else the page's.
      if (shellChat({ conversation: e.conversation, prefill: e.prefill })) location.hash = "#chat";
      else webUi.openChat?.({ conversation: e.conversation, prefill: e.prefill, focus: true });
    }
    else if (e.action === "sync") void syncAllNow().finally(() => void Shell.changed().catch(() => {}));
    else if (e.activity) void (webUi.openActivity ? webUi.openActivity(e.activity) : shellWorkout(e.activity));
    else if (e.session) void (webUi.openPlanSession?.(e.session, e.kind) ?? Promise.resolve(false)).then((ok) => ok || (location.hash = "coach"));
    else if (location.hash.slice(1) !== e.hash) location.hash = e.hash;
  });
  await Shell.addListener("api", (e) => {
    void (async () => {
      try {
        if (e.path.startsWith("rpc:")) {
          // The contract types each call; across the bridge the args are whatever JSON came.
          const name = e.path.slice(4);
          const fn = Object.hasOwn(RPC, name) ? (RPC[name as keyof EngineCalls] as (a: unknown) => Promise<unknown>) : null;
          if (!fn) throw new Error(`no ${e.path}`);
          const out = await fn(e.body ? JSON.parse(e.body) : {});
          await Shell.reply({ id: e.id, status: 200, body: JSON.stringify(out ?? null) });
          return;
        }
        const init: RequestInit = { method: e.method };
        if (e.body !== undefined) Object.assign(init, { body: e.body, headers: { "content-type": "application/json" } });
        const res = await app.api.request(e.path, init);
        // Streamed (the chat): each line to the native screen as it comes, then the end.
        if (e.stream && res.ok && res.body) {
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let rest = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            rest += value;
            const lines = rest.split("\n");
            rest = lines.pop() ?? "";
            for (const line of lines) if (line.trim()) await Shell.chunk({ id: e.id, line });
          }
          if (rest.trim()) await Shell.chunk({ id: e.id, line: rest });
          if (e.path.startsWith("/api/coach/chat")) void syncSchedule();
          await Shell.reply({ id: e.id, status: res.status, body: "" });
          return;
        }
        // A plan changed from a native screen: the calendar and the reminders follow, as from the web's.
        if (res.ok && e.method !== "GET" && e.path.startsWith("/api/plan")) void syncSchedule();
        // Training times changed: reminders and calendar events follow at once.
        if (res.ok && e.method !== "GET" && e.path.startsWith("/api/schedule")) void syncSchedule(true);
        await Shell.reply({ id: e.id, status: res.status, body: await res.text() });
      } catch (err) {
        await Shell.reply({ id: e.id, status: 599, body: JSON.stringify({ error: (err as Error).message }) }).catch(() => {});
      }
    })();
  });
  await Shell.addListener("back", onBack);
  // The page's messages are native snackbars; their action comes back here.
  let snackId = 0;
  let snackRun: { id: number; run: () => unknown } | null = null;
  const { setSnackHook } = await import("../state.ts");
  setSnackHook((text, kind, action) => {
    // Always native (on top of the page and the native screens alike), so their buttons take the touch.
    const id = ++snackId;
    snackRun = action ? { id, run: action.run } : null;
    // As long as the page's: longer words, longer; with an action, longer still. Errors stay.
    const ms = kind === "info" ? Math.min(10_000, 3500 + text.length * 45 + (action ? 3000 : 0)) : undefined;
    void Shell.snack({ id, text, error: kind === "error", action: action?.label, ms }).catch(() => {});
    return true;
  });
  await Shell.addListener("snack", (e) => {
    if (snackRun?.id === e.id) void snackRun.run();
  });
  // A native screen is showing under the page: the page goes see-through, so its sheets and
  // messages open over the native screen.
  await Shell.addListener("screen", (e) => document.documentElement.classList.toggle("native-screen", e.native));
  // A native part switched on or off from the native Settings: the page follows.
  await Shell.addListener("parts", (e) => {
    parts = { nav: e.nav, today: e.today, coach: e.coach, chat: e.chat, activities: e.activities, progress: e.progress, settings: e.settings, workout: e.workout ?? false, body: e.body ?? false, routes: e.routes ?? false, record: e.record ?? false };
    mark();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  // The watch as the page holds it (connected, a backup under way, its files): native Sources shows it.
  void import("../watch.ts").then((w) =>
    w.onWatch((st) => void Shell.watch({ state: JSON.stringify({ ...st, canBluetooth: w.canBluetooth(), noFileAccess: !!w.noFileAccess() }) }).catch(() => {})),
  );
  // A run being recorded (lib recorder.ts): native Record shows it as it goes.
  void import("../recorder.ts").then(async (rec) => {
    const { speedNow, track } = await import("../../src/recording.ts");
    // Today's planned run, once a recording starts: its distance and name for the Live Update.
    let goal: { goal_km?: number; plan_title?: string } | null = null;
    rec.onRecorder((st) => {
      if (st.status === "recording" && goal === null) {
        goal = {};
        void app.api.json<PlanView>("/api/plan").then((v) => {
          const s = v.weeks.flatMap((w) => w.days).find((d) => d.date === v.today)?.sessions.find((x) => x.kind !== "rest" && x.kind !== "strength");
          if (s) goal = { ...(s.distance_km ? { goal_km: s.distance_km } : {}), plan_title: s.title };
        }).catch(() => {});
      }
      if (st.status === "idle" || st.status === "finished") goal = null;
      const r = st.rec;
      const now = r ? speedNow(track(r)) : 0;
      const state = { status: st.status, start: r?.start ?? null, end: r?.end ?? null, pauses: r?.pauses ?? [], name: r?.name ?? null, summary: st.summary, accuracy: st.accuracy ?? null, gpsError: st.gpsError ?? null, hr: st.hr ?? null, now, guide: st.guide ?? null, ...(goal ?? {}) };
      void Shell.recorder({ state: JSON.stringify(state) }).catch(() => {});
    });
  });
  // Something wrote (a sync, a mark, a save): native screens read again; otherwise they keep theirs.
  onDataChanged(() => void Shell.changed().catch(() => {}));
  // Into or out of the demo (lib/demo.ts): other storage, so every native screen reads again.
  if (localStorage.getItem("tartan.demo.switched")) {
    localStorage.removeItem("tartan.demo.switched");
    void Shell.changed().catch(() => {});
  }
  window.addEventListener("tartan:colours", () => shellRoute());
  // A sheet opening or the keyboard coming up hides the bar; closing brings it back.
  let last = hidden();
  new MutationObserver(() => {
    if (hidden() !== last) {
      last = hidden();
      shellRoute();
    }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["open", "class"] });
  // The web intro coming and going (iPhone): it's added to and removed from the body.
  new MutationObserver(() => {
    if (hidden() !== last) {
      last = hidden();
      shellRoute();
    }
  }).observe(document.body, { childList: true });
  shellRoute();
}
