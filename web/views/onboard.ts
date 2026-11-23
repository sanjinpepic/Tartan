/**
 * First run. Five short steps over the app, each doing something real: the welcome (a timing
 * board where your watch, Strava and your coach cross the line), bringing workouts in,
 * adding the coach, when you train (and reminders), and where things live. Skippable at every step, shown once, and resumed
 * where you left off when Strava's sign-in takes you out of the app and back.
 */
import { restoreForm } from "./backup.ts";
import { DONE, LAST, STEP, setWebIntro, store } from "../lib/intro.ts";
import { forgetSex } from "../lib/demo-body.ts";
import { brandMark, el, icon } from "../lib/dom.ts";
import { thud } from "../lib/haptics.ts";
import { reduced, swap } from "../lib/motion.ts";
import { allowReminders, PRESETS, syncSchedule } from "../lib/schedule.ts";
import { act, app, deviceMode, isNative, notify } from "../state.ts";
import { pairForm, pcPairCard, syncBoth } from "./pc-link.ts";
import type { ScheduleView } from "../types.ts";
import { setupCard, type CoachStatus } from "./coach.ts";
import { dataSources } from "./sync.ts";



/**
 * When you train, in one tap: a weekday time from the quick picks (or your own), the weekend
 * time, and on the phone reminders before each session (Android asks for notifications here,
 * when the reason is on screen). Saved as you choose; Settings → Training has the rest.
 */
function trainingTimes(v: ScheduleView | null): HTMLElement[] {
  const p = v?.prefs ?? { weekday: "18:00", weekend: "09:00", remind: { on: false, before_min: 30 }, calendar: { on: false } };
  const save = (next: Partial<ScheduleView["prefs"]>) =>
    app.api
      .request("/api/schedule", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        void syncSchedule(true);
      })
      .catch((e) => notify(`Couldn't save: ${(e as Error).message}`, "error"));
  const weekday = el("input", { type: "time", value: p.weekday, step: "300" });
  const weekend = el("input", { type: "time", value: p.weekend, step: "300" });
  const chips = PRESETS.map(([name, t]) => el("button", { type: "button", class: "chip answer", role: "radio", "aria-checked": String(p.weekday === t), "data-t": t }, el("b", {}, name), el("span", {}, t)));
  const mark = (t: string) => chips.forEach((c) => c.setAttribute("aria-checked", String(c.dataset.t === t)));
  for (const c of chips)
    c.onclick = () => {
      weekday.value = c.dataset.t!;
      mark(c.dataset.t!);
      void save({ weekday: c.dataset.t! });
    };
  weekday.onchange = () => {
    if (!weekday.value) return;
    mark(weekday.value);
    void save({ weekday: weekday.value });
  };
  weekend.onchange = () => weekend.value && void save({ weekend: weekend.value });
  const nodes: HTMLElement[] = [
    el("div", { class: "ob-times chips", role: "radiogroup", "aria-label": "Weekdays" }, ...chips),
    el("div", { class: "grid-fields" }, el("label", { class: "field" }, el("span", {}, "Weekdays"), weekday), el("label", { class: "field" }, el("span", {}, "Weekends"), weekend)),
  ];
  if (isNative) {
    const sw = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(p.remind.on), "aria-label": "Remind me before each session" }, el("i"));
    const note = el("p", { class: "sub" }, `A notification ${p.remind.before_min} minutes before each session, with what's planned.`);
    sw.onclick = async () => {
      const on = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", String(on));
      sw.disabled = true;
      // Android asks for notifications right here, on the tap.
      if (on && !(await allowReminders().catch(() => false))) {
        sw.setAttribute("aria-checked", "false");
        note.textContent = "Notifications are off for Tartan. You can allow them later in Android's settings, then turn this on in Settings → Training.";
      } else await save({ remind: { ...p.remind, on } });
      sw.disabled = false;
    };
    nodes.push(el("section", { class: "card send-watch" }, el("div", { class: "switch-row" }, el("div", {}, el("h2", {}, "Remind me"), note), sw)));
  }
  return nodes;
}

const LANES = [
  { n: 1, name: "Watch", sub: "Straight off your wrist, over Bluetooth", hue: "var(--lane-watch)" },
  { n: 2, name: "Strava", sub: "Your whole history, every stream", hue: "var(--lane-strava)" },
  { n: 3, name: "Coach", sub: "A plan built around your week", hue: "var(--lane-agent)" },
];

/** The welcome's timing board: three lanes run to the finish line, one after another. */
/**
 * Asked only when Strava or an earlier answer hasn't said: it tunes the training-load formula
 * and who shows the exercises (web/lib/demo-body.ts). "Not saying" mixes a man and a woman.
 */
