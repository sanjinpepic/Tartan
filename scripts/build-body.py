#!/usr/bin/env python3
"""
Build web/assets/body.glb: the one 3D body the exercise views move (web/lib/body3d.ts).

From MakeHuman's CC0 assets (base mesh, default skeleton and weights, macro targets): an
athletic young male (more muscle, little fat, ideal proportions), the face smoothed into a
sculpted mannequin head, 163 bones folded into the ~40 that move a body in training, every
joint's rest rotation the identity (so a pose is plain rotations about the body's own axes),
and the muscle groups (src/strength/exercises.ts MUSCLES) as soft fields over the skin, the two
strongest kept per vertex for the highlight.

  python3 scripts/build-body.py [cache dir] [male|female]   (downloads what it needs into the cache)

Writes web/assets/body-m.glb or body-f.glb. Each also carries gym clothes as surfaces of their
own after the skin's triangles (extras.garments; the man's loose shorts, the woman's bike shorts
and racerback sports bra) and sculpted hair painted on slightly raised skin (_WEAR): short hair
for the man, a bun for the woman.
"""
import json
import os
import struct
import sys
import urllib.request

import numpy as np

SRC = "https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data/"
CACHE = sys.argv[1] if len(sys.argv) > 1 else "/tmp/makehuman-cache"
SEX = sys.argv[2] if len(sys.argv) > 2 else "male"
assert SEX in ("male", "female")
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "assets", f"body-{SEX[0]}.glb")
MUSCLES = ["traps", "delts", "chest", "biceps", "triceps", "forearms", "lats", "upper_back", "lower_back",
           "abs", "obliques", "hip_flexors", "glutes", "glute_med", "adductors", "quads", "hamstrings", "calves", "tibialis"]


def fetch(path):
    local = os.path.join(CACHE, path.replace("/", "_"))
    if not os.path.exists(local):
        os.makedirs(CACHE, exist_ok=True)
        urllib.request.urlretrieve(SRC + path, local)
    return local


# ------------------------------------------------------------------ the mesh and its shape

verts, faces = [], []
group = None
for line in open(fetch("3dobjs/base.obj")):
    if line.startswith("v "):
        verts.append([float(x) for x in line.split()[1:4]])
    elif line.startswith("g "):
        group = line.split()[1]
    elif line.startswith("f ") and group == "body":
        faces.append([int(t.split("/")[0]) - 1 for t in line.split()[1:]])
V = np.array(verts, dtype=np.float64)


def target(path, w):
    if w == 0:
        return
    for line in open(fetch("targets/" + path)):
        if line[0].isdigit():
            i, x, y, z = line.split()
            V[int(i)] += w * np.array([float(x), float(y), float(z)])


# Young and athletic; muscle and weight on MakeHuman's 0-1 scales (a bilinear mix of the four
# corner targets around that point), then ideal proportions. The man: muscle 0.95, weight 0.4;
# the woman: muscle 0.8, weight 0.42.
muscle, weight = (0.95, 0.4) if SEX == "male" else (0.8, 0.42)
m, w = (muscle - 0.5) / 0.5, weight / 0.5
# The sex's shape itself lives in the race targets (MakeHuman's default: a third of each).
for race in ("caucasian", "african", "asian"):
    target(f"macrodetails/{race}-{SEX}-young.target", 1 / 3)
target(f"macrodetails/universal-{SEX}-young-averagemuscle-averageweight.target", (1 - m) * w)
target(f"macrodetails/universal-{SEX}-young-maxmuscle-averageweight.target", m * w)
target(f"macrodetails/universal-{SEX}-young-averagemuscle-minweight.target", (1 - m) * (1 - w))
target(f"macrodetails/universal-{SEX}-young-maxmuscle-minweight.target", m * (1 - w))
target(f"macrodetails/proportions/{SEX}-young-averagemuscle-averageweight-idealproportions.target", 1.0)

skel = json.load(open(fetch("rigs/default.mhskel")))
joint_pos = {name: V[idx].mean(axis=0) for name, idx in skel["joints"].items()}

# Only the body: the vertices the body faces use, renumbered.
used = sorted({i for f in faces for i in f})
remap = {old: new for new, old in enumerate(used)}
P = V[used].copy()
F = [[remap[i] for i in f] for f in faces]
tris = np.array([t for f in F for t in ([f[0], f[1], f[2]], [f[0], f[2], f[3]])[: len(f) - 2]], dtype=np.int64)

# ------------------------------------------------------------------ bones: the ones that move a body

KEEP = ["root", "spine05", "spine04", "spine03", "spine02", "spine01", "neck01", "neck02", "neck03", "head"]
for s in ("L", "R"):
    KEEP += [f"{b}.{s}" for b in ("pelvis", "upperleg01", "upperleg02", "lowerleg01", "lowerleg02", "foot", "toe1-1",
                                   "clavicle", "shoulder01", "upperarm01", "upperarm02", "lowerarm01", "lowerarm02", "wrist")]
bones = skel["bones"]


def kept(b):
    """The bone itself when kept, else its nearest kept ancestor (fingers to the wrist, the face to the head)."""
    while b not in KEEP:
        b = bones[b]["parent"]
    return b


# The toes as one: toe1-1 takes every toe.
def fold(b):
    if b.startswith("toe") and not b.startswith("toe1-1"):
        side = b[-1]
        return f"toe1-1.{side}"
    return kept(b)


heads = {b: joint_pos[bones[b]["head"]] for b in KEEP}
index = {b: i for i, b in enumerate(KEEP)}

