/**
 * The 2D muscle map: a body from the front and from the back, each muscle its own shape, shaded
 * on the app's one heat scale (five steps of the accent, `--heat-0` to `--heat-4` in styles.css:
 * the same steps wherever something is "how much"). The outlines are MuscleMap's (Melih Colpan,
 * MIT; web/lib/musclemap-paths.ts, licence in vendor/MuscleMap-LICENSE), a man's or a woman's; they're ~95 KB, so they
 * load the first time a map is shown, the figure keeping its place until then.
 *
 * Used where 3D would be too much (lists, phones without WebGL) and on the You page, where a tap
 * on a muscle says how it is.
 */
import type { Muscle } from "../../src/strength/exercises.ts";
import { MUSCLE_NAME } from "../../src/strength/exercises.ts";
import type { View } from "./musclemap-paths.ts";

export type Heat = 0 | 1 | 2 | 3 | 4;
export type Levels = Partial<Record<Muscle, Heat>>;
export type Figure = "m" | "f";

/** Parts that are the body, not a muscle: drawn quiet, never shaded. */
const BODY = new Set(["head", "hair", "neck", "hands", "feet", "knees", "ankles"]);
/** Muscles the map draws that the app has no use for yet: the quiet muscle colour. */
const OTHER = new Set(["serratus"]);
/** The side glutes have no shape of their own: they shade the glutes. */
const SHARES: Partial<Record<Muscle, Muscle>> = { glute_med: "glutes" };

let paths: Promise<Record<Figure, Record<"front" | "back", View>>> | null = null;
const load = () => (paths ??= import("./musclemap-paths.ts").then((m) => m.default));

/** Each drawn muscle's level: its own, or the strongest of the muscles it stands for. */
function drawn(levels: Levels): Record<string, Heat> {
  const out: Record<string, Heat> = {};
  for (const [m, v] of Object.entries(levels) as Array<[Muscle, Heat]>) {
    const at = SHARES[m] ?? m;
    out[at] = Math.max(out[at] ?? 0, v) as Heat;
  }
  return out;
}

function svg(view: View, side: "front" | "back", levels: Record<string, Heat>, selected: Muscle | null, tappable: boolean): string {
  const [x, y, w, h] = view.vb.split(" ");
  let body = "";
  for (const [part, p] of Object.entries(view.parts)) {
    const ds = [...(p.l ?? []), ...(p.r ?? []), ...(p.c ?? [])];
    if (BODY.has(part) || OTHER.has(part)) {
      body += ds.map((d) => `<path class="${BODY.has(part) ? "mm-n" : "mm-m"}" d="${d}"/>`).join("");
      continue;
    }
    const m = part as Muscle;
    const name = MUSCLE_NAME[m] ?? part;
    const cls = `mm-m lv${levels[m] ?? 0}${selected === m ? " sel" : ""}`;
    const attrs = tappable ? ` role="button" tabindex="0" aria-label="${name}" aria-pressed="${selected === m}"` : "";
    body += `<g class="${cls}" data-m="${m}"${attrs}><title>${name}</title>${ds.map((d) => `<path d="${d}"/>`).join("")}</g>`;
  }
  return `<svg viewBox="${x} ${y} ${w} ${h}" class="mm-fig" role="${tappable ? "group" : "img"}" aria-label="${side === "front" ? "From the front" : "From the back"}">${body}</svg>`;
}

export interface BodyMapOptions {
  levels: Levels;
  figure?: Figure;
  /** Tap (or Enter/Space) on a muscle; the map marks it selected. */
  onMuscle?: (m: Muscle) => void;
  selected?: Muscle | null;
}

export type BodyMap = HTMLElement & { update(levels: Levels, selected?: Muscle | null): void; setFigure(f: Figure): void };

/** Front and back, shaded by level. Returns at once; the outlines fill in when loaded. */
export function bodyMap(o: BodyMapOptions): BodyMap {
  const box = document.createElement("div") as unknown as BodyMap;
  box.className = "mm-figs";
  let levels = o.levels;
  let selected = o.selected ?? null;
  let figure = o.figure ?? "m";
  let views: Record<"front" | "back", View> | null = null;
  const draw = () => {
    if (!views) return;
    const lv = drawn(levels);
    box.innerHTML = svg(views.front, "front", lv, selected, !!o.onMuscle) + svg(views.back, "back", lv, selected, !!o.onMuscle);
  };
  box.update = (next, sel) => {
    levels = next;
    if (sel !== undefined) selected = sel;
    draw();
  };
  if (o.onMuscle) {
    const pick = (t: EventTarget | null) => {
      const g = (t as Element | null)?.closest?.("[data-m]");
      if (!g) return;
      selected = g.getAttribute("data-m") as Muscle;
      draw();
      o.onMuscle!(selected);
    };
    box.addEventListener("click", (e) => pick(e.target));
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      pick(e.target);
    });
  }
  box.setFigure = (f) => {
    figure = f;
    void load().then((p) => {
      views = p[figure];
      draw();
    });
  };
  box.setFigure(figure);
  return box;
}

/** The heat scale's key: "less … more" (or the words given) over its five steps. */
export function heatLegend(low = "Less", high = "More"): HTMLElement {
  const box = document.createElement("div");
  box.className = "heat-legend";
  box.innerHTML = `<span>${low}</span>${[0, 1, 2, 3, 4].map((i) => `<i class="lv${i}"></i>`).join("")}<span>${high}</span>`;
  return box;
}

/** What an exercise works: front and back with the worked muscles lit, and named underneath. */
export function muscleMap(primary: Muscle[], secondary: Muscle[] = [], figure: Figure = "m"): HTMLElement {
  const p = new Set(primary);
  const s = new Set(secondary.filter((m) => !p.has(m)));
  const levels: Levels = {};
  s.forEach((m) => (levels[m] = 2));
  p.forEach((m) => (levels[m] = 4));
  const box = document.createElement("div");
  box.className = "mm";
  const legend = document.createElement("div");
  legend.className = "mm-legend";
  legend.innerHTML =
    `<p><i class="mm-key lv4"></i><span><b>Works</b> ${[...p].map((m) => MUSCLE_NAME[m]).join(", ")}</span></p>` +
    (s.size ? `<p><i class="mm-key lv2"></i><span><b>Helps</b> ${[...s].map((m) => MUSCLE_NAME[m]).join(", ")}</span></p>` : "");
  box.append(bodyMap({ levels, figure }), legend);
  return box;
}
