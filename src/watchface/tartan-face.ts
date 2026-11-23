/**
 * Tartan's watch faces for the Suunto Run 2 (466 × 466 AMOLED), drawn from a design. Everything
 * the Run 2's analog face layout can show is a choice here: the background (black, a colour, a
 * gradient, a tartan plaid or a photo), the minute track (lanes, a filled band, one ring, dashes or
 * none) and its finish line, the marks (every minute, every five, the quarters; lines, bars or
 * dots), numerals (quarters, all, Roman), the T (top, bottom or none), a line of text, the hands
 * (classic, slim, baton, sword, arrow, skeleton), the seconds hand (needle, lollipop, arrow,
 * plain) and its seven colours, the caps, and the colour of every part. "Tartan Track" is the house
 * design; the face builder (Settings → More → Advanced → Watch face builder) makes others, starting from PRESETS.
 *
 * Each layer is an SVG the size of the image the face format wants (background 480 × 466, hands
 * 64 × 466 and 16 × 466 pointing up with their pivot at the centre, caps 64 × 70 and 32 × 36, a
 * 352 × 352 preview), named as src/watchface/names.ts says. The watch draws the date (at 3) and
 * the rest of what it shows itself, over this background (as the Suunto face it comes from does):
 * a compass at upper left, the battery as an arc between 8 and 10, the day at the bottom, and two
 * data spots you fill on the watch, a circle at lower left (12 kinds of data, heart rate first)
 * and a large circle on the right (5 kinds, steps first), all in the face's accent colour (the
 * first seconds colour). The dial keeps its own marks and numerals out of their way; `face()`
 * imitates them so the preview shows what the watch will.
 */

import { IMAGE_NAMES } from "./names.ts";

export const SCREEN = 466;
const C = SCREEN / 2;

export type Background =
  | { kind: "black" }
  | { kind: "colour"; colour: string }
  | { kind: "gradient"; from: string; to: string }
  | { kind: "tartan"; colour: string; dim: number }
  | { kind: "photo"; image: string; dim: number };

/** Patterns drawn over the ground, under the dial. */
export const ART = ["none", "sunburst", "stripes", "split", "rings", "zones", "contours", "checker", "lanes", "halftone", "watermark"] as const;
export type Art = (typeof ART)[number];
/** Heart-rate zone colours (the "zones" pattern), easy to hard. */
const ZONES = ["#8f817d", "#a3c6ff", "#8fe3b4", "#ffbe3d", "#e0452b"];

export interface FaceDesign {
  /** The face's id on the watch: 6 to 10 digits. */
  id: string;
  name: string;
  background: Background;
  /** A pattern over the ground, in `colours.art` ("zones" has its own colours). */
  art: Art;
  /** "bezel" is a wide band at the rim with the minutes written on it. */
  track: "lanes" | "filled" | "single" | "dashed" | "bezel" | "none";
  /** The finish line across the track at 12. */
  finish: boolean;
  marks: "all" | "fives" | "quarters" | "none";
  markShape: "line" | "bar" | "dot";
  /** At 12 and 9 (the only places the watch's own data leaves room), or one big 12 in place of the T. */
  numerals: "none" | "arabic" | "roman" | "big";
  /** What sits above the centre: the T, a short text, or nothing. */
  logo: "top" | "text" | "none";
  /** Up to 6 characters, shown when `logo` is "text". */
  text: string;
  hands: "classic" | "slim" | "baton" | "sword" | "arrow" | "skeleton" | "dauphine" | "block" | "pencil";
  secondsStyle: "needle" | "lollipop" | "arrow" | "plain";
  caps: "dot" | "ring" | "none";
  colours: {
    track: string;
    finish: string;
    marks: string;
    minor: string;
    numerals: string;
    logo: string;
    text: string;
    hands: string;
    caps: string;
    art: string;
  };
  /** The seven seconds-hand colours the watch offers; the first is the default. */
  seconds: string[];
}

export const COLOUR_PARTS = ["hands", "marks", "minor", "numerals", "track", "finish", "logo", "text", "caps", "art"] as const;

/** Colours for the seconds hand (the face format offers a choice on the watch). */
export const SECONDS: Array<[string, string]> = [
  ["Finish", "#ff6a4d"],
  ["Tartan", "#e0452b"],
  ["Cream", "#fdf3ee"],
  ["Infield", "#8fe3b4"],
  ["Lane blue", "#a3c6ff"],
  ["Amber", "#ffbe3d"],
  ["White", "#ffffff"],
];
const SEC_WARM = ["#ff6a4d", "#e0452b", "#fdf3ee", "#8fe3b4", "#a3c6ff", "#ffbe3d", "#ffffff"];

const base = {
  art: "none",
  finish: true,
  marks: "all",
  markShape: "line",
  numerals: "none",
  logo: "top",
  text: "",
  hands: "classic",
  secondsStyle: "needle",
  caps: "dot",
} as const;

/** The house face: AMOLED black, everything in tartan red, only thin lines lit. */
export const TARTAN_TRACK_DESIGN: FaceDesign = {
  ...base,
  id: "2026101601",
  name: "Tartan Track",
  background: { kind: "black" },
  track: "lanes",
  colours: { track: "#7d2615", finish: "#ff6a4d", marks: "#e0452b", minor: "#7d2615", numerals: "#e0452b", logo: "#e0452b", text: "#b83a24", hands: "#e0452b", caps: "#e0452b", art: "#3d120a" },
  seconds: [...SEC_WARM],
};

type Preset = Omit<FaceDesign, "id">;
type Colours = FaceDesign["colours"];
/** Every part in one colour, then the exceptions. */
const ink = (c: string, rest: Partial<Colours> = {}): Colours => ({ track: c, finish: c, marks: c, minor: c, numerals: c, logo: c, text: c, hands: c, caps: c, art: c, ...rest });
/** The seconds colours with `first` (also the colour the watch draws its data in) as the default. */
const sec = (first: string) => [first, ...SEC_WARM.filter((x) => x !== first)].slice(0, 7);
const preset = (p: Partial<Preset> & Pick<Preset, "name" | "colours">): Preset => ({ ...base, background: { kind: "black" }, track: "lanes", seconds: [...SEC_WARM], ...p });

