/**
 * A protocol-level simulator of a watch's whiteboard endpoint, for tests and the web UI demo mode.
 * It answers the captured bring-up, path resolves, directory listings and file reads
 * the way the firmware does, including NG1/NG3 drive-prefix behaviour.
 */
import {
  Deframer,
  MT,
  buildFrame,
  concat,
  le16,
  le32,
  readLe16,
  readLe32,
  wrap,
} from "../protocol/codec.ts";
import type { BleLink, Generation } from "../protocol/session.ts";
import { encodeTrendPage, TREND_TYPE, type TrendRecord } from "../protocol/trends.ts";

export interface FakeWatchOptions {
  name?: string;
  generation?: Generation;
  /** canonical path ("/logs/a.bin") → content */
  files: Record<string, Uint8Array>;
  /** Max file bytes per read reply. */
  readChunk?: number;
  /** Notification payload size (MTU - 3). */
  notifySize?: number;
  /** Requests the watch never answers (for timeout tests). */
  silentPaths?: string[];
  /** Received frames, for assertions. */
  sent?: Uint8Array[];
  /** The only listing request shape this firmware accepts; others get 400 (default: any). */
  listForm?: "path+u8" | "path" | "path+i32";
  /**
   * Behave like the Run 2: DirectoryList at its own handle, described through the /Meta
   * resources in the layout the real watch uses, and a listing accepted only in exactly the
   * parameter types it declares.
   */
  schema?: { handle: [number, number, number]; opId: number; params: Array<{ name: string; type: number }>; firstPage?: number };
  /**
   * The Run 2's activity log: /Activity/Log answers 503 until /Activity/Logs/SyncCommand is PUT
   * with `start` (an enum behind the named type 0x2404); then Count and each entry's MoveData
   * (a STRING naming the workout file, read with Stream) answer.
   */
  activity?: { files: string[]; start: number; values: Record<string, number> };
  /**
   * The Run 2's logbook as the Suunto app reads it: /Logbook/Entries lists these; Summary comes
   * by GET in chunks (offset INT32); Data only by SUBSCRIBE, as notifications.
   */
  logbook?: Array<{ id: number; modified: number; summary: Uint8Array; data: Uint8Array }>;
  /** The Run 2's 10-minute trend log (protocol/trends.ts), oldest first. */
  trends?: TrendRecord[];
  /** PUTs received (resolved path, value), for assertions. */
  puts?: Array<{ path: string; value: number; type: number }>;
  /**
   * The Run 2's routes, as the Suunto app writes them (route-send.ts): the route format in
   * /DataFormat/Descriptors (id 2), the ids in /Settings/Navigation/RouteList, the file PUT to
   * Route/Data in pieces and the record PUT to Route, described by `types` (DataTypeMetadata).
   */
  navigation?: {
    ids: number[];
    descriptor: string;
    types: Record<number, { kind: number; nameId?: number; scalarType?: number; baseTypeId?: number; fields?: Array<{ name: string; type: number; required?: boolean }> }>;
    /** What the watch received. */
    file?: Uint8Array;
    record?: Uint8Array;
    writes?: string[];
    /** Watch faces (face-send.ts): the ids listed, and what an install received. */
    faces?: { ids: string[]; info?: Uint8Array; path?: string; zip?: Uint8Array; incoming?: Uint8Array[]; removed?: string[] };
    /** SuuntoPlus guides (structured workouts): ids listed, folders made, files streamed, ids removed. */
    plugins?: { ids: string[]; dirs: string[]; files: Record<string, Uint8Array>; removed?: string[]; streaming?: string | null; incoming?: Uint8Array[]; folder?: string };
  };
  /** Resource tree for ResourceMetadata (links: parent, next sibling, first child; 0xffff = none). */
  tree?: Array<{ id: number; name: string; parent: number; next: number; child: number; ops?: number }>;
}

const TRIPLES: Record<string, number[]> = {
  "/Dev/FileSystem/DirectoryList": [0xf0, 0x23, 0x02],
  "/Dev/FileSystem/Stream": [0xf0, 0x23, 0x0a],
};

