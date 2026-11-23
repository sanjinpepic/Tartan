/**
 * Where the 3D body goes on a page (web/lib/body3d.ts): it starts once its box is on the page,
 * fades in when drawn, and gives way to the 2D figure when the device can't draw 3D. Sheets call
 * `releaseBodies` as they close, so each view's GPU context goes with it.
 */
import { el } from "./dom.ts";
import { bodyView, canDraw3d, type BodyOptions, type BodyView } from "./body3d.ts";
import { demoBody } from "./demo-body.ts";

const views = new WeakMap<HTMLElement, Promise<BodyView | null>>();

/** `still`: no dragging (a body you scroll past, not one you turn); it turns by itself when `turn`. */
export function bodyStage(o: BodyOptions & { turn?: boolean; still?: boolean; label: string; fallback: () => Node; className?: string }): HTMLElement {
  const host = el("div", { class: `body-stage${o.className ? ` ${o.className}` : ""}`, role: "img", "aria-label": o.label });
  const flat = () => {
    host.classList.add("flat");
    host.replaceChildren(o.fallback());
  };
  if (!canDraw3d()) {
    flat();
    return host;
  }
  let tries = 0;
  const start = () => {
    if (!host.isConnected) {
      if (tries++ < 240) requestAnimationFrame(start);
      return;
    }
    const v = demoBody(o.exercise ?? o.primary.join()).then((body) => bodyView(host, { body, ...o, interactive: !o.still })).then(
      (view) => {
        host.classList.add("ready");
        return view;
      },
      () => {
        flat();
        return null;
      },
    );
    views.set(host, v);
  };
  requestAnimationFrame(start);
  return host;
}

/** Let go of the bodies inside `root` (a closing sheet). */
export function releaseBodies(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".body-stage").forEach((h) => void views.get(h)?.then((v) => v?.dispose()));
}
