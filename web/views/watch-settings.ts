/**
 * Settings → Watch: how guided workouts behave on the watch (drink and gel reminders on long
 * sessions) and the week drawn on a watch face. Sending the week itself is on the Coach tab,
 * next to the plan.
 */
import { DEFAULT_FUEL, type FuelPlan } from "../../src/workout/from-plan.ts";
import { checkDesign, face, TARTAN_TRACK_DESIGN, type FaceDesign } from "../../src/watchface/tartan-face.ts";
import { keepsWeekFace, sendWeekFace, setKeepsWeekFace, WEEK_BASE, weekOnFace } from "../lib/week-face.ts";
import { dayName, el, icon } from "../lib/dom.ts";
import { success, tick } from "../lib/haptics.ts";
import { readFuel, writeFuel } from "../lib/watch-workouts.ts";
import { act, app } from "../state.ts";
import { planDest, planOut, setPlanDest, type PlanDest, type PlanOutOp, type PlanOutState } from "../lib/plan-out.ts";
import type { PlanView } from "../types.ts";
import * as watch from "../watch.ts";

// ------------------------------------------------------------------ guided workouts: reminders

/**
 * Drink and gel reminders: each a switch with its line of explanation, and when on, how often
 * as a segmented control under it (the Training times card's pattern).
 */
export function workoutsCard(): HTMLElement {
  const sec = el("section", { class: "card setup workouts-card" });
  const draw = () => {
    const fuel = readFuel();
    const row = (on: "drink" | "gel", every: "drinkMin" | "gelMin", title: string, line: string, options: number[]) => {
      const sw = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(fuel[on]), "aria-label": `${title}` }, el("i"));
      sw.onclick = () => {
        tick();
        writeFuel({ ...fuel, [on]: !fuel[on] } as FuelPlan);
        draw();
      };
      const seg = el("div", { class: "segmented", role: "radiogroup", "aria-label": `${title}: how often` });
      for (const m of options) {
        const b = el("button", { type: "button", role: "radio", class: "seg", "aria-checked": String(fuel[every] === m) }, `${m} min`);
        b.onclick = () => {
          tick();
          writeFuel({ ...fuel, [every]: m } as FuelPlan);
          draw();
        };
        seg.append(b);
      }
      return el(
        "div",
        { class: "switch-row" },
        el("div", {}, el("h3", {}, title), el("p", { class: "sub" }, fuel[on] ? `${line} every ${fuel[every]} minutes.` : `Off: no ${title.toLowerCase()}.`), fuel[on] ? el("div", { class: "every" }, seg) : null),
        sw,
      );
    };
    sec.replaceChildren(
      el("h2", {}, icon("watch", "ic"), "Guided workouts"),
      el("p", { class: "sub" }, `Your plan's sessions go to the watch from the Coach tab, each step with its target and what's left. On sessions over ${DEFAULT_FUEL.fromMin} minutes the watch also reminds you to drink and fuel.`),
      row("drink", "drinkMin", "Drink reminders", "A few sips", [10, 15, 20]),
      row("gel", "gelMin", "Gel reminders", "A gel", [30, 40, 45]),
      el("p", { class: "footnote" }, "Changes reach the watch the next time you send the week."),
    );
  };
  draw();
  return sec;
}

// ------------------------------------------------------------------ the week on a watch face

const day = (iso: string) => new Date(`${iso}T12:00:00`);

/** This week as the face shows it: a dot per day, today's session, km done of planned. */
/**
 * The week on a face: a large preview beside what it shows, the face to draw it on, and one
 * button. The watch can't be told which face to wear, so after an update it's picked again.
 */
/** "Keep it up to date": the watch sync sends next week's face when the week turns or the plan's week changes. */
function keepRow(): HTMLElement {
  const sw = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(keepsWeekFace()), "aria-label": "Keep the week face up to date" }, el("i"));
  sw.onclick = () => {
    setKeepsWeekFace(!keepsWeekFace());
    sw.setAttribute("aria-checked", String(keepsWeekFace()));
  };
  return el("div", { class: "switch-row" }, el("div", {}, el("h3", {}, "Keep it up to date"), el("p", { class: "sub" }, "When a new week starts or this week's plan changes, the next watch sync sends the new face.")), sw);
}

