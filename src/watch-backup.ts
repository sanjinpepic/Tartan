import { RecordingLink } from "./protocol/blackbox.ts";
import { WatchSession, type Generation } from "./protocol/session.ts";
import { mirror, type MirrorEvent } from "./protocol/sync.ts";
import type { LocalStore } from "./store.ts";
import { Bluez } from "./transport/bluez.ts";

export interface BackupOptions {
  root?: string;
  needle?: string;
  address?: string;
  adapter?: string;
  generation?: Generation;
  force?: boolean;
  exclude?: RegExp[];
  log?: (m: string) => void;
  verbose?: (m: string) => void;
  /** Every byte of the connection, a tape line at a time (src/protocol/blackbox.ts). */
  record?: (line: string) => void;
  onEvent?: (e: MirrorEvent) => void;
}

/** Connect over BlueZ, copy new files under `root`, disconnect. Shared by the CLI and MCP. */
export async function backupWatch(store: LocalStore, opts: BackupOptions = {}) {
  const log = opts.log ?? (() => {});
  const bz = await Bluez.connect(opts.adapter);
  let link;
  try {
    link = await bz.open({ needle: opts.needle, address: opts.address, log });
  } catch (e) {
    bz.close();
    throw e;
  }
  const verbose = opts.verbose ?? (() => {});
  const rec = opts.record ? new RecordingLink(link, opts.record) : null;
  const session = new WatchSession(rec ?? link, { log: rec ? (m) => (verbose(m), rec.note(m)) : opts.verbose, generation: opts.generation });
  try {
    const info = await session.open();
    await store.saveInfo(info.name, { name: info.name, info: info.info, battery: link.battery });
    const errors: string[] = [];
    const res = await mirror(session, opts.root ?? "/", store.sink(info.name), {
      force: opts.force,
      exclude: opts.exclude,
      onEvent: (e) => {
        if (e.kind === "error") errors.push(`${e.path}: ${e.message}`);
        opts.onEvent?.(e);
      },
    });
    await store.saveInfo(info.name, { lastBackup: new Date().toISOString() });
    await store.logEvent({ lane: "watch", kind: "backup", added: res.downloaded, ok: res.failed === 0, detail: info.name });
    return { watch: info.name, battery: link.battery, ...res, errors: errors.slice(0, 20), dir: `${store.root}/${store.watchDir(info.name)}` };
  } finally {
    await session.close().catch(() => {});
  }
}
