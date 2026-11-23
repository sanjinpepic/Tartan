/**
 * Watch-defined structs: how the watch describes a type (DataTypeMetadata, GET f0000b) and how a
 * struct value travels in a request. Recovered from the HCI capture of 16 Oct 2026 and checked
 * against the watch-face record the Suunto app wrote there:
 *
 * A struct parameter is u16 type id, u16 header, padding, then the struct's bytes laid out like
 * a C struct (each field at its natural alignment). The header holds the length from the end of
 * the header (padding included) in bits 0–8, log2 of the alignment in bits 9–11, and 1 in bit 12
 * for a request (2 in a reply). The padding aligns the struct to its alignment counted from the
 * start of the frame. Strings are u32 offsets (from the struct's first byte) to NUL-terminated
 * text after the fixed part, in field order; an optional field is a presence byte, then the
 * value at its own alignment.
 */

export interface TypeMeta {
  id: number;
  /** 0 builtin, 1 named (an alias of baseTypeId), 2 array, 3 struct, 4 enum. */
  kind: number;
  scalarType?: number;
  nameId?: number;
  baseTypeId?: number;
  fields: Array<{ nameId: number; type: number; required: boolean; name?: string }>;
  items: Array<{ nameId: number; value: number; name?: string }>;
}

/** A DataTypeMetadata record (the struct a GET f0000b answers with). */
export function parseTypeMeta(blob: Uint8Array): TypeMeta | null {
  if (blob.length < 20) return null;
  const u16 = (o: number) => (o + 2 <= blob.length ? blob[o]! | (blob[o + 1]! << 8) : 0);
  const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  const t: TypeMeta = {
    id: u16(0),
    kind: blob[2]!,
    scalarType: blob[3] ? blob[4] : undefined,
    nameId: blob[10] ? u16(12) : undefined,
    baseTypeId: blob[14] ? u16(16) : undefined,
    fields: [],
    items: [],
  };
  if (blob[20] && blob.length >= 32) {
    const n = Math.min(64, u32(24));
    const off = u32(28);
    for (let i = 0; i < n && off + i * 6 + 6 <= blob.length; i++) {
      const at = off + i * 6;
      t.fields.push({ nameId: u16(at), type: u16(at + 2), required: blob[at + 4] === 1 });
    }
  }
  if (blob[32] && blob.length >= 44) {
    const n = Math.min(64, u32(36));
    const off = u32(40);
    for (let i = 0; i < n && off + i * 4 + 4 <= blob.length; i++) {
      const v = u16(off + i * 4 + 2);
      t.items.push({ nameId: u16(off + i * 4), value: v >= 0x8000 ? v - 0x10000 : v });
    }
  }
  return t;
}

// ------------------------------------------------------------------ layout

export type Scalar = "bool" | "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "i64" | "u64" | "f32" | "f64";
const BUILTIN: Record<number, Scalar | "string"> = { 1: "bool", 2: "i8", 3: "u8", 4: "i16", 5: "u16", 6: "i32", 7: "u32", 8: "i64", 9: "u64", 10: "f32", 11: "f64", 12: "string" };
const SIZE: Record<Scalar | "string", number> = { bool: 1, i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, i64: 8, u64: 8, f32: 4, f64: 8, string: 4 };

export type Layout =
  | { kind: "scalar"; scalar: Scalar; size: number; align: number }
  /** An array: u32 count, u32 offset. Tartan reads past them and writes them empty. */
  | { kind: "array"; size: 8; align: 4 }
  | { kind: "string"; size: 4; align: 4 }
  | { kind: "struct"; typeId: number; size: number; align: number; fields: Array<{ name: string; offset: number; required: boolean; layout: Layout }> };

const up = (n: number, a: number) => Math.ceil(n / a) * a;

/** The C layout of a type, asking the watch (`lookup`) about every type that isn't builtin. */
export async function layoutOf(typeId: number, lookup: (id: number) => Promise<TypeMeta | null>, depth = 0): Promise<Layout> {
  if (depth > 6) throw new Error("type nesting too deep");
  const b = BUILTIN[typeId];
  if (b === "string") return { kind: "string", size: 4, align: 4 };
  if (b) return { kind: "scalar", scalar: b, size: SIZE[b], align: SIZE[b] };
  const t = await lookup(typeId);
  // 0x1xx without metadata: the builtin arrays (lists of a builtin type).
  if (!t && typeId >= 0x100 && typeId < 0x200) return { kind: "array", size: 8, align: 4 };
  if (!t) throw new Error(`the watch didn't describe type 0x${typeId.toString(16)}`);
  if (t.kind === 2) return { kind: "array", size: 8, align: 4 };
  // A builtin the watch names itself (the Run 2's route record has 0x1ea for its time): laid out as its scalar.
  if (t.kind === 0) {
    const base = t.scalarType ?? t.baseTypeId;
    if (base !== undefined && base !== typeId) return layoutOf(base, lookup, depth + 1);
  }
  if (t.kind === 1 && t.baseTypeId !== undefined) return layoutOf(t.baseTypeId, lookup, depth + 1);
  if (t.kind === 4) return layoutOf(t.baseTypeId ?? t.scalarType ?? 3, lookup, depth + 1);
  if (t.kind !== 3) throw new Error(`type 0x${typeId.toString(16)} is a kind (${t.kind}) Tartan can't write`);
  const fields: Extract<Layout, { kind: "struct" }>["fields"] = [];
  let at = 0;
  let align = 1;
  for (const f of t.fields) {
    const inner = await layoutOf(f.type, lookup, depth + 1);
    if (f.required) {
      at = up(at, inner.align);
      fields.push({ name: f.name ?? `#${f.nameId.toString(16)}`, offset: at, required: true, layout: inner });
      at += inner.size;
      align = Math.max(align, inner.align);
    } else {
      // optional<T>: a presence byte, then T at its alignment.
      at = up(at, inner.align);
      fields.push({ name: f.name ?? `#${f.nameId.toString(16)}`, offset: at, required: false, layout: inner });
      at += up(1, inner.align) + inner.size;
      align = Math.max(align, inner.align);
    }
  }
  return { kind: "struct", typeId, size: up(at, align), align, fields };
}

