import { expect, test } from "bun:test";
import { WatchSession } from "../src/protocol/session.ts";
import { fieldBytes } from "../src/protocol/route-send.ts";
import { routeFile, ROUTE_FIELDS, watchPoints } from "../src/protocol/route-file.ts";
import { decodeStruct, encodeStruct, layoutOf, parseTypeMeta, structParam, type TypeMeta } from "../src/protocol/wbstruct.ts";
import { parseSbem } from "../src/sbem.ts";
import { FakeWatch, type FakeWatchOptions } from "../src/sim/fake-watch.ts";
import type { LngLat } from "../src/routes.ts";

const FAST = { chunkDelayMs: 0, frameGapMs: 0 };
const hex = (s: string) => Uint8Array.from(s.replace(/\s+/g, "").match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ------------------------------------------------------------------ the struct rules, on the capture's watch-face types

/** DataTypeMetadata replies from the HCI capture of 16 Oct (the value after u16 type and header). */
const WF_TYPES: Record<number, string> = {
  0x0351: "5103030000000000000000000000000000000000010000000a0000002c0000000000000000000000000000009e600c00010193640c000101be790c0001014574070001013e600c000101b4690c000101946f0c000101f46004b300014e79070000017a6407000001",
  0x034f: "4f0303000000000000000000000000000000000001000000050000002c0000000000000000000000000000009e600c000101b86002000101c3600c0001017c7a1e010101286c03b30101",
  0xb304: "04b3010000000000000001003d1101004f030000000000000000000000000000000000000000000000000000",
  0xb303: "03b301000000000000000100b15701004e030000000000000000000000000000000000000000000000000000",
  0x034e: "4e0304000000000000000000000001000300000000000000000000000000000001000000030000002c000000ce6c0000805c010025790200",
};

test("DataTypeMetadata: a struct's fields, a named type's base, an enum's values", () => {
  const info = parseTypeMeta(hex(WF_TYPES[0x0351]!))!;
  expect(info).toMatchObject({ id: 0x0351, kind: 3 });
  expect(info.fields.map((f) => [f.type, f.required])).toEqual([[12, true], [12, true], [12, true], [7, true], [12, true], [12, true], [12, true], [0xb304, false], [7, false], [7, false]]);
  expect(parseTypeMeta(hex(WF_TYPES[0xb304]!))).toMatchObject({ kind: 1, nameId: 0x113d, baseTypeId: 0x034f });
  expect(parseTypeMeta(hex(WF_TYPES[0x034e]!))!.items.map((i) => i.value)).toEqual([0, 1, 2]);
});

test("the watch-face record the Suunto app wrote comes out of the same rules", async () => {
  const types = Object.fromEntries(Object.entries(WF_TYPES).map(([k, v]) => [Number(k), parseTypeMeta(hex(v))!]));
  const layout = await layoutOf(0x0351, async (id) => types[id] ?? null);
  if (layout.kind !== "struct") throw new Error("not a struct");
  // 7 fields of 4 bytes, the optional Configuration (presence + 24 bytes), two optional u32s.
  expect(layout.size).toBe(72);
  expect(layout.fields.map((f) => f.offset)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 56, 64]);
  const names = layout.fields.map((f) => f.name);
  const strings = ["1152805748", "UrbanTrail explorer", "v1.0.0", "feat_watchface_kunming_v1", "f903232d514b45dfd6b7abd8f2ac8885", "SetC_2"];
  const values = Object.fromEntries(names.map((n, i) => [n, i === 3 ? 175013 : i < 7 ? strings[i < 3 ? i : i - 1]! : null]));
  const param = structParam(0xb306, layout.align, encodeStruct(layout, values));
  // Captured: type, header 0x14b3 (179 bytes, align 4), 3 bytes padding, then the offsets.
  expect(toHex(param.subarray(0, 4))).toBe("06b3b314");
  expect(toHex(param.subarray(7, 7 + 28))).toBe("48000000530000006700000" + "0a5ab02006e00000088000000a9000000");
  expect(new TextDecoder().decode(param.subarray(7 + 72))).toBe(strings.join("\0") + "\0");
  expect(param.length).toBe(4 + 179);
});

// ------------------------------------------------------------------ the route file

