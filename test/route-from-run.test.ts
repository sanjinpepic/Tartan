/** Routes from your own runs (src/route-from-run.ts, the coach's route_from_run), against a fake path finder. */
import { expect, test } from "bun:test";
import { Coach } from "../src/coach.ts";
import { MemoryDisk } from "../src/disk.ts";
import { FILES_FOLDER, importWorkout } from "../src/import.ts";
import { Library } from "../src/library.ts";
import { resize, routeFromRun, sameRoute, usualOf, whenRange } from "../src/route-from-run.ts";
import { along, lineOf, Routes, type LngLat } from "../src/routes.ts";
import { LocalStore } from "../src/store.ts";

const HOME: LngLat = [24.94, 60.17];
/** Points every ~20 m from a to b. */
const straight = (a: LngLat, b: LngLat): LngLat[] => {
  const n = Math.max(2, Math.ceil(Math.hypot((b[0] - a[0]) * 55_000, (b[1] - a[1]) * 111_000) / 20));
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as LngLat);
};
/** A path finder where every way is straight; heights rise to the north. */
const get = async (url: string): Promise<Response> => {
  if (url.includes("routed-foot")) {
    const pts = /driving\/([^?]+)/.exec(url)![1]!.split(";").map((p) => p.split(",").map(Number) as LngLat);
    const line = pts.slice(1).flatMap((p, i) => straight(pts[i]!, p).slice(i ? 1 : 0));
    return Response.json({ code: "Ok", routes: [{ geometry: { coordinates: line } }], waypoints: pts.map((location) => ({ location })) });
  }
  if (url.includes("open-meteo")) {
    const lats = /latitude=([^&]+)/.exec(url)![1]!.split(",").map(Number);
    return Response.json({ elevation: lats.map((l) => Math.round((l - 60) * 2000)) });
  }
  return new Response("no", { status: 500 });
};
const offline = async () => new Response("down", { status: 503 });

/** A loop of about `km` from `start`, its circle heading `dir` degrees off north (a different loop per dir). */
const loop = (start: LngLat, km: number, dir = 0, n = 400): LngLat[] => {
  const r = (km * 1000) / (2 * Math.PI);
  const b = (dir * Math.PI) / 180;
  const centre: LngLat = [start[0] + (Math.sin(b) * r) / 55_500, start[1] + (Math.cos(b) * r) / 111_200];
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = b + Math.PI + (i / n) * 2 * Math.PI;
    return [centre[0] + (Math.sin(a) * r) / 55_500, centre[1] + (Math.cos(a) * r) / 111_200] as LngLat;
  });
};
const km = (line: LngLat[]) => along(line).at(-1)! / 1000;

test("date words: yesterday, last tuesday, last week, a date; anything else is null", () => {
  // Wednesday 18 November 2026.
  const t = "2026-11-18";
  expect(whenRange("yesterday", t)).toEqual({ from: "2026-11-17", to: "2026-11-17" });
  expect(whenRange("last Tuesday", t)).toEqual({ from: "2026-11-17", to: "2026-11-17" });
  expect(whenRange("wednesday", t)).toEqual({ from: "2026-11-11", to: "2026-11-11" });
  expect(whenRange("this wednesday", t)).toEqual({ from: "2026-11-18", to: "2026-11-18" });
  expect(whenRange("last week", t)).toEqual({ from: "2026-11-09", to: "2026-11-15" });
  expect(whenRange("last weekend", t)).toEqual({ from: "2026-11-14", to: "2026-11-15" });
  expect(whenRange("3 days ago", t)).toEqual({ from: "2026-11-15", to: "2026-11-15" });
  expect(whenRange("2026-10-02", t)).toEqual({ from: "2026-10-02", to: "2026-10-02" });
  expect(whenRange("a while back", t)).toBeNull();
});

test("the usual one: the line most others follow from the same start", () => {
  const a = loop(HOME, 8, 0);
  const b = loop(HOME, 8, 0).map(([x, y]) => [x + 0.0003, y] as LngLat); // the same, 15 m over
  const c = loop(HOME, 8, 180); // the same length the other way round the start
  expect(sameRoute(a, b)).toBe(true);
  expect(sameRoute(a, c)).toBe(false);
  expect(sameRoute(a, loop(HOME, 12, 0))).toBe(false);
  const u = usualOf([{ id: "c", line: c }, { id: "a", line: a }, { id: "b", line: b }])!;
  expect(u.run.id).toBe("a");
  expect(u.repeats).toBe(2);
});

