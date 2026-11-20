/** Progress: the long view, one range control scoping every card. Nothing here repeats Today. */
import { columnChart, legend, lineChart, stackBar, tableTwin } from "../lib/charts.ts";
import { dateShort, dayName, el, fmtClock, fmtDuration, icon, meta, num } from "../lib/dom.ts";
import { countUp, revealOnScroll, swap } from "../lib/motion.ts";
import { app, hooks, lastThenFresh } from "../state.ts";
import type { Dashboard, PlanView, WeekView } from "../types.ts";
import type { Durability } from "../../src/durability.ts";
import { activityRow } from "./activities.ts";
import { bodyLink, largeTitle, takeawayRow } from "./today.ts";

const RANGES = [
  { days: 7, label: "Week" },
  { days: 84, label: "12 weeks" },
  { days: 182, label: "6 months" },
  { days: 365, label: "1 year" },
];
let range = 84;
/** The week the Week view shows (any day in it); unset: this week. */
let weekOf: string | undefined;
const ZONE_COLORS = ["var(--z1)", "var(--z2)", "var(--z3)", "var(--z4)", "var(--z5)"];

export async function renderTrends(root: HTMLElement): Promise<void> {
  const seg = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Range" });
  const body = el("div", { class: "trends-body" });
  // What all this training is doing to your muscles: the Body page (no longer a tab).
  root.replaceChildren(largeTitle("Progress", "How your training is adding up"), el("div", { class: "toolbar" }, seg), body, el("div", { class: "card body-card" }, bodyLink("Which muscles your training loads, and when they're fresh")));
  for (const r of RANGES) {
    const b = el("button", { type: "button", role: "radio", class: "seg", "aria-checked": String(range === r.days) }, r.label);
    b.onclick = () => {
      if (range === r.days) return;
      // The new range slides in from the side of the option you picked.
      const dir = RANGES.findIndex((x) => x.days === r.days) > RANGES.findIndex((x) => x.days === range) ? 1 : -1;
      range = r.days;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      void draw(dir);
    };
    seg.append(b);
  }
  // The first paint reveals the cards as they scroll in; after that, data changes under a still frame.
  let painted = false;
  const show = async (nodes: Node[], dir: -1 | 0 | 1) => {
    if (!painted) {
      body.replaceChildren(...nodes);
      revealOnScroll(body);
      painted = true;
    } else await swap(body, nodes, dir);
  };
  const draw = async (dir: -1 | 0 | 1 = 0): Promise<void> => {
    if (!body.children.length) body.append(el("div", { class: "skeleton-card" }), el("div", { class: "skeleton-card" }));
    if (range === 7) return drawWeek(body, show, dir);
    const want = range;
    let first = true;
    await lastThenFresh<Dashboard>(`/api/dashboard?days=${want}`, (d) => {
      if (want !== range) return; // the range changed meanwhile
      const changing = d.takeaways.filter((t) => t.horizon === "trend");
      const nodes = [
        totalsRow(d),
        ...(changing.length ? [takeawayRow(changing, "What's changing")] : []),
        ...(d.targets?.race ? [racePrediction(d.targets.race)] : []),
        raceShapeCard(Math.round(want / 7), d.targets?.race?.distance_km),
        weeklyCard(d),
        el("div", { class: "grid-2" }, fitnessTrendCard(d), consistencyCard(d)),
        el("div", { class: "grid-2" }, zonesCard(d), efficiencyCard(d)),
        durabilityCard(Math.round(want / 7)),
        bestsCard(d),
      ];
      // Fresh numbers after the cached ones: replace quietly, the frame is already in place.
      if (first) void show(nodes, dir);
      else body.replaceChildren(...nodes);
      first = false;
    });
  };
  await draw();
}

