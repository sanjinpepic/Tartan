/** The race countdown (src/race-countdown.ts): the race ahead, the prediction and how it moved, the taper. */
import { expect, test } from "bun:test";
import { Analytics } from "../src/analytics.ts";
import { MemoryDisk } from "../src/disk.ts";
import { FILES_FOLDER, importWorkout } from "../src/import.ts";
import { Library } from "../src/library.ts";
import { mondayOf, Plans } from "../src/plan.ts";
import { countdown, predictRace, raceAhead, TAPER } from "../src/race-countdown.ts";
import { raceWeek } from "../src/race-week.ts";
import { LocalStore } from "../src/store.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const ago = (d: number) => new Date(NOW - d * 86400_000).toISOString();

test("the prediction: the quickest from the recent runs' long enough stretches; a month ago from what was there then", () => {
  const runs = [
    { id: "a", start: ago(40), efforts: [{ name: "5k", time_s: 1500 }, { name: "400m", time_s: 70 }] },
    { id: "b", start: ago(10), efforts: [{ name: "10k", time_s: 3050 }, { name: "5k", time_s: 1440 }] },
  ];
  const now = predictRace(runs, 21.0975, NOW)!;
  // 5k 24:00 → a half in 1:50:24; the 10k (50:50) says 1:52:10, so the 5k counts.
  expect(now.from).toMatchObject({ name: "5k", time_s: 1440, activity: "b" });
  expect(now.time_s).toBe(Math.round(1440 * Math.pow(21097.5 / 5000, 1.06)));
  const then = predictRace(runs, 21.0975, NOW - 28 * 86400_000)!;
  expect(then.from.activity).toBe("a");
  expect(then.time_s).toBeGreaterThan(now.time_s);
  // A 400 m is too short for a half; nothing at all: null; only older runs: the year's.
  expect(predictRace([{ id: "x", start: ago(3), efforts: [{ name: "400m", time_s: 60 }] }], 21.0975, NOW)).toBeNull();
  expect(predictRace([{ id: "x", start: ago(200), efforts: [{ name: "10k", time_s: 3000 }] }], 10, NOW)!.time_s).toBe(3000);
});

test("the race ahead: the targets' while it's dated ahead, else the plan's next race", () => {
  const plan = [{ date: "2026-12-20", kind: "race", title: "Christmas 10k", distance_km: 10 }, { date: "2026-12-01", kind: "easy", title: "Easy" }];
  expect(raceAhead({ name: "Spring half", distance_km: 21.1, date: "2027-03-01" }, plan, "2026-11-18")!.name).toBe("Spring half");
  expect(raceAhead({ name: "Old", distance_km: 10, date: "2026-10-01", target_s: 2900 }, plan, "2026-11-18")).toEqual({ name: "Christmas 10k", distance_km: 10, date: "2026-12-20", target_s: 2900, from_plan: true });
  expect(raceAhead(undefined, [], "2026-11-18")).toBeNull();
});

test("the countdown in words: moved over a month, against the target, the taper, then race week takes over", () => {
  const r = { name: "Helsinki Half", distance_km: 21.0975, target_s: 6300 };
  expect(countdown({ ...r, days_to_go: 40, predicted_s: 6500 }, 6590)!.text).toBe("Helsinki Half in 40 days. Predicted 1:48:20, 1:30 quicker than a month ago. Target 1:45:00: 3:20 to find.");
  expect(countdown({ ...r, days_to_go: 40, predicted_s: 6200 }, 6202)).toMatchObject({ change_s: -2, gap_s: -100, text: "Helsinki Half in 40 days. Predicted 1:43:20, the same as a month ago. Target 1:45:00: on track." });
  expect(countdown({ ...r, days_to_go: 85, predicted_s: 6500 }, null)).toBeNull();
  expect(countdown({ distance_km: 10, days_to_go: 30 }, null)!.text).toBe("Your 10 km race in 30 days. No prediction yet: it needs a run of at least an eighth of the distance.");
  // The last two weeks before race week: the taper. At 7 days race week has it (and the countdown carries no taper).
  const eight = countdown({ ...r, days_to_go: 8, predicted_s: 6500 }, 6500)!;
  expect(eight.taper).toBe(TAPER);
  expect(raceWeek({ ...r, days_to_go: 8 })).toBeNull();
  expect(countdown({ ...r, days_to_go: 15, predicted_s: 6500 }, 6500)!.taper).toBeUndefined();
  expect(countdown({ ...r, days_to_go: 7, predicted_s: 6500 }, 6500)!.taper).toBeUndefined();
  expect(raceWeek({ ...r, days_to_go: 7 })!.focus.title).toBe("Taper");
});

test("the targets carry it: a race from the plan, predicted from the watch's runs, moved over four weeks", async () => {
  const disk = new MemoryDisk();
  const store = new LocalStore(disk);
  const now = Date.now();
  // Two 6 km runs: five weeks ago at 5:20 /km, a week ago at 5:00.
  const run = (start: number, pace: number) => {
    const samples = [];
    for (let t = 0; t <= 6 * pace; t += 5) samples.push({ t: start + t * 1000, lat: 60.17 + t * 1e-5, lon: 24.94, hr: 150, distance: (t / pace) * 1000 });
    return { start, end: start + 6 * pace * 1000, sport: "running", samples };
  };
  await importWorkout(store, FILES_FOLDER, "a", run(now - 35 * 86400_000, 320));
  await importWorkout(store, FILES_FOLDER, "b", run(now - 7 * 86400_000, 300));
  const day = (n: number) => new Date(now + n * 86400_000).toLocaleDateString("sv");
  const lib = new Library(disk);
  await new Plans(lib).save({ title: "To the 10k", summary: "S", weeks: [{ start: mondayOf(day(30)), focus: "Race", sessions: [{ date: day(30), kind: "race", title: "Autumn 10k", distance_km: 10 }] }] });
  const g = await new Analytics(lib).goalProgress();
  const race = g.race as unknown as { name: string; from_plan: boolean; days_to_go: number; predicted_s: number; countdown: { change_s: number; text: string } };
  expect(race).toMatchObject({ name: "Autumn 10k", from_plan: true, days_to_go: 30 });
  // 5k in 25:00 → 10k in about 52:07; a month ago 5k in 26:40.
  expect(race.predicted_s).toBe(Math.round(1500 * Math.pow(2, 1.06)));
  expect(race.countdown.change_s).toBeLessThan(-150);
  expect(race.countdown.text).toMatch(/^Autumn 10k in 30 days\. Predicted 52:\d\d, \d:\d\d quicker than a month ago\.$/);
});
