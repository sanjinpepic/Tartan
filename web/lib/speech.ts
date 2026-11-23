/**
 * Speak instead of type (run notes). On the phone, Android's own recognizer through the
 * TartanSpeech plugin: on-device when the phone has the language (offline, nothing leaves the
 * phone), else the system one preferring offline. In a desktop browser, the Web Speech API.
 * Words arrive as you speak; it ends when you pause or tap stop.
 */
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { isNative } from "../state.ts";

interface SpeechPlugin {
  available(): Promise<{ available: boolean; onDevice: boolean }>;
  start(): Promise<{ text: string; onDevice?: boolean }>;
  stop(): Promise<void>;
  addListener(e: "partial", f: (d: { text: string }) => void): Promise<PluginListenerHandle>;
  addListener(e: "level", f: (d: { db: number }) => void): Promise<PluginListenerHandle>;
}
const Speech = registerPlugin<SpeechPlugin>("TartanSpeech");

type WebRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
/** Looked up when used (a test can put its own in). */
const webSpeech = () => (globalThis as { SpeechRecognition?: new () => WebRecognition; webkitSpeechRecognition?: new () => WebRecognition }).SpeechRecognition ?? (globalThis as { webkitSpeechRecognition?: new () => WebRecognition }).webkitSpeechRecognition;

let can: Promise<boolean> | null = null;
/** Is there a recognizer here? (Asked once.) */
export function canDictate(): Promise<boolean> {
  can ??= isNative ? Speech.available().then((r) => r.available).catch(() => false) : Promise.resolve(!!webSpeech());
  return can;
}

export interface Dictation {
  /** The final text ("" when nothing was heard). */
  done: Promise<string>;
  stop(): void;
}

/** Listen once, in the phone's (or browser's) own language: `onWords` gets the words so far as you speak. */
export function dictate(onWords: (text: string) => void, onLevel?: (level: number) => void): Dictation {
  if (isNative) {
    const handles: Array<Promise<PluginListenerHandle>> = [Speech.addListener("partial", (d) => onWords(d.text))];
    if (onLevel) handles.push(Speech.addListener("level", (d) => onLevel(Math.max(0, Math.min(1, (d.db + 2) / 12)))));
    const done = Speech.start()
      .then((r) => r.text)
      .finally(() => handles.forEach((h) => void h.then((x) => x.remove())));
    return { done, stop: () => void Speech.stop() };
  }
  const WebSpeech = webSpeech();
  if (!WebSpeech) return { done: Promise.reject(new Error("This browser can't take speech. Type it instead.")), stop: () => {} };
  const rec = new WebSpeech();
  rec.lang = navigator.language;
  rec.interimResults = true;
  rec.continuous = false;
  let text = "";
  const done = new Promise<string>((resolve, reject) => {
    rec.onresult = (e) => {
      text = Array.from(e.results, (r) => r[0]?.transcript ?? "").join(" ").trim();
      onWords(text);
    };
    rec.onerror = (e) => (e.error === "no-speech" || e.error === "aborted" ? resolve(text) : reject(new Error(e.error === "not-allowed" ? "The browser wasn't allowed the microphone." : `Couldn't hear that (${e.error}).`)));
    rec.onend = () => resolve(text);
  });
  rec.start();
  return { done, stop: () => rec.stop() };
}
