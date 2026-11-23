/**
 * Motion check for the 3D moves, through every frame of every loop (check-moves.ts checks the
 * key poses only): the body posed by the app's own code (web/lib/body3d.ts) in headless
 * Chromium, sampled finely over each exercise's cycle, for both bodies.
 *
 * - Through the floor: the skin's lowest point below the floor (a sample of its vertices).
 * - Through a bench: skin inside a box prop by more than 1.5 cm.
 * - Chops: a frame where the body jumps much further than in the frames either side of it
 *   (the contact solve switching what it rests on, a pivot flipping).
 * - Sliding: a planted (locked) contact moving along the floor.
 *
 *   bun scripts/blender/check-motion.ts [exercise|all] [m|f|both] [frames per second]   (exits 1 on a problem)
 */
import { chromium } from "playwright-core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [exArg = "all", bodyArg = "both", fpsArg = "60"] = process.argv.slice(2);
const root = resolve(import.meta.dir, "../..");
const { EXERCISES } = await import(join(root, "src/strength/exercises.ts"));
const exercises: string[] = exArg === "all" ? EXERCISES.map((e: { id: string }) => e.id) : exArg.split(",");
const bodies = bodyArg === "both" ? ["m", "f"] : [bodyArg];

const dir = mkdtempSync(join(tmpdir(), "tartan-motion-"));
writeFileSync(
  join(dir, "entry.ts"),
  `import * as THREE from ${JSON.stringify(join(root, "node_modules/three/build/three.module.js"))};
import { toolFigure } from ${JSON.stringify(join(root, "web/lib/body3d.ts"))};
import { MOVES } from ${JSON.stringify(join(root, "web/lib/moves.ts"))};
const report = (window as unknown as { report: (json: string) => Promise<void> }).report;
const FPS = ${Number(fpsArg)};
for (const id of ${JSON.stringify(exercises)}) for (const body of ${JSON.stringify(bodies)}) {
  const { fig } = await toolFigure({ exercise: id, body, primary: [], secondary: [] }, 0, new THREE.Texture());
  const mesh = fig.mesh;
  const geo = mesh.geometry;
  const garments = (geo.groups[1]?.start ?? geo.index.count);
  let skinEnd = 0;
  for (let i = 0; i < garments; i++) skinEnd = Math.max(skinEnd, geo.index.getX(i));
  const sample = [];
  for (let i = 0; i <= skinEnd; i += 3) sample.push(i);
  const bones = mesh.skeleton.bones;
  const locked = (MOVES[id]?.poses ?? []).flatMap((p) => (p.contacts ?? []).filter((c) => c.lock).map((c) => c.bone.replace(/[.]/g, "")));
  const lockedBones = [...new Set(locked)].map((n) => bones.find((b) => b.name === n)).filter(Boolean);
  const boxes = [];
  fig.equipment.traverse((o) => { if (o.isMesh && o.geometry.type === "RoundedBoxGeometry") boxes.push(o); });
  const n = Math.max(2, Math.round(fig.cycle * FPS));
  const v = new THREE.Vector3();
  const frames = [];
  let prev = null;
  for (let f = 0; f <= n; f++) {
    const t = (f / n) * fig.cycle;
    fig.poseAt(t + 1e-7 * (f + 1));
    mesh.updateMatrixWorld(true);
    fig.equipment.updateMatrixWorld(true);
    let low = Infinity, lowBone = "";
    let deep = 0, deepBone = "";
    const bb = boxes.map((b) => new THREE.Box3().setFromObject(b));
    for (const i of sample) {
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      if (v.y < low) { low = v.y; lowBone = bones[geo.attributes.skinIndex.getX(i)].name; }
      for (const b of bb) if (b.containsPoint(v)) {
        const d = Math.min(v.x - b.min.x, b.max.x - v.x, v.z - b.min.z, b.max.z - v.z, b.max.y - v.y);
        if (d > deep) { deep = d; deepBone = bones[geo.attributes.skinIndex.getX(i)].name; }
      }
    }
    const pos = bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
    const steps = prev ? pos.map((p, k) => p.distanceTo(prev[k])) : [0];
    const step = Math.max(...steps);
    const stepBone = bones[steps.indexOf(step)]?.name ?? "";
    const slide = lockedBones.map((b) => { const p = b.getWorldPosition(new THREE.Vector3()); return [b.name, p.x, p.y, p.z]; });
    frames.push({ t: +t.toFixed(3), low: +low.toFixed(4), lowBone, deep: +deep.toFixed(4), deepBone, step: +step.toFixed(4), stepBone, slide });
    prev = pos;
  }
  await report(JSON.stringify({ id, body, cycle: fig.cycle, seg: fig.seg, frames }));
  fig.dispose();
}
document.body.dataset.ready = "1";
`,
);
const built = await Bun.build({ entrypoints: [join(dir, "entry.ts")], outdir: join(dir, "out"), splitting: true, format: "esm", loader: { ".glb": "file", ".png": "file" } });
if (!built.success) throw new Error(built.logs.join("\n"));
writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><script type="module" src="./out/entry.js"></script>`);
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    for (const f of [Bun.file(join(dir, p)), Bun.file(join(dir, "out", p))]) if (await f.exists()) return new Response(f);
    return new Response("", { status: 404 });
  },
});

type Frame = { t: number; low: number; lowBone: string; deep: number; deepBone: string; step: number; stepBone: string; slide: Array<[string, number, number, number]> };
let problems = 0;
const rows: string[] = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page:", e.message));
await page.exposeFunction("report", async (json: string) => {
  const d = JSON.parse(json) as { id: string; body: string; cycle: number; seg: number; frames: Frame[] };
  const F = d.frames;
  const issues: string[] = [];
  const at = (f: Frame) => `${(f.t / d.seg).toFixed(2)} keys in`;
  // Through the floor (1 cm of give: the skin presses into the floor where it rests).
  const floor = F.reduce((m, f) => (f.low < m.low ? f : m), F[0]!);
  if (floor.low < -0.01) issues.push(`through the floor ${Math.round(-floor.low * 100)} cm (${floor.lowBone}, ${at(floor)})`);
  const bench = F.reduce((m, f) => (f.deep > m.deep ? f : m), F[0]!);
  if (bench.deep > 0.015) issues.push(`into the bench ${Math.round(bench.deep * 100)} cm (${bench.deepBone}, ${at(bench)})`);
  // Chops: a step more than 2.5× its neighbours' and over 6 mm.
  for (let i = 2; i < F.length - 1; i++) {
    const s = F[i]!.step, around = (F[i - 1]!.step + F[i + 1]!.step) / 2;
    if (s > 0.006 && s > 2.5 * around + 0.002) issues.push(`chop ${Math.round(s * 1000)} mm (${F[i]!.stepBone}, around ${Math.round(around * 1000)}) at ${at(F[i]!)}`);
  }
  // Sliding: a locked contact on the floor moving along it.
  const names = F[0]!.slide.map((s) => s[0]);
  names.forEach((name, k) => {
    let moved = 0;
    let base: [number, number] | null = null;
    const rest = Math.min(...F.map((f) => f.slide[k]![2]));
    for (const f of F) {
      const [, x, y, z] = f.slide[k]!;
      if (y > rest + 0.012 && y < 1.5) { base = null; continue; } // lifted (a step, a reach)
      if (!base) base = [x, z];
      moved = Math.max(moved, Math.hypot(x - base[0], z - base[1]));
    }
    if (moved > 0.02) issues.push(`${name} slides ${Math.round(moved * 100)} cm`);
  });
  if (issues.length) {
    problems++;
    rows.push(`${d.id}-${d.body}: ${issues.slice(0, 6).join("; ")}${issues.length > 6 ? ` (+${issues.length - 6})` : ""}`);
  }
  console.log(`${d.id}-${d.body}: ${issues.length ? issues.length + " issue(s)" : "ok"}`);
});
await page.goto(`${server.url}index.html`);
await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 60 * 60_000, polling: 1000 });
await browser.close();
server.stop(true);
console.log(rows.length ? `\n${rows.join("\n")}` : "\nEvery frame of every move: on the floor, smooth, planted feet planted.");
process.exit(problems ? 1 : 0);
