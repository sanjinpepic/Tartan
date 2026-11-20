/**
 * Watch faces: the list in Settings → More → Advanced → Watch face builder (Tartan Track and the faces you made) and the face
 * builder (#face/<id>, #face/new, #face/copy): a live preview pinned at the top, then the dial
 * (track, marks, hands, the T), the colour of every part, the background (black, a colour or a
 * photo), the seven seconds-hand colours the watch offers, and Save / Install / the package.
 */
import { ART, checkDesign, COLOUR_PARTS, face, newFaceId, PRESETS, surprise, TARTAN_TRACK_DESIGN, type FaceDesign } from "../../src/watchface/tartan-face.ts";
import type { FaceSummary, SavedFace } from "../../src/faces.ts";
import { el, icon } from "../lib/dom.ts";
import { saveBytes } from "../lib/files.ts";
import { success, tick } from "../lib/haptics.ts";
import { act, app, notify } from "../state.ts";
import * as watch from "../watch.ts";
import { largeTitle } from "./today.ts";
import { installed, installFace, setInstalled, unmarkInstalled } from "../lib/face-install.ts";
export { installed, setInstalled, unmarkInstalled };

/** A button that asks for a second tap before `run`. */
function twoTap(label: string, again: string, run: (b: HTMLButtonElement) => void, cls = "btn text danger"): HTMLButtonElement {
  const b = el("button", { type: "button", class: cls }, label);
  let armed = 0;
  b.onclick = () => {
    if (!armed) {
      b.textContent = again;
      armed = window.setTimeout(() => {
        armed = 0;
        b.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    b.textContent = label;
    run(b);
  };
  return b;
}

const preview = (d: FaceDesign | FaceSummary, size: number, data = true) => {
  const box = el("div", { class: "face-thumb", style: `--s:${size}px`, role: "img", "aria-label": `${d.name} at 10:09` });
  // Summaries come without the photo: show the rest on black.
  const design = (d.background.kind === "photo" && !("image" in d.background) ? { ...d, background: { kind: "black" } } : d) as FaceDesign;
  box.innerHTML = face({ design, hours: 10, minutes: 9, seconds: 36, date: "FRI 16", battery: 84, size, data });
  return box;
};

/** Install a design from a button; `status` gets the progress and the outcome. */
export async function install(d: FaceDesign, status: HTMLElement): Promise<void> {
  await installFace(d, (t) => (status.textContent = t));
}

// ------------------------------------------------------------------ Settings → More → Advanced

/** The face list: in Settings → More → Advanced, under "Watch face builder" (which gives its title). */
export async function facesSection(): Promise<HTMLElement> {
  const list = await app.api.json<FaceSummary[]>("/api/faces").catch(() => [] as FaceSummary[]);
  const on = installed();
  const status = el("p", { class: "footnote" });
  const row = (d: FaceDesign | FaceSummary, builtin: boolean) => {
    const open = el("a", { class: "face-item", href: builtin ? "#face/copy" : `#face/${d.id}` }, preview(d, 64), el("span", { class: "face-meta" }, el("b", {}, d.name), el("span", { class: "sub" }, builtin ? "Tartan's own · tap to make it yours" : on[d.id] ? "On your watch" : "Not on your watch yet")), icon("chevron", "ic chev"));
    const btn = el("button", { type: "button", class: "icon-btn tonal", "aria-label": `Install ${d.name} on the watch`, title: "Install on the watch" }, icon("watch"));
    btn.disabled = !watch.canBluetooth();
    btn.onclick = () =>
      act(btn, "Watch face", async () => {
        const full = builtin ? TARTAN_TRACK_DESIGN : await app.api.json<SavedFace>(`/api/faces/${d.id}`);
        await install(full, status);
      });
    return el("li", {}, open, btn);
  };
  // What's on the watch now: Tartan's faces there, each with Remove (the Suunto app doesn't list them).
  const onWatch = el("div", { class: "faces-on-watch" });
  const check = el("button", { type: "button", class: "btn tonal" }, icon("watch", "ic sm"), "Check the watch");
  check.disabled = !watch.canBluetooth();
  check.onclick = () =>
    act(check, "Watch faces", async () => {
      const ids = await watch.watchFaceIds();
      const { isTartanFaceId } = await import("../../src/protocol/face-send.ts");
      const names = new Map<string, string>([[TARTAN_TRACK_DESIGN.id, TARTAN_TRACK_DESIGN.name], ...list.map((f) => [f.id, f.name] as [string, string])]);
      const mine = ids.filter(isTartanFaceId);
      // Bring "On your watch" up to date.
      const now = installed();
      for (const id of Object.keys(now)) if (!ids.includes(id)) delete now[id];
      for (const id of mine) now[id] ??= new Date().toISOString();
      setInstalled(now);
      const rowFor = (id: string) => {
        const name = names.get(id) ?? `Tartan face ${id}`;
        const li = el("li", {}, el("span", { class: "face-meta" }, el("b", {}, name), el("span", { class: "sub" }, `On your watch · ${id}`)));
        li.append(
          twoTap("Remove", "Tap again to remove", (b) =>
            act(b, "Remove face", async () => {
              const removed = await watch.removeFace(id, name);
              unmarkInstalled(id);
              li.remove();
              notify(removed ? `${name} is off your watch.` : `${name} wasn't on your watch.`);
            }),
          ),
        );
        return li;
      };
      onWatch.replaceChildren(
        el("p", { class: "sub" }, `${ids.length} face${ids.length === 1 ? "" : "s"} on the watch, ${mine.length} of them Tartan's. ${mine.length ? "Remove takes one off, as Uninstall does in the Suunto app." : ""} Suunto's own faces are managed in the Suunto app.`),
        el("ul", { class: "face-list on-watch" }, ...mine.map(rowFor)),
      );
    });
  return el(
    "section",
    { class: "faces" },
    el("ul", { class: "face-list" }, row(TARTAN_TRACK_DESIGN, true), ...list.map((d) => row(d, false))),
    el("div", { class: "row" }, el("a", { class: "btn filled", href: "#face/new" }, icon("plus"), "Design a face"), check),
    onWatch,
    status,
  );
}

// ------------------------------------------------------------------ the builder

const PALETTE: Array<[string, string]> = [
  ["Tartan", "#e0452b"], ["Finish", "#ff6a4d"], ["Brick", "#a8321f"], ["Deep tartan", "#7d2615"], ["Rust", "#5a1f14"], ["Ember", "#3d120a"],
  ["Cream", "#fdf3ee"], ["White", "#ffffff"], ["Stone", "#8f817d"], ["Slate", "#5a5250"], ["Graphite", "#3d3634"], ["Ink", "#201a19"], ["Black", "#000000"],
  ["Infield", "#8fe3b4"], ["Moss", "#4f9a6f"], ["Pine", "#1f5c3a"], ["Forest", "#0f2a1c"],
  ["Lane blue", "#a3c6ff"], ["Steel", "#6f8fbf"], ["Navy", "#2a5fa8"], ["Midnight", "#1d3557"], ["Deep sea", "#13233a"],
  ["Amber", "#ffbe3d"], ["Gold", "#b8860b"], ["Lilac", "#c588ff"], ["Rose", "#ff467e"],
];

const ART_LABELS: Record<(typeof ART)[number], string> = {
  none: "None", sunburst: "Sunburst", stripes: "Racing stripes", split: "Split", rings: "Rings", zones: "Heart zones", contours: "Contours", checker: "Chequered", lanes: "Lanes", halftone: "Halftone", watermark: "Big T",
};

type Part = { key: string; label: string; get: (d: FaceDesign) => string; set: (d: FaceDesign, c: string) => void };
const PART_LABELS: Record<(typeof COLOUR_PARTS)[number], string> = {
  hands: "Hands", marks: "Five-minute marks", minor: "Minute marks", numerals: "Numerals", track: "Track", finish: "Finish line", logo: "The T", text: "Text", caps: "Centre caps", art: "Pattern",
};
const PARTS: Part[] = COLOUR_PARTS.map((k): Part => ({ key: k, label: PART_LABELS[k], get: (d) => d.colours[k], set: (d, c) => (d.colours[k] = c) }));
const SECOND_PARTS: Part[] = Array.from({ length: 7 }, (_, i) => ({ key: `s${i}`, label: i === 0 ? "1 · default" : String(i + 1), get: (d) => d.seconds[i]!, set: (d, c) => (d.seconds[i] = c) }));

/** A row of colour swatches (and any colour) that sets `set`. */
function palette(get: () => string, set: (c: string) => void): { el: HTMLElement; mark: () => void } {
  const row = el("div", { class: "fb-swatches", role: "radiogroup", "aria-label": "Colour" });
  const custom = el("input", { type: "color", class: "fb-custom", "aria-label": "Any colour", value: get() });
  const mark = () => {
    const now = get();
    row.querySelectorAll<HTMLElement>(".swatch[data-c]").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.c === now)));
    custom.value = now;
  };
  for (const [label, c] of PALETTE) {
    const b = el("button", { type: "button", class: "swatch", role: "radio", "aria-label": label, title: label, style: `--c:${c}`, "data-c": c });
    b.onclick = () => {
      set(c);
      mark();
    };
    row.append(b);
  }
  custom.oninput = () => {
    set(custom.value.toLowerCase());
    mark();
  };
  row.append(el("label", { class: "swatch custom", title: "Any colour" }, icon("plus", "ic sm"), custom));
  mark();
  return { el: row, mark };
}