function totalsRow(d: Dashboard): HTMLElement {
  const tile = (label: string, t: Dashboard["totals"]["week"]) => {
    const v = el("span", { class: "tile-value" }, "0");
    queueMicrotask(() => countUp(v, t.distance_km ?? 0, (n) => num(n, n < 100 ? 1 : 0)));
    return el("div", { class: "tile" }, el("span", { class: "tile-label" }, label), el("span", { class: "tile-row" }, v, el("small", {}, " km")), el("span", { class: "tile-sub" }, meta(`${t.activities} workouts`, `${num(t.hours ?? 0, 1)} h`, `${num(t.elevation_m)} m climb`)));
  };
  // This week is on Today; here: the whole range, the month and the year.
  const inRange = {
    activities: d.weeks.reduce((n, w) => n + w.activities, 0),
    distance_km: d.weeks.reduce((n, w) => n + (w.distance_km ?? 0), 0),
    hours: d.weeks.reduce((n, w) => n + (w.moving_hours ?? 0), 0),
    elevation_m: d.weeks.reduce((n, w) => n + w.elevation_m, 0),
  };
  const label = RANGES.find((r) => r.days === d.days)?.label ?? `${d.days} days`;
  return el("section", { class: "tiles", "aria-label": "Totals", "data-reveal": "" }, tile(`Last ${label}`, inRange), tile("This month", d.totals.month), tile("This year", d.totals.year));
}

function weeklyCard(d: Dashboard): HTMLElement {
  const weeks = [...d.weeks].reverse();
  const chart = el("div", { class: "chart" });
  const avg = weeks.slice(0, -1).reduce((n, w) => n + (w.distance_km ?? 0), 0) / Math.max(1, weeks.length - 1);
  queueMicrotask(() =>
    columnChart(chart, {
      labels: weeks.map((w) => dateShort(new Date(w.week))),
      values: weeks.map((w) => w.distance_km ?? 0),
      color: "var(--s1)",
      highlight: weeks.length - 1,
      height: 220,
      reference: d.targets?.goals.weekly_km ? { value: d.targets.goals.weekly_km, label: `target ${num(d.targets.goals.weekly_km)} km` } : undefined,
      yFormat: (v) => `${num(v)} km`,
      tipLabel: (i) => `Week of ${dateShort(new Date(weeks[i]!.week))} · ${weeks[i]!.activities} workouts`,
      ariaLabel: "Distance per week",
    }),
  );
  return el(
    "section",
    { class: "card", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Weekly distance"), el("p", { class: "sub" }, `Average ${num(avg, 1)} km a week${d.targets?.week ? `; target met in ${d.targets.week.hit} of the last ${d.targets.week.of_weeks} weeks` : "; this week highlighted"}`))),
    chart,
    tableTwin(["Week", "Distance", "Time", "Climb", "Workouts"], [...d.weeks].map((w) => [w.week, `${num(w.distance_km ?? 0, 1)} km`, fmtDuration((w.moving_hours ?? 0) * 60) || "0", `${num(w.elevation_m)} m`, String(w.activities)])),
  );
}

/** The race: predicted time from this year's best efforts, against the target. */
function racePrediction(r: NonNullable<Dashboard["targets"]["race"]>): HTMLElement {
  const name = r.name ?? `${num(r.distance_km, 1)} km race`;
  const gap = r.predicted_s && r.target_s ? r.predicted_s - r.target_s : null;
  return el(
    "section",
    { class: "card", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, name), el("p", { class: "sub" }, [`${num(r.distance_km, 1)} km`, r.date ? `${dateShort(new Date(r.date))}${r.days_to_go !== undefined && r.days_to_go >= 0 ? `, ${r.days_to_go} days to go` : ""}` : null].filter(Boolean).join(" · ")))),
    el(
      "dl",
      { class: "kpis" },
      el("div", {}, el("dt", {}, "Predicted"), el("dd", {}, r.predicted_s ? fmtClock(r.predicted_s) : "–")),
      el("div", {}, el("dt", {}, "Target"), el("dd", {}, r.target_s ? fmtClock(r.target_s) : "–")),
      el("div", {}, el("dt", {}, "Target pace"), el("dd", {}, r.target_pace ? `${r.target_pace} /km` : "–")),
    ),
    el(
      "p",
      { class: "footnote" },
      r.from
        ? `Predicted from your ${r.from.name} best this year (${fmtClock(r.from.time_s)}, ${dateShort(new Date(r.from.date))}), scaled to the race distance the way race times usually slow over longer distances.${gap === null ? "" : gap <= 0 ? ` That's ${fmtClock(-gap)} inside your target.` : ` ${fmtClock(gap)} to find before race day.`}`
        : "A prediction needs a best effort from this year: a synced Strava run of at least a mile.",
    ),
  );
}

