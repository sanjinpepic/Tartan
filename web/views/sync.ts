/** Connections, shown in Settings: Strava, the watch and the PC link. */
import { ago, el, fmtBytes, hhmm, icon } from "../lib/dom.ts";
import { act, app, deviceMode, isNative, local, notify } from "../state.ts";
import { autoSync, openStravaConsent, stravaStatus, stravaSync } from "../sync.ts";
import * as watch from "../watch.ts";
import { pcPairCard, phoneLinkCard } from "./pc-link.ts";

let unsubscribe: (() => void) | null = null;

/** Strava first (where most data comes from), then the watch. */
export async function dataSources(o: { sendToStrava?: boolean } = {}): Promise<HTMLElement[]> {
  unsubscribe?.();
  return [await stravaSection(), watchSection(), importSection(), ...(o.sendToStrava === false ? [] : [await sendWatchSection()])];
}

// ------------------------------------------------------------------ workout files from other apps

/** FIT files from any watch or app (src/import.ts): they merge with Strava's copies like the watch's own. */
function importSection(): HTMLElement {
  const input = el("input", { type: "file", accept: ".fit,application/vnd.ant.fit,application/octet-stream", multiple: true, class: "sr" });
  const pick = el("button", { type: "button", class: "btn tonal" }, icon("plus", "ic sm"), "Import .fit files");
  const result = el("p", { class: "footnote", hidden: true });
  pick.onclick = () => input.click();
  input.onchange = () =>
    void act(pick, "Importing", async () => {
      const files = [...(input.files ?? [])];
      input.value = "";
      if (!files.length) return;
      let added = 0;
      let already = 0;
      const failed: string[] = [];
      for (const f of files) {
        const res = await app.api.request("/api/import/fit", { method: "POST", headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(f.name) }, body: new Uint8Array(await f.arrayBuffer()) });
        const r = (await res.json()) as { already?: boolean; error?: string };
        if (!res.ok) failed.push(r.error ?? `${f.name}: ${res.status}`);
        else if (r.already) already++;
        else added++;
      }
      const said = [added ? `Imported ${added} workout${added === 1 ? "" : "s"}.` : "", already ? `${already} ${already === 1 ? "was" : "were"} already here.` : ""].filter(Boolean).join(" ");
      result.textContent = [said, ...failed].filter(Boolean).join(" ");
      result.hidden = false;
      if (said) notify(said);
      if (failed.length) notify(failed[0]!, "error");
    });
  return el(
    "section",
    { class: "card import-card" },
    el("h2", {}, icon("file", "ic"), "Workout files"),
    el("p", { class: "sub" }, "From another watch or app: export a workout as a .fit file (Garmin Connect: ⋯ → Export Original; Coros, Polar, Wahoo and Zwift have their own export) and import it here. A workout Strava also has appears once."),
    el("div", { class: "row" }, pick),
    input,
    result,
  );
}

// ------------------------------------------------------------------ watch workouts → Strava (opt in)

interface SendWatchStatus {
  enabled: boolean;
  since?: string;
  connected: boolean;
  can_upload: boolean;
  sent: number;
  last: { name?: string; start?: string } | null;
  errors: Array<{ name?: string; error?: string }>;
}

/**
 * The switch for sending watch workouts to Strava. It acts right after a watch sync saves new
 * workouts (web/watch.ts), never on a timer; the copy says when to leave it off.
 */
