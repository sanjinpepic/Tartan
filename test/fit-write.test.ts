/** A FIT file written by Tartan reads back as the workout it was made from. */
import { expect, test } from "bun:test";
import { parseFit } from "../src/fit.ts";
import { fillTotals, writeFit } from "../src/fit-write.ts";

test("written and read back: session totals and every sample", () => {
  const t0 = Date.parse("2026-11-08T07:30:00Z");
  const samples = Array.from({ length: 61 }, (_, i) => ({ t: t0 + i * 10_000, lat: 60.17 + i * 0.0001, lon: 24.94 - i * 0.00005, altitude: 10 + (i % 7), hr: 120 + (i % 30), cadence: 85, speed: 3.1, power: i === 5 ? undefined : 250 }));
  const w = fillTotals({ start: t0, end: t0 + 600_000, sport: "running", calories: 210, samples });
  expect(w.distance_m).toBeGreaterThan(600);
  expect(w.max_hr).toBe(149);
  const fit = parseFit(writeFit(w));
  expect(fit.sport).toBe("running");
  expect(fit.startTime).toBe("2026-11-08T07:30:00.000Z");
  expect(fit.session).toMatchObject({ total_elapsed_time: 600, total_timer_time: 600, total_calories: 210, max_heart_rate: 149 });
  expect(Math.abs(Number(fit.session!.total_distance) - w.distance_m!)).toBeLessThan(0.02);
  expect(fit.records).toHaveLength(61);
  const r = fit.records[10]!;
  expect(r.time).toBe("2026-11-08T07:31:40.000Z");
  expect(r.lat).toBeCloseTo(60.171, 5);
  expect(r.lon).toBeCloseTo(24.9395, 5);
  expect(r).toMatchObject({ altitude: 13, heartRate: 130, cadence: 85, speed: 3.1, power: 250 });
  expect(fit.records[5]!.power).toBeUndefined();
});

test("a workout without a route or samples still reads back (treadmill, gym)", () => {
  const t0 = Date.parse("2026-11-08T18:00:00Z");
  const fit = parseFit(writeFit({ start: t0, end: t0 + 45 * 60_000, sport: "training", samples: [] }));
  expect(fit.sport).toBe("training");
  expect(fit.session).toMatchObject({ total_elapsed_time: 2700 });
  expect(fit.session!.total_distance).toBeUndefined();
  expect(fit.records).toHaveLength(0);
});
