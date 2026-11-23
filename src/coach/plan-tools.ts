/**
 * The coach's ways to write and change the plan: save_training_plan for the cloud models,
 * edit_session and change_plan for the phone's, and Tartan's rules when there is no AI.
 */
import { z } from "zod";
import type { Coach } from "../coach.ts";
import { Analytics } from "../analytics.ts";
import { basicPlanFor, makeBasicPlan, readTargetDay } from "../basic-plan.ts";
import { planInput, SESSION_KINDS, today, type PlanInput, type TrainingPlan } from "../plan.ts";
import type { DataTool } from "../tools.ts";
import { addDays, type CoachEvent } from "./conversation.ts";
import { TOOL_LABELS } from "./labels.ts";

/** save_training_plan: the plan from a cloud model, saved or proposed (the athlete's setting). */
export function saveTrainingPlanTool(c: Coach): DataTool {
  return {
    name: "save_training_plan",
    description:
      "Save the athlete's training plan. Weeks start on Monday; sessions carry their date. Rest days may be left out. Shown on the Coach tab and checked against their workouts. The first plan is saved at once. Once there is a plan, the new one is a proposal: the app works out every change from today on and the athlete accepts it or not on the Coach tab, so say in change_note (and a session's why) what changes and why, from their data. Days before today always stay as they were.",
    schema: z.object(planInput) as unknown as z.ZodObject<z.ZodRawShape>,
    readOnly: false,
    run: async (args) => {
      const r = await c.plans.submit(args as PlanInput, { conversation: c.active?.id, model: c.active?.model, source: c.source });
      if ("saved" in r) {
        c.planSaved = r.saved.updated;
        // The athlete lets these go in without asking: say what changed and why.
        if (r.applied) return { saved: true, applied: r.applied.map((c) => [c.type, c.date, c.to, c.title, c.detail].filter(Boolean).join(" · ")), note: "Saved at once (the athlete's setting); they can undo it for a week. Tell them in a sentence or two what you changed and why." };
        return { saved: true, weeks: r.saved.weeks.length, sessions: r.saved.weeks.reduce((n, w) => n + w.sessions.length, 0) };
      }
      if ("unchanged" in r) return { unchanged: true, note: "Nothing changes from today on: no proposal made." };
      c.planProposed = r.proposed.changes.length;
      return {
        proposed: true,
        changes: r.proposed.changes.map((c) => [c.type, c.date, c.to, c.title, c.detail].filter(Boolean).join(" · ")),
        note: "Not saved yet: the athlete sees these changes on the Coach tab and accepts them or not. Tell them in a sentence or two what you suggest and why; don't list the changes again.",
      };
    },
  };
}

/**
 * A plan change asked for in a phone chat (its change_plan tool): the planner (a cloud key)
 * rewrites the plan with the request as its note; what came of it goes back to the phone model.
 */
export async function changePlanFor(c: Coach, request: string): Promise<Record<string, unknown>> {
  // No cloud key: a single change is edit_session's; a whole new plan is Tartan's rules'.
  if ((await c.planner()) === "rules") return rulesReplan(c);
  const outer = c.active;
  let said = "";
  try {
    for await (const ev of c.updatePlan(request, undefined, { fromChat: true })) {
      if (ev.type === "text") said += ev.delta;
      if (ev.type === "error") return { error: ev.message };
    }
  } finally {
    c.active = outer;
  }
  return {
    done: c.planSaved ? "The plan is saved: it's on the Coach tab." : c.planProposed ? `${c.planProposed} change${c.planProposed > 1 ? "s" : ""} proposed: the athlete accepts them on the Coach tab.` : "The plan stays as it is.",
    planner_said: said.slice(0, 800),
  };
}


