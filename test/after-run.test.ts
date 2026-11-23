/** The note after a run (src/after-run.ts): its words by rules, which runs get one, the coach's words. */
import { beforeAll, expect, test } from "bun:test";
import { afterRunWords, claimNewRuns, lastWords, nextDay, nextWords } from "../src/after-run.ts";
import { Coach } from "../src/coach.ts";
import { MemoryDisk } from "../src/disk.ts";
import { FILES_FOLDER, importWorkout } from "../src/import.ts";
import { Library } from "../src/library.ts";
import { mondayOf, Plans } from "../src/plan.ts";
import type { RunFinish } from "../src/run-finish.ts";
import { LocalStore } from "../src/store.ts";
import { LocalApiBackend } from "../web/local-api.ts";

beforeAll(() => {
  (globalThis as { location?: unknown }).location = new URL("http://localhost/");
});

const finish = (o: Partial<RunFinish> = {}): RunFinish => ({ id: "r", start: "2026-11-18T07:00:00Z", records: [], ...o });
const last = (pace: string, hr: number, now: { pace: string; hr: number }) => ({ id: "p", date: "2026-11-11", pace, hr, now, change: 3, verdict: "fitter" as const, text: "8 s/km faster at 4 bpm lower: 5% more distance per heartbeat. Fitter." });

test("a tempo with every rep on pace, against last time, and tomorrow easy", () => {
  const f = finish({ plan: { date: "2026-11-18", kind: "tempo", title: "Steady tempo", work: { onTarget: 4, total: 4 } }, last: last("5:00", 160, { pace: "5:00", hr: 156 }) });
  const w = afterRunWords({ distance_km: 10.24, moving_min: 52 }, f, { when: "Tomorrow", sessions: [{ kind: "easy", title: "Easy run" }] });
  expect(w.title).toBe("Steady tempo · 10.2 km");
  expect(w.text).toBe("Every rep on pace, heart rate 4 lower than last time. Tomorrow stays easy.");
  expect(w.facts.some((x) => x.startsWith("Against the last run like it"))).toBe(true);
});

test("a record, a run that wasn't planned, a rest day next; and plain pace when there's nothing else", () => {
  const f = finish({ records: [{ name: "5k", time_s: 1471, rank: 1, vs: 1490 }, { name: "1k", time_s: 280, rank: 2, vs: 270 }] });
  const w = afterRunWords({ name: "Morning run", distance_km: 7 }, f, { when: "Tomorrow", sessions: [] });
  expect(w.text).toBe("A new best 5 km in 24:31. Tomorrow is a rest day.");
  expect(afterRunWords({ distance_km: 8, moving_min: 44, avg_hr: 141 }, finish(), null).text).toBe("5:30 /km at 141 bpm.");
  // Heart-rate sessions: in range, or how much of it.
  const easy = (inRange: number) => afterRunWords({ distance_km: 8 }, finish({ plan: { date: "2026-11-18", kind: "easy", title: "Easy run", inRange } }), { when: "Tomorrow", sessions: [{ kind: "intervals", title: "6 × 800 m" }] }).text;
  expect(easy(0.9)).toBe("Heart rate in range. Tomorrow: 6 × 800 m.");
  expect(easy(0.5)).toBe("50% in the heart-rate range. Tomorrow: 6 × 800 m.");
  expect(nextWords(null)).toBeNull();
});

test("against last time in words: pace, heart rate, both, or the same", () => {
  expect(lastWords(last("5:40", 150, { pace: "5:30", hr: 150 }))).toBe("10 s/km quicker than last time");
  expect(lastWords(last("5:30", 150, { pace: "5:40", hr: 155 }))).toBe("10 s/km slower than last time, heart rate 5 higher");
  expect(lastWords(last("5:30", 150, { pace: "5:31", hr: 151 }))).toBe("the same as last time");
});

test("the day after the run: tomorrow, or today when the run was yesterday", () => {
  const view = { weeks: [{ days: [{ date: "2026-11-18", sessions: [{ kind: "tempo", title: "Tempo", status: "done" }] }, { date: "2026-11-19", sessions: [{ kind: "recovery", title: "Recovery", status: "planned" }] }] }] };
  expect(nextDay(view, "2026-11-18", "2026-11-18")).toEqual({ when: "Tomorrow", sessions: [{ kind: "recovery", title: "Recovery" }] });
  expect(nextDay(view, "2026-11-18", "2026-11-19")!.when).toBe("Today");
  expect(nextDay(view, "2026-11-19", "2026-11-19")).toBeNull();
});

