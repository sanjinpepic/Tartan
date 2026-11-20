/**
 * Health Connect on the phone (src/health-connect.ts for what goes where): ask for access, then
 * on each sync read other apps' workouts, sleep and HRV, and write Tartan's workouts and the
 * watch's health log. Off until connected in Settings → Sources. Android only.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { app, log } from "../state.ts";

interface TartanHealth {
  status(): Promise<{ status: "available" | "update" | "unavailable" }>;
  granted(): Promise<{ granted: string[] }>;
  requestAccess(o: { permissions: string[] }): Promise<{ granted: string[] }>;
  openSettings(): Promise<void>;
  write(o: { records: unknown[] }): Promise<{ written: number; skipped: number }>;
  workouts(o: { start: number; end: number; known: string[]; limit?: number }): Promise<{ sessions: Array<{ id: string }>; more: boolean }>;
  read(o: { start: number; end: number }): Promise<{
    exercise: Array<{ start: number; end: number; source: string; title: string }>;
    sleep: Array<{ id: string; start: number; end: number; source: string; stages: Array<[number, number, number]> }>;
    hrv: Array<[number, number, string]>;
  }>;
  removeOurs(): Promise<{ kinds: number }>;
  /** Tartan's planned sessions from today on replaced by these (src/workout/export.ts HcPlanned). */
  writePlanned(o: { records: unknown[] }): Promise<{ written: number; removed: number; unsupported?: boolean; denied?: boolean }>;
}
const Native = registerPlugin<TartanHealth>("TartanHealth");

export type HcKind = "workouts" | "vitals" | "activity" | "sleep" | "import" | "plan";
const P = (s: string) => `android.permission.health.${s}`;
/** Health Connect permissions per kind of data. */
export const PERMISSIONS: Record<HcKind, string[]> = {
  workouts: ["WRITE_EXERCISE", "WRITE_EXERCISE_ROUTE", "WRITE_HEART_RATE", "WRITE_DISTANCE", "WRITE_ACTIVE_CALORIES_BURNED", "READ_EXERCISE"].map(P),
  vitals: ["WRITE_HEART_RATE", "WRITE_OXYGEN_SATURATION", "WRITE_RESTING_HEART_RATE"].map(P),
  activity: ["WRITE_STEPS", "WRITE_ACTIVE_CALORIES_BURNED"].map(P),
  sleep: ["READ_SLEEP", "READ_HEART_RATE_VARIABILITY"].map(P),
  // Other apps' workouts in full; routes and history only where Health Connect offers them.
  import: ["READ_EXERCISE", "READ_HEART_RATE", "READ_DISTANCE", "READ_SPEED", "READ_EXERCISE_ROUTES", "READ_HEALTH_DATA_HISTORY"].map(P),
  // The plan's coming week as planned workouts, for the watch apps that read them (Samsung, Pixel).
  plan: ["WRITE_PLANNED_EXERCISE"].map(P),
};
/** Asked for, but Tartan works without them (older Health Connect doesn't have them). */
export const OPTIONAL = (p: string) => /ROUTES?$|HISTORY$|PLANNED_EXERCISE$/.test(p);

export interface HcState {
  on: boolean;
  kinds: Record<HcKind, boolean>;
  /** Workouts written: library id → what was written (src/health-connect.ts workoutKey). */
  sent: Record<string, string>;
  /** Workouts from this time on (ms): set when connected, 30 days back. */
  since: number;
  /** The watch log written up to here (ms). */
  trends_after: number;
  last?: { at: number; written: number; covered: number; sleep: number; imported?: number; error?: string };
  /** Other apps' workouts already brought in (Health Connect ids). */
  imported?: string[];
  /** Bring in other apps' workouts from here on (ms): two years back when first asked. */
  import_from?: number;
  /** The plan's week as last written (a key of its sessions and times), and how that went. */
  plan_key?: string;
  plan_last?: { at: number; written: number; unsupported?: boolean; denied?: boolean; error?: string };
}
const KEY = "freesuunto.healthconnect";
/**
 * `plan` (the plan's coming week as planned workouts) is chosen in Settings → Sources → Plan on
 * your watch, not with the other kinds, so it starts off. Until 2.57 it had a switch of its own
 * here that started on: a state saved before then without it keeps it on, as it was.
 */
