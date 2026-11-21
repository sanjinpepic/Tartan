/** Gemini when Google is busy or a streamed answer breaks off: retried, kept, or said plainly. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { geminiError, geminiTurn, type GeminiOptions, type GeminiTurnEvent } from "../src/coach-gemini.ts";

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
  // The lighter model, asked when the chosen one stays busy.
  plans["lite-ok"] = [() => sse(`${chunk("Light ")}\n\n${chunk("answer.", "STOP")}\n\n`)];
  // Headers, then silence: given up on, asked again, then said plainly.
  const hang = () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
  plans["hang"] = [hang, hang];
  plans["hang-once"] = [hang, () => sse(`${chunk("Back.", "STOP")}\n\n`)];
  // A per-minute limit with a short wait: waited out. A day's quota: said, not retried.
  const limited = (details: unknown[]) => () => Response.json({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED", details } }, { status: 429 });
  plans["minute-limit"] = [limited([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.05s" }]), () => sse(`${chunk("Waited.", "STOP")}\n\n`)];
  const perDay = limited([{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.05s" }]);
  plans["day-limit"] = [perDay, perDay, perDay];
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

async function turn(model: string, more: Partial<GeminiOptions> = {}) {
  const contents = [{ role: "user", parts: [{ text: "How am I doing?" }] }];
  const events: GeminiTurnEvent[] = [];
  let error: unknown;
  try {
    for await (const e of geminiTurn(contents, { apiKey: "AIza-test", model, system: "", tools: [], maxRounds: 3, maxResultChars: 1000, baseUrl: server.url.toString().replace(/\/$/, ""), retryDelay: 0.01, ...more })) events.push(e);
  } catch (e) {
    error = e;
  }
  const text = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
  return { text, stop: events.find((e) => e.type === "stop")?.stop, error, contents, busy: events.some((e) => e.type === "tool" && e.name === "busy"), model: events.find((e) => e.type === "model")?.model };
}

test("an overloaded model is asked again", async () => {
  // Said as a step, so a slow answer has its reason.
  expect(await turn("busy-once")).toMatchObject({ text: "Fine now.", stop: "STOP", busy: true });
  expect(calls["busy-once"]).toBe(2);
});

test("still overloaded after four tries: said plainly", async () => {
  const r = await turn("busy-always");
  expect(calls["busy-always"]).toBe(4);
  expect(geminiError(r.error)).toContain("too busy");
});

test("still overloaded: the lighter model answers instead, and says it's the one answering", async () => {
  calls["busy-always"] = 0;
  const r = await turn("busy-always", { fallback: "lite-ok" });
  expect(r).toMatchObject({ text: "Light answer.", stop: "STOP", model: "lite-ok" });
});

test("a connection gone quiet is given up on and asked again", async () => {
  expect(await turn("hang-once", { stall: { first: 0.2, between: 0.2 } })).toMatchObject({ text: "Back.", stop: "STOP" });
  const r = await turn("hang", { stall: { first: 0.2, between: 0.2 } });
  expect(calls["hang"]).toBe(2);
  expect(geminiError(r.error)).toContain("stopped answering");
});

test("a per-minute limit with a short wait is waited out; a day's quota is said, not retried", async () => {
  expect(await turn("minute-limit")).toMatchObject({ text: "Waited.", stop: "STOP" });
  const r = await turn("day-limit");
  expect(calls["day-limit"]).toBe(1);
  expect(geminiError(r.error)).toContain("today's requests");
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