export class FakeWatch implements BleLink {
  readonly name: string;
  readonly chunkSize = 20;
  readonly sent: Uint8Array[];
  private readonly activityPaths = new Map<string, number>();
  private readonly navPaths = new Map<string, number>();
  private navIncoming: Uint8Array[] = [];
  private syncing = false;
  private onData: ((c: Uint8Array) => void) | null = null;
  private readonly deframer = new Deframer((f) => this.handle(f));
  private readonly gen: Generation;

  constructor(private readonly opts: FakeWatchOptions) {
    this.name = opts.name ?? "Suunto Vertical 2 0042";
    this.gen = opts.generation ?? "ng3";
    this.sent = opts.sent ?? [];
  }

  async subscribe(onData: (chunk: Uint8Array) => void): Promise<void> {
    this.onData = onData;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.deframer.push(chunk);
  }

  async close(): Promise<void> {
    this.onData = null;
  }

  private reply(type: number, id: number, body: Uint8Array): void {
    const pkt = wrap(buildFrame(type, id, body));
    const n = this.opts.notifySize ?? 20;
    // Deliver asynchronously and in MTU-sized pieces like a real notification stream.
    queueMicrotask(() => {
      for (let i = 0; i < pkt.length; i += n) this.onData?.(pkt.slice(i, i + n));
    });
  }