/** Starting points in the builder (each becomes a new face with its own id), each its own look. */
export const PRESETS: Preset[] = [
  { ...TARTAN_TRACK_DESIGN, name: "Tartan Track" },
  preset({
    name: "Signal Red",
    background: { kind: "colour", colour: "#c8371f" },
    track: "none",
    finish: false,
    marks: "fives",
    markShape: "bar",
    numerals: "big",
    logo: "none",
    hands: "block",
    secondsStyle: "plain",
    colours: ink("#ffffff", { minor: "#f08a74", caps: "#201a19" }),
    seconds: sec("#ffffff"),
  }),
  preset({
    name: "Plaid",
    background: { kind: "tartan", colour: "#a8321f", dim: 0.2 },
    track: "single",
    finish: false,
    marks: "fives",
    markShape: "bar",
    hands: "sword",
    colours: ink("#fdf3ee"),
    seconds: sec("#ffbe3d"),
  }),
  preset({
    name: "Chequered Flag",
    art: "checker",
    track: "none",
    finish: false,
    marks: "quarters",
    markShape: "bar",
    numerals: "big",
    logo: "none",
    hands: "baton",
    secondsStyle: "lollipop",
    colours: ink("#ffffff", { minor: "#5a5250", caps: "#e0452b" }),
    seconds: sec("#e0452b"),
  }),
  preset({
    name: "Heart Zones",
    art: "zones",
    track: "none",
    finish: false,
    marks: "fives",
    markShape: "dot",
    hands: "slim",
    caps: "ring",
    colours: ink("#fdf3ee", { marks: "#8f817d", minor: "#3d3634", logo: "#e0452b" }),
    seconds: sec("#ff6a4d"),
  }),
  preset({
    name: "Podium",
    background: { kind: "colour", colour: "#1e1305" },
    art: "sunburst",
    track: "single",
    finish: false,
    marks: "fives",
    markShape: "dot",
    numerals: "roman",
    logo: "none",
    hands: "dauphine",
    colours: ink("#ffbe3d", { track: "#b8860b", minor: "#5c4310", art: "#2c1d08" }),
    seconds: sec("#ffbe3d"),
  }),
  preset({
    name: "Racing Stripes",
    background: { kind: "colour", colour: "#163a7a" },
    art: "stripes",
    track: "none",
    finish: false,
    marks: "fives",
    markShape: "bar",
    logo: "none",
    hands: "block",
    secondsStyle: "plain",
    colours: ink("#ffffff", { hands: "#e0452b", caps: "#e0452b", minor: "#6f8fbf", art: "#f4f1ea" }),
    seconds: sec("#ffbe3d"),
  }),
  preset({
    name: "Trail",
    art: "contours",
    track: "none",
    finish: false,
    marks: "fives",
    markShape: "dot",
    hands: "pencil",
    secondsStyle: "arrow",
    colours: ink("#8fe3b4", { minor: "#1f5c3a", art: "#1c4a30", hands: "#fdf3ee" }),
    seconds: sec("#8fe3b4"),
  }),
  preset({
    name: "Lane Eight",
    background: { kind: "colour", colour: "#a8321f" },
    art: "lanes",
    track: "none",
    finish: false,
    marks: "none",
    logo: "text",
    text: "LANE 8",
    hands: "block",
    secondsStyle: "plain",
    colours: ink("#ffffff", { art: "#f4d9cf", caps: "#201a19" }),
    seconds: sec("#ffffff"),
  }),
  preset({
    name: "Day and Night",
    background: { kind: "colour", colour: "#fdf3ee" },
    art: "split",
    track: "single",
    finish: false,
    marks: "fives",
    markShape: "bar",
    hands: "sword",
    colours: ink("#e0452b", { minor: "#e0452b", art: "#201a19" }),
    seconds: sec("#e0452b"),
  }),
  preset({
    name: "Target",
    art: "rings",
    track: "none",
    finish: false,
    marks: "quarters",
    markShape: "bar",
    logo: "none",
    hands: "arrow",
    secondsStyle: "arrow",
    colours: ink("#fdf3ee", { marks: "#ff6a4d", art: "#2a0e08", caps: "#ff6a4d" }),
    seconds: sec("#ff6a4d"),
  }),
  preset({
    name: "Paper",
    background: { kind: "colour", colour: "#fbf7f6" },
    track: "bezel",
    finish: false,
    numerals: "arabic",
    colours: ink("#201a19", { minor: "#a8968f", logo: "#a8321f", caps: "#a8321f" }),
    seconds: sec("#a8321f"),
  }),
  preset({
    name: "Big T",
    art: "watermark",
    track: "none",
    finish: false,
    marks: "all",
    logo: "none",
    hands: "skeleton",
    caps: "ring",
    colours: ink("#fdf3ee", { marks: "#e0452b", minor: "#3d3634", art: "#3a120a", caps: "#e0452b" }),
    seconds: sec("#e0452b"),
  }),
  preset({
    name: "Minimal",
    track: "none",
    finish: false,
    marks: "quarters",
    logo: "none",
    hands: "slim",
    secondsStyle: "plain",
    caps: "ring",
    colours: ink("#fdf3ee", { minor: "#3d3634" }),
    seconds: sec("#ffffff"),
  }),
  preset({
    name: "Night Run",
    track: "none",
    finish: false,
    marks: "fives",
    logo: "none",
    hands: "baton",
    colours: ink("#7d2615", { hands: "#a8321f", caps: "#a8321f", minor: "#3d120a" }),
    seconds: ["#7d2615", "#a8321f", "#e0452b", "#ff6a4d", "#8f817d", "#5a5250", "#3d120a"],
  }),
  preset({
    name: "Ice",
    background: { kind: "gradient", from: "#1d3557", to: "#000000" },
    art: "halftone",
    track: "none",
    finish: false,
    marks: "fives",
    hands: "sword",
    colours: ink("#ffffff", { minor: "#2a5fa8", logo: "#a3c6ff", art: "#2a5fa8", caps: "#a3c6ff" }),
    seconds: sec("#a3c6ff"),
  }),
  preset({
    name: "Racing Green",
    background: { kind: "colour", colour: "#0f2a1c" },
    track: "bezel",
    finish: false,
    marks: "fives",
    markShape: "bar",
    hands: "dauphine",
    colours: ink("#fdf3ee", { track: "#1f5c3a", minor: "#4f9a6f", logo: "#ffbe3d", caps: "#ffbe3d" }),
    seconds: sec("#ffbe3d"),
  }),
  preset({
    name: "Marathon",
    track: "bezel",
    marks: "all",
    hands: "sword",
    logo: "text",
    text: "42.195",
    colours: ink("#fdf3ee", { track: "#c8371f", finish: "#ffffff", minor: "#5a5250", text: "#ff6a4d", caps: "#ff6a4d" }),
    seconds: sec("#ff6a4d"),
  }),
  preset({
    name: "Dawn",
    background: { kind: "gradient", from: "#ff7a4d", to: "#3d120a" },
    track: "none",
    finish: false,
    marks: "fives",
    markShape: "bar",
    numerals: "big",
    logo: "none",
    hands: "baton",
    colours: ink("#1b0f0c", { marks: "#fdf3ee", minor: "#fdf3ee", numerals: "#1b0f0c" }),
    seconds: sec("#fdf3ee"),
  }),
];

