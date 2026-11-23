/**
 * Phone and PC as one: the phone copies everything from Tartan on the PC once (its workouts,
 * plan, coach and key, notes, lifts, check-ins, routes, faces, watch backups), then the two keep
 * in step on each sync:
 *
 * - the plan and everything about it (marks, swaps, pace changes, a waiting proposal, the
 *   setting): whichever side changed last wins, as a whole;
 * - lifts and morning check-ins: merged day by day (the newer entry for a day wins);
 * - the coach's notes have their own merge (src/memory.ts); watch backups go to the PC as before.
 *
 * Not copied: caches (rebuilt), the PC's pairing token and its paired devices' keys, and Strava's sign-in (Strava hands out
 * one refresh token at a time, so two devices sharing it would sign each other out; the phone
 * connects to Strava itself, in one tap with the PC's app settings copied).
 */
import type { Disk } from "./disk.ts";
import { readJson } from "./disk.ts";

export interface FileEntry {
  path: string;
  size: number;
  mtime: number;
  /** SHA-256 (hex) of small files (≤ 256 KB), to tell same from different without copying. */
  hash?: string;
}

const HASHED = 256 * 1024;
async function sha256(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice() as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

const KEEP_OUT = [/^pairing-token\.txt$/, /^events\.jsonl$/, /^link\//, /^cache\//, /^strava\/tokens\.json$/, /^strava\/oauth-states\.json$/, /\.tmp$/];
/** Files written owner-only: keys, tokens and settings (Strava's app secret among them). */
const SECRET = /tokens|settings|key|secret|^strava\/|^coach\/settings/i;
export const transferable = (path: string) => !!path && !path.split("/").includes("..") && !path.startsWith("/") && !KEEP_OUT.some((r) => r.test(path));

/** Every file under the data folder that goes to another device. */
export async function listFiles(disk: Disk, dir = "", hash = false): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const e of await disk.list(dir)) {
    const path = dir ? `${dir}/${e.name}` : e.name;
    if (e.dir) {
      if (transferable(`${path}/`)) out.push(...(await listFiles(disk, path, hash)));
    } else if (transferable(path)) {
      const data = hash && e.size <= HASHED ? await disk.read(path) : null;
      out.push({ path, size: e.size, mtime: e.mtime, ...(data ? { hash: await sha256(data) } : {}) });
    }
  }
  return out;
}

export interface Remote {
  list(hash?: boolean): Promise<FileEntry[]>;
  file(path: string): Promise<Uint8Array>;
  put(path: string, data: Uint8Array, mtime: number): Promise<void>;
  state(): Promise<LinkState>;
  putState(s: LinkState): Promise<void>;
}

