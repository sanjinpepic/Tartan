/** One workout as a sheet: route, numbers, linked pace / heart rate / elevation, zones, splits, provenance. */
import { legend, lineChart, routeMap, stackBar, tableTwin, type ChartHandle } from "../lib/charts.ts";
import { dateLong, el, fmtClock, fmtDuration, hhmm, icon, meta, num, sportIcon } from "../lib/dom.ts";
import { reduced } from "../lib/motion.ts";
import { app, notify } from "../state.ts";
import { sourceBadges, sourceName } from "../lib/sources.ts";
import type { ActivityView } from "../types.ts";
import { runFinish } from "./finish.ts";
import { runShoes } from "./shoes.ts";
import { howItWent } from "./notes.ts";
import { bodyMap, type Levels } from "../lib/muscles.ts";
import { yourBody } from "../lib/demo-body.ts";
import { shellWorkout } from "../lib/shell.ts";
import { MUSCLE_NAME, type Muscle } from "../../src/strength/exercises.ts";

const ZONE_COLORS = ["var(--z1)", "var(--z2)", "var(--z3)", "var(--z4)", "var(--z5)"];

let dialog: HTMLDialogElement | null = null;

function sheet(): HTMLDialogElement {
  if (dialog) return dialog;
  // Focus lands on the sheet itself when it opens, not on its first control: on a phone that's
  // a chart halfway down (below the header), and the sheet would open scrolled.
  dialog = el("dialog", { class: "sheet", "aria-labelledby": "sheet-title", tabindex: "-1" });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  document.body.append(dialog);
  dragToClose(dialog);
  return dialog;
}

/**
 * Phone: pull the sheet down to close it, from anywhere once its content is scrolled to the
 * top. A long or quick pull closes; a short one springs back.
 */
export function dragToClose(d: HTMLDialogElement): void {
  let y0 = 0;
  let t0 = 0;
  let dy = 0;
  let dragging = false;
  let armed = false;
  const reset = () => {
    d.style.transition = "transform 280ms var(--spring)";
    d.style.transform = "";
    setTimeout(() => (d.style.transition = ""), 300);
  };
  d.addEventListener(
    "touchstart",
    (e) => {
      if (innerWidth >= 900 || e.touches.length !== 1) return;
      // Charts and maps keep their own touch handling.
      armed = d.scrollTop <= 0 && !(e.target as Element).closest("svg, .table-wrap, .carousel");
      y0 = e.touches[0]!.clientY;
      t0 = performance.now();
      dy = 0;
      dragging = false;
    },
    { passive: true },
  );
  d.addEventListener(
    "touchmove",
    (e) => {
      if (!armed) return;
      dy = e.touches[0]!.clientY - y0;
      if (!dragging && dy > 8 && d.scrollTop <= 0) dragging = true;
      if (!dragging) {
        if (dy < 0) armed = false; // scrolling the content up
        return;
      }
      e.preventDefault();
      d.style.transition = "none";
      d.style.transform = `translateY(${Math.max(0, dy)}px)`;
    },
    { passive: false },
  );
  d.addEventListener("touchend", () => {
    if (!dragging) return;
    dragging = false;
    armed = false;
    const speed = dy / Math.max(1, performance.now() - t0); // px per ms
    if (dy > Math.min(160, d.offsetHeight * 0.25) || (dy > 40 && speed > 0.6)) {
      d.style.transition = "transform 220ms ease-out";
      d.style.transform = "translateY(100%)";
      setTimeout(() => {
        d.close();
        d.style.transition = "";
        d.style.transform = "";
      }, 220);
    } else reset();
  });
  d.addEventListener("touchcancel", () => {
    if (dragging) reset();
    dragging = armed = false;
  });
}

async function close(): Promise<void> {
  const d = sheet();
  if (!d.open) return;
  if (reduced()) return d.close();
  d.classList.add("closing");
  await new Promise((r) => setTimeout(r, 260));
  d.classList.remove("closing");
  d.close();
}