async function sendWatchSection(): Promise<HTMLElement> {
  const sec = el("section", { class: "card send-watch" });
  const draw = (s: SendWatchStatus) => {
    const sw = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(s.enabled), "aria-label": "Send watch workouts to Strava" }, el("i"));
    sw.onclick = async () => {
      sw.disabled = true;
      sw.setAttribute("aria-checked", String(!s.enabled)); // the thumb moves at once
      try {
        const res = await app.api.request("/api/strava/send-watch", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) });
        const next = (await res.json()) as SendWatchStatus;
        draw(next);
        notify(next.enabled ? "On. New watch workouts go to Strava after each watch sync." : "Off. Watch workouts stay in Tartan.");
      } catch (e) {
        sw.setAttribute("aria-checked", String(s.enabled));
        sw.disabled = false;
        notify(`Couldn't change it: ${(e as Error).message}`, "error");
      }
    };
    const since = s.since ? new Date(s.since).toLocaleDateString([], { day: "numeric", month: "short" }) : "";
    const status = !s.enabled
      ? null
      : !s.connected
        ? el("p", { class: "callout" }, icon("info", "ic sm"), "Connect Strava above first.")
        : !s.can_upload
          ? el("p", { class: "callout" }, icon("info", "ic sm"), "Strava hasn't allowed uploads yet: tap Allow uploads on the Strava card.")
          : el("p", { class: "footnote" }, s.sent ? `${s.sent} sent since ${since}${s.last?.name ? ` · last: ${s.last.name}` : ""}.` : `On since ${since}. Nothing needed sending yet.`);
    sec.replaceChildren(
      el(
        "div",
        { class: "switch-row" },
        el(
          "div",
          {},
          el("h2", {}, icon("send", "ic"), "Send watch workouts to Strava"),
          el("p", { class: "sub" }, "When a watch sync brings in a workout Strava doesn't have, Tartan uploads it. Only workouts from when you turn this on. Leave it off if the Suunto app already sends your workouts to Strava."),
        ),
        sw,
      ),
      ...(status ? [status] : []),
      ...(s.enabled && s.errors.length ? [el("p", { class: "field-error" }, `${s.errors[0]!.name ?? "A workout"}: ${s.errors[0]!.error ?? "couldn't be sent"}. Tried again after the next watch sync.`)] : []),
    );
  };
  const st = await app.api.json<SendWatchStatus>("/api/strava/send-watch").catch(() => null);
  if (st) draw(st);
  else sec.hidden = true;
  return sec;
}

export async function pcSections(): Promise<HTMLElement[]> {
  return [linkSection()];
}

// ------------------------------------------------------------------ watch

let advancedOpen = false;

