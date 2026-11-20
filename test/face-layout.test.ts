import { describe, expect, test } from "bun:test";
import { encodeLayout, faceHash, tartanLayout, type LayoutDescription, type LayoutElement, type LayoutProperty } from "../src/watchface/layout.ts";
import { IMAGE_NAMES } from "../src/watchface/names.ts";
import { FACE_IMAGES } from "../src/watchface/package.ts";

const SEVEN = ["#ff6a4d", "#e0452b", "#fdf3ee", "#8fe3b4", "#a3c6ff", "#ffbe3d", "#ffffff"];
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

// ------------------------------------------------------------------ a tiny reader, written from the spec

interface Decoded {
  desc: LayoutDescription;
  E: number;
  P: number;
  R: number;
  at: { elements: number; properties: number; resources: number; strings: number; trailer: number };
  T: number;
  S: number;
  infos: number[];
  rootHash: number;
  elementHashes: number[];
  resources: Array<{ hash: number; owner: string; kind: number; items: number; offset: number; length: number; text: string }>;
  refs: Array<{ key: number; value: number }>;
  trailerMagic: number;
  trailerVersion: string;
}

function decode(b: Uint8Array): Decoded {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = (at: number) => dv.getUint32(at, true);
  const u16 = (at: number) => dv.getUint16(at, true);
  const name = (at: number) => {
    const f = b.subarray(at, at + 64);
    const end = f.indexOf(0);
    expect(end).toBeGreaterThanOrEqual(0);
    expect([...f.subarray(end)].every((x) => x === 0)).toBe(true);
    return new TextDecoder().decode(f.subarray(0, end));
  };
  const [E, R, P] = [u32(212), u32(216), u32(220)];
  const at = { elements: 376, properties: 376 + 84 * E, resources: 376 + 84 * E + 24 * P, strings: 376 + 84 * E + 24 * P + 92 * R, trailer: b.length - 132 };
  const T = at.trailer - at.strings;
  const resources = Array.from({ length: R }, (_, k) => {
    const base = at.resources + 92 * k;
    const offset = u32(base + 72);
    const length = u32(base + 76);
    const bytes = b.subarray(at.strings + offset, at.strings + offset + length);
    return { hash: u32(base), owner: name(base + 4), kind: b[base + 68]!, items: b[base + 69]!, offset, length, text: new TextDecoder().decode(bytes.subarray(0, length - 1)), nul: bytes[length - 1], zeros: [...b.subarray(base + 70, base + 72), ...b.subarray(base + 80, base + 92)] };
  });
  const byHash = new Map(resources.map((r) => [r.hash, r]));
  const refs: Decoded["refs"] = [];
  const elements: LayoutElement[] = [];
  const infos: number[] = [];
  const elementHashes: number[] = [];
  let p = at.properties;
  for (let i = 0; i < E; i++) {
    const base = at.elements + 84 * i;
    const info = u32(base + 68);
    infos.push(info);
    elementHashes.push(u32(base));
    expect([...b.subarray(base + 72, base + 84)].every((x) => x === 0)).toBe(true);
    const count = info >>> 13;
    const properties: LayoutProperty[] = [];
    for (let j = 0; j < count; j++, p += 24) {
      const flag = u16(p);
      const key = u16(p + 2);
      const value = u32(p + 4);
      expect([...b.subarray(p + 8, p + 24)].every((x) => x === 0)).toBe(true);
      expect(flag === 0 || flag === 1).toBe(true);
      if (flag === 1) {
        refs.push({ key, value });
        const r = byHash.get(value);
        expect(r).toBeDefined();
        properties.push({ key, ref: r!.text, kind: r!.kind as 1 | 2 });
      } else properties.push({ key, value });
    }
    elements.push({ name: name(base + 4), type: info & 31, properties });
  }
  for (const r of resources) {
    expect(r.nul).toBe(0);
    expect(r.zeros.every((x) => x === 0)).toBe(true);
  }
  const S = resources.reduce((n, r) => n + r.length, 0);
  return {
    desc: {
      name: name(228),
      preview: name(292),
      author: name(68),
      version: name(132),
      header: { magic: u32(0), name4: name(4), field196: u32(196), field200: u32(200), field204: u32(204), field208: u32(208), field356: u32(356), width: u16(360), height: u16(362) },
      elements,
    },
    E,
    P,
    R,
    at,
    T,
    S,
    infos,
    rootHash: u32(224),
    elementHashes,
    resources,
    refs,
    trailerMagic: u32(at.trailer),
    trailerVersion: name(at.trailer + 4),
  };
}

