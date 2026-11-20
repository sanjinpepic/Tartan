/**
 * The coach's memory: short notes about the athlete that outlast a conversation (an old knee
 * injury, mornings only, hates the treadmill, long runs go better fuelled). Every conversation
 * starts with them; the coach adds, edits and forgets notes with tools, and so can an agent over
 * MCP. One small file, coach/memory.json, merged note by note between the phone and the PC
 * (the newer edit wins; a forgotten note stays as a marker for a while so it isn't brought back).
 */
import { readJson, type Disk } from "./disk.ts";

export const NOTE_KINDS = ["athlete", "health", "preference", "goal", "lesson"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface Note {
  id: string;
  text: string;
  kind: NoteKind;
  created: string;
  updated: string;
  /** Forgotten: kept without its text so a merge doesn't bring it back. */
  gone?: boolean;
}

const FILE = "coach/memory.json";
export const MAX_NOTES = 60;
export const MAX_TEXT = 300;
/** Forgotten notes are dropped for good after this long. */
const KEEP_GONE_MS = 90 * 86400_000;

const isNote = (n: unknown): n is Note => {
  const x = n as Note;
  return !!x && typeof x.id === "string" && /^[a-z0-9-]{4,40}$/.test(x.id) && typeof x.text === "string" && (NOTE_KINDS as readonly string[]).includes(x.kind) && typeof x.updated === "string" && typeof x.created === "string";
};

/** Two sets of notes as one: per note, the later edit; on a tie, forgetting wins. */
export function mergeNotes(a: readonly Note[], b: readonly Note[], now = Date.now()): Note[] {
  const out = new Map<string, Note>();
  for (const n of [...a, ...b]) {
    if (!isNote(n)) continue;
    const cur = out.get(n.id);
    if (!cur || n.updated > cur.updated || (n.updated === cur.updated && n.gone && !cur.gone)) out.set(n.id, { ...n, text: n.gone ? "" : n.text.slice(0, MAX_TEXT) });
  }
  return [...out.values()].filter((n) => !n.gone || now - Date.parse(n.updated) < KEEP_GONE_MS).sort((x, y) => x.created.localeCompare(y.created));
}

const newId = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const clean = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

export class Memory {
  constructor(private readonly disk: Disk) {}

  /** Every note, forgotten ones included (what a sync sends). */
  async all(): Promise<Note[]> {
    const f = await readJson<{ notes?: Note[] }>(this.disk, FILE);
    return mergeNotes(f?.notes ?? [], []);
  }

  /** What the coach remembers now. */
  async notes(): Promise<Note[]> {
    return (await this.all()).filter((n) => !n.gone);
  }

  private async save(notes: Note[]): Promise<void> {
    await this.disk.write(FILE, JSON.stringify({ notes }, null, 1));
  }

  async remember(text: string, kind: NoteKind = "athlete"): Promise<Note> {
    const t = clean(text);
    if (!t) throw new Error("Nothing to remember.");
    const all = await this.all();
    const same = all.find((n) => !n.gone && n.text.toLowerCase() === t.toLowerCase());
    if (same) return same;
    if (all.filter((n) => !n.gone).length >= MAX_NOTES) throw new Error(`Memory is full (${MAX_NOTES} notes): merge or forget old notes first.`);
    const at = new Date().toISOString();
    const note: Note = { id: newId(), text: t, kind, created: at, updated: at };
    await this.save([...all, note]);
    return note;
  }

  async update(id: string, change: { text?: string; kind?: NoteKind }): Promise<Note> {
    const all = await this.all();
    const n = all.find((x) => x.id === id && !x.gone);
    if (!n) throw new Error(`No note ${id}.`);
    if (change.text !== undefined) {
      const t = clean(change.text);
      if (!t) throw new Error("A note needs text; use forget to remove it.");
      n.text = t;
    }
    if (change.kind) n.kind = change.kind;
    n.updated = new Date().toISOString();
    await this.save(all);
    return n;
  }

  async forget(id: string): Promise<boolean> {
    const all = await this.all();
    const n = all.find((x) => x.id === id && !x.gone);
    if (!n) return false;
    Object.assign(n, { text: "", gone: true, updated: new Date().toISOString() });
    await this.save(all);
    return true;
  }

  /** Take in notes from elsewhere (the phone or the PC); returns the merged set. */
  async merge(incoming: unknown): Promise<Note[]> {
    const notes = mergeNotes(await this.all(), Array.isArray(incoming) ? (incoming as Note[]) : []);
    await this.save(notes);
    return notes;
  }

  /** When the notes last changed (a conversation repeats them only after a change). */
  async stamp(): Promise<string> {
    return (await this.all()).reduce((m, n) => (n.updated > m ? n.updated : m), "");
  }

  /** The notes as the coach reads them at the start of a conversation; "" when there are none. */
  async prompt(): Promise<string> {
    const notes = await this.notes();
    if (!notes.length) return "";
    const lines = NOTE_KINDS.flatMap((k) => notes.filter((n) => n.kind === k).map((n) => `- [${n.id}] (${k}) ${n.text}`));
    return `What you remember about this athlete from earlier conversations (keep it current with remember, update_memory and forget_memory):\n${lines.join("\n")}`;
  }
}
