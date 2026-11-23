/** App-wide state and services shared by every view. */
import { Capacitor } from "@capacitor/core";
import { ServerBackend } from "./backend.ts";
import type { Link } from "../src/link.ts";
import { el, hhmm, icon } from "./lib/dom.ts";
import { plainSyncError } from "./lib/lanes.ts";
import { keepReads } from "./lib/read-cache.ts";

export const isNative = Capacitor.isNativePlatform();
/** `?device-storage` previews the phone app (Tartan running on its own storage) in a desktop browser. */
export const deviceMode = isNative || new URLSearchParams(location.search).has("device-storage");

/**
 * Tartan itself: the library, Strava, analytics, the coach and where watch backups go.
 * On the PC that's the Bun server; in the app it runs in-process on the phone's storage.
 */
export const local: ServerBackend = deviceMode ? new (await import("./local-api.ts")).LocalApiBackend() : new ServerBackend("");
// On the phone, what's been read is kept until something writes (web/lib/read-cache.ts). On a PC
// an agent can write behind the page's back, so it asks each time there.
if (deviceMode) keepReads(local);

const PC = "freesuunto.pc";
/** The PC this phone is paired with (src/link.ts): its address, this phone's id there, the link key. */
function readLink(): Link | null {
  try {
    const cfg = JSON.parse(localStorage.getItem(PC) ?? "null") as Partial<Link> | null;
    return cfg?.url && cfg.device && cfg.key ? (cfg as Link) : null;
  } catch {
    return null;
  }
}

export const app = {
  api: local,
  /** Phone only, optional: the paired PC, reached end to end encrypted (watch backups, coach notes, plan, lifts). */
  link: deviceMode ? readLink() : null,
  remote: null as ServerBackend | null,
  setLink(link: Link | null): void {
    try {
      if (link) localStorage.setItem(PC, JSON.stringify(link));
      else localStorage.removeItem(PC);
    } catch {
      // not remembered
    }
    this.link = link;
    this.remote = link ? new ServerBackend(link.url, link) : null;
  },
};
app.remote = app.link ? new ServerBackend(app.link.url, app.link) : null;

// ------------------------------------------------------------------ instant screens

const snapshots = new Map<string, string>();

/**
 * Draw the last answer for `path` straight away (kept across app starts), then the fresh one
 * if it differs. Screens open instantly; new numbers replace old ones once computed.
 */
export async function lastThenFresh<T>(path: string, draw: (data: T, cached: boolean) => void): Promise<void> {
  const key = `freesuunto.snap:${path}`;
  let shown = snapshots.get(path);
  if (shown === undefined) {
    try {
      shown = localStorage.getItem(key) ?? undefined;
    } catch {
      // no storage: just wait for the fresh answer
    }
  }
  if (shown !== undefined) {
    try {
      draw(JSON.parse(shown) as T, true);
    } catch {
      shown = undefined; // a snapshot from an older app version that no longer fits
    }
  }
  const text = JSON.stringify(await app.api.json<T>(path));
  snapshots.set(path, text);
  if (text === shown) return;
  try {
    localStorage.setItem(key, text);
  } catch {
    // storage full: the in-memory copy still makes this session instant
  }
  draw(JSON.parse(text) as T, false);
}

// ------------------------------------------------------------------ activity log

let logText = "";
const logListeners = new Set<(t: string) => void>();
export function log(msg: string): void {
  logText += `${hhmm(new Date())}  ${msg}\n`;
  logText = logText.slice(-150000);
  logListeners.forEach((f) => f(logText));
}
export function onLog(f: (t: string) => void): () => void {
  logListeners.add(f);
  f(logText);
  return () => logListeners.delete(f);
}

// ------------------------------------------------------------------ notices (snackbar)

let snackTimer: ReturnType<typeof setTimeout> | undefined;
/** Another screen: a passing info notice goes with the screen it was about; errors stay to be read. */
let shownAt = 0;
export function clearInfoNotice(): void {
  const host = document.getElementById("snack");
  // Not one said on the way here ("Your plan is ready", then the Coach tab opens).
  if (host?.dataset.kind === "info" && Date.now() - shownAt > 1200) host.classList.remove("show");
}

