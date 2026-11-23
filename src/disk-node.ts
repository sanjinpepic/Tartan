/** The PC's data folder as a Disk (Bun / Node only). */
import { appendFile, chmod, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { env, type Disk, type DiskEntry } from "./disk.ts";

/** $TARTAN_DATA (or the older $FREESUUNTO_DATA), else the project's own data/ folder (independent of the cwd an MCP client launches us in). */
export function defaultDataDir(): string {
  return env("TARTAN_DATA") ?? env("FREESUUNTO_DATA") ?? fileURLToPath(new URL("../data/", import.meta.url));
}

export class NodeDisk implements Disk {
  readonly root: string;

  constructor(root = defaultDataDir()) {
    this.root = resolve(root);
  }

  /** Absolute path inside the data folder; refuses anything that escapes it. */
  abs(path: string): string {
    const full = resolve(this.root, "." + sep + path);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error(`refusing path ${path}`);
    return full;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return readFile(this.abs(path)).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength), () => null);
  }

  async readHead(path: string, bytes: number): Promise<Uint8Array | null> {
    const fh = await open(this.abs(path), "r").catch(() => null);
    if (!fh) return null;
    try {
      const buf = new Uint8Array(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async readText(path: string): Promise<string | null> {
    return readFile(this.abs(path), "utf8").catch(() => null);
  }

  private locked: Promise<void> | null = null;
  /** The data folder holds health data and keys: only its owner may open it (0700, once per run). */
  private lock(): Promise<void> {
    this.locked ??= mkdir(this.root, { recursive: true, mode: 0o700 }).then(() => chmod(this.root, 0o700)).catch(() => {});
    return this.locked;
  }

  async write(path: string, data: Uint8Array | string, opts: { secret?: boolean } = {}): Promise<void> {
    const file = this.abs(path);
    await this.lock();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, data, opts.secret ? { mode: 0o600 } : undefined);
    if (opts.secret) await chmod(file, 0o600).catch(() => {});
  }

  async append(path: string, text: string): Promise<void> {
    const file = this.abs(path);
    await this.lock();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, text);
  }

  async list(dir: string): Promise<DiskEntry[]> {
    const base = this.abs(dir);
    const out: DiskEntry[] = [];
    for (const e of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (!e.isFile() && !e.isDirectory()) continue;
      const st = await stat(`${base}${sep}${e.name}`).catch(() => null);
      if (st) out.push({ name: e.name, dir: e.isDirectory(), size: st.size, mtime: st.mtimeMs });
    }
    return out;
  }

  async stat(path: string): Promise<{ size: number; mtime: number; dir: boolean } | null> {
    const st = await stat(this.abs(path)).catch(() => null);
    return st && { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
  }
}
