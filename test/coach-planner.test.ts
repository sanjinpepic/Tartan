/**
 * Who writes the plan and runs the weekly review (the planner): a cloud key when there is one,
 * whatever the chat runs on; Tartan's rules without. A phone model explains, it doesn't plan.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Coach, type CoachEvent } from "../src/coach.ts";
import type { HubState, ModelHubClient } from "../src/coach-litert.ts";
import { MemoryDisk } from "../src/disk.ts";
import { Plans, today } from "../src/plan.ts";
import { Library } from "../src/library.ts";

type Reply = { text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> };

/** Model Hub, ready: plays `script` (then one line each time); keeps what it was started with and sent. */
function hub(script: Reply[] = []) {
  const started: unknown[] = [];
  const sent: unknown[] = [];
  let i = 0;
  const state: HubState = { installed: true, allowed: true, model: "Gemma-4-E2B-it", context: 4096 };
  const counted = { state: 0 };
  const client: ModelHubClient = {
    state: async () => (counted.state++, state),
    status: async () => ({ name: state.model, loaded: false }),
    load: async () => ({ backend: "Tensor TPU, through Model Hub", context: 4096 }),
    start: async (_id, o) => void started.push(o),
    send: async (_id, m, onText) => {
      sent.push(m);
      const r = script[i++] ?? { text: "Easy today." };
      if (r.text) onText(r.text);
      return { text: r.text ?? "", toolCalls: r.toolCalls ?? [] };
    },
    end: async () => {},
  };
  return { client, started, sent, counted };
}

