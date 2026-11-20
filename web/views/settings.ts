/** Settings in five groups: Sources (Strava, watch, Health Connect), Training (targets, heart rate, plan), Coach (AI key), Watch (guided workouts, the week face), More (PC, data, and under Advanced agents, the face builder, the log). */
import { Capacitor } from "@capacitor/core";
import pkg from "../../package.json";
import { publicBuild, runnerChoice, setRunnerChoice, type RunnerChoice } from "../lib/runner.ts";
import { setShellParts, shellAvailable, shellParts } from "../lib/shell.ts";
import { healthConnectCard } from "./health-connect.ts";
import { WEEKLY_OFF } from "../lib/weekly.ts";
import { demoChoice, forgetSex, setDemoChoice } from "../lib/demo-body.ts";
import { ago, el, fmtBytes, icon, page } from "../lib/dom.ts";
import { act, app, deviceMode, isNative, notify, onLog } from "../state.ts";
import type { Goals, PlanView, ScheduleView, Targets } from "../types.ts";
import { saveFile } from "../lib/files.ts";
import { armRecorder, onRecorder, shareRecording } from "../lib/blackbox.ts";
import { colourChoice, setColourChoice, wallpaperColours, type ColourChoice } from "../lib/theme.ts";
import { facesSection } from "./face.ts";
import { planWatchCard, weekFaceCard, workoutsCard } from "./watch-settings.ts";
import { reduced } from "../lib/motion.ts";
import { allowReminders, PRESETS, syncSchedule, writableCalendars } from "../lib/schedule.ts";
import { setupCard, switchRow } from "./coach.ts";
import { maybeOnboard } from "../lib/intro.ts";
import { backupCard } from "./backup.ts";
import { shoesCard } from "./shoes.ts";
import { dataSources, pcSections } from "./sync.ts";
import { largeTitle } from "./today.ts";

interface ServerInfo {
  mcpUrl: string;
  cliPath: string;
  bunPath: string;
  dataDir: string;
}

const TOOLS: Array<[string, string]> = [
  ["get_overview", "What data exists: activity counts, sources, last syncs."],
  ["get_takeaways", "The most useful things to know right now, with numbers."],
  ["list_activities", "Every workout once, filtered by date, sport or source."],
  ["get_activity", "One workout: laps, splits, best efforts, provenance."],
  ["get_activity_streams", "Heart rate, pace, cadence, power, altitude, GPS."],
  ["get_training_summary", "Totals per week, month or year."],
  ["get_training_load", "Fitness, fatigue and form from heart rate."],
  ["get_hr_zones", "Time in zones for a workout or a period."],
  ["get_efficiency_trend", "Easy-run metres per heartbeat, week by week."],
  ["get_durability", "How well the effort holds on long runs: heart-rate drift and where it starts."],
  ["get_weather", "The forecast at each planned session, with what heat costs."],
  ["get_best_efforts", "Personal bests per distance."],
  ["get_athlete_profile", "Profile, totals and heart-rate settings."],
  ["list_watch_files / read_watch_file", "Files copied off the watch."],
  ["get_week", "One week day by day against the week before."],
  ["get_training_plan", "The plan, each session done, missed or ahead."],
  ["save_training_plan", "Write or change the plan the app shows."],
  ["mark_plan_session", "Tick a session off by hand."],
  ["set_training_availability", "Days, hours and long-run day you have."],
  ["get_training_times / set_training_times", "When you usually train; reminders and calendar follow."],
  ["export_training_plan_csv / _ics / reset_training_plan", "Export the plan or its calendar, or clear it."],
  ["list_routes / get_route / save_route", "Your routes, as points or GPX; save a workout's track as a route."],
  ["list_watch_faces / save_watch_face", "Watch faces from the face builder; design one for the phone to install."],
  ["sync_strava / backup_watch", "Pull new data in."],
];

let unsubscribeLog: (() => void) | null = null;
let unsubscribeRecorder: (() => void) | null = null;

/** Settings in four groups instead of one long list; the group you were in is kept while the app is open. */
const GROUPS = [
  { id: "sources", label: "Sources", sub: "Where your workouts come from. They sync by themselves." },
  { id: "training", label: "Training", sub: "Your targets, heart rate and plan." },
  { id: "coach", label: "Coach", sub: "The AI behind your coach." },
  { id: "watch", label: "Watch", sub: "Guided workouts, your week on a face, and routes." },
  { id: "more", label: "More", sub: "Your PC and your data. AI agents, the face builder and the log are under Advanced." },
] as const;
type Group = (typeof GROUPS)[number]["id"];
let group: Group = "sources";

