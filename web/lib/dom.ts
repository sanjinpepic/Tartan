/** Tiny DOM + formatting helpers shared by every view. Text always goes in as text nodes. */

/** The one scroller: the content between the fixed top bar and tab bar (see the app shell in styles.css). */
export const page = () => document.getElementById("main") as HTMLElement;

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style">> & Record<string, unknown> & { style?: string };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...kids: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "style") e.setAttribute("style", String(v));
    else if (k === "class") e.className = String(v);
    else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "for" || k === "tabindex") e.setAttribute(k, String(v));
    else (e as unknown as Record<string, unknown>)[k] = v;
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, ...kids: Array<Node | null | undefined | false>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, String(v));
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}

/** Inline icons: one stroke family (24 grid, 1.8 stroke, round joins), authored for this app. */
const ICONS: Record<string, string> = {
  today: "M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  record: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 12h.01",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  trends: "M4 19V9M10 19V5M16 19v-7M21 19H3",
  coach: "M4.5 5.5h15v10h-9l-4.5 4v-4h-1.5z M9 10.5h.01M12 10.5h.01M15 10.5h.01",
  plan: "M5 5.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1zM4 10h16M8.5 3.5v4M15.5 3.5v4M9 15l2 2 4-4",
  sync: "M20 12a8 8 0 0 1-14.3 4.9M4 12A8 8 0 0 1 18.3 7.1M18.5 3v4.3h-4.3M5.5 21v-4.3h4.3",
  settings: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4",
  watch: "M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9 6l1-3.5h4L15 6M9 18l1 3.5h4L15 18M12 9.5V12l1.6 1.2",
  route: "M5 19c3-1 4-4 6-8s4-6 8-6M5 19h.01M19 5h.01",
  run: "M13 4.5a1.5 1.5 0 1 0 0-.01M9.5 21l2.5-5.5 2.5 2V21M7 12l2.5-3.5h4l2 3 2.5.5M11.5 8.5 10 13l-3 1",
  ride: "M6 18a3 3 0 1 0 0-.01M18 18a3 3 0 1 0 0-.01M6 18l4-7h5l3 7M10 11l-1.5-3H7M15 11l-1-3h2",
  swim: "M3 17c2 0 2-1.5 4.5-1.5S10 17 12 17s2.5-1.5 4.5-1.5S19 17 21 17M7 13l4-4 3 2.5L17 9M16 6.5a1.5 1.5 0 1 0 0-.01",
  walk: "M12.5 4.5a1.5 1.5 0 1 0 0-.01M10 21l2-6 2 2v4M9 11l2-2.5 2.5 1.5 1.5 3M11 8.5 9.5 15",
  other: "M12 4l2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 16.2 7 19l1.2-5.6L4 9.6l5.6-.6z",
  close: "M6 6l12 12M18 6 6 18",
  back: "M15 5l-7 7 7 7",
  send: "M5 12h13M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  play: "M8 5.5v13l10.5-6.5z",
  pause: "M8.5 5.5v13M15.5 5.5v13",
  stop: "M6.5 6.5h11v11h-11z",
  pin: "M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  chevron: "M9 6l6 6-6 6",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2",
  undo: "M9 14 4.5 9.5 9 5M4.5 9.5H15a5 5 0 0 1 0 10h-3",
  loop: "M12 20a8 8 0 1 1 8-8M20 12l2.5-2.5M20 12l-2.5-2.5",
  outback: "M4 9h14l-3.5-3.5M20 15H6l3.5 3.5",
  reverse: "M8 4v16M4.5 7.5 8 4l3.5 3.5M16 20V4M12.5 16.5 16 20l3.5-3.5",
  locate: "M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5",
  file: "M7 3.5h7l4 4V20.5H7zM14 3.5V8h4",
  history: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2",
  bookmark: "M7 3.5h10a1 1 0 0 1 1 1V20.5l-6-4-6 4V4.5a1 1 0 0 1 1-1z",
  body: "M12 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 9.5l6 1.5 6-1.5M12 11v4.5M12 15.5 9 20.5M12 15.5l3 5",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18",
  bolt: "M13 3 5 14h6l-1 7 8-11h-6z",
  heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
  sun: "M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  moon: "M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a6 6 0 0 0 10 10z",
  drop: "M12 3.5s-6 6.4-6 10.8a6 6 0 0 0 12 0C18 9.9 12 3.5 12 3.5z",
  folder: "M3 6.5h6l2 2h10v10H3z",
  phone: "M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2",
  agent: "M8 9h8v8H8zM12 5v4M9.5 12.5h.01M14.5 12.5h.01M5 13h3M16 13h3",
  check: "M5 12.5l4.5 4.5L19 7.5",
  warn: "M12 4 3 20h18zM12 10v4M12 17h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  // Strava's mark (its two chevrons), filled, as tall as the watch: it labels Strava as a source.
  strava: "M5.22 13.38L10.73 2.5L16.29 13.38L13 13.38L10.73 9.03L8.47 13.38ZM10.62 13.38L13 13.38L14.7 16.67L16.29 13.38L18.78 13.38L14.7 21.5Z",
  camera: "M4 8.5h3.2L9 6h6l1.8 2.5H20V19H4zM12 16.2a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  mic: "M12 3.5a2.75 2.75 0 0 0-2.75 2.75v5.5a2.75 2.75 0 0 0 5.5 0v-5.5A2.75 2.75 0 0 0 12 3.5zM5.75 11.5a6.25 6.25 0 0 0 12.5 0M12 17.75V20.5",
};
/** Marks drawn as shapes, not lines. */
const FILLED = new Set(["strava"]);

