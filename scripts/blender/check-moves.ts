/**
 * Physics check for the 3D moves, on every key pose of every exercise (the export of
 * `bun scripts/blender/export.ts all both keys <dir>`):
 *
 * - Balance: the body's centre of mass (a standard segment model: head, trunk, arms, legs, with
 *   their usual share of the body's weight) plus the weight held must sit over what supports it:
 *   inside the outline of the feet, hands, knees or back on the floor or bench, or right below the
 *   hands when hanging from a bar.
 * - Contacts: every point a pose says touches (a foot, a hand, the back on the bench) must be at
 *   its height, within 3 cm, and a point on a bench must have the bench under it.
 *
 *   bun scripts/blender/check-moves.ts <dir>     (exits 1 when anything fails)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MOVES, type Pose } from "../../web/lib/moves.ts";

const dir = process.argv[2] ?? "keys";
type V3 = [number, number, number];
type XZ = [number, number];
const named = (n: string) => n.replace(/[.\[\]:/]/g, "");
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const lerp = (a: V3, b: V3, t: number): V3 => add(a, mul(sub(b, a), t));
const norm = (a: V3): V3 => mul(a, 1 / (Math.hypot(...a) || 1));
const mid = (a: V3, b: V3) => lerp(a, b, 0.5);

/** The centre of mass from the bones (Dempster/Winter segment shares and centres). */
function centreOfMass(B: (n: string) => V3): { at: V3; parts: number } {
  const parts: Array<[number, V3]> = [];
  const hipMid = mid(B("upperleg01.L"), B("upperleg01.R"));
  const head = B("head");
  parts.push([0.081, lerp(B("neck01"), head, 1.6)]);
  parts.push([0.497, lerp(hipMid, B("neck01"), 0.45)]);
  for (const s of ["L", "R"]) {
    const sh = B(`upperarm01.${s}`), el = B(`lowerarm01.${s}`), wr = B(`wrist.${s}`);
    const hip = B(`upperleg01.${s}`), kn = B(`lowerleg01.${s}`), an = B(`foot.${s}`), toe = B(`toe1-1.${s}`);
    parts.push([0.028, lerp(sh, el, 0.436)], [0.016, lerp(el, wr, 0.43)], [0.006, lerp(el, wr, 1.3)]);
    parts.push([0.1, lerp(hip, kn, 0.433)], [0.0465, lerp(kn, an, 0.433)], [0.0145, mid(an, toe)]);
  }
  let m = 0;
  let at: V3 = [0, 0, 0];
  for (const [w, p] of parts) {
    at = add(at, mul(p, w));
    m += w;
  }
  return { at: mul(at, 1 / m), parts: m };
}

/** Convex hull of points (x, z), anticlockwise. */
function hull(pts: XZ[]): XZ[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: XZ, a: XZ, b: XZ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: XZ[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: XZ[] = [];
  for (const q of [...p].reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop();
    up.push(q);
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}
/** How far (m) a point is outside a convex polygon (0 inside). */
function outside(p: XZ, poly: XZ[]): number {
  if (!poly.length) return Infinity;
  const seg = (a: XZ, b: XZ) => {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
  };
  if (poly.length < 3) return poly.length === 1 ? Math.hypot(p[0] - poly[0]![0], p[1] - poly[0]![1]) : seg(poly[0]!, poly[1]!);
  let inside = true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) inside = false;
  }
  if (inside) return 0;
  return Math.min(...poly.map((a, i) => seg(a, poly[(i + 1) % poly.length]!)));
}

/** Where each contact bone sits when it rests on the floor (moves.ts). */
const BASE: Record<string, number> = { foot: 0.077, "toe1-1": 0.034, wrist: 0.04, lowerleg01: 0.055, lowerarm01: 0.045 };

const kgOf = (props: NonNullable<(typeof MOVES)[string]["props"]>) =>
  props.reduce((n, p) => n + ("barbell" in p ? 20 + 2 * (p.plates ?? 20) : "dumbbell" in p ? (p.kg ?? 10) * (p.dumbbell === "both" ? 2 : 1) : "kettlebell" in p ? (p.kg ?? 16) : 0), 0);

