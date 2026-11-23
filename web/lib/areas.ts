/**
 * Where it hurts: one picker for the morning check and a run's niggle. An even grid of
 * full-size targets, head to toe, the chosen one filled; tap it again to clear.
 */
import { PAIN_NAME, type PainArea } from "../../src/readiness.ts";
import { el } from "./dom.ts";

/** Head to toe: how you'd scan your body for it. */
export const AREA_ORDER: PainArea[] = ["back", "hip", "hamstring", "quad", "knee", "shin", "calf", "achilles", "ankle", "foot", "other"];
export const areaName = (a: PainArea) => (a === "other" ? "Elsewhere" : PAIN_NAME[a].replace(/^./, (c) => c.toUpperCase()));

export function areaPicker(selected: PainArea | null, onPick: (a: PainArea | null) => void, label = "Where"): HTMLElement {
  const grid = el("div", { class: "area-grid", role: "radiogroup", "aria-label": label });
  const mark = (on: PainArea | null) => grid.querySelectorAll<HTMLElement>("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.area === on)));
  let cur = selected;
  for (const a of AREA_ORDER) {
    const b = el("button", { type: "button", role: "radio", class: "area-btn", "data-area": a, "aria-checked": String(a === selected) }, areaName(a));
    b.onclick = () => {
      cur = cur === a ? null : a;
      mark(cur);
      onPick(cur);
    };
    grid.append(b);
  }
  return grid;
}
