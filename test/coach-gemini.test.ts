/** The coach on Gemini against a mock Gen AI endpoint: tools, streaming, signatures, models. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDisk } from "../src/disk-node.ts";
import { Coach, type CoachEvent } from "../src/coach.ts";
import { Library } from "../src/library.ts";

const requests: Array<{ path: string; body: any; key: string | null }> = [];
let server: ReturnType<typeof Bun.serve>;

const sse = (chunks: object[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const chunk = (parts: object[], finishReason?: string) => ({ candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}), index: 0 }] });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = req.headers.get("x-goog-api-key") ?? url.searchParams.get("key");
      const body = req.method === "POST" ? await req.json() : null;
      requests.push({ path: url.pathname, body, key });
      if (key !== "AIza-test") return Response.json({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }, { status: 400 });
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({
          models: [
            { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedActions: ["generateContent", "countTokens"] },
            { name: "models/gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite", supportedActions: ["generateContent"] },
            { name: "models/text-embedding-005", displayName: "Embedding", supportedActions: ["embedContent"] },
          ],
        });
      }
      const contents = body.contents as Array<{ role: string; parts: any[] }>;
      const answered = contents.at(-1)!.parts.some((p) => p.functionResponse);
      if (!answered) {
        // Think (a signed function call), say a word, ask for takeaways.
        return sse([chunk([{ text: "Let me " }]), chunk([{ text: "check." }]), chunk([{ functionCall: { id: "call_1", name: "get_takeaways", args: {} }, thoughtSignature: "c2lnLTE=" }], "STOP")]);
      }
      return sse([chunk([{ text: " You are " }]), chunk([{ text: "doing well." }], "STOP")]);
    },
  });
});
afterAll(() => server.stop(true));

async function run(coach: Coach, conv: string | null, text: string) {
  const events: CoachEvent[] = [];
  for await (const e of coach.chat(conv, text)) events.push(e);
  return events;
}

test("coach on Gemini: tool round trip, streamed text, signatures echoed, history append-only", async () => {
  const root = mkdtempSync(join(tmpdir(), "tartan-gemini-"));
  const coach = new Coach(new Library(new NodeDisk(root)), { googleBaseUrl: server.url.toString().replace(/\/$/, "") });
  expect((await coach.status()).ready).toBe(false);
  await coach.saveSettings({ provider: "google", googleKey: "AIza-test", googleModel: "gemini-3.8-flash" });
  const st = await coach.status();
  expect(st).toMatchObject({ ready: true, provider: "google", model: "gemini-3.8-flash", keySource: "saved in Tartan" });
  expect(st.providers.map((p) => p.id)).toEqual(["anthropic", "google"]);

  const events = await run(coach, null, "How am I doing?");
  const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
  expect(text).toBe("Let me check. You are doing well.");
  expect(events.some((e) => e.type === "tool" && e.name === "get_takeaways")).toBe(true);
  expect(events.at(-1)).toEqual({ type: "done", stop: "stop" });

  const calls = requests.filter((r) => r.path.endsWith(":streamGenerateContent"));
  expect(calls).toHaveLength(2);
  expect(calls[0]!.path).toContain("/models/gemini-3.8-flash:streamGenerateContent");
  expect(calls[0]!.body.systemInstruction.parts[0].text).toContain("Tartan Coach");
  expect(calls[0]!.body.tools[0].functionDeclarations.some((f: any) => f.name === "get_takeaways")).toBe(true);
  // The second request carries the model's turn as returned (signature included) and the tool result.
  const second = calls[1]!.body.contents;
  const modelTurn = second.find((c: any) => c.role === "model");
  expect(modelTurn.parts.find((p: any) => p.functionCall).thoughtSignature).toBe("c2lnLTE=");
  const result = second.at(-1).parts[0].functionResponse;
  expect(result).toMatchObject({ id: "call_1", name: "get_takeaways" });
  expect(result.response.output).toBeDefined();

  // Switching the default provider later doesn't move this conversation off Gemini.
  await coach.saveSettings({ provider: "anthropic" });
  const conv = (events[0] as { id: string }).id;
  const again = await run(coach, conv, "And next week?");
  expect(again.at(-1)).toMatchObject({ type: "done" });
  expect(requests.filter((r) => r.path.endsWith(":streamGenerateContent"))).toHaveLength(4);
  expect((await coach.conversation(conv))!.display.filter((d) => d.role === "user")).toHaveLength(2);

  expect(await coach.listModels("google")).toEqual([
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  ]);
});

test("coach on Gemini: a rejected key says so; the question stays in the chat, marked, out of what the model reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "tartan-gemini-"));
  const coach = new Coach(new Library(new NodeDisk(root)), { googleBaseUrl: server.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ provider: "google", googleKey: "wrong" });
  const events = await run(coach, null, "Hello");
  expect(events.at(-1)).toEqual({ type: "error", message: "Google rejected the API key. Check it in Coach settings." });
  const id = (events[0] as { id: string }).id;
  const display = (await coach.conversation(id))!.display;
  expect(display).toMatchObject([{ role: "user", text: "Hello", failed: true }, { role: "assistant", failed: true, error: "Google rejected the API key. Check it in Coach settings." }]);
  // Asked again with a key that works: the model reads only the new question.
  await coach.saveSettings({ googleKey: "AIza-test" });
  requests.length = 0;
  await run(coach, id, "Hello again");
  const sent = requests.find((r) => r.path.endsWith(":streamGenerateContent"))!.body.contents as Array<{ parts: Array<{ text?: string }> }>;
  expect(sent.flatMap((c) => c.parts.map((p) => p.text ?? ""))).not.toContain("Hello");
  expect(sent.flatMap((c) => c.parts.map((p) => p.text ?? ""))).toContain("Hello again");
});

test("coach on Gemini: a connection that drops before any words is asked again, and said plainly when it drops twice", async () => {
  const { geminiError } = await import("../src/coach-gemini.ts");
  expect(geminiError(new TypeError("Failed to fetch"))).toMatch(/Couldn't reach Google: the connection dropped/);
});

test("coach on Gemini: a photo goes as inline data before the words", async () => {
  const root = mkdtempSync(join(tmpdir(), "tartan-gemini-photo-"));
  const coach = new Coach(new Library(new NodeDisk(root)), { googleBaseUrl: server.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ provider: "google", googleKey: "AIza-test", googleModel: "gemini-3.8-flash" });
  requests.length = 0;
  for await (const _ of coach.chat(null, "Is this meal enough before a long run?", { images: [{ mime: "image/webp", data: "UklGRg==" }] })) void _;
  const parts = requests.find((r) => r.path.endsWith(":streamGenerateContent"))!.body.contents[0].parts as Array<Record<string, unknown>>;
  expect(parts.at(-2)).toEqual({ inlineData: { mimeType: "image/webp", data: "UklGRg==" } });
  expect(parts.at(-1)).toEqual({ text: "Is this meal enough before a long run?" });
});
