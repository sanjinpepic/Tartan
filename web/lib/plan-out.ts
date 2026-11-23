/**
 * The plan's sessions for watches other than a Suunto (src/workout/export.ts): the coming week
 * kept on intervals.icu (which forwards it to Garmin and the other watch accounts it links) and in
 * Health Connect (for Samsung, Pixel and other watches whose app reads planned workouts there),
 * and any session or the whole week as .fit workout files to share or save. A Suunto gets them
 * over Bluetooth instead (lib/watch-workouts.ts). Apple Watch takes workouts only from an iPhone.
 */
import { app } from "../state.ts";
import { saveBytes } from "./files.ts";
import { readFuel } from "./watch-workouts.ts";
import type { PlanView } from "../types.ts";

const json = { "content-type": "application/json" };

export interface IcuPlanState {
  connected: boolean;
  on: boolean;
  at?: string;
  there?: number;
  error?: string;
}

/** intervals.icu: connected, and whether it keeps the plan (and how the last round went). */
export async function icuPlanState(): Promise<IcuPlanState> {
  const s = await app.api.json<{ connected: boolean; plan?: { on: boolean; at?: string; there?: number; error?: string } }>("/api/intervals/status").catch(() => null);
  return { connected: !!s?.connected, on: !!s?.plan?.on, ...(s?.plan?.at ? { at: s.plan.at } : {}), ...(s?.plan?.there !== undefined ? { there: s.plan.there } : {}), ...(s?.plan?.error ? { error: s.plan.error } : {}) };
}

/** The coming week onto intervals.icu (and kept there from now on); what changed. */
export async function sendToIntervals(): Promise<{ added: number; removed: number; there: number }> {
  const res = await app.api.request("/api/intervals/plan", { method: "POST", headers: json, body: JSON.stringify({ fuel: readFuel() }) });
  const r = (await res.json()) as { added: number; removed: number; there: number; error?: string };
  if (!res.ok) throw new Error(r.error ?? `intervals.icu: HTTP ${res.status}`);
  return r;
}

/** Stop keeping the plan on intervals.icu; Tartan's planned workouts come off it. */
export async function stopIntervals(): Promise<number> {
  const res = await app.api.request("/api/intervals/plan", { method: "POST", headers: json, body: JSON.stringify({ off: true }) });
  const r = (await res.json()) as { removed: number; error?: string };
  if (!res.ok) throw new Error(r.error ?? `intervals.icu: HTTP ${res.status}`);
  return r.removed;
}

/** With the sync: once the plan is kept on intervals.icu, bring it up to date (only changes are sent). */
export async function keepIntervals(): Promise<void> {
  const s = await icuPlanState();
  if (s.connected && s.on) await sendToIntervals();
}

const fuelQuery = () => `fuel=${encodeURIComponent(JSON.stringify(readFuel()))}`;
const fileName = (res: Response, fallback: string) => res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallback;

/** One session as a .fit workout file, through the share sheet (or a download on the PC). */
export async function shareSessionFile(date: string, kind: string): Promise<string> {
  const res = await app.api.request(`/api/plan/workout.fit?date=${encodeURIComponent(date)}&kind=${encodeURIComponent(kind)}&${fuelQuery()}`);
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  const name = fileName(res, `${date} workout.fit`);
  await saveBytes(name, new Uint8Array(await res.arrayBuffer()), "application/vnd.ant.fit", "Open it in your watch's app");
  return name;
}

/** The coming week as .fit workout files in a zip. */
export async function shareWeekFiles(): Promise<string> {
  const res = await app.api.request(`/api/plan/week.zip?${fuelQuery()}`);
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  const name = fileName(res, "tartan-week.zip");
  await saveBytes(name, new Uint8Array(await res.arrayBuffer()), "application/zip", "Save the week's workouts");
  return name;
}

export type PlanOutOp = "state" | "intervals" | "intervalsOff" | "hc" | "hcOff" | "files";

/** How the coming week stands on intervals.icu and in Health Connect, and how the last op went (`line`). */
export interface PlanOutState {
  wanted: number;
  intervals: IcuPlanState;
  hc: { status: string; on: boolean; plan: boolean; last: unknown };
  line: string | null;
}

