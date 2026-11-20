import { describe, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { MAX_NOTES, Memory, mergeNotes, type Note } from "../src/memory.ts";

const note = (id: string, updated: string, o: Partial<Note> = {}): Note => ({ id, text: `note ${id}`, kind: "athlete", created: "2026-10-01T00:00:00.000Z", updated, ...o });

describe("coach memory", () => {
  test("remember, update, forget; the prompt lists what's kept", async () => {
    const m = new Memory(new MemoryDisk());
    expect(await m.prompt()).toBe("");
    const a = await m.remember("  Left knee   gets sore after long downhill runs. ", "health");
    expect(a.text).toBe("Left knee gets sore after long downhill runs.");
    expect((await m.remember("left knee gets sore after long downhill runs.")).id).toBe(a.id); // no copies
    const b = await m.remember("Trains before work, 06:00.", "preference");
    await m.update(b.id, { text: "Trains before work, 06:30." });
    expect(await m.prompt()).toContain(`[${b.id}] (preference) Trains before work, 06:30.`);
    expect(await m.forget(a.id)).toBe(true);
    expect(await m.forget(a.id)).toBe(false);
    expect((await m.notes()).map((n) => n.id)).toEqual([b.id]);
    // The forgotten note stays as a marker, without its text, so a sync doesn't bring it back.
    expect((await m.all()).find((n) => n.id === a.id)).toMatchObject({ gone: true, text: "" });
    await expect(m.update(a.id, { text: "x" })).rejects.toThrow();
  });

  test("full memory refuses more notes", async () => {
    const m = new Memory(new MemoryDisk());
    for (let i = 0; i < MAX_NOTES; i++) await m.remember(`note number ${i}`);
    await expect(m.remember("one too many")).rejects.toThrow(/full/);
  });

  test("merging phone and PC: the later edit wins, forgetting wins a tie, junk is dropped", () => {
    const now = Date.parse("2026-10-18T00:00:00Z");
    const phone = [note("aaaa", "2026-10-10T00:00:00.000Z", { text: "old" }), note("bbbb", "2026-10-12T00:00:00.000Z"), note("cccc", "2026-10-12T00:00:00.000Z")];
    const pc = [note("aaaa", "2026-10-11T00:00:00.000Z", { text: "new" }), note("bbbb", "2026-10-11T00:00:00.000Z", { text: "older" }), note("cccc", "2026-10-12T00:00:00.000Z", { gone: true, text: "" }), { id: "BAD!", text: 1 } as unknown as Note];
    const out = mergeNotes(phone, pc, now);
    expect(out.map((n) => [n.id, n.text, !!n.gone])).toEqual([["aaaa", "new", false], ["bbbb", "note bbbb", false], ["cccc", "", true]]);
    // Long-forgotten markers go for good.
    expect(mergeNotes([note("dddd", "2026-01-01T00:00:00.000Z", { gone: true })], [], now)).toEqual([]);
  });

  test("merge saves the union", async () => {
    const m = new Memory(new MemoryDisk());
    const mine = await m.remember("Hates the treadmill.", "preference");
    const merged = await m.merge([note("eeee", "2026-10-15T00:00:00.000Z", { text: "Ran Berlin 2025 in 3:28.", kind: "lesson" })]);
    expect(merged.map((n) => n.id).sort()).toEqual([mine.id, "eeee"].sort());
    expect(await m.prompt()).toContain("Ran Berlin 2025 in 3:28.");
  });
});
