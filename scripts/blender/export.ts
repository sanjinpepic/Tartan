/**
 * Export exercises as the app poses them, for Blender (scripts/blender/render.py and
 * render-shadows.py): the 3D body (web/lib/body3d.ts) posed in headless Chromium, written as
 * JSON (triangles, vertex colours, world positions per frame, the app's camera).
 *
 *   bun scripts/blender/export.ts <exercise|all> <m|f|both> <frames|keys> <out> [aspect] [angle]
 *
 * frames: that many frames evenly over one loop (1 = the key pose a still shows); keys: each key
 * pose once. One exercise and body write <out> as a file; "all" or "both" write <out>/<id>-<m|f>.json
 * ("all" adds "stand", the body standing at ease). aspect = width / height of a render (0.75).
 */
import { chromium } from "playwright-core";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [exArg = "squat", bodyArg = "m", framesArg = "1", out = "body.json", aspect = "0.75", angle] = process.argv.slice(2);
const root = resolve(import.meta.dir, "../..");
const { EXERCISES } = await import(join(root, "src/strength/exercises.ts"));
const exercises: string[] = exArg === "all" ? ["stand", ...EXERCISES.map((e: { id: string }) => e.id)] : [exArg];
const bodies = bodyArg === "both" ? ["m", "f"] : [bodyArg];
const many = exercises.length > 1 || bodies.length > 1;
if (many) mkdirSync(out, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "tartan-export-"));
writeFileSync(
  join(dir, "entry.ts"),
  `import * as THREE from ${JSON.stringify(join(root, "node_modules/three/build/three.module.js"))};
import { toolFigure } from ${JSON.stringify(join(root, "web/lib/body3d.ts"))};
import { EXERCISES } from ${JSON.stringify(join(root, "src/strength/exercises.ts"))};
import { MOVES } from ${JSON.stringify(join(root, "web/lib/moves.ts"))};
const save = (window as unknown as { save: (name: string, json: string) => Promise<void> }).save;
for (const id of ${JSON.stringify(exercises)}) for (const body of ${JSON.stringify(bodies)}) {
  const ex = EXERCISES.find((e) => e.id === id) ?? { id, primary: [], secondary: [] };
  const { fig } = await toolFigure({ exercise: id === "stand" ? undefined : id, body, primary: ex.primary, secondary: ex.secondary }, ${angle ?? "undefined"} ?? MOVES[id]?.angle ?? 0, new THREE.Texture());
  const mesh = fig.mesh;
  const geo = mesh.geometry;
  const n = geo.attributes.position.count;
  const v = new THREE.Vector3();
  const keys = Math.round(fig.cycle / fig.seg);
  const times = ${JSON.stringify(framesArg)} === "keys" ? Array.from({ length: id === "stand" ? 1 : keys }, (_, i) => i * fig.seg)
    : Number(${JSON.stringify(framesArg)}) === 1 ? [fig.stillTime]
    : Array.from({ length: Number(${JSON.stringify(framesArg)}) }, (_, i) => (i / Number(${JSON.stringify(framesArg)})) * fig.cycle);
  const frames = [];
  // The equipment (bench, barbell…), as triangles in the world, frame by frame: it casts shadows too.
  const parts: Array<{ geo: THREE.BufferGeometry; obj: THREE.Object3D }> = [];
  fig.equipment.traverse((o) => { if ((o as THREE.Mesh).isMesh) parts.push({ geo: (o as THREE.Mesh).geometry, obj: o }); });
  const propIndex: number[] = [];
  let base = 0;
  for (const { geo: g } of parts) {
    const n2 = g.attributes.position.count;
    const ix = g.index ? Array.from(g.index.array) : Array.from({ length: n2 }, (_, i) => i);
    for (const i of ix) propIndex.push(i + base);
    base += n2;
  }
  const propFrames = [];
  const boneFrames = [];
  for (const t of times) {
    fig.poseAt(t + 1e-6 * Math.random());
    mesh.updateMatrixWorld(true);
    fig.equipment.updateMatrixWorld(true);
    const pa = [];
    for (const { geo: g, obj } of parts) {
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
        pa.push(+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4));
      }
    }
    propFrames.push(pa);
    // Every bone's place, for scripts/blender/check-moves.ts (balance and contacts).
    const bp: Record<string, number[]> = {};
    for (const b of mesh.skeleton.bones) bp[b.name] = b.getWorldPosition(v).toArray().map((x) => +x.toFixed(4));
    boneFrames.push(bp);
    const a = new Array(n * 3);
    // The cloth's vertices follow eight bones (its shader adds the second four; three's own
    // getVertexPosition knows four), so they are skinned here by hand.
    const j1 = geo.getAttribute("_joints1"), w1 = geo.getAttribute("_weights1");
    const sj = geo.getAttribute("skinIndex"), sw = geo.getAttribute("skinWeight");
    const bm = mesh.skeleton.bones.map((b, k) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, mesh.skeleton.boneInverses[k]));
    const rest = new THREE.Vector3(), part = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      if (w1 && w1.getX(i) > 0) {
        rest.fromBufferAttribute(geo.attributes.position, i).applyMatrix4(mesh.bindMatrix);
        v.set(0, 0, 0);
        for (const [J, Wt] of [[sj, sw], [j1, w1]]) for (let k = 0; k < 4; k++) {
          const w = Wt.getComponent(i, k);
          if (w) v.add(part.copy(rest).applyMatrix4(bm[J.getComponent(i, k)]).multiplyScalar(w));
        }
        v.applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);
      } else mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      a[i * 3] = +v.x.toFixed(5); a[i * 3 + 1] = +v.y.toFixed(5); a[i * 3 + 2] = +v.z.toFixed(5);
    }
    frames.push(a);
  }
  fig.poseAt(fig.stillTime + 1e-6);
  fig.fit(${Number(aspect)}, fig.centre.clone());
  await save(id + "-" + body, JSON.stringify({ exercise: id, body, n, index: Array.from(geo.index.array), colors: Array.from(geo.attributes.color.array, (x) => +x.toFixed(4)), frames, props: { index: propIndex, frames: propFrames }, bones: boneFrames, fps: times.length > 1 ? times.length / fig.cycle : 0, cam: { pos: fig.camera.position.toArray(), target: fig.centre.toArray(), fov: fig.camera.fov, aspect: ${Number(aspect)} } }));
  fig.dispose();
}
document.body.dataset.ready = "1";
`,
);
const built = await Bun.build({ entrypoints: [join(dir, "entry.ts")], outdir: join(dir, "out"), splitting: true, format: "esm", loader: { ".glb": "file" } });
if (!built.success) throw new Error(built.logs.join("\n"));
writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><style>:root{--primary:#a8321f}</style><script type="module" src="./out/entry.js"></script>`);
// Assets (the body) are asked for from the page's folder; they sit with the code in out/.
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    for (const f of [Bun.file(join(dir, p)), Bun.file(join(dir, "out", p))]) if (await f.exists()) return new Response(f);
    return new Response("", { status: 404 });
  },
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page:", e.message));
await page.exposeFunction("save", async (name: string, json: string) => {
  const file = many ? join(out, `${name}.json`) : out;
  await Bun.write(file, json);
  console.log(file);
});
await page.goto(`${server.url}index.html`);
await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 30 * 60_000, polling: 1000 });
await browser.close();
server.stop(true);