weights = json.load(open(fetch("rigs/default_weights.mhw")))["weights"]
W = np.zeros((len(used), len(KEEP)))
for b, pairs in weights.items():
    k = index[fold(b)]
    for v, wt in pairs:
        if v in remap:
            W[remap[v], k] += wt
W[W.sum(1) == 0, index["root"]] = 1

# ------------------------------------------------------------------ a mannequin head

# Smooth the face (vertices the head bones carry) until the features soften into a sculpted
# shape: Laplacian smoothing, the skull outline kept by holding the back of the head lightly.
nbr = [set() for _ in range(len(P))]
for f in F:
    for a, b in zip(f, f[1:] + f[:1]):
        nbr[a].add(b)
        nbr[b].add(a)
nbr = [np.array(sorted(n)) for n in nbr]
head_w = W[:, index["head"]]
face = head_w > 0.5
centre = P[face].mean(axis=0)
for it in range(40):
    avg = np.array([P[n].mean(axis=0) for n in nbr])
    front = np.clip((P[:, 2] - centre[2]) / 0.6 + 0.5, 0.15, 1.0)
    k = np.where(face, 0.5 * front * np.clip(head_w, 0, 1), 0.0)[:, None]
    P = P + k * (avg - P)

# A mannequin's chest: the nipples smoothed away (Laplacian, fading out over 3 cm round the
# most forward point of each side of the chest), so a sports bra lies smooth over it too.
u = 1.78 / (P[:, 1].max() - P[:, 1].min())  # metres per MakeHuman unit
cy = joint_pos[bones["spine01"]["head"]][1]
for sx in (1, -1):
    near = (np.abs(P[:, 1] - cy) * u < 0.05) & (P[:, 0] * sx * u > 0.04) & (P[:, 0] * sx * u < 0.15)
    tip = P[np.where(near)[0][np.argmax(P[near, 2])]]
    k = np.clip(1 - np.linalg.norm(P - tip, axis=1) * u / 0.03, 0, 1)[:, None] * 0.6
    for it in range(30):
        avg = np.array([P[n].mean(axis=0) for n in nbr])
        P = P + k * (avg - P)

# ------------------------------------------------------------------ normals

def normals(P):
    n = np.zeros_like(P)
    a, b, c = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
    fn = np.cross(b - a, c - a)
    for i in range(3):
        np.add.at(n, tris[:, i], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)


N = normals(P)

# ------------------------------------------------------------------ to metres, feet on the floor

scale = 1.78 / (P[:, 1].max() - P[:, 1].min())
floor = P[:, 1].min()
P = (P - [0, floor, 0]) * scale
heads = {b: (h - [0, floor, 0]) * scale for b, h in heads.items()}

# ------------------------------------------------------------------ muscle groups

# Each muscle is a soft field over the skin, so its edge fades over a centimetre or two the way
# an anatomy plate is shaded instead of stopping at a triangle. On the limbs a field is a band
# along the bone (0 at the upper joint, 1 at the lower) and round it (0° front, 90° the outer
# side, ±180° behind, -90° the inner side); on the trunk it is a shape on the front or the back,
# placed from the joints. Everything is written for the left side and mirrored.
side = np.where(P[:, 0] >= 0, 1.0, -1.0)
M = P * np.stack([side, np.ones_like(side), np.ones_like(side)], 1)  # the right side folded onto the left
NM = N * np.stack([side, np.ones_like(side), np.ones_like(side)], 1)
H = {b: heads[b] for b in heads if not b.endswith(".R")}


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def band(x, lo, hi, soft):
    return smooth(lo - soft, lo + soft, x) * (1 - smooth(hi - soft, hi + soft, x))


def arc(theta, centre, half, soft=16.0):
    d = np.abs((theta - centre + 180) % 360 - 180)
    return 1 - smooth(half - soft, half + soft, d)


def facing(d, lo=-0.05, hi=0.35):
    d = np.asarray(d, float)
    return smooth(lo, hi, NM @ (d / np.linalg.norm(d)))


def oval(cx, cy, rx, ry, soft=0.22):
    d = np.hypot((M[:, 0] - cx) / rx, (M[:, 1] - cy) / ry)
    return 1 - smooth(1 - soft, 1 + soft, d)


def member(*names):
    """How much of the vertex the bones (this side's) carry."""
    out = np.zeros(len(P))
    for n in names:
        out += np.where(side > 0, W[:, index[f"{n}.L"]], W[:, index[f"{n}.R"]])
    return np.clip(out, 0, 1)


def segment(a, b):
    """Along (0..1) and round (degrees) the bone from joint a to joint b."""
    A, B = H[a], H[b]
    L = np.linalg.norm(B - A)
    ax = (B - A) / L
    f = np.array([0, 0, 1.0]) - ax[2] * ax
    f /= np.linalg.norm(f)
    l = np.array([1.0, 0, 0]) - ax[0] * ax - f[0] * f
    l /= np.linalg.norm(l)
    r = M - A
    t = r @ ax / L
    return t, np.degrees(np.arctan2(r @ l, r @ f))


arms = member("upperarm01", "upperarm02", "lowerarm01", "lowerarm02", "wrist")
legs = member("upperleg01", "upperleg02", "lowerleg01", "lowerleg02", "foot", "toe1-1")
trunk = np.clip(1 - arms - legs, 0, 1)
x, y = M[:, 0], M[:, 1]
F_ = {m: np.zeros(len(P)) for m in MUSCLES}

