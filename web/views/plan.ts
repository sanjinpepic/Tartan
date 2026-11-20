/**
 * Coach: your plan and your coach in one place. Without a key, the setup; without a plan, the
 * coach introduces itself with what it already knows and asks three quick things; with a plan,
 * this week (or the whole plan at a glance), every session ticked off against your workouts.
 * "Ask your coach" opens the conversation (#chat), which is also where the plan changes.
 */
import { releaseBodies } from "../lib/body-stage.ts";
import { syncSchedule } from "../lib/schedule.ts";
import { ago, dateShort, dayName, el, fmtDuration, icon, meta, num } from "../lib/dom.ts";
import { renderMarkdown } from "../lib/md.ts";
import { success, thud } from "../lib/haptics.ts";
import { revealOnScroll, swap } from "../lib/motion.ts";
import { act, app, hooks, notify, plainWatchError, readNdjson } from "../state.ts";
import type { Availability, PlanChange, PlanSession, PlanView, PlanWeek, SessionKind } from "../types.ts";
import { openChat, setupCard, type CoachStatus } from "./coach.ts";
import { comingWeek, sendWeek } from "../lib/watch-workouts.ts";
import { planDest, planOut, shareSessionFile, type PlanOutOp } from "../lib/plan-out.ts";
import type { WeeklyReview } from "../sync.ts";
import * as watch from "../watch.ts";
import { dragToClose } from "./detail.ts";
import { strengthSection } from "./strength.ts";
import { largeTitle } from "./today.ts";
import { coachBadge } from "../lib/badge.ts";
import type { upcomingWeather } from "../../src/weather.ts";

type UpcomingWeather = Awaited<ReturnType<typeof upcomingWeather>>;

const KIND_LABEL: Record<SessionKind, string> = {
  easy: "Easy", long: "Long", tempo: "Tempo", intervals: "Intervals", hills: "Hills",
  recovery: "Recovery", race: "Race", strength: "Strength", cross: "Cross-training", rest: "Rest",
};
const STATUS: Record<PlanSession["status"], { label: string; icon?: string }> = {
  done: { label: "Done", icon: "check" },
  missed: { label: "Missed" },
  today: { label: "Today" },
  planned: { label: "Planned" },
  rest: { label: "Rest" },
};
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** This week day by day, or every week at a glance. Remembered while the app is open. */
let planMode: "week" | "all" = "week";

const day = (iso: string) => new Date(`${iso}T12:00:00`);
const range = (start: string) => `${dateShort(day(start))} – ${dateShort(new Date(day(start).getTime() + 6 * 86400_000))}`;
const details = (s: Pick<PlanSession, "duration_min" | "distance_km" | "target">) =>
  [s.duration_min ? fmtDuration(s.duration_min) : "", s.distance_km ? `${num(s.distance_km, s.distance_km < 10 ? 1 : 0)} km` : "", s.target ?? ""].filter(Boolean);
const sessionName = (s: PlanSession, date: string) => `${dayName(day(date))} ${dateShort(day(date))}, ${s.title}`;

// ------------------------------------------------------------------ the coach's suggested changes


const CHANGE_IC: Record<PlanChange["type"], string> = { added: "plus", removed: "trash", moved: "outback", changed: "spark", zones: "heart", length: "plan" };
const CHANGE_WORD: Record<PlanChange["type"], string> = { added: "New", removed: "Out", moved: "Moved", changed: "Changed", zones: "Zones", length: "Length" };
const FROM: Record<string, string> = { chat: "From your conversation", update: "Your new plan", weekly: "From the weekly review", agent: "From an outside agent", life: "From what you told Tartan" };

function changeRow(c: PlanChange): HTMLElement {
  const when = c.date ? `${dayName(day(c.date))} ${dateShort(day(c.date))}` : "";
  return el(
    "li",
    { class: `change t-${c.type}` },
    el("span", { class: "change-ic", "aria-hidden": "true" }, icon(CHANGE_IC[c.type], "ic sm")),
    el(
      "span",
      { class: "change-main" },
      el("b", {}, [CHANGE_WORD[c.type], c.title ? `${when ? `${when} · ` : ""}${c.title}` : ""].filter(Boolean).join(": ")),
      el("span", { class: "sub" }, c.detail),
      c.why ? el("span", { class: "change-why" }, c.why) : null,
    ),
  );
}

/** The suggestion: what the coach says, every change the app found, Accept or Not now. */
function proposalCard(p: NonNullable<PlanView["proposal"]>, changed: () => void, talk: (conversation: string) => void): HTMLElement {
  const accept = el("button", { type: "button", class: "btn filled" }, icon("check", "ic sm"), "Accept");
  const later = el("button", { type: "button", class: "btn text" }, "Not now");
  const send = (body: object, button: HTMLButtonElement, label: string, done: string, then?: { label: string; run: () => unknown }) =>
    void act(button, label, async () => {
      const r = (await (await app.api.request("/api/plan/proposal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { error?: string };
      if (r.error) throw new Error(r.error);
      thud();
      notify(done, "info", then);
      coachBadge(false);
      void syncSchedule();
      changed();
    });
  // The watch takes the new sessions when Tartan next syncs with it (opening the app near it), or now.
  const sendNow = {
    label: "Send now",
    run: () =>
      app.api
        .json<PlanView>("/api/plan")
        .then((v) => sendWeek(v))
        .then((r) => notify(r.added || r.removed ? "The next 7 days are on your watch." : "Your watch already has the next 7 days."))
        .catch((e: Error) => notify(plainWatchError(e.message) ?? `Couldn't send it: ${e.message}`, "error")),
  };
  accept.onclick = () => send({ accept: true, base: p.base }, accept, "Accepting", "Plan changed. Your watch gets it next time Tartan syncs with it.", sendNow);
  later.onclick = () => send({ accept: false }, later, "Declining", "Kept your plan as it was.");
  const talkBtn = p.conversation ? el("button", { type: "button", class: "btn text" }, icon("coach", "ic sm"), "Ask about it") : null;
  if (talkBtn) talkBtn.onclick = () => talk(p.conversation!);
  const n = p.changes.length;
  return el(
    "section",
    { class: "card proposal", "aria-label": "Suggested changes", "data-reveal": "" },
    el("div", {}, el("h2", {}, `Your coach suggests ${n} change${n > 1 ? "s" : ""}`), el("p", { class: "session-when" }, `${FROM[p.source] ?? "From your coach"} · ${ago(new Date(p.at))}`)),
    p.note ? el("p", { class: "proposal-note" }, p.note) : null,
    el("ul", { class: "changes" }, ...p.changes.map(changeRow)),
    el("p", { class: "sub" }, "Days already behind you stay as they were. You can undo it for a week. ", el("a", { href: "#settings/coach", class: "inline-link" }, "Let small changes go straight in")),
    el("div", { class: "row" }, accept, later, talkBtn),
  );
}

/** After taking a suggestion: what changed, and Undo for a week. */
function undoCard(l: NonNullable<PlanView["last_change"]>, changed: () => void): HTMLElement {
  const undo = el("button", { type: "button", class: "btn text small" }, icon("undo", "ic sm"), "Undo");
  undo.onclick = () =>
    void act(undo, "Undoing", async () => {
      const r = (await (await app.api.request("/api/plan/revert", { method: "POST" })).json()) as { error?: string };
      if (r.error) throw new Error(r.error);
      notify("Your plan is back as it was.");
      void syncSchedule();
      changed();
    });
  const n = l.changes.length;
  return el(
    "section",
    { class: "card proposal-done", "aria-label": "Last change" },
    el("details", { class: "more" }, el("summary", {}, icon("check", "ic sm"), l.auto ? `Your coach made ${n} change${n > 1 ? "s" : ""} ${ago(new Date(l.at))}` : `${n} change${n > 1 ? "s" : ""} taken ${ago(new Date(l.at))}`), el("ul", { class: "changes" }, ...l.changes.map(changeRow))),
    undo,
  );
}

/** Strength sessions logged in the app, by date: from the last plan fetched. */
let lifted: NonNullable<PlanView["lifts"]> = {};

/**
 * A strength session's way into the logger: Start, Continue (under way) or Logged (with its
 * records), for today and earlier. Null for other sessions.
 */
export function liftButton(s: PlanSession, date: string, today: string, small = false): HTMLElement | null {
  if (s.kind !== "strength" || date > today) return null;
  const l = lifted[date];
  const cls = `btn ${l?.finished ? "tonal" : "filled"}${small ? " small" : ""}`;
  return el(
    "a",
    { class: cls, href: `#lift/${date}` },
    icon(l?.finished ? "check" : "bolt", "ic sm"),
    l?.finished ? `Logged${l.prs ? ` · ${l.prs} record${l.prs > 1 ? "s" : ""}` : ""}` : l ? "Continue" : s.status === "done" ? "Log the sets" : "Start",
  );
}

/** A session whose paces you moved from a finished run's rule: why, and Undo. */
function adjustedNote(s: PlanSession, date: string, done: () => void): HTMLElement {
  const a = s.adjusted!;
  const undo = el("button", { type: "button", class: "text-btn" }, "Undo");
  undo.onclick = () =>
    void act(undo, "Undoing", async () => {
      await app.api.request("/api/plan/adjust", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ date, kind: s.kind, undo: true }) });
      notify(`${s.title} is back as planned.`);
      done();
      hooks.refresh();
    });
  return el("p", { class: "plan-manual" }, icon("spark", "ic xs"), `${Math.abs(a.shift_s)} s/km ${a.shift_s < 0 ? "faster" : "easier"} than planned: ${a.reason.replace(/:.*$/, "").toLowerCase()}.`, undo);
}

