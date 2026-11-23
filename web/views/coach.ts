/** The coach's conversation (#chat, opened from the Coach tab): a chat that reads your merged training data and can change your plan. */
import { shellChat } from "../lib/shell.ts";
import { syncSchedule } from "../lib/schedule.ts";
import { ago, el, icon, meta, page } from "../lib/dom.ts";
import { renderMarkdown } from "../lib/md.ts";
import { reduced } from "../lib/motion.ts";
import { act, app, deviceMode, notify, readNdjson } from "../state.ts";
import { largeTitle } from "./today.ts";
import { coachBadge } from "../lib/badge.ts";
import { canDictate, dictate, type Dictation } from "../lib/speech.ts";
import type { ChatImage } from "../../src/coach.ts";

/** A photo for the coach: at most 1280 px on its long side as JPEG, and a 320 px preview. */
async function chatImage(f: File): Promise<ChatImage> {
  if (!f.type.startsWith("image/")) throw new Error("That isn't a photo.");
  const bmp = await createImageBitmap(f);
  const jpeg = (max: number, q: number) => {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", q);
  };
  const full = jpeg(1280, 0.85);
  const thumb = jpeg(320, 0.7);
  bmp.close();
  return { mime: "image/jpeg", data: full.slice(full.indexOf(",") + 1), thumb };
}

/** Speak instead of type (web/lib/speech.ts): the words go into the message box as you say them. */
function voiceFor(box: HTMLTextAreaElement): HTMLElement {
  const mic = el("button", { type: "button", class: "icon-btn composer-tool mic-btn", "aria-label": "Speak your message", "aria-pressed": "false", hidden: true }, icon("mic"));
  let live: Dictation | null = null;
  mic.onclick = () => {
    if (live) return live.stop();
    const before = box.value.trim();
    const join = (w: string) => (before && w ? `${before} ${w}` : before || w);
    box.blur();
    mic.classList.add("listening");
    mic.setAttribute("aria-pressed", "true");
    const hint = box.placeholder;
    box.placeholder = "Listening…";
    live = dictate(
      (w) => {
        box.value = join(w);
        box.dispatchEvent(new Event("input"));
      },
      (level) => mic.style.setProperty("--level", level.toFixed(2)),
    );
    void live.done
      .then((w) => {
        box.value = join(w);
        box.dispatchEvent(new Event("input"));
        if (!w && !before) notify("Didn't catch that. Try again a little closer, or type it.");
      })
      .catch((e: Error) => notify(e.message, "error"))
      .finally(() => {
        live = null;
        mic.classList.remove("listening");
        mic.style.removeProperty("--level");
        mic.setAttribute("aria-pressed", "false");
        box.placeholder = hint;
      });
  };
  void canDictate().then((ok) => (mic.hidden = !ok));
  return mic;
}

type ProviderId = "anthropic" | "google" | "modelhub";
interface ProviderInfo {
  id: ProviderId;
  label: string;
  keyName: string;
  keyHelp: string;
  keySource: string | null;
  model: string;
  models: ReadonlyArray<{ id: string; label: string; note?: string }>;
}
export interface CoachStatus {
  ready: boolean;
  keySource: string | null;
  provider?: ProviderId;
  model: string;
  models: ReadonlyArray<{ id: string; label: string; note?: string }>;
  providers?: ProviderInfo[];
  /** Photos and speaking in the chat, each on unless turned off in Coach settings. */
  photos?: boolean;
  voice?: boolean;
}

const SUGGESTIONS = [
  "How is my training going?",
  "Make me a training plan",
  "Was my last run too hard?",
  "Am I ready for a 10K race?",
  "Why has my easy pace changed?",
];

/** The open conversation; undefined: your latest one, null: a new one. */
let conversation: string | null | undefined;
/** Set by openChat for the next render: text to start the message with, and whether to focus the box. */
let pending: { prefill?: string; focus?: boolean } = {};

/** Open the conversation (default: your latest), optionally starting a message ("About Wed 14 Oct, 6 × 800 m: "). */
export function openChat(o: { conversation?: string | null; prefill?: string; focus?: boolean } = {}): void {
  // Tartan 2: the native chat takes the conversation and the words.
  if (shellChat({ conversation: o.conversation, prefill: o.prefill })) {
    location.hash = "#chat";
    return;
  }
  if (o.conversation !== undefined) conversation = o.conversation;
  pending = { prefill: o.prefill, focus: o.focus };
  if (location.hash === "#chat") window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = "#chat";
}

