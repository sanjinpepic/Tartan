#!/usr/bin/env bun
/**
 * tartan — talk to your own Suunto watch over Bluetooth LE (Linux/BlueZ).
 * For macOS, Windows, ChromeOS and Android use the web UI: `tartan serve`.
 */
import { createInterface } from "node:readline/promises";
import { openSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { RecordingLink } from "./protocol/blackbox.ts";
import { WatchSession, type Generation } from "./protocol/session.ts";
import { sniff } from "./protocol/sync.ts";
import { NodeDisk } from "./disk-node.ts";
import { LocalStore } from "./store.ts";
import { authorizeInteractive } from "./strava/auth.ts";
import { StravaStore, syncStrava } from "./strava/sync.ts";
import { Bluez, type FindOptions } from "./transport/bluez.ts";
import { backupWatch } from "./watch-backup.ts";

const HELP = `tartan — your watch, your data. Bluetooth LE, no Suunto app, no account.

Usage: tartan <command> [options]

Watch (Linux, BlueZ):
  pair                     bond this computer with the watch (one time; evicts the phone's bond)
  scan                     list Suunto watches in range
  info                     connect and show what the watch reports about itself
  ls [path]                list a directory on the watch (default /)
  get <path> [--out f]     download one file
  backup [path]            copy everything under path (default /) to data/watches/<watch>/files
                           (files already copied are skipped; --force re-downloads)
  forget                   remove the bond so the phone app can pair again

Web UI (any OS with Chrome/Edge — Web Bluetooth) + MCP over HTTP at /mcp:
  serve [--port 5173] [--host 127.0.0.1] [--lan]
                           --lan: listen on the network so the Android app can pair with this PC
                           (a code shown in Settings; everything then goes end to end encrypted)

AI agents (MCP):
  mcp                      run the MCP server on stdio (Claude Desktop, Claude Code, Cursor…)

Strava (your watch already syncs every workout there):
  strava-auth [--client-id ID --client-secret SECRET]
                           connect your Strava API app (one time)
  strava-sync [--full] [--no-details]
                           download new activities with full detail and time series

Options:
  --needle <text>          pick a watch by part of its name, e.g. "Race 2" or the serial
  --address <mac>          pick a watch by address (rarely works: it rotates its address)
  --adapter <hciN>         Bluetooth adapter (default: first)
  --generation ng1|ng3     skip filesystem layout detection (ng1: 9 Peak Pro era, ng3: Vertical 2 era)
  --exclude <regex>        backup: skip matching paths (repeatable), e.g. --exclude ^/zapp
  --data <dir>             data directory (default: data/ in the project, or $TARTAN_DATA)
  --record <file>          info, ls, get, backup: record every byte of the connection to a file
                           (read it back with scripts/replay.ts; it holds your watch's data)
  -v, --verbose            protocol-level logging

Before connecting: wake the watch (Settings → Connectivity keeps it advertising) and turn
the phone's Bluetooth off — the watch talks to one device at a time.`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    needle: { type: "string" },
    address: { type: "string" },
    adapter: { type: "string" },
    generation: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
    exclude: { type: "string", multiple: true },
    data: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    lan: { type: "boolean" },
    full: { type: "boolean" },
    "no-details": { type: "boolean" },
    record: { type: "string" },
    "client-id": { type: "string" },
    "client-secret": { type: "string" },
    verbose: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
});

const [cmd, ...args] = positionals;
const log = (m: string) => console.error(m);
const verbose = o.verbose ? log : () => {};
const store = new LocalStore(new NodeDisk(o.data));
const find: FindOptions = { needle: o.needle, address: o.address, log };
/** `--record <file>`: the connection's tape, a line at a time (src/protocol/blackbox.ts). */
const tape = o.record
  ? (() => {
      const fd = openSync(o.record, "w", 0o600);
      log(`Recording the connection to ${o.record}`);
      return (line: string) => void writeSync(fd, `${line}\n`);
    })()
  : undefined;
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (hidden) {
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => out.output.write(s.startsWith(question) ? s : "");
  }
  try {
    return await rl.question(question);
  } finally {
    rl.close();
    if (hidden) process.stderr.write("\n");
  }
}

async function withWatch<T>(fn: (s: WatchSession) => Promise<T>): Promise<T> {
  if (o.generation && o.generation !== "ng1" && o.generation !== "ng3") throw new Error("--generation must be ng1 or ng3");
  const bz = await Bluez.connect(o.adapter);
  let link;
  try {
    link = await bz.open(find);
  } catch (e) {
    bz.close();
    throw e;
  }
  const rec = tape ? new RecordingLink(link, tape) : null;
  const session = new WatchSession(rec ?? link, { log: rec ? (m) => (verbose(m), rec.note(m)) : verbose, generation: o.generation as Generation | undefined });
  try {
    const info = await session.open();
    await store.saveInfo(info.name, { name: info.name, info: info.info, battery: link.battery });
    return await fn(session);
  } finally {
    await session.close().catch(() => {});
  }
}

