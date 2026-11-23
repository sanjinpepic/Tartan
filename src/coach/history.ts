/**
 * A long Gemini conversation kept light: every turn sends the whole history, and a chat that has
 * run for weeks (the plan's own chat above all) carries every lookup the coach ever made, tens of
 * thousands of characters each. Past a budget, turns before the last few keep only what was said:
 * the athlete's words and the coach's answers. The lookups go (the coach can look again, with fresh
 * data), as do thoughts, photos and the signatures that only the current turn needs.
 */
import type { Content, Part } from "@google/genai";

/** Characters of history (as JSON) a turn may carry before older turns are shortened. */
export const HISTORY_BUDGET = 60_000;
/** The latest exchanges always kept whole. */
export const KEEP_TURNS = 2;

const size = (c: Content[]) => JSON.stringify(c).length;
/** A user content that starts an exchange (the athlete's words), not one answering the coach's lookups. */
const opens = (c: Content) => c.role === "user" && (c.parts ?? []).some((p) => typeof p.text === "string");

/** Shortens `contents` in place when it's over the budget; returns whether it changed. */
export function compactHistory(contents: Content[], budget = HISTORY_BUDGET, keep = KEEP_TURNS): boolean {
  if (size(contents) <= budget) return false;
  const starts = contents.map((c, i) => (opens(c) ? i : -1)).filter((i) => i >= 0);
  if (starts.length <= keep) return false;
  const cut = starts[starts.length - keep]!;
  const old: Content[] = [];
  for (const c of contents.slice(0, cut)) {
    if (c.role === "user") {
      if (!opens(c)) continue; // a lookup's answer
      const parts: Part[] = (c.parts ?? []).flatMap((p): Part[] => (typeof p.text === "string" ? [{ text: p.text }] : p.inlineData ? [{ text: "[a photo]" }] : []));
      old.push({ role: "user", parts });
    } else {
      const words = (c.parts ?? []).filter((p) => typeof p.text === "string" && p.text && !p.thought).map((p) => p.text!).join("");
      if (!words) continue;
      // One model answer per exchange: the rounds of one turn join up.
      const last = old.at(-1);
      if (last?.role === "model") last.parts![0]!.text += words;
      else old.push({ role: "model", parts: [{ text: words }] });
    }
  }
  // An exchange the coach never answered in words still alternates.
  const merged: Content[] = [];
  for (const c of old) {
    const last = merged.at(-1);
    if (last && last.role === c.role) last.parts = [...last.parts!, ...c.parts!];
    else merged.push(c);
  }
  if (merged.at(-1)?.role === "user") merged.push({ role: "model", parts: [{ text: "(no answer)" }] });
  if (JSON.stringify(merged) === JSON.stringify(contents.slice(0, cut))) return false;
  contents.splice(0, cut, ...merged);
  return true;
}