/** The spec's self-checks (§13, 1–5 and 7). */
function selfCheck(b: Uint8Array): Decoded {
  const d = decode(b);
  // 1. size, counts, trailer
  expect(b.length).toBe(376 + 84 * d.E + 24 * d.P + 92 * d.R + d.T + 132);
  // At least what the strings and the properties take (a face may pad its table, §9 and the watch notes).
  expect(d.T).toBeGreaterThanOrEqual((Math.max(24 * d.P, d.S) + 3) & ~3);
  expect(d.T % 4).toBe(0);
  expect(d.trailerMagic).toBe(d.desc.header!.magic!);
  expect(d.trailerVersion).toBe(d.desc.version!);
  expect([...b.subarray(d.at.trailer + 68)].every((x) => x === 0)).toBe(true);
  for (const at of Object.values(d.at)) expect(at % 4).toBe(0);
  expect(b.length % 4).toBe(0);
  // header zeros
  expect([...b.subarray(364, 376)].every((x) => x === 0)).toBe(true);
  // 2. elements
  d.desc.elements.forEach((e, i) => {
    expect(d.elementHashes[i]).toBe(faceHash(e.name));
    expect((d.infos[i]! >>> 5) & 0xff).toBe(i);
  });
  expect(d.infos.reduce((n, x) => n + (x >>> 13), 0)).toBe(d.P);
  // 3. resources
  let offset = 0;
  for (const r of d.resources) {
    expect(r.hash).toBe(faceHash(r.text));
    expect(r.offset).toBe(offset);
    expect(r.length).toBe(r.text.length + 1);
    expect(r.text.includes("\0")).toBe(false);
    expect(r.items).toBe(r.text.split("@").length);
    offset += r.length;
  }
  expect(d.S).toBe(offset);
  // string table NUL-terminated, then filler: zeros, or the property bytes at the same distance (§9)
  expect(b[d.at.strings + d.S - 1]).toBe(0);
  for (let i = d.S; i < d.T; i++) {
    const x = b[d.at.strings + i]!;
    if (x !== 0) expect(x).toBe(b[d.at.properties + i]!);
  }
  // 4. references
  const hashes = new Set(d.resources.map((r) => r.hash));
  for (const r of d.refs) expect(hashes.has(r.value)).toBe(true);
  for (const r of d.resources) expect(d.refs.some((x) => x.value === r.hash)).toBe(true);
  // kinds: 1 for 0xCE, else 2
  for (const e of d.desc.elements) for (const p of e.properties) if ("ref" in p) expect(p.kind).toBe(p.key === 0xce ? 1 : 2);
  // 5. root and preview
  expect(d.rootHash).toBe(faceHash(d.desc.name));
  const pv = d.desc.elements.find((e) => e.type === 6)?.properties.find((p) => "ref" in p && p.key === 0xce);
  expect(pv && "ref" in pv ? pv.ref : undefined).toBe(d.desc.preview);
  // 7. decode and encode again
  // (the filler and a padded table aren't in the description a reader recovers: try how faces write them)
  const again = [undefined, 372].flatMap((stringsSize) => (["zeros", "properties"] as const).map((filler) => encodeLayout({ ...d.desc, filler, stringsSize })));
  expect(again.some((x) => x.length === b.length && x.every((v, i) => v === b[i]))).toBe(true);
  return d;
}

// ------------------------------------------------------------------ the spec's vectors