const HEX = /^#[0-9a-f]{6}$/i;
const MAX_PHOTO = 1_500_000;
const oneOf = <T extends string>(v: unknown, all: readonly T[], dflt: T): T => (all.includes(v as T) ? (v as T) : dflt);

/**
 * A design as it may be saved and installed: missing choices (an older face) take their
 * defaults; anything the watch couldn't show is refused.
 */
export function checkDesign(d: unknown): FaceDesign {
  const x = (d ?? {}) as Omit<Partial<FaceDesign>, "logo"> & { logo?: unknown };
  const fail = (why: string): never => {
    throw new Error(`Face: ${why}`);
  };
  if (typeof x !== "object") fail("not a design");
  if (typeof x.id !== "string" || !/^\d{6,10}$/.test(x.id) || Number(x.id) > 2147483647) fail("the id must be 6 to 10 digits");
  const name = typeof x.name === "string" ? x.name.trim().slice(0, 30) : "";
  if (!name) fail("give the face a name");
  const bg = x.background as Background | undefined;
  let background: Background = { kind: "black" };
  if (bg?.kind === "colour") background = HEX.test(bg.colour) ? { kind: "colour", colour: bg.colour.toLowerCase() } : fail("background colour");
  else if (bg?.kind === "gradient") background = HEX.test(bg.from) && HEX.test(bg.to) ? { kind: "gradient", from: bg.from.toLowerCase(), to: bg.to.toLowerCase() } : fail("gradient colours");
  else if (bg?.kind === "tartan") background = HEX.test(bg.colour) && bg.dim >= 0 && bg.dim <= 0.9 ? { kind: "tartan", colour: bg.colour.toLowerCase(), dim: Math.round(bg.dim * 100) / 100 } : fail("tartan background");
  else if (bg?.kind === "photo") {
    if (typeof bg.image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(bg.image) || bg.image.length > MAX_PHOTO || !(bg.dim >= 0 && bg.dim <= 0.9)) fail("photo");
    background = { kind: "photo", image: bg.image, dim: Math.round(bg.dim * 100) / 100 };
  } else if (bg && bg.kind !== "black") fail("background");
  const c = (x.colours ?? {}) as Partial<FaceDesign["colours"]>;
  const colours = {} as FaceDesign["colours"];
  for (const k of COLOUR_PARTS) {
    // Faces from before numerals, text and patterns existed take the marks' or the track's colour.
    const v = c[k] ?? (k === "numerals" || k === "text" ? c.marks : k === "art" ? c.track : undefined);
    if (!HEX.test(v ?? "")) fail(`${k} colour`);
    colours[k] = v!.toLowerCase();
  }
  if (!Array.isArray(x.seconds) || x.seconds.length !== 7 || !x.seconds.every((s) => HEX.test(s))) fail("seven seconds colours");
  const logo = x.logo === true || x.logo === "bottom" ? "top" : x.logo === false ? "none" : oneOf(x.logo, ["top", "text", "none"] as const, "top");
  return {
    id: x.id!,
    name,
    background,
    art: oneOf(x.art, ART, "none"),
    track: oneOf(x.track, ["lanes", "filled", "single", "dashed", "bezel", "none"] as const, "lanes"),
    finish: x.finish !== false,
    marks: oneOf(x.marks, ["all", "fives", "quarters", "none"] as const, "all"),
    markShape: oneOf(x.markShape, ["line", "bar", "dot"] as const, "line"),
    numerals: x.numerals === ("quarters" as string) || x.numerals === ("all" as string) ? "arabic" : oneOf(x.numerals, ["none", "arabic", "roman", "big"] as const, "none"),
    logo,
    text: typeof x.text === "string" ? x.text.replace(/[^\p{L}\p{N} .,:;'!?&+/#()-]/gu, "").slice(0, 6) : "",
    hands: oneOf(x.hands, ["classic", "slim", "baton", "sword", "arrow", "skeleton", "dauphine", "block", "pencil"] as const, "classic"),
    secondsStyle: oneOf(x.secondsStyle, ["needle", "lollipop", "arrow", "plain"] as const, "needle"),
    caps: oneOf(x.caps, ["dot", "ring", "none"] as const, "dot"),
    colours,
    seconds: x.seconds!.map((s) => s.toLowerCase()),
  };
}

/** A fresh id for a new face (from 2 000 000 000, under the watch's 31-bit limit). */
export const newFaceId = () => String(2_000_000_000 + Math.floor(Math.random() * 147_000_000));

// ------------------------------------------------------------------ drawing

// The T (brand/logo.svg), drawn in its own 698 × 595 box.
const T_BOX = { x: 92, y: 150, w: 698, h: 595 };
const T_PATHS = [
  "M167,150H720A70,70 0 0 1 790,220V298A70,70 0 0 1 720,368H615A197.7,197.7 0 0 0 425,225H92A75,75 0 0 1 167,150Z",
  "M92,247H425A167,167 0 0 1 592,414V665A77,80 0 0 1 515,745V428A145,145 0 0 0 370,283H92Z",
  "M92,303H370A119,119 0 0 1 489,422V745H373V425A53,55 0 0 0 320,370H165A73,67 0 0 1 92,303Z",
];

const f = (n: number) => Number(n.toFixed(2));
const polar = (r: number, deg: number): [number, number] => [f(C + r * Math.sin((deg * Math.PI) / 180)), f(C - r * Math.cos((deg * Math.PI) / 180))];
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
let uid = 0;

/** Options for drawing: `font`, a data URL of the numerals' typeface (needed when the SVG becomes an image). */
export interface DrawOptions {
  font?: string;
  /** The week on the face: what each day holds, the week's focus and its kilometres. */
  week?: WeekOnFace;
}
/**
 * The week on a face: only what stays true all week, since a face is a picture made once (the
 * watch draws the date itself, so today is the dot under it). Re-sent when the week changes.
 */
export interface WeekOnFace {
  /** Monday to Sunday: what each day holds. */
  days: Array<"hard" | "long" | "easy" | "strength" | "rest">;
  /** The week's focus ("Build", "Taper"), or "Rest" for an empty week. */
  title: string;
  planned_km: number;
}

/** The week, above the centre in place of the T: a mark per day by what it holds, the focus, the km. */
function weekLayer(w: WeekOnFace, d: FaceDesign): string {
  const c = d.colours;
  const accent = d.seconds[0]!;
  const out: string[] = [];
  // Seven marks, Monday first: hard and long filled in the accent (long bigger), easy an outline,
  // strength a small square, rest a speck.
  w.days.forEach((k, i) => {
    const x = C + (i - 3) * 15;
    const y = 84;
    if (k === "hard") out.push(`<circle cx="${x}" cy="${y}" r="5" fill="${accent}"/>`);
    else if (k === "long") out.push(`<circle cx="${x}" cy="${y}" r="6.5" fill="${accent}"/>`);
    else if (k === "easy") out.push(`<circle cx="${x}" cy="${y}" r="4" fill="none" stroke="${c.marks}" stroke-width="1.8"/>`);
    else if (k === "strength") out.push(`<rect x="${f(x - 3.5)}" y="${f(y - 3.5)}" width="7" height="7" rx="1" fill="${c.marks}"/>`);
    else out.push(`<circle cx="${x}" cy="${y}" r="1.8" fill="${c.minor}"/>`);
  });
  const title = w.title.replace(/[×✕]/g, "x").replace(/[^\x20-\x7e]/g, "").trim().toUpperCase();
  const short = title.length > 10 ? `${title.slice(0, 9).trimEnd()}.` : title;
  out.push(`<text x="${C}" y="128" text-anchor="middle" font-family="${FAMILY}" font-weight="600" font-size="26" fill="${c.numerals}">${esc(short || "REST")}</text>`);
  if (w.planned_km > 0) out.push(`<text x="${C}" y="152" text-anchor="middle" font-family="${FAMILY}" font-weight="600" font-size="16" letter-spacing="0.5" fill="${c.text}">${Math.round(w.planned_km)} KM</text>`);
  return out.join("");
}
const FONT = "TartanFace";
const fontFace = (o?: DrawOptions) => (o?.font ? `<style>@font-face{font-family:${FONT};src:url(${o.font}) format("woff2");font-weight:600}</style>` : "");
const FAMILY = `${FONT}, 'Barlow Condensed', 'Arial Narrow', sans-serif`;

function logo(cx: number, top: number, width: number, fill: string): string {
  const k = width / T_BOX.w;
  return `<g transform="translate(${f(cx - width / 2)} ${f(top)}) scale(${f(k)}) translate(${-T_BOX.x} ${-T_BOX.y})" fill="${fill}">${T_PATHS.map((d) => `<path d="${d}"/>`).join("")}</g>`;
}

/** Black or near-white, whichever reads on `bg`. */
function onColour(bg: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.55 ? "#201a19" : "#fdf3ee";
}

/** An arc along radius `r` from `a0` to `a1` degrees (clockwise from 12). */
function arc(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}`;
}

/** The pattern over the ground, across the whole image (`x0` to `x0 + width`). */
function artLayer(d: FaceDesign, x0: number, width: number): string {
  const c = d.colours.art;
  const out: string[] = [];
  switch (d.art) {
    case "sunburst":
      for (let i = 0; i < 36; i += 2) {
        const [ax, ay] = polar(420, i * 10);
        const [bx, by] = polar(420, (i + 1) * 10);
        out.push(`M${C},${C} L${ax},${ay} L${bx},${by}Z`);
      }
      return `<path d="${out.join("")}" fill="${c}"/>`;
    case "stripes":
      return `<rect x="${C - 62}" width="44" height="${SCREEN}" fill="${c}"/><rect x="${C + 18}" width="44" height="${SCREEN}" fill="${c}"/>`;
    case "split":
      return `<path d="M${x0 + width},-1 L${x0 + width},${SCREEN} L${x0},${SCREEN}Z" fill="${c}"/>`;
    case "rings":
      for (let r = 20; r < 250; r += 40) out.push(`<circle cx="${C}" cy="${C}" r="${r}" fill="none" stroke="${c}" stroke-width="20"/>`);
      return out.join("");
    case "zones":
      // Five heart-rate zones round the rim, from 7 o'clock to 5, easy to hard.
      return ZONES.map((z, i) => `<path d="${arc(219, 210 + i * 60 + 2, 210 + (i + 1) * 60 - 2)}" fill="none" stroke="${z}" stroke-width="22"/>`).join("");
    case "contours": {
      // Height lines round a hill to the lower right.
      const [hx, hy] = [318, 316];
      for (let k = 1; k <= 16; k++) {
        const pts: string[] = [];
        for (let a = 0; a < 72; a++) {
          const t = (a / 72) * 2 * Math.PI;
          const r = 24 * k * (1 + 0.13 * Math.sin(3 * t + k * 0.7) + 0.07 * Math.sin(5 * t - k * 0.4));
          pts.push(`${f(hx + r * Math.cos(t))},${f(hy + r * Math.sin(t))}`);
        }
        out.push(`M${pts.join("L")}Z`);
      }
      return `<path d="${out.join("")}" fill="none" stroke="${c}" stroke-width="2.4"/>`;
    }
    case "checker": {
      // Two rows of squares round the rim, offset by one.
      const row = (r: number, offset: number) => `<circle cx="${C}" cy="${C}" r="${r}" fill="none" stroke="${c}" stroke-width="13" pathLength="96" stroke-dasharray="1 1" stroke-dashoffset="${offset}" transform="rotate(-90 ${C} ${C})"/>`;
      return row(212.5, 0) + row(225.5, 1);
    }
    case "lanes":
      // A straight seen from above: lane lines across the face.
      for (let k = -4; k <= 4; k++) out.push(`<rect x="${f(C + k * 58 - 1.5)}" width="3" height="${SCREEN}" fill="${c}"/>`);
      return out.join("");
    case "halftone":
      // Dots growing towards the rim.
      for (let y = 8; y < SCREEN; y += 16)
        for (let x = x0 + 8; x < x0 + width; x += 16) {
          const dist = Math.hypot(x - C, y - C) / C;
          if (dist > 1.04) continue;
          out.push(`<circle cx="${x}" cy="${y}" r="${f(0.6 + 4.6 * dist ** 1.6)}"/>`);
        }
      return `<g fill="${c}">${out.join("")}</g>`;
    case "watermark":
      return logo(C, 92, 330, c);
    default:
      return "";
  }
}

const ROMAN = ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];

/** The dial: everything that doesn't move. `width` 480 matches the package's background image. */
export function dial(d: FaceDesign = TARTAN_TRACK_DESIGN, width = SCREEN, o?: DrawOptions): string {
  const dx = (width - SCREEN) / 2;
  const R_OUT = 224;
  const R_IN = 200;
  const c = d.colours;
  const id = ++uid;
  const defs: string[] = [];
  const parts: string[] = [];
  // ---- the ground
  const bg = d.background;
  const ground = bg.kind === "colour" ? bg.colour : "#000";
  parts.push(`<rect x="${-dx}" width="${width}" height="${SCREEN}" fill="${ground}"/>`);
  if (bg.kind === "gradient") {
    defs.push(`<radialGradient id="g${id}" cx="${C}" cy="${C}" r="${C + dx}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${bg.from}"/><stop offset="1" stop-color="${bg.to}"/></radialGradient>`);
    parts.push(`<rect x="${-dx}" width="${width}" height="${SCREEN}" fill="url(#g${id})"/>`);
  } else if (bg.kind === "tartan") {
    // A plaid: the colour as ground, broad dark bands and fine light lines both ways.
    const s = 72;
    const band = (horizontal: boolean) => {
      const r = (x: number, y: number, w: number, h: number, fill: string, op: number) => (horizontal ? `<rect x="${y}" y="${x}" width="${h}" height="${w}" fill="${fill}" fill-opacity="${op}"/>` : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" fill-opacity="${op}"/>`);
      return [r(0, 0, 22, s, "#000", 0.42), r(30, 0, 6, s, "#000", 0.3), r(48, 0, 2, s, "#fdf3ee", 0.45), r(58, 0, 3, s, "#ffbe3d", 0.22)].join("");
    };
    defs.push(`<pattern id="p${id}" width="${s}" height="${s}" patternUnits="userSpaceOnUse"><rect width="${s}" height="${s}" fill="${bg.colour}"/>${band(false)}${band(true)}</pattern>`);
    parts.push(`<rect x="${-dx}" width="${width}" height="${SCREEN}" fill="url(#p${id})"/>`);
    if (bg.dim > 0) parts.push(`<rect x="${-dx}" width="${width}" height="${SCREEN}" fill="#000" fill-opacity="${bg.dim}"/>`);
  } else if (bg.kind === "photo") {
    if (bg.image) parts.push(`<image href="${esc(bg.image)}" x="0" y="0" width="${SCREEN}" height="${SCREEN}" preserveAspectRatio="xMidYMid slice"/>`);
    if (bg.dim > 0) parts.push(`<rect x="${-dx}" width="${width}" height="${SCREEN}" fill="#000" fill-opacity="${bg.dim}"/>`);
  }
  parts.push(artLayer(d, -dx, width));
  // ---- the track
  const mid = (R_OUT + R_IN) / 2;
  if (d.track === "filled") parts.push(`<circle cx="${C}" cy="${C}" r="${mid}" fill="none" stroke="${c.track}" stroke-width="${R_OUT - R_IN}"/>`);
  if (d.track === "lanes" || d.track === "filled") {
    const lane = d.track === "filled" ? "rgba(0,0,0,0.38)" : c.track;
    for (let i = 0; i <= 3; i++) parts.push(`<circle cx="${C}" cy="${C}" r="${R_IN + i * 8}" fill="none" stroke="${lane}" stroke-width="${i === 0 || i === 3 ? 2 : 1.4}"/>`);
  } else if (d.track === "single") parts.push(`<circle cx="${C}" cy="${C}" r="${R_OUT - 4}" fill="none" stroke="${c.track}" stroke-width="3"/>`);
  else if (d.track === "bezel") {
    // A wide band at the rim, the minutes written on it, upright on both halves.
    const r = 219;
    const ink = onColour(c.track);
    parts.push(`<circle cx="${C}" cy="${C}" r="${r}" fill="none" stroke="${c.track}" stroke-width="30"/>`);
    for (let m = 5; m < 60; m += 5) {
      const deg = m * 6;
      const [x, y] = polar(r, deg);
      const turn = deg > 90 && deg < 270 ? deg + 180 : deg;
      parts.push(`<text x="${x}" y="${f(y + 6)}" text-anchor="middle" font-family="${FAMILY}" font-weight="600" font-size="17" fill="${ink}" transform="rotate(${turn} ${x} ${y})">${m}</text>`);
    }
  } else if (d.track === "dashed") parts.push(`<circle cx="${C}" cy="${C}" r="${mid}" fill="none" stroke="${c.track}" stroke-width="${R_OUT - R_IN - 8}" stroke-dasharray="${f((2 * Math.PI * mid) / 120)} ${f((2 * Math.PI * mid) / 120)}" transform="rotate(-90 ${C} ${C})"/>`);
  if (d.finish && d.track !== "none") {
    const fw = 6;
    const [outer, innerR] = d.track === "bezel" ? [SCREEN / 2, 204] : [R_OUT, R_IN];
    parts.push(`<rect x="${C - fw / 2}" y="${C - outer}" width="${fw}" height="${outer - innerR}" fill="${c.finish}"/>`);
    for (let i = 0; i < 4; i++) parts.push(`<rect x="${C + fw / 2}" y="${f(C - outer + (i * (outer - innerR)) / 4)}" width="3" height="${f((outer - innerR) / 8)}" fill="${c.finish}"/>`);
  }
  // ---- marks inside the track
  for (let m = 0; m < 60; m++) {
    const five = m % 5 === 0;
    const quarter = m % 15 === 0;
    if (d.marks === "none" || (d.marks === "fives" && !five) || (d.marks === "quarters" && !quarter)) continue;
    // The watch draws the battery as an arc between 8 and 10.
    if (m > 40 && m < 50) continue;
    const colour = m === 0 && d.finish ? c.finish : five ? c.marks : c.minor;
    const deg = m * 6;
    if (d.markShape === "dot") {
      const [x, y] = polar(182, deg);
      parts.push(`<circle cx="${x}" cy="${y}" r="${five ? (quarter ? 7 : 5) : 2.2}" fill="${colour}"/>`);
    } else if (d.markShape === "bar" && five) {
      const w = quarter ? 12 : 8;
      const len = quarter ? 30 : 24;
      parts.push(`<rect x="${C - w / 2}" y="${C - 192}" width="${w}" height="${len}" rx="2" fill="${colour}" transform="rotate(${deg} ${C} ${C})"/>`);
    } else {
      const [x1, y1] = polar(five ? 166 : 182, deg);
      const [x2, y2] = polar(190, deg);
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colour}" stroke-width="${five ? (quarter && d.marks === "quarters" ? 7 : m === 0 ? 7 : 5) : 2}" stroke-linecap="round"/>`);
    }
  }
  // ---- numerals at 12 and 9: everywhere else the watch draws its own data
  // (The week, when it's on the face, takes the place of the 12.)
  if (d.numerals === "big" && o?.week) {
    // no 12
  } else if (d.numerals === "big") parts.push(`<text x="${C}" y="140" text-anchor="middle" font-family="${FAMILY}" font-weight="600" font-size="78" letter-spacing="-2" fill="${c.numerals}">12</text>`);
  else if (d.numerals !== "none") {
    const size = d.numerals === "roman" ? 32 : 44;
    for (const h of o?.week ? [9] : [0, 9]) {
      const label = d.numerals === "roman" ? ROMAN[h]! : String(h === 0 ? 12 : h);
      const [x, y] = polar(140, h * 30);
      parts.push(`<text x="${x}" y="${f(y + size * 0.35)}" text-anchor="middle" font-family="${FAMILY}" font-weight="600" font-size="${size}" fill="${c.numerals}">${label}</text>`);
    }
  }
  // ---- above the centre, between the compass and the right-hand data: the T or a short text
  // (A big 12 takes that place.)
  const top = d.numerals !== "none" ? 124 : 112;
  if (o?.week) parts.push(weekLayer(o.week, d));
  else if (d.numerals === "big") {
    // nothing more up there
  } else if (d.logo === "top") parts.push(logo(C, top, 52, c.logo));
  else if (d.logo === "text" && d.text) parts.push(`<text x="${C}" y="${top + 34}" text-anchor="middle" font-family="${FAMILY}" font-weight="600" font-size="24" letter-spacing="1" fill="${c.text}">${esc(d.text.toUpperCase())}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${SCREEN}" viewBox="${-dx} 0 ${width} ${SCREEN}">${fontFace(o)}${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${parts.join("")}</svg>`;
}

