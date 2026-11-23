/**
 * Routes: draw one on the map (tap to add points; the line follows footpaths, tracks and
 * streets, or goes straight), see its distance, climb and profile as you go, save it, and send
 * it to the watch as a GPX file through the Suunto app. #routes lists them; #route/<id> (or
 * #route/new) is the editor, a full-screen map under the tab bar.
 */
import { climb, lineOf, metres, toGpx, type LngLat, type Route, type RouteMode, type RouteSummary } from "../../src/routes.ts";
import { routeMap } from "../lib/charts.ts";
import { el, icon, num, svg } from "../lib/dom.ts";
import { saveFile } from "../lib/files.ts";
import { success, tick } from "../lib/haptics.ts";
import { revealOnScroll } from "../lib/motion.ts";
import { footloop, footpath, heights } from "../lib/routing.ts";
import type { Loop } from "../../src/route-loop.ts";
import { act, app, isNative, log, notify, plainWatchError } from "../state.ts";
import { largeTitle } from "./today.ts";
import { LIBRARY_SUB, libraryTabs } from "./activities.ts";
import * as watch from "../watch.ts";

const km = (m: number) => (m < 10_000 ? num(m / 1000, 2) : num(m / 1000, 1));
const VIEW_KEY = "freesuunto.map.view";
const MODE_KEY = "freesuunto.route.mode";
const store = {
  get: <T>(k: string): T | null => {
    try {
      return JSON.parse(localStorage.getItem(k) ?? "null") as T | null;
    } catch {
      return null;
    }
  },
  set: (k: string, v: unknown) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // no storage: the map just opens where it would otherwise
    }
  },
};

// ------------------------------------------------------------------ the list

export async function renderRoutes(root: HTMLElement): Promise<void> {
  const create = el("a", { class: "btn filled", href: "#route/new" }, icon("plus"), "New route");
  // The same head as Workouts, so the switch stays put; New route sits where the search is there.
  root.replaceChildren(largeTitle("Activities", LIBRARY_SUB), libraryTabs("routes"), el("div", { class: "toolbar routes-toolbar" }, create));
  const body = el("div", { class: "routes-body" }, el("div", { class: "skeleton-card" }));
  root.append(body);
  const { routes } = await app.api.json<{ routes: RouteSummary[] }>("/api/routes");

  const file = el("input", { type: "file", accept: ".gpx,application/gpx+xml,application/xml,text/xml", hidden: true });
  const importBtn = el("button", { type: "button", class: "btn text" }, icon("file", "ic sm"), "Import a GPX file");
  // The quickest way to a run: a loop of a distance from where you are.
  const quick = el(
    "section",
    { class: "card loop-quick", "data-reveal": "" },
    el("div", {}, el("h2", {}, icon("loop", "ic"), "A loop from here"), el("p", { class: "sub" }, "Three loops along paths from where you are; pick one, then send it to your watch.")),
    el("div", { class: "loop-quick-km" }, ...[5, 8, 10, 15, 21].map((k) => el("a", { class: "chip action", href: `#route/new/loop-${k}` }, `${k} km`))),
  );
  importBtn.onclick = () => file.click();
  file.onchange = () => {
    const f = file.files?.[0];
    if (!f) return;
    void act(importBtn, "Import", async () => {
      const res = await app.api.request(`/api/routes/import?name=${encodeURIComponent(f.name.replace(/\.gpx$/i, ""))}`, { method: "POST", body: await f.text() });
      const r = (await res.json()) as Route & { error?: string };
      if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
      notify(`Imported ${r.name}, ${km(r.distance_m)} km.`);
      location.hash = `#route/${r.id}`;
    });
  };

  if (!routes.length) {
    body.replaceChildren(
      quick,
      el(
        "div",
        { class: "empty-card routes-empty" },
        el("h3", {}, "No routes yet"),
        el("p", {}, "Tap the map to place points; the line follows paths and streets and shows the distance and climb as you go. Then send it to your watch."),
        el("div", { class: "row" }, el("a", { class: "btn filled", href: "#route/new" }, icon("route"), "Draw a route"), importBtn),
      ),
      file,
    );
    return;
  }
  const list = el(
    "ul",
    { class: "route-list" },
    ...routes.map((r) => {
      const thumb = el("div", { class: "route-thumb" });
      routeMap(thumb, r.preview.map(([lng, lat]) => [lat, lng]), `Map of ${r.name}`);
      return el(
        "li",
        {},
        el(
          "a",
          { class: "route-item", href: `#route/${r.id}` },
          thumb,
          el(
            "span",
            { class: "route-meta" },
            el("b", {}, r.name),
            el("span", { class: "sub" }, [`${km(r.distance_m)} km`, r.ascent_m !== undefined ? `↑ ${r.ascent_m} m` : "", r.loop ? "Loop" : ""].filter(Boolean).join(" · ")),
            r.watch ? el("span", { class: "on-watch" }, icon("watch", "ic xs"), "On your watch") : null,
          ),
          icon("chevron", "ic chev"),
        ),
      );
    }),
  );
  body.replaceChildren(quick, el("h2", { class: "section-title" }, "Your routes"), list, el("div", { class: "row" }, importBtn), file);
  list.querySelectorAll("li").forEach((li) => li.setAttribute("data-reveal", ""));
  revealOnScroll(list);
}

