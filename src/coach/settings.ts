/**
 * The coach's providers and settings: which AIs it can run on, their models, how a saved
 * setting reads, and who plans. Moved from src/coach.ts, which re-exports what others use.
 */


export type Provider = "anthropic" | "google" | "modelhub";
/** The ones that run on the phone itself, with no key. */
export const ON_PHONE = new Set<Provider>(["modelhub"]);
/**
 * Gemini Nano on the phone ("device"), until 2.56. A setting saved with it takes what a phone
 * provider that's gone falls back to (pickProvider); a conversation on it moves to the coach's
 * provider when it's next asked something (chat, rehome).
 */
export const GONE_PHONE = "device";
/** On the phone, or was (Gemini Nano). */
export const wasOnPhone = (p: string) => ON_PHONE.has(p as Provider) || p === GONE_PHONE;
/**
 * A provider as saved: "litert" (a model file in Tartan, until 2.37) is Model Hub now, which runs
 * the same models for every app.
 */
export const current = (p: string | undefined): Provider | undefined => (p === "litert" ? "modelhub" : (p as Provider | undefined));

/** The models offered before a key has listed its own (Load models in Coach settings). */
export const COACH_PROVIDERS: Record<Provider, { label: string; keyName: string; keyHelp: string; defaultModel: string; models: Array<{ id: string; label: string; note?: string }> }> = {
  anthropic: {
    label: "Anthropic (Claude)",
    keyName: "Anthropic API key",
    keyHelp: "console.anthropic.com → API keys",
    // Sonnet for the chat (quick, and good); plans and weekly reviews take Opus (planModelFor).
    defaultModel: "claude-sonnet-5-5",
    models: [
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Best for the chat" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Deepest, slower: plans use it" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest, cheapest" },
    ],
  },
  google: {
    label: "Google (Gemini)",
    keyName: "Gemini API key",
    keyHelp: "aistudio.google.com → Get API key",
    defaultModel: "gemini-3.8-flash",
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "Best coaching" },
      { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", note: "Deepest, slower" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", note: "Fastest, cheapest" },
    ],
  },
  // Model Hub, the app that holds the phone's models for every app (Gemma downloaded once), running
  // them on the NPU, GPU or CPU; the coach's own tool loop (coach-litert.ts).
  modelhub: {
    label: "Model Hub on this phone",
    keyName: "",
    keyHelp: "",
    defaultModel: "model-hub",
    models: [{ id: "model-hub", label: "Model Hub's model", note: "Free, offline, downloaded once for all your apps" }],
  },
};
/** Kept for callers that list the Claude models. */
export const COACH_MODELS = COACH_PROVIDERS.anthropic.models;
export const DEFAULT_MODEL = COACH_PROVIDERS.anthropic.defaultModel;
export const MODEL_ID: Record<Provider, RegExp> = { anthropic: /^claude-[a-z0-9.-]{2,60}$/, google: /^gemini-[a-z0-9.-]{2,60}$/, modelhub: /^model-hub$/ };
/** Models that take the server-side refusal fallback on the Claude API. */
export const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
export const MAX_TOOL_ROUNDS = 12;
/** A turn's own checks of the setup: Model Hub's state from the last 30 s will do. */
export const TURN = { hubAge: 30_000 };
/** Plans and weekly reviews on a lighter model chosen for the chat take the provider's best one. */
export const PLAN_MODEL: Partial<Record<Provider, string>> = { anthropic: "claude-opus-5-5", google: "gemini-3.8-flash" };
export const LIGHTER = new Set(["claude-sonnet-5-5", "claude-haiku-5-5", "gemini-3.5-flash-lite"]);
/**
 * The Gemini model that answers when the chosen one is still busy after the retries: one step
 * down, so it runs on other servers (Gemini 4 to 3.8 Flash, any other to Flash-Lite).
 */
export const geminiBackup = (model: string): string | undefined =>
  /^gemini-([4-9]|\d{2,})-/.test(model) ? "gemini-3.8-flash" : model === "gemini-3.5-flash-lite" ? undefined : "gemini-3.5-flash-lite";
export const planModelFor = (p: Provider, chosen: string): string => (LIGHTER.has(chosen) && PLAN_MODEL[p] ? PLAN_MODEL[p]! : chosen);
/** A model's name as people read it. */
export const modelLabel = (p: Provider, model: string) => COACH_PROVIDERS[p].models.find((m) => m.id === model)?.label ?? model;
/** Model Hub's model by name ("Gemma-4-E2B-it": "Gemma 4 E2B"). */
export const hubLabel = (name?: string | null) => (name ? name.replace(/[-_]it$/i, "").replace(/[-_]+/g, " ").trim() : "Gemma");


export const MAX_RESULT_CHARS = 60_000;

/**
 * Who writes and changes the plan and runs the weekly review: "auto" (the default) is the chat's
 * provider when that's a cloud key, else a cloud key you have (Gemini first, then Claude), else
 * Tartan's own rules; or a cloud provider by name, or "rules". A phone model's 4096 tokens can't
 * hold weeks of history and a whole plan, so it explains Tartan's plan rather than writing one.
 */
export type Planner = "auto" | "anthropic" | "google" | "rules";

export interface CoachSettings {
  provider?: Provider;
  /** Plans and weekly reviews (see Planner). */
  planner?: Planner;
  /** Photos in the chat (on unless turned off): sent to the coach's model with the message. */
  photos?: boolean;
  /** Speaking a message instead of typing it (on unless turned off). */
  voice?: boolean;
  /**
   * A phone chat answered on the phone even with a cloud key (private, free). Off (the default):
   * the cloud model answers whenever it can (it reads every message and decides what to look up
   * or change); the phone answers offline.
   */
  phoneOnly?: boolean;
  /** Anthropic key and model (the original fields). */
  apiKey?: string;
  model?: string;
  googleKey?: string;
  googleModel?: string;
}
