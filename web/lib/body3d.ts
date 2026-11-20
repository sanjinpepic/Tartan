/**
 * The 3D body (web/assets/body.glb, built by scripts/build-body.py): one studio-lit figure that
 * shows which muscles work, turns under your finger, and moves through an exercise the way a
 * body does: each pose is a set of joint angles (hip, knee, ankle, spine, shoulder, elbow…)
 * kept inside natural limits (web/lib/moves.ts), blended smoothly between key poses, with the
 * feet (or whatever touches the floor) held where they are.
 *
 * three.js loads only when a body is first shown. A live view draws only while it's on screen
 * and something on it changes (a pose between holds, a turn); it settles on its key pose after
 * a minute untouched. Thumbnails are stills from one shared renderer, kept as images.
 */
import type * as THREE_NS from "three";
import manUrl from "../assets/body-m.glb";
import womanUrl from "../assets/body-f.glb";
import type { Muscle } from "../../src/strength/exercises.ts";
import { MOVES, type Move, type Pose } from "./moves.ts";
import { SHADOWS } from "../assets/shadows/index.ts";
import { makeProps, type Grip } from "./props3d.ts";

type Three = typeof THREE_NS;
type Gltf = import("three/examples/jsm/loaders/GLTFLoader.js").GLTF;
interface Lib {
  THREE: Three;
  GLTFLoader: typeof import("three/examples/jsm/loaders/GLTFLoader.js").GLTFLoader;
  OrbitControls: typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
  RoomEnvironment: typeof import("three/examples/jsm/environments/RoomEnvironment.js").RoomEnvironment;
  clone: typeof import("three/examples/jsm/utils/SkeletonUtils.js").clone;
  RoundedBoxGeometry: typeof import("three/examples/jsm/geometries/RoundedBoxGeometry.js").RoundedBoxGeometry;
}

let lib: Promise<Lib> | null = null;
const load = () =>
  (lib ??= Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/controls/OrbitControls.js"),
    import("three/examples/jsm/environments/RoomEnvironment.js"),
    import("three/examples/jsm/utils/SkeletonUtils.js"),
    import("three/examples/jsm/geometries/RoundedBoxGeometry.js"),
  ]).then(([THREE, g, o, r, u, b]) => ({ THREE, GLTFLoader: g.GLTFLoader, OrbitControls: o.OrbitControls, RoomEnvironment: r.RoomEnvironment, clone: u.clone, RoundedBoxGeometry: b.RoundedBoxGeometry })));
const gltf: Partial<Record<Body, Promise<Gltf>>> = {};
/** Baked shadow strips, loaded once each (every view clones the texture, sharing the image). */
const shadowImages: Record<string, Promise<THREE_NS.Texture>> = {};

/** Whether this device can draw the body (else the 2D figures stand in). */
export function canDraw3d(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Which body shows it: a man or a woman (the same moves; web/lib/body-stage.ts picks). */
export type Body = "m" | "f";

export interface BodyOptions {
  primary: readonly Muscle[];
  secondary: readonly Muscle[];
  exercise?: string;
  body?: Body;
}

/** The baked occlusion, deepened a little (a render's contact darkness reads stronger than raw AO). */
const occluded = (ao: number) => 0.42 + 0.58 * Math.pow(ao, 1.4);
const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const darkMode = () => matchMedia("(prefers-color-scheme: dark)").matches;

/** The renderer's look: filmic, soft, a studio room for reflections. */
function makeRenderer(L: Lib, still = false) {
  const { THREE } = L;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power", preserveDrawingBuffer: still });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new L.RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return { renderer, env };
}

/**
 * A body in a scene: posed, painted, framed. `poseAt(t)` sets the pose `t` seconds into the
 * loop and says whether it changed since the last call.
 */
/** For tools (the Blender exporter): the figure, posed by the same code the app uses. */
export async function toolFigure(o: BodyOptions, angleDeg: number, env: THREE_NS.Texture) {
  const L = await load();
  return { L, fig: await figure(L, env, o, angleDeg) };
}

/**
 * The loader scales every vertex's four bone weights to add up to one; a cloth vertex's add up
 * to one only with its second four (_weights1), so those four are given their share back.
 */
function eightBones(g: Gltf): Gltf {
  g.scene.traverse((n) => {
    const geo = (n as THREE_NS.SkinnedMesh).isSkinnedMesh ? (n as THREE_NS.SkinnedMesh).geometry : null;
    const w = geo?.getAttribute("skinWeight") as THREE_NS.BufferAttribute | undefined;
    const w1 = geo?.getAttribute("_weights1") as THREE_NS.BufferAttribute | undefined;
    if (!w || !w1) return;
    for (let i = 0; i < w.count; i++) {
      const rest = 1 - (w1.getX(i) + w1.getY(i) + w1.getZ(i) + w1.getW(i));
      if (rest < 0.999) w.setXYZW(i, w.getX(i) * rest, w.getY(i) * rest, w.getZ(i) * rest, w.getW(i) * rest);
    }
  });
  return g;
}

/**
 * For each bone, a few skin vertices that stand out round it (the furthest in 26 directions among
 * those it mostly carries): enough to find the body's lowest point each frame. Once per body.
 */
const probeCache = new WeakMap<Gltf, number[][]>();
function probesOf(g: Gltf, mesh: THREE_NS.SkinnedMesh, garmentStart?: number): number[][] {
  const cached = probeCache.get(g);
  if (cached) return cached;
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position") as THREE_NS.BufferAttribute;
  const si = geo.getAttribute("skinIndex") as THREE_NS.BufferAttribute;
  const sw = geo.getAttribute("skinWeight") as THREE_NS.BufferAttribute;
  // Skin only: the clothes start after the skin's last vertex.
  let skin = pos.count;
  if (garmentStart !== undefined && geo.index) {
    skin = Infinity;
    for (let i = garmentStart; i < geo.index.count; i++) skin = Math.min(skin, geo.index.getX(i));
  }
  const dirs: number[][] = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) dirs.push([x, y, z].map((c) => c / Math.hypot(x, y, z)));
  const out = mesh.skeleton.bones.map(() => dirs.map(() => ({ v: -1, d: -Infinity })));
  for (let v = 0; v < skin; v++) {
    let b = -1;
    for (let k = 0; k < 4; k++) if (sw.getComponent(v, k) >= 0.6) b = si.getComponent(v, k);
    if (b < 0) continue;
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    const best = out[b]!;
    dirs.forEach((d, i) => {
      const dot = x * d[0]! + y * d[1]! + z * d[2]!;
      if (dot > best[i]!.d) best[i] = { v, d: dot };
    });
  }
  const probes = out.map((best) => [...new Set(best.map((p) => p.v).filter((v) => v >= 0))]);
  probeCache.set(g, probes);
  return probes;
}

