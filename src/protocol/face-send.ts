/**
 * Install a watch face on the Suunto Run 2 the way the Suunto app does it (HCI capture of
 * 16 Oct 2026):
 *
 *   GET  /WatchFace/Lists                      the faces on the watch, five a page (logged)
 *   PUT  /WatchFace/Info                       id, name, version, size, feature, MD5, preview
 *   GET  /WatchFace/InstallPath                → /emmc/dial/download/<id>.zip
 *   PUT  /Dev/FileSystem/Stream (file client)  the path (100), then the zip in 453-byte pieces
 *   PUT  /WatchFace/Install                    no parameters
 *   GET  /WatchFace/Lists                      the new face is there
 *
 * The Info record is laid out from the watch's own description and must have the shape of the
 * one the Suunto app wrote (seven text and number fields, then three optional ones); the file
 * goes only to the path the watch names, and only under /emmc/dial/download/. Nothing else is
 * written.
 */
import { printableStrings } from "./codec.ts";
import { encodeStruct, layoutOf, structParam, type Layout, type TypeMeta, type Value } from "./wbstruct.ts";
import type { FacePackage } from "../watchface/package.ts";

export interface FaceRpc {
  rpc(path: string, params: Uint8Array[], method: "GET" | "PUT", client?: "device" | "files"): Promise<{ status?: number; raw: Uint8Array } | null>;
  typeMeta(id: number): Promise<TypeMeta | null>;
  log(msg: string): void;
}

/** The type /WatchFace/Info takes (a name for the BaseInfo struct, 0x0351). */
export const FACE_INFO_TYPE = 0xb306;
const CHUNK = 453;
const INSTALL_DIR = /^\/emmc\/dial\/download\/[\w.-]+\.zip$/;

const le = (n: number, bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 0xff);
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};
const text = (s: string) => cat(le(12, 2), new TextEncoder().encode(`${s}\0`));
const strings = (raw: Uint8Array) => printableStrings(raw.subarray(14, raw.length - 4), 3);

/**
 * Write a file through the file client, as the Suunto app does: the path first (100 or 200),
 * then 453-byte pieces (each 100, the last 200).
 */
export async function streamFile(r: Pick<FaceRpc, "rpc">, path: string, data: Uint8Array, onSent?: (sent: number) => void): Promise<void> {
  const open = await r.rpc("/Dev/FileSystem/Stream", [text(path)], "PUT", "files");
  if (open?.status !== 100 && open?.status !== 200) throw new Error(`the watch didn't open ${path} (${open?.status ?? "no reply"})`);
  for (let o = 0; o < data.length; o += CHUNK) {
    const piece = data.subarray(o, Math.min(data.length, o + CHUNK));
    const end = o + piece.length;
    const rep = await r.rpc("/Dev/FileSystem/Stream", [cat(le(13, 2), Uint8Array.of(2), le(data.length, 3), le(end, 3), le(piece.length, 2), piece)], "PUT", "files");
    const want = end === data.length ? 200 : 100;
    if (rep?.status !== want) throw new Error(`the watch stopped the file at ${end} of ${data.length} bytes (${rep?.status ?? "no reply"})`);
    onSent?.(end);
  }
}

/** A STRING parameter. */
export const textParam = (s: string) => text(s);

/**
 * What the watch lists: the ids among its faces' strings. The Run 2 lists five faces at a time;
 * 100 means there are more, asked for (as the Suunto app does) with the last id seen.
 */
export async function faceIds(r: Pick<FaceRpc, "rpc" | "log">): Promise<string[] | null> {
  const ids: string[] = [];
  const seen: string[] = [];
  for (let page = 0; page < 12; page++) {
    const rep = await r.rpc("/WatchFace/Lists", page ? [text(ids.at(-1)!)] : [], "GET");
    if (rep?.status !== 200 && rep?.status !== 100) return page ? ids : null;
    const all = strings(rep.raw);
    seen.push(...all);
    const found = all.flatMap((s) => s.match(/\d{6,10}/g) ?? []).filter((id) => !ids.includes(id));
    ids.push(...found);
    if (rep.status === 200 || !found.length) break;
  }
  r.log(`[face] on the watch: ${seen.join(" | ").slice(0, 400)}`);
  return ids;
}

export interface FaceProgress {
  stage: "checking" | "sending" | "installing";
  sent?: number;
  total?: number;
}

