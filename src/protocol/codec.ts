/**
 * Wire codec for the watch's "whiteboard" protocol over BLE.
 *
 * Frame (unescaped):  A5 | type | LE16 bodyLength | LE16 requestId | body | LE32 zlib-CRC32
 * On the air every frame is wrapped as 0x7E | escape(frame) | 0x7E, where 0x7E and 0x7D
 * are escaped as 0x7D followed by (byte ^ 0x20).
 *
 * Protocol knowledge: SyncFix (0BSD) and zappctl docs/PROTOCOL.md (0BSD).
 */

export const DELIM = 0x7e;
export const ESC = 0x7d;
export const MAGIC = 0xa5;

/** Message types (low 5 bits of byte 1). */
export const MT = {
  NOTIFICATION: 0x01,
  RESOLVE_REPLY: 0x02,
  RELEASE_REPLY: 0x03,
  GET_REPLY: 0x05,
  PUT_REPLY: 0x07,
  RESOLVE: 0x0a,
  RELEASE: 0x0b,
  GET: 0x0d,
  PUT: 0x0e,
  SUBSCRIBE: 0x10,
  UNSUBSCRIBE: 0x11,
  SUBSCRIBE_REPLY: 0x08,
  UNSUBSCRIBE_REPLY: 0x09,
  HELLO: 0x12,
  HELLO_ACK: 0x13,
  KEEPALIVE: 0x14,
  ERROR: 0x1a,
} as const;

/** HTTP-shaped status codes the watch answers with. */
export const STATUS = { CONTINUE: 100, OK: 200, BAD_REQUEST: 400, NOT_FOUND: 404 } as const;

/** Whiteboard scalar type IDs used for request parameters. */
export const TYPE = { UINT8: 3, INT32: 6, STRING: 12, LIST_OF_BYTES: 13 } as const;

/** Client triple used by the official app for filesystem requests. */
export const FS_CLIENT = Uint8Array.of(0x03, 0x80, 0x01);

// ---------------------------------------------------------------- CRC32 (zlib)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- byte helpers

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const le16 = (n: number) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
export const le32 = (n: number) =>
  Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
export const readLe16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
export const readLe24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
export const readLe32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

const ascii = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw new Error(`watch paths must be ASCII: ${JSON.stringify(s)}`);
    out[i] = c;
  }
  return out;
};

// ---------------------------------------------------------------- framing

/** Build a complete unescaped frame (header + body + CRC). */
export function buildFrame(type: number, requestId: number, body: Uint8Array): Uint8Array {
  if (body.length > 0x3ff) throw new Error(`frame body too long (${body.length} > 1023)`);
  const head = concat(Uint8Array.of(MAGIC, type), le16(body.length), le16(requestId & 0xffff), body);
  return concat(head, le32(crc32(head)));
}

/** Escape a frame and add the 0x7E delimiters. */
export function wrap(frame: Uint8Array): Uint8Array {
  const out: number[] = [DELIM];
  for (const b of frame) {
    if (b === DELIM || b === ESC) out.push(ESC, b ^ 0x20);
    else out.push(b);
  }
  out.push(DELIM);
  return Uint8Array.from(out);
}

export function unescape(body: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const b = body[i]!;
    if (b === ESC && i + 1 < body.length) out.push(body[++i]! ^ 0x20);
    else out.push(b);
  }
  return Uint8Array.from(out);
}

export function crcOk(frame: Uint8Array): boolean {
  return frame.length >= 10 && crc32(frame.subarray(0, -4)) === readLe32(frame, frame.length - 4);
}

/**
 * Reassembles notification chunks into frames. GATT notifications can split a frame
 * anywhere and can share delimiters between frames; this handles both.
 */
export class Deframer {
  private buf: number[] = [];
  private inFrame = false;

  constructor(private readonly onFrame: (frame: Uint8Array) => void, private readonly maxLen = 8192) {}

