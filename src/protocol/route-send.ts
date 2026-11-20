/**
 * Put a route on the Suunto Run 2 over Bluetooth, the way the Suunto app does it (HCI capture of
 * 16 Oct 2026):
 *
 *   GET  /DataFormat/Descriptors (2, offset)   the route format, checked against route-file.ts
 *   GET  /Settings/Navigation/RouteList         the ids in use; the new route takes the next one
 *   PUT  /Settings/Navigation/Route/Data        no parameters: opens the transfer (100)
 *   PUT  /Settings/Navigation/Route/Data × n    the SBEM file in 453-byte pieces (100, last 200)
 *   PUT  /Settings/Navigation/Route             the route's record (id, name, distance, …)
 *   GET  /Settings/Navigation/RouteList         the new id is there
 *
 * Nothing is written until every check passes: the watch must describe the route format with
 * exactly the fields Tartan writes, and describe the record so that the one the Suunto app sent
 * (kept below) comes out byte for byte. Values Tartan doesn't know the meaning of are copied
 * from that record. Only these two resources are ever written.
 */
import { routeFile, ROUTE_DESCRIPTOR_ID, ROUTE_FIELDS, type WatchRoutePoint } from "./route-file.ts";
import { decodeStruct, encodeStruct, layoutOf, structParam, type Layout, type TypeMeta, type Value } from "./wbstruct.ts";

export interface RouteRpc {
  /** A request on a path (resolved first); the reply, or null when there was none. */
  rpc(path: string, params: Uint8Array[], method: "GET" | "PUT"): Promise<{ status?: number; raw: Uint8Array } | null>;
  /** DataTypeMetadata for a type, with field names. */
  typeMeta(id: number): Promise<TypeMeta | null>;
  log(msg: string): void;
}

/** The record type /Settings/Navigation/Route takes. */
export const ROUTE_TYPE = 0x3601;
/** The record the Suunto app wrote for its 7 km route, from the struct's first byte. */
const SAMPLE = hex("0b000000200000000300000090" + "1c00008f44d26a00000000250100000100000437" + "6b20726f75746500");
const SAMPLE_KNOWN = { id: 11, distance: 7312, created: 1792165007, points: 293, name: "7k route" };
const CHUNK = 453;

function hex(s: string): Uint8Array {
  return Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
}
const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32 = (b: Uint8Array, o: number) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;
const le = (n: number, bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 0xff);
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};

/** A reply's value: what follows the status (frame bytes 14 to the CRC). */
const valueOf = (raw: Uint8Array) => raw.subarray(14, raw.length - 4);

/** A byte-list value: u16 type 13, then 02, u24 total, u24 end, u16 length, bytes. */
function bytesValue(v: Uint8Array): { total: number; end: number; data: Uint8Array } | null {
  if (v.length < 11 || u16(v, 0) !== 13) return null;
  const len = u16(v, 9);
  return { total: u24(v, 3), end: u24(v, 6), data: v.subarray(11, 11 + len) };
}

/** A struct reply holding one u32 list (RouteList): u32 count, u32 offset, then the items. */
export function u32List(raw: Uint8Array): number[] | null {
  if (raw.length < 22) return null;
  const hdr = u16(raw, 16);
  const align = 1 << ((hdr >> 9) & 7);
  const start = 18 + ((align - (18 % align)) % align);
  const data = raw.subarray(start, Math.min(raw.length - 4, 18 + (hdr & 0x1ff)));
  if (data.length < 8) return null;
  const n = u32(data, 0);
  const off = u32(data, 4);
  if (n > 1000 || off + n * 4 > data.length) return null;
  return Array.from({ length: n }, (_, i) => u32(data, off + i * 4));
}

/** The watch's own description of the route format: the field paths, in order. */
async function routeDescriptor(r: RouteRpc): Promise<string[]> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < 20; i++) {
    const rep = await r.rpc("/DataFormat/Descriptors", [cat(le(3, 2), le(ROUTE_DESCRIPTOR_ID, 1)), cat(le(6, 2), le(offset, 4))], "GET");
    const v = rep && (rep.status === 200 || rep.status === 100) ? bytesValue(valueOf(rep.raw)) : null;
    if (!v) throw new Error(`the watch didn't describe its route format (${rep?.status ?? "no reply"})`);
    parts.push(v.data);
    offset = v.end;
    if (v.end >= v.total || !v.data.length) break;
  }
  const text = new TextDecoder().decode(cat(...parts));
  return [...text.matchAll(/<PTH>([^\n]+)/g)].map((m) => m[1]!);
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Which bytes of a struct's fixed part belong to a field (presence bytes included); the rest is padding. */
export function fieldBytes(layout: Extract<Layout, { kind: "struct" }>): boolean[] {
  const used = new Array<boolean>(layout.size).fill(false);
  const mark = (l: Layout, at: number) => {
    if (l.kind === "struct") for (const f of l.fields) markField(f, at);
    else for (let i = 0; i < l.size; i++) used[at + i] = true;
  };
  const markField = (f: Extract<Layout, { kind: "struct" }>["fields"][number], base: number) => {
    if (f.required) return mark(f.layout, base + f.offset);
    used[base + f.offset] = true;
    mark(f.layout, base + f.offset + f.layout.align);
  };
  for (const f of layout.fields) markField(f, 0);
  return used;
}

