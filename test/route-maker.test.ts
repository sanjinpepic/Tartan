/** Routes the coach makes from a prompt (src/route-maker.ts), against fake map services. */
import { expect, test } from "bun:test";
import { Coach } from "../src/coach.ts";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import { makeRoute, usualStart } from "../src/route-maker.ts";
import { Routes, type LngLat } from "../src/routes.ts";
import { sceneryOf, sortWays } from "../src/scenery.ts";

const HOME: LngLat = [24.94, 60.17];
/** Points every ~20 m from a to b (a path that goes straight). */
const straight = (a: LngLat, b: LngLat): LngLat[] => {
  const n = Math.max(2, Math.ceil(Math.hypot((b[0] - a[0]) * 55_000, (b[1] - a[1]) * 111_000) / 20));
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as LngLat);
};
/** A park covering everything north of home; a busy road along its south edge. */
const park = [[24.8, 60.172], [25.1, 60.172], [25.1, 60.3], [24.8, 60.3], [24.8, 60.172]].map(([lon, lat]) => ({ lon, lat }));
const road = [[24.8, 60.165], [25.1, 60.165]].map(([lon, lat]) => ({ lon, lat }));
const calls: string[] = [];
const get = async (url: string): Promise<Response> => {
  calls.push(url.split("?")[0]!);
  if (url.includes("nominatim") && url.includes("/reverse")) {
    const lon = Number(/lon=([^&]+)/.exec(url)![1]);
    return Response.json({ address: lon < 10 ? { suburb: "Harbour", city: "Seaport" } : { suburb: "Old Town", municipality: "Lakeside" } });
  }
  if (url.includes("nominatim")) {
    const q = decodeURIComponent(/q=([^&]+)/.exec(url)![1]!);
    return Response.json(q.includes("nowhere") ? [] : [{ lat: "60.18", lon: "24.95", name: "The Lake" }]);
  }
  if (url.includes("routed-foot")) {
    const pts = /driving\/([^?]+)/.exec(url)![1]!.split(";").map((p) => p.split(",").map(Number) as LngLat);
    const line = pts.slice(1).flatMap((p, i) => straight(pts[i]!, p).slice(i ? 1 : 0));
    return Response.json({ code: "Ok", routes: [{ geometry: { coordinates: line } }], waypoints: pts.map((location) => ({ location })) });
  }
  if (url.includes("overpass")) return Response.json({ elements: [{ tags: { leisure: "park" }, geometry: park }, { tags: { highway: "primary" }, geometry: road }] });
  if (url.includes("open-meteo")) {
    const lats = /latitude=([^&]+)/.exec(url)![1]!.split(",").map(Number);
    return Response.json({ elevation: lats.map((l) => Math.round((l - 60) * 2000)) });
  }
  return new Response("no", { status: 500 });
};

test("a green 5 km loop from home: the candidate through the park is kept, named and with its climb", async () => {
  const r = await makeRoute({ km: 5, prefer: "nature" }, { get, home: async () => HOME });
  expect(Math.abs(r.km - 5)).toBeLessThan(0.75);
  expect(r.weighed).toBeGreaterThan(1);
  expect(r.from).toBe("your usual start");
  expect(r.route.name).toMatch(/^Green 5(\.\d)? km loop in Old Town$/);
  expect(r.scenery!.green).toBeGreaterThan(0.5);
  expect(r.ascent_m).toBeGreaterThan(0);
  expect(calls).toContain("https://overpass-api.de/api/interpreter");
});