/** A new plan by Tartan's rules from today, submitted like any change (a proposal, or in at once by their setting). */
export async function rulesReplan(c: Coach, until?: string): Promise<Record<string, unknown>> {
  c.planSaved = null;
  c.planProposed = 0;
  const input = await basicPlanFor(new Analytics(c.lib), { today: today(), until });
  const r = await c.plans.submit({ ...input, change_note: "A new plan by Tartan's rules from today, from your targets, time and recent weeks." }, { model: "Tartan's rules (no AI)", source: "update" });
  if ("saved" in r) c.planSaved = r.saved.updated;
  if ("proposed" in r) c.planProposed = r.proposed.changes.length;
  return { done: "saved" in r ? "A new plan by Tartan's rules is saved: it's on the Coach tab." : "proposed" in r ? `Tartan's rules propose a new plan (${r.proposed.changes.length} changes): the athlete accepts it on the Coach tab.` : "Tartan's rules come to the same plan: nothing changes." };
}


/**
 * One session changed in the plan by the phone model (edit_session): moved, dropped, changed or
 * added, by Tartan, so no cloud key is needed; submitted like any change.
 */
export async function editSession(c: Coach, a: { action: string; date: string; kind?: string; to?: string; new_kind?: string; title?: string; distance_km?: number; duration_min?: number; target?: string; why?: string }): Promise<Record<string, unknown>> {
  const cur = await c.plans.current();
  if (!cur) return { error: "There's no plan yet: make one on the Coach tab." };
  const t = today();
  if (a.date < t || (a.to && a.to < t)) return { error: "Days already behind them stay as they were: pick today or later." };
  const { created: _c, updated: _u, conversation: _v, model: _m, ...plan } = structuredClone(cur) as TrainingPlan;
  const weekOf = (d: string) => plan.weeks.find((w) => w.start <= d && d < addDays(w.start, 7));
  const from = weekOf(a.date);
  const at = from ? from.sessions.findIndex((x) => x.date === a.date && (!a.kind || x.kind === a.kind) && x.kind !== "rest") : -1;
  const kind = (k?: string) => (SESSION_KINDS as readonly string[]).includes(k ?? "") ? (k as PlanInput["weeks"][number]["sessions"][number]["kind"]) : undefined;
  if (a.action !== "add" && at < 0) return { error: `No ${a.kind ?? "session"} on ${a.date} in the plan: read get_training_plan for the dates.` };
  if (a.action === "move") {
    const to = a.to && weekOf(a.to);
    if (!to) return { error: "Move it to a day inside the plan (to: YYYY-MM-DD)." };
    const [x] = from!.sessions.splice(at, 1);
    to.sessions.push({ ...x!, date: a.to!, why: a.why });
  } else if (a.action === "drop") from!.sessions.splice(at, 1);
  else if (a.action === "change") {
    const x = from!.sessions[at]!;
    Object.assign(x, { ...(kind(a.new_kind) ? { kind: kind(a.new_kind) } : {}), ...(a.title ? { title: a.title } : {}), ...(a.distance_km !== undefined ? { distance_km: a.distance_km } : {}), ...(a.duration_min !== undefined ? { duration_min: a.duration_min } : {}), ...(a.target ? { target: a.target } : {}), ...(a.why ? { why: a.why } : {}) });
  } else if (a.action === "add") {
    const w = weekOf(a.date);
    const k = kind(a.new_kind ?? a.kind);
    if (!w || !k) return { error: "Add it on a day inside the plan, with a kind (easy, long, tempo, intervals, hills, recovery, strength, cross)." };
    w.sessions.push({ date: a.date, kind: k, title: a.title ?? k, ...(a.distance_km !== undefined ? { distance_km: a.distance_km } : {}), ...(a.duration_min !== undefined ? { duration_min: a.duration_min } : {}), ...(a.target ? { target: a.target } : {}), ...(a.why ? { why: a.why } : {}) });
  } else return { error: "action is move, drop, change or add." };
  plan.change_note = a.why ?? "Changed as you asked in the chat.";
  const r = await c.plans.submit(plan, { conversation: c.active?.id, model: c.active?.model, source: "chat" });
  if ("saved" in r) c.planSaved = r.saved.updated;
  if ("proposed" in r) c.planProposed = r.proposed.changes.length;
  return { done: "saved" in r ? "Saved: the plan on the Coach tab shows it." : "proposed" in r ? "Proposed: they accept it on the Coach tab." : "Nothing changes." };
}


