/**
 * How the body moves in each exercise (web/lib/body3d.ts): key poses written as joint angles in
 * degrees, the way a coach would describe them (hip flexion, knee bend, ankle, spine, shoulder,
 * elbow), clamped to natural ranges and turned into bone rotations for the body built by
 * scripts/build-body.py (every bone's rest rotation is the identity, +Z forward, +Y up, the
 * left side on +X). What touches the floor is named per pose and kept there.
 */

export interface Pose {
  /** Bone → rotation in degrees about its own x, y, z (applied z, x, then y), or about an axis (a hinge). */
  joints: Record<string, [number, number, number] | { axis: [number, number, number]; deg: number }>;
  /** The whole body's rotation (lying down, leaning into a plank). */
  root?: [number, number, number];
  /** Moves the body, metres. */
  shift?: [number, number, number];
  /**
   * What rests on the floor: the lowest is put on it; locked ones also keep their place. A
   * `rest` contact bears no weight (a hand lying beside the body): only its limb reaches down to it.
   */
  contacts?: Array<{ bone: string; height: number; lock?: boolean; rest?: boolean }>;
  /** The fingers, per hand (body3d's morph targets): relax.L/R and grip.L/R, 0 to 1. */
  hands?: Record<string, number>;
}

/** What the body holds or uses. A held weight follows the hands' grip; the rest stands on the floor. */
export type Prop =
  /** A bench, box or step of [width, height, depth] at [x, 0, z]; `under` a bone: where that bone rests in the first pose (offset by `at`, its height too), its top just below it. */
  | { box: [number, number, number]; at: [number, number, number]; under?: string }
  /** A barbell through both hands' grip (`plates`: kg a side, for the plates' size). */
  | { barbell: true; plates?: number }
  /** A dumbbell in one hand or each. */
  | { dumbbell: "L" | "R" | "both"; kg?: number }
  /** A kettlebell held in both hands: hanging below them (a goblet hold), or "swing": the bell carries on the arms' line. */
  | { kettlebell: true | "swing"; kg?: number }
  /** A bar to hang from, at this height, across the body. */
  | { pullupBar: number };
export interface Move {
  poses: Pose[];
  /** Seconds between poses, and held at each. */
  move: number;
  hold: number;
  /** Camera: angle round the body (0 front, 90 side), distance (× the fitted one), height looked at; still pose index. */
  angle?: number;
  /** Camera height, degrees above level (default 4.6). */
  pitch?: number;
  distance?: number;
  focusY?: number;
  /** Look at this point, or this bone in the still pose, instead of the middle of the body (close-ups). */
  focus?: [number, number, number] | string;
  still?: number;
  /**
   * Things in the scene: a box (a bench, a step) of [width, height, depth] standing at [x, 0, z];
   * `under` a bone, it stands where that bone rests in the first pose (offset by `at`), its top
   * just below it.
   */
  props?: Prop[];
}

type Side = "L" | "R";
interface Limb {
  hip?: { flex?: number; abd?: number; rot?: number };
  knee?: number;
  /** Positive: toes up (dorsiflexion); negative: pointed. */
  ankle?: number;
  /** The toes bent up at the ball of the foot (on tiptoe the foot rises, the toes stay flat). */
  toes?: number;
  /** flex forward, abd out to the side, rot about the vertical, twist: outward about the upper arm's own axis. */
  shoulder?: { flex?: number; abd?: number; rot?: number; twist?: number };
  elbow?: number;
  /** The hand bent back (flat on the floor in a push-up). */
  wrist?: number;
  /** The forearm turned palm-down (pronation, positive) or palm-up, degrees from the rest pose's palm-in. */
  palm?: number;
  /** The fingers: "grip" round a bar or handle, "open" flat (on the floor); relaxed and a little curled by default. */
  hand?: "grip" | "open" | "relaxed";
}
export interface Body {
  /** flex bends the whole spine from the bottom up; curl bends only its upper part (a crunch). */
  spine?: { flex?: number; curl?: number; side?: number; twist?: number };
  neck?: number;
  L?: Limb;
  R?: Limb;
  root?: [number, number, number];
  shift?: [number, number, number];
  contacts?: Pose["contacts"];
}

