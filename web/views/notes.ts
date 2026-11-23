/**
 * How a run went, in your words and the watch's: the watch's "How did it feel?" and your notes
 * on it (a win, a niggle with where, a note; src/run-notes.ts). On the workout sheet. Niggles
 * count with the morning check's pain, so readiness, the body map and the coach see them.
 */
import { FEELING_NAME, type Feeling } from "../../src/sbem.ts";
import type { PainArea } from "../../src/readiness.ts";
import { areaName, areaPicker } from "../lib/areas.ts";
import type { RunNote, NoteTag } from "../../src/run-notes.ts";
import { el, icon } from "../lib/dom.ts";
import { act, app, notify } from "../state.ts";
import { canDictate, dictate, type Dictation } from "../lib/speech.ts";

/** Keep the newest words in view as they come, like a text-TV ticker (the box is one line). */
function follow(box: HTMLInputElement): void {
  requestAnimationFrame(() => {
    const left = box.scrollWidth - box.clientWidth;
    if (left <= 0) return;
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      box.scrollTo({ left, behavior: calm ? "auto" : "smooth" });
    } catch {
      box.scrollLeft = left;
    }
  });
}

/**
 * Speak the note: a mic beside the box. Your words appear as you say them (after anything you'd
 * typed); a ring follows your voice; tap again to stop. It listens in the phone's own language,
 * and leaves the keyboard closed (the words are there to edit if you tap the box).
 */
function micFor(text: HTMLInputElement, spoke: () => void): { el: HTMLElement; listening: () => boolean } {
  const wrap = el("span", { class: "note-mic", hidden: true });
  const mic = el("button", { type: "button", class: "icon-btn tonal mic-btn", "aria-label": "Say it instead", "aria-pressed": "false" }, icon("mic"));
  let live: Dictation | null = null;
  mic.onclick = () => {
    if (live) return live.stop();
    const before = text.value.trim();
    // Speaking, not typing: put the keyboard away.
    text.blur();
    const join = (words: string) => (before && words ? `${before} ${words}` : before || words);
    mic.classList.add("listening");
    mic.setAttribute("aria-pressed", "true");
    mic.setAttribute("aria-label", "Stop listening");
    const hint = text.placeholder;
    text.placeholder = "Listening…";
    live = dictate(
      (words) => {
        text.value = join(words);
        text.dispatchEvent(new Event("input"));
        follow(text);
      },
      (level) => mic.style.setProperty("--level", level.toFixed(2)),
    );
    void live.done
      .then((words) => {
        text.value = join(words);
        text.dispatchEvent(new Event("input"));
        follow(text);
        if (!words && !before) notify("Didn't catch that. Try again a little closer, or type it.");
        return words;
      })
      .catch((e: Error) => (notify(e.message, "error"), ""))
      .then((words) => {
        live = null;
        mic.classList.remove("listening");
        mic.style.removeProperty("--level");
        mic.setAttribute("aria-pressed", "false");
        mic.setAttribute("aria-label", "Say it instead");
        text.placeholder = hint;
        if (words) spoke();
      });
  };
  void canDictate().then((ok) => (wrap.hidden = !ok));
  wrap.append(mic);
  return { el: wrap, listening: () => !!live };
}

const TAG: Record<NoteTag, { label: string; hint: string; ic: string }> = {
  win: { label: "Win", hint: "e.g. first sub-25 5k", ic: "spark" },
  niggle: { label: "Niggle", hint: "e.g. tight after the hills", ic: "warn" },
  note: { label: "Note", hint: "e.g. windy, started too fast", ic: "bookmark" },
};
const where = areaName;

/** "Felt good" with five pips, from the watch. */
export function feelingLine(f: number): HTMLElement {
  const word = FEELING_NAME[f as Feeling] ?? "";
  return el(
    "p",
    { class: "feeling", "aria-label": `Felt ${word.toLowerCase()}, as you answered on the watch` },
    el("span", { class: "feeling-pips", "aria-hidden": "true" }, ...[1, 2, 3, 4, 5].map((i) => el("i", { class: i <= f ? "on" : "" }))),
    el("b", {}, `Felt ${word.toLowerCase()}`),
    el("span", { class: "sub" }, "on your watch"),
  );
}

