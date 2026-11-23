/**
 * Who shows the exercises: "like me" follows the profile's sex (Strava's, or set in the intro or
 * Settings); a man, a woman, or both (each exercise keeps the same one, so a list shows a mix).
 * Unknown sex under "like me" also mixes.
 */
import { app } from "../state.ts";
import type { Body } from "./body3d.ts";

export type DemoChoice = "me" | "m" | "f" | "mix";
const KEY = "tartan.demos";

export function demoChoice(): DemoChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "m" || v === "f" || v === "mix" ? v : "me";
  } catch {
    return "me";
  }
}

export function setDemoChoice(c: DemoChoice): void {
  try {
    if (c === "me") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {
    // not remembered
  }
}

let sex: Promise<"M" | "F" | undefined> | null = null;
/** The profile changed: read it again next time. */
export function forgetSex(): void {
  sex = null;
}

/** A stable coin for "both": the same exercise always shows the same body. */
const coin = (key: string): Body => {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (h >>> 0) % 2 ? "f" : "m";
};

export async function demoBody(key: string): Promise<Body> {
  const c = demoChoice();
  if (c === "m" || c === "f") return c;
  if (c === "me") {
    sex ??= app.api.json<{ sex?: string }>("/api/profile").then((p) => (p.sex === "M" || p.sex === "F" ? p.sex : undefined)).catch(() => undefined);
    const s = await sex;
    if (s) return s === "F" ? "f" : "m";
  }
  return coin(key);
}

/** The You page's body: yours by the profile's sex, else the demo body chosen, else a man's. */
export async function yourBody(): Promise<Body> {
  sex ??= app.api.json<{ sex?: string }>("/api/profile").then((p) => (p.sex === "M" || p.sex === "F" ? p.sex : undefined)).catch(() => undefined);
  const s = await sex;
  if (s) return s === "F" ? "f" : "m";
  const c = demoChoice();
  return c === "f" ? "f" : "m";
}
