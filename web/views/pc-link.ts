/**
 * Phone and PC as one (src/link.ts, src/transfer.ts). On the phone: pair with the PC (its address
 * and the code it shows), copy everything over with progress, and then the link in Settings (sync
 * now, copy again, unpair). On the PC: Pair a phone (the code, the address) and the phones paired.
 * Everything between the two goes end to end encrypted.
 */
import qrcode from "qrcode-generator";
import { findPc, isHomeAddress, pairWith, type Link } from "../../src/link.ts";
import { normUrl, openPairLink, pairPhone, parsePairQr, phoneName, reopen, setWebPairSheet, summary, syncBoth as syncBothLib, type Synced } from "../lib/pairing.ts";
import { el, fmtBytes, icon } from "../lib/dom.ts";
import { success } from "../lib/haptics.ts";
import { act, app, hooks, notify, readNdjson } from "../state.ts";
import { syncMemory } from "../sync.ts";
import { dragToClose } from "./detail.ts";
import { scanQr } from "../lib/qr-scan.ts";
import { LOCAL_NETWORK_DENIED, localNetwork } from "../lib/local-network.ts";



/** A QR code as SVG (dark on white, whatever the theme: cameras want contrast). */
function qr(text: string, label: string): HTMLElement {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const box = el("div", { class: "pair-qr", role: "img", "aria-label": label });
  box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return box;
}