/** A hand in its own image, pointing up, pivot at (w/2, 233). */
function handSvg(w: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${SCREEN}" viewBox="${-w / 2} ${-C} ${w} ${SCREEN}">${body}</svg>`;
}

/** A hand `half` wide each side, from `tail` behind the pivot to `tip` in front. */
function handShape(style: FaceDesign["hands"], half: number, tip: number, tail: number, colour: string): string {
  switch (style) {
    case "baton":
      return `<rect x="${-half}" y="${-tip}" width="${half * 2}" height="${tip + tail}" rx="1" fill="${colour}"/>`;
    case "sword":
      return `<path d="M0,${-tip} L${half * 1.4},${-tip * 0.22} L${half * 0.8},${tail} L${-half * 0.8},${tail} L${-half * 1.4},${-tip * 0.22}Z" fill="${colour}"/>`;
    case "arrow":
      return `<rect x="${-half * 0.45}" y="${-tip + 26}" width="${half * 0.9}" height="${tip - 26 + tail}" rx="1" fill="${colour}"/><path d="M0,${-tip} L${half * 1.6},${-tip + 30} L${-half * 1.6},${-tip + 30}Z" fill="${colour}"/>`;
    case "skeleton": {
      const h = half + 1;
      return `<path d="M${-h},${tail - 6} L${-h},${-tip + 18} Q${-h},${-tip + 4} 0,${-tip} Q${h},${-tip + 4} ${h},${-tip + 18} L${h},${tail - 6} Q${h},${tail} 0,${tail} Q${-h},${tail} ${-h},${tail - 6}Z" fill="none" stroke="${colour}" stroke-width="2.6"/><rect x="-1.3" y="${-tip * 0.5}" width="2.6" height="${tip * 0.5 - 14}" fill="${colour}"/>`;
    }
    case "dauphine":
      // Faceted: lit on one side, shaded on the other.
      return `<path d="M0,${-tip} L${f(half * 1.7)},-4 L0,${tail} L${f(-half * 1.7)},-4Z" fill="${colour}"/><path d="M0,${-tip} L${f(half * 1.7)},-4 L0,${tail}Z" fill="#000" fill-opacity="0.3"/>`;
    case "block": {
      const w = half * 1.8;
      return `<rect x="${f(-w)}" y="${-tip}" width="${f(w * 2)}" height="${tip + tail}" rx="${f(w)}" fill="${colour}"/>`;
    }
    case "pencil": {
      const w = half * 0.55;
      return `<path d="M${f(-w)},${tail - 10} L${f(-w)},${-tip + 56} L0,${-tip} L${f(w)},${-tip + 56} L${f(w)},${tail - 10}Z" fill="${colour}"/><circle cx="0" cy="${tail - 4}" r="${f(half * 1.3)}" fill="${colour}"/>`;
    }
    default:
      return `<path d="M${-half},${tail - 6} L${-half},${-tip + 18} Q${-half},${-tip + 4} 0,${-tip} Q${half},${-tip + 4} ${half},${-tip + 18} L${half},${tail - 6} Q${half},${tail} 0,${tail} Q${-half},${tail} ${-half},${tail - 6}Z" fill="${colour}"/>`;
  }
}