export async function renderSettings(root: HTMLElement): Promise<void> {
  unsubscribeLog?.();
  unsubscribeRecorder?.();
  // Back from Strava's consent page: show the sources, where the result is.
  if (/[?&]code=|strava/i.test(location.search)) group = "sources";
  // #settings/<group> opens that group (the Coach tab links to Plan changes).
  const asked = location.hash.split("/")[1];
  if (asked && GROUPS.some((g) => g.id === asked)) group = asked as Group;
  const sub = el("p", { class: "sub settings-sub" });
  root.replaceChildren(largeTitle("Settings"));
  const seg = el("div", { class: "segmented settings-seg", role: "tablist", "aria-label": "Settings" });
  const panes = new Map<Group, HTMLElement>();
  const show = (dir = 0) => {
    seg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.group === group)));
    // With large text the tabs scroll sideways: keep the chosen one in view.
    const on = seg.querySelector<HTMLElement>(`[data-group="${group}"]`);
    if (on && seg.scrollWidth > seg.clientWidth) seg.scrollTo({ left: Math.max(0, on.offsetLeft - (seg.clientWidth - on.offsetWidth) / 2), behavior: dir ? "smooth" : "instant" });
    for (const [id, pane] of panes) pane.hidden = id !== group;
    sub.textContent = GROUPS.find((g) => g.id === group)!.sub;
    // The group slides in from the side of the tab you picked.
    const pane = panes.get(group);
    if (dir && pane && !reduced()) pane.animate([{ opacity: 0, transform: `translate3d(${dir * 10}px, 0, 0)` }, { opacity: 1, transform: "none" }], { duration: 300, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  };
  for (const g of GROUPS) {
    const b = el("button", { type: "button", role: "tab", class: "seg", "data-group": g.id }, g.label);
    b.onclick = () => {
      if (group === g.id) return;
      // Tartan 2: the group is in the address, so the native Settings can take the groups it draws.
      if (shellParts().settings) {
        location.hash = `settings/${g.id}`;
        return;
      }
      const dir = GROUPS.findIndex((x) => x.id === g.id) > GROUPS.findIndex((x) => x.id === group) ? 1 : -1;
      group = g.id;
      page().scrollTo({ top: 0, behavior: "instant" });
      show(dir);
    };
    seg.append(b);
  }
  const bar = el("div", { class: "toolbar settings-bar" }, seg);
  // A hairline under the tabs once they're pinned under the top bar, like the bar's own.
  const sentinel = el("div", { "aria-hidden": "true", style: "height:1px;margin-bottom:-1px" });
  new IntersectionObserver(([e]) => bar.classList.toggle("stuck", !e!.isIntersecting), { rootMargin: "-60px 0px 0px 0px" }).observe(sentinel);
  root.append(sentinel, bar, sub);

  const [sources, pc, targets, prof, coach, info, plan, times, faces] = await Promise.all([
    dataSources(),
    pcSections(),
    app.api.json<Targets>("/api/goals"),
    app.api.json<{ max_hr: number; rest_hr: number; max_hr_source: string; sex?: string }>("/api/profile"),
    app.api.json<Parameters<typeof setupCard>[0]>("/api/coach/status"),
    deviceMode ? null : app.api.json<ServerInfo>("/api/server").catch(() => null),
    app.api.json<PlanView>("/api/plan").catch(() => null),
    app.api.json<ScheduleView>("/api/schedule").catch(() => null),
    facesSection(),
  ]);
  const [link] = pc;
  const pane = (id: Group, ...cards: Array<HTMLElement | undefined>) => {
    const p = el("div", { class: "settings-pane", role: "tabpanel", "aria-label": GROUPS.find((g) => g.id === id)!.label }, ...cards.filter((c): c is HTMLElement => !!c));
    panes.set(id, p);
    return p;
  };
  root.append(
    pane("sources", ...sources, deviceMode ? healthConnectCard() : undefined, planWatchCard()),
    pane("training", targetsSection(targets.goals), timesSection(times, !!plan?.plan), profileSection(prof), shoesCard(), demosCard(prof.sex), planSection(plan, () => void renderSettings(root))),
    pane("coach", setupCard(coach, () => void renderSettings(root)), approvalSetting(plan?.approval ?? "ask"), weeklySetting(), memoryCard()),
    pane("watch", workoutsCard(), weekFaceCard(plan), routesNote()),
    pane("more", coloursCard(), tartan2Card(), link, backupCard(), dataSection(info), advancedSection(info, faces)),
  );
  show();
}

// ------------------------------------------------------------------ the training plan: export, reset

function planSection(v: PlanView | null, changed: () => void): HTMLElement {
  const sec = el("section", { class: "card" }, el("h2", {}, icon("plan", "ic"), "Training plan"));
  if (!v?.plan) {
    sec.append(el("p", { class: "sub" }, "No plan yet. Your coach makes one on the Coach tab."), el("div", { class: "row" }, el("a", { class: "btn tonal", href: "#coach" }, icon("coach"), "Go to Coach")));
    return sec;
  }
  const p = v.plan;
  const exportBtn = el("button", { type: "button", class: "btn tonal" }, icon("down", "ic sm"), "Export as CSV");
  exportBtn.onclick = () =>
    act(exportBtn, "Export", async () => {
      const res = await app.api.request("/api/plan/export.csv");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await saveFile(`training-plan-${v.today}.csv`, await res.text(), "text/csv");
    });
  // Two taps: the first arms it for a few seconds.
  const reset = el("button", { type: "button", class: "btn text danger" }, "Reset plan");
  let armed = 0;
  reset.onclick = () => {
    if (!armed) {
      reset.textContent = "Tap again to clear the plan";
      reset.classList.add("armed");
      armed = window.setTimeout(() => {
        armed = 0;
        reset.textContent = "Reset plan";
        reset.classList.remove("armed");
      }, 4000);
      return;
    }
    clearTimeout(armed);
    void act(reset, "Reset", async () => {
      await app.api.request("/api/plan/reset", { method: "POST" });
      void syncSchedule();
      notify("Plan cleared. Your coach can make a new one on the Coach tab.");
      changed();
    });
  };
  sec.append(
    el("p", { class: "sub" }, `${p.title} · ${v.weeks.length} week${v.weeks.length === 1 ? "" : "s"} · updated ${ago(new Date(p.updated))}`),
    el("div", { class: "row" }, exportBtn, reset),
    el("p", { class: "footnote" }, "The CSV has one row per session with its date, target and how it went; it opens in any spreadsheet. Resetting keeps the old plan in your data folder and the sessions you ticked off."),
  );
  return sec;
}

function routesNote(): HTMLElement {
  return el("section", { class: "card" }, el("h2", {}, icon("route", "ic"), "Routes"), el("p", { class: "sub" }, "Draw a route under Activities → Routes; Send to watch puts it on your watch, with a prompt at every turn (left, right, sharp, turn around)."), el("div", { class: "row" }, el("a", { class: "btn tonal", href: "#routes" }, "Open Routes")));
}