export async function renderChat(root: HTMLElement): Promise<void> {
  const status = await app.api.json<CoachStatus>("/api/coach/status");
  // Labelled, not icons alone: what they do is not obvious from a clock and a plus.
  const historyBtn = el("button", { type: "button", class: "btn tonal small", "aria-label": "Conversations" }, icon("history", "ic sm"), "Chats");
  const newBtn = el("button", { type: "button", class: "btn tonal small", "aria-label": "New conversation" }, icon("plus", "ic sm"), "New");
  const back = el("a", { class: "back-link", href: "#coach" }, el("span", { class: "flip" }, icon("chevron", "ic sm")), "Plan");
  root.replaceChildren(back, largeTitle("Ask your coach", status.ready ? meta("Reads your workouts, sleep and plan", status.models.find((m) => m.id === status.model)?.label ?? status.model) : undefined, el("div", { class: "row" }, historyBtn, newBtn)));
  if (!status.ready) {
    root.append(setupCard(status, () => renderChat(root)));
    return;
  }
  const opening = pending;
  pending = {};
  if (conversation === undefined) conversation = (await app.api.json<Array<{ id: string }>>("/api/coach/conversations"))[0]?.id ?? null;

  const thread = el("div", { class: "thread", "aria-live": "polite" });
  const input = el("textarea", { class: "composer-input", rows: 1, placeholder: "Ask your coach", "aria-label": "Message the coach" });
  const send = el("button", { type: "submit", class: "send", "aria-label": "Send" }, icon("send"));
  // A photo with the message (a shoe, a meal, a watch screen, a sore spot): resized on the phone first.
  let photo: ChatImage | null = null;
  const attached = el("div", { class: "composer-photo", hidden: true });
  const picker = el("input", { type: "file", accept: "image/*", class: "sr", "aria-hidden": "true", tabIndex: -1 });
  const photoBtn = el("button", { type: "button", class: "icon-btn composer-tool", "aria-label": "Add a photo" }, icon("camera"));
  photoBtn.onclick = () => picker.click();
  const showPhoto = () => {
    attached.hidden = !photo;
    if (!photo) return attached.replaceChildren();
    const remove = el("button", { type: "button", class: "icon-btn", "aria-label": "Remove the photo" }, icon("close", "ic sm"));
    remove.onclick = () => {
      photo = null;
      showPhoto();
    };
    attached.replaceChildren(el("img", { src: photo.thumb!, alt: "Photo to send" }), remove);
  };
  picker.onchange = () =>
    void act(photoBtn, "Adding the photo", async () => {
      const f = picker.files?.[0];
      picker.value = "";
      if (!f) return;
      photo = await chatImage(f);
      showPhoto();
      input.focus();
    });
  const mic = voiceFor(input);
  const tools = el("div", { class: "composer-tools" }, ...(status.photos !== false ? [photoBtn, picker] : []), ...(status.voice !== false ? [mic] : []));
  const composer = el("form", { class: "composer" }, attached, tools, input, send);
  const drawer = el("aside", { class: "history", "aria-label": "Conversations" });
  drawer.hidden = true;
  const syncDrawer = () => root.querySelector(".coach")?.classList.toggle("history-open", !drawer.hidden);
  root.append(el("div", { class: "coach" }, drawer, el("div", { class: "coach-main" }, thread, composer)));

  const empty = () =>
    thread.replaceChildren(
      el(
        "div",
        { class: "coach-empty" },
        el("span", { class: "coach-mark" }, icon("coach", "ic lg")),
        el("h2", {}, "What would you like to know?"),
        el("p", {}, "The coach reads your workouts, load, zones and takeaways before it answers, and shows you what it checked."),
        el("div", { class: "suggestions" }, ...SUGGESTIONS.map((s) => el("button", { type: "button", class: "chip action", onclick: () => ask(s) }, s))),
        el("p", { class: "footnote" }, "Training guidance, not medical advice. AI can be wrong: for pain, illness or anything that worries you, see a doctor."),
      ),
    );

  const bubble = (role: "user" | "assistant", text: string, tools: string[] = [], image?: string, by?: string) => {
    const b = el("div", { class: `msg ${role}` });
    if (image) b.append(el("img", { class: "msg-photo", src: image, alt: "Photo sent to the coach" }));
    if (tools.length) b.append(el("div", { class: "tool-trail" }, ...tools.map((t) => el("span", { class: "chip quiet" }, icon("check", "ic xs"), t))));
    const textNode = el("div", { class: "msg-text" });
    if (role === "assistant") textNode.append(renderMarkdown(text));
    else textNode.textContent = text;
    b.append(textNode);
    if (by && role === "assistant") b.append(el("div", { class: "msg-by" }, by));
    return b;
  };

  const load = async (id: string | null) => {
    conversation = id;
    if (!id) return empty();
    const c = await app.api.json<{ display: Array<{ role: "user" | "assistant"; text: string; tools?: string[]; image?: string; by?: string; failed?: boolean; error?: string; routes?: Array<{ id: string; name: string; km: number }> }> }>(`/api/coach/conversations/${id}`);
    // A turn that failed shows its error (the question stays above it); routes shown link to them.
    thread.replaceChildren(
      ...c.display.map((m) => {
        const b = bubble(m.role, m.failed && m.role === "assistant" ? [m.text, `*${m.error ?? "This answer didn't come through."}*`].filter(Boolean).join("\n\n") : m.text, m.tools, m.image, m.by);
        for (const r of m.routes ?? []) b.append(el("a", { class: "chip action plan-link", href: `#route/${encodeURIComponent(r.id)}` }, icon("route", "ic sm"), `${r.name} · ${r.km.toFixed(1)} km · open it`));
        return b;
      }),
    );
    thread.lastElementChild?.scrollIntoView({ block: "end" });
  };

  const ask = async (text: string) => {
    if (photo && !text.trim()) text = "What do you make of this?";
    if (!text.trim() || send.disabled) return;
    const sending = photo;
    photo = null;
    showPhoto();
    thread.querySelector(".coach-empty")?.remove();
    thread.append(bubble("user", text, [], sending?.thumb));
    const reply = el("div", { class: "msg assistant streaming" });
    const trail = el("div", { class: "tool-trail" });
    const body = el("div", { class: "msg-text" }, el("span", { class: "typing", "aria-label": "Coach is thinking" }, el("i"), el("i"), el("i")));
    reply.append(trail, body);
    thread.append(reply);
    reply.scrollIntoView({ block: "end", behavior: reduced() ? "auto" : "smooth" });
    input.value = "";
    input.style.height = "";
    let textSoFar = "";
    let frame = 0;
    let planned = false;
    let proposed = 0;
    let by = "";
    const routes: Array<{ id: string; name: string; km: number }> = [];
    await act(send, "Coach", async () => {
      const res = await app.api.request("/api/coach/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation, message: text, ...(sending ? { images: [sending] } : {}) }) });
      await readNdjson(res, (m) => {
        if (m.type === "conversation") conversation = String(m.id);
        else if (m.type === "by") by = String(m.label);
        else if (m.type === "route") routes.push({ id: String(m.id), name: String(m.name), km: Number(m.km) });
        else if (m.type === "tool") {
          trail.querySelector(".chip.live")?.classList.remove("live");
          trail.append(el("span", { class: "chip quiet live" }, el("span", { class: "spinner", "aria-hidden": "true" }), String(m.label)));
        } else if (m.type === "text") {
          textSoFar += String(m.delta);
          // Re-render markdown at most once per frame while streaming.
          if (!frame) {
            frame = requestAnimationFrame(() => {
              frame = 0;
              body.replaceChildren(renderMarkdown(textSoFar));
            });
          }
        } else if (m.type === "plan") {
          if (m.proposed) proposed = Number(m.proposed);
          else planned = true;
        } else if (m.type === "error") throw new Error(String(m.message));
      });
    });
    cancelAnimationFrame(frame);
    // The plan or the training times may have changed: reminders and calendar follow.
    void syncSchedule();
    if (planned) reply.append(el("a", { class: "chip action plan-link", href: "#coach" }, icon("plan", "ic sm"), "Plan updated · see the plan"));
    for (const r of routes) reply.append(el("a", { class: "chip action plan-link", href: `#route/${encodeURIComponent(r.id)}` }, icon("route", "ic sm"), `${r.name} · ${r.km.toFixed(1)} km · open it`));
    // A change to an existing plan waits for you on the Coach tab.
    if (proposed) {
      reply.append(el("a", { class: "chip action plan-link", href: "#coach" }, icon("plan", "ic sm"), `${proposed} change${proposed > 1 ? "s" : ""} to the plan · review them`));
      coachBadge(true);
    }
    trail.querySelectorAll(".chip.live").forEach((c) => {
      c.classList.remove("live");
      c.querySelector(".spinner")?.replaceWith(icon("check", "ic xs"));
    });
    reply.classList.remove("streaming");
    if (textSoFar) {
      body.replaceChildren(renderMarkdown(textSoFar));
      if (by) reply.append(el("div", { class: "msg-by" }, by));
    } else reply.remove();
  };

  composer.onsubmit = (e) => {
    e.preventDefault();
    void ask(input.value);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ask(input.value);
    }
  };
  // Tapping the box brings up the keyboard: keep the end of the chat in view above it, not
  // wherever the page happened to be (the keyboard takes its height out of the screen).
  const toEnd = () => page().scrollTo({ top: page().scrollHeight, behavior: "instant" });
  input.addEventListener("focus", () => {
    requestAnimationFrame(toEnd);
    setTimeout(toEnd, 350);
  });
  const onKeyboard = () => {
    if (!input.isConnected) return window.removeEventListener("keyboard", onKeyboard);
    if (document.activeElement === input) toEnd();
  };
  window.addEventListener("keyboard", onKeyboard);
  input.oninput = () => {
    input.style.height = "";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  newBtn.onclick = () => void load(null);
  historyBtn.onclick = async () => {
    drawer.hidden = !drawer.hidden;
    syncDrawer();
    if (drawer.hidden) return;
    const list = await app.api.json<Array<{ id: string; title: string; updated: string }>>("/api/coach/conversations");
    drawer.replaceChildren(
      el("h2", { class: "section-title" }, "Conversations"),
      list.length
        ? el("ul", { class: "rows" }, ...list.map((c) => el("li", {}, el("button", { type: "button", class: `row${c.id === conversation ? " current" : ""}`, onclick: () => { drawer.hidden = true; syncDrawer(); void load(c.id); } }, el("span", { class: "row-main" }, el("b", { class: "row-title" }, c.title), el("span", { class: "row-sub" }, ago(new Date(c.updated))))))))
        : el("p", { class: "empty" }, "No conversations yet."),
    );
  };
  await load(conversation);
  if (opening.prefill) {
    input.value = opening.prefill;
    input.dispatchEvent(new Event("input"));
  }
  if (opening.focus || opening.prefill) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

/** One on/off line, saved the moment it is switched. */
export function switchRow(title: string, sub: string, on: boolean, save: (on: boolean) => Promise<void>): HTMLElement {
  const sw = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(on), "aria-label": title }, el("i"));
  sw.onclick = () =>
    void act(sw, title, async () => {
      const next = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", String(next));
      try {
        await save(next);
      } catch (e) {
        sw.setAttribute("aria-checked", String(!next));
        throw e;
      }
    });
  return el("div", { class: "switch-row coach-flag" }, el("div", {}, el("b", {}, title), el("p", { class: "sub" }, sub)), sw);
}
const saveFlag = async (flags: { photos?: boolean; voice?: boolean }, said: string) => {
  await app.api.request("/api/coach/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(flags) });
  notify(said);
};

export function setupCard(status: CoachStatus, done: () => void): HTMLElement {
  const providers: ProviderInfo[] = status.providers ?? [{ id: "anthropic", label: "Anthropic (Claude)", keyName: "Anthropic API key", keyHelp: "console.anthropic.com → API keys", keySource: status.keySource, model: status.model, models: status.models }];
  let current = providers.find((p) => p.id === status.provider) ?? providers[0]!;
  // Models a key listed (Load models), per provider, for this visit.
  const loaded = new Map<ProviderId, ReadonlyArray<{ id: string; label: string; note?: string }>>();

  const provider = el("select", { "aria-label": "Provider" }, ...providers.map((p) => el("option", { value: p.id, selected: p.id === current.id }, p.label)));
  const model = el("select", { id: "coach-model" });
  const key = el("input", { type: "password", autocomplete: "off" });
  const keyLabel = el("span", {});
  const help = el("p", { class: "footnote" });
  const load = el("button", { type: "button", class: "btn text small" }, icon("sync", "ic sm"), "Load models");
  const save = el("button", { type: "submit", class: "btn filled" }, "Save");
  const keyField = el("label", { class: "field" }, keyLabel, key);

  const fillModels = (selected: string) => {
    const list = [...(loaded.get(current.id) ?? current.models)];
    if (!list.some((m) => m.id === selected)) list.unshift({ id: selected, label: selected });
    model.replaceChildren(...list.map((m) => el("option", { value: m.id, selected: m.id === selected, "data-sub": m.note ?? (m.label === m.id ? undefined : m.id) }, m.label)));
  };
  const show = () => {
    const onPhone = current.id === "modelhub";
    keyField.hidden = help.hidden = load.hidden = onPhone;
    if (onPhone) {
      fillModels(current.model);
      return;
    }
    keyLabel.textContent = current.keySource ? `${current.keyName} (current: ${current.keySource})` : current.keyName;
    key.placeholder = current.id === "google" ? "AIza… or AQ.…" : "sk-ant-…";
    key.setAttribute("aria-label", current.keyName);
    key.value = "";
    // Gemini's free tier: no card needed, within daily limits; Google may use free-tier requests to improve its products.
    const cost =
      current.id === "google"
        ? "Google's free tier needs no card. It has daily request limits (each question takes a few), and on the free tier Google may use what you send to improve its products. With billing turned on, questions are billed to your account."
        : "Each question is billed to your account.";
    help.textContent = `Get a key at ${current.keyHelp}. It is stored only ${deviceMode ? "in this app on your phone and goes nowhere but the provider" : "on this PC, readable by your account alone"}. ${cost}`;
    fillModels(current.model);
  };
  provider.onchange = () => {
    current = providers.find((p) => p.id === provider.value) ?? current;
    show();
  };
  const body = () =>
    JSON.stringify(
      current.id === "modelhub"
        ? { provider: current.id }
        : current.id === "google"
        ? { provider: "google", googleModel: model.value, ...(key.value ? { googleKey: key.value } : {}) }
        : { provider: "anthropic", model: model.value, ...(key.value ? { apiKey: key.value } : {}) },
    );
  load.onclick = () =>
    act(load, "Loading models", async () => {
      // A key just typed is saved first: the list comes from what that key can use.
      if (key.value) await app.api.request("/api/coach/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: body() });
      const res = await app.api.request(`/api/coach/models?provider=${current.id}`);
      const list = (await res.json()) as Array<{ id: string; label: string }> | { error: string };
      if (!Array.isArray(list)) throw new Error(list.error);
      if (!list.length) throw new Error("This key lists no chat models.");
      loaded.set(current.id, list);
      fillModels(model.value);
      notify(`${list.length} ${current.id === "google" ? "Gemini" : "Claude"} models available to your key.`);
    });

  const form = el(
    "form",
    { class: "card setup coach-setup" },
    el("h2", {}, icon("coach", "ic"), status.ready ? "Coach settings" : "Set up your coach"),
    el("p", { class: "sub" }, providers.some((p) => p.id === "modelhub") ? "The coach reads your workouts, sleep and plan: on your own AI key (Claude from Anthropic or Gemini from Google), or on this phone, free and offline (Model Hub)." : "The coach reads your workouts, sleep and plan, on your own AI key: Claude from Anthropic or Gemini from Google."),
    el(
      "div",
      { class: "grid-fields" },
      el("label", { class: "field" }, el("span", {}, "Provider"), provider),
      // Not a <label> around it all: the Load models button must not be the label's target.
      el("div", { class: "field" }, el("span", { class: "label-row" }, el("label", { for: "coach-model" }, "Model"), load), model),
    ),
    keyField,
    help,
    // Photos and speaking in the chat: yours to turn off.
    switchRow("Photos in the chat", "Send a photo with a question (a shoe, a meal, a watch screen, a sore spot). It goes to the coach's model; on the phone's models, to the phone only.", status.photos !== false, (on) => saveFlag({ photos: on }, on ? "Photos are on in the chat." : "Photos are off in the chat.")),
    switchRow("Speak to the coach", "A mic in the message box: say it instead of typing it. On the phone, Android's own recognizer.", status.voice !== false, (on) => saveFlag({ voice: on }, on ? "Speaking is on in the chat." : "Speaking is off in the chat.")),
    el("div", { class: "row" }, save),
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    void act(save, "Saving coach settings", async () => {
      await app.api.request("/api/coach/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: body() });
      key.value = "";
      notify(`Coach settings saved: ${model.selectedOptions[0]?.textContent ?? model.value}.`);
      done();
    });
  };
  show();
  return form;
}