describe("faceHash", () => {
  test("the spec's check values (§3, §13)", () => {
    const cases: Array<[string, number]> = [
      ["", 0x011c9dc5],
      ["a", 0x050c5d7e],
      ["pv", 0x617715cb],
      ["bg", 0x6f772ba0],
      ["hour", 0x55a08f93],
      ["demo", 0x6dd5a65c],
      ["0x123456@0x654321", 0x23eac6e7],
      ["imgDialPreview", 0x5de01cdc],
      ["imgDialMainBg", 0x7b1ede0a],
      ["imgDialHour", 0x0c010582],
      ["fixedDate", 0x735a4b95],
      ["tartan_hour_hand", 0x74d76130],
    ];
    for (const [s, h] of cases) expect(faceHash(s)).toBe(h);
  });
});

const v = (key: number, value: number): LayoutProperty => ({ key, value });
const demo = (hour = "hour"): LayoutDescription => ({
  name: "demo",
  preview: "pv",
  author: "tartan",
  version: "ver-2026/10/25",
  header: { field208: 0 },
  elements: [
    { name: "imgDialPreview", type: 6, properties: [{ key: 0xce, ref: "pv" }] },
    { name: "imgDialMainBg", type: 7, properties: [v(0xc9, 1), v(0xcc, 0), v(0xca, 1), v(0xcb, 0), v(0x07, 0), v(0x08, 0), v(0x01, 466), v(0x04, 466), v(0x09, 9), v(0x0b, 0), v(0x6d, 256), { key: 0xce, ref: "bg" }] },
    {
      name: "imgDialHour",
      type: 7,
      properties: [v(0xc9, 3), v(0xcc, 23), v(0xca, 1), v(0xcb, 1), v(0x07, 0), v(0x08, 0), v(0x01, 40), v(0x04, 466), v(0x09, 9), v(0x0b, 0), v(0x6d, 256), v(0x6f, 20), v(0x70, 233), v(0xcd, 2), v(0x47, 0x123456), v(0x48, 200), { key: 0xd2, ref: "0x123456@0x654321" }, { key: 0xce, ref: hour }],
    },
    { name: "fixedDate", type: 16, properties: [v(0xd6, 3), v(0xd7, 35), v(0xd8, 100), v(0xd9, 300)] },
  ],
});

