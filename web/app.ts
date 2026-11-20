/** Shell: navigation, routing with view transitions, the collapsing title bar. */
import { brandMark, el, icon, page } from "./lib/dom.ts";
import { transition } from "./lib/motion.ts";
import { watchKeyboard } from "./lib/keyboard.ts";
import { enhanceSelects } from "./lib/picker.ts";
import { rubberBand } from "./lib/rubber.ts";
import { listenForReminderTaps, syncSchedule } from "./lib/schedule.ts";
import { tick } from "./lib/haptics.ts";
import { app, clearInfoNotice, deviceMode, hooks, isNative, log, notify } from "./state.ts";
import { autoSync, finishStravaReturn, listenForStravaReturn, syncAllNow } from "./sync.ts";
import type { Lane } from "./lib/lanes.ts";
import { BOARD, boardLanes, boardModel, followBoard } from "./lib/board.ts";
import { openBoard } from "./views/board.ts";
import { updateWidget } from "./lib/widget.ts";
import { openActivity } from "./views/detail.ts";
import { renderActivities } from "./views/activities.ts";
import { renderChat } from "./views/coach.ts";
import { maybeOnboard } from "./lib/intro.ts";
import "./views/onboard.ts";
import { renderCoachHome } from "./views/plan.ts";
import { renderRecord } from "./views/record.ts";
import { renderRouteEditor, renderRoutes } from "./views/routes.ts";
import { renderFaceEditor } from "./views/face.ts";
import * as recorder from "./recorder.ts";
import { renderSettings } from "./views/settings.ts";
import { renderToday } from "./views/today.ts";
import { renderTrends } from "./views/trends.ts";
import { renderYou } from "./views/you.ts";
import { renderLift } from "./views/lift.ts";
import { openPairLink } from "./views/pc-link.ts";
import { applyColours, applyMaterial } from "./lib/theme.ts";
import { shellBoard, shellParts, shellRoute, startShell, webUi } from "./lib/shell.ts";
import { openChat } from "./views/coach.ts";
import { openPlanSession } from "./views/plan.ts";
import { slideSelect } from "./lib/slide-select.ts";

const VIEWS = {
  today: { label: "Today", icon: "today", render: renderToday },
  // Not a tab (four is enough): your body, muscles from fresh to worked hard, sleep and the
  // watch's vitals; opened from Today's readiness card and from Progress.
  you: { label: "Body", icon: "body", render: renderYou },
  // Your plan and your coach in one tab; the conversation opens over it as #chat.
  coach: { label: "Coach", icon: "coach", render: renderCoachHome },
  activities: { label: "Activities", icon: "list", render: renderActivities },
  // Routes sit with Activities (a switch at the top of each), not in the bar.
  routes: { label: "Routes", icon: "route", render: renderRoutes },
  trends: { label: "Progress", icon: "trends", render: renderTrends },
  settings: { label: "Settings", icon: "settings", render: renderSettings },
  // Not tabs: Record opens from Today (and the top bar while recording); Chat from the Coach tab.
  record: { label: "Record", icon: "play", render: renderRecord },
  chat: { label: "Coach", icon: "coach", render: renderChat },
  // #route/<id> is the route editor, a full-screen map over the Routes tab.
  route: { label: "Route", icon: "route", render: renderRouteEditor },
  // #lift/<date> is a strength session as you lift it, from its session on Today or the plan.
  lift: { label: "Strength", icon: "bolt", render: renderLift },
  // #face/<id> is the face builder, opened from Settings → More → Advanced → Watch face builder.
  face: { label: "Face builder", icon: "watch", render: renderFaceEditor },
} as const;
type View = keyof typeof VIEWS;

const nav = document.getElementById("nav")!;
const viewEl = document.getElementById("view")!;
const topTitle = document.getElementById("topbar-title")!;
const topbar = document.getElementById("topbar")!;
const gear = document.getElementById("gear")!;
gear.append(icon("settings"));

nav.append(
  el("a", { class: "nav-brand", href: "#today", "aria-label": "Tartan, today" }, brandMark()),
  ...(Object.entries(VIEWS) as Array<[View, (typeof VIEWS)[View]]>).filter(([id]) => !["record", "chat", "route", "routes", "face", "lift", "you"].includes(id)).map(([id, v]) =>
    el("a", { href: `#${id}`, "data-tab": id, class: id === "settings" ? "nav-settings" : "" }, el("span", { class: "pill" }, icon(v.icon)), el("span", { class: "label" }, v.label)),
  ),
);


