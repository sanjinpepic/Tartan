import { describe, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import type { Slot } from "../src/schedule.ts";
import { forSessions, heat, Weather, type Hour } from "../src/weather.ts";

const slot = (date: string, time: string, kind: string): Slot => ({ key: `${date}:${kind}`, date, kind, title: kind, start: `${date}T${time}`, end: `${date}T${time}`, minutes: 45, summary: kind });

/** A summer day: 14 °C at 05:00 rising to 30 °C at 17:00, a humid 20 °C dew point. */
const day = (date: string): Hour[] =>
  Array.from({ length: 24 }, (_, h) => ({ time: `${date}T${String(h).padStart(2, "0")}:00`, temp_c: h < 5 ? 14 : Math.min(30, 14 + (h - 5) * 1.4), dew_c: 20, rain_pct: h === 18 ? 70 : 10, wind_kmh: 8 }));

describe("heat", () => {
  test("temperature plus dew point in °F, as runners read it", () => {
    expect(heat(10, 5)).toEqual({ sum_f: 91, slow_pct: null, too_hot: false });
    expect(heat(22, 15).sum_f).toBe(131);
    expect(heat(22, 15).slow_pct).toEqual([2, 3]);
    expect(heat(27, 18)).toEqual({ sum_f: 145, slow_pct: [3, 4.5], too_hot: false });
    expect(heat(35, 26).slow_pct).toEqual([8, 10]);
    expect(heat(38, 28)).toMatchObject({ sum_f: 183, too_hot: true });
  });
});

describe("weather at the sessions", () => {
  test("a hot evening tempo: what it costs, go by effort, and the cooler morning", () => {
    const [w] = forSessions(day("2026-07-10"), [slot("2026-07-10", "18:00", "tempo")], "2026-07-10T06:00");
    expect(w!.temp_c).toBe(30);
    expect(w!.heat.too_hot).toBe(false);
    expect(w!.cooler).toEqual({ time: "07:00", temp_c: 16.8, dew_c: 20 });
    expect(w!.note).toBe("30 °C, dew point 20 °C, 70% chance of rain. Heat: about 4.5–6% slower for the same effort; go by effort, not pace. Cooler at 07:00 (17 °C).");
  });

  test("a mild easy run says only the temperature; strength and sessions past the forecast are left out", () => {
    const mild = day("2026-10-01").map((h) => ({ ...h, temp_c: 9, dew_c: 4, rain_pct: 0 }));
    const out = forSessions(mild, [slot("2026-10-01", "18:00", "easy"), slot("2026-10-01", "12:00", "strength"), slot("2026-10-20", "18:00", "easy")], "2026-10-01T06:00");
    expect(out).toHaveLength(1);
    expect(out[0]!.note).toBe("9 °C.");
  });

  test("no cooler hour offered once it has passed", () => {
    const [w] = forSessions(day("2026-07-10"), [slot("2026-07-10", "18:00", "long")], "2026-07-10T16:30");
    expect(w!.cooler).toBeUndefined();
  });
});

describe("the forecast, fetched and kept an hour", () => {
  const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  const reply = { hourly: { time: ["2026-07-10T18:00", "2026-07-10T19:00"], temperature_2m: [30, null], dew_point_2m: [20, 19], precipitation_probability: [70, 10], wind_speed_10m: [8, 9] } };

  test("where you run, from the last place known; one request an hour; a bad answer says so", async () => {
    const disk = new MemoryDisk();
    await disk.write("cache/weather.json", JSON.stringify({ at: { lat: 60.17, lon: 24.94 } }));
    const urls: string[] = [];
    const w = new Weather(new Library(disk), async (u) => (urls.push(u), json(reply)));
    const f = await w.forecast(1_000_000);
    expect(f!.where).toEqual({ lat: 60.17, lon: 24.94 });
    expect(f!.hours).toEqual([{ time: "2026-07-10T18:00", temp_c: 30, dew_c: 20, rain_pct: 70, wind_kmh: 8 }]);
    expect(urls[0]).toContain("latitude=60.17&longitude=24.94");
    expect(urls[0]).toContain("timezone=auto");
    await w.forecast(1_000_000 + 30 * 60_000);
    expect(urls).toHaveLength(1);
    await w.forecast(1_000_000 + 61 * 60_000);
    expect(urls).toHaveLength(2);

    const broken = new Weather(new Library(new MemoryDisk()), async () => json({}));
    expect(await broken.forecast()).toBeNull(); // nowhere known yet: no request at all
    await disk.write("cache/weather.json", JSON.stringify({ at: { lat: 1, lon: 2 } }));
    await expect(new Weather(new Library(disk), async () => json({ error: true })).forecast()).rejects.toThrow(/without hourly temperatures/);
  });
});