/** Tartan on the PC, through the encrypted link (src/link.ts tunnel). */
export function remote(request: (path: string, init?: RequestInit) => Promise<Response>): Remote {
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await request(path, init);
    if (!res.ok) throw new Error(`The PC answered ${res.status} for ${path}`);
    return res;
  };
  return {
    list: async (hash = false) => (await (await req(`/api/transfer/list${hash ? "?hash=1" : ""}`)).json()) as FileEntry[],
    file: async (path) => new Uint8Array(await (await req(`/api/transfer/file?path=${encodeURIComponent(path)}`)).arrayBuffer()),
    put: async (path, data, mtime) => void (await req(`/api/transfer/file?path=${encodeURIComponent(path)}&mtime=${mtime}`, { method: "PUT", body: data.slice() as BodyInit })),
    state: async () => (await (await req("/api/link/state")).json()) as LinkState,
    putState: async (s) => void (await req("/api/link/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(s) })),
  };
}

/**
 * Copy the PC's data onto this device. Files this device already has at the same size and at
 * least as new are skipped, so a copy that broke off carries on where it stopped.
 */
export async function pull(disk: Disk, from: Remote, progress: (p: { done: number; total: number; bytes: number; totalBytes: number }) => void = () => {}): Promise<{ files: number; bytes: number; skipped: number }> {
  const all = (await from.list()).filter((e) => transferable(e.path));
  const totalBytes = all.reduce((n, e) => n + e.size, 0);
  let done = 0;
  let bytes = 0;
  let skipped = 0;
  let copied = 0;
  const queue = [...all];
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      const have = await disk.stat(e.path);
      if (have && !have.dir && have.size === e.size && have.mtime >= e.mtime) skipped++;
      else {
        const bytes = await from.file(e.path);
        // Text as text (the app reads its JSON as text everywhere), binaries as bytes.
        let data: Uint8Array | string = bytes;
        try {
          data = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          // binary
        }
        // Two copies making the same folder at once: the second finds it there; write again.
        for (let i = 0; ; i++) {
          try {
            await disk.write(e.path, data, { secret: /tokens|settings|key/i.test(e.path) });
            break;
          } catch (err) {
            if (i >= 3 || !/exist/i.test((err as Error).message)) throw err;
            await new Promise((r) => setTimeout(r, 30 * (i + 1)));
          }
        }
        copied++;
      }
      done++;
      bytes += e.size;
      progress({ done, total: all.length, bytes, totalBytes });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { files: copied, bytes, skipped };
}

/** The plan and everything about it travel together. */
const PLAN_FILES = ["coach/plan.json", "coach/plan-marks.json", "coach/plan-swaps.json", "coach/plan-adjust.json", "coach/plan-proposal.json", "coach/plan-last-change.json", "coach/plan-approval.json"];

/** Merged entry by entry instead of one copy winning: which workout is which, and Strava's list. */
const MERGED: Record<string, (a: string, b: string) => string> = {
  // Keys are copies (strava:123, watch:…), values the workout's id; the side with more keeps its ids.
  "activity-links.json": (a, b) => {
    const [x, y] = [JSON.parse(a || "{}"), JSON.parse(b || "{}")] as Array<Record<string, string>>;
    return JSON.stringify(Object.keys(x!).length >= Object.keys(y!).length ? { ...y, ...x } : { ...x, ...y });
  },
  "strava/index.json": (a, b) => {
    const all = new Map<string, Record<string, unknown>>();
    for (const r of [...(JSON.parse(a || "[]") as Array<Record<string, unknown>>), ...(JSON.parse(b || "[]") as Array<Record<string, unknown>>)]) all.set(String(r.id), r);
    return JSON.stringify([...all.values()].sort((p, q) => String(q.start_date).localeCompare(String(p.start_date))));
  },
};
/** Kept in step by their own merges (syncWith, and the coach's notes through their API). */
const OWN_MERGE = new Set([...PLAN_FILES, "strength/log.json", "coach/checkins.json", "coach/memory.json"]);
/** How much training a side holds: Strava workouts and watch logbook entries. */
const weight = (list: FileEntry[]) => list.filter((e) => /^strava\/activities\/|\/logbook\/.*summary/.test(e.path)).length;

/**
 * Bring both sides to the latest, like a sync: what only one side has goes to the other; what
 * differs goes the way of the newer copy, except that a side with no workouts yet (a fresh
 * install) never overwrites the other; the workout table and Strava's list merge entry by
 * entry; the plan, lifts, check-ins and notes keep their own merges.
 */
export async function reconcile(disk: Disk, other: Remote, progress: (p: { done: number; total: number; bytes: number; totalBytes: number }) => void = () => {}): Promise<{ pulled: number; pushed: number; merged: number; changed: boolean }> {
  const [mine, all] = await Promise.all([listFiles(disk, "", true), other.list(true)]);
  // The other side's list too: never take its link keys, Strava tokens or a path out of the folder.
  const theirs = all.filter((e) => transferable(e.path));
  const L = new Map(mine.map((e) => [e.path, e]));
  const R = new Map(theirs.map((e) => [e.path, e]));
  const [wl, wr] = [weight(mine), weight(theirs)];
  const pulls: FileEntry[] = [];
  const pushes: FileEntry[] = [];
  const merges: string[] = [];
  for (const path of new Set([...L.keys(), ...R.keys()])) {
    if (OWN_MERGE.has(path)) continue;
    const l = L.get(path);
    const r = R.get(path);
    if (!r) pushes.push(l!);
    else if (!l) pulls.push(r);
    else if (l.hash && r.hash ? l.hash === r.hash : l.size === r.size) continue;
    else if (MERGED[path]) merges.push(path);
    else if (wl === 0 && wr > 0) pulls.push(r);
    else if (wr === 0 && wl > 0) pushes.push(l);
    else if (r.mtime > l.mtime) pulls.push(r);
    else pushes.push(l);
  }
  const total = pulls.length + pushes.length + merges.length;
  const totalBytes = [...pulls, ...pushes].reduce((n, e) => n + e.size, 0);
  let done = 0;
  let bytes = 0;
  const tick = (n: number) => {
    done++;
    bytes += n;
    progress({ done, total, bytes, totalBytes });
  };
  const write = async (path: string, data: Uint8Array) => {
    let out: Uint8Array | string = data;
    try {
      out = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      // binary
    }
    for (let i = 0; ; i++) {
      try {
        return await disk.write(path, out, { secret: SECRET.test(path) });
      } catch (err) {
        if (i >= 3 || !/exist/i.test((err as Error).message)) throw err;
        await new Promise((r) => setTimeout(r, 30 * (i + 1)));
      }
    }
  };
  const queue = [...pulls.map((e) => ["pull", e] as const), ...pushes.map((e) => ["push", e] as const)];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [way, e] = job;
      if (way === "pull") await write(e.path, await other.file(e.path));
      else {
        const data = await disk.read(e.path);
        if (data) await other.put(e.path, data, e.mtime);
      }
      tick(e.size);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const enc = new TextEncoder();
  for (const path of merges) {
    const both = MERGED[path]!((await disk.readText(path)) ?? "", new TextDecoder().decode(await other.file(path)));
    await disk.write(path, both);
    await other.put(path, enc.encode(both), Date.now());
    tick(0);
  }
  const stepped = await syncWith(disk, other);
  return { pulled: pulls.length, pushed: pushes.length, merged: merges.length, changed: stepped || pulls.length + merges.length > 0 };
}

/**
 * The other way: send this device's data to the PC (Tartan started on the phone). Only what
 * the PC doesn't have, or has older; nothing newer there is overwritten.
 */
export async function push(disk: Disk, to: Remote, progress: (p: { done: number; total: number; bytes: number; totalBytes: number }) => void = () => {}): Promise<{ files: number; bytes: number; skipped: number }> {
  const theirs = new Map((await to.list()).map((e) => [e.path, e]));
  const mine = await listFiles(disk);
  const send = mine.filter((e) => {
    const t = theirs.get(e.path);
    return !t || (t.size !== e.size && e.mtime > t.mtime);
  });
  const totalBytes = send.reduce((n, e) => n + e.size, 0);
  let done = 0;
  let bytes = 0;
  for (const e of send) {
    const data = await disk.read(e.path);
    if (data) await to.put(e.path, data, e.mtime);
    done++;
    bytes += e.size;
    progress({ done, total: send.length, bytes, totalBytes });
  }
  return { files: send.length, bytes, skipped: mine.length - send.length };
}

/** Receive a file from the paired device: text as text, never over something newer here. */
export async function receive(disk: Disk, path: string, data: Uint8Array, mtime: number): Promise<boolean> {
  if (!transferable(path)) return false;
  const have = await disk.stat(path);
  if (have && have.mtime > mtime && have.size === data.length) return false;
  let out: Uint8Array | string = data;
  try {
    out = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // binary
  }
  await disk.write(path, out, { secret: SECRET.test(path) });
  return true;
}

// ---------------------------------------------------------------- keeping in step

const LIFTS = "strength/log.json";
const CHECKINS = "coach/checkins.json";

export interface LinkState {
  /** When the plan last changed on that device (ms), and its files. */
  plan: { at: number; files: Record<string, string | null> };
  lifts: Record<string, { started?: string; finished?: string } & Record<string, unknown>>;
  checkins: Record<string, Record<string, unknown>>;
}

export async function readState(disk: Disk): Promise<LinkState> {
  const files: Record<string, string | null> = {};
  let at = 0;
  for (const p of PLAN_FILES) {
    files[p] = await disk.readText(p);
    at = Math.max(at, (await disk.stat(p))?.mtime ?? 0);
  }
  return { plan: { at, files }, lifts: (await readJson(disk, LIFTS)) ?? {}, checkins: (await readJson(disk, CHECKINS)) ?? {} };
}

/** Day by day: both sides' days, the newer entry where both have one. */
export function mergeDays<T extends Record<string, unknown>>(a: Record<string, T>, b: Record<string, T>, stamp: (x: T) => string): Record<string, T> {
  const out: Record<string, T> = { ...a };
  for (const [k, v] of Object.entries(b)) if (!out[k] || stamp(v) > stamp(out[k]!)) out[k] = v;
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]!]));
}

