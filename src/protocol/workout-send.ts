/**
 * Structured workouts on the Suunto Run 2, the way the Suunto app's workout planner puts them
 * there (HCI capture of 18 Oct 2026). A workout is a SuuntoPlus guide (src/workout/guide.ts):
 *
 *   GET  /Plugin/List                         the guides on the watch (ids, e.g. "ua82weak")
 *   GET  /Plugin/InstallAid                   where they go: /emmc/data/Data/Structured
 *   PUT  /Dev/FileSystem/DirectoryCreate ×4   emmc, emmc/data, … (file client; 501 = already there)
 *   PUT  /Dev/FileSystem/Stream               <folder>/<id>.zip, in 453-byte pieces (file client)
 *   PUT  /Plugin/Install                      no parameters
 *   GET  /Plugin/List                         the new id is there
 *
 * and removing one: PUT /Plugin/Uninstall with its id. Tartan writes only into that folder, only
 * files named for Tartan's own ids ("tt" and six letters or digits), and removes only those.
 */
import { printableStrings } from "./codec.ts";
import { streamFile, textParam, type FaceRpc } from "./face-send.ts";
import { TARTAN_WORKOUT_ID } from "../workout/guide.ts";

export const WORKOUT_DIR = "/emmc/data/Data/Structured";
/** The folders the Suunto app creates on the way, as it names them (no leading slash). */
export const WORKOUT_DIRS = ["emmc", "emmc/data", "emmc/data/Data", "emmc/data/Data/Structured"];

type Rpc = Pick<FaceRpc, "rpc" | "log">;
const strings = (raw: Uint8Array) => printableStrings(raw.subarray(14, raw.length - 4), 3);

/** The ids of the guides on the watch (the Suunto app's and Tartan's). */
export async function workoutIds(r: Rpc): Promise<string[]> {
  const rep = await r.rpc("/Plugin/List", [], "GET");
  if (rep?.status !== 200) throw new Error(`the watch didn't list its workouts (${rep?.status ?? "no reply"})`);
  const all = strings(rep.raw);
  r.log(`[workout] on the watch: ${all.join(" | ").slice(0, 300) || "none"}`);
  return all.flatMap((s) => s.match(/[a-z0-9]{8}$/) ?? []);
}

export interface WorkoutProgress {
  stage: "checking" | "sending" | "installing";
  sent?: number;
  total?: number;
}

/** Put one guide (its zip) on the watch under `id`. */
export async function installWorkoutOnWatch(r: Rpc, id: string, zip: Uint8Array, onProgress?: (p: WorkoutProgress) => void): Promise<void> {
  if (!TARTAN_WORKOUT_ID.test(id)) throw new Error("not a Tartan workout id; nothing was sent");
  onProgress?.({ stage: "checking" });
  if ((await workoutIds(r)).includes(id)) throw new Error("that workout is already on the watch; nothing was sent");
  const aid = await r.rpc("/Plugin/InstallAid", [], "GET");
  const where = aid?.status === 200 ? strings(aid.raw).find((s) => s.startsWith("/emmc/")) : undefined;
  r.log(`[workout] install folder: ${where ?? `none (${aid?.status ?? "no reply"})`}`);
  if (where !== WORKOUT_DIR) throw new Error("the watch keeps workouts somewhere Tartan doesn't know; nothing was sent");
  for (const dir of WORKOUT_DIRS) {
    const rep = await r.rpc("/Dev/FileSystem/DirectoryCreate", [textParam(dir)], "PUT", "files");
    // 501: it's there already (the usual answer).
    if (rep?.status !== 200 && rep?.status !== 501) throw new Error(`the watch didn't make the folder ${dir} (${rep?.status ?? "no reply"})`);
  }
  await streamFile(r, `${WORKOUT_DIR}/${id}.zip`, zip, (sent) => onProgress?.({ stage: "sending", sent, total: zip.length }));
  onProgress?.({ stage: "installing" });
  const done = await r.rpc("/Plugin/Install", [], "PUT");
  if (done?.status !== 200) throw new Error(`the watch didn't install the workout (${done?.status ?? "no reply"})`);
  if (!(await workoutIds(r)).includes(id)) throw new Error("the watch took the workout but doesn't list it");
}

/** Take a Tartan guide off the watch (the Suunto app's are never touched). */
export async function removeWorkoutFromWatch(r: Rpc, id: string): Promise<void> {
  if (!TARTAN_WORKOUT_ID.test(id)) throw new Error("Tartan only removes workouts it made; nothing was sent");
  const rep = await r.rpc("/Plugin/Uninstall", [textParam(id)], "PUT");
  if (rep?.status !== 200) throw new Error(`the watch didn't remove the workout (${rep?.status ?? "no reply"})`);
}
