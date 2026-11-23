/**
 * The Garmin daily signals feed: what the phone puts into the body signals from Tartan's Garmin
 * watch app (garmin/source/Body.mc → GarminLink → the engine's signalsPut, PUT /api/signals).
 * test/fixtures/garmin-day.json is the watch's message and the arguments the phone makes of it; the
 * Android GarminTest checks the phone side against the same file.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MemoryDisk } from "../src/disk.ts";
import { Signals, SIGNAL_FIELDS, type SignalDay, type SignalPut } from "../src/signals.ts";
import { Library } from "../src/library.ts";
import { LocalStore } from "../src/store.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/garmin-day.json", import.meta.url), "utf8")) as {
  today: string;
  watch: { t: string; days: Array<Record<string, unknown>> };
  put: { days: SignalPut[] };
};

/** What Connect IQ gives a watch app: the fields the watch may send, and those it never does. */
const FROM_THE_WATCH = ["energy", "stress", "recovery_h", "breathing_rate", "resting_hr", "vo2max", "night_hr_min", "spo2_max"];

test("the phone's arguments are the watch's days as they came, each as \"garmin\"", () => {
  expect(fixture.put.days.map((d) => d.date)).toEqual(fixture.watch.days.map((d) => d.date as string));
  for (const [i, d] of fixture.put.days.entries()) {
    const { source, ...rest } = d;
    expect(source).toBe("garmin");
    expect(rest).toEqual(fixture.watch.days[i] as typeof rest);
    // Only signals the layer knows, and only ones the watch can measure: no sleep stages, no HRV.
    for (const k of Object.keys(rest)) if (k !== "date") expect(FROM_THE_WATCH).toContain(k);
  }
  for (const k of FROM_THE_WATCH) expect(SIGNAL_FIELDS).toContain(k as (typeof SIGNAL_FIELDS)[number]);
});

test("the watch's day through signalsPut: everything kept, each value from the Garmin, the Garmin the watch", async () => {
  const { createApi } = await import("../src/api.ts");
  const { Analytics } = await import("../src/analytics.ts");
  const disk = new MemoryDisk();
  const store = new LocalStore(disk);
  const library = new Library(disk);
  const api = createApi({ store, library, analytics: new Analytics(library) } as unknown as Parameters<typeof createApi>[0]);
  const call = async (path: string, init?: RequestInit) => (await api.handle(new Request(`http://x${path}`, init)))!;
  // web/lib/shell.ts signalsPut: the phone's arguments, as a PUT without "replace".
  const put = async () =>
    (await (await call("/api/signals", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ days: fixture.put.days, replace: false }) })).json()) as { days: SignalDay[]; dropped: string[] };
  const first = await put();
  expect(first.dropped).toEqual([]);
  const today = first.days.find((d) => d.date === fixture.today)!;
  expect(today).toMatchObject({ energy: 64, stress: 31, recovery_h: 18, breathing_rate: 14.2, resting_hr: 48, vo2max: 54, night_hr_min: 44, spo2_max: 98 });
  for (const k of FROM_THE_WATCH) expect(today.from[k as keyof typeof today.from]).toBe("garmin");
  const s = new Signals(disk);
  expect(await s.watch()).toBe("garmin");
  expect(Object.keys(await s.from("garmin")).sort()).toEqual(["2026-11-22", "2026-11-23"]);
  // The watch sends again every half hour: the same day writes nothing.
  const before = disk.files.get("health/signals.json")!.mtime;
  await new Promise((r) => setTimeout(r, 5));
  expect((await put()).dropped).toEqual([]);
  expect(disk.files.get("health/signals.json")!.mtime).toBe(before);
});

test("the Garmin's day leaves the night's stages and HRV to the sources that have them", async () => {
  const s = new Signals(new MemoryDisk());
  await s.put([{ date: "2026-11-23", source: "health_connect", sleep_min: 431, deep_min: 72, light_min: 270, rem_min: 89, hrv_ms: 52, resting_hr: 51 }]);
  const { days } = await s.put(fixture.put.days.filter((d) => d.date === "2026-11-23"));
  expect(days[0]).toMatchObject({ sleep_min: 431, deep_min: 72, hrv_ms: 52, resting_hr: 48, energy: 64 });
  expect(days[0]!.from).toMatchObject({ sleep_min: "health_connect", hrv_ms: "health_connect", resting_hr: "garmin", energy: "garmin" });
  // A later message with a field missing (not measured yet) keeps what came before.
  await s.put([{ date: "2026-11-23", source: "garmin", stress: 33 }]);
  expect((await s.day("2026-11-23")).day).toMatchObject({ stress: 33, energy: 64, spo2_max: 98 });
});

test("what the engine refuses from a garbled Garmin day, should one get past the phone", async () => {
  const s = new Signals(new MemoryDisk());
  const r = await s.put([{ date: "2026-11-23", source: "garmin", energy: 140, stress: -3, resting_hr: "48" as unknown as number, vo2max: 54 }]);
  expect(r.dropped.sort()).toEqual(["2026-11-23 energy", "2026-11-23 resting_hr", "2026-11-23 stress"]);
  expect(r.days[0]).toMatchObject({ vo2max: 54 });
});