# Legs.
thigh = member("upperleg01", "upperleg02")
t, th = segment("upperleg01.L", "lowerleg01.L")
F_["quads"] = thigh * band(t, 0.16, 0.97, 0.06) * arc(th, 12, 52 + 34 * np.clip(t / 0.6, 0, 1))
F_["hamstrings"] = thigh * band(t, 0.14, 0.9, 0.07) * arc(th, 178, 64)
F_["adductors"] = thigh * band(t, -0.05, 0.66, 0.07) * arc(th, -75, 22 + 40 * np.clip(1 - t / 0.7, 0, 1))
shin = member("lowerleg01", "lowerleg02")
t, th = segment("lowerleg01.L", "foot.L")
F_["tibialis"] = shin * band(t, 0.06, 0.74, 0.07) * arc(th, 34, 32, 14)
F_["calves"] = shin * band(t, 0.03, 0.58 + 0.08 * np.cos(np.radians(th - 180)), 0.08) * arc(th, 180, 92)

# The hip.
hip = H["upperleg01.L"]
F_["glutes"] = oval(0.085, hip[1] - 0.06, 0.105, 0.115) * facing([0.35, 0, -1], -0.15, 0.3)
F_["glute_med"] = oval(0.14, hip[1] + 0.04, 0.065, 0.07) * facing([1, 0.2, -0.35], 0.0, 0.4)
F_["hip_flexors"] = oval(0.09, hip[1] - 0.035, 0.055, 0.095) * facing([0.25, 0, 1], 0.0, 0.45)

# Arms.
upper = member("upperarm01", "upperarm02")
t, th = segment("upperarm01.L", "lowerarm01.L")
F_["delts"] = np.maximum(upper, member("shoulder01")) * band(t, -0.5, 0.45, 0.08) * arc(th, 90, 140, 20)
F_["biceps"] = upper * band(t, 0.18, 0.9, 0.07) * arc(th, 0, 60)
F_["triceps"] = upper * band(t, 0.24, 0.92, 0.07) * arc(th, 180, 82)
fore = member("lowerarm01", "lowerarm02")
t, th = segment("lowerarm01.L", "wrist.L")
F_["forearms"] = fore * band(t, -0.05, 0.72, 0.1)

# Trunk, front.
chest_y = H["spine01"][1]  # about the nipple line
F_["chest"] = trunk * oval(0.095, chest_y + 0.01, 0.105, 0.092) * facing([0.15, 0.1, 1], 0.1, 0.5)
F_["abs"] = trunk * band(x, -1, 0.062, 0.014) * band(y, hip[1] - 0.02, chest_y - 0.07, 0.025) * facing([0, 0, 1], 0.3, 0.7)
F_["obliques"] = trunk * oval(0.125, (hip[1] + chest_y) / 2 + 0.02, 0.065, 0.15) * facing([0.75, 0, 0.65], 0.1, 0.5)

# Trunk, back.
neck = H["neck02"][1]
yy = np.clip((y - chest_y) / (neck - chest_y), -2, 1)  # 0 at the nipple line, 1 at the neck
trap_w = np.interp(y, [chest_y - 0.17, chest_y + 0.1, H["clavicle.L"][1] + 0.03, neck + 0.02], [0.0, 0.07, 0.17, 0.035])
F_["traps"] = trunk * (1 - smooth(trap_w - 0.015, trap_w + 0.015, x)) * band(y, chest_y - 0.17, neck + 0.02, 0.02) * facing([0, 0.6, -1], -0.1, 0.3)
F_["upper_back"] = trunk * oval(0.055, chest_y + 0.005, 0.09, 0.075) * facing([0, 0, -1], 0.2, 0.6)
s_ = np.clip((y - 1.03) / 0.33, 0, 1)
F_["lats"] = trunk * band(x, 0.025 + 0.06 * s_, 0.16 + 0.04 * s_, 0.02) * band(y, 1.03, chest_y + 0.03, 0.03) * facing([0.55, 0, -1], -0.1, 0.35)
F_["lower_back"] = trunk * band(x, -1, 0.06, 0.015) * band(y, hip[1] + 0.0, 1.2, 0.03) * facing([0, 0, -1], 0.3, 0.7)

# Soften a little more over the skin itself, then keep the two strongest per vertex.
Fm = np.stack([F_[m] for m in MUSCLES], 1)
for _ in range(3):
    Fm = 0.5 * Fm + 0.5 * np.array([Fm[n].mean(axis=0) for n in nbr])
two = np.argsort(-Fm, 1)[:, :2]
tw = np.clip(np.take_along_axis(Fm, two, 1), 0, 1)
mus_id = two.astype(np.uint8)
mus_w = np.round(tw * 255).astype(np.uint8)

# ------------------------------------------------------------------ gym clothes and hair

# The clothes are surfaces of their own, cut from the skin and built after the bun (below). Each
# is a field over the body: about the distance (m) inside the garment's edge, negative outside,
# taken at any point and its bone weights (the cut refines the skin along the edge and asks
# again there). The man: gym shorts to mid-thigh, cut higher at the sides, loose towards the hem.
# The woman: fitted bike shorts and a racerback sports bra. Hair: the scalp above a hairline that
# runs from the forehead over the ears to the nape (lower and over the ears for the woman), plus
# a bun, raised a few millimetres off the skin and painted in the viewer.
fold = lambda Q: Q * np.stack([np.where(Q[:, 0] >= 0, 1.0, -1.0), np.ones(len(Q)), np.ones(len(Q))], 1)


def along(Q, a, b):
    """segment() for any points: along (0..1) and round (degrees) the bone from joint a to joint b."""
    A, B = H[a], H[b]
    L = np.linalg.norm(B - A)
    ax = (B - A) / L
    f = np.array([0, 0, 1.0]) - ax[2] * ax
    f /= np.linalg.norm(f)
    l = np.array([1.0, 0, 0]) - ax[0] * ax - f[0] * f
    l /= np.linalg.norm(l)
    r = fold(Q) - A
    return r @ ax / L, np.degrees(np.arctan2(r @ l, r @ f))


