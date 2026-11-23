/**
 * The week on a watch face (src/watchface/tartan-face.ts weekLayer): what each day holds, the
 * week's focus and its kilometres, all true for the whole week. A face is a picture made once
 * and replacing it takes it off the wrist, so it's sent at most once a week: by hand, or by the
 * watch sync when "Keep it up to date" is on and the week on the face is no longer this week.
 */
import { checkDesign, TARTAN_TRACK_DESIGN, type FaceDesign, type WeekOnFace } from "../../src/watchface/tartan-face.ts";
import { app, log } from "../state.ts";
import type { PlanView } from "../types.ts";
import * as watch from "../watch.ts";

export const WEEK_FACE_ID = "2026101702";
export const WEEK_BASE = "freesuunto.weekface.base";
const AUTO = "freesuunto.weekface.auto";
const SENT = "freesuunto.weekface.sent";

const HARD = new Set(["intervals", "tempo", "hills", "race"]);
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // not remembered
    }
  },
};

/** This week as the face shows it, or null without a plan week. */
export function weekOnFace(v: PlanView): WeekOnFace | null {
  const w = v.weeks.find((x) => x.when === "current");
  if (!w) return null;
  const days = w.days.map((d): WeekOnFace["days"][number] => {
    const kinds = d.sessions.map((s) => s.kind).filter((k) => k !== "rest");
    return kinds.some((k) => HARD.has(k)) ? "hard" : kinds.includes("long") ? "long" : kinds.some((k) => k === "easy" || k === "recovery") ? "easy" : kinds.length ? "strength" : "rest";
  });
  const planned = w.target_km ?? w.planned.km;
  return { days, title: w.focus || (days.every((d) => d === "rest") ? "Rest" : "This week"), planned_km: planned };
}

/** What identifies the face's content: when it changes, the face is out of date. */
const keyOf = (v: PlanView, w: WeekOnFace) => `${v.weeks.find((x) => x.when === "current")?.start}|${w.days.join()}|${w.title}|${Math.round(w.planned_km)}`;

export const keepsWeekFace = () => store.get(AUTO) === "1";
export const setKeepsWeekFace = (on: boolean) => store.set(AUTO, on ? "1" : "0");

async function baseDesign(): Promise<FaceDesign> {
  const id = store.get(WEEK_BASE);
  if (!id || id === TARTAN_TRACK_DESIGN.id) return TARTAN_TRACK_DESIGN;
  return checkDesign(await app.api.json<FaceDesign>(`/api/faces/${id}`));
}

/** Put this week's face on the watch (connecting if needed); remembers which week it shows. */
export async function sendWeekFace(v: PlanView, base?: FaceDesign, onProgress?: (t: string) => void): Promise<{ replaced: boolean }> {
  const week = weekOnFace(v);
  if (!week) throw new Error("There's no plan for this week yet");
  const { packageFor } = await import("./faces.ts");
  onProgress?.("Drawing the face…");
  const pkg = await packageFor(base ?? (await baseDesign()), { week, id: WEEK_FACE_ID, name: "Tartan Week" });
  const r = await watch.replaceFace(pkg, onProgress);
  store.set(SENT, keyOf(v, week));
  return r;
}

/** From the watch sync: send the face when it's on and the face no longer shows this week. */
export async function keepWeekFace(v: PlanView): Promise<boolean> {
  if (!keepsWeekFace()) return false;
  const week = weekOnFace(v);
  if (!week || store.get(SENT) === keyOf(v, week)) return false;
  await sendWeekFace(v);
  log("Week face: this week's sent to the watch (pick Tartan Week again if it was on).");
  return true;
}
