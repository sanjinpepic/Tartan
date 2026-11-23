/**
 * Render the Tartan Track watch face's images (src/watchface/tartan-face.ts) to PNG, with a
 * transparent background where the face format layers them, and build its package (the zip the
 * watch installs) from them:
 *   bun scripts/watchface.ts <out dir>
 * Uses the Chromium Playwright finds (no network needed).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { facePackage } from "../src/watchface/package.ts";
import { encodePng } from "../src/watchface/png.ts";
import { face, layers, SECONDS, TARTAN_TRACK } from "../src/watchface/tartan-face.ts";

const out = process.argv[2] ?? "watchface";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ deviceScaleFactor: 1 });
/** Draw an SVG on a canvas in the page and take its pixels, then encode them as RGBA PNG here. */
const shoot = async (name: string, svg: string, width: number, height: number) => {
  const pixels = await page.evaluate(
    async ([svg, w, h]) => {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg as string)}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = w as number;
      c.height = h as number;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0, w as number, h as number);
      return Array.from(g.getImageData(0, 0, w as number, h as number).data);
    },
    [svg, width, height] as const,
  );
  const png = await encodePng(width, height, Uint8Array.from(pixels));
  writeFileSync(join(out, name), png);
  return png;
};
const images: Record<string, Uint8Array> = {};
const font = `data:font/woff2;base64,${readFileSync(new URL("../web/fonts/barlow-condensed-latin-600-normal.woff2", import.meta.url)).toString("base64")}`;
for (const [name, l] of Object.entries(layers(undefined, { font }))) images[name] = await shoot(name, l.svg, l.width, l.height);
const pkg = await facePackage({ ...TARTAN_TRACK, images, seconds: SECONDS.map(([, c]) => c) });
writeFileSync(join(out, `${pkg.id}.zip`), pkg.zip);
console.log(`package ${pkg.id}.zip: ${pkg.zip.length} bytes, md5 ${pkg.md5}`);
await shoot("face-1009.png", face({ hours: 10, minutes: 9, seconds: 36, date: "FRI 16", battery: 84 }), 466, 466);
await browser.close();
console.log(`wrote ${Object.keys(layers()).length + 1} images to ${out}`);