export function watchSection(): HTMLElement {
  const sec = el("section", { class: "group-card" });
  const render = (s: watch.WatchState) => {
    const head = el("div", { class: "card-head" }, el("div", {}, el("h2", {}, el("span", { class: "lane-dot", style: "--c:var(--lane-watch-ui)" }), "Watch"), el("p", { class: "sub" }, s.connected ? `Connected to ${s.demo ? "the demo watch" : s.name}` : "Bluetooth, the same protocol the Suunto app uses")));
    const actions = el("div", { class: "row" });
    if (!s.connected && s.connecting) {
      // While a connection is being set up there is nothing to press: just say so.
      actions.append(el("p", { class: "gps" }, el("span", { class: "spinner", "aria-hidden": "true" }), "Connecting to the watch…"));
    } else if (!s.connected) {
      const c = el("button", { type: "button", class: "btn filled" }, icon("watch"), "Connect watch");
      c.disabled = !watch.canBluetooth();
      c.onclick = () => act(c, "Connect", () => watch.connect());
      const d = el("button", { type: "button", class: "btn tonal" }, "Try demo watch");
      d.onclick = () => act(d, "Demo", () => watch.connect(true));
      // The phone keeps it simple: the demo watch is for trying Tartan out on a computer.
      actions.append(...(isNative ? [c] : [c, d]));

    } else {
      const all = el("button", { type: "button", class: "btn filled" }, icon("sync"), "Back up now");
      all.onclick = () => act(all, "Backup", async () => void (await watch.backup("/", force.checked)));
      const dis = el("button", { type: "button", class: "btn text" }, "Disconnect");
      dis.onclick = () => void watch.disconnect();
      actions.append(all, dis);
    }
    const force = el("input", { type: "checkbox" });
    const parts: Array<Node | null> = [head, actions];
    if (s.mode === "logbook" || (!s.connected && watch.noFileAccess())) {
      parts.push(
        el(
          "p",
          { class: "callout" },
          icon("info", "ic sm"),
          "This watch hands over workouts from its logbook, the way the Suunto app syncs them. Only workouts the Suunto app hasn't synced yet are there, so Tartan reads them first when it can; it never marks them as synced, so the Suunto app still gets every one.",
        ),
      );
    }
    if (!watch.canBluetooth()) parts.push(el("p", { class: "callout" }, icon("info", "ic sm"), "This browser has no Web Bluetooth. Use Chrome or Edge on a computer, the Tartan Android app, or ", el("code", {}, "bun src/cli.ts backup"), " on Linux. The demo watch works anywhere."));
    if (s.job) {
      const bar = el("progress", {});
      if (s.job.value !== undefined) {
        bar.max = s.job.max ?? 1;
        bar.value = s.job.value;
      }
      const stop = el("button", { type: "button", class: "btn text small" }, "Stop");
      stop.onclick = () => watch.cancel();
      parts.push(el("div", { class: "job" }, el("div", { class: "row spread" }, el("b", {}, s.job.title), s.running ? stop : null), bar, el("p", { class: "sub" }, s.job.text)));
    }
    if (s.connected) {
      const facts = isNative ? s.facts.filter(([k]) => ["Watch", "Battery", "Firmware"].includes(k)) : s.facts;
      parts.push(el("dl", { class: "facts" }, ...facts.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])));
      const crumbs = el("nav", { class: "crumbs", "aria-label": "Folder on the watch" }, icon("folder", "ic sm"));
      const pp = s.cwd.split("/").filter(Boolean);
      const crumb = (label: string, target: string) => el("button", { type: "button", onclick: () => act(null, "Open folder", () => watch.browse(target)) }, label);
      crumbs.append(crumb("watch", "/"), ...pp.flatMap((p, i) => [el("span", {}, "/"), crumb(p, "/" + pp.slice(0, i + 1).join("/"))]));
      const entries = el("ul", { class: "rows inset files" });
      for (const d of [...(s.listing?.dirs ?? [])].sort()) {
        const target = watch.childPath(s.cwd, d);
        entries.append(el("li", {}, el("button", { type: "button", class: "row", onclick: () => act(null, "Open folder", () => watch.browse(target)) }, el("span", { class: "row-ic" }, icon("folder")), el("span", { class: "row-main" }, el("b", { class: "row-title mono" }, `${d}/`)), icon("chevron", "ic chev"))));
      }
      for (const f of [...(s.listing?.files ?? [])].sort()) {
        const target = watch.childPath(s.cwd, f);
        const save = el("button", { type: "button", class: "btn tonal small" }, "Save");
        save.onclick = () => act(save, "Download", () => watch.saveOne(target));
        entries.append(el("li", { class: "file" }, el("span", { class: "row-main" }, el("b", { class: "row-title mono" }, f)), save));
      }
      if (!entries.children.length) entries.append(el("li", { class: "empty" }, "This folder is empty."));
      // The watch's own files: for the curious and for troubleshooting, folded on every device.
      const browser = [crumbs, entries, el("label", { class: "check" }, force, "Download files again even if I have them")];
      const here2 = el("button", { type: "button", class: "btn tonal small" }, "Back up this folder");
      here2.onclick = () => act(here2, "Backup", async () => void (await watch.backup(s.cwd, force.checked)));
      parts.push(el("details", { class: "more", open: advancedOpen }, el("summary", { onclick: () => (advancedOpen = !advancedOpen) }, "Advanced: browse the watch's files"), ...browser, el("div", { class: "row" }, here2)));
    } else {
      parts.push(
        isNative
          ? el(
              "ol",
              { class: "steps" },
              el("li", {}, el("b", {}, "Already paired with this phone? "), "Then there's nothing to set up. Tartan uses the pairing the Suunto app made, so no code and no re-pairing."),
              el("li", {}, el("b", {}, "Keep it close and awake. "), "If the Suunto app is syncing the watch right now, let it finish first."),
              el("li", {}, el("b", {}, "Never paired? "), "Open Settings → Connectivity on the watch, tap Connect watch here and type the code the watch shows."),
            )
          : el(
              "ol",
              { class: "steps" },
              el("li", {}, el("b", {}, "Free the watch. "), "Turn the phone's Bluetooth off or force-stop the Suunto app; the watch talks to one device at a time."),
              el("li", {}, el("b", {}, "Wake it. "), "Open Settings → Connectivity on the watch so it advertises."),
              el("li", {}, el("b", {}, "Pair once. "), "Type the 6-digit code the watch shows. The watch keeps one pairing, so the Suunto app will need to pair again afterwards."),
            ),
      );
      if (!isNative) {
        const chunk = el("select", { "aria-label": "Bluetooth write size" }, ...[20, 60, 124, 244].map((n) => el("option", { value: String(n), selected: watch.watchOptions.chunkSize === n }, n === 20 ? "20 bytes (always works)" : `${n} bytes`)));
        chunk.onchange = () => (watch.watchOptions.chunkSize = Number(chunk.value));
        const allDev = el("input", { type: "checkbox", checked: watch.watchOptions.acceptAll });
        allDev.onchange = () => (watch.watchOptions.acceptAll = allDev.checked);
        parts.push(el("details", { class: "more" }, el("summary", {}, "Connection options"), el("label", { class: "field" }, el("span", {}, "Bluetooth write size"), chunk), el("label", { class: "check" }, allDev, "List every Bluetooth device in the picker")));
      }
    }
    parts.push(savedFiles());
    sec.replaceChildren(...parts.filter((p): p is Node => !!p));
  };
  unsubscribe = watch.onWatch(render);
  return sec;
}

