/**
 * The watch link's flight recorder: every byte both ways, with the session's own log between
 * them, so one connection on a real watch becomes something a test can play back.
 *
 * A tape is JSON lines. The first is the header, then one line per event, `t` in ms from the start:
 *   {"tartan":"blackbox","v":1,"name":"Suunto Run 2 …","chunkSize":244,"started":"2026-…"}
 *   {"t":12,"w":"7ea5…"}      written to the watch (one GATT write, still escaped)
 *   {"t":40,"n":"7ea5…"}      a notification from the watch
 *   {"t":41,"log":"[session] …"}
 *   {"t":900,"close":"watch disconnected"}
 *
 * `ReplayLink` is a watch made from a tape: each request gets the replies the real watch gave the
 * same request. A tape carries whatever the watch sent (workouts, routes, heart rate), so it is
 * the owner's data: it is shared by hand and kept out of the repository.
 */
import { crc32, Deframer, le16, le32, printableStrings, readLe16, wrap } from "./codec.ts";
import type { BleLink } from "./session.ts";

export interface TapeHeader {
  tartan: "blackbox";
  v: 1;
  name: string;
  chunkSize: number;
  started: string;
  build?: string;
}
export type TapeEvent = { t: number; w: string } | { t: number; n: string } | { t: number; log: string } | { t: number; close: string };
export interface Tape {
  header: TapeHeader;
  events: TapeEvent[];
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

/** Past this much tape the traffic is no longer kept (a full backup of a watch runs to tens of MB). */
export const TAPE_LIMIT = 48 * 1024 * 1024;

/** Wraps a link and writes every byte through it to `out`, one tape line at a time. */
export class RecordingLink implements BleLink {
  private readonly t0 = Date.now();
  private readonly limit: number;
  private written = 0;
  private full = false;
  private ended = false;
  private readonly onEnd: () => void;

  /** `onEnd` runs once, when Tartan closes the link or the watch drops it. */
  constructor(
    private readonly inner: BleLink,
    private readonly out: (line: string) => void,
    opts: { build?: string; limit?: number; onEnd?: () => void } = {},
  ) {
    this.limit = opts.limit ?? TAPE_LIMIT;
    this.onEnd = opts.onEnd ?? (() => {});
    const header: TapeHeader = { tartan: "blackbox", v: 1, name: inner.name, chunkSize: inner.chunkSize, started: new Date(this.t0).toISOString(), ...(opts.build ? { build: opts.build } : {}) };
    this.line(JSON.stringify(header));
  }

  get name(): string {
    return this.inner.name;
  }
  get chunkSize(): number {
    return this.inner.chunkSize;
  }

  /** A line of the session's own log, between the bytes it explains. */
  note(msg: string): void {
    this.event({ log: msg });
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.event({ w: hex(chunk) });
    await this.inner.write(chunk);
  }

  subscribe(onData: (chunk: Uint8Array) => void, onClose: (reason: string) => void): Promise<void> {
    return this.inner.subscribe(
      (chunk) => {
        this.event({ n: hex(chunk) });
        onData(chunk);
      },
      (reason) => {
        this.event({ close: reason });
        onClose(reason);
        this.end();
      },
    );
  }

  async close(): Promise<void> {
    if (!this.ended) this.event({ close: "closed by Tartan" });
    await this.inner.close();
    this.end();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd();
  }

  private event(e: Record<string, string>): void {
    if (this.full) return;
    const t = Date.now() - this.t0;
    const line = JSON.stringify({ t, ...e });
    if (this.written + line.length > this.limit) {
      this.full = true;
      this.line(JSON.stringify({ t, log: `[blackbox] stopped recording at ${Math.round(this.limit / 1048576)} MB` }));
      return;
    }
    this.line(line);
  }

