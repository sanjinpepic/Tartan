import { BRING_UP, DIRLIST_SETUP, STREAM_SETUP } from "./captured.ts";
import { sendRouteToWatch, type SendProgress } from "./route-send.ts";
import { faceIds, installFaceOnWatch, isTartanFaceId, removeFaceFromWatch, type FaceProgress } from "./face-send.ts";
import type { FacePackage } from "../watchface/package.ts";
import { installWorkoutOnWatch, removeWorkoutFromWatch, WORKOUT_DIR, WORKOUT_DIRS, workoutIds, type WorkoutProgress } from "./workout-send.ts";
import { TARTAN_WORKOUT_ID } from "../workout/guide.ts";
import type { WatchRoutePoint } from "./route-file.ts";
import { parseTypeMeta, type TypeMeta } from "./wbstruct.ts";
import { readTrendLog, TREND_TYPE, type TrendRecord } from "./trends.ts";
import {
  DIRLIST_TRIPLE,
  Deframer,
  FS_CLIENT,
  MT,
  buildFrame,
  concat,
  STATUS,
  STREAM_TRIPLE,
  dirListFrame,
  hexToBytes,
  parseDirListing,
  parseFileChunk,
  parseReply,
  printableStrings,
  readFileFrame,
  resolveFrame,
  type ListEncoding,
  type ListForm,
  readLe16,
  typedListFrame,
  ENCODABLE_TYPES,
  wrap,
  type DirListing,
  type Reply,
} from "./codec.ts";

/** GATT service + characteristics carrying the whiteboard protocol. */
export const WB_SERVICE = "61353090-8231-49cc-b57a-886370740041";
export const WB_WRITE = "17816557-5652-417f-909f-3aee61e5fa85";
export const WB_NOTIFY = "34802252-7185-4d5d-b431-630e7050e8f0";

/** Anything that can move bytes to and from the watch's whiteboard characteristics. */
export interface BleLink {
  /** Human-readable device name (the advertised name carries model + serial). */
  readonly name: string;
  /** Max bytes per GATT write-without-response (ATT MTU - 3; 20 is always safe). */
  readonly chunkSize: number;
  write(chunk: Uint8Array): Promise<void>;
  /** Start notifications. `onData` gets raw notification payloads. */
  subscribe(onData: (chunk: Uint8Array) => void, onClose: (reason: string) => void): Promise<void>;
  close(): Promise<void>;
}

/**
 * Watch generations differ in the filesystem drive prefix:
 * NG3 (Vertical 2, Race 2, …) wants `b:/logs`, NG1 (9 Peak Pro, …) wants `/logs`.
 * `drive-a` / `drive-c` are guesses for models nobody has mapped yet (probed last).
 */
export type Generation = "ng1" | "ng3" | "ng3-bare" | "drive-a" | "drive-c";
const PREFIX: Record<Generation, string> = { ng1: "", ng3: "b:", "ng3-bare": "b:", "drive-a": "a:", "drive-c": "c:" };

export interface SessionOptions {
  log?: (msg: string) => void;
  /** Force a generation instead of probing. */
  generation?: Generation;
  /** Per-request reply timeout. */
  timeoutMs?: number;
  /** Pause between GATT chunks of one frame (the watch reassembles on 0x7E). */
  chunkDelayMs?: number;
  /** Pause after each reply before the next request. */
  frameGapMs?: number;
  /** Called once if the link drops. */
  onClose?: (reason: string) => void;
}

export interface WatchInfo {
  name: string;
  generation?: Generation;
  /** Strings found in the /Info reply: product, serial, firmware versions. */
  info: string[];
}

export interface ResourceSchema {
  opId: number;
  params: Array<{ id: number; name: string; required: boolean; type: number }>;
}

// 1 (BOOL) and 7 (UINT32) as the Run 2's replies carry them; 2, 4 and 8–11 by the same pattern.
const TYPE_NAMES: Record<number, string> = { 1: "BOOL", 2: "INT8", 3: "UINT8", 4: "INT16", 5: "UINT16", 6: "INT32", 7: "UINT32", 8: "INT64", 9: "UINT64", 10: "FLOAT", 11: "DOUBLE", 12: "STRING", 13: "BYTES", 14: "STREAM" };

/** Client triple for device (non-file) resources, as the official app sends them. */
const DEV_CLIENT = Uint8Array.of(0x01, 0x80, 0x00);

export interface SyncItem {
  nameId: number;
  name: string;
  value: number;
}
export interface WatchType {
  id: number;
  kind: number;
  scalarType?: number;
  nameId?: number;
  name?: string;
  baseTypeId?: number;
  items: SyncItem[];
}
export interface SyncOptions {
  /** The parameter's declared type (named) and the enum it resolves to. */
  declared: number;
  enumId: number;
  scalarType: number;
  items: SyncItem[];
}

/** A struct value's bytes: u16 type, u16 header (size in bits 0–8, alignment 1 << bits 9–11). */
function structValue(frame: Uint8Array): Uint8Array | null {
  if (frame.length < 22) return null;
  const hdr = readLe16(frame, 16);
  const align = 1 << ((hdr >> 9) & 7);
  const he = 18;
  const start = he + ((align - (he % align)) % align);
  const end = Math.min(frame.length - 4, he + (hdr & 0x1ff));
  return start <= end ? frame.subarray(start, end) : null;
}

export interface LogEntry {
  id: number;
  /** Seconds since the epoch. */
  modified: number;
  size?: number;
}

function joinBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A builtin scalar reply value: u16 type, then the little-endian number. */
function builtinValue(frame: Uint8Array): number | null {
  const body = frame.subarray(14, -4);
  if (body.length < 3) return null;
  const t = readLe16(body, 0);
  const size = t === 1 || t === 2 || t === 3 ? 1 : t === 4 || t === 5 ? 2 : t === 6 || t === 7 ? 4 : 0;
  if (!size || body.length < 2 + size) return null;
  let v = 0;
  for (let i = size - 1; i >= 0; i--) v = v * 256 + body[2 + i]!;
  return v;
}

interface ResourceNode {
  id: number;
  name: string;
  parent: number;
  next: number;
  child: number;
  ops: number;
}