let failures = 0;
const rows: string[] = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as { exercise: string; body: string; bones: Array<Record<string, V3>>; props: { frames: number[][] } };
  const move = MOVES[d.exercise];
  if (!move || !d.bones) continue;
  const bodyKg = d.body === "f" ? 62 : 75;
  const loadKg = kgOf(move.props ?? []);
  d.bones.forEach((bones, k) => {
    const B = (n: string) => bones[named(n)]!;
    const pose: Pose = move.poses[k] ?? move.poses[0]!;
    const contacts = pose.contacts ?? [];
    const issues: string[] = [];
    // Contacts at their height; on a bench, the bench under them.
    const propPts = d.props.frames[k] ?? [];
    const hasBox = (move.props ?? []).some((p) => "box" in p);
    /** The outline of the bench top under a point. */
    const benchTop = (p: V3): XZ[] => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < propPts.length; i += 3) {
        const y = propPts[i + 1]!;
        if (y > p[1] - 0.02 || y < p[1] - 0.25) continue;
        x0 = Math.min(x0, propPts[i]!); x1 = Math.max(x1, propPts[i]!);
        z0 = Math.min(z0, propPts[i + 2]!); z1 = Math.max(z1, propPts[i + 2]!);
      }
      return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    };
    /** On top of a bench or box: equipment within 25 cm below it, and inside that equipment's outline. */
    const onProp = (p: V3) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < propPts.length; i += 3) {
        const y = propPts[i + 1]!;
        if (y > p[1] - 0.02 || y < p[1] - 0.25) continue;
        x0 = Math.min(x0, propPts[i]!); x1 = Math.max(x1, propPts[i]!);
        z0 = Math.min(z0, propPts[i + 2]!); z1 = Math.max(z1, propPts[i + 2]!);
      }
      return p[0] > x0 - 0.04 && p[0] < x1 + 0.04 && p[2] > z0 - 0.04 && p[2] < z1 + 0.04;
    };
    for (const c of contacts) {
      const p = B(c.bone);
      if (!p) continue;
      const off = p[1] - c.height;
      if (Math.abs(off) > 0.03) issues.push(`${c.bone} ${off > 0 ? "floats" : "sinks"} ${Math.round(Math.abs(off) * 100)} cm`);
      if (hasBox && c.height > 0.2 && c.height < 1.5 && !onProp(p)) issues.push(`${c.bone} has no bench under it`);
    }
    // Balance.
    const com = centreOfMass(B).at;
    const wrists = mid(B("wrist.L"), B("wrist.R"));
    const total: V3 = mul(add(mul(com, bodyKg), mul(wrists, loadKg)), 1 / (bodyKg + loadKg));
    const hanging = contacts.some((c) => c.height > 1.5);
    // In the air (a jump, a hop): every contact above its resting height, and nothing to land on.
    const airborne = !hasBox && contacts.length > 0 && contacts.every((c) => c.height > (BASE[c.bone.replace(/\.[LR]$/, "")] ?? 0.1) + 0.05);
    // Support: whatever of the body rests on the floor (the feet heel to toe, else any part within
    // 13 cm of it: knees, hands, elbows, the back) or on a bench (then the bench's whole top).
    const support: XZ[] = [];
    for (const side of ["L", "R"]) {
      const an = B(`foot.${side}`), toe = B(`toe1-1.${side}`);
      const down = (q: V3) => q[1] < 0.1 || (hasBox && onProp(q));
      if (!down(an) && !(toe[1] < 0.065 || (hasBox && onProp(toe)))) continue;
      const dir = norm([toe[0] - an[0], 0, toe[2] - an[2]]);
      const across: V3 = [-dir[2] * 0.045, 0, dir[0] * 0.045];
      const pts = [...(down(an) ? [sub(an, mul(dir, 0.06))] : []), toe, add(toe, mul(dir, 0.05))];
      for (const q of pts) support.push([q[0] + across[0], q[2] + across[2]], [q[0] - across[0], q[2] - across[2]]);
    }
    for (const [name, p] of Object.entries(bones)) {
      if (/^(foot|toe)/.test(name)) continue;
      if (p[1] < 0.13) support.push([p[0] - 0.05, p[2]], [p[0] + 0.05, p[2]], [p[0], p[2] - 0.05], [p[0], p[2] + 0.05]);
      else if (hasBox && onProp(p)) support.push(...benchTop(p));
    }
    if (hanging) {
      const a = B("wrist.L"), b = B("wrist.R");
      const miss = outside([total[0], total[2]], [[a[0], a[2]], [b[0], b[2]]]);
      if (miss > 0.07) issues.push(`hangs ${Math.round(miss * 100)} cm off the bar's vertical`);
    } else if (!airborne && support.length) {
      const h = hull(support);
      const miss = outside([total[0], total[2]], h);
      if (miss > 0.03) {
        const cz = h.reduce((n, q) => n + q[1], 0) / h.length;
        issues.push(`centre of mass ${Math.round(miss * 100)} cm ${total[2] > cz ? "ahead of" : "behind"} its support`);
      }
    }
    if (issues.length) {
      failures++;
      rows.push(`${d.exercise}-${d.body} pose ${k}: ${issues.join("; ")}`);
    }
  });
}
console.log(rows.length ? rows.join("\n") : "All key poses balanced, every contact touching.");
process.exit(failures ? 1 : 0);
