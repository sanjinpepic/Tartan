/**
 * Shoes in Settings → Training (each pair's kilometres against its limit, add one, retire one),
 * the pair on a run's sheet, to change for that run, and Today's one-time note about them
 * (src/shoes.ts counts them). Pairs on Strava come in with its sync and link by name; a run moved
 * to a linked pair is set on Strava too.
 */
import { kindFromName, kindOf, limitFor, type ShoeKind, type ShoesView, type ShoeTotal } from "../../src/shoes.ts";
import { dateShort, el, icon, num } from "../lib/dom.ts";
import { act, app, notify } from "../state.ts";

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const KIND_NAME: Record<ShoeKind, string> = { daily: "Daily", racing: "Racing", trail: "Trail" };
/** What a pair is for: Today and the coach pick racing shoes for fast days, trail shoes for trails. */
const kindSelect = (value: ShoeKind, label: string) => el("select", { class: "shoe-kind", "aria-label": label }, ...(Object.keys(KIND_NAME) as ShoeKind[]).map((k) => el("option", { value: k, selected: k === value }, KIND_NAME[k])));
const runs = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;

/** A photo of the pair, squared and small enough to keep in shoes.json. */
async function shoePhoto(file: Blob): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = c.height = 384;
    c.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 384, 384);
    return c.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const photoInput = () => el("input", { type: "file", accept: "image/*", capture: "environment", hidden: true });

async function send<T>(path: string, method: string, body: object): Promise<T> {
  const res = await app.api.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const v = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(v.error ?? `HTTP ${res.status}`);
  return v;
}

