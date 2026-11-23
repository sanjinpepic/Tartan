/** Activities: every workout once, grouped by week, searchable. */
import { dateShort, dayName, el, fmtDuration, hhmm, icon, num, sportIcon } from "../lib/dom.ts";
import { revealOnScroll, swap } from "../lib/motion.ts";
import { app, hooks } from "../state.ts";
import type { Activity } from "../types.ts";
import { sourceBadges } from "../lib/sources.ts";
import { largeTitle } from "./today.ts";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "run", label: "Runs" },
  { id: "ride", label: "Rides" },
  { id: "other", label: "Other" },
] as const;

let filter: (typeof FILTERS)[number]["id"] = "all";
let query = "";

export function activityRow(a: Activity): HTMLElement {
  const d = new Date(a.start);
  const btn = el(
    "button",
    // No aria-label: the row reads as it looks (name, when, where from, distance, time, pace).
    { type: "button", class: "row" },
    el("span", { class: "row-ic" }, icon(sportIcon(a.sport))),
    el(
      "span",
      { class: "row-main" },
      el("b", { class: "row-title" }, a.name ?? a.sport),
      el("span", { class: "row-sub with-src" }, el("span", { class: "when" }, `${dayName(d)} ${dateShort(d)} · ${hhmm(d)}`), sourceBadges(a.sources, { labels: false })),
    ),
    el(
      "span",
      { class: "row-stats" },
      el("b", {}, a.distance_km !== undefined ? `${num(a.distance_km, 2)} km` : fmtDuration(a.moving_min)),
      el("span", {}, [a.distance_km !== undefined ? fmtDuration(a.moving_min) : "", a.avg_pace_min_km ? `${a.avg_pace_min_km} /km` : a.avg_hr ? `${a.avg_hr} bpm` : ""].filter(Boolean).join(" · ")),
    ),
    icon("chevron", "ic chev"),
  );
  btn.onclick = () => hooks.openActivity(a.id, btn);
  return el("li", {}, btn);
}

const family = (sport: string) => {
  const s = sport.toLowerCase();
  if (/run|jog|trail|treadmill/.test(s)) return "run";
  if (/ride|cycl|bik/.test(s)) return "ride";
  return "other";
};

function weekStart(iso: string): string {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString();
}

/** Both halves of the tab share their head, so the switch never moves. */
export const LIBRARY_SUB = "Every workout once, and your routes";

/** Workouts and routes, one tab: the switch at the top of each. */
export function libraryTabs(current: "activities" | "routes"): HTMLElement {
  const link = (id: "activities" | "routes", label: string) => el("a", { class: "seg", href: `#${id}`, ...(id === current ? { "aria-current": "page" } : {}) }, label);
  return el("nav", { class: "segmented library-tabs", "aria-label": "Activities" }, link("activities", "Workouts"), link("routes", "Routes"));
}

export async function renderActivities(root: HTMLElement): Promise<void> {
  const search = el("input", { type: "search", class: "search", placeholder: "Search workouts", "aria-label": "Search workouts", value: query });
  const seg = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Sport" });
  const list = el("div", { class: "groups" });
  root.replaceChildren(largeTitle("Activities", LIBRARY_SUB), libraryTabs("activities"), el("div", { class: "toolbar" }, search, seg), list);
  list.append(el("div", { class: "skeleton-card" }));
  const all = await app.api.json<Activity[]>("/api/library/activities?limit=3000");

  // Reveal on the first paint only; filtering and searching change the list in place.
  let painted = false;
  const draw = (dir: -1 | 0 | 1 = 0) => {
    const q = query.trim().toLowerCase();
    const rows = all.filter((a) => (filter === "all" || family(a.sport) === filter) && (!q || `${a.name ?? ""} ${a.sport} ${a.device ?? ""}`.toLowerCase().includes(q)));
    if (!rows.length) {
      const empty =
        el(
          "div",
          { class: "empty-card" },
          el("h3", {}, all.length ? "Nothing matches" : "No workouts yet"),
          el("p", {}, all.length ? "Try another search or sport." : "Connect Strava for your full history, or back up the watch. Each workout appears once even when it is in both."),
          all.length ? null : el("a", { class: "btn tonal", href: "#settings" }, "Connect Strava or the watch"),
        );
      if (painted) void swap(list, empty, dir);
      else list.replaceChildren(empty);
      painted = true;
      return;
    }
    const groups = new Map<string, Activity[]>();
    for (const a of rows.slice(0, 400)) {
      const k = weekStart(a.start);
      groups.set(k, [...(groups.get(k) ?? []), a]);
    }
    const nodes: Node[] = [
      ...[...groups.entries()].map(([wk, acts]) => {
        const km = acts.reduce((n, a) => n + (a.distance_km ?? 0), 0);
        const min = acts.reduce((n, a) => n + (a.moving_min ?? 0), 0);
        return el(
          "section",
          { class: "group", "data-reveal": "" },
          el("h2", { class: "group-head" }, el("span", {}, `Week of ${dateShort(new Date(wk))}`), el("span", { class: "sr-only" }, ", "), el("span", { class: "group-sum" }, `${num(km, 1)} km · ${fmtDuration(min)}`)),
          el("ul", { class: "rows inset" }, ...acts.map(activityRow)),
        );
      }),
      ...(rows.length > 400 ? [el("p", { class: "footnote" }, `Showing the latest 400 of ${rows.length}. Search to find older ones.`)] : []),
    ];
    if (!painted) {
      list.replaceChildren(...nodes);
      revealOnScroll(list);
    } else if (dir) void swap(list, nodes, dir);
    else list.replaceChildren(...nodes);
    painted = true;
  };

  for (const f of FILTERS) {
    const b = el("button", { type: "button", role: "radio", "aria-checked": String(filter === f.id), class: "seg" }, f.label);
    b.onclick = () => {
      if (filter === f.id) return;
      const dir = FILTERS.findIndex((x) => x.id === f.id) > FILTERS.findIndex((x) => x.id === filter) ? 1 : -1;
      filter = f.id;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      draw(dir);
    };
    seg.append(b);
  }
  let t: ReturnType<typeof setTimeout> | undefined;
  search.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      query = search.value;
      draw();
    }, 120);
  };
  draw();
}
