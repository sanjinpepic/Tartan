import { expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { climb, lineOf, metres, parseGpx, Routes, thin, toGpx, type LngLat } from "../src/routes.ts";

const A: LngLat = [18.0686, 59.3293];
const B: LngLat = [18.0786, 59.3293];
const C: LngLat = [18.0786, 59.3343];

test("metres: a hundredth of a degree of longitude at 59° N is about 568 m", () => {
  expect(metres(A, B)).toBeGreaterThan(560);
  expect(metres(A, B)).toBeLessThan(575);
});

test("lineOf joins segments without repeating where they meet", () => {
  expect(lineOf([{ mode: "paths", coords: [A, B] }, { mode: "straight", coords: [B, C] }])).toEqual([A, B, C]);
});

test("climb ignores wobbles under 3 m", () => {
  expect(climb([10, 11, 10, 11, 10, 20, 19, 21, 5])).toEqual({ ascent_m: 10, descent_m: 15 });
});

test("thin keeps the ends", () => {
  const line = Array.from({ length: 1000 }, (_, i) => [i, 0] as LngLat);
  const t = thin(line, 80);
  expect(t).toHaveLength(80);
  expect(t[0]).toEqual([0, 0]);
  expect(t.at(-1)).toEqual([999, 0]);
});

test("save works out distance and climb; list, get and remove", async () => {
  const routes = new Routes(new MemoryDisk());
  const r = await routes.save({ name: "  Söder loop ", waypoints: [A, B, C, A], segments: [{ mode: "paths", coords: [A, B] }, { mode: "paths", coords: [B, C] }, { mode: "straight", coords: [C, A] }], elevation: [10, 30, 20, 10] }, new Date("2026-10-16T10:00:00Z"));
  expect(r.name).toBe("Söder loop");
  expect(r.distance_m).toBeGreaterThan(1700);
  expect(r).toMatchObject({ ascent_m: 20, descent_m: 20 });
  const [s] = await routes.list();
  expect(s).toMatchObject({ id: r.id, name: "Söder loop", loop: true });
  // Saving again keeps the id and the creation time.
  const again = await routes.save({ ...r, name: "Söder", segments: r.segments, waypoints: r.waypoints }, new Date("2026-10-17T10:00:00Z"));
  expect(again).toMatchObject({ id: r.id, created: r.created, name: "Söder" });
  expect(await routes.remove(r.id)).toBe(true);
  expect(await routes.get(r.id)).toBeNull();
  expect(await routes.list()).toEqual([]);
});

test("save refuses broken input", async () => {
  const routes = new Routes(new MemoryDisk());
  await expect(routes.save({ name: "x", waypoints: [A, B], segments: [] })).rejects.toThrow(/line between/);
  await expect(routes.save({ name: "x", waypoints: [A, [200, 0]], segments: [{ mode: "paths", coords: [A, B] }] })).rejects.toThrow(/at least one point/);
  // Elevation that doesn't match the line is dropped, not trusted.
  const r = await routes.save({ name: "x", waypoints: [A, B], segments: [{ mode: "paths", coords: [A, B] }], elevation: [1, 2, 3] });
  expect(r.elevation).toBeUndefined();
});

test("GPX out and back in", async () => {
  const gpx = toGpx({ name: "Tom & Jerry's <loop>", segments: [{ mode: "paths", coords: [A, B, C] }], elevation: [10, 12.5, 9] });
  expect(gpx).toContain('<trkpt lat="59.329300" lon="18.068600"><ele>10.0</ele></trkpt>');
  expect(gpx).toContain("<name>Tom &amp; Jerry&apos;s &lt;loop&gt;</name>");
  const back = parseGpx(gpx);
  expect(back).toEqual({ name: "Tom & Jerry's <loop>", line: [A, B, C], elevation: [10, 12.5, 9] });
  const routes = new Routes(new MemoryDisk());
  const r = await routes.importGpx(gpx);
  expect(r).toMatchObject({ name: "Tom & Jerry's <loop>", source: "gpx", waypoints: [A, C] });
  expect(r.elevation).toEqual([10, 12.5, 9]);
});

test("GPX routes and waypoint lists import too; empty files don't", () => {
  expect(parseGpx(`<gpx><rte><rtept lat="1" lon="2"/><rtept lat="1.1" lon="2.1"/></rte></gpx>`).line).toEqual([[2, 1], [2.1, 1.1]]);
  expect(() => parseGpx("<gpx></gpx>")).toThrow(/No track/);
});

test("a route remembers its copy on the watch until a new one is sent", async () => {
  const routes = new Routes(new MemoryDisk());
  const r = await routes.save({ name: "x", waypoints: [A, B], segments: [{ mode: "paths", coords: [A, B] }] });
  await routes.save({ ...r, watch: { id: 12, sent: "2026-10-16T18:00:00Z", name: "x" } });
  // A later save without it (the editor saving again) keeps it.
  const again = await routes.save({ id: r.id, name: "y", waypoints: r.waypoints, segments: r.segments });
  expect(again.watch).toEqual({ id: 12, sent: "2026-10-16T18:00:00Z", name: "x" });
  expect((await routes.list())[0]!.watch?.id).toBe(12);
  // Junk isn't kept.
  const junk = await routes.save({ id: r.id, name: "y", waypoints: r.waypoints, segments: r.segments, watch: { id: "1" } as never });
  expect(junk.watch?.id).toBe(12);
});

// ------------------------------------------------------------------ fat-finger snapping

import { nearestOnLines } from "../web/lib/snap.ts";

test("a tap near a path lands on the nearest one, a tap far from any stays put", () => {
  const road = [{ x: 0, y: 100 }, { x: 200, y: 100 }];
  const path = [{ x: 50, y: 0 }, { x: 50, y: 200 }];
  expect(nearestOnLines({ x: 120, y: 90 }, [road, path], 28)).toEqual({ x: 120, y: 100 });
  expect(nearestOnLines({ x: 60, y: 30 }, [road, path], 28)).toEqual({ x: 50, y: 30 });
  // Past the end of a line: its end.
  expect(nearestOnLines({ x: 210, y: 105 }, [road], 28)).toEqual({ x: 200, y: 100 });
  expect(nearestOnLines({ x: 120, y: 160 }, [road, path], 28)).toBeNull();
  expect(nearestOnLines({ x: 1, y: 1 }, [], 28)).toBeNull();
});

// ------------------------------------------------------------------ loops from here

import { loopWaypoints, makeLoops, offset } from "../src/route-loop.ts";
import { metres as dist } from "../src/routes.ts";

test("loops from a start: three turning points on a circle through it, each way a different loop", async () => {
  const start: [number, number] = [24.94, 60.17];
  expect(dist(start, offset(start, 90, 1000))).toBeCloseTo(1000, -1);
  const wp = loopWaypoints(start, 0, 1000);
  expect(wp[0]).toEqual(start);
  expect(wp.at(-1)).toEqual(start);
  // All on one circle 1 km round its centre.
  const centre = offset(start, 0, 1000);
  for (const p of wp.slice(1, -1)) expect(dist(centre, p)).toBeCloseTo(1000, -1);
  // A router that wanders: each leg a dog-leg, a good deal longer than straight.
  const wander = async (a: [number, number], b: [number, number]) => [a, [a[0], b[1]] as [number, number], b];
  const loops = await makeLoops(start, 10, wander, { firstBearing: 30 });
  expect(loops).toHaveLength(3);
  for (const l of loops) {
    expect(Math.abs(l.km / 10 - 1)).toBeLessThan(0.15);
    expect(l.legs).toHaveLength(4);
  }
  expect(new Set(loops.map((l) => l.bearing))).toEqual(new Set([30, 150, 270]));
  // A leg with no way through drops that loop.
  let calls = 0;
  const flaky = async (a: [number, number], b: [number, number]) => (++calls === 2 ? null : [a, b]);
  expect((await makeLoops(start, 5, flaky, { count: 1 })).length).toBe(0);
});

import { splitLoop } from "../src/route-loop.ts";

test("a whole loop routed in one go is cut into legs at its turning points, moved onto the path", () => {
  const sq: [number, number][] = [];
  for (let i = 0; i <= 10; i++) sq.push([24.9 + i * 0.001, 60.17]);
  for (let i = 1; i <= 10; i++) sq.push([24.91, 60.17 + i * 0.0005]);
  for (let i = 1; i <= 10; i++) sq.push([24.91 - i * 0.001, 60.175]);
  for (let i = 1; i <= 10; i++) sq.push([24.9, 60.175 - i * 0.0005]);
  // The turning points a little off the path: each lands on the path's nearest point.
  const stops: [number, number][] = [sq[0]!, [24.9101, 60.1699], [24.9102, 60.1751], [24.8999, 60.1752], sq[0]!];
  const { legs, points } = splitLoop(sq, stops);
  expect(legs).toHaveLength(4);
  expect(points[1]).toEqual(sq[10]!);
  expect(points[2]).toEqual(sq[20]!);
  for (let k = 0; k < 4; k++) {
    expect(legs[k]![0]).toEqual(points[k]!);
    expect(legs[k]!.at(-1)).toEqual(points[k + 1]!);
  }
});

test("loops get within 7% of the distance asked for; ones that can't get within 15% aren't offered", async () => {
  const start: [number, number] = [24.94, 60.17];
  // A network that winds a lot: every leg 1.6 times the straight line.
  const winding = async (pts: [number, number][]) => {
    const legs = pts.slice(1).map((b, i) => {
      const a = pts[i]!;
      const mid: [number, number] = [(a[0] + b[0]) / 2 + (b[1] - a[1]) * 0.62, (a[1] + b[1]) / 2 - (b[0] - a[0]) * 0.31];
      return [a, mid, b];
    });
    return { legs, points: pts };
  };
  const loops = await makeLoops(start, 10, async () => null, { firstBearing: 0, loop: winding });
  expect(loops.length).toBeGreaterThan(0);
  for (const l of loops) expect(Math.abs(l.km / 10 - 1)).toBeLessThanOrEqual(0.07);
  // A start where every loop drags along a 6 km detour: nothing near 5 km, so nothing offered.
  const detour = async (pts: [number, number][]) => ({ legs: [[pts[0]!, offset(pts[0]!, 90, 3000), pts[0]!], ...pts.slice(1).map((b, i) => [pts[i]!, b])], points: [pts[0]!, ...pts] });
  expect(await makeLoops(start, 5, async () => null, { loop: detour })).toEqual([]);
});
