import { expect, test } from "bun:test";
import { mergeActivities, sameActivity, type Candidate, type LinkTable } from "../src/merge.ts";

const t0 = Date.parse("2026-10-12T06:40:00Z");
const strava = (o: Partial<Candidate> = {}): Candidate => ({
  key: "strava:1", source: "strava", start: t0 + 2000, elapsed_s: 3010, moving_s: 2950, distance_m: 10_020, sport: "Run",
  name: "Morning tempo", avg_hr: 151, elevation_m: 88, has_streams: true, ...o,
});
const watch = (o: Partial<Candidate> = {}): Candidate => ({
  key: "watch:Run2/logs/a.fit", source: "watch", start: t0, elapsed_s: 3012, moving_s: 2948, distance_m: 10_004, sport: "running",
  avg_hr: 150, elevation_m: 91, has_streams: true, ...o,
});

test("watch file and Strava copy of one run become one activity", () => {
  const [m, ...rest] = mergeActivities([strava(), watch()]);
  expect(rest).toHaveLength(0);
  expect(m!.members.map((x) => x.source)).toEqual(["watch", "strava"]);
  // Measurements from the device's own file, the edited title and sport from Strava.
  expect(m).toMatchObject({ distance_m: 10_004, avg_hr: 150, elevation_m: 91, name: "Morning tempo", sport: "Run", start: t0 });
  expect(m!.provenance).toMatchObject({ distance_m: "watch:Run2/logs/a.fit", name: "strava:1", sport: "strava:1" });
  // One time series only: the watch's.
  expect(m!.streams_from).toBe("watch:Run2/logs/a.fit");
});

test("the Strava time series is used when the watch copy has none", () => {
  const [m] = mergeActivities([strava(), watch({ has_streams: false })]);
  expect(m!.streams_from).toBe("strava:1");
});

test("different workouts stay apart", () => {
  expect(sameActivity(strava(), watch({ distance_m: 5_000 }))).toBe(false); // distance disagrees
  expect(sameActivity(strava(), watch({ sport: "cycling" }))).toBe(false); // different sport
  expect(sameActivity(strava(), watch({ start: t0 + 4 * 3600_000 }))).toBe(false); // later that day
  expect(sameActivity(strava(), strava({ key: "strava:2" }))).toBe(false); // same source never merges
  // Two runs on the same morning, back to back: each merges only with its own copy.
  const second = { start: t0 + 3100_000, elapsed_s: 900, moving_s: 890, distance_m: 2_500 };
  const merged = mergeActivities([strava(), watch(), strava({ key: "strava:2", ...second }), watch({ key: "watch:Run2/logs/b.fit", ...second })]);
  expect(merged).toHaveLength(2);
  expect(merged.map((m) => m.members.map((x) => x.key).sort())).toEqual([
    ["strava:2", "watch:Run2/logs/b.fit"],
    ["strava:1", "watch:Run2/logs/a.fit"],
  ]);
});

test("canonical ids stay stable when a second copy shows up later", () => {
  const links: LinkTable = {};
  const [first] = mergeActivities([watch()], links);
  const [later] = mergeActivities([watch(), strava()], links);
  expect(later!.id).toBe(first!.id);
  expect(links["strava:1"]).toBe(first!.id);
});

test("unknown sport on one copy does not block a match", () => {
  expect(sameActivity(strava(), watch({ sport: "unknown" }))).toBe(true);
  const [m] = mergeActivities([strava(), watch({ sport: "unknown" })]);
  expect(m!.sport).toBe("Run");
});

test("a run of a few seconds still matches its copy when the clocks disagree a little", () => {
  // Recorded on the phone for 4 s; Strava's copy starts 3 s later and lasts 3 s: no overlap.
  const phone: Candidate = { key: "phone:r1", source: "phone", start: t0, elapsed_s: 4, moving_s: 4, distance_m: 70, sport: "Run" };
  expect(sameActivity(phone, strava({ start: t0 + 5000, elapsed_s: 3, moving_s: 3, distance_m: 70 }))).toBe(true);
  // A minute apart is no longer the same start.
  expect(sameActivity(phone, strava({ start: t0 + 90_000, elapsed_s: 3, moving_s: 3, distance_m: 70 }))).toBe(false);
  // Same start, different sport: still apart.
  expect(sameActivity(phone, strava({ start: t0 + 5000, elapsed_s: 3, sport: "Ride" }))).toBe(false);
});