/**
 * The coming week for other watches: intervals.icu (it forwards to Garmin and the others it
 * links), Health Connect's planned workouts (Samsung, Pixel…), .fit files. How each stands; with
 * an op, send (and keep it up to date), stop, or share the week's files. The phone's screens ask
 * through the bridge (rpc planOut); the web views call it directly.
 */
export async function planOut(op: PlanOutOp = "state"): Promise<PlanOutState> {
  const hc = await import("./health-connect.ts");
  let line: string | null = null;
  if (op === "intervals") {
    const r = await sendToIntervals();
    line = r.added || r.removed ? `${r.there} ${r.there === 1 ? "session" : "sessions"} on intervals.icu${r.removed ? ` (${r.removed} old ${r.removed === 1 ? "one" : "ones"} off)` : ""}. It passes them on to your watch's account; it stays up to date by itself.` : "intervals.icu already has the coming week. It stays up to date by itself.";
  } else if (op === "intervalsOff") {
    const n = await stopIntervals();
    line = `Stopped. ${n} planned ${n === 1 ? "workout" : "workouts"} taken off intervals.icu.`;
  } else if (op === "hc") {
    const s = hc.readHc();
    const kinds = { ...s.kinds, plan: true };
    hc.writeHc({ ...s, kinds });
    const granted = await hc.hcGranted();
    if (!s.on || !hc.PERMISSIONS.plan.every((p) => granted.includes(p))) {
      const got = await hc.connectHc(kinds);
      if (!got.length) throw new Error("Nothing was allowed. Tap again and allow Tartan to write planned workouts.");
    }
    const r = await hc.writePlan(true);
    line = r?.unsupported ? "This phone's Health Connect doesn't take planned workouts yet: update it from the Play Store, then try again." : r?.denied ? "Health Connect didn't allow planned workouts. Allow them in Health Connect, then try again." : `${r?.written ?? 0} planned ${r?.written === 1 ? "workout" : "workouts"} in Health Connect, for your watch's app to pick up. They stay up to date by themselves.`;
  } else if (op === "hcOff") {
    const s = hc.readHc();
    hc.writeHc({ ...s, kinds: { ...s.kinds, plan: false } });
    if (s.on) await hc.writePlanNone();
    line = "Stopped. Tartan's planned workouts are out of Health Connect.";
  } else if (op === "files") {
    line = `Saved ${await shareWeekFiles()}.`;
  }
  const v = await app.api.json<PlanView>("/api/plan").catch(() => null);
  const { plannedWeek } = await import("../../src/workout/from-plan.ts");
  const hs = hc.readHc();
  const granted = hs.on ? await hc.hcGranted() : [];
  return {
    wanted: v?.plan ? plannedWeek(v, readFuel()).length : 0,
    intervals: await icuPlanState(),
    hc: { status: await hc.hcStatus(), on: hs.on, plan: hs.on && hs.kinds.plan && hc.PERMISSIONS.plan.every((p) => granted.includes(p)), last: hs.plan_last ?? null },
    line,
  };
}

// ------------------------------------------------------------------ where the plan goes (the PC's web app)

/**
 * Where the plan goes for your watch, picked in Settings → Sources → Plan on your watch: "suunto"
 * (over Bluetooth, the default), "intervals" (intervals.icu passes it to Garmin and the others it
 * links), "hc" (Health Connect, on the phone) or "files" (.fit workout files). The Coach tab's watch
 * line sends there. The phone's native screens keep their own choice (PlanDest in CoachPlanOut.kt).
 */
export type PlanDest = "suunto" | "intervals" | "hc" | "files";
const DEST_KEY = "freesuunto.plan.dest";
const DESTS: PlanDest[] = ["suunto", "intervals", "hc", "files"];

export function planDest(): PlanDest {
  try {
    const v = localStorage.getItem(DEST_KEY) as PlanDest | null;
    return v && DESTS.includes(v) ? v : "suunto";
  } catch {
    return "suunto";
  }
}

export function setPlanDest(d: PlanDest): void {
  try {
    localStorage.setItem(DEST_KEY, d);
  } catch {
    // no storage: the default stays
  }
}
