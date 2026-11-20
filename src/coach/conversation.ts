/**
 * A conversation as the coach keeps it, the events a turn streams, photos, and the small
 * helpers every turn uses.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Content } from "@google/genai";
import type { Provider } from "./settings.ts";
import type { RouteCard } from "./route-tools.ts";

/** A photo sent with a message: JPEG, PNG or WebP as base64, and a small preview for the conversation. */
export interface ChatImage {
  mime: string;
  data: string;
  thumb?: string;
}
export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** About 6 MB of picture at most (the app sends them resized, far smaller). */
export const okImage = (i: ChatImage) => IMAGE_TYPES.has(i.mime) && typeof i.data === "string" && i.data.length < 8_000_000 && /^[A-Za-z0-9+/=]+$/.test(i.data.slice(0, 200));

export interface ChatOptions {
  /** Photos with the message (up to three; the phone's models take the first). */
  images?: ChatImage[];
  /** A new conversation's title (default: the message). */
  title?: string;
  /** Sent to the model with the message, not shown in the conversation. */
  instructions?: string;
  /** A new conversation on this provider, not the chat's (plans and reviews: the planner's). */
  provider?: Provider;
}

export type CoachEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; label: string }
  /** Who answers this turn ("Gemma 4 E2B on your phone", "Gemini 3.8 Flash"); again when that changes. */
  | { type: "by"; label: string }
  | { type: "plan"; updated: string; proposed?: number }
  /** A route the coach made this turn, saved in Routes (the chat links to it). */
  | ({ type: "route" } & RouteCard)
  | { type: "done"; stop: string }
  | { type: "error"; message: string };

export interface Conversation {
  id: string;
  title: string;
  created: string;
  updated: string;
  model: string;
  /** Which API the conversation runs on; its history format follows. Absent: Anthropic. */
  provider?: Provider;
  /** Exactly what was sent to the API, append-only (keeps thinking blocks valid). */
  messages: Anthropic.Beta.BetaMessageParam[];
  /** The same for Gemini conversations (thought signatures must round-trip unchanged). */
  contents?: Content[];
  /** When the coach's notes were last given to this conversation (they ride in a user turn, once per change). */
  memory?: string;
  /** What the UI shows; `by`: the model that answered; `reported`: why the athlete flagged it. */
  display: Array<{
    role: "user" | "assistant"; text: string; tools?: string[]; image?: string; by?: string; reported?: string;
    /** A turn that failed: kept so the question isn't lost (with Ask again), left out of what models read. */
    failed?: boolean; error?: string;
    /** A route the coach made in this answer (the chat links to it). */
    route?: { id: string; name: string; km: number };
    /** Routes shown in this answer as cards (made, or a saved one the coach brought up). */
    routes?: RouteCard[];
  }>;
  /** A turn in the cloud for a phone chat: never saved itself (its words go in the phone chat). */
  transient?: boolean;
}

export type Reply = { role: "assistant"; text: string; tools: string[]; by?: string };


export const num1 = (n: number) => String(Math.round(n * 10) / 10);
/** The athlete's message as the conversation shows it, with the first photo's preview. */
/** A day `n` days after `date` (YYYY-MM-DD). */
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);


/**
 * A turn that failed: the question and what came back stay in the chat, marked (the athlete sees
 * the error and can ask again), and are left out of what any model reads afterwards.
 */
export function failTurn(conv: { display: Array<{ role: "user" | "assistant"; text: string; failed?: boolean; error?: string }> }, error: string): void {
  const [q, a] = conv.display.slice(-2);
  if (q) q.failed = true;
  if (a) Object.assign(a, { failed: true, error });
}

/** The chat as a model on the phone is given it: the last eight messages, each at most 600 characters. */
export const localHistory = (conv: { display: Array<{ role: "user" | "assistant"; text: string; failed?: boolean }> }) =>
  conv.display.filter((d) => !d.failed).slice(-8).map((d) => ({ role: d.role, text: d.text.length > 600 ? `${d.text.slice(0, 600)}…` : d.text }));
export const shown = (text: string, images: ChatImage[]) => ({ role: "user" as const, text, ...(images[0]?.thumb?.startsWith("data:image/") && images[0].thumb.length < 120_000 ? { image: images[0].thumb } : {}) });
