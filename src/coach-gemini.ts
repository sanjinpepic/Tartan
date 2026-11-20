/**
 * The coach on Google Gemini (Gen AI SDK, Gemini Developer API key): the same read-only data
 * tools and instructions as the Claude coach, through Gemini function calling. The history
 * keeps the model's turns exactly as returned (thought signatures on function calls must go
 * back unchanged), and is only ever appended to.
 */
import { ApiError, GoogleGenAI, ThinkingLevel, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { z } from "zod";
import type { DataTool } from "./tools.ts";

export interface GeminiTurnEvent {
  type: "text" | "tool" | "stop";
  delta?: string;
  name?: string;
  /** Finish reason of the last response (STOP, MAX_TOKENS, SAFETY, …). */
  stop?: string;
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  system: string;
  tools: DataTool[];
  maxRounds: number;
  maxResultChars: number;
  /**
   * How long it thinks before answering, on Gemini 3 and later: "low" for the chat (a quick
   * answer, after each lookup too), the model's own (deepest) default for plans and reviews.
   */
  thinking?: "low" | "default";
  /** Tests: a mock endpoint. */
  baseUrl?: string;
  /** Tests: seconds before the first retry. */
  retryDelay?: number;
}

/** Google's busy and gateway answers: worth a couple more tries before saying so. */
const BUSY = [500, 502, 503, 504];

export function geminiClient(apiKey: string, baseUrl?: string, retryDelay = 1, onBusy?: () => void): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(baseUrl ? { baseUrl } : {}),
      // An overloaded model (503) often answers on the next try; only before anything streamed.
      retryOptions: { attempts: 3, initialDelay: retryDelay, maxDelay: retryDelay * 6, httpStatusCodes: BUSY },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await sseClosed(input, init);
        if (BUSY.includes(res.status)) onBusy?.();
        return res;
      },
    },
  });
}

/**
 * fetch, with a streamed reply's last event closed off: the SDK only reads an event once it sees
 * the blank line after it, and throws "Incomplete JSON segment at the end" when a stream ends
 * without one. A whole last event then reads as usual; a cut one fails to parse (and is retried).
 */
const sseClosed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const res = await fetch(input, init);
  if (!res.ok || !res.body || !/event-stream/.test(res.headers.get("content-type") ?? "")) return res;
  const end = new TextEncoder().encode("\n\n");
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: (c) => c.enqueue(end) }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
};

/** Gemini 3 and later take a thinking level (earlier ones refuse it). */
export const thinksInLevels = (model: string) => /^gemini-([3-9]|\d{2,})(\.|-)/.test(model);

/** A stream that broke off midway (as opposed to an error answer from Google). */
const cutOff = (e: unknown) => !(e instanceof ApiError) && /incomplete json|parsing stream chunk|terminated|network|aborted|reset|failed to fetch|load failed/i.test(String((e as Error)?.message ?? e));

/** Run one user turn: `contents` already ends with the user's message; model turns and tool results are appended to it. */
export async function* geminiTurn(contents: Content[], o: GeminiOptions): AsyncGenerator<GeminiTurnEvent> {
  // Google busy (asked again, a few seconds later, by the SDK): said once, as a step, when it answers.
  let busy = 0;
  let toldBusy = false;
  const ai = geminiClient(o.apiKey, o.baseUrl, o.retryDelay, () => busy++);
  const functionDeclarations: FunctionDeclaration[] = o.tools.map((t) => {
    const { $schema: _drop, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { name: t.name, description: t.description, parametersJsonSchema: schema };
  });
  let stop = "STOP";
  let retried = false;
  for (let round = 0; round < o.maxRounds; round++) {
    const parts: Part[] = [];
    let said = false;
    try {
      const stream = await ai.models.generateContentStream({
        model: o.model,
        contents,
        config: { systemInstruction: o.system, tools: [{ functionDeclarations }], ...(o.thinking === "low" && thinksInLevels(o.model) ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}) },
      });
      if (busy && !toldBusy) {
        toldBusy = true;
        yield { type: "tool", name: "busy" };
      }
      for await (const chunk of stream) {
        const cand = chunk.candidates?.[0];
        for (const part of cand?.content?.parts ?? []) {
          parts.push(part);
          if (part.text && !part.thought) {
            said = true;
            yield { type: "text", delta: part.text };
          }
        }
        if (cand?.finishReason) stop = String(cand.finishReason);
      }
    } catch (e) {
      if (!cutOff(e)) throw e;
      // Broke off before a word showed: ask again, once. After words: keep them, say it was cut.
      if (!said && !retried) {
        retried = true;
        round--;
        continue;
      }
      if (!said) throw e;
      contents.push({ role: "model", parts: parts.filter((p) => !p.functionCall) });
      yield { type: "stop", stop: "CUT" };
      return;
    }
    contents.push({ role: "model", parts });
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
    if (!calls.length) break;

    const responses: Part[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      yield { type: "tool", name };
      const tool = o.tools.find((t) => t.name === name);
      const respond = (response: Record<string, unknown>) => responses.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name, response } });
      if (!tool) {
        respond({ error: `Unknown tool ${name}` });
        continue;
      }
      const parsed = tool.schema.safeParse(call.args ?? {});
      if (!parsed.success) {
        respond({ error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` });
        continue;
      }
      try {
        const out = JSON.stringify(await tool.run(parsed.data));
        respond(out.length > o.maxResultChars ? { output: `${out.slice(0, o.maxResultChars)}… (truncated; ask for a narrower range)` } : { output: JSON.parse(out) });
      } catch (e) {
        respond({ error: (e as Error).message });
      }
    }
    contents.push({ role: "user", parts: responses });
  }
  yield { type: "stop", stop };
}

/** A readable message for a Gemini API failure. */
export function geminiError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400 && /api key/i.test(e.message)) return "Google rejected the API key. Check it in Coach settings.";
    if (e.status === 401 || e.status === 403) return "This Google API key cannot use that model.";
    if (e.status === 404) return "Google doesn't know that model. Pick another in Coach settings.";
    if (e.status === 429) return "Rate limited by Google. Try again in a minute.";
    if (e.status === 503) return "Google's servers are too busy for this model right now (Tartan tried three times). Try again in a few minutes, or pick another model in Coach settings.";
    if (BUSY.includes(e.status)) return `Google had a problem answering (error ${e.status}, tried three times). Try again in a few minutes.`;
    return `Gemini API error ${e.status}: ${e.message}`;
  }
  if (/failed to fetch|load failed|networkerror/i.test(String((e as Error)?.message ?? e))) return "Couldn't reach Google: the connection dropped (Tartan asked again once). Check the connection and ask again.";
  if (cutOff(e)) return "Google's answer broke off midway. Try again.";
  return (e as Error).message;
}

/** The Gemini models this key can chat with (generateContent), newest names first. */
export async function geminiModels(apiKey: string, baseUrl?: string): Promise<Array<{ id: string; label: string }>> {
  const out: Array<{ id: string; label: string }> = [];
  const pager = await geminiClient(apiKey, baseUrl).models.list();
  for await (const m of pager) {
    const id = (m.name ?? "").replace(/^models\//, "");
    if (!/^gemini-/.test(id) || (m.supportedActions && !m.supportedActions.includes("generateContent"))) continue;
    out.push({ id, label: m.displayName ?? id });
  }
  return out.sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
}
