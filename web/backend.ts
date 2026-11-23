/**
 * The Tartan API as the UI sees it.
 *  - ServerBackend: the local Bun server (PC), or a PC paired with the Android app, reached
 *    over the network through the end to end encrypted link (src/link.ts).
 *  - LocalApiBackend (./local-api.ts): the same API running inside the Android app itself.
 */
import type { FileSink } from "../src/protocol/sync.ts";
import type { SyncEvent } from "../src/slug.ts";
import { tunnel, type Link } from "../src/link.ts";
import { LOCAL_NETWORK_DENIED, localNetwork } from "./lib/local-network.ts";

export interface WatchEntry {
  id: string;
  info: { name?: string; lastBackup?: string; updated?: string; battery?: number };
  files: number;
  bytes: number;
}

export interface FileEntry {
  path: string;
  bytes: number;
  modified: number;
  kind: string;
}

export class ServerBackend {
  private readonly sealed: ((path: string, init?: RequestInit) => Promise<Response>) | null;
  /** `link`: a PC paired with this phone; every request then goes end to end encrypted (src/link.ts). */
  constructor(readonly base = "", readonly link?: Link) {
    this.sealed = link ? tunnel(link) : null;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.sealed) {
      // The PC is on the home network: Android 17 wants the app's OK first (asked from a tap, not here).
      if (!(await localNetwork(false))) throw new Error(LOCAL_NETWORK_DENIED);
      return this.sealed(path, init);
    }
    const res = await fetch(this.base.replace(/\/$/, "") + path, init);
    if (res.status === 403) throw new Error("The server refused the request.");
    return res;
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  private w(watch: string, rest: string, path?: string) {
    return `/api/watches/${encodeURIComponent(watch)}${rest}${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`;
  }

  fileUrl(watchId: string, path: string): string {
    return this.base + this.w(watchId, "/file", path);
  }

  sink(watch: string): FileSink {
    return {
      has: async (p) => (await this.json<{ exists: boolean }>(this.w(watch, "/exists", p))).exists,
      put: async (p, data) => {
        const res = await this.request(this.w(watch, "/file", p), { method: "PUT", body: data.slice() });
        if (!res.ok) throw new Error(`saving ${p} failed: ${res.status}`);
      },
    };
  }

  async saveInfo(watch: string, info: object): Promise<void> {
    await this.request(this.w(watch, "/info"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(info) });
  }

  watches() {
    return this.json<WatchEntry[]>("/api/watches");
  }

  files(watchId: string) {
    return this.json<FileEntry[]>(this.w(watchId, "/files"));
  }

  async readFile(watchId: string, path: string): Promise<Uint8Array> {
    const res = await this.request(this.w(watchId, "/file", path));
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  events(days = 14) {
    return this.json<SyncEvent[]>(`/api/events?days=${days}`);
  }

  async logEvent(e: Omit<SyncEvent, "at">): Promise<void> {
    await this.request("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) }).catch(() => {});
  }
}