export class WatchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const NG1_MARKERS = ["peakpro", "peak pro", "9 peak"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Request ID the captured bring-up uses for GET /Info. */
const INFO_REQUEST_ID = 76;

/**
 * One connected session with a watch. All traffic is strictly request → reply,
 * one request in flight, as the firmware expects.
 */
export class WatchSession {
  /** The resource tree is mapped at most once per app run (it takes a few hundred requests). */
  static mapped = false;
  /** Logbook and file-system state is read at most once per app run after a failed listing. */
  static inspected = false;
  /** The value probes (a few dozen requests) run at most once per app run. */
  static probed = false;
  /** The Run 2's tree is known (HANDOVER.md); map again only when asked. */
  mapOnFailure = false;
  private readonly log: (msg: string) => void;
  private readonly timeoutMs: number;
  private readonly chunkDelayMs: number;
  private readonly frameGapMs: number;
  private readonly onClose?: (reason: string) => void;

  private inbox: Reply[] = [];
  private wake: (() => void) | null = null;
  private closedReason: string | null = null;
  private busy = false;
  private nextId = 0x20;
  /** Request IDs this session used, to tell its replies from another app's on the shared link. */
  private readonly ours = new Set<number>();
  /** Replies that answered someone else (the Suunto app on the same phone). */
  private foreign = 0;
  /** Handles those replies were for, to name them in the log. */
  private readonly foreignHandles = new Set<string>();
  /** Resolved handles by client and path. */
  private readonly handles = new Map<string, Uint8Array | null>();

  private dirTriple: Uint8Array | null = null;
  private listForm: ListForm = "path+u8";
  /** Parameter types read from the watch's own DirectoryList schema, once it told us. */
  private listTypes: number[] | null = null;
  /** First page index this firmware accepts (0 on the captured watches). */
  private firstPage = 0;
  /** Same for Stream (file reads), learned on the first 400. */
  private streamTypes: number[] | null = null;
  private schema: ResourceSchema | null | undefined;
  /** What resolving DirectoryList returned, for error messages. */
  private dirResolve = "";
  private streamTriple: Uint8Array | null = null;
  private generation: Generation | undefined;
  private bringUpReplies: Reply[] = [];

  constructor(readonly link: BleLink, opts: SessionOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.chunkDelayMs = opts.chunkDelayMs ?? 8;
    this.frameGapMs = opts.frameGapMs ?? 15;
    this.generation = opts.generation;
    this.onClose = opts.onClose;
  }

  /** Subscribe to notifications and replay the official app's read-only bring-up. */
  async open(): Promise<WatchInfo> {
    const deframer = new Deframer((frame) => {
      try {
        this.inbox.push(parseReply(frame));
      } catch (e) {
        this.log(`[rx] dropped malformed frame: ${(e as Error).message}`);
      }
      this.wake?.();
    });
    await this.link.subscribe(
      (chunk) => deframer.push(chunk),
      (reason) => {
        if (this.closedReason) return;
        this.closedReason = reason || "disconnected";
        this.wake?.();
        this.onClose?.(this.closedReason);
      },
    );
    this.log(`[session] bringing the protocol up (${BRING_UP.length} frames)…`);
    this.bringUpReplies = await this.replay(BRING_UP);
    const info = this.info();
    this.log(`[session] watch reports: ${info.info.join(" · ") || "(no /Info strings)"}`);
    return info;
  }

  info(): WatchInfo {
    const reply = this.bringUpReplies.find((r) => r.requestId === INFO_REQUEST_ID && r.type === MT.GET_REPLY);
    return {
      name: this.link.name,
      generation: this.generation,
      info: reply ? printableStrings(reply.raw.subarray(14, -4)) : [],
    };
  }

  /** True once the link dropped; every further request fails. */
  get closed(): boolean {
    return this.closedReason !== null;
  }

  async close(): Promise<void> {
    this.closedReason ??= "closed";
    await this.link.close();
  }

  // ------------------------------------------------------------ filesystem

  /**
   * Lists a directory. Paths are written generation-neutral (`/`, `/logs`); the drive
   * prefix is added for NG3 watches and detected automatically on first use.
   */
  async listDir(path = "/"): Promise<DirListing> {
    await this.ensureDirList();
    const canonical = normalize(path);
    if (!this.generation) await this.detectGeneration();
    const listing = await this.listSpelled(spell(canonical, this.generation!));
    // The NG3 root may be spelled "b:" rather than "b:/".
    if (canonical === "/" && this.generation === "ng3" && !listing.files.length && !listing.dirs.length) {
      return this.listSpelled("b:");
    }
    return listing;
  }

  /** Downloads a whole file. `onProgress` gets the running byte count. */
  async readFile(path: string, onProgress?: (bytes: number) => void): Promise<Uint8Array> {
    if (!this.generation) {
      await this.ensureDirList();
      await this.detectGeneration();
    }
    await this.ensureStream();
    const spelled = spell(normalize(path), this.generation!);
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const id = this.allocId();
      const frame = this.streamTypes ? typedListFrame(spelled, id, this.streamTriple!, this.streamTypes, total) : readFileFrame(spelled, id, total, this.streamTriple!);
      const reply = await this.request(frame, id);
      if (reply.status === STATUS.BAD_REQUEST && !this.streamTypes && total === 0) {
        // Like DirectoryList: this firmware wants other parameter types. Ask it, then retry.
        const schema = await this.describeResource(this.streamTriple!).catch(() => null);
        const types = schema?.params.map((p) => p.type) ?? [];
        if (types.length && types.every((t) => ENCODABLE_TYPES.has(t))) {
          this.streamTypes = types;
          this.log(`[session] reading files with the watch's own schema (${types.join(", ")})`);
          continue;
        }
      }
      if (reply.status !== STATUS.OK && reply.status !== STATUS.CONTINUE) {
        throw new WatchError(`read ${spelled}: watch answered ${reply.status}`, reply.status);
      }
      const chunk = parseFileChunk(reply.raw);
      parts.push(chunk.data);
      total += chunk.data.length;
      onProgress?.(total);
      if (chunk.status === STATUS.OK) break;
      if (chunk.data.length === 0) throw new WatchError(`read ${spelled}: watch stalled at ${total} bytes`);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  /**
   * Learn the drive prefix. `/zapp` (installed SuuntoPlus apps) exists on every supported
   * watch and is the spelling verified on both generations; the root is the fallback.
   */
  async detectGeneration(): Promise<Generation> {
    if (this.generation) return this.generation;
    await this.ensureDirList();
    const lower = this.link.name.toLowerCase();
    const order: Generation[] = NG1_MARKERS.some((m) => lower.includes(m)) ? ["ng1", "ng3"] : ["ng3", "ng1"];
    const tried: string[] = [];
    const attempts: Array<[string, Generation]> = [
      ...["/zapp", "/"].flatMap((probe) => order.map((gen) => [probe, gen] as [string, Generation])),
      ["/", "drive-a"],
      ["/", "drive-c"],
    ];
    for (const [probe, gen] of attempts) {
      const spelled = spell(probe, gen);
      try {
        const listing = await this.listSpelled(spelled);
        if (listing.files.length || listing.dirs.length) {
          this.generation = gen;
          this.log(`[session] filesystem layout: ${gen} (${spell("/", gen)}…)`);
          return gen;
        }
        tried.push(`${spelled} empty`);
        this.log(`[session] ${spelled}: empty listing`);
      } catch (e) {
        if (this.closed) throw e;
        const msg = (e as Error).message;
        const status = (e as WatchError).status;
        tried.push(`${spelled} ${status ? `answered ${status}` : /no reply/.test(msg) ? "no reply" : /no directory listing/.test(msg) ? "unreadable reply" : msg.slice(0, 40)}`);
        this.log(`[session] ${spelled}: ${msg}`);
      }
    }
    // Every spelling refused with 400: this firmware wants the request in another shape.
    // First ask the watch which (its DirectoryList schema), and build the request from that.
    if (tried.every((t) => / answered 400$/.test(t))) {
      this.schema = await this.describeResource(this.dirTriple!).catch((e) => {
        this.log(`[schema] stopped: ${(e as Error).message}`);
        return null;
      });
      const types = this.schema?.params.map((p) => p.type) ?? [];
      const known = types.length > 0 && types.every((t) => ENCODABLE_TYPES.has(t));
      if (known) {
        for (const gen of ["ng3", "ng1"] as Generation[]) {
          const spelled = spell("/", gen);
          try {
            const listing = await this.listSpelled(spelled, this.listForm, this.dirTriple!, types);
            if (listing.files.length || listing.dirs.length) {
              this.generation = gen;
              this.listTypes = types;
              this.log(`[session] listing works with the watch's own schema (${types.join(", ")}), layout ${gen}`);
              return gen;
            }
            tried.push(`schema ${spelled} empty`);
          } catch (e) {
            if (this.closed) throw e;
            tried.push(`schema ${spelled} ${(e as WatchError).status ?? (e as Error).message.slice(0, 30)}`);
            this.log(`[session] schema-built listing ${spelled}: ${(e as Error).message}`);
          }
        }
        // The request has the declared shape, so the values must be off: other path spellings
        // and page numbers, other storage roots, and other ways of writing the string. Any
        // answer but 400 teaches something (404 = format fine, no such path).
        type Probe = { gen?: Generation; spelled: string; page: number; enc?: ListEncoding; label?: string };
        const probes: Probe[] = WatchSession.probed ? [] : [
          ...([["ng3", "/", 1], ["ng1", "/", 1], ["ng3", "/zapp", 1], ["ng3-bare", "/", 0], ["ng3-bare", "/zapp", 0], ["ng3-bare", "/syslogs", 0], ["ng3", "/syslogs", 0], ["ng3-bare", "/", 1], ["ng3-bare", "/zapp", 1], ["ng3", "/logs", 0], ["ng1", "/logs", 0]] as Array<[Generation, string, number]>).map(([gen, path, page]) => ({ gen, spelled: spell(path, gen), page })),
          // Roots other embedded filesystems use (littlefs, FatFS, Zephyr mounts).
          ...["", "B:/", "/lfs", "/lfs1", "/ext", "/fs", "/data", "/NAND:", "/SD:", "0:/", "1:/", "/sd", "/flash", "/b", "/root", "."].map((spelled) => ({ spelled, page: 0 })),
          // The same request with the string written differently, or from the bring-up's client.
          ...(["b:/", "/", "b:/zapp"] as const).flatMap((spelled) => [
            { spelled, page: 0, enc: { strings: "len" }, label: "length-prefixed" },
            { spelled, page: 0, enc: { strings: "len+nul" }, label: "length+NUL" },
            { spelled, page: 0, enc: { client: Uint8Array.of(0x01, 0x80, 0x00) }, label: "client 018000" },
          ] as Probe[]),
        ];
        WatchSession.probed = true;
        const answers: string[] = [];
        for (const pr of probes) {
          const id = this.allocId();
          const reply = await this.request(typedListFrame(pr.spelled, id, this.dirTriple!, types, pr.page, pr.enc), id).catch((e) => {
            if (this.closed) throw e;
            return null;
          });
          const status = reply?.status ?? "no reply";
          const what = `${JSON.stringify(pr.spelled)} page ${pr.page}${pr.label ? ` ${pr.label}` : ""}`;
          answers.push(`${what} → ${status}`);
          if (status !== STATUS.BAD_REQUEST) this.log(`[probe] ${what} → ${status}${reply ? ` ${hex(reply.raw.subarray(0, 48))}` : ""}`);
          if (reply?.status === STATUS.OK || reply?.status === STATUS.CONTINUE) {
            const listing = parseDirListing(reply.raw);
            this.log(`[probe]   reply: ${JSON.stringify(new TextDecoder("latin1").decode(reply.raw.subarray(14, Math.min(reply.raw.length - 4, 14 + 160))))}`);
            if (pr.gen && !pr.enc && listing && (listing.files.length || listing.dirs.length)) {
              this.generation = pr.gen;
              this.listTypes = types;
              this.firstPage = pr.page;
              this.log(`[session] listing works: ${JSON.stringify(pr.spelled)} with first page ${pr.page}, layout ${pr.gen}`);
              return pr.gen;
            }
          }
        }
        if (answers.length) this.log(`[probe] ${answers.filter((a) => a.endsWith("→ 400")).length} of ${answers.length} value probes answered 400`);
        tried.push(...answers.filter((a) => !a.endsWith("→ 400")));
        await this.mapTree();
        await this.inspectWatch();
      }
      // The watch told us its parameters: guessing other shapes would only add noise.
      if (known) {
        const others = this.foreign ? ` Another app sent the watch ${this.foreign} requests on the same connection while we tried (the Suunto app or its background service): turn off its Nearby devices permission and try again.` : "";
        throw new WatchError(
          `the watch refused every listing (${this.dirResolve}; it takes ${this.schema!.params.map((p) => `${p.name || "?"} (${TYPE_NAMES[p.type] ?? `type ${p.type}`})`).join(", ")}, and we send exactly that; every path and page answered 400${tried.some((t) => !/400$/.test(t)) ? `; other answers: ${tried.filter((t) => !/400$/.test(t)).join("; ")}` : ""}).${others} Settings → Activity log → Copy log has the details.`,
        );
      }
      // Only the handle the watch resolved: a hard-coded one can name another resource on
      // other models (f02302 is EmmcFormat on the Run 2).
      const triples = [this.dirTriple!];
      for (const form of ["path", "path+i32", "path+u8"] as ListForm[]) {
        for (const triple of triples) {
          if (form === "path+u8" && triple === this.dirTriple) continue; // tried above
          for (const gen of ["ng3", "ng1"] as Generation[]) {
            const spelled = spell("/", gen);
            try {
              const listing = await this.listSpelled(spelled, form, triple);
              if (listing.files.length || listing.dirs.length) {
                this.generation = gen;
                this.listForm = form;
                this.dirTriple = triple;
                this.log(`[session] listing works as ${form} on handle ${hex(triple)}, layout ${gen}`);
                return gen;
              }
              tried.push(`${form}@${hex(triple)} ${spelled} empty`);
            } catch (e) {
              if (this.closed) throw e;
              const status = (e as WatchError).status;
              tried.push(`${form}@${hex(triple)} ${spelled} ${status ?? (e as Error).message.slice(0, 30)}`);
              this.log(`[session] ${form}@${hex(triple)} ${spelled}: ${(e as Error).message}`);
            }
          }
        }
      }
    }
    const wants = this.schema?.params.length ? ` The watch says its listing takes: ${this.schema.params.map((p) => `${p.name || "?"} (${TYPE_NAMES[p.type] ?? `type ${p.type}`})`).join(", ")}.` : "";
    const others = this.foreign ? ` Another app (the Suunto app) answered on the same connection ${this.foreign} times: force-stop it before trying again.` : "";
    const all400 = tried.every((t) => /\b400$/.test(t));
    throw new WatchError(
      all400
        ? `the watch didn't list its files (${this.dirResolve}; every request shape answered 400).${wants} Settings → Activity log → Copy log has the details.${others}`
        : `the watch didn't list its files (${tried.join("; ")}; ${this.dirResolve}). If the Suunto app is open on this phone, force-stop it and try again.${others}`,
    );
  }

  /**
   * Read-only metadata reads about one resource, the kind the official app makes on connect
   * (layouts per zappctl's docs/PROTOCOL.md, matched against the Run 2's own replies):
   * ResourceMetadata f00003(res) → its operation IDs; OperationMetadata f00004(res, op) →
   * parameter and response IDs; ParameterMetadata f00007(opId, i) → name, required, data type;
   * StringMetadata f0000c(nameId) → the name. Every reply is logged whole.
   */
  async describeResource(triple: Uint8Array): Promise<ResourceSchema | null> {
    const res = (triple[1]! << 8) | triple[2]!;
    const u16 = (n: number) => Uint8Array.of(0x05, 0x00, n & 0xff, (n >> 8) & 0xff);
    const u8 = (n: number) => Uint8Array.of(0x03, 0x00, n & 0xff);
    const ask = async (meta: number, label: string, ...params: Uint8Array[]): Promise<Reply | null> => {
      const id = this.allocId();
      try {
        const r = await this.request(buildFrame(MT.GET, id, concat(Uint8Array.of(0xf0, 0x00, meta), FS_CLIENT, Uint8Array.of(params.length), ...params)), id);
        this.log(`[schema] ${label} → ${r.status} ${hex(r.raw)} ${JSON.stringify(printableStrings(r.raw.subarray(14, -4)).join(" "))}`);
        return r.status === STATUS.OK ? r : null;
      } catch (e) {
        if (this.closed) throw e;
        this.log(`[schema] ${label} → ${(e as Error).message}`);
        return null;
      }
    };
    // A metadata value: u16 type, u8 size, u8 flags, then the record, aligned in the frame.
    const record = (r: Reply, align: number) => {
      const body = r.raw.subarray(14, -4);
      const start = 4 + ((align - ((14 + 4) % align)) % align);
      const at = (o: number) => start + o;
      return {
        u8: (o: number) => body[at(o)] ?? 0,
        u16: (o: number) => (at(o) + 2 <= body.length ? readLe16(body, at(o)) : 0),
        u32: (o: number) => (at(o) + 4 <= body.length ? (readLe16(body, at(o)) | (readLe16(body, at(o) + 2) << 16)) >>> 0 : 0),
        ids: (o: number) => {
          // An array field: u32 count, u32 offset from the record start; u16 items.
          const n = Math.min(8, (body[at(o)] ?? 0) | ((body[at(o) + 1] ?? 0) << 8));
          const off = (body[at(o) + 4] ?? 0) | ((body[at(o) + 5] ?? 0) << 8);
          return Array.from({ length: n }, (_, i) => at(off) + i * 2).filter((x) => x + 2 <= body.length).map((x) => readLe16(body, x));
        },
      };
    };
    const name = `0x${res.toString(16)}`;
    this.log(`[schema] describing resource ${name} (handle ${hex(triple)})`);
    const rm = await ask(0x03, `resource ${name}`, u16(res));
    const opIds = rm ? record(rm, 4).ids(12) : [];
    this.log(`[schema] ${name}: operations ${opIds.map((x) => `0x${x.toString(16)}`).join(", ") || "?"}`);
    const om = await ask(0x04, `${name} operation 0`, u16(res), u8(0));
    if (!om) return null;
    const op = record(om, 4);
    const opId = op.u16(0);
    const paramIds = op.ids(8);
    const responseIds = op.ids(16);
    this.log(`[schema] operation 0x${opId.toString(16)} (kind ${op.u8(2)}): parameters ${paramIds.map((x) => `0x${x.toString(16)}`).join(", ")}; responses ${responseIds.map((x) => `0x${x.toString(16)}`).join(", ")}`);
    const params: ResourceSchema["params"] = [];
    for (let i = 0; i < Math.min(paramIds.length || 4, 6); i++) {
      const pm = await ask(0x07, `operation 0x${opId.toString(16)} parameter ${i}`, u16(opId), u8(i));
      if (!pm) break;
      const p = record(pm, 2);
      const nameId = p.u16(2);
      const nm = await ask(0x0c, `name 0x${nameId.toString(16)}`, u16(nameId));
      const pname = nm ? (printableStrings(nm.raw.subarray(14, -4), 1).at(-1) ?? "") : "";
      const type = p.u16(6);
      params.push({ id: p.u16(0), name: pname, required: p.u8(4) === 1, type });
      if (type >= 15) await ask(0x0b, `data type ${type}`, u16(type));
    }
    this.log(`[schema] ${name} GET takes: ${params.map((p) => `${p.name || "?"}:${TYPE_NAMES[p.type] ?? `type ${p.type}`}${p.required ? "" : "?"}`).join(", ") || "nothing readable"}`);
    return { opId, params };
  }

  /** One ResourceMetadata record (GET f00003): name, links and operation count; read-only. */
  private async resourceInfo(id: number): Promise<ResourceNode | null> {
    const rid = this.allocId();
    const r = await this.request(buildFrame(MT.GET, rid, concat(Uint8Array.of(0xf0, 0x00, 0x03), FS_CLIENT, Uint8Array.of(1, 0x05, 0x00, id & 0xff, id >> 8))), rid).catch((e) => {
      if (this.closed) throw e;
      return null;
    });
    if (r?.status !== STATUS.OK) return null;
    const body = r.raw.subarray(14, -4);
    const at = 6; // u16 type, u8 size, u8 flags, 2 bytes padding to the 4-aligned record
    const u16 = (o: number) => (at + o + 2 <= body.length ? readLe16(body, at + o) : 0xffff);
    const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
    let name = "";
    for (let i = at + u32(4); i < body.length && body[i]; i++) name += String.fromCharCode(body[i]!);
    // Links as the Run 2 fills them: [?, parent, next sibling, first child]; 0xffff = none.
    return { id, name, parent: u16(22), next: u16(24), child: u16(26), ops: u32(12) };
  }

  /** What each method of a resource takes (OperationMetadata per method, then its parameters). */
  private async describeMethods(id: number): Promise<string> {
    const out: string[] = [];
    for (let m = 0; m < 6; m++) {
      const rid = this.allocId();
      const r = await this.request(buildFrame(MT.GET, rid, concat(Uint8Array.of(0xf0, 0x00, 0x04), FS_CLIENT, Uint8Array.of(2, 0x05, 0x00, id & 0xff, id >> 8, 0x03, 0x00, m))), rid).catch(() => null);
      if (r?.status !== STATUS.OK) continue;
      const body = r.raw.subarray(14, -4);
      const at = 6;
      const u16 = (o: number) => (at + o + 2 <= body.length ? readLe16(body, at + o) : 0);
      const opId = u16(0);
      const n = Math.min(6, u16(8));
      const params: string[] = [];
      for (let i = 0; i < n; i++) {
        const pid = this.allocId();
        const pm = await this.request(buildFrame(MT.GET, pid, concat(Uint8Array.of(0xf0, 0x00, 0x07), FS_CLIENT, Uint8Array.of(2, 0x05, 0x00, opId & 0xff, opId >> 8, 0x03, 0x00, i))), pid).catch(() => null);
        if (pm?.status !== STATUS.OK) break;
        const pb = pm.raw.subarray(14, -4);
        const p2 = (o: number) => (4 + o + 2 <= pb.length ? readLe16(pb, 4 + o) : 0);
        const nameId = p2(2);
        const nid = this.allocId();
        const nm = await this.request(buildFrame(MT.GET, nid, concat(Uint8Array.of(0xf0, 0x00, 0x0c), FS_CLIENT, Uint8Array.of(1, 0x05, 0x00, nameId & 0xff, nameId >> 8))), nid).catch(() => null);
        const pname = nm?.status === STATUS.OK ? (printableStrings(nm.raw.subarray(14, -4), 1).at(-1) ?? "?") : "?";
        const type = p2(6);
        let custom = "";
        if (!TYPE_NAMES[type]) {
          // A watch-defined type (an enum or a struct): its DataTypeMetadata names the values.
          const tid = this.allocId();
          const tm = await this.request(buildFrame(MT.GET, tid, concat(Uint8Array.of(0xf0, 0x00, 0x0b), FS_CLIENT, Uint8Array.of(1, 0x05, 0x00, type & 0xff, type >> 8))), tid).catch(() => null);
          const tb = tm?.status === STATUS.OK ? tm.raw.subarray(14, -4) : null;
          custom = tb ? `{${hex(tb.subarray(0, 64))}${printableStrings(tb, 2).length ? ` ${printableStrings(tb, 2).join("|")}` : ""}}` : `{${tm?.status ?? "no reply"}}`;
        }
        params.push(`${pname}:${TYPE_NAMES[type] ?? type}${custom}${pb[4 + 4] === 1 ? "" : "?"}`);
      }
      out.push(`m${m}(${params.join(", ")})`);
    }
    return out.join(" ") || "no readable methods";
  }

  /**
   * Walk the watch's whole resource tree (first child, then next siblings), read-only, and log
   * every path; resources under /Dev/FileSystem also get their methods. Once per app run.
   */
  async mapTree(opts: { from?: string; force?: boolean } = {}): Promise<void> {
    if (!opts.force && !this.mapOnFailure) return;
    if (!opts.force && WatchSession.mapped) return;
    WatchSession.mapped = true;
    // Resources another client (the Suunto app) used in this session: marked, and described.
    const used = new Set([...this.foreignHandles].filter((h) => h.length === 6).map((h) => parseInt(h.slice(2), 16)));
    const nodes = new Map<number, ResourceNode>();
    const get = async (id: number) => {
      if (nodes.has(id)) return nodes.get(id)!;
      const n = await this.resourceInfo(id);
      if (n) nodes.set(id, n);
      return n;
    };
    const path = (n: ResourceNode): string => {
      const parts: string[] = [];
      for (let c: ResourceNode | undefined = n, guard = 0; c && c.id !== 0 && guard < 12; c = nodes.get(c.parent), guard++) parts.unshift(c.name);
      return "/" + parts.join("/");
    };
    // Top level: a resource 0 with children if the watch has one; otherwise climb from
    // DirectoryList and walk the top-level siblings from there.
    const root = await get(0);
    let first = root && root.child !== 0xffff ? root.child : -1;
    if (first < 0) {
      let n = await get((this.dirTriple![1]! << 8) | this.dirTriple![2]!);
      while (n && n.parent !== 0 && n.parent !== 0xffff) n = await get(n.parent);
      first = n?.id ?? -1;
    }
    this.log(`[tree] mapping the watch's resources from 0x${first.toString(16)}${root ? ` (root "${root.name}")` : ""}…`);
    const lines: string[] = [];
    const walk = async (start: number, depth: number) => {
      for (let id = start, guard = 0; id !== 0xffff && id !== 0 && guard < 200 && nodes.size < 1500; guard++) {
        const n = await get(id);
        if (!n) {
          lines.push(`${"  ".repeat(depth)}0x${id.toString(16)} unreadable`);
          return;
        }
        // Top-level branches before `from` (alphabetical, as the watch orders them) were mapped
        // already: skip them without descending.
        const skip = depth === 0 && opts.from !== undefined && n.name.localeCompare(opts.from, "en", { sensitivity: "base" }) < 0;
        if (!skip) {
          const fs = /^\/Dev\/FileSystem\//.test(path(n));
          const mark = used.has(n.id);
          lines.push(`${"  ".repeat(depth)}${n.name} ${n.id.toString(16)}${n.ops ? ` ops ${n.ops}` : ""}${mark ? " ← Suunto app" : ""}${(fs || mark) && n.ops ? ` ${await this.describeMethods(n.id)}` : ""}`);
          if (n.child !== 0xffff && n.child !== 0 && depth < 10) await walk(n.child, depth + 1);
        }
        id = n.next;
      }
    };
    if (first >= 0) await walk(first, 0);
    // In batches, so one log line doesn't get too long to read.
    for (let i = 0; i < lines.length; i += 40) this.log(`[tree]\n${lines.slice(i, i + 40).join("\n")}`);
    this.log(`[tree] ${nodes.size} resources mapped`);
  }

  // ------------------------------------------------------------ logbook (Run 2)

  /**
   * The workouts the watch hasn't handed over yet, as the Suunto app lists them:
   * GET /Logbook/Entries (client 01 80 00) → {elements: [{Id u32, ModificationTimestamp u32,
   * Size u64?}]}, paged with StartAfterId while the watch answers 100.
   */
  async logbookEntries(): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    let after: number | null = null;
    for (let page = 0; page < 20; page++) {
      const params = after === null ? [] : [Uint8Array.of(0x07, 0x00, after & 0xff, (after >> 8) & 0xff, (after >> 16) & 0xff, after >>> 24)];
      const r = await this.call("/Logbook/Entries", params);
      if (r?.status !== STATUS.OK && r?.status !== STATUS.CONTINUE) {
        this.log(`[logbook] Entries → ${r?.status ?? "no reply"}`);
        break;
      }
      const rec = structValue(r.raw);
      if (!rec || rec.length < 8) break;
      const count = readLe16(rec, 0);
      const off = readLe16(rec, 4) | (readLe16(rec, 6) << 16);
      const size = count ? Math.max(8, Math.floor((rec.length - off) / count)) : 24;
      const u32 = (o: number) => (o + 4 <= rec.length ? (readLe16(rec, o) | (readLe16(rec, o + 2) << 16)) >>> 0 : 0);
      for (let i = 0; i < count; i++) {
        const e = off + i * size;
        if (e + 8 > rec.length) break;
        out.push({ id: u32(e), modified: u32(e + 4), size: size >= 24 && rec[e + 8] ? u32(e + 16) : undefined });
      }
      this.log(`[logbook] Entries page ${page}: ${count} (${out.map((x) => x.id).join(", ")})`);
      if (r.status !== STATUS.CONTINUE || !count) break;
      after = out.at(-1)!.id;
    }
    return out;
  }

  /**
   * One part of a logbook entry: Summary by GET with an INT32 offset (chunks of status 100 until
   * 200), Data the same way or, when the watch only streams it, by SUBSCRIBE: notifications of
   * {offset u32, bytes[]} until an empty one.
   */
  async logbookPart(id: number, part: "Summary" | "Data" | "Descriptors"): Promise<Uint8Array> {
    const path = `/Logbook/byId/${id}/${part}`;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < 4000; i++) {
      const o = total;
      const r = await this.call(path, [Uint8Array.of(0x06, 0x00, o & 0xff, (o >> 8) & 0xff, (o >> 16) & 0xff, o >>> 24)]);
      if (r?.status !== STATUS.OK && r?.status !== STATUS.CONTINUE) {
        if (i === 0 && part === "Data") return this.logbookStream(path);
        throw new WatchError(`${path}: watch answered ${r?.status ?? "nothing"} at ${total} bytes`, typeof r?.status === "number" ? r.status : undefined);
      }
      const c = parseFileChunk(r.raw);
      chunks.push(c.data);
      total += c.data.length;
      if (r.status === STATUS.OK || !c.data.length) break;
    }
    return joinBytes(chunks, total);
  }

  private async logbookStream(path: string): Promise<Uint8Array> {
    const sub = await this.call(path, [], DEV_CLIENT, MT.SUBSCRIBE);
    if (sub?.status !== STATUS.OK) throw new WatchError(`${path}: subscribe answered ${sub?.status ?? "nothing"}`);
    const key = `${hex(DEV_CLIENT)} ${path}`;
    const h = this.handles.get(key)!;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (let i = 0; i < 4000; i++) {
        // Notifications carry the resource with its own first byte (f0 where the subscription
        // resolved to 00 on the Run 2): match the resource id only.
        const n = await this.waitFor(() => takeWhere(this.inbox, (x) => x.type === MT.NOTIFICATION && x.raw[7] === h[1] && x.raw[8] === h[2]), `${path} data`, 8000).catch(() => null);
        if (!n) break;
        // Notification: triple, client, then the value: u16 type, u16 header, record aligned to 4.
        const hdr = readLe16(n.raw, 14);
        const he = 16;
        const start = he + ((4 - (he % 4)) % 4);
        const end = Math.min(n.raw.length - 4, he + (hdr & 0x1ff));
        const rec = n.raw.subarray(start, end);
        if (rec.length < 12) break;
        const count = readLe16(rec, 4);
        const off = readLe16(rec, 8) | (readLe16(rec, 10) << 16);
        if (!count) break;
        const bytes = rec.slice(off, off + count);
        chunks.push(bytes);
        total += bytes.length;
      }
    } finally {
      await this.call(path, [], DEV_CLIENT, MT.UNSUBSCRIBE).catch(() => null);
    }
    return joinBytes(chunks, total);
  }

  /**
   * Save every listed workout not saved yet: logbook/<id>/{entry.json, summary.sbem, data.sbem}.
   * Read-only: the entry's Flags are never set, so the Suunto app still syncs it as usual.
   */
  async logbookBackup(sink: { has(path: string): Promise<boolean>; put(path: string, data: Uint8Array): Promise<void> }, onEntry?: (id: number, bytes: number) => void): Promise<{ downloaded: number; skipped: number; failed: number; bytes: number }> {
    const res = { downloaded: 0, skipped: 0, failed: 0, bytes: 0 };
    for (const e of await this.logbookEntries()) {
      const dir = `logbook/${e.id}`;
      if (await sink.has(`${dir}/summary.sbem`)) {
        res.skipped++;
        continue;
      }
      try {
        const summary = await this.logbookPart(e.id, "Summary");
        const data = await this.logbookPart(e.id, "Data");
        await sink.put(`${dir}/data.sbem`, data);
        // The SBEM descriptors name each chunk's fields: what full decoding needs. Optional.
        const desc = await this.logbookPart(e.id, "Descriptors").catch((err) => {
          this.log(`[logbook] ${e.id} descriptors: ${(err as Error).message}`);
          return null;
        });
        if (desc?.length) {
          await sink.put(`${dir}/descriptors.sbem`, desc);
          this.log(`[logbook] ${e.id} descriptors: ${desc.length} B ${JSON.stringify(printableStrings(desc, 4).join(" | ").slice(0, 300))}`);
        }
        await sink.put(`${dir}/entry.json`, new TextEncoder().encode(JSON.stringify({ ...e, modifiedIso: new Date(e.modified * 1000).toISOString(), summaryBytes: summary.length, dataBytes: data.length })));
        await sink.put(`${dir}/summary.sbem`, summary);
        res.downloaded++;
        res.bytes += summary.length + data.length;
        this.log(`[logbook] ${e.id}: summary ${summary.length} B, data ${data.length} B${e.size ? ` (watch said ${e.size})` : ""}`);
        onEntry?.(e.id, summary.length + data.length);
      } catch (err) {
        if (this.closed) throw err;
        res.failed++;
        this.log(`[logbook] ${e.id} failed: ${(err as Error).message}`);
      }
    }
    return res;
  }

  // ------------------------------------------------------------ activity log (Run 2)

  /** A GET (or PUT) on a path, resolved with `client` first; the reply, or null without one. */
  private async call(path: string, params: Uint8Array[] = [], client: Uint8Array = DEV_CLIENT, mt: number = MT.GET): Promise<Reply | null> {
    const key = `${hex(client)} ${path}`;
    let h = this.handles.get(key);
    if (h === undefined) {
      h = (await this.resolve(path, client)).handle;
      this.handles.set(key, h);
    }
    if (!h) return null;
    const id = this.allocId();
    this.lock();
    try {
      this.drainStale();
      await this.send(buildFrame(mt, id, concat(h, client, Uint8Array.of(params.length), ...params)));
      return await this.waitFor(() => takeWhere(this.inbox, (r) => r.requestId === id && r.type !== MT.RESOLVE_REPLY), `${path}`).catch((e) => {
        if (this.closed) throw e;
        return null;
      });
    } finally {
      this.unlock();
      await sleep(this.frameGapMs);
    }
  }

  /**
   * A watch-defined type (DataTypeMetadata, GET f0000b), decoded with the struct layout zappctl
   * recovered: id, kind (0 scalar, 1 named, 2 array, 3 struct, 4 enum), then optional
   * scalarType, scalarUnit, nameId, baseTypeId, properties[] and items[] ({nameId, value}).
   */
  async describeType(type: number): Promise<WatchType | null> {
    const id = this.allocId();
    const r = await this.request(buildFrame(MT.GET, id, concat(Uint8Array.of(0xf0, 0x00, 0x0b), FS_CLIENT, Uint8Array.of(1, 0x05, 0x00, type & 0xff, type >> 8))), id).catch(() => null);
    const blob = r?.status === STATUS.OK ? structValue(r.raw) : null;
    if (!blob || blob.length < 18) return null;
    const u16 = (o: number) => (o + 2 <= blob.length ? readLe16(blob, o) : 0);
    const opt = (flagAt: number, at: number, size: 1 | 2) => (blob[flagAt] ? (size === 1 ? blob[at]! : u16(at)) : undefined);
    const t: WatchType = { id: u16(0), kind: blob[2]!, scalarType: opt(3, 4, 1), nameId: opt(10, 12, 2), baseTypeId: opt(14, 16, 2), items: [] };
    if (blob[32] && blob.length >= 44) {
      const n = Math.min(64, u16(36));
      const off = u16(40) | (u16(42) << 16);
      for (let i = 0; i < n && off + i * 4 + 4 <= blob.length; i++) {
        const v = u16(off + i * 4 + 2);
        t.items.push({ nameId: u16(off + i * 4), value: v >= 0x8000 ? v - 0x10000 : v, name: "" });
      }
    }
    t.name = t.nameId !== undefined ? await this.metaString(t.nameId) : undefined;
    for (const it of t.items) it.name = await this.metaString(it.nameId);
    return t;
  }

  /** DataTypeMetadata for a type with its field and value names (read-only). */
  async typeMeta(type: number): Promise<TypeMeta | null> {
    const id = this.allocId();
    const r = await this.request(buildFrame(MT.GET, id, concat(Uint8Array.of(0xf0, 0x00, 0x0b), FS_CLIENT, Uint8Array.of(1, 0x05, 0x00, type & 0xff, type >> 8))), id).catch((e) => {
      if (this.closed) throw e;
      return null;
    });
    const blob = r?.status === STATUS.OK ? structValue(r.raw) : null;
    const t = blob ? parseTypeMeta(blob) : null;
    if (!t) return null;
    for (const f of t.fields) f.name = await this.metaString(f.nameId);
    for (const i of t.items) i.name = await this.metaString(i.nameId);
    return t;
  }

  /**
   * Put a route on the watch (route-send.ts): checks the watch's own descriptions first and
   * writes only /Settings/Navigation/Route/Data and /Settings/Navigation/Route.
   */
  async sendRoute(route: { name: string; points: WatchRoutePoint[]; distance_m: number }, onProgress?: (p: SendProgress) => void): Promise<{ id: number; bytes: number }> {
    const WRITABLE = new Set(["/Settings/Navigation/Route/Data", "/Settings/Navigation/Route"]);
    return sendRouteToWatch(
      {
        rpc: async (path, params, method) => {
          if (method === "PUT" && !WRITABLE.has(path)) throw new WatchError(`refusing to write ${path}`);
          return this.call(path, params, DEV_CLIENT, method === "PUT" ? MT.PUT : MT.GET);
        },
        typeMeta: (id) => this.typeMeta(id),
        log: this.log,
      },
      route,
      onProgress,
    );
  }

  /**
   * Install a watch face (face-send.ts): writes only /WatchFace/Info, /WatchFace/Install and the
   * file the watch names under /emmc/dial/download/.
   */
  async installFace(pkg: FacePackage, onProgress?: (p: FaceProgress) => void): Promise<{ id: string; bytes: number }> {
    let target: string | null = null;
    return installFaceOnWatch(
      {
        rpc: async (path, params, method, client) => {
          if (method === "PUT") {
            const ok = path === "/WatchFace/Info" || path === "/WatchFace/Install" || path === "/Dev/FileSystem/Stream";
            if (!ok) throw new WatchError(`refusing to write ${path}`);
            if (path === "/Dev/FileSystem/Stream") {
              // The first piece names the file; it must stay the one under /emmc/dial/download/.
              const named = params[0] && params[0][0] === 12 ? new TextDecoder().decode(params[0].subarray(2)).replace(/\0.*$/s, "") : null;
              if (named !== null) target = named;
              if (!target || !/^\/emmc\/dial\/download\/[\w.-]+\.zip$/.test(target)) throw new WatchError("refusing to write outside the watch-face folder");
            }
          }
          return this.call(path, params, client === "files" ? FS_CLIENT : DEV_CLIENT, method === "PUT" ? MT.PUT : MT.GET);
        },
        typeMeta: (id) => this.typeMeta(id),
        log: this.log,
      },
      pkg,
      onProgress,
    );
  }

  /**
   * Sleep since a time, as the Suunto app asks for it (capture of 18 Oct 2026): GET
   * /Daily/Sleep/Timeline/Data with the time (i64 ms) and the file name "mdsSlp.sbm". It
   * answered 204 (nothing new) in the capture, so what a full answer looks like is still to be
   * seen: the reply comes back as it is, for the backup. Reads only.
   */
  async readSleep(sinceMs: number): Promise<{ status: number; data: Uint8Array } | null> {
    const t = new Uint8Array(10);
    const v = new DataView(t.buffer);
    v.setUint16(0, 8, true);
    v.setBigUint64(2, BigInt(Math.floor(sinceMs)), true);
    const name = concat(Uint8Array.of(12, 0), new TextEncoder().encode("mdsSlp.sbm\0"));
    const r = await this.call("/Daily/Sleep/Timeline/Data", [t, name], DEV_CLIENT, MT.GET).catch(() => null);
    return r ? { status: r.status ?? 0, data: r.raw } : null;
  }

  private trendTypesLogged = false;

  /**
   * The watch's 10-minute trend log (trends.ts): heart rate, blood oxygen, steps and energy for
   * about the last day. Reads only. The first read in a session also logs how the watch
   * describes the page's type, to name the fields Tartan doesn't know yet.
   */
  async readTrends(sinceMs: number): Promise<TrendRecord[]> {
    if (!this.trendTypesLogged) {
      this.trendTypesLogged = true;
      const seen = new Set<number>();
      const describe = async (type: number, depth: number): Promise<void> => {
        if (depth > 8 || seen.has(type) || type < 0x100) return;
        seen.add(type);
        const t = await this.typeMeta(type).catch(() => null);
        if (!t) return this.log(`[trends] type 0x${type.toString(16)}: not described`);
        this.log(`[trends] type 0x${type.toString(16)} kind ${t.kind}${t.baseTypeId !== undefined ? ` of 0x${t.baseTypeId.toString(16)}` : ""}: ${t.fields.map((f) => `${f.name ?? f.nameId}:0x${f.type.toString(16)}${f.required ? "" : "?"}`).join(", ")}`);
        for (const f of t.fields) await describe(f.type, depth + 1);
        if (t.baseTypeId !== undefined) await describe(t.baseTypeId, depth + 1);
      };
      await describe(TREND_TYPE, 0).catch(() => {});
    }
    const { records } = await readTrendLog({ rpc: (path, params) => this.call(path, params, DEV_CLIENT, MT.GET), log: this.log }, sinceMs);
    return records;
  }

  /** The ids of the workouts (SuuntoPlus guides) on the watch (reads only). */
  async workoutIds(): Promise<string[]> {
    return workoutIds({ rpc: async (path, params) => this.call(path, params, DEV_CLIENT, MT.GET), log: this.log });
  }

  /**
   * Put a workout on the watch (workout-send.ts). Writes only the folders on the way to the
   * workouts folder, the one file <folder>/<id>.zip for a Tartan id, and /Plugin/Install.
   */
  async installWorkout(id: string, zip: Uint8Array, onProgress?: (p: WorkoutProgress) => void): Promise<void> {
    if (!TARTAN_WORKOUT_ID.test(id)) throw new WatchError("refusing a workout id Tartan didn't make");
    const file = `${WORKOUT_DIR}/${id}.zip`;
    let target: string | null = null;
    const named = (p: Uint8Array | undefined) => (p && p[0] === 12 ? new TextDecoder().decode(p.subarray(2)).replace(/\0.*$/s, "") : null);
    return installWorkoutOnWatch(
      {
        rpc: async (path, params, method, client) => {
          if (method === "PUT") {
            if (path === "/Dev/FileSystem/DirectoryCreate") {
              if (!WORKOUT_DIRS.includes(named(params[0]) ?? "")) throw new WatchError("refusing to make that folder");
            } else if (path === "/Dev/FileSystem/Stream") {
              target = named(params[0]) ?? target;
              if (target !== file) throw new WatchError("refusing to write outside the workout file");
            } else if (path !== "/Plugin/Install") throw new WatchError(`refusing to write ${path}`);
          }
          return this.call(path, params, client === "files" ? FS_CLIENT : DEV_CLIENT, method === "PUT" ? MT.PUT : MT.GET);
        },
        log: this.log,
      },
      id,
      zip,
      onProgress,
    );
  }

  /** Take a Tartan workout off the watch: writes only /Plugin/Uninstall, only for a Tartan id. */
  async removeWorkout(id: string): Promise<void> {
    if (!TARTAN_WORKOUT_ID.test(id)) throw new WatchError("refusing to remove a workout Tartan didn't make");
    return removeWorkoutFromWatch(
      {
        rpc: async (path, params, method) => {
          if (method === "PUT" && (path !== "/Plugin/Uninstall" || !new TextDecoder().decode(params[0]).includes(`${id}\0`))) throw new WatchError(`refusing to write ${path}`);
          return this.call(path, params, DEV_CLIENT, method === "PUT" ? MT.PUT : MT.GET);
        },
        log: this.log,
      },
      id,
    );
  }

  /** The ids of the faces on the watch (reads only). */
  async faceIds(): Promise<string[]> {
    const ids = await faceIds({ rpc: async (path, params) => this.call(path, params, DEV_CLIENT, MT.GET), log: this.log });
    if (!ids) throw new WatchError("the watch didn't list its faces");
    return ids;
  }

  /**
   * Remove a face Tartan installed (face-send.ts): writes only /WatchFace/Delete/MultiId, and
   * only for a Tartan face id.
   */
  async removeFace(id: string): Promise<{ removed: boolean }> {
    if (!isTartanFaceId(id)) throw new WatchError("refusing to remove a face Tartan didn't make");
    return removeFaceFromWatch(
      {
        rpc: async (path, params, method) => {
          if (method === "PUT" && path !== "/WatchFace/Delete/MultiId") throw new WatchError(`refusing to write ${path}`);
          if (method === "PUT" && !new TextDecoder().decode(params[0]).includes(`${id}\0`)) throw new WatchError("refusing to remove another face");
          return this.call(path, params, DEV_CLIENT, method === "PUT" ? MT.PUT : MT.GET);
        },
        typeMeta: (t) => this.typeMeta(t),
        log: this.log,
      },
      id,
    );
  }

  private async metaString(nameId: number): Promise<string> {
    const id = this.allocId();
    const r = await this.request(buildFrame(MT.GET, id, concat(Uint8Array.of(0xf0, 0x00, 0x0c), FS_CLIENT, Uint8Array.of(1, 0x05, 0x00, nameId & 0xff, nameId >> 8))), id).catch(() => null);
    return r?.status === STATUS.OK ? (printableStrings(r.raw.subarray(14, -4), 1).at(-1) ?? "") : "";
  }

  /** The options /Activity/Logs/SyncCommand takes (its `value` is a named enum). */
  async syncCommandOptions(): Promise<SyncOptions | null> {
    let t = await this.describeType(0x2404);
    const declared = t?.id ?? 0x2404;
    for (let hop = 0; t && t.kind === 1 && t.baseTypeId !== undefined && hop < 4; hop++) t = await this.describeType(t.baseTypeId);
    if (!t) return null;
    this.log(`[sync] SyncCommand is ${["scalar", "named", "array", "struct", "enum"][t.kind] ?? t.kind} 0x${t.id.toString(16)}${t.name ? ` "${t.name}"` : ""}, scalar ${t.scalarType ?? "?"}: ${t.items.map((i) => `${i.name || `#${i.nameId.toString(16)}`}=${i.value}`).join(", ") || "no values listed"}`);
    return { declared, enumId: t.id, scalarType: t.scalarType ?? 3, items: t.items };
  }

  /** Read-only: the activity log count, asked with each client identity; logs every answer. */
  async activityCount(): Promise<number | null> {
    for (const client of [DEV_CLIENT, FS_CLIENT]) {
      const r = await this.call("/Activity/Log/Count", [], client);
      this.log(`[sync] GET /Activity/Log/Count as ${hex(client)} → ${r?.status ?? "no reply"}${r ? ` ${hex(r.raw.subarray(14, -4))}` : ""}`);
      if (r?.status === STATUS.OK) return builtinValue(r.raw);
    }
    return null;
  }

  /**
   * Start the watch's activity-log sync (PUT /Activity/Logs/SyncCommand = start), wait for the
   * log to open, read each entry's MoveData (and the file it names, if any), then PUT `end`.
   * Every step is logged; `save` keeps what came back. Only called after the owner confirmed.
   */
  async activitySync(opts: SyncOptions, start: SyncItem | null, end: SyncItem | null, save: (name: string, data: Uint8Array) => Promise<void>): Promise<number> {
    const enumParam = (type: number, v: number) => {
      const st = opts.scalarType;
      const size = st <= 3 || st === 1 ? 1 : st <= 5 ? 2 : st <= 7 ? 4 : 8;
      const b = new Uint8Array(2 + size);
      b[0] = type & 0xff;
      b[1] = type >> 8;
      for (let i = 0; i < Math.min(size, 4); i++) b[2 + i] = (v >> (8 * i)) & 0xff;
      return b;
    };
    const command = async (item: SyncItem) => {
      // The declared parameter type first; the enum's own id and its scalar as fallbacks.
      // The plain scalar is what the Run 2 parses (the named and enum ids get no reply).
      for (const type of [opts.scalarType, opts.declared, opts.enumId]) {
        const r = await this.call("/Activity/Logs/SyncCommand", [enumParam(type, item.value)], DEV_CLIENT, MT.PUT);
        this.log(`[sync] PUT SyncCommand ${item.name}=${item.value} (as type 0x${type.toString(16)}) → type 0x${r?.type.toString(16) ?? "-"} ${r?.status ?? "no reply"}`);
        if (r?.status === STATUS.OK) return true;
        if (r && r.status !== STATUS.BAD_REQUEST) return false;
      }
      return false;
    };
    let count = await this.activityCount();
    let started = false;
    if (count === null && start) {
      started = await command(start);
      for (let i = 0; started && count === null && i < 30; i++) {
        await sleep(1000);
        const p = await this.call("/Activity/Logs/SyncProgress");
        if (i % 5 === 0) this.log(`[sync] SyncProgress → ${p?.status ?? "no reply"}${p ? ` ${hex(p.raw.subarray(14, -4))}` : ""}`);
        const r = await this.call("/Activity/Log/Count");
        if (r?.status === STATUS.OK) count = builtinValue(r.raw);
      }
    }
    this.log(`[sync] activity log entries: ${count ?? "unavailable"}`);
    let saved = 0;
    try {
      for (let i = 0; count !== null && i < Math.min(count, 500); i++) {
        const r = await this.call(`/Activity/Log/${i}/MoveData`);
        const body = r ? r.raw.subarray(14, -4) : new Uint8Array();
        const said = printableStrings(body, 3);
        this.log(`[sync] MoveData ${i} → ${r?.status ?? "no reply"}, ${body.length} bytes ${hex(body.subarray(0, 64))}${said.length ? ` ${JSON.stringify(said.join(" | ").slice(0, 200))}` : ""}`);
        if (r?.status !== STATUS.OK) continue;
        await save(`activity-log/${i}/movedata.bin`, body.slice());
        saved++;
        // If the entry names a file, read it with Stream.
        const file = said.find((x) => /[/:].*\.[a-z0-9]{2,5}$/i.test(x) || /\.(sml|json|fit|bin|dat|log)$/i.test(x));
        if (file) {
          try {
            this.generation ??= /^[a-z]:/i.test(file) ? "ng3" : "ng1";
            const data = await this.readFile(file);
            await save(`activity-log/${i}/${file.replace(/^.*[\\/:]/, "")}`, data);
            this.log(`[sync]   read ${file}: ${data.length} bytes`);
          } catch (e) {
            this.log(`[sync]   read ${file} failed: ${(e as Error).message}`);
          }
        }
      }
    } finally {
      if (started && end) await command(end).catch(() => false);
    }
    return saved;
  }

  /** Resolve a path to its handle (RESOLVE); null when the watch has no such resource. */
  private async resolve(path: string, client: Uint8Array = FS_CLIENT): Promise<{ handle: Uint8Array | null; status: number | string }> {
    const id = this.allocId();
    this.lock();
    try {
      this.drainStale();
      await this.send(resolveFrame(path, id, client));
      const r = await this.waitFor(() => takeWhere(this.inbox, (x) => x.requestId === id && (x.type === MT.RESOLVE_REPLY || x.type === MT.ERROR)), `resolve ${path}`).catch((e) => {
        if (this.closed) throw e;
        return null;
      });
      return { handle: r?.status === STATUS.OK && r.resource ? r.resource : null, status: r?.status ?? "no reply" };
    } finally {
      this.unlock();
      await sleep(this.frameGapMs);
    }
  }

  /**
   * The Run 2 keeps workouts in a Movesense-style Logbook (/Logbook/Entries, /Logbook/byId/
   * {LogId}/Data) and /Activity/Log. Once per app run after a failed listing: describe those
   * resources' methods, then GET the plainly read-only ones and log what comes back. Nothing
   * named like a command (SyncCommand, SyncToDb, Remove, removeAll) is touched.
   */
  private async inspectWatch(): Promise<void> {
    if (WatchSession.inspected) return;
    WatchSession.inspected = true;
    // What SyncCommand takes, by name, and whether the activity log answers when asked with
    // the device client identity (read-only).
    await this.syncCommandOptions();
    await this.activityCount();
    const reads: Array<[string, Uint8Array[]]> = [["/Activity/Logs/SyncProgress", []], ["/Activity/Logs/SyncState", []]];
    const handles = new Map<string, Uint8Array | null>();
    for (const [path, params] of reads) {
      if (!handles.has(path)) {
        const r = await this.resolve(path);
        handles.set(path, r.handle);
        if (!r.handle) this.log(`[inspect] resolve ${path} → ${r.status}`);
      }
      const h = handles.get(path);
      if (!h) continue;
      const id = this.allocId();
      const r = await this.request(buildFrame(MT.GET, id, concat(h, FS_CLIENT, Uint8Array.of(params.length), ...params)), id).catch((e) => {
        if (this.closed) throw e;
        return null;
      });
      const what = `${path}(${params.map((p) => `${TYPE_NAMES[p[0]!] ?? p[0]} ${p[2]}`).join(", ")})`;
      if (!r) {
        this.log(`[inspect] ${what} → no reply`);
        continue;
      }
      const body = r.raw.subarray(14, -4);
      const said = printableStrings(body);
      this.log(`[inspect] ${what} @${hex(h)} → ${r.status}, ${body.length} bytes: ${hex(body.subarray(0, 160))}${body.length > 160 ? "…" : ""}${said.length ? ` ${JSON.stringify(said.join(" | ").slice(0, 300))}` : ""}`);
    }
  }

  private async listSpelled(spelled: string, form: ListForm = this.listForm, triple: Uint8Array = this.dirTriple!, types: number[] | null = this.listTypes): Promise<DirListing> {
    const merged: DirListing = { files: [], dirs: [] };
    // Page index is the second parameter of the listing GET. The official app always sends 0;
    // if a watch ever answers 100 (more), ask for the following page.
    for (let page = this.firstPage; page < this.firstPage + 64; page++) {
      const id = this.allocId();
      const reply = await this.request(types ? typedListFrame(spelled, id, triple, types, page) : dirListFrame(spelled, id, triple, page, form), id);
      if (reply.status !== STATUS.OK && reply.status !== STATUS.CONTINUE) {
        const said = printableStrings(reply.raw.subarray(14, -4));
        throw new WatchError(`list ${spelled}: watch answered ${reply.status}${said.length ? ` (${said.join(" ")})` : ""} [${hex(reply.raw.subarray(0, 32))}]`, reply.status);
      }
      const listing = parseDirListing(reply.raw);
      if (!listing) {
        // Keep what the watch actually sent: it shows how a new model's listing differs.
        const body = reply.raw.subarray(14, Math.min(reply.raw.length - 4, 14 + 96));
        this.log(`[session] ${spelled}: unreadable listing, status ${reply.status}, ${reply.raw.length} bytes: ${JSON.stringify(new TextDecoder("latin1").decode(body))}`);
        throw new WatchError(`list ${spelled}: reply carried no directory listing`);
      }
      merged.files.push(...listing.files);
      merged.dirs.push(...listing.dirs);
      if (reply.status !== STATUS.CONTINUE) break;
    }
    return merged;
  }

  private async ensureDirList(): Promise<void> {
    if (this.dirTriple) return;
    const replies = await this.replay(DIRLIST_SETUP);
    this.dirTriple = resolvedTriple(replies, DIRLIST_TRIPLE, this.log);
    const r = replies.find((x) => x.type === MT.RESOLVE_REPLY && x.requestId === 1);
    this.dirResolve = `DirectoryList resolve ${r?.status ?? "missing"} → ${hex(this.dirTriple)}`;
    this.log(`[session] ${this.dirResolve}`);
    // The metadata replies describe the resource (its parameters); keep their readable text.
    const text = [...new Set(replies.flatMap((x) => printableStrings(x.raw.subarray(9, -4))))];
    if (text.length) this.log(`[session] DirectoryList metadata: ${text.join(" | ").slice(0, 600)}`);
    // Replies to another client (ids the setup never used) show which resources it is busy with.
    for (const x of replies) if (x.requestId > 0x100 && !this.ours.has(x.requestId)) this.foreignHandles.add(hex(x.raw.subarray(6, 9)));
  }

  private async ensureStream(): Promise<void> {
    if (this.streamTriple) return;
    const replies = await this.replay(STREAM_SETUP);
    this.streamTriple = resolvedTriple(replies, STREAM_TRIPLE, this.log);
  }

  // ------------------------------------------------------------ transport

  private allocId(): number {
    const id = this.nextId;
    this.ours.add(id);
    this.nextId = this.nextId >= 0xfff0 ? 0x20 : this.nextId + 1;
    return id;
  }

  /** Send captured frames one by one, waiting for one reply each (ack-gated, as the app does). */
  private async replay(hexFrames: readonly string[]): Promise<Reply[]> {
    const replies: Reply[] = [];
    for (const [i, hex] of hexFrames.entries()) {
      const frame = hexToBytes(hex);
      const id = readLe16(frame, 4);
      this.lock();
      try {
        await this.send(frame);
        const reply = await this.waitFor(() => this.inbox.shift() ?? null, `setup frame ${i + 1}/${hexFrames.length}`);
        replies.push(reply);
        if (reply.requestId !== id) {
          // Late reply to an earlier frame: keep it and wait for this frame's own answer briefly.
          const own = await this.waitFor(() => takeWhere(this.inbox, (r) => r.requestId === id), "", 1500).catch(() => null);
          if (own) replies.push(own);
        }
      } finally {
        this.unlock();
      }
      await sleep(this.frameGapMs);
    }
    replies.push(...this.inbox.splice(0));
    return replies;
  }

  /** Send one request and wait for the GET reply with the same request ID. */
  private async request(frame: Uint8Array, id: number): Promise<Reply> {
    this.lock();
    try {
      this.drainStale();
      await this.send(frame);
      return await this.waitFor(
        () => takeWhere(this.inbox, (r) => r.requestId === id && (r.type === MT.GET_REPLY || r.type === MT.ERROR)),
        `request ${id}`,
      ).then((r) => {
        if (r.type === MT.ERROR) throw new WatchError(`watch reported a protocol error for request ${id}`, r.status);
        return r;
      });
    } finally {
      this.unlock();
      await sleep(this.frameGapMs);
    }
  }

  /** Straggler replies from setup frames and unsolicited notifications are harmless; drop them. */
  private drainStale(): void {
    for (const r of this.inbox.splice(0)) {
      if (r.type !== MT.NOTIFICATION && r.type !== MT.KEEPALIVE) {
        if (!this.ours.has(r.requestId) && r.requestId > 0x100) {
          this.foreign++;
          const h = hex(r.raw.subarray(6, 9));
          if (!this.foreignHandles.has(h)) {
            this.foreignHandles.add(h);
            const said = printableStrings(r.raw.subarray(14, -4));
            this.log(`[rx] another client is using ${h}: type 0x${r.type.toString(16)} status ${r.status ?? "-"}, ${r.raw.length} bytes${said.length ? ` ${JSON.stringify(said.join(" ").slice(0, 240))}` : ""}`);
            continue;
          }
        }
        else this.log(`[rx] ignoring late reply type=0x${r.type.toString(16)} id=${r.requestId}`);
      }
    }
  }

  private async send(frame: Uint8Array): Promise<void> {
    if (this.closedReason) throw new WatchError(`link closed: ${this.closedReason}`);
    const pkt = wrap(frame);
    const size = Math.max(20, this.link.chunkSize);
    for (let at = 0; at < pkt.length; at += size) {
      await this.link.write(pkt.subarray(at, at + size));
      if (at + size < pkt.length && this.chunkDelayMs) await sleep(this.chunkDelayMs);
    }
  }

  private async waitFor<T>(take: () => T | null, what: string, timeoutMs = this.timeoutMs): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const got = take();
      if (got !== null) return got;
      if (this.closedReason) throw new WatchError(`link closed while waiting for ${what}: ${this.closedReason}`);
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new WatchError(
          `no reply to ${what} within ${timeoutMs} ms — is the watch awake and the phone's Bluetooth off?`,
        );
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  private lock(): void {
    if (this.busy) throw new WatchError("one request at a time: wait for the previous call to finish");
    this.busy = true;
  }

  private unlock(): void {
    this.busy = false;
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function takeWhere<T>(arr: T[], pred: (x: T) => boolean): T | null {
  const i = arr.findIndex(pred);
  return i < 0 ? null : arr.splice(i, 1)[0]!;
}

/** Use the device-assigned triple from the setup's resolve reply; fall back to the known one. */
function resolvedTriple(replies: Reply[], _fallback: Uint8Array, log: (m: string) => void): Uint8Array {
  const r = replies.find((x) => x.type === MT.RESOLVE_REPLY && x.requestId === 1);
  if (r?.status === STATUS.OK && r.resource) return r.resource;
  // Never fall back to a handle from another model: on the Run 2, f02302 (DirectoryList on
  // the captured watches) is EmmcFormat. Only a handle the watch itself resolved is safe.
  log(`[session] resolve reply missing or status ${r?.status}; stopping rather than guessing a handle`);
  throw new WatchError(`the watch didn't resolve the file service (status ${r?.status ?? "none"})`, r?.status);
}

/** `logs/`, `/logs`, `b:/logs`, `b:logs` → `/logs`. */
export function normalize(path: string): string {
  let p = path.trim().replace(/^[a-z]:/i, "");
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

export function spell(canonical: string, gen: Generation): string {
  // "ng3-bare": the drive without a slash, as zappctl writes `b:syslogs` (root: `b:`).
  if (gen === "ng3-bare") return `b:${canonical.slice(1)}`;
  return `${PREFIX[gen]}${canonical}`;
}

export function joinPath(dir: string, name: string): string {
  return normalize(`${dir}/${name}`);
}