def carried(Q, Wq, *names):
    """member() for any points: how much of each the bones (its side's) carry."""
    out = np.zeros(len(Q))
    for n in names:
        out += np.where(Q[:, 0] >= 0, Wq[:, index[f"{n}.L"]], Wq[:, index[f"{n}.R"]])
    return np.clip(out, 0, 1)


# How much the arm carries a point, smoothed over the skin (the weights themselves are too
# uneven for an edge to follow); kept as an extra column after the bone weights.
arm_s = arms.copy()
for _ in range(25):
    arm_s = 0.5 * arm_s + 0.5 * np.array([arm_s[n].mean() for n in nbr])
WX = np.hstack([W, arm_s[:, None]])


def not_arm(Q, Wq):
    """Never the arms (the hands hang by the hips): how far from them, about in metres."""
    return (0.3 - Wq[:, -1]) * 0.06


waist = hip[1] + (0.105 if SEX == "male" else 0.112)
thigh_len = np.linalg.norm(H["lowerleg01.L"] - H["upperleg01.L"])


def shorts_hem(Q):
    t, th = along(Q, "upperleg01.L", "lowerleg01.L")
    outer = 0.5 + 0.5 * np.cos(np.radians(th - 90))  # 1 on the thigh's outer side, 0 the inner
    return t, outer, (0.56 - 0.07 * outer if SEX == "male" else np.full(len(Q), 0.45))


def shorts_field(Q, Wq):
    t, _, hem = shorts_hem(Q)
    return np.minimum(np.minimum(waist - Q[:, 1], (hem - t) * thigh_len), not_arm(Q, Wq))


def shorts_lift(Q, Wq):
    t, outer, _ = shorts_hem(Q)
    loose = 0.006 + 0.03 * smooth(0.0, 0.55, t) ** 1.5 * (0.15 + 0.85 * outer) if SEX == "male" else 0.0035
    return loose + 0.0018 * smooth(waist - 0.05, waist - 0.04, Q[:, 1])


def shorts_trim(Q, Wq):
    """The waistband and the hems."""
    t, _, hem = shorts_hem(Q)
    return np.maximum(smooth(waist - 0.048, waist - 0.04, Q[:, 1]), smooth(hem - 0.05, hem - 0.04, t))


