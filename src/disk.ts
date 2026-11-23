/**
 * Where Tartan keeps its data, as a tiny async file API. The library, Strava sync,
 * analytics and the coach only talk to this, so the same code runs on the PC (files under
 * data/, see ./disk-node.ts) and inside the Android app (app-private storage, see
 * web/disk-capacitor.ts).
 *
 * Paths are relative to the data folder and use "/" (e.g. "strava/index.json").
 */

export interface DiskEntry {
  name: string;
  dir: boolean;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
}

export interface Disk {
  /** Where the data lives, for display ("/home/me/Tartan/data", "this phone"). */
  readonly root: string;
  /** null if the file does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** The first `bytes` of a file, where the storage can read part of one. */
  readHead?(path: string, bytes: number): Promise<Uint8Array | null>;
  readText(path: string): Promise<string | null>;
  /** Creates parent folders. `secret` files are made readable by the owner only where the OS allows. */
  write(path: string, data: Uint8Array | string, opts?: { secret?: boolean }): Promise<void>;
  append(path: string, text: string): Promise<void>;
  /** Entries directly in `dir`; [] if it does not exist. */
  list(dir: string): Promise<DiskEntry[]>;
  stat(path: string): Promise<{ size: number; mtime: number; dir: boolean } | null>;
}

export async function readJson<T>(disk: Disk, path: string): Promise<T | null> {
  const text = await disk.readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Joins path segments with "/", dropping empty ones and leading/trailing slashes. */
export function joinPath(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split("/"))
    .filter(Boolean)
    .join("/");
}

/** process.env where there is one (Bun/Node), undefined in the app's WebView. */
export function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

/** Everything in memory: for tests, and for previewing the phone's storage mode. */
export class MemoryDisk implements Disk {
  readonly root = "memory";
  readonly files = new Map<string, { data: Uint8Array; mtime: number }>();

  private key(path: string): string {
    const k = joinPath(path);
    if (k.split("/").includes("..")) throw new Error(`refusing path ${path}`);
    return k;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(this.key(path))?.data.slice() ?? null;
  }

  async readText(path: string): Promise<string | null> {
    const d = await this.read(path);
    return d && new TextDecoder().decode(d);
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    this.files.set(this.key(path), { data: typeof data === "string" ? new TextEncoder().encode(data) : data.slice(), mtime: Date.now() });
  }

  async append(path: string, text: string): Promise<void> {
    await this.write(path, ((await this.readText(path)) ?? "") + text);
  }

  async list(dir: string): Promise<DiskEntry[]> {
    const prefix = this.key(dir) ? `${this.key(dir)}/` : "";
    const out = new Map<string, DiskEntry>();
    for (const [k, f] of this.files) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) out.set(rest, { name: rest, dir: false, size: f.data.length, mtime: f.mtime });
      else out.set(rest.slice(0, slash), { name: rest.slice(0, slash), dir: true, size: 0, mtime: f.mtime });
    }
    return [...out.values()];
  }

  async stat(path: string): Promise<{ size: number; mtime: number; dir: boolean } | null> {
    const k = this.key(path);
    const f = this.files.get(k);
    if (f) return { size: f.data.length, mtime: f.mtime, dir: false };
    return [...this.files.keys()].some((x) => x.startsWith(`${k}/`)) ? { size: 0, mtime: 0, dir: true } : null;
  }
}
