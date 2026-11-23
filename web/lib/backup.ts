/**
 * Backups from the app (src/backup.ts does the packing and the encryption): back up now (the
 * share sheet on the phone, a download on the PC), every week by itself into Documents/Tartan
 * on the phone (the last four kept), and restore from a file.
 *
 * The passphrase is kept in this app's own storage so the weekly backup can run (Android keeps
 * that private to Tartan, and the app opts out of Android's own backup and device transfer); it
 * never goes into a backup, so a backup is no use to someone who finds the file without it. The
 * link to the PC stays out too: a restored phone pairs again, with a fresh key.
 */
import { app, isNative, log } from "../state.ts";
import { saveBytes } from "./files.ts";

const KEY = "freesuunto.backup";
/** Kept out of backups: the passphrase itself and the PC link key. */
const PRIVATE = new Set([KEY, "freesuunto.pc"]);
const WEEK = 7 * 86400_000;
const FOLDER = "Tartan";
const KEEP = 4;

export interface BackupPrefs {
  /** The passphrase, once set (kept here for the weekly backup). */
  pass?: string;
  weekly?: boolean;
  /** Last backup that worked (ms) and where it went. */
  last?: number;
  where?: string;
  /** Last automatic one that didn't, in words. */
  failed?: { at: number; text: string };
}

export function backupPrefs(): BackupPrefs {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as BackupPrefs;
  } catch {
    return {};
  }
}
export function setBackupPrefs(next: BackupPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // no storage: nothing to remember
  }
}

/** The app's own settings worth keeping (which workouts are on the watch, reminders, the intro done…). */
function appSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith("freesuunto.") && !PRIVATE.has(k)) out[k] = localStorage.getItem(k) ?? "";
    }
  } catch {
    // none
  }
  return out;
}

const header = (pass: string) => ({ "x-passphrase": btoa(String.fromCharCode(...new TextEncoder().encode(pass))) });

async function make(pass: string): Promise<{ name: string; data: Uint8Array }> {
  const res = await app.api.request("/api/backup", { method: "POST", headers: { "content-type": "application/json", ...header(pass) }, body: JSON.stringify({ app: appSettings() }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `backup failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "tartan-backup.tartan";
  return { name, data: new Uint8Array(await res.arrayBuffer()) };
}

/** Back up now: the share sheet (Drive, email, Files) on the phone, a download on the PC. */
export async function backupNow(pass: string): Promise<number> {
  const b = await make(pass);
  await saveBytes(b.name, b.data, "application/octet-stream", "Keep your Tartan backup somewhere safe");
  setBackupPrefs({ ...backupPrefs(), last: Date.now(), where: isNative ? "shared" : "downloaded", failed: undefined });
  return b.data.length;
}

/** Once a week, by itself (phone only): into Documents/Tartan, keeping the last four. */
export async function weeklyBackup(): Promise<void> {
  const p = backupPrefs();
  if (!isNative || !p.weekly || !p.pass || (p.last && Date.now() - p.last < WEEK)) return;
  try {
    const b = await make(p.pass);
    const { Directory, Filesystem } = await import("@capacitor/filesystem");
    let bin = "";
    for (let i = 0; i < b.data.length; i += 0x8000) bin += String.fromCharCode(...b.data.subarray(i, i + 0x8000));
    await Filesystem.writeFile({ path: `${FOLDER}/${b.name}`, data: btoa(bin), directory: Directory.Documents, recursive: true });
    // The last four, oldest out.
    const { files } = await Filesystem.readdir({ path: FOLDER, directory: Directory.Documents });
    const ours = files.map((f) => f.name).filter((n) => /^tartan-backup-.*\.tartan$/.test(n)).sort();
    for (const old of ours.slice(0, Math.max(0, ours.length - KEEP))) await Filesystem.deleteFile({ path: `${FOLDER}/${old}`, directory: Directory.Documents }).catch(() => {});
    setBackupPrefs({ ...backupPrefs(), last: Date.now(), where: `Documents/${FOLDER}`, failed: undefined });
    log(`Weekly backup: ${b.name}, ${Math.round(b.data.length / 1024)} KB, in Documents/${FOLDER}.`);
  } catch (e) {
    log(`Weekly backup: ${(e as Error).message}`);
    setBackupPrefs({ ...backupPrefs(), failed: { at: Date.now(), text: (e as Error).message } });
  }
}

/** Restore: put the backup's files and the app's settings back, then start again with them. */
export async function restoreFrom(file: File, pass: string): Promise<{ files: number; created: string }> {
  const res = await app.api.request("/api/backup/restore", { method: "POST", headers: { "content-type": "application/octet-stream", ...header(pass) }, body: new Uint8Array(await file.arrayBuffer()) });
  const r = (await res.json()) as { files?: number; created?: string; app?: Record<string, string>; error?: string };
  if (!res.ok || r.files === undefined) throw new Error(r.error ?? `restore failed (${res.status})`);
  try {
    for (const [k, v] of Object.entries(r.app ?? {})) if (k.startsWith("freesuunto.") && !PRIVATE.has(k)) localStorage.setItem(k, v);
  } catch {
    // the files are back; settings start fresh
  }
  // Remember the passphrase that opened it, for the weekly backups from here on.
  setBackupPrefs({ ...backupPrefs(), pass });
  return { files: r.files, created: r.created ?? "" };
}