export const hourHand = (d: FaceDesign = TARTAN_TRACK_DESIGN) => handSvg(64, handShape(d.hands, d.hands === "slim" ? 4.5 : d.hands === "skeleton" ? 8 : 7, 122, 24, d.colours.hands));
export const minuteHand = (d: FaceDesign = TARTAN_TRACK_DESIGN) => handSvg(64, handShape(d.hands, d.hands === "slim" ? 3.2 : d.hands === "skeleton" ? 6 : 5, 183, 26, d.colours.hands));
export const secondHand = (colour = TARTAN_TRACK_DESIGN.seconds[0]!, style: FaceDesign["secondsStyle"] = "needle") =>
  handSvg(
    16,
    style === "lollipop"
      ? `<rect x="-1.4" y="-200" width="2.8" height="230" rx="1.4" fill="${colour}"/><circle cx="0" cy="-150" r="7" fill="${colour}"/>`
      : style === "arrow"
        ? `<rect x="-1.4" y="-176" width="2.8" height="206" rx="1.4" fill="${colour}"/><path d="M0,-202 L7,-176 L-7,-176Z" fill="${colour}"/>`
        : style === "plain"
          ? `<rect x="-1.6" y="-196" width="3.2" height="214" rx="1.6" fill="${colour}"/>`
          : `<rect x="-1.6" y="-196" width="3.2" height="236" rx="1.6" fill="${colour}"/><circle cx="0" cy="34" r="6" fill="none" stroke="${colour}" stroke-width="3"/>`,
  );
