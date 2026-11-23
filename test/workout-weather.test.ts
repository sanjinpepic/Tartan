/** The weather each outdoor workout was done in (src/workout-weather.ts): mapped, kept once, never online in tests. */
import { describe, expect, test } from "bun:test";
import { Analytics } from "../src/analytics.ts";
import { createApi } from "../src/api.ts";
import { MemoryDisk } from "../src/disk.ts";
import type { FitWorkout } from "../src/fit-write.ts";
import { importWorkout } from "../src/import.ts";
import { Library } from "../src/library.ts";
import { seedSample } from "../src/sample.ts";
import { LocalStore } from "../src/store.ts";
import type { Hour } from "../src/weather.ts";
import { notableWords, outdoor, skyOf, weatherAt, withForecast, withWeather, WorkoutWeathers, type Limiter } from "../src/workout-weather.ts";
import { DEFAULT_PREFS } from "../src/schedule.ts";

const HOUR = 3_600_000;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

/** A run (or another sport) around a small loop near 60.19, 24.90, starting at `start`. */
function workout(start: number, sport = "running", gps = true): FitWorkout {
  const samples = Array.from({ length: 120 }, (_, i) => ({ t: start + i * 10_000, ...(gps ? { lat: 60.1949 + i * 1e-5, lon: 24.9051 } : {}), hr: 140, speed: 3, distance: i * 30 }));
  return { start, end: start + 1200_000, sport, distance_m: 3600, samples };
}

async function library(list: Array<[string, FitWorkout]>): Promise<Library> {
  const disk = new MemoryDisk();
  const store = new LocalStore(disk);
  for (const [name, w] of list) await importWorkout(store, { id: "test", name: "Test" }, name, w);
  return new Library(disk);
}

/** Open-Meteo's answer for the days asked, every hour 4 °C, light rain, 18 km/h, feels 0 °C. */
function answer(url: string, over: (time: string) => Partial<Record<string, number>> = () => ({})) {
  const q = new URL(url).searchParams;
  const from = Date.parse(`${q.get("start_date")}T00:00:00Z`);
  const to = Date.parse(`${q.get("end_date")}T23:00:00Z`);
  const time: string[] = [];
  for (let t = from; t <= to; t += HOUR) time.push(new Date(t).toISOString().slice(0, 16));
  const col = (k: string, v: number) => time.map((t) => over(t)[k] ?? v);
  return json({ hourly: { time, temperature_2m: col("t", 4), dew_point_2m: col("d", 2), apparent_temperature: col("f", 0), weather_code: col("code", 61), wind_speed_10m: col("wind", 18), precipitation: col("mm", 0.4), is_day: col("day", 0) } });
}

const fresh = (): Limiter => ({ sent: [], failedAt: -Infinity });

describe("the weather in words", () => {
  test("weather codes as a sky word and words; what fell when there's no code", () => {
    expect(skyOf({ code: 0 })).toEqual(["clear", "Clear"]);
    expect(skyOf({ code: 3 })).toEqual(["cloudy", "Overcast"]);
    // As heavy as the swap nudge says: a "rain" code with 2 mm or more in the hour.
    expect(skyOf({ code: 63, rain_mm: 3 })).toEqual(["rain", "Heavy rain"]);
    expect(skyOf({ code: 63, rain_mm: 0.5 })).toEqual(["rain", "Rain"]);
    expect(skyOf({ code: 61 })).toEqual(["rain", "Light rain"]);
    expect(skyOf({ code: 75 })).toEqual(["snow", "Heavy snow"]);
    expect(skyOf({ code: 45 })).toEqual(["fog", "Fog"]);
    expect(skyOf({ code: 95 })).toEqual(["storm", "Thunderstorm"]);
    expect(skyOf({ snow_cm: 0.4 })[0]).toBe("snow");
    expect(skyOf({ rain_mm: 1 })[0]).toBe("rain");
  });

  test("the hour nearest the start, with feels-like, wind and what made it notable", () => {
    const hours: Hour[] = [
      { time: "2026-07-10T17:00", temp_c: 27.96, dew_c: 21, feels_c: 31.04, wind_kmh: 9.4, code: 1, day: true },
      { time: "2026-07-10T18:00", temp_c: 26, dew_c: 21, wind_kmh: 8, code: 1, day: true },
    ];
    // 17:20 is nearest 17:00.
    const w = weatherAt(hours, Date.parse("2026-07-10T17:20:00Z"), "start")!;
    expect(w).toEqual({ temp_c: 28, feels_c: 31, condition: "clear", sky: "Mostly clear", wind_kmh: 9, day: true, flags: ["heat"], where: "start" });
    expect(weatherAt(hours, Date.parse("2026-07-11T09:00:00Z"), "start")).toBeNull();
    const icy: Hour[] = [{ time: "2026-01-10T07:00", temp_c: -1, dew_c: -2, code: 71, wind_kmh: 34 }];
    expect(weatherAt(icy, Date.parse("2026-01-10T07:00:00Z"), "usual")!.flags).toEqual(["ice", "wind"]);
  });

  test("outdoors: runs, rides, walks, hikes; not the treadmill, a trainer, a pool or the gym", () => {
    for (const sport of ["Run", "TrailRun", "running", "Ride", "MountainBikeRide", "Walk", "Hike", "OpenWaterSwim"]) expect(outdoor({ sport })).toBe(true);
    for (const sport of ["Treadmill", "VirtualRide", "VirtualRun", "Swim", "swimming", "Pool swim", "WeightTraining", "training", "Yoga", "Elliptical"]) expect(outdoor({ sport })).toBe(false);
  });

  test("against last time, the heat, snow or wind once, only when it says something", () => {
    const hot = { temp_c: 28, condition: "clear" as const, sky: "Clear", flags: ["heat" as const], where: "start" as const };
    const harder = { verdict: "harder", text: "12 s/km slower at 4 bpm higher: 5% less distance per heartbeat. Fatigue, heat or a short night can do this." };
    expect(withWeather(harder, hot).text).toBe("12 s/km slower at 4 bpm higher: 5% less distance per heartbeat, in 28° heat: that explains much of it.");
    expect(withWeather({ verdict: "fitter", text: "The same pace at 5 bpm lower: 4% more distance per heartbeat. Fitter." }, hot).text).toBe("The same pace at 5 bpm lower: 4% more distance per heartbeat. Fitter. In 28° heat, too.");
    expect(withWeather(harder, { ...hot, flags: [] }).text).toBe(harder.text);
    expect(withWeather(harder, null)).toBe(harder);
    expect(notableWords({ ...hot, temp_c: 3, wind_kmh: 34, flags: ["wind"] })).toBe("in a 34 km/h wind");
  });
});