test("which runs get a note: the last day's, once each, none from before the first look", async () => {
  const disk = new MemoryDisk();
  const now = Date.parse("2026-11-18T12:00:00Z");
  const row = (id: string, hoursAgo: number, sport = "Run", km = 8) => ({ id, start: new Date(now - hoursAgo * 3600_000).toISOString(), sport, distance_km: km });
  const isRun = (s: string) => s === "Run";
  // The first look (a fresh install, an import, a restored backup without the record): nothing.
  expect(await claimNewRuns(disk, [row("a", 2), row("b", 30)], isRun, now)).toEqual([]);
  // A new run: once; an old one, a walk or a tiny run: never.
  const rows = [row("a", 2), row("b", 30), row("c", 1), row("d", 40), row("w", 1, "Walk"), row("t", 1, "Run", 0.1)];
  expect(await claimNewRuns(disk, rows, isRun, now)).toEqual(["c"]);
  expect(await claimNewRuns(disk, rows, isRun, now)).toEqual([]);
  // Several at once: newest first, at most three.
  const many = [row("e", 5), row("f", 4), row("g", 3), row("h", 2.5)];
  expect(await claimNewRuns(disk, many, isRun, now)).toEqual(["h", "g", "f"]);
  expect(await claimNewRuns(disk, many, isRun, now)).toEqual([]);
});

/** A run as a FIT file: `km` at `pace` s/km and `hr` bpm, ending `endAgo` ms ago. */
const run = (start: number, km: number, pace: number, hr: number) => {
  const samples = [];
  const secs = km * pace;
  for (let t = 0; t <= secs; t += 10) samples.push({ t: start + t * 1000, lat: 60.17 + (t / secs) * 0.05, lon: 24.94, hr, distance: (t / pace) * 1000 });
  return { start, end: start + secs * 1000, sport: "running", samples };
};

test("the phone asks: a new run gets its note by rules, then never again; the switch turns it off", async () => {
  const disk = new MemoryDisk();
  const store = new LocalStore(disk);
  const now = Date.now();
  await importWorkout(store, FILES_FOLDER, "old", run(now - 8 * 86400_000, 8, 330, 150));
  const app = new LocalApiBackend(disk, false);
  type Notes = { notes: Array<{ id: string; title: string; text: string; by: string }> };
  expect((await app.json<Notes>("/api/after-run")).notes).toEqual([]);
  // A plan with an easy run the day after the new run (two hours ago: yesterday, just after midnight).
  const ran = now - 2 * 3600_000;
  const next = new Date(ran + 86400_000).toLocaleDateString("sv");
  const when = next === new Date(now).toLocaleDateString("sv") ? "Today" : "Tomorrow";
  await new Plans(new Library(disk)).save({ title: "P", summary: "S", weeks: [{ start: mondayOf(next), focus: "Build", sessions: [{ date: next, kind: "easy", title: "Easy run", duration_min: 40 }] }] });
  await importWorkout(store, FILES_FOLDER, "new", run(ran, 8, 320, 146));
  const app2 = new LocalApiBackend(disk, false);
  const first = (await app2.json<Notes>("/api/after-run")).notes;
  expect(first).toHaveLength(1);
  expect(first[0]!.by).toBe("rules");
  expect(first[0]!.title).toMatch(/8(\.0)? km/);
  expect(first[0]!.text).toBe(`A new best 5 km in 26:40, 10 s/km quicker than last time, heart rate 4 lower. ${when} stays easy.`);
  expect((await app2.json<Notes>("/api/after-run")).notes).toEqual([]);
  // Off: a new run is claimed but gets no note (turning it on later brings no old ones).
  await app2.request("/api/schedule", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notify: { run: false } }) });
  await importWorkout(store, FILES_FOLDER, "newer", run(now - 3600_000, 5, 300, 150));
  const app3 = new LocalApiBackend(disk, false);
  expect((await app3.json<Notes>("/api/after-run")).notes).toEqual([]);
  await app3.request("/api/schedule", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notify: { run: true } }) });
  expect((await app3.json<Notes>("/api/after-run")).notes).toEqual([]);
});

test("the coach's words: with a cloud key, short; on an error, a long answer or a slow one, the rules' words stand", async () => {
  let answer = "Strong tempo: every rep on pace and your heart rate 4 lower than last week. Keep tomorrow easy.";
  let delay = 0;
  const bodies: Array<{ max_tokens: number; model: string }> = [];
  const fetchMock = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    await new Promise((r) => setTimeout(r, delay));
    if (answer === "error") return Response.json({ type: "error", error: { type: "api_error", message: "down" } }, { status: 500 });
    return Response.json({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: answer }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }) as unknown as typeof fetch;
  const coach = new Coach(new Library(new MemoryDisk()), { baseURL: "http://claude.test", fetch: fetchMock });
  expect(await coach.afterRunWords("draft.", ["Run: 10 km."])).toBeNull(); // no key yet
  await coach.saveSettings({ provider: "anthropic", apiKey: "sk-ant-test-0123456789abcdefghij" });
  expect(await coach.afterRunWords("draft.", ["Run: 10 km."])).toBe(answer);
  expect(bodies.at(-1)!.max_tokens).toBeLessThanOrEqual(200);
  answer = "x".repeat(300) + ".";
  expect(await coach.afterRunWords("draft.", ["Run: 10 km."])).toBeNull();
  answer = "error";
  expect(await coach.afterRunWords("draft.", ["Run: 10 km."])).toBeNull();
  answer = "Fine run. Easy tomorrow.";
  delay = 300;
  expect(await coach.afterRunWords("draft.", ["Run: 10 km."], 50)).toBeNull();
});