/** Fitness only (fatigue and form are about today, on Today), with what the number means. */
function fitnessTrendCard(d: Dashboard): HTMLElement {
  const s = d.load.series;
  const chart = el("div", { class: "chart" });
  const first = s[0];
  const last = s.at(-1);
  const change = first && last ? last.fitness - first.fitness : 0;
  const sub = !first || !last ? "" : Math.abs(change) < 1 ? `Holding at ${num(last.fitness)} since ${dateShort(new Date(first.date))}` : `${change > 0 ? "Up" : "Down"} from ${num(first.fitness)} to ${num(last.fitness)} since ${dateShort(new Date(first.date))}`;
  if (s.length > 1) {
    queueMicrotask(() =>
      lineChart(chart, {
        x: s.map((p) => Date.parse(p.date)),
        xFormat: (t) => dateShort(new Date(t)),
        xTicks: (xs) => [xs[0]!, xs[Math.floor(xs.length / 2)]!, xs.at(-1)!],
        yFormat: (v) => num(v),
        height: 180,
        zero: true,
        ariaLabel: "Fitness over time",
        series: [{ name: "Fitness", color: "var(--s1)", values: s.map((p) => p.fitness), area: true }],
      }),
    );
  }
  return el(
    "section",
    { class: "card", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Fitness"), el("p", { class: "sub" }, sub))),
    s.length > 1 ? chart : el("p", { class: "empty" }, "Needs a few weeks of workouts."),
    el("p", { class: "footnote" }, "Your average daily training effort over 6 weeks, from how long and how hard you train. Steady growth means the training is adding up."),
    d.load.estimated_share > 0.3 ? el("p", { class: "footnote" }, `${Math.round(d.load.estimated_share * 100)}% of workouts had no heart rate; their effort is estimated from duration.`) : null,
  );
}

/** How regularly you train: workouts per week, active weeks, the current run of active weeks. */
function consistencyCard(d: Dashboard): HTMLElement {
  const weeks = [...d.weeks].reverse(); // oldest first
  const total = Math.ceil(d.days / 7);
  const byWeek = new Map(weeks.map((w) => [w.week, w.activities]));
  // Every week in the range, including empty ones (the summary only lists weeks with workouts).
  const all: Array<{ week: string; n: number }> = [];
  const monday = (t: number) => {
    const x = new Date(new Date(t).toISOString().slice(0, 10) + "T00:00:00Z");
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x.getTime();
  };
  for (let i = total - 1; i >= 0; i--) {
    const k = new Date(monday(Date.now()) - i * 7 * 86400_000).toISOString().slice(0, 10);
    all.push({ week: k, n: byWeek.get(k) ?? 0 });
  }
  const done = all.slice(0, -1); // complete weeks
  const active = done.filter((w) => w.n > 0).length;
  const avg = done.length ? done.reduce((n, w) => n + w.n, 0) / done.length : 0;
  let streak = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.n > 0) streak++;
    else if (i === all.length - 1) continue; // this week may not have started yet
    else break;
  }
  // Every day in the range (at least 12 weeks), shaded by that day's effort: the year at a glance.
  const chart = dayGrid(Math.min(53, Math.max(12, all.length)));
  return el(
    "section",
    { class: "card", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Consistency"), el("p", { class: "sub" }, "Every day you trained, shaded by its effort. Tap one to open it."))),
    el(
      "dl",
      { class: "kpis" },
      el("div", {}, el("dt", {}, "Per week"), el("dd", {}, num(avg, 1))),
      el("div", {}, el("dt", {}, "Active weeks"), el("dd", {}, `${active} of ${done.length}`)),
      el("div", {}, el("dt", {}, "Weeks in a row"), el("dd", {}, String(streak))),
    ),
    chart,
  );
}

interface RaceShape {
  distances: Array<{ name: string; metres: number; weeks: Array<{ week: string; s: number | null; from?: string }> }>;
}

/**
 * Race shape: week by week, what your fastest stretches of the six weeks before say you could
 * race at 5k, 10k, the half (and your race's distance). A line that rises is getting faster.
 */