describe("fetched lazily and kept for good", () => {
  const day = Date.parse("2026-11-16T00:00:00Z");

  test("one request covers the month at one place; kept once per workout, never asked again", async () => {
    const lib = await library([
      ["a", workout(day + 7.5 * HOUR)],
      ["b", workout(day + 2 * 86_400_000 + 17.5 * HOUR)],
      ["c", workout(day + 3 * 86_400_000 + 17.5 * HOUR, "cycling")],
    ]);
    const urls: string[] = [];
    let added = 0;
    const ww = new WorkoutWeathers(lib, { fetch: async (u) => (urls.push(u), answer(u)), added: () => added++, limiter: fresh(), clock: () => 1e12 });
    const rows = await lib.activities();
    expect((await ww.attach(rows)).some((r) => r.weather)).toBe(false);
    expect(await ww.fill()).toBe(3);
    expect(urls).toHaveLength(1);
    // Rounded to about a kilometre; in UTC, from the day before the first.
    expect(urls[0]).toContain("latitude=60.19&longitude=24.91");
    expect(urls[0]).toContain("start_date=2026-11-15&end_date=2026-11-19");
    expect(urls[0]).toContain("apparent_temperature");
    expect(urls[0]).toContain("timezone=GMT");
    expect(added).toBe(1);
    const shown = await ww.attach(rows);
    expect(shown.every((r) => r.weather)).toBe(true);
    expect(shown[0]!.weather).toEqual({ temp_c: 4, feels_c: 0, condition: "rain", sky: "Light rain", wind_kmh: 18, day: false, flags: [], where: "start" });
    // Kept: nothing more is asked, by this or a new one (the file).
    expect(await ww.fill()).toBe(0);
    expect(await new WorkoutWeathers(lib, { fetch: async (u) => (urls.push(u), answer(u)), limiter: fresh() }).fill()).toBe(0);
    expect(urls).toHaveLength(1);
    expect(await ww.of(rows[0]!.id)).toMatchObject({ temp_c: 4 });
  });

  test("indoors, the gym and a run told without its time are never asked about", async () => {
    const lib = await library([
      ["gym", workout(day + 8 * HOUR, "training", false)],
      ["pool", workout(day + 9 * HOUR, "swimming", false)],
    ]);
    await lib.logged.add({ date: "2026-11-17", sport: "Run", name: "Run", minutes: 30 });
    await lib.logged.add({ date: "2026-11-17", time: "12:00", sport: "Treadmill", name: "Treadmill", minutes: 30 });
    lib.invalidate();
    const urls: string[] = [];
    const ww = new WorkoutWeathers(lib, { fetch: async (u) => (urls.push(u), answer(u)), limiter: fresh(), clock: () => 1e12 });
    // The told run is settled as none (no hour to look at); nothing else qualifies.
    expect(await ww.fill()).toBe(1);
    expect(urls).toHaveLength(0);
    expect((await ww.attach(await lib.activities())).some((r) => r.weather)).toBe(false);
  });

  test("offline: nothing shown, nothing kept, tried again a few minutes on", async () => {
    const lib = await library([["a", workout(day + 7.5 * HOUR)]]);
    let now = 1e12;
    let online = false;
    let added = 0;
    const urls: string[] = [];
    const ww = new WorkoutWeathers(lib, {
      fetch: async (u) => {
        urls.push(u);
        if (!online) throw new TypeError("Failed to fetch");
        return answer(u);
      },
      added: () => added++,
      limiter: fresh(),
      clock: () => now,
    });
    expect(await ww.fill()).toBe(0);
    expect(await ww.of((await lib.activities())[0]!.id)).toBeNull();
    expect((await ww.attach(await lib.activities()))[0]!.weather).toBeUndefined();
    expect(await lib.disk.stat("cache/workout-weather.json")).toBeNull();
    online = true;
    now += 60_000;
    expect(await ww.fill()).toBe(0); // still waiting after the failure
    expect(urls).toHaveLength(1);
    now += 5 * 60_000;
    expect(await ww.fill()).toBe(1);
    expect(added).toBe(1);
  });

  test("a few requests a minute at most; too long ago is kept as none", async () => {
    // Three places far apart: one request each.
    const far = (lat: number, start: number): FitWorkout => ({ ...workout(start), samples: workout(start).samples.map((s) => ({ ...s, lat })) });
    const lib = await library([
      ["a", far(60.2, day + 8 * HOUR)],
      ["b", far(61.5, day + 9 * HOUR)],
      ["c", far(62.5, day + 10 * HOUR)],
      ["d", far(63.5, day + 11 * HOUR)],
    ]);
    let now = 1e12;
    const urls: string[] = [];
    const ww = new WorkoutWeathers(lib, { fetch: async (u) => (urls.push(u), u.includes("latitude=63.5") ? json({ error: true, reason: "out of range" }, 400) : answer(u)), limiter: fresh(), clock: () => now });
    expect(await ww.fill()).toBe(3);
    expect(urls).toHaveLength(3);
    now += 61_000;
    expect(await ww.fill()).toBe(1);
    expect(urls).toHaveLength(4);
    const shown = await ww.attach(await lib.activities());
    expect(shown.filter((r) => r.weather)).toHaveLength(3);
    // The one the service has nothing for isn't asked again.
    now += 61_000;
    expect(await ww.fill()).toBe(0);
    expect(urls).toHaveLength(4);
  });

  test("the sample carries weather of its own, the same every time, with no request", async () => {
    const disk = new MemoryDisk();
    await seedSample(new LocalStore(disk), disk, Date.parse("2026-11-22T09:00:00Z"));
    const lib = new Library(disk);
    const urls: string[] = [];
    const ww = new WorkoutWeathers(lib, { fetch: async (u) => (urls.push(u), answer(u)), limiter: fresh() });
    const rows = await ww.attach(await lib.activities());
    expect(await ww.fill()).toBe(0);
    expect(urls).toHaveLength(0);
    const runs = rows.filter((r) => /run/i.test(r.sport));
    expect(runs.every((r) => r.weather)).toBe(true);
    expect(rows.filter((r) => !/run/i.test(r.sport)).some((r) => r.weather)).toBe(false);
    expect(runs[0]!.weather).toMatchObject({ temp_c: 4, feels_c: 0, sky: "Light rain", wind_kmh: 18 });
    expect(runs[1]!.weather).toMatchObject({ wind_kmh: 32 });
  });
});

