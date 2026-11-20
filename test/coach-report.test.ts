/** A coach's reply reported (long press → Report reply): marked in the chat, kept in coach/reports.json. */
import { expect, test } from "bun:test";
import { Coach } from "../src/coach.ts";
import type { ModelHubClient } from "../src/coach-litert.ts";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";

test("a reported reply is marked, kept, and handed back with its question", async () => {
  const client: ModelHubClient = {
    state: async () => ({ installed: true, allowed: true, model: "Gemma-4-E2B-it", context: 4096 }),
    status: async () => ({ name: "Gemma-4-E2B-it", loaded: false }),
    load: async () => ({ backend: "Tensor TPU", context: 4096 }),
    start: async () => {},
    send: async (_id, _m, onText) => (onText("Run 30 km today."), { text: "Run 30 km today.", toolCalls: [] }),
    end: async () => {},
  };
  const lib = new Library(new MemoryDisk());
  const coach = new Coach(lib, { modelHub: client });
  await coach.saveSettings({ provider: "modelhub" });
  let id = "";
  for await (const e of coach.chat(null, "I'm sore, what now?")) if (e.type === "conversation") id = e.id;
  expect(await coach.report(id, 0, "Wrong or unsafe advice")).toBeNull(); // your own message isn't a reply
  const r = await coach.report(id, 1, "Wrong or unsafe advice", "Way too much when sore");
  expect(r).toEqual({ question: "I'm sore, what now?", reply: "Run 30 km today.", by: "Gemma 4 E2B on your phone" });
  expect((await coach.conversation(id))!.display[1]!.reported).toBe("Wrong or unsafe advice");
  const kept = JSON.parse((await lib.disk.readText("coach/reports.json"))!);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ conversation: id, index: 1, reason: "Wrong or unsafe advice", note: "Way too much when sore" });
});