GARMENTS = [("shorts", shorts_field, shorts_lift, shorts_trim, 1)]  # + rounds of refining the skin along the edge
if SEX == "female":
    # Round the trunk at the chest: 0° the front, 90° the side, 180° the back.
    ring = (np.abs(y - chest_y) < 0.03) & (trunk > 0.9)
    zc = (P[ring, 2].max() + P[ring, 2].min()) / 2

    def bra_lines(Q):
        """The front panel's neckline (a U between the cups, up to the straps over each, dropping
        under the arms to the band at the back) and the band's lower edge."""
        ang = np.degrees(np.arctan2(np.abs(Q[:, 0]), Q[:, 2] - zc))
        top = chest_y + np.interp(ang, [0, 10, 20, 30, 40, 48, 55, 65, 80, 95, 110, 130, 180], [0.038, 0.0396, 0.0442, 0.052, 0.0629, 0.0738, 0.085, 0.07, 0.025, -0.01, -0.025, -0.032, -0.035])
        return top, chest_y - np.interp(ang, [0, 180], [0.1, 0.09])

    def probe(px, py=None, pz=None, side="front"):
        """The skin of the trunk where a line along z (front, back) or y (top) through the point leaves it."""
        on = (trunk > 0.6) & (np.abs(x - px) < 0.012)
        if side == "top":
            on &= (np.abs(P[:, 2] - pz) < 0.015) & (y < H["neck01"][1] + 0.01)
            return M[on][np.argmax(y[on])]
        on &= np.abs(y - py) < 0.012
        return M[on][np.argmax(P[on, 2]) if side == "front" else np.argmin(P[on, 2])]

    clav = H["clavicle.L"][1]
    path = [probe(0.09, chest_y + 0.075), probe(0.074, clav - 0.005), probe(0.066, pz=H["neck01"][2], side="top"),
            probe(0.052, clav - 0.02, side="back"), probe(0.03, chest_y + 0.04, side="back"), probe(0.004, chest_y, side="back"),
            probe(0.004, chest_y - 0.07, side="back")]
    # The strap's line on the skin: the probes joined, sampled every few millimetres, then smoothed
    # and put back on the skin (the nearest point of the trunk's triangles) a few times over.
    sk = tris[np.all(trunk[tris] > 0.3, axis=1)]
    TA, TB, TC = M[sk[:, 0]], M[sk[:, 1]], M[sk[:, 2]]

    def on_skin(q):
        """The nearest point to q on the trunk's skin (folded)."""
        ab, ac, aq = TB - TA, TC - TA, q - TA
        d00, d01, d11 = (ab * ab).sum(1), (ab * ac).sum(1), (ac * ac).sum(1)
        d20, d21 = (aq * ab).sum(1), (aq * ac).sum(1)
        den = np.maximum(d00 * d11 - d01 * d01, 1e-18)
        v = np.clip((d11 * d20 - d01 * d21) / den, 0, 1)
        w = np.clip((d00 * d21 - d01 * d20) / den, 0, 1)
        k = np.maximum(v + w, 1)
        c3 = TA + (v / k)[:, None] * ab + (w / k)[:, None] * ac
        return c3[np.argmin(((c3 - q) ** 2).sum(1))]

    pts = np.vstack([a + t * (b - a) for a, b in zip(path, path[1:]) for t in np.linspace(0, 1, max(2, int(np.linalg.norm(b - a) / 0.006)), endpoint=False)] + [path[-1]])
    for _ in range(4):
        pts = np.array([on_skin(q) for q in pts])
        for _ in range(8):
            pts[1:-1] = 0.25 * pts[:-2] + 0.5 * pts[1:-1] + 0.25 * pts[2:]
    pts = np.array([on_skin(q) for q in pts])

    def bra_field(Q, Wq):
        Mq = fold(Q)
        d = np.full(len(Q), np.inf)
        for a, b in zip(pts, pts[1:]):
            ab = b - a
            t = np.clip(((Mq - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
            d = np.minimum(d, np.linalg.norm(Mq - (a + t[:, None] * ab), axis=1))
        width = 0.0145 + 0.0055 * (1 - smooth(0.02, 0.045, Mq[:, 0]))  # the racer's spine a little wider
        strap = np.minimum(width - d, (0.3 - Wq[:, index["head"]]) * 0.06)
        top, low = bra_lines(Q)
        panel = np.minimum(Q[:, 1] - low, top - Q[:, 1])
        return np.minimum(np.minimum(np.maximum(panel, strap), not_arm(Q, Wq)), Q[:, 1] - hip[1] - 0.15)

    def bra_band(Q, Wq):
        """The underband."""
        return 1 - smooth(bra_lines(Q)[1] + 0.03, bra_lines(Q)[1] + 0.04, Q[:, 1])

    GARMENTS.append(("bra", bra_field, lambda Q, Wq: 0.0035 + 0.0015 * bra_band(Q, Wq), bra_band, 2))
head_w = W[:, index["head"]]
c = H["head"]
rel = M - c
phi = np.arctan2(rel[:, 0], rel[:, 2])  # 0 at the forehead, ±pi at the nape
front, back = (0.112, 0.012) if SEX == "male" else (0.108, -0.035)
line = back + (front - back) * ((1 + np.cos(phi)) / 2) ** (1.0 if SEX == "male" else 1.6)
hair = smooth(0.4, 0.8, head_w) * smooth(line - 0.004, line + 0.004, rel[:, 1])
# The skin under the clothes, wholly covered (every neighbour inside too): painted as the fabric,
# so a fold of skin that comes through at a deep bend reads as cloth.
inside = np.zeros(len(P), bool)
for _, field, _, _, _ in GARMENTS:
    inside |= field(P, WX) > 0
cloth = np.array([inside[i] and inside[n].all() for i, n in enumerate(nbr)], dtype=float)
P = P + N * ((0.007 if SEX == "male" else 0.011) * hair)[:, None]

# ------------------------------------------------------------------ hands: relaxed and gripping

# Fingers curl through MakeHuman's own finger bones and weights, baked as morph targets (the
# skeleton above keeps only the wrist): per hand a relaxed curl and a full grip round a 3 cm bar.
# Each finger joint turns about the axis square to the finger and the palm's normal. Also kept:
# where a bar sits in each gripping hand (from the wrist, in the rest pose) and which way it runs.
def jp(name):
    return (joint_pos[name] - [0, floor, 0]) * scale


def rot(axis, deg):
    a = np.radians(deg)
    k = axis / np.linalg.norm(axis)
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K


CURL = {"relax": ([12, 22, 16], [6, 10, 12]), "grip": ([68, 82, 56], [18, 34, 42])}
hand_morphs, grips = {}, {}
for side in ("L", "R"):
    sgn = 1 if side == "L" else -1
    wrist = jp(f"wrist.{side}____head")
    index_b, pinky_b, middle_b = (jp(f"finger{k}-1.{side}____head") for k in (2, 5, 3))
    fdir = (middle_b - wrist) / np.linalg.norm(middle_b - wrist)
    across = (pinky_b - index_b) / np.linalg.norm(pinky_b - index_b)
    palm = -sgn * np.cross(fdir, across)
    palm /= np.linalg.norm(palm)
    grips[side] = {"at": [float(x) for x in ((index_b + pinky_b) / 2 + palm * 0.024 - fdir * 0.004 - wrist)], "axis": [float(x) for x in across], "palm": [float(x) for x in palm]}
    for kind, (fingers, thumb) in CURL.items():
        moved = P.copy()
        delta = np.zeros_like(P)
        for f in range(1, 6):
            angles = thumb if f == 1 else fingers
            chain = [f"finger{f}-{j}.{side}" for j in (1, 2, 3)]
            mats = []
            for b, ang in zip(chain, angles):
                h, t = jp(f"{b}____head"), jp(f"{b}____tail")
                d = (t - h) / np.linalg.norm(t - h)
                mats.append((h, rot(np.cross(d, palm), ang)))
            for j, b in enumerate(chain):
                pairs = weights.get(b, [])
                idx = np.array([remap[v] for v, _ in pairs if v in remap], dtype=np.int64)
                wts = np.array([w for v, w in pairs if v in remap])
                if not len(idx):
                    continue
                q = P[idx].copy()
                # This bone's own turn first, then each parent's (all in the rest frame).
                for h, R in reversed(mats[: j + 1]):
                    q = (q - h) @ R.T + h
                delta[idx] += wts[:, None] * (q - P[idx])
        nz = np.where(np.abs(delta).max(1) > 1e-6)[0]
        hand_morphs[f"{kind}.{side}"] = (nz, delta[nz].astype(np.float32))

# Top four bone weights a vertex.
order = np.argsort(-W, 1)[:, :4]
top = np.take_along_axis(W, order, 1)
top = top / np.maximum(top.sum(1, keepdims=True), 1e-9)
wq = np.round(top * 255).astype(np.int32)
wq[:, 0] += 255 - wq.sum(1)

# The woman's bun: a rounded knot at the back of the crown, carried by the head.
if SEX == "female":
    top_y = P[head_w > 0.9][:, 1].max()
    ctr = np.array([0.0, top_y - 0.045, H["head"][2] - 0.085])
    rad = np.array([0.045, 0.042, 0.04])
    rings, segs = 12, 18
    bv = [ctr + rad * [np.sin(a) * np.cos(b), np.cos(a), np.sin(a) * np.sin(b)] for a in np.linspace(0, np.pi, rings + 1) for b in np.linspace(0, 2 * np.pi, segs, endpoint=False)]
    base = len(P)
    bt = []
    for r in range(rings):
        for q in range(segs):
            a0, a1 = base + r * segs + q, base + r * segs + (q + 1) % segs
            b0, b1 = a0 + segs, a1 + segs
            bt += [[a0, a1, b1], [a0, b1, b0]]
    P = np.vstack([P, np.array(bv)])
    tris = np.vstack([tris, np.array(bt)])
    n_b = len(bv)
    order = np.vstack([order, np.tile([index["head"], 0, 0, 0], (n_b, 1))])
    wq = np.vstack([wq, np.tile([255, 0, 0, 0], (n_b, 1))])
    mus_id = np.vstack([mus_id, np.zeros((n_b, 2), np.uint8)])
    mus_w = np.vstack([mus_w, np.zeros((n_b, 2), np.uint8)])
    cloth = np.concatenate([cloth, np.zeros(n_b)])
    hair = np.concatenate([hair, np.ones(n_b)])

# ------------------------------------------------------------------ the clothes as surfaces

# Each garment is the skin inside its field, lifted off it along the normal and further where the
# cloth bridges a hollow the way fabric does (between the breasts, the cleft of the buttocks)
# instead of following the skin into it. Along its edge the skin is refined (a round or two of
# splitting the triangles the edge passes through, and their neighbours so no crack opens), then
# cut exactly where the field crosses zero, so a hem or a strap runs clean whatever the mesh. Its edges turn down to the skin as a hem, which gives it
# thickness. Every new vertex is skinned, placed and coloured by blending the ones it lies
# between. Drawn with its own material; _WEAR (fabric, hair, trim) is 1 for fabric on these.
body_tris = len(tris)
nb = len(nbr)  # the body's own vertices (the bun's come after)
skin_tris = tris[:body_tris][tris[:body_tris].max(1) < nb]
trim = np.zeros(len(P))
g_P, g_W, g_mus_id, g_mus_w, g_trim, g_tris = [], [], [], [], [], []
n_next = len(P)


def refine(T, X, marked):
    """One round of red-green refinement of triangles T over vertex data X (arrays by name):
    the marked triangles split in four, any other that shares a split edge in two or three. A new
    vertex is the midpoint of its edge (its data the average; "src", the skin vertex it came
    from, that of the edge's first end)."""
    mids = {}
    for t in T[marked]:
        for k in range(3):
            e = (min(t[k], t[(k + 1) % 3]), max(t[k], t[(k + 1) % 3]))
            mids.setdefault(e, len(X["P"]) + len(mids))
    if not mids:
        return T, X
    E = np.array(list(mids))
    X = {k: np.concatenate([v, v[E[:, 0]] if k == "src" else 0.5 * (v[E[:, 0]] + v[E[:, 1]])]) for k, v in X.items()}
    out = []
    for t in T:
        m = [mids.get((min(t[k], t[(k + 1) % 3]), max(t[k], t[(k + 1) % 3]))) for k in range(3)]
        n = sum(v is not None for v in m)
        if n == 0:
            out.append(list(t))
        elif n == 3:
            out += [[t[0], m[0], m[2]], [m[0], t[1], m[1]], [m[2], m[1], t[2]], [m[0], m[1], m[2]]]
        else:
            # Turned so that the first edge is split (and, of two, the second as well).
            r = next(r for r in range(3) if m[r] is not None and (n == 1 or m[(r + 1) % 3] is not None))
            v0, v1, v2 = t[r], t[(r + 1) % 3], t[(r + 2) % 3]
            m0, m1 = m[r], m[(r + 1) % 3]
            out += [[v0, m0, v2], [m0, v1, v2]] if n == 1 else [[v0, m0, m1], [v0, m1, v2], [m0, v1, m1]]
    return np.array(out), X


# The weights the skin is drawn with (its top four); a garment vertex blends these, so it moves
# with the skin under it rather than with the fuller weights the skin itself lost.
W4 = np.zeros_like(W)
np.put_along_axis(W4, order[:nb], wq[:nb] / 255, 1)
W4X = np.hstack([W4, arm_s[:, None]])

for name, field, lift_of, trim_of, rounds in GARMENTS:
    f = field(P[:nb], W4X)
    # Relax outwards only, on the skin's own even mesh (the refined one is uneven, and its
    # smaller triangles would rise less than the large ones beside them): a point rises towards
    # its neighbours' average only when that is further out, so hollows fill and nothing sinks
    # into the skin. Then the rise itself is evened out and capped.
    near = f > -0.03
    Q0 = P[:nb] + N * lift_of(P[:nb], W4X)[:, None]
    rise = np.zeros(nb)
    for _ in range(14):
        out = np.maximum(((np.array([Q0[n].mean(0) for n in nbr]) - Q0) * N).sum(1), 0) * near
        Q0 = Q0 + 0.6 * out[:, None] * N
        rise += 0.6 * out
    for _ in range(8):
        rise = 0.5 * rise + 0.5 * np.array([rise[n].mean() for n in nbr])
    X = {"P": P[:nb].copy(), "N": N.copy(), "W": W4X.copy(), "rise": np.minimum(rise, 0.008), "src": np.arange(nb)}
    T = skin_tris[(f[skin_tris] > -0.04).any(1)]
    for _ in range(rounds):
        e = np.linalg.norm(X["P"][T] - X["P"][T[:, [1, 2, 0]]], axis=2).max(1)
        T, X = refine(T, X, (f[T].min(1) < 0.1 * e) & (f[T].max(1) > -0.1 * e))
        f = field(X["P"], X["W"])
    made = {}  # an inside vertex, or a cut edge (a, b), to its garment vertex
    src_a, src_b, src_t = [], [], []

    def vert(a, b=None):
        key = a if b is None else (min(a, b), max(a, b))
        if key not in made:
            made[key] = len(src_a)
            if b is None:
                src_a.append(a), src_b.append(a), src_t.append(0.0)
            else:
                lo, hi = (a, b) if f[a] > 0 else (b, a)  # from the inside vertex to the outside one
                src_a.append(lo), src_b.append(hi), src_t.append(f[lo] / (f[lo] - f[hi]))
        return made[key]

    G = []
    for tri in T:
        if (f[tri] <= 0).all():
            continue
        poly = []
        for k in range(3):
            a, b = tri[k], tri[(k + 1) % 3]
            if f[a] > 0:
                poly.append(vert(a))
            if (f[a] > 0) != (f[b] > 0):
                poly.append(vert(a, b))
        G += [[poly[0], poly[j], poly[j + 1]] for j in range(1, len(poly) - 1)]
    G = np.array(G)
    A, B, Tt = np.array(src_a), np.array(src_b), np.array(src_t)[:, None]
    mix = lambda arr: arr[A] * (1 - Tt) + arr[B] * Tt
    base_P, base_W = mix(X["P"]), mix(X["W"])
    nq = mix(X["N"])
    nq /= np.linalg.norm(nq, axis=1, keepdims=True)
    Q = base_P + nq * (lift_of(base_P, base_W) + mix(X["rise"][:, None])[:, 0])[:, None]
    # The hem: every edge on one garment triangle only, turned down to the skin.
    count = {}
    for t3 in G:
        for k in range(3):
            e2 = (t3[k], t3[(k + 1) % 3])
            count[(min(e2), max(e2))] = count.get((min(e2), max(e2)), 0) + 1
    rim = [(t3[k], t3[(k + 1) % 3], t3) for t3 in G for k in range(3) if count[(min(t3[k], t3[(k + 1) % 3]), max(t3[k], t3[(k + 1) % 3]))] == 1]
    # (Down to the skin, or, where the cloth stands off it (a loose hem, a hollow it spans), as deep
    # as the cloth is thick.)
    skin = Q - nq * np.minimum(((Q - base_P) * nq).sum(1) - 0.0005, 0.006)[:, None]
    n0 = len(Q)
    Qh, srch, hem_tris, hv = [], [], [], {}

    def hem_vert(u, down):
        """The edge vertex u again for the hem (its own normal), at the cloth or down at the skin."""
        if (u, down) not in hv:
            hv[(u, down)] = n0 + len(Qh)
            Qh.append(skin[u] if down else Q[u])
            srch.append(u)
        return hv[(u, down)]

    for u, v, t3 in rim:
        uo, vo, vd, ud = hem_vert(u, 0), hem_vert(v, 0), hem_vert(v, 1), hem_vert(u, 1)
        q1, q2 = [uo, vo, vd], [uo, vd, ud]
        away = (Q[u] + Q[v]) / 2 - Q[t3].mean(0)
        if np.cross(Q[v] - Q[u], skin[u] - Q[u]) @ away < 0:
            q1, q2 = q1[::-1], q2[::-1]
        hem_tris += [q1, q2]
    every = np.concatenate([np.arange(n0), np.array(srch, dtype=np.int64)])  # each vertex's place on the cloth
    g_P.append(np.vstack([Q, np.array(Qh)]) if Qh else Q)
    g_W.append(base_W[every][:, :-1])
    near = np.where(Tt[:, 0] < 0.5, X["src"][A], X["src"][B])[every]  # the nearest skin vertex
    g_mus_id.append(mus_id[near])
    g_mus_w.append(mus_w[near])
    g_trim.append(trim_of(base_P, base_W)[every])
    g_tris.append((np.vstack([G, np.array(hem_tris)]) if hem_tris else G) + n_next)
    n_next += len(every)
    print(f"{name}: {len(G)} triangles, {len(rim)} hem edges")

gP = np.vstack(g_P)
gW = np.vstack(g_W)
# The cloth follows up to eight bones (the skin four): a cloth vertex blends the skin vertices
# around it, and where those follow different bones, keeping four would let neighbouring cloth
# vertices drop different ones and tear apart in a pose. The second four go in _JOINTS1 and
# _WEIGHTS1, which the viewer's cloth shader adds.
g_order8 = np.argsort(-gW, 1)[:, :8]
g_top = np.take_along_axis(gW, g_order8, 1)
g_top = g_top / np.maximum(g_top.sum(1, keepdims=True), 1e-9)
g_wq = np.round(g_top * 255).astype(np.int32)
g_wq[:, 0] += 255 - g_wq.sum(1)
g_order, g_wq, g_order1, g_wq1 = g_order8[:, :4], g_wq[:, :4], g_order8[:, 4:], g_wq[:, 4:]
P = np.vstack([P, gP])
order1 = np.vstack([np.zeros_like(order), g_order1])
wq1 = np.vstack([np.zeros_like(wq), g_wq1])
order = np.vstack([order, g_order])
wq = np.vstack([wq, g_wq])
mus_id = np.vstack([mus_id, *g_mus_id])
mus_w = np.vstack([mus_w, *g_mus_w])
cloth = np.concatenate([cloth, np.ones(len(gP))])
hair = np.concatenate([hair, np.zeros(len(gP))])
trim = np.concatenate([trim, *g_trim])
garment_tris = np.vstack(g_tris)
tris = np.vstack([tris, garment_tris])
assert len(P) < 65536

# ------------------------------------------------------------------ glb

buf = bytearray()
views, accessors = [], []


def add(arr, target=None, ctype=5126, kind="VEC3", norm=False, minmax=False):
    data = arr.tobytes()
    while len(buf) % 4:
        buf.append(0)
    views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data), **({"target": target} if target else {})})
    buf.extend(data)
    acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": int(arr.shape[0]), "type": kind}
    if norm:
        acc["normalized"] = True
    if minmax:
        acc["min"] = arr.min(0).tolist()
        acc["max"] = arr.max(0).tolist()
    accessors.append(acc)
    return len(accessors) - 1