/** The pairing form: the PC's address and the code it shows. */
export function pairForm(paired: (link: Link) => void): HTMLElement {
  const url = el("input", { placeholder: "192.168.1.20:5173", inputmode: "url", autocomplete: "off", autocapitalize: "off", spellcheck: false, value: app.link?.url.replace(/^http:\/\//, "") ?? "" });
  const code = el("input", { placeholder: "K7QM3-XPA9R", autocomplete: "one-time-code", autocapitalize: "characters", spellcheck: false, maxlength: "13", class: "pair-code" });
  const go = el("button", { type: "submit", class: "btn filled" }, icon("phone", "ic sm"), "Connect");
  const scan = el("button", { type: "button", class: "btn filled pair-scan" }, icon("locate", "ic sm"), "Scan the code on your PC");
  const form = el(
    "form",
    { class: "pair-form" },
    el("ol", { class: "pair-steps" },
      el("li", {}, "On your PC, start Tartan with ", el("code", {}, "bun src/cli.ts serve --lan"), " and open it at ", el("code", {}, "localhost:5173"), "."),
      el("li", {}, "Settings → More → Phone app → ", el("b", {}, "Pair a phone"), "."),
      el("li", {}, "Scan its QR code here, or type the address and code."),
    ),
    scan,
    el("p", { class: "pair-or sub" }, "or type them"),
    el("label", { class: "field" }, el("span", {}, "PC address"), url),
    el("label", { class: "field" }, el("span", {}, "Code"), code),
    el("div", { class: "row" }, go),
    el("p", { class: "footnote" }, icon("check", "ic xs"), " End to end encrypted: your data, health and keys travel sealed with a key only your phone and your PC hold."),
  );
  scan.onclick = () =>
    void scanQr("Point at the QR code on your PC").then((text) => {
      const p = text ? parsePairQr(text) : null;
      if (text && !p) notify("That's not Tartan's pairing code. On the PC: Settings → More → Phone app → Pair a phone.", "error");
      if (!p) return;
      // Every address the PC has: the form tries them all.
      url.value = p.urls.map((x) => x.replace(/^http:\/\//, "")).join(" ");
      code.value = p.code;
      form.requestSubmit();
    });
  form.onsubmit = (e) => {
    e.preventDefault();
    void act(go, "Pairing", async () => {
      const link = await pairPhone(url.value, code.value);
      success();
      paired(link);
    });
  };
  return form;
}





/**
 * The phone opened from the PC's QR code (tartan://localhost/pair?url=…&code=…), or the in-app
 * scanner: pair, then copy everything from the PC, or send this phone's data to it. A link can
 * come from anywhere, so one that opened Tartan (`ask`), or one that would replace the PC this
 * phone is paired with, asks first; only addresses on the home network are tried (isHomeAddress).
 */

/** Bring both up to date, with the progress in `box`. */
export async function syncBoth(box: HTMLElement): Promise<Synced> {
  const bar = el("i", { style: "--p:0%" });
  const line = el("p", { class: "sub" }, "Comparing with your PC…");
  box.replaceChildren(el("div", { class: "copy-bar", role: "progressbar", "aria-label": "Bringing this phone and your PC up to date" }, bar), line);
  return syncBothLib((p) => {
    bar.style.setProperty("--p", `${p.pct.toFixed(1)}%`);
    line.textContent = p.line;
  });
}
export { openPairLink, pairPhone, parsePairQr, summary, type Synced };

function pairSheet(list: string[], code: string, ask: boolean): void {
  document.querySelector("dialog.pair-sheet")?.remove();
  const dialog = el("dialog", { class: "sheet pair-sheet", "aria-labelledby": "pair-title" });
  const close = () => dialog.open && (dialog.classList.add("closing"), setTimeout(() => dialog.close(), 240));
  dialog.addEventListener("close", () => dialog.remove());
  const title = el("h2", { id: "pair-title" }, "Pairing with your PC");
  const sub = el("p", { class: "sub" }, list.map((u) => u.replace(/^https?:\/\//, "")).join(" · "));
  const step = el("span", {}, "Looking for your PC on this Wi-Fi…");
  const body = el("div", { class: "pair-sheet-body" });
  dialog.append(el("div", { class: "sheet-body" }, el("div", { class: "grabber", "aria-hidden": "true" }), el("header", { class: "ex-head" }, el("div", {}, title, sub), el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))), body));
  document.body.append(dialog);
  dragToClose(dialog);
  dialog.showModal();
  const home = list.filter(isHomeAddress);
  if (!home.length) {
    title.textContent = "Not your PC";
    body.replaceChildren(el("p", {}, "This pairing link points outside your home network, so Tartan won't use it."), el("p", { class: "sub" }, "Pair only with the code your own PC shows: Settings → More → Phone app → Pair a phone."));
    return;
  }
  const replacing = app.link && !home.some((u) => u.replace(/\/$/, "") === app.link!.url.replace(/\/$/, ""));
  if (!ask && !replacing) return pair(home);
  title.textContent = replacing ? "Pair with a different PC?" : "Pair with this PC?";
  const yes = el("button", { type: "button", class: "btn filled" }, icon("phone", "ic sm"), "Pair");
  const no = el("button", { type: "button", class: "btn text" }, "Cancel");
  yes.onclick = () => pair(home);
  no.onclick = close;
  body.replaceChildren(
    el("p", {}, "Pair only if you just scanned the code on your own PC. This phone and that PC then share everything: workouts, health, plans and keys, end to end encrypted."),
    ...(replacing ? [el("p", { class: "sub" }, `This replaces the pairing with ${app.link!.name ?? app.link!.url.replace(/^https?:\/\//, "")}.`)] : []),
    el("div", { class: "row" }, yes, no),
  );
  yes.focus();

  function pair(where: string[]): void {
    title.textContent = "Pairing with your PC";
    body.replaceChildren(el("p", { class: "status-line live" }, el("i", { "aria-hidden": "true" }), step));
    void localNetwork(true)
      .then((ok) => {
        if (!ok) throw new Error(LOCAL_NETWORK_DENIED);
        return findPc(where);
      })
      .then((url) => {
        sub.textContent = url.replace(/^http:\/\//, "");
        step.textContent = "Connecting, end to end encrypted…";
        return pairWith(url, code, phoneName());
      })
      .then((link) => {
        app.setLink(link);
        success();
        title.textContent = `Paired with ${link.name ?? "your PC"}`;
        const progress = el("div", { class: "copy-box" });
        body.replaceChildren(el("p", {}, "Bringing this phone and your PC up to date: whatever one has goes to the other, the newer copy wins."), progress);
        void syncBoth(progress)
          .then((r) => {
            const done = el("button", { type: "button", class: "btn filled" }, r.pulled || r.changed ? "Open Tartan" : "Done");
            done.onclick = () => (r.pulled || r.changed ? reopen() : close());
            body.append(el("div", { class: "row" }, done));
          })
          .catch((e: Error) => body.append(el("p", { class: "sub" }, `Stopped: ${e.message}. Sync now in Settings → More carries on.`)));
      })
      .catch((e: Error) => {
        title.textContent = "Couldn't pair";
        body.replaceChildren(el("p", {}, e.message), el("p", { class: "sub" }, "Fix that, show a new code on the PC and scan again."));
      });
  }
}

/** Settings on the phone: the paired PC, or pairing. */
export function phoneLinkCard(): HTMLElement {
  const sec = el("section", { class: "group-card pc-link" });
  const draw = () => {
    const link = app.link;
    const head = el("div", { class: "card-head" }, el("div", {}, el("h2", {}, icon("phone", "ic"), "Your PC"), el("p", { class: "sub" }, link ? `Paired with ${link.name ?? link.url} · end to end encrypted` : "Use Tartan on your PC and here as one: the same plan, coach, notes and lifts.")));
    if (!link) {
      sec.replaceChildren(head, pairForm(() => draw()));
      return;
    }
    const sync = el("button", { type: "button", class: "btn tonal" }, icon("sync", "ic sm"), "Sync now");
    const unpair = el("button", { type: "button", class: "btn text danger" }, "Unpair");
    const progress = el("div", { class: "copy-box" });
    sync.onclick = () =>
      void act(sync, "Syncing with your PC", async () => {
        const r = await syncBoth(progress);
        if (r.pulled || r.changed) hooks.refresh();
      });
    unpair.onclick = () => {
      app.setLink(null);
      notify("Unpaired. Your data stays on this phone; the PC can forget this phone in its Settings.");
      draw();
    };
    sec.replaceChildren(head, el("p", { class: "sub" }, `Both stay at the latest: the plan, lifts and morning checks on every sync, everything else (workouts, routes, backups, settings) every few hours and when you tap Sync now. Address ${link.url}.`), el("div", { class: "row" }, sync, unpair), progress);
  };
  draw();
  return sec;
}

/**
 * On the PC: pair a phone. The code and a QR code (the camera opens Tartan on the phone with both
 * filled in, through this PC's /pair page), for 10 minutes; then the phones paired, to forget.
 * `auto`: show the code at once (the intro's "I use Tartan on my phone").
 */
export function pcPairCard(auto = false): HTMLElement {
  const sec = el("section", { class: "group-card pc-link" });
  const head = el("div", { class: "card-head" }, el("div", {}, el("h2", {}, icon("phone", "ic"), "Phone app"), el("p", { class: "sub" }, "Pair the Android app with this PC: they copy each other's data and keep in step, end to end encrypted.")));
  const pairBtn = el("button", { type: "button", class: "btn filled" }, icon("phone", "ic sm"), "Pair a phone");
  const shown = el("div", { class: "pair-show", hidden: true });
  const list = el("ul", { class: "rows paired" });
  const note = el("p", { class: "sub" }, "");
  let timer: ReturnType<typeof setInterval> | null = null;
  let known = -1;
  const listDevices = () =>
    void app.api
      .json<Array<{ id: string; name: string; at: string }>>("/api/link/devices")
      .then((ds) => {
        // A phone just paired: say so where the code was.
        if (known >= 0 && ds.length > known && !shown.hidden) {
          shown.replaceChildren(el("p", { class: "pair-done" }, icon("check", "ic sm"), `Paired with ${ds.at(-1)!.name}. They're bringing each other up to date now.`));
          if (timer) clearInterval(timer);
        }
        known = ds.length;
        list.replaceChildren(
          ...ds.map((d) => {
            const forget = el("button", { type: "button", class: "btn text small danger" }, "Forget");
            forget.onclick = () =>
              void act(forget, "Forgetting", async () => {
                await app.api.request(`/api/link/devices?id=${encodeURIComponent(d.id)}`, { method: "DELETE" });
                listDevices();
              });
            return el("li", { class: "row spread" }, el("span", {}, el("b", {}, d.name), el("span", { class: "sub" }, ` · paired ${new Date(d.at).toLocaleDateString()}`)), forget);
          }),
        );
      })
      .catch(() => list.replaceChildren());
  const start = () =>
    act(pairBtn, "Pairing", async () => {
      const res = await app.api.request("/api/pair/start", { method: "POST" });
      const r = (await res.json().catch(() => ({}))) as { code: string; until: number; urls: string[]; error?: string };
      if (!res.ok) throw new Error(r.error ?? `The server answered ${res.status}`);
      const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.round(ms / 1000) % 60).padStart(2, "0")}`;
      const left = el("span", {}, mmss(r.until - Date.now()));
      const where = r.urls[0] ?? "";
      shown.replaceChildren(
        where ? qr(`tartan://localhost/pair?${r.urls.slice(0, 4).map((u) => `url=${encodeURIComponent(u)}`).join("&")}&code=${encodeURIComponent(r.code)}`, "QR code: scan it with Tartan on the phone to pair") : el("span"),
        el(
          "div",
          { class: "pair-text" },
          el("p", { class: "sub" }, "In Tartan on the phone: Scan the code on your PC (on the Hello page, or Settings → More → Your PC). Or type these:"),
          el("dl", { class: "facts" }, el("dt", {}, "Address"), el("dd", {}, r.urls.map((u) => u.replace(/^http:\/\//, "")).join("  or  ") || "no network found"), el("dt", {}, "Code"), el("dd", { class: "pair-big" }, r.code)),
          el("p", { class: "footnote" }, "Good for one phone, for ", left, "."),
        ),
      );
      shown.hidden = false;
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        const s = Math.round((r.until - Date.now()) / 1000);
        if (s <= 0 || !sec.isConnected) {
          clearInterval(timer!);
          shown.hidden = true;
          return;
        }
        left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        if (s % 3 === 0) listDevices();
      }, 1000);
    });
  pairBtn.onclick = () => void start();
  sec.append(head, note, el("div", { class: "row" }, pairBtn), shown, list);
  // Without --lan the phone can't reach this PC: say how, up front.
  void app.api
    .json<{ lan: boolean }>("/api/server")
    .then((info) => {
      if (!info.lan) {
        note.replaceChildren("To pair, restart Tartan on this PC with ", el("code", {}, "bun src/cli.ts serve --lan"), ", then open it here at localhost and press Pair a phone.");
        pairBtn.disabled = true;
      } else if (auto) void start();
    })
    .catch(() => {});
  listDevices();
  return sec;
}

setWebPairSheet(pairSheet);