async function figure(L: Lib, env: THREE_NS.Texture, o: BodyOptions, angleDeg: number, tight = false) {
  const { THREE } = L;
  const who: Body = o.body ?? "m";
  const loaded = await (gltf[who] ??= new L.GLTFLoader().loadAsync(who === "f" ? womanUrl : manUrl).then(eightBones));
  const scene = new THREE.Scene();
  scene.environment = env;
  scene.environmentIntensity = 0.55;
  const key = new THREE.DirectionalLight(0xfff6f0, 2.4);
  key.position.set(1.5, 3, 2.5);
  const rim = new THREE.DirectionalLight(0xffe2d6, 1.6);
  rim.position.set(-2, 2.2, -2.5);
  scene.add(key, rim);

  // A fresh copy of the skinned mesh and its bones, with its own colours.
  const root = L.clone(loaded.scene) as THREE_NS.Object3D;
  scene.add(root);
  let found: THREE_NS.SkinnedMesh | null = null;
  root.traverse((n) => {
    if ((n as THREE_NS.SkinnedMesh).isSkinnedMesh) found = n as THREE_NS.SkinnedMesh;
  });
  const body = found as unknown as THREE_NS.SkinnedMesh;
  body.frustumCulled = false;
  const shared = body.geometry as THREE_NS.BufferGeometry;
  const geo = new THREE.BufferGeometry();
  geo.setIndex(shared.index);
  for (const [k, a] of Object.entries(shared.attributes)) geo.setAttribute(k, a);
  // The fingers' shapes (relaxed, gripping) come along; the clone kept their names and weights.
  geo.morphAttributes = shared.morphAttributes;
  geo.morphTargetsRelative = shared.morphTargetsRelative;
  body.geometry = geo;
  // Per vertex, the two muscles under the skin there and how much (fading at their edges).
  const muscleId = geo.getAttribute("_muscle") as THREE_NS.BufferAttribute;
  const muscleW = geo.getAttribute("_musclew") as THREE_NS.BufferAttribute;
  // Sportswear and hair (x: fabric, y: hair), painted over the clay.
  const wear = geo.getAttribute("_wear") as THREE_NS.BufferAttribute | undefined;
  // Ambient occlusion baked in Blender (scripts/blender/bake-ao.py): the depth of a render, painted in.
  const occlusion = geo.getAttribute("_ao") as THREE_NS.BufferAttribute | undefined;
  const extras = ((loaded.parser.json as { extras?: { muscles?: string[]; garments?: [number, number] } }).extras ?? {});
  const names = extras.muscles ?? [];
  const colors = new Float32Array(muscleId.count * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  // The standard material: with the occlusion baked in, the physical one's sheen and clearcoat
  // added little but cost a heavier shader on every pixel.
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.66, metalness: 0 });
  // The gym clothes are surfaces of their own (scripts/build-body.py), drawn after the skin as
  // matte knit: rougher than skin, no shine.
  // Both sides: inside a leg opening the cloth's inner face shows, and where a deep bend folds the
  // cloth over (the front of the hip in a squat) it stays cloth instead of opening a hole.
  const fabricMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  // The cloth follows up to eight bones (scripts/build-body.py: _JOINTS1, _WEIGHTS1 hold the
  // second four), so it moves with the skin under it at every bend. Its depth is also taken
  // 4 mm nearer the eye (along the line of sight, so it draws in the same place): where the skin
  // under it comes that close, the cloth still wins.
  fabricMaterial.onBeforeCompile = (shader) => {
    const chunk = THREE.ShaderChunk;
    shader.vertexShader = `attribute vec4 _joints1;\nattribute vec4 _weights1;\n${shader.vertexShader}`
      .replace("#include <skinbase_vertex>", `#include <skinbase_vertex>
#ifdef USE_SKINNING
	mat4 boneMatE = getBoneMatrix( _joints1.x );
	mat4 boneMatF = getBoneMatrix( _joints1.y );
	mat4 boneMatG = getBoneMatrix( _joints1.z );
	mat4 boneMatH = getBoneMatrix( _joints1.w );
#endif`)
      .replace("#include <skinnormal_vertex>", chunk.skinnormal_vertex.replace("skinMatrix = bindMatrixInverse", "skinMatrix += _weights1.x * boneMatE + _weights1.y * boneMatF + _weights1.z * boneMatG + _weights1.w * boneMatH;\n\tskinMatrix = bindMatrixInverse"))
      .replace("#include <skinning_vertex>", chunk.skinning_vertex.replace("transformed = ( bindMatrixInverse", "skinned += ( boneMatE * _weights1.x + boneMatF * _weights1.y + boneMatG * _weights1.z + boneMatH * _weights1.w ) * skinVertex;\n\ttransformed = ( bindMatrixInverse"))
      .replace("#include <project_vertex>", "#include <project_vertex>\n\tmvPosition.xyz -= normalize( mvPosition.xyz ) * 0.004;\n\tgl_Position = projectionMatrix * mvPosition;");
  };
  if (extras.garments) {
    geo.addGroup(0, extras.garments[0], 0);
    geo.addGroup(extras.garments[0], extras.garments[1], 1);
    body.material = [material, fabricMaterial];
  } else body.material = material;

  const paint = (primary: readonly Muscle[], secondary: readonly Muscle[]) => {
    const clay = new THREE.Color(darkMode() ? "#8a7f7a" : "#d9cec8");
    const fabric = new THREE.Color(darkMode() ? "#2f2c2b" : "#3a3634");
    const trimC = new THREE.Color(darkMode() ? "#242120" : "#2a2725");
    const hairC = new THREE.Color(darkMode() ? "#2e2522" : "#4a3a33");
    const p = new THREE.Color(css("--primary", "#a8321f"));
    const s = clay.clone().lerp(p, 0.55);
    // On cloth a worked muscle shows as the fabric dyed deep in the accent, cut clean at its edge
    // (not the muscle's soft shape coming through, which reads as see-through cloth).
    // (The accent's hue, deep: dark mode's accent is a light salmon that would dye cloth skin-toned.)
    const hsl = p.getHSL({ h: 0, s: 0, l: 0 });
    const pd = new THREE.Color().setHSL(hsl.h, Math.max(hsl.s, 0.6), 0.3).lerp(fabric, 0.3);
    const sd = fabric.clone().lerp(pd, 0.4);
    const cut = (w: number) => THREE.MathUtils.smoothstep(w, 0.32, 0.6);
    const P = new Set(primary.map((m) => names.indexOf(m)));
    const S = new Set(secondary.map((m) => names.indexOf(m)));
    const c = new THREE.Color();
    const f = new THREE.Color();
    for (let i = 0; i < muscleId.count; i++) {
      let ap = 0;
      let as = 0;
      for (const k of [0, 1]) {
        const m = k ? muscleId.getY(i) : muscleId.getX(i);
        const w = k ? muscleW.getY(i) : muscleW.getX(i);
        if (P.has(m)) ap = Math.max(ap, w);
        else if (S.has(m)) as = Math.max(as, w);
      }
      const cloth = wear ? wear.getX(i) : 0;
      const hair = wear ? wear.getY(i) : 0;
      const trim = wear && wear.itemSize > 2 ? wear.getZ(i) : 0;
      c.copy(clay).lerp(s, as).lerp(p, ap);
      if (cloth) c.lerp(f.copy(fabric).lerp(trimC, trim).lerp(sd, cut(as)).lerp(pd, cut(ap)), cloth);
      if (hair) c.lerp(hairC, hair);
      if (occlusion) c.multiplyScalar(occluded(occlusion.getX(i)));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    (geo.getAttribute("color") as THREE_NS.BufferAttribute).needsUpdate = true;
  };
  paint(o.primary, o.secondary);

  // The floor shadow: Blender's, baked per key pose (scripts/blender/render-shadows.py) and
  // crossfaded as the body moves between them; else a soft blob that follows the hips.
  const baked = SHADOWS[`${o.exercise ?? "stand"}-${who}`];
  const shadowGeo = new THREE.PlaneGeometry(baked?.size ?? 1.4, baked?.size ?? 1.4);
  const shadowTex: THREE_NS.Texture = baked
    ? await (shadowImages[baked.url] ??= new THREE.TextureLoader().loadAsync(baked.url))
    : (() => {
        const c = document.createElement("canvas");
        c.width = c.height = 128;
        const g = c.getContext("2d")!;
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, "rgb(52,52,52)");
        grad.addColorStop(1, "rgb(0,0,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        return new THREE.CanvasTexture(c);
      })();
  const poses = baked?.poses ?? 1;
  // Two layers, each showing one key pose's square of the strip (the image is shared).
  const shadowLayers = [0, 1].map(() => {
    const map = shadowTex.clone();
    map.repeat.set(1 / poses, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: map, transparent: true, depthWrite: false, opacity: 0 });
    const mesh = new THREE.Mesh(shadowGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(baked?.x ?? 0, 0.002, baked?.z ?? 0);
    mesh.renderOrder = -1;
    scene.add(mesh);
    return { mesh, mat, map };
  });
  const shadowAt = (i: number, j: number, t: number) => {
    const [a, b] = shadowLayers;
    a!.map.offset.x = (Math.min(i, poses - 1)) / poses;
    b!.map.offset.x = (Math.min(j, poses - 1)) / poses;
    a!.mat.opacity = 1 - t;
    b!.mat.opacity = t;
  };

  // What the exercise uses: a bench, a barbell, dumbbells… (web/lib/props3d.ts)
  const move: Move | undefined = o.exercise ? MOVES[o.exercise] : undefined;
  const equipment = makeProps(THREE, L.RoundedBoxGeometry, move?.props ?? [], darkMode());
  scene.add(equipment.group);

  // ---------------------------------------------------------------- bones and poses
  // three drops the "." from node names ("foot.L" → "footL"): look bones up the same way.
  const named = (n: string) => THREE.PropertyBinding.sanitizeNodeName(n);
  const bones = new Map<string, THREE_NS.Bone>();
  body.skeleton.bones.forEach((b) => bones.set(b.name, b));
  const hips = bones.get("root")!;
  const restRoot = hips.position.clone();
  const tmpE = new THREE.Euler();
  const tmpA = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const qa = new THREE.Quaternion();
  const toQuat = (deg: [number, number, number]) => new THREE.Quaternion().setFromEuler(tmpE.set((deg[0] * Math.PI) / 180, (deg[1] * Math.PI) / 180, (deg[2] * Math.PI) / 180, "YXZ"));
  type Q = { rot: Map<string, THREE_NS.Quaternion>; root: THREE_NS.Quaternion; shift: THREE_NS.Vector3; contacts: Pose["contacts"]; hands: Array<[number, number]>; open: Map<string, boolean> };
  const morphs = body.morphTargetDictionary ?? {};
  const influences = body.morphTargetInfluences ?? [];
  const compile = (p: Pose): Q => {
    const rot = new Map<string, THREE_NS.Quaternion>();
    for (const [b, e] of Object.entries(p.joints)) rot.set(named(b), Array.isArray(e) ? toQuat(e) : new THREE.Quaternion().setFromAxisAngle(tmpA.set(...e.axis).normalize(), (e.deg * Math.PI) / 180));
    const hands = Object.entries(p.hands ?? {}).flatMap(([n, v]): Array<[number, number]> => (morphs[n] === undefined ? [] : [[morphs[n]!, v]]));
    // An open hand: neither relaxed nor gripping (flat on the floor or a bench).
    const open = new Map((["L", "R"] as const).map((s) => [s, !p.hands?.[`relax.${s}`] && !p.hands?.[`grip.${s}`]]));
    return { rot, root: toQuat(p.root ?? [0, 0, 0]), shift: new THREE.Vector3(...(p.shift ?? [0, 0, 0])), contacts: p.contacts, hands, open };
  };
  const keys = (move?.poses ?? [MOVES.stand!.poses[0]!]).map(compile);
  /** Where each locked contact stands: where it first touches, pose by pose. */
  const anchors = new Map<string, [number, number]>();

  const qb = new THREE.Quaternion();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();
  // Where a bar sits in each gripping hand (from the wrist, rest pose) and which way it runs.
  const gripRest = ((loaded.parser.json as { extras?: { grips?: Record<string, { at: number[]; axis: number[]; palm?: number[] }> } }).extras?.grips ?? {}) as Record<string, { at: number[]; axis: number[]; palm?: number[] }>;
  const gripOf = (side: "L" | "R"): Grip => {
    const wrist = bones.get(named(`wrist.${side}`))!;
    const r = gripRest[side] ?? { at: [0, -0.08, 0], axis: [0, 0, 1] };
    return {
      at: new THREE.Vector3(...(r.at as [number, number, number])).applyMatrix4(wrist.matrixWorld),
      axis: new THREE.Vector3(...(r.axis as [number, number, number])).applyQuaternion(wrist.getWorldQuaternion(qb)).normalize(),
    };
  };

  const UP = new THREE.Vector3(0, 1, 0);
  const qt = new THREE.Quaternion();
  /** Turn the whole body about an axis through a point (world). */
  const turnAbout = (at: THREE_NS.Vector3, axis: THREE_NS.Vector3, angle: number) => {
    if (!Number.isFinite(angle) || Math.abs(angle) < 1e-5) return;
    qt.setFromAxisAngle(axis, angle);
    hips.quaternion.premultiply(qt);
    hips.position.sub(at).applyQuaternion(qt).add(at);
    root.updateMatrixWorld(true);
  };
  /** The lowest contact onto its height; planted ones (lock) back where they stood. */
  const place = (contacts: Array<{ bone: THREE_NS.Bone; lock?: [number, number]; height: number }>) => {
    let lift = -Infinity;
    let lx = 0;
    let lz = 0;
    let locks = 0;
    for (const c of contacts) {
      c.bone.getWorldPosition(tmpV);
      lift = Math.max(lift, c.height - tmpV.y);
      if (c.lock) {
        lx += c.lock[0] - tmpV.x;
        lz += c.lock[1] - tmpV.z;
        locks++;
      }
    }
    if (Number.isFinite(lift)) hips.position.y += lift;
    if (locks) {
      hips.position.x += lx / locks;
      hips.position.z += lz / locks;
    }
    root.updateMatrixWorld(true);
  };
  /** The body's centre of mass: head, trunk, arms and legs with their usual share of the weight. */
  const SEGMENTS: Array<[number, string, string, number]> = [
    [0.081, "neck01", "head", 1.6],
    ...(["L", "R"] as const).flatMap((s): Array<[number, string, string, number]> => [
      [0.028, `upperarm01.${s}`, `lowerarm01.${s}`, 0.436], [0.016, `lowerarm01.${s}`, `wrist.${s}`, 0.43], [0.006, `lowerarm01.${s}`, `wrist.${s}`, 1.3],
      [0.1, `upperleg01.${s}`, `lowerleg01.${s}`, 0.433], [0.0465, `lowerleg01.${s}`, `foot.${s}`, 0.433], [0.0145, `foot.${s}`, `toe1-1.${s}`, 0.5],
    ]),
  ];
  /** With the weight in the hands (the equipment's kg, at the hands) when asked. */
  const load = (move?.props ?? []).reduce((n, p) => n + ("barbell" in p ? 20 + 2 * (p.plates ?? 20) : "dumbbell" in p ? (p.kg ?? 10) * (p.dumbbell === "both" ? 2 : 1) : "kettlebell" in p ? (p.kg ?? 16) : 0), 0) / (who === "f" ? 62 : 75);
  const centreOfMass = (withLoad = false) => {
    const c = new THREE.Vector3();
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    let m = 0;
    for (const [w, x, y, f] of SEGMENTS) {
      bones.get(named(x))!.getWorldPosition(p);
      bones.get(named(y))!.getWorldPosition(q);
      c.addScaledVector(p.lerp(q, f), w);
      m += w;
    }
    // The trunk: from between the hips to the base of the neck, a little below halfway.
    bones.get(named("upperleg01.L"))!.getWorldPosition(p);
    bones.get(named("upperleg01.R"))!.getWorldPosition(q);
    p.add(q).multiplyScalar(0.5);
    bones.get(named("neck01"))!.getWorldPosition(q);
    c.addScaledVector(p.lerp(q, 0.45), 0.497);
    m += 0.497;
    if (withLoad && load) {
      bones.get(named("wrist.L"))!.getWorldPosition(p);
      bones.get(named("wrist.R"))!.getWorldPosition(q);
      c.addScaledVector(p.add(q).multiplyScalar(0.5), load);
      m += load;
    }
    return c.divideScalar(m);
  };
  /** The outline (x, z) of what the feet stand on: heel to toe, a hand's width across, plus a foot on a bench. */
  const supportOf = (contacts: Array<{ bone: THREE_NS.Bone }>): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    const sides = new Set<string>();
    for (const c of contacts) if (/^(foot|toe)/.test(c.bone.name)) sides.add(c.bone.name.slice(-1));
    for (const n of (move?.props ?? []).flatMap((p) => ("under" in p && p.under && /^(foot|toe)/.test(p.under) ? [p.under] : []))) sides.add(n.slice(-1));
    for (const side of sides) {
      const an = bones.get(named(`foot.${side}`))!.getWorldPosition(new THREE.Vector3());
      const toe = bones.get(named(`toe1-1.${side}`))!.getWorldPosition(new THREE.Vector3());
      const dx = toe.x - an.x;
      const dz = toe.z - an.z;
      const l = Math.hypot(dx, dz) || 1;
      const [ux, uz] = [dx / l, dz / l];
      // The heel's end of the outline slides to just behind the ball of the foot as the heel
      // rises (on tiptoe only the ball and toes bear), smoothly, so a calf raise doesn't jump.
      const heel = 0.06 - (0.04 + l) * THREE.MathUtils.smoothstep(an.y - toe.y, 0.065, 0.11);
      const ends: Array<[number, number]> = [[an.x - ux * heel, an.z - uz * heel], [toe.x + ux * 0.05, toe.z + uz * 0.05]];
      for (const [x, z] of ends) pts.push([x - uz * 0.045, z + ux * 0.045], [x + uz * 0.045, z - ux * 0.045]);
    }
    return pts;
  };
  /** The point of a convex outline nearest to (x, z) (itself when inside); the outline is a hull of the points, drawn in a little. */
  const nearestInside = (x: number, z: number, all: Array<[number, number]>): [number, number] => {
    if (!all.length) return [x, z];
    // A little inside the edge, not on it: the outline drawn in 15% towards its middle.
    const mx = all.reduce((n, q) => n + q[0], 0) / all.length;
    const mz = all.reduce((n, q) => n + q[1], 0) / all.length;
    const pts = all.map(([px, pz]): [number, number] => [px + (mx - px) * 0.15, pz + (mz - pz) * 0.15]);
    const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list: Array<[number, number]>) => {
      const h: Array<[number, number]> = [];
      for (const q of list) {
        while (h.length >= 2 && cross(h[h.length - 2]!, h[h.length - 1]!, q) <= 0) h.pop();
        h.push(q);
      }
      return h;
    };
    const lo = half(p);
    const up = half([...p].reverse());
    const hull = [...lo.slice(0, -1), ...up.slice(0, -1)];
    if (hull.length >= 3 && hull.every((a, i) => cross(a, hull[(i + 1) % hull.length]!, [x, z]) >= 0)) return [x, z];
    let best: [number, number] = hull[0] ?? [x, z];
    let bd = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i]!;
      const b = hull[(i + 1) % hull.length]!;
      const ex = b[0] - a[0];
      const ez = b[1] - a[1];
      const u = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez || 1)));
      const q: [number, number] = [a[0] + u * ex, a[1] + u * ez];
      const dd = Math.hypot(x - q[0], z - q[1]);
      if (dd < bd) [best, bd] = [q, dd];
    }
    return best;
  };

  // ---------------------------------------------------------------- limbs and the floor
  // Probes: a few points of the skin that stand out round each bone (from the rest mesh, in the
  // bone's own frame), to find the body's lowest point without skinning every vertex.
  const sk = body.skeleton;
  const probes = probesOf(loaded, body, extras.garments?.[0]);
  const morphPos = geo.morphAttributes.position ?? [];
  const pm = new THREE.Matrix4();
  const pv = new THREE.Vector3();
  const boneIndex = new Map(sk.bones.map((b, i) => [b, i]));
  /** The world points of a bone's probes now (with the fingers' current shape). */
  const probePoints = (bone: THREE_NS.Bone): THREE_NS.Vector3[] => {
    const i = boneIndex.get(bone)!;
    pm.multiplyMatrices(body.matrixWorld, body.bindMatrixInverse).multiply(bone.matrixWorld).multiply(sk.boneInverses[i]!).multiply(body.bindMatrix);
    return (probes[i] ?? []).map((v) => {
      pv.fromBufferAttribute(geo.attributes.position as THREE_NS.BufferAttribute, v);
      for (let m = 0; m < morphPos.length; m++) if (influences[m]) pv.addScaledVector(tmpA.fromBufferAttribute(morphPos[m] as THREE_NS.BufferAttribute, v), influences[m]!);
      return pv.clone().applyMatrix4(pm);
    });
  };
  const FLOOR = 0.002;
  const wq = new THREE.Quaternion();
  const wq2 = new THREE.Quaternion();
  /** Turn a bone in the world (about its own joint). */
  const turnBone = (bone: THREE_NS.Bone, q: THREE_NS.Quaternion) => {
    bone.parent!.getWorldQuaternion(wq);
    bone.getWorldQuaternion(wq2);
    bone.quaternion.copy(wq.invert().multiply(q).multiply(wq2));
    bone.updateMatrixWorld(true);
  };
  const B = (n: string) => bones.get(named(n))!;
  /** Each limb from the trunk out: hip or shoulder, knee or elbow, ankle or wrist, toes; and the bones each joint carries. */
  const LIMBS = (["L", "R"] as const).flatMap((s) => [
    { joints: [B(`upperleg01.${s}`), B(`lowerleg01.${s}`), B(`foot.${s}`), B(`toe1-1.${s}`)], carried: [[B(`upperleg02.${s}`)], [B(`lowerleg02.${s}`)], [], []] },
    { joints: [B(`upperarm01.${s}`), B(`lowerarm01.${s}`), B(`wrist.${s}`)], carried: [[B(`upperarm02.${s}`)], [B(`lowerarm02.${s}`)], []] },
  ]);
  const palmRest = Object.fromEntries((["L", "R"] as const).map((s) => [s, new THREE.Vector3(...((gripRest[s]?.palm ?? [0, -1, 0]) as [number, number, number])).normalize()]));
  const DOWN = new THREE.Vector3(0, -1, 0);
  const iv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  /**
   * Two-bone reach: the limb's knee (elbow) bends and its hip (shoulder) turns so the joint at
   * `end` (an ankle, a wrist; or the knee or elbow itself: then only the upper bone turns) is at
   * the target. Planted hands and feet stay where they stood, whatever the body does above them.
   * Without `bendKnee` only the hip or shoulder turns; "if bent": only when the limb is bent (a
   * lift: a near-straight limb would bend suddenly for the smallest change in its reach).
   */
  const reach = (limb: (typeof LIMBS)[number], end: number, target: THREE_NS.Vector3, bendKnee: boolean | "if bent" = true) => {
    const [hipB, kneeB] = limb.joints;
    const H = hipB!.getWorldPosition(iv[0]!);
    if (end >= 2 && bendKnee) {
      const K = kneeB!.getWorldPosition(iv[1]!);
      const A = limb.joints[end]!.getWorldPosition(iv[2]!);
      const a = H.distanceTo(K);
      const b = K.distanceTo(A);
      // The bend for a reach, from its length (out of range: as near as it gets). Applied as
      // the change from the bend for the reach now, so an unchanged reach changes nothing.
      const bend = (d: number) => {
        const c = THREE.MathUtils.clamp(d, Math.abs(a - b) + 1e-4, a + b - 1e-4);
        return Math.acos(THREE.MathUtils.clamp((a * a + b * b - c * c) / (2 * a * b), -1, 1));
      };
      const u = tmpA.copy(H).sub(K);
      const v = iv[3]!.copy(A).sub(K);
      const now = bend(H.distanceTo(A));
      // (A lift leaves a near-straight limb straight, easing in: only the hip or shoulder turns.)
      const straight = bendKnee === "if bent" ? THREE.MathUtils.smoothstep(u.angleTo(v), Math.PI - 0.45, Math.PI - 0.12) : 0;
      const want = THREE.MathUtils.lerp(bend(H.distanceTo(target)), now, straight);
      const axis = new THREE.Vector3().crossVectors(u, v);
      if (axis.lengthSq() < 1e-10) axis.set(1, 0, 0).applyQuaternion(kneeB!.getWorldQuaternion(wq2));
      if (Math.abs(want - now) > 1e-5) turnBone(kneeB!, qt.setFromAxisAngle(axis.normalize(), want - now));
    }
    const E = limb.joints[end]!.getWorldPosition(iv[2]!);
    const from = tmpA.copy(E).sub(H).normalize();
    const to = iv[3]!.copy(target).sub(H).normalize();
    if (from.dot(to) < 0.999999) turnBone(hipB!, qt.setFromUnitVectors(from, to));
  };

  /**
   * A joint turned about its hinge (its own x) as little as it takes for everything it carries to
   * clear the floor; left as it is when it can't (the next joint in tries). Points near the joint
   * are left out (turning it can't lift them).
   */
  const clearFloor = (joint: THREE_NS.Bone, carried: THREE_NS.Bone[], limit = 1.1) => {
    const J = joint.getWorldPosition(new THREE.Vector3());
    const k = new THREE.Vector3(1, 0, 0).applyQuaternion(joint.getWorldQuaternion(wq2)).normalize();
    const terms: Array<[number, number, number]> = [];
    let low = Infinity;
    for (const bone of carried) for (const p of probePoints(bone)) {
      const r = p.sub(J);
      if (r.lengthSq() < 0.0016) continue;
      low = Math.min(low, J.y + r.y);
      const along = k.y * r.dot(k);
      const perp = r.y - along;
      const side = k.z * r.x - k.x * r.z; // (k × r).y
      terms.push([J.y + along - FLOOR, perp, side]);
    }
    if (!terms.length || low >= FLOOR) return;
    const minAt = (th: number) => {
      const c = Math.cos(th), s = Math.sin(th);
      let m = Infinity;
      for (const [c0, a, b] of terms) m = Math.min(m, c0 + a * c + b * s);
      return m;
    };
    // The way that raises the lowest point (a fixed choice, so it doesn't flip frame to frame),
    // as far as it takes to clear the floor.
    const lowest = terms.reduce((m, x) => (x[0] + x[1] < m[0] + m[1] ? x : m));
    const sg = lowest[2] >= 0 ? 1 : -1;
    let best = 0;
    const step = Math.PI / 360;
    for (let th = step; th <= limit; th += step) {
      const m = minAt(sg * th);
      if (m >= 0) {
        // Back towards zero to where it just clears.
        let lo = sg * (th - step), hi = sg * th;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (minAt(mid) >= 0) hi = mid;
          else lo = mid;
        }
        best = hi;
        break;
      }
    }
    if (Math.abs(best) > 1e-5) turnBone(joint, qt.setFromAxisAngle(k, best));
  };

  type Contact = { bone: THREE_NS.Bone; lock?: [number, number]; height: number; open?: boolean; rest?: boolean };
  /** After the body is placed: planted hands and feet back where they stood, feet and hands flat, nothing through the floor (`only`: just the limbs with contacts). */
  const limbs = (contacts: Contact[], only = false) => {
    for (const limb of LIMBS) {
      const on = contacts.filter((c) => limb.joints.includes(c.bone));
      if (only && !on.length) continue;
      const deepest = Math.max(-1, ...on.map((c) => limb.joints.indexOf(c.bone)));
      for (const c of on) {
        // A hand lying beside the body: down to the floor where it is.
        if (c.rest) {
          const j = limb.joints.indexOf(c.bone);
          const p = c.bone.getWorldPosition(new THREE.Vector3());
          reach(limb, j, p.setY(c.height), false);
          continue;
        }
        if (!c.lock) {
          // Bearing but not planted (a lunge's back toes): down to the floor if it's still above it.
          const j = Math.min(limb.joints.indexOf(c.bone), 2);
          const gap = c.bone.getWorldPosition(new THREE.Vector3()).y - c.height;
          if (gap > 0.005 && c.height < 1.2) reach(limb, j, limb.joints[j]!.getWorldPosition(new THREE.Vector3()).add(tmpV.set(0, -gap, 0)));
          continue;
        }
        const end = limb.joints.indexOf(c.bone);
        // A toe planted: the ankle goes where it takes the toe there.
        const j = Math.min(end, 2);
        const target = c.bone.getWorldPosition(new THREE.Vector3());
        const shift = new THREE.Vector3(c.lock[0], c.height, c.lock[1]).sub(target);
        reach(limb, j, limb.joints[j]!.getWorldPosition(new THREE.Vector3()).add(shift));
      }
      // Flat on the floor: a foot on its sole, toes on theirs, an open hand on its palm.
      for (const c of on) {
        if (c.height > 1.2) continue;
        const i = limb.joints.indexOf(c.bone);
        const isArm = limb.joints.length === 3;
        // (A foot only when it's nearly so already, easing out: a side plank's rests on its edge, a
        // dip's heels on the floor with the toes up.)
        if (i === 1) {
          // A knee or elbow on the floor: the shin or forearm lies along it.
          const d = limb.joints[2]!.getWorldPosition(new THREE.Vector3()).sub(c.bone.getWorldPosition(iv[0]!)).normalize();
          const flat = iv[1]!.set(d.x, 0, d.z);
          if (flat.lengthSq() > 1e-4) turnBone(c.bone, qt.setFromUnitVectors(d, flat.normalize()));
        } else if (isArm && i === 2 && c.open) {
          const side = c.bone.name.slice(-1) as "L" | "R";
          const n = palmRest[side]!.clone().applyQuaternion(c.bone.getWorldQuaternion(wq2));
          turnBone(c.bone, qt.setFromUnitVectors(n, DOWN));
        } else if (!isArm && i >= 2) {
          const n = new THREE.Vector3(0, -1, 0).applyQuaternion(c.bone.getWorldQuaternion(wq2));
          const k = i === 3 ? 1 : 1 - THREE.MathUtils.smoothstep(n.angleTo(DOWN), 0.9, 1.3);
          if (k > 0) turnBone(c.bone, qt.setFromUnitVectors(n, DOWN).slerp(qa.identity(), 1 - k));
        }
      }
      // Clear of the floor, from the hand or foot inwards: never a joint with a planted part beyond it.
      for (let i = limb.joints.length - 1; i >= 1; i--) {
        if (deepest > i) break;
        clearFloor(limb.joints[i]!, [...limb.joints.slice(i), ...limb.carried.slice(i).flat()], i === 3 ? 0.6 : 1.1);
      }
      // A free hand or foot still in the floor (turning a joint couldn't): the limb lifts it out.
      if (!on.length) liftOut(limb);
    }
  };
  /** The limb's hand or foot lifted (by its reach) as far as it is in the floor. */
  const liftOut = (limb: (typeof LIMBS)[number]) => {
    for (let n = 0; n < 3; n++) {
      let low = Infinity;
      for (const bone of [...limb.joints.slice(2), ...limb.carried.slice(2).flat()]) for (const p of probePoints(bone)) low = Math.min(low, p.y);
      if (low >= FLOOR) break;
      reach(limb, 2, limb.joints[2]!.getWorldPosition(new THREE.Vector3()).add(tmpV.set(0, FLOOR - low, 0)), "if bent");
    }
  };

  /** One solve: the contacts on the floor (and planted ones where they stood), balance, the limbs. */
  const solve = (all: Contact[]) => {
    if (!all.length) return;
    const contacts = all.filter((c) => !c.rest);
    place(contacts);
    // Gravity: a support left in the air (the toes while the elbows touch, the shoulders while
    // the feet do) brings the body down onto it, pivoting about the touching one furthest away.
    for (let i = 0; i < 4 && contacts.length > 1; i++) {
      let float: Contact | null = null;
      let gap = 0.001;
      for (const c of contacts) {
        const d = c.bone.getWorldPosition(tmpV).y - c.height;
        if (d > gap) [float, gap] = [c, d];
      }
      if (!float) break;
      const fp = float.bone.getWorldPosition(tmpS).clone();
      // The pivot: the touching contacts furthest away, blended (two feet as far as each other
      // share it, so it doesn't flip between them).
      const touching = contacts.flatMap((c) => {
        const p = c.bone.getWorldPosition(new THREE.Vector3());
        return p.y - c.height < 0.005 ? [{ p, r: Math.hypot(p.x - fp.x, p.z - fp.z) }] : [];
      });
      const far = Math.max(0, ...touching.map((x) => x.r));
      if (far <= 0.1) break;
      const pivot = new THREE.Vector3();
      let wsum = 0;
      for (const x of touching) {
        const w = THREE.MathUtils.smoothstep(x.r, 0.8 * far, far) + 1e-6 * (x.r === far ? 1 : 0);
        pivot.addScaledVector(x.p, w);
        wsum += w;
      }
      pivot.divideScalar(wsum);
      const reachOut = Math.hypot(fp.x - pivot.x, fp.z - pivot.z);
      const dir = tmpA.set(fp.x - pivot.x, 0, fp.z - pivot.z).normalize();
      turnAbout(pivot, tmpS.crossVectors(UP, dir).normalize(), Math.atan2(gap, Math.max(reachOut, 0.05)));
      place(contacts);
    }
    // Standing: sway at the ankles (the feet stay flat) until the centre of mass, with what the
    // hands hold, is over the feet. A few degrees; a bigger lean is the move's own.
    if (contacts.every((c) => /^(foot|toe)/.test(c.bone.name) && c.height < 1.5)) {
      for (let i = 0; i < 3; i++) {
        const feet = supportOf(contacts);
        const com = centreOfMass(true);
        const at = nearestInside(com.x, com.z, feet);
        const miss = Math.hypot(com.x - at[0], com.z - at[1]);
        if (miss < 1e-4) break;
        const dir = tmpA.set(at[0] - com.x, 0, at[1] - com.z).normalize();
        const pivot = new THREE.Vector3(at[0], 0, at[1]);
        turnAbout(pivot, tmpS.crossVectors(UP, dir).normalize(), Math.min(0.18, Math.atan2(miss, Math.max(0.3, com.y))));
        place(contacts);
      }
    }
    // Hanging from a bar: the body swings until its centre of mass is right below the hands.
    if (contacts.some((c) => c.height > 1.5)) {
      for (let i = 0; i < 2; i++) {
        const wl = B("wrist.L").getWorldPosition(new THREE.Vector3());
        const wr = B("wrist.R").getWorldPosition(new THREE.Vector3());
        const grip = wl.clone().add(wr).multiplyScalar(0.5);
        const axis = wl.sub(wr).setY(0).normalize();
        const off = centreOfMass().sub(grip);
        const across = off.clone().sub(axis.clone().multiplyScalar(off.dot(axis)));
        const side = tmpA.crossVectors(UP, axis).normalize();
        turnAbout(grip, axis, -Math.atan2(across.dot(side), -across.y));
        place(contacts);
      }
    }
    limbs(all);
    floorUnder(all);
  };
  /** Anything else through the floor (the head lying back, a shoulder): the body rests on it. */
  const floorUnder = (contacts: Contact[]) => {
    let low = 0;
    for (const bone of sk.bones) {
      if (LIMBS.some((l) => l.joints.slice(1).includes(bone) || l.carried.slice(1).flat().includes(bone))) continue;
      for (const p of probePoints(bone)) low = Math.min(low, p.y - FLOOR);
    }
    if (low < -0.003) {
      hips.position.y -= low;
      root.updateMatrixWorld(true);
      limbs(contacts);
    }
  };

  /** The key poses' blend before any solving: joint angles, the body's turn and shift, the fingers. */
  const blend = (a: Q, b: Q, t: number) => {
    influences.fill(0);
    for (const [i, v] of a.hands) influences[i] = (influences[i] ?? 0) + v * (1 - t);
    for (const [i, v] of b.hands) influences[i] = (influences[i] ?? 0) + v * t;
    bones.forEach((bone, n) => {
      const x = a.rot.get(n);
      const y = b.rot.get(n);
      if (!x && !y) bone.quaternion.identity();
      else bone.quaternion.copy(x ?? qa.identity()).slerp(y ?? qa.identity(), t);
    });
    hips.quaternion.multiplyQuaternions(qa.copy(a.root).slerp(b.root, t), hips.quaternion);
    hips.position.copy(restRoot).add(tmpV.copy(a.shift).lerp(b.shift, t));
    root.updateMatrixWorld(true);
  };
  /** A pose's contacts as the solve takes them; a bone touching in both poses moves its height smoothly (a jump leaves the floor and lands). */
  const contactsOf = (own: Q, other: Q, t: number): Contact[] =>
    (own.contacts ?? []).flatMap((c) => {
      const bone = bones.get(named(c.bone));
      const o = other.contacts?.find((x) => x.bone === c.bone);
      const height = o ? c.height + (o.height - c.height) * (own === other ? 0 : t) : c.height;
      const open = c.bone.startsWith("wrist") && (own.open.get(c.bone.slice(-1)) ?? false);
      return bone ? [{ bone, lock: c.lock ? anchors.get(named(c.bone)) : undefined, height, open, rest: c.rest }] : [];
    });
  const sameContacts = (a: Q, b: Q) => {
    const k = (q: Q) => (q.contacts ?? []).map((c) => `${c.bone}:${!!c.lock}`).sort().join();
    return k(a) === k(b);
  };
  /** Each key pose solved on its own contacts (filled in once the planted points are known). */
  const solved = new Map<Q, { q: Map<THREE_NS.Bone, THREE_NS.Quaternion>; hips: THREE_NS.Vector3; ends: THREE_NS.Vector3[] }>();
  const snapshot = () => ({
    q: new Map([...bones.values()].map((bone) => [bone, bone.quaternion.clone()])),
    hips: hips.position.clone(),
    ends: LIMBS.map((l) => l.joints[2]!.getWorldPosition(new THREE.Vector3())),
  });

  /**
   * A blend of two key poses, solved on the floor. When the two rest on different things (a
   * foot lifting to step, the back coming off the floor), each key is solved on its own contacts
   * and the body moves between the two solutions: what it rests on hands over smoothly, and the
   * blend never forces one pose's contacts onto the other's shape.
   */
  const apply = (a: Q, b: Q, t: number) => {
    const sa = solved.get(a);
    const sb = solved.get(b);
    if (sameContacts(a, b) || !sa || !sb) {
      blend(a, b, t);
      solve(contactsOf(a, b, t));
    } else {
      blend(a, b, t);
      bones.forEach((bone) => bone.quaternion.copy(sa.q.get(bone)!).slerp(sb.q.get(bone)!, t));
      hips.position.lerpVectors(sa.hips, sb.hips, t);
      root.updateMatrixWorld(true);
      // What stays planted in both is pinned again (the blend of two bodies moves it), flat.
      const both = contactsOf(a, b, t).filter((c) => c.lock && contactsOf(b, a, 1 - t).some((x) => x.bone === c.bone && x.lock));
      if (both.length) limbs(both, true);
      // A hand or foot that changes what it rests on and travels (a step, a reach) lifts as it
      // goes, rather than dragging along the floor.
      const key = (q: Q, limb: (typeof LIMBS)[number]) => (q.contacts ?? []).filter((c) => limb.joints.includes(B(c.bone))).map((c) => `${c.bone}:${!!c.lock}`).sort().join();
      // (Rising early, so it leaves the floor before it travels far.)
      const arc = Math.sqrt(Math.sin(Math.PI * t));
      if (arc > 1e-3)
        LIMBS.forEach((limb, n) => {
          if (key(a, limb) === key(b, limb)) return;
          const travel = Math.hypot(sa.ends[n]!.x - sb.ends[n]!.x, sa.ends[n]!.z - sb.ends[n]!.z);
          const lift = 0.07 * arc * THREE.MathUtils.smoothstep(travel, 0.03, 0.15);
          // What lifts is what was on the floor: the knee when kneeling, else the hand or foot.
          const touching = [...(a.contacts ?? []), ...(b.contacts ?? [])].map((c) => limb.joints.indexOf(B(c.bone))).filter((i) => i >= 1);
          const j = Math.min(2, ...touching);
          if (lift <= 1e-4) return;
          const at = limb.joints[j]!.getWorldPosition(new THREE.Vector3());
          if (j === 2) return reach(limb, 2, at.add(tmpV.set(0, lift, 0)), "if bent");
          // A knee or elbow swings up on its circle round the hip or shoulder, the way the limb is
          // going (one hanging straight down can't rise by turning alone).
          const H = limb.joints[0]!.getWorldPosition(new THREE.Vector3());
          const v = at.clone().sub(H);
          const way = new THREE.Vector3(sb.ends[n]!.x - sa.ends[n]!.x, 0, sb.ends[n]!.z - sa.ends[n]!.z).normalize();
          const vw = v.dot(way);
          const rp = Math.hypot(vw, v.y);
          const up = (y: number) => Math.acos(THREE.MathUtils.clamp(-y / rp, -1, 1));
          // Turned in the plane of travel to `lift` above where it is (behind: exactly; still
          // ahead of straight down: by what raises it that much from hanging).
          const th0 = Math.atan2(vw, -v.y);
          const th = th0 >= 0 ? Math.max(th0, up(v.y + lift)) : th0 + up(v.y + lift) - up(v.y);
          const target = H.addScaledVector(way, rp * Math.sin(th) - vw).add(tmpV.set(0, -rp * Math.cos(th) - v.y, 0)).add(v);
          reach(limb, 1, target);
        });
      // Nothing in the floor: a free hand or foot lifts out; the body rests on anything else.
      for (const limb of LIMBS) if (!both.some((c) => limb.joints.includes(c.bone))) liftOut(limb);
      floorUnder(both);
    }
    if (equipment.held) {
      B("upperarm01.L").getWorldPosition(tmpV);
      B("upperarm01.R").getWorldPosition(tmpS);
      equipment.hold(gripOf("L"), gripOf("R"), tmpS.add(tmpV).multiplyScalar(0.5));
    }
    if (!baked) {
      hips.getWorldPosition(tmpV);
      for (const l of shadowLayers) l.mesh.position.set(tmpV.x, 0.002, tmpV.z);
    }
  };
  // Where planted points stand: where they are in the first pose whose limb is on the floor
  // (rising onto the toes, they stay where they were with the foot flat).
  const lockedBones = [...new Set(keys.flatMap((k) => (k.contacts ?? []).filter((c) => c.lock).map((c) => c.bone)))];
  for (const k of keys) {
    apply(k, k, 0);
    for (const name of lockedBones) {
      const bone = bones.get(named(name));
      if (!bone || anchors.has(named(name))) continue;
      const limb = LIMBS.find((l) => l.joints.includes(bone));
      const onFloor = (k.contacts ?? []).some((c) => (limb ? limb.joints.includes(B(c.bone)) : c.bone === name));
      if (!onFloor) continue;
      bone.getWorldPosition(tmpV);
      anchors.set(named(name), [tmpV.x, tmpV.z]);
    }
  }

  for (const k of keys) {
    apply(k, k, 0);
    solved.set(k, snapshot());
  }

  // The reach: head, hands, knees and feet in every key pose (a still: in its own), with a
  // margin for the body round them.
  const box = new THREE.Box3();
  const stillKey = Math.min(keys.length - 1, move?.still ?? 1);
  for (const k of tight ? [keys[stillKey]!] : keys) {
    apply(k, k, 0);
    for (const n of ["head", "root", "wrist.L", "wrist.R", "toe1-1.L", "toe1-1.R", "foot.L", "foot.R", "lowerleg01.L", "lowerleg01.R", "upperarm01.L", "upperarm01.R"]) {
      bones.get(named(n))?.getWorldPosition(tmpV);
      box.expandByPoint(tmpV);
    }
  }
  box.max.y += 0.2; // the top of the head
  box.expandByScalar(tight ? 0.04 : 0.07);
  box.min.y = Math.min(box.min.y, 0);
  const centre = box.getCenter(new THREE.Vector3());
  if (move?.focusY !== undefined) centre.y = move.focusY;
  if (Array.isArray(move?.focus)) centre.set(...move.focus);
  else if (move?.focus) {
    // A bone (close-ups): where it is in the key pose a still shows.
    const k = keys[Math.min(keys.length - 1, move.still ?? 1)]!;
    apply(k, k, 0);
    bones.get(named(move.focus))?.getWorldPosition(centre);
  }
  const half = (box.max.y - box.min.y) / 2;
  const radius = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
  // A bench under a foot: its top just below where the foot rests in the first pose.
  apply(keys[0]!, keys[0]!, 0);
  for (const { prop: p, mesh: m } of equipment.boxes) {
    if (!p.under) continue;
    bones.get(named(p.under))?.getWorldPosition(tmpV);
    const h = Math.max(0.1, tmpV.y - 0.065 + p.at[1]);
    m.scale.y = h / p.box[1];
    m.position.set(tmpV.x + p.at[0], h / 2, tmpV.z + p.at[2]);
  }
  equipment.settle(gripOf("L"), gripOf("R"));

  // ---------------------------------------------------------------- camera
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 30);
  const angle = (angleDeg * Math.PI) / 180;
  const pitch = ((move?.pitch ?? 4.6) * Math.PI) / 180;
  camera.position.set(Math.sin(angle) * Math.cos(pitch), Math.sin(pitch), Math.cos(angle) * Math.cos(pitch)).add(centre);
  /** Fit everything the body reaches to the view, from the direction the camera looks now. */
  const fit = (aspect: number, target: THREE_NS.Vector3) => {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    const t = Math.tan((camera.fov * Math.PI) / 360);
    const d = (move?.distance ?? 1) * (Math.max(half / t, radius / (t * aspect)) + radius * 0.35);
    const dir = tmpA.copy(camera.position).sub(target).normalize();
    target.copy(centre);
    camera.position.copy(centre).addScaledVector(dir, d);
    camera.lookAt(centre);
  };

  // ---------------------------------------------------------------- the loop
  const seg = move ? move.move + move.hold : 1;
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  let last = "";
  const poseAt = (time: number): boolean => {
    let i = 0;
    let t = 0;
    if (move && keys.length > 1) {
      const total = seg * keys.length;
      const tt = ((time % total) + total) % total;
      i = Math.min(keys.length - 1, Math.floor(tt / seg));
      const into = tt - i * seg;
      t = into < move.hold ? 0 : ease(Math.min(1, (into - move.hold) / move.move));
    }
    const k = `${i}:${t.toFixed(4)}`;
    if (k === last) return false;
    last = k;
    apply(keys[i]!, keys[(i + 1) % keys.length]!, t);
    shadowAt(i, (i + 1) % keys.length, t);
    return true;
  };
  /** The key pose a still shows: the working position. */
  const stillTime = move ? seg * (move.still ?? 1) : 0;

  const dispose = () => {
    material.dispose();
    fabricMaterial.dispose();
    geo.dispose();
    if (!baked) shadowTex.dispose();
    for (const l of shadowLayers) {
      l.map.dispose();
      l.mat.dispose();
    }
    shadowGeo.dispose();
    equipment.dispose();
  };
  return { scene, camera, fit, centre, poseAt, seg, stillTime, animated: !!move && keys.length > 1, paint, dispose, mesh: body, equipment: equipment.group, cycle: seg * keys.length };
}

