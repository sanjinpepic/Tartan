/**
 * Strength sessions: the muscles the session works (the 3D body, turning slowly), its exercises
 * in order (each a still of the body at work, with sets and reps), and an exercise's own sheet:
 * the body moving through it (drag to turn it), sets and reps, three form cues and why it helps
 * a runner. Without 3D, the 2D figures and muscle map stand in.
 */
import { doseText, MUSCLE_NAME, musclesOf, routineOf, type Dose, type Exercise, type Muscle } from "../../src/strength/exercises.ts";
import { el, icon } from "../lib/dom.ts";
import { exerciseFigure } from "../lib/figure.ts";
import { muscleMap } from "../lib/muscles.ts";
import { bodyStill, canDraw3d } from "../lib/body3d.ts";
import { bodyStage, releaseBodies } from "../lib/body-stage.ts";
import { demoBody } from "../lib/demo-body.ts";
import type { PlanSession } from "../types.ts";
import { dragToClose } from "./detail.ts";

const KIND: Record<Exercise["kind"], string> = { strength: "Strength", core: "Core", power: "Power", mobility: "Mobility" };

/** "Works quads, glutes · Helps calves": the key under a body. */
function legend(primary: readonly Muscle[], secondary: readonly Muscle[]): HTMLElement {
  const names = (ms: readonly Muscle[]) => ms.map((m) => MUSCLE_NAME[m]).join(", ");
  return el(
    "div",
    { class: "mm-legend" },
    el("p", {}, el("i", { class: "mm-key p" }), el("span", {}, el("b", {}, "Works"), ` ${names(primary)}`)),
    secondary.length ? el("p", {}, el("i", { class: "mm-key s" }), el("span", {}, el("b", {}, "Helps"), ` ${names(secondary)}`)) : null,
  );
}

/** A list's thumbnail: the body at work in the exercise (a 3D still), else the 2D figure. */
export function thumb(ex: Exercise): HTMLElement {
  const box = el("span", { class: "ex-thumb", "aria-hidden": "true" });
  if (!canDraw3d()) {
    box.append(exerciseFigure(ex.id, { still: true }));
    return box;
  }
  void demoBody(ex.id).then((body) => bodyStill({ body, exercise: ex.id, primary: ex.primary, secondary: ex.secondary, width: 144, height: 120 })).then(
    (src) => {
      const img = el("img", { src, alt: "", width: 72, height: 60, decoding: "async" });
      img.onload = () => img.classList.add("in");
      box.append(img);
    },
    () => box.append(exerciseFigure(ex.id, { still: true })),
  );
  return box;
}

/** For a session's sheet: what it works, then the exercises. */
export function strengthSection(s: PlanSession): HTMLElement {
  const items = routineOf(s.exercises, s.duration_min);
  const m = musclesOf(items);
  const list = el(
    "ol",
    { class: "ex-list" },
    ...items.map(({ ex, dose }, i) => {
      const row = el(
        "button",
        { type: "button", class: "ex-row", style: `--i:${i}` },
        thumb(ex),
        el("span", { class: "ex-main" }, el("b", {}, ex.name), el("span", { class: "sub" }, doseText(dose))),
        icon("chevron", "ic sm chev"),
      );
      row.onclick = () => openExercise(ex, dose);
      return el("li", {}, row);
    }),
  );
  return el(
    "section",
    { class: "strength" },
    el("h3", {}, "What it works"),
    el(
      "div",
      { class: "works" },
      bodyStage({ primary: m.primary, secondary: m.secondary, turn: true, still: true, label: `The muscles this session works: ${[...m.primary, ...m.secondary].map((x) => MUSCLE_NAME[x]).join(", ")}`, fallback: () => muscleMap(m.primary, m.secondary), className: "works-body" }),
      legend(m.primary, m.secondary),
    ),
    el("h3", {}, `${items.length} exercises`),
    list,
    s.exercises?.length ? null : el("p", { class: "footnote" }, "A runner's basic routine for this length of session. Ask your coach to change it."),
  );
}

/** One exercise: how to do it, looping, and what it works. */
export function openExercise(ex: Exercise, dose: Dose): void {
  const dialog = el("dialog", { class: "sheet ex-sheet", "aria-labelledby": "ex-title" });
  const close = () => {
    if (!dialog.open) return;
    dialog.classList.add("closing");
    setTimeout(() => dialog.close(), 240);
  };
  dialog.addEventListener("close", () => {
    releaseBodies(dialog);
    dialog.remove();
  });
  dialog.addEventListener("click", (e) => e.target === dialog && close());
  dialog.append(
    el(
      "div",
      { class: "sheet-body" },
      el("div", { class: "grabber", "aria-hidden": "true" }),
      el(
        "header",
        { class: "ex-head" },
        el("div", {}, el("h2", { id: "ex-title" }, ex.name), el("p", { class: "session-when" }, [KIND[ex.kind], ex.equipment].filter(Boolean).join(" · "))),
        el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close")),
      ),
      el(
        "div",
        { class: "ex-stage" },
        bodyStage({ exercise: ex.id, primary: ex.primary, secondary: ex.secondary, label: `How to do ${ex.name}`, fallback: () => exerciseFigure(ex.id, { label: `How to do ${ex.name}` }) }),
        canDraw3d() ? el("p", { class: "ex-turn", "aria-hidden": "true" }, "Drag to turn") : null,
      ),
      el("p", { class: "ex-dose" }, doseText(dose)),
      el("ol", { class: "ex-cues" }, ...ex.cues.map((c) => el("li", {}, c))),
      el("p", { class: "ex-why" }, ex.why),
      canDraw3d() ? legend(ex.primary, ex.secondary) : muscleMap(ex.primary, ex.secondary),
    ),
  );
  document.body.append(dialog);
  dragToClose(dialog);
  dialog.showModal();
}