/** Tick a session off by hand (the watch stayed home), or take the mark back. */
export async function markSession(date: string, kind: string, done: boolean): Promise<void> {
  const res = await app.api.request("/api/plan/mark", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ date, kind, done }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  void syncSchedule();
}

type Mark = (button: HTMLButtonElement, s: PlanSession, date: string, done: boolean) => Promise<void>;
type Ask = (s: PlanSession, date: string) => void;

/**
 * The Coach tab's last answers. Coming back draws them at once and freshens in place, instead of
 * skeletons while the coach's status, the plan and the week's review are asked for again.
 */
let homeSnap: { status: CoachStatus; plan: PlanView; weekly: WeeklyReview | null } | null = null;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function renderCoachHome(root: HTMLElement): Promise<void> {
  const sub = el("span", {}, "Your plan and your coach");
  root.replaceChildren(largeTitle("Coach", sub));
  const snap = homeSnap;
  const body = el("div", { class: "plan-body" }, ...(snap ? [] : [el("div", { class: "skeleton-card" }), el("div", { class: "skeleton-card" })]));
  root.append(body);
  // All three asked at once (they were one after another).
  const statusP = app.api.json<CoachStatus>("/api/coach/status");
  const planP = app.api.json<PlanView>("/api/plan");
  const weeklyP = app.api.json<WeeklyReview | null>("/api/plan/weekly").catch(() => null);
  const askBar = el("button", { type: "button", class: "ask-bar" }, el("span", { class: "ask-bar-text" }, "Ask your coach"), el("span", { class: "send", "aria-hidden": "true" }, icon("send")));
  askBar.onclick = () => openChat({ focus: true });

  const status = snap ? snap.status : await statusP;
  // Drawn from last time: if the coach's state changed since (a key added, Model Hub ready), draw again.
  if (snap)
    void statusP
      .then((fresh) => {
        if (!same(fresh, snap.status) && root.isConnected) {
          homeSnap = { ...snap, status: fresh };
          void renderCoachHome(root);
        }
      })
      .catch(() => {});
  // Without an AI key: a plan by Tartan's own rules (src/basic-plan.ts), and the key's setup.
  const noKey = !status.ready;
  const setup = () => setupCard(status, () => void renderCoachHome(root));
  if (noKey) {
    const v = await planP.catch(() => null);
    if (!v?.plan) {
      const makeBasic = (button: HTMLButtonElement, target?: string) =>
        act(button, "Making the plan", async () => {
          const res = await app.api.request("/api/plan/basic", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }) });
          const r = (await res.json()) as { error?: string };
          if (!res.ok) throw new Error(r.error ?? `couldn't make the plan (${res.status})`);
          void syncSchedule();
          success();
          planMode = "week";
          notify("Your plan is ready.");
          await renderCoachHome(root);
        });
      body.replaceChildren(meetCard(), ...(v ? [intakeCard(v, makeBasic, true)] : []), setup());
      return;
    }
    // There is a plan: shown as always; talking it over needs a key, whose setup takes the ask bar's place.
  }

  const mark: Mark = (button, s, date, done) =>
    act(button, done ? "Marking it done" : "Undoing", async () => {
      await markSession(date, s.kind, done);
      if (done) thud();
      await draw();
      notify(done ? `${s.title} marked done.` : `${s.title} is no longer marked done.`);
    });
  let planConversation: string | undefined;
  const ask: Ask = (s, date) => openChat({ conversation: planConversation, prefill: `About ${sessionName(s, date)}: `, focus: true });

  // The first paint reveals the cards as they scroll in; later redraws (a session ticked off,
  // the plan rewritten) change in place, and switching views slides the plan sideways.
  let painted = false;
  const paint = (...nodes: Node[]) => {
    body.replaceChildren(...nodes);
    if (!painted) revealOnScroll(body);
    painted = true;
  };
  const seg = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Show" });
  const holder = el("div", { class: "plan-content" });
  let shown: PlanView | null = null;
  // What the coach suggests or last changed, and the week's review: under the week they change.
  let changes: () => Node[] = () => [];
  const planContent = (v: PlanView): Node[] => {
    const current = v.weeks.find((w) => w.when === "current");
    const later = v.weeks.filter((w) => w.when === "future");
    if (planMode === "all") return [wholePlan(v, mark, ask), ...changes()];
    // The coming week's sessions on a Suunto carry a mark each; the line above the week sends them.
    const marks = planDest() === "suunto" && watch.canBluetooth() ? comingWeek(v).onWatch : new Set<string>();
    return [
      current
        ? weekCard(current, v.today, "This week", mark, ask, marks)
        : el("div", { class: "empty-card" }, el("h3", {}, "No sessions this week"), el("p", {}, "Ask your coach to carry the plan on from today.")),
      ...changes(),
      ...(later[0] ? [weekCard(later[0], v.today, "Next week", mark, ask, marks)] : []),
      ...(later.length > 1 ? [el("button", { type: "button", class: "btn tonal plan-more", onclick: () => setMode("all", true) }, `${later.length - 1} more week${later.length > 2 ? "s" : ""} · see the whole plan`)] : []),
    ];
  };
  const syncSeg = () => seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === planMode)));
  const setMode = (m: typeof planMode, toTop = false) => {
    if (m === planMode || !shown) return;
    const dir = m === "all" ? 1 : -1;
    planMode = m;
    syncSeg();
    if (toTop) seg.scrollIntoView({ block: "start", behavior: "smooth" });
    void swap(holder, planContent(shown), dir);
  };
  for (const [id, label] of [["week", "This week"], ["all", "Whole plan"]] as const) {
    const b = el("button", { type: "button", role: "radio", class: "seg", "data-mode": id }, label);
    b.onclick = () => setMode(id);
    seg.append(b);
  }

  const draw = async (live?: HTMLElement, given?: { plan: PlanView; weekly: WeeklyReview | null }) => {
    const v = given?.plan ?? (await app.api.json<PlanView>("/api/plan"));
    shown = v;
    lifted = v.lifts ?? {};
    coachBadge(!!v.proposal);
    planConversation = v.plan?.conversation;
    askBar.querySelector(".ask-bar-text")!.textContent = v.plan ? "Ask your coach or change the plan" : "Or just ask your coach anything";
    if (!v.plan) {
      if (noKey) return renderCoachHome(root);
      sub.textContent = "Your plan and your coach";
      paint(...(live ? [live] : []), intakeCard(v, make), askBar);
      return;
    }
    sub.replaceChildren(meta(`Plan updated ${ago(new Date(v.plan.updated))}`, `${v.weeks.length} week${v.weeks.length === 1 ? "" : "s"}`));
    syncSeg();
    const weekly = given ? given.weekly : await app.api.json<WeeklyReview | null>("/api/plan/weekly").catch(() => null);
    homeSnap = { status, plan: v, weekly };
    changes = () => {
      const review = weekly ? weeklyCard(weekly, v.today, () => void draw()) : null;
      // The coach's suggestion; once taken, a week to undo it.
      const proposal = v.proposal ? proposalCard(v.proposal, () => void draw(), (c) => openChat({ conversation: c })) : v.last_change ? undoCard(v.last_change, () => void draw()) : null;
      return [proposal, review].filter((n): n is HTMLElement => !!n);
    };
    holder.replaceChildren(...planContent(v));
    // The plan first: which weeks and a change of plan (ill, away, busy), one line on the watch,
    // the weeks; then the plan at a glance, the paces and zones, the pointers.
    paint(
      ...(live ? [live] : []),
      el("div", { class: "toolbar plan-bar" }, seg, lifeButton(v, () => void draw())),
      watchLine(v, () => void draw()),
      holder,
      overviewCard(v, v.weeks.find((w) => w.when === "current")),
      ...(v.plan.zones?.length ? [zonesCard(v.plan.zones)] : []),
      ...(v.plan.advice?.length ? [adviceCard(v.plan.advice)] : []),
      noKey ? setup() : askBar,
    );
  };

  /** The first plan: the coach thinks out loud (tools, then a few sentences), then the plan appears. */
  const make = async (button: HTMLButtonElement, target?: string) => {
    const trail = el("div", { class: "tool-trail" });
    const text = el("div", { class: "msg-text" }, el("span", { class: "typing", "aria-label": "Coach is working" }, el("i"), el("i"), el("i")));
    const discuss = el("button", { type: "button", class: "btn text small", hidden: true }, icon("coach", "ic sm"), "Talk it through with your coach");
    const live = el("section", { class: "card plan-live", "aria-live": "polite" }, el("p", { class: "status-line live" }, el("i", { "aria-hidden": "true" }), "Your coach is planning"), trail, text, discuss);
    body.prepend(live);
    live.scrollIntoView({ block: "start" });
    let said = "";
    let frame = 0;
    let saved = false;
    let proposed = 0;
    await act(button, "Making the plan", async () => {
      const res = await app.api.request("/api/plan/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }) });
      await readNdjson(res, (m) => {
        if (m.type === "conversation") discuss.onclick = () => openChat({ conversation: String(m.id) });
        else if (m.type === "tool") {
          trail.querySelector(".chip.live")?.classList.remove("live");
          trail.append(el("span", { class: "chip quiet live" }, el("span", { class: "spinner", "aria-hidden": "true" }), String(m.label)));
        } else if (m.type === "plan") {
          if (m.proposed) proposed = Number(m.proposed);
          else saved = true;
        } else if (m.type === "text") {
          said += String(m.delta);
          frame ||= requestAnimationFrame(() => {
            frame = 0;
            text.replaceChildren(renderMarkdown(said));
          });
        } else if (m.type === "error") throw new Error(String(m.message));
      });
    });
    cancelAnimationFrame(frame);
    trail.querySelectorAll(".chip.live").forEach((c) => {
      c.classList.remove("live");
      c.querySelector(".spinner")?.replaceWith(icon("check", "ic xs"));
    });
    const line = live.querySelector(".status-line")!;
    line.replaceChildren(saved || proposed ? "Your coach" : "No plan yet");
    line.className = "status-line";
    text.replaceChildren(said ? renderMarkdown(said) : saved || proposed ? "" : "No answer from the coach. Try again in a moment.");
    discuss.hidden = false;
    if (proposed) {
      notify(`Your coach suggests ${proposed} change${proposed > 1 ? "s" : ""}: accept them or not below.`);
      await draw(live);
    }
    if (saved) {
      void syncSchedule();
      success();
      planMode = "week";
      notify("Your plan is ready.");
      await draw(live);
    }
  };

  if (snap) await draw(undefined, snap);
  // Offline with last time's drawn: keep it rather than an error.
  const [plan, weekly] = await Promise.all([planP, weeklyP]).catch((e: unknown) => {
    if (snap) return [snap.plan, snap.weekly] as const;
    throw e;
  });
  if (!snap || !same(plan, snap.plan) || !same(weekly, snap.weekly)) {
    if (root.isConnected) await draw(undefined, { plan, weekly });
  }
}

