/**
 * Read a watch recording (Settings → More → Advanced → Watch recorder on the phone, or
 * `tartan … --record file.jsonl` on the PC) and play it back:
 *   bun scripts/replay.ts watch.jsonl            every frame and log line, decoded
 *   bun scripts/replay.ts watch.jsonl --full     the same with whole payloads
 *   bun scripts/replay.ts watch.jsonl --connect  run today's connect (open, layout, listing) against it
 * The recording is the owner's data (workouts, heart rate): keep it out of the repository.
 */
import { readFileSync } from "node:fs";
import { decodeTape, parseTape, ReplayLink } from "../src/protocol/blackbox.ts";
import { WatchSession } from "../src/protocol/session.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/replay.ts <recording.jsonl> [--full | --connect]");
  process.exit(2);
}
const tape = parseTape(readFileSync(file, "utf8"));

if (!process.argv.includes("--connect")) {
  console.log(decodeTape(tape, process.argv.includes("--full")));
  process.exit(0);
}

const replay = new ReplayLink(tape);
const s = new WatchSession(replay, { log: (m) => console.log(`  · ${m}`), chunkDelayMs: 0, frameGapMs: 0, timeoutMs: 400 });
let failed: unknown = null;
try {
  const info = await s.open();
  console.log(`opened: ${info.name} · ${info.info.join(" · ")}`);
  const gen = await s.detectGeneration();
  console.log(`layout: ${gen}`);
  const root = await s.listDir("/");
  console.log(`/: ${root.dirs.length} folders, ${root.files.length} files`);
} catch (e) {
  failed = e;
  console.log(`stopped: ${(e as Error).message}`);
}
console.log(`\nanswered from the recording: ${replay.answered.length}`);
if (replay.approximate.length) console.log(`answered from a near match:\n  ${replay.approximate.join("\n  ")}`);
if (replay.misses.length) console.log(`not in the recording (no answer):\n  ${replay.misses.join("\n  ")}`);
process.exit(failed ? 1 : 0);
