/** Gemini when Google is busy or a streamed answer breaks off: retried, kept, or said plainly. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { geminiError, geminiTurn, type GeminiTurnEvent } from "../src/coach-gemini.ts";

const chunk = (text: string, finishReason?: string) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, ...(finishReason ? { finishReason } : {}), index: 0 }] })}`;
const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
/** What each model answers, by call: a list of responses taken in turn. */
const plans: Record<string, Array<() => Response>> = {};
const calls: Record<string, number> = {};
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  const busy = () => Response.json({ error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }, { status: 503 });
  plans["busy-once"] = [busy, () => sse(`${chunk("Fine ")}\n\n${chunk("now.", "STOP")}\n\n`)];
  plans["busy-always"] = [busy, busy, busy, busy];
  // The last event without the blank line after it: still read.
  plans["no-tail"] = [() => sse(`${chunk("All ")}\n\n${chunk("there.", "STOP")}`)];
  // Cut in the middle of the first event: asked again.
  plans["cut-early"] = [() => sse(`data: {"candidates":[{"content":{"ro`), () => sse(`${chunk("Second ")}\n\n${chunk("try.", "STOP")}\n\n`)];
  // Cut after words were shown: they stay, and the turn says so.
  plans["cut-late"] = [() => sse(`${chunk("Half an ")}\n\ndata: {"candidates":[{"content":{"ro`)];
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const model = /models\/([^:]+):/.exec(new URL(req.url).pathname)?.[1] ?? "";
      const n = (calls[model] = (calls[model] ?? 0) + 1);
      return plans[model]![n - 1]!();
    },
  });
});
afterAll(() => server.stop(true));

async function turn(model: string) {
  const contents = [{ role: "user", parts: [{ text: "How am I doing?" }] }];
  const events: GeminiTurnEvent[] = [];
  let error: unknown;
  try {
    for await (const e of geminiTurn(contents, { apiKey: "AIza-test", model, system: "", tools: [], maxRounds: 3, maxResultChars: 1000, baseUrl: server.url.toString().replace(/\/$/, ""), retryDelay: 0.01 })) events.push(e);
  } catch (e) {
    error = e;
  }
  const text = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
  return { text, stop: events.find((e) => e.type === "stop")?.stop, error, contents, busy: events.some((e) => e.type === "tool" && e.name === "busy") };
}

test("an overloaded model is asked again", async () => {
  // Said as a step, so a slow answer has its reason.
  expect(await turn("busy-once")).toMatchObject({ text: "Fine now.", stop: "STOP", busy: true });
  expect(calls["busy-once"]).toBe(2);
});

test("still overloaded after three tries: said plainly", async () => {
  const r = await turn("busy-always");
  expect(calls["busy-always"]).toBe(3);
  expect(geminiError(r.error)).toContain("too busy for this model");
});

test("a last event without its blank line is still read", async () => {
  expect(await turn("no-tail")).toMatchObject({ text: "All there.", stop: "STOP", busy: false });
});

test("a stream cut before any words is asked again", async () => {
  expect(await turn("cut-early")).toMatchObject({ text: "Second try.", stop: "STOP" });
  expect(calls["cut-early"]).toBe(2);
});

test("a stream cut after words keeps them and says it was cut", async () => {
  const r = await turn("cut-late");
  expect(r).toMatchObject({ text: "Half an ", stop: "CUT" });
  expect(r.contents.at(-1)).toEqual({ role: "model", parts: [{ text: "Half an " }] });
});