describe("encodeLayout", () => {
  test("the spec's made-up file (§13)", () => {
    const b = encodeLayout(demo());
    const d = selfCheck(b);
    expect([d.E, d.R, d.P]).toEqual([4, 4, 35]);
    expect(d.infos).toEqual([0x00002006, 0x00018027, 0x00024047, 0x00008070]);
    expect(d.at.properties).toBe(712);
    expect(d.at.resources).toBe(1552);
    expect(d.at.strings).toBe(1920);
    expect(d.resources.map((r) => [r.owner, r.kind, r.items, r.offset, r.length])).toEqual([
      ["imgDialPreviewRes", 1, 1, 0, 3],
      ["imgDialMainBgRes", 1, 1, 3, 3],
      ["imgDialHourRes", 2, 2, 6, 18],
      ["imgDialHourRes", 1, 1, 24, 5],
    ]);
    expect(d.S).toBe(29);
    expect(d.T).toBe(840);
    expect(d.at.trailer).toBe(2760);
    expect(b.length).toBe(2892);
    expect(sha256(b)).toBe("977cab78c5c96e3388a2f1a59e359c41f2682e8a6f97b25b875a316d900f0fe3");
  });

  test("the preview name defaults to the preview element's image", () => {
    const { preview: _, ...rest } = demo();
    expect(sha256(encodeLayout(rest))).toBe("977cab78c5c96e3388a2f1a59e359c41f2682e8a6f97b25b875a316d900f0fe3");
  });

  test("a longer image name: its hash changes everywhere, later resources move (§13 check 6)", () => {
    const a = decode(encodeLayout(demo()));
    const bBytes = encodeLayout(demo("tartan_hour_hand"));
    const b = selfCheck(bBytes);
    const hourA = a.resources[3]!;
    const hourB = b.resources[3]!;
    expect(hourB.hash).toBe(0x74d76130);
    expect(hourB.hash).not.toBe(hourA.hash);
    expect(b.refs.filter((r) => r.key === 0xce).map((r) => r.value)).toContain(0x74d76130);
    expect(b.refs.some((r) => r.value === hourA.hash)).toBe(false);
    expect(b.S - a.S).toBe("tartan_hour_hand".length - "hour".length);
  });

  test("shared strings make one resource", () => {
    const d = demo();
    d.elements.push({ name: "imgDialMin", type: 7, properties: [{ key: 0xd2, ref: "0x123456@0x654321" }, { key: 0xce, ref: "min" }] });
    const x = selfCheck(encodeLayout(d));
    expect(x.R).toBe(5);
    expect(x.resources.filter((r) => r.text === "0x123456@0x654321")).toHaveLength(1);
  });

  test("a string table longer than the property section", () => {
    const long = Array.from({ length: 12 }, (_, i) => `a_rather_long_image_name_${i}`).join("@");
    const b = encodeLayout({ name: "x", elements: [{ name: "imgDialPreview", type: 6, properties: [{ key: 0xce, ref: "p" }] }, { name: "imgDialSec", type: 7, properties: [{ key: 0xce, ref: long }] }] });
    const d = selfCheck(b);
    expect(d.S).toBeGreaterThan(24 * d.P);
    expect(d.T).toBe((d.S + 3) & ~3);
  });

  test("the stale-property filler copies property bytes after the strings", () => {
    const b = encodeLayout({ ...demo(), filler: "properties" });
    const d = decode(b);
    expect(b.length).toBe(2892);
    expect([...b.subarray(d.at.strings + d.S, d.at.trailer)]).toEqual([...b.subarray(d.at.properties + d.S, d.at.properties + 24 * d.P)]);
  });

  test("refuses what the format can't hold", () => {
    expect(() => encodeLayout({ name: "x".repeat(64), elements: [] })).toThrow();
    expect(() => encodeLayout({ name: "x", elements: [{ name: "e", type: 32, properties: [] }] })).toThrow();
    expect(() => encodeLayout({ name: "x", elements: [{ name: "e", type: 7, properties: [{ key: 1, value: -1 }] }] })).toThrow();
    expect(() => encodeLayout({ name: "x", elements: [{ name: "e", type: 7, properties: [{ key: 0xce, ref: "a\0b" }] }] })).toThrow();
  });
});

// ------------------------------------------------------------------ Tartan's face

