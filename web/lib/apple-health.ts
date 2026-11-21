/**
 * Apple Health on iPhone (src/apple-health.ts for what goes where), read only: ask once to read
 * workouts, then on each sync bring in what's new, newest first, each kept once. Off until
 * connected (the intro, or Settings → Sources). Without HealthKit (an iPad, an older build, or a
 * copy installed without the Health permission) it says so and nothing else changes.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { HkSession } from "../../src/apple-health.ts";
import { app, log } from "../state.ts";

interface TartanAppleHealth {
  status(): Promise<{ status: "available" | "unavailable"; asked?: boolean }>;
  requestAccess(): Promise<{ asked: boolean }>;
  workouts(o: { start: number; end: number; known: string[]; limit?: number }): Promise<{ sessions: HkSession[]; more: boolean; found: number }>;
  openHealth(): Promise<void>;
}
const Native = registerPlugin<TartanAppleHealth>("TartanAppleHealth");

export interface AhState {
  on: boolean;
  /** Workouts already brought in (Apple Health's ids). */
  imported: string[];
  /** Bring in workouts from here on (ms): two years back when first connected. */
  from?: number;
  /** How many workouts Apple Health showed Tartan the last time it looked (none: not allowed, or none there). */
  seen?: number;
  last?: { at: number; added: number; error?: string };
}
const KEY = "tartan.applehealth";
const DEFAULTS: AhState = { on: false, imported: [] };

export function readAh(): AhState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AhState> | null;
    return { ...DEFAULTS, ...v, imported: v?.imported ?? [] };
  } catch {
    return { ...DEFAULTS };
  }
}
function writeAh(v: AhState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // no storage
  }
}

export const ahNative = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable("TartanAppleHealth");

/** "available", "unavailable" (no HealthKit here), or "web" (not on an iPhone). */
export async function ahStatus(): Promise<"available" | "unavailable" | "web"> {
  if (!ahNative()) return "web";
  return (await Native.status().catch(() => ({ status: "unavailable" as const }))).status;
}

/**
 * Ask Apple Health (its own sheet, once) and turn it on; syncAh then brings in what's there.
 * Apple Health never says whether reading was allowed: no workouts at all reads as "nothing
 * allowed, or nothing there".
 */
export async function connectAh(): Promise<void> {
  await Native.requestAccess();
  const s = readAh();
  writeAh({ ...s, on: true, from: s.from ?? Date.now() - 730 * 86400_000 });
}

/** Stop bringing workouts in. Those already here stay. */
export function stopAh(): void {
  writeAh({ ...readAh(), on: false, last: undefined });
}

export const openHealth = () => Native.openHealth();

let running: Promise<AhState["last"]> | null = null;
/** Bringing workouts in right now. */
export const ahRunning = () => running !== null;
const EVERY = 30 * 60_000;

/** New workouts from Apple Health, at most every 30 minutes unless forced; nothing (undefined) when off or not due. */
export function syncAh(force = false): Promise<AhState["last"]> {
  if (running) return running;
  running = once(force).finally(() => (running = null));
  return running;
}

async function once(force: boolean): Promise<AhState["last"]> {
  const s = readAh();
  if (!s.on || !ahNative()) return undefined;
  // Looked a moment ago: nothing new to say (undefined, so a sync doesn't count it twice).
  if (!force && s.last && Date.now() - s.last.at < EVERY) return undefined;
  const now = Date.now();
  const from = s.from ?? now - 730 * 86400_000;
  const known = new Set(s.imported);
  let added = 0;
  let seen = s.seen ?? 0;
  try {
    // Ten at a time (a long run with its route is big), at most 400 a round; the rest next time.
    for (let round = 0; round < 40; round++) {
      const got = await Native.workouts({ start: from, end: now, known: [...known], limit: 10 });
      seen = got.found;
      if (!got.sessions.length) break;
      const res = await app.api.request("/api/apple-health/workouts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessions: got.sessions }) });
      const r = (await res.json()) as { added: number; done: string[]; error?: string };
      if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
      added += r.added;
      // One that couldn't be kept is still left out next time (it would come back every round).
      for (const x of got.sessions) known.add(x.id);
      writeAh({ ...readAh(), imported: [...known].slice(-5000), seen });
      if (!got.more) break;
    }
    const last = { at: now, added };
    writeAh({ ...readAh(), seen, last });
    if (added) log(`[apple health] brought in ${added} workouts`);
    return last;
  } catch (e) {
    const last = { at: now, added, error: (e as Error).message };
    writeAh({ ...readAh(), last });
    log(`[apple health] ${(e as Error).message}`);
    return last;
  }
}