const groundOf = (d: FaceDesign) => (d.background.kind === "colour" ? d.background.colour : "#000");
/** The cap over the hour and minute hands (under the seconds hand), centred in 64 × 70. */
export const capUnder = (d: FaceDesign = TARTAN_TRACK_DESIGN) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="70" viewBox="-32 -35 64 70">${d.caps === "dot" ? `<circle r="9" fill="${d.colours.caps}"/>` : d.caps === "ring" ? `<circle r="10" fill="${groundOf(d)}" stroke="${d.colours.caps}" stroke-width="3"/>` : ""}</svg>`;
/** The cap over everything, centred in 32 × 36. */
export const capOver = (d: FaceDesign = TARTAN_TRACK_DESIGN) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="36" viewBox="-16 -18 32 36">${d.caps === "dot" ? `<circle r="11" fill="${d.colours.caps}"/><circle r="4" fill="${groundOf(d)}"/>` : d.caps === "ring" ? `<circle r="5" fill="${d.colours.caps}"/>` : ""}</svg>`;

const inner = (svg: string) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");

/**
 * The whole face at a time, as the watch would show it, with the date and battery the watch
 * draws imitated. `size` scales it (352 is the package's preview image).
 */
/**
 * What the watch draws over the background itself, imitated (approximately) in `accent`: the
 * compass, the battery arc, the day, and the two data spots with their first choices.
 */
