/** The coach loop against a mock Anthropic streaming endpoint. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDisk } from "../src/disk-node.ts";
import { Coach, type CoachEvent } from "../src/coach.ts";
import { Library } from "../src/library.ts";

const requests: Array<{ body: any; headers: Headers }> = [];
let server: ReturnType<typeof Bun.serve>;

function sse(events: object[]): Response {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const start = (id: string) => ({ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
const end = (stop: string) => [{ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" }];
const textBlock = (i: number, parts: string[]) => [
  { type: "content_block_start", index: i, content_block: { type: "text", text: "" } },
  ...parts.map((t) => ({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index: i },
];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      requests.push({ body, headers: req.headers });
      const last = body.messages.at(-1);
      const hasToolResult = Array.isArray(last.content) && last.content.some((b: any) => b.type === "tool_result");
      if (req.headers.get("x-api-key") !== "sk-test") return Response.json({ type: "error", error: { type: "authentication_error", message: "bad key" } }, { status: 401 });
      if (!hasToolResult) {
        // First call of a turn: say a word, then ask for takeaways.
        return sse([
          start("msg_1"),
          ...textBlock(0, ["Let me ", "check."]),
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_takeaways", input: {} } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
          { type: "content_block_stop", index: 1 },
          ...end("tool_use"),
        ]);
      }
      return sse([start("msg_2"), ...textBlock(0, [" You are ", "doing well."]), ...end("end_turn")]);
    },
  });
});
afterAll(() => server.stop(true));

async function run(coach: Coach, conv: string | null, text: string) {
  const events: CoachEvent[] = [];
  for await (const e of coach.chat(conv, text)) events.push(e);
  return events;
}

test("coach: tool round trip, streaming text, append-only history", async () => {
  const root = mkdtempSync(join(tmpdir(), "tartan-coach-"));
  const coach = new Coach(new Library(new NodeDisk(root)), { baseURL: server.url.toString().replace(/\/$/, "") });

  expect((await run(coach, null, "How am I doing?")).at(-1)).toEqual({ type: "error", message: "Add your Anthropic API key in Coach settings first." });

  await coach.saveSettings({ apiKey: "sk-wrong" });
  expect((await run(coach, null, "hi")).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("rejected the API key") });

  await coach.saveSettings({ apiKey: "sk-test" });
  expect((await coach.status()).keySource).toBe("saved in Tartan");
  requests.length = 0;
  const ev = await run(coach, null, "How am I doing?");
  const id = (ev[0] as { id: string }).id;
  expect(ev.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Let me check. You are doing well.");
  expect(ev.find((e) => e.type === "tool")).toMatchObject({ name: "get_takeaways", label: "Checking your takeaways" });
  expect(ev.at(-1)).toEqual({ type: "done", stop: "end_turn" });

  // Request shape.
  const first = requests[0]!;
  // Sonnet answers the chat by default; plans take Opus (plan.test.ts).
  expect(first.body.model).toBe("claude-sonnet-5-5");
  expect(first.body.fallbacks).toBe("default");
  expect(first.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
  expect(first.body.output_config).toEqual({ effort: "medium" });
  expect(first.body.cache_control).toEqual({ type: "ephemeral" });
  expect(first.body.thinking).toBeUndefined();
  const takeTool = first.body.tools.find((t: any) => t.name === "get_takeaways");
  expect(takeTool.eager_input_streaming).toBe(true);
  expect(first.body.tools.some((t: any) => t.name === "sync_strava")).toBe(false); // coach is read-only
  // The tool really ran on the (empty) library.
  const toolResult = requests[1]!.body.messages.at(-1).content[0];
  expect(toolResult.tool_use_id).toBe("toolu_1");
  expect(JSON.parse(toolResult.content)[0].id).toBe("empty");

  // Turn two extends turn one exactly: nothing edited.
  const turn1 = requests[1]!.body.messages;
  requests.length = 0;
  await run(coach, id, "And next week?");
  const turn2 = requests[0]!.body.messages;
  expect(turn2.slice(0, turn1.length + 1)).toEqual([...turn1, turn2[turn1.length]]);
  expect(turn2[turn1.length].role).toBe("assistant");

  const saved = await coach.conversation(id);
  expect(saved!.display.map((d) => d.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect((await coach.conversations())[0]!.id).toBe(id);
});

test("the weekly review: in the plan's conversation, told what to look at and when not to change", async () => {
  const { Plans, mondayOf, today } = await import("../src/plan.ts");
  const root = mkdtempSync(join(tmpdir(), "tartan-weekly-"));
  const lib = new Library(new NodeDisk(root));
  const coach = new Coach(lib, { baseURL: server.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ apiKey: "sk-test" });
  // No plan: nothing to review.
  const none: CoachEvent[] = [];
  for await (const e of coach.weeklyReview("2026-10-19")) none.push(e);
  expect(none).toEqual([{ type: "error", message: "No plan to review." }]);
  const monday = mondayOf(today());
  await new Plans(lib).save({ title: "Base", summary: "Easy running.", weeks: [{ start: monday, focus: "Build", sessions: [{ date: monday, kind: "easy", title: "Easy run", duration_min: 40 }] }] } as never, { conversation: "plan-conv" });
  requests.length = 0;
  const ev: CoachEvent[] = [];
  for await (const e of coach.weeklyReview("2026-10-19")) ev.push(e);
  expect(ev.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Let me check. You are doing well.");
  const sent = JSON.stringify(requests[0]!.body.messages.at(-1));
  expect(sent).toContain("Weekly review for the week starting Monday 2026-10-19");
  expect(sent).toContain("If not, don't save.");
});

test("the coach's notes ride in a conversation's first turn, and again only after they change", async () => {
  const root = mkdtempSync(join(tmpdir(), "tartan-coach-mem-"));
  const lib = new Library(new NodeDisk(root));
  const coach = new Coach(lib, { baseURL: server.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ apiKey: "sk-test" });
  const { Memory } = await import("../src/memory.ts");
  const memory = new Memory(lib.disk);
  await memory.remember("Left knee gets sore on long descents.", "health");
  requests.length = 0;
  const events = await run(coach, null, "How am I doing?");
  const id = (events.find((e) => e.type === "conversation") as { id: string }).id;
  const firstTurn = JSON.stringify(requests[0]!.body.messages.at(-1));
  expect(firstTurn).toContain("What you remember about this athlete");
  expect(firstTurn).toContain("Left knee gets sore on long descents.");
  expect(requests[0]!.body.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["remember", "update_memory", "forget_memory", "get_memory"]));
  expect(JSON.stringify(requests[0]!.body.system)).toContain("Memory:");

  requests.length = 0;
  await run(coach, id, "And next week?");
  expect(JSON.stringify(requests[0]!.body.messages.at(-1))).not.toContain("What you remember");

  await memory.remember("Long runs on Saturday.", "preference");
  requests.length = 0;
  await run(coach, id, "Anything else?");
  expect(JSON.stringify(requests[0]!.body.messages.at(-1))).toContain("Your notes changed");
});

test("coach: a photo goes to Claude as an image block before the words, and stays out when photos are off", async () => {
  const root = mkdtempSync(join(tmpdir(), "tartan-coach-photo-"));
  const coach = new Coach(new Library(new NodeDisk(root)), { baseURL: server.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ apiKey: "sk-test" });
  const photo = { mime: "image/jpeg", data: "/9j/4AAQSkZJRgABAQ==", thumb: "data:image/jpeg;base64,/9j/4AAQ" };
  requests.length = 0;
  const ev: CoachEvent[] = [];
  for await (const e of coach.chat(null, "Are these shoes worn out?", { images: [photo] })) ev.push(e);
  const content = requests[0]!.body.messages[0].content as Array<{ type: string; source?: { type: string; data: string; media_type: string } }>;
  expect(content.at(-2)).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photo.data } });
  expect(content.at(-1)).toMatchObject({ type: "text", text: "Are these shoes worn out?" });
  const id = (ev[0] as { id: string }).id;
  expect((await coach.conversation(id))!.display[0]).toMatchObject({ role: "user", image: photo.thumb });

  await coach.saveSettings({ photos: false });
  expect(await coach.status()).toMatchObject({ photos: false, voice: true });
  requests.length = 0;
  for await (const _ of coach.chat(null, "And now?", { images: [photo] })) void _;
  expect(JSON.stringify(requests[0]!.body.messages)).not.toContain(photo.data);
  // Not a picture at all: never sent.
  await coach.saveSettings({ photos: true });
  requests.length = 0;
  for await (const _ of coach.chat(null, "This?", { images: [{ mime: "text/html", data: "PGgxPg==" }] })) void _;
  expect(JSON.stringify(requests[0]!.body.messages)).not.toContain("PGgxPg");
});