function savedFiles(): HTMLElement {
  const box = el("details", { class: "more" }, el("summary", {}, deviceMode ? "Saved on this phone" : "Saved on this computer"));
  box.addEventListener("toggle", async () => {
    if (!box.open || box.querySelector(".table-wrap, .empty")) return;
    const watches = await local.watches().catch(() => []);
    const files = (await Promise.all(watches.map(async (w) => (await local.files(w.id).catch(() => [])).map((f) => ({ w, f }))))).flat();
    if (!files.length) {
      box.append(el("p", { class: "empty" }, "Nothing copied yet. Connect the watch and back it up; files you already have are skipped next time."));
      return;
    }
    box.append(
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "File"), el("th", { scope: "col" }, "Type"), el("th", { scope: "col", class: "num" }, "Size"), el("th", { scope: "col" }, el("span", { class: "sr" }, "Download")))),
          el("tbody", {}, ...files.map(({ w, f }) => el("tr", {}, el("td", { class: "mono" }, `${w.info.name ?? w.id}${f.path}`), el("td", {}, f.kind), el("td", { class: "num" }, fmtBytes(f.bytes)), el("td", { class: "num" }, deviceMode ? "" : el("a", { href: local.fileUrl(w.id, f.path) }, "Download"))))),
        ),
      ),
    );
  });
  return box;
}

// ------------------------------------------------------------------ strava

