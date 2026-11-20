/**
 * Notes on a run: a win ("first sub-25 5k"), a niggle ("left calf tight after the hills", with
 * where) or a plain note. Kept in coach/run-notes.json, so they go to the PC with the rest and
 * the coach reads them. Niggles count with the morning check's pain (CheckIns.niggles): the body
 * map, readiness and the coach see both; a niggle in the same place again is a pattern.
 */
import { readJson, type Disk } from "./disk.ts";
import { PAIN_AREAS, PAIN_NAME, type PainArea } from "./readiness.ts";

export const FILE = "coach/run-notes.json";
export const NOTE_TAGS = ["win", "niggle", "note"] as const;
export type NoteTag = (typeof NOTE_TAGS)[number];

export interface RunNote {
  id: string;
  /** The workout (its id in the library). */
  run: string;
  /** The run's day, YYYY-MM-DD. */
  date: string;
  tag: NoteTag;
  text: string;
  /** For a niggle: where. */
  area?: PainArea;
  at: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class RunNotes {
  constructor(private readonly disk: Disk) {}

  async all(): Promise<RunNote[]> {
    const d = await readJson<RunNote[]>(this.disk, FILE);
    return Array.isArray(d) ? d : [];
  }

  async forRun(run: string): Promise<RunNote[]> {
    return (await this.all()).filter((n) => n.run === run);
  }

  async add(n: { run: string; date: string; tag: string; text?: string; area?: string }): Promise<RunNote> {
    if (!n.run) throw new Error("which run?");
    if (!DATE.test(n.date)) throw new Error("the run's day is missing");
    if (!NOTE_TAGS.includes(n.tag as NoteTag)) throw new Error("a note is a win, a niggle or a note");
    const text = String(n.text ?? "").trim().slice(0, 280);
    const area = n.tag === "niggle" && PAIN_AREAS.includes(n.area as PainArea) ? (n.area as PainArea) : undefined;
    if (!text && !area) throw new Error("write a few words");
    const note: RunNote = { id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, run: n.run, date: n.date, tag: n.tag as NoteTag, text, ...(area ? { area } : {}), at: new Date().toISOString() };
    await this.disk.write(FILE, JSON.stringify([...(await this.all()), note], null, 2));
    return note;
  }

  async remove(id: string): Promise<void> {
    await this.disk.write(FILE, JSON.stringify((await this.all()).filter((n) => n.id !== id), null, 2));
  }

  /** Niggles noted on runs since `since` (YYYY-MM-DD), as the morning check's pain at level 1. */
  async niggles(since: string): Promise<Array<{ date: string; area: PainArea; level: 1 }>> {
    return (await this.all()).filter((n) => n.tag === "niggle" && n.area && n.date >= since).map((n) => ({ date: n.date, area: n.area!, level: 1 as const }));
  }
}

/**
 * The same place noted again and again: two or more niggles in one area within three weeks
 * (from runs and morning checks), newest first. For "Worth knowing" and the coach.
 */
export function nigglePattern(niggles: Array<{ date: string; area: PainArea }>): Array<{ area: PainArea; name: string; times: number; last: string }> {
  const by = new Map<PainArea, { times: number; last: string }>();
  for (const n of niggles) {
    const b = by.get(n.area) ?? { times: 0, last: "" };
    by.set(n.area, { times: b.times + 1, last: n.date > b.last ? n.date : b.last });
  }
  return [...by.entries()].filter(([a, b]) => a !== "other" && b.times >= 2).map(([area, b]) => ({ area, name: PAIN_NAME[area], ...b })).sort((a, b) => b.last.localeCompare(a.last));
}

/** How your recent workouts felt on the watch (1 poor … 5 excellent), newest first: for readiness. */
export async function recentFeelings(lib: { activities(f: { since: string }): Promise<Array<{ feeling?: number }>> }, days = 5, now = Date.now()): Promise<number[]> {
  const since = new Date(now - days * 86400_000).toISOString().slice(0, 10);
  return (await lib.activities({ since })).flatMap((r) => (r.feeling ? [r.feeling] : []));
}