const liftStamp = (x: { started?: string; finished?: string }) => x.finished ?? x.started ?? "";
const checkinStamp = (x: Record<string, unknown>) => String(x.at ?? JSON.stringify(x));

/** Both sides as one: the newer plan, every day's lifts and check-ins. */
export function merge(mine: LinkState, theirs: LinkState): LinkState {
  return {
    plan: theirs.plan.at > mine.plan.at ? theirs.plan : mine.plan,
    lifts: mergeDays(mine.lifts, theirs.lifts, liftStamp),
    checkins: mergeDays(mine.checkins, theirs.checkins, checkinStamp),
  };
}

/** Write a merged state here, touching only what differs. */
export async function writeState(disk: Disk, s: LinkState): Promise<boolean> {
  const cur = await readState(disk);
  let changed = false;
  if (s.plan.at > cur.plan.at)
    for (const [p, text] of Object.entries(s.plan.files)) {
      if (!PLAN_FILES.includes(p) || text === cur.plan.files[p]) continue;
      await disk.write(p, text ?? "null");
      changed = true;
    }
  for (const [p, next, now] of [[LIFTS, s.lifts, cur.lifts], [CHECKINS, s.checkins, cur.checkins]] as const) {
    if (JSON.stringify(next) === JSON.stringify(now)) continue;
    await disk.write(p, JSON.stringify(next));
    changed = true;
  }
  return changed;
}

/** One round with the PC: merge both ways. True when this device changed. */
export async function syncWith(disk: Disk, pc: Remote): Promise<boolean> {
  const [mine, theirs] = await Promise.all([readState(disk), pc.state()]);
  const both = merge(mine, theirs);
  if (JSON.stringify(merge(theirs, both)) !== JSON.stringify(theirs) || both.plan !== theirs.plan) await pc.putState(both);
  return writeState(disk, both);
}
