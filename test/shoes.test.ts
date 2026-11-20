import { describe, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { importStrava, kindFromName, limitFor, pickShoe, sessionNeeds, shoeFor, switchAdvice, shoeTotals, Shoes, toStrava, wornOut, type ShoeData } from "../src/shoes.ts";

const run = (id: string, date: string, km: number, need?: "daily" | "racing" | "trail") => ({ id, start: `${date}T08:00:00`, km, ...(need ? { need } : {}) });
const data: ShoeData = {
  shoes: [
    { id: "old", name: "Pegasus 40", since: "2026-01-01", start_km: 100, limit_km: 700, retired: "2026-09-30" },
    { id: "new", name: "Pegasus 41", since: "2026-10-01", start_km: 0, limit_km: 700 },
    { id: "race", name: "Vaporfly", since: "2026-10-10", start_km: 0, limit_km: 400 },
  ],
  assign: { r4: "new" },
};

describe("shoes", () => {
  test("a run counts to the newest pair of its kind started by then, unless moved", () => {
    expect(shoeFor(run("r1", "2026-05-01", 10), data)).toBe("old");
    expect(shoeFor(run("r2", "2026-10-05", 10), data)).toBe("new");
    // Racing shoes take the fast days; an easy run stays on the daily pair.
    expect(shoeFor(run("r3", "2026-10-12", 10, "racing"), data)).toBe("race");
    expect(shoeFor(run("r5", "2026-10-12", 10), data)).toBe("new");
    // No trail pair: the daily one.
    expect(shoeFor(run("r6", "2026-10-12", 10, "trail"), data)).toBe("new");
    expect(shoeFor(run("r4", "2026-10-12", 10), data)).toBe("new");
    expect(shoeFor(run("r0", "2025-12-01", 10), data)).toBeNull();
  });
  test("totals add the kilometres already on a pair; in use first; near the limit flagged", () => {
    const t = shoeTotals([run("r1", "2026-05-01", 600), run("r2", "2026-10-05", 12), run("r3", "2026-10-12", 380, "racing"), run("r4", "2026-10-12", 10)], data);
    expect(t.map((s) => [s.id, s.km, s.runs])).toEqual([["race", 380, 1], ["new", 22, 2], ["old", 700, 1]]);
    expect(wornOut(t).map((s) => s.id)).toEqual(["race"]);
  });
  test("stored: add, change, move a run, remove", async () => {
    const s = new Shoes(new MemoryDisk());
    await expect(s.put({ name: "  " })).rejects.toThrow(/name/);
    const d = await s.put({ name: "Pegasus 41", since: "2026-10-01", start_km: 40 });
    const id = d.shoes[0]!.id;
    expect(d.shoes[0]).toMatchObject({ name: "Pegasus 41", since: "2026-10-01", start_km: 40, limit_km: 700 });
    expect((await s.put({ id, name: "Pegasus 41", since: "2026-10-01", retired: "2026-12-01" })).shoes[0]!.retired).toBe("2026-12-01");
    expect((await s.assign("r9", null)).assign).toEqual({ r9: null });
    expect((await s.assign("r9", undefined)).assign).toEqual({});
    expect((await s.remove(id)).shoes).toEqual([]);
  });
  test("pairs added at once each keep their own id", async () => {
    const s = new Shoes(new MemoryDisk());
    await s.put({ name: "A" });
    await s.put({ name: "B" });
    expect((await s.put({ name: "C", kind: "racing" })).shoes.map((x) => [x.name, x.kind])).toEqual([["A", undefined], ["B", undefined], ["C", "racing"]]);
  });
  test("a photo is kept, replaced or taken off; only a small image", async () => {
    const s = new Shoes(new MemoryDisk());
    const photo = "data:image/jpeg;base64,/9j/AAAA";
    const id = (await s.put({ name: "Pegasus 41", photo })).shoes[0]!.id;
    expect((await s.put({ id, name: "Pegasus 41", limit_km: 650 })).shoes[0]!.photo).toBe(photo);
    expect((await s.put({ id, name: "Pegasus 41", photo: "" })).shoes[0]!.photo).toBeUndefined();
    await expect(s.put({ id, name: "Pegasus 41", photo: "data:text/html;base64,PGI+" })).rejects.toThrow(/photo/);
    await expect(s.put({ id, name: "Pegasus 41", photo: `data:image/png;base64,${"A".repeat(200_000)}` })).rejects.toThrow(/photo/);
  });
});

describe("shoes from Strava", () => {
  const runs = [
    { ...run("a", "2026-08-01", 10), strava: "1", gear: "g1" },
    { ...run("b", "2026-09-01", 12), strava: "2", gear: "g1" },
    { ...run("c", "2026-10-02", 8), strava: "3", gear: null },
    { ...run("d", "2026-10-03", 21), strava: "4", gear: "g2" },
    run("w", "2026-10-04", 5),
  ];
  test("pairs come in: one with the same name links, others are added with Strava's earlier km", () => {
    const here: ShoeData = { shoes: [{ id: "mine", name: "pegasus 41", since: "2026-10-01", start_km: 0, limit_km: 700 }], assign: {} };
    const r = importStrava(here, [
      { id: "g1", name: "Nike Pegasus 41", nickname: null, distance: 150_000 },
      { id: "g2", name: "Nike Vaporfly 3", nickname: "Race day", distance: 21_000, retired: true },
    ], runs, "2026-10-20");
    expect(r.linked).toEqual(["pegasus 41"]);
    expect(r.added).toEqual(["Race day"]);
    expect(r.data.shoes[0]).toMatchObject({ id: "mine", strava_id: "g1" });
    // Strava's 21 km are all from the one run Tartan has: nothing before. Retired on its last run. A racing shoe.
    expect(r.data.shoes[1]).toMatchObject({ id: "strava-g2", strava_id: "g2", since: "2026-10-03", start_km: 0, retired: "2026-10-03", limit_km: 400 });
    // Again: nothing new; the linked pair takes Strava's km from before Tartan (150 - 22).
    const again = importStrava(r.data, [{ id: "g1", name: "Nike Pegasus 41", distance: 150_000 }, { id: "g2", name: "Nike Vaporfly 3", distance: 21_000, retired: true }], runs);
    expect(again.added).toEqual([]);
    expect(again.data.shoes[0]!.start_km).toBe(128);
  });
  test("a run counts to the pair Strava has on it; the others by date", () => {
    const d: ShoeData = { shoes: [{ id: "p", name: "Pegasus", since: "2026-07-01", start_km: 0, limit_km: 700, strava_id: "g1" }, { id: "v", name: "Vaporfly", since: "2026-10-01", start_km: 0, limit_km: 400, strava_id: "g2" }], assign: { b: "v" } };
    expect(shoeFor(runs[0]!, d)).toBe("p");
    expect(shoeFor(runs[1]!, d)).toBe("v"); // moved by hand wins
    expect(shoeFor(runs[2]!, d)).toBe("p"); // no pair on Strava, an easy day: the daily pair
    // Strava doesn't have Vaporfly on b (moved here), nor Pegasus on c (none): those can be set there.
    expect(toStrava(runs, d, "v").map((r) => r.id)).toEqual(["b"]);
    expect(toStrava(runs, d, "p").map((r) => r.id)).toEqual(["c"]);
  });
  test("racing shoes last less", () => {
    expect(kindFromName("Nike Alphafly 3")).toBe("racing");
    expect(kindFromName("Asics Novablast 5")).toBe("daily");
    expect(kindFromName("Hoka Speedgoat 6")).toBe("trail");
    expect(limitFor("racing")).toBe(400);
    expect(limitFor("trail")).toBe(700);
  });
});

describe("which pair to wear", () => {
  const t = shoeTotals([], {
    shoes: [
      { id: "peg", name: "Pegasus 41", since: "2026-09-01", start_km: 650, limit_km: 700 },
      { id: "nova", name: "Novablast 5", since: "2026-10-01", start_km: 50, limit_km: 700 },
      { id: "vf", name: "Vaporfly 3", since: "2026-08-01", start_km: 100, limit_km: 400 },
    ],
    assign: {},
  });
  test("by the session: racing pair on fast days, the freshest daily pair otherwise", () => {
    expect(sessionNeeds("intervals")).toBe("racing");
    expect(sessionNeeds("long", "Trail long run")).toBe("trail");
    expect(pickShoe("racing", "race", t, "2026-10-20")).toMatchObject({ id: "vf", why: "race day" });
    expect(pickShoe("daily", "easy", t, "2026-10-20")).toMatchObject({ id: "nova" });
    expect(pickShoe("trail", "long", t, "2026-10-20")).toMatchObject({ id: "nova", why: "no trail pair: your daily pair" });
    // One pair in use: nothing to choose.
    expect(pickShoe("racing", "race", t.filter((s) => s.id === "peg"), "2026-10-20")).toBeNull();
  });
  test("a worn pair says where its runs go next", () => {
    expect(switchAdvice(t.find((s) => s.id === "peg")!, t)).toBe("Close to the 700 km you set: start giving your easy and long runs to Novablast 5.");
    expect(switchAdvice({ ...t.find((s) => s.id === "vf")!, km: 410, used: 1.03 }, t)).toMatch(/^Past the 400 km you set: time for a new pair for your races and fast days/);
  });
});