/** The phone model's own way to change one session (no cloud key needed). */
export function editSessionTool(c: Coach): DataTool {
  return {
    name: "edit_session",
    description: "Change one session in the athlete's plan, as they ask: move it to another day, drop it, change it (kind, title, distance, time, target) or add one. Today or later only. For a whole new plan, use change_plan.",
    schema: z.object({
      action: z.enum(["move", "drop", "change", "add"]),
      date: z.string().describe("the session's day, YYYY-MM-DD"),
      kind: z.string().optional().describe("which session that day, when there are two (easy, long, tempo…)"),
      to: z.string().optional().describe("move: the new day, YYYY-MM-DD"),
      new_kind: z.string().optional().describe("change/add: easy, long, tempo, intervals, hills, recovery, strength, cross"),
      title: z.string().optional(),
      distance_km: z.number().optional(),
      duration_min: z.number().optional(),
      target: z.string().optional().describe("pace or heart rate in words"),
      why: z.string().optional().describe("in a few words, why"),
    }),
    readOnly: false,
    local: true,
    run: async (a) => editSession(c, a as Parameters<typeof editSession>[1]),
  };
}


/** The phone model's way to rewrite the plan: the planner (a cloud key) or Tartan's rules. */
export function changePlanTool(c: Coach): DataTool {
  return {
    name: "change_plan",
    description: "Rewrite the athlete's whole training plan (a new race or target, a different block, start over). For one session, use edit_session. Their cloud coach (or Tartan's rules) rewrites it; tell them what came of it.",
    schema: z.object({ request: z.string().describe("What to change, in the athlete's words") }),
    readOnly: false,
    local: true,
    run: async (a) => changePlanFor(c, String((a as { request?: string }).request ?? "")),
  };
}


/** "Make my plan" on a model on the phone: Tartan's rules write it, the model says what it does. */
export async function* planOnDevice(c: Coach, target?: string): AsyncGenerator<CoachEvent> {
  const t = today();
  const until = target?.trim() ? readTargetDay(target, t) : undefined;
  if (until === null) return yield { type: "error", message: `Couldn't read "${target}" as a date: try "14 March" or "end of June".` };
  yield { type: "tool", name: "save_training_plan", label: TOOL_LABELS.save_training_plan! };
  // A plan already: Tartan's new one is a proposal (or goes in, by the athlete's setting) like any change.
  if (await c.plans.current()) {
    const r = await rulesReplan(c, until ?? undefined);
    if ("error" in r) return yield { type: "error", message: String(r.error) };
    if (c.planProposed) yield { type: "plan", updated: "", proposed: c.planProposed };
    else if (c.planSaved) yield { type: "plan", updated: c.planSaved };
    const ask = `Tell me in two or three sentences what the new plan by Tartan's rules changes, and that I accept it on the Coach tab.`;
    return yield* c.chat(null, ask, { title: `Training plan, ${t}`, instructions: "Tartan's rules just proposed a new plan from today; explain it, don't change it." });
  }
  let saved;
  try {
    saved = await makeBasicPlan(new Analytics(c.lib), c.plans, { today: t, until: until ?? undefined });
  } catch (e) {
    return yield { type: "error", message: (e as Error).message };
  }
  yield { type: "plan", updated: saved.updated };
  // Then the coach on the phone says what the plan does, in its own conversation.
  const ask = `Tell me about my new plan "${saved.title}" in three or four sentences: what it builds to, how the weeks go, and my paces. The plan: ${saved.summary}`;
  yield* c.chat(null, ask, { title: `Training plan, ${t}`, instructions: "The plan was just made by the app's own rules and saved; explain it, don't change it." });
}
