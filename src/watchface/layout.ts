/**
 * Tartan's own encoder for the Suunto Run 2 watch-face layout file (`dial_main.bin`, the
 * "kunming" analog faces, 466 × 466), and Tartan's analog face built with it.
 *
 * Written clean-room from docs/cleanroom/face-layout-spec.md alone (section numbers below refer to
 * it), plus Tartan's own image names and sizes (names.ts, package.ts) and the places its face art
 * leaves for the watch's data (tartan-face.ts). `encodeLayout` knows nothing about Tartan's design:
 * it writes whatever elements and properties it is given, computing every hash, count, offset,
 * resource and the string table itself.
 *
 * What remains a guess (the spec's open questions, §14): the meaning of header offset 208 (a
 * parameter here; the spec says try 0, the sample holds 0x1732), header offset 196 (`1`) and the
 * empty name at offset 4; whether offset 200 is the header size (376, what we write) or something
 * that happened to equal it; key 0x0B, the exact meaning of 0xCD and 0xCB and of align 9; whether
 * x/y may be negative (we refuse negatives); which 0xDC data ids mean which data, and whether 0xDB
 * is the slot number or the default choice; whether every element is required; whether the
 * filler after the string table may be zeros (the default) or must be the stale property bytes
 * the sample holds (`filler: "properties"`). For fixed complications, whether (0xD8, 0xD9) is
 * the centre or the top-left of what the watch draws isn't known either; Tartan gives centres.
 */

import { FACE_IMAGES } from "./package.ts";
import { IMAGE_NAMES } from "./names.ts";

// ------------------------------------------------------------------ the hash (§3)

/** FNV-1, 32-bit, top bit cleared, over the string's bytes (no NUL). */
export function faceHash(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = (Math.imul(h, 0x01000193) ^ b) >>> 0;
  return (h & 0x7fffffff) >>> 0;
}

// ------------------------------------------------------------------ the description

/** Element types seen (§6). Any 5-bit type may be written. */
export const ELEMENT_TYPE = { colourOption: 4, preview: 6, image: 7, fixedComplication: 16, selectableComplication: 18 } as const;

/** Property keys (§7). Any 16-bit key may be written. */
export const KEY = {
  width: 0x01,
  height: 0x04,
  x: 0x07,
  y: 0x08,
  align: 0x09,
  unknown0B: 0x0b,
  colour: 0x47,
  alpha: 0x48,
  scale: 0x6d,
  pivotX: 0x6f,
  pivotY: 0x70,
  widget: 0xc9,
  showActive: 0xca,
  showAlwaysOn: 0xcb,
  source: 0xcc,
  handMode: 0xcd,
  image: 0xce,
  colourOptions: 0xcf,
  colourList: 0xd2,
  dataType: 0xd6,
  template: 0xd7,
  anchorX: 0xd8,
  anchorY: 0xd9,
  slot: 0xdb,
  dataChoices: 0xdc,
  dataChoicesExtra: 0xdd,
} as const;

/** Resource kinds (§8): 1 = list of image names, 2 = list of values (colours or numbers). */
export const RESOURCE_KIND = { images: 1, values: 2 } as const;
export type ResourceKind = (typeof RESOURCE_KIND)[keyof typeof RESOURCE_KIND];

/** A plain value (flag 0): an unsigned 32-bit integer. */
export interface ValueProperty {
  key: number;
  value: number;
}
/**
 * A reference (flag 1) to a string resource: an `@`-separated list. `kind` defaults to 1 (image
 * names) for key 0xCE and 2 (values) for every other key, as the spec says.
 */
export interface RefProperty {
  key: number;
  ref: string;
  kind?: ResourceKind;
}
export type LayoutProperty = ValueProperty | RefProperty;

export interface LayoutElement {
  /** The firmware's interface name (e.g. `imgDialHour`), at most 60 ASCII bytes (its resources are named `<name>Res`). */
  name: string;
  /** 0–31 (§6). */
  type: number;
  /** In the order they're written. */
  properties: LayoutProperty[];
}

/** The header fields the spec can't explain, with the values it says to write. */
export interface LayoutHeader {
  /** Offset 0 and the trailer's first word: 0x86. */
  magic?: number;
  /** The name field at offset 4: empty. */
  name4?: string;
  /** Offset 196: 1. */
  field196?: number;
  /** Offset 200: 376 (the header size, as we read it). */
  field200?: number;
  /** Offset 204: 132 (the trailer size). */
  field204?: number;
  /** Offset 208: unknown; 0 here (the spec's first choice), 0x1732 in the sample. */
  field208?: number;
  /** Offset 356: 0. */
  field356?: number;
  /** Screen size at 360/362: 466 × 466. */
  width?: number;
  height?: number;
}