/** A Gemini API that answers in a word and counts what it's asked. */
let gemini: ReturnType<typeof Bun.serve>;
const asked: string[] = [];
const bodies: string[] = [];
beforeAll(() => {
  gemini = Bun.serve({
    port: 0,
    async fetch(req) {
      asked.push(new URL(req.url).pathname);
      bodies.push(await req.text());
      const chunk = { candidates: [{ content: { role: "model", parts: [{ text: "Here is your plan." }] }, finishReason: "STOP", index: 0 }] };
      return new Response(`data: ${JSON.stringify(chunk)}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
});
afterAll(() => gemini.stop(true));

const collect = async (g: AsyncGenerator<CoachEvent>) => {
  const out: CoachEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
};

test("chat on Model Hub with a Gemini key: Gemini plans; kept on the phone, the chat stays there", async () => {
  const h = hub();
  const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.client, googleBaseUrl: gemini.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ provider: "modelhub", googleKey: "AIza-test", phoneOnly: true });
  expect((await coach.status()).planner).toEqual({ choice: "auto", uses: "google", model: "Gemini 3.8 Flash" });
  expect((await coach.status()).answers).toBe("Gemma 4 E2B on your phone");

  asked.length = 0;
  const plan = await collect(coach.updatePlan());
  expect(asked.some((p) => p.endsWith(":streamGenerateContent"))).toBe(true);
  expect(h.started).toHaveLength(0);
  expect(plan.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Here is your plan.");

  // A new chat is still Model Hub's.
  await collect(coach.chat(null, "Should I run today?"));
  expect(h.started).toHaveLength(1);
});

test("no cloud key: Tartan's rules plan, the phone explains; chosen rules stay rules", async () => {
  const h = hub();
  const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.client });
  await coach.saveSettings({ provider: "modelhub" });
  expect((await coach.status()).planner).toEqual({ choice: "auto", uses: "rules" });

  const withKey = new Coach(new Library(new MemoryDisk()), { modelHub: hub().client });
  await withKey.saveSettings({ provider: "modelhub", googleKey: "AIza-test", planner: "rules" });
  expect((await withKey.status()).planner).toEqual({ choice: "rules", uses: "rules" });
  // Claude named but no Anthropic key: Tartan's rules rather than nothing.
  await withKey.saveSettings({ planner: "anthropic" });
  expect((await withKey.status()).planner.uses).toBe("rules");
});

test("chat on a cloud key: that provider plans too", async () => {
  const coach = new Coach(new Library(new MemoryDisk()), { modelHub: hub().client });
  await coach.saveSettings({ provider: "google", googleKey: "AIza-test", apiKey: "sk-ant-test" });
  expect((await coach.status()).planner.uses).toBe("google");
  await coach.saveSettings({ provider: "anthropic" });
  expect((await coach.status()).planner.uses).toBe("anthropic");
  await coach.saveSettings({ planner: "google" });
  expect((await coach.status()).planner).toEqual({ choice: "google", uses: "google", model: "Gemini 3.8 Flash" });
});

test("asked in a Model Hub chat to change the plan, Gemma hands it to Gemini, and says what came of it", async () => {
  const h = hub([{ toolCalls: [{ name: "change_plan", args: { request: "Move my long run to Sunday" } }] }, { text: "Done: Gemini looked at it." }]);
  const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.client, googleBaseUrl: gemini.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ provider: "modelhub", googleKey: "AIza-test", phoneOnly: true });
  asked.length = 0;
  const events = await collect(coach.chat(null, "Move my long run to Sunday"));
  expect(asked.some((p) => p.endsWith(":streamGenerateContent"))).toBe(true);
  const results = (h.sent[1] as { toolResults: Array<{ name: string; result: string }> }).toolResults;
  expect(results[0]!.name).toBe("change_plan");
  expect(results[0]!.result).toContain("Here is your plan.");
  expect(events.at(-1)).toMatchObject({ type: "done" });
  // No cloud key: Tartan's rules write the new plan instead.
  const bare = hub([{ toolCalls: [{ name: "change_plan", args: { request: "A new plan" } }] }, { text: "Done." }]);
  const noKey = new Coach(new Library(new MemoryDisk()), { modelHub: bare.client });
  await noKey.saveSettings({ provider: "modelhub" });
  await collect(noKey.chat(null, "A new plan please"));
  expect(JSON.stringify(bare.sent[1])).toContain("Tartan's rules");
});

test("with no cloud key, Gemma moves a session itself (edit_session): proposed, to accept on the Coach tab", async () => {
  const lib = new Library(new MemoryDisk());
  const plans = new Plans(lib);
  // A plan to change: Tartan's rules, from today.
  const setup = new Coach(lib, { modelHub: hub().client });
  await setup.saveSettings({ provider: "modelhub" });
  await collect(setup.updatePlan());
  const plan = (await plans.current())!;
  const t = today();
  const s = plan.weeks.flatMap((w) => w.sessions).find((x) => x.date > t && x.kind !== "rest")!;
  const to = plan.weeks.flatMap((w) => [0, 1, 2, 3, 4, 5, 6].map((i) => new Date(Date.parse(`${w.start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10))).find((d) => d > s.date && !plan.weeks.some((w) => w.sessions.some((x) => x.date === d)))!;
  const h = hub([{ toolCalls: [{ name: "edit_session", args: { action: "move", date: s.date, to, why: "busy that day" } }] }, { text: "Moved." }]);
  const coach = new Coach(lib, { modelHub: h.client });
  const events = await collect(coach.chat(null, `Move my ${s.title} to ${to}`));
  const result = (h.sent[1] as { toolResults: Array<{ name: string; result: string }> }).toolResults[0]!;
  expect(result.name).toBe("edit_session");
  expect(result.result).toMatch(/Proposed|Saved/);
  const proposal = await plans.proposal();
  const moved = (proposal?.plan ?? (await plans.current())!).weeks.flatMap((w) => w.sessions);
  expect(moved.some((x) => x.date === to && x.title === s.title)).toBe(true);
  expect(events.some((e) => e.type === "plan")).toBe(true);
  // A day behind them stays as it was.
  const past = hub([{ toolCalls: [{ name: "edit_session", args: { action: "drop", date: "2020-01-01" } }] }, { text: "Can't." }]);
  await collect(new Coach(lib, { modelHub: past.client }).chat(null, "Drop that old one"));
  expect(JSON.stringify(past.sent[1])).toContain("behind them");
});

test("a chat begun on Model Hub moves to Gemini when Gemini is chosen, with what was said", async () => {
  const h = hub();
  const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.client, googleBaseUrl: gemini.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ provider: "modelhub" });
  const first = await collect(coach.chat(null, "How am I?"));
  const id = (first[0] as { id: string }).id;
  expect(h.started).toHaveLength(1);
  await coach.saveSettings({ provider: "google", googleKey: "AIza-test" });
  asked.length = 0;
  const next = await collect(coach.chat(id, "And tomorrow?"));
  expect(asked.some((p) => p.endsWith(":streamGenerateContent"))).toBe(true);
  expect(h.started).toHaveLength(1);
  expect(next.at(-1)).toMatchObject({ type: "done" });
  expect((await coach.conversation(id))!.display.map((d) => d.text)).toEqual(["How am I?", "Easy today.", "And tomorrow?", "Here is your plan."]);
});