// ------------------------------------------------------------------ training times: reminders, calendar

const DAYS: Array<[keyof NonNullable<ScheduleView["prefs"]["days"]>, string]> = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const LEADS: Array<[number, string]> = [[15, "15 minutes before"], [30, "30 minutes before"], [60, "1 hour before"], [120, "2 hours before"]];

/**
 * When you train. Every planned session gets this time (a day of your own over weekday or
 * weekend), and from it a reminder and a calendar event on the phone, or an .ics file anywhere.
 */
function timesSection(initial: ScheduleView | null, hasPlan: boolean): HTMLElement | undefined {
  if (!initial) return undefined;
  const sec = el("section", { class: "card setup times" });
  let v = initial;
  const save = async (next: Partial<ScheduleView["prefs"]>, said?: string) => {
    const res = await app.api.request("/api/schedule", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    if (!res.ok) throw new Error(`could not save (${res.status})`);
    v = (await res.json()) as ScheduleView;
    if (said) notify(said);
    void syncSchedule(true);
    draw();
  };
  const trySave = (next: Partial<ScheduleView["prefs"]>, said?: string) => void save(next, said).catch((e) => notify(`Couldn't save: ${(e as Error).message}`, "error"));
  const timeIn = (value: string, placeholder = "") => el("input", { type: "time", value, placeholder, step: "300" });
  const switchBtn = (on: boolean, label: string) => el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(on), "aria-label": label }, el("i"));

  const draw = () => {
    const p = v.prefs;
    const weekday = timeIn(p.weekday);
    const weekend = timeIn(p.weekend);
    weekday.onchange = () => weekday.value && trySave({ weekday: weekday.value }, `Weekday sessions at ${weekday.value}.`);
    weekend.onchange = () => weekend.value && trySave({ weekend: weekend.value }, `Weekend sessions at ${weekend.value}.`);
    const presets = el(
      "div",
      { class: "ob-times chips", role: "radiogroup", "aria-label": "Weekday time" },
      ...PRESETS.map(([name, t]) => {
        const c = el("button", { type: "button", class: "chip answer", role: "radio", "aria-checked": String(p.weekday === t), "aria-label": `${name} · ${t}` }, el("b", {}, name), el("span", {}, t));
        c.onclick = () => trySave({ weekday: t }, `Weekday sessions at ${t}.`);
        return c;
      }),
    );

    // A day of its own: empty means the weekday or weekend time.
    const own = Object.keys(p.days ?? {}).length;
    const dayRows = DAYS.map(([k, name]) => {
      const input = timeIn(p.days?.[k] ?? "");
      input.onchange = () => trySave({ days: { ...p.days, [k]: input.value || undefined } }, input.value ? `${name}s at ${input.value}.` : `${name}s at the ${k === "sat" || k === "sun" ? "weekend" : "weekday"} time.`);
      return el("label", { class: "field day-time" }, el("span", {}, name), input);
    });
    const days = el("details", { class: "more", open: own > 0 }, el("summary", {}, own ? `Your own time on ${own} day${own === 1 ? "" : "s"}` : "A different time on some days"), el("div", { class: "grid-fields three" }, ...dayRows));

    const next = v.slots[0];
    const preview = next
      ? el("p", { class: "footnote" }, `Next: ${next.title}, ${new Date(`${next.start}:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" })} at ${next.start.slice(11)}.`)
      : el("p", { class: "footnote" }, hasPlan ? "No sessions ahead in your plan." : "Your coach's plan will use these times.");

    const nodes: Node[] = [
      el("h2", {}, icon("clock", "ic"), "Training times"),
      el("p", { class: "sub" }, "When you usually train. Every session in your plan gets this time, for reminders and your calendar."),
      el("div", { class: "grid-fields" }, el("div", { class: "time-group" }, el("label", { class: "field" }, el("span", {}, "Weekdays"), weekday), presets), el("label", { class: "field" }, el("span", {}, "Weekends"), weekend)),
      days,
      preview,
    ];

    if (isNative) {
      // Reminders: a notification before each session.
      const rs = switchBtn(p.remind.on, "Remind me before each session");
      rs.onclick = async () => {
        rs.disabled = true;
        const on = !p.remind.on;
        rs.setAttribute("aria-checked", String(on));
        if (on && !(await allowReminders().catch(() => false))) {
          rs.setAttribute("aria-checked", "false");
          rs.disabled = false;
          return notify("Notifications are off for Tartan. Turn them on in Android's settings for the app.", "error");
        }
        trySave({ remind: { ...p.remind, on } }, on ? "Reminders on." : "Reminders off.");
      };
      const lead = el("select", { "aria-label": "When to remind you" }, ...LEADS.map(([m, label]) => el("option", { value: String(m), selected: p.remind.before_min === m }, label)));
      lead.onchange = () => trySave({ remind: { on: true, before_min: Number(lead.value) } });
      // After a session: "done? tap to bring it in" (opens the app, which syncs the watch).
      const after = p.remind.after !== false;
      const as = switchBtn(after, "Nudge me after each session");
      as.onclick = async () => {
        as.disabled = true;
        const on = !after;
        as.setAttribute("aria-checked", String(on));
        if (on && !(await allowReminders().catch(() => false))) {
          as.setAttribute("aria-checked", "false");
          as.disabled = false;
          return notify("Notifications are off for Tartan. Turn them on in Android's settings for the app.", "error");
        }
        trySave({ remind: { ...p.remind, after: on } }, on ? "Nudges after sessions on." : "Nudges after sessions off.");
      };
      nodes.push(
        el("div", { class: "switch-row" }, el("div", {}, el("h3", {}, "Remind me"), el("p", { class: "sub" }, "A notification before each session, with what's planned.")), rs),
        ...(p.remind.on ? [el("label", { class: "field" }, el("span", {}, "When"), lead)] : []),
        el("div", { class: "switch-row" }, el("div", {}, el("h3", {}, "After a session"), el("p", { class: "sub" }, "Half an hour after it should end, a tap brings the workout in from your watch (a strength session opens its log). Not sent once it's in.")), as),
      );

      // Calendar: the sessions as events in a calendar on the phone.
      const cs = switchBtn(p.calendar.on, "Add my plan to my calendar");
      const pick = async () => {
        const list = await writableCalendars().catch(() => null);
        if (!list) {
          notify("Tartan can't reach your calendar. Allow it in Android's settings for the app.", "error");
          return null;
        }
        if (!list.length) {
          notify("No calendar on this phone takes new events.", "error");
          return null;
        }
        return list;
      };
      cs.onclick = async () => {
        cs.disabled = true;
        const on = !p.calendar.on;
        cs.setAttribute("aria-checked", String(on));
        if (!on) return trySave({ calendar: { on: false } }, "Your plan's future sessions are leaving your calendar.");
        const list = await pick();
        if (!list) {
          cs.setAttribute("aria-checked", "false");
          cs.disabled = false;
          return;
        }
        const keep = list.find((c) => c.id === p.calendar.calendar_id) ?? list[0]!;
        trySave({ calendar: { on: true, calendar_id: keep.id, calendar_name: keep.title } }, `Your sessions are going into ${keep.title}.`);
      };
      nodes.push(el("div", { class: "switch-row" }, el("div", {}, el("h3", {}, "Add to my calendar"), el("p", { class: "sub" }, "Every session ahead as an event at your time. They move when the plan changes.")), cs));
      if (p.calendar.on) {
        const which = el("select", { "aria-label": "Calendar" }, el("option", { value: p.calendar.calendar_id ?? "", selected: true }, p.calendar.calendar_name ?? "Calendar"));
        // The full list once you open it (it needs calendar access, which you've given).
        void pick().then((list) => {
          if (!list) return;
          which.replaceChildren(...list.map((c) => el("option", { value: c.id, selected: c.id === p.calendar.calendar_id, ...(c.account && c.account !== c.title ? { "data-sub": c.account } : {}) }, c.title)));
          which.onchange = () => {
            const c = list.find((x) => x.id === which.value);
            if (c) trySave({ calendar: { on: true, calendar_id: c.id, calendar_name: c.title } }, `Your sessions are moving to ${c.title}.`);
          };
        });
        nodes.push(el("label", { class: "field" }, el("span", {}, "Calendar"), which));
      }
    }

    const ics = el("button", { type: "button", class: "btn tonal" }, icon("down", "ic sm"), "Calendar file (.ics)");
    ics.disabled = !v.slots.length;
    ics.onclick = () =>
      act(ics, "Calendar file", async () => {
        const res = await app.api.request("/api/plan/calendar.ics");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await saveFile(`tartan-training-${v.today}.ics`, await res.text(), "text/calendar");
      });
    nodes.push(
      el("div", { class: "row" }, ics),
      el("p", { class: "footnote" }, isNative ? "The file opens in any calendar app, on this phone or another device. Importing it again updates the sessions instead of adding them twice." : "Open the file in Google Calendar, Outlook or Apple Calendar. Importing it again updates the sessions instead of adding them twice."),
    );
    sec.replaceChildren(...nodes);
  };
  draw();
  return sec;
}

