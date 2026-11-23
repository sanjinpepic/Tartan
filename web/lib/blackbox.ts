/**
 * The watch recorder (src/protocol/blackbox.ts) in the app: switched on for the next connection
 * only, kept in the app's private storage (the PC browser keeps it in memory), shared by hand.
 */
import { RecordingLink } from "../../src/protocol/blackbox.ts";
import type { BleLink } from "../../src/protocol/session.ts";
import { saveFile } from "./files.ts";
import { isNative } from "../state.ts";

declare const BUILD_ID: string;
const BUILD = typeof BUILD_ID === "string" ? BUILD_ID : "dev";
const ARMED = "tartan.blackbox";
const LAST = "tartan.blackbox.last";
const FILE = "blackbox/watch.jsonl";

export interface RecorderState {
  armed: boolean;
  recording: boolean;
  last: { started: string; bytes: number; name: string } | null;
}

const listeners = new Set<(s: RecorderState) => void>();
let recording = false;
/** The PC browser's copy (the phone writes to a file instead). */
let memory: string[] = [];

const read = <T>(key: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (key: string, value: unknown) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // no storage
  }
};

export function recorder(): RecorderState {
  return { armed: read(ARMED, false), recording, last: read(LAST, null) };
}
export function onRecorder(f: (s: RecorderState) => void): () => void {
  listeners.add(f);
  f(recorder());
  return () => listeners.delete(f);
}
const emit = () => listeners.forEach((f) => f(recorder()));

export function armRecorder(on: boolean): void {
  store(ARMED, on || null);
  emit();
}

/**
 * When armed, the link comes back recording (and the recorder disarms: one connection each time).
 * `log` is the session's log with each line also on the tape.
 */
export function recordLink(link: BleLink, log: (m: string) => void): { link: BleLink; log: (m: string) => void } {
  if (!recorder().armed || recording) return { link, log };
  store(ARMED, null);
  recording = true;
  memory = [];
  const started = new Date().toISOString();
  let pending: string[] = [];
  let bytes = 0;
  let fresh = true;
  let writing: Promise<void> = Promise.resolve();
  const flush = () => {
    if (!pending.length) return writing;
    const text = `${pending.join("\n")}\n`;
    pending = [];
    writing = writing
      .then(async () => {
        if (!isNative) return void memory.push(text);
        const { Directory, Encoding, Filesystem } = await import("@capacitor/filesystem");
        const at = { path: FILE, data: text, directory: Directory.Data, encoding: Encoding.UTF8 };
        if (fresh) await Filesystem.writeFile({ ...at, recursive: true });
        else await Filesystem.appendFile(at);
        fresh = false;
      })
      .catch((e) => log(`[blackbox] couldn't save the recording: ${(e as Error).message}`));
    return writing;
  };
  const timer = setInterval(() => void flush(), 2000);
  const rec = new RecordingLink(
    link,
    (line) => {
      pending.push(line);
      bytes += line.length + 1;
    },
    {
      build: BUILD,
      onEnd: () => {
        recording = false;
        clearInterval(timer);
        void flush().then(() => {
          store(LAST, { started, bytes, name: link.name });
          emit();
        });
      },
    },
  );
  emit();
  log("[blackbox] recording this connection (Settings → More → Advanced → Watch recorder)");
  return {
    link: rec,
    log: (m) => {
      log(m);
      rec.note(m);
    },
  };
}

/** Share the last recording: the share sheet on the phone, a download on the PC. */
export async function shareRecording(): Promise<void> {
  const last = recorder().last;
  if (!last) throw new Error("Nothing recorded yet.");
  const name = `tartan-watch-${last.started.slice(0, 16).replace(/[T:]/g, "-")}.jsonl`;
  if (!isNative) {
    if (!memory.length) throw new Error("The recording was made before this page was reloaded; record the connection again.");
    return saveFile(name, memory.join(""), "application/x-ndjson", "Send the watch recording");
  }
  const { Directory, Filesystem } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  await Filesystem.copy({ from: FILE, directory: Directory.Data, to: name, toDirectory: Directory.Cache });
  const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache });
  await Share.share({ title: name, files: [uri], dialogTitle: "Send the watch recording" });
}