test("routeOf: a whole new plan, a session change (asked for or wondered about), a bigger question, or the phone", async () => {
  const { routeOf } = await import("../src/coach.ts");
  expect(routeOf("Make me a new plan")).toEqual({ kind: "plan", told: true });
  expect(routeOf("I signed up for a half marathon on 14 March")).toEqual({ kind: "plan", told: true });
  expect(routeOf("Move my long run to Sunday")).toEqual({ kind: "edit", told: true });
  expect(routeOf("Can you make tomorrow an easy run?")).toEqual({ kind: "edit", told: true });
  expect(routeOf("Should I skip today's run?")).toEqual({ kind: "edit", told: false });
  expect(routeOf("How has my pace changed over the last 8 weeks?")).toBeNull();
  expect(routeOf("Should I run today?")).toBeNull();
  expect(routeOf("How was my run yesterday?")).toBeNull();
});

test("a Model Hub chat with a Gemini key: Gemini answers every message there; offline, the phone does", async () => {
  const h = hub();
  const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.client, googleBaseUrl: gemini.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ provider: "modelhub", googleKey: "AIza-test" });
  expect((await coach.status()).answers).toBe("Gemini 3.8 Flash; offline, Gemma 4 E2B on your phone");
  // Nothing to get ready on the phone.
  expect(await coach.prepare(null)).toBeNull();
  asked.length = 0;
  const events = await collect(coach.chat(null, "I was sick last week, did 7.4 km yesterday. I want to keep building to 15 km"));
  expect(asked.some((p) => p.endsWith(":streamGenerateContent"))).toBe(true);
  expect(h.started).toHaveLength(0);
  expect(events).toContainEqual({ type: "by", label: "Gemini 3.8 Flash" });
  expect(events.at(-1)).toMatchObject({ type: "done" });
  const id = (events[0] as { id: string }).id;
  await collect(coach.chat(id, "Should I run today?"));
  expect(h.started).toHaveLength(0);
  const conv = (await coach.conversation(id))!;
  expect(conv.display.map((d) => d.by ?? null)).toEqual([null, "Gemini 3.8 Flash", null, "Gemini 3.8 Flash"]);
  // One chat, still the phone's.
  expect(await coach.conversations()).toHaveLength(1);

  const off = hub();
  const offline = new Coach(new Library(new MemoryDisk()), { modelHub: off.client, googleBaseUrl: "http://127.0.0.1:9" });
  await offline.saveSettings({ provider: "modelhub", googleKey: "AIza-test" });
  const ev = await collect(offline.chat(null, "Am I improving?"));
  expect(ev.some((e) => e.type === "tool" && e.label.startsWith("Couldn't reach Gemini"))).toBe(true);
  expect(off.started).toHaveLength(1);
  expect(ev).toContainEqual({ type: "by", label: "Gemma 4 E2B on your phone" });
  expect(ev.at(-1)).toMatchObject({ type: "done" });
});

