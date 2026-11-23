import { describe, expect, test } from "bun:test";
import { bodyState, workoutMuscles, exercisesFor, stimulus, type Workout } from "../src/fatigue.ts";

const PROF = { max_hr: 190, rest_hr: 50 };
const NOW = Date.parse("2026-10-19T12:00:00Z");
const H = 3600_000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();
const run = (hoursAgo: number, minutes: number, extra: Partial<Workout> = {}): Workout => ({ start: at(hoursAgo), sport: "Running", title: "Run", minutes, ...extra });

describe("stimulus", () => {
  test("a run loads the legs, calves most, and nothing above the waist", () => {
    const s = stimulus(run(0, 60), PROF);
    expect(s.calves!).toBeGreaterThan(s.quads!);
    expect(s.quads!).toBeGreaterThan(0);
    expect(s.chest).toBeUndefined();
    expect(s.biceps).toBeUndefined();
  });
  test("harder and hillier runs load more", () => {
    const easy = stimulus(run(0, 60, { kind: "easy" }), PROF);
    const reps = stimulus(run(0, 60, { kind: "intervals" }), PROF);
    const hills = stimulus(run(0, 60, { kind: "easy", elevation_m: 600 }), PROF);
    expect(reps.hamstrings!).toBeGreaterThan(easy.hamstrings! * 1.5);
    expect(hills.calves!).toBeGreaterThan(easy.calves!);
    expect(hills.quads!).toBeGreaterThan(easy.quads!);
  });
  test("heart rate stands in for the plan's kind", () => {
    const low = stimulus(run(0, 60, { avg_hr: 120 }), PROF);
    const high = stimulus(run(0, 60, { avg_hr: 175 }), PROF);
    expect(high.calves!).toBeGreaterThan(low.calves!);
  });
  test("a strength session loads what its exercises work, by hard sets", () => {
    const s = stimulus({ start: at(0), sport: "Strength", title: "Upper body", minutes: 45, kind: "strength", exercises: [{ id: "bench_press", sets: 4, reps: 8 }, { id: "pull_up", sets: 4, reps: 5 }] }, PROF);
    expect(s.chest).toBeCloseTo(4 / 8);
    expect(s.lats).toBeCloseTo(4 / 8);
    // A helper counts 0.4 of a set: delts help the bench press.
    expect(s.delts).toBeCloseTo((0.4 * 4) / 8);
    expect(s.quads).toBeUndefined();
  });
  test("a muscle's sets in one session are capped", () => {
    const many = stimulus({ start: at(0), sport: "Strength", title: "Legs", minutes: 60, kind: "strength", exercises: [{ id: "back_squat", sets: 10, reps: 5 }, { id: "split_squat", sets: 10, reps: 8 }] }, PROF);
    expect(many.quads).toBeCloseTo(12 / 8);
  });
});

describe("bodyState", () => {
  test("nothing done: everything fresh", () => {
    const b = bodyState([], [], PROF, NOW);
    expect(Object.values(b.muscles).every((m) => m.state === "fresh" && m.level === 0 && !m.causes.length)).toBe(true);
  });
  test("a hard long run yesterday leaves the legs worked, the arms fresh, with the run as the reason", () => {
    const b = bodyState([run(20, 120, { kind: "long", title: "Long run" })], [], PROF, NOW);
    expect(b.muscles.calves.state).toBe("fatigued");
    expect(b.muscles.calves.level).toBe(4);
    expect(b.muscles.calves.fresh_in_h).toBeGreaterThan(0);
    expect(b.muscles.calves.causes[0]).toMatchObject({ what: "Long run", kind: "run", share: 1 });
    expect(b.muscles.chest.state).toBe("fresh");
  });
  test("it fades: the same run a week ago has left", () => {
    const b = bodyState([run(24 * 7, 120, { kind: "long" })], [], PROF, NOW);
    expect(b.muscles.calves.state).toBe("fresh");
    expect(b.muscles.calves.last_worked).toBe("2026-10-12");
  });
  test("muscles used to the work read it lighter: a daily runner's usual day isn't 'worked hard'", () => {
    const today = run(6, 60, { kind: "easy" });
    const habit = Array.from({ length: 27 }, (_, i) => run(24 * (i + 1) + 6, 60, { kind: "easy" }));
    expect(bodyState([today], [], PROF, NOW).muscles.calves.state).toBe("fatigued");
    const used = bodyState([today, ...habit], [], PROF, NOW).muscles.calves;
    expect(used.state).toBe("recovering");
    // A long run on top of the habit is more than usual.
    expect(bodyState([today, run(30, 120, { kind: "long" }), ...habit], [], PROF, NOW).muscles.calves.state).toBe("fatigued");
  });
  test("causes are shared out between the workouts still in the muscle", () => {
    const b = bodyState([run(10, 60, { title: "Tempo", kind: "tempo" }), run(40, 60, { title: "Easy", kind: "easy" })], [], PROF, NOW);
    const c = b.muscles.quads.causes;
    expect(c.map((x) => x.what)).toEqual(["Tempo", "Easy"]);
    expect(c[0]!.share + c[1]!.share).toBeCloseTo(1, 1);
  });
  test("a sore calf from the morning check shows on the calves for a week", () => {
    const b = bodyState([], [{ date: "2026-10-18", area: "calf", level: 2 }], PROF, NOW);
    expect(b.muscles.calves.sore).toEqual({ date: "2026-10-18", area: "calf", level: 2 });
    expect(b.muscles.quads.sore).toBeUndefined();
    const later = bodyState([], [{ date: "2026-10-05", area: "calf", level: 2 }], PROF, NOW);
    expect(later.muscles.calves.sore).toBeUndefined();
  });
});

test("exercisesFor: those that drive the muscle come first", () => {
  const ex = exercisesFor("calves");
  expect(ex[0]!.primary).toBe(true);
  expect(ex.some((e) => e.id === "calf_raise" && e.primary)).toBe(true);
  expect(ex.findIndex((e) => !e.primary)).toBeGreaterThan(ex.findLastIndex((e) => e.primary));
});

describe("what one workout worked (the workout sheet's map)", () => {
  test("a run works the calves most, every level on the 0-4 scale, most worked first", () => {
    const m = workoutMuscles(run(0, 60), PROF);
    expect(m[0]!.muscle).toBe("calves");
    expect(m[0]!.level).toBe(4);
    expect(m.every((x) => x.level >= 1 && x.level <= 4)).toBe(true);
    expect(m.map((x) => x.share)).toEqual([...m.map((x) => x.share)].sort((a, b) => b - a));
  });
  test("a strength session works what its exercises work; nothing for no time", () => {
    const m = workoutMuscles({ start: at(0), sport: "strength", title: "Gym", minutes: 40, kind: "strength", exercises: [{ id: "push_up", sets: 3, reps: 10 }] }, PROF);
    expect(m.map((x) => x.muscle)).toContain("chest");
    expect(workoutMuscles(run(0, 0), PROF)).toEqual([]);
  });
});