test("route points: waypoints marked, close points dropped, distance as a fraction", () => {
  const line: LngLat[] = [[18, 59], [18.00001, 59], [18.001, 59], [18.002, 59], [18.003, 59]];
  const { points, distance_m } = watchPoints(line, { waypoints: [[18, 59], [18.002, 59]], elevation: [10, 10, 12, 14, 15] });
  expect(points).toHaveLength(4); // the 0.6 m step goes
  expect(points.map((p) => p.type)).toEqual([100, 255, 100, 255]);
  expect(points.map((p) => p.name)).toEqual(["", "none", "", "none"]);
  expect(points[0]!.rd).toBe(0);
  expect(points.at(-1)!.rd).toBe(1);
  expect(distance_m).toBeGreaterThan(170);
  const file = routeFile(points);
  expect(new TextDecoder().decode(file.subarray(0, 8))).toBe("SBEM0102");
  const chunks = parseSbem(file)!.chunks;
  expect(chunks.map((c) => c.id)).toEqual([1, 2, ...points.flatMap(() => [3, 4, 5, 6, 7, 8])]);
  // Unknown heights are the format's "nil".
  expect(new DataView(routeFile([{ ...points[0]!, alt: undefined }]).buffer).getInt32(8 + 12 + 2, true)).toBe(2147483647);
});

// ------------------------------------------------------------------ sending, against a simulated Run 2

const DESCRIPTOR = ROUTE_FIELDS.map((p) => `<PTH>${p}\n<FRM>x\n`).join("") + "pad".repeat(80);
/** The route record as the Run 2 describes it (24 Oct log); its time is the watch's own builtin 0x1ea. */
const ROUTE_TYPES = (createdType = 0x1ea): NonNullable<FakeWatchOptions["navigation"]>["types"] => ({
  0x3601: {
    kind: 3,
    fields: [
      { name: "id", type: 6 }, { name: "name", type: 12 }, { name: "activityId", type: 6 }, { name: "distance", type: 6 },
      { name: "lastModifiedDate", type: createdType }, { name: "routePointCount", type: 7 }, { name: "isQuickNavi", type: 1, required: false },
    ],
  },
  0x1ea: { kind: 0, scalarType: 9 },
});

const line: LngLat[] = Array.from({ length: 400 }, (_, i) => [18 + i * 0.0002, 59 + Math.sin(i / 20) * 0.001]);

test("sends a route the way the Suunto app does: checks, the file in pieces, the record", async () => {
  const nav = { ids: [2, 3, 5], descriptor: DESCRIPTOR, types: ROUTE_TYPES(), writes: [] as string[] } as NonNullable<FakeWatchOptions["navigation"]>;
  const s = new WatchSession(new FakeWatch({ name: "Suunto Run 2", files: {}, navigation: nav, notifySize: 120 }), FAST);
  await s.open();
  const { points, distance_m } = watchPoints(line, { waypoints: [line[0]!, line[200]!] });
  const progress: number[] = [];
  const res = await s.sendRoute({ name: "Söder loop", points, distance_m }, (p) => p.sent && progress.push(p.sent));
  expect(res.id).toBe(6);
  expect(nav.ids).toContain(6);
  // The file arrived whole, in 453-byte pieces.
  expect(toHex(nav.file!)).toBe(toHex(routeFile(points)));
  expect(progress.at(-1)).toBe(nav.file!.length);
  expect(progress[0]).toBe(453);
  // The record: our id, name, distance, point count; the rest as the Suunto app wrote it.
  const described = ROUTE_TYPES()!;
  const types = Object.fromEntries(Object.entries(described).map(([id, t]) => [id, { id: Number(id), kind: t.kind, scalarType: t.scalarType, fields: (t.fields ?? []).map((f, i) => ({ nameId: i, type: f.type, required: f.required !== false, name: f.name })), items: [] }])) as Record<number, TypeMeta>;
  const layout = await layoutOf(0x3601, async (id) => types[id] ?? null);
  if (layout.kind !== "struct") throw new Error("not a struct");
  expect([layout.size, layout.align]).toEqual([32, 8]);
  const rec = decodeStruct(layout, nav.record!);
  expect(rec).toMatchObject({ id: 6, name: "Söder loop", activityId: 3, distance: distance_m, routePointCount: points.length, isQuickNavi: 0 });
  expect(Number(rec.lastModifiedDate)).toBeGreaterThan(1.7e9);
  // The Suunto app's record has a stray 04 in the padding after isQuickNavi; Tartan writes zeros there.
  expect(fieldBytes(layout).slice(28)).toEqual([true, true, false, false]);
  expect([...nav.record!.subarray(28, 32)]).toEqual([1, 0, 0, 0]);
  // Only the two route resources were written.
  expect([...new Set(nav.writes)].sort()).toEqual(["/Settings/Navigation/Route", "/Settings/Navigation/Route/Data"]);
});

