/** Workouts told to the coach ("I swam 25x25m today"): logged, shown, filling the plan, counted, and stepping aside for a recording. */
import { expect, test } from "bun:test";
import { Analytics } from "../src/analytics.ts";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import { mondayOf, Plans, today } from "../src/plan.ts";
import { dataTools } from "../src/tools.ts";

const setup = async () => {
  const lib = new Library(new MemoryDisk());
  await lib.strava.write([], "index.json");
  const tools = dataTools(lib);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name)!;
    return (await t.run(t.schema.parse(args))) as Record<string, any>;
  };
  return { lib, call };
};

test("a swim told to the coach is a workout: in activities, filling the planned cross session, counted in the load", async () => {
  const { lib, call } = await setup();
  const t = today();
  await new Plans(lib).save({ title: "Build", summary: "x", weeks: [{ start: mondayOf(t), focus: "Base", sessions: [{ date: t, kind: "cross", title: "Swim or bike, 30'", duration_min: 30 }] }] });

  const r = await call("log_workout", { sport: "Swim", minutes: 30, distance_m: 625, effort: 4, name: "Pool swim", note: "25 × 25 m" });
  expect(r.logged).toMatchObject({ date: t, sport: "Swim", name: "Pool swim", distance_m: 625, minutes: 30, effort: 4 });
  expect(r.fills).toBe("cross: Swim or bike, 30'");

  const [row] = await lib.activities({ source: "logged" });
  expect(row).toMatchObject({ sport: "Swim", name: "Pool swim", distance_km: 0.63, moving_min: 30, sources: ["logged"], effort: 4, device: "Told to the coach" });
  expect((await lib.activity(row!.id)).description).toBe("25 × 25 m");
  // Effort 4 of 10 with no heart rate: a little under a middling minute's load.
  expect(new Analytics(lib).trimp(row!, { max_hr: 190, rest_hr: 50 })).toEqual({ load: 23.4, estimated: true });

  // Logged twice by mistake: taken back by either id.
  const again = await call("log_workout", { sport: "Swim", minutes: 20 });
  expect(await call("remove_logged_workout", { id: `logged:${again.logged.id}` })).toEqual({ removed: true });
  expect(await call("remove_logged_workout", { id: "nope" })).toEqual({ error: "No logged workout with that id." });
  expect(await lib.activities({ source: "logged" })).toHaveLength(1);
});

test("nothing in the future; no amount still logs it; a recording that day wins, before or after", async () => {
  const { lib, call } = await setup();
  const t = today();
  expect((await call("log_workout", { sport: "Swim", minutes: 30, date: "2999-01-01" })).error).toContain("today or earlier");

  // "I went for a ride": logged as said, no questions.
  expect((await call("log_workout", { sport: "Ride", time: "07:30" })).logged).toMatchObject({ sport: "Ride", name: "Ride" });
  expect(await lib.activities({ source: "logged" })).toHaveLength(1);
  // The ride's recording arrives from Strava: that's the one, the told copy steps aside.
  const start = new Date(`${t}T17:00:00`);
  await lib.strava.write([{ id: 9, name: "Evening ride", type: "Ride", sport_type: "Ride", start_date: start.toISOString(), start_date_local: `${t}T17:00:00Z`, distance: 20000, moving_time: 2400, elapsed_time: 2500, total_elevation_gain: 50 }], "index.json");
  lib.invalidate();
  const rides = await lib.activities({ sport: "Ride" });
  expect(rides.map((r) => r.name)).toEqual(["Evening ride"]);
  // And a ride already recorded isn't logged again.
  expect((await call("log_workout", { sport: "Ride", minutes: 40 })).already_recorded).toMatchObject({ name: "Evening ride" });
});