pos = add(P.astype(np.float32), 34962, minmax=True)
nrm = add(normals(P).astype(np.float32), 34962)
jnt = add(order.astype(np.uint8), 34962, 5121, "VEC4")
wgt = add(wq.astype(np.uint8), 34962, 5121, "VEC4", norm=True)
jnt1 = add(order1.astype(np.uint8), 34962, 5121, "VEC4")
wgt1 = add(wq1.astype(np.uint8), 34962, 5121, "VEC4", norm=True)
mus_acc = add(mus_id, 34962, 5121, "VEC2")
musw_acc = add(mus_w, 34962, 5121, "VEC2", norm=True)
wear_acc = add(np.round(np.stack([cloth, hair, trim, np.zeros(len(P))], 1).clip(0, 1) * 255).astype(np.uint8), 34962, 5121, "VEC4", norm=True)
idx = add(tris.astype(np.uint16).reshape(-1), 34963, 5123, "SCALAR")
# Morph targets, sparse: only the hand's vertices move.
target_names = sorted(hand_morphs)
targets = []
for name in target_names:
    nz, dv = hand_morphs[name]
    iv = add(nz.astype(np.uint32), None, 5125, "SCALAR")
    vv = add(dv, None, 5126, "VEC3")
    # The sparse parts are referred to by their views; drop the two plain accessors add() made.
    iview, vview = accessors[iv]["bufferView"], accessors[vv]["bufferView"]
    accessors.pop()
    accessors.pop()
    accessors.append({"componentType": 5126, "count": int(len(P)), "type": "VEC3", "min": dv.min(0).tolist(), "max": dv.max(0).tolist(), "sparse": {"count": int(len(nz)), "indices": {"bufferView": iview, "componentType": 5125}, "values": {"bufferView": vview}}})
    targets.append({"POSITION": len(accessors) - 1})
