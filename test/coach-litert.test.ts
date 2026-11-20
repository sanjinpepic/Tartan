import { describe, expect, test } from "bun:test";
import { Coach, type CoachEvent } from "../src/coach.ts";
import { LOCAL_TOOLS, localError, localTurn, toolDescriptions, type HubState, type PhoneModel, type ModelHubClient } from "../src/coach-litert.ts";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import { dataTools } from "../src/tools.ts";

type Script = Array<{ text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }>;

/** A stand-in for a model on the phone: plays a script, one reply per message, and keeps what it was sent. */
function fakeFile(script: Script, file: { name?: string } = { name: "Gemma-4-E2B-it" }) {
  const sent: Array<Parameters<PhoneModel["send"]>[1]> = [];
  const started: Array<Parameters<PhoneModel["start"]>[1]> = [];
  const ended: string[] = [];
  let i = 0;
  const model: PhoneModel = {
    status: async () => ({ ...file, loaded: false }),
    load: async () => ({ backend: "Tensor NPU" }),
    start: async (_id, o) => void started.push(o),
    send: async (_id, msg, onText) => {
      sent.push(msg);
      const r = script[i++] ?? { text: "Done." };
      for (const w of (r.text ?? "").match(/\S+\s*/g) ?? []) onText(w);
      return { text: r.text ?? "", toolCalls: r.toolCalls ?? [] };
    },
    end: async (id) => void ended.push(id),
  };
  return { model, sent, started, ended };
}

const collect = async <T,>(g: AsyncGenerator<T>) => {
  const out: T[] = [];
  for await (const e of g) out.push(e);
  return out;
};

