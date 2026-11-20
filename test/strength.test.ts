import { expect, test } from "bun:test";
import { defaultRoutine, doseSeconds, doseText, EXERCISES, MUSCLES, musclesOf, routineOf } from "../src/strength/exercises.ts";
import { ANIMS, poseAt } from "../web/lib/figure.ts";

test("every exercise has known muscles and three cues; the 2D figures (the fallback without 3D) are all exercises", () => {
  for (const id of Object.keys(ANIMS)) expect(EXERCISES.some((e) => e.id === id)).toBe(true);
  for (const ex of EXERCISES) {
    for (const m of [...ex.primary, ...ex.secondary]) expect(MUSCLES).toContain(m);
    expect(ex.cues).toHaveLength(3);
    expect(ex.primary.length).toBeGreaterThan(0);
  }
});

test("figures loop smoothly: back where they started after a full cycle, and nothing jumps", () => {
  for (const [id, anim] of Object.entries(ANIMS)) {
    const cycle = (anim.move + anim.hold) * anim.poses.length;
    expect(poseAt(anim, 0)).toEqual(poseAt(anim, cycle));
    // Between frames 1/60 s apart, no limb turns more than a few degrees (a jump's arm swing is the quickest).
    for (let t = 0; t < cycle; t += 1 / 60) {
      const a = poseAt(anim, t);
      const b = poseAt(anim, t + 1 / 60);
      for (const k of ["trunk", "thighN", "shinN", "armN", "foreN"] as const) {
        const d = Math.abs(((b[k] - a[k] + 540) % 360) - 180);
        if (d > 20) throw new Error(`${id}: ${k} jumps ${d.toFixed(1)}° at ${t.toFixed(2)} s`);
      }
    }
  }
});

test("routines: the coach's exercises, or a basic one sized to the session", () => {
  expect(defaultRoutine(20).map((x) => x.id)).toEqual(["squat", "reverse_lunge", "single_leg_rdl", "glute_bridge"]);
  expect(defaultRoutine(45)).toHaveLength(8);
  const r = routineOf([{ id: "plank", sets: 2, seconds: 45 }, { id: "nope", sets: 1 }, { id: "reverse_lunge", sets: 4 }]);
  expect(r.map((x) => [x.ex.id, doseText(x.dose)])).toEqual([["plank", "2 × 45 s"], ["reverse_lunge", "4 × 10 each side"]]);
  expect(doseSeconds({ sets: 3, reps: 10, each_side: true })).toBe(3 * 60 + 2 * 60);
  const m = musclesOf(routineOf(defaultRoutine(30)));
  expect(m.primary).toContain("glutes");
  expect(m.secondary.some((x) => m.primary.includes(x))).toBe(false);
});