/** The sheet's own shape while the workout loads: head, chips, the route and the stat grid. */
function placeholder(): Node[] {
  return [
    el("div", { class: "grabber", "aria-hidden": "true" }),
    el("div", { class: "sheet-head ph" }, el("span", { class: "row-ic big ph-block" }), el("div", { class: "ph-lines" }, el("i", { class: "ph-line w60" }), el("i", { class: "ph-line w40" }))),
    el("div", { class: "ph-block ph-route" }),
    el("div", { class: "stat-grid ph" }, ...Array.from({ length: 6 }, () => el("div", { class: "stat ph-block" }))),
    el("div", { class: "ph-block ph-chart" }),
  ];
}

/**
 * Open a workout. The sheet grows out of the tapped row once, at its full height: with the
 * workout when it's ready within a beat (it usually is, the data is local), else with the
 * sheet's own outline, which the workout then fades into without the sheet moving.
 */
/** `_from`: the row tapped (kept for callers; the sheet slides up the same way from anywhere). */
export async function openActivity(id: string, _from?: HTMLElement): Promise<void> {
  // Tartan 2: the native sheet, over whichever screen asked.
  if (shellWorkout(id)) return;
  const d = sheet();
  const loading = app.api.json<ActivityView>(`/api/activity/${encodeURIComponent(id)}`).then(
    (v) => ({ v }),
    (e: Error) => ({ e }),
  );
  const quick = await Promise.race([loading, new Promise<null>((r) => setTimeout(() => r(null), 220))]);
  const body = el("div", { class: "sheet-body" });
  if (quick && "v" in quick) body.append(...content(quick.v));
  else body.append(...placeholder());
  body.setAttribute("aria-busy", String(!(quick && "v" in quick)));
  d.replaceChildren(body);
  d.scrollTop = 0;
  // Every sheet comes up from the bottom and goes back down the same way (the CSS sheet-up and
  // sheet-down); this one used to grow out of the row first, which read as a zoom, then a sheet.
  if (!d.open) d.showModal();
  d.focus({ preventScroll: true });
  d.scrollTop = 0;
  if (quick && "v" in quick) return;
  const res = await loading;
  if ("e" in res) {
    notify(`Could not open this workout: ${res.e.message}`, "error");
    return close();
  }
  body.setAttribute("aria-busy", "false");
  const next = el("div", { class: "sheet-body" }, ...content(res.v));
  if (reduced()) return body.replaceWith(next);
  // The outline dissolves into the workout; the sheet itself stays where it is.
  next.style.opacity = "0";
  body.replaceWith(next);
  next.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" }).finished.then(() => (next.style.opacity = ""));
}