describe("on the API", () => {
  test("the list and the sheet carry kept weather; a workout told to the coach can be taken back", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    const library = new Library(disk);
    const api = createApi({ store, library, analytics: new Analytics(library) } as unknown as Parameters<typeof createApi>[0]);
    const told = await library.logged.add({ date: "2026-11-17", time: "07:00", sport: "Swim", name: "Swim", minutes: 30 });
    library.invalidate();
    const call = async (path: string, method = "GET") => (await api.handle(new Request(`http://x${path}`, { method })))!;
    const rows = (await (await call("/api/library/activities")).json()) as Array<{ id: string; sources: string[] }>;
    expect(rows).toHaveLength(1);
    // A recorded workout isn't removed this way.
    await importWorkout(store, { id: "t", name: "T" }, "run", workout(Date.parse("2026-11-16T07:00:00Z")));
    library.invalidate();
    const run = (await library.activities()).find((r) => !r.sources.includes("logged"))!;
    expect((await call(`/api/logged/${encodeURIComponent(run.id)}`, "DELETE")).status).toBe(409);
    // By the workout's own id.
    const res = await call(`/api/logged/${encodeURIComponent(rows[0]!.id)}`, "DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(await library.logged.all()).toEqual([]);
    expect((await call(`/api/logged/${told.id}`, "DELETE")).status).toBe(404);
  });
});

