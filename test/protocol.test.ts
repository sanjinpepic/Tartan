import { describe, expect, test } from "bun:test";
import { BRING_UP, DIRLIST_SETUP, STREAM_SETUP } from "../src/protocol/captured.ts";
import {
  Deframer,
  MT,
  bytesToHex,
  crc32,
  crcOk,
  dirListFrame,
  hexToBytes,
  parseReply,
  readFileFrame,
  unescape,
  wrap,
} from "../src/protocol/codec.ts";
import { WatchSession, normalize, spell } from "../src/protocol/session.ts";
import { mirror, sniff, type FileSink } from "../src/protocol/sync.ts";
import { FakeWatch } from "../src/sim/fake-watch.ts";

const FAST = { chunkDelayMs: 0, frameGapMs: 0 };
const enc = (s: string) => new TextEncoder().encode(s);

describe("codec", () => {
  test("crc32 matches zlib", () => {
    expect(crc32(enc("123456789"))).toBe(3421780262);
  });

  test("every captured frame has a valid CRC and is read-only", () => {
    for (const hex of [...BRING_UP, ...DIRLIST_SETUP, ...STREAM_SETUP]) {
      const f = hexToBytes(hex);
      expect(crcOk(f)).toBe(true);
      // HELLO, RESOLVE or GET only: nothing in the replay writes to the watch.
      expect([MT.HELLO, MT.RESOLVE, MT.GET]).toContain(f[1]! as 0x12 | 0x0a | 0x0d);
    }
  });

  test("request builders match the frames SyncFix/zappctl send", () => {
    expect(bytesToHex(dirListFrame("b:/zapp", 15))).toBe(
      "a50d14000f00f02302038001020c00623a2f7a617070000300006d3f0424",
    );
    expect(bytesToHex(readFileFrame("b:syslogs/systemevent_1297017.log", 20, 4096))).toBe(
      "a50d31001400f0230a038001020c00623a7379736c6f67732f73797374656d6576656e745f313239373031372e6c6f6700060000100000880712be",
    );
  });

  test("escaping round-trips delimiter bytes", () => {
    const frame = Uint8Array.of(0xa5, 0x7e, 0x7d, 0x00, 0x7e);
    const w = wrap(frame);
    expect(w[0]).toBe(0x7e);
    expect(w.at(-1)).toBe(0x7e);
    expect(w.subarray(1, -1).includes(0x7e)).toBe(false);
    expect(unescape(w.subarray(1, -1))).toEqual(frame);
  });

  test("deframer handles arbitrary chunking and shared delimiters", () => {
    const a = hexToBytes(BRING_UP[1]!);
    const b = hexToBytes(BRING_UP[2]!);
    const stream = Uint8Array.from([...wrap(a), ...wrap(b).subarray(1)]); // shared 0x7e
    const got: Uint8Array[] = [];
    const d = new Deframer((f) => got.push(f));
    for (let i = 0; i < stream.length; i += 3) d.push(stream.subarray(i, i + 3));
    expect(got.map(bytesToHex)).toEqual([bytesToHex(a), bytesToHex(b)]);
    expect(parseReply(got[0]!).type).toBe(MT.RESOLVE);
  });

  test("path normalisation and spelling", () => {
    expect(normalize("b:/logs/")).toBe("/logs");
    expect(normalize("b:syslogs")).toBe("/syslogs");
    expect(normalize("logs//x")).toBe("/logs/x");
    expect(spell("/logs", "ng3")).toBe("b:/logs");
    expect(spell("/", "ng1")).toBe("/");
  });

  test("sniff recognises FIT files", () => {
    const fit = new Uint8Array(16);
    fit.set(enc(".FIT"), 8);
    expect(sniff(fit)).toBe("FIT activity file");
    expect(sniff(enc('{"a":1}'))).toBe("JSON");
  });
});

