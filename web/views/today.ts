/** Today: how you are right now. Readiness in plain words, the last workout, this week so far. */
import { stackBar } from "../lib/charts.ts";
import { dateLong, dateShort, dayName, el, fmtClock, fmtDuration, icon, num } from "../lib/dom.ts";
import { countUp, revealOnScroll } from "../lib/motion.ts";
import { act, app, deviceMode, isNative, lastThenFresh, notify } from "../state.ts";
import type { PlanView, PlanWeek, Takeaway, Targets, TodayView } from "../types.ts";
import { activityRow } from "./activities.ts";
import { vitalsStrip } from "./health.ts";
import { evenSplits, raceWeek, type RaceWeek } from "../../src/race-week.ts";
import { putWorkout } from "../watch.ts";
import { todaySessionCard } from "./plan.ts";
import { runFinish } from "./finish.ts";
import { dragToClose } from "./detail.ts";
import { scanAndPair } from "../lib/pairing.ts";
import { shoesNote } from "./shoes.ts";
import { feelingLine } from "./notes.ts";
import { areaName, areaPicker } from "../lib/areas.ts";
import type { PainArea } from "../../src/readiness.ts";

export function largeTitle(title: string, sub?: string | Node, actions?: HTMLElement): HTMLElement {
  return el("header", { class: "large-title" }, el("div", {}, el("h1", { id: "view-title", tabindex: "-1" }, title), sub ? el("p", { class: "sub" }, sub) : null), actions ?? null);
}

const PAIR_HINT = "freesuunto.pairhint.off";
/** New: phone and PC as one. Once, on a phone not paired with a PC, until dismissed or paired. */
function pairHint(): HTMLElement | null {
  try {
    if (!deviceMode || app.link || localStorage.getItem(PAIR_HINT)) return null;
  } catch {
    return null;
  }
  const close = el("button", { type: "button", class: "icon-btn", "aria-label": "Dismiss" }, icon("close", "ic sm"));
  const card = el(
    "section",
    { class: "card pair-hint", "data-reveal": "" },
    el("span", { class: "ob-choice-ic", "aria-hidden": "true" }, icon("phone")),
    el("div", {}, el("h2", {}, "Tartan on your PC too?"), el("p", { class: "sub" }, "Pair them: the same plan, coach, notes and lifts on both, end to end encrypted. On the PC: Settings → More → Phone app → Pair a phone, then scan its code here."), el("div", { class: "row" }, el("button", { type: "button", class: "btn tonal small", onclick: () => void scanAndPair() }, "Scan my PC's code"), el("a", { class: "btn text small", href: "#settings/more" }, "Type it instead"))),
    close,
  );
  close.onclick = () => {
    try {
      localStorage.setItem(PAIR_HINT, "1");
    } catch {
      // shows again
    }
    card.remove();
  };
  return card;
}

export async function renderToday(root: HTMLElement): Promise<void> {
  const record = el("a", { class: "btn tonal", href: "#record" }, icon("play"), "Record");
  root.replaceChildren(largeTitle("Today", dateLong(new Date()), record));
  const body = el("div", { class: "today-body" }, el("div", { class: "skeleton-card" }), el("div", { class: "skeleton-card" }));
  root.append(body);
  // Today's planned session leads when there is a plan; it arrives on its own and slots in.
  let plan: PlanView | null = null;
  let shown: TodayView | null = null;
  // What the watch measured, in the readiness card: fetched once, kept across redraws.
  const vitals = vitalsStrip();
  // Shoes, once: the pairs found on Strava, or which shoes you run in (web/views/shoes.ts).
  let shoes: HTMLElement | null = null;
  const draw = (t: TodayView, cached: boolean) => {
    shown = t;
    const worth = t.takeaways.length ? takeawayRow(t.takeaways, "Worth knowing") : null;
    const rw = t.targets?.race ? raceWeek(t.targets.race) : null;
    const race = t.targets?.race ? (rw ? raceWeekCard(t.targets.race, rw) : raceCard(t.targets.race)) : null;
    const session = plan ? todaySessionCard(plan, () => void refreshPlan()) : null;
    const planWeek = plan?.weeks.find((w) => w.when === "current");
    // One thing leads, by the moment: just back from a run, how it went; otherwise today's
    // session and how you are. The rest follows; the PC suggestion comes last of all.
    const ready = readinessCard(t.readiness, () => void refreshPlan(), vitals);
    const last = lastCard(t.last);
    const week = weekCard(t.week, t.targets, planWeek);
    const hint = pairHint();
    const order = justIn(t.last)
      ? [last, session, race && rw ? race : null, ready, race && !rw ? race : null, week]
      : [session, race && rw ? race : null, ready, race && !rw ? race : null, el("div", { class: "grid-2" }, last, week)];
    body.replaceChildren(...order.filter((x): x is HTMLElement => !!x), ...(worth ? [worth] : []), ...(shoes ? [shoes] : []), ...(hint ? [hint] : []));
    if (cached || !body.dataset.drawn) revealOnScroll(body);
    body.dataset.drawn = "1";
  };
  const refreshPlan = async () => {
    plan = await app.api.json<PlanView>("/api/plan").catch(() => null);
    if (shown && body.isConnected) draw(shown, false);
  };
  void refreshPlan();
  void shoesNote().then((n) => {
    shoes = n;
    if (n && shown && body.isConnected) draw(shown, false);
  });
  await lastThenFresh<TodayView>("/api/today", draw);
}