function raceShapeCard(weeks: number, raceKm?: number): HTMLElement {
  const card = el("section", { class: "card race-shape", "data-reveal": "" });
  const n = Math.max(8, Math.min(52, weeks));
  void app.api
    .json<RaceShape>(`/api/race-shape?weeks=${n}`)
    .then((r) => {
      const has = r.distances.filter((d) => d.weeks.filter((w) => w.s).length >= 2);
      if (!has.length) return card.remove();
      // Your race's distance first when there is one, else the 10k.
      let pick = has.find((d) => raceKm && Math.abs(d.metres - raceKm * 1000) < 300) ?? has.find((d) => d.name === "10k") ?? has[0]!;
      const seg = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Distance" });
      const head = el("p", { class: "race-shape-head" });
      const chart = el("div", { class: "chart" });
      const foot = el("p", { class: "footnote" });
      const draw = () => {
        seg.querySelectorAll<HTMLElement>(".seg").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.name === pick.name)));
        const pts = pick.weeks.filter((w) => w.s) as Array<{ week: string; s: number; from?: string }>;
        const first = pts[0]!;
        const last = pts.at(-1)!;
        const diff = last.s - first.s;
        head.replaceChildren(
          el("b", {}, `${pick.name === "Half" ? "Half" : pick.name}: ${fmtClock(first.s)} → ${fmtClock(last.s)}`),
          el("span", { class: `sub ${diff < 0 ? "good" : ""}` }, ` ${Math.abs(diff) < 5 ? "about the same" : `${fmtClock(Math.abs(diff))} ${diff < 0 ? "faster" : "slower"}`} since ${dateShort(new Date(first.week))}`),
        );
        chart.replaceChildren();
        lineChart(chart, {
          x: pick.weeks.map((w) => Date.parse(w.week)),
          xFormat: (t) => dateShort(new Date(t)),
          yFormat: (v) => fmtClock(v),
          yTime: true,
          invert: true,
          // 6% of the race time: a 10k of 55 min spans at least 3:18, so 17 s reads as 17 s.
          minSpan: Math.round(last.s * 0.06),
          height: 170,
          ariaLabel: `Predicted ${pick.name} time per week`,
          series: [{ name: pick.name, color: "var(--s1)", values: pick.weeks.map((w) => w.s), area: false }],
        });
        foot.textContent = `This week's is from your ${last.from ?? "best"} stretch. Easy weeks read slower: it only knows what you've run fast lately.`;
      };
      for (const d of has) {
        const b = el("button", { type: "button", role: "radio", class: "seg", "data-name": d.name }, d.name);
        b.onclick = () => {
          pick = d;
          draw();
        };
        seg.append(b);
      }
      card.replaceChildren(el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Race shape"), el("p", { class: "sub" }, "What your runs say you could race, week by week"))), seg, head, chart, foot);
      queueMicrotask(draw);
    })
    .catch(() => card.remove());
  return card;
}

/**
 * One square per day, a column per week (Monday on top), newest on the right: empty days pale,
 * training days shaded by effort against your own (quartiles of your training days). Months
 * above. A long range scrolls sideways and opens at the latest week. Tap a day to open its
 * biggest workout.
 */