export interface LayoutDescription {
  /** The face name in the root record (hashed into offset 224). */
  name: string;
  /** Header offset 292. Default: the string the first preview element's 0xCE refers to. */
  preview?: string;
  /** Free text at offset 68. Default empty. */
  author?: string;
  /** `ver-YYYY/MM/DD`, in header and trailer. Default `ver-2026/10/25`. */
  version?: string;
  header?: LayoutHeader;
  /** In drawing order. Each one's index is its position. */
  elements: LayoutElement[];
  /** After the strings, up to the reserved size: zeros (default), or the sample's stale copy of the property bytes (§9). */
  filler?: "zeros" | "properties";
  /**
   * Treat the string table as this many bytes (zeros after the strings), when that's more than
   * the strings take. Header field 200 is 376 in the sample, which is both the header's size and
   * the sample's string-table length + 4; a face written with a 372-byte table is right under
   * either reading (on the watch, a 307-byte table drew none of the face's images).
   */
  stringsSize?: number;
}

// ------------------------------------------------------------------ list helpers

/** `@`-joined list (§8 rule 4). */
export const list = (items: Array<string | number>): string => items.map(String).join("@");
/** One colour item from `#rrggbb`: `0xRRGGBB`. */
export function colourItem(c: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(c)) throw new Error(`layout: ${c} isn't a #rrggbb colour`);
  return `0x${c.slice(1).toUpperCase()}`;
}
/** A colour list `0xRRGGBB@…` from `#rrggbb` colours. */
export const colourList = (cs: string[]): string => list(cs.map(colourItem));
/** A `#rrggbb` colour as the 0x00RRGGBB value of key 0x47. */
export const colourValue = (c: string): number => parseInt(colourItem(c).slice(2), 16);

// ------------------------------------------------------------------ the encoder (§4–§11)

export const LAYOUT_SIZES = { header: 376, element: 84, property: 24, resource: 92, trailer: 132, name: 64 } as const;
const { header: HEADER, element: ELEMENT, property: PROPERTY, resource: RESOURCE, trailer: TRAILER, name: NAME } = LAYOUT_SIZES;

const isRef = (p: LayoutProperty): p is RefProperty => "ref" in p;
const ascii = (s: string, what: string) => {
  if (!/^[\x01-\x7f]*$/.test(s)) throw new Error(`layout: ${what} must be ASCII without NUL: ${JSON.stringify(s)}`);
  return s;
};
const uint = (n: number, bits: number, what: string) => {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** bits) throw new Error(`layout: ${what} must be an integer 0…${2 ** bits - 1}, not ${n}`);
  return n;
};
const align4 = (n: number) => (n + 3) & ~3;

export interface LayoutResource {
  text: string;
  hash: number;
  owner: string;
  kind: ResourceKind;
  items: number;
  offset: number;
  length: number;
}

/** The resources a description makes, in first-reference order (§8 rule 1). */
export function layoutResources(d: LayoutDescription): LayoutResource[] {
  const out: LayoutResource[] = [];
  const seen = new Map<string, LayoutResource>();
  let offset = 0;
  for (const e of d.elements)
    for (const p of e.properties) {
      if (!isRef(p)) continue;
      const kind = p.kind ?? (p.key === KEY.image ? RESOURCE_KIND.images : RESOURCE_KIND.values);
      const had = seen.get(p.ref);
      if (had) {
        if (had.kind !== kind) throw new Error(`layout: "${p.ref}" is referred to both as kind ${had.kind} and ${kind}`);
        continue;
      }
      ascii(p.ref, "a resource string");
      const r: LayoutResource = { text: p.ref, hash: faceHash(p.ref), owner: `${e.name}Res`, kind, items: p.ref.split("@").length, offset, length: p.ref.length + 1 };
      uint(r.items, 8, `the item count of "${p.ref}"`);
      offset += r.length;
      seen.set(p.ref, r);
      out.push(r);
    }
  return out;
}

