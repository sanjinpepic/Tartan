/**
 * An 8-bit RGBA PNG from raw pixels, always RGBA and never interlaced (what the Run 2's faces
 * use; a browser's own encoder drops the alpha channel from an opaque image).
 */
import { crc32 } from "../protocol/codec.ts";

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** `rgba`: width × height × 4 bytes, row by row. */
export async function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Promise<Uint8Array> {
  if (rgba.length !== width * height * 4) throw new Error("pixel data doesn't match the size");
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk("IHDR", ihdr), chunk("IDAT", await zlib(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
