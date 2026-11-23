import { describe, expect, test } from "bun:test";
import { brandOf, companiesOf, GARMIN_COMPANY, pickWatch, SUUNTO_COMPANY, usesGarmin, usesSuunto, type FoundWatch } from "../src/transport/brand.ts";
import { garminKey, garminMessage, garminSteps, garminSummary } from "../src/workout/garmin.ts";
import { plannedWeek, workoutFor } from "../src/workout/from-plan.ts";
import type { Workout } from "../src/workout/guide.ts";

describe("which watch: the brand", () => {
  test("by the company id in the manufacturer data", () => {
    expect(GARMIN_COMPANY).toBe(0x0087);
    expect(SUUNTO_COMPANY).toBe(0x009f);
    expect(brandOf({ companies: [0x0087] })).toBe("garmin");
    expect(brandOf({ companies: [0x009f] })).toBe("suunto");
    // The company id wins over a name that says otherwise.
    expect(brandOf({ companies: [0x009f], name: "Forerunner 265" })).toBe("suunto");
    expect(brandOf({ companies: [0x0087], name: "Suunto Run 2" })).toBe("garmin");
    // Another company (Apple 0x004C, Polar 0x006B): not a watch Tartan knows by its id.
    expect(brandOf({ companies: [0x004c] })).toBeNull();
  });

  test("by the advertised name when the data says nothing", () => {
    for (const n of ["Forerunner 265", "Forerunner 965", "fenix 7", "fēnix 8 - 47mm", "Venu 3", "vívoactive 5", "Instinct 2", "epix Pro", "Enduro 3", "Garmin Watch"]) expect(brandOf({ name: n })).toBe("garmin");
    for (const n of ["Suunto Run 2 1234", "SUUNTO 9 PEAK", "Suunto Race"]) expect(brandOf({ name: n })).toBe("suunto");
    for (const n of ["Pixel Buds", "Polar H10 1234", "Apple Watch", "", "Venus speaker"]) expect(brandOf({ name: n })).toBeNull();
    expect(brandOf({})).toBeNull();
  });

  test("company ids from a scan result's manufacturer data", () => {
    expect(companiesOf({ "135": new DataView(new ArrayBuffer(2)) })).toEqual([0x0087]);
    expect(companiesOf({ "0x009F": 1 })).toEqual([0x009f]);
    expect(companiesOf({ nope: 1 })).toEqual([]);
    expect(companiesOf(undefined)).toEqual([]);
  });

  test("one watch out of what was found", () => {
    const suunto: FoundWatch = { brand: "suunto", name: "Suunto Run 2", id: "AA:BB", via: "nearby", rssi: -50 };
    const garmin: FoundWatch = { brand: "garmin", name: "Forerunner 265", id: "CC:DD", via: "nearby", rssi: -70 };
    // The strongest nearby watch decides.
    expect(pickWatch([garmin, suunto], [], null)).toEqual(suunto);
    // A Garmin nearby goes the Garmin Connect way when Garmin Connect knows a watch.
    expect(pickWatch([garmin], [{ id: "123", name: "Forerunner 265 (Sam)", connected: true }], null)).toEqual({ brand: "garmin", name: "Forerunner 265 (Sam)", id: "123", via: "garmin-connect" });
    // Nothing nearby: Garmin Connect's connected watch, before a merely known one.
    expect(pickWatch([], [{ id: "1", name: "fenix 7" }, { id: "2", name: "Forerunner 965", connected: true }], null)?.name).toBe("Forerunner 965");
    // Nothing else: the Suunto this phone has paired.
    const paired: FoundWatch = { brand: "suunto", name: "Suunto Race", id: "EE", via: "paired" };
    expect(pickWatch([], [], paired)).toEqual(paired);
    expect(pickWatch([], [], null)).toBeNull();
  });

  test("a Suunto never goes the Garmin way, and a Garmin never the Suunto way", () => {
    expect(usesSuunto("suunto")).toBe(true);
    expect(usesGarmin("suunto")).toBe(false);
    expect(usesSuunto("garmin")).toBe(false);
    expect(usesGarmin("garmin")).toBe(true);
    // Before any watch is set (everyone who had a Suunto before brands): the Suunto way, as it always was.
    expect(usesSuunto(null)).toBe(true);
    expect(usesGarmin(null)).toBe(false);
  });
});