// ------------------------------------------------------------------ values

export type Value = number | bigint | string | null | { [name: string]: Value };

function readScalar(v: DataView, at: number, s: Scalar): number | bigint {
  switch (s) {
    case "bool": case "u8": return v.getUint8(at);
    case "i8": return v.getInt8(at);
    case "i16": return v.getInt16(at, true);
    case "u16": return v.getUint16(at, true);
    case "i32": return v.getInt32(at, true);
    case "u32": return v.getUint32(at, true);
    case "i64": return v.getBigInt64(at, true);
    case "u64": return v.getBigUint64(at, true);
    case "f32": return v.getFloat32(at, true);
    case "f64": return v.getFloat64(at, true);
  }
}
function writeScalar(v: DataView, at: number, s: Scalar, x: number | bigint): void {
  const n = typeof x === "bigint" ? Number(x) : x;
  switch (s) {
    case "bool": case "u8": return v.setUint8(at, n);
    case "i8": return v.setInt8(at, n);
    case "i16": return v.setInt16(at, n, true);
    case "u16": return v.setUint16(at, n, true);
    case "i32": return v.setInt32(at, n, true);
    case "u32": return v.setUint32(at, n >>> 0, true);
    case "i64": return v.setBigInt64(at, BigInt(x), true);
    case "u64": return v.setBigUint64(at, BigInt(x), true);
    case "f32": return v.setFloat32(at, n, true);
    case "f64": return v.setFloat64(at, n, true);
  }
}

/** A struct's values from its bytes (`null` for an absent optional field). */
export function decodeStruct(layout: Extract<Layout, { kind: "struct" }>, bytes: Uint8Array): Record<string, Value> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (off: number) => {
    let end = off;
    while (end < bytes.length && bytes[end]) end++;
    return new TextDecoder().decode(bytes.subarray(off, end));
  };
  const read = (l: Layout, at: number): Value =>
    l.kind === "scalar" ? readScalar(v, at, l.scalar) : l.kind === "string" ? text(v.getUint32(at, true)) : l.kind === "array" ? null : walk(l, at);
  const walk = (l: Extract<Layout, { kind: "struct" }>, base: number): Record<string, Value> => {
    const out: Record<string, Value> = {};
    for (const f of l.fields) {
      if (f.required) out[f.name] = read(f.layout, base + f.offset);
      else out[f.name] = bytes[base + f.offset] ? read(f.layout, base + f.offset + up(1, f.layout.align)) : null;
    }
    return out;
  };
  return walk(layout, 0);
}

/** A struct's bytes: the fixed part, then its strings in field order. */
export function encodeStruct(layout: Extract<Layout, { kind: "struct" }>, values: Record<string, Value>): Uint8Array {
  const fixed = new Uint8Array(layout.size);
  const v = new DataView(fixed.buffer);
  const strings: Uint8Array[] = [];
  let tail = layout.size;
  const put = (l: Layout, at: number, x: Value) => {
    if (l.kind === "scalar") writeScalar(v, at, l.scalar, typeof x === "bigint" || typeof x === "number" ? x : 0);
    else if (l.kind === "string") {
      const b = new TextEncoder().encode(`${typeof x === "string" ? x : ""}\0`);
      v.setUint32(at, tail, true);
      strings.push(b);
      tail += b.length;
    } else if (l.kind === "struct") walk(l, at, (x ?? {}) as Record<string, Value>);
    // arrays stay empty: count 0
  };
  const walk = (l: Extract<Layout, { kind: "struct" }>, base: number, vals: Record<string, Value>) => {
    for (const f of l.fields) {
      const x = vals[f.name];
      if (f.required) put(f.layout, base + f.offset, x ?? 0);
      else if (x !== null && x !== undefined) {
        fixed[base + f.offset] = 1;
        put(f.layout, base + f.offset + up(1, f.layout.align), x);
      }
    }
  };
  walk(layout, 0, values);
  const out = new Uint8Array(tail);
  out.set(fixed);
  let at = layout.size;
  for (const s of strings) {
    out.set(s, at);
    at += s.length;
  }
  return out;
}

/**
 * A struct as a request's only parameter (after the frame header, the resource and client
 * triples and the parameter count, so its type id sits at frame offset 13).
 */
export function structParam(typeId: number, align: number, data: Uint8Array): Uint8Array {
  const headerEnd = 13 + 4;
  const pad = up(headerEnd, align) - headerEnd;
  const len = pad + data.length;
  if (len > 0x1ff) throw new Error(`struct too long for one parameter (${len} bytes)`);
  const out = new Uint8Array(4 + len);
  out[0] = typeId & 0xff;
  out[1] = typeId >> 8;
  const hdr = len | (Math.log2(align) << 9) | (1 << 12);
  out[2] = hdr & 0xff;
  out[3] = hdr >> 8;
  out.set(data, 4 + pad);
  return out;
}