  private handle(frame: Uint8Array): void {
    this.sent.push(frame);
    const type = frame[1]! & 0x1f;
    const id = readLe16(frame, 4);
    const body = frame.subarray(6, -4);

    if (type === MT.HELLO) return this.reply(MT.HELLO_ACK, id, Uint8Array.of(0x09, 0x09));
    if (type === MT.RESOLVE) {
      const client = body.subarray(0, 3);
      const path = new TextDecoder().decode(body.subarray(4, 4 + body[3]!));
      if ((this.opts.activity && path.startsWith("/Activity/")) || (this.opts.logbook && path.startsWith("/Logbook/")) || (this.opts.trends && path === "/Activity/TrendData")) {
        if (!this.activityPaths.has(path)) this.activityPaths.set(path, this.activityPaths.size);
        const n = this.activityPaths.get(path)!;
        // Path-parameter resources resolve with context byte 00 on the Run 2 (00240e for byId Data).
        return this.reply(MT.RESOLVE_REPLY, id, concat(Uint8Array.of(path.startsWith("/Logbook/byId/") ? 0x00 : 0xf0, 0x30, n), client, le16(200)));
      }
      const nv = this.opts.navigation;
      if (nv && (/^\/(Settings\/Navigation\/|DataFormat\/|WatchFace\/)/.test(path) || ((nv.faces || nv.plugins) && path === "/Dev/FileSystem/Stream") || (nv.plugins && (path.startsWith("/Plugin/") || path === "/Dev/FileSystem/DirectoryCreate")))) {
        if (!this.navPaths.has(path)) this.navPaths.set(path, this.navPaths.size);
        return this.reply(MT.RESOLVE_REPLY, id, concat(Uint8Array.of(0xf0, 0x36, 0x80 + this.navPaths.get(path)!), client, le16(200)));
      }
      const triple = (path === "/Dev/FileSystem/DirectoryList" && this.opts.schema?.handle) || TRIPLES[path] || [0xf0, 0x40 + (path.length & 0x3f), 0x01];
      return this.reply(MT.RESOLVE_REPLY, id, concat(Uint8Array.from(triple), client, le16(200)));
    }
    const nav = this.opts.navigation;
    if (nav) {
      const answered = this.navigation(nav, type, id, body);
      if (answered) return;
    }
    const act = this.opts.activity;
    const mapped = (body[0] === 0xf0 || body[0] === 0x00) && body[1] === 0x30 ? [...this.activityPaths].find(([, n]) => n === body[2])?.[0] : undefined;
    const head0 = body.subarray(0, 6);
    const lb = this.opts.logbook;
    const tr = this.opts.trends;
    if (tr && mapped === "/Activity/TrendData" && type === MT.GET) {
      // Like the Run 2: from the record at the time asked for (else the oldest), ten a page,
      // 202 while more follow.
      const since = Number(new DataView(body.buffer, body.byteOffset + 9, 8).getBigInt64(0, true));
      let i = tr.findIndex((r) => r.t === since);
      if (i < 0) i = 0;
      const page = tr.slice(i, i + 10);
      const rec = encodeTrendPage(page);
      return this.reply(MT.GET_REPLY, id, concat(head0, le16(i + 10 < tr.length ? 202 : 200), le16(TREND_TYPE), le16((2 + rec.length) | (2 << 9)), new Uint8Array(2), rec));
    }
    if (lb && mapped?.startsWith("/Logbook/")) {
      const m = /^\/Logbook\/byId\/(\d+)\/(\w+)$/.exec(mapped);
      const entry = m ? lb.find((e) => e.id === Number(m[1])) : undefined;
      if (type === MT.PUT) {
        this.opts.puts?.push({ path: mapped, value: body[9] ?? 0, type: readLe16(body, 7) });
        return this.reply(MT.PUT_REPLY, id, concat(head0, le16(200)));
      }
      if (type === MT.SUBSCRIBE && entry && m![2] === "Data") {
        this.reply(MT.SUBSCRIBE_REPLY, id, concat(head0, le16(200), le16(0)));
        // {offset u32, bytes[]} notifications of up to 279 bytes, then an empty one.
        const note = (offset: number, bytes: Uint8Array) => {
          const rec = concat(le32(offset), le16(bytes.length), le16(0), le32(12), bytes);
          // Like the Run 2: the notification names the resource with f0 as its first byte.
          return concat(Uint8Array.of(0xf0), head0.subarray(1), le16(0x2402), le16(rec.length | (2 << 9)), rec);
        };
        for (let o = 0; o < entry.data.length; o += 279) this.reply(MT.NOTIFICATION, 0, note(o, entry.data.subarray(o, o + 279)));
        this.reply(MT.NOTIFICATION, 0, note(entry.data.length, new Uint8Array()));
        return;
      }
      if (type === MT.UNSUBSCRIBE) return this.reply(MT.UNSUBSCRIBE_REPLY, id, concat(head0, le16(200), le16(0)));
      if (type !== MT.GET) return this.reply(MT.ERROR, id, concat(head0, le16(501)));
      if (mapped === "/Logbook/Entries") {
        const els = concat(...lb.map((e) => concat(le32(e.id), le32(e.modified), Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0), le32(e.summary.length + e.data.length), le32(0))));
        const rec = concat(le16(lb.length), le16(0), le32(12), le32(0), els);
        return this.reply(MT.GET_REPLY, id, concat(head0, le16(200), le16(0x2401), le16((2 + rec.length) | (2 << 9)), new Uint8Array(2), rec));
      }
      if (entry && m![2] === "Summary") {
        const offset = readLe32(body, 9);
        const chunk = entry.summary.subarray(offset, offset + 451);
        const done = offset + chunk.length >= entry.summary.length;
        const le24 = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff);
        return this.reply(MT.GET_REPLY, id, concat(head0, le16(done ? 200 : 100), le16(0x0d), Uint8Array.of(0x02), le24(chunk.length), le24(chunk.length), le16(chunk.length), chunk));
      }
      // Data answers GET with 400 on the Run 2's firmware as far as we know: stream it instead.
      return this.reply(MT.GET_REPLY, id, concat(head0, le16(entry ? 400 : 404)));
    }
    const activityPath = act ? mapped : undefined;
    if (type === MT.PUT) {
      if (activityPath === "/Activity/Logs/SyncCommand" && body[6] === 1) {
        const t = readLe16(body, 7);
        const value = body[9]!;
        this.opts.puts?.push({ path: activityPath, value, type: t });
        // Like the Run 2: the value parses only as the plain scalar (UINT8); anything else gets
        // no reply at all.
        if (t !== 3) return;
        this.syncing = value === act!.start ? true : value === act!.values.STOP ? false : this.syncing;
        return this.reply(MT.PUT_REPLY, id, concat(head0, le16(200)));
      }
      return this.reply(MT.PUT_REPLY, id, concat(head0, le16(404)));
    }
    if (type !== MT.GET) return this.reply(MT.ERROR, id, concat(body.subarray(0, 6), le16(501)));
    if (activityPath) {
      if (!this.syncing) return this.reply(MT.GET_REPLY, id, concat(head0, le16(503)));
      if (activityPath === "/Activity/Log/Count") return this.reply(MT.GET_REPLY, id, concat(head0, le16(200), le16(5), le16(act!.files.length)));
      const m = /^\/Activity\/Log\/(\d+)\/MoveData$/.exec(activityPath);
      const f = m ? act!.files[Number(m[1])] : undefined;
      if (f) return this.reply(MT.GET_REPLY, id, concat(head0, le16(200), le16(12), new TextEncoder().encode(`b:${f}\0`)));
      return this.reply(MT.GET_REPLY, id, concat(head0, le16(m ? 404 : 200), le16(0)));
    }
    if (act && body[0] === 0xf0 && body[1] === 0x00 && (body[2] === 0x0b || body[2] === 0x0c)) {
      const a0 = readLe16(body, 9);
      const names: Record<number, string> = { 0x4bda: "SyncCommand", 0x4c00: "SyncCommandValue", ...Object.fromEntries(Object.keys(act.values).map((k, i) => [0x4d00 + i, k])) };
      // A struct value as the Run 2 sends it: u16 type, u16 header (size incl. padding, align 4).
      const structReply = (t: number, rec: Uint8Array) => this.reply(MT.GET_REPLY, id, concat(head0, le16(200), le16(t), le16((2 + rec.length) | (2 << 9)), new Uint8Array(2), rec));
      if (body[2] === 0x0c && names[a0]) {
        return structReply(0x160, concat(le16(a0), le16(0), le32(8), new TextEncoder().encode(`${names[a0]}\0`)));
      }
      if (body[2] === 0x0b && (a0 === 0x2404 || a0 === 0x01bf)) {
        const rec = new Uint8Array(44);
        const dv = new DataView(rec.buffer);
        dv.setUint16(0, a0, true);
        if (a0 === 0x2404) {
          rec[2] = 1; // named
          rec[10] = 1;
          dv.setUint16(12, 0x4bda, true);
          rec[14] = 1;
          dv.setUint16(16, 0x01bf, true);
          return structReply(0x15e, rec);
        }
        const items = Object.entries(act.values);
        rec[2] = 4; // enum
        rec[3] = 1;
        rec[4] = 3; // UINT8
        rec[10] = 1;
        dv.setUint16(12, 0x4c00, true);
        rec[32] = 1;
        dv.setUint16(36, items.length, true);
        dv.setUint32(40, 44, true);
        const list = concat(...items.map(([, v], i) => concat(le16(0x4d00 + i), le16(v))));
        return structReply(0x15e, concat(rec, list));
      }
    }

    const triple = Array.from(body.subarray(0, 3));
    const head = body.subarray(0, 6);
    const same = (t: number[] | undefined) => !!t && t.every((x, i) => x === triple[i]);

    const sc = this.opts.schema;
    if (sc) {
      const meta = triple[0] === 0xf0 && triple[1] === 0x00 ? triple[2]! : -1;
      const arg = (i: number) => readLe16(body, 9 + i * 4); // u16 params: type(2) + value(2) each… u8 ones are shorter
      const res = (sc.handle[1] << 8) | sc.handle[2];
      // A metadata value as the Run 2 sends it: u16 type, u8 size, u8 flags, padding up to the
      // record's alignment (frame offset 14 + 4), then the record.
      const metaReply = (type: number, align: number, rec: Uint8Array) => {
        const pad = (align - ((14 + 4) % align)) % align;
        return this.reply(MT.GET_REPLY, id, concat(head, le16(200), le16(type), Uint8Array.of(rec.length, 0x34), new Uint8Array(pad), rec));
      };
      const u32 = (n: number) => le32(n);
      const node = meta === 0x03 ? this.opts.tree?.find((n) => n.id === arg(0)) : undefined;
      if (node || (meta === 0x03 && arg(0) === res)) {
        const n = node ?? { id: res, name: "DirectoryList", parent: 0x0241, next: 0x2302, child: 0xffff, ops: 1 };
        const name = new TextEncoder().encode(`${n.name}\0`);
        const opsAt = 28 + name.length + (name.length % 2);
        const ops = n.ops ?? 0;
        return metaReply(0x23, 4, concat(le16(n.id), le16(0), u32(28), Uint8Array.of(0, 0, 0, 0), u32(ops), u32(opsAt), le16(0xffff), le16(n.parent), le16(n.next), le16(n.child), name, new Uint8Array(name.length % 2), ...(ops ? [le16(n.id === res ? sc.opId : 0x100 + n.id)] : [])));
      }
      if (meta === 0x04 && arg(0) === res) {
        const n = sc.params.length;
        return metaReply(0x25, 4, concat(le16(sc.opId), Uint8Array.of(1, 0), u32(1), u32(n), u32(24), u32(3), u32(24 + n * 2), ...sc.params.map((_, i) => le16(0xf4 + i)), le16(0x75), le16(1), le16(2)));
      }
      if (meta === 0x07 && arg(0) === sc.opId) {
        const i = body[13]!;
        const p = sc.params[i];
        if (!p) return this.reply(MT.GET_REPLY, id, concat(head, le16(404)));
        return metaReply(0x27, 2, concat(le16(0xf4 + i), le16(0x500 + i), Uint8Array.of(1, 0), le16(p.type)));
      }
      if (meta === 0x0c && arg(0) >= 0x500 && arg(0) < 0x500 + sc.params.length) {
        const nm = new TextEncoder().encode(`${sc.params[arg(0) - 0x500]!.name}\0`);
        return metaReply(0x2d, 4, concat(le16(arg(0)), le16(0), u32(8), nm));
      }
      if (triple.every((x, i) => x === sc.handle[i])) {
        // Accept only exactly the declared parameter types.
        let at = 7;
        const count = body[6]!;
        let ok = count === sc.params.length;
        let path = "";
        for (let i = 0; ok && i < count; i++) {
          const t = readLe16(body, at);
          at += 2;
          if (t !== sc.params[i]!.type) ok = false;
          else if (t === 12) {
            path = cString(body, at);
            at += path.length + 1;
          } else {
            const page = t === 3 ? body[at]! : t === 5 ? readLe16(body, at) : readLe32(body, at);
            if (page < (sc.firstPage ?? 0)) ok = false;
            at += t === 3 ? 1 : t === 5 ? 2 : 4;
          }
        }
        if (!ok) return this.reply(MT.GET_REPLY, id, concat(head, le16(400)));
        const canonical = this.canonical(path);
        const json = canonical === null ? "{}" : JSON.stringify(this.listing(canonical));
        return this.reply(MT.GET_REPLY, id, concat(head, le16(200), le16(12), new TextEncoder().encode(json + "\0")));
      }
    }

    if (same(TRIPLES["/Dev/FileSystem/DirectoryList"]) && body[7] === 0x0c) {
      const path = cString(body, 9);
      if (this.opts.silentPaths?.includes(path)) return;
      if (this.opts.listForm) {
        const count = body[6];
        const after = body[9 + path.length + 1];
        const form = count === 1 ? "path" : after === 3 ? "path+u8" : after === 6 ? "path+i32" : "?";
        if (form !== this.opts.listForm) return this.reply(MT.GET_REPLY, id, concat(head, le16(400)));
      }
      const canonical = this.canonical(path);
      const json = canonical === null ? "{}" : JSON.stringify(this.listing(canonical));
      const value = concat(le16(12), new TextEncoder().encode(json + "\0"));
      return this.reply(MT.GET_REPLY, id, concat(head, le16(200), value));
    }

    if (same(TRIPLES["/Dev/FileSystem/Stream"]) && body[7] === 0x0c) {
      const path = cString(body, 9);
      if (this.opts.silentPaths?.includes(path)) return;
      const offset = readLe32(body, 9 + path.length + 1 + 2);
      const canonical = this.canonical(path);
      const file = canonical === null ? undefined : this.opts.files[canonical];
      if (!file) return this.reply(MT.GET_REPLY, id, concat(head, le16(404)));
      const chunk = file.subarray(offset, offset + (this.opts.readChunk ?? 400));
      const done = offset + chunk.length >= file.length;
      const le24 = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff);
      const value = concat(le16(0x0d), Uint8Array.of(0x02), le24(chunk.length), le24(chunk.length), le16(0), chunk);
      return this.reply(MT.GET_REPLY, id, concat(head, le16(done ? 200 : 100), value));
    }

    // Metadata, /System/Mode, /Info, /Dev/Capabilities: answer 200 with a small value.
    const info = id === 76 ? new TextEncoder().encode(`\0${this.name}\0SN0042\0FW 2.44.12\0`) : le32(0);
    return this.reply(MT.GET_REPLY, id, concat(head, le16(200), info));
  }

  /** The route resources and the metadata describing them; true when the frame was theirs. */
  private navigation(nav: NonNullable<FakeWatchOptions["navigation"]>, type: number, id: number, body: Uint8Array): boolean {
    const head = body.subarray(0, 6);
    const le24 = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff);
    const structReply = (t: number, rec: Uint8Array, align = 4, status = 200) => {
      const pad = (align - (18 % align)) % align;
      this.reply(MT.GET_REPLY, id, concat(head, le16(status), le16(t), le16((pad + rec.length) | (Math.log2(align) << 9) | (2 << 12)), new Uint8Array(pad), rec));
    };
    // Metadata: DataTypeMetadata (f0000b) and names (f0000c) for the described types.
    if (body[0] === 0xf0 && body[1] === 0x00 && (body[2] === 0x0b || body[2] === 0x0c) && type === MT.GET) {
      const a0 = readLe16(body, 9);
      const names: string[] = [];
      for (const t of Object.values(nav.types)) for (const f of t.fields ?? []) names.push(f.name);
      if (body[2] === 0x0c && a0 >= 0x7000 && a0 < 0x7000 + names.length) {
        structReply(0x2d, concat(le16(a0), le16(0), le32(8), new TextEncoder().encode(`${names[a0 - 0x7000]}\0`)));
        return true;
      }
      const t = body[2] === 0x0b ? nav.types[a0] : undefined;
      if (!t) return false;
      const rec = new Uint8Array(44);
      const dv = new DataView(rec.buffer);
      dv.setUint16(0, a0, true);
      rec[2] = t.kind;
      if (t.scalarType !== undefined) {
        rec[3] = 1;
        rec[4] = t.scalarType;
      }
      if (t.baseTypeId !== undefined) {
        rec[14] = 1;
        dv.setUint16(16, t.baseTypeId, true);
      }
      const fields = t.fields ?? [];
      if (fields.length) {
        rec[20] = 1;
        dv.setUint32(24, fields.length, true);
        dv.setUint32(28, 44, true);
      }
      structReply(0x2b, concat(rec, ...fields.map((f) => concat(le16(0x7000 + names.indexOf(f.name)), le16(f.type), Uint8Array.of(f.required === false ? 0 : 1, 1)))));
      return true;
    }
    if (body[0] !== 0xf0 || body[1] !== 0x36) return false;
    const path = [...this.navPaths].find(([, n]) => 0x80 + n === body[2])?.[0];
    if (!path) return false;
    if (type === MT.GET && path === "/DataFormat/Descriptors") {
      if (body[9] !== 2) {
        this.reply(MT.GET_REPLY, id, concat(head, le16(404)));
        return true;
      }
      const all = new TextEncoder().encode(nav.descriptor);
      const offset = readLe32(body, 12);
      const chunk = all.subarray(offset, offset + 200);
      const end = offset + chunk.length;
      this.reply(MT.GET_REPLY, id, concat(head, le16(end >= all.length ? 200 : 100), le16(0x0d), Uint8Array.of(2), le24(all.length), le24(end), le16(chunk.length), chunk));
      return true;
    }
    // Structured workouts (SuuntoPlus guides).
    const plug = nav.plugins;
    const textAt9 = () => new TextDecoder().decode(body.subarray(9)).split("\0")[0]!;
    if (plug && type === MT.GET && path === "/Plugin/List") {
      structReply(0xaa03, new TextEncoder().encode(plug.ids.map((x) => `${x}\0`).join("")));
      return true;
    }
    if (plug && type === MT.GET && path === "/Plugin/InstallAid") {
      structReply(0xaa04, new TextEncoder().encode(`${plug.folder ?? "/emmc/data/Data/Structured"}\0`));
      return true;
    }
    if (plug && type === MT.PUT && (path.startsWith("/Plugin/") || path === "/Dev/FileSystem/DirectoryCreate" || (path === "/Dev/FileSystem/Stream" && (plug.streaming || (readLe16(body, 7) === 12 && textAt9().startsWith("/emmc/data/")))))) {
      nav.writes?.push(path);
      if (path === "/Dev/FileSystem/DirectoryCreate") {
        const dir = textAt9();
        const made = !plug.dirs.includes(dir);
        if (made) plug.dirs.push(dir);
        this.reply(MT.PUT_REPLY, id, concat(head, le16(made ? 200 : 501)));
        return true;
      }
      if (path === "/Dev/FileSystem/Stream") {
        if (readLe16(body, 7) === 12) {
          plug.streaming = textAt9();
          plug.incoming = [];
          this.reply(MT.PUT_REPLY, id, concat(head, le16(100)));
          return true;
        }
        const total = body[10]! | (body[11]! << 8) | (body[12]! << 16);
        const end = body[13]! | (body[14]! << 8) | (body[15]! << 16);
        plug.incoming!.push(body.slice(18, 18 + readLe16(body, 16)));
        if (end >= total) {
          plug.files[plug.streaming!] = concat(...plug.incoming!);
          plug.streaming = null;
        }
        this.reply(MT.PUT_REPLY, id, concat(head, le16(end >= total ? 200 : 100)));
        return true;
      }
      if (path === "/Plugin/Install") {
        // The newest file in the folder becomes a guide named after it.
        const last = Object.keys(plug.files).at(-1);
        const gid = last?.replace(/^.*\/([a-z0-9]+)\.zip$/, "$1");
        if (gid && !plug.ids.includes(gid)) plug.ids.push(gid);
        this.reply(MT.PUT_REPLY, id, concat(head, le16(gid ? 200 : 400)));
        return true;
      }
      if (path === "/Plugin/Uninstall") {
        const gone = textAt9();
        const had = plug.ids.includes(gone);
        plug.ids = plug.ids.filter((x) => x !== gone);
        if (had) plug.removed = [...(plug.removed ?? []), gone];
        this.reply(MT.PUT_REPLY, id, concat(head, le16(had ? 200 : 404)));
        return true;
      }
    }
    const faces = nav.faces;
    if (faces && path.startsWith("/WatchFace/") && type === MT.GET) {
      if (path === "/WatchFace/Lists") {
        // Five faces a page, like the Run 2: 100 means more, asked for with the last id seen.
        const after = body[6] === 1 && readLe16(body, 7) === 12 ? new TextDecoder().decode(body.subarray(9)).split("\0")[0]! : null;
        const from = after === null ? 0 : faces.ids.indexOf(after) + 1;
        const page = faces.ids.slice(from, from + 5);
        structReply(0xb301, new TextEncoder().encode(page.map((id) => `${id}\0Face ${id}\0v1.0.0\0`).join("")), 4, from + 5 < faces.ids.length ? 100 : 200);
        return true;
      }
      if (path === "/WatchFace/InstallPath") {
        this.reply(MT.GET_REPLY, id, concat(head, le16(200), le16(12), new TextEncoder().encode(`${faces.path ?? "/emmc/dial/download/0.zip"}\0`)));
        return true;
      }
    }
    if (faces && type === MT.PUT && (path.startsWith("/WatchFace/") || path === "/Dev/FileSystem/Stream")) {
      nav.writes?.push(path);
      if (path === "/WatchFace/Info") {
        const hdr = readLe16(body, 9);
        const align = 1 << ((hdr >> 9) & 7);
        const start = 17 + ((align - (17 % align)) % align);
        faces.info = body.slice(start - 6, 11 + (hdr & 0x1ff));
        // The watch answers with the path it wants the file at (named after the face's id).
        const idText = new TextDecoder().decode(faces.info.subarray(new DataView(faces.info.buffer, faces.info.byteOffset).getUint32(0, true))).split("\0")[0];
        faces.path = `/emmc/dial/download/${idText}.zip`;
        this.reply(MT.PUT_REPLY, id, concat(head, le16(200)));
        return true;
      }
      if (path === "/Dev/FileSystem/Stream") {
        if (readLe16(body, 7) === 12) {
          faces.incoming = [];
          const named = new TextDecoder().decode(body.subarray(9)).split("\0")[0];
          this.reply(MT.PUT_REPLY, id, concat(head, le16(named === faces.path ? 100 : 403)));
          return true;
        }
        const total = body[10]! | (body[11]! << 8) | (body[12]! << 16);
        const end = body[13]! | (body[14]! << 8) | (body[15]! << 16);
        faces.incoming?.push(body.slice(18, 18 + readLe16(body, 16)));
        if (end >= total) faces.zip = concat(...(faces.incoming ?? []));
        this.reply(MT.PUT_REPLY, id, concat(head, le16(end >= total ? 200 : 100)));
        return true;
      }
      if (path === "/WatchFace/Delete/MultiId") {
        // Ids: the list (count, offset 8), each element a string offset; ids removed if listed.
        const hdr = readLe16(body, 9);
        const start = 17 + ((4 - (17 % 4)) % 4) - 6;
        const rec = body.subarray(start, 11 + (hdr & 0x1ff));
        const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        const n = dv.getUint32(0, true);
        const at = dv.getUint32(4, true);
        for (let i = 0; i < n; i++) {
          const off = dv.getUint32(at + i * 4, true);
          const gone = new TextDecoder().decode(rec.subarray(off)).split("\0")[0]!;
          faces.removed = [...(faces.removed ?? []), gone];
          faces.ids = faces.ids.filter((x) => x !== gone);
        }
        this.reply(MT.PUT_REPLY, id, concat(head, le16(200)));
        return true;
      }
      if (path === "/WatchFace/Install") {
        const ok = !!faces.zip && !!faces.info;
        if (ok) faces.ids.push(faces.path!.replace(/^.*\/(\d+)\.zip$/, "$1"));
        this.reply(MT.PUT_REPLY, id, concat(head, le16(ok ? 200 : 400)));
        return true;
      }
    }
    if (type === MT.GET && path === "/Settings/Navigation/RouteList") {
      structReply(0x3600, concat(le32(nav.ids.length), le32(8), ...nav.ids.map((n) => le32(n))));
      return true;
    }
    if (type === MT.PUT) {
      nav.writes?.push(path);
      if (path === "/Settings/Navigation/Route/Data") {
        if (body[6] === 0) {
          this.navIncoming = [];
          this.reply(MT.PUT_REPLY, id, concat(head, le16(100)));
          return true;
        }
        const total = body[10]! | (body[11]! << 8) | (body[12]! << 16);
        const end = body[13]! | (body[14]! << 8) | (body[15]! << 16);
        const len = readLe16(body, 16);
        this.navIncoming.push(body.slice(18, 18 + len));
        if (end >= total) nav.file = concat(...this.navIncoming);
        this.reply(MT.PUT_REPLY, id, concat(head, le16(end >= total ? 200 : 100)));
        return true;
      }
      if (path === "/Settings/Navigation/Route") {
        // u16 type, u16 header, padding to the alignment from the frame start, the record.
        const hdr = readLe16(body, 9);
        const align = 1 << ((hdr >> 9) & 7);
        const start = 17 + ((align - (17 % align)) % align);
        nav.record = body.slice(start - 6, 11 + (hdr & 0x1ff));
        nav.ids.push(readLe32(nav.record, 0));
        this.reply(MT.PUT_REPLY, id, concat(head, le16(200)));
        return true;
      }
    }
    return false;
  }

  /** Strip/validate the drive prefix the way each generation does; null = wrong spelling. */
  private canonical(path: string): string | null {
    const hasDrive = /^b:/.test(path);
    if (this.gen === "ng1" && hasDrive) return null;
    if (this.gen === "ng3" && !hasDrive) return null;
    const p = path.replace(/^b:/, "");
    return p.startsWith("/") ? p : "/" + p;
  }

  private listing(dir: string) {
    const prefix = dir === "/" ? "/" : dir + "/";
    const files = new Set<string>();
    const dirs = new Set<string>();
    for (const p of Object.keys(this.opts.files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) files.add(rest);
      else dirs.add(rest.slice(0, slash));
    }
    return { dirs: [...dirs], files: [...files] };
  }
}

function cString(b: Uint8Array, at: number): string {
  let end = at;
  while (end < b.length && b[end] !== 0) end++;
  return new TextDecoder().decode(b.subarray(at, end));
}
