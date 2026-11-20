/** The Android app's private storage as a Disk: everything lives under Tartan/ in the app's data dir. */
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Capacitor } from "@capacitor/core";
import { joinPath, type Disk, type DiskEntry } from "../src/disk.ts";

const NATIVE = Capacitor.isNativePlatform();

// The folder name predates the rename to Tartan; changing it would hide existing installs' data.
// The demo (lib/demo.ts) has storage of its own, so the sample never meets your data.
const BASE = (() => {
  try {
    return localStorage.getItem("tartan.demo") === "1" ? "TartanDemo" : "FreeSuunto";
  } catch {
    return "FreeSuunto";
  }
})();

export class CapacitorDisk implements Disk {
  readonly root = "this phone (app storage)";
  private readonly dir = Directory.Data;

  private p(path: string): string {
    const rel = joinPath(path);
    if (rel.split("/").includes("..")) throw new Error(`refusing path ${path}`);
    return joinPath(BASE, rel);
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      const r = await Filesystem.readFile({ path: this.p(path), directory: this.dir });
      if (typeof r.data !== "string") return new Uint8Array(await r.data.arrayBuffer());
      // Android always hands back base64. The browser preview's storage hands back what was
      // written: base64 for bytes, but text as text (JSON is never valid base64).
      if (NATIVE || (r.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(r.data))) return fromBase64(r.data);
      return new TextEncoder().encode(r.data);
    } catch {
      return null;
    }
  }

  async readText(path: string): Promise<string | null> {
    try {
      const r = await Filesystem.readFile({ path: this.p(path), directory: this.dir, encoding: Encoding.UTF8 });
      return typeof r.data === "string" ? r.data : await r.data.text();
    } catch {
      return null;
    }
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    // App storage is private to the app already, so "secret" needs nothing extra here.
    await Filesystem.writeFile(
      typeof data === "string"
        ? { path: this.p(path), directory: this.dir, data, encoding: Encoding.UTF8, recursive: true }
        : { path: this.p(path), directory: this.dir, data: toBase64(data), recursive: true },
    );
  }

  async append(path: string, text: string): Promise<void> {
    if (await this.stat(path)) await Filesystem.appendFile({ path: this.p(path), directory: this.dir, data: text, encoding: Encoding.UTF8 });
    else await this.write(path, text);
  }

  async list(dir: string): Promise<DiskEntry[]> {
    try {
      const { files } = await Filesystem.readdir({ path: this.p(dir), directory: this.dir });
      return files.map((f) => ({ name: f.name, dir: f.type === "directory", size: f.size, mtime: f.mtime }));
    } catch {
      return [];
    }
  }

  async stat(path: string): Promise<{ size: number; mtime: number; dir: boolean } | null> {
    try {
      const s = await Filesystem.stat({ path: this.p(path), directory: this.dir });
      return { size: s.size, mtime: s.mtime, dir: s.type === "directory" };
    } catch {
      return null;
    }
  }
}

function toBase64(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