// ------------------------------------------------------------------ no plan yet: the intro

/** What the coach does, before asking for a key: a week as the Coach tab shows it, marked as an example. */
function meetCard(): HTMLElement {
  return el(
    "section",
    { class: "card coach-intro" },
    el("h2", {}, "Meet your coach"),
    el("p", {}, "It reads your workouts, heart rate, load and targets, builds a training plan around the time you have, and changes it whenever you ask. It runs on your own AI key: add one below to begin, or start with a plan by Tartan's own rules, no AI needed."),
    el(
      "figure",
      { class: "coach-example" },
      el("figcaption", {}, "An example week"),
      el(
        "ul",
        {},
        ...([
          ["easy", "Tue", "Easy run", "40 min, easy heart rate"],
          ["intervals", "Thu", "6 × 800 m", "reps at 5 km pace, on your watch as a guided workout"],
          ["strength", "Fri", "Strength", "30 min, exercises shown step by step"],
          ["long", "Sun", "Long run", "1 h 20, the week's longest"],
        ] as const).map(([k, d, t, x]) => el("li", { class: `k-${k}` }, el("span", { class: "kind-dot", "aria-hidden": "true" }), el("b", {}, d), el("span", {}, el("b", {}, t), ` · ${x}`))),
      ),
    ),
    el(
      "ul",
      { class: "coach-gets" },
      el("li", {}, icon("plan", "ic sm"), "A plan around your days and hours, ticked off by your workouts"),
      el("li", {}, icon("check", "ic sm"), "Changes it suggests wait for your OK, and can be undone"),
      el("li", {}, icon("coach", "ic sm"), "Ask about any run, your form, a race or an injury"),
    ),
  );
}

/** One question answered by tapping a chip. */
function chips(name: string, options: Array<[string, string]>, selected: string): { group: HTMLElement; value: () => string } {
  let value = selected;
  const group = el("div", { class: "answer-chips", role: "radiogroup", "aria-label": name });
  for (const [v, label] of options) {
    const b = el("button", { type: "button", role: "radio", class: "chip action answer", "aria-checked": String(v === value) }, label);
    b.onclick = () => {
      value = v;
      group.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    };
    group.append(b);
  }
  return { group, value: () => value };
}

