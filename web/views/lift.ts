/**
 * #lift/<date>: a strength session as you lift it. Each exercise with its sets filled in from
 * last time and the next step (more weight, a rep more, the same, lighter) with why; tick a set
 * and the rest counts down (a notification when it's over, the screen off or not). How many reps
 * were left in you after the last set. Finish: the plan's session ticks off, records, next time.
 */
import type { LiftLog, Rule, SetLog, Summary, Target } from "../../src/strength/log.ts";
import { exercise } from "../../src/strength/exercises.ts";
import { dateShort, el, icon } from "../lib/dom.ts";
import { success, thud, tick } from "../lib/haptics.ts";
import { act, app, isNative } from "../state.ts";
import { dragToClose } from "./detail.ts";
import { openExercise, thumb } from "./strength.ts";
import { largeTitle } from "./today.ts";

interface Session {
  date: string;
  title: string;
  planned: boolean;
  log: LiftLog | null;
  targets: Target[];
}

const RULE: Record<Rule, string> = { start: "First time", add: "More weight", "more reps": "A rep more", longer: "Longer", hold: "Same again", ease: "Lighter" };
const REST_NOTE = 7301;
const day = (d: string) => new Date(`${d}T12:00:00`);
const kgText = (kg: number) => `${Number.isInteger(kg) ? kg : kg.toFixed(1)} kg`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

/** "3 × 10 at 40 kg" for a target. */
const doseOf = (t: { sets: number; reps?: number; seconds?: number; kg?: number; each_side?: boolean }) =>
  `${t.sets} × ${t.reps ?? `${t.seconds ?? 0} s`}${t.each_side ? " each side" : ""}${t.kg ? ` at ${kgText(t.kg)}` : ""}`;

let restTimer: ReturnType<typeof setInterval> | null = null;

