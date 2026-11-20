/**
 * The exercise figures: a jointed figure seen from the side (facing right), drawn as rounded
 * strokes in the brand's colours, moving through a few key poses and back, looped. Each pose
 * gives the angle of every limb (0° points down, 90° forward, 180° up, −90° back) and where the
 * pelvis is, or which ankle stands where (the pelvis then follows from the leg). The far arm and
 * leg are drawn behind, a shade lighter, for depth.
 */

type Deg = number;
export interface Pose {
  /** The pelvis, or a planted ankle that places it. */
  root?: [number, number];
  ground?: { leg: "near" | "far"; at: [number, number] };
  trunk: Deg;
  head?: Deg;
  thighN: Deg;
  shinN: Deg;
  footN?: Deg;
  thighF?: Deg;
  shinF?: Deg;
  footF?: Deg;
  armN: Deg;
  foreN: Deg;
  armF?: Deg;
  foreF?: Deg;
}
interface Anim {
  poses: Pose[];
  /** Seconds per move between two poses, and the hold at each. */
  move: number;
  hold: number;
  /** Props drawn with the figure. */
  props?: Array<"floor" | "bench" | "dumbbell" | "mat">;
}

const L = { trunk: 50, neck: 7, head: 9.5, thigh: 42, shin: 40, foot: 13, arm: 27, fore: 25 };
const FLOOR = 176;
const rad = (d: Deg) => (d * Math.PI) / 180;
const step = (p: [number, number], a: Deg, len: number): [number, number] => [p[0] + Math.sin(rad(a)) * len, p[1] + Math.cos(rad(a)) * len];

const stand: Pose = { ground: { leg: "near", at: [118, FLOOR - 4] }, trunk: 180, thighN: 0, shinN: 0, footN: 90, thighF: 0, shinF: 0, footF: 90, armN: 6, foreN: 10, armF: -4, foreF: 2 };