describe("the coach on a model on the phone (its tool loop)", () => {
  const tools = dataTools(new Library(new MemoryDisk()), { allowSync: false });

  test("a few read-only tools, described short enough for a phone's context", () => {
    const d = toolDescriptions(tools).map((x) => JSON.parse(x) as { name: string; description: string; parameters: { type: string } });
    // edit_session and change_plan are the coach's own (it changes the plan): not among the data tools.
    expect(d.map((x) => x.name)).toEqual(LOCAL_TOOLS.filter((n) => n !== "change_plan" && n !== "edit_session"));
    expect(d.every((x) => x.description.length <= 280 && x.parameters.type === "object")).toBe(true);
    expect(toolDescriptions(tools).join("").length).toBeLessThan(9000);
  });

  test("it calls tools, gets their results back, then answers; bad calls get an error, not a crash", async () => {
    const f = fakeFile([
      { toolCalls: [{ name: "get_readiness", args: {} }, { name: "save_training_plan", args: {} }, { name: "list_activities", args: { limit: "lots" } }] },
      { text: "You're fresh: run the tempo today." },
    ]);
    const events = await collect(localTurn({ model: f.model, tools, system: "sys", history: [{ role: "user", text: "Hi" }], text: "Should I run?" }));
    expect(events[0]).toEqual({ type: "loaded", backend: "Tensor NPU" });
    expect(events.filter((e) => e.type === "tool").map((e) => (e as { name: string }).name)).toEqual(["get_readiness", "save_training_plan", "list_activities"]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("You're fresh: run the tempo today.");
    expect(f.started[0]).toMatchObject({ system: "sys", history: [{ role: "user", text: "Hi" }] });
    expect(f.sent[0]).toEqual({ text: "Should I run?" });
    const results = (f.sent[1] as { toolResults: Array<{ name: string; result: string }> }).toolResults;
    expect(results.map((r) => r.name)).toEqual(["get_readiness", "save_training_plan", "list_activities"]);
    expect(results[1]!.result).toContain("No tool called save_training_plan"); // not one it was given
    expect(results[2]!.result).toContain("error"); // limit must be a number
    expect(results.every((r) => r.result.length <= 2600)).toBe(true);
    expect(f.ended).toHaveLength(1);
  });

  test("it stops looking things up after five rounds", async () => {
    const f = fakeFile(Array.from({ length: 10 }, () => ({ toolCalls: [{ name: "get_readiness", args: {} }] })));
    const events = await collect(localTurn({ model: f.model, tools, system: "", history: [], text: "?" }));
    expect(events.filter((e) => e.type === "tool")).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({ type: "text", delta: expect.stringContaining("Stopped looking things up") });
  });

  test("a turn that doesn't end in an answer lets its conversation go", async () => {
    // Here the script runs out mid-lookup.
    const g = fakeFile(Array.from({ length: 10 }, () => ({ toolCalls: [{ name: "get_readiness", args: {} }] })));
    await collect(localTurn({ model: g.model, tools, system: "", history: [], text: "?", id: "c1", turns: 4 }));
    expect(g.ended).toEqual(["c1"]);
  });

  test("a small context (a TPU build: 4096 tokens) gets fewer tools, a shorter chat and shorter results", async () => {
    const f = fakeFile([{ toolCalls: [{ name: "get_shoes", args: {} }, { name: "get_readiness", args: {} }] }, { text: "Fine." }]);
    const small: PhoneModel = { ...f.model, load: async () => ({ backend: "Tensor TPU", context: 4096 }) };
    const history = Array.from({ length: 8 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: "x".repeat(500) }));
    await collect(localTurn({ model: small, tools, system: "", history, text: "?" }));
    const tools0 = f.started[0]!.tools.map((t) => (JSON.parse(t) as { name: string }).name);
    expect(tools0).not.toContain("get_shoes");
    expect(tools0).toContain("get_readiness");
    expect(f.started[0]!.history).toHaveLength(4);
    expect(f.started[0]!.history.every((m) => m.text.length <= 301)).toBe(true);
    const results = (f.sent[1] as { toolResults: Array<{ name: string; result: string }> }).toolResults;
    expect(results[0]!.result).toContain("No tool called get_shoes");
    expect(results.every((r) => r.result.length <= 1300)).toBe(true);
  });

  test("a photo goes with the first message only", async () => {
    const f = fakeFile([{ toolCalls: [{ name: "get_shoes", args: {} }] }, { text: "Worn out: retire them." }]);
    await collect(localTurn({ model: f.model, tools, system: "", history: [], text: "These shoes?", image: "/9j/4AAQ" }));
    expect(f.sent[0]).toEqual({ text: "These shoes?", image: "/9j/4AAQ" });
    expect(JSON.stringify(f.sent[1])).not.toContain("/9j/");
  });

  describe("Model Hub (the app that holds the phone's models for every app)", () => {
    /** A stand-in for Model Hub: its state, and a model file's start / send / end playing a script. */
    function fakeHub(state: HubState, script: Script = [{ text: "Easy today." }]) {
      const f = fakeFile(script);
      const hub: ModelHubClient = {
        ...f.model,
        state: async () => state,
        status: async () => ({ name: state.installed && state.allowed ? state.model : undefined, loaded: false }),
        load: async () => ({ backend: "Tensor TPU, through Model Hub", context: 4096 }),
      };
      return { hub, ...f };
    }
    const ready: HubState = { installed: true, allowed: true, model: "Gemma-4-E2B-it", context: 4096, vision: true };

    test("offered once installed; the coach's choice when nothing was chosen and it can answer", async () => {
      const none = new Coach(new Library(new MemoryDisk()), { modelHub: fakeHub({ installed: false, allowed: false }).hub });
      expect((await none.status()).providers.map((p) => p.id)).not.toContain("modelhub");
      expect((await none.status()).provider).toBe("anthropic");

      const asked = new Coach(new Library(new MemoryDisk()), { modelHub: fakeHub({ installed: true, allowed: false }).hub });
      expect(await asked.status()).toMatchObject({ provider: "anthropic", hub: { installed: true, allowed: false } });
      expect((await asked.status()).providers.find((p) => p.id === "modelhub")?.keySource).toBeNull();

      const coach = new Coach(new Library(new MemoryDisk()), { modelHub: fakeHub(ready).hub });
      expect(await coach.status()).toMatchObject({ provider: "modelhub", ready: true, keySource: "Gemma-4-E2B-it" });
    });

    test("a chosen provider stays chosen; Model Hub gone, the coach falls back; a model file's choice is Model Hub's", async () => {
      const lib = new Library(new MemoryDisk());
      const chosen = new Coach(lib, { modelHub: fakeHub(ready).hub });
      await chosen.saveSettings({ provider: "anthropic" });
      expect((await chosen.status()).provider).toBe("anthropic");
      await chosen.saveSettings({ provider: "modelhub" });
      expect((await chosen.status()).provider).toBe("modelhub");
      // Uninstalled, with no cloud key: Claude (which asks for a key).
      const gone = new Coach(lib, { modelHub: fakeHub({ installed: false, allowed: false }).hub });
      expect((await gone.status()).provider).toBe("anthropic");
      // Saved before 2.37 as a model file in Tartan ("litert"): Model Hub now.
      const before = new Library(new MemoryDisk());
      await before.disk.write("coach/settings.json", JSON.stringify({ provider: "litert" }));
      expect((await new Coach(before, { modelHub: fakeHub(ready).hub }).status()).provider).toBe("modelhub");
    });

    test("a chat begun on a model file before 2.37 carries on on Model Hub", async () => {
      const lib = new Library(new MemoryDisk());
      const now = new Date().toISOString();
      await lib.disk.write("coach/conversations/old-chat-1.json", JSON.stringify({ id: "old-chat-1", title: "Old", created: now, updated: now, model: "model-file", provider: "litert", messages: [], display: [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello." }] }));
      const h = fakeHub(ready, [{ text: "Still here." }]);
      const events = await collect(new Coach(lib, { modelHub: h.hub }).chat("old-chat-1", "And now?"));
      expect(events.at(-1)).toMatchObject({ type: "done" });
      expect(h.started[0]).toMatchObject({ turns: 2 });
    });

    test("Gemini Nano, saved before 2.56: Model Hub when it can answer, else a cloud key, else Claude asking for one", async () => {
      const nano = async (hub: ReturnType<typeof fakeHub>["hub"] | undefined, settings: Record<string, unknown> = {}) => {
        const lib = new Library(new MemoryDisk());
        await lib.disk.write("coach/settings.json", JSON.stringify({ provider: "device", ...settings }));
        return new Coach(lib, hub ? { modelHub: hub } : {}).status();
      };
      expect(await nano(fakeHub(ready).hub)).toMatchObject({ provider: "modelhub", ready: true });
      // Installed but not ready: a Gemini key answers instead.
      expect(await nano(fakeHub({ installed: true, allowed: false }).hub, { googleKey: "AIza-test-key-0000000000000" })).toMatchObject({ provider: "google", ready: true });
      expect(await nano(undefined, { apiKey: "sk-ant-test" })).toMatchObject({ provider: "anthropic", ready: true });
      const none = await nano(undefined);
      expect(none).toMatchObject({ provider: "anthropic", ready: false, planner: { uses: "rules" } });
      expect(none.providers.map((p) => p.id)).toEqual(["anthropic", "google"]);
    });

    test("a chat begun on Gemini Nano opens and carries on on the coach's provider", async () => {
      const lib = new Library(new MemoryDisk());
      const now = new Date().toISOString();
      await lib.disk.write("coach/settings.json", JSON.stringify({ provider: "device" }));
      await lib.disk.write("coach/conversations/nano-chat-1.json", JSON.stringify({ id: "nano-chat-1", title: "Nano", created: now, updated: now, model: "gemini-nano", provider: "device", messages: [], display: [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello.", by: "Gemini Nano on your phone" }] }));
      // Nothing set up yet: it still opens, and asking says what to set up.
      const bare = new Coach(lib);
      expect((await bare.conversation("nano-chat-1"))?.display).toHaveLength(2);
      expect((await collect(bare.chat("nano-chat-1", "And now?"))).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("Anthropic API key") });
      // With Model Hub: it carries on there, its earlier words included.
      const h = fakeHub(ready, [{ text: "Still here." }]);
      const events = await collect(new Coach(lib, { modelHub: h.hub }).chat("nano-chat-1", "And now?"));
      expect(events.at(-1)).toMatchObject({ type: "done" });
      expect(h.started[0]).toMatchObject({ turns: 2 });
      const after = await new Coach(lib).conversation("nano-chat-1");
      expect(after?.display.map((d) => d.text)).toEqual(["Hi", "Hello.", "And now?", "Still here."]);
    });

    test("a chat on Model Hub: the same tool loop, a small context's tools, kept between questions", async () => {
      const h = fakeHub(ready, [{ toolCalls: [{ name: "get_readiness", args: {} }] }, { text: "Fresh: run the tempo." }, { text: "And rest on Friday." }]);
      const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.hub });
      const first = await collect(coach.chat(null, "Should I run?"));
      expect(first.filter((e) => e.type === "tool").map((e) => (e as { label: string }).label)).toEqual(["Running on the phone's Tensor TPU, through Model Hub", "Checking how ready you are"]);
      expect(first.at(-1)).toMatchObject({ type: "done" });
      const id = (first[0] as { id: string }).id;
      await collect(coach.chat(id, "And this week?"));
      expect(h.started.map((o) => o.turns)).toEqual([0, 2]);
      // 4096 tokens: the short list of tools.
      expect(h.started[0]!.tools.map((t) => (JSON.parse(t) as { name: string }).name)).not.toContain("get_shoes");
      expect(h.ended).toEqual([]);
    });

    test("the chat screen opens: the chat is prepared, and its question carries on in it", async () => {
      const h = fakeHub(ready, [{ text: "Easy today." }, { text: "Then a tempo." }]);
      const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.hub });
      // A new chat: prepared under the id its first question then takes, with the question's own set-up.
      const id = await coach.prepare(null);
      expect(id).toBeString();
      expect(h.started[0]).toMatchObject({ prepare: true, turns: 0, history: [], temperature: 0.4 });
      const first = await collect(coach.chat(null, "How am I?"));
      expect((first[0] as { id: string }).id).toBe(id!);
      // The question starts with exactly what was prepared, without the prepare.
      const { prepare: _prepared, ...setUp } = h.started[0]!;
      expect(h.started[1]).toEqual(setUp);
      // Back on that chat: prepared again, one question on, with its history.
      expect(await coach.prepare(id)).toBe(id);
      expect(h.started[2]).toMatchObject({ prepare: true, turns: 2 });
      expect(h.started[2]!.history).toHaveLength(2);
    });

    test("nothing prepared off Model Hub, or before it can answer", async () => {
      const ready_ = fakeHub(ready);
      const onClaude = new Coach(new Library(new MemoryDisk()), { modelHub: ready_.hub });
      await onClaude.saveSettings({ provider: "anthropic" });
      expect(await onClaude.prepare(null)).toBeNull();
      expect(ready_.started).toHaveLength(0);
      const h = fakeHub({ installed: true, allowed: false });
      expect(await new Coach(new Library(new MemoryDisk()), { modelHub: h.hub }).prepare(null)).toBeNull();
      expect(h.started).toHaveLength(0);
    });

    test("not approved in Model Hub yet: not ready, Model Hub's own words, the fallback on the phone", async () => {
      const waiting = "Model Hub is waiting for you to approve Tartan: tap Approve in Model Hub's notification (or Model Hub → Model API), then try again.";
      const h = fakeHub({ ...ready, notApproved: waiting });
      const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.hub });
      expect(await coach.status()).toMatchObject({ provider: "anthropic", hub: { notApproved: waiting } });
      expect(await coach.prepare(null)).toBeNull();
      await coach.saveSettings({ provider: "modelhub" });
      expect((await collect(coach.chat(null, "Hi"))).at(-1)).toEqual({ type: "error", message: waiting });
      expect(h.started).toHaveLength(0);
      // Refused mid-answer (code 12): its words as they are.
      expect(localError(Object.assign(new Error(waiting), { code: "12" }))).toBe(waiting);
    });

    test("not allowed yet: says what to do, starts nothing", async () => {
      const h = fakeHub({ installed: true, allowed: false });
      const coach = new Coach(new Library(new MemoryDisk()), { modelHub: h.hub });
      await coach.saveSettings({ provider: "modelhub" });
      const events = await collect(coach.chat(null, "Hi"));
      expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("Model Hub isn't ready") });
      expect(h.started).toHaveLength(0);
    });
  });
});
