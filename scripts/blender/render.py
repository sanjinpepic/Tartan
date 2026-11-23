"""
Render an exercise exported by scripts/blender/export.ts in Blender Cycles, for comparing with
the app's live 3D: subdivided skin, soft studio light, subsurface clay, real contact shadows on a
shadow-catcher floor (transparent film; composite onto the app's stage colour afterwards).

  pip install bpy==5.2.2 numpy   (Blender as a Python module, Python 3.13)
  python scripts/blender/render.py body.json frames/f- [width height samples]
  ffmpeg -f lavfi -i color=c=0xf3eeec:s=WxH:r=24 -framerate 24 -i frames/f-%03d.png \
    -filter_complex "[0][1]overlay=format=auto:shortest=1" -pix_fmt yuv420p clip.mp4
"""
import json, math, sys
import numpy as np
import bpy

src, prefix = sys.argv[1], sys.argv[2]
W, H, SAMPLES = (int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])) if len(sys.argv) > 5 else (600, 800, 64)
d = json.load(open(src))
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def conv(a):  # three: y up, z forward -> blender: z up, -y forward
    a = np.asarray(a, dtype=np.float64).reshape(-1, 3)
    return np.stack([a[:, 0], -a[:, 2], a[:, 1]], 1)

faces = np.asarray(d["index"]).reshape(-1, 3)
me = bpy.data.meshes.new("body")
me.from_pydata(conv(d["frames"][0]).tolist(), [], faces.tolist())
me.update()
me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), dtype=bool))
col = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
c = np.asarray(d["colors"]).reshape(-1, 3)
col.data.foreach_set("color", np.hstack([c, np.ones((len(c), 1))]).ravel())
body = bpy.data.objects.new("body", me)
scene.collection.objects.link(body)
sub = body.modifiers.new("sub", "SUBSURF")
sub.levels = 1
sub.render_levels = 2

mat = bpy.data.materials.new("clay")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
attr = nt.nodes.new("ShaderNodeVertexColor")
attr.layer_name = "Col"
nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.52
bsdf.inputs["Subsurface Weight"].default_value = 0.12
bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.45, 0.3)
bsdf.inputs["Subsurface Scale"].default_value = 0.02
bsdf.inputs["Sheen Weight"].default_value = 0.25
bsdf.inputs["Coat Weight"].default_value = 0.06
body.data.materials.append(mat)

# Floor: catches shadows only.
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
floor = bpy.context.active_object
floor.is_shadow_catcher = True

# Light: a big soft key, a warm rim, a fill, and a dim warm room.
def area(name, loc, size, power, color=(1, 1, 1)):
    l = bpy.data.lights.new(name, "AREA")
    l.size = size
    l.energy = power
    l.color = color
    o = bpy.data.objects.new(name, l)
    o.location = loc
    scene.collection.objects.link(o)
    tgt = d["cam"]["target"]
    direction = np.array([tgt[0], -tgt[2], tgt[1]]) - np.array(loc)
    o.rotation_mode = "QUATERNION"
    from mathutils import Vector
    o.rotation_quaternion = Vector(direction).to_track_quat("-Z", "Y")
area("key", (1.8, -3.0, 3.4), 2.5, 190, (1, 0.97, 0.94))
area("rim", (-2.4, 2.8, 2.6), 1.6, 260, (1, 0.88, 0.82))
area("fill", (-2.8, -2.2, 1.2), 3.0, 35)
world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.95, 0.92, 0.9, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.14

# Camera: the app's framing.
cam_d = bpy.data.cameras.new("cam")
cam_d.sensor_fit = "VERTICAL"
cam_d.angle_y = math.radians(d["cam"]["fov"])
cam = bpy.data.objects.new("cam", cam_d)
scene.collection.objects.link(cam)
p = d["cam"]["pos"]; t = d["cam"]["target"]
cam.location = (p[0], -p[2], p[1])
from mathutils import Vector
cam.rotation_mode = "QUATERNION"
cam.rotation_quaternion = (Vector((t[0], -t[2], t[1])) - cam.location).to_track_quat("-Z", "Y")
scene.camera = cam

scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.render.film_transparent = True
scene.render.resolution_x, scene.render.resolution_y = W, H
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = "Khronos PBR Neutral"
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"

for i, f in enumerate(d["frames"]):
    me.vertices.foreach_set("co", conv(f).ravel())
    me.update()
    scene.render.filepath = f"{prefix}{i:03d}.png"
    bpy.ops.render.render(write_still=True)
    print("frame", i, flush=True)