function content(v: ActivityView): Node[] {
  const a = v.detail;
  const d = new Date(a.start);
  const closeBtn = el("button", { type: "button", class: "icon-btn", "aria-label": "Close" }, icon("close"));
  closeBtn.onclick = () => close();
  const isRun = /run|walk|hik|trail|treadmill/i.test(a.sport);

  const nodes: Node[] = [
    el("div", { class: "grabber", "aria-hidden": "true" }),
    el(
      "header",
      { class: "sheet-head" },
      el("span", { class: "row-ic big" }, icon(sportIcon(a.sport))),
      el("div", {}, el("h2", { id: "sheet-title" }, a.name ?? a.sport), el("p", { class: "sub" }, meta(dateLong(d), hhmm(d), a.device))),
      closeBtn,
    ),
    el("div", { class: "chips" }, sourceBadges(a.copies.map((c) => c.source)), a.copies.length > 1 ? el("span", { class: "chip quiet" }, icon("check", "ic sm"), "Matched: one workout") : null),
  ];
  if (a.description) nodes.push(el("p", { class: "desc" }, a.description));

  const latlng = v.streams?.streams.latlng as Array<[number, number] | null> | undefined;
  if (latlng?.some(Boolean)) {
    const map = el("div", { class: "route-card" });
    routeMap(map, latlng, `Route of ${a.name ?? a.sport}`);
    nodes.push(map);
    streetMap(map, latlng);
  }

  const stat = (k: string, val: string, unit = "") => el("div", { class: "stat" }, el("dt", {}, k), el("dd", {}, val, unit ? el("small", {}, ` ${unit}`) : ""));
  nodes.push(
    el(
      "dl",
      { class: "stat-grid" },
      a.distance_km !== undefined ? stat("Distance", num(a.distance_km, 2), "km") : null,
      stat("Moving time", fmtDuration(a.moving_min) || "–"),
      isRun && a.avg_pace_min_km ? stat("Avg pace", a.avg_pace_min_km, "/km") : a.avg_speed_kmh ? stat("Avg speed", num(a.avg_speed_kmh, 1), "km/h") : null,
      a.avg_hr ? stat("Avg heart rate", String(a.avg_hr), "bpm") : null,
      a.max_hr ? stat("Max heart rate", String(a.max_hr), "bpm") : null,
      a.elevation_m !== undefined ? stat("Climb", num(a.elevation_m), "m") : null,
      v.load ? stat(v.load.estimated ? "Effort (estimated)" : "Effort", num(v.load.load), v.load.label?.toLowerCase() ?? "") : null,
      a.calories ? stat("Energy", num(a.calories), "kcal") : null,
    ),
  );
  // A run: how it went against the plan, records, last time, next time.
  if (isRun) nodes.push(runFinish(a.id));

  if (v.load?.rank) nodes.push(el("p", { class: "footnote" }, `Effort scores how long and how hard (by heart rate) a workout was. This one: ${v.load.label.toLowerCase()}, ${v.load.rank}.`));
  // How it went: the watch's "How did it feel?" and your notes (a win, a niggle, a note).
  nodes.push(howItWent(String(a.id), a.feeling));

  // Linked small multiples over distance: one crosshair, three single-series charts, no dual axes.
  const st = v.streams?.streams;
  const dist = st?.distance as Array<number | null> | undefined;
  if (st && dist?.length) {
    const x = dist.map((m, i) => (m ?? (i ? dist[i - 1] ?? 0 : 0)) / 1000);
    const smooth = (vals: Array<number | null>, w = 4) => vals.map((_, i) => {
      const win = vals.slice(Math.max(0, i - w), i + w + 1).filter((n): n is number => n !== null && Number.isFinite(n));
      return win.length ? win.reduce((s, n) => s + n, 0) / win.length : null;
    });
    const vel = st.velocity as Array<number | null> | undefined;
    const hr = st.heartrate as Array<number | null> | undefined;
    const alt = st.altitude as Array<number | null> | undefined;
    const fmtKm = (k: number) => `${num(k, k < 10 ? 1 : 0)} km`;
    const charts: Array<{ title: string; el: HTMLElement; make: (hover: (i: number | null) => void) => ChartHandle }> = [];
    if (vel?.some((n) => n)) {
      const paceVals = smooth(vel.map((s) => (s && s > 0.6 ? (isRun ? 1000 / s : s * 3.6) : null)));
      const node = el("div", { class: "chart" });
      charts.push({
        title: isRun ? "Pace" : "Speed",
        el: node,
        make: (hover) => lineChart(node, { x, xFormat: fmtKm, yFormat: (y) => (isRun ? `${fmtClock(y)}` : `${num(y, 1)}`), invert: isRun, yTime: isRun, height: 150, ariaLabel: isRun ? "Pace over distance" : "Speed over distance", series: [{ name: isRun ? "Pace /km" : "km/h", color: "var(--s1)", values: paceVals }], onHover: hover }),
      });
    }
    if (hr?.some((n) => n)) {
      const node = el("div", { class: "chart" });
      charts.push({ title: "Heart rate", el: node, make: (hover) => lineChart(node, { x, xFormat: fmtKm, yFormat: (y) => `${Math.round(y)}`, height: 150, ariaLabel: "Heart rate over distance", series: [{ name: "bpm", color: "var(--s2)", values: smooth(hr, 2) }], onHover: hover }) });
    }
    if (alt?.some((n) => n !== null)) {
      const node = el("div", { class: "chart" });
      charts.push({ title: "Elevation", el: node, make: (hover) => lineChart(node, { x, xFormat: fmtKm, yFormat: (y) => `${Math.round(y)} m`, height: 120, ariaLabel: "Elevation over distance", series: [{ name: "m", color: "var(--s-context)", values: smooth(alt, 2), area: true }], onHover: hover }) });
    }
    if (charts.length) {
      nodes.push(el("section", { class: "card flat" }, el("h3", {}, "Along the way"), ...charts.flatMap((c) => [el("h4", { class: "mini-title" }, c.title), c.el])));
      queueMicrotask(() => {
        const handles: ChartHandle[] = [];
        charts.forEach((c, k) => handles.push(c.make((i) => handles.forEach((h, j) => j !== k && h.setHover(i)))));
      });
    }
  }

  if (v.zones?.some((z) => z.seconds)) {
    const zbar = el("div", { class: "zones" });
    const segs = v.zones.map((z, i) => ({ name: `Z${z.zone} ${z.name} (${z.bpm[0]}–${z.bpm[1]} bpm)`, value: z.seconds, color: ZONE_COLORS[i]! }));
    stackBar(zbar, segs, (s) => fmtDuration(s / 60) || "<1 min");
    nodes.push(
      el(
        "section",
        { class: "card flat" },
        el("h3", {}, "Heart-rate zones"),
        zbar,
        legend(v.zones.map((z, i) => ({ name: `Z${z.zone} ${fmtDuration(z.seconds / 60) || "0 min"}`, color: ZONE_COLORS[i]!, shape: "rect" as const }))),
        tableTwin(["Zone", "Heart rate", "Time"], v.zones.map((z) => [`Z${z.zone} ${z.name}`, `${z.bpm[0]}–${z.bpm[1]} bpm`, fmtDuration(z.seconds / 60) || "0 min"])),
        el(
          "p",
          { class: "footnote" },
          v.profile.zones_source === "your watch"
            ? `Your watch's zones (Z2 from ${v.zones[1]?.bpm[0]}, Z3 ${v.zones[2]?.bpm[0]}, Z4 ${v.zones[3]?.bpm[0]}, Z5 ${v.zones[4]?.bpm[0]} bpm), as the Suunto app shows them.`
            : `Zones as % of ${v.profile.zones_source === "your max heart rate" ? "your" : "an estimated"} max heart rate (${v.profile.max_hr} bpm); change it in Settings.`,
        ),
      ),
    );
  }

  // A run counts to a pair of shoes: which, and a picker to change it for this run.
  if (/run|jog|trail|treadmill/i.test(a.sport)) nodes.push(runShoes(String(a.id)));
  nodes.push(workedCard(String(a.id)));

  if (a.splits_metric?.length) {
    nodes.push(
      el(
        "section",
        { class: "card flat" },
        el("h3", {}, "Splits"),
        el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "splits" },
            el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "km"), el("th", { scope: "col", class: "num" }, isRun ? "Pace" : "Speed"), el("th", { scope: "col", class: "num" }, "HR"), el("th", { scope: "col", class: "num" }, "Elev"))),
            el("tbody", {}, ...a.splits_metric.map((s) => el(
              "tr",
              {},
              el("td", {}, String(s.split)),
              el("td", { class: "num" }, s.average_speed ? (isRun ? `${fmtClock(1000 / s.average_speed)} /km` : `${num(s.average_speed * 3.6, 1)} km/h`) : "–"),
              el("td", { class: "num" }, s.average_heartrate ? String(Math.round(s.average_heartrate)) : "–"),
              el("td", { class: "num" }, s.elevation_difference !== undefined ? `${s.elevation_difference > 0 ? "+" : ""}${Math.round(s.elevation_difference)} m` : "–"),
            ))),
          ),
        ),
      ),
    );
  }

  nodes.push(sourcesCard(v, isRun));
  return nodes;
}

