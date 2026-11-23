/**
 * A watch-face package for the Suunto Run 2: a zip of PNG images and the layout
 * (`dial_main.bin`), plus the facts the watch is told before it takes the file (id, name,
 * version, size, the zip's MD5, the preview's name). See src/protocol/face-send.ts.
 */
import { crc32 } from "../protocol/codec.ts";
import { tartanLayout } from "./layout.ts";
import { IMAGE_NAMES } from "./names.ts";

export interface FacePackage {
  id: string;
  name: string;
  version: string;
  feature: string;
  preview: string;
  zip: Uint8Array;
  md5: string;
}

/** The images a face needs, by file name, with the pixel size each must have. */
export const FACE_IMAGES: Record<string, { width: number; height: number }> = {
  [`${IMAGE_NAMES.preview}.png`]: { width: 352, height: 352 },
  [`${IMAGE_NAMES.background}.png`]: { width: 480, height: 466 },
  [`${IMAGE_NAMES.hour}.png`]: { width: 64, height: 466 },
  [`${IMAGE_NAMES.minute}.png`]: { width: 64, height: 466 },
  [`${IMAGE_NAMES.capUnder}.png`]: { width: 64, height: 70 },
  [`${IMAGE_NAMES.capOver}.png`]: { width: 32, height: 36 },
  ...Object.fromEntries(IMAGE_NAMES.seconds.map((n) => [`${n}.png`, { width: 16, height: 466 }])),
};

// ------------------------------------------------------------------ MD5 (RFC 1321)

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data: Uint8Array): string {
  const n = (((data.length + 8) >> 6) + 1) * 64;
  const buf = new Uint8Array(n);
  buf.set(data);
  buf[data.length] = 0x80;
  const bits = data.length * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(n - 8, bits >>> 0, true);
  dv.setUint32(n - 4, Math.floor(bits / 2 ** 32), true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < n; off += 64) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const t = (a + f + K[i]! + dv.getUint32(off + g * 4, true)) >>> 0;
      [a, d, c] = [d, c, b];
      b = (b + ((t << S[i]!) | (t >>> (32 - S[i]!)))) >>> 0;
    }
    [a0, b0, c0, d0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0];
  }
  return [a0, b0, c0, d0].map((w) => Array.from({ length: 4 }, (_, i) => ((w >>> (8 * i)) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}

// ------------------------------------------------------------------ zip

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const s = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * A plain zip (deflated where that helps, stored otherwise), in the order given. `store` keeps
 * every file uncompressed; `unix` marks the files as made on Unix with mode 0644 (as the Suunto
 * app's workout zips are).
 */
export async function zip(files: Array<{ name: string; data: Uint8Array }>, when = new Date(2026, 0, 1), o: { store?: boolean; unix?: boolean } = {}): Promise<Uint8Array> {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const packed = o.store ? null : await deflate(f.data);
    const method = packed && packed.length < f.data.length ? 8 : 0;
    const body = method === 8 ? packed! : f.data;
    const crc = crc32(f.data);
    const head = new Uint8Array(30 + name.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    if (o.unix) h.setUint16(6, 0x0800, true); // names in UTF-8
    h.setUint16(8, method, true);
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, body.length, true);
    h.setUint32(22, f.data.length, true);
    h.setUint16(26, name.length, true);
    head.set(name, 30);
    const cen = new Uint8Array(46 + name.length);
    const c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, o.unix ? 0x0314 : 20, true);
    c.setUint16(6, 20, true);
    if (o.unix) {
      c.setUint16(8, 0x0800, true);
      c.setUint32(38, 0x81a40000, true);
    }
    c.setUint16(10, method, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    cen.set(name, 46);
    parts.push(head, body);
    central.push(cen);
    offset += head.length + body.length;
  }
  const cenSize = central.reduce((n, x) => n + x.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, cenSize, true);
  e.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of all) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}

/** True when `png` is an 8-bit RGBA PNG of the given size (what the watch's faces use). */
export function pngFits(png: Uint8Array, width: number, height: number): boolean {
  if (png.length < 33 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return false;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return dv.getUint32(16) === width && dv.getUint32(20) === height && png[24] === 8 && png[25] === 6 && png[28] === 0;
}

/**
 * Build a face package from its images (PNG bytes by file name, every one of FACE_IMAGES) and the
 * seven seconds colours the watch offers.
 */
export async function facePackage(o: { id: string; name: string; images: Record<string, Uint8Array>; seconds: string[]; version?: string }): Promise<FacePackage> {
  if (!/^\d{6,10}$/.test(o.id)) throw new Error("a face id is 6 to 10 digits");
  for (const [file, size] of Object.entries(FACE_IMAGES)) {
    const png = o.images[file];
    if (!png) throw new Error(`the face is missing ${file}`);
    if (!pngFits(png, size.width, size.height)) throw new Error(`${file} must be an 8-bit RGBA PNG of ${size.width} × ${size.height}`);
  }
  // Tartan's own layout (src/watchface/layout.ts, written clean-room from the format spec).
  const layout = tartanLayout(o.seconds);
  const files = [...Object.keys(FACE_IMAGES).map((name) => ({ name, data: o.images[name]! })), { name: "dial_main.bin", data: layout }];
  const z = await zip(files);
  return { id: o.id, name: o.name, version: o.version ?? "v1.0.0", feature: "feat_watchface_kunming_v1", preview: IMAGE_NAMES.preview, zip: z, md5: md5(z) };
}