test("longer by an out and back from the far end; a loop cut across to be shorter; a one-way run ends early", async () => {
  const l = loop(HOME, 8);
  const longer = await resize(l, 10, get);
  expect(Math.abs(longer.km - 10)).toBeLessThan(0.25);
  expect(longer.how).toMatch(/out and back of 2(\.\d)? km/);
  const shorter = await resize(l, 6, get);
  expect(Math.abs(shorter.km - 6)).toBeLessThan(0.35);
  expect(shorter.how).toMatch(/cut across/);
  const oneWay = straight(HOME, [HOME[0], HOME[1] + 0.05]);
  const cut = await resize(oneWay, 3, get);
  expect(Math.abs(cut.km - 3)).toBeLessThan(0.05);
  await expect(resize(l, 10, offline)).rejects.toThrow(/couldn't be reached/);
});

test("a run as a route: its own line and heights, reversed, or resized with the map's heights", async () => {
  const line = loop(HOME, 6);
  const run = { id: "r1", start: "2026-11-17T06:00:00Z", name: "River loop", distance_km: 6, line, elevation: line.map((_, i) => i % 50) };
  const same = await routeFromRun(run, { get: offline });
  expect(same.route.name).toBe("River loop, Tue 17 Nov");
  expect(same.route.segments).toHaveLength(1);
  expect(same.route.elevation?.length).toBe(same.route.segments[0]!.coords.length);
  const back = await routeFromRun(run, { reverse: true, get: offline });
  expect(back.route.name).toBe("River loop, Tue 17 Nov, reversed");
  expect(back.route.segments[0]!.coords[1]).toEqual(same.route.segments[0]!.coords.at(-2)!);
  const longer = await routeFromRun(run, { km: 8, get });
  expect(longer.route.name).toMatch(/^River loop, Tue 17 Nov, 8(\.\d)? km$/);
  expect(longer.route.waypoints.length).toBe(longer.route.segments.length + 1);
  expect(Math.abs(km(lineOf(longer.route.segments)) - 8)).toBeLessThan(0.3);
  expect(longer.route.elevation?.length).toBe(lineOf(longer.route.segments).length);
});

/** A run as a FIT file along `line`, at 5:30 /km. */
const fit = (start: number, line: LngLat[]) => {
  const samples = [];
  let d = 0;
  for (let i = 0; i < line.length; i++) {
    if (i) d += along([line[i - 1]!, line[i]!]).at(-1)!;
    samples.push({ t: start + d * 330, lat: line[i]![1], lon: line[i]![0], hr: 140, distance: d });
  }
  return { start, end: start + d * 330, sport: "running", samples };
};

test("the coach's route_from_run: last tuesday's loop 2 km longer, the usual Sunday run, a run reversed", async () => {
  const disk = new MemoryDisk();
  const store = new LocalStore(disk);
  const sunday = (weeks: number) => {
    const d = new Date();
    d.setHours(8, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 7) % 7 || 7) - 7 * weeks);
    return d.getTime();
  };
  // Three Sundays on the same 14 km loop (one a little off the line), one on another; a Tuesday loop.
  await importWorkout(store, FILES_FOLDER, "s1", fit(sunday(0), loop(HOME, 14, 90)));
  await importWorkout(store, FILES_FOLDER, "s2", fit(sunday(1), loop(HOME, 14, 270)));
  await importWorkout(store, FILES_FOLDER, "s3", fit(sunday(2), loop(HOME, 14, 90).map(([x, y]) => [x, y + 0.0002] as LngLat)));
  await importWorkout(store, FILES_FOLDER, "s4", fit(sunday(3), loop(HOME, 14, 90)));
  const tuesday = (() => {
    const d = new Date();
    d.setHours(18, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() - 2 + 7) % 7 || 7));
    return d.getTime();
  })();
  await importWorkout(store, FILES_FOLDER, "t1", fit(tuesday, loop(HOME, 8, 0)));
  const lib = new Library(disk);
  const sent: string[] = [];
  const coach = new Coach(lib, { routes: { get, sendRoute: async (r) => (sent.push(r.name), { id: 9 }) } });
  const tool = (coach as unknown as { tools: Array<{ name: string; run: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }> }).tools.find((t) => t.name === "route_from_run")!;

  const tue = await tool.run({ when: "last tuesday", change_km: 2 });
  expect(tue.error).toBeUndefined();
  expect(Math.abs((tue.km as number) - 10)).toBeLessThan(0.3);
  expect(tue.asked_km).toBe(10);
  expect(tue.changed).toMatch(/out and back/);

  const usual = await tool.run({ usual: true, weekday: "sun", send_to_watch: true });
  expect((usual.from_run as { usual?: string }).usual).toBe("3 of the 4 matching runs follow this line");
  expect(Math.abs((usual.km as number) - 14)).toBeLessThan(0.2);
  expect(usual.watch).toMatch(/On the watch/);
  expect(sent).toHaveLength(1);

  const back = await tool.run({ when: "last tuesday", reverse: true });
  expect(back.saved).toMatch(/reversed$/);
  expect(back.changed).toBe("reversed");

  expect((await tool.run({ when: "a while back" })).error).toMatch(/isn't a day/);
  expect((await tool.run({ name: "marathon" })).error).toMatch(/No run with a GPS line matched/);
  // Each made a route, shown as a card.
  expect(await new Routes(disk).list()).toHaveLength(3);
  expect(coach.routesShown).toHaveLength(3);
});
