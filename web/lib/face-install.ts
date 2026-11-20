/**
 * Watch faces onto the watch (the engine's part of views/face.ts): which of Tartan's faces are
 * on the watch, as this phone knows it, and installing one over Bluetooth.
 */
import type { FaceDesign } from "../../src/watchface/tartan-face.ts";
import { success } from "./haptics.ts";
import { notify } from "../state.ts";
import * as watch from "../watch.ts";

const INSTALLED = "freesuunto.faces.installed";
export const installed = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(INSTALLED) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
};
export const setInstalled = (next: Record<string, string>) => {
  try {
    localStorage.setItem(INSTALLED, JSON.stringify(next));
  } catch {
    // no storage: the watch still knows
  }
};
export const markInstalled = (id: string) => setInstalled({ ...installed(), [id]: new Date().toISOString() });
export const unmarkInstalled = (id: string) => {
  const { [id]: _, ...rest } = installed();
  setInstalled(rest);
};

/** Install a design; `status` hears the progress and the outcome. */
export async function installFace(d: FaceDesign, status: (text: string) => void = () => {}): Promise<string> {
  const { packageFor } = await import("./faces.ts");
  status("Drawing the face…");
  try {
    const pkg = await packageFor(d);
    await watch.installFace(pkg, status);
    markInstalled(d.id);
    success();
    const done = "On your watch now. Pick it where you change faces on the watch.";
    status(done);
    notify(`${d.name} is on your watch.`);
    return done;
  } catch (e) {
    if (/already on your watch/.test((e as Error).message)) markInstalled(d.id);
    status("Not installed. The activity log under More says what the watch answered.");
    throw e;
  }
}