/** `noAi`: the plan comes from Tartan's own rules (no key yet), so the card speaks for the app, not the coach. */
function intakeCard(v: PlanView, make: (b: HTMLButtonElement, target?: string) => Promise<void>, noAi = false): HTMLElement {
  const a: Availability = v.availability ?? {};
  const r = v.recent;
  const race = v.goals.race?.date && v.goals.race.date >= v.today ? v.goals.race : undefined;
  // What the coach already knows, in its own voice.
  const knows = [
    r.runs
      ? `Over the last four weeks you ran ${num(r.run_km_per_week, 1)} km a week across ${r.runs} run${r.runs === 1 ? "" : "s"}, the longest ${num(r.longest_run_km, 1)} km.`
      : r.workouts
        ? `You've trained about ${num(r.hours_per_week, 1)} hours a week lately, without runs.`
        : "I don't see any workouts from the last four weeks yet, so we'll start gently.",
    race ? `Your ${race.name ?? `${num(race.distance_km, 1)} km race`} is on ${dateShort(day(race.date!))}.` : "",
  ].filter(Boolean).join(" ");

  const days = chips("Days a week", [["", "Not sure"], ...[2, 3, 4, 5, 6, 7].map((n): [string, string] => [String(n), String(n)])], a.days_per_week ? String(a.days_per_week) : "");
  const hours = chips("Hours a week", [["", "Not sure"], ...[2, 3, 4, 5, 6, 8, 10].map((n): [string, string] => [String(n), `${n} h`])], a.hours_per_week ? String(a.hours_per_week) : "");
  const long = chips("Long run day", [["", "Any day"], ...WEEKDAYS.map((d): [string, string] => [d, d])], a.long_run_day ?? "");
  const target = el("input", {
    type: "text",
    autocomplete: "off",
    maxLength: 80,
    placeholder: "e.g. 14 March, end of June",
    "aria-label": "Target date",
    value: race ? day(race.date!).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }) : "",
  });
  const notes = el("textarea", { class: "plain", rows: 2, maxLength: 300, "aria-label": "Anything else", placeholder: "Injuries, no running on Thursdays, what you want from it…" }, a.notes ?? "");
  const go = el("button", { type: "submit", class: "btn filled" }, icon("spark"), "Make my plan");
  const q = (_n: number, title: string, ...kids: Array<Node | null>) => el("div", { class: "intake-q" }, el("p", { class: "intake-title" }, title), ...kids);
  const form = el(
    "form",
    { class: "card coach-intro intake", "data-reveal": "" },
    el("h2", {}, noAi ? "Or start with a plan, no AI needed" : "Let's build your plan"),
    el("p", {}, noAi ? knows.replace(/\bI don't see\b/, "Tartan doesn't see").replace(/\bwe'll\b/, "it'll") : knows),
    el("p", { class: "sub" }, noAi ? "Three quick things, and Tartan plans around them by its own rules: about 10% more a week, every fourth week easier, mostly easy running, and a taper before a race. Add an AI key later and the coach can take it over." : "Three quick things, and I'll plan around them."),
    q(1, "How many days a week can you train?", days.group),
    q(2, "About how many hours a week?", hours.group),
    q(3, "Which day suits the long run?", long.group),
    q(4, "Building to a date?", target, el("span", { class: "field-hint" }, race ? "Your race day. Clear it for an 8-week plan." : "Optional. Leave it empty for an 8-week plan.")),
    noAi ? null : el("details", { class: "intake-more" }, el("summary", {}, "Anything else I should know?"), notes),
    el("div", { class: "row" }, go, v.goals.race || v.goals.weekly_km ? null : el("a", { class: "btn text", href: "#settings" }, "Set targets first")),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const avail: Availability = {
      days_per_week: days.value() ? Number(days.value()) : undefined,
      hours_per_week: hours.value() ? Number(hours.value()) : undefined,
      long_run_day: long.value() || undefined,
      notes: notes.value.trim() || undefined,
    };
    try {
      await app.api.request("/api/plan/availability", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(avail) });
    } catch (err) {
      return notify(`Couldn't save your answers: ${(err as Error).message}`, "error");
    }
    await make(go, target.value.trim() || undefined);
  };
  return form;
}

// ------------------------------------------------------------------ the plan

const WEEKLY_SEEN = "freesuunto.weekly.seen";

/**
 * What the coach said in this week's review (src/coach.ts weeklyReview), until it's put away or
 * the week is over: whether next week changed, and the way into the conversation.
 */