function dayGrid(weeks: number): HTMLElement {
  const box = el("div", { class: "day-grid-wrap" });
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400_000 - (weeks - 1) * 7 * 86400_000);
  const count = Math.round((today.getTime() - start.getTime()) / 86400_000) + 1;
  void app.api
    .json<Array<{ date: string; load: number; n: number; run_km: number; id?: string; name?: string }>>(`/api/days?days=${count}`)
    .then((days) => {
      const by = new Map(days.map((d) => [d.date, d]));
      const loads = days.filter((d) => d.n).map((d) => d.load).sort((a, b) => a - b);
      const q = (p: number) => loads[Math.min(loads.length - 1, Math.floor(p * loads.length))] ?? 0;
      const cuts = [q(0.25), q(0.5), q(0.75)];
      const level = (d?: { n: number; load: number }) => (!d?.n ? 0 : d.load <= cuts[0]! ? 1 : d.load <= cuts[1]! ? 2 : d.load <= cuts[2]! ? 3 : 4);
      const grid = el("div", { class: "day-grid", style: `--weeks:${weeks}` });
      let lastMonth = -1;
      for (let w = 0; w < weeks; w++) {
        const mon = new Date(start.getTime() + w * 7 * 86400_000);
        const m = mon.getUTCMonth();
        grid.append(el("span", { class: "dg-month", "aria-hidden": "true" }, m !== lastMonth && w < weeks - 1 ? mon.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }) : ""));
        lastMonth = m;
        for (let i = 0; i < 7; i++) {
          const t = new Date(mon.getTime() + i * 86400_000);
          const key = t.toISOString().slice(0, 10);
          if (t > today) {
            grid.append(el("i", { class: "dg-day future" }));
            continue;
          }
          const d = by.get(key);
          const cell = el("i", { class: `dg-day l${level(d)}${key === today.toISOString().slice(0, 10) ? " today" : ""}`, title: d?.n ? `${dateShort(t)}: ${d.name}${d.run_km ? `, ${num(d.run_km, 1)} km` : ""}` : dateShort(t) });
          if (d?.id) cell.dataset.id = d.id;
          grid.append(cell);
        }
      }
      grid.onclick = (e) => {
        const c = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
        if (c) hooks.openActivity(c.dataset.id!, c);
      };
      const trained = days.filter((d) => d.n).length;
      grid.setAttribute("role", "img");
      grid.setAttribute("aria-label", `${trained} days with training in the last ${weeks} weeks, ${days.filter((d) => d.run_km > 0).length} of them with a run.`);
      box.replaceChildren(grid, el("div", { class: "dg-legend", "aria-hidden": "true" }, "Less", ...[0, 1, 2, 3, 4].map((l) => el("i", { class: `dg-day l${l}` })), "More"));
    })
    .catch(() => box.remove());
  return box;
}