export interface BodyView {
  setMuscles(primary: readonly Muscle[], secondary: readonly Muscle[]): void;
  dispose(): void;
}

/** Seconds untouched before a moving body settles on its key pose (and stops drawing). */
const IDLE_S = 60;

/**
 * A live body in `host`: the muscles lit, turning slowly when `turn`, moving through `exercise`
 * when given; drag to turn it yourself. Still under reduced motion (on the exercise's key pose),
 * or at key pose `hold` (tests).
 */
export async function bodyView(host: HTMLElement, o: BodyOptions & { turn?: boolean; interactive?: boolean; view?: "front" | "side" | "back"; angle?: number; hold?: number }): Promise<BodyView> {
  const L = await load();
  const reduced = o.hold !== undefined || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const { renderer, env } = makeRenderer(L);
  const canvas = renderer.domElement;
  canvas.className = "body3d-canvas";
  const move = o.exercise ? MOVES[o.exercise] : undefined;
  const angle = o.angle ?? (o.view === "back" ? 180 : o.view === "side" ? 90 : (move?.angle ?? 0));
  let fig: Awaited<ReturnType<typeof figure>>;
  try {
    fig = await figure(L, env, o, angle);
  } catch (e) {
    env.dispose();
    renderer.dispose();
    throw e;
  }
  host.append(canvas);
  const { camera } = fig;

  const controls = new L.OrbitControls(camera, canvas);
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = Math.PI * 0.2;
  controls.maxPolarAngle = Math.PI * 0.62;
  controls.target.copy(fig.centre);
  if (o.interactive === false) {
    // Not turned by hand: a finger on it scrolls the page as usual.
    controls.enableRotate = false;
    canvas.style.touchAction = "pan-y";
  }
  controls.autoRotate = !!o.turn && !reduced;
  controls.autoRotateSpeed = 1.2;
  let dirty = true;
  let touched = performance.now();
  controls.addEventListener("change", () => (dirty = true));
  controls.addEventListener("start", () => {
    controls.autoRotate = false;
    touched = performance.now();
    wake();
  });

  const size = () => {
    const w = host.clientWidth || 300;
    const h = host.clientHeight || 300;
    renderer.setSize(w, h, false);
    fig.fit(w / h, controls.target);
    controls.update();
    dirty = true;
    wake();
  };
  const ro = new ResizeObserver(size);

  const animated = fig.animated && !reduced;
  const still = o.hold !== undefined ? fig.seg * o.hold : fig.stillTime;
  fig.poseAt(animated ? 0 : still);

  // Draw only while on screen, the page is showing, and something changed.
  let visible = true;
  let frame = 0;
  let clock = 0;
  let prev = 0;
  const loop = (now: number) => {
    frame = 0;
    if (!canvas.isConnected) return dispose();
    if (!visible || document.hidden) return;
    const dt = prev ? Math.min(0.1, (now - prev) / 1000) : 0;
    prev = now;
    const idle = (now - touched) / 1000 > IDLE_S;
    let changed = false;
    if (animated) {
      if (!idle) clock += dt;
      changed = fig.poseAt(idle ? still : clock);
    }
    const moved = controls.update();
    if (changed || moved || dirty) {
      renderer.render(fig.scene, camera);
      dirty = false;
    }
    // Keep going while something can still change: the move, a turn, the damping settling.
    if ((animated && !idle) || moved || controls.autoRotate) frame = requestAnimationFrame(loop);
    else prev = 0;
  };
  function wake() {
    if (!frame && visible && !document.hidden && canvas.isConnected) frame = requestAnimationFrame(loop);
  }
  const io = new IntersectionObserver(([e]) => {
    if (!canvas.isConnected) return dispose();
    visible = !!e?.isIntersecting;
    prev = 0;
    wake();
  });
  const onVis = () => {
    prev = 0;
    wake();
  };
  // The theme changes: the clay follows.
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    fig.paint(o.primary, o.secondary);
    dirty = true;
    wake();
  };
  // A tap brings a settled body back to life.
  const onTap = () => {
    touched = performance.now();
    wake();
  };

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    io.disconnect();
    ro.disconnect();
    document.removeEventListener("visibilitychange", onVis);
    scheme.removeEventListener("change", onScheme);
    controls.dispose();
    fig.dispose();
    env.dispose();
    renderer.dispose();
    canvas.remove();
  }
  ro.observe(host);
  io.observe(host);
  document.addEventListener("visibilitychange", onVis);
  scheme.addEventListener("change", onScheme);
  canvas.addEventListener("pointerdown", onTap);
  canvas.addEventListener("webglcontextlost", dispose);
  size();
  return {
    setMuscles: (p, s) => {
      fig.paint(p, s);
      dirty = true;
      wake();
    },
    dispose,
  };
}

