/**
 * The sync board, tapped: each source's lane in words (when it last came in, or what went
 * wrong and what to try), a button to sync it now, and when Tartan syncs by itself.
 */
import { ago, el, icon } from "../lib/dom.ts";
import { getLanes, onLanes, type Lane, type LaneState } from "../lib/lanes.ts";
import { dragToClose } from "./detail.ts";

export interface BoardLane {
  id: Lane;
  name: string;
  icon: string;
  /** Shown when nothing is known yet ("Not paired yet"). */
  idle: string;
  sync: () => Promise<void>;
}

export function openBoard(lanes: BoardLane[]): void {
  const dialog = el("dialog", { class: "sheet board-sheet", "aria-labelledby": "board-title" });
  let off = () => {};
  const close = () => {
    if (!dialog.open) return;
    dialog.classList.add("closing");
    setTimeout(() => dialog.close(), 240);
  };
  dialog.addEventListener("close", () => {
    off();
    dialog.remove();
  });
  dialog.addEventListener("click", (e) => e.target === dialog && close());
  const list = el("div", { class: "board-lanes" });
  const row = (l: BoardLane, s: LaneState) => {
    const state = s.running ? "busy" : s.error ? "fail" : s.ok ? "ok" : "off";
    const status = s.running
      ? el("p", { class: "board-status" }, "Syncing now…")
      : s.error
        ? el("p", { class: "board-status" }, el("b", {}, s.error.text), s.error.fix ? ` ${s.error.fix}` : "", el("span", { class: "board-when" }, ` · ${ago(new Date(s.error.at))}`))
        : el("p", { class: "board-status" }, s.ok ? `Synced ${ago(new Date(s.ok))}` : l.idle);
    const go = el("button", { type: "button", class: `btn ${s.error ? "filled" : "tonal"} small`, disabled: s.running }, s.error ? "Try again" : "Sync now");
    go.onclick = () => void l.sync();
    return el(
      "section",
      { class: "board-lane", "data-state": state, "data-lane": l.id },
      el("span", { class: "board-ic", "aria-hidden": "true" }, icon(s.error ? "warn" : l.icon)),
      el("div", { class: "board-text" }, el("h3", {}, l.name), status),
      go,
    );
  };
  const draw = () => list.replaceChildren(...lanes.map((l) => row(l, getLanes()[l.id])));
  dialog.append(
    el(
      "div",
      { class: "sheet-body" },
      el("div", { class: "grabber", "aria-hidden": "true" }),
      el("header", { class: "sheet-head board-head" }, el("div", {}, el("h2", { id: "board-title" }, "Your data"), el("p", { class: "sub" }, "Where your workouts come in from, and when they last did.")), el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))),
      list,
      el("p", { class: "board-note" }, icon("clock", "ic xs"), "Tartan syncs by itself when you open it, when you come back after 20 minutes, and every hour while it's open. Pull down on Today to sync everything at once."),
    ),
  );
  document.body.append(dialog);
  dragToClose(dialog);
  off = onLanes(draw);
  dialog.showModal();
}
