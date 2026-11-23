/**
 * Body (#you, opened from Today's readiness card and from Progress): how your body is now. The
 * muscles on the heat scale from fresh to worked hard, running and lifting together
 * (src/fatigue.ts); a tap on one says how it is, when it'll be fresh, why (the workouts still in
 * it) and what trains it. Then sleep and the watch's vitals. Readiness itself lives on Today.
 */
import type { BodyState, Cause, MuscleState } from "../../src/fatigue.ts";
import { EXERCISES, MUSCLE_NAME, MUSCLES, type Muscle } from "../../src/strength/exercises.ts";
import { dateShort, el, icon } from "../lib/dom.ts";
import { yourBody } from "../lib/demo-body.ts";
import { revealOnScroll } from "../lib/motion.ts";
import { bodyMap, heatLegend, type Levels } from "../lib/muscles.ts";
import { app, lastThenFresh } from "../state.ts";
import { dragToClose } from "./detail.ts";
import { bodyNodes, whenDay, type HealthView } from "./health.ts";
import { openExercise, thumb } from "./strength.ts";
import { largeTitle } from "./today.ts";

const STATE: Record<MuscleState["state"], string> = { fresh: "Fresh", recovering: "Recovering", fatigued: "Worked hard" };
const PAIN = ["", "a little", "clearly", "a lot"];

/** "about 20 h", "about 2 days". */
const inHours = (h: number) => (h < 36 ? `about ${Math.max(1, Math.round(h))} h` : `about ${Math.round(h / 24)} days`);
const names = (ms: Muscle[]) => {
  const n = ms.map((m) => MUSCLE_NAME[m].toLowerCase());
  return n.length < 2 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
};
/** "calves, quads and hamstrings", or "calves, quads, hamstrings and more". */
const list3 = (ms: Muscle[]) => (ms.length > 3 ? `${ms.slice(0, 3).map((m) => MUSCLE_NAME[m].toLowerCase()).join(", ")} and more` : names(ms));
const upper = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
/** "today", "yesterday", "on Monday" this week, else "on 3 Oct". */
const on = (date: string) => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const days = Math.round((noon.getTime() - Date.parse(`${date}T12:00:00`)) / 86400_000);
  const w = whenDay(date);
  return w === "today" || w === "yesterday" ? w : days < 7 ? `on ${w}` : `on ${dateShort(new Date(`${date}T12:00:00`))}`;
};

/** Muscles with anything in them (or sore), most tired first. */
function needing(b: BodyState): Muscle[] {
  return MUSCLES.filter((m) => b.muscles[m].level > 0 || b.muscles[m].sore).sort((a, b2) => b.muscles[b2].score - b.muscles[a].score);
}

/** One line on the body as a whole: what's carrying work, and the workout most of it came from. */
function summary(b: BodyState): string {
  const tired = MUSCLES.filter((m) => b.muscles[m].state === "fatigued");
  const rec = MUSCLES.filter((m) => b.muscles[m].state === "recovering");
  if (!tired.length && !rec.length) {
    const light = MUSCLES.filter((m) => b.muscles[m].level > 0);
    return light.length ? `Fresh. ${upper(list3(light))} carry a little from your last workouts, nothing that needs time.` : "Everything's fresh. Nothing from your last workouts is still in your muscles.";
  }
  const lead = tired.length ? tired : rec;
  const top = lead.map((m) => b.muscles[m].causes[0]).filter((c): c is Cause => !!c).sort((x, y) => y.share - x.share)[0];
  const what = top ? `, mostly from ${top.what.toLowerCase().startsWith("the ") ? "" : "your "}${top.what} ${on(top.date)}` : "";
  return `${upper(list3(lead))} ${lead.length === 1 ? "is" : "are"} ${tired.length ? "worked hard" : "still recovering"}${what}.`;
}