export async function renderLift(root: HTMLElement): Promise<void> {
  const date = location.hash.split("/")[1] ?? "";
  const s = await app.api.json<Session>(`/api/lifts/session?date=${encodeURIComponent(date)}`);
  const today = new Date();
  const isToday = s.date === `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const byId = new Map(s.targets.map((t) => [t.id, t]));
  const log: LiftLog = s.log ?? {
    date: s.date,
    title: s.title,
    started: "",
    exercises: s.targets.map((t) => ({
      id: t.id,
      target: { sets: t.sets, ...(t.reps ? { reps: t.reps } : {}), ...(t.seconds ? { seconds: t.seconds } : {}), ...(t.kg ? { kg: t.kg } : {}), ...(t.each_side ? { each_side: true } : {}) },
      sets: Array.from({ length: t.sets }, (): SetLog => ({ done: false, ...(t.reps ? { reps: t.reps } : { seconds: t.seconds }), ...(t.kg ? { kg: t.kg } : {}) })),
    })),
  };
  const started = () => !!log.started;

  // Saved as you go (after the first ticked set), so closing the app loses nothing.
  let saving: ReturnType<typeof setTimeout> | null = null;
  const save = (now = false) => {
    if (!started()) return Promise.resolve();
    if (saving) clearTimeout(saving);
    const put = () => app.api.request("/api/lifts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(log) });
    if (now) return put();
    saving = setTimeout(() => void put().catch(() => {}), 500);
    return Promise.resolve();
  };

  const finishBtn = el("button", { type: "button", class: "btn filled" }, icon("check", "ic sm"), log.finished ? "Save" : "Finish");
  const sub = el("span", {}, "");
  const when = isToday ? "Today" : dateShort(day(s.date));
  // Finish sits at the bottom, under the thumb, not in the far top corner.
  root.replaceChildren(largeTitle(s.title, sub));
  const list = el("div", { class: "lift-list" });
  const rest = el("div", { class: "lift-rest", hidden: true, role: "timer", "aria-live": "off" });
  const confirmLine = el("p", { class: "lift-confirm", "aria-live": "polite", hidden: true });
  root.append(list, rest, el("div", { class: "lift-actions" }, confirmLine, finishBtn));

  const doneCount = () => log.exercises.filter((e) => e.sets.length && e.sets.every((x) => x.done)).length;
  const head = () => {
    sub.textContent = `${when} · ${doneCount()} of ${log.exercises.length} done`;
  };

  // The first exercise with a set left is open.
  let open = Math.max(0, log.exercises.findIndex((e) => e.sets.some((x) => !x.done)));
  const draw = () => {
    head();
    list.replaceChildren(...log.exercises.map((e, i) => exerciseCard(e, i)));
  };

  // ---------------------------------------------------------------- rest between sets
  let restEnd = 0;
  let restFor = 0;
  const stopRest = () => {
    if (restTimer) clearInterval(restTimer);
    restTimer = null;
    rest.hidden = true;
    void cancelRestNote();
  };
  const startRest = (seconds: number, next: string) => {
    restFor = seconds;
    restEnd = Date.now() + seconds * 1000;
    rest.hidden = false;
    void scheduleRestNote(restEnd, next);
    const paint = () => {
      // Left the screen: the notification still comes.
      if (!rest.isConnected) {
        if (restTimer) clearInterval(restTimer);
        restTimer = null;
        return;
      }
      const left = Math.round((restEnd - Date.now()) / 1000);
      if (left <= 0) {
        if (restTimer) clearInterval(restTimer);
        restTimer = null;
        success();
        rest.classList.add("go");
        rest.replaceChildren(el("span", { class: "lift-rest-time" }, "Go"), el("span", { class: "lift-rest-what" }, el("span", { class: "lift-rest-next" }, next.replace(/^Then /, "").replace(/^./, (c) => c.toUpperCase()))), el("button", { type: "button", class: "text-btn", onclick: () => (rest.hidden = true, rest.classList.remove("go")) }, "OK"));
        setTimeout(() => {
          rest.hidden = true;
          rest.classList.remove("go");
        }, 4000);
        return;
      }
      const bar = el("i", { class: "lift-rest-bar", style: `--p:${(1 - left / restFor) * 100}%`, "aria-hidden": "true" });
      const shift = (d: number) => () => {
        restEnd += d * 1000;
        restFor = Math.max(restFor + d, 1);
        void scheduleRestNote(restEnd, next);
        paint();
      };
      rest.replaceChildren(
        bar,
        el("span", { class: "lift-rest-time" }, mmss(left)),
        el("span", { class: "lift-rest-what" }, el("span", { class: "lift-rest-label" }, "Rest"), el("span", { class: "lift-rest-next" }, next)),
        el("button", { type: "button", class: "chip action", "aria-label": "15 seconds less", onclick: shift(-15) }, "−15"),
        el("button", { type: "button", class: "chip action", "aria-label": "15 seconds more", onclick: shift(15) }, "+15"),
        el("button", { type: "button", class: "chip action", onclick: stopRest }, "Skip"),
      );
    };
    rest.classList.remove("go");
    if (restTimer) clearInterval(restTimer);
    restTimer = setInterval(paint, 250);
    paint();
  };

  // ---------------------------------------------------------------- an exercise
  function exerciseCard(e: LiftLog["exercises"][number], i: number): HTMLElement {
    const ex = exercise(e.id)!;
    const t = byId.get(e.id);
    const loaded = t?.loaded ?? e.sets.some((x) => x.kg);
    const done = e.sets.filter((x) => x.done).length;
    const all = done === e.sets.length && done > 0;
    const card = el("section", { class: `card lift-ex${i === open ? " open" : ""}${all ? " all" : ""}`, "data-reveal": "" });
    const headBtn = el(
      "button",
      { type: "button", class: "lift-head", "aria-expanded": String(i === open) },
      thumb(ex),
      el("span", { class: "lift-name" }, el("b", {}, ex.name), el("span", { class: "sub" }, doseOf(e.target))),
      all ? el("span", { class: "lift-tick", "aria-label": "Done" }, icon("check", "ic sm")) : el("span", { class: "lift-count" }, `${done}/${e.sets.length}`),
    );
    headBtn.onclick = () => {
      open = open === i ? -1 : i;
      draw();
    };
    card.append(headBtn);
    if (i !== open) return card;

    const body = el("div", { class: "lift-body" });
    if (t && !log.finished)
      body.append(el("p", { class: `lift-rule r-${t.rule.replace(" ", "-")}` }, el("b", {}, RULE[t.rule]), ` ${t.why}`));
    if (t?.last) body.append(el("p", { class: "sub lift-last" }, `Last time ${t.last.text} · ${dateShort(day(t.last.date))}`));

    const unit = e.target.seconds && !e.target.reps ? "s" : "reps";
    const rows = el("ol", { class: "lift-sets" });
    e.sets.forEach((set, k) => {
      const field = (label: string, value: number | undefined, mode: "decimal" | "numeric", put: (v: number | undefined) => void) => {
        const input = el("input", { type: "text", inputmode: mode, value: value === undefined ? "" : String(value), "aria-label": `Set ${k + 1} ${label}`, enterkeyhint: "done" });
        input.addEventListener("change", () => {
          const v = Number(input.value.replace(",", "."));
          put(input.value.trim() && Number.isFinite(v) && v >= 0 ? v : undefined);
          void save();
        });
        input.addEventListener("focus", () => input.select());
        return el("label", { class: "lift-field" }, input, el("span", {}, label));
      };
      const check = el("button", { type: "button", class: `lift-check${set.done ? " on" : ""}`, "aria-pressed": String(set.done), "aria-label": `Set ${k + 1} done` }, icon("check", "ic sm"));
      check.onclick = () => {
        set.done = !set.done;
        if (set.done) {
          if (!log.started) log.started = new Date().toISOString();
          thud();
          // Rest before the next set (or the next exercise), not after the very last.
          const nextSet = e.sets.findIndex((x) => !x.done);
          const nextEx = log.exercises.findIndex((x, j) => j > i && x.sets.some((y) => !y.done));
          const label = nextSet >= 0 ? `Then set ${nextSet + 1}` : nextEx >= 0 ? `Then ${exercise(log.exercises[nextEx]!.id)!.name.toLowerCase()}` : "";
          if (label) startRest(t?.rest_s ?? 90, label);
          else stopRest();
        } else tick();
        void save();
        draw();
      };
      rows.append(
        el(
          "li",
          { class: `lift-set${set.done ? " done" : ""}${loaded ? "" : " bw"}` },
          el("span", { class: "lift-n" }, String(k + 1)),
          loaded ? field("kg", set.kg, "decimal", (v) => (set.kg = v)) : null,
          field(unit, unit === "s" ? set.seconds : set.reps, "numeric", (v) => (unit === "s" ? (set.seconds = v) : (set.reps = v))),
          check,
        ),
      );
    });
    body.append(rows);
    const more = el("button", { type: "button", class: "text-btn" }, icon("plus", "ic sm"), "Add a set");
    more.onclick = () => {
      const lastSet = e.sets.at(-1);
      e.sets.push({ done: false, ...(lastSet?.reps !== undefined ? { reps: lastSet.reps } : {}), ...(lastSet?.seconds !== undefined ? { seconds: lastSet.seconds } : {}), ...(lastSet?.kg ? { kg: lastSet.kg } : {}) });
      draw();
    };
    const how = el("button", { type: "button", class: "text-btn" }, "How to do it");
    how.onclick = () => openExercise(ex, { sets: e.target.sets, reps: e.target.reps, seconds: e.target.seconds, each_side: e.target.each_side });
    body.append(el("div", { class: "row lift-links" }, more, how));

    // After the last set: how much was left, which sets next time's step.
    if (all) {
      const seg = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Reps left after the last set" });
      for (const [v, label] of [[0, "0"], [1, "1"], [2, "2"], [3, "3+"]] as const) {
        const b = el("button", { type: "button", role: "radio", class: "seg", "aria-checked": String(e.rir === v) }, label);
        b.onclick = () => {
          e.rir = v;
          tick();
          void save();
          // On to the next exercise with a set left.
          const nextEx = log.exercises.findIndex((x) => x.sets.some((y) => !y.done));
          if (nextEx >= 0) open = nextEx;
          draw();
        };
        seg.append(b);
      }
      body.append(el("div", { class: "lift-rir" }, el("p", {}, unit === "s" ? "How much longer could you have held it?" : "How many more reps could you have done?"), seg));
    }
    card.append(body);
    return card;
  }

  // Exercises left: the first tap asks, so a brush of the thumb mid-set doesn't end the session.
  let armed: ReturnType<typeof setTimeout> | null = null;
  const finishLabel = () => [icon("check", "ic sm"), log.finished ? "Save" : "Finish"];
  finishBtn.onclick = () =>
    void act(finishBtn, "Finishing", async () => {
      if (!log.exercises.some((e) => e.sets.some((x) => x.done))) {
        history.back();
        return;
      }
      const left = log.exercises.length - doneCount();
      if (left > 0 && !log.finished && !armed) {
        // Said right above the button (a notice would sit over it): tap again to finish anyway.
        finishBtn.replaceChildren(icon("check", "ic sm"), `Finish with ${left} left`);
        confirmLine.textContent = `${left} ${left === 1 ? "exercise isn't" : "exercises aren't"} done. Tap again to finish anyway; ${left === 1 ? "it counts" : "they count"} as skipped.`;
        confirmLine.hidden = false;
        armed = setTimeout(() => {
          armed = null;
          confirmLine.hidden = true;
          finishBtn.replaceChildren(...finishLabel());
        }, 6000);
        return;
      }
      if (armed) clearTimeout(armed);
      armed = null;
      confirmLine.hidden = true;
      stopRest();
      log.finished ??= new Date().toISOString();
      const res = await save(true);
      const r = (await (res as Response).json()) as { log?: LiftLog; summary?: Summary; error?: string };
      if (!r.summary) throw new Error(r.error ?? "not saved");
      success();
      finished(r.summary, s.title);
    });

  draw();
  offerFromWatch();

  /**
   * Done on the watch as a guided workout: its laps say which sets were done. Offered to tick in
   * one go (the watch doesn't count reps, so they're the planned ones), never ticked by itself.
   */
  function offerFromWatch(): void {
    if (log.finished || log.exercises.some((e) => e.sets.some((x) => x.done))) return;
    void app.api
      .json<{ activity: { id: string; name: string; minutes: number }; laps: number; sets: Array<{ id: string; done: number; of: number }> } | null>(`/api/lifts/from-watch?date=${encodeURIComponent(s.date)}`)
      .then((w) => {
        const total = w?.sets.reduce((n, x) => n + Math.min(x.done, log.exercises.find((e) => e.id === x.id)?.sets.length ?? 0), 0) ?? 0;
        if (!w || !total) return;
        const tickAll = el("button", { type: "button", class: "btn filled small" }, icon("check", "ic sm"), `Tick ${total} ${total === 1 ? "set" : "sets"}`);
        const no = el("button", { type: "button", class: "btn text small" }, "Not now");
        const card = el(
          "section",
          { class: "card lift-from-watch", "aria-live": "polite" },
          el("div", { class: "card-head" }, el("div", {}, el("h2", {}, icon("watch", "ic"), "Done on your watch"), el("p", { class: "sub" }, `${w.activity.name}, ${w.activity.minutes} min: its laps account for ${total} ${total === 1 ? "set" : "sets"}.`))),
          el("p", { class: "footnote" }, "The watch doesn't count reps, so they're the planned ones; change any you did differently. Read from the laps, which is new: check they look right."),
          el("div", { class: "row" }, tickAll, no),
        );
        no.onclick = () => card.remove();
        tickAll.onclick = () => {
          for (const x of w.sets) {
            const e = log.exercises.find((y) => y.id === x.id);
            e?.sets.slice(0, x.done).forEach((set) => (set.done = true));
          }
          if (!log.started) log.started = new Date().toISOString();
          open = Math.max(0, log.exercises.findIndex((e) => e.sets.some((x) => !x.done)));
          card.remove();
          draw();
          void save(true);
        };
        list.before(card);
      })
      .catch(() => {});
  }
}

/** Finished: how much, the records, and next time for each exercise. */
function finished(sum: Summary, title: string): void {
  const dialog = el("dialog", { class: "sheet lift-done", "aria-labelledby": "lift-done-title" });
  const close = () => {
    if (!dialog.open) return;
    dialog.classList.add("closing");
    setTimeout(() => dialog.close(), 240);
  };
  dialog.addEventListener("close", () => {
    dialog.remove();
    location.hash = "#today";
  });
  dialog.addEventListener("click", (e) => e.target === dialog && close());
  const stat = (v: string, l: string) => el("div", {}, el("dd", {}, v), el("dt", {}, l));
  dialog.append(
    el(
      "div",
      { class: "sheet-body" },
      el("div", { class: "grabber", "aria-hidden": "true" }),
      el("header", { class: "ex-head" }, el("div", {}, el("h2", { id: "lift-done-title" }, sum.prs.length ? `${sum.prs.length === 1 ? "A record" : `${sum.prs.length} records`} today` : "Session done"), el("p", { class: "session-when" }, title)), el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))),
      el("dl", { class: "kpis lift-kpis" }, stat(`${sum.minutes} min`, "Time"), stat(String(sum.sets), "Sets"), sum.volume_kg ? stat(`${sum.volume_kg.toLocaleString()} kg`, "Lifted") : null),
      sum.prs.length
        ? el("ul", { class: "lift-prs" }, ...sum.prs.map((p) => el("li", {}, el("span", { class: "lift-pr-ic", "aria-hidden": "true" }, icon("spark", "ic sm")), el("span", {}, el("b", {}, p.name), el("span", { class: "sub" }, `${p.text}, was ${p.before}`)))))
        : null,
      sum.next.length ? el("h3", {}, "Next time") : null,
      sum.next.length
        ? el(
            "ul",
            { class: "lift-next" },
            ...sum.next.map((n) => el("li", {}, el("b", {}, n.name), el("span", { class: "lift-arrow" }, n.last, icon("chevron", "ic xs"), el("strong", {}, n.next)), el("span", { class: "sub" }, n.why))),
          )
        : null,
      el("p", { class: "footnote" }, "Next time's weights are on your watch with the session, once the week is sent."),
      el("button", { type: "button", class: "btn filled", onclick: close }, "Done"),
    ),
  );
  document.body.append(dialog);
  dragToClose(dialog);
  dialog.showModal();
}

/** On the phone: a notification when the rest is over, so it buzzes with the screen off. */
async function scheduleRestNote(at: number, next: string): Promise<void> {
  if (!isNative) return;
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    await LocalNotifications.cancel({ notifications: [{ id: REST_NOTE }] }).catch(() => {});
    let perm = (await LocalNotifications.checkPermissions()).display;
    if (perm === "prompt" || perm === "prompt-with-rationale") perm = (await LocalNotifications.requestPermissions()).display;
    if (perm !== "granted") return;
    await LocalNotifications.schedule({ notifications: [{ id: REST_NOTE, title: "Rest's over", body: next, schedule: { at: new Date(at), allowWhileIdle: true } }] });
  } catch {
    // no notification: the timer on screen still runs
  }
}

async function cancelRestNote(): Promise<void> {
  if (!isNative) return;
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    await LocalNotifications.cancel({ notifications: [{ id: REST_NOTE }] });
  } catch {
    // nothing scheduled
  }
}