const RACES: Array<[string, number]> = [["5 km", 5], ["10 km", 10], ["Half marathon", 21.0975], ["Marathon", 42.195]];

/** "1:52:30", "52:30" or "52" (minutes) → seconds. */
function parseTime(s: string): number | undefined {
  const parts = s.trim().split(":").map(Number);
  if (!s.trim() || parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  if (parts.length === 1) return parts[0]! * 60;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return undefined;
}

function targetsSection(g: Goals): HTMLElement {
  const numIn = (v: number | undefined, step = "0.5") => el("input", { type: "number", min: "0", step, inputmode: "decimal", value: v ? String(v) : "", placeholder: "none" });
  const km = numIn(g.weekly_km, "1");
  const workouts = numIn(g.weekly_workouts, "1");
  const longRun = numIn(g.long_run_km);
  const raceName = el("input", { type: "text", value: g.race?.name ?? "", placeholder: "e.g. Göteborgsvarvet", autocomplete: "off" });
  const known = RACES.find(([, d]) => g.race && Math.abs(d - g.race.distance_km) < 0.05);
  const raceDist = el("select", {}, el("option", { value: "", selected: !g.race }, "No race"), ...RACES.map(([n, d]) => el("option", { value: String(d), selected: known?.[1] === d }, n)), el("option", { value: "other", selected: !!g.race && !known }, "Other distance"));
  const otherKm = numIn(g.race && !known ? g.race.distance_km : undefined, "0.1");
  const otherField = el("label", { class: "field" }, el("span", {}, "Race distance (km)"), otherKm);
  const raceDate = el("input", { type: "date", value: g.race?.date ?? "" });
  const fmt = (s?: number) => (!s ? "" : s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  const raceTime = el("input", { type: "text", inputmode: "numeric", value: fmt(g.race?.target_s), placeholder: "h:mm:ss" });
  const raceFields = el("div", { class: "grid-fields" }, el("label", { class: "field" }, el("span", {}, "Race name"), raceName), otherField, el("label", { class: "field" }, el("span", {}, "Date"), raceDate), el("label", { class: "field" }, el("span", {}, "Target time"), raceTime));
  const sync = () => {
    raceFields.hidden = !raceDist.value;
    otherField.hidden = raceDist.value !== "other";
  };
  raceDist.onchange = sync;
  sync();
  const save = el("button", { type: "submit", class: "btn filled" }, "Save targets");
  const form = el(
    "form",
    { class: "card setup", id: "targets" },
    el("h2", {}, icon("spark", "ic"), "Targets"),
    el("p", { class: "sub" }, "Today tracks this week against them, Progress shows how often you hit them, and the coach plans around them. Leave a field empty for no target."),
    el("div", { class: "grid-fields three" }, el("label", { class: "field" }, el("span", {}, "Distance a week (km)"), km), el("label", { class: "field" }, el("span", {}, "Workouts a week"), workouts), el("label", { class: "field" }, el("span", {}, "Long run (km)"), longRun)),
    el("label", { class: "field" }, el("span", {}, "Race"), raceDist),
    raceFields,
    el("div", { class: "row" }, save),
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    void act(save, "Saving targets", async () => {
      const distance = raceDist.value === "other" ? Number(otherKm.value) : Number(raceDist.value);
      const target = parseTime(raceTime.value);
      if (raceTime.value.trim() && target === undefined) throw new Error("Write the target time like 1:52:30 or 52:30");
      const body: Goals = {
        weekly_km: Number(km.value) || undefined,
        weekly_workouts: Number(workouts.value) || undefined,
        long_run_km: Number(longRun.value) || undefined,
        race: raceDist.value && distance > 0 ? { distance_km: distance, name: raceName.value || undefined, date: raceDate.value || undefined, target_s: target } : undefined,
      };
      const res = await app.api.request("/api/goals", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`could not save (${res.status})`);
      notify("Targets saved. Today and Progress use them now.");
    });
  };
  return form;
}

type ProfileInfo = { max_hr: number; rest_hr: number; max_hr_source: string; sex?: string; zones_source?: string; zone_limits?: number[]; watch_zones?: number[] };

function profileSection(p: ProfileInfo): HTMLElement {
  const max = el("input", { type: "number", min: "120", max: "240", value: String(p.max_hr), inputmode: "numeric" });
  const rest = el("input", { type: "number", min: "25", max: "110", value: String(p.rest_hr), inputmode: "numeric" });
  const sex = el("select", {}, el("option", { value: "", selected: !p.sex }, "Not set"), el("option", { value: "M", selected: p.sex === "M" }, "Male"), el("option", { value: "F", selected: p.sex === "F" }, "Female"));
  const save = el("button", { type: "submit", class: "btn filled" }, "Save");
  // Your own max overrides the watch's zones; this goes back to them.
  const watchZones = p.watch_zones && p.zones_source !== "your watch" ? el("button", { type: "button", class: "btn tonal" }, "Use my watch's zones") : null;
  if (watchZones) {
    watchZones.onclick = () =>
      act(watchZones, "Heart rate", async () => {
        forgetSex();
        await app.api.request("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rest_hr: Number(rest.value), sex: sex.value || null }) });
        notify("Using your watch's heart-rate zones.");
        watchZones.remove();
      });
  }
  const form = el(
    "form",
    { class: "card setup" },
    el("h2", {}, icon("heart", "ic"), "Heart rate"),
    el(
      "p",
      { class: "sub" },
      p.zones_source === "your watch"
        ? `Zones come from your watch: Z2 from ${p.zone_limits?.[0]}, Z3 ${p.zone_limits?.[1]}, Z4 ${p.zone_limits?.[2]}, Z5 ${p.zone_limits?.[3]} bpm. Max heart rate is ${p.max_hr_source}. Setting your own max here uses % of it instead.`
        : `Heart-rate zones and effort scores use these. Max heart rate is ${p.max_hr_source}.`,
    ),
    el("div", { class: "grid-fields three" }, el("label", { class: "field" }, el("span", {}, "Max heart rate"), max), el("label", { class: "field" }, el("span", {}, "Resting heart rate"), rest), el("label", { class: "field" }, el("span", {}, "Sex (sets the effort score)"), sex)),
    el("div", { class: "row" }, save, watchZones),
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    void act(save, "Saving", async () => {
      // The max is saved only when it is yours: an untouched estimate (or the watch's) stays automatic.
      const ownMax = p.max_hr_source === "set by you" || Number(max.value) !== p.max_hr;
      forgetSex();
        await app.api.request("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ max_hr: ownMax ? Number(max.value) : null, rest_hr: Number(rest.value), sex: sex.value || null }) });
      notify("Heart-rate settings saved.");
    });
  };
  return form;
}

/**
 * What most people never need, folded in one place at the bottom: AI agents over MCP and the
 * activity log. Everyday Settings stay about your sources, training, coach and watch.
 */
function advancedSection(info: ServerInfo | null, faces: HTMLElement): HTMLElement {
  return el(
    "section",
    { class: "card advanced" },
    el("h2", {}, icon("settings", "ic"), "Advanced"),
    el("p", { class: "sub" }, "For AI agents, troubleshooting and the curious."),
    el("details", { class: "more" }, el("summary", {}, icon("agent", "ic sm"), "AI agents (MCP)"), agentsSection(info)),
    // The face builder: kept, but out of the way (Settings → Watch keeps the week on a face).
    el("details", { class: "more face-builder" }, el("summary", {}, icon("watch", "ic sm"), "Watch face builder"), el("p", { class: "sub" }, "Design your own watch faces (colours, track, hands, a photo) and install them on your Suunto over Bluetooth."), faces),
    ...(publicBuild() ? [] : [runnerSection()]),
    recorderSection(),
    logSection(),
  );
}

/**
 * The owner's build only: which step runner guided workouts carry. Suunto's (captured from the
 * Suunto app) is the default and the one proven on the owner's Suunto Run 2; Tartan's own (written
 * clean-room, src/workout/runner.ts) is the only one the public build has, kept here to be tried
 * on the watch before a public release. Was in Settings → Watch until 2.57; the saved choice
 * (localStorage freesuunto.workouts.runner) is the same.
 */
function runnerSection(): HTMLElement {
  const seg = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Workout runner" });
  const draw = () => {
    const cur = runnerChoice();
    seg.replaceChildren(
      ...([["suunto", "Suunto's"], ["tartan", "Tartan's own"]] as Array<[RunnerChoice, string]>).map(([c, label]) => {
        const b = el("button", { type: "button", role: "radio", class: "seg", "aria-checked": String(cur === c) }, label);
        b.onclick = () => {
          setRunnerChoice(c);
          draw();
        };
        return b;
      }),
    );
  };
  draw();
  return el(
    "details",
    { class: "more runner-row" },
    el("summary", {}, icon("watch", "ic sm"), "Step runner"),
    el("p", { class: "sub" }, "Suunto's is proven on your watch; Tartan's own is the one the public build sends, to try."),
    seg,
  );
}

/**
 * Watch recorder (web/lib/blackbox.ts): every byte of the next connection to the watch, so a
 * problem with it can be played back and fixed without the watch.
 */
function recorderSection(): HTMLElement {
  const status = el("p", { class: "footnote" });
  const row = el("div", { class: "row" });
  const arm = el("button", { type: "button", class: "btn tonal small" });
  const share = el("button", { type: "button", class: "btn text small" }, "Share recording");
  share.onclick = () => void act(share, "Share recording", shareRecording);
  unsubscribeRecorder = onRecorder((r) => {
    arm.textContent = r.armed ? "Cancel" : "Record the next connection";
    arm.onclick = () => armRecorder(!r.armed);
    arm.disabled = r.recording;
    status.textContent = r.recording
      ? "Recording this connection. It's saved when the watch disconnects."
      : r.armed
        ? "Waiting: the next connection to the watch is recorded, whether you start it or Tartan syncs by itself."
        : r.last
          ? `Last recording: ${r.last.name}, ${ago(new Date(r.last.started))}, ${fmtBytes(r.last.bytes)}.`
          : "Nothing recorded yet.";
    row.replaceChildren(arm, ...(r.last && !r.recording ? [share] : []));
  });
  return el(
    "details",
    { class: "more" },
    el("summary", {}, icon("watch", "ic sm"), "Watch recorder"),
    el("p", { class: "sub" }, "When something goes wrong with the watch, record one connection and send the recording along. It holds every byte between the phone and the watch, so the problem can be played back and fixed without your watch."),
    el("p", { class: "callout" }, icon("info", "ic sm"), "It includes what the watch sends (workouts, heart rate, routes). Share it only with whoever is fixing Tartan."),
    status,
    row,
  );
}

function agentsSection(info: ServerInfo | null): HTMLElement {
  const sec = el("div", { class: "agents" }, el("p", { class: "sub" }, "Give Claude Code, Claude Desktop, Cursor or any MCP client the same workouts, sleep and plan the coach reads."));
  if (deviceMode) {
    sec.append(el("p", { class: "callout" }, icon("info", "ic sm"), "Agents connect to Tartan on a computer, which has their setup under Settings → More → Advanced. Link it under Your PC above and this phone keeps it up to date."));
  } else if (info) {
    const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
    const snippets: Array<[string, string, string]> = [
      ["Claude Code", "Run once in a terminal.", `claude mcp add tartan -- ${q(info.bunPath)} ${q(info.cliPath)} mcp --data ${q(info.dataDir)}`],
      ["Claude Desktop, Cursor and other stdio clients", "Add to the client's MCP config.", JSON.stringify({ mcpServers: { tartan: { command: info.bunPath, args: [info.cliPath, "mcp", "--data", info.dataDir] } } }, null, 2)],
      ["Over HTTP", "For clients that take a URL, while this server runs.", `claude mcp add --transport http tartan ${info.mcpUrl}`],
    ];
    for (const [title, text, code] of snippets) {
      const copy = el("button", { type: "button", class: "btn tonal small" }, "Copy");
      copy.onclick = async () => {
        await navigator.clipboard.writeText(code).then(
          () => (copy.textContent = "Copied"),
          () => notify("Copy failed: select the text and copy it by hand.", "error"),
        );
        setTimeout(() => (copy.textContent = "Copy"), 1600);
      };
      sec.append(el("div", { class: "snippet" }, el("div", { class: "row spread" }, el("h3", {}, title), copy), el("p", { class: "sub" }, text), el("pre", { class: code.startsWith("{") ? "json" : "" }, el("code", {}, code))));
    }
  }
  sec.append(el("details", { class: "more" }, el("summary", {}, "What agents can call"), el("dl", { class: "tools" }, ...TOOLS.flatMap(([n, d]) => [el("dt", {}, n), el("dd", {}, d)]))));
  return sec;
}

/**
 * Colours (web/lib/theme.ts): Material You's from the wallpaper, or Tartan's own. Only where the
 * phone has wallpaper colours (the Android app on Android 12+); gone elsewhere.
 */
function coloursCard(): HTMLElement {
  const card = el("section", { class: "card colours-card", hidden: true });
  void wallpaperColours().then((c) => {
    if (!c) return;
    const swatch = (r: Record<string, string>) => el("span", { class: "swatches", "aria-hidden": "true" }, ...[r.primary, r.secondary_container, r.surface_container, r.surface].map((x) => el("i", { style: `background:${x}` })));
    const seg = el("div", { class: "segmented colour-choice", role: "radiogroup", "aria-label": "Colours" });
    const options: Array<[ColourChoice, string, Node]> = [
      ["wallpaper", "Your wallpaper", swatch(c.light)],
      ["tartan", "Tartan", swatch({ primary: "#a8321f", secondary_container: "#f7ddd6", surface_container: "#fceae6", surface: "#fff8f6" })],
    ];
    for (const [id, label, sw] of options) {
      const b = el("button", { type: "button", role: "radio", class: "seg", "aria-checked": String(colourChoice() === id) }, sw, label);
      b.onclick = () => {
        seg.querySelectorAll(".seg").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        void setColourChoice(id);
      };
      seg.append(b);
    }
    card.replaceChildren(
      el("h2", {}, icon("spark", "ic"), "Colours"),
      el("p", { class: "sub" }, "Material You: Tartan in the colours Android picked from your wallpaper, changing when it does. Or Tartan's own track red. Charts and heart-rate zones keep their colours either way."),
      seg,
    );
    card.hidden = false;
  });
  return card;
}

/** Tartan 2 (the tartan-2 branch): the native Compose parts, each on or off, to compare on the same phone. */
function tartan2Card(): HTMLElement | undefined {
  if (!shellAvailable()) return undefined;
  const p = shellParts();
  // iPhone: the SwiftUI parts built so far (ios/App/App/Shell), each on or off.
  if (Capacitor.getPlatform() === "ios")
    return el(
      "section",
      { class: "card" },
      el("h2", {}, icon("spark", "ic"), "Native screens"),
      el("p", { class: "sub" }, "Parts of Tartan drawn by iOS itself, with Liquid Glass, instead of the web page. More come one at a time. Turn them off to compare."),
      switchRow("Native tab bar", "Slide along it to switch tabs, with a click you feel.", p.nav, (on) => setShellParts({ nav: on })),
      switchRow("Native Today", "Today drawn by iOS: your session, how you are, the morning check, the week.", p.today, (on) => setShellParts({ today: on })),
      switchRow("Native workout sheet", "A workout drawn by iOS: its route on the map, charts you can slide across, your notes.", p.workout, (on) => setShellParts({ workout: on })),
      switchRow("Native Coach", "Your plan drawn by iOS: this week, the whole plan, the coach's suggestions, Change plan. Making the first plan stays here.", p.coach, (on) => setShellParts({ coach: on })),
      switchRow("Native Activities", "Your workouts drawn by iOS, by week, searchable. Routes stay as they are.", p.activities, (on) => setShellParts({ activities: on })),
      switchRow("Native Progress", "The long view drawn by iOS: charts you can slide across, your bests, the week.", p.progress, (on) => setShellParts({ progress: on })),
    );
  return el(
    "section",
    { class: "card" },
    el("h2", {}, icon("spark", "ic"), "Tartan 2 preview"),
    el("p", { class: "sub" }, "Parts of Tartan drawn natively by Android (Jetpack Compose, Material 3 Expressive) instead of the web page. Turn them off to compare."),
    switchRow("Native navigation bar", "Slide along it to switch tabs, with a click you feel.", p.nav, (on) => setShellParts({ nav: on })),
    switchRow("Native Today", "Today drawn by Android, with the week as a wavy ring.", p.today, (on) => setShellParts({ today: on })),
    switchRow("Native Coach", "Your plan drawn by Android: the coach's suggestions, this week, the whole plan.", p.coach, (on) => setShellParts({ coach: on })),
    switchRow("Native chat", "Talking to your coach, drawn by Android: photos, dictation, its answer as it comes.", p.chat, (on) => setShellParts({ chat: on })),
    switchRow("Native Activities", "Your workouts drawn by Android, by week, searchable. Routes stay as they are.", p.activities, (on) => setShellParts({ activities: on })),
    switchRow("Native Settings", "Every group drawn by Android: sources, training, the coach, the watch and more.", p.settings, (on) => setShellParts({ settings: on })),
    switchRow("Native Progress", "The long view drawn by Android: charts you can slide across, the year's training days, the week.", p.progress, (on) => setShellParts({ progress: on })),
    switchRow("Native Body", "Your muscles on the map, sleep and the watch's vitals, drawn by Android.", p.body, (on) => setShellParts({ body: on })),
    switchRow("Native Routes", "The route editor on a native map: paths, loops from here, race pacing, to the watch.", p.routes, (on) => setShellParts({ routes: on })),
    switchRow("Native Record and Lift", "Recording a run on the phone, and a strength session set by set, native.", p.record, (on) => setShellParts({ record: on })),
    switchRow("Native workout sheet", "A workout drawn by Android: its route on the map, charts you can slide across, your notes.", p.workout, (on) => setShellParts({ workout: on })),
  );
}

function dataSection(info: ServerInfo | null): HTMLElement {
  const replay = el("button", { type: "button", class: "btn text small" }, "Replay the intro");
  replay.onclick = () => void maybeOnboard(true);
  return el(
    "section",
    { class: "card" },
    el("h2", {}, icon("folder", "ic"), "Your data"),
    el("p", { class: "sub" }, ...(deviceMode ? ["Everything is kept in this app's private storage on the phone"] : ["Everything is plain files in ", el("code", {}, info?.dataDir ?? "data/")]), ": watch files, Strava activities and streams, coach conversations and the sync log."),
    el("div", { class: "row" }, replay),
  );
}

declare const BUILD_ID: string;
const BUILD = typeof BUILD_ID === "string" ? BUILD_ID : "dev";

function logSection(): HTMLElement {
  const pre = el("pre", { class: "log" });
  unsubscribeLog = onLog((t) => {
    pre.textContent = t || "Nothing logged in this session yet. Connections, syncs and errors appear here.";
    pre.scrollTop = pre.scrollHeight;
  });
  const copy = el("button", { type: "button", class: "btn tonal small" }, "Copy log");
  copy.onclick = () =>
    void navigator.clipboard.writeText(`Tartan ${pkg.version}, build ${BUILD}\n${pre.textContent ?? ""}`).then(
      () => notify("Log copied. Paste it wherever you need it."),
      () => notify("Copy failed: select the text and copy it by hand.", "error"),
    );
  return el("details", { class: "more" }, el("summary", {}, icon("file", "ic sm"), "Activity log"), pre, el("div", { class: "row" }, copy), el("p", { class: "footnote" }, `Version ${pkg.version} · build ${BUILD}`));
}

/** Settings → Coach: the weekly review on or off. */
/** What the coach remembers across conversations (src/memory.ts), each note can be forgotten here. */
function memoryCard(): HTMLElement {
  const list = el("ul", { class: "memory-list" });
  const empty = el("p", { class: "footnote" }, "Nothing yet. Tell the coach something worth keeping (an old injury, when you can train) and it takes a note.");
  const card = el(
    "section",
    { class: "card memory-card" },
    el("h2", {}, icon("bookmark", "ic"), "What your coach remembers"),
    el("p", { class: "sub" }, `Short notes that carry from one conversation to the next. ${app.remote ? "Shared with your PC, so agents there see them too." : "Linked to a PC, they're shared with it."}`),
    list,
    empty,
  );
  const KIND: Record<string, string> = { athlete: "You", health: "Health", preference: "Likes", goal: "Goal", lesson: "Learned" };
  const show = (notes: Array<{ id: string; text: string; kind: string; gone?: boolean }>) => {
    const live = notes.filter((n) => !n.gone);
    empty.hidden = live.length > 0;
    list.replaceChildren(
      ...live.map((n) => {
        const forget = el("button", { type: "button", class: "icon-btn", "aria-label": `Forget: ${n.text}` }, icon("close", "ic sm"));
        forget.onclick = () =>
          act(forget, "Forgetting a note", async () => {
            await app.api.request(`/api/coach/memory/${encodeURIComponent(n.id)}`, { method: "DELETE" });
            show(notes.filter((x) => x.id !== n.id));
          });
        return el("li", {}, el("span", { class: "memory-kind" }, KIND[n.kind] ?? n.kind), el("span", { class: "memory-text" }, n.text), forget);
      }),
    );
  };
  void app.api.json<{ notes: Array<{ id: string; text: string; kind: string; gone?: boolean }> }>("/api/coach/memory").then((r) => show(r.notes)).catch(() => show([]));
  return card;
}

/** Who shows the exercises in strength sessions (web/lib/demo-body.ts). */
function demosCard(sex?: string): HTMLElement {
  const seg = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Who shows the exercises" });
  const sync = () => seg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.c === demoChoice())));
  for (const [c, label] of [["me", "Like me"], ["m", "Man"], ["f", "Woman"], ["mix", "Both"]] as const) {
    const b = el("button", { type: "button", role: "radio", class: "seg", "data-c": c }, label);
    b.onclick = () => {
      setDemoChoice(c);
      sync();
    };
    seg.append(b);
  }
  sync();
  return el(
    "section",
    { class: "card demos-card" },
    el("h2", {}, icon("body", "ic"), "Exercise demos"),
    el("p", { class: "sub" }, `Who shows you each exercise in a strength session. ${sex ? `Like me: a ${sex === "F" ? "woman" : "man"}, from your profile above.` : "Like me follows the sex in your profile above; until it's set, a man and a woman take turns."}`),
    seg,
  );
}

/** How much of the coach's change to the plan goes in without you. */
function approvalSetting(mode: "ask" | "small" | "auto"): HTMLElement {
  const CHOICES = [
    ["ask", "Ask me every time", "Every change waits for your OK on the Coach tab."],
    ["small", "Small changes go straight in", "A session moved within its week, up to a quarter shorter or longer, paces by up to 10 s/km. New or dropped sessions and bigger changes wait for your OK."],
    ["auto", "My coach decides", "The coach changes the plan itself; you see what changed and why, and can undo it for a week."],
  ] as const;
  const list = el("div", { class: "choices", role: "radiogroup", "aria-label": "Plan changes" });
  for (const [id, title, line] of CHOICES) {
    const b = el("button", { type: "button", role: "radio", class: "choice", "aria-checked": String(id === mode) }, el("span", { class: "choice-dot", "aria-hidden": "true" }), el("span", {}, el("b", {}, title), el("span", { class: "sub" }, line)));
    b.onclick = () =>
      void act(b, "Saving", async () => {
        const r = (await (await app.api.request("/api/plan/approval", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: id }) })).json()) as { error?: string };
        if (r.error) throw new Error(r.error);
        list.querySelectorAll(".choice").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      });
    list.append(b);
  }
  return el("section", { class: "card approval-setting" }, el("h2", {}, icon("plan", "ic"), "Plan changes"), list, el("p", { class: "footnote" }, "Days behind you are never changed, and the app lists every change itself, whatever the coach says about it."));
}

function weeklySetting(): HTMLElement {
  let on = true;
  try {
    on = localStorage.getItem(WEEKLY_OFF) !== "1";
  } catch {
    // on
  }
  const sw = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(on), "aria-label": "Weekly review" }, el("i"));
  sw.onclick = () => {
    on = !on;
    sw.setAttribute("aria-checked", String(on));
    try {
      if (on) localStorage.removeItem(WEEKLY_OFF);
      else localStorage.setItem(WEEKLY_OFF, "1");
    } catch {
      // not remembered
    }
  };
  return el(
    "section",
    { class: "card weekly-setting" },
    el("div", { class: "switch-row" }, el("div", {}, el("h2", {}, icon("history", "ic"), "Weekly review"), el("p", { class: "sub" }, "Sunday evening, your coach looks back at the week and suggests changes to the next one when it should. Plan changes, above, decides what waits for your OK.")), sw),
  );
}