function watchData(accent: string, day: string, battery: number): string {
  const ink = "#eceaea";
  const disc = "#1b1a1a";
  const out: string[] = [];
  // Compass, upper left.
  out.push(`<circle cx="152" cy="152" r="44" fill="${disc}"/><circle cx="152" cy="152" r="36" fill="none" stroke="#2c2a2a" stroke-width="2"/><path d="M152,122 L158,152 L146,152Z" fill="${accent}"/><path d="M152,182 L158,152 L146,152Z" fill="#5a5656"/>`);
  // Battery: ten segments along the rim between 8 and 10.
  const lit = Math.round((battery / 100) * 10);
  for (let i = 0; i < 10; i++) {
    const deg = 300 - 6 - i * 5.6;
    out.push(`<rect x="${C - 3}" y="${C - 196}" width="6" height="16" rx="1.5" fill="${i < lit ? accent : "#3a3838"}" transform="rotate(${f(deg)} ${C} ${C})"/>`);
  }
  // The day, in a pill at the bottom.
  out.push(`<rect x="${C - 40}" y="361" width="80" height="34" rx="17" fill="${disc}"/><text x="${C}" y="385" text-anchor="middle" font-family="${FAMILY}" font-weight="600" font-size="22" letter-spacing="1" fill="${ink}">${esc(day.slice(0, 3).toUpperCase())}</text>`);
  // Data spot 1, lower left: heart rate.
  out.push(`<circle cx="157" cy="288" r="56" fill="${disc}"/><path d="M157,282 C150,272 136,274 138,286 C140,294 157,304 157,304 C157,304 174,294 176,286 C178,274 164,272 157,282Z" transform="translate(0 -12) scale(1) " fill="${accent}"/><text x="157" y="322" text-anchor="middle" font-family="${FAMILY}" font-weight="600" font-size="24" fill="${ink}">128</text>`);
  // Data spot 2, right: steps, with its progress ring.
  const ring = 2 * Math.PI * 90;
  out.push(
    `<circle cx="334" cy="243" r="100" fill="${disc}"/><circle cx="334" cy="243" r="90" fill="none" stroke="${accent}" stroke-opacity="0.25" stroke-width="10"/>` +
      `<circle cx="334" cy="243" r="90" fill="none" stroke="${accent}" stroke-width="10" stroke-dasharray="${f(ring * 0.68)} ${f(ring)}" transform="rotate(-90 334 243)"/>` +
      `<g fill="${ink}"><ellipse cx="328" cy="208" rx="5" ry="8"/><ellipse cx="342" cy="200" rx="5" ry="8"/></g>` +
      `<text x="334" y="262" text-anchor="middle" font-family="${FAMILY}" font-weight="600" font-size="34" fill="${ink}">2345</text>`,
  );
  return out.join("");
}