export function shoesCard(): HTMLElement {
  const sec = el("section", { class: "card shoes-card" });
  let coachReady = false;
  const draw = (v: ShoesView) => {
    const rows = v.shoes.map((s) => {
      const pct = Math.min(100, Math.round(s.used * 100));
      const retire = el("button", { type: "button", class: "btn text small" }, s.retired ? "Back in use" : "Retire");
      retire.onclick = () =>
        act(retire, "Shoes", async () => {
          draw(await send<ShoesView>("/api/shoes", "PUT", { ...s, photo: undefined, retired: s.retired ? "" : day(new Date()) }));
          notify(s.retired ? `${s.name} back in use.` : `${s.name} retired at ${Math.round(s.km)} km. New runs count to your newest pair.`);
        });
      const pending = v.to_strava[s.id] ?? 0;
      const push = s.strava_id && pending && v.strava.can_write && !s.retired ? el("button", { type: "button", class: "btn tonal small" }, icon("strava", "ic sm"), `Set on Strava · ${runs(pending)}`) : null;
      if (push)
        push.onclick = () =>
          act(push, "Strava", async () => {
            const r = await send<{ done: number; left: number; stopped?: string }>("/api/shoes/strava", "POST", { shoe: s.id });
            draw(await app.api.json<ShoesView>("/api/shoes"));
            notify(`${s.name} set on ${runs(r.done)} on Strava.${r.left ? ` ${r.stopped ?? `${r.left} more: tap again.`}` : ""}`);
          });
      // Everything about the pair (photo, name, type, dates, km) is changed in its editor, opened here.
      const edit = el("button", { type: "button", class: "btn text small", "aria-expanded": "false" }, "Edit");
      const pic = el("button", { type: "button", class: "shoe-pic", "aria-label": `Edit ${s.name}` }, s.photo ? el("img", { src: s.photo, alt: "" }) : icon("camera", "ic sm"));
      let editor: HTMLElement | null = null;
      const toggle = () => {
        if (editor) {
          editor.remove();
          editor = null;
          edit.setAttribute("aria-expanded", "false");
          return;
        }
        editor = pairForm(draw, () => coachReady, s, toggle);
        li.append(editor);
        edit.setAttribute("aria-expanded", "true");
        editor.querySelector<HTMLInputElement>('input[name="shoe-name"]')?.focus();
      };
      edit.onclick = toggle;
      pic.onclick = toggle;
      const line = [KIND_NAME[kindOf(s)], s.retired ? `retired ${dateShort(new Date(`${s.retired}T12:00:00`))} · ${runs(s.runs)}` : `${runs(s.runs)} since ${dateShort(new Date(`${s.since}T12:00:00`))} · retire at ${s.limit_km} km`].join(" · ");
      const li = el(
        "li",
        { class: `shoe${s.retired ? " retired" : ""}${s.used >= 0.9 && !s.retired ? " worn" : ""}` },
        pic,
        el(
          "div",
          { class: "shoe-body" },
          el("div", { class: "shoe-head" }, el("b", {}, s.name, s.strava_id ? el("span", { class: "shoe-strava", title: "On Strava too" }, icon("strava", "ic sm"), el("span", { class: "sr-only" }, "On Strava")) : null), el("span", { class: "shoe-km" }, `${num(s.km, 0)} km`)),
          el("div", { class: "progress-track", role: "img", "aria-label": `${Math.round(s.km)} of ${s.limit_km} km` }, el("span", { style: `width:${pct}%` })),
          el("div", { class: "shoe-foot" }, el("p", { class: "sub" }, line), el("div", { class: "shoe-acts" }, edit, retire)),
          push,
        ),
      );
      return li;
    });
    // Pairs made here that Strava doesn't have: Strava's API can't add shoes, so say how.
    const notOnStrava = v.strava.connected ? v.shoes.filter((s) => !s.strava_id && !s.retired) : [];
    const stravaNote = notOnStrava.length
      ? el("p", { class: "sub shoe-note" }, icon("strava", "ic sm"), `${notOnStrava.length === 1 ? `${notOnStrava[0]!.name} isn't` : "These aren't"} on Strava. Apps can't add shoes there: add ${notOnStrava.length === 1 ? "it" : "them"} once in Strava under My Gear, with the same name, and the next sync links ${notOnStrava.length === 1 ? "it" : "them"}. Then moving a run here moves it on Strava too.`)
      : null;
    sec.replaceChildren(...[el("div", { class: "card-head" }, el("div", {}, el("h2", {}, icon("run", "ic"), "Shoes"), el("p", { class: "sub" }, v.shoes.length ? "A run counts to the pair Strava has on it, else by type: racing shoes on fast days, trail shoes on trails, daily shoes for the rest. Change one on its sheet." : v.strava.connected ? "How many kilometres are on your shoes. Pairs you have on Strava come in with its sync. Most last 500-800 km; Today says when a pair gets close." : "How many kilometres are on your shoes. Most last 500-800 km; Today says when a pair gets close."))), v.shoes.length ? el("ul", { class: "shoes" }, ...rows) : null, stravaNote, v.shoes.length ? el("details", { class: "more" }, el("summary", {}, "Add a pair"), pairForm(draw, () => coachReady)) : pairForm(draw, () => coachReady)].filter((x): x is HTMLElement => !!x));
  };
  void app.api
    .json<{ ready: boolean }>("/api/coach/status")
    .then((s) => (coachReady = s.ready))
    .catch(() => {});
  void app.api.json<ShoesView>("/api/shoes").then(draw).catch(() => sec.remove());
  return sec;
}

/**
 * Add a pair, or edit one (`pair`): a photo if you like (the coach can read the name off it), a
 * name, its type, when you started wearing them and what's on them. Editing also offers Remove.
 */
function pairForm(draw: (v: ShoesView) => void, coachReady: () => boolean, pair?: ShoeTotal, close?: () => void): HTMLElement {
  let photo: string | undefined;
  const name = el("input", { name: "shoe-name", placeholder: "e.g. Pegasus 41", maxLength: 40, required: true, value: pair?.name ?? "" });
  const since = el("input", { type: "date", value: pair?.since ?? day(new Date()) });
  const start = el("input", { type: "number", inputmode: "numeric", min: "0", max: "5000", value: String(pair?.start_km ?? 0) });
  const limit = el("input", { type: "number", inputmode: "numeric", min: "100", max: "3000", value: String(pair?.limit_km ?? 700) });
  // The type follows the name until you pick one (an existing pair's is already picked); the limit follows the type.
  const kind = kindSelect(pair ? kindOf(pair) : "daily", "What they're for");
  let kindPicked = !!pair;
  kind.onchange = () => {
    kindPicked = true;
    limit.value = String(limitFor(kind.value));
  };
  name.onchange = () => {
    if (kindPicked) return;
    kind.value = kindFromName(name.value);
    limit.value = String(limitFor(kind.value));
  };
  const add = pair ? el("button", { type: "submit", class: "btn filled" }, "Save") : el("button", { type: "submit", class: "btn tonal" }, icon("plus", "ic sm"), "Add the pair");
  const file = photoInput();
  const preview = el("span", { class: "shoe-pic", "aria-hidden": "true" }, pair?.photo ? el("img", { src: pair.photo, alt: "" }) : icon("camera", "ic sm"));
  const take = el("button", { type: "button", class: "btn text small" }, pair?.photo ? "Another photo" : "Add a photo");
  const recognise = el("button", { type: "button", class: "btn tonal small", hidden: true }, "Read the name off it");
  take.onclick = () => file.click();
  file.onchange = () => {
    const f = file.files?.[0];
    if (!f) return;
    void act(take, "Photo", async () => {
      photo = await shoePhoto(f);
      preview.replaceChildren(el("img", { src: photo, alt: "" }));
      take.textContent = "Another photo";
      recognise.hidden = !coachReady();
    });
  };
  recognise.onclick = () =>
    act(recognise, "Coach", async () => {
      const r = await send<{ name: string | null; kind: string; limit_km: number }>("/api/shoes/recognise", "POST", { photo });
      if (!r.name) return notify("Couldn't tell which shoe that is. Type its name instead.");
      name.value = r.name;
      limit.value = String(r.limit_km);
      kind.value = r.kind;
      kindPicked = true;
      notify(`Looks like ${r.name}: ${r.kind === "racing" ? "a racing shoe, so around 400 km" : r.kind === "trail" ? "a trail shoe, around 700 km" : "a daily trainer, around 700 km"}. Change anything that's off.`);
    });
  const cancel = pair ? el("button", { type: "button", class: "btn text", onclick: () => close?.() }, "Cancel") : null;
  // Remove (a duplicate, a pair added by mistake): a second tap to be sure; its runs go back to the others.
  const remove = pair ? el("button", { type: "button", class: "btn text danger shoe-remove" }, "Remove") : null;
  if (remove && pair)
    remove.onclick = () => {
      if (!remove.classList.contains("armed")) {
        remove.classList.add("armed");
        remove.textContent = "Tap again to remove";
        return;
      }
      void act(remove, "Shoes", async () => {
        const res = await app.api.request(`/api/shoes/${encodeURIComponent(pair.id)}`, { method: "DELETE" });
        draw((await res.json()) as ShoesView);
        notify(`${pair.name} removed. Its runs count to your other pairs.`);
      });
    };
  const form = el(
    "form",
    { class: `setup shoe-form${pair ? " shoe-editor" : ""}`, ...(pair ? { "aria-label": `Edit ${pair.name}` } : {}) },
    el("div", { class: "shoe-photo-row" }, preview, el("div", { class: "row" }, take, recognise), file),
    el("div", { class: "grid-fields shoe-name-row" }, el("label", { class: "field" }, el("span", {}, "Name"), name), el("label", { class: "field" }, el("span", {}, "Type"), kind)),
    el("div", { class: "grid-fields three" }, el("label", { class: "field" }, el("span", {}, "First worn"), since), el("label", { class: "field" }, el("span", {}, "Km on them already"), start), el("label", { class: "field" }, el("span", {}, "Retire at (km)"), limit)),
    el("div", { class: "row" }, add, cancel, remove),
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    void act(add, "Shoes", async () => {
      draw(await send<ShoesView>("/api/shoes", "PUT", { ...(pair ? { id: pair.id } : {}), name: name.value, since: since.value, start_km: Number(start.value), limit_km: Number(limit.value), kind: kind.value, ...(photo ? { photo } : {}) }));
      notify(pair ? `${name.value.trim()} saved.` : `${name.value.trim()} added. Runs from ${dateShort(new Date(`${since.value}T12:00:00`))} count to them.`);
    });
  };
  return form;
}

/** On a run's sheet: the pair it counts to, and a picker to change it for this run (on Strava too, for a linked pair). */
export function runShoes(activityId: string): HTMLElement {
  const box = el("div", { class: "run-shoes", hidden: true });
  const load = () =>
    app.api
      .json<{ shoe: string | null; shoes: ShoesView["shoes"]; moved: boolean }>(`/api/shoes/run?id=${encodeURIComponent(activityId)}`)
      .then((r) => {
        if (!r.shoes.length) return;
        const pick = el(
          "select",
          { "aria-label": "Shoes for this run" },
          ...r.shoes.filter((s) => !s.retired || s.id === r.shoe).map((s) => el("option", { value: s.id, selected: s.id === r.shoe }, s.name)),
          el("option", { value: "", selected: !r.shoe }, "No shoes counted"),
        );
        pick.onchange = () => {
          const name = r.shoes.find((s) => s.id === pick.value)?.name;
          void send<{ strava: "set" | "same" | "not-linked" | "not-allowed" | "failed" | null }>("/api/shoes/run", "PUT", { run: activityId, shoe: pick.value || null })
            .then(({ strava }) =>
              notify(
                !pick.value
                  ? "This run counts to no shoes."
                  : strava === "set"
                    ? `This run counts to ${name}, on Strava too.`
                    : strava === "not-linked"
                      ? `This run counts to ${name}. ${name} isn't on Strava: add it there under My Gear and the next sync links it.`
                      : strava === "not-allowed"
                        ? `This run counts to ${name}. To change it on Strava too, reconnect Strava and approve uploads.`
                        : strava === "failed"
                          ? `This run counts to ${name}. Strava didn't take the change; try again later.`
                          : `This run counts to ${name}.`,
              ),
            )
            .catch((e: Error) => notify(`Couldn't change it: ${e.message}`, "error"));
        };
        box.replaceChildren(el("span", { class: "run-shoes-label" }, icon("run", "ic sm"), "Shoes"), pick);
        box.hidden = false;
      })
      .catch(() => {});
  void load();
  return box;
}

const FOUND = "freesuunto.shoes.found";
const NUDGE_OFF = "freesuunto.shoes.nudge.off";
/** The Strava note stays for this session once shown (Today can draw more than once), until closed. */
let foundNow = false;
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return "1";
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // asks again
    }
  },
};