function aboutYou(p: { sex?: string } | null): HTMLElement[] {
  if (!p || p.sex) return [];
  const row = el("div", { class: "ob-sex", role: "radiogroup", "aria-label": "You are" });
  for (const [v, label] of [["M", "A man"], ["F", "A woman"], ["", "Not saying"]] as const) {
    const b = el("button", { type: "button", role: "radio", class: "chip action answer", "aria-checked": "false" }, label);
    b.onclick = () =>
      act(b, "Profile", async () => {
        forgetSex();
        await app.api.request("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sex: v || null }) });
        row.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      });
    row.append(b);
  }
  return [el("h2", { class: "ob-h2" }, "You are…"), el("p", { class: "ob-fine ob-tight" }, "For your training load, and who shows you the strength exercises."), row];
}

function board(): HTMLElement {
  return el(
    "div",
    { class: "ob-board", role: "img", "aria-label": "Your watch, Strava and your coach, side by side" },
    ...LANES.map((l, i) =>
      el(
        "div",
        { class: "ob-lane", style: `--hue:${l.hue}; --i:${i}` },
        el("span", { class: "ob-num" }, String(l.n)),
        el("span", { class: "ob-name" }, el("b", {}, l.name), el("span", {}, l.sub)),
        el("span", { class: "ob-track", "aria-hidden": "true" }, el("i", { class: "ob-runner" }), el("i", { class: "ob-flash" })),
      ),
    ),
  );
}

/** The web's intro, at a step (lib/intro.ts decides whether it shows). */
export function openIntro(start: number): void {
  const shell = [document.getElementById("main"), document.getElementById("nav"), document.getElementById("topbar")].filter((x): x is HTMLElement => !!x);
  shell.forEach((n) => (n.inert = true));
  let step = start;
  const bar = el("div", { class: "ob-progress", "aria-hidden": "true" }, ...Array.from({ length: LAST + 1 }, () => el("i", {}, el("span", {}))));
  const skip = el("button", { type: "button", class: "btn text small ob-skip" }, "Skip");
  const stage = el("div", { class: "ob-stage" });
  const back = el("button", { type: "button", class: "icon-btn tonal", "aria-label": "Back" }, el("span", { class: "flip" }, icon("chevron")));
  const next = el("button", { type: "button", class: "btn filled ob-next" });
  const root = el(
    "div",
    { class: "onboard", role: "dialog", "aria-modal": "true", "aria-labelledby": "ob-title" },
    el("header", { class: "ob-top" }, bar, skip),
    stage,
    el("footer", { class: "ob-foot" }, back, next),
  );
  document.body.append(root);
  requestAnimationFrame(() => root.classList.add("in"));

  const finish = async () => {
    store.set(DONE, "1");
    store.set(STEP, null);
    thud();
    shell.forEach((n) => (n.inert = false));
    if (!reduced()) {
      root.classList.add("out");
      await new Promise((r) => setTimeout(r, 420));
    }
    root.remove();
    if (location.hash !== "#today" && location.hash !== "") location.hash = "#today";
  };
  skip.onclick = () => void finish();

  const views: Array<() => Promise<{ title: string; nodes: Node[]; cta: string }>> = [
    async () => ({
      title: "Your training, yours to keep",
      cta: "Get started",
      nodes: [
        el("div", { class: "ob-brand" }, brandMark(), el("b", {}, "Tartan")),
        board(),
        el("h1", { id: "ob-title", tabindex: "-1" }, "Hello!"),
        el("p", { class: "ob-lede" }, "Your training, yours to keep. Is Tartan new to you?"),
        // New here, or already using Tartan on the other device: bring it all over.
        ...(!deviceMode
          ? [
              el(
                "div",
                { class: "ob-choices" },
                el("button", { type: "button", class: "ob-choice", onclick: () => void go(1) }, el("span", { class: "ob-choice-ic", "aria-hidden": "true" }, icon("spark")), el("span", {}, el("b", {}, "I'm new to Tartan"), el("span", {}, "Set me up: workouts, coach, training times")), icon("chevron", "ic sm")),
                el("button", { type: "button", class: "ob-choice", onclick: () => void fromPhone() }, el("span", { class: "ob-choice-ic", "aria-hidden": "true" }, icon("phone")), el("span", {}, el("b", {}, "I use Tartan on my phone"), el("span", {}, "Pair it with this PC and bring its data here")), icon("chevron", "ic sm")),
              ),
            ]
          : []),
        ...(deviceMode
          ? [
              el(
                "div",
                { class: "ob-choices" },
                el("button", { type: "button", class: "ob-choice", onclick: () => {
                    // New here: no PC to pair with, so Today never suggests it (Settings → More still has it).
                    store.set("freesuunto.pairhint.off", "1");
                    void go(1);
                  } }, el("span", { class: "ob-choice-ic", "aria-hidden": "true" }, icon("spark")), el("span", {}, el("b", {}, "I'm new to Tartan"), el("span", {}, "Set me up: workouts, coach, training times")), icon("chevron", "ic sm")),
                el("button", { type: "button", class: "ob-choice", onclick: () => void fromPc() }, el("span", { class: "ob-choice-ic", "aria-hidden": "true" }, icon("phone")), el("span", {}, el("b", {}, "I use Tartan on my PC"), el("span", {}, "Bring it all over: plan, coach, notes, lifts, workouts")), icon("chevron", "ic sm")),
                el("button", { type: "button", class: "ob-choice", onclick: () => void fromBackup() }, el("span", { class: "ob-choice-ic", "aria-hidden": "true" }, icon("history")), el("span", {}, el("b", {}, "I have a backup"), el("span", {}, "Restore a Tartan backup file")), icon("chevron", "ic sm")),
              ),
            ]
          : []),
        el("p", { class: "ob-fine" }, "Works with Strava on its own, or with a Suunto watch read directly over Bluetooth (unofficial; not made by or affiliated with Suunto)."),
      ],
    }),
    async () => ({
      title: "Bring in your workouts",
      cta: "Continue",
      nodes: [
        el("h1", { id: "ob-title", tabindex: "-1" }, "Bring in your workouts"),
        el("p", { class: "ob-lede" }, "Connect one or both. Strava brings your whole history; the watch gives the files it recorded. A run that's in both shows up once."),
        ...(await dataSources({ sendToStrava: false })),
        el("p", { class: "ob-fine" }, "You can do this later in Settings."),
      ],
    }),
    async () => {
      const status = await app.api.json<CoachStatus>("/api/coach/status");
      return {
        title: "Add your coach",
        cta: status.ready ? "Continue" : "Skip for now",
        nodes: [
          el("h1", { id: "ob-title", tabindex: "-1" }, "Add your coach"),
          el("p", { class: "ob-lede" }, "The coach reads your workouts, builds your plan and answers your questions. It runs on your own AI key from Anthropic or Google, so you choose the model and the bill."),
          setupCard(status, () => void go(3)),
        ],
      };
    },
    async () => ({
      title: "When do you train?",
      cta: "Continue",
      nodes: [
        el("h1", { id: "ob-title", tabindex: "-1" }, "When do you usually train?"),
        el("p", { class: "ob-lede" }, isNative ? "Your plan's sessions go at these times, and Tartan can remind you before each one." : "Your plan's sessions go at these times, and into your calendar if you like."),
        ...trainingTimes(await app.api.json<ScheduleView>("/api/schedule").catch(() => null)),
        el("p", { class: "ob-fine" }, "A day of its own, your calendar and more are in Settings → Training."),
        ...aboutYou(await app.api.json<{ sex?: string }>("/api/profile").catch(() => null)),
      ],
    }),
    async () => ({
      title: "Four places, one job each",
      cta: "Start",
      nodes: [
        el("h1", { id: "ob-title", tabindex: "-1" }, "Four places, one job each"),
        el(
          "ul",
          { class: "ob-tabs" },
          ...[
            ["today", "Today", "How you are, what's on today, and your body"],
            ["coach", "Coach", "Your plan, and a coach to ask"],
            ["list", "Activities", "Every workout once, and routes to draw for the watch"],
            ["trends", "Progress", "How your training adds up, week by week"],
          ].map(([ic, name, line], i) => el("li", { style: `--i:${i}` }, el("span", { class: "ob-tab-ic" }, icon(ic!)), el("span", {}, el("b", {}, name!), el("span", {}, line!)))),
        ),
        el("p", { class: "ob-fine" }, "Settings sit behind the sliders at the top right."),
      ],
    }),
  ];

  /** Already on a PC: pair, copy everything over, and open the app with it all here. */
  const fromPc = async () => {
    store.set(STEP, "0");
    root.dataset.step = "pc";
    next.hidden = true;
    back.hidden = false;
    bar.querySelectorAll("i").forEach((seg, i) => seg.classList.toggle("on", i === 0));
    const page = el(
      "div",
      { class: "ob-page" },
      el("h1", { id: "ob-title", tabindex: "-1" }, "Bring it over from your PC"),
      el("p", { class: "ob-lede" }, "Your phone pairs with Tartan on your PC and copies everything: workouts, plan, coach and its key, notes, lifts and morning checks. After that the two keep in step."),
      pairForm(() => void copying()),
    );
    await swap(stage, page, 1);
    (stage.querySelector("#ob-title") as HTMLElement | null)?.focus({ preventScroll: true });
  };
  /** Had Tartan before: a backup file and its passphrase bring everything back. */
  const fromBackup = async () => {
    store.set(STEP, "0");
    root.dataset.step = "pc";
    next.hidden = true;
    back.hidden = false;
    const page = el(
      "div",
      { class: "ob-page" },
      el("h1", { id: "ob-title", tabindex: "-1" }, "Restore your backup"),
      el("p", { class: "ob-lede" }, "Pick the backup file (tartan-backup-….tartan, from Drive, Files or Documents/Tartan) and give the passphrase you chose. Everything comes back: workouts, plan, coach and its key, lifts and notes."),
      restoreForm(() => {
        store.set(DONE, "1");
        store.set(STEP, null);
        location.reload();
      }),
    );
    await swap(stage, page, 1);
    (stage.querySelector("#ob-title") as HTMLElement | null)?.focus({ preventScroll: true });
  };
  /** On the PC, already using Tartan on the phone: pair it here (a code and a QR code), the phone sends its data. */
  const fromPhone = async () => {
    store.set(STEP, "0");
    root.dataset.step = "pc";
    back.hidden = false;
    next.hidden = false;
    next.textContent = "Done";
    next.onclick = () => void finish().then(() => location.reload());
    const page = el(
      "div",
      { class: "ob-page" },
      el("h1", { id: "ob-title", tabindex: "-1" }, "Pair your phone"),
      el("p", { class: "ob-lede" }, "Install Tartan on your phone, choose I use Tartan on my PC, and scan this code with it: the two pair and bring each other up to date. From then on they keep in step, end to end encrypted."),
      pcPairCard(true),
    );
    await swap(stage, page, 1);
  };
  const copying = async () => {
    back.hidden = true;
    const box = el("div", { class: "copy-box" });
    const page = el("div", { class: "ob-page" }, el("h1", { id: "ob-title", tabindex: "-1" }, `Bringing it over from ${app.link?.name ?? "your PC"}`), el("p", { class: "ob-lede" }, "Both end up at the latest, sealed end to end on the way. Keep the app open; a big history takes a minute."), box);
    await swap(stage, page, 1);
    try {
      const r = await syncBoth(box);
      const o = await app.api.json<{ activities?: { total?: number } }>("/api/library/overview").catch(() => null);
      const [plan, coach] = await Promise.all([app.api.json<{ plan: { title: string } | null }>("/api/plan").catch(() => null), app.api.json<CoachStatus>("/api/coach/status").catch(() => null)]);
      const fact = (ok: boolean, text: string) => el("li", { class: ok ? "ok" : "" }, icon(ok ? "check" : "info", "ic sm"), text);
      const done = el(
        "div",
        { class: "ob-page" },
        el("h1", { id: "ob-title", tabindex: "-1" }, "All here"),
        el("p", { class: "ob-lede" }, `${r.pulled.toLocaleString()} files from ${app.link?.name ?? "your PC"}${r.pushed ? `, ${r.pushed.toLocaleString()} sent to it` : ""}.`),
        el(
          "ul",
          { class: "ob-facts" },
          fact(!!o?.activities?.total, o?.activities?.total ? `${o.activities.total.toLocaleString()} workouts` : "No workouts yet"),
          fact(!!plan?.plan, plan?.plan ? `Your plan: ${plan.plan.title}` : "No plan yet: your coach makes one on the Coach tab"),
          fact(!!coach?.ready, coach?.ready ? "Your coach, with its key" : "Add your coach's key in Settings → Coach (the PC's came from its environment, not its settings)"),
          fact(false, "Connect Strava on this phone in Settings → Sources: one tap, your app's details came over (each device signs in itself)"),
        ),
      );
      await swap(stage, done, 1);
      next.hidden = false;
      next.textContent = "Open Tartan";
      next.onclick = () => {
        void finish().then(() => location.reload());
      };
    } catch (e) {
      notify(`Copying from your PC stopped: ${(e as Error).message}. Try again; what came over is kept.`, "error");
      back.hidden = false;
    }
  };

  const go = async (to: number) => {
    if (to > LAST) return finish();
    const dir: -1 | 0 | 1 = to > step ? 1 : to < step ? -1 : 0;
    step = to;
    store.set(STEP, String(step));
    const v = await views[step]!();
    bar.querySelectorAll("i").forEach((seg, i) => seg.classList.toggle("on", i <= step));
    back.hidden = step === 0;
    next.textContent = v.cta;
    // The welcome asks first (new, or from the other device): its choices are the way on.
    next.hidden = step === 0;
    next.onclick = () => {
      thud();
      void go(step + 1);
    };
    root.dataset.step = String(step);
    const page = el("div", { class: "ob-page" }, ...v.nodes);
    await swap(stage, page, dir);
    stage.scrollTop = 0;
    (stage.querySelector("#ob-title") as HTMLElement | null)?.focus({ preventScroll: true });
  };
  next.onclick = () => {
    thud();
    void go(step + 1);
  };
  back.onclick = () => void go(root.dataset.step === "pc" ? 0 : step - 1);
  void go(step);
}

setWebIntro(openIntro);