export const ANIMS: Record<string, Anim> = {
  squat: {
    move: 1.1, hold: 0.25, props: ["floor"],
    poses: [
      { ...stand, armN: 70, foreN: 88, armF: 70, foreF: 88 },
      { ...stand, trunk: 145, thighN: 82, shinN: -32, thighF: 82, shinF: -32, armN: 92, foreN: 92, armF: 92, foreF: 92 },
    ],
  },
  goblet_squat: {
    move: 1.2, hold: 0.25, props: ["floor", "dumbbell"],
    poses: [
      { ...stand, armN: 20, foreN: 165, armF: 20, foreF: 165 },
      { ...stand, trunk: 150, thighN: 84, shinN: -32, thighF: 84, shinF: -32, armN: 30, foreN: 170, armF: 30, foreF: 170 },
    ],
  },
  jump_squat: {
    move: 0.45, hold: 0.1, props: ["floor"],
    poses: [
      { ...stand, trunk: 150, thighN: 70, shinN: -28, thighF: 70, shinF: -28, armN: -20, foreN: -10, armF: -20, foreF: -10 },
      { ...stand, ground: { leg: "near", at: [118, FLOOR - 26] }, footN: 30, footF: 30, armN: 148, foreN: 155, armF: 148, foreF: 155 },
      { ...stand, trunk: 150, thighN: 70, shinN: -28, thighF: 70, shinF: -28, armN: -20, foreN: -10, armF: -20, foreF: -10 },
    ],
  },
  reverse_lunge: {
    move: 1.0, hold: 0.3, props: ["floor"],
    poses: [
      { ...stand, ground: { leg: "near", at: [128, FLOOR - 4] }, armN: 30, foreN: 140, armF: 30, foreF: 140 },
      { ...stand, ground: { leg: "near", at: [128, FLOOR - 4] }, trunk: 176, thighN: 84, shinN: -4, thighF: -22, shinF: -100, footF: -10, armN: 30, foreN: 140, armF: 30, foreF: 140 },
    ],
  },
  split_squat: {
    move: 1.1, hold: 0.3, props: ["floor", "bench"],
    poses: [
      { ...stand, ground: { leg: "near", at: [138, FLOOR - 4] }, trunk: 178, thighN: 22, shinN: -10, thighF: -28, shinF: -78, footF: -150, armN: 4, foreN: 4, armF: 4, foreF: 4 },
      { ...stand, ground: { leg: "near", at: [138, FLOOR - 4] }, trunk: 172, thighN: 80, shinN: -8, thighF: -8, shinF: -64, footF: -150, armN: 4, foreN: 4, armF: 4, foreF: 4 },
    ],
  },
  single_leg_rdl: {
    move: 1.3, hold: 0.3, props: ["floor"],
    poses: [
      { ...stand, ground: { leg: "near", at: [122, FLOOR - 4] }, thighF: -6, shinF: 10, footF: 60, armN: 2, foreN: 2, armF: 2, foreF: 2 },
      { ...stand, ground: { leg: "near", at: [122, FLOOR - 4] }, trunk: 98, thighN: 10, shinN: -4, thighF: -82, shinF: -82, footF: 0, armN: 2, foreN: 0, armF: -6, foreF: -4 },
    ],
  },
  rdl: {
    move: 1.3, hold: 0.25, props: ["floor", "dumbbell"],
    poses: [
      { ...stand, armN: 4, foreN: 4, armF: 4, foreF: 4 },
      { ...stand, trunk: 108, thighN: 18, shinN: -6, thighF: 18, shinF: -6, armN: 2, foreN: 0, armF: 2, foreF: 0 },
    ],
  },
  glute_bridge: {
    move: 1.0, hold: 0.5, props: ["floor", "mat"],
    poses: [
      { root: [120, FLOOR - 8], trunk: -90, thighN: 145, shinN: 25, footN: 90, thighF: 145, shinF: 25, footF: 90, armN: 92, foreN: 90, armF: 92, foreF: 90 },
      { root: [120, FLOOR - 36], trunk: -58, thighN: 98, shinN: 0, footN: 90, thighF: 98, shinF: 0, footF: 90, armN: 92, foreN: 90, armF: 92, foreF: 90 },
    ],
  },
  single_leg_bridge: {
    move: 1.0, hold: 0.5, props: ["floor", "mat"],
    poses: [
      { root: [120, FLOOR - 8], trunk: -90, thighN: 145, shinN: 25, footN: 90, thighF: 130, shinF: 130, footF: 150, armN: 92, foreN: 90, armF: 92, foreF: 90 },
      { root: [120, FLOOR - 36], trunk: -58, thighN: 98, shinN: 0, footN: 90, thighF: 98, shinF: 98, footF: 150, armN: 92, foreN: 90, armF: 92, foreF: 90 },
    ],
  },
  calf_raise: {
    move: 0.9, hold: 0.35, props: ["floor"],
    poses: [
      { ...stand, root: [118, FLOOR - 4 - 82], ground: undefined },
      { ...stand, root: [118, FLOOR - 4 - 82 - 9], ground: undefined, footN: 42, footF: 42 },
    ],
  },
  single_leg_calf_raise: {
    move: 0.9, hold: 0.35, props: ["floor"],
    poses: [
      { ...stand, root: [118, FLOOR - 4 - 82], ground: undefined, thighF: 20, shinF: -70, armN: 60, foreN: 85 },
      { ...stand, root: [118, FLOOR - 4 - 82 - 9], ground: undefined, footN: 42, thighF: 20, shinF: -70, armN: 60, foreN: 85 },
    ],
  },
  pogo_hops: {
    move: 0.22, hold: 0.04, props: ["floor"],
    poses: [
      { ...stand, root: [118, FLOOR - 4 - 82 - 4], ground: undefined, footN: 50, footF: 50, armN: 20, foreN: 100, armF: 20, foreF: 100 },
      { ...stand, root: [118, FLOOR - 4 - 82 - 18], ground: undefined, footN: 35, footF: 35, armN: 24, foreN: 104, armF: 24, foreF: 104 },
    ],
  },
  plank: {
    move: 1.6, hold: 0.2, props: ["floor", "mat"],
    poses: [
      { root: [115, 148], trunk: 95, thighN: -85, shinN: -85, footN: 0, thighF: -85, shinF: -85, footF: 0, armN: 0, foreN: 90, armF: 0, foreF: 90 },
      { root: [115, 145], trunk: 96, thighN: -86, shinN: -86, footN: 2, thighF: -86, shinF: -86, footF: 2, armN: 0, foreN: 90, armF: 0, foreF: 90 },
    ],
  },
  push_up: {
    move: 0.9, hold: 0.2, props: ["floor"],
    poses: [
      { root: [124, 141], trunk: 112, thighN: -68, shinN: -68, footN: -10, thighF: -68, shinF: -68, footF: -10, armN: 4, foreN: 4, armF: 4, foreF: 4 },
      { root: [116, 163], trunk: 98, thighN: -82, shinN: -82, footN: -20, thighF: -82, shinF: -82, footF: -20, armN: -58, foreN: 80, armF: -58, foreF: 80 },
    ],
  },
  dead_bug: {
    move: 1.1, hold: 0.3, props: ["floor", "mat"],
    poses: [
      { root: [124, FLOOR - 8], trunk: -90, thighN: 180, shinN: 90, footN: 160, thighF: 180, shinF: 90, footF: 160, armN: 180, foreN: 180, armF: 180, foreF: 180 },
      { root: [124, FLOOR - 8], trunk: -90, thighN: 100, shinN: 96, footN: 150, thighF: 180, shinF: 90, footF: 160, armN: 180, foreN: 180, armF: -105, foreF: -100 },
      { root: [124, FLOOR - 8], trunk: -90, thighN: 180, shinN: 90, footN: 160, thighF: 180, shinF: 90, footF: 160, armN: 180, foreN: 180, armF: 180, foreF: 180 },
      { root: [124, FLOOR - 8], trunk: -90, thighN: 180, shinN: 90, footN: 160, thighF: 100, shinF: 96, footF: 150, armN: -105, foreN: -100, armF: 180, foreF: 180 },
    ],
  },
  bird_dog: {
    move: 1.1, hold: 0.35, props: ["floor", "mat"],
    poses: [
      { root: [100, 128], trunk: 97, thighN: 0, shinN: -88, footN: -170, thighF: 0, shinF: -88, footF: -170, armN: 0, foreN: 0, armF: 0, foreF: 0 },
      { root: [100, 128], trunk: 96, thighN: 0, shinN: -88, footN: -170, thighF: -93, shinF: -93, footF: -150, armN: 96, foreN: 96, armF: 0, foreF: 0 },
      { root: [100, 128], trunk: 97, thighN: 0, shinN: -88, footN: -170, thighF: 0, shinF: -88, footF: -170, armN: 0, foreN: 0, armF: 0, foreF: 0 },
      { root: [100, 128], trunk: 96, thighN: -93, shinN: -93, footN: -150, thighF: 0, shinF: -88, footF: -170, armN: 0, foreN: 0, armF: 96, foreF: 96 },
    ],
  },
  hip_flexor_stretch: {
    move: 1.6, hold: 0.8, props: ["floor", "mat"],
    poses: [
      { ...stand, ground: { leg: "near", at: [140, FLOOR - 4] }, trunk: 180, thighN: 70, shinN: -6, thighF: -20, shinF: -92, footF: -170, armN: 20, foreN: 150, armF: 20, foreF: 150 },
      { ...stand, ground: { leg: "near", at: [140, FLOOR - 4] }, trunk: 184, thighN: 82, shinN: 12, thighF: -38, shinF: -96, footF: -170, armN: 175, foreN: 178, armF: 175, foreF: 178 },
    ],
  },
};