async function stravaSection(): Promise<HTMLElement> {
  const sec = el("section", { class: "group-card" });
  const head = (sub: string) => el("div", { class: "card-head" }, el("div", {}, el("h2", {}, el("span", { class: "lane-dot", style: "--c:var(--lane-strava-ui)" }), "Strava"), el("p", { class: "sub" }, sub)));
  const st = await stravaStatus();
  const params = new URLSearchParams(location.search);
  if (params.get("strava") === "connected") {
    notify("Strava is connected. Downloading your workouts…");
    void autoSync(true);
  }
  else if (params.get("strava") === "denied") notify("Strava access was not granted.", "error");
  else if (params.get("strava") === "error") notify(`Strava connection failed: ${params.get("message")}`, "error");
  if (params.has("strava")) {
    for (const k of ["strava", "message"]) params.delete(k);
    history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
  }

  if (st?.connected) {
    const name = `${st.athlete?.firstname ?? ""} ${st.athlete?.lastname ?? ""}`.trim();
    // What a sync did, line by line: there if you want it, folded otherwise.
    const out = el("pre", { class: "log" });
    const outBox = el("details", { class: "more" }, el("summary", {}, "What the last sync did"), out);
    outBox.hidden = true;
    const sync = el("button", { type: "button", class: "btn tonal" }, icon("sync"), "Sync now");
    const full = el("button", { type: "button", class: "btn text" }, "Fetch full history again");
    const run = (b: HTMLButtonElement, isFull: boolean) =>
      act(b, "Strava sync", async () => {
        outBox.hidden = false;
        out.textContent = "";
        await stravaSync(isFull, (line) => {
          out.textContent += `${line}\n`;
          out.scrollTop = out.scrollHeight;
        });
      });
    sync.onclick = () => run(sync, false);
    full.onclick = () => run(full, true);
    const detailed = st.activities - (st.pendingDetails ?? 0);
    const bar = el("progress", { max: Math.max(1, st.activities), value: detailed });
    // Connected before uploads existed: one more consent adds upload permission.
    const allow = el("button", { type: "button", class: "btn filled" }, icon("up"), "Allow uploads");
    allow.onclick = () =>
      act(allow, "Strava", async () => {
        const res = await app.api.request("/api/strava/connect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const body = (await res.json()) as { authorizeUrl?: string; error?: string };
        if (!body.authorizeUrl) throw new Error(body.error ?? "could not start");
        await openStravaConsent(body.authorizeUrl);
      });
    const uploads = st.can_upload
      ? null
      : el("div", { class: "callout" }, el("p", {}, icon("info", "ic sm"), "To send runs you record on the phone to Strava, Tartan needs Strava's OK to upload."), el("div", { class: "row" }, allow));
    sec.append(
      head(`Connected${name ? ` as ${name}` : ""} · syncs by itself · last ${st.lastSync ? `${hhmm(new Date(st.lastSync))}, ${ago(new Date(st.lastSync))}` : "never"}`),
      el("div", { class: "row" }, sync, full),
      uploads ?? "",
      el("div", { class: "detail-progress" }, el("p", {}, el("b", {}, `${detailed} of ${st.activities}`), " activities have full detail (laps, splits, time series)."), bar),
      st.stoppedForRateLimit ? el("p", { class: "callout" }, icon("info", "ic sm"), "Paused at Strava's rate limit (about 100 requests per 15 minutes). Sync again later; it continues where it stopped.") : "",
      outBox,
    );
    return sec;
  }
  const id = el("input", { name: "clientId", inputmode: "numeric", autocomplete: "off", required: true, value: st?.clientId ?? "" });
  const secret = el("input", { name: "clientSecret", type: "password", autocomplete: "off", required: !st?.configured });
  const err = el("p", { class: "field-error" });
  err.hidden = true;
  const go = el("button", { type: "submit", class: "btn filled" }, "Connect Strava");
  // If the sign-in tab doesn't open (or you'd rather use another browser): the same link, to copy.
  const handoff = el("div", { class: "callout" });
  handoff.hidden = true;
  // A friend setting this up has never seen Strava's API page: what to press, what to type where.
  const copy = (text: string) => {
    const b = el("button", { type: "button", class: "btn text small copy-btn", "aria-label": `Copy ${text}` }, "Copy");
    b.onclick = () =>
      void navigator.clipboard.writeText(text).then(
        () => {
          b.textContent = "Copied";
          setTimeout(() => (b.textContent = "Copy"), 1600);
        },
        () => notify("Copy failed: type it in by hand.", "error"),
      );
    return b;
  };
  const fill = (label: string, value: string, note?: string) => el("div", { class: "fill-row" }, el("dt", {}, label), el("dd", {}, el("code", {}, value), note ? el("span", { class: "sub" }, ` ${note}`) : null, note ? null : copy(value)));
  // Pasted with a stray space or line break, or only half of it: say so before Strava does.
  const check = () => {
    id.value = id.value.replace(/\s+/g, "");
    secret.value = secret.value.replace(/\s+/g, "");
    const bad = id.value && !/^\d{3,10}$/.test(id.value) ? "The Client ID is a number, like 123456." : secret.value && !/^[0-9a-f]{40}$/i.test(secret.value) ? "The Client Secret is 40 letters and digits. Check it was copied whole." : "";
    err.replaceChildren(...(bad ? [icon("warn", "ic sm"), bad] : []));
    err.hidden = !bad;
  };
  id.addEventListener("change", check);
  secret.addEventListener("change", check);
  const form = el(
    "form",
    { class: "setup" },
    el("p", { class: "sub" }, "About 5 minutes, once. Strava lets each person connect their own apps, so Tartan uses yours."),
    el(
      "ol",
      { class: "steps" },
      el(
        "li",
        {},
        el("b", {}, "Create your API application on Strava. "),
        "Sign in, then fill in the form like this (other fields can be anything):",
        el("dl", { class: "fill" }, fill("Application name", "Tartan", "or anything you like"), fill("Website", "http://localhost"), fill("Authorization Callback Domain", "localhost")),
        el("div", { class: "row" }, el("a", { class: "btn tonal small", href: "https://www.strava.com/settings/api", target: "_blank", rel: "noopener" }, "Open Strava's API page")),
      ),
      el("li", {}, el("b", {}, "Copy its Client ID and Client Secret here. "), `They stay on this ${deviceMode ? "phone" : "computer"}.`),
      el("li", {}, isNative ? "Connect, sign in to Strava in the browser tab that opens and approve read access. You come straight back here. A long history takes a few rounds because of Strava's rate limit." : "Connect and approve read access. A long history takes a few rounds because of Strava's rate limit."),
    ),
    el("div", { class: "grid-fields" }, el("label", { class: "field" }, el("span", {}, "Client ID"), id), el("label", { class: "field" }, el("span", {}, "Client Secret"), secret)),
    err,
    el("div", { class: "row" }, go),
    handoff,
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    check();
    if (!err.hidden) return;
    void act(go, "Strava", async () => {
      const res = await app.api.request("/api/strava/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: id.value, clientSecret: secret.value }) });
      const body = (await res.json()) as { authorizeUrl?: string; error?: string };
      if (!body.authorizeUrl) {
        err.replaceChildren(icon("warn", "ic sm"), body.error ?? "Could not start the Strava connection.");
        err.hidden = false;
        return;
      }
      if (isNative) showHandoff(handoff, body.authorizeUrl);
      await openStravaConsent(body.authorizeUrl);
    });
  };
  sec.append(head("Your watch already syncs every workout there"), form);
  return sec;
}

function showHandoff(box: HTMLElement, url: string): void {
  const copy = el("button", { type: "button", class: "btn tonal small" }, "Copy link");
  copy.onclick = () =>
    void navigator.clipboard.writeText(url).then(
      () => notify("Sign-in link copied. Paste it into any browser on this phone; Strava sends you back here."),
      () => notify("Copy failed: press and hold the link to copy it.", "error"),
    );
  box.replaceChildren(
    el("p", {}, icon("info", "ic sm"), "Sign-in didn't open, or want another browser? Open this link on this phone. It works once, within the hour."),
    el("p", { class: "mono", style: "word-break:break-all;user-select:all" }, url),
    el("div", { class: "row" }, copy),
  );
  box.hidden = false;
}

// ------------------------------------------------------------------ phone ↔ PC

function linkSection(): HTMLElement {
  return deviceMode ? phoneLinkCard() : pcPairCard();
}

