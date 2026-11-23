/** Record: a run with the phone's GPS, then keep it and send it to Strava. */
import { track } from "../../src/recording.ts";
import type { RecordingSummary } from "../../src/recording.ts";
import { dateShort, el, fmtClock, hhmm, icon, num } from "../lib/dom.ts";
import * as rec from "../recorder.ts";
import { act, app, hooks, isNative, notify } from "../state.ts";
import { stravaStatus } from "../sync.ts";
import { largeTitle } from "./today.ts";

let unsubscribe: (() => void) | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

const pace = (mps: number) => {
  if (!(mps > 0.3)) return "–:––";
  const s = Math.round(1000 / mps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export async function renderRecord(root: HTMLElement): Promise<void> {
  unsubscribe?.();
  if (ticker) clearInterval(ticker);
  const panel = el("section", { class: "card record-panel", "aria-live": "off" });
  const past = el("section", { class: "card list-card" });
  root.replaceChildren(largeTitle("Record", "A run with your phone's GPS"), panel, past);

  const draw = (s: rec.RecState) => {
    if (!root.isConnected) return;
    panel.replaceChildren(...content(s).filter((n): n is Node => !!n));
  };
  unsubscribe = rec.onRecorder(draw);
  // The clock moves even when no GPS fix arrives.
  ticker = setInterval(() => {
    if (!root.isConnected) {
      if (ticker) clearInterval(ticker);
      unsubscribe?.();
      return;
    }
    const s = rec.getRecorder();
    if (s.status === "recording") draw(s);
  }, 1000);
  await drawPast(past);
}

function content(s: rec.RecState): Array<Node | null> {
  const r = s.rec;
  const now = Date.now();
  const start = r ? Date.parse(r.start) : now;
  const end = r?.end ? Date.parse(r.end) : now;
  const pausedMs = r?.pauses.reduce((n, p) => n + ((p.to ?? end) - p.from), 0) ?? 0;
  const moving = r ? Math.max(0, Math.round((end - start - pausedMs) / 1000)) : 0;
  const dist = s.summary?.distance_m ?? 0;
  // Current pace over the last ~30 s of good fixes.
  const tr = r ? track(r) : [];
  const recent = tr.filter((p) => p.t >= (tr.at(-1)?.t ?? 0) - 30_000);
  const cur = recent.length > 1 ? (recent.at(-1)!.d - recent[0]!.d) / ((recent.at(-1)!.t - recent[0]!.t) / 1000) : 0;
  const gps =
    s.gpsError ? el("p", { class: "gps bad" }, icon("warn", "ic sm"), s.gpsError)
    : s.accuracy === undefined ? (s.status === "idle" ? null : el("p", { class: "gps" }, el("span", { class: "spinner", "aria-hidden": "true" }), "Finding GPS…"))
    : el("p", { class: `gps ${s.accuracy <= 15 ? "good" : s.accuracy <= 35 ? "ok" : "bad"}` }, icon("pin", "ic sm"), s.accuracy <= 15 ? `GPS good (±${s.accuracy} m)` : s.accuracy <= 35 ? `GPS fair (±${s.accuracy} m)` : `Weak GPS (±${s.accuracy} m): distance waits for a better fix`);
  const hrBtn = el("button", { type: "button", class: "btn tonal small" }, icon("heart", "ic sm"), s.hr ? `${s.hr.name}` : "Connect heart rate");
  hrBtn.onclick = () => act(hrBtn, "Heart rate", () => rec.connectHeartRate());
  const stat = (label: string, value: string, unit = "", big = false) => el("div", { class: `rstat${big ? " big" : ""}` }, el("dt", {}, label), el("dd", {}, value, unit ? el("small", {}, ` ${unit}`) : ""));

  if (s.status === "finished" && r) return finished(s);
  const stats = el(
    "dl",
    { class: "rstats" },
    stat("Time", fmtClock(moving), "", true),
    stat("Distance", num(dist / 1000, 2), "km", true),
    stat("Avg pace", pace(moving ? dist / moving : 0), "/km"),
    stat("Pace now", s.status === "recording" ? pace(cur) : "–:––", "/km"),
    stat("Heart rate", s.hr?.bpm ? String(s.hr.bpm) : "–", s.hr?.bpm ? "bpm" : ""),
  );
  const startBtn = el("button", { type: "button", class: "btn filled big-btn" }, icon("play"), "Start run");
  startBtn.onclick = () => act(startBtn, "Recording", () => rec.start());
  const pauseBtn = el("button", { type: "button", class: "btn tonal big-btn" }, icon("pause"), "Pause");
  pauseBtn.onclick = () => rec.pause();
  const resumeBtn = el("button", { type: "button", class: "btn filled big-btn" }, icon("play"), "Resume");
  resumeBtn.onclick = () => rec.resume();
  const finishBtn = el("button", { type: "button", class: "btn tonal big-btn" }, icon("stop"), "Finish");
  finishBtn.onclick = () => act(finishBtn, "Finishing", () => rec.finish());
  const controls =
    s.status === "idle" ? [startBtn]
    : s.status === "recording" ? [pauseBtn, finishBtn]
    : [resumeBtn, finishBtn];
  return [
    s.status === "paused" ? el("p", { class: "status-line paused" }, icon("pause", "ic sm"), "Paused") : s.status === "recording" ? el("p", { class: "status-line live" }, el("i", { "aria-hidden": "true" }), "Recording") : el("p", { class: "status-line" }, "Ready to record"),
    s.guide && s.status !== "idle" ? guideCard(s.guide, s.status === "recording") : null,
    stats,
    gps,
    el("div", { class: "row record-controls" }, ...controls),
    el("div", { class: "row record-extras" }, hrBtn, voiceSwitch()),
    s.status === "idle"
      ? el(
          "p",
          { class: "footnote" },
          isNative
            ? "Keeps recording with the screen off; Android shows a notification while it does. Heart rate comes from any Bluetooth heart-rate sensor: a chest strap, or a watch that shares its heart rate."
            : "Recording uses this browser's location; keep the page open.",
        )
      : null,
  ];
}

/** Spoken kilometre cues on or off, right where the run is started. */
function voiceSwitch(): HTMLElement {
  const sw = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(rec.cuesOn()), "aria-label": "Spoken cues: each kilometre, and each step of a guided run" }, el("i"));
  sw.onclick = () => {
    const on = !rec.cuesOn();
    rec.setCues(on);
    sw.setAttribute("aria-checked", String(on));
  };
  return el("label", { class: "voice-switch" }, el("span", {}, "Voice cues"), sw);
}