export function icon(name: string, cls = "ic"): SVGSVGElement {
  const s = svg("svg", { viewBox: "0 0 24 24", class: cls, "aria-hidden": "true" });
  s.append(svg("path", FILLED.has(name) ? { d: ICONS[name]!, fill: "currentColor", stroke: "none" } : { d: ICONS[name] ?? ICONS.other! }));
  return s;
}

/** A meta line ("Wed 14 Oct · 07:42 · Suunto Run 2") whose separators never start a wrapped line. */
export function meta(...parts: Array<string | false | null | undefined>): HTMLSpanElement {
  return el("span", { class: "meta" }, ...parts.filter((p): p is string => !!p).map((p) => el("span", {}, p)));
}

export function sportIcon(sport: string): string {
  const s = sport.toLowerCase();
  if (/run|jog|trail|treadmill/.test(s)) return "run";
  if (/ride|cycl|bik/.test(s)) return "ride";
  if (/swim/.test(s)) return "swim";
  if (/walk|hik/.test(s)) return "walk";
  return "other";
}

// ------------------------------------------------------------------ formatting

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
export const dayName = (d: Date) => d.toLocaleDateString([], { weekday: "short" });
export const dateLong = (d: Date) => d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
export const dateShort = (d: Date) => d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });

export function fmtDuration(min?: number): string {
  if (min === undefined || !Number.isFinite(min)) return "";
  const total = Math.round(min);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")}`;
}

export function fmtClock(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function ago(d: Date): string {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export const num = (n: number | undefined, d = 0) => (n === undefined || !Number.isFinite(n) ? "–" : n.toLocaleString([], { maximumFractionDigits: d, minimumFractionDigits: d }));

/** The Tartan mark (rail, intro). */
/**
 * The Tartan logo: a T whose crossbar's left arm is two track lanes bending down into the stem,
 * in the theme's tartan. (The app icon is the same T in cream on a tartan tile: web/favicon.svg.)
 */
export function brandMark(): SVGSVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "92 150 698 595");
  s.setAttribute("class", "brand-mark");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML =
    '<g fill="var(--primary)"><path d="M167,150H720A70,70 0 0 1 790,220V298A70,70 0 0 1 720,368H615A197.7,197.7 0 0 0 425,225H92A75,75 0 0 1 167,150Z"/><path d="M92,247H425A167,167 0 0 1 592,414V665A77,80 0 0 1 515,745V428A145,145 0 0 0 370,283H92Z"/><path d="M92,303H370A119,119 0 0 1 489,422V745H373V425A53,55 0 0 0 320,370H165A73,67 0 0 1 92,303Z"/></g>';
  return s;
}
