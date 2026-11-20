/**
 * A backup of everything Tartan keeps, in one file only you can open: the data folder (workouts,
 * plan, lifts, check-ins, coach notes and keys, watch files) plus the app's own settings, packed,
 * gzipped and encrypted with a key made from your passphrase (PBKDF2-SHA256, AES-256-GCM).
 * Without the passphrase the file is noise; a changed byte or a wrong passphrase fails whole.
 *
 * File layout: "TARTANBK" | version u8 | PBKDF2 iterations u32 | salt 16 | iv 12 | ciphertext.
 * The header is the ciphertext's associated data. Inside (after gunzip): JSON metadata line,
 * then per file: u32 path length | path | f64 mtime | u32 size | bytes.
 */
import type { Disk } from "./disk.ts";

const MAGIC = new TextEncoder().encode("TARTANBK");
const VERSION = 1;
const ITERATIONS = 310_000;
/** Never in a backup: caches, half-written files, one-time sign-in state, the phone link keys (a restored PC pairs its phones again). */
const LEAVE_OUT = [/^cache\//, /\.tmp$/, /^strava\/oauth-states\.json$/, /^pairing-token\.txt$/, /^events\.jsonl$/, /^link\//];
export const MIN_PASSPHRASE = 8;

export interface BackupFile {
  path: string;
  mtime: number;
  data: Uint8Array;
}
export interface Backup {
  created: string;
  /** The app's own settings (the phone's localStorage), by key. */
  app: Record<string, string>;
  files: BackupFile[];
}

const inBackup = (path: string) => !!path && !path.split("/").includes("..") && !LEAVE_OUT.some((r) => r.test(path));

async function walk(disk: Disk, dir = ""): Promise<Array<{ path: string; mtime: number }>> {
  const out: Array<{ path: string; mtime: number }> = [];
  for (const e of await disk.list(dir)) {
    const path = dir ? `${dir}/${e.name}` : e.name;
    if (e.dir) {
      if (inBackup(`${path}/`)) out.push(...(await walk(disk, path)));
    } else if (inBackup(path)) out.push({ path, mtime: e.mtime });
  }
  return out;
}

async function keyFor(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Pack, gzip and encrypt everything on `disk` (and the app's settings). */
export async function makeBackup(disk: Disk, passphrase: string, app: Record<string, string> = {}, now = new Date()): Promise<Uint8Array> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [enc.encode(`${JSON.stringify({ created: now.toISOString(), app })}\n`)];
  for (const f of await walk(disk)) {
    const data = await disk.read(f.path);
    if (!data) continue;
    const path = enc.encode(f.path);
    const head = new DataView(new ArrayBuffer(4 + path.length + 12));
    head.setUint32(0, path.length, true);
    new Uint8Array(head.buffer).set(path, 4);
    head.setFloat64(4 + path.length, f.mtime, true);
    head.setUint32(12 + path.length, data.length, true);
    parts.push(new Uint8Array(head.buffer), data);
  }
  const packed = await through(concat(parts), new CompressionStream("gzip"));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = new Uint8Array(MAGIC.length + 1 + 4 + 16 + 12);
  header.set(MAGIC, 0);
  header[MAGIC.length] = VERSION;
  new DataView(header.buffer).setUint32(MAGIC.length + 1, ITERATIONS, true);
  header.set(salt, MAGIC.length + 5);
  header.set(iv, MAGIC.length + 21);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: header as BufferSource }, await keyFor(passphrase, salt, ITERATIONS), packed as BufferSource));
  return concat([header, sealed]);
}

/** Open a backup; throws in plain words on a wrong passphrase, a damaged file or a file that isn't one. */
export async function readBackup(file: Uint8Array, passphrase: string): Promise<Backup> {
  const h = MAGIC.length + 1 + 4 + 16 + 12;
  if (file.length < h + 16 || !MAGIC.every((b, i) => file[i] === b)) throw new Error("this isn't a Tartan backup");
  if (file[MAGIC.length] !== VERSION) throw new Error("this backup is from a newer Tartan: update the app first");
  const header = file.subarray(0, h);
  const iterations = new DataView(file.buffer, file.byteOffset).getUint32(MAGIC.length + 1, true);
  if (iterations < 100_000 || iterations > 10_000_000) throw new Error("this backup's header is damaged");
  let packed: Uint8Array;
  try {
    const key = await keyFor(passphrase, file.slice(MAGIC.length + 5, MAGIC.length + 21), iterations);
    packed = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: file.slice(MAGIC.length + 21, h) as BufferSource, additionalData: header as BufferSource }, key, file.subarray(h) as BufferSource));
  } catch {
    throw new Error("wrong passphrase, or the file was changed");
  }
  const raw = await through(packed, new DecompressionStream("gzip"));
  const nl = raw.indexOf(10);
  const meta = JSON.parse(new TextDecoder().decode(raw.subarray(0, nl))) as { created: string; app?: Record<string, string> };
  const files: BackupFile[] = [];
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let at = nl + 1; at < raw.length; ) {
    const n = v.getUint32(at, true);
    const path = new TextDecoder().decode(raw.subarray(at + 4, at + 4 + n));
    const mtime = v.getFloat64(at + 4 + n, true);
    const size = v.getUint32(at + 12 + n, true);
    const start = at + 16 + n;
    if (start + size > raw.length) throw new Error("this backup is cut short");
    if (inBackup(path)) files.push({ path, mtime, data: raw.slice(start, start + size) });
    at = start + size;
  }
  return { created: meta.created, app: meta.app ?? {}, files };
}

/** Put a backup's files back (overwriting what's there); text stays text, keys stay owner-only. */
export async function restoreBackup(disk: Disk, b: Backup): Promise<number> {
  for (const f of b.files) {
    let out: Uint8Array | string = f.data;
    try {
      out = new TextDecoder("utf-8", { fatal: true }).decode(f.data);
    } catch {
      // binary (watch files, FIT)
    }
    await disk.write(f.path, out, { secret: /tokens|settings|key|secret|^strava\//i.test(f.path) });
  }
  return b.files.length;
}

/** "tartan-backup-2026-10-24.tartan" */
export const backupName = (d = new Date()) => `tartan-backup-${d.toISOString().slice(0, 10)}.tartan`;