/** Tartan 2: over a native screen, its own snackbar says it (the page's would sit under the screen's touches). */
type SnackHook = (msg: string, kind: "info" | "error", action?: { label: string; run: () => unknown }) => boolean;
let snackHook: SnackHook | null = null;
const early: Array<Parameters<SnackHook>> = [];
export const setSnackHook = (f: SnackHook) => {
  snackHook = f;
  for (const m of early.splice(0)) f(...m);
};

export function notify(msg: string, kind: "info" | "error" = "info", action?: { label: string; run: () => unknown }): void {
  log(msg);
  if (snackHook?.(msg, kind, action)) return;
  const host = document.getElementById("snack");
  // The phone's engine has no page to show it on: it waits for the native snackbar.
  if (!host) return void early.push([msg, kind, action]);
  const go = action
    ? el("button", {
        type: "button",
        class: "text-btn snack-action",
        onclick: () => {
          host.classList.remove("show");
          void action.run();
        },
      }, action.label)
    : null;
  host.replaceChildren(kind === "error" ? icon("warn", "ic sm") : "", el("p", {}, msg), go ?? "", el("button", { type: "button", class: "text-btn", onclick: () => host.classList.remove("show") }, "Dismiss"));
  host.dataset.kind = kind;
  host.setAttribute("role", kind === "error" ? "alert" : "status");
  host.classList.add("show");
  shownAt = Date.now();
  clearTimeout(snackTimer);
  // Long enough to read outdoors: longer words, longer; with an action, longer still. Errors stay.
  if (kind === "info") snackTimer = setTimeout(() => host.classList.remove("show"), Math.min(10_000, 3500 + msg.length * 45 + (action ? 3000 : 0)));
}

/** Run an action with its button busy; failures become a notice, never an alert(). */
export async function act(button: HTMLButtonElement | null, label: string, fn: () => Promise<void>): Promise<void> {
  if (button?.disabled) return;
  button?.classList.add("busy");
  button?.setAttribute("aria-busy", "true");
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (e) {
    const msg = (e as Error).message;
    if (/cancel|chooser|user gesture|No device selected/i.test(msg)) log(`${label}: ${msg}`);
    else {
      // Watch and protocol failures in words; what the watch actually said stays in the log.
      const plain = plainWatchError(msg);
      if (plain) log(`${label}: ${msg}`);
      notify(plain ?? `${label} failed: ${msg}`, "error");
    }
  } finally {
    button?.classList.remove("busy");
    button?.removeAttribute("aria-busy");
    if (button) button.disabled = false;
  }
}

// ------------------------------------------------------------------ cross-view hooks

export const hooks = {
  /** Open an activity in the detail sheet (set by app.ts). */
  openActivity: (_id: string, _from?: HTMLElement) => {},
  /** Re-render the current view (after a sync). */
  refresh: () => {},
};

export async function readNdjson(res: Response, onMsg: (m: Record<string, unknown>) => void): Promise<void> {
  if (!res.body) throw new Error(`no response body (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) onMsg(JSON.parse(line));
    }
  }
}

/**
 * A watch failure as someone back from a run reads it: what happened to the watch and what to
 * try. Null when the message isn't about the watch (those keep their own words).
 */
export function plainWatchError(msg: string): string | null {
  // The watch refused or the check before writing stopped: nothing was written.
  if (/0x[0-9a-f]{2,}|kind \(\d\)|nothing was sent|doesn't match|describes \w+ differently|refusing to write|didn't (save|open|list|describe)|stopped the \w+ at|took the \w+ but/i.test(msg))
    return "Your watch didn't take it. Nothing on the watch changed.";
  if (/bluetooth|gatt|watch|device|connect|disconnect|timed? ?out|no answer|didn't answer|out of range|busy/i.test(msg)) {
    const p = plainSyncError("watch", msg);
    // Only a failure it recognises; anything else keeps its own (already plain) words.
    return p.text === plainSyncError("watch", "").text ? null : `${p.text}${p.fix ? ` ${p.fix}` : ""}`;
  }
  return null;
}
