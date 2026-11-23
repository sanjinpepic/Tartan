import { describe, expect, test } from "bun:test";
import { decodeTape, parseTape, RecordingLink, ReplayLink, tapeFrames } from "../src/protocol/blackbox.ts";
import { WatchSession } from "../src/protocol/session.ts";
import { mirror, type FileSink } from "../src/protocol/sync.ts";
import { FakeWatch } from "../src/sim/fake-watch.ts";

const FAST = { chunkDelayMs: 0, frameGapMs: 0 };
const enc = (s: string) => new TextEncoder().encode(s);
const files = () => ({
  "/logs/entry_1.bin": Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff),
  "/logs/entry_2.bin": enc("second ~ } workout"),
  "/settings/user.json": enc('{"hr":190}'),
});
const memSink = () => {
  const store = new Map<string, Uint8Array>();
  const sink: FileSink = { has: async (p) => store.has(p), put: async (p, d) => void store.set(p, d) };
  return { store, sink };
};

/** One real-looking connection, recorded: open, list, back up, close. */
async function record(): Promise<{ tape: string; copied: Map<string, Uint8Array> }> {
  const lines: string[] = [];
  const link = new RecordingLink(new FakeWatch({ name: "Suunto Run 2 0042", files: files(), readChunk: 700, notifySize: 61 }), (l) => lines.push(l), { build: "test" });
  const s = new WatchSession(link, { ...FAST, log: (m) => link.note(m) });
  await s.open();
  await s.detectGeneration();
  const { store, sink } = memSink();
  await mirror(s, "/", sink);
  await s.close();
  return { tape: lines.join("\n"), copied: store };
}

describe("the watch link's flight recorder", () => {
  test("records both directions and the session's log, and reads back as frames", async () => {
    const { tape } = await record();
    const t = parseTape(tape);
    expect(t.header).toMatchObject({ tartan: "blackbox", v: 1, name: "Suunto Run 2 0042", build: "test" });
    const frames = tapeFrames(t);
    expect(frames.filter((f) => "dir" in f && f.dir === ">").length).toBeGreaterThan(5);
    expect(frames.filter((f) => "dir" in f && f.dir === "<").length).toBeGreaterThan(5);
    expect(frames.some((f) => "log" in f && f.log.includes("bringing the protocol up"))).toBe(true);
    expect(frames.at(-1)).toMatchObject({ close: "closed by Tartan" });
    const text = decodeTape(t);
    expect(text).toContain("RESOLVE");
    expect(text).toContain("Suunto Run 2 0042");
  });

  test("a replay answers the same session byte for byte, with no watch", async () => {
    const { tape, copied } = await record();
    const replay = new ReplayLink(tape);
    const s = new WatchSession(replay, { ...FAST, timeoutMs: 300 });
    const info = await s.open();
    expect(info.name).toBe("Suunto Run 2 0042");
    await s.detectGeneration();
    const { store, sink } = memSink();
    const res = await mirror(s, "/", sink);
    expect(res.failed).toBe(0);
    expect([...store.keys()].sort()).toEqual([...copied.keys()].sort());
    for (const [p, d] of copied) expect(store.get(p)).toEqual(d);
    expect(replay.misses).toEqual([]);
    expect(replay.approximate).toEqual([]);
  });

  test("request ids that moved still get their answers; a request the tape never saw times out and is listed", async () => {
    const { tape } = await record();
    const replay = new ReplayLink(tape);
    const s = new WatchSession(replay, { ...FAST, timeoutMs: 150 });
    await s.open();
    await s.detectGeneration();
    // Read a file out of the recorded order (other request ids than on the tape).
    expect(await s.readFile("/settings/user.json")).toEqual(enc('{"hr":190}'));
    await expect(s.readFile("/logs/never.bin")).rejects.toThrow(/no reply/);
    expect(replay.misses.length).toBeGreaterThan(0);
  });

  test("a recording stops at its limit and says so; a cut-off last line is forgiven", async () => {
    const lines: string[] = [];
    const link = new RecordingLink(new FakeWatch({ files: files() }), (l) => lines.push(l), { limit: 2000 });
    const s = new WatchSession(link, FAST);
    await s.open();
    await s.close();
    expect(lines.join("\n").length).toBeLessThan(2400);
    expect(lines.at(-1)).toContain("stopped recording");
    const cut = `${lines.join("\n")}\n{"t":5,"n":"7ea5`;
    expect(() => parseTape(cut)).not.toThrow();
    expect(() => parseTape("hello")).toThrow(/not a Tartan watch recording/);
  });
});