/** Encode a layout. Everything derived (hashes, counts, offsets, resources, padding) is computed here. */
export function encodeLayout(d: LayoutDescription): Uint8Array {
  const h = d.header ?? {};
  const E = d.elements.length;
  uint(E, 8, "the number of elements"); // the index is 8 bits
  const P = d.elements.reduce((n, e) => n + e.properties.length, 0);
  const res = layoutResources(d);
  const R = res.length;
  const S = Math.max(res.reduce((n, r) => n + r.length, 0), d.stringsSize ?? 0);
  const T = align4(Math.max(PROPERTY * P, S));
  const atElements = HEADER;
  const atProperties = atElements + ELEMENT * E;
  const atResources = atProperties + PROPERTY * P;
  const atStrings = atResources + RESOURCE * R;
  const atTrailer = atStrings + T;
  const out = new Uint8Array(atTrailer + TRAILER);
  const dv = new DataView(out.buffer);
  const u32 = (at: number, v: number, what: string) => dv.setUint32(at, uint(v, 32, what), true);
  const u16 = (at: number, v: number, what: string) => dv.setUint16(at, uint(v, 16, what), true);
  const name = (at: number, s: string, what: string) => {
    ascii(s, what);
    if (s.length > NAME - 1) throw new Error(`layout: ${what} is longer than ${NAME - 1} bytes: ${s}`);
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };

  const preview = d.preview ?? d.elements.find((e) => e.type === ELEMENT_TYPE.preview)?.properties.find((p): p is RefProperty => isRef(p) && p.key === KEY.image)?.ref ?? "";
  const version = d.version ?? "ver-2026/10/25";
  const magic = h.magic ?? 0x86;

  // ---- header (§5)
  u32(0, magic, "the magic");
  name(4, h.name4 ?? "", "the name at offset 4");
  name(68, d.author ?? "", "the author");
  name(132, version, "the version text");
  u32(196, h.field196 ?? 1, "header field 196");
  u32(200, h.field200 ?? HEADER, "header field 200");
  u32(204, h.field204 ?? TRAILER, "header field 204");
  u32(208, h.field208 ?? 0, "header field 208");
  u32(212, E, "E");
  u32(216, R, "R");
  u32(220, P, "P");
  u32(224, faceHash(ascii(d.name, "the face name")), "the root hash");
  name(228, d.name, "the face name");
  name(292, preview, "the preview name");
  u32(356, h.field356 ?? 0, "header field 356");
  u16(360, h.width ?? 466, "the screen width");
  u16(362, h.height ?? 466, "the screen height");

  // ---- elements (§6) and their properties (§7)
  const byText = new Map(res.map((r) => [r.text, r]));
  let at = atProperties;
  d.elements.forEach((e, index) => {
    const base = atElements + ELEMENT * index;
    if (e.name.length > NAME - 1 - 3) throw new Error(`layout: element name ${e.name} is too long for its resources' names`);
    u32(base, faceHash(ascii(e.name, "an element name")), "an element hash");
    name(base + 4, e.name, "an element name");
    const info = uint(e.type, 5, `${e.name}'s type`) | (index << 5) | (uint(e.properties.length, 19, `${e.name}'s property count`) * 2 ** 13);
    u32(base + 68, info >>> 0, "an info field");
    for (const p of e.properties) {
      u16(at, isRef(p) ? 1 : 0, "a flag");
      u16(at + 2, p.key, `a key of ${e.name}`);
      u32(at + 4, isRef(p) ? byText.get(p.ref)!.hash : p.value, `${e.name}'s value for key 0x${p.key.toString(16)}`);
      at += PROPERTY;
    }
  });

  // ---- resources and strings (§8)
  res.forEach((r, k) => {
    const base = atResources + RESOURCE * k;
    u32(base, r.hash, "a resource hash");
    name(base + 4, r.owner, "a resource name");
    out[base + 68] = r.kind;
    out[base + 69] = r.items;
    u32(base + 72, r.offset, "a string offset");
    u32(base + 76, r.length, "a string length");
    for (let i = 0; i < r.text.length; i++) out[atStrings + r.offset + i] = r.text.charCodeAt(i);
  });

  // ---- filler (§9): zeros already; or the stale property bytes the sample carries
  if (d.filler === "properties") for (let i = S; i < Math.min(T, PROPERTY * P); i++) out[atStrings + i] = out[atProperties + i]!;

  // ---- trailer (§10)
  u32(atTrailer, magic, "the magic");
  name(atTrailer + 4, version, "the version text");
  return out;
}

// ------------------------------------------------------------------ Tartan's face

/** A point on the screen (pixels from the top-left). */
export interface Point {
  x: number;
  y: number;
}
/** A selectable slot: its box (top-left, size) and the anchor of its content. */
export interface SlotPlace {
  x: number;
  y: number;
  size: number;
  anchor: Point;
}

/**
 * Where the watch draws its own data on Tartan's face. The compass, battery, day and both slots
 * come from the areas tartan-face.ts keeps free (its `watchData`, which imitates them); the status
 * icons have no place there, so they sit in the gap above the day, between the two slots.
 */