export async function installFaceOnWatch(r: FaceRpc, pkg: FacePackage, onProgress?: (p: FaceProgress) => void): Promise<{ id: string; bytes: number }> {
  onProgress?.({ stage: "checking" });
  // The Suunto app deletes a face before sending it again; Tartan doesn't delete, so it stops.
  if ((await faceIds(r))?.includes(pkg.id)) throw new Error(`${pkg.name} is already on your watch. To put a changed version on, remove it on the watch first; nothing was sent`);

  // 1. The Info record, laid out from the watch's description; it must be the Suunto app's shape.
  const metas = new Map<number, TypeMeta | null>();
  const layout = await layoutOf(FACE_INFO_TYPE, async (id) => {
    if (!metas.has(id)) metas.set(id, await r.typeMeta(id));
    return metas.get(id)!;
  });
  if (layout.kind !== "struct") throw new Error("the watch's face record isn't a struct; nothing was sent");
  const kinds = layout.fields.map((f) => (f.layout.kind === "scalar" ? f.layout.scalar : f.layout.kind) + (f.required ? "" : "?"));
  r.log(`[face] Info 0x${FACE_INFO_TYPE.toString(16)}: ${layout.size} bytes: ${layout.fields.map((f, i) => `${f.name}@${f.offset}:${kinds[i]}`).join(", ")}`);
  const shape = ["string", "string", "string", "u32", "string", "string", "string", "struct?", "u32?", "u32?"];
  if (kinds.join() !== shape.join() || layout.size !== 72) throw new Error("the watch describes faces differently from the Run 2 Tartan knows; nothing was sent");
  const f = layout.fields.map((x) => x.name);
  const values: Record<string, Value> = {
    [f[0]!]: pkg.id,
    [f[1]!]: pkg.name,
    [f[2]!]: pkg.version,
    [f[3]!]: pkg.zip.length,
    [f[4]!]: pkg.feature,
    [f[5]!]: pkg.md5,
    [f[6]!]: pkg.preview,
    [f[7]!]: null,
    [f[8]!]: null,
    // The Suunto app set the last one to a time (the face's release); now will do.
    [f[9]!]: Math.floor(Date.now() / 1000),
  };
  const info = await r.rpc("/WatchFace/Info", [structParam(FACE_INFO_TYPE, (layout as Extract<Layout, { kind: "struct" }>).align, encodeStruct(layout, values))], "PUT");
  if (info?.status !== 200) throw new Error(`the watch didn't take the face's details (${info?.status ?? "no reply"})`);

  // 2. Where it wants the file.
  const at = await r.rpc("/WatchFace/InstallPath", [], "GET");
  const path = at?.status === 200 ? strings(at.raw).find((s) => s.startsWith("/emmc/")) : undefined;
  r.log(`[face] install path: ${path ?? `none (${at?.status ?? "no reply"})`}`);
  if (!path || !INSTALL_DIR.test(path)) throw new Error("the watch didn't say where the face goes; nothing was sent");

  // 3. The zip, through the file client.
  const z = pkg.zip;
  await streamFile(r, path, z, (sent) => onProgress?.({ stage: "sending", sent, total: z.length }));

  // 4. Install, then look.
  onProgress?.({ stage: "installing" });
  const done = await r.rpc("/WatchFace/Install", [], "PUT");
  if (done?.status !== 200) throw new Error(`the watch didn't install the face (${done?.status ?? "no reply"})`);
  const ids = await faceIds(r);
  if (ids && !ids.includes(pkg.id)) throw new Error("the watch took the face but doesn't list it");
  return { id: pkg.id, bytes: z.length };
}

// ------------------------------------------------------------------ removing

/** The type /WatchFace/Delete/MultiId takes: a list of face ids (named "Ids", struct 0x0352). */
export const FACE_IDS_TYPE = 0xb307;
/** Faces Tartan made have ids from 2 000 000 000; the watch's own and Suunto's are lower. */
export const isTartanFaceId = (id: string) => /^\d{10}$/.test(id) && Number(id) >= 2_000_000_000 && Number(id) <= 2_147_483_647;

/**
 * The Ids record for one face, as the Suunto app sends it to uninstall (capture, 16 Oct): the
 * list (u32 count, u32 offset 8), then the one element (a string offset, 12), then the id.
 */
export function faceIdsRecord(id: string): Uint8Array {
  const text = new TextEncoder().encode(`${id}\0`);
  const out = new Uint8Array(12 + text.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 1, true);
  v.setUint32(4, 8, true);
  v.setUint32(8, 12, true);
  out.set(text, 12);
  return out;
}

/**
 * Remove a face Tartan installed, the way the Suunto app's "Uninstall" does:
 * PUT /WatchFace/Delete/MultiId with its id, then check the list. Only Tartan's own faces
 * (isTartanFaceId), only when the watch lists it, and only when the watch describes the record
 * as the Run 2 did (a struct holding one list).
 */
export async function removeFaceFromWatch(r: FaceRpc, id: string): Promise<{ removed: boolean }> {
  if (!isTartanFaceId(id)) throw new Error("Tartan only removes faces it made; nothing was sent");
  const before = await faceIds(r);
  if (!before) throw new Error("the watch didn't list its faces; nothing was sent");
  if (!before.includes(id)) return { removed: false };
  const layout = await layoutOf(FACE_IDS_TYPE, async (t) => r.typeMeta(t));
  r.log(`[face] Ids 0x${FACE_IDS_TYPE.toString(16)}: ${layout.kind === "struct" ? layout.fields.map((f) => `${f.name}@${f.offset}:${f.layout.kind}`).join(", ") : layout.kind}`);
  if (layout.kind !== "struct" || layout.size !== 8 || layout.fields.length !== 1 || layout.fields[0]!.layout.kind !== "array" || !layout.fields[0]!.required) {
    throw new Error("the watch describes face removal differently from the Run 2 Tartan knows; nothing was sent");
  }
  const rep = await r.rpc("/WatchFace/Delete/MultiId", [structParam(FACE_IDS_TYPE, 4, faceIdsRecord(id))], "PUT");
  if (rep?.status !== 200) throw new Error(`the watch didn't remove the face (${rep?.status ?? "no reply"})`);
  const after = await faceIds(r);
  if (after?.includes(id)) throw new Error("the watch still lists the face");
  return { removed: true };
}
