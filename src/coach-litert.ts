/**
 * The coach on a model on the phone: Gemma in Model Hub (TartanModelHubPlugin, web/lib/modelhub.ts),
 * which runs it on the Tensor TPU, GPU or CPU for every app. It calls tools itself: it gets a short list of the read-only data tools, asks for what it needs, the app runs
 * them (the same code Claude and Gemini use) and sends the results back, until it answers.
 * (Until 2.37 Tartan also ran a model file itself, through LiteRT-LM; Model Hub took that over.)
 *
 * A phone model has a small context (4096 tokens on the TPU, tools included), so the tools are a
 * chosen few with short descriptions, and each result is squeezed (squeeze) before it goes back.
 *
 * The conversation stays loaded on the phone between questions (keyed by the chat's id, with the
 * number of messages so far): a follow-up carries on in it instead of reading the chat again.
 */
import { z } from "zod";
import type { DataTool } from "./tools.ts";
import { VOICE_LINE } from "./coach/prompt.ts";

/** Small enough for a small model: no empty fields, rounded numbers, short lists and strings. */
export function squeeze(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "number") return Math.round(v * 100) / 100;
  if (typeof v === "string") return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  if (Array.isArray(v)) {
    if (depth > 4) return `${v.length} items`;
    const kept = v.slice(0, 8).map((x) => squeeze(x, depth + 1)).filter((x) => x !== undefined);
    return v.length > 8 ? [...kept, `…and ${v.length - 8} more`] : kept.length ? kept : undefined;
  }
  if (typeof v === "object") {
    if (depth > 4) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const s = squeeze(x, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v;
}

/** A model on the phone, as the coach's tool loop drives it (Model Hub's). */
export interface PhoneModel {
  /** The model it would use (none: it can't answer yet), and whether it's loaded. */
  status(): Promise<{ name?: string; loaded: boolean }>;
  /** Load the model; the processor it runs on, and its context in tokens. */
  load(): Promise<{ backend: string; context?: number }>;
  /** A conversation; `turns` is how many messages the chat had before this question (a loaded one with two fewer carries on). */
  start(id: string, o: { system: string; tools: string[]; history: Array<{ role: "user" | "assistant"; text: string }>; turns: number; temperature?: number; prepare?: boolean }): Promise<{ reused?: boolean } | void>;
  /** One message (the athlete's words or tool results); the reply's words and the tools it calls. */
  send(id: string, msg: { text: string; image?: string } | { toolResults: Array<{ name: string; result: string }> }, onText: (text: string) => void): Promise<{ text: string; toolCalls: Array<{ name: string; args: Record<string, unknown> }> }>;
  end(id: string): Promise<void>;
}

/**
 * Model Hub (another app on the phone, holding the models for every app) as it stands for Tartan:
 * installed, allowed (Android's permission), the model it would use and what it's like, an update
 * it has found, how fast the last answer was, and what went wrong if it can't say.
 */
export interface HubState {
  installed: boolean;
  allowed: boolean;
  model?: string;
  context?: number;
  vision?: boolean;
  accelerators?: string[];
  update?: string;
  backend?: string;
  firstMs?: number;
  tokensPerSecond?: number;
  error?: string;
  code?: number;
  /** Model Hub's word that it waits for the owner to approve Tartan there (or that it was denied). */
  notApproved?: string;
  /** Tartan's own model file from before 2.37, still in its storage: its name and size, to offer removing it. */
  oldFile?: { name: string; size: number };
}
/** Model Hub as the coach's model: the model file's start / send / end, and its state. */
export interface ModelHubClient extends PhoneModel {
  state(): Promise<HubState>;
}
/** Model Hub can answer: installed, allowed, with a model downloaded. */
export const hubReady = (h: HubState | null | undefined): boolean => !!h?.installed && !!h.allowed && !!h.model && !h.error && !h.notApproved;

/** The tools a phone model gets: the read-only ones a coach needs most. */
export const LOCAL_TOOLS = [
  "get_readiness",
  "get_training_plan",
  "list_activities",
  "get_activity",
  "get_week",
  "get_goals",
  "get_training_load",
  "get_best_efforts",
  "get_durability",
  "get_weather",
  "get_health",
  "get_run_notes",
  "get_shoes",
  "get_athlete_profile",
  "edit_session",
  "change_plan",
] as const;

const MAX_ROUNDS = 5;
const RESULT_CHARS = 2500;
/**
 * A small context (a TPU build of Gemma: 4096 tokens) holds the instructions, the tools, the chat
 * and the lookups only if each is smaller: the tools a coach needs most, the last few messages,
 * shorter results.
 */
const SMALL_CONTEXT = 6000;
const SMALL_TOOLS = ["get_readiness", "get_training_plan", "list_activities", "get_activity", "get_week", "get_goals", "get_athlete_profile", "edit_session", "change_plan"] as const;
const SMALL_RESULT_CHARS = 1200;

export const LOCAL_SYSTEM = `You are the athlete's coach in Tartan, simply "Coach": an experienced endurance coach for one athlete, running on their phone.
- ${VOICE_LINE}
- Look before you speak: call the tools for what the question needs (get_readiness for today, get_training_plan for the plan, list_activities for recent workouts, and so on). A call or two is usually enough.
- Answer only from what the tools return: quote dates, distances, paces and heart rates. If they can't answer it, say what's missing.
- Lead with the answer, explain why in plain words, then one to three concrete next steps. At most about 150 words. No tables.
- Easy runs stay below the top of zone 2 (get_athlete_profile). Never invent numbers.
- To change one session (move, drop, shorten, swap its kind, add one), call edit_session with its date (get_training_plan has them). For a whole new plan (a new race, a different block), call change_plan. Then say what changed. You are not a doctor: for pain, illness, chest symptoms or dizziness, advise rest and seeing a professional.
- Answer in the language the athlete writes in.`;

/** The chosen tools as the engine takes them: name, a short description and JSON Schema parameters. */
export function toolDescriptions(tools: DataTool[], names: readonly string[] = LOCAL_TOOLS): string[] {
  return names.flatMap((name) => {
    const t = tools.find((x) => x.name === name);
    if (!t) return [];
    const { $schema: _drop, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    const description = t.description.length > 280 ? `${t.description.slice(0, 277).replace(/\s+\S*$/, "")}…` : t.description;
    return [JSON.stringify({ name: t.name, description, parameters })];
  });
}

type History = Array<{ role: "user" | "assistant"; text: string }>;

/**
 * What a conversation on the phone starts with, from the model's context: the tools (the short
 * list in a small context), the chat (shorter there too), and how long a lookup's result may be.
 * The same for a question and for preparing one, so a prepared conversation is the one asked in.
 */
function startArgs(o: { tools: DataTool[]; system: string; history: History; turns?: number; context?: number }) {
  const small = !!o.context && o.context < SMALL_CONTEXT;
  const names: readonly string[] = small ? SMALL_TOOLS : LOCAL_TOOLS;
  const history = small ? o.history.slice(-4).map((m) => ({ ...m, text: m.text.length > 300 ? `${m.text.slice(0, 300)}…` : m.text })) : o.history;
  return { names, resultChars: small ? SMALL_RESULT_CHARS : RESULT_CHARS, start: { system: o.system, tools: toolDescriptions(o.tools, names), history, turns: o.turns ?? -1, temperature: 0.4 } };
}

/**
 * Get a chat ready before its question (Model Hub's prepare): the model loaded and the
 * instructions, tools and chat read, so the question only has its own words to read. Kept for
 * the question that follows (a model file or Model Hub carries on in it).
 */
export async function prepareLocal(o: { model: PhoneModel; tools: DataTool[]; system: string; history: History; id: string; turns: number; context?: number }): Promise<void> {
  await o.model.start(o.id, { ...startArgs(o).start, prepare: true });
}

export type LocalEvent = { type: "text"; delta: string } | { type: "tool"; name: string } | { type: "loaded"; backend: string };

/**
 * One turn: the model reads with tools, then answers. Yields its words as they come, each tool it
 * calls, and (first) the processor it runs on.
 */
export async function* localTurn(o: { model: PhoneModel; tools: DataTool[]; system: string; history: Array<{ role: "user" | "assistant"; text: string }>; text: string; image?: string; id?: string; turns?: number }): AsyncGenerator<LocalEvent> {
  const { backend, context } = await o.model.load();
  yield { type: "loaded", backend };
  const { names, resultChars, start } = startArgs({ ...o, context });
  const id = o.id ?? crypto.randomUUID();
  await o.model.start(id, start);
  // Kept loaded for the next question when this one is answered; dropped if it fails midway.
  let answered = false;
  try {
    let msg: Parameters<PhoneModel["send"]>[1] = { text: o.text, ...(o.image ? { image: o.image } : {}) };
    for (let round = 0; ; round++) {
      // The words arrive from the plugin's events; they are passed on as they come.
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      const reply = o.model
        .send(id, msg, (delta) => {
          queue.push(delta);
          wake?.();
        })
        .finally(() => {
          finished = true;
          wake?.();
        });
      let said = "";
      while (!finished || queue.length) {
        if (queue.length) {
          const delta = queue.shift()!;
          said += delta;
          yield { type: "text", delta };
        } else {
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      }
      const r = await reply;
      if (!said && r.text) yield { type: "text", delta: r.text };
      if (!r.toolCalls.length) {
        answered = !!o.id;
        return;
      }
      if (round >= MAX_ROUNDS) {
        yield { type: "text", delta: "\n\n(Stopped looking things up: that was enough for one answer.)" };
        return;
      }
      const results: Array<{ name: string; result: string }> = [];
      for (const call of r.toolCalls) {
        yield { type: "tool", name: call.name };
        const tool = names.includes(call.name) ? o.tools.find((t) => t.name === call.name) : undefined;
        if (!tool) {
          results.push({ name: call.name, result: JSON.stringify({ error: `No tool called ${call.name}.` }) });
          continue;
        }
        const parsed = tool.schema.safeParse(call.args ?? {});
        if (!parsed.success) {
          results.push({ name: call.name, result: JSON.stringify({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }) });
          continue;
        }
        try {
          let out = JSON.stringify(squeeze(await tool.run(parsed.data)) ?? "none");
          if (out.length > resultChars) out = JSON.stringify({ truncated: out.slice(0, resultChars) });
          results.push({ name: call.name, result: out });
        } catch (e) {
          results.push({ name: call.name, result: JSON.stringify({ error: (e as Error).message }) });
        }
      }
      msg = { toolResults: results };
    }
  } finally {
    if (!answered) await o.model.end(id).catch(() => {});
  }
}

/** Words for what can go wrong with the model on the phone. */
export function localError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  // Model Hub's own words on approving Tartan there (ERROR_NOT_APPROVED), as they are.
  if ((e as { code?: string | number })?.code == 12) return m;
  if (/memory|OOM|alloc/i.test(m)) return "The phone ran out of memory for the model. Close other apps and try again.";
  return `The model on the phone couldn't answer: ${m}`;
}