function zonesCard(d: Dashboard): HTMLElement {
  const total = d.zones.zones.reduce((n, z) => n + z.seconds, 0);
  const body = el("div", { class: "zones" });
  if (total) stackBar(body, d.zones.zones.map((z, i) => ({ name: `Z${z.zone} ${z.name}`, value: z.seconds, color: ZONE_COLORS[i]! })), (s) => fmtDuration(s / 60) || "<1 min");
  const easy = total ? Math.round(((d.zones.zones[0]!.seconds + d.zones.zones[1]!.seconds) / total) * 100) : 0;
  return el(
    "section",
    { class: "card", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Intensity mix"), el("p", { class: "sub" }, total ? `${easy}% easy (zones 1–2) across ${d.zones.activities} workouts. Most plans aim for about 80% easy.` : "Needs workouts with heart rate"))),
    total ? body : el("p", { class: "empty" }, "No heart-rate time series in this range yet."),
    total ? legend(d.zones.zones.map((z, i) => ({ name: `Z${z.zone} ${z.name} · ${fmtDuration(z.seconds / 60) || "0 min"}`, color: ZONE_COLORS[i]!, shape: "rect" as const }))) : null,
    total ? tableTwin(["Zone", "Time", "Share"], d.zones.zones.map((z) => [`Z${z.zone} ${z.name}`, fmtDuration(z.seconds / 60) || "0 min", `${Math.round((z.seconds / total) * 100)}%`])) : null,
  );
}

function efficiencyCard(d: Dashboard): HTMLElement {
  const e = d.efficiency;
  const chart = el("div", { class: "chart" });
  if (e.length >= 2) {
    queueMicrotask(() =>
      lineChart(chart, {
        x: e.map((w) => Date.parse(w.week)),
        xFormat: (t) => dateShort(new Date(t)),
        yFormat: (v) => `${num(v, 2)} m`,
        height: 180,
        ariaLabel: "Metres per heartbeat on easy runs, per week",
        series: [{ name: "per beat", color: "var(--s1)", values: e.map((w) => w.m_per_beat), area: true }],
      }),
    );
  }
  return el(
    "section",
    { class: "card", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Easy-run efficiency"), el("p", { class: "sub" }, "How far you go per heartbeat on easy runs. Up means the same effort carries you further."))),
    e.length >= 2 ? chart : el("p", { class: "empty" }, "Needs a few weeks of easy runs with heart rate."),
    e.length ? tableTwin(["Week", "Per beat", "Easy pace", "Runs"], e.map((w) => [w.week, `${num(w.m_per_beat, 2)} m`, w.easy_pace ? `${w.easy_pace} /km` : "–", String(w.runs)])) : null,
  );
}

/**
 * Long runs: does the effort hold? Heart-rate drift for the same hill-adjusted pace
 * (src/durability.ts), per run of an hour or more. Gone when there is no such run.
 */
function durabilityCard(weeks: number): HTMLElement {
  const card = el("section", { class: "card durability", "data-reveal": "" });
  void app.api
    .json<Durability>(`/api/durability?weeks=${Math.max(8, weeks)}`)
    .then((r) => {
      if (!r.runs.length) return card.remove();
      const steady = r.runs.filter((x) => x.steady).reverse();
      const chart = el("div", { class: "chart" });
      if (steady.length >= 2)
        queueMicrotask(() =>
          lineChart(chart, {
            x: steady.map((x) => Date.parse(x.date)),
            xFormat: (t) => dateShort(new Date(t)),
            yFormat: (v) => `${num(v, 1)}%`,
            height: 170,
            ariaLabel: "Heart-rate drift per long run",
            series: [{ name: "drift", color: "var(--s1)", values: steady.map((x) => x.drift_pct), area: false }],
          }),
        );
      const held = (x: Durability["runs"][number]) => (x.holds_until_min === null ? "to the end" : `slipped from ${x.holds_until_min} min`);
      card.replaceChildren(
        el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Long runs: does the effort hold?"), el("p", { class: "sub" }, "Heart rate against hill-adjusted pace, the second half against the first. Under 5% is a well-built aerobic base; heat and tired legs push it up."))),
        el("p", {}, r.summary),
        ...(steady.length >= 2 ? [chart] : []),
        tableTwin(
          ["Date", "Run", "Drift", "Effort"],
          r.runs.map((x) => [x.date, `${x.minutes} min${x.km ? `, ${num(x.km, 1)} km` : ""}${x.steady ? "" : " (not steady)"}`, `${num(x.drift_pct, 1)}%`, held(x)]),
        ),
      );
    })
    .catch(() => card.remove());
  return card;
}

function bestsCard(d: Dashboard): HTMLElement {
  const order = ["400m", "1/2 mile", "1k", "1 mile", "2 mile", "5k", "10k", "15k", "10 mile", "20k", "Half-Marathon", "30k", "Marathon"];
  const bests = [...d.bests].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return el(
    "section",
    { class: "card list-card", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Personal bests"), el("p", { class: "sub" }, "From Strava best efforts on synced runs"))),
    bests.length
      ? el(
          "ul",
          { class: "rows" },
          ...bests.map((b) => {
            const btn = el("button", { type: "button", class: "row" }, el("span", { class: "row-main" }, el("b", { class: "row-title" }, b.name), el("span", { class: "row-sub" }, dateShort(new Date(b.date)))), el("span", { class: "row-stats" }, el("b", {}, fmtClock(b.time_s)), el("span", {}, b.pace_min_km ? `${b.pace_min_km} /km` : "")));
            btn.onclick = () => hooks.openActivity(b.activity, btn);
            return el("li", {}, btn);
          }),
        )
      : el("p", { class: "empty" }, "Synced Strava runs with detail add their best efforts here."),
  );
}

// ------------------------------------------------------------------ one week

const SPORT_NAME: Record<string, string> = { run: "Running", ride: "Cycling", swim: "Swimming", walk: "Walking", ski: "Skiing", paddle: "Paddling", other: "Other" };

/** The Week range: one week day by day, stepping back and forth with the arrows. */
/** Last week view's totals: the tiles count from them to the new week's, so stepping reads as a change. */
let shownTotals: { km: number; hours: number; load: number } | null = null;

/**
 * The Week range. The week bar stays put while you step; only the week's content slides, from
 * the side you're going (back from the left, forward from the right).
 */
async function drawWeek(body: HTMLElement, show: (nodes: Node[], dir: -1 | 0 | 1) => Promise<void>, enterDir: -1 | 0 | 1): Promise<void> {
  const asked = weekOf;
  const [w, plan] = await Promise.all([
    app.api.json<WeekView>(`/api/week${asked ? `?start=${asked}` : ""}`),
    app.api.json<PlanView>("/api/plan").catch(() => null),
  ]);
  if (range !== 7 || asked !== weekOf) return; // moved on meanwhile
  const go = (to: string | null, dir: -1 | 1) => {
    if (!to) return;
    weekOf = to;
    void drawWeek(body, show, dir);
  };
  const start = new Date(`${w.start}T12:00:00`);
  const end = new Date(`${w.end}T12:00:00`);
  const title = w.current ? "This week" : weekLabel(w);
  const prevBtn = el("button", { type: "button", class: "icon-btn tonal", "aria-label": "Previous week", disabled: !w.prev, onclick: () => go(w.prev, -1) }, el("span", { class: "flip" }, icon("chevron")));
  const nextBtn = el("button", { type: "button", class: "icon-btn tonal", "aria-label": "Next week", disabled: !w.next, onclick: () => go(w.next, 1) }, icon("chevron"));
  const head = el(
    "section",
    { class: "week-nav", "aria-label": "Week" },
    prevBtn,
    el("div", { class: "week-nav-label" }, el("b", {}, title), el("span", { class: "sub" }, `${dateShort(start)} – ${dateShort(end)}`)),
    nextBtn,
  );

  const delta = (now: number, before: number, unit: string, digits = 0) => {
    if (!before) return w.current ? "so far" : "";
    const d = now - before;
    if (Math.abs(d) < (digits ? 0.05 : 0.5)) return "same as the week before";
    return `${d > 0 ? "+" : "−"}${num(Math.abs(d), digits)}${unit} on the week before`;
  };
  const tile = (label: string, value: number, fmt: (n: number) => string, from: number | undefined, unit: string, sub: string) => {
    const v = el("span", { class: "tile-value" }, fmt(from ?? value));
    v.dataset.value = String(from ?? value);
    queueMicrotask(() => countUp(v, value, fmt, 600));
    return el("div", { class: "tile" }, el("span", { class: "tile-label" }, label), el("span", { class: "tile-row" }, v, unit ? el("small", {}, ` ${unit}`) : null), el("span", { class: "tile-sub" }, sub));
  };
  const was = shownTotals;
  shownTotals = { km: w.totals.km, hours: w.totals.minutes / 60, load: w.totals.load };
  const tiles = el(
    "section",
    { class: "tiles", "aria-label": "Week totals", "data-reveal": "" },
    tile("Distance", w.totals.km, (n) => num(n, 1), was?.km, "km", delta(w.totals.km, w.previous.km, " km", 1)),
    tile("Time", w.totals.minutes / 60, (h) => fmtDuration(h * 60) || "0 min", was?.hours, "", delta(w.totals.minutes / 60, w.previous.minutes / 60, " h", 1)),
    tile("Effort", w.totals.load, (n) => num(n), was?.load, "", w.usual.load ? `usual week ${num(w.usual.load)}` : `${w.totals.workouts} workouts`),
  );

  // Day by day: distance when the week has any, else time.
  const byKm = w.totals.km > 0;
  const today = new Date().toISOString().slice(0, 10);
  const chart = el("div", { class: "chart" });
  queueMicrotask(() =>
    columnChart(chart, {
      labels: w.days.map((d) => dayName(new Date(`${d.date}T12:00:00`))),
      values: w.days.map((d) => (byKm ? d.km : d.minutes)),
      color: "var(--s1)",
      highlight: w.current ? w.days.findIndex((d) => d.date === today) : undefined,
      height: 200,
      yFormat: (v) => (byKm ? `${num(v)} km` : fmtDuration(v) || "0"),
      tipLabel: (i) => {
        const d = w.days[i]!;
        return `${dayName(new Date(`${d.date}T12:00:00`))} ${dateShort(new Date(`${d.date}T12:00:00`))} · ${d.workouts ? `${d.workouts} workout${d.workouts > 1 ? "s" : ""}, ${fmtDuration(d.minutes)}` : "rest"}`;
      },
      ariaLabel: byKm ? "Distance per day" : "Training time per day",
    }),
  );
  const restDays = w.days.filter((d) => !d.workouts && !d.future).length;
  const daysCard = el(
    "section",
    { class: "card", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Day by day"), el("p", { class: "sub" }, meta(`${w.totals.workouts} workout${w.totals.workouts === 1 ? "" : "s"}`, `${restDays} rest day${restDays === 1 ? "" : "s"}`, w.totals.climb ? `${num(w.totals.climb)} m climb` : null)))),
    chart,
    tableTwin(["Day", "Distance", "Time", "Workouts", "Effort"], w.days.map((d) => [d.date, `${num(d.km, 1)} km`, fmtDuration(d.minutes) || "0", String(d.workouts), num(d.load)])),
  );

  const acts = w.days.flatMap((d) => d.activities);
  const listCard = el(
    "section",
    { class: "card list-card", "data-reveal": "" },
    el("h2", {}, "Workouts"),
    acts.length ? el("ul", { class: "rows" }, ...acts.map((a) => activityRow(a))) : el("p", { class: "empty" }, w.current ? "Nothing yet this week." : "No workouts this week."),
  );

  const zoneTotal = w.zones.reduce((n, z) => n + z.seconds, 0);
  const zoneBar = el("div", {});
  if (zoneTotal) queueMicrotask(() => stackBar(zoneBar, w.zones.map((z, i) => ({ name: `Z${z.zone} ${z.name}`, value: z.seconds, color: ZONE_COLORS[i]! })), (v) => fmtDuration(v / 60) || "0 min"));
  const easy = zoneTotal ? Math.round(((w.zones[0]!.seconds + w.zones[1]!.seconds) / zoneTotal) * 100) : 0;
  const mixCard = el(
    "section",
    { class: "card", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Intensity and sports"), el("p", { class: "sub" }, zoneTotal ? `${easy}% easy (zones 1–2)` : "No heart rate this week"))),
    zoneTotal ? zoneBar : null,
    zoneTotal ? legend(w.zones.map((z, i) => ({ name: `Z${z.zone} ${z.name} · ${fmtDuration(z.seconds / 60) || "0 min"}`, color: ZONE_COLORS[i]!, shape: "rect" as const }))) : null,
    w.sports.length
      ? el("dl", { class: "kpis" }, ...w.sports.slice(0, 3).map((s) => el("div", {}, el("dt", {}, SPORT_NAME[s.sport] ?? s.sport), el("dd", {}, s.km ? `${num(s.km, 1)} km` : fmtDuration(s.minutes)))))
      : null,
  );

  const pw = plan?.weeks.find((p) => p.start === w.start);
  const planCard = pw
    ? el(
        "a",
        { class: "card plan-mini", href: "#coach", "data-reveal": "" },
        el("span", { class: "row-ic" }, icon("plan")),
        el("span", { class: "row-main" }, el("b", { class: "row-title" }, `Plan: ${pw.done.sessions} of ${pw.planned.sessions} sessions done`), el("span", { class: "row-sub" }, [pw.focus, pw.planned.km ? `${num(pw.done.km, 1)} of ${num(pw.planned.km, 0)} km` : ""].filter(Boolean).join(" · "))),
        icon("chevron", "ic chev"),
      )
    : null;

  const content = [tiles, ...(planCard ? [planCard] : []), daysCard, el("div", { class: "grid-2" }, listCard, mixCard)];
  // Already showing a week: keep the bar, update it in place, slide only the week's content.
  const bar = body.querySelector<HTMLElement>(":scope > .week-nav");
  const holder = body.querySelector<HTMLElement>(":scope > .week-content");
  if (bar && holder) {
    bar.replaceWith(head);
    await swap(holder, content, enterDir);
  } else await show([head, el("div", { class: "week-content" }, ...content)], enterDir);
}

function weekLabel(w: WeekView): string {
  const weeksAgo = Math.floor((Date.now() - Date.parse(`${w.start}T00:00:00`)) / (7 * 86400_000));
  return weeksAgo <= 1 ? "Last week" : `${weeksAgo} weeks ago`;
}