ibm = add(np.stack([np.array([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [-h[0], -h[1], -h[2], 1]], dtype=np.float32).reshape(-1) for h in (heads[b] for b in KEEP)]), None, 5126, "MAT4")

nodes = [{"name": "body", "mesh": 0, "skin": 0}]
first = len(nodes)
for b in KEEP:
    p = bones[b]["parent"]
    t = heads[b] - (heads[p] if p else np.zeros(3))
    nodes.append({"name": b, "translation": [float(x) for x in t]})
for i, b in enumerate(KEEP):
    kids = [first + j for j, c in enumerate(KEEP) if bones[c]["parent"] == b]
    if kids:
        nodes[first + i]["children"] = kids
gltf = {
    "asset": {"version": "2.0", "generator": "Tartan scripts/build-body.py", "copyright": "Body from MakeHuman assets (CC0)"},
    "scene": 0,
    "scenes": [{"nodes": [0, first]}],
    "nodes": nodes,
    "meshes": [{"primitives": [{"attributes": {"POSITION": pos, "NORMAL": nrm, "JOINTS_0": jnt, "WEIGHTS_0": wgt, "_JOINTS1": jnt1, "_WEIGHTS1": wgt1, "_MUSCLE": mus_acc, "_MUSCLEW": musw_acc, "_WEAR": wear_acc}, "indices": idx, "targets": targets}], "weights": [0.0] * len(targets), "extras": {"targetNames": target_names}}],
    "skins": [{"joints": [first + i for i in range(len(KEEP))], "inverseBindMatrices": ibm, "skeleton": first}],
    "accessors": accessors,
    "bufferViews": views,
    "buffers": [{"byteLength": len(buf)}],
    "extras": {"muscles": MUSCLES, "sex": SEX, "grips": grips, "garments": [body_tris * 3, len(garment_tris) * 3]},
}
js = json.dumps(gltf, separators=(",", ":")).encode()
js += b" " * (-len(js) % 4)
while len(buf) % 4:
    buf.append(0)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "wb") as f:
    f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(buf)))
    f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
    f.write(struct.pack("<II", len(buf), 0x004E4942) + bytes(buf))
counts = {m: int((Fm[:, i] > 0.5).sum()) for i, m in enumerate(MUSCLES)}
print(f"{OUT}: {len(P)} vertices, {len(tris)} triangles, {len(KEEP)} bones, {os.path.getsize(OUT) // 1024} KB; muscles {counts}")