  push(chunk: Uint8Array): void {
    for (const b of chunk) {
      if (b === DELIM) {
        if (this.buf.length) this.onFrame(unescape(Uint8Array.from(this.buf)));
        this.buf = [];
        this.inFrame = true;
      } else if (this.inFrame) {
        this.buf.push(b);
        if (this.buf.length > this.maxLen) {
          this.buf = [];
          this.inFrame = false;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- replies

export interface Reply {
  type: number;
  requestId: number;
  /** Resource triple (replies with a status only). */
  resource?: Uint8Array;
  status?: number;
  raw: Uint8Array;
}

/** Message types whose body starts with resource[3] | client[3] | LE16 status. */
const STATUS_TYPES = new Set([0x02, 0x03, 0x05, 0x07, 0x08, 0x09, 0x18, 0x19, MT.ERROR]);

export function parseReply(frame: Uint8Array): Reply {
  if (frame.length < 10 || frame[0] !== MAGIC) throw new Error("not a protocol frame");
  if (!crcOk(frame)) throw new Error("CRC mismatch");
  const type = frame[1]! & 0x1f;
  const requestId = readLe16(frame, 4);
  if (STATUS_TYPES.has(type) && frame.length >= 18) {
    return { type, requestId, resource: frame.slice(6, 9), status: readLe16(frame, 12), raw: frame };
  }
  return { type, requestId, raw: frame };
}

// ---------------------------------------------------------------- requests

/** Resolve (register) a resource path; the reply carries the device-assigned triple. */
export function resolveFrame(path: string, requestId: number, client: Uint8Array = FS_CLIENT): Uint8Array {
  const p = ascii(path);
  return buildFrame(MT.RESOLVE, requestId, concat(client, Uint8Array.of(p.length), p));
}

/** Default triples the official app uses (identical on NG1 and NG3 per zappctl probes). */
export const DIRLIST_TRIPLE = Uint8Array.of(0xf0, 0x23, 0x02);
export const STREAM_TRIPLE = Uint8Array.of(0xf0, 0x23, 0x0a);

/**
 * Shapes of the listing request. "path+u8" is what the official app sends to the watches
 * this was captured from; the others are fallbacks for firmware that rejects it (400).
 */
export type ListForm = "path+u8" | "path" | "path+i32";

/** GET /Dev/FileSystem/DirectoryList {path: STRING, page: UINT8}. */
export function dirListFrame(path: string, requestId: number, triple: Uint8Array = DIRLIST_TRIPLE, page = 0, form: ListForm = "path+u8"): Uint8Array {
  const p = ascii(path + "\0");
  const params =
    form === "path" ? concat(Uint8Array.of(1), le16(TYPE.STRING), p)
    : form === "path+i32" ? concat(Uint8Array.of(2), le16(TYPE.STRING), p, le16(TYPE.INT32), le32(page))
    : concat(Uint8Array.of(2), le16(TYPE.STRING), p, le16(TYPE.UINT8), Uint8Array.of(page & 0xff));
  return buildFrame(MT.GET, requestId, concat(triple, FS_CLIENT, params));
}

/** Builtin scalar type IDs a request can carry, as the watch's DataTypeMetadata numbers them. */
export const ENCODABLE_TYPES = new Set([TYPE.UINT8, 5, TYPE.INT32, TYPE.STRING]);

/**
 * A listing request built from the parameter types the watch itself reports (ParameterMetadata):
 * the first STRING carries the path, the first number the page, everything else empty or 0.
 */
export interface ListEncoding {
  /** How a STRING value is written: NUL-terminated (every capture), or with a length byte first. */
  strings?: "nul" | "len" | "len+nul";
  client?: Uint8Array;
}

export function typedListFrame(path: string, requestId: number, triple: Uint8Array, types: number[], page = 0, enc: ListEncoding = {}): Uint8Array {
  let pathUsed = false;
  let pageUsed = false;
  const parts: Uint8Array[] = [Uint8Array.of(types.length)];
  const str = (v: string) =>
    enc.strings === "len" ? concat(Uint8Array.of(v.length), ascii(v))
    : enc.strings === "len+nul" ? concat(Uint8Array.of(v.length + 1), ascii(`${v}\0`))
    : ascii(`${v}\0`);
  for (const t of types) {
    parts.push(le16(t));
    if (t === TYPE.STRING) {
      parts.push(str(pathUsed ? "" : path));
      pathUsed = true;
    } else {
      const v = pageUsed ? 0 : page;
      pageUsed = true;
      if (t === TYPE.UINT8) parts.push(Uint8Array.of(v & 0xff));
      else if (t === 5) parts.push(le16(v));
      else if (t === TYPE.INT32) parts.push(le32(v));
      else throw new Error(`can't encode parameter type ${t}`);
    }
  }
  return buildFrame(MT.GET, requestId, concat(triple, enc.client ?? FS_CLIENT, ...parts));
}

/** GET /Dev/FileSystem/Stream {path: STRING, offset: INT32}: read the next chunk of a file. */
export function readFileFrame(path: string, requestId: number, offset: number, triple: Uint8Array = STREAM_TRIPLE): Uint8Array {
  const p = ascii(path + "\0");
  return buildFrame(
    MT.GET,
    requestId,
    concat(triple, FS_CLIENT, Uint8Array.of(2), le16(TYPE.STRING), p, le16(TYPE.INT32), le32(offset)),
  );
}

export interface DirListing {
  files: string[];
  dirs: string[];
}

/**
 * The listing reply carries a JSON document such as {"dirs":["logs"],"files":["a.sml"]}.
 * Returns null when no JSON is present; an empty object means "wrong path spelling"
 * on this watch generation (NG1 has no `b:` drive prefix).
 */
export function parseDirListing(frame: Uint8Array): DirListing | null {
  const text = new TextDecoder("latin1").decode(frame.subarray(14, -4));
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const doc = JSON.parse(text.slice(start, end + 1)) as { files?: unknown; dirs?: unknown };
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { files: strings(doc.files), dirs: strings(doc.dirs) };
  } catch {
    return null;
  }
}

export interface FileChunk {
  status: number;
  data: Uint8Array;
}

/**
 * Stream read reply: status@12, value typeId 0x000D @14, tag 0x02 @16,
 * LE24 chunk length @17, LE24 echoed length @20, data from @25.
 * Status 100 means "more data follows", 200 means "end of file".
 */
export function parseFileChunk(frame: Uint8Array): FileChunk {
  if (frame.length < 29) throw new Error("file chunk reply too short");
  const status = readLe16(frame, 12);
  if (readLe16(frame, 14) !== TYPE.LIST_OF_BYTES || frame[16] !== 0x02) {
    throw new Error(`unexpected stream reply layout (status ${status})`);
  }
  const len = readLe24(frame, 17);
  if (len !== readLe24(frame, 20) || 25 + len + 4 > frame.length) throw new Error("inconsistent chunk length");
  return { status, data: frame.slice(25, 25 + len) };
}

/** Printable ASCII runs inside a reply, used to surface /Info strings (model, serial, versions). */
export function printableStrings(b: Uint8Array, min = 3): string[] {
  const out: string[] = [];
  let cur = "";
  for (const x of b) {
    if (x >= 0x20 && x < 0x7f) cur += String.fromCharCode(x);
    else {
      if (cur.length >= min) out.push(cur);
      cur = "";
    }
  }
  if (cur.length >= min) out.push(cur);
  return out;
}
