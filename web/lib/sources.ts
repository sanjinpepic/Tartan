/** Where a workout came from, shown the same way everywhere: small coloured source badges. */
import { el, icon } from "./dom.ts";

export const SOURCES: Record<string, { name: string; short: string; icon: string }> = {
  watch: { name: "Watch", short: "Watch", icon: "watch" },
  strava: { name: "Strava", short: "Strava", icon: "strava" },
  health: { name: "Health app", short: "Health", icon: "heart" },
  intervals: { name: "intervals.icu", short: "intervals.icu", icon: "trends" },
  phone: { name: "Recorded on this phone", short: "Phone", icon: "phone" },
  "suunto-cloud": { name: "Suunto cloud export", short: "Cloud", icon: "folder" },
  logged: { name: "Told to the coach", short: "Told", icon: "coach" },
};

export const sourceName = (s: string) => SOURCES[s]?.name ?? s;

/** One badge per source; two or more are drawn as one merged workout. */
export function sourceBadges(sources: string[], opts: { labels?: boolean } = {}): HTMLElement {
  const uniq = [...new Set(sources)];
  const box = el("span", { class: `src-badges${uniq.length > 1 ? " merged" : ""}`, title: uniq.length > 1 ? `One workout, matched across ${uniq.map(sourceName).join(" and ")}` : sourceName(uniq[0] ?? "") });
  for (const s of uniq) {
    const m = SOURCES[s];
    const label = opts.labels === false ? "" : (m?.short ?? s);
    box.append(el("span", { class: `src src-${s}${label ? "" : " icon-only"}`, ...(label ? {} : { role: "img", "aria-label": sourceName(s) }) }, icon(m?.icon ?? "folder", "ic xs"), label));
  }
  return box;
}