describe("the forecast on planned sessions", () => {
  /** Local hours over three days: 4 °C, light rain, 18 km/h, feels 0 °C (Wednesday 21 to Friday 23 October 2026). */
  const hours: Hour[] = ["2026-10-21", "2026-10-22", "2026-10-23"].flatMap((d) =>
    Array.from({ length: 24 }, (_, h) => ({ time: `${d}T${String(h).padStart(2, "0")}:00`, temp_c: 4.04, dew_c: 2, feels_c: 0.2, wind_kmh: 18.4, code: 61, rain_mm: 0.4, day: h >= 8 && h < 17 })),
  );
  type S = { kind: string; title: string; status: string; target?: string; swap_to?: string; weather?: unknown };
  const day = (date: string, ...sessions: S[]) => ({ date, sessions });
  const weeks = [
    {
      days: [
        day("2026-10-20", { kind: "easy", title: "Easy run", status: "missed" }),
        day("2026-10-21", { kind: "easy", title: "Easy run", status: "today" }, { kind: "strength", title: "Strength", status: "today" }),
        day("2026-10-22", { kind: "long", title: "Long run", status: "planned" }, { kind: "swim", title: "Easy swim", status: "planned" }),
        day("2026-10-23", { kind: "easy", title: "Easy run", status: "planned", swap_to: "treadmill" }, { kind: "rest", title: "Rest", status: "rest" }),
        day("2026-10-24", { kind: "long", title: "Long run", status: "planned" }),
      ],
    },
  ];
  // The same answer whatever the time of day: it reads only the plan's dates and your training times.
  const out = withForecast(weeks, { ...DEFAULT_PREFS, weekday: "17:00", weekend: "09:00" }, "2026-10-21", hours);
  const at = (d: number, n: number) => out[0]!.days[d]!.sessions[n]!.weather;

  test("a run ahead gets the hour it's planned for, in the workout's own words", () => {
    expect(at(1, 0)).toEqual({ temp_c: 4, feels_c: 0.2, condition: "rain", sky: "Light rain", wind_kmh: 18, day: false, at: "17:00" });
    expect(at(2, 0)).toMatchObject({ sky: "Light rain", at: "17:00" });
  });

  test("none for the past, indoors, the treadmill, rest, or beyond the forecast", () => {
    expect(at(0, 0)).toBeUndefined();
    expect(at(1, 1)).toBeUndefined();
    expect(at(2, 1)).toBeUndefined();
    expect(at(3, 0)).toBeUndefined();
    expect(at(3, 1)).toBeUndefined();
    expect(at(4, 0)).toBeUndefined();
  });

  test("no forecast (offline): the plan as it was", () => {
    expect(withForecast(weeks, DEFAULT_PREFS, "2026-10-21", [])).toBe(weeks);
  });
});

describe("the forecast in the plan's payload", () => {
  test("the demo's pinned rainy week: each outdoor session ahead carries its weather, indoor ones none (no network)", async () => {
    const disk = new MemoryDisk();
    const store = new LocalStore(disk);
    await seedSample(store, disk, Date.now());
    const library = new Library(disk);
    const coach = { status: async () => ({ ready: false }) };
    const api = createApi({ store, library, analytics: new Analytics(library), coach } as unknown as Parameters<typeof createApi>[0]);
    const call = async (path: string, method = "GET", body?: unknown) => (await api.handle(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })))!;
    expect((await call("/api/plan/basic", "POST", {})).status).toBe(200);
    expect((await call("/api/sample/rain", "POST", {})).status).toBe(200);
    type Ses = { kind: string; title: string; status: string; weather?: { sky: string; condition: string; wind_kmh?: number; temp_c: number; at: string } };
    const plan = (await (await call("/api/plan")).json()) as { today: string; weeks: Array<{ days: Array<{ date: string; sessions: Ses[] }> }> };
    const ahead = plan.weeks.flatMap((w) => w.days).filter((d) => d.date >= plan.today).flatMap((d) => d.sessions);
    const outdoors = ahead.filter((s) => ["easy", "long", "recovery", "tempo", "intervals", "hills"].includes(s.kind) && s.status !== "done");
    expect(outdoors.length).toBeGreaterThan(0);
    for (const s of outdoors.slice(0, 3)) expect(s.weather).toMatchObject({ condition: "rain", sky: "Heavy rain", wind_kmh: 40, temp_c: 9 });
    expect(outdoors[0]!.weather!.at).toMatch(/^\d\d:\d\d$/);
    for (const s of ahead.filter((x) => ["strength", "swim", "rest"].includes(x.kind))) expect(s.weather).toBeUndefined();
    // Taken off, the forecast is gone with it, and the plan reads as before.
    await call("/api/sample/rain", "POST", { off: true });
  });
});
