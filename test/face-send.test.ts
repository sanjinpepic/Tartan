import { expect, test } from "bun:test";
import { crc32 } from "../src/protocol/codec.ts";
import { WatchSession } from "../src/protocol/session.ts";
import { decodeStruct, layoutOf, type TypeMeta } from "../src/protocol/wbstruct.ts";
import { FakeWatch, type FakeWatchOptions } from "../src/sim/fake-watch.ts";
import { faceHash, tartanLayout } from "../src/watchface/layout.ts";
import { IMAGE_NAMES } from "../src/watchface/names.ts";
import { FACE_IMAGES, facePackage, md5 } from "../src/watchface/package.ts";
import { FACE_IDS_TYPE, faceIdsRecord } from "../src/protocol/face-send.ts";
import { structParam } from "../src/protocol/wbstruct.ts";
import { layers, SECONDS, TARTAN_TRACK } from "../src/watchface/tartan-face.ts";

const FAST = { chunkDelayMs: 0, frameGapMs: 0 };
const COLOURS = SECONDS.map(([, c]) => c);

/** A PNG header that says `w × h`, 8-bit RGBA (all the package checks), plus some bytes. */
function png(w: number, h: number, fill = 0): Uint8Array {
  const ihdr = new Uint8Array(17);
  const dv = new DataView(ihdr.buffer);
  ihdr.set([0x49, 0x48, 0x44, 0x52]);
  dv.setUint32(4, w);
  dv.setUint32(8, h);
  ihdr.set([8, 6, 0, 0, 0], 12);
  const out = new Uint8Array(8 + 4 + 17 + 4 + 64).fill(fill);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(out.buffer).setUint32(8, 13);
  out.set(ihdr, 12);
  new DataView(out.buffer).setUint32(29, crc32(ihdr));
  return out;
}
const images = () => Object.fromEntries(Object.entries(FACE_IMAGES).map(([n, s], i) => [n, png(s.width, s.height, i)]));

/** File names in a zip, from its central directory. */
function zipNames(z: Uint8Array): string[] {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const end = z.length - 22;
  const n = dv.getUint16(end + 10, true);
  let at = dv.getUint32(end + 16, true);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = dv.getUint16(at + 28, true);
    out.push(new TextDecoder().decode(z.subarray(at + 46, at + 46 + len)));
    at += 46 + len + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
  }
  return out;
}

