"""From a picture a second of the simulator, the last picture of each of the first four phases
that differ (home, the run before START, the step change, the run), cropped to the window."""
import os
import sys

from PIL import Image, ImageChops

src, out, dev = sys.argv[1], sys.argv[2], sys.argv[3]
files = sorted(f for f in os.listdir(src) if f.endswith(".png"))
imgs = [Image.open(os.path.join(src, f)).convert("RGB") for f in files]
# Phases: runs of pictures that (nearly) match the one before.
phases, run = [], []
for i, im in enumerate(imgs):
    if run and ImageChops.difference(im, imgs[run[-1]]).getbbox() is not None:
        diff = ImageChops.difference(im, imgs[run[-1]]).convert("L").point(lambda v: 255 if v > 24 else 0)
        if sum(diff.histogram()[255:]) > 400:
            phases.append(run)
            run = []
    run.append(i)
phases.append(run)
def same(a, b):
    d = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 24 else 0)
    return sum(d.histogram()[255:]) <= 400


# A flicker splits a phase in two: neighbours that end on the same picture are one.
merged = []
for p in phases:
    if merged and same(imgs[merged[-1][-1]], imgs[p[-1]]):
        merged[-1] = merged[-1] + p
    else:
        merged.append(p)
# A phase of a second or so is a state passing by (the GPS finding itself): not one of the four.
phases = [p for p in merged if len(p) >= 3]
# The blank desktop before the simulator draws is the first phase when it shows: dropped.
phases = [p for p in phases if imgs[p[-1]].convert("L").getextrema()[1] > 40]
names = ["1-home", "2-ready", "3-step", "4-run"]
for name, p in zip(names, phases[-4:] if len(phases) > 4 else phases):
    im = imgs[p[-1]]
    box = im.convert("L").point(lambda v: 255 if v > 8 else 0).getbbox()
    (im.crop(box) if box else im).save(os.path.join(out, f"{dev}-{name}.png"))
print(f"{dev}: {len(phases)} phases, {len(files)} pictures")
