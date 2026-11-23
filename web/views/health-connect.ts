/**
 * Settings → Sources → Health Connect: what's shared (four switches), connect or allow what's
 * missing, share now, and stop (optionally removing what Tartan wrote). web/lib/health-connect.ts
 * does the work.
 */
import { ago, el, icon } from "../lib/dom.ts";
import { tick } from "../lib/haptics.ts";
import { connectHc, disconnectHc, hcGranted, hcStatus, openHcSettings, PERMISSIONS, readHc, syncHc, writeHc, type HcKind } from "../lib/health-connect.ts";
import { act, notify } from "../state.ts";

const KINDS: Array<{ kind: HcKind; title: string; line: string }> = [
  { kind: "workouts", title: "Workouts", line: "With heart rate, distance and route." },
  { kind: "vitals", title: "Heart rate and blood oxygen", line: "From the watch's log, with resting heart rate." },
  { kind: "activity", title: "Steps and active calories", line: "From the watch's log." },
  { kind: "sleep", title: "Sleep and HRV from other apps", line: "For the Body card on Today." },
];

export function healthConnectCard(): HTMLElement {
  const sec = el("section", { class: "card hc-card" });
  const head = () => el("div", { class: "card-head" }, el("h2", {}, icon("heart", "ic"), "Health Connect"));
  const intro = el("p", { class: "sub" }, "Share your workouts and your watch's heart rate, blood oxygen and steps with Android's Health Connect, for Google Fit and every app that reads it, and bring sleep and HRV back.");
  const draw = async () => {
    const status = await hcStatus();
    if (status === "web") {
      sec.replaceChildren(head(), intro, el("p", { class: "footnote" }, "In the Android app."));
      return;
    }
    if (status === "unavailable") {
      sec.replaceChildren(head(), intro, el("p", { class: "footnote" }, "Health Connect isn't available on this phone (it needs Android 9 or newer)."));
      return;
    }
    if (status === "update") {
      const get = el("button", { type: "button", class: "btn tonal" }, "Get Health Connect");
      get.onclick = () => void openHcSettings();
      sec.replaceChildren(head(), intro, el("p", { class: "sub" }, "Health Connect needs installing or updating first."), el("div", { class: "row" }, get));
      return;
    }
    const s = readHc();
    const granted = new Set(s.on ? await hcGranted() : []);
    const rows = KINDS.map(({ kind, title, line }) => {
      const missing = s.on && s.kinds[kind] && !PERMISSIONS[kind].filter((p) => !p.endsWith("ROUTE")).every((p) => granted.has(p));
      const sw = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(s.kinds[kind]), "aria-label": title }, el("i"));
      sw.onclick = () => {
        tick();
        const kinds = { ...readHc().kinds, [kind]: !s.kinds[kind] };
        writeHc({ ...readHc(), kinds });
        // Newly on while connected: ask for its access.
        if (s.on && kinds[kind]) void connectHc(kinds).finally(() => void draw());
        else void draw();
      };
      return el("div", { class: "switch-row" }, el("div", {}, el("h3", {}, title), el("p", { class: "sub" }, line), missing ? el("p", { class: "hc-missing" }, icon("warn", "ic sm"), "Not allowed in Health Connect yet") : null), sw);
    });
    const actions = el("div", { class: "row" });
    const status2 = el("p", { class: "footnote", "aria-live": "polite" });
    if (!s.on) {
      const go = el("button", { type: "button", class: "btn filled" }, "Connect");
      go.onclick = () =>
        act(go, "Health Connect", async () => {
          const got = await connectHc();
          if (!got.length) throw new Error("Nothing was allowed. Tap Connect again and allow what you want to share.");
          status2.textContent = "Connected. Sharing your last 30 days…";
          const last = await syncHc(true);
          notify(last?.error ? `Health Connect: ${last.error}` : `Health Connect: shared ${last?.written ?? 0} records.`, last?.error ? "error" : "info");
          await draw();
        });
      actions.append(go);
    } else {
      const now = el("button", { type: "button", class: "btn tonal" }, "Share now");
      now.onclick = () =>
        act(now, "Health Connect", async () => {
          const last = await syncHc(true);
          if (last?.error) throw new Error(last.error);
          await draw();
        });
      const allow = el("button", { type: "button", class: "btn text" }, "Manage access");
      allow.onclick = () => void openHcSettings();
      const stop = el("button", { type: "button", class: "btn text" }, "Stop sharing");
      stop.onclick = () =>
        act(stop, "Health Connect", async () => {
          const remove = confirm("Also remove everything Tartan wrote to Health Connect? (Cancel keeps it there.)");
          await disconnectHc(remove);
          notify(remove ? "Stopped sharing, and removed Tartan's records from Health Connect." : "Stopped sharing with Health Connect.");
          await draw();
        });
      actions.append(now, allow, stop);
      const l = s.last;
      status2.textContent = l
        ? l.error
          ? `Last try ${ago(new Date(l.at))}: ${l.error}`
          : `Shared ${ago(new Date(l.at))}: ${l.written} records${l.covered ? `, ${l.covered} ${l.covered === 1 ? "workout was" : "workouts were"} already there from another app` : ""}${l.sleep ? `; ${l.sleep} nights of sleep read` : ""}. It shares again after each sync.`
        : "Not shared yet.";
    }
    sec.replaceChildren(head(), intro, el("div", { class: "hc-kinds" }, ...rows), actions, status2);
  };
  sec.append(head(), intro);
  void draw();
  return sec;
}
