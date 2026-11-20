/**
 * Hand-written SVG charts (no dependencies), built to the dataviz specs:
 * 2px lines, <=24px columns with 4px rounded data-ends, 2px surface gaps, hairline solid
 * grids, a crosshair + one tooltip for every series, keyboard access, a table twin for
 * every chart, and text that never wears the series color.
 */
import { el, svg } from "./dom.ts";
import { reduced } from "./motion.ts";

export interface Series {
  name: string;
  /** CSS color (use a var(--…) token). */
  color: string;
  values: Array<number | null>;
  /** Wash under the line at ~10%. */
  area?: boolean;
}

export interface LineOpts {
  x: number[];
  series: Series[];
  height?: number;
  xFormat: (x: number) => string;
  xTicks?: (x: number[]) => number[];
  yFormat: (y: number) => string;
  /** Include zero in the y-domain. */
  zero?: boolean;
  /** Diverging fill around zero: above uses `pos`, below uses `neg`. */
  diverging?: { pos: string; neg: string; posLabel: string; negLabel: string };
  /** Invert the y axis (pace: faster is up). */
  invert?: boolean;
  /** Y values are seconds: tick on clock-friendly steps. */
  yTime?: boolean;
  /** The y axis spans at least this much, so a small change looks small. */
  minSpan?: number;
  /** Called when the crosshair moves (index) or leaves (null). */
  onHover?: (i: number | null) => void;
  ariaLabel: string;
}

export interface ChartHandle {
  setHover(i: number | null): void;
}

const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

function niceTicks(min: number, max: number, count = 4, time = false): number[] {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  // Durations step on clock-friendly seconds (15 s, 30 s, 1 min…), everything else on 1-2-2.5-5.
  const steps = time ? [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600] : [1, 2, 2.5, 5, 10].map((m) => m * mag);
  const step = steps.find((s) => span / s <= count + 0.5) ?? (time ? 3600 : 10 * mag);
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
  // Close the scale above the data so no mark rises past the top gridline.
  if (out.at(-1)! < max - step * 1e-6) out.push(+(out.at(-1)! + step).toFixed(10));
  return out;
}

/** Re-render on size changes; returns the latest handle. */
function responsive(container: HTMLElement, draw: (width: number) => ChartHandle): ChartHandle {
  let handle: ChartHandle = draw(container.clientWidth || 600);
  let last = container.clientWidth;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    if (!w || Math.abs(w - last) < 4) return;
    last = w;
    clearTimeout(timer);
    timer = setTimeout(() => (handle = draw(w)), 80);
  });
  ro.observe(container);
  return { setHover: (i) => handle.setHover(i) };
}

function tooltip(container: HTMLElement): HTMLDivElement {
  const t = el("div", { class: "viz-tip", role: "status", "aria-live": "polite" });
  t.hidden = true;
  container.append(t);
  return t;
}

function tipRow(color: string, value: string, label: string, shape: "line" | "rect" = "line"): HTMLElement {
  return el("div", { class: "tip-row" }, el("i", { class: `key ${shape}`, style: `--c:${color}` }), el("b", {}, value), el("span", {}, label));
}

export function legend(items: Array<{ name: string; color: string; shape?: "line" | "rect" }>): HTMLElement {
  return el("ul", { class: "viz-legend" }, ...items.map((i) => el("li", {}, el("i", { class: `key ${i.shape ?? "line"}`, style: `--c:${i.color}` }), i.name)));
}

/** Every chart has a table twin: the values without hovering. */
export function tableTwin(headers: string[], rows: Array<Array<string>>): HTMLElement {
  return el(
    "details",
    { class: "table-twin" },
    el("summary", {}, "Show as table"),
    el(
      "div",
      { class: "table-wrap" },
      el("table", {}, el("thead", {}, el("tr", {}, ...headers.map((h, i) => el("th", { scope: "col", class: i ? "num" : "" }, h)))), el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c, i) => el("td", { class: i ? "num" : "" }, c)))))),
    ),
  );
}