/** A guided run's step (src/workout/guided.ts): what it is, what's left, what's next, and Next step. */
function guideCard(g: NonNullable<rec.RecState["guide"]>, live: boolean): HTMLElement {
  const left = g.left_s !== undefined ? `${fmtClock(g.left_s)} left` : g.left_m !== undefined ? `${g.left_m} m left` : "";
  const next = el("button", { type: "button", class: "btn tonal small" }, "Next step");
  next.onclick = () => rec.nextStep();
  return el(
    "section",
    { class: `guide-step k-${g.kind}`, "aria-live": "polite" },
    el("p", { class: "sub" }, g.done ? g.name : `${g.name} · step ${g.index + 1} of ${g.total}`),
    el("h2", {}, g.label),
    el("p", {}, [g.detail, g.done ? "" : left].filter(Boolean).join(" · ")),
    el("div", { class: "guide-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(g.share * 100)) }, el("i", { style: `width:${Math.round(g.share * 100)}%` })),
    g.next ? el("p", { class: "sub" }, `Then: ${g.next}`) : null,
    !g.done && live ? next : null,
  );
}

function finished(s: rec.RecState): Node[] {
  const sum = s.summary!;
  const name = el("input", { type: "text", value: s.rec?.name ?? "", "aria-label": "Name", maxlength: "80" });
  const up = el("input", { type: "checkbox", checked: true });
  const save = el("button", { type: "button", class: "btn filled" }, icon("check"), "Save");
  const drop = el("button", { type: "button", class: "btn text" }, "Discard");
  save.onclick = () =>
    act(save, "Saving", async () => {
      const id = await rec.keep(name.value);
      if (!id) return;
      notify("Run saved.");
      hooks.refresh();
      if (up.checked) await upload(id);
    });
  drop.onclick = () =>
    act(drop, "Discard", async () => {
      if (!confirm("Discard this run? It won't be saved anywhere.")) return;
      await rec.discard();
    });
  return [
    el("p", { class: "status-line" }, icon("check", "ic sm"), "Finished"),
    el(
      "dl",
      { class: "rstats" },
      el("div", { class: "rstat big" }, el("dt", {}, "Time"), el("dd", {}, fmtClock(sum.moving_s))),
      el("div", { class: "rstat big" }, el("dt", {}, "Distance"), el("dd", {}, num(sum.distance_m / 1000, 2), el("small", {}, " km"))),
      el("div", { class: "rstat" }, el("dt", {}, "Avg pace"), el("dd", {}, pace(sum.moving_s ? sum.distance_m / sum.moving_s : 0), el("small", {}, " /km"))),
      el("div", { class: "rstat" }, el("dt", {}, "Climb"), el("dd", {}, num(sum.elevation_m), el("small", {}, " m"))),
      el("div", { class: "rstat" }, el("dt", {}, "Avg heart rate"), el("dd", {}, sum.avg_hr ? String(sum.avg_hr) : "–", sum.avg_hr ? el("small", {}, " bpm") : "")),
    ),
    el("label", { class: "field" }, el("span", {}, "Name"), name),
    el("label", { class: "check" }, up, "Send to Strava"),
    el("div", { class: "row" }, save, drop),
  ];
}

async function upload(id: string): Promise<void> {
  const st = await stravaStatus();
  if (!st?.connected) return notify("Saved on the phone. Connect Strava in Settings to send it there.");
  if (!st.can_upload) {
    notify("Saved. Strava needs your OK for uploads: in Settings, tap Allow uploads, then send it from Record.", "error");
    return;
  }
  notify("Sending to Strava…");
  const res = await app.api.request(`/api/recordings/${id}/upload`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string; activity_id?: number };
  if (body.status === "done") notify("On Strava now. It joins your library with the next sync, as one workout.");
  else notify(`Strava upload failed: ${body.error ?? res.status}`, "error");
  const past = document.querySelector<HTMLElement>("[data-past]");
  if (past) await drawPast(past);
}

async function drawPast(box: HTMLElement): Promise<void> {
  box.dataset.past = "";
  const list = await app.api.json<RecordingSummary[]>("/api/recordings").catch(() => []);
  const done = list.filter((r) => r.end);
  box.replaceChildren(el("div", { class: "card-head" }, el("h2", {}, "Recorded on this phone")));
  if (!done.length) {
    box.append(el("p", { class: "empty" }, "Runs you record here appear in Activities too, and on Strava once sent."));
    return;
  }
  const rows = el("ul", { class: "rows" });
  for (const r of done.slice(0, 20)) {
    const d = new Date(r.start);
    const status =
      r.strava?.status === "done" ? el("span", { class: "effort-pill effort-easy" }, "On Strava")
      : r.strava?.status === "error" ? el("span", { class: "effort-pill effort-hard", title: r.strava.error ?? "" }, "Upload failed")
      : null;
    const send = el("button", { type: "button", class: "btn tonal small" }, r.strava?.status === "error" ? "Try again" : "Send to Strava");
    send.onclick = () => act(send, "Strava upload", () => upload(r.id));
    rows.append(
      el(
        "li",
        { class: "rec-row" },
        el("span", { class: "row-main" }, el("b", { class: "row-title" }, r.name ?? "Run"), el("span", { class: "row-sub" }, `${dateShort(d)} · ${hhmm(d)} · ${num(r.distance_m / 1000, 2)} km · ${fmtClock(r.moving_s)}`)),
        status ?? send,
      ),
    );
  }
  box.append(rows);
}
