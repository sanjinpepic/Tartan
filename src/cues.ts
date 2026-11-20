/**
 * Spoken cues while recording a run on the phone: at every kilometre, the split, the time so far,
 * heart rate when a sensor is on, and against today's target pace when the plan has one. Words a
 * voice reads well: "Kilometre 3. Split 4 minutes 52. Time 14 minutes 30. On pace."
 */

/** "4 minutes 52", "1 hour 2 minutes", "45 seconds". */
export function spokenTime(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h} hour${h > 1 ? "s" : ""}${m ? ` ${m} minute${m > 1 ? "s" : ""}` : ""}`;
  if (!m) return `${r} seconds`;
  return r ? `${m} minute${m > 1 ? "s" : ""} ${r}` : `${m} minute${m > 1 ? "s" : ""}`;
}

/**
 * The cue at the end of kilometre `km`: its split (s), the moving time so far (s), heart rate,
 * and the pace against a target [fast, slow] in seconds per km (5 s of slack either way).
 */
export function kmCue(km: number, split: number, total: number, o: { hr?: number; target?: [number, number] | null } = {}): string {
  const parts = [`Kilometre ${km}.`, `Split ${spokenTime(split)}.`, `Time ${spokenTime(total)}.`];
  if (o.hr) parts.push(`Heart rate ${Math.round(o.hr)}.`);
  const t = o.target;
  if (t) parts.push(split < t[0] - 5 ? "A little fast: ease off." : split > t[1] + 5 ? "A little slow." : "On pace.");
  return parts.join(" ");
}

/** The kilometres newly completed between two distances (m): usually none or one. */
export function kmsPassed(before: number, after: number): number[] {
  const out: number[] = [];
  for (let k = Math.floor(before / 1000) + 1; k * 1000 <= after; k++) out.push(k);
  return out;
}
