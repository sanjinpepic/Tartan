"""
Bake ambient occlusion into the 3D bodies: for each web/assets/body-*.glb, Cycles bakes AO
(how much of the sky each point of skin sees, within 12 cm) into a vertex colour on the rest
pose, and it is written back into the glb as _AO (u8, normalized). The viewer multiplies it into
the clay at paint time: the crevices between muscles, under the chest, behind the knees, round
the ears and between fingers and toes darken the way they do in a render, at no cost per frame.
Run it after scripts/build-body.py (which writes the glb without it). The clothes, surfaces of
their own, are baked with the body; the skin without the clothes.

  pip install bpy==5.2.2 numpy   (Blender as a Python module, Python 3.13)
  python scripts/blender/bake-ao.py [samples]
"""
import glob, json, os, struct, sys
import numpy as np
import bpy

SAMPLES = int(sys.argv[1]) if len(sys.argv) > 1 else 128
ASSETS = os.path.join(os.path.dirname(__file__), "..", "..", "web", "assets")


def read_glb(path):
    b = open(path, "rb").read()
    jl = struct.unpack("<I", b[12:16])[0]
    js = json.loads(b[20:20 + jl])
    bl = struct.unpack("<I", b[20 + jl:24 + jl])[0]
    return js, bytearray(b[28 + jl:28 + jl + bl])


def accessor(js, buf, i):
    a = js["accessors"][i]
    v = js["bufferViews"][a["bufferView"]]
    comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}[a["componentType"]]
    arr = np.frombuffer(bytes(buf[v["byteOffset"]:v["byteOffset"] + v["byteLength"]]), dtype=dt)
    return arr.reshape(-1, comps) if comps > 1 else arr


def write_glb(path, js, buf):
    j = json.dumps(js, separators=(",", ":")).encode()
    j += b" " * (-len(j) % 4)
    while len(buf) % 4:
        buf.append(0)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(j) + 8 + len(buf)))
        f.write(struct.pack("<II", len(j), 0x4E4F534A) + j)
        f.write(struct.pack("<II", len(buf), 0x004E4942) + bytes(buf))


def bake(P, tris):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    me = bpy.data.meshes.new("body")
    # three: y up, z forward -> blender: z up, -y forward (AO doesn't care, but keep it upright)
    me.from_pydata(np.stack([P[:, 0], -P[:, 2], P[:, 1]], 1).tolist(), [], tris.tolist())
    me.update()
    me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), dtype=bool))
    ob = bpy.data.objects.new("body", me)
    scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    col = me.color_attributes.new("AO", "FLOAT_COLOR", "POINT")
    me.color_attributes.active_color = col
    mat = bpy.data.materials.new("m")
    ob.data.materials.append(mat)
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.light_settings.distance = 0.12
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = SAMPLES
    bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
    out = np.zeros(len(P) * 4, dtype=np.float32)
    col.data.foreach_get("color", out)
    return out.reshape(-1, 4)[:, 0]


for path in sorted(glob.glob(os.path.join(ASSETS, "body-*.glb"))):
    js, buf = read_glb(path)
    prim = js["meshes"][0]["primitives"][0]
    P = accessor(js, buf, prim["attributes"]["POSITION"]).astype(np.float64)
    tris = accessor(js, buf, prim["indices"]).reshape(-1, 3).astype(np.int64)
    ao = bake(P, tris)
    garments = js.get("extras", {}).get("garments")
    if garments:
        # The skin is baked without the clothes over it: a skin vertex just under a hem would go
        # black, and the triangles it shares with the visible skin beside the hem would smear
        # that darkness out from under the cloth. The clothes keep the bake with everything.
        worn = np.unique(tris[garments[0] // 3:].reshape(-1))
        skin = np.setdiff1d(np.arange(len(P)), worn)
        ao[skin] = bake(P, tris[: garments[0] // 3])[skin]
    q = np.round(np.clip(ao, 0, 1) * 255).astype(np.uint8)
    data = q.tobytes()
    if "_AO" in prim["attributes"]:
        # Baked before: overwrite it in place.
        v = js["bufferViews"][js["accessors"][prim["attributes"]["_AO"]]["bufferView"]]
        buf[v["byteOffset"]:v["byteOffset"] + len(data)] = data
    else:
        while len(buf) % 4:
            buf.append(0)
        js["bufferViews"].append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data), "target": 34962})
        buf.extend(data)
        js["accessors"].append({"bufferView": len(js["bufferViews"]) - 1, "componentType": 5121, "count": len(q), "type": "SCALAR", "normalized": True})
        prim["attributes"]["_AO"] = len(js["accessors"]) - 1
        js["buffers"][0]["byteLength"] = len(buf)
    write_glb(path, js, buf)
    print(f"{os.path.basename(path)}: AO baked on {len(q)} vertices, mean {ao.mean():.2f}, min {ao.min():.2f}", flush=True)