export async function renderFaceEditor(root: HTMLElement): Promise<void> {
  const arg = decodeURIComponent(location.hash.split("/")[1] ?? "new");
  let saved = false;
  let d: FaceDesign;
  if (/^\d{6,10}$/.test(arg)) {
    d = checkDesign(await app.api.json<SavedFace>(`/api/faces/${arg}`));
    saved = true;
  } else if (arg === "copy") d = { ...structuredClone(TARTAN_TRACK_DESIGN), id: newFaceId(), name: "My Tartan Track" };
  else d = { ...structuredClone(PRESETS[0]!), id: newFaceId(), name: "My face" };
  let dirty = !saved;

  // ---- the preview, pinned under the top bar, ticking while the builder is open
  const screen = el("div", { class: "fb-screen" });
  const stage = el("div", { class: "fb-stage" }, el("div", { class: "fb-watch" }, el("div", { class: "fb-case" }), screen));
  let raf = 0;
  let showData = true;
  const paint = () => {
    const now = new Date();
    screen.innerHTML = face({ design: d, hours: now.getHours(), minutes: now.getMinutes(), seconds: now.getSeconds(), date: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][now.getDay()], battery: 84, data: showData });
  };
  let last = -1;
  const loop = () => {
    if (!screen.isConnected) return;
    const sec = new Date().getSeconds();
    if (sec !== last) {
      last = sec;
      paint();
    }
    raf = requestAnimationFrame(loop);
  };
  let frame = 0;
  const changed = () => {
    dirty = true;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };

  // ---- name and starting point: a gallery of presets, and a surprise
  const name = el("input", { type: "text", id: "fb-name", value: d.name, maxlength: 30, autocomplete: "off", "aria-label": "Face name" });
  name.oninput = () => {
    d.name = name.value;
    dirty = true;
  };
  const replaceDesign = (next: Omit<FaceDesign, "id" | "name">) => {
    tick();
    d = { ...structuredClone(next), id: d.id, name: d.name } as FaceDesign;
    drawControls();
    changed();
  };
  const gallery = el(
    "div",
    { class: "fb-gallery", role: "group", "aria-label": "Designs to start from" },
    ...PRESETS.map((p) => {
      const b = el("button", { type: "button", class: "fb-preset", "aria-label": `Start from ${p.name}` }, preview({ ...p, id: "0" } as FaceDesign, 76, false), el("span", {}, p.name));
      b.onclick = () => replaceDesign(p);
      return b;
    }),
  );
  const shuffle = el("button", { type: "button", class: "btn tonal" }, icon("spark", "ic sm"), "Surprise me");
  shuffle.onclick = () => replaceDesign(surprise(d.id));

  // ---- the controls follow the design (redrawn when a preset or a surprise replaces it)
  const controls = el("div", { class: "fb-controls" });
  const choices = <T extends string>(label: string, options: Array<[T, string]>, get: () => T, set: (v: T) => void, after?: () => void) => {
    const group = el("div", { class: "choices", role: "radiogroup", "aria-label": label });
    for (const [v, text] of options) {
      const b = el("button", { type: "button", class: "choice", role: "radio", "aria-checked": String(get() === v) }, text);
      b.onclick = () => {
        set(v);
        group.querySelectorAll(".choice").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        after?.();
        changed();
      };
      group.append(b);
    }
    return el("div", { class: "fb-field" }, el("span", { class: "fb-label" }, label), group);
  };
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const sw = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(get()), "aria-label": label }, el("i"));
    sw.onclick = () => {
      set(!get());
      sw.setAttribute("aria-checked", String(get()));
      changed();
    };
    return el("div", { class: "fb-row" }, el("span", { class: "fb-label" }, label), sw);
  };
  const slider = (label: string, get: () => number, set: (v: number) => void) => {
    const r = el("input", { type: "range", min: "0", max: "0.8", step: "0.05", value: String(get()), "aria-label": label });
    r.oninput = () => {
      set(Number(r.value));
      changed();
    };
    return el("label", { class: "field" }, el("span", {}, label), r);
  };
  let part: Part = PARTS[0]!;

  const drawControls = () => {
    // Background.
    const bgExtra = el("div", { class: "fb-bg" });
    const drawBg = () => {
      const bg = d.background;
      const setBg = (b: FaceDesign["background"]) => {
        d.background = b;
        changed();
      };
      bgExtra.replaceChildren();
      if (bg.kind === "colour") bgExtra.append(palette(() => (d.background as { colour: string }).colour, (c) => setBg({ kind: "colour", colour: c })).el);
      else if (bg.kind === "gradient") {
        bgExtra.append(
          el("span", { class: "fb-label" }, "Centre"),
          palette(() => (d.background as { from: string }).from, (c) => setBg({ ...(d.background as { kind: "gradient"; from: string; to: string }), from: c })).el,
          el("span", { class: "fb-label" }, "Edge"),
          palette(() => (d.background as { to: string }).to, (c) => setBg({ ...(d.background as { kind: "gradient"; from: string; to: string }), to: c })).el,
        );
      } else if (bg.kind === "tartan") {
        bgExtra.append(
          el("span", { class: "fb-label" }, "Plaid colour"),
          palette(() => (d.background as { colour: string }).colour, (c) => setBg({ ...(d.background as { kind: "tartan"; colour: string; dim: number }), colour: c })).el,
          slider("Darken it so the hands stand out", () => (d.background as { dim: number }).dim, (v) => ((d.background as { dim: number }).dim = v)),
        );
      } else if (bg.kind === "photo") {
        const file = el("input", { type: "file", accept: "image/*", hidden: true });
        const pick = el("button", { type: "button", class: "btn tonal" }, icon("plus", "ic sm"), bg.image ? "Another photo" : "Choose a photo");
        pick.onclick = () => file.click();
        file.onchange = () => {
          const f = file.files?.[0];
          if (!f) return;
          void act(pick, "Photo", async () => {
            const { photoBackground } = await import("../lib/faces.ts");
            const image = await photoBackground(f);
            d.background = { kind: "photo", image, dim: d.background.kind === "photo" ? d.background.dim : 0.35 };
            drawBg();
            changed();
          });
        };
        bgExtra.append(el("div", { class: "row" }, pick, file), slider("Darken it so the hands stand out", () => (d.background as { dim: number }).dim, (v) => ((d.background as { dim: number }).dim = v)));
      }
    };
    const bgCard = el(
      "section",
      { class: "card fb-card" },
      el("h2", {}, "Background"),
      el("p", { class: "sub" }, "Black is kindest to the battery: an AMOLED screen doesn't light black pixels."),
      choices(
        "Background",
        [["black", "Black"], ["colour", "Colour"], ["gradient", "Gradient"], ["tartan", "Tartan plaid"], ["photo", "Photo"]],
        () => d.background.kind,
        (v) =>
          (d.background =
            v === "colour" ? { kind: "colour", colour: "#201a19" }
            : v === "gradient" ? { kind: "gradient", from: "#5a1f14", to: "#000000" }
            : v === "tartan" ? { kind: "tartan", colour: "#7d2615", dim: 0.45 }
            : v === "photo" ? { kind: "photo", image: "", dim: 0.35 }
            : { kind: "black" }),
        drawBg,
      ),
      bgExtra,
      choices("Pattern", ART.map((a) => [a, ART_LABELS[a]] as [(typeof ART)[number], string]), () => d.art, (v) => (d.art = v)),
      el("p", { class: "footnote" }, "The pattern takes its colour from Pattern under Colours. Heart zones has its own five."),
    );
    drawBg();

    const trackCard = el(
      "section",
      { class: "card fb-card" },
      el("h2", {}, "Track and marks"),
      choices("Track", [["lanes", "Lanes"], ["filled", "Filled"], ["single", "One ring"], ["dashed", "Dashes"], ["bezel", "Bezel with minutes"], ["none", "None"]], () => d.track, (v) => (d.track = v)),
      toggle("Finish line at 12", () => d.finish, (v) => (d.finish = v)),
      choices("Marks", [["all", "Every minute"], ["fives", "Every five"], ["quarters", "Quarters"], ["none", "None"]], () => d.marks, (v) => (d.marks = v)),
      choices("Mark shape", [["line", "Lines"], ["bar", "Bars"], ["dot", "Dots"]], () => d.markShape, (v) => (d.markShape = v)),
    );

    const text = el("input", { type: "text", id: "fb-text", value: d.text, maxlength: 6, autocomplete: "off", placeholder: "e.g. SUB3", "aria-label": "Your text" });
    const textField = el("label", { class: "field" }, el("span", {}, "Your text (up to 6 characters)"), text);
    textField.hidden = d.logo !== "text";
    text.oninput = () => {
      d.text = text.value;
      changed();
    };
    const numbersCard = el(
      "section",
      { class: "card fb-card" },
      el("h2", {}, "Numbers and text"),
      choices("Numerals", [["none", "None"], ["arabic", "12 and 9"], ["roman", "XII and IX"], ["big", "One big 12"]], () => d.numerals, (v) => (d.numerals = v)),
      choices("Above the centre", [["top", "The T"], ["text", "Your text"], ["none", "Nothing"]], () => d.logo, (v) => (d.logo = v), () => (textField.hidden = d.logo !== "text")),
      textField,
      el("p", { class: "footnote" }, "Numbers only fit at 12 and 9: the watch draws its own data everywhere else (see Data below). A big 12 takes the place of the T or your text."),
    );

    const handsCard = el(
      "section",
      { class: "card fb-card" },
      el("h2", {}, "Hands"),
      choices("Hour and minute", [["classic", "Classic"], ["slim", "Slim"], ["baton", "Baton"], ["sword", "Sword"], ["arrow", "Arrow"], ["skeleton", "Skeleton"], ["dauphine", "Dauphine"], ["block", "Block"], ["pencil", "Pencil"]], () => d.hands, (v) => (d.hands = v)),
      choices("Seconds", [["needle", "Needle"], ["lollipop", "Lollipop"], ["arrow", "Arrow"], ["plain", "Plain"]], () => d.secondsStyle, (v) => (d.secondsStyle = v)),
      choices("Centre caps", [["dot", "Dot"], ["ring", "Ring"], ["none", "None"]], () => d.caps, (v) => (d.caps = v)),
    );

    // Colours: pick a part, then a colour.
    const dot = (p: Part) => el("i", { class: "dot", style: `--c:${p.get(d)}` });
    const sw = palette(
      () => part.get(d),
      (c) => {
        part.set(d, c);
        colourCard.querySelector<HTMLElement>(`.chip.part[data-key="${part.key}"] .dot`)?.style.setProperty("--c", c);
        changed();
      },
    );
    const chipsFor = (parts: Part[]) =>
      el(
        "div",
        { class: "chips", role: "radiogroup" },
        ...parts.map((p) => {
          const c = el("button", { type: "button", class: "chip part", role: "radio", "aria-checked": String(p === part), "data-key": p.key }, dot(p), p.label);
          c.onclick = () => {
            part = p;
            colourCard.querySelectorAll(".chip.part").forEach((x) => x.setAttribute("aria-checked", String(x === c)));
            sw.mark();
          };
          return c;
        }),
      );
    const colourCard = el(
      "section",
      { class: "card fb-card" },
      el("h2", {}, "Colours"),
      el("p", { class: "sub" }, "Pick a part, then its colour."),
      chipsFor(PARTS),
      el("span", { class: "fb-label" }, "Seconds hand: the watch lets you choose one of these seven"),
      chipsFor(SECOND_PARTS),
      sw.el,
    );
    // What the watch draws itself.
    const dataCard = el(
      "section",
      { class: "card fb-card" },
      el("h2", {}, "Data"),
      el(
        "p",
        { class: "sub" },
        "The watch draws its own data over the face, in the face's accent colour (the first seconds colour): the compass, the battery, the day, and two spots you fill on the watch. The circle at lower left takes one of 12 kinds of data (heart rate to start with); the big circle on the right one of 5 (steps to start with).",
      ),
      toggle("Show the watch's data in the preview", () => showData, (v) => (showData = v)),
      el("p", { class: "footnote" }, "To pick what goes in the two spots from Tartan, and to put data elsewhere on the dial (weather, sleep, pace), Tartan needs to write its own face layout. That comes next."),
    );
    controls.replaceChildren(bgCard, trackCard, numbersCard, handsCard, colourCard, dataCard);
  };

  // ---- actions
  const status = el("p", { class: "footnote" });
  const persist = async (): Promise<SavedFace> => {
    if (d.background.kind === "photo" && !d.background.image) throw new Error("Choose a photo, or pick another background");
    const body = checkDesign({ ...d, name: name.value });
    const res = await app.api.request(`/api/faces/${saved ? d.id : "new"}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const f = (await res.json()) as SavedFace & { error?: string };
    if (!res.ok) throw new Error(f.error ?? `HTTP ${res.status}`);
    d = { ...f };
    saved = true;
    dirty = false;
    if (location.hash !== `#face/${f.id}`) history.replaceState(null, "", `#face/${f.id}`);
    return f;
  };
  const save = el("button", { type: "button", class: "btn filled" }, "Save");
  save.onclick = () =>
    act(save, "Save", async () => {
      const f = await persist();
      success();
      notify(`Saved ${f.name}.`);
    });
  const send = el("button", { type: "button", class: "btn tonal" }, icon("watch", "ic sm"), "Install on watch");
  send.disabled = !watch.canBluetooth();
  send.onclick = () => act(send, "Watch face", async () => install(await persist(), status));
  const zip = el("button", { type: "button", class: "btn text" }, icon("down", "ic sm"), "Package (.zip)");
  zip.onclick = () =>
    act(zip, "Face package", async () => {
      const f = await persist();
      const { packageFor } = await import("../lib/faces.ts");
      const pkg = await packageFor(f);
      await saveBytes(`${pkg.id}.zip`, pkg.zip, "application/zip");
    });
  const offWatch = twoTap("Remove from watch", "Tap again to remove", (b) =>
    act(b, "Remove face", async () => {
      const removed = await watch.removeFace(d.id, d.name);
      unmarkInstalled(d.id);
      status.textContent = removed ? "Off your watch now." : "It wasn't on your watch.";
      notify(removed ? `${d.name} is off your watch.` : `${d.name} wasn't on your watch.`);
    }),
  );
  offWatch.disabled = !watch.canBluetooth();
  const remove = el("button", { type: "button", class: "btn text danger" }, "Delete face");
  let armed = 0;
  remove.onclick = () => {
    if (!saved) return void (location.hash = "#settings");
    if (!armed) {
      remove.textContent = "Tap again to delete";
      armed = window.setTimeout(() => {
        armed = 0;
        remove.textContent = "Delete face";
      }, 4000);
      return;
    }
    clearTimeout(armed);
    void act(remove, "Delete", async () => {
      await app.api.request(`/api/faces/${d.id}`, { method: "DELETE" });
      notify(`Deleted ${d.name} from Tartan. If it's on your watch, Settings → More → Advanced → Watch face builder → Check the watch takes it off.`);
      location.hash = "#settings";
    });
  };

  root.replaceChildren(
    largeTitle("Face builder", "A watch face for your Suunto Run 2"),
    stage,
    el("section", { class: "card fb-card" }, el("label", { class: "field" }, el("span", {}, "Name"), name), el("div", { class: "row spread" }, el("span", { class: "fb-label" }, "Start from a design"), shuffle), gallery),
    controls,
    el("section", { class: "card fb-card" }, el("div", { class: "row" }, save, send, zip), status, el("div", { class: "row" }, el("a", { class: "btn text", href: "#settings" }, "Back to Settings"), saved ? offWatch : null, saved ? remove : null)),
  );
  drawControls();
  paint();
  raf = requestAnimationFrame(loop);
  // Leaving with changes: a reminder, once.
  const onHash = () =>
    setTimeout(() => {
      if (screen.isConnected) return;
      cancelAnimationFrame(raf);
      window.removeEventListener("hashchange", onHash);
      if (dirty && saved) notify("The face builder had unsaved changes.");
    }, 500);
  window.addEventListener("hashchange", onHash);
}
