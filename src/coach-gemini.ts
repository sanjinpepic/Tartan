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
  type: "text" | "tool" | "stop" | "model";
  /** "model": the model now answering (the lighter one, when the chosen one is too busy). */
  model?: string;
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
   * How long it thinks before answering, on Gemini 3 and later (sent always: 3.8 Flash's own
   * default is medium, Flash-Lite's minimal, which can stop a lookup short).
   */
  thinking?: "low" | "medium" | "high";
  /** Asked instead, once, when the chosen model is still too busy after the retries. */
  fallback?: string;
  /** Seconds with nothing from Google before the attempt counts as dropped (first answer, then between parts). */
  stall?: { first: number; between: number };
  /** Tests: a mock endpoint. */
  baseUrl?: string;
  /** Tests: seconds before the first retry. */
  retryDelay?: number;
}

/** Google's busy, timeout and gateway answers: worth a few more tries before saying so. */
const BUSY = [408, 500, 502, 503, 504];

export function geminiClient(apiKey: string, baseUrl?: string, retryDelay = 1, onBusy?: () => void): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    // The SDK's own default moved to v1 in 3.0; v1beta is what Tartan's calls were made against.
    apiVersion: "v1beta",
    httpOptions: {
      ...(baseUrl ? { baseUrl } : {}),
      // An overloaded model (503) often answers on the next try; only before anything streamed.
      // Seconds: 1, 2, 4 (with jitter), so a busy model has had about 7 s to clear.
      retryOptions: { attempts: 4, initialDelay: retryDelay, maxDelay: retryDelay * 8, httpStatusCodes: BUSY },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        let res = await sseClosed(input, init);
        // A per-minute limit says how long to wait: waited out once, when it's short. A day's
        // quota isn't retried (it won't clear), and neither is a long wait.
        if (res.status === 429) {
          const wait = await rateWait(res.clone());
          if (wait !== null && wait <= 12 * retryDelay) {
            onBusy?.();
            await new Promise((r) => setTimeout(r, wait * 1000));
            res = await sseClosed(input, init);
          }
        }
        if (BUSY.includes(res.status)) onBusy?.();
        return res;
      },
    },
  });
}

/** Seconds a 429 asks to wait (RetryInfo, else Retry-After), or null for a day's quota or none said. */
async function rateWait(res: Response): Promise<number | null> {
  const body = (await res.json().catch(() => null)) as { error?: { details?: Array<Record<string, unknown>> } } | null;
  const details = body?.error?.details ?? [];
  if (JSON.stringify(details).match(/PerDay/i)) return null;
  const info = details.find((d) => String(d["@type"] ?? "").endsWith("RetryInfo"))?.retryDelay;
  const secs = typeof info === "string" ? parseFloat(info) : Number(res.headers.get("retry-after"));
  return Number.isFinite(secs) && secs >= 0 ? secs : null;
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

const LEVEL = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH } as const;

/** Gemini 3 and later take a thinking level (earlier ones refuse it). */
export const thinksInLevels = (model: string) => /^gemini-([3-9]|\d{2,})(\.|-)/.test(model);

const QUIET = "Google went quiet";
/** A response's parts as kept in the history: thought summaries without a signature left out. */
const kept = (parts: Part[]) => parts.filter((p) => !(p.thought && !p.thoughtSignature));

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
  let model = o.model;
  let busyError: ApiError | null = null;
  let level: "low" | "medium" | "high" | null = null;
  let noLevel = false;
  let saidAny = false;
  const stall = o.stall ?? { first: 90, between: 60 };
  for (let round = 0; round < o.maxRounds; round++) {
    const parts: Part[] = [];
    let said = false;
    // A connection gone quiet (a phone network can drop one without a word): given up on, so
    // it's asked again rather than waited on for ever. Thought summaries keep it talking.
    const quiet = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (secs: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => quiet.abort(new Error("Google went quiet: the connection was dropped")), secs * 1000);
    };
    wait(stall.first);
    try {
      level = o.thinking && thinksInLevels(model) && !noLevel ? o.thinking : null;
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: o.system,
          tools: [{ functionDeclarations }],
          abortSignal: quiet.signal,
          ...(level ? { thinkingConfig: { thinkingLevel: LEVEL[level], includeThoughts: true } } : {}),
        },
      });
      if (busy && !toldBusy) {
        toldBusy = true;
        yield { type: "tool", name: "busy" };
      }
      for await (const chunk of stream) {
        wait(stall.between);
        const cand = chunk.candidates?.[0];
        for (const part of cand?.content?.parts ?? []) {
          parts.push(part);
          if (part.text && !part.thought) {
            said = saidAny = true;
            yield { type: "text", delta: part.text };
          }
        }
        if (cand?.finishReason) stop = String(cand.finishReason);
      }
    } catch (e) {
      // Still busy after the retries, before a word of this turn: the lighter model, once.
      if (e instanceof ApiError && BUSY.includes(e.status) && o.fallback && model !== o.fallback && !saidAny) {
        busyError = e;
        model = o.fallback;
        yield { type: "model", model };
        round--;
        continue;
      }
      // A model that doesn't take this thinking level (a newer one may not): its own default, once.
      if (e instanceof ApiError && e.status === 400 && level && !noLevel && /thinking/i.test(e.message)) {
        noLevel = true;
        round--;
        continue;
      }
      // The lighter model refusing what the busy one left in the history: the busy answer stands.
      if (busyError && e instanceof ApiError && e.status === 400) throw busyError;
      if (!cutOff(e) && !quiet.signal.aborted) throw e;
      // Broke off before a word showed: ask again, once. After words: keep them, say it was cut.
      if (!said && !retried) {
        retried = true;
        round--;
        continue;
      }
      if (!said) throw quiet.signal.aborted ? new Error(QUIET) : e;
      contents.push({ role: "model", parts: kept(parts).filter((p) => !p.functionCall) });
      yield { type: "stop", stop: "CUT" };
      return;
    } finally {
      clearTimeout(timer);
    }
    // Thought summaries were only for the wait; a part carrying a signature goes back as it came.
    contents.push({ role: "model", parts: kept(parts) });
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
    if (e.status === 429 && /per ?day/i.test(e.message)) return "This Gemini key has used today's requests for this model. It resets tomorrow; a paid key in AI Studio lifts the limit, or pick another model in Coach settings.";
    if (e.status === 429) return "Google says this key is asking too often. Try again in a minute.";
    if (e.status === 503) return "Google's servers are too busy right now (Tartan tried four times, and the lighter model too). Try again in a few minutes.";
    if (BUSY.includes(e.status)) return `Google had a problem answering (error ${e.status}, tried four times). Try again in a few minutes.`;
    return `Gemini API error ${e.status}: ${e.message}`;
  }
  if (String((e as Error)?.message ?? e).startsWith(QUIET)) return "Google stopped answering partway (asked twice). Ask again; if it keeps happening, the connection may be dropping.";
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
