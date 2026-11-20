import { describe, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { loggedSets } from "../src/fatigue.ts";
import { cleanLog, Lifts, nextFor, nextWeights, prsIn, records, summarize, targetsFor, type ExerciseLog, type LiftLog } from "../src/strength/log.ts";

const sets = (n: number, reps: number, kg?: number) => Array.from({ length: n }, () => ({ done: true, reps, ...(kg ? { kg } : {}) }));
const ex = (id: string, target: ExerciseLog["target"], s: ExerciseLog["sets"], rir?: ExerciseLog["rir"]): ExerciseLog => ({ id, target, sets: s, ...(rir !== undefined ? { rir } : {}) });
const log = (date: string, ...exercises: ExerciseLog[]): LiftLog => ({ date, title: "Gym", started: `${date}T16:00:00.000Z`, finished: `${date}T16:45:00.000Z`, exercises });

describe("next time", () => {
  test("first time: no weight, a sentence on how to pick one", () => {
    const t = nextFor({ id: "back_squat", sets: 4, reps: 6 }, [])!;
    expect(t).toMatchObject({ rule: "start", loaded: true, sets: 4, reps: 6 });
    expect(t.kg).toBeUndefined();
    expect(t.why).toContain("Pick a weight");
  });
  test("every set done with reps to spare: 2.5 kg more on a bar, 2 kg on dumbbells", () => {
    const logs = [log("2026-10-12", ex("back_squat", { sets: 4, reps: 6, kg: 60 }, sets(4, 6, 60), 2), ex("dumbbell_curl", { sets: 3, reps: 12, kg: 10 }, sets(3, 12, 10), 1))];
    expect(nextFor({ id: "back_squat", sets: 4, reps: 6 }, logs)).toMatchObject({ rule: "add", kg: 62.5, last: { date: "2026-10-12", text: "4 × 6 at 60 kg" } });
    expect(nextFor({ id: "dumbbell_curl", sets: 3, reps: 12 }, logs)).toMatchObject({ rule: "add", kg: 12 });
  });
  test("nothing left in the tank: the same again", () => {
    const logs = [log("2026-10-12", ex("bench_press", { sets: 3, reps: 8, kg: 50 }, sets(3, 8, 50), 0))];
    expect(nextFor({ id: "bench_press", sets: 3, reps: 8 }, logs)).toMatchObject({ rule: "hold", kg: 50 });
  });
  test("short of the reps: hold; short twice running: 10% lighter, to a plate", () => {
    const miss = (date: string) => log(date, ex("bench_press", { sets: 3, reps: 8, kg: 50 }, [...sets(2, 8, 50), { done: true, reps: 5, kg: 50 }], 0));
    expect(nextFor({ id: "bench_press", sets: 3, reps: 8 }, [miss("2026-10-12")])).toMatchObject({ rule: "hold", kg: 50, last: { text: "8, 8, 5 at 50 kg" } });
    expect(nextFor({ id: "bench_press", sets: 3, reps: 8 }, [miss("2026-10-05"), miss("2026-10-12")])).toMatchObject({ rule: "ease", kg: 45 });
  });
  test("bodyweight: a rep more; a hold: 5 s longer", () => {
    const logs = [log("2026-10-12", ex("calf_raise", { sets: 3, reps: 15 }, sets(3, 15), 2), ex("plank", { sets: 3, seconds: 40 }, Array.from({ length: 3 }, () => ({ done: true, seconds: 40 })), 1))];
    expect(nextFor({ id: "calf_raise", sets: 3, reps: 15 }, logs)).toMatchObject({ rule: "more reps", reps: 16 });
    expect(nextFor({ id: "plank", sets: 3, seconds: 40 }, logs)).toMatchObject({ rule: "longer", seconds: 45 });
  });
  test("running comes first: worked-hard legs or a go-easy morning hold the weight, with the reason", () => {
    const logs = [log("2026-10-12", ex("back_squat", { sets: 4, reps: 6, kg: 60 }, sets(4, 6, 60), 2), ex("bench_press", { sets: 3, reps: 8, kg: 50 }, sets(3, 8, 50), 2))];
    const tired = nextFor({ id: "back_squat", sets: 4, reps: 6 }, logs, { fatigued: { quads: "Long run, Saturday" } })!;
    expect(tired).toMatchObject({ rule: "hold", kg: 60 });
    expect(tired.why).toBe("Your quads are still worked hard (Long run, Saturday): the same as last time today.");
    // The bench doesn't use the legs: it still moves on.
    expect(nextFor({ id: "bench_press", sets: 3, reps: 8 }, logs, { fatigued: { quads: "Long run, Saturday" } })).toMatchObject({ rule: "add", kg: 52.5 });
    expect(nextFor({ id: "bench_press", sets: 3, reps: 8 }, logs, { readiness: "go easy" })).toMatchObject({ rule: "hold", kg: 50 });
  });
  test("a session's own log doesn't count as last time; a session without exercises gets the basic routine", () => {
    const today = log("2026-10-19", ex("back_squat", { sets: 4, reps: 6, kg: 62.5 }, sets(4, 6, 62.5), 2));
    const t = targetsFor([{ id: "back_squat", sets: 4, reps: 6 }], 45, [log("2026-10-12", ex("back_squat", { sets: 4, reps: 6, kg: 60 }, sets(4, 6, 60), 2)), today], {}, "2026-10-19");
    expect(t[0]).toMatchObject({ kg: 62.5, last: { date: "2026-10-12" } });
    expect(targetsFor(undefined, 30, []).map((x) => x.id)).toEqual(["squat", "reverse_lunge", "single_leg_rdl", "glute_bridge", "calf_raise", "plank"]);
  });
});

describe("records", () => {
  const a = log("2026-10-05", ex("back_squat", { sets: 3, reps: 5, kg: 60 }, sets(3, 5, 60)), ex("calf_raise", { sets: 3, reps: 15 }, sets(3, 15)));
  const b = log("2026-10-12", ex("back_squat", { sets: 3, reps: 8, kg: 60 }, sets(3, 8, 60)), ex("calf_raise", { sets: 3, reps: 18 }, sets(3, 18)));
  test("each exercise's best set, estimated max, reps and hold", () => {
    const r = records([a, b]);
    expect(r.find((x) => x.id === "back_squat" && x.kind === "heaviest")).toMatchObject({ value: 60, text: "60 kg × 8", date: "2026-10-12" });
    expect(r.find((x) => x.id === "back_squat" && x.kind === "e1rm")!.value).toBe(76);
    expect(r.find((x) => x.id === "calf_raise" && x.kind === "reps")).toMatchObject({ value: 18 });
  });
  test("a session's records beat earlier ones; a first time sets none", () => {
    expect(prsIn(a, [])).toEqual([]);
    const prs = prsIn(b, [a]);
    expect(prs.map((p) => `${p.name}: ${p.text}, was ${p.before}`)).toEqual(["Back squat: 76 kg estimated max, was 70 kg estimated max", "Calf raise: 18 reps, was 15 reps"]);
  });
  test("the summary: time, sets, kilos, records and next time", () => {
    const s = summarize(b, [a, b]);
    expect(s).toMatchObject({ minutes: 45, sets: 6, volume_kg: 1440 });
    expect(s.prs).toHaveLength(2);
    expect(s.next.find((n) => n.id === "back_squat")).toMatchObject({ last: "3 × 8 at 60 kg", next: "3 × 8 at 62.5 kg", rule: "add" });
    expect(nextWeights([a, b])).toEqual({ back_squat: { kg: 62.5, reps: 8 }, calf_raise: { reps: 19 } });
  });
});

describe("the log", () => {
  test("kept per day, cleaned of what it can't hold", async () => {
    const lifts = new Lifts(new MemoryDisk());
    await lifts.save({ date: "2026-10-19", title: "Gym", started: "2026-10-19T16:00:00Z", exercises: [{ id: "squat", target: { sets: 3, reps: 12 }, sets: [{ done: true, reps: 12, kg: -4, junk: 1 }], rir: 7 }, { id: "nope", target: { sets: 1 }, sets: [] }] });
    const l = (await lifts.get("2026-10-19"))!;
    expect(l.exercises).toEqual([{ id: "squat", target: { sets: 3, reps: 12 }, sets: [{ done: true, reps: 12 }] }]);
    expect(() => cleanLog({ date: "19.10.2026", exercises: [] })).toThrow();
    expect(await lifts.remove("2026-10-19")).toBe(true);
    expect(await lifts.all()).toEqual([]);
  });
  test("for the muscles: ticked sets, lighter with reps left", () => {
    const l = log("2026-10-12", ex("back_squat", { sets: 4, reps: 6 }, [...sets(3, 6, 60), { done: false, reps: 6 }], 1), ex("plank", { sets: 3, seconds: 40 }, Array.from({ length: 3 }, () => ({ done: true, seconds: 40 })), 3));
    expect(loggedSets(l)).toEqual([{ id: "back_squat", sets: 3 }, { id: "plank", sets: 3 * 0.6 }]);
  });
});