  private line(s: string): void {
    this.written += s.length + 1;
    this.out(s);
  }
}

/** Read a tape; anything that isn't one says so. */
export function parseTape(text: string): Tape {
  const lines = text.split("\n").filter((l) => l.trim());
  let header: TapeHeader;
  try {
    header = JSON.parse(lines[0] ?? "") as TapeHeader;
  } catch {
    throw new Error("not a Tartan watch recording (the first line isn't JSON)");
  }
  if (header.tartan !== "blackbox") throw new Error("not a Tartan watch recording");
  if (header.v !== 1) throw new Error(`a watch recording of a newer kind (v${header.v}); update Tartan`);
  const events: TapeEvent[] = [];
  for (const [i, l] of lines.slice(1).entries()) {
    try {
      events.push(JSON.parse(l) as TapeEvent);
    } catch {
      // The app closed mid-line: what came before is still good.
      if (i !== lines.length - 2) throw new Error(`watch recording line ${i + 2} isn't JSON`);
    }
  }
  return { header, events };
}

export type TapeFrame = { t: number; dir: ">" | "<"; frame: Uint8Array } | { t: number; log: string } | { t: number; close: string };

/** The tape as whole protocol frames (`>` to the watch, `<` from it), with the log lines between. */
export function tapeFrames(tape: Tape): TapeFrame[] {
  const out: TapeFrame[] = [];
  let t = 0;
  const tx = new Deframer((frame) => out.push({ t, dir: ">", frame }), 1 << 16);
  const rx = new Deframer((frame) => out.push({ t, dir: "<", frame }), 1 << 16);
  for (const e of tape.events) {
    t = e.t;
    if ("w" in e) tx.push(unhex(e.w));
    else if ("n" in e) rx.push(unhex(e.n));
    else out.push(e);
  }
  return out;
}

const NAMES: Record<number, string> = { 0x0a: "RESOLVE", 0x0b: "RELEASE", 0x0d: "GET", 0x0e: "PUT", 0x10: "SUB", 0x11: "UNSUB", 0x16: "POST", 0x17: "DEL", 0x12: "HELLO", 0x13: "HELLO_ACK", 0x14: "KEEPALIVE", 0x01: "NOTIFY", 0x02: "resolve-r", 0x03: "release-r", 0x05: "get-r", 0x07: "put-r", 0x08: "sub-r", 0x09: "unsub-r", 0x18: "post-r", 0x19: "del-r", 0x1a: "ERROR" };
const REPLIES = new Set([0x02, 0x03, 0x05, 0x07, 0x08, 0x09, 0x18, 0x19, 0x1a]);

/** One frame in a line: its type, request id, resource and what it carries (`full` keeps whole payloads). */
export function describeFrame(f: Uint8Array, full = false): string {
  if (f.length < 10) return `short frame ${hex(f)}`;
  const type = f[1]! & 0x1f;
  const id = readLe16(f, 4);
  const body = f.subarray(6, -4);
  const cut = (b: Uint8Array, n: number) => (full ? hex(b) : `${hex(b.subarray(0, n))}${b.length > n ? "…" : ""}`);
  const text = (b: Uint8Array) => JSON.stringify(printableStrings(b, 4).join("|").slice(0, 120));
  let desc: string;
  if (type === 0x0a) desc = `${hex(body.subarray(0, 3))} "${new TextDecoder("latin1").decode(body.subarray(4, 4 + body[3]!))}"`;
  else if (REPLIES.has(type) && body.length >= 8) {
    const v = body.subarray(8);
    desc = `@${hex(body.subarray(0, 3))} ${readLe16(body, 6)} len ${v.length} ${cut(v, 48)} ${text(v)}`;
  } else if (type === 0x01) desc = `${body.length}b ${cut(body, 48)} ${text(body)}`;
  else desc = `@${hex(body.subarray(0, 3))} cl ${hex(body.subarray(3, 6))} ${cut(body.subarray(6), 54)}`;
  return `${(NAMES[type] ?? `0x${type.toString(16)}`).padEnd(9)} #${id} ${desc}`;
}

/** The tape as text, one line per frame or log line, for reading by eye. */
export function decodeTape(tape: Tape, full = false): string {
  const lines = [`${tape.header.name} · chunk ${tape.header.chunkSize} · ${tape.header.started}${tape.header.build ? ` · build ${tape.header.build}` : ""}`];
  for (const f of tapeFrames(tape)) {
    const s = (f.t / 1000).toFixed(2).padStart(8);
    if ("frame" in f) lines.push(`${s} ${f.dir} ${describeFrame(f.frame, full)}`);
    else if ("log" in f) lines.push(`${s}   · ${f.log}`);
    else lines.push(`${s}   ✕ link closed: ${f.close}`);
  }
  return lines.join("\n");
}

interface Exchange {
  request: Uint8Array;
  replies: Uint8Array[];
  used: boolean;
}

/** A request as it compares across runs: without its request id and CRC (both differ run to run). */
const shape = (f: Uint8Array) => {
  const c = f.slice(0, -4);
  if (c.length >= 6) c[4] = c[5] = 0;
  return hex(c);
};

/**
 * A watch made from a tape. Each request is answered with the replies the real watch gave the
 * same request (its request id swapped in), each recorded answer used once while there are
 * unused ones. A request that differs only past its resource (a timestamp, say) gets the
 * recorded answer to the nearest one and is listed in `approximate`; one the tape never saw gets
 * nothing, so the session times out as against a watch that didn't answer, and it is listed in `misses`.
 */
export class ReplayLink implements BleLink {
  readonly name: string;
  readonly chunkSize: number;
  readonly misses: string[] = [];
  readonly approximate: string[] = [];
  /** Requests answered from the tape, in order. */
  readonly answered: string[] = [];
  private readonly exchanges: Exchange[] = [];
  /** What the watch sent before the first request (a hello of its own). */
  private readonly opening: Uint8Array[] = [];
  private onData: ((chunk: Uint8Array) => void) | null = null;
  private onClose: ((reason: string) => void) | null = null;
  private readonly deframer = new Deframer((f) => this.answer(f), 1 << 16);

