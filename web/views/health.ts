/**
 * What the watch measured while you wore it (src/health.ts): resting heart rate against your usual,
 * last night's rest, blood oxygen, steps, and today's heart rate. On the You page in full, and as a
 * strip in Today's readiness card that leads there.
 */
import { el, fmtDuration, icon, num } from "../lib/dom.ts";
import { app } from "../state.ts";

interface HealthDay {
  date: string;
  worn_min: number;
  resting_hr: number | null;
  hr_min: number | null;
  hr_max: number | null;
  steps: number;
  active_kcal: number;
  spo2: Array<{ at: string; pct: number }>;
  night: { start: string; end: string; minutes: number; hr_avg: number; hr_min: number } | null;
  /** From another app via Health Connect. */
  sleep: { start: number; end: number; source: string; minutes: { asleep: number; awake: number; light: number; deep: number; rem: number } } | null;
  hrv_ms: number | null;
}
export interface HealthView {
  days: HealthDay[];
  resting_baseline: number | null;
  today_hr: Array<number | null>;
  latest: { at: string; hr?: number; spo2?: number } | null;
  last_t: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (local: string) => local.slice(11, 16);
/** "today", "yesterday", or the weekday. */
export const whenDay = (date: string) => {
  const today = new Date();
  if (date === isoDay(today)) return "today";
  if (date === isoDay(new Date(today.getTime() - 86400_000))) return "yesterday";
  return new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: "long" });
};