/** Natural ranges, degrees. */
const LIMIT = {
  hipFlex: [-30, 135], hipAbd: [-30, 60], knee: [0, 150], ankle: [-50, 30],
  spineFlex: [-35, 95], shoulderFlex: [-60, 180], shoulderAbd: [-10, 180], elbow: [0, 150],
} as const;
const clamp = (x: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, x));

// The model's rest pose is an A-pose with the legs a little apart: the neutral stance brings
// the arms to the sides and the feet under the hips. In it the upper arm hangs 38.5° out from
// vertical and the elbow is already bent 47°, about a hinge square to the arm in the frontal
// plane (measured from the skeleton).
const REST = { hipAbd: -6, shoulderAbd: -38, elbow: 47 };
const ELBOW_AXIS = { x: Math.cos((38.5 * Math.PI) / 180), y: Math.sin((38.5 * Math.PI) / 180) };
/** The upper arm's own axis in the rest pose (shoulder towards elbow, left side), for its twist. */
const UPPER_ARM_AXIS: [number, number, number] = [0.148, -0.186, -0.003];
/** The forearm's own axis in the rest pose (elbow towards wrist, left side), for turning the palm. */
const FOREARM_AXIS: [number, number, number] = [0.063, -0.056, 0.088];

/** A pose from joint angles. */
export function pose(b: Body): Pose {
  const j: Pose["joints"] = {};
  const sp = b.spine ?? {};
  const flex = clamp(sp.flex ?? 0, LIMIT.spineFlex);
  for (const [bone, share] of [["spine05", 0.2], ["spine04", 0.25], ["spine03", 0.25], ["spine02", 0.2], ["spine01", 0.1]] as const) {
    const curl = (sp.curl ?? 0) * ({ spine03: 0.2, spine02: 0.4, spine01: 0.4 } as Record<string, number>)[bone]! || 0;
    j[bone] = [flex * share + curl, (sp.twist ?? 0) * share, (sp.side ?? 0) * share];
  }
  j.neck01 = [(b.neck ?? 0) * 0.6, 0, 0];
  j.neck02 = [(b.neck ?? 0) * 0.4, 0, 0];
  for (const s of ["L", "R"] as Side[]) {
    const l = b[s] ?? {};
    const sign = s === "L" ? 1 : -1;
    const hf = clamp(l.hip?.flex ?? 0, LIMIT.hipFlex);
    const ha = clamp(l.hip?.abd ?? 0, LIMIT.hipAbd) + REST.hipAbd;
    j[`upperleg01.${s}`] = [-hf, (l.hip?.rot ?? 0) * sign, ha * sign];
    j[`lowerleg01.${s}`] = [clamp(l.knee ?? 0, LIMIT.knee), 0, -REST.hipAbd * sign * 0.5];
    j[`foot.${s}`] = [-clamp(l.ankle ?? 0, LIMIT.ankle), 0, 0];
    if (l.toes) j[`toe1-1.${s}`] = [-Math.max(0, Math.min(60, l.toes)), 0, 0];
    const sf = clamp(l.shoulder?.flex ?? 0, LIMIT.shoulderFlex);
    const sa = clamp(l.shoulder?.abd ?? 0, LIMIT.shoulderAbd) + REST.shoulderAbd;
    j[`upperarm01.${s}`] = [-sf, (l.shoulder?.rot ?? 0) * sign, sa * sign];
    if (l.wrist) j[`wrist.${s}`] = [-Math.max(-60, Math.min(90, l.wrist)), 0, 0];
    if (l.shoulder?.twist) j[`upperarm02.${s}`] = { axis: [UPPER_ARM_AXIS[0] * sign, UPPER_ARM_AXIS[1], UPPER_ARM_AXIS[2]], deg: -Math.max(-90, Math.min(90, l.shoulder.twist)) * sign };
    if (l.palm) j[`lowerarm02.${s}`] = { axis: [FOREARM_AXIS[0] * sign, FOREARM_AXIS[1], FOREARM_AXIS[2]], deg: Math.max(-90, Math.min(90, l.palm)) * sign };
    // Positive about the hinge straightens (the forearm swings back): REST.elbow straightens it fully.
    j[`lowerarm01.${s}`] = { axis: [ELBOW_AXIS.x, ELBOW_AXIS.y * sign, 0], deg: REST.elbow - clamp(l.elbow ?? 0, LIMIT.elbow) };
  }
  const hands: Record<string, number> = {};
  for (const s of ["L", "R"] as Side[]) {
    const h = b[s]?.hand ?? "relaxed";
    hands[`relax.${s}`] = h === "relaxed" ? 1 : 0;
    hands[`grip.${s}`] = h === "grip" ? 1 : 0;
  }
  return { joints: j, root: b.root, shift: b.shift, contacts: b.contacts, hands };
}