test("to a place by name; here needs a location; a place that isn't on the map is said plainly", async () => {
  const to = await makeRoute({ shape: "to", to: "the lake" }, { get, home: async () => HOME });
  expect(to.route.name).toBe("To The Lake");
  expect(to.route.waypoints.at(-1)).toEqual([24.95, 60.18]);
  await expect(makeRoute({ km: 5, start: "here" }, { get, home: async () => HOME })).rejects.toThrow(/where you are/);
  await expect(makeRoute({ km: 5, start: "nowhere at all" }, { get, home: async () => HOME })).rejects.toThrow(/Couldn't find "nowhere at all"/);
  const back = await makeRoute({ km: 6, shape: "out_and_back", start: "here" }, { get, home: async () => HOME, whereAmI: async () => HOME });
  expect(back.route.waypoints[0]).toEqual(back.route.waypoints.at(-1));
  expect(Math.abs(back.km - 6)).toBeLessThan(0.9);
});

test("the usual start: where most recent runs began", () => {
  const a: LngLat = [24.94, 60.17];
  const near: LngLat = [24.941, 60.1702];
  const away: LngLat = [25.2, 60.3];
  expect(usualStart([away, a, near, a])).toEqual(a);
  expect(usualStart([])).toBeNull();
});

test("scenery: on a trail, in a park, beside a busy road", () => {
  const f = sortWays([{ tags: { highway: "path" }, geometry: [{ lon: 0, lat: 0 }, { lon: 0.01, lat: 0 }] }, { tags: { highway: "primary" }, geometry: [{ lon: 0, lat: 0.001 }, { lon: 0.01, lat: 0.001 }] }]);
  const s = sceneryOf([[0, 0], [0.01, 0]], f);
  expect(s.trails).toBe(1);
  expect(s.busy).toBe(0);
  expect(s.green).toBe(0);
});

test("the coach's make_route: saved in Routes, sent to the watch when asked, linked in the chat", async () => {
  const lib = new Library(new MemoryDisk());
  const sent: string[] = [];
  const coach = new Coach(lib, { routes: { get, whereAmI: async () => HOME, sendRoute: async (r) => (sent.push(r.name), { id: 7 }) } });
  const tool = (coach as unknown as { tools: Array<{ name: string; run: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }> }).tools.find((t) => t.name === "make_route")!;
  const out = await tool.run({ km: 4, start: "here", prefer: "nature", send_to_watch: true });
  expect(out.watch).toMatch(/On the watch/);
  expect(out.scenery).toMatch(/through parks/);
  const list = await new Routes(lib.disk).list();
  expect(list).toHaveLength(1);
  expect(list[0]!.watch).toMatchObject({ id: 7 });
  expect(sent).toEqual([list[0]!.name]);
  // A watch that can't be reached: still saved, and said.
  const shy = new Coach(lib, { routes: { get, whereAmI: async () => HOME, sendRoute: async () => { throw new Error("Connect your watch first"); } } });
  const t2 = (shy as unknown as { tools: typeof tool[] }).tools.find((t) => t.name === "make_route")!;
  expect((await t2.run({ km: 3, start: "here", send_to_watch: true })).watch).toMatch(/Not on the watch: Connect your watch first/);
});

test("away from home, in another city: the route starts where the phone is, and says where that is", async () => {
  const home: LngLat = [10.75, 59.91];
  const away: LngLat = [4.48, 51.92];
  const deps = { get, home: async () => home, whereAmI: async () => away };
  // Nothing said about where: where you are.
  const r = await makeRoute({ km: 5 }, deps);
  expect(r.start).toEqual(away);
  expect(r.place).toBe("Harbour, Seaport");
  expect(r.route.name).toMatch(/km loop in Harbour$/);
  // "From home", but you're 1,200 km away: where you are, and said so.
  const h = await makeRoute({ km: 5, start: "home" }, deps);
  expect(h.start).toEqual(away);
  expect(h.from).toMatch(/away from your usual start/);
  // At home: home is home.
  const atHome = await makeRoute({ km: 5, start: "home" }, { ...deps, whereAmI: async () => [10.751, 59.9101] as LngLat });
  expect(atHome.from).toBe("your usual start");
  expect(atHome.place).toBe("Old Town, Lakeside");
  // No fresh fix: "here" says why, and never falls back to an old place.
  await expect(makeRoute({ km: 5, start: "here" }, { ...deps, whereAmI: async () => { throw new Error("No location fix in 25 seconds (indoors?)."); } })).rejects.toThrow(/couldn't get where you are \(No location fix in 25 seconds \(indoors\?\)\)/);
});

test("the route is made, then the reply fails: the chat says the route is saved, and keeps its link", async () => {
  let n = 0;
  const google = Bun.serve({
    port: 0,
    fetch() {
      n++;
      if (n === 1) {
        const chunk = { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "make_route", args: { km: 3, start: "here" } } }] }, finishReason: "STOP", index: 0 }] };
        return new Response(`data: ${JSON.stringify(chunk)}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } }, { status: 400 });
    },
  });
  try {
    const lib = new Library(new MemoryDisk());
    const coach = new Coach(lib, { googleBaseUrl: google.url.toString().replace(/\/$/, ""), routes: { get, whereAmI: async () => HOME } });
    await coach.saveSettings({ provider: "google", googleKey: "AIza-test" });
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const e of coach.chat(null, "A 3 km loop from here")) events.push(e as never);
    const route = events.find((e) => e.type === "route")!;
    expect(route.name).toMatch(/km loop in Old Town/);
    expect(String(events.at(-1)!.message)).toMatch(/^Your route is made and saved: open it below\. The coach's reply about it didn't come through/);
    const id = String(events[0]!.id);
    const last = (await coach.conversation(id))!.display.at(-1)!;
    expect(last).toMatchObject({ failed: true, routes: [{ id: route.id }] });
    expect(last.error).toMatch(/^Your route is made and saved/);
    expect(await new Routes(lib.disk).list()).toHaveLength(1);
  } finally {
    google.stop(true);
  }
});

test("show_route: a saved route as a card in the chat, kept with the answer", async () => {
  const lib = new Library(new MemoryDisk());
  const saved = await new Routes(lib.disk).save({ name: "Sunday loop", waypoints: [HOME, [24.95, 60.17], HOME], segments: [{ mode: "paths", coords: straight(HOME, [24.95, 60.17]) }, { mode: "paths", coords: straight([24.95, 60.17], HOME) }] });
  let n = 0;
  const google = Bun.serve({
    port: 0,
    fetch() {
      n++;
      const part = n === 1 ? { functionCall: { name: "show_route", args: { id: saved.id } } } : { text: "Here's your Sunday loop." };
      const chunk = { candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }] };
      return new Response(`data: ${JSON.stringify(chunk)}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const coach = new Coach(lib, { googleBaseUrl: google.url.toString().replace(/\/$/, ""), routes: { get } });
    await coach.saveSettings({ provider: "google", googleKey: "AIza-test" });
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const e of coach.chat(null, "Show me my Sunday loop")) events.push(e as never);
    const card = events.find((e) => e.type === "route")!;
    expect(card).toMatchObject({ id: saved.id, name: "Sunday loop", loop: true, on_watch: false });
    expect((card.preview as unknown[]).length).toBeGreaterThan(10);
    expect(Math.abs(Number(card.km) - 1.1)).toBeLessThan(0.1);
    const last = (await coach.conversation(String(events[0]!.id)))!.display.at(-1)!;
    expect(last.routes?.[0]).toMatchObject({ id: saved.id, name: "Sunday loop" });
  } finally {
    google.stop(true);
  }
});