export function howItWent(runId: string, feeling?: number): HTMLElement {
  const card = el("section", { class: "card flat notes-card" });
  const draw = (notes: RunNote[], felt: number | null) => {
    const list = notes.length
      ? el(
          "ul",
          { class: "run-notes" },
          ...notes.map((n) => {
            const del = el("button", { type: "button", class: "icon-btn small", "aria-label": `Remove this ${TAG[n.tag].label.toLowerCase()}` }, icon("close", "ic sm"));
            del.onclick = () =>
              act(del, "Note", async () => {
                await app.api.request(`/api/notes/${encodeURIComponent(n.id)}`, { method: "DELETE" });
                draw(notes.filter((x) => x.id !== n.id), felt);
              });
            return el("li", { class: `run-note t-${n.tag}` }, el("span", { class: "note-tag" }, icon(TAG[n.tag].ic, "ic xs"), TAG[n.tag].label, n.area ? ` · ${where(n.area)}` : ""), n.text ? el("span", { class: "note-text" }, n.text) : null, del);
          }),
        )
      : null;
    const add = form(runId, (next) => draw(next, felt));
    card.replaceChildren(
      ...[el("h3", {}, "How it went"), felt ? feelingLine(felt) : null, list, notes.length ? el("details", { class: "more" }, el("summary", {}, "Add a note"), add) : add].filter((x): x is HTMLElement => !!x),
    );
  };
  draw([], feeling ?? null);
  void app.api
    .json<{ notes: RunNote[]; feeling: number | null }>(`/api/notes?run=${encodeURIComponent(runId)}`)
    .then((r) => draw(r.notes, r.feeling ?? feeling ?? null))
    .catch(() => {});
  return card;
}

/**
 * A win, a niggle (and where) or a note: a tag and a few words, kept by themselves (no Save):
 * when you finish speaking, press done on the keyboard, leave the box, close the sheet or
 * switch away from the app. Then it joins the list above and the form starts fresh.
 */
function form(runId: string, done: (notes: RunNote[]) => void): HTMLElement {
  let tag: NoteTag = "note";
  let area: PainArea | null = null;
  let saving = false;
  let gone = false;
  const text = el("input", { type: "text", maxLength: 280, placeholder: TAG.note.hint, "aria-label": "Your note", enterkeyhint: "done" });
  const tags = el("div", { class: "segmented note-tags", role: "radiogroup", "aria-label": "What kind of note" });
  const status = el("p", { class: "note-status", "aria-live": "polite", hidden: true }, "");
  const has = () => !!(text.value.trim() || (tag === "niggle" && area));
  const say = (t: string) => ((status.textContent = t), (status.hidden = !t));
  const pending = () => !saving && say(has() ? "Kept by itself when you're done." : "");
  text.addEventListener("input", pending);
  const areas = el("div", { class: "note-areas", hidden: true }, el("span", { class: "field-label" }, "Where?"), areaPicker(null, (a) => ((area = a), pending()), "Where it niggles"));
  const pickTag = (t: NoteTag) => {
    tag = t;
    pending();
    tags.querySelectorAll<HTMLElement>(".seg").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.tag === t)));
    text.placeholder = TAG[t].hint;
    areas.hidden = t !== "niggle";
  };
  for (const t of ["win", "niggle", "note"] as NoteTag[]) {
    const b = el("button", { type: "button", role: "radio", class: "seg", "data-tag": t, "aria-checked": String(t === tag) }, TAG[t].label);
    b.onclick = () => pickTag(t);
    tags.append(b);
  }
  const commit = async () => {
    if (saving || gone || !has() || mic.listening()) return;
    saving = true;
    say("Saving…");
    try {
      const res = await app.api.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: runId, tag, text: text.value, ...(area ? { area } : {}) }) });
      const r = (await res.json()) as { notes?: RunNote[]; error?: string };
      if (!res.ok || !r.notes) throw new Error(r.error ?? `HTTP ${res.status}`);
      gone = true;
      document.removeEventListener("close", onClose, true);
      document.removeEventListener("visibilitychange", onHide);
      notify(tag === "niggle" ? "Noted. Readiness and your coach take it into account." : tag === "win" ? "Noted. Nice one." : "Noted. Your coach will see it.");
      done(r.notes);
    } catch (e) {
      say(`Not kept yet: ${(e as Error).message}. It tries again when you leave the box.`);
    } finally {
      saving = false;
    }
  };
  const mic = micFor(text, () => void commit());
  const f = el("form", { class: "note-form" }, tags, areas, el("div", { class: "note-row" }, text, mic.el), status);
  f.onsubmit = (e) => {
    e.preventDefault();
    text.blur();
    void commit();
  };
  // Leaving the form (not moving within it, say from the box to the mic or a place) keeps the note.
  f.addEventListener("focusout", (e) => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (to && f.contains(to)) return;
    setTimeout(() => !f.contains(document.activeElement) && void commit(), 0);
  });
  // Closing the sheet, or the app going to the background, keeps it too.
  const onClose = (e: Event) => (e.target as Node).contains(f) && void commit();
  const onHide = () => document.visibilityState === "hidden" && f.isConnected && void commit();
  document.addEventListener("close", onClose, true);
  document.addEventListener("visibilitychange", onHide);
  return f;
}