/** Joint positions for a pose. */
function joints(p: Pose) {
  const thighF = p.thighF ?? p.thighN;
  const shinF = p.shinF ?? p.shinN;
  let pelvis: [number, number];
  if (p.root) pelvis = p.root;
  else {
    const g = p.ground!;
    const [t, s] = g.leg === "near" ? [p.thighN, p.shinN] : [thighF, shinF];
    // From the planted ankle back up the leg.
    const knee = step(g.at, s + 180, L.shin);
    pelvis = step(knee, t + 180, L.thigh);
  }
  const shoulder = step(pelvis, p.trunk, L.trunk);
  const neck = step(shoulder, p.head ?? p.trunk, L.neck);
  const head = step(neck, p.head ?? p.trunk, L.head);
  const leg = (t: Deg, s: Deg, f: Deg) => {
    const knee = step(pelvis, t, L.thigh);
    const ankle = step(knee, s, L.shin);
    return [pelvis, knee, ankle, step(ankle, f, L.foot)] as const;
  };
  const arm = (a: Deg, f: Deg) => {
    const elbow = step(shoulder, a, L.arm);
    return [shoulder, elbow, step(elbow, f, L.fore)] as const;
  };
  return {
    pelvis, shoulder, neck, head,
    legN: leg(p.thighN, p.shinN, p.footN ?? 90),
    legF: leg(thighF, shinF, p.footF ?? p.footN ?? 90),
    armN: arm(p.armN, p.foreN),
    armF: arm(p.armF ?? p.armN, p.foreF ?? p.foreN),
  };
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const mixAngle = (a: number, b: number, t: number) => {
  // The short way round.
  let d = ((b - a + 540) % 360) - 180;
  if (d === -180) d = 180;
  return a + d * t;
};
function mix(a: Pose, b: Pose, t: number): Pose {
  const n = (x?: number, y?: number) => (x === undefined || y === undefined ? (x ?? y) : mixAngle(x, y, t));
  const pt = (x?: [number, number], y?: [number, number]) => (x && y ? ([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t] as [number, number]) : (x ?? y));
  const out: Pose = {
    trunk: n(a.trunk, b.trunk)!, head: n(a.head, b.head), thighN: n(a.thighN, b.thighN)!, shinN: n(a.shinN, b.shinN)!, footN: n(a.footN, b.footN),
    thighF: n(a.thighF, b.thighF), shinF: n(a.shinF, b.shinF), footF: n(a.footF, b.footF), armN: n(a.armN, b.armN)!, foreN: n(a.foreN, b.foreN)!, armF: n(a.armF, b.armF), foreF: n(a.foreF, b.foreF),
  };
  if (a.root || b.root) out.root = pt(a.root ?? joints(a).pelvis, b.root ?? joints(b).pelvis);
  else out.ground = { leg: a.ground!.leg, at: pt(a.ground!.at, b.ground!.at)! };
  return out;
}

/** The pose at time t (s) of a looping animation: there through each pose and back. */
export function poseAt(anim: Anim, t: number): Pose {
  const ps = anim.poses;
  // A ping-pong of two poses, or a cycle through more (dead bug, bird dog).
  const seq = ps.length === 2 ? [ps[0]!, ps[1]!] : ps;
  const seg = anim.move + anim.hold;
  const total = seg * seq.length;
  const tt = ((t % total) + total) % total;
  const i = Math.floor(tt / seg);
  const into = tt - i * seg;
  const a = seq[i]!;
  const b = seq[(i + 1) % seq.length]!;
  if (into < anim.hold) return a;
  return mix(a, b, ease((into - anim.hold) / anim.move));
}

const NS = "http://www.w3.org/2000/svg";
const f1 = (n: number) => n.toFixed(1);
const path = (pts: ReadonlyArray<readonly [number, number]>) => pts.map((p, i) => `${i ? "L" : "M"}${f1(p[0])} ${f1(p[1])}`).join("");

/**
 * An exercise's figure as an SVG, looping while it's on screen (a still of its key pose when the
 * phone asks for reduced motion, or `still` is set).
 */
export function exerciseFigure(id: string, o: { still?: boolean; pose?: number; label?: string } = {}): SVGSVGElement {
  // The gym lifts have only the 3D body (web/lib/body3d.ts); without 3D they show a still figure.
  const anim = ANIMS[id] ?? ANIMS.squat!;
  if (!ANIMS[id]) o = { ...o, still: true };
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 240 190");
  svg.setAttribute("class", "fig");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", o.label ?? "How to do it");
  const props = anim.props ?? ["floor"];
  const deco = [
    props.includes("mat") ? `<rect class="fig-mat" x="20" y="${FLOOR - 1}" width="200" height="5" rx="2.5"/>` : "",
    props.includes("floor") ? `<path class="fig-floor" d="M8 ${FLOOR + 4}H232"/>` : "",
    props.includes("bench") ? `<rect class="fig-bench" x="30" y="${FLOOR - 46}" width="48" height="10" rx="4"/><path class="fig-bench-leg" d="M40 ${FLOOR - 36}V${FLOOR + 3}M68 ${FLOOR - 36}V${FLOOR + 3}"/>` : "",
  ].join("");
  svg.innerHTML = `${deco}<g class="fig-far"><path class="fig-leg"/><path class="fig-arm"/></g><g class="fig-near"><path class="fig-trunk"/><path class="fig-leg"/><circle class="fig-head" r="${L.head}"/><path class="fig-arm"/>${props.includes("dumbbell") ? `<g class="fig-db"><rect x="-9" y="-3.5" width="18" height="7" rx="3.5"/></g>` : ""}</g>`;
  const far = svg.querySelector(".fig-far")!;
  const near = svg.querySelector(".fig-near")!;
  const draw = (p: Pose) => {
    const j = joints(p);
    far.querySelector(".fig-leg")!.setAttribute("d", path(j.legF));
    far.querySelector(".fig-arm")!.setAttribute("d", path(j.armF));
    near.querySelector(".fig-trunk")!.setAttribute("d", path([j.pelvis, j.shoulder, j.neck]));
    near.querySelector(".fig-leg")!.setAttribute("d", path(j.legN));
    near.querySelector(".fig-arm")!.setAttribute("d", path(j.armN));
    const h = near.querySelector(".fig-head")!;
    h.setAttribute("cx", f1(j.head[0]));
    h.setAttribute("cy", f1(j.head[1]));
    const db = near.querySelector(".fig-db");
    if (db) db.setAttribute("transform", `translate(${f1(j.armN[2][0])} ${f1(j.armN[2][1])})`);
  };
  const still = o.still || matchMedia("(prefers-reduced-motion: reduce)").matches;
  draw(still ? anim.poses[o.pose ?? Math.min(1, anim.poses.length - 1)]! : anim.poses[0]!);
  if (still) return svg;
  // Runs only while the figure is in the page and on screen.
  let frame = 0;
  let seen = false;
  const t0 = performance.now();
  const tick = (now: number) => {
    if (!svg.isConnected) return void (frame = 0);
    if (seen) draw(poseAt(anim, (now - t0) / 1000));
    frame = requestAnimationFrame(tick);
  };
  new IntersectionObserver(([e]) => {
    seen = !!e?.isIntersecting;
    if (seen && !frame && svg.isConnected) frame = requestAnimationFrame(tick);
  }).observe(svg);
  frame = requestAnimationFrame(tick);
  return svg;
}