function sampleFiles() {
  const big = new Uint8Array(5000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff; // includes 0x7e / 0x7d bytes
  return {
    "/logs/entry_1.bin": big,
    "/logs/entry_2.bin": enc("second workout"),
    "/settings/user.json": enc('{"name":"me"}'),
    "/zapp/app.fea": enc("PKapp"),
  };
}

for (const generation of ["ng3", "ng1"] as const) {
  describe(`session against a simulated ${generation.toUpperCase()} watch`, () => {
    const name = generation === "ng1" ? "Suunto 9 PeakPro 0042" : "Suunto Vertical 2 0042";

    test("bring-up, info, listing and generation detection", async () => {
      const watch = new FakeWatch({ name, generation, files: sampleFiles() });
      const s = new WatchSession(watch, FAST);
      const info = await s.open();
      expect(info.info).toContain("FW 2.44.12");
      const root = await s.listDir("/");
      expect(root.dirs.sort()).toEqual(["logs", "settings", "zapp"]);
      expect((await s.listDir("logs")).files.sort()).toEqual(["entry_1.bin", "entry_2.bin"]);
      expect(s.info().generation).toBe(generation);
    });

    test("multi-chunk download is byte exact", async () => {
      const files = sampleFiles();
      const s = new WatchSession(new FakeWatch({ name, generation, files, readChunk: 333, notifySize: 61 }), FAST);
      await s.open();
      const progress: number[] = [];
      const data = await s.readFile("/logs/entry_1.bin", (n) => progress.push(n));
      expect(data).toEqual(files["/logs/entry_1.bin"]);
      expect(progress.at(-1)).toBe(5000);
      expect(progress.length).toBe(Math.ceil(5000 / 333));
    });

    test("missing file surfaces the watch status", async () => {
      const s = new WatchSession(new FakeWatch({ name, generation, files: sampleFiles() }), FAST);
      await s.open();
      await expect(s.readFile("/nope.bin")).rejects.toThrow(/404/);
    });

    test("mirror copies the tree and skips what is already there", async () => {
      const files = sampleFiles();
      const s = new WatchSession(new FakeWatch({ name, generation, files }), FAST);
      await s.open();
      const store = new Map<string, Uint8Array>([["/zapp/app.fea", enc("old")]]);
      const sink: FileSink = {
        has: async (p) => store.has(p),
        put: async (p, d) => void store.set(p, d),
      };
      const res = await mirror(s, "/", sink);
      expect(res).toMatchObject({ downloaded: 3, skipped: 1, failed: 0 });
      for (const p of ["/logs/entry_1.bin", "/logs/entry_2.bin", "/settings/user.json"]) {
        expect(store.get(p)).toEqual(files[p as keyof typeof files]);
      }
    });
  });
}

test("a silent watch times out instead of hanging", async () => {
  const watch = new FakeWatch({ files: sampleFiles(), silentPaths: ["b:/logs/entry_2.bin"] });
  const s = new WatchSession(watch, { ...FAST, timeoutMs: 300 });
  await s.open();
  await expect(s.readFile("/logs/entry_2.bin")).rejects.toThrow(/no reply/);
});

test("layout detection survives a spelling the watch never answers", async () => {
  const files = { "/zapp/app.fea": new TextEncoder().encode("PK"), "/logs/a.bin": Uint8Array.of(1, 2, 3) };
  // An NG1 watch without NG1 markers in its name: NG3 spellings time out, NG1 works.
  const watch = new FakeWatch({ name: "Suunto 5 Peak 0042", generation: "ng1", files, silentPaths: ["b:/zapp", "b:/"] });
  const s = new WatchSession(watch, { ...FAST, timeoutMs: 200 });
  await s.open();
  expect(await s.detectGeneration()).toBe("ng1");
  expect(await s.readFile("/logs/a.bin")).toEqual(Uint8Array.of(1, 2, 3));
});

test("a watch that lists nothing: the error says what each spelling got, and suggests the Suunto app", async () => {
  const s = new WatchSession(new FakeWatch({ name: "Suunto Run 2 0042", generation: "ng3", files: {} }), FAST);
  const lines: string[] = [];
  const logged = new WatchSession(new FakeWatch({ name: "Suunto Run 2 0042", generation: "ng3", files: {} }), { ...FAST, log: (m) => lines.push(m) });
  await logged.open();
  expect(lines.some((l) => l.startsWith("[session] watch reports:"))).toBe(true);
  await s.open();
  const err = await s.detectGeneration().then(() => null, (e: Error) => e.message);
  expect(err).toContain("b:/zapp");
  expect(err).toContain("a:/");
  expect(err).toContain("c:/");
  expect(err).toMatch(/Suunto app/);
});

test("firmware that rejects the captured listing shape (400): the session finds the shape it accepts", async () => {
  for (const listForm of ["path", "path+i32"] as const) {
    const lines: string[] = [];
    const s = new WatchSession(new FakeWatch({ name: "Suunto Run 2 0042", generation: "ng3", files: sampleFiles(), listForm }), { ...FAST, log: (m) => lines.push(m) });
    await s.open();
    expect(await s.detectGeneration()).toBe("ng3");
    expect(lines.some((l) => l.includes(`listing works as ${listForm}`))).toBe(true);
    expect(lines.some((l) => l.includes("DirectoryList resolve 200"))).toBe(true);
    // Later listings use the shape that worked.
    expect((await s.listDir("/logs")).files.length).toBeGreaterThan(0);
  }
});

test("every listing shape refused: the watch is asked to describe the resource, and the error says so", async () => {
  const lines: string[] = [];
  const watch = new FakeWatch({ name: "Suunto Run 2 0042", generation: "ng3", files: sampleFiles(), listForm: "none" as never });
  const s = new WatchSession(watch, { ...FAST, log: (m) => lines.push(m) });
  await s.open();
  const err = await s.detectGeneration().then(() => null, (e: Error) => e.message);
  expect(err).toContain("every request shape answered 400");
  expect(lines.some((l) => l.startsWith("[schema] resource 0x2302 → 200"))).toBe(true);
  expect(lines.some((l) => l.startsWith("[schema] 0x2302 operation 0 →"))).toBe(true);
});

test("a Run 2-like watch: DirectoryList at its own handle, a listing shape no capture uses; the session reads the schema and lists", async () => {
  const lines: string[] = [];
  const watch = new FakeWatch({
    name: "Suunto Run 2 2634C6001750",
    generation: "ng3",
    files: sampleFiles(),
    schema: { handle: [0xf0, 0xb0, 0x00], opId: 0x02ea, params: [{ name: "path", type: 12 }, { name: "pageIndex", type: 5 }] },
  });
  const s = new WatchSession(watch, { ...FAST, log: (m) => lines.push(m) });
  await s.open();
  expect(await s.detectGeneration()).toBe("ng3");
  expect(lines.some((l) => l.includes("DirectoryList resolve 200 → f0b000"))).toBe(true);
  expect(lines.some((l) => l.includes("GET takes: path:STRING, pageIndex:UINT16"))).toBe(true);
  expect(lines.some((l) => l.includes("listing works with the watch's own schema (12, 5)"))).toBe(true);
  expect((await s.listDir("/")).dirs.length).toBeGreaterThan(0);
  expect((await s.listDir("/logs")).files.length).toBeGreaterThan(0);
});

test("a Run 2-like watch whose pages start at 1: the value probes find it", async () => {
  const lines: string[] = [];
  WatchSession.probed = false;
  const watch = new FakeWatch({
    name: "Suunto Run 2 2634C6001750",
    generation: "ng3",
    files: sampleFiles(),
    schema: { handle: [0xf0, 0xb0, 0x00], opId: 0x02ea, params: [{ name: "Path", type: 12 }, { name: "Page", type: 3 }], firstPage: 1 },
  });
  const s = new WatchSession(watch, { ...FAST, log: (m) => lines.push(m) });
  await s.open();
  expect(await s.detectGeneration()).toBe("ng3");
  expect(lines.some((l) => l.includes('listing works: "b:/" with first page 1'))).toBe(true);
  expect((await s.listDir("/logs")).files.length).toBeGreaterThan(0);
});

test("a Run 2-like watch that refuses every listing value: the probes run, then a clear error", async () => {
  const lines: string[] = [];
  const sent: Uint8Array[] = [];
  WatchSession.mapped = false;
  WatchSession.inspected = false;
  WatchSession.probed = false;
  const watch = new FakeWatch({
    name: "Suunto Run 2 2634C6001750",
    generation: "ng3",
    files: sampleFiles(),
    schema: { handle: [0xf0, 0xb0, 0x00], opId: 0x02ea, params: [{ name: "Path", type: 12 }, { name: "Page", type: 3 }], firstPage: 200 },
    sent,
  });
  const s = new WatchSession(watch, { ...FAST, log: (m) => lines.push(m) });
  await s.open();
  await expect(s.detectGeneration()).rejects.toThrow(/we send exactly that/);
  // Every probe was sent (roots, encodings, the bring-up client); only the summary is logged.
  expect(lines.some((l) => / of 36 value probes answered 400$/.test(l))).toBe(true);
  expect(sent.some((f) => f[1] === 0x0d && f[9] === 0x01 && f[10] === 0x80 && f[6] === 0xf0 && f[7] === 0xb0)).toBe(true);
  // The neighbours are mapped read-only, and nothing goes to the captured watches' handle,
  // which is EmmcFormat on the Run 2.
  // The tree is known for the Run 2: not mapped again by default. The Logbook is read instead.
  expect(lines.some((l) => /^\[tree\] \d+ resources mapped$/.test(l))).toBe(false);
  expect(lines.some((l) => l.startsWith("[sync] GET /Activity/Log/Count as 018000 →"))).toBe(true);
  expect(lines.some((l) => l.startsWith('[probe] ') && l.endsWith("value probes answered 400"))).toBe(true);
  expect(sent.some((f) => f[1] === 0x0d && f[6] === 0xf0 && f[7] === 0x23 && f[8] === 0x02)).toBe(false);
  expect(sent.every((f) => f[1] !== 0x0e)).toBe(true);
});

test("a failed listing maps the watch's resource tree once, with the file system's methods", async () => {
  const lines: string[] = [];
  WatchSession.mapped = false;
  const N = 0xffff;
  const watch = new FakeWatch({
    name: "Suunto Run 2 2634C6001750",
    generation: "ng3",
    files: sampleFiles(),
    schema: { handle: [0xf0, 0xb0, 0x00], opId: 0x02ea, params: [{ name: "Path", type: 12 }, { name: "Page", type: 3 }], firstPage: 200 },
    tree: [
      { id: 0x0240, name: "Dev", parent: 0, next: 0x010e, child: 0x0241 },
      { id: 0x0241, name: "FileSystem", parent: 0x0240, next: N, child: 0x2300 },
      { id: 0x2300, name: "DirectoryCreate", parent: 0x0241, next: 0xb000, child: N, ops: 1 },
      { id: 0xb000, name: "DirectoryList", parent: 0x0241, next: 0x2302, child: N, ops: 1 },
      { id: 0x2302, name: "EmmcFormat", parent: 0x0241, next: N, child: N, ops: 1 },
      { id: 0x010e, name: "Activity", parent: 0, next: N, child: 0x0ab5 },
      { id: 0x0ab5, name: "Logbook", parent: 0x010e, next: N, child: N, ops: 2 },
    ],
  });
  const s = new WatchSession(watch, { ...FAST, log: (m) => lines.push(m) });
  s.mapOnFailure = true;
  await s.open();
  await expect(s.detectGeneration()).rejects.toThrow(/we send exactly that/);
  const tree = lines.filter((l) => l.startsWith("[tree]\n")).join("\n");
  expect(tree).toContain("\nDev 240");
  expect(tree).toContain("\n    DirectoryList b000 ops 1 m0(Path:STRING, Page:UINT8)");
  expect(tree).toContain("\n    EmmcFormat 2302 ops 1");
  expect(tree).toContain("\nActivity 10e");
  expect(tree).toContain("\n  Logbook ab5 ops 2");
  expect(lines).toContain("[tree] 8 resources mapped");
  // Once per app run: a second failure doesn't walk it again.
  const again = new WatchSession(watch, { ...FAST, log: (m) => lines.push(m) });
  again.mapOnFailure = true;
  await again.open();
  await expect(again.detectGeneration()).rejects.toThrow();
  expect(lines.filter((l) => l.endsWith("resources mapped")).length).toBe(1);
});

test("Run 2 activity log: the sync command's options are decoded by name, and an opted-in sync reads every workout", async () => {
  const lines: string[] = [];
  const puts: Array<{ path: string; value: number; type: number }> = [];
  const watch = new FakeWatch({
    name: "Suunto Run 2 2634C6001750",
    generation: "ng3",
    files: sampleFiles(),
    schema: { handle: [0xf0, 0xb0, 0x00], opId: 0x02ea, params: [{ name: "Path", type: 12 }, { name: "Page", type: 3 }], firstPage: 200 },
    activity: { files: ["/logs/entry_1.bin", "/logs/entry_2.bin"], start: 1, values: { STOP: 0, START: 1, PAUSE: 2, RESET: 3 } },
    puts,
  });
  const s = new WatchSession(watch, { ...FAST, log: (m) => lines.push(m) });
  await s.open();
  // Read-only first: nothing is written while the options are learned and the log is locked.
  const opts = await s.syncCommandOptions();
  expect(opts?.items.map((i) => `${i.name}=${i.value}`)).toEqual(["STOP=0", "START=1", "PAUSE=2", "RESET=3"]);
  expect(opts?.declared).toBe(0x2404);
  expect(await s.activityCount()).toBeNull();
  expect(puts).toEqual([]);

  const saved = new Map<string, Uint8Array>();
  const start = opts!.items.find((i) => i.name === "START")!;
  const stop = opts!.items.find((i) => i.name === "STOP")!;
  const n = await s.activitySync(opts!, start, stop, async (name, data) => void saved.set(name, data));
  expect(n).toBe(2);
  expect(puts.map((p) => `${p.value}@${p.type.toString(16)}`)).toEqual(["1@3", "0@3"]);
  expect(new TextDecoder().decode(saved.get("activity-log/1/entry_2.bin"))).toBe("second workout");
  expect(saved.get("activity-log/0/entry_1.bin")?.length).toBe(5000);
  expect(new TextDecoder().decode(saved.get("activity-log/0/movedata.bin")!)).toContain("b:/logs/entry_1.bin");
  expect(lines).toContain("[sync] activity log entries: 2");
});

test("Run 2 logbook: lists unsynced workouts, downloads Summary (chunked GET) and Data (subscription), never marks them synced", async () => {
  const lines: string[] = [];
  const puts: Array<{ path: string; value: number; type: number }> = [];
  const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 7) & 0xff);
  const sbem = (n: number, seed: number) => {
    const b = bytes(n, seed);
    b.set(new TextEncoder().encode("SBEM0103"), 0);
    return b;
  };
  const logbook = [
    { id: 657559034, modified: 1_792_081_013, summary: sbem(1832, 3), data: sbem(279, 5) },
    { id: 657559100, modified: 1_792_082_000, summary: sbem(400, 11), data: sbem(1000, 13) },
  ];
  const watch = new FakeWatch({ name: "Suunto Run 2 2634C6001750", generation: "ng3", files: sampleFiles(), logbook, puts });
  const s = new WatchSession(watch, { ...FAST, log: (m) => lines.push(m) });
  await s.open();
  const entries = await s.logbookEntries();
  expect(entries).toEqual([
    { id: 657559034, modified: 1_792_081_013, size: 2111 },
    { id: 657559100, modified: 1_792_082_000, size: 1400 },
  ]);
  const saved = new Map<string, Uint8Array>();
  const sink = { has: async (p: string) => saved.has(p), put: async (p: string, d: Uint8Array) => void saved.set(p, d) };
  const res = await s.logbookBackup(sink);
  expect(res).toMatchObject({ downloaded: 2, failed: 0, bytes: 2111 + 1400 });
  expect(saved.get("logbook/657559034/summary.sbem")).toEqual(logbook[0]!.summary);
  expect(saved.get("logbook/657559034/data.sbem")).toEqual(logbook[0]!.data);
  expect(saved.get("logbook/657559100/data.sbem")).toEqual(logbook[1]!.data);
  expect(JSON.parse(new TextDecoder().decode(saved.get("logbook/657559034/entry.json")!)).modifiedIso).toBe("2026-10-15T16:16:53.000Z");
  // A second run skips what is saved, and nothing is ever written to the watch (no Flags PUT).
  expect((await s.logbookBackup(sink)).skipped).toBe(2);
  expect(puts).toEqual([]);
});