/**
 * Where the watch draws its own data: the top-left corner of each of its widgets (the watch picks
 * their size), worked out from where Tartan's face art (tartan-face.ts) leaves room for them.
 * Estimates from our own drawing, to be checked on the watch and nudged from what it shows.
 */
export const TARTAN_PLACES = {
  /** The compass, upper left: the art's disc is centred at (152, 152), radius 44; a ~104 box around it. */
  compass: { x: 100, y: 100 },
  /** The battery, along the rim between 8 and 10: the top-left of that arc's bounding box (radius 188). */
  battery: { x: 45, y: 139 },
  /** The day, at the bottom: the art's pill, 80 × 34, centred at (233, 378). */
  date: { x: 193, y: 361 },
  /** Ours: the status icons centred under 12, inside the hour marks (a ~60-wide row). */
  status: { x: 203, y: 60 },
  /** Data spot 1, lower left: the box of the art's circle of radius 56 at (157, 288). */
  slot1: { x: 101, y: 232, size: 112, anchor: { x: 101, y: 232 } },
  /** Data spot 2, right: the box of the art's circle of radius 100 at (334, 243). */
  slot2: { x: 234, y: 143, size: 200, anchor: { x: 234, y: 143 } },
} satisfies Record<string, Point | SlotPlace>;

/** What each fixed complication shows and how (§7.3). */
const FIXED = {
  fixedCompStatus: { data: 1, template: 2 },
  fixedCompass: { data: 21, template: 34 },
  fixedDate: { data: 3, template: 35 },
  fixedPower: { data: 2, template: 33 },
} as const;

export interface TartanLayoutOptions {
  /** The face name in the root record. Default "tartan". */
  name?: string;
  author?: string;
  version?: string;
  /** Header offset 208 (unknown). Default 0x00001732, the sample's value. */
  field208?: number;
  /** Other header fields, as `LayoutDescription.header`. */
  header?: Omit<LayoutHeader, "field208">;
  filler?: LayoutDescription["filler"];
  /** The string table's size (default 372, see LayoutDescription.stringsSize). */
  stringsSize?: number;
  /** Tint and alpha of the hour and minute hands (keys 0x47, 0x48): white and opaque leave the art as drawn. */
  handColour?: string;
  handAlpha?: number;
  /** The hands' two-colour list (key 0xD2). Default both white. */
  handColours?: [string, string];
  /** Image names by role, in place of IMAGE_NAMES (each role keeps its size from FACE_IMAGES). */
  images?: Partial<typeof IMAGE_NAMES>;
  /** Where the watch draws its data, in place of TARTAN_PLACES. */
  places?: Partial<typeof TARTAN_PLACES>;
  /** The data ids each slot offers, the first the default (key 0xDC). Their meaning isn't known yet. */
  slot1Data?: number[];
  slot2Data?: number[];
}

