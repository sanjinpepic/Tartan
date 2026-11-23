import { expect, test } from "bun:test";
import { mergeActivities, migrateLinks, resolveAlias, sameActivity, type Candidate, type LinkTable } from "../src/merge.ts";

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

test("two different workouts starting the same second get ids of their own, and keep them", () => {
  const swim: Candidate = { key: "logged:s1", source: "logged", start: t0, sport: "Swim", moving_s: 2400 };
  const ride: Candidate = { key: "logged:r1", source: "logged", start: t0, sport: "Ride", moving_s: 3600 };
  const links: LinkTable = {};
  const ids = mergeActivities([swim, ride], links).map((m) => m.id);
  expect(new Set(ids).size).toBe(2);
  expect(mergeActivities([ride, swim], { ...links }).map((m) => m.id).sort()).toEqual([...ids].sort());
});

// A health app's copy (Health Connect, Apple Health) of the watch's own workout.
const health = (o: Partial<Candidate> = {}): Candidate => ({
  key: "health:hc-Suunto/2026-10-12-running-abc.fit", source: "health", start: t0 + 1000, elapsed_s: 3005, moving_s: 3005, distance_m: 9_950, sport: "running",
  avg_hr: 149, has_streams: true, ...o,
});

test("a health app's copy first, then the watch's own file: one workout, the watch's numbers, the id it had", () => {
  const links: LinkTable = {};
  const [first, ...none] = mergeActivities([health()], links);
  expect(none).toHaveLength(0);
  const merged = mergeActivities([health(), watch()], links);
  expect(merged).toHaveLength(1);
  const m = merged[0]!;
  expect(m.id).toBe(first!.id);
  expect(m.members.map((x) => x.source)).toEqual(["watch", "health"]);
  expect(m).toMatchObject({ distance_m: 10_004, avg_hr: 150, elapsed_s: 3012, start: t0 });
  expect(m.streams_from).toBe("watch:Run2/logs/a.fit");
  expect(links["watch:Run2/logs/a.fit"]).toBe(first!.id);
});

test("the watch's file first, then a health app's copy: still one", () => {
  const links: LinkTable = {};
  const [first] = mergeActivities([watch()], links);
  const merged = mergeActivities([watch(), health()], links);
  expect(merged).toHaveLength(1);
  expect(merged[0]!.id).toBe(first!.id);
  expect(merged[0]!.provenance.distance_m).toBe("watch:Run2/logs/a.fit");
});

test("two different workouts close together on one watch stay two, each with its health copy", () => {
  // A warm-up, then the session: back to back, the second's copy through Health Connect too.
  const warm = watch({ key: "watch:Run2/logs/w.fit", elapsed_s: 600, moving_s: 600, distance_m: 1_800 });
  const main = watch({ start: t0 + 610_000 });
  const mainCopy = health({ start: t0 + 612_000 });
  const merged = mergeActivities([warm, main, mainCopy]);
  expect(merged).toHaveLength(2);
  expect(merged.map((m) => m.members.map((x) => x.key).sort())).toEqual([
    ["health:hc-Suunto/2026-10-12-running-abc.fit", "watch:Run2/logs/a.fit"],
    ["watch:Run2/logs/w.fit"],
  ]);
  // Two files off one watch at nearly the same time are two workouts, never one.
  expect(sameActivity(watch(), watch({ key: "watch:Run2/logs/b.fit", start: t0 + 20_000 }))).toBe(false);
  expect(mergeActivities([watch(), watch({ key: "watch:Run2/logs/b.fit", start: t0 + 20_000 })])).toHaveLength(2);
});

test("Strava, a health app's copy and the watch's file: one, measured by the watch, titled by Strava", () => {
  const links: LinkTable = {};
  const [h] = mergeActivities([health()], links);
  const merged = mergeActivities([strava(), health(), watch()], links);
  expect(merged).toHaveLength(1);
  const m = merged[0]!;
  expect(m.id).toBe(h!.id);
  expect(m.members.map((x) => x.source)).toEqual(["watch", "strava", "health"]);
  expect(m).toMatchObject({ distance_m: 10_004, avg_hr: 150, name: "Morning tempo", sport: "Run" });
  expect(m.streams_from).toBe("watch:Run2/logs/a.fit");
  // Without the watch's file, Strava's numbers come before the health app's.
  const [sh] = mergeActivities([health(), strava()]);
  expect(sh).toMatchObject({ distance_m: 10_020, avg_hr: 151 });
  expect(sh!.streams_from).toBe("strava:1");
  // A health app's copy outranks one only told to the coach.
  const [hl] = mergeActivities([health(), { key: "logged:x", source: "logged", start: t0, elapsed_s: 3000, distance_m: 10_000, sport: "Run" }]);
  expect(hl!.provenance.distance_m).toBe(health().key);
});

test("two copies that had ids of their own and now merge keep the id seen first; the other still finds it", () => {
  // As it was before health apps' copies merged: the health copy and the watch file apart.
  const links: LinkTable = { [health().key]: "a-health", "watch:Run2/logs/a.fit": "a-watch" };
  const [m] = mergeActivities([watch(), health()], links);
  expect(m!.id).toBe("a-health");
  expect(resolveAlias(links, "a-watch")).toBe("a-health");
  expect(resolveAlias(links, "a-health")).toBe("a-health");
  // A new workout later never gets the id that went.
  expect(Object.values(links).filter((v) => v === "a-watch")).toHaveLength(0);
});

test("link keys from when a health app's copies were watch files are renamed, ids and order kept", () => {
  const links: LinkTable = {
    "strava:1": "a1",
    "watch:hc-Samsung-Health/2026-10-01-running-x.fit": "a2",
    "watch:Suunto Run 2 0042/logs/r.fit": "a3",
    "watch:apple-health-Apple-Watch/2026-10-02-running-y.fit": "a4",
  };
  const sourceOf = (f: string) => (f.startsWith("hc-") || f.startsWith("apple-health-") ? "health" : "watch");
  expect(migrateLinks(links, sourceOf)).toBe(true);
  expect(Object.entries(links)).toEqual([
    ["strava:1", "a1"],
    ["health:hc-Samsung-Health/2026-10-01-running-x.fit", "a2"],
    ["watch:Suunto Run 2 0042/logs/r.fit", "a3"],
    ["health:apple-health-Apple-Watch/2026-10-02-running-y.fit", "a4"],
  ]);
  expect(migrateLinks(links, sourceOf)).toBe(false);
});