export function face(o: { design?: FaceDesign; hours: number; minutes: number; seconds: number; secondsColour?: string; date?: string; battery?: number; size?: number; showSeconds?: boolean; data?: boolean } & DrawOptions): string {
  const d = o.design ?? TARTAN_TRACK_DESIGN;
  const size = o.size ?? SCREEN;
  const h = ((o.hours % 12) + o.minutes / 60) * 30;
  const m = (o.minutes + o.seconds / 60) * 6;
  const s = o.seconds * 6;
  const sc = o.secondsColour ?? d.seconds[0]!;
  const date = o.date ?? "";
  const clip = `tt-screen-${++uid}`;
  // Each hand is drawn around its pivot at (0, 0): turn it, then put the pivot on the centre.
  const hand = (svg: string, deg: number) => `<g transform="translate(${C} ${C}) rotate(${f(deg)})">${inner(svg)}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${SCREEN} ${SCREEN}">
${fontFace(o)}<defs><clipPath id="${clip}"><circle cx="${C}" cy="${C}" r="${C}"/></clipPath></defs>
<g clip-path="url(#${clip})">
${inner(dial(d, SCREEN, { week: o.week }))}
${o.data === false ? "" : watchData(sc, date || "FRI", o.battery ?? 84)}
${hand(hourHand(d), h)}
${hand(minuteHand(d), m)}
<g transform="translate(${C} ${C})">${inner(capUnder(d))}</g>
${o.showSeconds === false ? "" : hand(secondHand(sc, d.secondsStyle), s)}
<g transform="translate(${C} ${C})">${inner(capOver(d))}</g>
</g></svg>`;
}

/**
 * Every image the face package needs, by the file name the layout uses
 * (src/watchface/layout.ts): seconds hand i in the design's seconds[i], the first the default.
 */
export function layers(d: FaceDesign = TARTAN_TRACK_DESIGN, o?: DrawOptions): Record<string, { svg: string; width: number; height: number }> {
  const out: Record<string, { svg: string; width: number; height: number }> = {
    [`${IMAGE_NAMES.background}.png`]: { svg: dial(d, 480, o), width: 480, height: SCREEN },
    [`${IMAGE_NAMES.hour}.png`]: { svg: hourHand(d), width: 64, height: SCREEN },
    [`${IMAGE_NAMES.minute}.png`]: { svg: minuteHand(d), width: 64, height: SCREEN },
    [`${IMAGE_NAMES.capUnder}.png`]: { svg: capUnder(d), width: 64, height: 70 },
    [`${IMAGE_NAMES.capOver}.png`]: { svg: capOver(d), width: 32, height: 36 },
    [`${IMAGE_NAMES.preview}.png`]: { svg: face({ design: d, hours: 10, minutes: 9, seconds: 36, date: "FRI 16", battery: 84, size: 352, ...o }), width: 352, height: 352 },
  };
  IMAGE_NAMES.seconds.forEach((n, i) => (out[`${n}.png`] = { svg: secondHand(d.seconds[i]!, d.secondsStyle), width: 16, height: SCREEN }));
  return out;
}

/** A random design from the brand's colours (the builder's "Surprise me"). */
export function surprise(id: string, rand = Math.random): FaceDesign {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
  const p = structuredClone(pick(PRESETS));
  const lights = ["#e0452b", "#ff6a4d", "#fdf3ee", "#ffffff", "#8fe3b4", "#a3c6ff", "#ffbe3d"];
  const darks = ["#7d2615", "#3d120a", "#1f5c3a", "#1d3557", "#3d3634", "#5a1f14"];
  const a = pick(lights);
  const b = pick(lights.filter((x) => x !== a));
  const deep = pick(darks);
  const art = pick(ART);
  // Lines and squares in a light colour; fields and washes in a dark one.
  const loud = art === "stripes" || art === "lanes" || art === "checker";
  const numerals = pick(["none", "none", "arabic", "roman", "big"] as const);
  const r = rand();
  return checkDesign({
    ...p,
    id,
    name: "Surprise",
    art,
    track: pick(["lanes", "filled", "single", "dashed", "bezel", "none", "none"] as const),
    marks: pick(["all", "fives", "quarters"] as const),
    markShape: pick(["line", "bar", "dot"] as const),
    numerals,
    logo: pick(["top", "top", "none"] as const),
    hands: pick(["classic", "slim", "baton", "sword", "arrow", "skeleton", "dauphine", "block", "pencil"] as const),
    secondsStyle: pick(["needle", "lollipop", "arrow", "plain"] as const),
    caps: pick(["dot", "ring"] as const),
    background:
      r < 0.4 ? { kind: "black" }
      : r < 0.6 ? { kind: "colour", colour: pick(["#c8371f", "#163a7a", "#0f2a1c", "#1e1305", "#3d120a"]) }
      : r < 0.8 ? { kind: "gradient", from: deep, to: "#000000" }
      : { kind: "tartan", colour: deep, dim: 0.35 },
    colours: { track: deep, finish: b, marks: a, minor: deep, numerals: a, logo: b, text: b, hands: a, caps: b, art: loud ? b : art === "split" ? "#000000" : deep },
    seconds: [b, ...lights.filter((x) => x !== b)].slice(0, 7),
  });
}

/** The house face's identity on the watch. */
export const TARTAN_TRACK = { id: TARTAN_TRACK_DESIGN.id, name: TARTAN_TRACK_DESIGN.name };