/** The record layout, proven on the Suunto app's own record; null (with the reason logged) when it doesn't hold. */
async function recordLayout(r: RouteRpc): Promise<{ layout: Extract<Layout, { kind: "struct" }>; sample: Record<string, Value>; roles: Record<keyof typeof SAMPLE_KNOWN, string> }> {
  const metas = new Map<number, TypeMeta | null>();
  const lookup = async (id: number) => {
    if (!metas.has(id)) metas.set(id, await r.typeMeta(id));
    return metas.get(id)!;
  };
  const layout = await layoutOf(ROUTE_TYPE, lookup);
  if (layout.kind !== "struct") throw new Error("the route record isn't a struct");
  r.log(`[route] record 0x${ROUTE_TYPE.toString(16)}: ${layout.size} bytes, align ${layout.align}: ${layout.fields.map((f) => `${f.name}${f.required ? "" : "?"}@${f.offset}:${f.layout.kind === "scalar" ? f.layout.scalar : f.layout.kind}`).join(", ")}`);
  const sample = decodeStruct(layout, SAMPLE);
  const again = encodeStruct(layout, sample);
  // Byte for byte, except padding: the Suunto app's record has a stray 04 in the two bytes after
  // isQuickNavi (whatever was in its buffer); Tartan writes zeros there.
  const used = fieldBytes(layout);
  const differs = again.findIndex((b, i) => b !== SAMPLE[i] && (i >= layout.size || !!used[i]));
  if (again.length !== SAMPLE.length || differs >= 0) {
    r.log(`[route] rebuilt record ${toHex(again)} vs the Suunto app's ${toHex(SAMPLE)}${differs >= 0 ? `; first difference at byte ${differs}` : ""}`);
    throw new Error("the watch's route record doesn't match the one the Suunto app wrote; nothing was sent");
  }
  // Which field is which, by the values the Suunto app put in them.
  const roles = {} as Record<keyof typeof SAMPLE_KNOWN, string>;
  for (const [role, want] of Object.entries(SAMPLE_KNOWN) as Array<[keyof typeof SAMPLE_KNOWN, number | string]>) {
    const hits = Object.entries(sample).filter(([, v]) => (typeof v === "bigint" ? Number(v) : v) === want);
    if (hits.length !== 1) throw new Error(`couldn't tell which field of the route record is the ${role}; nothing was sent`);
    roles[role] = hits[0]![0];
  }
  r.log(`[route] record fields: ${Object.entries(sample).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
  return { layout, sample, roles };
}

export interface SendProgress {
  stage: "checking" | "sending" | "saving";
  sent?: number;
  total?: number;
}

/** Send a route; returns the id the watch keeps it under. */
export async function sendRouteToWatch(r: RouteRpc, route: { name: string; points: WatchRoutePoint[]; distance_m: number; created?: Date }, onProgress?: (p: SendProgress) => void): Promise<{ id: number; bytes: number }> {
  onProgress?.({ stage: "checking" });
  // 1. The format, as the watch describes it.
  const paths = await routeDescriptor(r);
  r.log(`[route] format ${ROUTE_DESCRIPTOR_ID}: ${paths.join(", ")}`);
  if (paths.length !== ROUTE_FIELDS.length || paths.some((p, i) => !p.startsWith(ROUTE_FIELDS[i]!))) throw new Error("this watch describes routes differently from the Run 2 Tartan knows; nothing was sent");

  // 2. The record, proven on the Suunto app's.
  const { layout, sample, roles } = await recordLayout(r);

  // 3. The next free id.
  const list = await r.rpc("/Settings/Navigation/RouteList", [], "GET");
  const ids = list?.status === 200 ? u32List(list.raw) : null;
  if (!ids) throw new Error(`the watch didn't list its routes (${list?.status ?? "no reply"})`);
  const id = Math.max(0, ...ids) + 1;
  r.log(`[route] routes on the watch: ${ids.join(", ") || "none"}; this one becomes ${id}`);

  // 4. The file, in pieces.
  const file = routeFile(route.points);
  const open = await r.rpc("/Settings/Navigation/Route/Data", [], "PUT");
  if (open?.status !== 100 && open?.status !== 200) throw new Error(`the watch didn't open the route transfer (${open?.status ?? "no reply"})`);
  for (let at = 0; at < file.length; at += CHUNK) {
    const piece = file.subarray(at, Math.min(file.length, at + CHUNK));
    const end = at + piece.length;
    const rep = await r.rpc("/Settings/Navigation/Route/Data", [cat(le(13, 2), Uint8Array.of(2), le(file.length, 3), le(end, 3), le(piece.length, 2), piece)], "PUT");
    const want = end === file.length ? 200 : 100;
    if (rep?.status !== want) throw new Error(`the watch stopped the route at ${end} of ${file.length} bytes (${rep?.status ?? "no reply"})`);
    onProgress?.({ stage: "sending", sent: end, total: file.length });
  }

  // 5. The record.
  onProgress?.({ stage: "saving" });
  const name = route.name.replace(/[^\p{L}\p{N} .,'&()+-]/gu, "").trim().slice(0, 40) || "Route";
  const values: Record<string, Value> = {
    ...sample,
    [roles.id]: id,
    [roles.name]: name,
    [roles.distance]: Math.round(route.distance_m),
    [roles.created]: typeof sample[roles.created] === "bigint" ? BigInt(Math.floor((route.created ?? new Date()).getTime() / 1000)) : Math.floor((route.created ?? new Date()).getTime() / 1000),
    [roles.points]: route.points.length,
  };
  const saved = await r.rpc("/Settings/Navigation/Route", [structParam(ROUTE_TYPE, layout.align, encodeStruct(layout, values))], "PUT");
  if (saved?.status !== 200) throw new Error(`the watch didn't save the route (${saved?.status ?? "no reply"})`);

  // 6. It's there.
  const after = await r.rpc("/Settings/Navigation/RouteList", [], "GET");
  const now = after?.status === 200 ? u32List(after.raw) : null;
  r.log(`[route] routes on the watch now: ${now?.join(", ") ?? "unreadable"}`);
  if (now && !now.includes(id)) throw new Error("the watch took the route but doesn't list it");
  return { id, bytes: file.length };
}