/** Today's heart rate every 10 minutes as a line, with gaps where the watch wasn't worn. */
function sparkline(hr: Array<number | null>): SVGSVGElement | null {
  const got = hr.filter((x): x is number => x !== null);
  if (got.length < 2) return null;
  const [lo, hi] = [Math.min(...got), Math.max(...got)];
  const W = 288;
  const H = 56;
  const x = (i: number) => (i / 143) * W;
  const y = (v: number) => H - 4 - ((v - lo) / Math.max(1, hi - lo)) * (H - 8);
  let d = "";
  hr.forEach((v, i) => {
    if (v === null) return;
    d += `${i && hr[i - 1] !== null ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
  });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "hr-line");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Heart rate today, ${lo} to ${hi} bpm`);
  svg.innerHTML = `<path class="hr-noon" d="M${W / 2} 0V${H}"/><path class="hr-path" d="${d}"/>`;
  return svg;
}

function tile(cls: string, ic: string, label: string, value: Node | string, note: Node | string, tone = ""): HTMLElement {
  return el("div", { class: `body-tile ${cls}${tone ? ` ${tone}` : ""}` }, el("dt", {}, icon(ic, "ic sm"), label), el("dd", {}, value), el("p", { class: "body-note" }, note));
}
const big = (n: string, unit: string) => el("span", {}, n, el("small", {}, unit));

/** The body's figures: tiles, today's heart rate, and what they mean. */
export function bodyNodes(h: HealthView): Node[] {
  const today = isoDay(new Date());
  const day = h.days.find((d) => d.date === today);

  // Resting heart rate: today's, else the latest day with one.
  const rest = h.days.find((d) => d.resting_hr !== null);
  const diff = rest && h.resting_baseline !== null ? rest.resting_hr! - h.resting_baseline : null;
  const restTile = rest
    ? tile(
        "rest",
        "heart",
        "Resting heart rate",
        big(String(rest.resting_hr), " bpm"),
        diff === null ? (rest.date === today ? "Lowest still half hour today" : `Lowest still half hour ${whenDay(rest.date)}`)
        : Math.abs(diff) < 3 ? `Your usual (${h.resting_baseline})`
        : `${diff > 0 ? "+" : "−"}${Math.abs(diff)} on your usual ${h.resting_baseline}${rest.date === today ? "" : `, ${whenDay(rest.date)}`}`,
        diff !== null && diff >= 7 ? "warn" : diff !== null && diff <= -3 ? "good" : "",
      )
    : tile("rest", "heart", "Resting heart rate", "–", "Wear the watch to bed");

  // Last night: as another app recorded it (Health Connect), else estimated from the watch's log.
  const night = day?.night ?? null;
  const sl = day?.sleep ?? null;
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const stages = sl && sl.minutes.deep + sl.minutes.rem > 0 ? ` · deep ${fmtDuration(sl.minutes.deep)} · REM ${fmtDuration(sl.minutes.rem)}` : "";
  const sleepTile = sl
    ? tile("sleep", "moon", "Last night", fmtDuration(sl.minutes.asleep), `${hm(sl.start)}–${hm(sl.end)}${stages}${day?.hrv_ms ? ` · HRV ${day.hrv_ms} ms` : ""}`)
    : night
      ? tile("sleep", "moon", "Last night", fmtDuration(night.minutes), `${clock(night.start)}–${clock(night.end)} · about ${night.hr_avg} bpm · estimated`)
      : tile("sleep", "moon", "Last night", "–", "Wear the watch to bed");

  // The newest reading (days come newest first, readings oldest first).
  const lastOx = h.days.flatMap((d) => [...d.spo2].reverse())[0] ?? null;
  const oxTile = lastOx
    ? tile("oxygen", "drop", "Blood oxygen", big(num(lastOx.pct), "%"), `${whenDay(lastOx.at.slice(0, 10)) === "today" ? "At" : whenDay(lastOx.at.slice(0, 10)).replace(/^./, (c) => c.toUpperCase()) + " at"} ${clock(lastOx.at)}`, lastOx.pct < 92 ? "warn" : "")
    : tile("oxygen", "drop", "Blood oxygen", "–", "No reading yet");

  const stepsTile = tile("steps", "walk", "Steps today", num(day?.steps ?? 0), day?.active_kcal ? `${num(day.active_kcal)} kcal active` : "So far");

  const line = sparkline(h.today_hr);
  const got = h.today_hr.filter((x): x is number => x !== null);
  return [
    el("dl", { class: "body-tiles" }, restTile, sleepTile, oxTile, stepsTile),
    ...(line
      ? [
          el(
            "figure",
            { class: "body-hr" },
            el("figcaption", {}, el("span", {}, "Heart rate today"), el("span", { class: "body-range" }, `${Math.min(...got)}–${Math.max(...got)} bpm`)),
            line,
            el("div", { class: "body-axis", "aria-hidden": "true" }, el("span", {}, "00"), el("span", {}, "12"), el("span", {}, "24")),
          ),
        ]
      : []),
    el(
      "p",
      { class: "footnote" },
      "Tartan reads the watch's 10-minute log each time it connects. The watch keeps about a day of it, so open Tartan daily for a full history. Resting heart rate is your lowest half hour sitting or lying still. Last night comes from Health Connect when an app such as Suunto's records your sleep there (Settings → Sources), else it's estimated from heart rate and stillness. Blood oxygen shows when the watch has measured it: a spot check, or overnight when that's on in the watch's settings.",
    ),
  ];
}

/**
 * In the readiness card: this morning's body in one line (resting heart rate against the usual,
 * last night, blood oxygen); a tap opens Body. Hidden until the watch has given any.
 */
export function vitalsStrip(): HTMLElement {
  const strip = el("button", { type: "button", class: "vitals", hidden: true });
  void app.api
    .json<HealthView>("/api/health")
    .then((h) => {
      if (!h.days.length && !h.latest) return;
      const today = isoDay(new Date());
      const day = h.days.find((d) => d.date === today);
      const rest = h.days.find((d) => d.resting_hr !== null);
      const diff = rest && h.resting_baseline !== null ? rest.resting_hr! - h.resting_baseline : null;
      const sleepMin = day?.sleep?.minutes.asleep ?? day?.night?.minutes ?? null;
      const ox = h.days.flatMap((d) => [...d.spo2].reverse())[0] ?? null;
      const item = (cls: string, ic: string, value: string, label: string, tone = "") => el("span", { class: `vital ${cls}${tone ? ` ${tone}` : ""}` }, icon(ic, "ic sm"), el("b", {}, value), el("small", {}, label));
      strip.replaceChildren(
        item("rest", "heart", rest ? String(rest.resting_hr) : "–", diff !== null && Math.abs(diff) >= 3 ? `${diff > 0 ? "+" : "−"}${Math.abs(diff)} resting` : "resting", diff !== null && diff >= 7 ? "warn" : ""),
        item("sleep", "moon", sleepMin !== null ? fmtDuration(sleepMin) : "–", "last night"),
        item("oxygen", "drop", ox ? `${num(ox.pct)}%` : "–", "oxygen"),
        icon("chevron", "ic sm chev"),
      );
      strip.setAttribute("aria-label", `Body: resting heart rate ${rest?.resting_hr ?? "unknown"}, last night ${sleepMin !== null ? fmtDuration(sleepMin) : "unknown"}, blood oxygen ${ox ? `${num(ox.pct)}%` : "unknown"}. Open Body for more.`);
      // Everything about your body is on the Body page.
      strip.onclick = () => (location.hash = "#you");
      strip.hidden = false;
    })
    .catch(() => {});
  return strip;
}