export async function renderYou(root: HTMLElement): Promise<void> {
  // Not a tab: back goes where you came from (Today or Progress).
  const back = el("button", { type: "button", class: "icon-btn tonal", "aria-label": "Back" }, el("span", { class: "flip" }, icon("chevron")));
  back.onclick = () => (history.length > 1 ? history.back() : (location.hash = "#today"));
  root.replaceChildren(el("div", { class: "page-back" }, back), largeTitle("Body", "Muscles, sleep and recovery"));
  const body = el("div", { class: "you-body" });
  root.append(body);

  // ---------------------------------------------------------------- muscles
  const head = el("p", { class: "sub" }, "Reading your last weeks…");
  const list = el("div", { class: "chips you-needs" });
  // Every muscle as a full-size chip too: the map's small ones (forearms, calves from the side)
  // are hard to hit with a thumb, and a fresh muscle should be as easy to open as a tired one.
  const others = el("div", { class: "chips you-others" });
  const every = el("details", { class: "more you-every" }, el("summary", {}, "Every muscle"), others);
  let state: BodyState | null = null;
  const map = bodyMap({ levels: {}, onMuscle: (m) => state && openMuscle(m, state, () => map.update(levelsOf(state!), null)) });
  const levelsOf = (b: BodyState): Levels => Object.fromEntries(MUSCLES.map((m) => [m, b.muscles[m].level])) as Levels;
  const muscles = el(
    "section",
    { class: "card you-muscles", "aria-label": "Muscles", "data-reveal": "" },
    el("div", { class: "you-head" }, el("h2", {}, "Muscles"), head),
    el("div", { class: "you-figure" }, el("div", { class: "you-map" }, map), heatLegend("Fresh", "Worked hard")),
    el(
      "div",
      { class: "you-rest" },
      list,
      el("p", { class: "sub you-tip" }, "Tap a muscle to see how it is and why."),
      every,
      el(
        "details",
        { class: "more explain" },
        el("summary", {}, "How is this worked out?"),
        el(
          "p",
          { class: "footnote" },
          "From your workouts of the last five weeks, runs and strength together. A run loads the legs by how long and how hard it was (calves most, then quads, hamstrings, glutes and hip flexors; climbing adds calves and glutes); a strength session loads what its exercises work, by hard sets. Each muscle recovers at its own pace, the big leg muscles in about two days, the upper body sooner, and it's compared with what that muscle is used to: your usual week leaves a muscle recovering, more than usual reads worked hard. Soreness is what you said in the morning check.",
        ),
      ),
    ),
  );
  // Tapping a fresh muscle on the map still opens it; the chips list the ones worth knowing about.
  const draw = (b: BodyState) => {
    state = b;
    head.textContent = summary(b);
    map.update(levelsOf(b));
    const need = needing(b);
    list.replaceChildren(
      ...need.slice(0, 8).map((m) => {
        const s = b.muscles[m];
        const chip = el(
          "button",
          { type: "button", class: `chip action you-chip lv${s.level}` },
          el("i", { class: `mm-key lv${s.level}`, "aria-hidden": "true" }),
          el("span", {}, el("b", {}, MUSCLE_NAME[m]), el("small", {}, s.fresh_in_h ? `fresh in ${inHours(s.fresh_in_h).replace("about ", "~")}` : s.sore ? "sore" : "a little worked")),
          s.sore ? icon("warn", "ic sm sore") : null,
        );
        chip.onclick = () => {
          map.update(levelsOf(b), m);
          openMuscle(m, b, () => map.update(levelsOf(b), null));
        };
        return chip;
      }),
    );
    list.hidden = !need.length;
    others.replaceChildren(
      ...MUSCLES.filter((m) => !need.includes(m)).map((m) => {
        const chip = el("button", { type: "button", class: "chip action you-chip lv0" }, el("i", { class: "mm-key lv0", "aria-hidden": "true" }), el("span", {}, el("b", {}, MUSCLE_NAME[m])));
        chip.onclick = () => {
          map.update(levelsOf(b), m);
          openMuscle(m, b, () => map.update(levelsOf(b), null));
        };
        return chip;
      }),
    );
    every.hidden = !others.children.length;
  };
  void yourBody().then((fig) => fig !== "m" && map.setFigure(fig));

  // ---------------------------------------------------------------- sleep and vitals
  const vitals = el(
    "section",
    { class: "card you-vitals", "aria-label": "Sleep and vitals", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "Sleep and vitals"), el("p", { class: "sub" }, "From your watch"))),
    el("div", { class: "skeleton-card" }),
  );

  body.append(muscles, vitals);
  revealOnScroll(body);

  void app.api
    .json<HealthView>("/api/health")
    .then((h) => {
      const at = h.latest ? `From your watch · ${whenDay(h.latest.at.slice(0, 10)) === "today" ? h.latest.at.slice(11, 16) : whenDay(h.latest.at.slice(0, 10))}` : "From your watch";
      vitals.querySelector(".sub")!.textContent = at;
      // The long note on where the readings come from folds away here.
      const nodes = bodyNodes(h).map((n) => (n instanceof HTMLElement && n.classList.contains("footnote") ? el("details", { class: "more explain" }, el("summary", {}, "Where do these come from?"), n) : n));
      vitals.querySelector(".skeleton-card")!.replaceWith(...nodes);
    })
    .catch(() => vitals.querySelector(".skeleton-card")?.replaceWith(el("p", { class: "sub" }, "Nothing from the watch yet.")));

  await lastThenFresh<BodyState>("/api/body", (b) => draw(b));
}

