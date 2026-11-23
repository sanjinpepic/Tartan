"""
Bake Blender's floor shadows for the live 3D body: for every exercise and body exported with
`bun scripts/blender/export.ts all both keys <dir>`, Cycles renders each key pose's shadow on the
floor from straight above (the body itself hidden from the camera, the same studio lights as
scripts/blender/render.py, a soft key, a rim, a fill and the room), and the poses go side by side
into one small greyscale strip, web/assets/shadows/<exercise>-<m|f>.png (white = shadow). It also
writes web/assets/shadows/index.ts: where each strip lies on the floor, for web/lib/body3d.ts,
which crossfades between the key poses' shadows as the body moves.

  python scripts/blender/render-shadows.py <dir> [pixels samples]
"""
import glob, json, math, os, sys
import numpy as np
import bpy
from mathutils import Vector
from PIL import Image

SRC = sys.argv[1]
PX, SAMPLES = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (160, 48)
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "web", "assets", "shadows")
os.makedirs(OUT, exist_ok=True)


def conv(a):  # three: y up, z forward -> blender: z up, -y forward
    a = np.asarray(a, dtype=np.float64).reshape(-1, 3)
    return np.stack([a[:, 0], -a[:, 2], a[:, 1]], 1)


def scene_for(d, cx, cz, size):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    me = bpy.data.meshes.new("body")
    me.from_pydata(conv(d["frames"][0]).tolist(), [], np.asarray(d["index"]).reshape(-1, 3).tolist())
    me.update()
    me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), dtype=bool))
    body = bpy.data.objects.new("body", me)
    body.visible_camera = False  # casts its shadow, isn't seen
    scene.collection.objects.link(body)
    props = None
    if d.get("props") and d["props"]["index"]:
        pm = bpy.data.meshes.new("props")
        pm.from_pydata(conv(d["props"]["frames"][0]).tolist(), [], np.asarray(d["props"]["index"]).reshape(-1, 3).tolist())
        pm.update()
        props = bpy.data.objects.new("props", pm)
        props.visible_camera = False
        scene.collection.objects.link(props)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    bpy.context.active_object.is_shadow_catcher = True
    target = Vector((cx, -cz, 0.8))

    def area(name, loc, sz, power):
        l = bpy.data.lights.new(name, "AREA")
        l.size = sz
        l.energy = power
        o = bpy.data.objects.new(name, l)
        o.location = Vector(loc) + Vector((cx, -cz, 0))
        o.rotation_mode = "QUATERNION"
        o.rotation_quaternion = (target - o.location).to_track_quat("-Z", "Y")
        scene.collection.objects.link(o)

    area("key", (1.8, -3.0, 3.4), 2.5, 190)
    area("rim", (-2.4, 2.8, 2.6), 1.6, 260)
    area("fill", (-2.8, -2.2, 1.2), 3.0, 35)
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.color = (0.14, 0.13, 0.13)
    cam_d = bpy.data.cameras.new("cam")
    cam_d.type = "ORTHO"
    cam_d.ortho_scale = size
    cam = bpy.data.objects.new("cam", cam_d)
    cam.location = (cx, -cz, 10)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = PX
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    return scene, me, (props.data if props else None)


# The square's edge must never show: the faint room-light darkening is dropped (a floor of 3%)
# and everything fades out over the outer fifth of the square.
_r = np.linspace(-1, 1, PX)
_edge = np.clip((1 - np.maximum(np.abs(_r)[None, :], np.abs(_r)[:, None])) / 0.2, 0, 1)
_edge = _edge * _edge * (3 - 2 * _edge)


def soften(alpha):
    return np.clip((alpha - 0.03) / 0.97, 0, 1) * _edge


manifest = {}
tmp = os.path.join(OUT, "_tmp.png")
for path in sorted(glob.glob(os.path.join(SRC, "*.json"))):
    d = json.load(open(path))
    pts = np.concatenate([np.asarray(f).reshape(-1, 3) for f in d["frames"] + (d.get("props") or {}).get("frames", [])])
    lo, hi = pts.min(0), pts.max(0)
    cx, cz = float((lo[0] + hi[0]) / 2), float((lo[2] + hi[2]) / 2)
    # Room round the body for the soft shadow to fade out; a square, in metres.
    size = float(round(max(hi[0] - lo[0], hi[2] - lo[2]) + 1.8, 2))
    scene, me, pm = scene_for(d, cx, cz, size)
    strips = []
    for k, f in enumerate(d["frames"]):
        me.vertices.foreach_set("co", conv(f).ravel())
        me.update()
        if pm is not None:
            pm.vertices.foreach_set("co", conv(d["props"]["frames"][k]).ravel())
            pm.update()
        scene.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        alpha = np.asarray(Image.open(tmp).convert("RGBA"))[:, :, 3].astype(np.float64) / 255
        strips.append(np.round(soften(alpha) * 255))
    img = Image.fromarray(np.concatenate(strips, 1).astype(np.uint8), "L")
    name = f"{d['exercise']}-{d['body']}"
    img.save(os.path.join(OUT, f"{name}.png"), optimize=True)
    manifest[name] = {"poses": len(strips), "x": round(cx, 3), "z": round(cz, 3), "size": size}
    print(name, len(strips), "poses", f"{size} m", flush=True)
os.remove(tmp)

names = sorted(manifest)
ident = lambda n: "s_" + n.replace("-", "_")
lines = [
    "/** Floor shadows baked in Blender (scripts/blender/render-shadows.py; generated, don't edit). */",
    *[f'import {ident(n)} from "./{n}.png";' for n in names],
    "",
    "/** Per exercise and body: the strip (one square per key pose, white = shadow), and the floor square it covers. */",
    "export const SHADOWS: Record<string, { url: string; poses: number; x: number; z: number; size: number }> = {",
    *[f'  "{n}": {{ url: {ident(n)}, poses: {manifest[n]["poses"]}, x: {manifest[n]["x"]}, z: {manifest[n]["z"]}, size: {manifest[n]["size"]} }},' for n in names],
    "};",
    "",
]
open(os.path.join(OUT, "index.ts"), "w").write("\n".join(lines))
