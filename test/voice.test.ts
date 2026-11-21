/**
 * The coach's voice in the words Tartan writes by itself: no exclamation marks, no emoji, in the
 * nudge, the note after a run, the stance on a day's change and the morning notifications.
 */
import { expect, test } from "bun:test";
import { afterRunWords } from "../src/after-run.ts";
import { stanceFor } from "../src/day-swap.ts";
import { nudgeLines, type NudgeFacts } from "../src/nudge.ts";
import type { RunFinish } from "../src/run-finish.ts";
import { dailies } from "../src/schedule.ts";
import { SYSTEM, VOICE_LINE } from "../src/coach/prompt.ts";
import { LOCAL_SYSTEM } from "../src/coach-litert.ts";

const loud = /[!\p{Extended_Pictographic}]/u;
const quiet = (s: string) => expect(s).not.toMatch(loud);

test("the nudge never shouts", () => {
  const base: NudgeFacts = { session: { title: "Easy run", kind: "easy", minutes: 40 }, week: { runs: 0, km: 0 } };
  const cases: NudgeFacts[] = [
    base,
    { ...base, week: { runs: 1, km: 6 } },
    { ...base, week: { runs: 3, km: 24.5 }, easy_felt: { avg: 4, n: 5 } },
    { ...base, since_last: 6, nudged: { ran: 4, n: 5 } },
    { ...base, session: { title: "6 × 800 m", kind: "intervals" }, race: { name: "Helsinki Half", days: 30 } },
    { ...base, stance: { lead: "others", line: "With that niggle, back off today. Any of these will do." } },
    { ...base, stance: { lead: "others" } },
    { ...base, stance: { lead: "run", line: "That's the third change in ten days, so not this one. 25 easy minutes, then see." } },
  ];
  for (const f of cases) {
    const n = nudgeLines(f);
    quiet(n.text);
    n.facts.forEach(quiet);
  }
});

test("the note after a run never shouts, a best included", () => {
  const finish = (o: Partial<RunFinish> = {}): RunFinish => ({ id: "r", start: "2026-11-18T07:00:00Z", records: [], ...o });
  const notes = [
    afterRunWords({ distance_km: 10, moving_min: 50 }, finish({ plan: { date: "2026-11-18", kind: "tempo", title: "Tempo", work: { onTarget: 4, total: 4 } } }), { when: "Tomorrow", sessions: [] }),
    afterRunWords({ distance_km: 5 }, finish({ records: [{ name: "5k", time_s: 1471, rank: 1, vs: 1490 }] }), { when: "Tomorrow", sessions: [{ kind: "easy", title: "Easy run" }] }),
    afterRunWords({ distance_km: 8, moving_min: 44, avg_hr: 141 }, finish(), null),
    afterRunWords({ distance_km: 8 }, finish({ plan: { date: "2026-11-18", kind: "easy", title: "Easy run", inRange: 0.4 } }), { when: "Tomorrow", sessions: [{ kind: "long", title: "Long run" }] }),
  ];
  for (const n of notes) {
    quiet(n.text);
    quiet(n.title);
    n.facts.forEach(quiet);
  }
});

test("the stance on a day's change, and the morning's notifications, stay quiet", () => {
  const T = "2026-11-18";
  const easy = { kind: "easy", title: "Easy run" };
  const days = [{ date: T, sessions: [easy] }];
  const answers = [{ date: "2026-11-12", kind: "easy", pick: "swim" as const, tags: [] }, { date: "2026-11-15", kind: "easy", pick: "ride" as const, tags: [] }];
  for (const o of [{ niggle: true }, { tired: true }, { raceDays: 1 }, { raceDays: 12 }, {}]) {
    const s = stanceFor({ today: T, session: easy, days, answers: Object.keys(o).length ? [] : answers, ...o });
    if (s.line) quiet(s.line);
  }
  const now = Date.parse("2026-11-18T06:00:00");
  for (const plan of [true, false]) {
    for (const d of dailies({ prefs: {}, slots: [], morning: { readiness: "Go easy", proposed: 2, plan } }, now)) {
      quiet(d.title);
      quiet(d.body);
    }
  }
});

test("the coach's prompts carry its voice, and its name is just Coach", () => {
  for (const p of [SYSTEM, LOCAL_SYSTEM]) {
    expect(p).toContain("no exclamation marks");
    expect(p).not.toContain("Tartan Coach");
    expect(p).not.toMatch(/\bTart\b/);
  }
  expect(SYSTEM).toContain("Voice:");
  expect(LOCAL_SYSTEM).toContain(VOICE_LINE);
});