/**
 * Today, once: "Found your N pairs from Strava" the first time pairs come in from it; or, with
 * no pairs and a week of runs behind you, "Which shoes do you run in?" until added or Not now.
 */
export async function shoesNote(): Promise<HTMLElement | null> {
  const v = await app.api.json<ShoesView>("/api/shoes").catch(() => null);
  if (!v) return null;
  const fromStrava = v.shoes.filter((s) => s.strava_id && !s.retired);
  const card = (title: string, text: string, go: string, quiet: string, key: string) => {
    const close = () => {
      store.set(key, "1");
      foundNow = false;
      box.remove();
    };
    const box = el(
      "section",
      { class: "card pair-hint shoes-note", "data-reveal": "" },
      el("span", { class: "ob-choice-ic", "aria-hidden": "true" }, icon("run")),
      el("div", {}, el("h2", {}, title), el("p", { class: "sub" }, text), el("div", { class: "row" }, el("a", { class: "btn tonal small", href: "#settings/training", onclick: close }, go), el("button", { type: "button", class: "btn text small", onclick: close }, quiet))),
    );
    return box;
  };
  if (fromStrava.length && (foundNow || !store.get(FOUND))) {
    // Once: it's shown this session and not again.
    store.set(FOUND, "1");
    foundNow = true;
    const n = fromStrava.length;
    return card(`Found your ${n === 1 ? "pair" : `${n} pairs`} from Strava`, `${fromStrava.map((s) => `${s.name} (${num(s.km, 0)} km)`).join(", ")}. Runs count to them from now on, and Today says when one is close to done.`, "See them", "OK", FOUND);
  }
  const first = v.runs?.first ? Date.parse(v.runs.first) : NaN;
  if (!v.shoes.length && !store.get(NUDGE_OFF) && (v.runs?.count ?? 0) >= 3 && Date.now() - first > 7 * 86400_000)
    return card("Which shoes do you run in?", "Add a pair and Tartan counts their kilometres from your runs, and says when they're close to done.", "Add a pair", "Not now", NUDGE_OFF);
  return null;
}