/**
 * What each source measured, side by side: the watch's own numbers next to Strava's, with
 * the value Tartan shows marked. Copies match when they overlap in time with the same sport.
 */
function sourcesCard(v: ActivityView, isRun: boolean): HTMLElement {
  const a = v.detail;
  const copies = [...a.copies].sort((x, y) => ORDER.indexOf(x.source) - ORDER.indexOf(y.source));
  const card = el("section", { class: "card sources-card" }, el("div", { class: "card-head" }, el("h3", {}, copies.length > 1 ? "Sources" : "Source")));
  if (copies.length > 1) {
    const starts = copies.map((c) => (c.start ? Date.parse(c.start) : NaN)).filter(Number.isFinite);
    const apart = starts.length > 1 ? Math.round((Math.max(...starts) - Math.min(...starts)) / 1000) : null;
    card.append(
      el(
        "p",
        { class: "match" },
        icon("check", "ic sm"),
        `Matched as one workout${apart !== null ? `: same sport, started ${apart < 1 ? "at the same second" : apart < 120 ? `${apart} s apart` : `${Math.round(apart / 60)} min apart`}` : ""}. It counts once in your totals.`,
      ),
    );
  } else {
    card.append(el("p", { class: "match" }, sourceBadges([copies[0]?.source ?? ""]), copies[0]?.source === "watch" ? "Read straight from the watch." : `Only on ${sourceName(copies[0]?.source ?? "")} so far.`));
  }
  const pace = (mps?: number) => (mps ? (isRun ? `${fmtClock(1000 / mps)} /km` : `${num(mps * 3.6, 1)} km/h`) : undefined);
  type Copy = (typeof copies)[number];
  const rows: Array<[string, keyof Copy, (c: Copy) => string | undefined]> = [
    ["Distance", "distance_m", (c) => (c.distance_m ? `${num(c.distance_m / 1000, 2)} km` : undefined)],
    ["Moving time", "moving_s", (c) => (c.moving_s ? fmtClock(c.moving_s) : undefined)],
    ["Total time", "elapsed_s", (c) => (c.elapsed_s ? fmtClock(c.elapsed_s) : undefined)],
    [isRun ? "Avg pace" : "Avg speed", "avg_speed", (c) => pace(c.avg_speed)],
    ["Avg heart rate", "avg_hr", (c) => (c.avg_hr ? `${Math.round(c.avg_hr)} bpm` : undefined)],
    ["Max heart rate", "max_hr", (c) => (c.max_hr ? `${Math.round(c.max_hr)} bpm` : undefined)],
    ["Climb", "elevation_m", (c) => (c.elevation_m ? `${Math.round(c.elevation_m)} m` : undefined)],
    ["Cadence", "avg_cadence", (c) => (c.avg_cadence ? `${Math.round(c.avg_cadence)} /min` : undefined)],
    ["Power", "avg_power", (c) => (c.avg_power ? `${Math.round(c.avg_power)} W` : undefined)],
    ["Energy", "calories", (c) => (c.calories ? `${Math.round(c.calories)} kcal` : undefined)],
  ];
  const body = el("tbody", {});
  for (const [label, field, fmt] of rows) {
    const cells = copies.map(fmt);
    if (cells.every((x) => x === undefined)) continue;
    const used = a.provenance[field as string];
    body.append(
      el(
        "tr",
        {},
        el("td", {}, label),
        ...copies.map((c, i) => el("td", { class: cells[i] === undefined ? "dim" : copies.length > 1 && used === c.source ? "used" : copies.length > 1 ? "off" : "" }, cells[i] ?? "–")),
      ),
    );
  }
  if (v.streams) {
    body.append(el("tr", {}, el("td", {}, "Map & charts"), ...copies.map((c) => el("td", { class: c.source === v.streams!.from ? "used" : "dim" }, c.source === v.streams!.from ? "✓" : c.has_streams ? "available" : "–"))));
  }
  // One copy: the line above says it all; the side by side is for copies that differ.
  if (body.childElementCount && copies.length > 1) {
    card.append(
      el(
        "div",
        { class: "table-wrap" },
        el("table", { class: "compare" }, el("thead", {}, el("tr", {}, el("th", { scope: "col" }, ""), ...copies.map((c) => el("th", { scope: "col" }, sourceBadges([c.source]))))), body),
      ),
    );
    if (copies.length > 1) card.append(el("p", { class: "footnote" }, "Bold with a dot: the value Tartan shows. Each number comes from the source that measures it best."));
  }
  return card;
}

