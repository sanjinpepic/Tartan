/**
 * Watch faces on the phone: draw a face's layers (src/watchface/tartan-face.ts), turn each into
 * the RGBA PNG the watch wants, and pack them (src/watchface/package.ts).
 */
import { facePackage, FACE_IMAGES, type FacePackage } from "../../src/watchface/package.ts";
import { encodePng } from "../../src/watchface/png.ts";
import { face, layers, TARTAN_TRACK_DESIGN, type FaceDesign, type WeekOnFace } from "../../src/watchface/tartan-face.ts";
import fontUrl from "../fonts/barlow-condensed-latin-600-normal.woff2";

/** The numerals' typeface as a data URL: an SVG drawn as an image can't reach the page's fonts. */
let font: Promise<string | undefined> | null = null;
const numeralsFont = () =>
  (font ??= fetch(fontUrl)
    .then((r) => r.arrayBuffer())
    .then((b) => {
      const bytes = new Uint8Array(b);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `data:font/woff2;base64,${btoa(bin)}`;
    })
    .catch(() => undefined));

async function rasterize(svg: string, width: number, height: number): Promise<Uint8Array> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, width, height);
  return encodePng(width, height, g.getImageData(0, 0, width, height).data);
}

/** A face, drawn and packed, ready to install. */
export async function packageFor(design: FaceDesign, extra: { week?: WeekOnFace; id?: string; name?: string } = {}): Promise<FacePackage> {
  const images: Record<string, Uint8Array> = {};
  const fontData = await numeralsFont();
  for (const [name, l] of Object.entries(layers(design, { font: fontData, week: extra.week }))) {
    const size = FACE_IMAGES[name];
    if (!size) continue;
    images[name] = await rasterize(l.svg, size.width, size.height);
  }
  return facePackage({ id: extra.id ?? design.id, name: extra.name ?? design.name, images, seconds: design.seconds });
}

/**
 * Tartan 2: a face at 10:09 as a picture, for the native screens (which can't draw its SVG):
 * WebP with alpha, `size` px square. A saved face listed without its photo shows on black.
 */
export async function facePicture(design: FaceDesign, o: { size: number; week?: WeekOnFace; date?: string; at?: { h: number; m: number; s: number }; data?: boolean }): Promise<string> {
  const d = (design.background.kind === "photo" && !("image" in design.background && design.background.image) ? { ...design, background: { kind: "black" } } : design) as FaceDesign;
  const at = o.at ?? { h: 10, m: 9, s: 36 };
  const svg = face({ design: d, hours: at.h, minutes: at.m, seconds: at.s, date: o.date ?? "FRI 16", battery: 84, size: o.size, week: o.week, data: o.data, font: await numeralsFont() });
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = c.height = o.size;
  c.getContext("2d")!.drawImage(img, 0, 0, o.size, o.size);
  return c.toDataURL("image/webp", 0.9);
}

/** Tartan Track, ready to install. */
export const tartanTrackPackage = () => packageFor(TARTAN_TRACK_DESIGN);

/** A photo for a face's background: cropped square from its centre, 466 × 466, as JPEG. */
export async function photoBackground(file: Blob): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = c.height = 466;
    c.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 466, 466);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
