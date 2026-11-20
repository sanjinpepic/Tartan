import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDisk } from "../src/disk-node.ts";
import { Analytics, weekKey } from "../src/analytics.ts";
import { Library, type ActivityRow } from "../src/library.ts";

const DAY = 86400_000;
let lib: Library;
let an: Analytics;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "tartan-an-"));
  lib = new Library(new NodeDisk(root));
  // 10 weeks of runs, every other day; from the start of last week on, much bigger (a volume
  // jump). The takeaway compares last full week (Monday to Sunday) with the three before, so the
  // jump is placed by the calendar week, not by days ago: the test holds on any weekday.
  const lastWeek = Date.parse(weekKey(Date.now())) - 7 * DAY;
  const index = [];
  for (let i = 0; i < 35; i++) {
    const t = Date.now() - (i * 2 + 0.5) * DAY;
    const big = t >= lastWeek;
    index.push({
      id: 100 + i, name: big ? "Long run" : "Easy run", type: "Run", sport_type: "Run",
      start_date: new Date(t).toISOString(), distance: big ? 24_000 : 8_000, moving_time: big ? 8_400 : 2_880, elapsed_time: big ? 8_600 : 2_950,
      total_elevation_gain: 60, average_speed: big ? 2.86 : 2.78 + i * 0.004, average_heartrate: 138, max_heartrate: 182,
    });
  }
  await lib.strava.write(index, "index.json");
  // One HR stream: 10 minutes at 150 bpm sampled every 1 s.
  const n = 601;
  await lib.strava.write({ time: { data: Array.from({ length: n }, (_, i) => i) }, heartrate: { data: Array(n).fill(150) } }, "streams", "100.json");
  an = new Analytics(lib);
  await an.saveProfile({ max_hr: 190, rest_hr: 50, sex: "M" });
});

test("TRIMP follows Banister's formula", () => {
  const row = { moving_min: 60, avg_hr: 150 } as ActivityRow;
  const hrr = (150 - 50) / (190 - 50);
  expect(an.trimp(row, { max_hr: 190, rest_hr: 50 }).load).toBeCloseTo(60 * hrr * 0.64 * Math.exp(1.92 * hrr), 0);
  expect(an.trimp({ moving_min: 30 } as ActivityRow, { max_hr: 190, rest_hr: 50 })).toEqual({ load: 27, estimated: true });
});

test("fitness, fatigue and form", async () => {
  const { series, today } = await an.load(60);
  expect(series).toHaveLength(61);
  expect(today.fitness).toBeGreaterThan(10);
  expect(today.fatigue).toBeGreaterThan(today.fitness); // the big last week
  const prev = series.at(-2)!;
  expect(today.form).toBeCloseTo(prev.fitness - prev.fatigue, 0);
});

test("heart-rate zones from the single time series", async () => {
  const z = await an.zonesFor("strava:100");
  expect(z!.find((x) => x.zone === 3)!.seconds).toBe(600); // 150/190 = 79% of max
  expect(z!.reduce((n, x) => n + x.seconds, 0)).toBe(600);
});

test("takeaways name the volume jump and the form", async () => {
  const t = await an.takeaways();
  const ids = t.map((x) => x.id);
  expect(ids).toContain("form");
  expect(ids).toContain("volume");
  expect(t.find((x) => x.id === "volume")!.title).toMatch(/up \d+%/);
  expect(t[0]!.tone).toBe("watch"); // warnings sort first
});

test("dashboard bundles everything once", async () => {
  const d = await an.dashboard();
  expect(Object.keys(d).sort()).toEqual(["bests", "days", "efficiency", "load", "profile", "recent", "takeaways", "targets", "totals", "weeks", "zones"]);
  expect(d.recent).toHaveLength(8);
  expect(d.profile).toMatchObject({ max_hr: 190, max_hr_source: "set by you" });
});