// ---------------------------------------------------------------- stills

let stillRenderer: { renderer: THREE_NS.WebGLRenderer; env: THREE_NS.Texture } | null = null;
const stills = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * An exercise's key pose as an image (a list's thumbnail), from one shared renderer, one at a
 * time, kept for the session. Colours follow the theme at the time it's drawn.
 */
export function bodyStill(o: BodyOptions & { width: number; height: number; angle?: number }): Promise<string> {
  const id = `${o.body ?? "m"}|${o.exercise ?? ""}|${o.primary.join()}|${o.secondary.join()}|${o.width}x${o.height}|${o.angle ?? ""}|${darkMode() ? "d" : "l"}`;
  let p = stills.get(id);
  if (!p) {
    const run = queue.catch(() => {}).then(async () => {
      const L = await load();
      stillRenderer ??= makeRenderer(L, true);
      const { renderer, env } = stillRenderer;
      const move = o.exercise ? MOVES[o.exercise] : undefined;
      const fig = await figure(L, env, o, o.angle ?? move?.angle ?? 0, true);
      try {
        renderer.setSize(o.width, o.height, false);
        fig.fit(o.width / o.height, fig.centre.clone());
        fig.poseAt(fig.stillTime);
        renderer.render(fig.scene, fig.camera);
        return renderer.domElement.toDataURL("image/png");
      } finally {
        fig.dispose();
      }
    });
    queue = run;
    p = run;
    stills.set(id, p);
    p.catch(() => stills.delete(id));
  }
  return p;
}

