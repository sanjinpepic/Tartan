/**
 * Watch faces made in the face builder (Settings → More → Advanced → Watch face builder), one file each in `faces/`. A face is a
 * design (src/watchface/tartan-face.ts); the phone draws and installs it.
 */
import { readJson, type Disk } from "./disk.ts";
import { checkDesign, newFaceId, type FaceDesign } from "./watchface/tartan-face.ts";

const DIR = "faces";

export type SavedFace = FaceDesign & { created: string; updated: string };
export type FaceSummary = Omit<SavedFace, "background"> & { background: { kind: FaceDesign["background"]["kind"] } };

export class Faces {
  constructor(private readonly disk: Disk) {}

  async get(id: string): Promise<SavedFace | null> {
    if (!/^\d{6,10}$/.test(id)) return null;
    const f = await readJson<SavedFace & { deleted?: boolean }>(this.disk, `${DIR}/${id}.json`);
    return f && !f.deleted ? f : null;
  }

  /** Newest first; photos left out (they're large). */
  async list(): Promise<FaceSummary[]> {
    const out: FaceSummary[] = [];
    for (const e of await this.disk.list(DIR)) {
      if (e.dir || !e.name.endsWith(".json")) continue;
      const f = await this.get(e.name.slice(0, -5));
      if (f) out.push({ ...f, background: { kind: f.background.kind } });
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** Check and save; a design without an id gets a new one. */
  async save(input: Partial<FaceDesign>, now = new Date()): Promise<SavedFace> {
    const d = checkDesign({ ...input, id: input.id || newFaceId() });
    const prev = await this.get(d.id);
    const f: SavedFace = { ...d, created: prev?.created ?? now.toISOString(), updated: now.toISOString() };
    await this.disk.write(`${DIR}/${d.id}.json`, JSON.stringify(f));
    return f;
  }

  /** Disks have no delete: an empty marker hides it. */
  async remove(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await this.disk.write(`${DIR}/${id}.json`, JSON.stringify({ id, deleted: true }));
    return true;
  }
}