test("writes nothing when the watch describes the record differently", async () => {
  const nav = { ids: [1], descriptor: DESCRIPTOR, types: ROUTE_TYPES(7), writes: [] as string[] } as NonNullable<FakeWatchOptions["navigation"]>;
  const s = new WatchSession(new FakeWatch({ name: "Suunto Run 2", files: {}, navigation: nav, notifySize: 120 }), FAST);
  await s.open();
  const { points, distance_m } = watchPoints(line);
  await expect(s.sendRoute({ name: "x", points, distance_m })).rejects.toThrow(/nothing was sent/);
  expect(nav.writes).toEqual([]);
});

test("writes nothing when the route format isn't the one Tartan knows", async () => {
  const nav = { ids: [], descriptor: DESCRIPTOR.replace("Latitude", "Lat"), types: ROUTE_TYPES(), writes: [] as string[] } as NonNullable<FakeWatchOptions["navigation"]>;
  const s = new WatchSession(new FakeWatch({ name: "Suunto Run 2", files: {}, navigation: nav, notifySize: 120 }), FAST);
  await s.open();
  const { points, distance_m } = watchPoints(line);
  await expect(s.sendRoute({ name: "x", points, distance_m })).rejects.toThrow(/describes routes differently/);
  expect(nav.writes).toEqual([]);
});

// ------------------------------------------------------------------ turn prompts from the route's shape

/** A line from `start` going `m` metres in each step's direction (degrees from north), a point every 5 m. */
function walk(start: LngLat, legs: Array<[number, number]>): LngLat[] {
  const out: LngLat[] = [start];
  let [lon, lat] = start;
  for (const [deg, m] of legs)
    for (let k = 0; k < m / 5; k++) {
      lat += (5 * Math.cos((deg * Math.PI) / 180)) / 111_320;
      lon += (5 * Math.sin((deg * Math.PI) / 180)) / (111_320 * Math.cos((lat * Math.PI) / 180));
      out.push([lon, lat]);
    }
  return out;
}
const turnsOf = (line: LngLat[]) => watchPoints(line).points.filter((p) => p.type >= 48 && p.type <= 55).map((p) => p.name);

test("turn prompts come from the route's own shape: left, right, sharp, slight, turn around", () => {
  expect(turnsOf(walk([18.07, 59.33], [[90, 300], [0, 300]]))).toEqual(["Left"]);
  expect(turnsOf(walk([18.07, 59.33], [[90, 300], [180, 300]]))).toEqual(["Right"]);
  expect(turnsOf(walk([18.07, 59.33], [[90, 300], [125, 300]]))).toEqual(["Slight right"]);
  expect(turnsOf(walk([18.07, 59.33], [[90, 300], [240, 300]]))).toEqual(["Sharp right"]);
  expect(turnsOf(walk([18.07, 59.33], [[90, 300], [270, 300]]))).toEqual(["Turn around"]);
  // Two corners: a block.
  expect(turnsOf(walk([18.07, 59.33], [[0, 200], [90, 200], [180, 200]]))).toEqual(["Right", "Right"]);
});

test("no prompts for a straight road, a wobbly line, or a bend at the very start; a placed waypoint wins", () => {
  expect(turnsOf(walk([18.07, 59.33], [[45, 800]]))).toEqual([]);
  expect(turnsOf(walk([18.07, 59.33], Array.from({ length: 40 }, (_, i) => [i % 2 ? 80 : 100, 20] as [number, number])))).toEqual([]);
  expect(turnsOf(walk([18.07, 59.33], [[90, 20], [0, 400]]))).toEqual([]);
  const corner = walk([18.07, 59.33], [[90, 300], [0, 300]]);
  const pts = watchPoints(corner, { waypoints: [corner[60]!] }).points;
  expect(pts.filter((p) => p.type === 100).length).toBe(2);
  expect(pts.filter((p) => p.type >= 48 && p.type <= 55)).toEqual([]);
});