test("md5", () => {
  expect(md5(new TextEncoder().encode("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
  expect(md5(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"))).toBe("9e107d9d372bb6826bd81d3542a419d6");
  expect(md5(new TextEncoder().encode("a".repeat(1000)))).toBe("cabe45dcc9ae5b66ba86600cca6b8ba8");
});

test("the layout: Tartan's own, naming our images and the seven seconds colours", () => {
  const a = tartanLayout(COLOURS);
  const text = new TextDecoder("latin1").decode(a);
  for (const name of [IMAGE_NAMES.preview, IMAGE_NAMES.background, IMAGE_NAMES.hour, IMAGE_NAMES.minute, IMAGE_NAMES.capUnder, IMAGE_NAMES.capOver]) expect(text).toContain(`${name}\0`);
  expect(text).toContain([IMAGE_NAMES.seconds[0], ...IMAGE_NAMES.seconds].join("@"));
  expect(text).toContain("0xFF6A4D@0xE0452B@0xFDF3EE@0x8FE3B4@0xA3C6FF@0xFFBE3D@0xFFFFFF");
  // Every image is found by the hash of its name: the hour hand's is in the file.
  const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const hashes = Array.from({ length: a.length >> 2 }, (_, i) => dv.getUint32(i * 4, true));
  expect(hashes).toContain(faceHash(IMAGE_NAMES.hour));
  expect(() => tartanLayout(COLOURS.slice(1))).toThrow();
});

test("the package: every image at its size, the layout, and the zip's MD5", async () => {
  const pkg = await facePackage({ ...TARTAN_TRACK, images: images(), seconds: COLOURS });
  expect(zipNames(pkg.zip).sort()).toEqual([...Object.keys(FACE_IMAGES), "dial_main.bin"].sort());
  expect(pkg.md5).toBe(md5(pkg.zip));
  expect(pkg).toMatchObject({ id: "2026101601", name: "Tartan Track", feature: "feat_watchface_kunming_v1", preview: IMAGE_NAMES.preview });
  // A wrong size is refused.
  const bad = images();
  bad[`${IMAGE_NAMES.hour}.png`] = png(64, 460);
  await expect(facePackage({ ...TARTAN_TRACK, images: bad, seconds: COLOURS })).rejects.toThrow(/64 × 466/);
  // The face's drawing names exactly the images the package needs.
  expect(Object.keys(layers()).sort()).toEqual(Object.keys(FACE_IMAGES).sort());
  for (const [n, l] of Object.entries(layers())) expect([l.width, l.height]).toEqual([FACE_IMAGES[n]!.width, FACE_IMAGES[n]!.height]);
});

// ------------------------------------------------------------------ installing, against a simulated Run 2

/** The face types as the Run 2 described them in the capture (field names made up; the capture didn't ask for them all). */
const TYPES = (extra = false): NonNullable<FakeWatchOptions["navigation"]>["types"] => ({
  0xb306: { kind: 1, baseTypeId: 0x0351 },
  0x0351: {
    kind: 3,
    fields: [
      { name: "id", type: 12 }, { name: "name", type: 12 }, { name: "version", type: 12 }, { name: "size", type: 7 }, { name: "feature", type: 12 },
      { name: "md5sum", type: 12 }, { name: "preImgName", type: 12 }, { name: "configuration", type: 0xb304, required: false },
      { name: "x", type: 7, required: false }, { name: "y", type: 7, required: false }, ...(extra ? [{ name: "z", type: 7 }] : []),
    ],
  },
  0xb304: { kind: 1, baseTypeId: 0x034f },
  0x034f: { kind: 3, fields: [{ name: "a", type: 12 }, { name: "colorIndex", type: 2 }, { name: "colorValue", type: 12 }, { name: "widgets", type: 0x011e }, { name: "type", type: 0xb303 }] },
  0xb303: { kind: 1, baseTypeId: 0x034e },
  // Delete/MultiId's record: one list of ids (0x0120, a builtin list the capture didn't describe).
  0xb307: { kind: 1, baseTypeId: 0x0352 },
  0x0352: { kind: 3, fields: [{ name: "ids", type: 0x0120 }] },
  0x034e: { kind: 4, baseTypeId: 3 },
});

const watch = (extra = false) => {
  const nav = { ids: [], descriptor: "", types: TYPES(extra), writes: [] as string[], faces: { ids: ["489366607", "573254755", "1152805749", "1152805759", "1152805748"] } } as NonNullable<FakeWatchOptions["navigation"]>;
  return { nav, s: new WatchSession(new FakeWatch({ name: "Suunto Run 2", files: {}, navigation: nav, notifySize: 120 }), FAST) };
};

test("installs a face the way the Suunto app does: details, the zip in pieces, install", async () => {
  const { nav, s } = watch();
  await s.open();
  const pkg = await facePackage({ ...TARTAN_TRACK, images: images(), seconds: COLOURS });
  const seen: number[] = [];
  const res = await s.installFace(pkg, (p) => p.sent && seen.push(p.sent));
  expect(res.id).toBe("2026101601");
  // Five faces already: the new one is on the list's second page.
  expect(nav.faces!.ids.indexOf("2026101601")).toBe(5);
  expect(nav.faces!.path).toBe("/emmc/dial/download/2026101601.zip");
  expect(Buffer.from(nav.faces!.zip!).equals(Buffer.from(pkg.zip))).toBe(true);
  expect(seen[0]).toBe(453);
  // The details, read back with the same layout.
  const types: Record<number, TypeMeta> = {};
  for (const [k, t] of Object.entries(TYPES())) types[Number(k)] = { id: Number(k), kind: t.kind, baseTypeId: t.baseTypeId, fields: (t.fields ?? []).map((f, i) => ({ nameId: i, type: f.type, required: f.required !== false, name: f.name })), items: [] };
  const layout = await layoutOf(0xb306, async (id) => types[id] ?? null);
  if (layout.kind !== "struct") throw new Error("not a struct");
  const info = decodeStruct(layout, nav.faces!.info!);
  expect(info).toMatchObject({ id: "2026101601", name: "Tartan Track", version: "v1.0.0", size: pkg.zip.length, feature: "feat_watchface_kunming_v1", md5sum: pkg.md5, preImgName: IMAGE_NAMES.preview, configuration: null, x: null });
  expect(Number(info.y)).toBeGreaterThan(1.7e9);
  expect([...new Set(nav.writes)].sort()).toEqual(["/Dev/FileSystem/Stream", "/WatchFace/Info", "/WatchFace/Install"]);
  // Again: it's there already, so nothing is sent.
  nav.writes!.length = 0;
  await expect(s.installFace(pkg)).rejects.toThrow(/already on your watch/);
  expect(nav.writes).toEqual([]);
});

test("writes nothing when the watch describes faces differently", async () => {
  const { nav, s } = watch(true);
  await s.open();
  const pkg = await facePackage({ ...TARTAN_TRACK, images: images(), seconds: COLOURS });
  await expect(s.installFace(pkg)).rejects.toThrow(/nothing was sent/);
  expect(nav.writes).toEqual([]);
});

// ------------------------------------------------------------------ the face builder's designs

import { checkDesign, newFaceId, PRESETS, surprise, TARTAN_TRACK_DESIGN } from "../src/watchface/tartan-face.ts";
import { Faces } from "../src/faces.ts";
import { MemoryDisk } from "../src/disk.ts";

test("every preset and every surprise is a design the watch can show", () => {
  for (const p of PRESETS) expect(checkDesign({ ...p, id: newFaceId() }).name).toBe(p.name);
  for (let i = 0; i < 50; i++) {
    const d = surprise(newFaceId());
    expect(checkDesign(d)).toEqual(d);
    expect(Object.keys(layers(d)).sort()).toEqual(Object.keys(FACE_IMAGES).sort());
  }
  expect(PRESETS.length).toBeGreaterThanOrEqual(15);
});

test("the presets each look their own: no two share ground, pattern, track and hands", () => {
  const look = (p: (typeof PRESETS)[number]) => JSON.stringify([p.background, p.art, p.track, p.hands, p.numerals]);
  expect(new Set(PRESETS.map(look)).size).toBe(PRESETS.length);
  expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
  // Every pattern, every track and every hand shape is in at least one.
  for (const a of ["sunburst", "stripes", "split", "rings", "zones", "contours", "checker", "lanes", "halftone", "watermark"]) expect(PRESETS.some((p) => p.art === a)).toBe(true);
  for (const h of ["dauphine", "block", "pencil"]) expect(PRESETS.some((p) => p.hands === h)).toBe(true);
  expect(PRESETS.some((p) => p.track === "bezel" && p.numerals !== "big")).toBe(true);
  // Each draws as a full set of images, and the dial carries what was asked for.
  for (const p of PRESETS) {
    const d = checkDesign({ ...p, id: "2000000001" });
    expect(Object.keys(layers(d)).sort()).toEqual(Object.keys(FACE_IMAGES).sort());
    const bg = layers(d)[`${IMAGE_NAMES.background}.png`]!.svg;
    if (d.numerals === "big") expect(bg).toContain(">12</text>");
    if (d.track === "bezel") expect(bg).toContain(">55</text>");
  }
});

test("faces from before the builder grew options still load", () => {
  const old = { id: "2012345678", name: "Old", background: { kind: "black" }, track: "lanes", marks: "all", logo: false, numerals: "quarters", hands: "slim", colours: { track: "#111111", finish: "#222222", marks: "#333333", minor: "#444444", logo: "#555555", hands: "#666666", caps: "#777777" }, seconds: COLOURS };
  const d = checkDesign(old);
  expect(d).toMatchObject({ logo: "none", numerals: "arabic", finish: true, markShape: "line", secondsStyle: "needle", caps: "dot", text: "", art: "none" });
  expect(d.colours.numerals).toBe("#333333");
  expect(d.colours.art).toBe("#111111");
  expect(() => checkDesign({ ...old, id: "12" })).toThrow(/id/);
  expect(() => checkDesign({ ...old, seconds: COLOURS.slice(2) })).toThrow(/seven/);
  expect(() => checkDesign({ ...old, background: { kind: "photo", image: "http://x/y.jpg", dim: 0.2 } })).toThrow(/photo/);
});

test("the face store keeps designs, without photos in the list", async () => {
  const faces = new Faces(new MemoryDisk());
  const photo = `data:image/jpeg;base64,${"A".repeat(2000)}`;
  const f = await faces.save({ ...TARTAN_TRACK_DESIGN, id: undefined as never, name: "Mine", background: { kind: "photo", image: photo, dim: 0.3 } });
  expect(f.id).toMatch(/^\d{10}$/);
  expect((await faces.get(f.id))!.background).toEqual({ kind: "photo", image: photo, dim: 0.3 });
  expect((await faces.list())[0]).toMatchObject({ id: f.id, name: "Mine", background: { kind: "photo" } });
  expect(JSON.stringify(await faces.list())).not.toContain("AAAA");
  expect(await faces.remove(f.id)).toBe(true);
  expect(await faces.list()).toEqual([]);
});

// ------------------------------------------------------------------ removing a face

test("the uninstall record is the Suunto app's, byte for byte (but for its padding)", () => {
  // Captured: PUT /WatchFace/Delete/MultiId for face 1152805751. Bytes 4-6 are padding and 9-10
  // the list count's unused half; the Suunto app left memory there, Tartan zeros.
  const captured = "07b31a14616365" + "0100656c" + "08000000" + "0c000000" + "3131353238303537353100";
  const ours = Buffer.from(structParam(FACE_IDS_TYPE, 4, faceIdsRecord("1152805751"))).toString("hex");
  const blank = (h: string) => h.slice(0, 8) + "000000" + h.slice(14, 18) + "0000" + h.slice(22);
  expect(ours).toBe(blank(captured));
});

test("removes a face Tartan installed, and only that", async () => {
  const { nav, s } = watch();
  await s.open();
  const pkg = await facePackage({ ...TARTAN_TRACK, images: images(), seconds: COLOURS });
  await s.installFace(pkg);
  nav.writes!.length = 0;
  expect(await s.removeFace("2026101601")).toEqual({ removed: true });
  expect(nav.faces!.removed).toEqual(["2026101601"]);
  expect(nav.faces!.ids).not.toContain("2026101601");
  expect(nav.writes).toEqual(["/WatchFace/Delete/MultiId"]);
  // Not there any more: nothing sent.
  expect(await s.removeFace("2026101601")).toEqual({ removed: false });
  // Suunto's own faces are never touched.
  await expect(s.removeFace("1152805749")).rejects.toThrow(/didn't make/);
  expect(nav.writes).toEqual(["/WatchFace/Delete/MultiId"]);
  expect(nav.faces!.ids).toContain("1152805749");
});

test("the week on a face: a mark per day by what it holds, the focus, the km, and no 12 in their way", () => {
  const week = { days: ["easy", "hard", "rest", "strength", "easy", "rest", "long"] as Array<"hard" | "long" | "easy" | "strength" | "rest">, title: "Build", planned_km: 41 };
  const paper = checkDesign({ ...PRESETS.find((p) => p.name === "Paper")!, id: "2026101702" });
  const bg = layers(paper, { week })[`${IMAGE_NAMES.background}.png`]!.svg;
  expect(bg).toContain(">BUILD</text>");
  expect(bg).toContain(">41 KM</text>");
  expect(bg).not.toContain(">12</text>");
  expect(bg).toContain(">9</text>");
  // Seven marks on one line: six dots (hard, long, two easy rings, two rest specks) and a square for strength.
  expect((bg.match(/cy="84"/g) ?? []).length).toBe(6);
  expect((bg.match(/<rect x="[\d.]+" y="80.5" width="7"/g) ?? []).length).toBe(1);
  // Nothing on it that goes stale during the week.
  expect(bg).not.toMatch(/\d+ \/ \d+ KM|TODAY/);
  // Without the week, the face is as designed; a long focus is cut.
  expect(layers(paper)[`${IMAGE_NAMES.background}.png`]!.svg).toContain(">12</text>");
  expect(layers(paper, { week: { ...week, title: "Strength and mobility" } })[`${IMAGE_NAMES.background}.png`]!.svg).toContain(">STRENGTH.</text>");
});
