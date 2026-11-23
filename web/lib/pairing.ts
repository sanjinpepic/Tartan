/**
 * Phone and PC as one, the engine's part (src/link.ts, src/transfer.ts): read the PC's pairing
 * code, pair with it (end to end encrypted), and bring both up to date. The screens are native
 * (PairSheet, PcCard) or the web's (views/pc-link.ts).
 */
import { findPc, pairWith, type Link } from "../../src/link.ts";
import { fmtBytes } from "./dom.ts";
import { app, notify, readNdjson } from "../state.ts";
import { syncMemory } from "../sync.ts";
import { scanQr } from "./qr-scan.ts";
import { LOCAL_NETWORK_DENIED, localNetwork } from "./local-network.ts";
import { shellPair } from "./shell.ts";

/** The web's own pairing sheet, when the app has one: set by views/pc-link.ts. */
let webPairSheet: ((urls: string[], code: string, ask: boolean) => void) | null = null;
export const setWebPairSheet = (f: (urls: string[], code: string, ask: boolean) => void) => void (webPairSheet = f);

/** The PC's pairing QR: tartan://localhost/pair?url=…(&url=…)&code=… (or the PC's own /pair page link). */
export function parsePairQr(text: string): { urls: string[]; code: string } | null {
  try {
    const u = new URL(text.trim());
    if (u.pathname !== "/pair" && u.pathname !== "//localhost/pair") return null;
    const code = u.searchParams.get("code") ?? "";
    const urls = (u.protocol === "tartan:" ? u.searchParams.getAll("url") : [u.origin]).filter((x) => /^https?:\/\//.test(x));
    return urls.length && code ? { urls, code } : null;
  } catch {
    return null;
  }
}

/** Scan the PC's QR code and pair with it (the sheet takes it from there). */
export async function scanAndPair(): Promise<void> {
  const text = await scanQr("Point at the QR code on your PC (Settings → More → Phone app)");
  if (!text) return;
  const p = parsePairQr(text);
  if (!p) return notify("That's not Tartan's pairing code. On the PC: Settings → More → Phone app → Pair a phone.", "error");
  openPairLink(p.urls, p.code, false);
}

/** "192.168.1.20:5173" → "http://192.168.1.20:5173". */
export const normUrl = (s: string) => {
  const t = s.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
};
/** "Pixel 8" from the user agent, else "Phone". */
export const phoneName = () => /Android [\d.]+; ([^;)]+)/.exec(navigator.userAgent)?.[1]?.replace(/ Build.*$/, "").trim() || "Phone";

/** Pair with the PC at these addresses (space or comma separated) with the code it shows. */
export async function pairPhone(urls: string, code: string): Promise<Link> {
  if (code.replace(/[^0-9a-z]/gi, "").length !== 10) throw new Error("The code has 10 letters and digits.");
  if (!(await localNetwork(true))) throw new Error(LOCAL_NETWORK_DENIED);
  const where = await findPc(urls.split(/[\s,]+/).filter(Boolean).map(normUrl));
  const link = await pairWith(where, code, phoneName());
  app.setLink(link);
  return link;
}

export interface Synced {
  pulled: number;
  pushed: number;
  merged: number;
  changed: boolean;
}

/**
 * Bring this phone and the PC to the latest, like a sync (src/transfer.ts reconcile): what one
 * has goes to the other, the newer copy wins, nothing fresh overwrites a full history. Shows how
 * far it got; then the coach's notes merge too.
 */
export async function syncBoth(progress: (p: { pct: number; line: string }) => void = () => {}): Promise<Synced> {
  const link = app.link;
  if (!link) throw new Error("Pair with your PC first.");
  progress({ pct: 0, line: "Comparing with your PC…" });
  let result: Synced = { pulled: 0, pushed: 0, merged: 0, changed: false };
  const res = await app.api.request("/api/link/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link }) });
  await readNdjson(res, (m) => {
    if (m.type === "progress") {
      const p = Number(m.totalBytes) ? (Number(m.bytes) / Number(m.totalBytes)) * 100 : (Number(m.done) / Math.max(1, Number(m.total))) * 100;
      progress({ pct: p, line: `${Number(m.done).toLocaleString()} of ${Number(m.total).toLocaleString()} · ${fmtBytes(Number(m.bytes))} of ${fmtBytes(Number(m.totalBytes))}` });
    } else if (m.type === "done") result = { pulled: Number(m.pulled), pushed: Number(m.pushed), merged: Number(m.merged), changed: !!m.changed };
    else if (m.error) throw new Error(String(m.error));
  });
  await syncMemory().catch(() => {});
  progress({ pct: 100, line: summary(result) });
  return result;
}
export const summary = (r: Synced) =>
  r.pulled + r.pushed + r.merged === 0 && !r.changed
    ? "Already the same on both: up to date."
    : `Up to date: ${[r.pulled ? `${r.pulled.toLocaleString()} from your PC` : "", r.pushed ? `${r.pushed.toLocaleString()} to your PC` : "", r.merged ? `${r.merged} combined` : "", r.changed && !r.pulled ? "plan, lifts or checks updated" : ""].filter(Boolean).join(", ")}.`;

/** Done copying from the PC: the intro is over, and the app starts again with it all here. */
export const reopen = () => {
  try {
    localStorage.setItem("freesuunto.onboarded", "1");
    localStorage.removeItem("freesuunto.onboard.step");
  } catch {
    // nothing kept: the intro may show once more
  }
  setTimeout(() => location.reload(), 500);
};

/**
 * The phone opened from the PC's QR code (tartan://localhost/pair?url=…&code=…), or the in-app
 * scanner: the native sheet pairs (views/pc-link.ts has the web's, set by the web app's entry).
 */
export function openPairLink(urls: string | string[], code: string, ask = true): void {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  // Tartan 2: the pairing sheet is native.
  void shellPair(list, code, ask).then((native) => native || webPairSheet?.(list, code, ask));
}
