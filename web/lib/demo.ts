/**
 * The demo: Tartan with sample data (src/sample.ts), to try before connecting anything. It runs on
 * storage of its own (web/disk-capacitor.ts reads the flag), so your data is never touched, and
 * nothing syncs while it's on (no Strava, watch, Health Connect or intervals.icu). Leaving deletes
 * the sample and brings the app back as it was (the intro again, if it wasn't finished).
 */
import { Directory, Filesystem } from "@capacitor/filesystem";
import { app, log } from "../state.ts";

export const DEMO = "tartan.demo";
export const DEMO_BASE = "TartanDemo";
const INTRO_BEFORE = "tartan.demo.intro";
const DONE = "freesuunto.onboarded";

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // no storage
  }
};

export const inDemo = () => get(DEMO) === "1";

/** Into the demo: its own storage, the intro set aside, and the app again. */
export function startDemo(): void {
  if (inDemo()) return;
  set(INTRO_BEFORE, get(DONE) ?? "");
  set(DONE, "1");
  set(DEMO, "1");
  set("tartan.demo.switched", "1");
  setTimeout(() => location.reload(), 200);
}

/** Out of the demo: the sample deleted, the intro as it was, and the app again on your own data. */
export async function leaveDemo(): Promise<void> {
  if (!inDemo()) return;
  set(DEMO, null);
  set(DONE, get(INTRO_BEFORE) || null);
  set(INTRO_BEFORE, null);
  set("tartan.demo.switched", "1");
  await Filesystem.rmdir({ path: DEMO_BASE, directory: Directory.Data, recursive: true }).catch(() => {});
  setTimeout(() => location.reload(), 200);
}

/** In the demo, the sample written once (the first start). Whether it was just written. */
export async function seedDemo(): Promise<boolean> {
  if (!inDemo()) return false;
  const r = await app.api.json<{ workouts?: number }>("/api/sample/seed", { method: "POST" }).catch((e: Error) => (log(`[demo] ${e.message}`), null));
  return (r?.workouts ?? 0) > 0;
}