async function main(): Promise<number> {
  if (!cmd || o.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case "pair": {
      const bz = await Bluez.connect(o.adapter);
      try {
        log("Open Settings → Connectivity on the watch and keep the screen awake.");
        const w = await bz.pair({ ...find, scanMs: 45_000, askPasskey: () => ask("Code shown on the watch: ") });
        log(`Paired with ${w.name}. Try: tartan info`);
      } finally {
        bz.close();
      }
      return 0;
    }
    case "forget": {
      const bz = await Bluez.connect(o.adapter);
      try {
        const gone = await bz.forget(find);
        log(gone.length ? `Removed: ${gone.map((g) => g.name).join(", ")}` : "No bonded Suunto watch found.");
      } finally {
        bz.close();
      }
      return 0;
    }
    case "scan": {
      const bz = await Bluez.connect(o.adapter);
      try {
        await bz.find({ ...find, log: () => {} }, true).catch(() => null);
        await Bun.sleep(3000);
        const seen = await bz.candidates(find);
        await bz.stopDiscovery();
        if (!seen.length) log("Nothing found. Wake the watch and turn the phone's Bluetooth off.");
        for (const c of seen) console.log(`${c.name}\t${c.address}\tRSSI ${c.rssi ?? "-"}\t${c.paired ? "bonded" : "not bonded"}`);
      } finally {
        bz.close();
      }
      return 0;
    }
    case "info":
      return withWatch(async (s) => {
        const gen = await s.detectGeneration();
        const info = s.info();
        console.log(`Watch:      ${info.name}`);
        console.log(`Layout:     ${gen.toUpperCase()}`);
        if (info.info.length) console.log(`Reports:    ${info.info.join(" | ")}`);
        const root = await s.listDir("/");
        console.log(`Root dirs:  ${root.dirs.join(", ") || "-"}`);
        return 0;
      });
    case "ls":
      return withWatch(async (s) => {
        const path = args[0] ?? "/";
        const l = await s.listDir(path);
        for (const d of l.dirs.sort()) console.log(`${d}/`);
        for (const f of l.files.sort()) console.log(f);
        return 0;
      });
    case "get": {
      const path = args[0];
      if (!path) throw new Error("usage: tartan get <path> [--out file]");
      return withWatch(async (s) => {
        const data = await s.readFile(path, (n) => process.stderr.write(`\r${fmtBytes(n)}   `));
        const out = o.out ?? basename(path);
        await writeFile(out, data);
        log(`\n${fmtBytes(data.length)} → ${out} (${sniff(data)})`);
        return 0;
      });
    }
    case "backup": {
      if (o.generation && o.generation !== "ng1" && o.generation !== "ng3") throw new Error("--generation must be ng1 or ng3");
      const root = args[0] ?? "/";
      let current = "";
      const res = await backupWatch(store, {
        root,
        needle: o.needle,
        address: o.address,
        adapter: o.adapter,
        generation: o.generation as Generation | undefined,
        force: o.force,
        exclude: (o.exclude ?? []).map((r) => new RegExp(r)),
        log,
        verbose,
        record: tape,
        onEvent: (e) => {
          if (e.kind === "dir") log(`${e.path}  (${e.files} files, ${e.dirs} dirs)`);
          else if (e.kind === "progress") {
            current = e.path;
            process.stderr.write(`\r  ${e.path}  ${fmtBytes(e.bytes)}   `);
          } else if (e.kind === "file") process.stderr.write(`\r  ${e.path}  ${fmtBytes(e.bytes)} ✓\n`);
          else if (e.kind === "error") process.stderr.write(`${current === e.path ? "\n" : ""}  ${e.path}  ✗ ${e.message}\n`);
          else if (e.kind === "skip") verbose(`  ${e.path}  (already have it)`);
        },
      });
      log(`Done: ${res.downloaded} downloaded (${fmtBytes(res.bytes)}), ${res.skipped} already present, ${res.failed} failed → ${res.dir}`);
      return res.failed ? 1 : 0;
    }
    case "serve": {
      const { startServer } = await import("./server.ts");
      await startServer({ port: Number(o.port ?? 5173), hostname: o.host ?? (o.lan ? "0.0.0.0" : "127.0.0.1"), lan: o.lan, store });
      return new Promise<number>(() => {}); // run until Ctrl-C
    }
    case "mcp": {
      const { createMcpServer } = await import("./mcp.ts");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { Library } = await import("./library.ts");
      await createMcpServer({ library: new Library(store.disk) }).connect(new StdioServerTransport());
      log(`Tartan MCP server on stdio (data: ${store.root})`);
      return new Promise<number>(() => {});
    }
    case "strava-auth": {
      const strava = new StravaStore(store.disk);
      const clientId = o["client-id"] ?? process.env.STRAVA_CLIENT_ID ?? (await strava.read<{ clientId: string }>("config.json"))?.clientId ?? (await ask("Strava Client ID: "));
      const clientSecret =
        o["client-secret"] ?? process.env.STRAVA_CLIENT_SECRET ?? (await strava.read<{ clientSecret: string }>("config.json"))?.clientSecret ?? (await ask("Strava Client Secret: ", true));
      await strava.writeSecret({ clientId, clientSecret }, "config.json");
      const client = (await strava.client({ clientId, clientSecret }))!;
      const tokens = await authorizeInteractive(client, { port: Number(o.port ?? 8721), log });
      log(`Connected to Strava as ${tokens.athlete?.firstname ?? ""} ${tokens.athlete?.lastname ?? ""}. Next: tartan strava-sync`);
      return 0;
    }
    case "strava-sync": {
      const strava = new StravaStore(store.disk);
      const client = await strava.client();
      if (!client?.connected) throw new Error("Strava is not connected yet: run `tartan strava-auth` first");
      const res = await syncStrava(client, strava, { full: o.full, details: !o["no-details"], log });
      log(`Strava: ${res.total} activities (${res.added} new), ${res.detailed} detailed this run, ${res.pendingDetails} still pending.`);
      return 0;
    }
    default:
      log(`unknown command: ${cmd}\n`);
      console.log(HELP);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log(`error: ${(e as Error).message}`);
    process.exit(1);
  },
);