export function weekFaceCard(v: PlanView | null): HTMLElement | undefined {
  const week = v?.plan ? weekOnFace(v) : null;
  if (!week || !v) return undefined;
  let base: FaceDesign = TARTAN_TRACK_DESIGN;
  const preview = el("div", { class: "face-thumb week-face-preview", style: "--s:148px", role: "img", "aria-label": "Your week on a watch face" });
  const paint = () => (preview.innerHTML = face({ design: base, hours: 10, minutes: 9, seconds: 36, date: dayName(day(v.today)).toUpperCase(), battery: 84, size: 148, week }));
  paint();
  const picks = el("div", { class: "segmented week-face-base", role: "radiogroup", "aria-label": "Face to draw it on" });
  const choose = (d: FaceDesign) => {
    base = d;
    try {
      localStorage.setItem(WEEK_BASE, d.id);
    } catch {
      // not remembered
    }
    picks.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === d.id)));
    paint();
  };
  const add = (id: string, label: string, load: () => Promise<FaceDesign>) => {
    const b = el("button", { type: "button", role: "radio", class: "seg", "data-id": id, "aria-checked": String(base.id === id) }, label);
    b.onclick = () => {
      tick();
      void load().then(choose);
    };
    picks.append(b);
  };
  add(TARTAN_TRACK_DESIGN.id, "Tartan Track", async () => TARTAN_TRACK_DESIGN);
  void app.api
    .json<Array<{ id: string; name: string }>>("/api/faces")
    .then((list) => {
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem(WEEK_BASE);
      } catch {
        // none
      }
      for (const f of list.slice(0, 3)) {
        const load = async () => checkDesign(await app.api.json<FaceDesign>(`/api/faces/${f.id}`));
        add(f.id, f.name, load);
        if (f.id === remembered) void load().then(choose);
      }
    })
    .catch(() => {});
  const status = el("p", { class: "footnote", "aria-live": "polite" });
  const go = el("button", { type: "button", class: "btn tonal" }, icon("watch", "ic sm"), "Put it on the watch");
  go.disabled = !watch.canBluetooth();
  go.onclick = () =>
    act(go, "Week face", async () => {
      const { replaced } = await sendWeekFace(v, base, (t) => (status.textContent = t));
      success();
      status.textContent = replaced ? "Updated. If you were wearing it, pick Tartan Week again on the watch." : "On your watch: pick Tartan Week where you change faces.";
    });
  return el(
    "section",
    { class: "card week-face-card" },
    el(
      "div",
      { class: "week-face-row" },
      preview,
      el(
        "div",
        { class: "week-face-text" },
        el("h2", {}, "Your week on a face"),
        el("p", { class: "sub" }, "Each day's mark from your plan: filled for hard or long, a ring for easy, a square for strength. With the week's focus and kilometres."),
      ),
    ),
    el("div", { class: "field" }, el("span", {}, "Drawn on"), picks),
    el("div", { class: "row" }, go),
    status,
    keepRow(),
    el("p", { class: "footnote" }, "A face is a picture made once, and the watch can't switch faces by itself: after an update, pick Tartan Week again. That's why it changes once a week, not every day. Today's session itself is on the watch as a guided workout."),
  );
}

// ------------------------------------------------------------------ where the plan goes (Settings → Sources)

/**
 * Settings → Sources → Plan on your watch: where the plan goes. A Suunto takes it over Bluetooth;
 * intervals.icu passes it to Garmin and the others it links; Health Connect (on the phone) holds it
 * for Samsung, Pixel and other watch apps; any watch's app opens .fit files. The Coach tab's watch
 * line sends to the choice (views/plan.ts watchLine). As on the phone (PlanWatchCard).
 */
export function planWatchCard(): HTMLElement {
  const sec = el("section", { class: "card plan-watch-card" });
  let said: string | null = null;
  const draw = (s: PlanOutState | null) => {
    const dest = planDest();
    const hcOk = s?.hc.status === "available";
    const CHOICES: Array<[PlanDest, string, string]> = [
      ["suunto", "Suunto", "Over Bluetooth, as guided workouts."],
      ["intervals", "Garmin and others", "Through intervals.icu, which passes it to your watch's account."],
      ...(hcOk || dest === "hc" ? [["hc", "Samsung, Pixel and others", "As planned workouts in Health Connect."] as [PlanDest, string, string]] : []),
      ["files", "Any watch", "The week as .fit files, to open in your watch's app."],
    ];
    const list = el("div", { class: "choices", role: "radiogroup", "aria-label": "Plan on your watch" });
    for (const [id, title, line] of CHOICES) {
      const b = el("button", { type: "button", role: "radio", class: "choice", "aria-checked": String(id === dest) }, el("span", { class: "choice-dot", "aria-hidden": "true" }), el("span", {}, el("b", {}, title), el("span", { class: "sub" }, line)));
      b.onclick = () => {
        tick();
        setPlanDest(id);
        said = null;
        draw(s);
      };
      list.append(b);
    }
    const run = (b: HTMLButtonElement, op: PlanOutOp) =>
      void act(b, b.textContent ?? "", async () => {
        const r = await planOut(op);
        said = r.line;
        draw(r);
      });
    const btn = (label: string, op: PlanOutOp, cls = "btn tonal small") => {
      const b = el("button", { type: "button", class: cls }, label);
      b.onclick = () => run(b, op);
      return b;
    };
    const note = (t: string) => el("p", { class: "sub" }, t);
    const here: HTMLElement[] = [];
    if (dest === "intervals") {
      if (!s?.intervals.connected) here.push(note("intervals.icu isn't connected. Connect it in Tartan on your phone, under Settings → Sources."));
      else {
        if (s.intervals.on) here.push(note("Kept up to date on intervals.icu."));
        here.push(el("div", { class: "row" }, btn("Send", "intervals"), s.intervals.on ? btn("Stop", "intervalsOff", "btn text small") : null));
      }
    } else if (dest === "hc") {
      if (s?.hc.plan) here.push(note("Kept up to date in Health Connect."));
      here.push(el("div", { class: "row" }, btn("Send", "hc"), s?.hc.plan ? btn("Stop", "hcOff", "btn text small") : null));
    } else if (dest === "files") here.push(el("div", { class: "row" }, btn("Save", "files")));
    // Kept up to date somewhere else as well (picked before): said, with Stop.
    const also: HTMLElement[] = [];
    if (dest !== "intervals" && s?.intervals.on) also.push(el("div", { class: "plan-also" }, el("span", {}, "Also kept up to date on intervals.icu."), btn("Stop", "intervalsOff", "btn text small")));
    if (dest !== "hc" && s?.hc.plan) also.push(el("div", { class: "plan-also" }, el("span", {}, "Also kept up to date in Health Connect."), btn("Stop", "hcOff", "btn text small")));
    sec.replaceChildren(
      el("h2", {}, icon("watch", "ic"), "Plan on your watch"),
      list,
      ...here,
      ...also,
      ...(said ? [el("p", { class: "footnote", "aria-live": "polite" }, said)] : []),
      el("p", { class: "footnote plan-apple" }, icon("info", "ic xs"), "Apple Watch takes workouts only from an iPhone."),
    );
  };
  draw(null);
  void planOut("state").then(draw).catch(() => {});
  return sec;
}
