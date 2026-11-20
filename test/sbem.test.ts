import { expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { Analytics, robustMax } from "../src/analytics.ts";
import { Library } from "../src/library.ts";
import { decodeStreams, decodeWorkout, parseDescriptors, parseSbem, sbemSummary, sbemTime } from "../src/sbem.ts";
import { LocalStore } from "../src/store.ts";

/** An 8-byte SBEM time: watch-local ms (6 bytes), 0, UTC offset in 15-minute steps. */
const time = (utcMs: number, offsetMin: number) => {
  const local = utcMs + offsetMin * 60_000;
  const b = new Uint8Array(8);
  let v = local;
  for (let i = 0; i < 6; i++) {
    b[i] = v % 256;
    v = Math.floor(v / 256);
  }
  b[7] = (offsetMin / 15) & 0xff;
  return b;
};
const u32 = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
const chunk = (id: number, data: Uint8Array) =>
  data.length < 0xff ? Uint8Array.of(id, data.length, ...data) : Uint8Array.of(id, 0xff, ...u32(data.length), ...data);

/** A Summary laid out like the Run 2's: 0x22 lap chunks, then the 0x20 workout chunk. */
function summary(startUtc: number, durationMs: number, offsetMin: number, sport: string, laps = 3) {
  const lap = new Uint8Array(405);
  const w = new Uint8Array(585);
  w.set(time(startUtc + durationMs, offsetMin), 0);
  w.set(time(startUtc, offsetMin), 8);
  w.set(u32(durationMs), 16);
  w.set(new TextEncoder().encode(sport), 585 - 13);
  const parts = [new TextEncoder().encode("SBEM0103"), ...Array.from({ length: laps }, () => chunk(0x22, lap)), chunk(0x20, w)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

test("SBEM chunks: short and extended lengths; times are watch-local with a 15-minute offset", () => {
  const b = summary(Date.parse("2026-10-15T16:33:12Z"), 8174, 60, "Running");
  const f = parseSbem(b)!;
  expect(f.version).toBe("0103");
  expect(f.chunks.map((c) => `${c.id.toString(16)}:${c.data.length}`)).toEqual(["22:405", "22:405", "22:405", "20:585"]);
  expect(parseSbem(Uint8Array.of(...new TextEncoder().encode("SBEM0103"), 0x02, 0x04, 0, 0, 0, 0, 0x03, 0x01, 9))!.chunks).toHaveLength(2);
  expect(parseSbem(new TextEncoder().encode("not sbem"))).toBeNull();
  // The real sample's start: c0 07 a0 40 a1 01 00 04 → 17:33:12 local at UTC+1.
  expect(sbemTime(Uint8Array.of(0xc0, 0x07, 0xa0, 0x40, 0xa1, 0x01, 0x00, 0x04), 0)).toEqual({ utc: Date.parse("2026-10-15T16:33:12Z"), offsetMin: 60 });
});

test("SBEM summary: start, duration, sport and laps of a Run 2 workout", () => {
  const start = Date.parse("2026-10-15T06:00:00Z");
  expect(sbemSummary(summary(start, 45 * 60_000 + 400, 120, "Trail running", 5))).toEqual({
    start,
    end: start + 45 * 60_000 + 400,
    duration_s: 2700,
    offsetMin: 120,
    sport: "Trail running",
    laps: 5,
  });
  expect(sbemSummary(new TextEncoder().encode("SBEM0103"))).toBeNull();
});

test("library: a logbook workout from the watch is listed, and merges with Strava's copy", async () => {
  const disk = new MemoryDisk();
  const local = new LocalStore(disk);
  await local.saveInfo("Suunto Run 2 2634C6001750", { name: "Suunto Run 2 2634C6001750" });
  const start = Date.parse("2026-10-15T06:00:00Z");
  await local.sink("Suunto Run 2 2634C6001750").put("logbook/657559034/summary.sbem", summary(start, 30 * 60_000, 120, "Running"));
  const lib = new Library(disk);
  const all = await lib.activities({ limit: 10 });
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ sport: "Running", start: "2026-10-15T06:00:00.000Z", sources: ["watch"], elapsed_min: 30 });
});

// ---------------------------------------------------------------- with descriptors

const enc = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const le = (n: number, bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => Math.floor(n / 256 ** i) & 0xff);
const f32 = (n: number) => new Uint8Array(new Float32Array([n]).buffer);

/** Descriptors in the Run 2's layout: id-0 chunks of u16 id + "<PTH>…\n<FRM>…" lines. */
function descriptors(entries: Array<[number, string]>) {
  return join(enc("SBEM0103"), ...entries.map(([id, text]) => chunk(0, join(le(id, 2), enc(`${text}\0`)))));
}
const P = "Samples.TimelineSample.Attributes.suunto/sml.";
const DESC = descriptors([
  [37, "<PTH>Samples+TimelineSample.TimeISO8601\n<FRM>local64"],
  [38, "<PTH>Samples+TimelineSample.TimeISO8601\n<FRM>local64,baseonly"],
  [39, "<DELTAREF>38\n<FRM>dint16"],
  [140, `<PTH>${P}Header.Duration\n<FRM>uint32,precision=3\n<MOD>x/1000,y*1000`],
  [141, `<PTH>${P}Header.PauseDuration\n<FRM>uint32,precision=3\n<MOD>x/1000,y*1000`],
  [142, `<PTH>${P}Header.Activity\n<FRM>utf8`],
  [144, `<PTH>${P}Header.DateTime\n<FRM>local64`],
  [145, `<PTH>${P}Header.Distance\n<FRM>uint32,precision=1,nillable=4294967295`],
  [151, `<PTH>${P}Header.Ascent\n<FRM>float32,precision=6,nillable=0`],
  [164, `<PTH>${P}Header.Energy\n<FRM>float32,precision=6`],
  [304, `<PTH>${P}Windows+Window.Type\n<FRM>enum:0=Move,1=Activity,2=Lap,3=Autolap`],
  [306, `<PTH>${P}Windows.Window.Duration\n<FRM>float32,precision=6,nillable=-16000000`],
  [317, `<PTH>${P}Windows.Window.HR.Max\n<FRM>float32,precision=6,nillable=-16000000`],
  [318, `<PTH>${P}Windows.Window.HR.Avg\n<FRM>float32,precision=6,nillable=-16000000`],
  [312, `<PTH>${P}Windows.Window.Speed.Avg\n<FRM>float32,precision=6,nillable=-16000000`],
  [66, `<PTH>${P}Sample.Latitude\n<FRM>int32\n<MOD>PI*x/(10^7*180),y*10^7*180/PI`],
  [67, `<PTH>${P}Sample.Longitude\n<FRM>int32\n<MOD>PI*x/(10^7*180),y*10^7*180/PI`],
  [78, "<DELTAREF>66\n<FRM>dint8"],
  [79, "<DELTAREF>67\n<FRM>dint8"],
  [93, `<PTH>${P}Sample.HR\n<FRM>uint8,precision=2\n<MOD>x/60,y*60`],
  [106, `<PTH>${P}Sample.Distance\n<FRM>uint32,precision=1,nillable=4294967295`],
  [120, "<DELTAREF>106\n<FRM>duint8"],
  [1, "<GRP>38"],
  [12, "<GRP>39,66,67,106"],
  [13, "<GRP>39,78,79,120"],
  [18, "<GRP>39,93"],
  [178, `<PTH>${P}Header.HrZones.Zone2LowerLimit\n<FRM>float32,precision=6,nillable=0`],
  [179, `<PTH>${P}Header.HrZones.Zone3LowerLimit\n<FRM>float32,precision=6,nillable=0`],
  [180, `<PTH>${P}Header.HrZones.Zone4LowerLimit\n<FRM>float32,precision=6,nillable=0`],
  [181, `<PTH>${P}Header.HrZones.Zone5LowerLimit\n<FRM>float32,precision=6,nillable=0`],
  [209, `<PTH>${P}Header.Personal.MaxHR\n<FRM>float32,precision=6,nillable=0`],
  [210, `<PTH>${P}Header.Personal.RestHR\n<FRM>float32,precision=6,nillable=0`],
  [32, "<GRP>37,144,140,141,145,151,164,142,178,179,180,181,209,210"],
  [34, "<GRP>37,304,306,317,318,312"],
]);

test("descriptors: items, groups, enums, nillable, deltas and unit formulas", () => {
  const d = parseDescriptors(DESC);
  expect(d.get(12)?.group).toEqual([39, 66, 67, 106]);
  expect(d.get(304)?.enumValues).toEqual({ 0: "Move", 1: "Activity", 2: "Lap", 3: "Autolap" });
  expect(d.get(145)?.nillable).toBe(4294967295);
  expect(d.get(78)?.deltaRef).toBe(66);
  expect(d.get(93)?.mod?.(150)).toBe(2.5);
  // Only arithmetic on x: anything else is not run.
  expect(parseDescriptors(descriptors([[5, "<PTH>a\n<FRM>uint8\n<MOD>process.exit(1),y"]])).get(5)?.mod).toBeUndefined();
});

test("a 20-minute run with heart rate and GPS: workout values and streams from Summary and Data", () => {
  const d = parseDescriptors(DESC);
  const start = Date.parse("2026-10-16T06:00:00Z");
  const off = 60;
  const t = (ms: number) => time(start + ms, off);
  const summary = join(
    enc("SBEM0103"),
    chunk(34, join(t(1_260_000), Uint8Array.of(0), f32(1200), f32(170 / 60), f32(150 / 60), f32(3.2))),
    chunk(32, join(t(1_260_000), t(0), le(1_260_000, 4), le(60_000, 4), le(3840, 4), f32(42), f32(1_255_200), enc("Running\0"))),
  );
  const lat0 = 60.17 * 1e7;
  const lon0 = 24.94 * 1e7;
  const data = join(
    enc("SBEM0103"),
    chunk(1, t(0)),
    chunk(12, join(le(1000, 2), le(lat0, 4), le(lon0, 4), le(3, 4))),
    chunk(18, join(le(0, 2), Uint8Array.of(140 * 1))), // HR at the same time; raw bpm (the MOD makes it Hz)
    chunk(13, join(le(1000, 2), Uint8Array.of(20, 0xf6, 3))), // +1 s: lat +20, lon −10, distance +3
    chunk(18, join(le(0, 2), Uint8Array.of(150))),
    chunk(13, join(le(1000, 2), Uint8Array.of(20))), // trailing lon and distance left off
  );
  const w = decodeWorkout(summary, d)!;
  expect(w).toMatchObject({ start, duration_s: 1260, moving_s: 1200, distance_m: 3840, sport: "Running", avg_hr: 150, max_hr: 170, ascent_m: 42, offsetMin: 60 });
  expect(w.avg_speed).toBeCloseTo(3.2, 5);
  expect(w.calories).toBeCloseTo(300, 5);
  const s = decodeStreams(data, d, start + off * 60_000)!;
  expect(s.time).toEqual([1, 2, 3]);
  expect(s.heartrate).toEqual([140, 150, null]);
  expect(s.distance).toEqual([3, 6, null]);
  const ll = s.latlng as Array<[number, number] | null>;
  expect(ll[0]![0]).toBeCloseTo(60.17, 6);
  expect(ll[1]![0]).toBeCloseTo(60.170002, 6);
  expect(ll[1]![1]).toBeCloseTo(24.939999, 6);
  // The third sample moved latitude only: longitude keeps its last value.
  expect(ll[2]![0]).toBeCloseTo(60.170004, 6);
  expect(ll[2]![1]).toBeCloseTo(24.939999, 6);
});

test("library: with descriptors saved, the watch workout carries distance and heart rate, and its streams", async () => {
  const disk = new MemoryDisk();
  const local = new LocalStore(disk);
  await local.saveInfo("Suunto Run 2 2634C6001750", { name: "Suunto Run 2 2634C6001750" });
  const start = Date.parse("2026-10-16T06:00:00Z");
  const t = (ms: number) => time(start + ms, 60);
  const sink = local.sink("Suunto Run 2 2634C6001750");
  await sink.put("logbook/700000001/descriptors.sbem", DESC);
  await sink.put("logbook/700000001/summary.sbem", join(enc("SBEM0103"), chunk(34, join(t(600_000), Uint8Array.of(0), f32(600), f32(3), f32(2.5), f32(3))), chunk(32, join(t(600_000), t(0), le(600_000, 4), le(0, 4), le(1800, 4), f32(0), f32(0), enc("Running\0")))));
  await sink.put("logbook/700000001/data.sbem", join(enc("SBEM0103"), chunk(1, t(0)), chunk(18, join(le(1000, 2), Uint8Array.of(140))), chunk(18, join(le(1000, 2), Uint8Array.of(150)))));
  const lib = new Library(disk);
  const [row] = await lib.activities({ limit: 5 });
  expect(row).toMatchObject({ sport: "Running", distance_km: 1.8, avg_hr: 150, max_hr: 180, sources: ["watch"], streams_from: "watch" });
  const merged = (await lib.merged())[0]!;
  const streams = await lib.rawStreams(merged);
  expect(streams?.columns.heartrate).toEqual([140, 150]);
});

test("heart-rate zones: the watch's own zones win over an estimate; your own max wins over the watch", async () => {
  const disk = new MemoryDisk();
  const local = new LocalStore(disk);
  await local.saveInfo("Suunto Run 2 2634C6001750", { name: "Suunto Run 2 2634C6001750" });
  const start = Date.now() - 2 * 86400_000;
  const t = (ms: number) => time(start + ms, 60);
  const hz = (bpm: number) => f32(bpm / 60);
  const sink = local.sink("Suunto Run 2 2634C6001750");
  await sink.put("logbook/700000002/descriptors.sbem", DESC);
  await sink.put(
    "logbook/700000002/summary.sbem",
    join(
      enc("SBEM0103"),
      chunk(34, join(t(600_000), Uint8Array.of(0), f32(600), hz(176), hz(150), f32(3))),
      chunk(32, join(t(600_000), t(0), le(600_000, 4), le(0, 4), le(1800, 4), f32(0), f32(0), enc("Running\0"), hz(138), hz(148), hz(157), hz(168), hz(191), hz(50))),
    ),
  );
  // Ten minutes of samples at 140, 150 and 160 bpm.
  const beats = [...Array(200).fill(140), ...Array(200).fill(150), ...Array(200).fill(160)];
  await sink.put("logbook/700000002/data.sbem", join(enc("SBEM0103"), chunk(1, t(0)), ...beats.map((b) => chunk(18, join(le(1000, 2), Uint8Array.of(b))))));
  const lib = new Library(disk);
  const an = new Analytics(lib);
  const prof = await an.profile();
  expect(prof).toMatchObject({ zone_limits: [138, 148, 157, 168], zones_source: "your watch", max_hr: 191, max_hr_source: "set on your watch", rest_hr: 50 });
  const [row] = await lib.activities({ limit: 1 });
  const zones = (await an.zonesFor(row!.id, prof))!;
  // 140 → Z2 (138–147), 150 → Z3 (148–156), 160 → Z4 (157–167): as the watch counts them.
  expect(zones.map((z) => Math.round(z.seconds / 60))).toEqual([0, 3, 3, 3, 0]);
  expect(zones[1]!.bpm).toEqual([138, 147]);
  // A max set in Settings means % of it, over the watch.
  await an.saveProfile({ max_hr: 180 });
  expect(await new Analytics(lib).profile()).toMatchObject({ zone_limits: [108, 126, 144, 162], zones_source: "your max heart rate", max_hr_source: "set by you" });
});

test("estimated max heart rate ignores a lone sensor spike", () => {
  expect(robustMax([150, 181, 176, 214])).toBe(181);
  expect(robustMax([150, 181, 186])).toBe(186);
  expect(robustMax([172])).toBe(172);
  expect(robustMax([])).toBe(0);
});