/** Draw a path in once: dashes on a normalised length, cleared when the stroke lands. */
function drawIn(path: SVGPathElement): void {
  path.setAttribute("pathLength", "1");
  path.style.strokeDasharray = "1";
  path.style.strokeDashoffset = "1";
  path.addEventListener(
    "transitionend",
    () => {
      path.removeAttribute("pathLength");
      path.style.strokeDasharray = "";
      path.style.strokeDashoffset = "";
      path.classList.remove("draw");
    },
    { once: true },
  );
  requestAnimationFrame(() => requestAnimationFrame(() => path.classList.add("draw")));
}

// ------------------------------------------------------------------ line / area

export function lineChart(container: HTMLElement, o: LineOpts): ChartHandle {
  container.classList.add("viz");
  const height = o.height ?? 200;
  const tip = tooltip(container);
  let drawn = false;

  return responsive(container, (width) => {
    container.querySelector("svg.viz-svg")?.remove();
    const W = Math.max(240, width);
    const iw = W - PAD.left - PAD.right;
    const ih = height - PAD.top - PAD.bottom;
    const all = o.series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (o.zero || o.diverging) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (!all.length) {
      lo = 0;
      hi = 1;
    }
    // A small change shouldn't fill the chart like a big one.
    if (o.minSpan && hi - lo < o.minSpan) {
      const mid = (hi + lo) / 2;
      lo = mid - o.minSpan / 2;
      hi = mid + o.minSpan / 2;
    }
    const ticks = niceTicks(lo, hi, 4, o.yTime);
    const y0 = Math.min(lo, ticks[0]!);
    const y1 = Math.max(hi, ticks.at(-1)!);
    const xs = o.x;
    const xmin = xs[0] ?? 0;
    const xmax = xs.at(-1) ?? 1;
    const X = (v: number) => PAD.left + ((v - xmin) / (xmax - xmin || 1)) * iw;
    const Y = (v: number) => (o.invert ? PAD.top + ((v - y0) / (y1 - y0 || 1)) * ih : PAD.top + ih - ((v - y0) / (y1 - y0 || 1)) * ih);

    const root = svg("svg", { class: "viz-svg", viewBox: `0 0 ${W} ${height}`, width: "100%", height, role: "img", "aria-label": o.ariaLabel, tabindex: 0 });
    const grid = svg("g", { class: "grid" });
    for (const t of ticks) {
      grid.append(svg("line", { x1: PAD.left, x2: W - PAD.right, y1: Y(t), y2: Y(t) }));
      grid.append(Object.assign(svg("text", { x: PAD.left - 8, y: Y(t) + 4, "text-anchor": "end", class: "tick" }), { textContent: o.yFormat(t) }));
    }
    const xt = o.xTicks ? o.xTicks(xs) : [xs[0]!, xs[Math.floor(xs.length / 2)]!, xs.at(-1)!].filter((v) => v !== undefined);
    for (const t of xt) {
      const anchor = X(t) < PAD.left + 20 ? "start" : X(t) > W - PAD.right - 20 ? "end" : "middle";
      grid.append(Object.assign(svg("text", { x: X(t), y: height - 8, "text-anchor": anchor, class: "tick" }), { textContent: o.xFormat(t) }));
    }
    root.append(grid);
    if (o.diverging || o.zero) root.append(svg("line", { class: "zero", x1: PAD.left, x2: W - PAD.right, y1: Y(0), y2: Y(0) }));

    const marks = svg("g", { class: "marks" });
    for (const s of o.series) {
      const pts: Array<[number, number] | null> = s.values.map((v, i) => (v === null || !Number.isFinite(v) ? null : [X(xs[i]!), Y(v)]));
      const d = pts.reduce((acc, p, i) => (p ? acc + `${acc && pts[i - 1] ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}` : acc), "");
      if (o.diverging) {
        const base = Y(0);
        const area = pts.reduce((acc, p, i) => (p ? acc + `${acc ? "L" : `M${p[0].toFixed(1)},${base}L`}${p[0].toFixed(1)},${p[1].toFixed(1)}` : acc), "") + `L${X(xs.at(-1)!)},${base}Z`;
        const idp = `clip-${Math.random().toString(36).slice(2)}`;
        const defs = svg("defs");
        defs.append(svg("clipPath", { id: `${idp}-pos` }, svg("rect", { x: 0, y: 0, width: W, height: base })));
        defs.append(svg("clipPath", { id: `${idp}-neg` }, svg("rect", { x: 0, y: base, width: W, height: height - base })));
        marks.append(defs);
        marks.append(svg("path", { d: area, class: "area div", style: `--c:${o.diverging.pos}`, "clip-path": `url(#${idp}-pos)` }));
        marks.append(svg("path", { d: area, class: "area div", style: `--c:${o.diverging.neg}`, "clip-path": `url(#${idp}-neg)` }));
        marks.append(svg("path", { d, class: "line", style: `--c:var(--ink-3)`, "clip-path": `url(#${idp}-pos)` }));
        marks.append(svg("path", { d, class: "line", style: `--c:var(--ink-3)`, "clip-path": `url(#${idp}-neg)` }));
        continue;
      }
      if (s.area) {
        const first = pts.find((p) => p);
        const lastP = [...pts].reverse().find((p) => p);
        if (first && lastP) marks.append(svg("path", { d: `${d}L${lastP[0]},${PAD.top + ih}L${first[0]},${PAD.top + ih}Z`, class: "area", style: `--c:${s.color}` }));
      }
      const line = svg("path", { d, class: "line", style: `--c:${s.color}` });
      marks.append(line);
      if (!drawn && !reduced()) drawIn(line);
      // End marker + direct label for the last value (selective labelling).
      const lastIdx = s.values.findLastIndex((v) => v !== null);
      if (lastIdx >= 0 && o.series.length <= 3) marks.append(svg("circle", { class: "end", cx: X(xs[lastIdx]!), cy: Y(s.values[lastIdx]!), r: 4, style: `--c:${s.color}` }));
    }
    root.append(marks);

    const cross = svg("line", { class: "cross", y1: PAD.top, y2: PAD.top + ih, x1: 0, x2: 0 });
    cross.style.display = "none";
    const dots = o.series.map((s) => {
      const c = svg("circle", { class: "hover-dot", r: 4, style: `--c:${o.diverging ? "var(--ink-3)" : s.color}` });
      c.style.display = "none";
      return c;
    });
    root.append(cross, ...dots);
    container.prepend(root);
    drawn = true;

    let current: number | null = null;
    const show = (i: number | null, fromSelf = false) => {
      current = i;
      if (i === null) {
        cross.style.display = "none";
        dots.forEach((d) => (d.style.display = "none"));
        tip.hidden = true;
        if (fromSelf) o.onHover?.(null);
        return;
      }
      const x = X(xs[i]!);
      cross.setAttribute("x1", String(x));
      cross.setAttribute("x2", String(x));
      cross.style.display = "";
      tip.replaceChildren(el("div", { class: "tip-x" }, o.xFormat(xs[i]!)));
      o.series.forEach((s, k) => {
        const v = s.values[i];
        if (v === null || v === undefined) {
          dots[k]!.style.display = "none";
          return;
        }
        dots[k]!.setAttribute("cx", String(x));
        dots[k]!.setAttribute("cy", String(Y(v)));
        dots[k]!.style.display = "";
        const color = o.diverging ? (v >= 0 ? o.diverging.pos : o.diverging.neg) : s.color;
        const label = o.diverging ? `${s.name} · ${v >= 0 ? o.diverging.posLabel : o.diverging.negLabel}` : s.name;
        tip.append(tipRow(color, o.yFormat(v), label));
      });
      tip.hidden = false;
      const left = (x / W) * container.clientWidth;
      tip.style.left = `${Math.min(Math.max(left, 70), container.clientWidth - 70)}px`;
      if (fromSelf) o.onHover?.(i);
    };
    const nearest = (clientX: number) => {
      const r = root.getBoundingClientRect();
      const vx = ((clientX - r.left) / r.width) * W;
      let best = 0;
      let bd = Infinity;
      xs.forEach((v, i) => {
        const dd = Math.abs(X(v) - vx);
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      });
      return best;
    };
    root.addEventListener("pointermove", (e) => show(nearest(e.clientX), true));
    root.addEventListener("pointerleave", () => show(null, true));
    root.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = current === null ? xs.length - 1 : Math.max(0, Math.min(xs.length - 1, current + (e.key === "ArrowRight" ? 1 : -1)));
      show(i, true);
    });
    root.addEventListener("blur", () => show(null, true));
    return { setHover: (i) => show(i) };
  });
}