// What can touch the floor, and how high its bone sits when it does (metres).
const FOOT = 0.077;
const TOE = 0.034;
const KNEE = 0.055;
const ELBOW = 0.045;
const WRIST = 0.04;
const BACK = 0.1;
const on = (bone: string, height: number, lock = true) => ({ bone, height, lock });
/** A hand lying on the floor beside the body, palm down: it bears no weight. */
const lying = (side: "L" | "R") => ({ bone: `wrist.${side}`, height: WRIST, rest: true });
const FEET: Pose["contacts"] = [on("foot.L", FOOT), on("foot.R", FOOT)];
const TOES: Pose["contacts"] = [on("toe1-1.L", TOE), on("toe1-1.R", TOE)];
const both = (l: Limb): Pick<Body, "L" | "R"> => ({ L: l, R: l });
const stand = (b: Body = {}): Pose => pose({ contacts: FEET, ...b });
/** Lying on the back (head towards -z), face down (head towards +z, tilted by `incline`), on all fours. */
const SUPINE: Body["root"] = [-90, 0, 0];
const prone = (incline = 0): Body["root"] => [90 - incline, 0, 0];

// A squat's depth, shared by the squat family.
const squatBottom = (deep = 1): Body => ({
  spine: { flex: 22 * deep },
  ...both({ hip: { flex: 100 * deep, abd: 10 }, knee: 112 * deep, ankle: 26 * deep }),
});
const arms = (shoulder: NonNullable<Limb["shoulder"]>, elbow = 0) => ({ shoulder, elbow });
const merge = (b: Body, side: "L" | "R", l: Limb): Body => ({ ...b, [side]: { ...b[side], ...l } });