/** One muscle: how it is, when it'll be fresh, why, and what trains it. */
function openMuscle(m: Muscle, b: BodyState, closed: () => void): void {
  const s = b.muscles[m];
  const dialog = el("dialog", { class: "sheet muscle-sheet", "aria-labelledby": "muscle-title" });
  const close = () => {
    if (!dialog.open) return;
    dialog.classList.add("closing");
    setTimeout(() => dialog.close(), 240);
  };
  dialog.addEventListener("close", () => {
    dialog.remove();
    closed();
  });
  dialog.addEventListener("click", (e) => e.target === dialog && close());

  const verdict =
    s.state === "fresh" ? (s.last_worked ? "Fresh and ready to work." : "Fresh: nothing has loaded it lately.")
    : `${s.state === "fatigued" ? "Carrying more than it's used to." : "Getting there."} Fresh again in ${inHours(s.fresh_in_h ?? 0)}.`;
  // Where it is: the body small, just this muscle lit.
  const where = bodyMap({ levels: { [m]: Math.max(2, s.level) } as Levels, selected: m });
  where.classList.add("muscle-where");
  where.setAttribute("aria-hidden", "true");
  void yourBody().then((f) => f !== "m" && where.setFigure(f));
  const total = s.causes.reduce((n, c) => n + c.share, 0);
  const why = s.causes.length
    ? el(
        "ol",
        { class: "why-list" },
        ...s.causes.map((c) =>
          el(
            "li",
            { class: `why kind-${c.kind}` },
            el("span", { class: "why-ic", "aria-hidden": "true" }, icon(c.kind === "run" ? "run" : c.kind === "strength" ? "bolt" : "other", "ic sm")),
            el("span", { class: "why-main" }, el("b", {}, c.what), el("span", { class: "sub" }, upper(on(c.date).replace(/^on /, "")))),
            el("span", { class: "why-share" }, el("i", { style: `--w:${Math.round(c.share * 100)}%`, "aria-hidden": "true" }), `${Math.round(c.share * 100)}%`),
          ),
        ),
      )
    : null;
  const exs = [...EXERCISES.filter((e) => e.primary.includes(m)), ...EXERCISES.filter((e) => e.secondary.includes(m) && !e.primary.includes(m))].slice(0, 6);

  dialog.append(
    el(
      "div",
      { class: "sheet-body" },
      el("div", { class: "grabber", "aria-hidden": "true" }),
      el(
        "header",
        { class: "ex-head" },
        el("div", {}, el("h2", { id: "muscle-title" }, MUSCLE_NAME[m]), el("p", { class: `session-when muscle-state lv${s.level}` }, el("i", { class: `mm-key lv${s.level}`, "aria-hidden": "true" }), STATE[s.state])),
        el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close")),
      ),
      el("div", { class: "muscle-top" }, el("p", { class: "muscle-verdict" }, verdict), where),
      s.sore
        ? el(
            "p",
            { class: "muscle-sore" },
            icon("warn", "ic sm"),
            el("span", {}, `You said your ${s.sore.area === "other" ? "body" : s.sore.area} hurt ${PAIN[s.sore.level]} ${on(s.sore.date)}. `, s.sore.level >= 2 ? "Let it settle before loading it hard; tell your coach if it lingers." : "Easy work is fine if it eases as you warm up."),
          )
        : null,
      why ? el("h3", {}, "Why") : null,
      why ? el("p", { class: "sub" }, `What's still in it, by share${total < 0.95 ? " (the rest is older work)" : ""}:`) : null,
      why,
      s.last_worked ? el("p", { class: "sub" }, `Last worked ${on(s.last_worked)}.`) : null,
      exs.length ? el("h3", {}, s.state === "fresh" ? "Exercises for it" : "Exercises for it, when it's fresh") : null,
      exs.length
        ? el(
            "ol",
            { class: "ex-list" },
            ...exs.map((ex) => {
              const row = el(
                "button",
                { type: "button", class: "ex-row" },
                thumb(ex),
                el("span", { class: "ex-main" }, el("b", {}, ex.name), el("span", { class: "sub" }, ex.primary.includes(m) ? "Works it" : "Helps it")),
                icon("chevron", "ic sm chev"),
              );
              row.onclick = () => openExercise(ex, ex.dose);
              return el("li", {}, row);
            }),
          )
        : null,
    ),
  );
  document.body.append(dialog);
  dragToClose(dialog);
  dialog.showModal();
}