// ------------------------------------------------------------------ columns

export interface ColumnOpts {
  labels: string[];
  values: number[];
  color: string;
  /** Emphasis: this column takes `color`, the rest the muted step. */
  highlight?: number;
  height?: number;
  yFormat: (v: number) => string;
  tipLabel: (i: number) => string;
  ariaLabel: string;
  /** Label every n-th column on the axis. */
  labelEvery?: number;
  /** A dashed reference line (a target), with its label. */
  reference?: { value: number; label: string };
}

export function columnChart(container: HTMLElement, o: ColumnOpts): ChartHandle {
  container.classList.add("viz");
  const height = o.height ?? 200;
  const tip = tooltip(container);
  let animated = false;
  return responsive(container, (width) => {
    container.querySelector("svg.viz-svg")?.remove();
    const W = Math.max(240, width);
    const iw = W - PAD.left - PAD.right;
    const ih = height - PAD.top - PAD.bottom;
    const ticks = niceTicks(0, Math.max(1, ...o.values, o.reference?.value ?? 0));
    const top = ticks.at(-1)!;
    const band = iw / o.values.length;
    const bw = Math.min(24, Math.max(4, band - 2));
    const Y = (v: number) => PAD.top + ih - (v / top) * ih;
    const root = svg("svg", { class: "viz-svg", viewBox: `0 0 ${W} ${height}`, width: "100%", height, role: "img", "aria-label": o.ariaLabel });
    const grid = svg("g", { class: "grid" });
    for (const t of ticks) {
      grid.append(svg("line", { x1: PAD.left, x2: W - PAD.right, y1: Y(t), y2: Y(t) }));
      grid.append(Object.assign(svg("text", { x: PAD.left - 8, y: Y(t) + 4, "text-anchor": "end", class: "tick" }), { textContent: o.yFormat(t) }));
    }
    const every = o.labelEvery ?? Math.max(1, Math.ceil(o.values.length / Math.max(2, Math.floor(iw / 56))));
    o.labels.forEach((l, i) => {
      if ((o.values.length - 1 - i) % every) return;
      grid.append(Object.assign(svg("text", { x: PAD.left + band * i + band / 2, y: height - 8, "text-anchor": "middle", class: "tick" }), { textContent: l }));
    });
    root.append(grid);
    const marks = svg("g", { class: "marks" });
    o.values.forEach((v, i) => {
      const x = PAD.left + band * i + (band - bw) / 2;
      const h = Math.max(v > 0 ? 2 : 0, (v / top) * ih);
      const r = Math.min(4, h, bw / 2);
      const yTop = PAD.top + ih - h;
      // Rounded data-end, square at the baseline.
      const d = `M${x},${PAD.top + ih}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + bw - r}Q${x + bw},${yTop} ${x + bw},${yTop + r}V${PAD.top + ih}Z`;
      const muted = o.highlight !== undefined && o.highlight !== i;
      const col = svg("path", { d, class: `col${muted ? " muted" : ""}`, style: `--c:${o.color}; --d:${i * 18}ms`, tabindex: 0, role: "img", "aria-label": `${o.tipLabel(i)}: ${o.yFormat(v)}` });
      if (!animated && !reduced()) col.classList.add("grow");
      const hit = svg("rect", { x: PAD.left + band * i, y: PAD.top, width: band, height: ih, class: "hit" });
      const showTip = () => {
        tip.replaceChildren(el("div", { class: "tip-x" }, o.tipLabel(i)), tipRow(o.color, o.yFormat(v), "", "rect"));
        tip.hidden = false;
        tip.style.left = `${Math.min(Math.max(((x + bw / 2) / W) * container.clientWidth, 70), container.clientWidth - 70)}px`;
        col.classList.add("hover");
      };
      const hide = () => {
        tip.hidden = true;
        col.classList.remove("hover");
      };
      for (const t of [hit, col]) {
        t.addEventListener("pointerenter", showTip);
        t.addEventListener("pointerleave", hide);
      }
      col.addEventListener("focus", showTip);
      col.addEventListener("blur", hide);
      marks.append(col, hit);
    });
    root.append(marks);
    if (o.reference) {
      const y = Y(o.reference.value);
      root.append(
        svg("line", { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y, class: "ref-line" }),
        Object.assign(svg("text", { x: W - PAD.right, y: y - 6, "text-anchor": "end", class: "ref-label" }), { textContent: o.reference.label }),
      );
    }
    container.prepend(root);
    animated = true;
    return { setHover: () => {} };
  });
}

