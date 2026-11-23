/**
 * Press and slide across a row of choices (every `.segmented`: the Activities filters, Workouts /
 * Routes, This week / Whole plan, the Settings groups…), as on the bar in Tartan 2: the choice
 * under your finger lights up with a small click for each one you cross, and letting go picks it.
 * A plain tap is still a tap. Rows that scroll sideways are left to scroll.
 */
import { feel } from "./shell.ts";

const ITEM = ":scope > button, :scope > a";

export function slideSelect(): void {
  let group: HTMLElement | null = null;
  let start = 0;
  let sliding = false;
  let over: HTMLElement | null = null;
  let swallow = false;

  const items = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>(ITEM)].filter((x) => !(x as HTMLButtonElement).disabled);
  const at = (g: HTMLElement, x: number) => {
    const list = items(g);
    // The nearest by centre, so the gaps between segments never count as nothing.
    let best: HTMLElement | null = null;
    let d = Infinity;
    for (const it of list) {
      const r = it.getBoundingClientRect();
      const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (dist < d) [best, d] = [it, dist];
    }
    return best;
  };
  const light = (it: HTMLElement | null) => {
    if (it === over) return;
    over?.classList.remove("slide-over");
    over = it;
    over?.classList.add("slide-over");
  };
  const end = () => {
    group?.classList.remove("sliding");
    light(null);
    group = null;
    sliding = false;
  };

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      const g = (e.target as Element).closest<HTMLElement>(".segmented");
      if (!g || !(e.target as Element).closest(".seg, button, a")) return;
      // A row wider than the screen scrolls instead.
      if (g.scrollWidth > g.clientWidth + 1) {
        g.style.touchAction = "auto";
        return;
      }
      group = g;
      start = e.clientX;
      sliding = false;
    },
    { passive: true },
  );

  document.addEventListener(
    "pointermove",
    (e) => {
      if (!group || !e.isPrimary) return;
      if (!sliding) {
        if (Math.abs(e.clientX - start) < 10) return;
        sliding = true;
        group.classList.add("sliding");
        light(at(group, start));
      }
      const it = at(group, e.clientX);
      if (it && it !== over) {
        light(it);
        feel("detent");
      }
    },
    { passive: true },
  );

  document.addEventListener("pointerup", (e) => {
    if (!group || !e.isPrimary) return;
    const chosen = sliding ? over : null;
    end();
    if (!chosen) return; // a tap: its own click does the rest
    // The browser's click would land on the segment the press began on: swallow it, click the chosen.
    swallow = true;
    setTimeout(() => (swallow = false), 400);
    feel("click");
    chosen.click();
  });
  document.addEventListener("pointercancel", () => group && end());
  document.addEventListener(
    "click",
    (e) => {
      if (swallow && e.isTrusted) {
        swallow = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
