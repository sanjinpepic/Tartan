/**
 * Local data layout (everything stays on your disk, or in the app's storage on the phone):
 *
 *   watches/<watch>/files/<path on watch>   raw files copied over Bluetooth
 *   watches/<watch>/info.json               name, generation, /Info strings, last sync
 *   cloud/workouts/<key>.json|.fit|.gpx     the Suunto cloud export (until 2.56; still read)
 *   cloud/wellness/<kind>.json
 *   events.jsonl                            sync log for the freshness strip
 */
import { joinPath, readJson, type Disk } from "./disk.ts";
import { normalize } from "./protocol/session.ts";
import { sniff, type FileSink } from "./protocol/sync.ts";

import { slug, type SyncEvent } from "./slug.ts";
export { slug };

export interface LocalFile {
  path: string;
  bytes: number;
  modified: number;
  kind: string;
}

export class LocalStore {
  /** File kinds by path + size + mtime, so listing a big backup doesn't re-read every file. */
  private kinds = new Map<string, string>();

  constructor(readonly disk: Disk) {}

  get root(): string {
    return this.disk.root;
  }

  watchDir(watch: string): string {
    return joinPath("watches", slug(watch));
  }

  /** Data-relative path for a file copied from the watch; refuses anything escaping the folder. */
  watchFile(watch: string, watchPath: string): string {
    const canonical = normalize(watchPath);
    if (canonical.split("/").some((seg) => seg === "..")) throw new Error(`refusing path ${watchPath}`);
    return joinPath(this.watchDir(watch), "files", canonical);
  }

  sink(watch: string): FileSink {
    return {
      has: async (p) => (await this.disk.stat(this.watchFile(watch, p)))?.dir === false,
      put: (p, data) => this.disk.write(this.watchFile(watch, p), data),
    };
  }

  readWatchFile(watch: string, path: string): Promise<Uint8Array | null> {
    return this.disk.read(this.watchFile(watch, path));
  }

  async saveInfo(watch: string, info: object): Promise<void> {
    const file = joinPath(this.watchDir(watch), "info.json");
    const previous = (await readJson<Record<string, unknown>>(this.disk, file)) ?? {};
    await this.disk.write(file, JSON.stringify({ ...previous, ...info, updated: new Date().toISOString() }, null, 2));
  }

  async watches(): Promise<Array<{ id: string; info: Record<string, unknown>; files: number; bytes: number }>> {
    const ids = (await this.disk.list("watches")).filter((e) => e.dir).map((e) => e.name);
    const out = [];
    for (const id of ids.sort()) {
      const files = await this.files(id);
      out.push({
        id,
        info: (await readJson<Record<string, unknown>>(this.disk, joinPath("watches", id, "info.json"))) ?? {},
        files: files.length,
        bytes: files.reduce((n, f) => n + f.bytes, 0),
      });
    }
    return out;
  }

  async files(watch: string): Promise<LocalFile[]> {
    const base = joinPath(this.watchDir(watch), "files");
    const out: LocalFile[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const e of await this.disk.list(joinPath(base, rel))) {
        const path = `${rel}/${e.name}`;
        if (e.dir) await walk(path);
        else out.push({ path, bytes: e.size, modified: e.mtime, kind: await this.kind(joinPath(base, path), e.size, e.mtime) });
      }
    };
    await walk("");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async kind(file: string, size: number, mtime: number): Promise<string> {
    const key = `${file}|${size}|${mtime}`;
    let kind = this.kinds.get(key);
    if (kind === undefined) {
      // Phone storage can only read whole files: name big ones by extension instead.
      const head = this.disk.readHead ? await this.disk.readHead(file, 512) : size <= 1 << 20 ? await this.disk.read(file) : null;
      kind = head ? sniff(head.subarray(0, 512)) : /\.fit$/i.test(file) ? "FIT activity file" : "binary";
      this.kinds.set(key, kind);
    }
    return kind;
  }

  /** Append to events.jsonl (the freshness strip's source). Never throws. */
  async logEvent(e: Omit<SyncEvent, "at"> & { at?: string }): Promise<void> {
    try {
      await this.disk.append("events.jsonl", JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");
    } catch {
      // logging must never break a sync
    }
  }

  async events(days = 14): Promise<SyncEvent[]> {
    const since = Date.now() - days * 86400_000;
    const text = (await this.disk.readText("events.jsonl")) ?? "";
    const out: SyncEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as SyncEvent;
        if (Date.parse(e.at) >= since) out.push(e);
      } catch {
        // skip a torn line
      }
    }
    return out;
  }

  /** Data-relative path under cloud/. */
  cloudPath(...parts: string[]): string {
    return joinPath("cloud", ...parts);
  }
}