test("a whole new plan asked for on the phone goes straight to the planner", async () => {
  const h = hub();
  const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.client, googleBaseUrl: gemini.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ provider: "modelhub", googleKey: "AIza-test" });
  asked.length = 0;
  const events = await collect(coach.chat(null, "I signed up for a half marathon on 14 March, make me a new plan"));
  expect(asked.some((p) => p.endsWith(":streamGenerateContent"))).toBe(true);
  expect(h.started).toHaveLength(0);
  expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Here is your plan.");
  expect(events.filter((e) => e.type === "conversation")).toHaveLength(1);
});

test("kept on the phone, a change Gemma was asked for and didn't make: the planner makes it; with no key, it says the plan hasn't changed", async () => {
  const h = hub([{ text: "Sure, moved it!" }]);
  const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.client, googleBaseUrl: gemini.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ provider: "modelhub", googleKey: "AIza-test", phoneOnly: true });
  asked.length = 0;
  const events = await collect(coach.chat(null, "Move my long run to Sunday"));
  expect(JSON.stringify(h.sent[0])).toContain("call edit_session");
  expect(asked.some((p) => p.endsWith(":streamGenerateContent"))).toBe(true);
  expect(events).toContainEqual({ type: "by", label: "Gemma 4 E2B on your phone, plan by Gemini 3.8 Flash" });
  const id = (events[0] as { id: string }).id;
  expect((await coach.conversation(id))!.display.at(-1)!.text).toBe("Sure, moved it!\n\nHere is your plan.");

  const bare = hub([{ text: "Sure, moved it!" }]);
  const noKey = new Coach(new Library(new MemoryDisk()), { modelHub: bare.client });
  await noKey.saveSettings({ provider: "modelhub" });
  const ev = await collect(noKey.chat(null, "Move my long run to Sunday"));
  expect(ev).toContainEqual({ type: "by", label: "Gemma 4 E2B on your phone" });
  expect(ev.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toContain("The plan hasn't changed");
  // Only wondered about: no note.
  const asking = hub([{ text: "Rest if you're tired." }]);
  const q = new Coach(new Library(new MemoryDisk()), { modelHub: asking.client });
  await q.saveSettings({ provider: "modelhub" });
  const said = await collect(q.chat(null, "Should I skip today's run?"));
  expect(said.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Rest if you're tired.");
});

test("Gemini thinks briefly in the chat, deeply for plans; a turn asks Model Hub how it is once", async () => {
  const h = hub();
  const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.client, googleBaseUrl: gemini.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ provider: "modelhub", googleKey: "AIza-test" });
  bodies.length = 0;
  h.counted.state = 0;
  await collect(coach.chat(null, "Should I run today?"));
  expect(h.counted.state).toBeLessThanOrEqual(1);
  expect(JSON.parse(bodies[0]!).generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "LOW", includeThoughts: true });
  bodies.length = 0;
  await collect(coach.updatePlan());
  expect(JSON.parse(bodies[0]!).generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "HIGH", includeThoughts: true });
  // A model before Gemini 3 isn't sent a level.
  const { thinksInLevels } = await import("../src/coach-gemini.ts");
  expect([thinksInLevels("gemini-3.8-flash"), thinksInLevels("gemini-3.5-flash-lite"), thinksInLevels("gemini-2.5-flash"), thinksInLevels("gemini-10-pro")]).toEqual([true, true, false, true]);
});

test("thinking fits the message: a plan deep, a change some, a question quick", async () => {
  const { effortOf } = await import("../src/coach/routing.ts");
  expect(effortOf("Make me a plan for the Helsinki marathon")).toBe("high");
  expect(effortOf("Move my long run to Sunday")).toBe("medium");
  expect(effortOf("How many lengths should I aim for? One is 25 m")).toBe("low");
  expect(effortOf("How many lengths should I aim for?", true)).toBe("high");
});