/** Tartan's face as a layout description (see `tartanLayout`). */
export function tartanDescription(seconds: string[], o: TartanLayoutOptions = {}): LayoutDescription {
  const names = { ...IMAGE_NAMES, ...o.images };
  if (seconds.length !== names.seconds.length) throw new Error(`layout: the face has ${names.seconds.length} seconds hands, so it needs ${names.seconds.length} colours`);
  const size = (role: Exclude<keyof typeof IMAGE_NAMES, "seconds"> | "seconds") => {
    const s = FACE_IMAGES[`${role === "seconds" ? IMAGE_NAMES.seconds[0] : IMAGE_NAMES[role]}.png`];
    if (!s) throw new Error(`layout: no size for the ${role} image`);
    return s;
  };
  const places = { ...TARTAN_PLACES, ...o.places };
  const white = "#ffffff";
  const handColours = colourList(o.handColours ?? [white, white]);

  const v = (key: number, value: number): ValueProperty => ({ key, value });
  const ref = (key: number, r: string): RefProperty => ({ key, ref: r });
  /**
   * The properties every image starts with (§12); centred on the screen (align 9). An image wider
   * than the screen (the background, 480 for 466) gets half the extra width as its x: Tartan's
   * background has been shown on the watch that way, its dial centred.
   */
  const image = (widget: number, source: number, alwaysOn: number, s: { width: number; height: number }) => [
    v(KEY.widget, widget),
    v(KEY.source, source),
    v(KEY.showActive, 1),
    v(KEY.showAlwaysOn, alwaysOn),
    v(KEY.x, Math.max(0, Math.round((s.width - 466) / 2))),
    v(KEY.y, 0),
    v(KEY.width, s.width),
    v(KEY.height, s.height),
    v(KEY.align, 9),
    v(KEY.unknown0B, 0),
    v(KEY.scale, 256),
  ];
  /** The pivot: the image's horizontal centre, at the screen centre's height in the (centred) image. */
  const pivot = (s: { width: number; height: number }) => [v(KEY.pivotX, Math.floor(s.width / 2)), v(KEY.pivotY, Math.floor(s.height / 2))];
  const hand = (name: string, source: number, img: string, s: { width: number; height: number }): LayoutElement => ({
    name,
    type: ELEMENT_TYPE.image,
    properties: [...image(3, source, 1, s), ...pivot(s), v(KEY.handMode, 2), v(KEY.colour, colourValue(o.handColour ?? white)), v(KEY.alpha, uint(o.handAlpha ?? 255, 8, "the hands' alpha")), ref(KEY.colourList, handColours), ref(KEY.image, img)],
  });
  const cap = (name: string, img: string, s: { width: number; height: number }): LayoutElement => ({ name, type: ELEMENT_TYPE.image, properties: [...image(3, 0, 1, s), ref(KEY.image, img)] });
  const fixed = (name: keyof typeof FIXED, at: Point): LayoutElement => ({
    name,
    type: ELEMENT_TYPE.fixedComplication,
    properties: [v(KEY.dataType, FIXED[name].data), v(KEY.template, FIXED[name].template), v(KEY.anchorX, at.x), v(KEY.anchorY, at.y)],
  });
  const slot = (n: 0 | 1, at: SlotPlace, ids: number[]): LayoutElement => ({
    name: `compBuildInOpt_${n + 1}`,
    type: ELEMENT_TYPE.selectableComplication,
    properties: [
      v(KEY.slot, n),
      v(KEY.template, n === 0 ? 31 : 32),
      v(KEY.x, at.x),
      v(KEY.y, at.y),
      v(KEY.width, at.size),
      v(KEY.height, at.size),
      v(KEY.unknown0B, 255),
      v(KEY.anchorX, at.anchor.x),
      v(KEY.anchorY, at.anchor.y),
      ref(KEY.dataChoices, list(ids)),
      ref(KEY.dataChoicesExtra, list(ids.map(() => 0))),
    ],
  });

  const secSize = size("seconds");
  return {
    name: o.name ?? "tartan",
    author: o.author ?? "tartan",
    version: o.version,
    preview: names.preview,
    header: { ...o.header, field208: o.field208 ?? 0x00001732 },
    // As the face the watch is known to draw: a 372-byte string table (header field 200 = 376 is
    // then right whichever it means) and the property bytes after the strings.
    filler: o.filler ?? "properties",
    stringsSize: o.stringsSize ?? 372,
    elements: [
      { name: "imgDialPreview", type: ELEMENT_TYPE.preview, properties: [ref(KEY.image, names.preview)] },
      { name: "imgDialMainBg", type: ELEMENT_TYPE.image, properties: [...image(1, 0, 0, size("background")), ref(KEY.image, names.background)] },
      hand("imgDialHour", 23, names.hour, size("hour")),
      hand("imgDialMin", 24, names.minute, size("minute")),
      cap("imgPinOne", names.capUnder, size("capUnder")),
      {
        name: "imgDialSec",
        type: ELEMENT_TYPE.image,
        // The default first, then one image per colour: colour i shows image i + 1 (§7.2).
        properties: [...image(3, 25, 0, secSize), ...pivot(secSize), v(KEY.handMode, 1), ref(KEY.image, list([names.seconds[0]!, ...names.seconds]))],
      },
      cap("imgPinTwo", names.capOver, size("capOver")),
      { name: "imgDialOptColor", type: ELEMENT_TYPE.colourOption, properties: [ref(KEY.colourOptions, colourList(seconds))] },
      fixed("fixedCompStatus", places.status),
      fixed("fixedCompass", places.compass),
      fixed("fixedDate", places.date),
      fixed("fixedPower", places.battery),
      slot(0, places.slot1, o.slot1Data ?? [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      slot(1, places.slot2, o.slot2Data ?? [16, 17, 18, 19, 20]),
    ],
  };
}

/**
 * Tartan's analog face as `dial_main.bin`: the background centred, the hour, minute and seconds
 * hands turning about the screen centre, the two caps centred, the seconds hand in the seven
 * given colours (`seconds`, "#rrggbb", the first the default), the preview, and the watch's own
 * status, compass, date, battery and two data slots where Tartan's art leaves room for them.
 */
export function tartanLayout(seconds: string[], o: TartanLayoutOptions = {}): Uint8Array {
  return encodeLayout(tartanDescription(seconds, o));
}