const DEFAULTS: HcState = { on: false, kinds: { workouts: true, vitals: true, activity: true, sleep: true, import: true, plan: false }, sent: {}, since: 0, trends_after: 0 };

export function readHc(): HcState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<HcState> | null;
    const legacy = v ? { plan: true } : {};
    return { ...DEFAULTS, ...v, kinds: { ...DEFAULTS.kinds, ...legacy, ...v?.kinds }, sent: v?.sent ?? {} };
  } catch {
    return { ...DEFAULTS };
  }
}
export function writeHc(v: HcState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // no storage
  }
}

export const hcNative = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

/** "available", "update" (install or update Health Connect), "unavailable", or "web". */
export async function hcStatus(): Promise<"available" | "update" | "unavailable" | "web"> {
  if (!hcNative()) return "web";
  return (await Native.status().catch(() => ({ status: "unavailable" as const }))).status;
}

export async function hcGranted(): Promise<string[]> {
  return hcNative() ? (await Native.granted().catch(() => ({ granted: [] }))).granted : [];
}

/** Ask for access to the kinds switched on; connected when anything was granted. */
export async function connectHc(kinds = readHc().kinds): Promise<string[]> {
  const wanted = [...new Set((Object.keys(kinds) as HcKind[]).filter((k) => kinds[k]).flatMap((k) => PERMISSIONS[k]))];
  const { granted } = await Native.requestAccess({ permissions: wanted });
  const s = readHc();
  const first = !s.on;
  writeHc({ ...s, kinds, on: granted.length > 0, ...(first ? { since: Date.now() - 30 * 86400_000, sent: {}, trends_after: 0 } : {}) });
  return granted;
}

export const openHcSettings = () => Native.openSettings();

/** Tartan's planned sessions out of Health Connect (switched off). */
export async function writePlanNone(): Promise<void> {
  await Native.writePlanned({ records: [] });
  writeHc({ ...readHc(), plan_key: undefined, plan_last: undefined });
}

/**
 * The plan's coming week as Health Connect planned sessions (at your training times), written
 * again only when a session or its time changed, or when forced. Nothing when not connected or
 * switched off; Health Connect without planned workouts (older versions) is said, not failed.
 */