/**
 * Tartan 2: a body as pictures, for the native screens (which draw no WebGL of their own).
 * `loop` frames go once through the exercise's move, evenly, at its own angle; `turn` frames
 * show its key pose all the way round, for a finger to turn. WebP with alpha, from the shared
 * still renderer, one request at a time.
 */
export function bodyFrames(o: BodyOptions & { width: number; height: number; loop?: number; turn?: number; angle?: number }): Promise<{ loop: string[]; turn: string[]; cycle: number }> {
  const run = queue.catch(() => {}).then(async () => {
    const L = await load();
    stillRenderer ??= makeRenderer(L, true);
    const { renderer, env } = stillRenderer;
    const move = o.exercise ? MOVES[o.exercise] : undefined;
    const fig = await figure(L, env, o, o.angle ?? move?.angle ?? 0, true);
    const breathe = () => new Promise((r) => setTimeout(r, 0));
    try {
      renderer.setSize(o.width, o.height, false);
      fig.fit(o.width / o.height, fig.centre.clone());
      const shot = () => {
        renderer.render(fig.scene, fig.camera);
        return renderer.domElement.toDataURL("image/webp", 0.86);
      };
      const loop: string[] = [];
      const n = fig.animated ? (o.loop ?? 0) : Math.min(1, o.loop ?? 0);
      for (let i = 0; i < n; i++) {
        fig.poseAt(fig.animated ? (i / n) * fig.cycle : fig.stillTime);
        loop.push(shot());
        await breathe();
      }
      const turn: string[] = [];
      if (o.turn) {
        fig.poseAt(fig.stillTime);
        const c = fig.centre;
        const off = fig.camera.position.clone().sub(c);
        const up = new L.THREE.Vector3(0, 1, 0);
        for (let i = 0; i < o.turn; i++) {
          fig.camera.position.copy(c).add(off.clone().applyAxisAngle(up, (i / o.turn) * Math.PI * 2));
          fig.camera.lookAt(c);
          turn.push(shot());
          await breathe();
        }
      }
      return { loop, turn, cycle: fig.animated ? fig.cycle : 0 };
    } finally {
      fig.dispose();
    }
  });
  queue = run;
  return run;
}
