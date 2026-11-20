/**
 * The equipment the 3D body uses (web/lib/body3d.ts, web/lib/moves.ts Prop): a bench or step, a
 * barbell, dumbbells, a kettlebell, a pull-up bar. A held weight follows the hands' grip every
 * frame (the grip points come with the body, from scripts/build-body.py); the rest stands on the
 * floor. Few, simple shapes with three shared materials: cheap to draw.
 */
import type * as THREE_NS from "three";
import type { Prop } from "./moves.ts";

type Three = typeof THREE_NS;
type Vec = THREE_NS.Vector3;

export interface Grip {
  /** Where a bar sits in the gripping hand, and which way it runs (world). */
  at: Vec;
  axis: Vec;
}

export function makeProps(THREE: Three, RoundedBoxGeometry: new (w: number, h: number, d: number, segments: number, radius: number) => THREE_NS.BufferGeometry, props: readonly Prop[], dark: boolean) {
  const group = new THREE.Group();
  const geos: THREE_NS.BufferGeometry[] = [];
  const steel = new THREE.MeshStandardMaterial({ color: dark ? "#9c9ca2" : "#b9b9be", metalness: 0.85, roughness: 0.32 });
  const iron = new THREE.MeshStandardMaterial({ color: dark ? "#232120" : "#2e2b2a", metalness: 0.25, roughness: 0.62 });
  const pad = new THREE.MeshStandardMaterial({ color: dark ? "#5d5552" : "#cfc6c2", roughness: 0.7 });
  const g = <T extends THREE_NS.BufferGeometry>(x: T): T => (geos.push(x), x);
  /** A cylinder lying along x. */
  const rod = (r: number, len: number, mat: THREE_NS.Material, sides = 18, x = 0) => {
    const m = new THREE.Mesh(g(new THREE.CylinderGeometry(r, r, len, sides)), mat);
    m.rotation.z = Math.PI / 2;
    m.position.x = x;
    return m;
  };

  const boxes: Array<{ prop: Extract<Prop, { box: unknown }>; mesh: THREE_NS.Mesh }> = [];
  const held: Array<{ prop: Prop; obj: THREE_NS.Object3D; hand?: "L" | "R" }> = [];
  const bars: Array<{ height: number; obj: THREE_NS.Object3D }> = [];

  for (const p of props) {
    if ("box" in p) {
      const mesh = new THREE.Mesh(g(new RoundedBoxGeometry(p.box[0], p.box[1], p.box[2], 3, 0.03)), pad);
      mesh.position.set(p.at[0], p.box[1] / 2 + p.at[1], p.at[2]);
      group.add(mesh);
      boxes.push({ prop: p, mesh });
    } else if ("barbell" in p) {
      // 2.2 m, sleeves at the ends, a plate each side sized to the load.
      const o = new THREE.Group();
      const r = (p.plates ?? 20) >= 10 ? 0.225 : 0.15;
      o.add(rod(0.0135, 1.32, steel), rod(0.025, 0.42, steel, 18, 0.88), rod(0.025, 0.42, steel, 18, -0.88), rod(0.03, 0.03, steel, 18, 0.66), rod(0.03, 0.03, steel, 18, -0.66));
      for (const x of [0.72, -0.72]) o.add(rod(r, 0.055, iron, 32, x));
      group.add(o);
      held.push({ prop: p, obj: o });
    } else if ("dumbbell" in p) {
      for (const hand of p.dumbbell === "both" ? (["L", "R"] as const) : [p.dumbbell]) {
        const o = new THREE.Group();
        const head = 0.045 + Math.min(0.03, (p.kg ?? 10) * 0.0012);
        o.add(rod(0.016, 0.15, steel), rod(head, 0.075, iron, 6, 0.112), rod(head, 0.075, iron, 6, -0.112));
        group.add(o);
        held.push({ prop: p, obj: o, hand });
      }
    } else if ("kettlebell" in p) {
      // The handle's top is the grip; the bell hangs below it.
      const o = new THREE.Group();
      const bell = new THREE.Mesh(g(new THREE.SphereGeometry(0.1 + Math.min(0.03, (p.kg ?? 16) * 0.001), 28, 20)), iron);
      bell.position.y = -0.17;
      const handle = new THREE.Mesh(g(new THREE.TorusGeometry(0.07, 0.014, 10, 28, Math.PI)), iron);
      handle.position.y = -0.07;
      o.add(bell, handle);
      group.add(o);
      held.push({ prop: p, obj: o });
    } else if ("pullupBar" in p) {
      const o = new THREE.Group();
      o.add(rod(0.016, 1.3, steel));
      for (const x of [-0.64, 0.64]) {
        const post = new THREE.Mesh(g(new THREE.CylinderGeometry(0.03, 0.03, p.pullupBar + 0.1, 16)), iron);
        post.position.set(x, -(p.pullupBar + 0.1) / 2 + 0.05, 0);
        o.add(post);
      }
      group.add(o);
      bars.push({ height: p.pullupBar, obj: o });
    }
  }

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const X = new THREE.Vector3(1, 0, 0);
  const DOWN = new THREE.Vector3(0, -1, 0);

  /** Put the held weights in the hands. */
  const hold = (L: Grip, R: Grip, shoulders?: Vec) => {
    for (const h of held) {
      if ("barbell" in h.prop) {
        h.obj.position.copy(L.at).add(R.at).multiplyScalar(0.5);
        h.obj.quaternion.setFromUnitVectors(X, tmp.copy(L.at).sub(R.at).normalize());
      } else if ("dumbbell" in h.prop) {
        const grip = h.hand === "R" ? R : L;
        h.obj.position.copy(grip.at);
        h.obj.quaternion.setFromUnitVectors(X, grip.axis);
      } else if ("kettlebell" in h.prop) {
        h.obj.position.copy(L.at).add(R.at).multiplyScalar(0.5);
        if (h.prop.kettlebell === "swing" && shoulders) {
          // The bell carries on from the shoulders through the hands; the handle faces across.
          tmp.copy(h.obj.position).sub(shoulders).normalize();
          h.obj.quaternion.setFromUnitVectors(DOWN, tmp);
        } else {
          // Upright (it hangs), turned to face the line between the hands.
          tmp.copy(L.at).sub(R.at).setY(0);
          if (tmp.lengthSq() < 1e-6) tmp.copy(X);
          h.obj.quaternion.setFromUnitVectors(X, tmp.normalize());
        }
      }
    }
  };
  /** Place what stands still from the first pose: the bar where the hands hang from it. */
  const settle = (L: Grip, R: Grip) => {
    for (const b of bars) {
      tmp2.copy(L.at).add(R.at).multiplyScalar(0.5);
      b.obj.position.set(tmp2.x, b.height, tmp2.z);
      b.obj.quaternion.setFromUnitVectors(X, tmp.copy(L.at).sub(R.at).setY(0).normalize());
    }
  };
  const dispose = () => {
    for (const x of geos) x.dispose();
    steel.dispose();
    iron.dispose();
    pad.dispose();
  };
  return { group, boxes, held: held.length > 0, hold, settle, dispose };
}