// ------------------------------------------------------------------ stacked bar (part to whole)

export function stackBar(container: HTMLElement, segments: Array<{ name: string; value: number; color: string }>, format: (v: number) => string): void {
  container.classList.add("viz");
  const total = segments.reduce((n, s) => n + s.value, 0) || 1;
  const bar = el("div", { class: "stack", role: "img", "aria-label": segments.map((s) => `${s.name} ${format(s.value)}`).join(", ") });
  const tip = tooltip(container);
  for (const s of segments) {
    if (!s.value) continue;
    // Not a tab stop: inside role="img" a segment has no name; the bar's label reads them all.
    const seg = el("div", { class: "seg", style: `--c:${s.color}; --w:${(s.value / total) * 100}%` });
    const show = () => {
      tip.replaceChildren(el("div", { class: "tip-x" }, s.name), tipRow(s.color, format(s.value), `${Math.round((s.value / total) * 100)}%`, "rect"));
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(seg.offsetLeft + seg.offsetWidth / 2, 70), container.clientWidth - 70)}px`;
    };
    seg.addEventListener("pointerenter", show);
    seg.addEventListener("focus", show);
    seg.addEventListener("pointerleave", () => (tip.hidden = true));
    seg.addEventListener("blur", () => (tip.hidden = true));
    bar.append(seg);
  }
  container.prepend(bar);
}

// ------------------------------------------------------------------ route

export function routeMap(container: HTMLElement, latlng: Array<[number, number] | null>, ariaLabel: string): void {
  const pts = latlng.filter((p): p is [number, number] => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) return;
  const lat0 = pts.reduce((n, p) => n + p[0], 0) / pts.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p[1] * kx);
  const ys = pts.map((p) => -p[0]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const W = 600;
  const H = 300;
  const pad = 24;
  const s = Math.min((W - 2 * pad) / (maxX - minX || 1e-9), (H - 2 * pad) / (maxY - minY || 1e-9));
  const ox = (W - (maxX - minX) * s) / 2;
  const oy = (H - (maxY - minY) * s) / 2;
  const P = (i: number) => [ox + (xs[i]! - minX) * s, oy + (ys[i]! - minY) * s] as const;
  const d = pts.map((_, i) => `${i ? "L" : "M"}${P(i)[0].toFixed(1)},${P(i)[1].toFixed(1)}`).join("");
  const route = svg("path", { d, class: "route" });
  const glow = svg("path", { d, class: "route-under" });
  if (!reduced()) drawIn(route);
  const [sx, sy] = P(0);
  const [ex, ey] = P(pts.length - 1);
  container.append(
    svg(
      "svg",
      { class: "route-svg", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": ariaLabel },
      glow,
      route,
      svg("circle", { cx: sx, cy: sy, r: 6, class: "route-start" }),
      svg("circle", { cx: ex, cy: ey, r: 6, class: "route-end" }),
    ),
  );
}