// ------------------------------------------------------------------ the editor

type Seg = { mode: RouteMode; coords: LngLat[] };

export async function renderRouteEditor(root: HTMLElement): Promise<void> {
  const id = decodeURIComponent(location.hash.split("/")[1] ?? "new");
  // #route/new/loop-10: straight to 10 km loops from where you are.
  const wantLoop = id === "new" ? Number(/^loop-(\d+)$/.exec(location.hash.split("/")[2] ?? "")?.[1] ?? 0) : 0;
  const existing = id !== "new" ? await app.api.json<Route>(`/api/routes/${encodeURIComponent(id)}`).catch(() => null) : null;
  if (id !== "new" && !existing) throw new Error("This route isn't here any more.");

  let savedId = existing?.id ?? null;
  let wp: LngLat[] = existing?.waypoints.map((p) => [...p] as LngLat) ?? [];
  let segs: Seg[] = existing?.segments.map((s) => ({ mode: s.mode, coords: s.coords })) ?? [];
  let elevation: number[] | null = existing?.elevation ?? null;
  let mode: RouteMode = store.get<RouteMode>(MODE_KEY) === "straight" ? "straight" : "paths";
  let dirty = false;
  const undoStack: Array<{ wp: LngLat[]; segs: Seg[] }> = [];

  // ---- the frame: map, a header over it, the panel at the bottom
  const mapEl = el("div", { class: "route-map", "data-no-stretch": "" });
  const back = el("a", { class: "icon-btn tonal", href: "#routes", "aria-label": "Back to routes" }, el("span", { class: "flip" }, icon("chevron")));
  const name = el("input", { type: "text", class: "route-name", value: existing?.name ?? "", placeholder: "Name this route", "aria-label": "Route name", maxlength: 80, autocomplete: "off" });
  name.oninput = () => (dirty = true);
  const locate = el("button", { type: "button", class: "icon-btn tonal", "aria-label": "Where am I" }, icon("locate"));
  const status = el("div", { class: "route-status", "aria-live": "polite" });
  const loopBar = el("div", { class: "route-loops", hidden: true });

  const dist = el("b", { class: "route-km" }, "0.00");
  const up = el("span", {}, "–");
  const down = el("span", {}, "–");
  const modes = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Line" });
  for (const [m, label] of [["paths", "Follow paths"], ["straight", "Straight"]] as const) {
    const b = el("button", { type: "button", class: "seg", role: "radio", "aria-checked": String(mode === m) }, label);
    b.onclick = () => {
      mode = m;
      store.set(MODE_KEY, m);
      modes.querySelectorAll(".seg").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    };
    modes.append(b);
  }
  // Shown once a route has heights (draw()); empty, it would only take room from the map.
  const profile = el("div", { class: "route-profile", "aria-hidden": "true", hidden: true });
  const tool = (ic: string, label: string, fn: () => void, short = label) => {
    const b = el("button", { type: "button", class: "route-tool", ...(short !== label ? { "aria-label": label } : {}) }, icon(ic), el("span", {}, short));
    b.onclick = () => {
      tick();
      fn();
    };
    return b;
  };
  const undoBtn = tool("undo", "Undo", () => undo());
  const loopBtn = tool("loop", "Back to start", () => void addPoint(wp[0]!), "To start");
  const outBtn = tool("outback", "Out and back", () => outAndBack(), "Out & back");
  const revBtn = tool("reverse", "Reverse", () => reverse());
  const paceBtn = tool("clock", "Race pace", () => racePacing());
  const save = el("button", { type: "button", class: "btn filled" }, "Save");
  // Straight to the watch over Bluetooth where this device can; the GPX (for the Suunto app,
  // or anything else) is always one tap away.
  const direct = watch.canBluetooth();
  const send = el("button", { type: "button", class: "btn tonal" }, icon("watch", "ic sm"), direct ? "Send to watch" : isNative ? "Share GPX" : "Download GPX");
  // Labelled: it's the way onto the watch through the Suunto app when sending direct doesn't work.
  const gpx = el("button", { type: "button", class: "btn tonal", "aria-label": isNative ? "Share as GPX" : "Download GPX" }, icon("file", "ic sm"), el("span", { class: "gpx-label" }, "GPX"));
  gpx.hidden = !direct;
  const panel = el(
    "section",
    { class: "route-panel" },
    el(
      "div",
      { class: "route-stats" },
      el("div", { class: "route-dist" }, dist, el("span", {}, "km")),
      el("div", { class: "route-climb" }, el("span", { "aria-label": "Climb" }, "↑ ", up), el("span", { "aria-label": "Descent" }, "↓ ", down)),
    ),
    profile,
    el("div", { class: "route-tools" }, undoBtn, loopBtn, outBtn, revBtn, paceBtn),
    el("div", { class: "route-actions" }, save, send, gpx),
  );
  const shell = el(
    "div",
    { class: "route-editor" },
    mapEl,
    el("header", { class: "route-head" }, back, name, locate, modes),
    el("div", { class: "route-bottom" }, loopBar, status, panel),
  );
  // Nothing to act on until the map is up and the route drawn (draw() sets these).
  undoBtn.disabled = loopBtn.disabled = outBtn.disabled = revBtn.disabled = paceBtn.disabled = save.disabled = send.disabled = gpx.disabled = true;
  status.textContent = "Loading the map…";
  root.replaceChildren(shell);

  // ---- the map
  const { createMap, maplibregl } = await import("../lib/map.ts");
  const { home } = await app.api.json<{ home: LngLat | null }>("/api/routes").catch(() => ({ home: null }));
  const last = store.get<{ center: LngLat; zoom: number }>(VIEW_KEY);
  let map: Awaited<ReturnType<typeof createMap>>;
  try {
    map = await createMap(mapEl, existing ? existing.waypoints[0]! : (last?.center ?? home));
  } catch (e) {
    log(`Route map: ${(e as Error).message}`);
    status.hidden = true;
    mapEl.replaceChildren(el("div", { class: "empty-card route-offline" }, el("h3", {}, "The map needs the internet"), el("p", {}, "Connect and open this again; saved routes are kept on this device.")));
    return;
  }
  // The map's centre is the middle of what you can see: above the bottom panel, which grows
  // with large text and the loop choices. Centring on you (or a route) uses it.
  const bottom = shell.querySelector<HTMLElement>(".route-bottom")!;
  const pad = () => map.setPadding({ top: 96, bottom: bottom.offsetHeight + 12, left: 0, right: 0 });
  pad();
  const watchPanel = new ResizeObserver(pad);
  watchPanel.observe(bottom);
  if (!existing && last) map.jumpTo({ center: last.center, zoom: last.zoom });
  map.on("moveend", () => store.set(VIEW_KEY, { center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom() }));
  // Leaving the editor frees the map (WebGL contexts are scarce on phones).
  const leave = () =>
    setTimeout(() => {
      if (mapEl.isConnected) return;
      window.removeEventListener("hashchange", leave);
      watchPanel.disconnect();
      map.remove();
    }, 1000);
  window.addEventListener("hashchange", leave);

  const primary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#a8321f";
  const paper = getComputedStyle(document.documentElement).getPropertyValue("--surface-1").trim() || "#ffffff";
  map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("km", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": paper, "line-width": 9 } });
  map.addLayer({ id: "route-line", type: "line", source: "route", filter: ["!", ["get", "pending"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": primary, "line-width": 4.5 } });
  // A part still being routed is dashed until the way is found.
  map.addLayer({ id: "route-pending", type: "line", source: "route", filter: ["get", "pending"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": primary, "line-width": 4.5, "line-dasharray": [1, 1.5] } });
  // Loop options, before one is picked: each in its own colour.
  const LOOP_COLOURS = [primary, getComputedStyle(document.documentElement).getPropertyValue("--s1").trim() || "#2a78d6", getComputedStyle(document.documentElement).getPropertyValue("--good").trim() || "#1d6b45"];
  map.addSource("loops", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "loop-options", type: "line", source: "loops", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-width": 4, "line-opacity": 0.8 } }, "route-casing");
  map.addLayer({ id: "km-dot", type: "circle", source: "km", paint: { "circle-radius": 8, "circle-color": paper, "circle-stroke-color": primary, "circle-stroke-width": 1.5 } });
  if (map.getStyle().glyphs) {
    map.addLayer({ id: "km-text", type: "symbol", source: "km", layout: { "text-field": ["get", "label"], "text-size": 10, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true }, paint: { "text-color": primary } });
  }
  if (existing) {
    const line = lineOf(existing.segments);
    const b = line.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(line[0]!, line[0]!));
    map.fitBounds(b, { padding: { top: 16, bottom: 28, left: 40, right: 40 }, duration: 0, maxZoom: 16 });
  }

  // ---- drawing
  let markers: InstanceType<typeof maplibregl.Marker>[] = [];
  let pending = new Set<Seg>();
  const say = (t: string) => (status.textContent = t);
  const snapshot = () => {
    undoStack.push({ wp: wp.map((p) => [...p] as LngLat), segs: segs.map((s) => ({ ...s })) });
    if (undoStack.length > 60) undoStack.shift();
    dirty = true;
  };
  /** A line from a to b: straight at once, then along paths when the router answers. */
  const segment = (a: LngLat, b: LngLat): Seg => {
    const s: Seg = { mode, coords: [a, b] };
    if (mode === "paths") {
      pending.add(s);
      void footpath(a, b).then((found) => {
        pending.delete(s);
        const i = segs.indexOf(s);
        if (i < 0) return draw();
        if (found.line) segs[i] = { mode: "paths", coords: found.line };
        else {
          segs[i] = { mode: "straight", coords: [a, b] };
          notify(
            found.reason === "no-path"
              ? "No path between those points, so that part is a straight line."
              : `Couldn't reach the path finder, so that part is a straight line (${found.detail.slice(0, 120)}).`,
            found.reason === "no-path" ? "info" : "error",
          );
        }
        draw();
      });
    }
    return s;
  };
  const addPoint = (p: LngLat) => {
    snapshot();
    if (wp.length) segs.push(segment(wp.at(-1)!, p));
    wp.push(p);
    draw();
  };
  const movePoint = (i: number, p: LngLat) => {
    snapshot();
    wp[i] = p;
    if (i > 0) segs[i - 1] = segment(wp[i - 1]!, p);
    if (i < wp.length - 1) segs[i] = segment(p, wp[i + 1]!);
    draw();
  };
  const removePoint = (i: number) => {
    snapshot();
    if (wp.length === 1) [wp, segs] = [[], []];
    else if (i === 0) [wp, segs] = [wp.slice(1), segs.slice(1)];
    else if (i === wp.length - 1) [wp, segs] = [wp.slice(0, -1), segs.slice(0, -1)];
    else {
      segs.splice(i - 1, 2, segment(wp[i - 1]!, wp[i + 1]!));
      wp.splice(i, 1);
    }
    draw();
  };
  const outAndBack = () => {
    if (wp.length < 2) return;
    snapshot();
    for (let i = segs.length - 1; i >= 0; i--) {
      segs.push({ mode: segs[i]!.mode, coords: [...segs[i]!.coords].reverse() });
      wp.push(wp[i]!);
    }
    draw();
  };
  const reverse = () => {
    if (wp.length < 2) return;
    snapshot();
    wp = [...wp].reverse();
    segs = [...segs].reverse().map((s) => ({ mode: s.mode, coords: [...s.coords].reverse() }));
    draw();
  };
  const undo = () => {
    const h = undoStack.pop();
    if (!h) return;
    [wp, segs] = [h.wp, h.segs];
    draw();
  };

  // Along paths, a tap near one lands on it (fingers are wider than paths).
  const { snapToPath } = await import("../lib/snap.ts");
  const placed = (lngLat: { lng: number; lat: number }): LngLat => {
    if (mode === "paths") {
      const on = snapToPath(map, map.project(lngLat));
      if (on) return on;
    }
    return [Math.round(lngLat.lng * 1e6) / 1e6, Math.round(lngLat.lat * 1e6) / 1e6];
  };
  map.on("click", (e) => addPoint(placed(e.lngLat)));
  // ---- where you are: a live dot; tap it to start (or carry on) from there
  let here: LngLat | null = null;
  const meDot = el("button", { type: "button", class: "me-dot", "aria-label": "You are here. Tap to add a point here" });
  const me = new maplibregl.Marker({ element: meDot });
  meDot.onclick = (e) => {
    e.stopPropagation();
    if (!here) return;
    tick();
    addPoint([Math.round(here[0] * 1e6) / 1e6, Math.round(here[1] * 1e6) / 1e6]);
  };
  let centred = !!existing;
  let looped = !wantLoop;
  const autoLoop = () => {
    if (looped || !mapEl.isConnected) return;
    looped = true;
    const go = () => [...loopBar.querySelectorAll("button")].find((b) => b.textContent === `${wantLoop} km`)?.click();
    if (map.loaded()) go();
    else map.once("load", go);
  };
  // Without a location in a few seconds, from the middle of the map.
  if (wantLoop) setTimeout(autoLoop, 6000);
  const watchId = navigator.geolocation?.watchPosition(
    (pos) => {
      if (!mapEl.isConnected) return;
      const first = !here;
      here = [pos.coords.longitude, pos.coords.latitude];
      me.setLngLat(here);
      if (first) {
        me.addTo(map);
        if (!wp.length) say("Tap the map where you start, or your blue dot");
      }
      // A new route opens where you are, once.
      if (!centred) {
        centred = true;
        map.jumpTo({ center: here, zoom: Math.max(map.getZoom(), 14.5) });
      }
      if (first) autoLoop();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 },
  );
  // Leaving the editor stops following you.
  const stopWatching = () =>
    setTimeout(() => {
      if (mapEl.isConnected) return;
      if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
      window.removeEventListener("hashchange", stopWatching);
    }, 1000);
  window.addEventListener("hashchange", stopWatching);
  locate.onclick = () => {
    if (here) return void map.flyTo({ center: here, zoom: Math.max(map.getZoom(), 14.5) });
    navigator.geolocation?.getCurrentPosition(
      (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 14.5) }),
      () => notify("Couldn't find where you are. Allow location for Tartan, or move the map by hand.", "error"),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  // ---- a loop from here: "10 km", three options on the map, tap one to make it the route
  let loopOptions: Loop[] = [];
  // Loops are told apart by letter and direction, not only by colour: A, B, C on the map and on the chips.
  const LETTERS = ["A", "B", "C"];
  const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const heading = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
  let loopMarks: InstanceType<typeof maplibregl.Marker>[] = [];
  const showLoops = (loops: Loop[]) => {
    loopOptions = loops;
    for (const m of loopMarks) m.remove();
    loopMarks = loops.map((l, i) => {
      // At the loop's far turning point, where the lines are furthest apart.
      const far = l.waypoints[Math.floor(l.waypoints.length / 2)] ?? l.waypoints[0]!;
      const tag = el("span", { class: "loop-letter", style: `--c:${LOOP_COLOURS[i % 3]}`, "aria-hidden": "true" }, LETTERS[i] ?? String(i + 1));
      return new maplibregl.Marker({ element: tag }).setLngLat(far).addTo(map);
    });
    (map.getSource("loops") as { setData(d: unknown): void } | undefined)?.setData({
      type: "FeatureCollection",
      features: loops.map((l, i) => ({ type: "Feature", properties: { colour: LOOP_COLOURS[i % 3] }, geometry: { type: "LineString", coordinates: lineOf(l.legs.map((coords) => ({ mode: "paths" as const, coords }))) } })),
    });
    if (loops.length) {
      const all = loops.flatMap((l) => l.legs.flat());
      const b = all.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(all[0]!, all[0]!));
      map.fitBounds(b, { padding: { top: 24, bottom: 28, left: 40, right: 40 }, maxZoom: 16 });
    }
    drawLoopBar();
  };
  const pickLoop = (l: Loop) => {
    snapshot();
    wp = l.waypoints.map((p) => [...p] as LngLat);
    segs = l.legs.map((coords) => ({ mode: "paths" as const, coords }));
    if (!name.value.trim()) name.value = `${num(l.km, 1)} km loop`;
    showLoops([]);
    draw();
  };
  function drawLoopBar() {
    loopBar.hidden = wp.length > 0 && !loopOptions.length;
    loopBar.classList.toggle("picking", loopOptions.length > 0);
    if (loopBar.hidden) return;
    if (loopOptions.length) {
      const cancel = el("button", { type: "button", class: "chip action", "aria-label": "No loop" }, icon("close", "ic xs"));
      cancel.onclick = () => showLoops([]);
      loopBar.replaceChildren(
        el("div", { class: "route-loops-head" }, el("span", { class: "route-loops-label" }, "Pick a loop"), cancel),
        ...loopOptions.map((l, i) => {
          const b = el("button", { type: "button", class: "chip action loop-pick", "aria-label": `Loop ${LETTERS[i] ?? i + 1}: ${num(l.km, 1)} km, heading ${heading(l.bearing)}` }, el("b", { class: "loop-tag", style: `--c:${LOOP_COLOURS[i % 3]}` }, LETTERS[i] ?? String(i + 1)), `${num(l.km, 1)} km ${heading(l.bearing)}`);
          b.onclick = () => pickLoop(l);
          return b;
        }),
      );
      return;
    }
    loopBar.replaceChildren(
      el("span", { class: "route-loops-label" }, "Or a loop from here"),
      ...[...new Set([5, 10, 15, 21, ...(wantLoop ? [wantLoop] : [])])].sort((a, b) => a - b).map((k) => {
        const b = el("button", { type: "button", class: "chip action" }, `${k} km`);
        b.onclick = () =>
          act(b, "Loops", async () => {
            const start: LngLat = here ?? [Math.round(map.getCenter().lng * 1e6) / 1e6, Math.round(map.getCenter().lat * 1e6) / 1e6];
            say(`Finding ${k} km loops…`);
            const { makeLoops } = await import("../../src/route-loop.ts");
            const loops = await makeLoops(start, k, async (a, c) => (await footpath(a, c)).line, { loop: footloop });
            say("");
            if (!loops.length) throw new Error(`No ${k} km loop along paths from here: try another distance, or move the map`);
            tick();
            showLoops(loops);
          });
        return b;
      }),
    );
  }

  let heightsToken = 0;
  let heightsTimer = 0;
  const draw = () => {
    const line = lineOf(segs);
    const src = map.getSource("route") as { setData(d: unknown): void } | undefined;
    src?.setData({
      type: "FeatureCollection",
      features: segs.map((s) => ({ type: "Feature", properties: { pending: pending.has(s) }, geometry: { type: "LineString", coordinates: s.coords } })),
    });
    // A dot at every kilometre.
    const kmDots: unknown[] = [];
    let run = 0;
    let next = 1000;
    for (let i = 1; i < line.length; i++) {
      const d = metres(line[i - 1]!, line[i]!);
      while (run + d >= next) {
        const t = (next - run) / d;
        kmDots.push({ type: "Feature", properties: { label: String(next / 1000) }, geometry: { type: "Point", coordinates: [line[i - 1]![0] + (line[i]![0] - line[i - 1]![0]) * t, line[i - 1]![1] + (line[i]![1] - line[i - 1]![1]) * t] } });
        next += 1000;
      }
      run += d;
    }
    (map.getSource("km") as { setData(d: unknown): void } | undefined)?.setData({ type: "FeatureCollection", features: kmDots });

    // Points you can drag; tap the start to close the loop, any other point to take it out.
    for (const m of markers) m.remove();
    markers = wp.map((p, i) => {
      const dot = el("button", { type: "button", class: `wp${i === 0 ? " start" : ""}${i === wp.length - 1 && i > 0 ? " end" : ""}`, "aria-label": i === 0 ? "Start" : i === wp.length - 1 ? "End" : `Point ${i + 1}` });
      dot.onclick = (e) => {
        e.stopPropagation();
        if (i === 0 && wp.length > 1) addPoint(wp[0]!);
        else removePoint(i);
      };
      const m = new maplibregl.Marker({ element: dot, draggable: true }).setLngLat(p).addTo(map);
      m.on("dragend", () => movePoint(i, placed(m.getLngLat())));
      return m;
    });

    const total = line.length > 1 ? line.reduce((n, p, i) => (i ? n + metres(line[i - 1]!, p) : 0), 0) : 0;
    dist.textContent = km(total);
    undoBtn.disabled = !undoStack.length;
    loopBtn.disabled = outBtn.disabled = revBtn.disabled = paceBtn.disabled = wp.length < 2;
    save.disabled = send.disabled = gpx.disabled = wp.length < 2;
    drawLoopBar();
    say(!wp.length ? (here ? "Tap the map where you start, or your blue dot" : "Tap the map where you start") : wp.length === 1 ? "Tap where you're heading" : pending.size ? "Finding the way…" : "");

    // Heights follow once the line has settled.
    const token = ++heightsToken;
    clearTimeout(heightsTimer);
    if (line.length < 2 || pending.size) {
      if (line.length < 2) elevation = null;
      return paintHeights(line);
    }
    if (elevation?.length === line.length) return paintHeights(line);
    elevation = null;
    paintHeights(line);
    heightsTimer = window.setTimeout(async () => {
      const h = await heights(line);
      if (token !== heightsToken) return;
      elevation = h;
      paintHeights(line);
    }, 500);
  };

  const paintHeights = (line: LngLat[]) => {
    if (!elevation || elevation.length !== line.length) {
      up.textContent = down.textContent = "–";
      profile.replaceChildren();
      profile.hidden = true;
      return;
    }
    const c = climb(elevation);
    up.textContent = `${c.ascent_m} m`;
    down.textContent = `${c.descent_m} m`;
    const d = [0];
    for (let i = 1; i < line.length; i++) d.push(d[i - 1]! + metres(line[i - 1]!, line[i]!));
    const W = 600;
    const H = 64;
    const lo = Math.min(...elevation);
    const hi = Math.max(...elevation, lo + 20);
    const x = (i: number) => ((d[i]! / (d.at(-1) || 1)) * W).toFixed(1);
    const y = (e: number) => (H - 4 - ((e - lo) / (hi - lo)) * (H - 12)).toFixed(1);
    const step = Math.max(1, Math.floor(line.length / 300));
    const pts = elevation.map((e, i) => (i % step === 0 || i === elevation!.length - 1 ? `${x(i)},${y(e)}` : "")).filter(Boolean);
    profile.hidden = false;
    profile.replaceChildren(
      svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" }, svg("path", { d: `M0,${H} L${pts.join(" L")} L${W},${H} Z`, class: "route-profile-area" }), svg("path", { d: `M${pts.join(" L")}`, class: "route-profile-line" })),
      el("span", { class: "route-profile-max" }, `${Math.round(Math.max(...elevation))} m`),
      el("span", { class: "route-profile-min" }, `${Math.round(lo)} m`),
    );
  };

  // ---- save and send
  const body = () => ({ name: name.value.trim() || defaultName(), waypoints: wp, segments: segs, ...(elevation?.length === lineOf(segs).length ? { elevation } : {}) });
  const defaultName = () => {
    const line = lineOf(segs);
    const loop = line.length > 2 && metres(line[0]!, line.at(-1)!) < 60;
    return `${km(line.reduce((n, p, i) => (i ? n + metres(line[i - 1]!, p) : 0), 0))} km ${loop ? "loop" : "route"}`;
  };
  const persist = async (): Promise<Route> => {
    if (pending.size) throw new Error("Still finding the way: try again in a moment");
    const res = await app.api.request(`/api/routes/${savedId ?? "new"}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
    const r = (await res.json()) as Route & { error?: string };
    if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
    savedId = r.id;
    name.value = r.name;
    dirty = false;
    // The address follows the saved route (without re-rendering the editor).
    if (location.hash !== `#route/${r.id}`) history.replaceState(null, "", `#route/${r.id}`);
    return r;
  };
  save.onclick = () =>
    act(save, "Save", async () => {
      const r = await persist();
      success();
      notify(`Saved ${r.name}.`);
    });
  const shareGpx = async () => {
    const r = await persist();
    await saveFile(`${r.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "route"}.gpx`, toGpx(r), "application/gpx+xml", "Open in the Suunto app");
    if (!isNative) notify("Saved the GPX. Import it in the Suunto app (Map → Routes → Import) to put it on your watch.");
  };
  gpx.onclick = () => act(gpx, "GPX", shareGpx);
  // ---- race pacing: even effort over this course's hills for a target time
  const PACE_KEY = "freesuunto.route.target";
  const racePacing = () => {
    if (pending.size) return notify("Still finding the way: try again in a moment.");
    const line = lineOf(segs);
    const dialog = el("dialog", { class: "sheet pace-sheet", "aria-labelledby": "pace-title" });
    const close = () => {
      dialog.close();
      dialog.remove();
    };
    dialog.addEventListener("click", (e) => e.target === dialog && close());
    const time = el("input", { type: "text", inputmode: "numeric", placeholder: "e.g. 1:45:00 or 48:30", value: store.get<string>(PACE_KEY) ?? "", "aria-label": "Target time", autocomplete: "off" });
    const result = el("div", { class: "pace-result" });
    const status = el("p", { class: "footnote", "aria-live": "polite" });
    const work = el("button", { type: "submit", class: "btn filled" }, "Work it out");
    const routeName = () => name.value.trim() || defaultName();
    const form = el("form", { class: "pace-form" }, el("label", { class: "field" }, el("span", {}, "Target time"), time), work);
    form.onsubmit = (e) => {
      e.preventDefault();
      const { parseTime, raceSplits, pacingWorkout, clock } = paceLib!;
      const target = parseTime(time.value);
      if (!target) return void (status.textContent = "Type a time like 1:45:00, 48:30 or 50 (minutes).");
      store.set(PACE_KEY, time.value.trim());
      const { splits, marks, line: course } = raceSplits(line, elevation?.length === line.length ? elevation : null, target);
      const fmtPace = (s: number) => `${clock(s)} /km`;
      const table = el(
        "table",
        { class: "pace-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "km"), el("th", { class: "num" }, "Pace"), el("th", { class: "num" }, "Time"), el("th", { class: "num" }, "Climb"))),
        el("tbody", {}, ...splits.map((sp) => el("tr", {}, el("td", {}, sp.distance_m < 1000 ? `${sp.km - 1}–${num((sp.km - 1) + sp.distance_m / 1000, 1)}` : String(sp.km)), el("td", { class: "num" }, fmtPace(sp.pace_s)), el("td", { class: "num" }, clock(sp.cumulative_s)), el("td", { class: "num" }, sp.climb_m ? `↑${sp.climb_m} m` : "")))),
      );
      const toWatch = watch.canBluetooth();
      const courseBtn = el("button", { type: "button", class: "btn tonal" }, icon("route", "ic sm"), "Course with splits");
      courseBtn.disabled = !toWatch;
      courseBtn.onclick = () =>
        act(courseBtn, "Course to the watch", async () => {
          const res = await watch.sendRoute({ name: routeName(), line: course, waypoints: [], named: marks }, (t) => (status.textContent = t));
          success();
          status.textContent = `On your watch with a split every km (route ${res.id}).`;
        });
      const workoutBtn = el("button", { type: "button", class: "btn tonal" }, icon("watch", "ic sm"), "Pacing workout");
      workoutBtn.disabled = !toWatch;
      workoutBtn.onclick = () =>
        act(workoutBtn, "Pacing to the watch", async () => {
          await watch.putWorkout(pacingWorkout(`${routeName()} ${clock(target)}`.slice(0, 30), splits), (t) => (status.textContent = t));
          success();
          status.textContent = "The pacing workout is on your watch: start it from the sport mode's workout options.";
        });
      result.replaceChildren(
        el("p", { class: "sub" }, elevation?.length === line.length ? "Even effort: slower up the climbs, quicker down them, so the hills cost what they should." : "No heights for this course yet, so an even pace."),
        el("div", { class: "table-wrap" }, table),
        el("div", { class: "row" }, courseBtn, workoutBtn),
        toWatch ? el("p", { class: "footnote" }, "The course goes with a named point every km (\"5k 24:10\"); the workout guides each km at its pace, ±5 s.") : el("p", { class: "footnote" }, "Open Tartan on your phone to send these to the watch."),
      );
    };
    let paceLib: typeof import("../../src/race-pace.ts") | null = null;
    void import("../../src/race-pace.ts").then((m) => {
      paceLib = m;
      if (time.value) form.requestSubmit();
    });
    dialog.append(
      el(
        "div",
        { class: "sheet-body" },
        el("div", { class: "grabber", "aria-hidden": "true" }),
        el("div", { class: "row spread" }, el("h2", { id: "pace-title" }, "Race pacing"), el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))),
        el("p", { class: "sub" }, `${routeName()} · ${km(line.reduce((n, p, i) => (i ? n + metres(line[i - 1]!, p) : 0), 0))} km`),
        form,
        status,
        result,
      ),
    );
    document.body.append(dialog);
    dialog.showModal();
  };

  send.onclick = () =>
    act(send, "Send", async () => {
      if (!direct) return shareGpx();
      const r = await persist();
      try {
        const res = await watch.sendRoute({ name: r.name, line: lineOf(r.segments), elevation: r.elevation, waypoints: r.waypoints }, say);
        await app.api.request(`/api/routes/${r.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body(), watch: { id: res.id, sent: new Date().toISOString(), name: r.name } }) });
        success();
        notify(`${r.name} is on your watch. Find it under Navigation → Routes.`);
      } catch (e) {
        // In words, with the way round it right there; the watch's own answer goes to the log.
        log(`Route to the watch: ${(e as Error).message}`);
        notify(`${plainWatchError((e as Error).message) ?? "The route didn't go to the watch. Nothing on the watch changed."} You can still put it on through the Suunto app.`, "error", { label: isNative ? "Share GPX" : "Download GPX", run: () => act(null, "GPX", shareGpx) });
      } finally {
        say("");
      }
    });

  // Leaving with unsaved points: one tap more.
  back.onclick = (e) => {
    if (!dirty || wp.length < 2 || back.dataset.armed) return;
    e.preventDefault();
    back.dataset.armed = "1";
    notify("This route isn't saved. Tap back again to leave it.");
    setTimeout(() => delete back.dataset.armed, 4000);
  };

  draw();
  // Nothing to centre on (no workouts with GPS, the map never moved): find where you are.
  if (!existing && !last && !home) locate.click();
}