export const MOVES: Record<string, Move> = {
  stand: { move: 1, hold: 1, poses: [stand()] },

  squat: {
    move: 1.3, hold: 0.35, angle: 35, still: 1,
    poses: [stand(both({ ...arms({ flex: 72 }, 10), palm: 70 })), stand(merge(merge(squatBottom(), "L", { ...arms({ flex: 104 }, 10), palm: 70 }), "R", { ...arms({ flex: 104 }, 10), palm: 70 }))],
  },
  goblet_squat: {
    move: 1.4, hold: 0.35, angle: 35, still: 1,
    props: [{ kettlebell: true, kg: 16 }],
    poses: [
      stand(both({ ...arms({ flex: 12, rot: -38 }, 122), hand: "grip" })),
      stand(merge(merge(squatBottom(1.08), "L", { ...arms({ flex: 26, rot: -38 }, 120), hand: "grip" }), "R", { ...arms({ flex: 26, rot: -38 }, 120), hand: "grip" })),
    ],
  },
  reverse_lunge: {
    move: 1.3, hold: 0.3, angle: 70, still: 1,
    poses: [
      stand(),
      pose({ spine: { flex: 6 }, L: { hip: { flex: 88 }, knee: 92, ankle: 18 }, R: { hip: { flex: -18 }, knee: 98, ankle: -30 }, contacts: [on("foot.L", FOOT), on("toe1-1.R", TOE, false)] }),
    ],
  },
  split_squat: {
    move: 1.4, hold: 0.3, angle: 70, still: 1,
    // The rear foot rests laces-down on the bench (its toes held there), the front foot flat.
    props: [{ box: [0.42, 0.42, 0.36], at: [0, 0, -0.04], under: "toe1-1.R" }],
    poses: [
      pose({ L: { hip: { flex: 30 }, knee: 12, ankle: 4 }, R: { hip: { flex: -32 }, knee: 75, ankle: -35 }, contacts: [on("foot.L", FOOT), on("toe1-1.R", 0.47)] }),
      pose({ spine: { flex: 3 }, L: { hip: { flex: 92 }, knee: 98, ankle: 22 }, R: { hip: { flex: -14 }, knee: 112, ankle: -35 }, contacts: [on("foot.L", FOOT), on("toe1-1.R", 0.47)] }),
    ],
  },
  single_leg_rdl: {
    move: 1.6, hold: 0.4, angle: 80, still: 1,
    poses: [
      pose({ L: { knee: 6 }, R: { hip: { flex: 5 }, knee: 25 }, contacts: [on("foot.L", FOOT)] }),
      pose({ root: [72, 0, 0], L: { hip: { flex: 80 }, knee: 16, ankle: 6, shoulder: { flex: 72 } }, R: { hip: { flex: -2 }, knee: 4, ankle: -20, shoulder: { flex: 72 } }, contacts: [on("foot.L", FOOT)] }),
    ],
  },
  rdl: {
    move: 1.5, hold: 0.35, angle: 70, still: 1,
    props: [{ barbell: true, plates: 15 }],
    poses: [
      stand(both({ shoulder: { flex: 4, abd: 6 }, palm: 90, hand: "grip" })),
      stand({ root: [66, 0, 0], spine: { flex: 4 }, ...both({ hip: { flex: 84 }, knee: 20, ankle: 2, shoulder: { flex: 66, abd: 6 }, palm: 90, hand: "grip" }) }),
    ],
  },
  glute_bridge: {
    move: 1.1, hold: 0.6, angle: 75, still: 1,
    poses: [
      pose({ root: SUPINE, ...both({ hip: { flex: 50 }, knee: 112, ankle: 0, shoulder: { flex: -14 }, palm: 90, hand: "open" }), contacts: [on("foot.L", FOOT), on("foot.R", FOOT), on("spine04", BACK, false), lying("L"), lying("R")] }),
      pose({ root: [-116, 0, 0], neck: 48, ...both({ hip: { flex: 0 }, knee: 116, ankle: 0, shoulder: { flex: -42 }, palm: 90, hand: "open" }), contacts: [on("foot.L", FOOT), on("foot.R", FOOT), on("spine01", BACK, false), lying("L"), lying("R")] }),
    ],
  },
  single_leg_bridge: {
    move: 1.1, hold: 0.6, angle: 75, still: 1,
    poses: [
      pose({ root: SUPINE, L: { hip: { flex: 50 }, knee: 112, shoulder: { flex: -14 }, palm: 90, hand: "open" }, R: { hip: { flex: 50 }, knee: 6, shoulder: { flex: -14 }, palm: 90, hand: "open" }, contacts: [on("foot.L", FOOT), on("spine04", BACK, false), lying("L"), lying("R")] }),
      pose({ root: [-116, 0, 0], neck: 48, L: { hip: { flex: 0 }, knee: 116, ankle: 0, shoulder: { flex: -42 }, palm: 90, hand: "open" }, R: { hip: { flex: 0 }, knee: 4, shoulder: { flex: -42 }, palm: 90, hand: "open" }, contacts: [on("foot.L", FOOT), on("spine01", BACK, false), lying("L"), lying("R")] }),
    ],
  },
  calf_raise: {
    move: 0.8, hold: 0.5, angle: 70, still: 1,
    poses: [stand(), stand({ ...both({ ankle: -38, toes: 38, knee: 2 }), contacts: TOES })],
  },
  single_leg_calf_raise: {
    move: 0.8, hold: 0.5, angle: 70, still: 1,
    poses: [
      pose({ R: { hip: { flex: 8 }, knee: 75 }, contacts: [on("foot.L", FOOT)] }),
      pose({ L: { ankle: -38, toes: 38, knee: 2 }, R: { hip: { flex: 8 }, knee: 75 }, contacts: [on("toe1-1.L", TOE)] }),
    ],
  },
  plank: {
    move: 2.2, hold: 0.8, angle: 80, still: 0,
    poses: [
      pose({ root: prone(5), ...both({ hip: { flex: 2 }, ankle: 20, toes: 30, shoulder: { flex: 85 }, elbow: 93, palm: 90, wrist: 14, hand: "open" }), contacts: [on("lowerarm01.L", ELBOW), on("lowerarm01.R", ELBOW), ...TOES] }),
      pose({ root: prone(6), ...both({ hip: { flex: 4 }, ankle: 20, toes: 30, shoulder: { flex: 84 }, elbow: 93, palm: 90, wrist: 14, hand: "open" }), contacts: [on("lowerarm01.L", ELBOW), on("lowerarm01.R", ELBOW), ...TOES] }),
    ],
  },
  push_up: {
    move: 1.1, hold: 0.25, angle: 80, still: 1,
    poses: [
      pose({ root: prone(24), ...both({ ankle: 22, toes: 30, shoulder: { flex: 66, abd: 4 }, elbow: 2, wrist: 64, palm: 90, hand: "open" }), contacts: [on("wrist.L", WRIST), on("wrist.R", WRIST), on("toe1-1.L", TOE, false), on("toe1-1.R", TOE, false)] }),
      pose({ root: prone(8), ...both({ ankle: 18, toes: 30, shoulder: { flex: 20, abd: 12 }, elbow: 100, wrist: 80, palm: 90, hand: "open" }), contacts: [on("wrist.L", WRIST), on("wrist.R", WRIST), on("toe1-1.L", TOE, false), on("toe1-1.R", TOE, false)] }),
    ],
  },
  dead_bug: {
    move: 1.2, hold: 0.4, angle: 65, still: 1,
    poses: (() => {
      const base: Body = { root: SUPINE, ...both({ hip: { flex: 90 }, knee: 90, ankle: -10, shoulder: { flex: 90 } }), contacts: [on("spine03", BACK)] };
      return [
        pose(base),
        pose({ ...base, L: { ...base.L, shoulder: { flex: 170 } }, R: { ...base.R, hip: { flex: 18 }, knee: 8, ankle: -20 } }),
        pose(base),
        pose({ ...base, R: { ...base.R, shoulder: { flex: 170 } }, L: { ...base.L, hip: { flex: 18 }, knee: 8, ankle: -20 } }),
      ];
    })(),
  },
  bird_dog: {
    move: 1.3, hold: 0.5, angle: 70, still: 1,
    poses: (() => {
      const base: Body = { root: prone(), ...both({ hip: { flex: 90 }, knee: 90, ankle: -30, shoulder: { flex: 90 }, wrist: 85, palm: 90, hand: "open" }), contacts: [on("lowerleg01.L", KNEE), on("lowerleg01.R", KNEE), on("wrist.L", WRIST), on("wrist.R", WRIST)] };
      const reach = (arm: "L" | "R"): Body => {
        const leg = arm === "L" ? "R" : "L";
        return { ...base, [arm]: { ...base[arm], shoulder: { flex: 175 }, wrist: 0, palm: 90, hand: "relaxed" }, [leg]: { ...base[leg], hip: { flex: -4 }, knee: 4, ankle: -25 }, contacts: [on(`lowerleg01.${arm}`, KNEE), on(`wrist.${leg}`, WRIST)] };
      };
      return [pose(base), pose(reach("L")), pose(base), pose(reach("R"))];
    })(),
  },
  jump_squat: {
    move: 0.55, hold: 0.15, angle: 35, still: 1,
    poses: [
      stand(both(arms({ flex: 20 }))),
      stand(merge(merge(squatBottom(0.9), "L", arms({ flex: -40 })), "R", arms({ flex: -40 }))),
      pose({ ...both({ ankle: -35, knee: 4, shoulder: { flex: 150 } }), contacts: [on("toe1-1.L", TOE + 0.28), on("toe1-1.R", TOE + 0.28)] }),
    ],
  },
  pogo_hops: {
    move: 0.22, hold: 0.04, angle: 60, still: 1,
    poses: [
      // On the balls of the feet: the heels just off the floor.
      stand({ ...both({ knee: 12, ankle: -22, toes: 22, hip: { flex: 6 }, shoulder: { flex: 6 }, elbow: 85 }), contacts: TOES }),
      pose({ ...both({ knee: 4, ankle: -32, hip: { flex: 2 }, shoulder: { flex: 10 }, elbow: 85 }), contacts: [on("toe1-1.L", TOE + 0.1), on("toe1-1.R", TOE + 0.1)] }),
    ],
  },
  hip_flexor_stretch: {
    move: 2, hold: 1.6, angle: 75, still: 1,
    poses: [
      pose({ spine: { flex: 10 }, L: { hip: { flex: 88 }, knee: 88, ankle: 6 }, R: { hip: { flex: -2 }, knee: 92, ankle: -40, shoulder: { flex: 10 } }, contacts: [on("foot.L", FOOT), on("lowerleg01.R", KNEE)] }),
      pose({ spine: { flex: -6 }, L: { hip: { flex: 72 }, knee: 105, ankle: 22 }, R: { hip: { flex: -22 }, knee: 92, ankle: -40, shoulder: { flex: 165, abd: 8 } }, contacts: [on("foot.L", FOOT), on("lowerleg01.R", KNEE)] }),
    ],
  },

  // ------------------------------------------------------------ the gym classics
  back_squat: {
    move: 1.5, hold: 0.35, angle: 40, still: 1,
    props: [{ barbell: true, plates: 20 }],
    poses: (() => {
      const rack: Limb = { shoulder: { abd: 50, rot: 44, twist: 38 }, elbow: 124, palm: 40, hand: "grip" };
      return [stand(both(rack)), stand(merge(merge(squatBottom(1.05), "L", rack), "R", rack))];
    })(),
  },
  deadlift: {
    move: 1.5, hold: 0.45, angle: 70, still: 0,
    props: [{ barbell: true, plates: 20 }],
    poses: [
      stand({ root: [42, 0, 0], spine: { flex: 6 }, neck: -14, ...both({ hip: { flex: 102, abd: 4 }, knee: 74, ankle: 18, shoulder: { flex: 40, abd: 6 }, palm: 90, hand: "grip" }) }),
      stand(both({ shoulder: { flex: 4, abd: 6 }, palm: 90, hand: "grip" })),
    ],
  },
  bench_press: {
    move: 1.4, hold: 0.25, angle: 70, pitch: 14, still: 1,
    // (Its top 4 cm lower than under the mid-back alone: the shoulder blades rest on it too.)
    props: [{ box: [0.3, 0.42, 1.15], at: [0, -0.04, -0.12], under: "spine03" }, { barbell: true, plates: 20 }],
    poses: (() => {
      // Back flat on the bench, thighs sloping down off it, shins upright, feet flat on the floor.
      const lie = (s: Limb): Body => ({ root: SUPINE, neck: 14, ...both({ hip: { flex: -20, abd: 8 }, knee: 74, ankle: 4, ...s }), contacts: [on("spine03", 0.53, false), on("foot.L", FOOT), on("foot.R", FOOT)] });
      return [
        pose(lie({ shoulder: { flex: 88, abd: 18 }, elbow: 4, palm: 90, hand: "grip" })),
        pose(lie({ shoulder: { flex: 4, abd: 66 }, elbow: 96, palm: 90, hand: "grip" })),
      ];
    })(),
  },
  overhead_press: {
    move: 1.3, hold: 0.3, angle: 35, still: 1,
    props: [{ barbell: true, plates: 10 }],
    poses: [
      stand(both({ shoulder: { flex: 28, abd: 30, twist: 30 }, elbow: 142, palm: 70, hand: "grip" })),
      stand({ neck: 8, ...both({ shoulder: { flex: 172, abd: 16 }, elbow: 4, palm: 80, hand: "grip" }) }),
    ],
  },
  barbell_row: {
    move: 1.1, hold: 0.3, angle: 75, still: 1,
    props: [{ barbell: true, plates: 15 }],
    poses: [
      stand({ root: [50, 0, 0], neck: -10, ...both({ hip: { flex: 72 }, knee: 26, ankle: 4, shoulder: { flex: 50, abd: 8 }, palm: 90, hand: "grip" }) }),
      stand({ root: [50, 0, 0], neck: -10, ...both({ hip: { flex: 72 }, knee: 26, ankle: 4, shoulder: { flex: -6, abd: 22 }, elbow: 92, palm: 90, hand: "grip" }) }),
    ],
  },
  pull_up: {
    move: 1.3, hold: 0.35, angle: 30, pitch: 6, still: 1,
    props: [{ pullupBar: 2.32 }],
    poses: (() => {
      const hang = (s: Limb): Body => ({ L: { hip: { flex: 18 }, knee: 55, ankle: -25, ...s }, R: { hip: { flex: 18 }, knee: 55, ankle: -25, ...s }, contacts: [on("wrist.L", 2.24), on("wrist.R", 2.24)] });
      return [
        pose(hang({ shoulder: { flex: 168, abd: 24 }, elbow: 4, palm: 90, wrist: -8, hand: "grip" })),
        pose({ ...hang({ shoulder: { flex: 64, abd: 52 }, elbow: 128, palm: 90, hand: "grip" }), neck: 10 }),
      ];
    })(),
  },
  dumbbell_curl: {
    move: 1.1, hold: 0.3, angle: 30, still: 1,
    props: [{ dumbbell: "both", kg: 10 }],
    poses: [stand(both({ elbow: 6, palm: -85, shoulder: { abd: 4 }, hand: "grip" })), stand(both({ elbow: 132, palm: -85, shoulder: { flex: 8, abd: 4 }, hand: "grip" }))],
  },
  lateral_raise: {
    move: 1.1, hold: 0.35, angle: 15, still: 1,
    props: [{ dumbbell: "both", kg: 6 }],
    poses: [stand(both({ elbow: 14, shoulder: { abd: 10, flex: 6 }, hand: "grip" })), stand(both({ elbow: 14, shoulder: { abd: 86, flex: 6 }, palm: 10, hand: "grip" }))],
  },
  hip_thrust: {
    move: 1.1, hold: 0.5, angle: 75, still: 1,
    props: [{ box: [1.1, 0.42, 0.36], at: [0, 0, -0.1], under: "spine01" }, { barbell: true, plates: 20 }],
    poses: (() => {
      const arms2: Limb = { shoulder: { flex: 12, abd: 20 }, elbow: 30, palm: 90, hand: "grip" };
      return [
        pose({ root: [-62, 0, 0], ...both({ hip: { flex: 62 }, knee: 118, ankle: 4, ...arms2 }), contacts: [on("foot.L", FOOT), on("foot.R", FOOT), on("spine01", 0.52, false)] }),
        pose({ root: [-92, 0, 0], ...both({ hip: { flex: 0 }, knee: 92, ankle: 0, ...arms2 }), contacts: [on("foot.L", FOOT), on("foot.R", FOOT), on("spine01", 0.52, false)] }),
      ];
    })(),
  },
  kettlebell_swing: {
    move: 0.5, hold: 0.08, angle: 75, still: 1,
    props: [{ kettlebell: "swing", kg: 20 }],
    poses: [
      stand({ root: [52, 0, 0], neck: -12, ...both({ hip: { flex: 72, abd: 10 }, knee: 28, ankle: 10, shoulder: { flex: 22, rot: -14 }, elbow: 4, hand: "grip" }) }),
      stand(both({ hip: { abd: 10 }, shoulder: { flex: 82, rot: -14 }, elbow: 4, hand: "grip" })),
    ],
  },
  step_up: {
    move: 1.2, hold: 0.35, angle: 70, still: 1,
    // The box a little to the lead leg's side, so the trailing foot comes up past its edge.
    props: [{ box: [0.5, 0.42, 0.42], at: [0.13, 0, 0.05], under: "foot.L" }],
    poses: [
      pose({ spine: { flex: 8 }, L: { hip: { flex: 72 }, knee: 88, ankle: 12 }, R: { hip: { flex: -6 }, ankle: 0 }, contacts: [on("foot.R", FOOT), on("foot.L", 0.42 + FOOT)] }),
      pose({ L: { knee: 2 }, R: { hip: { flex: 60 }, knee: 90, ankle: -10 }, contacts: [on("foot.L", 0.42 + FOOT)] }),
    ],
  },
  side_plank: {
    move: 2.4, hold: 0.8, angle: 10, pitch: 8, still: 0,
    poses: (() => {
      const side = (hip: number): Pose =>
        pose({ root: [0, 0, 72], spine: { side: hip }, R: { shoulder: { abd: 82 }, elbow: 90, palm: 60, hand: "open" }, L: { shoulder: { abd: 4 }, elbow: 30, hand: "relaxed" }, contacts: [on("lowerarm01.R", ELBOW), on("foot.R", 0.05)] });
      return [side(-6), side(-2)];
    })(),
  },
  bench_dip: {
    move: 1.1, hold: 0.3, angle: 70, still: 1,
    props: [{ box: [1.0, 0.42, 0.36], at: [-0.2, 0, -0.2], under: "wrist.L" }],
    poses: (() => {
      const dip = (sh: number, el: number, hip: number): Pose =>
        pose({ ...both({ hip: { flex: hip }, knee: 12, ankle: 10, shoulder: { flex: sh, abd: 10 }, elbow: el, wrist: 82, palm: -20, hand: "open" }), contacts: [on("wrist.L", 0.47), on("wrist.R", 0.47), on("foot.L", 0.065, false), on("foot.R", 0.065, false)] });
      return [dip(-32, 4, 86), dip(-62, 92, 92)];
    })(),
  },
  mountain_climber: {
    move: 0.32, hold: 0.04, angle: 70, still: 0,
    poses: (() => {
      const top: Limb = { ankle: 22, toes: 30, shoulder: { flex: 66, abd: 4 }, elbow: 2, wrist: 64, palm: 90, hand: "open" };
      const drive: Limb = { ...top, hip: { flex: 92 }, knee: 112, ankle: -10, toes: 0 };
      const c = (planted: Side) => [on("wrist.L", WRIST), on("wrist.R", WRIST), on(`toe1-1.${planted}`, TOE, false)];
      return [pose({ root: prone(24), L: drive, R: top, contacts: c("R") }), pose({ root: prone(24), L: top, R: drive, contacts: c("L") })];
    })(),
  },
  crunch: {
    move: 1.0, hold: 0.35, angle: 70, still: 1,
    poses: (() => {
      const lie = (flex: number): Pose =>
        pose({ root: SUPINE, spine: { curl: flex }, neck: flex * 0.4, ...both({ hip: { flex: 50 }, knee: 112, shoulder: { flex: 120, abd: 85 }, elbow: 150, palm: 20 }), contacts: [on("foot.L", FOOT), on("foot.R", FOOT), on("spine04", BACK, false)] });
      return [lie(0), lie(36)];
    })(),
  },
};