describe("the plan for the Garmin watch app", () => {
  const intervals: Workout = {
    name: "Tue Intervals",
    blocks: [
      { kind: "warmup", duration_s: 900, hr: [120, 140] },
      { repeat: 6, steps: [{ kind: "run", distance_m: 800, pace: [230, 240] }, { kind: "recover", duration_s: 90 }] },
      { kind: "cooldown", duration_s: 600 },
    ],
  };

  test("steps written out, each with its label, length and target", () => {
    const s = garminSteps(intervals);
    expect(s.length).toBe(1 + 12 + 1);
    expect(s[0]).toEqual({ k: "warmup", l: "Warm up", t: 900, h: [120, 140] });
    expect(s[1]).toEqual({ k: "run", l: "Rep 1 of 6", d: 800, p: [230, 240] });
    expect(s[2]).toEqual({ k: "recover", l: "Recover", t: 90 });
    expect(s[11]).toEqual({ k: "run", l: "Rep 6 of 6", d: 800, p: [230, 240] });
    expect(s[13]).toEqual({ k: "cooldown", l: "Cool down", t: 600 });
    expect(garminSummary(intervals)).toBe("6 x 800 m");
  });

  test("a speed target as its pace, a reminder as a note, a plain run's summary", () => {
    const w: Workout = { name: "Sun Long", blocks: [{ kind: "run", duration_s: 1800, speed: [10, 12] }, { kind: "run", duration_s: 1800, note: { title: "Fuel", text: "Gel and a drink" }, speed: [10, 12] }] };
    const s = garminSteps(w);
    expect(s[0]!.p).toEqual([300, 360]);
    expect(s[1]!.n).toBe("Fuel: Gel and a drink");
    expect(garminSummary(w)).toBe("1 h");
    expect(garminSummary({ name: "x", blocks: [{ kind: "run", distance_m: 12000 }] })).toBe("12 km");
    expect(garminSummary({ name: "x", blocks: [{ kind: "run", duration_s: 2700 }] })).toBe("45 min");
  });

  test("from the plan's coming week: today first, the title without its weekday, the sport", () => {
    const v = {
      today: "2026-11-23",
      plan: { zones: [{ name: "Z2 easy", heart_rate: "135-148" }] },
      weeks: [{ days: [
        { date: "2026-11-22", sessions: [{ date: "2026-11-22", kind: "easy", title: "Easy run", duration_min: 40, status: "done" }] },
        { date: "2026-11-23", sessions: [{ date: "2026-11-23", kind: "easy", title: "Monday Easy Run", duration_min: 45 }] },
        { date: "2026-11-24", sessions: [{ date: "2026-11-24", kind: "rest", title: "Rest" }] },
        { date: "2026-11-25", sessions: [{ date: "2026-11-25", kind: "strength", title: "Strength", duration_min: 30 }] },
      ] }],
    };
    const m = garminMessage(plannedWeek(v), v.today);
    expect(m.v).toBe(1);
    expect(m.made).toBe("2026-11-23");
    expect(m.days.map((d) => d.date)).toEqual(["2026-11-23", "2026-11-25"]);
    expect(m.days[0]).toMatchObject({ title: "Easy Run", sport: "running", sum: "45 min" });
    expect(m.days[0]!.steps).toEqual([{ k: "run", l: "Run", t: 2700, h: [135, 148] }]);
    expect(m.days[1]!.sport).toBe("strength");
    // Every word the watch shows is plain ASCII, and the whole message stays small.
    expect(JSON.stringify(m)).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.stringify(m).length).toBeLessThan(4000);
    expect(garminKey(m)).toBe(garminKey(garminMessage(plannedWeek(v), v.today)));
    expect(garminKey(m)).not.toBe(garminKey({ ...m, days: m.days.slice(1) }));
  });

  test("the same workout a Suunto gets", () => {
    const r = workoutFor({ date: "2026-11-24", kind: "intervals", title: "Intervals", steps: [{ repeat: 4, steps: [{ kind: "run", duration_s: 180, pace: [240, 250] }, { kind: "recover", duration_s: 120 }] }] });
    if (!("workout" in r)) throw new Error(r.reason);
    expect(garminSteps(r.workout).map((s) => s.l)).toEqual(["Rep 1 of 4", "Recover", "Rep 2 of 4", "Recover", "Rep 3 of 4", "Recover", "Rep 4 of 4", "Recover"]);
  });
});