const ORDER = ["watch", "strava", "health", "intervals", "phone", "suunto-cloud", "logged"];

/**
 * What this workout worked: the body small, its muscles shaded by their share of the load (the
 * Body page's model), the main ones named, and the way to how the body is now.
 */
/**
 * The real map under the route, as in the route editor: the line is drawn at once (routeMap),
 * the streets fade in under it when the map has loaded. A picture, not a control: it never takes
 * the sheet's scroll or drag. Offline, the line alone stays. Freed when the sheet closes.
 */
function streetMap(host: HTMLElement, latlng: Array<[number, number] | null>): void {
  const line = latlng.filter((p): p is [number, number] => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([la, lo]) => [lo, la] as [number, number]);
  if (line.length < 2) return;
  // The map's own element sits inside the overlay: MapLibre makes its container position: relative.
  const inner = el("div", { class: "route-street-map" });
  const box = el("div", { class: "route-street", "aria-hidden": "true" }, inner);
  host.prepend(box);
  // After the sheet is up (its entrance stays smooth), and only if it's still open.
  setTimeout(async () => {
    if (!host.isConnected) return;
    try {
      const { createMap, maplibregl } = await import("../lib/map.ts");
      const m = await createMap(inner, line[0]!, { interactive: false });
      const css = getComputedStyle(document.documentElement);
      const primary = css.getPropertyValue("--primary").trim() || "#a8321f";
      const paper = css.getPropertyValue("--surface-1").trim() || "#ffffff";
      m.addSource("run", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } } });
      m.addSource("ends", { type: "geojson", data: { type: "FeatureCollection", features: [line[0]!, line.at(-1)!].map((c, i) => ({ type: "Feature", properties: { end: i }, geometry: { type: "Point", coordinates: c } })) } });
      m.addLayer({ id: "run-casing", type: "line", source: "run", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": paper, "line-width": 7 } });
      m.addLayer({ id: "run-line", type: "line", source: "run", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": primary, "line-width": 3.5 } });
      m.addLayer({ id: "run-ends", type: "circle", source: "ends", paint: { "circle-radius": 5, "circle-color": ["case", ["==", ["get", "end"], 0], paper, primary], "circle-stroke-color": primary, "circle-stroke-width": 2 } });
      const b = line.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(line[0]!, line[0]!));
      m.fitBounds(b, { padding: 28, duration: 0, maxZoom: 16 });
      m.once("idle", () => host.classList.add("has-streets"));
      // WebGL contexts are scarce on phones: let go when the sheet does.
      const free = setInterval(() => {
        if (host.isConnected) return;
        clearInterval(free);
        m.remove();
      }, 1500);
    } catch {
      box.remove();
    }
  }, 450);
}