export async function writePlan(force = false): Promise<HcState["plan_last"] | null> {
  const s = readHc();
  if (!s.on || !s.kinds.plan || !hcNative()) return null;
  const { readFuel } = await import("./watch-workouts.ts");
  const res = await app.api.request("/api/health-connect/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fuel: readFuel() }) });
  const out = (await res.json()) as { records: unknown[]; key: string; error?: string };
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  if (!force && out.key === s.plan_key && s.plan_last && !s.plan_last.error && !s.plan_last.denied && !s.plan_last.unsupported) return s.plan_last;
  try {
    const r = await Native.writePlanned({ records: out.records });
    const last = { at: Date.now(), written: r.written, ...(r.unsupported ? { unsupported: true } : {}), ...(r.denied ? { denied: true } : {}) };
    writeHc({ ...readHc(), plan_key: r.unsupported || r.denied ? undefined : out.key, plan_last: last });
    if (r.written || r.removed) log(`[health connect] the coming week as planned workouts: ${r.written} written`);
    return last;
  } catch (e) {
    const last = { at: Date.now(), written: 0, error: (e as Error).message };
    writeHc({ ...readHc(), plan_last: last });
    throw e;
  }
}

/** Stop, and optionally remove everything Tartan wrote to Health Connect. */
export async function disconnectHc(remove: boolean): Promise<void> {
  if (remove) await Native.removeOurs();
  writeHc({ ...readHc(), on: false, sent: {}, trends_after: 0, last: undefined, plan_key: undefined, plan_last: undefined });
}

let running: Promise<HcState["last"] | null> | null = null;
const EVERY = 30 * 60_000;

/**
 * One round: what other apps have (their workouts, sleep, HRV), then Tartan's records out. Runs at
 * most every 30 minutes unless forced; nothing when not connected.
 */
export function syncHc(force = false): Promise<HcState["last"] | null> {
  if (running) return running;
  running = once(force).finally(() => (running = null));
  return running;
}

async function once(force: boolean): Promise<HcState["last"] | null> {
  const s = readHc();
  if (!s.on || !hcNative()) return null;
  if (!force && s.last && Date.now() - s.last.at < EVERY) return s.last;
  const now = Date.now();
  try {
    const read = await Native.read({ start: Math.min(s.since, now - 14 * 86400_000) - 86400_000, end: now });
    let sleep = 0;
    if (s.kinds.sleep && (read.sleep.length || read.hrv.length)) {
      const res = await app.api.request("/api/health-connect/in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sleep: read.sleep, hrv: read.hrv }) });
      sleep = ((await res.json()) as { sleep: number }).sleep;
    }
    const res = await app.api.request("/api/health-connect/out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: s.since, sent: s.sent, trends_after: s.trends_after, kinds: s.kinds, others: read.exercise }),
    });
    const out = (await res.json()) as { records: unknown[]; sent: Record<string, string>; covered: number; trends_last: number; error?: string };
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    let written = 0;
    // In pieces of about a megabyte (a workout with its route is far bigger than a step count).
    let piece: unknown[] = [];
    let size = 0;
    for (const r of [...out.records, null]) {
      const n = r ? JSON.stringify(r).length : 0;
      if (piece.length && (!r || size + n > 1_000_000 || piece.length >= 500)) {
        written += (await Native.write({ records: piece })).written;
        [piece, size] = [[], 0];
      }
      if (r) {
        piece.push(r);
        size += n;
      }
    }
    // Remember the last 600 workouts written.
    const sent = Object.fromEntries(Object.entries({ ...s.sent, ...out.sent }).slice(-600));
    const last = { at: now, written, covered: out.covered, sleep };
    writeHc({ ...readHc(), sent, trends_after: Math.max(s.trends_after, out.trends_last), last });
    const imported = s.kinds.import ? await bringIn(now) : 0;
    if (s.kinds.plan) await writePlan().catch((e) => log(`[health connect] planned workouts: ${(e as Error).message}`));
    if (imported) writeHc({ ...readHc(), last: { ...readHc().last!, imported } });
    log(`[health connect] wrote ${written} records (${Object.keys(out.sent).length - out.covered} workouts; ${out.covered} already there from another app); read ${read.sleep.length} sleep sessions, ${read.hrv.length} HRV readings, ${read.exercise.length} other workouts`);
    return { ...last, imported };
  } catch (e) {
    const last = { at: now, written: 0, covered: 0, sleep: 0, error: (e as Error).message };
    writeHc({ ...readHc(), last });
    log(`[health connect] ${(e as Error).message}`);
    return last;
  }
}

/**
 * Other apps' workouts (Samsung Health, the Suunto app, Fitbit, Coros…) brought in whole, newest
 * first, 20 at a time, each kept once (src/health-connect.ts hcWorkout). The first time, two years
 * back (as far as Health Connect lets Tartan read). How many came in.
 */
async function bringIn(now: number): Promise<number> {
  const s = readHc();
  const from = s.import_from ?? now - 730 * 86400_000;
  const known = new Set(s.imported ?? []);
  let added = 0;
  for (let round = 0; round < 40; round++) {
    const got = await Native.workouts({ start: from, end: now, known: [...known], limit: 20 });
    if (!got.sessions.length) break;
    const res = await app.api.request("/api/health-connect/workouts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessions: got.sessions }) });
    const r = (await res.json()) as { added: number; done: string[] };
    added += r.added;
    for (const id of r.done) known.add(id);
    // A session that couldn't be kept is still left out next time (it would come back every round).
    for (const x of got.sessions) known.add(x.id);
    writeHc({ ...readHc(), imported: [...known].slice(-5000), import_from: from });
    if (!got.more) break;
  }
  if (added) log(`[health connect] brought in ${added} workouts from other apps`);
  return added;
}