// ------------------------------------------------------------------ readiness

const SCALE = [
  { state: "tired", label: "Tired" },
  { state: "building", label: "Building" },
  { state: "steady", label: "Balanced" },
  { state: "fresh", label: "Fresh" },
  { state: "rested", label: "Rested" },
] as const;

interface ReadinessView {
  date: string;
  checkin: { sleep?: 1 | 2 | 3; legs?: 1 | 2 | 3; pain?: { area: string; level: 1 | 2 | 3 } } | null;
  /** Last night as the watch measured it, minutes: then sleep isn't asked. */
  sleep_measured: number | null;
  readiness: { level: "ready" | "go easy" | "rest"; reasons: string[] };
  session: { title: string; kind: string; hard: boolean; done: boolean; swapped_from?: string; swap_kind?: string } | null;
  suggest_swap: boolean;
}

/**
 * The morning check: how your legs feel (and how you slept, when the watch didn't measure the
 * night), then the verdict with your training load; on a bad day with a hard session planned,
 * the offer to swap it for an easy run. Answered already: just the verdict, with Change.
 */
function morningCheck(planChanged: () => void, onVerdict: (r: ReadinessView) => void = () => {}): HTMLElement {
  const box = el("div", { class: "morning", "aria-live": "polite" });
  // Folded to the verdict when today's check was done before this screen opened.
  let open: boolean | null = null;
  let painOpen = false;
  let painArea: string | null = null;
  const paint = (r: ReadinessView) => {
    open ??= !r.checkin;
    onVerdict(r);
    const measured = r.sleep_measured !== null;
    const send = (next: object, b: HTMLButtonElement) =>
      act(b, "Morning check", async () => {
        const res = await app.api.request("/api/readiness", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
        paint((await res.json()) as ReadinessView);
      });
    const base = () => ({ ...(measured || !r.checkin?.sleep ? {} : { sleep: r.checkin.sleep }), ...(r.checkin?.legs ? { legs: r.checkin.legs } : {}), ...(r.checkin?.pain ? { pain: r.checkin.pain } : {}) });
    const row = (label: string, key: "sleep" | "legs", words: [string, string, string]) =>
      el(
        "div",
        { class: `morning-row${measured ? " solo" : ""}`, role: "radiogroup", "aria-label": label },
        measured ? null : el("span", { class: "morning-label" }, label),
        ...words.map((w, i) => {
          const v = (i + 1) as 1 | 2 | 3;
          const b = el("button", { type: "button", role: "radio", class: "chip action answer", "aria-checked": String(r.checkin?.[key] === v) }, w);
          b.onclick = () =>
            act(b, "Morning check", async () => {
              const next = { ...base(), [key]: v };
              const res = await app.api.request("/api/readiness", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
              paint((await res.json()) as ReadinessView);
            });
          return b;
        }),
      );
    const verdict = r.checkin
      ? el(
          "p",
          { class: `morning-verdict level-${r.readiness.level.replace(" ", "-")}` },
          el("b", {}, r.readiness.level === "ready" ? "Ready for today." : r.readiness.level === "rest" ? "Rest or go very easy today." : "Go easy today."),
          r.readiness.reasons.length ? ` ${r.readiness.reasons.join(", ").replace(/^./, (c) => c.toUpperCase())}.` : "",
        )
      : null;
    const s = r.session;
    let action: HTMLElement | null = null;
    if (s?.swapped_from && !s.done) {
      const undo = el("button", { type: "button", class: "btn text small" }, "Undo the swap");
      undo.onclick = () =>
        act(undo, "Swap", async () => {
          const res = await app.api.request("/api/plan/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: r.date, kind: s.swap_kind, undo: true }) });
          paint((await res.json()) as ReadinessView);
          planChanged();
        });
      action = el("p", { class: "sub" }, `${s.swapped_from} is swapped for an easy run today. `, undo);
    } else if (r.suggest_swap && s) {
      const swap = el("button", { type: "button", class: "btn tonal small" }, `Swap ${s.title} for an easy run`);
      swap.onclick = () =>
        act(swap, "Swap", async () => {
          const res = await app.api.request("/api/plan/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: r.date, kind: s.kind, reason: r.readiness.reasons.join(", ") || "a hard day" }) });
          const next = (await res.json()) as ReadinessView & { error?: string };
          if (!res.ok) throw new Error(next.error ?? `HTTP ${res.status}`);
          paint(next);
          planChanged();
        });
      action = el("div", { class: "row" }, swap);
    }
    if (!open && r.checkin) {
      // Folded: the verdict is the card's headline now; here, just what you said, to change.
      const change = el("button", { type: "button", class: "text-btn morning-change" }, "Change");
      change.onclick = () => {
        open = true;
        paint(r);
      };
      const said = r.readiness.reasons.length ? r.readiness.reasons.join(", ") : "all good";
      box.replaceChildren(el("p", { class: "morning-said" }, el("span", {}, `Morning check: ${said}.`), " ", change), ...(action ? [action] : []));
      return;
    }
    // Something hurts: where, then how much. Folded to a link (or what was said) otherwise.

    const LEVELS: Array<[1 | 2 | 3, string]> = [[1, "A niggle"], [2, "Sore"], [3, "Painful"]];
    const pain = r.checkin?.pain;
    let painPart: HTMLElement;
    if (painOpen) {
      const areas = areaPicker((painArea ?? pain?.area ?? null) as PainArea | null, (a) => {
        painArea = a;
        paint(r);
      }, "Where it hurts");
      const levels = el("div", { class: "morning-row solo", role: "radiogroup", "aria-label": "How much" }, ...LEVELS.map(([v, label]) => {
        const b = el("button", { type: "button", role: "radio", class: "chip action answer", "aria-checked": String(pain?.level === v && (painArea ?? pain.area) === pain.area) }, label);
        b.disabled = !(painArea ?? pain?.area);
        b.onclick = () => {
          painOpen = false;
          void send({ ...base(), pain: { area: painArea ?? pain!.area, level: v } }, b);
        };
        return b;
      }));
      const none = el("button", { type: "button", class: "text-btn" }, "Nothing hurts");
      none.onclick = () => {
        painOpen = false;
        painArea = null;
        void send({ ...base(), pain: null }, none);
      };
      painPart = el("div", { class: "pain" }, el("div", { class: "pain-step" }, el("span", { class: "field-label" }, "Where does it hurt?"), areas), el("div", { class: "pain-step" }, el("span", { class: "field-label" }, "How much?"), levels), none);
    } else {
      const link = el("button", { type: "button", class: "text-btn pain-link" }, pain ? `${areaName(pain.area as PainArea)}: ${LEVELS.find(([v]) => v === pain.level)?.[1].toLowerCase()} · Change` : "Something hurts?");
      link.onclick = () => {
        painOpen = true;
        paint(r);
      };
      painPart = el("div", { class: "pain" }, link);
    }
    box.replaceChildren(
      el("h3", {}, measured ? "How do your legs feel?" : "Morning check"),
      ...(measured ? [] : [row("Sleep", "sleep", ["Badly", "OK", "Well"])]),
      row("Legs", "legs", ["Heavy", "Normal", "Fresh"]),
      painPart,
      ...(verdict ? [verdict] : []),
      ...(action ? [action] : []),
    );
  };
  void app.api.json<ReadinessView>("/api/readiness").then(paint).catch(() => box.remove());
  return box;
}

/** The way to the Body page (not a tab): from readiness here, and from Progress. */
export function bodyLink(line: string): HTMLElement {
  return el("a", { class: "body-link", href: "#you" }, el("span", { class: "row-ic", "aria-hidden": "true" }, icon("body", "ic sm")), el("span", {}, el("b", {}, "Your body"), el("small", {}, line)), icon("chevron", "ic sm chev"));
}

function readinessCard(r: TodayView["readiness"], planChanged: () => void = () => {}, vitals: HTMLElement | null = null): HTMLElement {
  const signed = (n: number) => `${n > 0 ? "+" : ""}${num(n)}`;
  const explain = el(
    "details",
    { class: "more explain" },
    el("summary", {}, "What do these numbers mean?"),
    el(
      "dl",
      { class: "explain-list" },
      el("dt", {}, el("b", {}, num(r.fitness)), " Fitness"),
      el("dd", {}, "Your average daily training effort over the last 6 weeks (effort comes from how long and how hard, by heart rate). It grows slowly when you train consistently."),
      el("dt", {}, el("b", {}, num(r.fatigue)), " Fatigue"),
      el("dd", {}, "The same average over just the last 7 days. It jumps after hard days and drops after a few easy ones."),
      el("dt", {}, el("b", {}, signed(r.form)), " Form"),
      el("dd", {}, "Fitness minus fatigue. Below −10 you're carrying tiredness from training, which is normal while building. Above +5 you're fresh. Below −30, rest."),
    ),
  );
  // One verdict per card: once the morning check says go easy or rest, that's the advice.
  const advice = el("p", { class: "readiness-advice", "aria-live": "polite" }, r.advice);
  const verdictFrom = (c: ReadinessView) => {
    const lvl = c.checkin ? c.readiness.level : "ready";
    if (lvl === "ready") return void (advice.textContent = r.advice);
    const why = c.readiness.reasons.length ? ` ${c.readiness.reasons.join(", ").replace(/^./, (x) => x.toUpperCase())}.` : "";
    advice.textContent = `${lvl === "rest" ? "Rest or go very easy today." : "Go easy today."}${why}`;
  };
  return el(
    "section",
    { class: `card readiness state-${r.state}`, "aria-label": "Readiness", "data-reveal": "" },
    el("h2", { class: "readiness-title" }, r.title),
    advice,
    r.state === "new"
      ? null
      : el(
          "ol",
          { class: "scale", "aria-label": `On a scale from tired to rested: ${r.title}` },
          ...SCALE.map((x) => el("li", { "aria-current": x.state === r.state ? "true" : undefined }, x.label)),
        ),
    el("p", { class: "sub" }, r.why),
    vitals,
    morningCheck(planChanged, verdictFrom),
    r.state === "new" ? null : explain,
    bodyLink("Muscles, sleep and vitals"),
  );
}

// ------------------------------------------------------------------ race countdown (the prediction itself is on Progress)

/**
 * In the last seven days: race week. On Today, the race, when, and today's focus; pacing, fuel
 * and the checklist open in a sheet, so the week of the race doesn't push the day off the screen.
 */
function raceWeekCard(r: NonNullable<Targets["race"]>, w: RaceWeek): HTMLElement {
  const name = r.name ?? `${num(r.distance_km, 1)} km race`;
  const when = w.days_to_go > 1 ? `in ${w.days_to_go} days` : w.days_to_go === 1 ? "tomorrow" : "today";
  const more = el("button", { type: "button", class: "btn tonal small" }, w.pacing ? "Pacing, fuel and checklist" : "Fuel and checklist");
  more.onclick = () => openRaceWeek(r, w, name, when);
  return el(
    "section",
    { class: "card race-week", "aria-label": "Race week", "data-reveal": "" },
    el("div", { class: "rw-head" }, el("div", {}, el("h2", {}, name), el("p", { class: "sub" }, w.pacing ? `Race week · ${fmtClock(w.pacing.pace_s)} /km for ${fmtClock(w.pacing.time_s)}` : "Race week")), el("b", { class: "rw-when" }, when)),
    el("div", { class: "rw-focus" }, el("h3", {}, w.focus.title), el("p", {}, w.focus.text)),
    el("div", { class: "row" }, more),
  );
}

/** Race week in full: pacing (and the pacing workout for the watch), fuel, and a checklist. */
function openRaceWeek(r: NonNullable<Targets["race"]>, w: RaceWeek, name: string, when: string): void {
  const key = `freesuunto.raceweek.${r.date ?? ""}`;
  let ticked: string[] = [];
  try {
    ticked = JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
  } catch {
    // none
  }
  const checklist = el(
    "ul",
    { class: "rw-check" },
    ...w.checklist.map((item) => {
      const box = el("input", { type: "checkbox", checked: ticked.includes(item) });
      box.onchange = () => {
        ticked = box.checked ? [...ticked, item] : ticked.filter((x) => x !== item);
        try {
          localStorage.setItem(key, JSON.stringify(ticked));
        } catch {
          // not remembered
        }
      };
      return el("li", {}, el("label", { class: "check" }, box, item));
    }),
  );
  const p = w.pacing;
  const toWatch = el("button", { type: "button", class: "btn tonal small" }, icon("watch", "ic sm"), "Pacing workout to the watch");
  toWatch.hidden = !p || !isNative;
  toWatch.onclick = () =>
    act(toWatch, "Pacing to the watch", async () => {
      const { pacingWorkout } = await import("../../src/race-pace.ts");
      await putWorkout(pacingWorkout(`${name} ${fmtClock(p!.time_s)}`.slice(0, 30), evenSplits(r.distance_km, p!.time_s)));
      notify("The pacing workout is on your watch: start it from the sport mode's workout options.");
    });
  const dialog = el("dialog", { class: "sheet rw-sheet", "aria-labelledby": "rw-title" });
  const close = () => {
    if (!dialog.open) return;
    dialog.classList.add("closing");
    setTimeout(() => dialog.close(), 240);
  };
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => e.target === dialog && close());
  dialog.append(
    el(
      "div",
      { class: "sheet-body race-week" },
      el("div", { class: "grabber", "aria-hidden": "true" }),
      el("header", { class: "sheet-head board-head" }, el("div", {}, el("h2", { id: "rw-title" }, name), el("p", { class: "sub" }, `Race week · ${when}`)), el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))),
      p
        ? el(
            "div",
            { class: "rw-pacing" },
            el("h3", {}, "Pacing"),
            el("dl", { class: "kpis" }, el("div", {}, el("dt", {}, p.from === "target" ? "Target" : "Predicted"), el("dd", {}, fmtClock(p.time_s))), el("div", {}, el("dt", {}, "Pace"), el("dd", {}, `${fmtClock(p.pace_s)} /km`)), ...p.checkpoints.slice(0, 1).map((c) => el("div", {}, el("dt", {}, `At ${num(c.at_km, c.at_km % 1 ? 1 : 0)} km`), el("dd", {}, fmtClock(c.time_s))))),
            el("p", { class: "sub" }, `${p.checkpoints.length > 1 ? `Even pace: ${p.checkpoints.map((c) => `${num(c.at_km, c.at_km % 1 ? 1 : 0)} km in ${fmtClock(c.time_s)}`).join(", ")}. ` : ""}${p.start}`),
            toWatch,
          )
        : null,
      el("div", { class: "rw-fuel" }, el("h3", {}, "Fuel"), el("ul", {}, ...[...w.fuel.before, ...w.fuel.during].map((t) => el("li", {}, t)))),
      el("div", {}, el("h3", {}, "Checklist"), checklist),
    ),
  );
  document.body.append(dialog);
  dragToClose(dialog);
  dialog.showModal();
}

function raceCard(r: NonNullable<Targets["race"]>): HTMLElement {
  const name = r.name ?? `${num(r.distance_km, 1)} km race`;
  const when = r.days_to_go === undefined ? "" : r.days_to_go > 1 ? `in ${r.days_to_go} days` : r.days_to_go === 1 ? "tomorrow" : r.days_to_go === 0 ? "today" : "done";
  const verdict =
    r.on_track === undefined ? null
    : r.on_track ? el("span", { class: "effort-pill effort-easy" }, "On track")
    // Behind target is information, not an error: say the predicted time, in a neutral pill.
    : el("span", { class: "effort-pill" }, r.predicted_s ? `Predicted ${fmtClock(r.predicted_s)}` : "Behind target");
  return el(
    "a",
    { class: "card race-card", href: "#trends", "data-reveal": "" },
    el(
      "div",
      {},
      el("h2", {}, name),
      el("p", { class: "sub" }, [`${num(r.distance_km, 1)} km`, r.date ? dateShort(new Date(r.date)) : null, r.target_s ? `target ${fmtClock(r.target_s)}` : null].filter(Boolean).join(" · ")),
      // From twelve weeks out until race week: the prediction, how it moved, the target, the taper.
      r.countdown && r.countdown.days_to_go > 7 ? el("p", {}, r.countdown.text.replace(/^.*? (?:in \d+ days|tomorrow|today)\. /, "")) : null,
    ),
    el("div", { class: "race-when" }, when ? el("b", {}, when) : null, verdict),
  );
}

// ------------------------------------------------------------------ last workout

const ZONE_COLORS = ["var(--z1)", "var(--z2)", "var(--z3)", "var(--z4)", "var(--z5)"];

/**
 * A run in the last day and a half that was a real run: it leads Today as "Just in". A recording
 * started by accident (a few metres, under a couple of minutes) isn't news.
 */
function justIn(last: TodayView["last"]): boolean {
  if (!last || !/run/i.test(last.activity.sport)) return false;
  const a = last.activity;
  return Date.now() - Date.parse(a.start) < 36 * 3600_000 && ((a.distance_km ?? 0) >= 0.5 || (a.moving_min ?? 0) >= 5);
}

function lastCard(last: TodayView["last"]): HTMLElement {
  const card = el("section", { class: "card list-card last", "data-reveal": "" }, el("div", { class: "card-head" }, el("h2", {}, "Last workout"), el("a", { href: "#activities", class: "text-btn" }, "All activities")));
  if (!last) {
    card.append(el("p", { class: "empty" }, "No workouts yet. Connect Strava or your watch in Settings."));
    return card;
  }
  card.append(el("ul", { class: "rows" }, el("li", {}, activityRow(last.activity))));
  // Just in (a run in the last day and a half): how it went, records, last time, next time.
  const fresh = justIn(last);
  if (fresh) card.querySelector("h2")!.textContent = "Just in";
  // A recording started by accident (a few metres, a minute) gets no effort or heart rate to read into.
  const trivial = (last.activity.distance_km ?? 0) < 0.5 && (last.activity.moving_min ?? 0) < 5;
  if (last.effort > 0 && !trivial) {
    card.append(
      el(
        "div",
        { class: "effort" },
        // In words first: how hard it was for you. The number (effort points) is in the sheet, explained.
        el("span", { class: `effort-pill effort-${last.label.toLowerCase().replace(/\s+/g, "-")}` }, `${last.label} effort`),
        el("p", {}, last.rank ? last.rank.replace(/^./, (c) => c.toUpperCase()) : "", last.estimated ? `${last.rank ? " · " : ""}estimated without heart rate` : ""),
      ),
    );
  }
  // How it felt, as answered on the watch: beside the effort, never folded into it.
  if (last.activity.feeling && !trivial) card.append(feelingLine(last.activity.feeling));
  const z = last.zones;
  const total = z?.reduce((n, x) => n + x.seconds, 0) ?? 0;
  if (z && total && !trivial) {
    const bar = el("div", { class: "zones compact" });
    stackBar(bar, z.map((x, i) => ({ name: `Z${x.zone} ${x.name}`, value: x.seconds, color: ZONE_COLORS[i]! })), (sec) => fmtDuration(sec / 60) || "<1 min");
    const easy = Math.round(((z[0]!.seconds + z[1]!.seconds) / total) * 100);
    // Easy is zones 1-2, the same line the readiness advice and the plan use.
    const cap = (z[1] as { bpm?: [number, number] }).bpm?.[1];
    card.append(el("h3", { class: "mini-title" }, `Heart rate: ${easy}% easy${cap ? ` (up to ${cap} bpm)` : ""}, ${100 - easy}% above`), bar);
  }
  if (fresh) card.append(runFinish(last.activity.id));
  return card;
}

// ------------------------------------------------------------------ this week

function weekCard(w: TodayView["week"], targets?: Targets, plan?: PlanWeek): HTMLElement {
  const hero = el("span", { class: "hero-figure" }, "0");
  const max = Math.max(1, ...w.days.map((d) => d.km));
  const today = new Date().toISOString().slice(0, 10);
  // The plan's week when there is one (the same number the Coach tab shows), else your own
  // target, else your usual week. Your Settings target is what the coach plans toward.
  const tw = targets?.week;
  const planKm = Math.round((plan?.planned.km || plan?.target_km || 0) * 10) / 10;
  const targetKm = planKm || tw?.target_km || 0;
  const goalKm = targetKm || w.usual_km;
  const share = goalKm > 0 ? Math.min(1, w.km / goalKm) : 0;
  const bar = el("div", { class: `progress-track${targetKm && w.km >= targetKm ? " done" : ""}`, role: "img", "aria-label": `${num(w.km, 1)} of ${num(goalKm, 1)} km` }, el("span", { style: `width:${Math.round(share * 100)}%` }));
  const toGo = targetKm
    ? w.km >= targetKm
      ? el("p", { class: "target-note done" }, icon("check", "ic sm"), planKm ? "This week's plan distance reached" : "Weekly target reached")
      : el("p", { class: "target-note" }, `${num(targetKm - w.km, 1)} km to go`, !planKm && tw ? (tw.days_left > 0 ? ` · about ${num(tw.km_per_day_needed, 1)} km a day` : " today") : "")
    : el("p", { class: "target-note" }, el("a", { href: "#settings/training", class: "text-btn" }, "Set a weekly target"));
  const planLine = plan?.planned.sessions
    ? el("p", { class: "target-note" }, el("a", { href: "#coach", class: "text-btn" }, `Plan: ${plan.done.sessions} of ${plan.planned.sessions} sessions done`))
    : null;
  const lr = targets?.long_run;
  const longLine = lr ? el("p", { class: "target-note" }, `Long run: ${num(lr.longest_km, 1)} of ${num(lr.target_km, 1)} km in the last 2 weeks`) : null;
  queueMicrotask(() => countUp(hero, w.km, (v) => num(v, 1)));
  return el(
    "section",
    { class: "card week", "data-reveal": "" },
    el("h2", {}, "This week"),
    el("div", { class: "hero" }, hero, el("span", { class: "hero-unit" }, "km"), planKm ? el("span", { class: "delta" }, `plan ${num(planKm, 0)} km`) : tw?.target_km ? el("span", { class: "delta" }, `target ${num(tw.target_km, 0)} km`) : w.usual_km > 0 ? el("span", { class: "delta" }, `usual week ${num(w.usual_km, 0)} km`) : null),
    goalKm > 0 ? bar : null,
    toGo,
    planLine,
    longLine,
    el(
      "ol",
      { class: "days", "aria-label": "Distance per day" },
      ...w.days.map((d) =>
        el(
          "li",
          { class: d.date === today ? "today" : d.future ? "future" : "", title: d.workouts ? `${num(d.km, 1)} km, ${fmtDuration(d.minutes) || "0 min"}` : "rest" },
          el("span", { class: "day-bar" }, el("i", { style: `height:${d.km ? Math.max(8, Math.round((d.km / max) * 100)) : 0}%` })),
          el("span", { class: "day-name" }, dayName(new Date(d.date + "T12:00:00")).slice(0, 2)),
        ),
      ),
    ),
    el(
      "dl",
      { class: "kpis" },
      el("div", {}, el("dt", {}, "Time"), el("dd", {}, fmtDuration(w.minutes) || "0 min")),
      el("div", {}, el("dt", {}, "Climb"), el("dd", {}, `${num(w.climb)} m`)),
      el("div", {}, el("dt", {}, "Workouts"), el("dd", {}, `${w.workouts}${tw?.target_workouts ? ` of ${num(tw.target_workouts, 0)}` : w.usual_workouts ? ` of ~${num(w.usual_workouts, 0)}` : ""}`)),
    ),
  );
}

// ------------------------------------------------------------------ takeaways

const TONE_ICON = { good: "check", watch: "warn", info: "info" } as const;
// "Heads-up", not "Watch": the watch is the device here.
const TONE_LABEL = { good: "Good", watch: "Heads-up", info: "Note" } as const;

export function takeawayRow(items: Takeaway[], title = "Takeaways"): HTMLElement {
  return el(
    "section",
    { class: "takeaways", "aria-label": title, "data-reveal": "" },
    el("h2", { class: "section-title" }, title),
    el(
      "div",
      { class: "carousel" },
      ...items.map((t) =>
        el(
          t.activity ? "button" : "div",
          { class: `takeaway tone-${t.tone}`, type: t.activity ? "button" : undefined, onclick: t.activity ? (e: Event) => openFrom(t.activity!, e) : undefined },
          el("span", { class: "tone" }, icon(TONE_ICON[t.tone], "ic sm"), TONE_LABEL[t.tone]),
          el("h3", {}, t.title),
          el("p", {}, t.detail),
        ),
      ),
    ),
  );
}

function openFrom(id: string, e: Event) {
  import("../state.ts").then(({ hooks }) => hooks.openActivity(id, e.currentTarget as HTMLElement));
}