function workedCard(id: string): HTMLElement {
  const map = bodyMap({ levels: {} as Levels });
  map.classList.add("worked-map");
  map.setAttribute("aria-hidden", "true");
  void yourBody().then((f) => f !== "m" && map.setFigure(f));
  const line = el("p", { class: "sub" }, "");
  const toBody = el("a", { class: "text-btn", href: "#you", onclick: () => void closeActivity() }, "Your body now", icon("chevron", "ic sm"));
  const card = el("section", { class: "card flat worked", hidden: true }, el("div", { class: "card-head" }, el("h3", {}, "What it worked"), toBody), el("div", { class: "worked-body" }, map, line));
  void app.api
    .json<{ muscles: Array<{ muscle: Muscle; level: 0 | 1 | 2 | 3 | 4; share: number }> }>(`/api/body/workout?id=${encodeURIComponent(id)}`)
    .then(({ muscles }) => {
      if (!muscles.length) return;
      map.update(Object.fromEntries(muscles.map((m) => [m.muscle, m.level])) as Levels);
      const top = muscles.filter((m) => m.share >= 0.5).slice(0, 4).map((m) => MUSCLE_NAME[m.muscle].toLowerCase());
      const rest = muscles.filter((m) => m.share < 0.5).slice(0, 3).map((m) => MUSCLE_NAME[m.muscle].toLowerCase());
      const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
      line.textContent = `Mostly ${list(top)}${rest.length ? `; some ${list(rest)}` : ""}.`;
      card.setAttribute("aria-label", `What it worked: ${line.textContent}`);
      card.hidden = false;
    })
    .catch(() => {});
  return card;
}

export function closeActivity(): Promise<void> {
  return close();
}