let current: View | null = null;
/** Native Settings draws every group (#sync, back from Strava's sign-in, is Sources). */
const nativeSettings = () => true;
const TAB_ORDER = ["today", "coach", "activities", "trends"];
/** Where a view sits in the bar (screens opened from a tab count as that tab). */
const tabIndex = (v: View | null) => (v === null ? -1 : TAB_ORDER.indexOf(v === "chat" ? "coach" : v === "route" || v === "routes" ? "activities" : v === "lift" || v === "you" ? "today" : v));
let renderToken = 0;

async function route(): Promise<void> {
  // #sync is where the old Sync tab lived (and where Strava sign-in returns to): it's in Settings now.
  // #plan was the Plan tab, now part of Coach.
  const raw = location.hash.slice(1);
  const hash = (raw === "sync" ? "settings" : raw === "plan" ? "coach" : raw).split("/")[0]!;
  const id = (hash in VIEWS ? hash : "today") as View;
  // Tartan 2: the native bar and screens follow (before the web paints, so they don't lag).
  shellRoute(id);
  const token = ++renderToken;
  // Tartan 2: with Today drawn natively over the page, the page's own Today stays empty, so
  // nothing of it shows for a moment as the native one comes and goes.
  const v =
    id === "today" && shellParts().today ? { ...VIEWS.today, render: async () => {} }
    : id === "chat" && shellParts().chat ? { ...VIEWS.chat, render: async () => {} }
    : id === "activities" && shellParts().activities ? { ...VIEWS.activities, render: async () => {} }
    : id === "trends" && shellParts().progress ? { ...VIEWS.trends, render: async () => {} }
    : id === "you" && shellParts().body ? { ...VIEWS.you, render: async () => {} }
    : (id === "routes" || id === "route") && shellParts().routes ? { ...VIEWS[id], render: async () => {} }
    : (id === "record" || id === "lift") && shellParts().record ? { ...VIEWS[id], render: async () => {} }
    : id === "face" && shellParts().settings ? { ...VIEWS.face, render: async () => {} }
    : id === "settings" && shellParts().settings && nativeSettings() ? { ...VIEWS.settings, render: async () => {} }
    : id === "coach" && shellParts().coach ? { ...VIEWS.coach, render: async () => {} }
    : VIEWS[id];
  for (const a of nav.querySelectorAll<HTMLAnchorElement>("[data-tab]")) {
    if (a.dataset.tab === (id === "chat" ? "coach" : id === "route" || id === "routes" ? "activities" : id === "lift" || id === "you" ? "today" : id)) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (id === "settings") gear.setAttribute("aria-current", "page");
  else gear.removeAttribute("aria-current");
  document.title = id === "today" ? "Tartan" : `${v.label} · Tartan`;
  let rendered: Promise<void> = Promise.resolve();
  const paint = async () => {
    const fresh = el("div", { class: "view-inner" });
    viewEl.replaceChildren(fresh);
    page().scrollTo({ top: 0, behavior: "instant" });
    rendered = (async () => {
      try {
        await v.render(fresh);
      } catch (e) {
        if (token === renderToken) {
          fresh.append(el("div", { class: "empty-card" }, el("h3", {}, "Couldn't load this"), el("p", {}, (e as Error).message)));
          log(`${v.label}: ${(e as Error).message}`);
        }
      }
      if (token === renderToken) watchTitle();
    })();
    // The transition freezes the old screen until this returns: don't make it wait for data.
    // What's drawn by now (last numbers, or skeletons) animates in; the rest fills in after.
    await Promise.race([rendered, new Promise((r) => setTimeout(r, 120))]);
  };
  // The route editor is a full-screen map: no top bar over it, and no stretch left on the content.
  stretch.reset();
  document.documentElement.classList.toggle("full-map", id === "route");
  // The sync board reads in full on Today; elsewhere it's just its lanes' dots, so titles keep the bar.
  document.documentElement.classList.toggle("board-full", id === "today");
  // Workouts ⇄ Routes is a switch within one tab: no slide between them.
  const sibling = (a: View | null, b: View) => a !== null && a !== b && ["activities", "routes"].includes(a) && ["activities", "routes"].includes(b);
  if (current === id || current === null || sibling(current, id)) await paint();
  else {
    // Between tabs the page slides the way the bar goes: to a tab on the right, in from the right.
    const a = tabIndex(current);
    const b = tabIndex(id);
    await transition(paint, a >= 0 && b >= 0 && a !== b ? (b > a ? "nav-next" : "nav-prev") : "nav");
  }
  const moved = current !== null && current !== id;
  current = id;
  await rendered;
  // A new screen: focus its title, so TalkBack says "Coach, heading" instead of staying on the tab.
  if (moved && token === renderToken) document.getElementById("view-title")?.focus({ preventScroll: true });
}

/** iOS-style: the large title scrolls away and its name appears in the translucent bar. */
let titleObserver: IntersectionObserver | null = null;
function watchTitle(): void {
  titleObserver?.disconnect();
  const h1 = document.getElementById("view-title");
  topTitle.textContent = h1?.textContent ?? "";
  topbar.classList.remove("scrolled");
  if (!h1) return;
  // Start from where the title actually is (a re-render can land mid-scroll), then follow it.
  topbar.classList.toggle("scrolled", h1.getBoundingClientRect().bottom < 60);
  titleObserver = new IntersectionObserver(([e]) => topbar.classList.toggle("scrolled", !e!.isIntersecting), { rootMargin: "-60px 0px 0px 0px" });
  titleObserver.observe(h1);
}

hooks.openActivity = (id, from) => void openActivity(id, from);
// The page's own screens take what the native ones ask for (on the PC; the phone has no web screens).
Object.assign(webUi, { openActivity: (id: string) => openActivity(id), openPlanSession, openChat });
/** New data arrived: redraw the screens that show it (not Settings or Coach mid-use). */
hooks.refresh = () => {
  // New workouts can tick sessions off: their reminders go.
  void syncSchedule();
  if (current === "today" || current === "you" || current === "activities" || current === "trends") void route();
};

/**
 * The sync board: the photo-finish timing board as a chip. One lane per source you have (Watch,
 * Strava), each with how long ago it last came in; a lane breathes while it syncs and turns
 * amber when its last round failed. Tapping opens the lanes in words, with Sync now / Try again.
 */
const conn = document.getElementById("conn") as HTMLButtonElement;
// Lanes are kept and updated in place, so a change of state (one syncing, both fine) moves
// rather than redraws: the merge into one dot and the split back are transitions.
const laneEls = new Map<Lane, HTMLElement>();
const offLane = el("span", { class: "lane", "data-state": "off" }, icon("plus", "ic"), el("b", {}, "Connect"));
const showBoard = () => {
  const model = boardModel();
  const kids = model.map((m) => {
    let lane = laneEls.get(m.id);
    if (!lane) {
      lane = el("span", { class: "lane", "data-lane": m.id }, el("i", { "aria-hidden": "true" }), icon(BOARD[m.id].icon, "ic"), el("b", {}));
      laneEls.set(m.id, lane);
    }
    lane.dataset.state = m.state;
    if (lane.dataset.icon !== m.glyph) {
      lane.querySelector("svg")!.replaceWith(icon(m.glyph, "ic"));
      lane.dataset.icon = m.glyph;
    }
    lane.querySelector("b")!.textContent = m.text;
    return lane;
  });
  const want = kids.length ? kids : [offLane];
  const now = [...conn.children];
  if (want.length !== now.length || want.some((k, i) => k !== now[i])) conn.replaceChildren(...want);
  conn.dataset.state = kids.length ? (model.some((m) => m.failed) ? "fail" : "ok") : "off";
  // Every source fine: in the compact chip their dots turn green and become one.
  conn.dataset.all = kids.length > 1 && model.every((m) => m.state === "ok" || m.state === "on") ? "ok" : "";
  conn.setAttribute("aria-label", kids.length ? `${model.map((m) => m.said).join(". ")}. Open sync details.` : "Nothing connected yet. Connect Strava or your watch.");
  // Tartan 2: native Today draws the same chip.
  shellBoard(model.map(({ id, state, text, glyph, name, status, failed }) => ({ id, state, text, glyph, name, status, failed })));
};
conn.onclick = () => {
  if (!boardLanes().length) {
    location.hash = "#settings/sources";
    return;
  }
  openBoard(boardLanes().map((id) => ({ id, ...BOARD[id] })));
};
followBoard(showBoard);

// While a run records, a chip in the top bar shows it and leads back to it from any screen.
const recChip = el("a", { class: "rec-chip", href: "#record", hidden: true }, el("i", { "aria-hidden": "true" }), el("span", {}, ""));
conn.after(recChip);
const showRecording = (s: recorder.RecState) => {
  const live = s.status === "recording" || s.status === "paused";
  recChip.hidden = !live;
  if (!live || !s.rec) return;
  const start = Date.parse(s.rec.start);
  const paused = s.rec.pauses.reduce((n, p) => n + ((p.to ?? Date.now()) - p.from), 0);
  const sec = Math.max(0, Math.round((Date.now() - start - paused) / 1000));
  recChip.dataset.state = s.status;
  recChip.querySelector("span")!.textContent = `${s.status === "paused" ? "Paused" : "Recording"} ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};
// The chip's clock ticks only while a run is live (no timer otherwise).
let recTick: ReturnType<typeof setInterval> | null = null;
recorder.onRecorder((s) => {
  showRecording(s);
  const live = s.status === "recording" || s.status === "paused";
  if (live && !recTick) recTick = setInterval(() => showRecording(recorder.getRecorder()), 1000);
  if (!live && recTick) {
    clearInterval(recTick);
    recTick = null;
  }
});
// In-app dropdowns everywhere instead of the system picker.
enhanceSelects();
// The content stretches at the ends like a native list; the bars don't.
// On Today, pulling down far enough syncs everything (the board shows it running).
const PULL_SYNC = 72;
const pullHint = el("div", { class: "pull-hint", "aria-hidden": "true" }, icon("sync", "ic sm"), el("span", {}, "Pull to sync"));
document.body.append(pullHint);
const stretch = rubberBand(page(), document.getElementById("view")!, {
  onPull: (px) => {
    const on = current === "today" && px > 8;
    pullHint.classList.toggle("show", on);
    pullHint.classList.toggle("ready", on && px >= PULL_SYNC);
    pullHint.style.setProperty("--pull", String(Math.min(1, px / PULL_SYNC)));
    pullHint.querySelector("span")!.textContent = px >= PULL_SYNC ? "Let go to sync" : "Pull to sync";
  },
  onRelease: (px) => {
    if (current !== "today" || px < PULL_SYNC) return;
    tick();
    void syncAllNow();
  },
});
if (isNative) {
  document.documentElement.classList.add("native");
  // No browser menu on a long press, except where text is meant to be edited or copied.
  document.addEventListener("contextmenu", (e) => {
    if (!(e.target as Element).closest?.("input, textarea, pre, code")) e.preventDefault();
  });
}
// A light tick when a choice changes: tabs, segments, answer chips, picker options.
document.addEventListener("click", (e) => {
  if ((e.target as Element).closest?.('.nav [data-tab], .seg, .chip.answer, [role="option"]')) tick();
});
watchKeyboard();
void recorder.restoreUnfinished();
// Which build this is, first in the activity log (set by `bun run build:web`).
declare const BUILD_ID: string;
log(`Tartan build ${typeof BUILD_ID === "string" ? BUILD_ID : "dev"}`);

window.addEventListener("hashchange", () => {
  clearInfoNotice();
  void route();
});

window.addEventListener("unhandledrejection", (e) => {
  // A skipped view transition is harmless (the page still updated).
  if (/Transition was (aborted|skipped)/i.test(String((e.reason as Error)?.message))) return;
  notify(String((e.reason as Error)?.message ?? e.reason), "error");
});
// The PC's QR code in a browser preview (on the phone it arrives as tartan://localhost/pair).
const pairParam = new URLSearchParams(location.search).get("pair");
if (pairParam && deviceMode) {
  const parts = pairParam.split("|");
  openPairLink(parts.slice(0, -1), parts.at(-1) ?? "");
}
void finishStravaReturn().finally(() => {
  void route();
  void autoSync(false, "open");
  // First run: the intro, over the app (resumes after Strava's sign-in brings you back).
  void maybeOnboard();
  // Reminders and calendar events follow the plan (and the days passing).
  void syncSchedule();
});
// A reminder opens Today; the nudge after a session syncs now (the workout is on the watch) and
// opens the session: a strength session's log, or Today.
void listenForReminderTaps((t) => {
  location.hash = t.after && t.kind === "strength" && t.date ? `#lift/${t.date}` : "#today";
  if (t.after) void autoSync(true, "open");
});
// No Sync button: data comes in when the app opens, when you come back to it, and half-hourly.
document.addEventListener("visibilitychange", () => {
  // Leaving the app: the widget gets the latest (a session ticked off, a morning check).
  if (document.visibilityState === "hidden") void updateWidget();
  void autoSync(false, "resume");
  if (document.visibilityState === "visible") void syncSchedule();
  // A new wallpaper while away: Material You's colours follow it.
  if (document.visibilityState === "visible") void applyColours(true);
});
// Material You: the wallpaper's colours (or Tartan's own, Settings → More → Colours).
applyMaterial();
void applyColours();
void startShell();
// The demo (iPhone, the PC): its sample written the first time, then every screen reads it.
void import("./lib/demo.ts").then(async (d) => {
  if (await d.seedDemo()) hooks.refresh?.();
});
slideSelect();
setInterval(() => void autoSync(false, "tick"), 30 * 60_000);
void listenForStravaReturn();
