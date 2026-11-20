/** The steps the coach shows in the chat are words, never a tool's code name. */
import { expect, test } from "bun:test";
import { Coach, TOOL_LABELS, toolLabel } from "../src/coach.ts";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import { dataTools } from "../src/tools.ts";

test("every tool the coach can call has a label of its own, in plain words", () => {
  const lib = new Library(new MemoryDisk());
  const c = new Coach(lib) as unknown as { tools: Array<{ name: string }>; editSessionTool(): { name: string }; changePlanTool(): { name: string } };
  const names = new Set([...c.tools.map((t) => t.name), c.editSessionTool().name, c.changePlanTool().name, ...dataTools(lib, { allowSync: true }).map((t) => t.name)]);
  const missing = [...names].filter((n) => !TOOL_LABELS[n]);
  expect(missing).toEqual([]);
  for (const n of names) expect(toolLabel(n)).not.toMatch(/_/);
});

test("a tool without a label still reads as words", () => {
  expect(toolLabel("get_lap_splits")).toBe("Checking your lap splits");
  expect(toolLabel("list_training_blocks")).toBe("Looking through your blocks");
  expect(toolLabel("frobnicate_things")).toBe("Frobnicate things");
});