function weeklyCard(r: WeeklyReview, today: string, gone: () => void): HTMLElement | null {
  const ends = new Date(day(r.week).getTime() + 6 * 86400_000);
  if (!r.text || day(today) > ends) return null;
  try {
    if (localStorage.getItem(WEEKLY_SEEN) === r.week) return null;
  } catch {
    // shown
  }
  const close = el("button", { type: "button", class: "icon-btn", "aria-label": "Put away" }, icon("close"));
  close.onclick = () => {
    try {
      localStorage.setItem(WEEKLY_SEEN, r.week);
    } catch {
      // stays
    }
    gone();
  };
  const talk = el("button", { type: "button", class: "btn text small" }, icon("coach", "ic sm"), "Talk it through");
  talk.onclick = () => openChat({ conversation: r.conversation, focus: true });
  return el(
    "section",
    { class: `card weekly-card${r.changed ? " changed" : ""}`, "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, r.proposed ? "Changes suggested for next week" : r.changed ? "Next week, adjusted" : "Next week stays as planned"), el("p", { class: "session-when" }, `Week review · ${dayName(new Date(r.at))}`)), close),
    el("div", { class: "weekly-text" }, renderMarkdown(r.text)),
    talk,
  );
}

/** The week's volume as the plan's sessions add up (the coach's own target when they don't). */
const weekKm = (w: PlanWeek) => w.planned.km || w.target_km || 0;
const weekMinutes = (w: PlanWeek) => w.planned.minutes || (w.target_hours ? w.target_hours * 60 : 0);

function overviewCard(v: PlanView, w?: PlanWeek): HTMLElement {
  const p = v.plan!;
  const share = w && w.planned.sessions ? w.done.sessions / w.planned.sessions : 0;
  const race = v.goals.race?.date && v.goals.race.date === p.target_date ? `${v.goals.race.name ?? `${num(v.goals.race.distance_km, 1)} km race`} on ${dateShort(day(v.goals.race.date))}` : p.target_date ? `Building to ${dateShort(day(p.target_date))}` : null;
  // The coach's summary: three lines, the rest a tap away.
  const summary = el("p", { class: "plan-summary clamped" }, p.summary);
  const more = el("button", { type: "button", class: "text-btn plan-summary-more", hidden: true, "aria-expanded": "false" }, "More");
  more.onclick = () => {
    const open = summary.classList.toggle("clamped") === false;
    more.textContent = open ? "Less" : "More";
    more.setAttribute("aria-expanded", String(open));
  };
  requestAnimationFrame(() => (more.hidden = summary.scrollHeight <= summary.clientHeight + 2));
  const km = w ? weekKm(w) : 0;
  return el(
    "section",
    { class: "card plan-hero", "data-reveal": "" },
    el("h2", {}, p.title),
    race ? el("p", { class: "plan-target" }, icon("plan", "ic sm"), race) : null,
    w
      ? el(
          "div",
          { class: "plan-progress" },
          el("div", { class: "plan-progress-head" }, el("b", {}, `${w.done.sessions} of ${w.planned.sessions} sessions`), el("span", { class: "sub" }, km ? `${num(w.done.km, 1)} of ${num(km, 0)} km this week` : fmtDuration(w.done.minutes) || "")),
          el("div", { class: `progress-track${share >= 1 ? " done" : ""}`, role: "img", "aria-label": `${w.done.sessions} of ${w.planned.sessions} sessions done` }, el("span", { style: `width:${Math.round(Math.min(1, share) * 100)}%` })),
        )
      : null,
    summary,
    more,
  );
}

/**
 * A session in the week: one quiet row (the day's colour, its name, one line of what, and where
 * it stands at the end). A tap opens it: everything about it and what can be done with it.
 */
function sessionRow(s: PlanSession, date: string, today: string, mark: Mark, ask: Ask, onWatch = false): HTMLElement {
  const a = s.activity;
  const what = a ? `Did ${[a.distance_km ? `${num(a.distance_km, 1)} km` : "", fmtDuration(a.moving_min)].filter(Boolean).join(" · ") || (a.name ?? a.sport)}` : [KIND_LABEL[s.kind], ...details(s).slice(0, 2)].join(" · ");
  const end =
    s.status === "done" ? el("span", { class: "status-pill done", "aria-label": "Done" }, icon("check", "ic xs"))
    : s.status === "missed" ? el("span", { class: "status-pill missed" }, "Missed")
    : s.status === "today" ? el("span", { class: "status-pill today" }, "Today")
    : null;
  const row = el(
    "button",
    { type: "button", class: `plan-session k-${s.kind} s-${s.status}${date === today ? " is-today" : ""}`, "aria-label": `${sessionName(s, date)}: ${what}${s.status === "planned" ? "" : `, ${STATUS[s.status].label}`}` },
    el("span", { class: "kind-dot", "aria-hidden": "true" }),
    el(
      "span",
      { class: "plan-session-main" },
      el("b", {}, s.title),
      el("span", { class: "sub" }, onWatch ? el("span", { class: "on-watch", title: "On your watch" }, icon("watch", "ic xs")) : null, what),
    ),
    end,
  );
  row.onclick = () => openSession(s, date, today, mark, ask, onWatch);
  return row;
}

/**
 * One day's session in its sheet, from anywhere (Tartan 2's native Today opens today's this way,
 * rather than the whole Coach tab). False when the plan has no such session.
 */
export async function openPlanSession(date: string, kind?: string): Promise<boolean> {
  const v = await app.api.json<PlanView>("/api/plan");
  const s = v.weeks.flatMap((w) => w.days).find((d) => d.date === date)?.sessions.find((x) => x.kind !== "rest" && (!kind || x.kind === kind));
  if (!s) return false;
  lifted = v.lifts ?? {};
  const mark: Mark = (button, x, d, done) =>
    act(button, done ? "Marking it done" : "Undoing", async () => {
      await markSession(d, x.kind, done);
      if (done) thud();
      notify(done ? `${x.title} marked done.` : `${x.title} is no longer marked done.`);
    });
  const ask: Ask = (x, d) => openChat({ conversation: v.plan?.conversation, prefill: `About ${sessionName(x, d)}: `, focus: true });
  openSession(s, date, v.today, mark, ask, false);
  return true;
}

/** A session's sheet: what, how, notes, the workout that did it, and its actions. */
function openSession(s: PlanSession, date: string, today: string, mark: Mark, ask: Ask, onWatch: boolean): void {
  const dialog = el("dialog", { class: "sheet session-sheet", "aria-labelledby": "session-title" });
  const close = () => {
    if (!dialog.open) return;
    dialog.classList.add("closing");
    setTimeout(() => dialog.close(), 240);
  };
  dialog.addEventListener("close", () => {
    releaseBodies(dialog);
    dialog.remove();
  });
  dialog.addEventListener("click", (e) => e.target === dialog && close());
  const a = s.activity;
  const stat = (label: string, value: string) => el("div", {}, el("dt", {}, label), el("dd", {}, value));
  const stats = [
    s.duration_min ? stat("Time", fmtDuration(s.duration_min)) : null,
    s.distance_km ? stat("Distance", `${num(s.distance_km, s.distance_km < 10 ? 1 : 0)} km`) : null,
  ].filter((x): x is HTMLDivElement => !!x);
  // The structured session, block by block.
  const len = (x: { duration_s?: number; distance_m?: number }) => (x.distance_m ? (x.distance_m >= 1000 ? `${num(x.distance_m / 1000, 1)} km` : `${x.distance_m} m`) : x.duration_s ? fmtDuration(x.duration_s / 60) : "");
  const STEP: Record<string, string> = { warmup: "Warm up", run: "Run", recover: "Recover", cooldown: "Cool down" };
  const steps = s.steps?.length
    ? el(
        "ol",
        { class: "session-steps" },
        ...s.steps.map((b) =>
          el(
            "li",
            {},
            (b.repeat ?? 1) > 1 ? el("b", { class: "session-repeat" }, `${b.repeat} ×`) : null,
            el("span", {}, b.steps.map((x) => [STEP[x.kind] ?? x.kind, len(x)].filter(Boolean).join(" ")).join(", then ")),
          ),
        ),
      )
    : null;
  const review = el("div", { class: "plan-review", hidden: true });
  if (a && (s.steps?.length || s.target))
    void app.api
      .json<SessionReviewView>(`/api/plan/review?date=${date}&kind=${encodeURIComponent(s.kind)}`)
      .then((r) => {
        review.replaceChildren(el("h3", {}, "How it went"), ...reviewContent(r));
        review.hidden = false;
      })
      .catch(() => {});
  const canMark = !a && !s.manual && (s.status === "missed" || s.status === "today");
  const lift = liftButton(s, date, today);
  lift?.addEventListener("click", close);
  // A strength session ticks itself off when its log is finished: Mark done stays for one done elsewhere.
  const markBtn = canMark ? el("button", { type: "button", class: lift ? "btn text" : "btn tonal" }, icon("check", "ic sm"), lift ? "Mark done without logging" : "Mark done") : null;
  if (markBtn) markBtn.onclick = () => void mark(markBtn, s, date, true).then(close);
  const undo = s.manual ? el("button", { type: "button", class: "text-btn" }, "Undo") : null;
  if (undo) undo.onclick = () => void mark(undo, s, date, false).then(close);
  const askBtn = el("button", { type: "button", class: `btn ${lift ? "tonal" : "filled"} session-ask` }, icon("coach", "ic sm"), "Ask your coach");
  askBtn.onclick = () => {
    close();
    ask(s, date);
  };
  // For any watch's app (Garmin, Coros…): the session as a .fit workout file.
  const fitBtn = s.status !== "done" && s.kind !== "rest" && date >= today ? el("button", { type: "button", class: "btn text" }, icon("share", "ic sm"), "Save as a .fit workout") : null;
  if (fitBtn) fitBtn.onclick = () => act(fitBtn, "Workout file", async () => notify(`Saved ${await shareSessionFile(date, s.kind)}. Open it in your watch's app.`));
  const did = a
    ? el(
        "button",
        {
          type: "button",
          class: "plan-did",
          onclick: () => {
            close();
            hooks.openActivity(a.id);
          },
        },
        icon("check", "ic xs"),
        `Did ${[a.distance_km ? `${num(a.distance_km, 1)} km` : "", fmtDuration(a.moving_min)].filter(Boolean).join(" · ") || (a.name ?? a.sport)}`,
        icon("chevron", "ic xs"),
      )
    : null;
  const when = date === today ? "Today" : `${dayName(day(date))} ${dateShort(day(date))}`;
  dialog.append(
    el(
      "div",
      { class: `sheet-body k-${s.kind}` },
      el("div", { class: "grabber", "aria-hidden": "true" }),
      el(
        "header",
        { class: "session-head" },
        el("span", { class: "kind-dot", "aria-hidden": "true" }),
        el("div", {}, el("h2", { id: "session-title" }, s.title), el("p", { class: "session-when" }, `${when} · ${KIND_LABEL[s.kind]}`)),
        el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close")),
      ),
      stats.length ? el("dl", { class: "kpis session-kpis" }, ...stats) : null,
      s.target ? el("p", { class: "session-target" }, el("span", {}, "Target"), s.target) : null,
      s.adjusted ? adjustedNote(s, date, close) : null,
      steps,
      s.notes ? el("p", { class: "session-notes" }, s.notes) : null,
      s.kind === "strength" || s.exercises?.length ? strengthSection(s) : null,
      onWatch ? el("p", { class: "on-watch" }, icon("watch", "ic xs"), "On your watch as a guided workout") : null,
      did,
      s.manual ? el("p", { class: "plan-manual" }, icon("check", "ic xs"), "Marked done by you", undo) : null,
      review,
      el("div", { class: "session-actions" }, lift, markBtn, askBtn, fitBtn),
    ),
  );
  document.body.append(dialog);
  dragToClose(dialog);
  dialog.showModal();
}

type SessionReviewView =
  | { error: string }
  | {
      title: string;
      summary: string;
      inRange: number | null;
      steps: Array<{ label: string; kind: string; target: string; actual: string; inRange: number | null; verdict: string; off: string; seconds: number; metres: number }>;
    };

const VERDICT: Record<string, string> = { "on target": "On target", fast: "Fast", slow: "Slow", high: "High", low: "Low", "no data": "No data", "not done": "Not done", done: "Done" };

/** The review: one line, then each step with its target, what was done and the verdict. */
function reviewContent(r: SessionReviewView): Node[] {
  if ("error" in r) return [el("p", { class: "sub" }, `Can't compare this one: ${r.error}.`)];
  const len = (st: { seconds: number; metres: number }) => (st.metres >= 950 ? `${num(st.metres / 1000, 2)} km` : st.seconds ? fmtDuration(st.seconds / 60) : "");
  return [
    el("p", { class: "plan-review-summary" }, r.summary, r.inRange !== null ? el("span", { class: "sub" }, ` ${Math.round(r.inRange * 100)}% of the time in range.`) : null),
    el(
      "ol",
      { class: "plan-review-steps" },
      ...r.steps.map((st) =>
        el(
          "li",
          { class: `v-${st.verdict.replace(/ /g, "-")}` },
          el("span", { class: "rv-label" }, st.label, el("span", { class: "sub" }, [len(st), st.target].filter(Boolean).join(" · "))),
          el("span", { class: "rv-actual" }, st.actual || "–"),
          el("span", { class: "rv-verdict" }, VERDICT[st.verdict] ?? st.verdict, st.off ? el("span", { class: "sub" }, ` ${st.off}`) : null),
        ),
      ),
    ),
  ];
}

function weekDays(w: PlanWeek, today: string, mark: Mark, ask: Ask, onWatch: Set<string> = new Set()): HTMLElement {
  return el(
    "ol",
    { class: "plan-days" },
    ...w.days.map((d, i) => {
      const work = d.sessions.filter((s) => s.kind !== "rest");
      const rest = !work.length && !d.extra.length;
      return el(
        "li",
        { class: `plan-day${d.date === today ? " today" : ""}${rest ? " rest" : ""}${d.date < today ? " past" : ""}`, style: `--i:${i}` },
        el("span", { class: "plan-date" }, el("span", {}, dayName(day(d.date))), el("b", {}, String(day(d.date).getDate()))),
        el(
          "div",
          { class: "plan-day-body" },
          ...(rest ? [el("span", { class: "plan-rest" }, "Rest")] : work.map((s) => sessionRow(s, d.date, today, mark, ask, onWatch.has(`${d.date}:${s.kind}`)))),
          ...d.extra.map((a) =>
            el("button", { type: "button", class: "plan-extra", onclick: (e: Event) => hooks.openActivity(a.id, e.currentTarget as HTMLElement) }, icon("plus", "ic xs"), `Extra: ${a.name ?? a.sport}${a.distance_km ? ` · ${num(a.distance_km, 1)} km` : ""}`),
          ),
        ),
      );
    }),
  );
}

function weekCard(w: PlanWeek, today: string, title: string, mark: Mark, ask: Ask, onWatch: Set<string> = new Set()): HTMLElement {
  return el(
    "section",
    { class: "card plan-week", "data-reveal": "" },
    el(
      "div",
      { class: "card-head" },
      el("div", { class: "plan-week-title" }, el("h2", {}, title), el("p", { class: "sub" }, meta(range(w.start), weekKm(w) ? `${num(weekKm(w), 0)} km` : null, weekMinutes(w) ? fmtDuration(weekMinutes(w)) : null))),
    ),
    w.focus ? el("p", { class: "plan-focus" }, w.focus) : null,
    weekDays(w, today, mark, ask, onWatch),
  );
}

/**
 * Every week at a glance: dates, focus, volume (a bar on one scale, so the build, the easier
 * weeks and the taper show as a shape), and a dot per day coloured by session, ticked when done.
 */
function wholePlan(v: PlanView, mark: Mark, ask: Ask): HTMLElement {
  const byKm = v.weeks.every((w) => (w.target_km ?? w.planned.km) > 0);
  const vol = (w: PlanWeek) => (byKm ? (w.target_km ?? w.planned.km) : (w.target_hours ? w.target_hours * 60 : w.planned.minutes));
  const max = Math.max(1, ...v.weeks.map(vol));
  const target = v.plan?.target_date;
  return el(
    "section",
    { class: "card whole-plan", "data-reveal": "" },
    el("div", { class: "card-head" }, el("div", {}, el("h2", {}, "The whole plan"), el("p", { class: "sub" }, `${v.weeks.length} weeks · tap a week for its days`))),
    el(
      "ol",
      { class: "week-rows" },
      ...v.weeks.map((w, i) => {
        const raceWeek = w.days.some((d) => d.sessions.some((s) => s.kind === "race")) || (!!target && target >= w.start && target <= w.days[6]!.date);
        const dots = el(
          "span",
          { class: "wr-dots", "aria-hidden": "true" },
          ...w.days.map((d) => {
            const s = d.sessions.find((x) => x.kind !== "rest");
            return el("i", { class: s ? `k-${s.kind} s-${s.status}` : "rest" });
          }),
        );
        const state =
          w.when === "past" ? `${w.done.sessions} of ${w.planned.sessions} done` : w.when === "current" ? `This week · ${w.done.sessions} of ${w.planned.sessions} done` : `${w.planned.sessions} sessions`;
        const row = el(
          "details",
          { class: `week-row ${w.when}${raceWeek ? " race" : ""}` },
          el(
            "summary",
            {},
            el("span", { class: "wr-n" }, String(i + 1)),
            el(
              "span",
              { class: "wr-main" },
              el("span", { class: "wr-top" }, el("b", {}, w.focus), raceWeek ? el("span", { class: "status-pill today" }, "Race week") : null),
              el("span", { class: "sub" }, meta(range(w.start), byKm ? `${num(vol(w), 0)} km` : fmtDuration(vol(w)), state)),
              el("span", { class: "wr-bar" }, el("span", { style: `width:${Math.max(4, Math.round((vol(w) / max) * 100))}%` })),
            ),
            dots,
          ),
          weekDays(w, v.today, mark, ask),
        );
        return el("li", {}, row);
      }),
    ),
  );
}

// ------------------------------------------------------------------ change plan: ill, away, busy

type Life = "ill" | "better" | "away" | "busy";
const LIFE_IC: Record<Life, string> = { ill: "heart", better: "check", away: "route", busy: "clock" };
const LIFE_TITLE: Record<Life, string> = { ill: "Ill", better: "Back after being ill", away: "Away", busy: "A busy week" };
const LIFE_GO: Record<Life, string> = { ill: "Rest until I'm better", better: "Ease me back in", away: "Change my plan", busy: "Make this week shorter" };
/** The days a "how long were you ill" choice stands for, and its words. */
const ILL_FOR: Array<[number, string]> = [[3, "A few days"], [7, "About a week"], [14, "Longer"]];

/** A short sheet (phone) or panel (desktop) of its own, closed by its button, a tap outside or Escape. */
function smallSheet(label: string): { dialog: HTMLDialogElement; body: HTMLElement; close: () => void } {
  const dialog = el("dialog", { class: "sheet life-sheet", "aria-label": label });
  const close = () => {
    if (!dialog.open) return;
    dialog.classList.add("closing");
    setTimeout(() => dialog.close(), 240);
  };
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => e.target === dialog && close());
  const body = el("div", { class: "sheet-body" });
  dialog.append(body);
  return { dialog, body, close };
}