describe("tartanLayout", () => {
  const b = tartanLayout(SEVEN);
  const d = selfCheck(b);
  const el = (name: string) => d.desc.elements.find((e) => e.name === name)!;
  const val = (name: string, key: number) => {
    const p = el(name).properties.find((p) => p.key === key);
    return p && "value" in p ? p.value : p?.ref;
  };

  test("is self-consistent, with the elements in the spec's order", () => {
    expect(d.desc.elements.map((e) => [e.name, e.type, e.properties.length])).toEqual([
      ["imgDialPreview", 6, 1],
      ["imgDialMainBg", 7, 12],
      ["imgDialHour", 7, 18],
      ["imgDialMin", 7, 18],
      ["imgPinOne", 7, 12],
      ["imgDialSec", 7, 15],
      ["imgPinTwo", 7, 12],
      ["imgDialOptColor", 4, 1],
      ["fixedCompStatus", 16, 4],
      ["fixedCompass", 16, 4],
      ["fixedDate", 16, 4],
      ["fixedPower", 16, 4],
      ["compBuildInOpt_1", 18, 11],
      ["compBuildInOpt_2", 18, 11],
    ]);
    expect(d.desc.header!.field208).toBe(0x1732);
    expect(d.desc.preview).toBe(IMAGE_NAMES.preview);
    expect(d.desc.header!.width).toBe(466);
  });

  test("names our images, with the sizes our PNGs have", () => {
    const text = new TextDecoder().decode(b.subarray(d.at.strings, d.at.strings + d.S));
    for (const n of [IMAGE_NAMES.preview, IMAGE_NAMES.background, IMAGE_NAMES.hour, IMAGE_NAMES.minute, IMAGE_NAMES.capUnder, IMAGE_NAMES.capOver, ...IMAGE_NAMES.seconds]) expect(text).toContain(n);
    const roles: Array<[string, string]> = [
      ["imgDialMainBg", IMAGE_NAMES.background],
      ["imgDialHour", IMAGE_NAMES.hour],
      ["imgDialMin", IMAGE_NAMES.minute],
      ["imgPinOne", IMAGE_NAMES.capUnder],
      ["imgPinTwo", IMAGE_NAMES.capOver],
      ["imgDialSec", IMAGE_NAMES.seconds[0]!],
    ];
    for (const [e, n] of roles) {
      const s = FACE_IMAGES[`${n}.png`]!;
      // Centred (align 9); wider than the screen (the background): half the extra width as x.
      expect([val(e, 0x01), val(e, 0x04), val(e, 0x07), val(e, 0x08), val(e, 0x09)]).toEqual([s.width, s.height, Math.max(0, (s.width - 466) / 2), 0, 9]);
    }
    expect(val("imgDialSec", 0xce)).toBe([IMAGE_NAMES.seconds[0], ...IMAGE_NAMES.seconds].join("@"));
  });

  test("hands turn about the screen centre", () => {
    expect([val("imgDialHour", 0xcc), val("imgDialMin", 0xcc), val("imgDialSec", 0xcc)]).toEqual([23, 24, 25]);
    for (const e of ["imgDialHour", "imgDialMin", "imgDialSec"]) expect([val(e, 0x6f), val(e, 0x70)]).toEqual([(val(e, 0x01) as number) / 2, 233]);
    expect(val("imgDialHour", 0xd2)).toBe(val("imgDialMin", 0xd2));
  });

  test("offers the seven colours", () => {
    expect(val("imgDialOptColor", 0xcf)).toBe(SEVEN.map((c) => `0x${c.slice(1).toUpperCase()}`).join("@"));
    const text = new TextDecoder().decode(b);
    for (const c of SEVEN) expect(text).toContain(`0x${c.slice(1).toUpperCase()}`);
  });

  test("a 372-byte string table, so header field 200 (376) holds under either reading", () => {
    const f = tartanLayout(SEVEN);
    const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
    expect(v.getUint32(200, true)).toBe(376);
    const E = v.getUint32(212, true), R = v.getUint32(216, true), P = v.getUint32(220, true);
    const atStrings = 376 + 84 * E + 24 * P + 92 * R;
    // The table runs to the trailer (24P bytes here), the strings filling its first 372.
    expect(f.length - 132 - atStrings).toBe(Math.max(24 * P, 372));
    let last = 0;
    for (let r = 0; r < R; r++) last = Math.max(last, v.getUint32(376 + 84 * E + 24 * P + 92 * r + 72, true) + v.getUint32(376 + 84 * E + 24 * P + 92 * r + 76, true));
    expect(last).toBeLessThanOrEqual(372);
  });

  test("places the watch's data, and offers equal-length lists in the slots", () => {
    // The watch's widgets go by their top-left corner, around where the art leaves room.
    expect([val("fixedCompass", 0xd8), val("fixedCompass", 0xd9)]).toEqual([100, 100]);
    expect([val("fixedDate", 0xd8), val("fixedDate", 0xd9)]).toEqual([193, 361]);
    for (const s of ["compBuildInOpt_1", "compBuildInOpt_2"]) expect((val(s, 0xdd) as string).split("@").length).toBe((val(s, 0xdc) as string).split("@").length);
  });

  test("other image name lengths still give a consistent file", () => {
    const longer = tartanLayout(SEVEN, { images: { hour: "tartan_hour_hand", background: "bg", seconds: IMAGE_NAMES.seconds.map((n, i) => `${n}_v${i * 111}`) } });
    const x = selfCheck(longer);
    expect(x.S).not.toBe(d.S);
    expect(x.resources.some((r) => r.hash === 0x74d76130 && r.text === "tartan_hour_hand")).toBe(true);
  });

  test("header 208 can be overridden; the colours must be seven", () => {
    expect(decode(tartanLayout(SEVEN, { field208: 0 })).desc.header!.field208).toBe(0);
    expect(() => tartanLayout(SEVEN.slice(0, 6))).toThrow();
    expect(() => tartanLayout([...SEVEN.slice(0, 6), "red"])).toThrow();
  });
});