  constructor(tape: Tape | string) {
    const t = typeof tape === "string" ? parseTape(tape) : tape;
    this.name = t.header.name;
    this.chunkSize = t.header.chunkSize;
    const byId = new Map<number, Exchange>();
    for (const f of tapeFrames(t)) {
      if (!("frame" in f) || f.frame.length < 10) continue;
      const id = readLe16(f.frame, 4);
      if (f.dir === ">") {
        const x = { request: f.frame, replies: [], used: false };
        this.exchanges.push(x);
        byId.set(id, x);
      } else {
        // A reply belongs to the latest request with its id; anything else (a notification) to the latest request.
        const x = byId.get(id) ?? this.exchanges.at(-1);
        if (x) x.replies.push(f.frame);
        else this.opening.push(f.frame);
      }
    }
  }

  async subscribe(onData: (chunk: Uint8Array) => void, onClose: (reason: string) => void): Promise<void> {
    this.onData = onData;
    this.onClose = onClose;
    for (const f of this.opening) this.send(f);
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.deframer.push(chunk);
  }

  async close(): Promise<void> {
    this.onData = null;
    this.onClose = null;
  }

  /** Close the link from the watch's side, as a dropped connection does. */
  drop(reason = "watch disconnected"): void {
    this.onClose?.(reason);
  }

  private answer(req: Uint8Array): void {
    if (req.length < 10) return;
    const key = shape(req);
    const what = describeFrame(req);
    const same = this.exchanges.filter((x) => shape(x.request) === key);
    let x = same.find((e) => !e.used) ?? same.at(-1);
    if (!x) {
      // Same type, length, resource and client: the nearest recorded request.
      x = this.exchanges.find((e) => !e.used && e.request.length === req.length && e.request[1] === req[1] && hex(e.request.subarray(6, 12)) === hex(req.subarray(6, 12)));
      if (x) this.approximate.push(what);
    }
    if (!x) {
      this.misses.push(what);
      return;
    }
    x.used = true;
    this.answered.push(what);
    const was = readLe16(x.request, 4);
    const id = readLe16(req, 4);
    for (const r of x.replies) {
      const rid = readLe16(r, 4);
      this.send(rid === was ? withId(r, id) : r);
    }
  }

  private send(frame: Uint8Array): void {
    const data = wrap(frame);
    setTimeout(() => this.onData?.(data), 0);
  }
}

/** The same frame under another request id, its CRC made again. */
function withId(f: Uint8Array, id: number): Uint8Array {
  const out = f.slice();
  out.set(le16(id), 4);
  out.set(le32(crc32(out.subarray(0, -4))), out.length - 4);
  return out;
}