const sheetHead = (title: string, sub: string | null, close: () => void) =>
  el(
    "header",
    { class: "sheet-head life-head" },
    el("div", {}, el("h2", {}, title), sub ? el("p", { class: "sub" }, sub) : null),
    el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close")),
  );

/**
 * Something came up (src/life.ts): one tonal button beside This week / Whole plan ("Change plan",
 * or "Feeling better?" while you're ill) opens a sheet with ill, better again, away and a busy
 * week; each shows the choice it needs and changes the plan by Tartan's rules, taken at once with
 * Undo on the plan. As on the phone (CoachLife.kt).
 */
function lifeButton(v: PlanView, changed: () => void): HTMLElement {
  const ill = v.life?.ill?.from ?? null;
  const button = el("button", { type: "button", class: "btn tonal small life-btn" }, icon(ill ? "heart" : "clock", "ic sm"), ill ? "Feeling better?" : "Change plan");
  button.onclick = () => {
    const { dialog, body, close } = smallSheet(ill ? "Feeling better?" : "Change plan");
    const menu = () => {
      const order: Life[] = ill ? ["better", "away", "busy"] : ["ill", "better", "away", "busy"];
      const label = (l: Life) => (l === "ill" ? "I'm ill" : l === "better" ? (ill ? "Better now" : "I was ill") : l === "away" ? "I'm away" : "Busy week");
      body.replaceChildren(
        el("div", { class: "grabber", "aria-hidden": "true" }),
        sheetHead(ill ? "Feeling better?" : "Something came up?", ill ? `Ill since ${dateShort(day(ill))}.` : null, close),
        el(
          "ul",
          { class: "rows inset life-rows" },
          ...order.map((l) => el("li", {}, el("button", { type: "button", class: "row", onclick: () => open(l) }, el("span", { class: "row-ic" }, icon(LIFE_IC[l])), el("span", { class: "row-main" }, el("b", { class: "row-title" }, label(l))), icon("chevron", "ic chev")))),
        ),
      );
    };
    const open = (l: Life) => {
      const since = ill ? Math.round((Date.parse(`${v.today}T12:00:00`) - Date.parse(`${ill}T12:00:00`)) / 86400_000) : null;
      let illFor = since === null ? 0 : Math.max(0, ILL_FOR.findIndex(([d]) => since <= d));
      if (since !== null && since > 14) illFor = 2;
      let away = 0;
      let easy = false;
      const words = el("p", { class: "sub" });
      const say = () =>
        (words.textContent =
          l === "ill" ? "Rest for today and the next two days. When you feel better, tap Better now and the plan eases you back in."
          : l === "better" ? ["Three days of easy running, a little shorter, the long run an hour at most. Then the plan as it was.", "A week of easy running: half length for three days (no gym), then three quarters. Then the plan as it was.", "Two weeks of easy running: the first at half length (no gym), the second at three quarters. Then the plan as it was."][illFor]!
          : l === "away" ? (easy ? "Easy runs only while you're away: hard sessions become easy runs, the long run 75 minutes at most, no gym." : "No training while you're away. After a week or more, two easy days when you're back.")
          : "The rest of this week shorter: easy runs at about 60%, the long run at 75%, hard sessions kept. With more than three runs left, the shortest easy one goes.");
      const seg = (name: string, options: string[], at: number, pick: (i: number) => void) => {
        const g = el("div", { class: "segmented", role: "radiogroup", "aria-label": name });
        options.forEach((o, i) => {
          const b = el("button", { type: "button", role: "radio", class: "seg", "aria-checked": String(i === at) }, o);
          b.onclick = () => {
            g.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
            pick(i);
            say();
          };
          g.append(b);
        });
        return g;
      };
      const q = (text: string) => el("p", { class: "life-q" }, text);
      const parts: HTMLElement[] =
        l === "better" ? [q("How long were you ill?"), seg("How long were you ill", ILL_FOR.map(([, w]) => w), illFor, (i) => (illFor = i))]
        : l === "away" ? [q("When?"), seg("When", ["This week", "Next week", "Two weeks"], 0, (i) => (away = i)), q("Training while away"), seg("Training while away", ["None", "Easy runs"], 0, (i) => (easy = i === 1))]
        : [];
      say();
      const go = el("button", { type: "button", class: "btn filled" }, LIFE_GO[l]);
      go.onclick = () =>
        void act(go, "Changing the plan", async () => {
          const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
          const plus = (s: string, n: number) => iso(new Date(Date.parse(`${s}T12:00:00`) + n * 86400_000));
          const sunday = plus(v.today, (7 - new Date(`${v.today}T12:00:00`).getDay()) % 7);
          const [from, to] = away === 0 ? [v.today, sunday] : away === 1 ? [plus(sunday, 1), plus(sunday, 7)] : [v.today, plus(v.today, 13)];
          const payload = l === "better" ? { type: l, days: ILL_FOR[illFor]![0] } : l === "away" ? { type: l, from, to, train: easy ? "easy" : "none" } : { type: l };
          const res = await app.api.request("/api/plan/life", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
          const r = (await res.json()) as { said?: string; error?: string };
          if (!res.ok || r.error) throw new Error(r.error ?? `HTTP ${res.status}`);
          close();
          notify(r.said ?? "Plan changed.");
          void syncSchedule();
          changed();
        });
      body.replaceChildren(el("div", { class: "grabber", "aria-hidden": "true" }), sheetHead(LIFE_TITLE[l], null, close), ...parts, words, go);
    };
    menu();
    document.body.append(dialog);
    dragToClose(dialog);
    dialog.showModal();
  };
  return button;
}

// ------------------------------------------------------------------ the plan on your watch: one line

/**
 * The Coach tab's one quiet line about the watch: the coming week where the plan goes (Settings →
 * Sources → Plan on your watch: lib/plan-out.ts planDest), and Send. Empty when there is nothing
 * to say (no Bluetooth for a Suunto, nothing to send). As on the phone (WatchLine in CoachPlanOut.kt).
 */
function watchLine(v: PlanView, sent: () => void): HTMLElement {
  const line = el("div", { class: "watch-line", hidden: true });
  const dest = planDest();
  const show = (text: string, done: boolean, button?: { label: string; run: (b: HTMLButtonElement) => Promise<string> } | { label: string; href: string }) => {
    const words = el("span", { class: "watch-line-text", "aria-live": "polite" }, text);
    let btn: HTMLElement | null = null;
    if (button && "href" in button) btn = el("a", { class: "btn text small", href: button.href }, button.label);
    else if (button) {
      const b = el("button", { type: "button", class: "btn text small" }, button.label);
      b.onclick = () =>
        void act(b, button.label, async () => {
          const said = await button.run(b);
          success();
          notify(said);
          sent();
        });
      btn = b;
    }
    line.replaceChildren(el("span", { class: `watch-line-ic${done ? " done" : ""}`, "aria-hidden": "true" }, icon(done ? "check" : "watch", "ic sm")), words, btn ?? "");
    line.hidden = false;
  };
  if (dest === "suunto") {
    const ws = watch.canBluetooth() ? comingWeek(v) : null;
    if (!ws?.wanted.length) return line;
    const on = Math.min(ws.onWatch.size, ws.wanted.length);
    const all = on >= ws.wanted.length;
    show(`On your watch: ${on} of ${ws.wanted.length}`, all, {
      label: all ? "Send again" : "Send",
      run: async () => {
        const words = line.querySelector(".watch-line-text")!;
        const r = await sendWeek(v, (t) => (words.textContent = t));
        return r.added || r.removed ? `${r.added} on your watch${r.removed ? `, ${r.removed} old ${r.removed === 1 ? "one" : "ones"} off` : ""}. Start one from the sport mode's workout options.` : "Your watch already has the coming week.";
      },
    });
    return line;
  }
  const send = (op: PlanOutOp) => async () => (await planOut(op)).line ?? "Done.";
  void planOut("state")
    .then((s) => {
      if (!s.wanted || !line.isConnected) return;
      if (dest === "intervals") {
        if (!s.intervals.connected) show("intervals.icu isn't connected", false, { label: "Set up", href: "#settings/sources" });
        else if (s.intervals.on) show("On intervals.icu, kept up to date", true, { label: "Send again", run: send("intervals") });
        else show("Not on intervals.icu yet", false, { label: "Send", run: send("intervals") });
      } else if (dest === "hc") {
        if (s.hc.status !== "available") return;
        if (s.hc.plan) show("In Health Connect, kept up to date", true, { label: "Send again", run: send("hc") });
        else show("Not in Health Connect yet", false, { label: "Send", run: send("hc") });
      } else show("The week as .fit files", false, { label: "Save", run: send("files") });
    })
    .catch(() => {});
  return line;
}

/** The paces and heart-rate ranges the coach worked out from your data; every target comes from them. */
function zonesCard(zones: NonNullable<NonNullable<PlanView["plan"]>["zones"]>): HTMLElement {
  return el(
    "details",
    { class: "card plan-compact plan-zones", "data-reveal": "" },
    el("summary", {}, el("div", {}, el("h2", {}, "Your paces and zones"), el("p", { class: "sub" }, "Worked out from your recent runs and heart rate")), icon("chevron", "ic chev")),
    el(
      "dl",
      { class: "zone-list" },
      ...zones.map((z) => el("div", {}, el("dt", {}, z.name), el("dd", {}, [z.pace, z.heart_rate].filter(Boolean).join(" · ") || "–", z.use ? el("span", { class: "sub" }, z.use) : null))),
    ),
  );
}

function adviceCard(advice: string[]): HTMLElement {
  return el("section", { class: "card", "data-reveal": "" }, el("h2", {}, "Pointers from your coach"), el("ul", { class: "plan-advice" }, ...advice.map((a) => el("li", {}, a))));
}

// ------------------------------------------------------------------ Today's card

/**
 * Today's planned session for the Today screen: what it is, whether it's done (or a Mark done
 * button), or on a rest day what comes next. Null without a plan covering today.
 */
/** The forecast for the sessions ahead (src/weather.ts), asked once every ten minutes at most. */
let forecast: { at: number; p: Promise<UpcomingWeather> } | null = null;

/** The forecast at a session's time in one line, filled in when it comes (nothing without one). `day`: say which day. */
function sessionWeather(key: string, day?: string): HTMLElement {
  const line = el("p", { class: "plan-weather", hidden: true });
  if (!forecast || Date.now() - forecast.at > 10 * 60_000) forecast = { at: Date.now(), p: app.api.json<UpcomingWeather>("/api/weather") };
  void forecast.p
    .then((r) => {
      const w = r.sessions.find((x) => x.key === key);
      if (!w) return;
      line.classList.toggle("hot", !!w.heat.slow_pct && w.heat.slow_pct[1] >= 2);
      line.replaceChildren(icon("sun", "ic xs"), el("span", {}, `${day ? `${day} ` : "At "}${w.start.slice(11, 16)}: ${w.note}`));
      line.hidden = false;
    })
    .catch(() => (forecast = null));
  return line;
}

export function todaySessionCard(v: PlanView, changed: () => void): HTMLElement | null {
  coachBadge(!!v.proposal);
  if (!v.plan) return null;
  lifted = v.lifts ?? {};
  const week = v.weeks.find((w) => w.when === "current");
  const days = v.weeks.flatMap((w) => w.days);
  const todays = days.find((d) => d.date === v.today)?.sessions.filter((s) => s.kind !== "rest") ?? [];
  if (!week && !days.some((d) => d.date > v.today)) return null; // the plan is over
  const next = days.filter((d) => d.date > v.today).flatMap((d) => d.sessions.filter((s) => s.kind !== "rest").map((s) => ({ s, date: d.date })))[0];
  const toPlan = el("a", { class: "btn text small", href: "#coach" }, icon("plan", "ic sm"), "See the plan");

  if (!todays.length) {
    return el(
      "section",
      { class: "card today-session rest", "aria-label": "Today's session", "data-reveal": "" },
      el("h2", {}, "Rest day"),
      next ? el("p", { class: "sub" }, `Next: ${dayName(day(next.date))}, ${next.s.title}${details(next.s).length ? ` · ${details(next.s).slice(0, 2).join(" · ")}` : ""}`) : null,
      next ? sessionWeather(`${next.date}:${next.s.kind}`, dayName(day(next.date))) : null,
      toPlan,
    );
  }
  return el(
    "section",
    { class: "card today-session", "aria-label": "Today's session", "data-reveal": "" },
    ...todays.map((s) => {
      const a = s.activity;
      const lift = liftButton(s, v.today, v.today, true);
      const markBtn = !a && !s.manual && !lift ? el("button", { type: "button", class: "btn tonal small" }, icon("check", "ic sm"), "Mark done") : null;
      if (markBtn) markBtn.onclick = () => act(markBtn, "Marking it done", async () => { await markSession(v.today, s.kind, true); thud(); changed(); });
      return el(
        "div",
        { class: `today-plan k-${s.kind}` },
        el("div", { class: "today-plan-head" }, el("span", { class: "kind-dot", "aria-hidden": "true" }), el("h2", {}, s.title), s.status === "done" ? el("span", { class: "status-pill done" }, icon("check", "ic xs"), "Done") : null),
        el("p", { class: "sub" }, ["Today", KIND_LABEL[s.kind], ...details(s)].join(" · ")),
        // Which shoes, when you have more than one pair in use (src/shoes.ts pickShoe).
        v.shoe_picks?.[`${v.today}:${s.kind}`] && s.status !== "done" ? el("p", { class: "plan-shoes" }, icon("run", "ic xs"), el("span", {}, el("b", {}, v.shoe_picks[`${v.today}:${s.kind}`]!.name), ` · ${v.shoe_picks[`${v.today}:${s.kind}`]!.why}`)) : null,
        s.status !== "done" ? sessionWeather(`${v.today}:${s.kind}`) : null,
        s.notes ? el("p", { class: "plan-notes" }, s.notes) : null,
        a
          ? el("button", { type: "button", class: "plan-did", onclick: (e: Event) => hooks.openActivity(a.id, e.currentTarget as HTMLElement) }, icon("check", "ic xs"), `Did ${[a.distance_km ? `${num(a.distance_km, 1)} km` : "", fmtDuration(a.moving_min)].filter(Boolean).join(" · ")}`, icon("chevron", "ic xs"))
          : s.manual && !lift
            ? el("span", { class: "plan-manual" }, icon("check", "ic xs"), "Marked done by you")
            : null,
        el("div", { class: "row" }, lift, markBtn, toPlan.cloneNode(true)),
      );
    }),
  );
}
