/** The 3D bodies' moves (web/lib/moves.ts) against the exercises and the bodies' bones (web/assets/body-m.glb, body-f.glb). */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXERCISES, MUSCLES } from "../src/strength/exercises.ts";
import { MOVES } from "../web/lib/moves.ts";
import { SHADOWS } from "../web/assets/shadows/index.ts";

type Glb = { nodes: Array<{ name: string }>; extras: { muscles: string[]; sex: string; garments?: [number, number] }; meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }> };
const read = (f: string): Glb => {
  const glb = readFileSync(join(import.meta.dir, "../web/assets", f));
  return JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString()) as Glb;
};
const man = read("body-m.glb");
const woman = read("body-f.glb");
const bones = new Set(man.nodes.slice(1).map((n) => n.name));

test("both bodies carry the muscles, gym clothes and the same bones", () => {
  expect([man.extras.sex, woman.extras.sex]).toEqual(["male", "female"]);
  for (const json of [man, woman]) {
    expect(json.extras.muscles).toEqual([...MUSCLES]);
    expect(Object.keys(json.meshes[0]!.primitives[0]!.attributes)).toEqual(expect.arrayContaining(["_MUSCLE", "_MUSCLEW", "_WEAR", "_AO", "JOINTS_0", "WEIGHTS_0", "_JOINTS1", "_WEIGHTS1"]));
    // The clothes: their own triangles after the skin's (drawn with the cloth material).
    const [start, count] = json.extras.garments!;
    expect(start % 3).toBe(0);
    expect(count).toBeGreaterThan(3000);
    expect(json.nodes.slice(1).map((n) => n.name)).toEqual([...bones]);
  }
  expect(bones.size).toBe(38);
});

test("every exercise moves, with real bones, contacts on the floor and a still pose", () => {
  for (const ex of EXERCISES) {
    const m = MOVES[ex.id];
    expect(m, ex.id).toBeDefined();
    expect(m!.poses.length, ex.id).toBeGreaterThanOrEqual(2);
    expect(m!.still ?? 1, ex.id).toBeLessThan(m!.poses.length);
    expect(m!.move, ex.id).toBeGreaterThan(0);
    for (const p of m!.poses) {
      for (const b of Object.keys(p.joints)) expect(bones.has(b), `${ex.id}: ${b}`).toBe(true);
      expect(p.contacts?.length, `${ex.id} touches the floor`).toBeGreaterThan(0);
      for (const c of p.contacts ?? []) {
        expect(bones.has(c.bone), `${ex.id}: ${c.bone}`).toBe(true);
        expect(c.height).toBeGreaterThanOrEqual(0);
      }
      for (const [b, r] of Object.entries(p.joints)) {
        const deg = Array.isArray(r) ? r : [r.deg];
        for (const d of deg) expect(Math.abs(d), `${ex.id}: ${b}`).toBeLessThanOrEqual(185);
      }
    }
    for (const pr of m!.props ?? []) if ("under" in pr && pr.under) expect(bones.has(pr.under)).toBe(true);
  }
});

test("every exercise has Blender's floor shadow baked for both bodies, one square per key pose", () => {
  for (const id of ["stand", ...EXERCISES.map((e) => e.id)])
    for (const b of ["m", "f"]) {
      const s = SHADOWS[`${id}-${b}`];
      expect(s, `${id}-${b}`).toBeDefined();
      expect(s!.poses, `${id}-${b}`).toBe(MOVES[id]!.poses.length);
      expect(s!.size).toBeGreaterThan(1.5);
    }
});
