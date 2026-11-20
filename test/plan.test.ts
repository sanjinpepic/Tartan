/** The training plan: validation, history, ticking sessions off, the week view, and the coach writing it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analytics } from "../src/analytics.ts";
import { Coach, type CoachEvent } from "../src/coach.ts";
import { NodeDisk } from "../src/disk-node.ts";
import { Library } from "../src/library.ts";
import { mondayOf, Plans, today, type PlanInput } from "../src/plan.ts";

let root: string;
let lib: Library;

const run = (id: number, date: string, km: number, type = "Run") => ({
  id, name: `${type} ${date}`, type, sport_type: type,
  start_date: `${date}T07:00:00Z`, start_date_local: `${date}T09:00:00Z`,
  distance: km * 1000, moving_time: km * 330, elapsed_time: km * 340, total_elevation_gain: 20, average_heartrate: 140, max_heartrate: 170,
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "tartan-plan-"));
  lib = new Library(new NodeDisk(root));
  await lib.strava.write(
    [
      run(1, "2026-09-07", 8), // Mon: the planned easy run
      run(2, "2026-09-10", 30, "Ride"), // Thu: nobody planned it
      run(3, "2026-09-13", 16), // Sun: the long run
      run(4, "2026-09-14", 6), // next Mon
      run(5, "2026-08-31", 10), // the week before the plan
    ],
    "index.json",
  );
});

const PLAN: PlanInput = {
  title: "Build to the autumn 10k",
  summary: "Three runs a week, one long.",
  weeks: [
    {
      start: "2026-09-07",
      focus: "Build",
      target_km: 30,
      sessions: [
        { date: "2026-09-07", kind: "easy", title: "Easy run", distance_km: 8, target: "Z2" },
        { date: "2026-09-09", kind: "tempo", title: "Tempo 3 × 10 min", duration_min: 50 },
        { date: "2026-09-11", kind: "rest", title: "Rest" },
        { date: "2026-09-13", kind: "long", title: "Long run", distance_km: 16 },
      ],
    },
    {
      start: "2026-09-14",
      focus: "Build",
      sessions: [
        { date: "2026-09-14", kind: "easy", title: "Easy run", duration_min: 40 },
        { date: "2026-09-16", kind: "intervals", title: "6 × 800 m", duration_min: 55 },
        { date: "2026-09-18", kind: "strength", title: "Strength", duration_min: 30 },
      ],
    },
  ],
  advice: ["Keep easy runs easy."],
};

test("plans: validated, versions kept, sessions ticked off against workouts", async () => {
  const plans = new Plans(lib);
  await expect(plans.save({ ...PLAN, weeks: [{ ...PLAN.weeks[0]!, start: "2026-09-08" }] })).rejects.toThrow(/not a Monday/);
  await expect(plans.save({ ...PLAN, weeks: [{ ...PLAN.weeks[0]!, sessions: [{ date: "2026-09-20", kind: "easy", title: "x" }] }] })).rejects.toThrow(/outside the week/);
  expect(await plans.current()).toBeNull();

  await plans.save(PLAN, { conversation: "c1" });
  await plans.save(PLAN, { conversation: "c2" });
  expect(readdirSync(join(root, "coach", "plans"))).toHaveLength(1);
  expect((await plans.current())!.conversation).toBe("c2");

  // Wednesday of the second week, midday.
  const v = await plans.view(new Date(2026, 8, 16, 12));
  expect(v.today).toBe("2026-09-16");
  const [w1, w2] = v.weeks;
  expect(w1!.when).toBe("past");
  expect(w2!.when).toBe("current");
  const s = (w: typeof w1, date: string) => w!.days.find((d) => d.date === date)!;
  expect(s(w1, "2026-09-07").sessions[0]).toMatchObject({ status: "done", activity: { id: expect.any(String), distance_km: 8 } });
  expect(s(w1, "2026-09-09").sessions[0]!.status).toBe("missed");
  expect(s(w1, "2026-09-10").extra).toHaveLength(1); // the ride
  expect(s(w1, "2026-09-11").sessions[0]!.status).toBe("rest");
  expect(s(w1, "2026-09-13").sessions[0]!.status).toBe("done");
  expect(w1!.planned).toEqual({ sessions: 3, km: 24, minutes: 50 });
  expect(w1!.done).toMatchObject({ sessions: 2, km: 54 });
  expect(s(w2, "2026-09-14").sessions[0]!.status).toBe("done");
  expect(s(w2, "2026-09-16").sessions[0]!.status).toBe("today");
  expect(s(w2, "2026-09-18").sessions[0]!.status).toBe("planned");
});

test("plans: a session done without the watch can be ticked off by hand, and survives a new plan", async () => {
  const plans = new Plans(lib);
  const now = new Date(2026, 8, 16, 12);
  await expect(plans.mark("2026-09-18", "strength", true, now)).rejects.toThrow(/today's and earlier/);
  await expect(plans.mark("2026-09-09", "rest", true, now)).rejects.toThrow(/not a session kind/);
  await plans.mark("2026-09-09", "tempo", true, now);
  await plans.save(PLAN, { conversation: "c3" }); // the coach rewrites the plan
  let v = await plans.view(now);
  const tempo = v.weeks[0]!.days.find((d) => d.date === "2026-09-09")!.sessions[0]!;
  expect(tempo).toMatchObject({ status: "done", manual: true });
  expect(tempo.activity).toBeUndefined();
  expect(v.weeks[0]!.done).toMatchObject({ sessions: 3, minutes: expect.any(Number) });
  await plans.mark("2026-09-09", "tempo", false, now);
  v = await plans.view(now);
  expect(v.weeks[0]!.days.find((d) => d.date === "2026-09-09")!.sessions[0]!.status).toBe("missed");
});

test("plans: a target date must fall in the last week", async () => {
  const plans = new Plans(new Library(new NodeDisk(mkdtempSync(join(tmpdir(), "tartan-target-")))));
  const m = mondayOf(today());
  const day = (n: number) => new Date(Date.parse(`${m}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const two = { ...PLAN, weeks: [{ start: m, focus: "Build", sessions: [] }, { start: day(7), focus: "Race", sessions: [{ date: day(12), kind: "race" as const, title: "Race" }] }] };
  await expect(plans.save({ ...two, target_date: day(20) })).rejects.toThrow(/plan through that week/);
  await expect(plans.save({ ...two, target_date: "2020-01-01" })).rejects.toThrow(/in the past/);
  const saved = await plans.save({ ...two, target_date: day(12), zones: [{ name: "Easy", pace: "5:40-6:10 /km", heart_rate: "130-145 bpm" }] });
  expect(saved).toMatchObject({ target_date: day(12), zones: [{ name: "Easy" }] });
});

test("week view: day by day against the week before", async () => {
  const w = await new Analytics(lib).week("2026-09-09");
  expect(w).toMatchObject({ start: "2026-09-07", end: "2026-09-13", current: false, prev: "2026-08-31", next: "2026-09-14" });
  expect(w.totals).toMatchObject({ km: 54, workouts: 3 });
  expect(w.previous).toMatchObject({ km: 10, workouts: 1 });
  expect(w.days.map((d) => d.km)).toEqual([8, 0, 0, 30, 0, 0, 16]);
  expect(w.sports.map((s) => s.sport).sort()).toEqual(["ride", "run"]);
  // Never past this week.
  expect((await new Analytics(lib).week("2099-01-01")).current).toBe(true);
});

test("available time: saved apart from the targets form", async () => {
  const an = new Analytics(lib);
  await an.saveAvailability({ days_per_week: 4, hours_per_week: 5.2, long_run_day: "Sun", notes: " no Thursdays " });
  await an.saveGoals({ weekly_km: 30 });
  expect((await an.goals()).availability).toEqual({ days_per_week: 4, hours_per_week: 5, long_run_day: "Sun", notes: "no Thursdays" });
  await an.saveAvailability({ days_per_week: 9 } as never);
  expect((await an.goals()).availability).toBeUndefined();
});

// ------------------------------------------------------------------ the coach writes the plan

const requests: any[] = [];
let server: ReturnType<typeof Bun.serve>;
const sse = (events: object[]) => new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const start = (id: string) => ({ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
const end = (stop: string) => [{ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" }];

beforeAll(() => {
  const monday = mondayOf(today());
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      requests.push(body);
      const last = body.messages.at(-1);
      if (!last.content.some((b: any) => b.type === "tool_result")) {
        const plan = { title: "Next four weeks", summary: "Steady build.", weeks: [{ start: monday, focus: "Build", sessions: [{ date: monday, kind: "easy", title: "Easy run", duration_min: 40 }] }] };
        return sse([
          start("m1"),
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "save_training_plan", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(plan) } },
          { type: "content_block_stop", index: 0 },
          ...end("tool_use"),
        ]);
      }
      return sse([
        start("m2"),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Your plan is ready." } },
        { type: "content_block_stop", index: 0 },
        ...end("end_turn"),
      ]);
    },
  });
});
afterAll(() => server?.stop(true));

test("coach: Update plan writes the plan in a fresh conversation, with the dates and time it was given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tartan-plan-coach-"));
  const l = new Library(new NodeDisk(dir));
  await new Analytics(l).saveAvailability({ days_per_week: 3, hours_per_week: 4 });
  const coach = new Coach(l, { baseURL: server.url.toString().replace(/\/$/, "") });
  await coach.saveSettings({ apiKey: "sk-test" });
  const ev: CoachEvent[] = [];
  for await (const e of coach.updatePlan("Knee is fine again, give me 11 weeks", "end of next month")) ev.push(e);
  expect(ev.map((e) => e.type)).toEqual(["conversation", "by", "tool", "text", "plan", "done"]);
  expect(ev[1]).toEqual({ type: "by", label: "Claude Opus 5.5" });
  expect(ev[2]).toMatchObject({ name: "save_training_plan", label: "Writing your plan" });

  const plan = (await new Plans(l).current())!;
  const conv = (ev[0] as { id: string; title: string });
  expect(plan).toMatchObject({ title: "Next four weeks", conversation: conv.id, model: "claude-opus-5-5" });
  expect(conv.title).toStartWith("Training plan, ");

  // The model got the dates and the time; the conversation shows only what was asked.
  const sent = requests[0].messages[0].content.map((b: any) => b.text).join("\n");
  expect(sent).toContain(`week of Monday ${mondayOf(today())}`);
  expect(sent).toContain("3 days and about 4 hours a week");
  expect(sent).toContain("Knee is fine again");
  expect(sent).toContain('Plan up to my target date: "end of next month"');
  expect(sent).toContain("Lengths mentioned in my message below don't change this");
  expect(sent).toContain("don't ask questions now");

  // Without a length and without a race: about two months.
  requests.length = 0;
  for await (const _ of coach.updatePlan()) void _;
  expect(requests[0].messages[0].content.map((b: any) => b.text).join("\n")).toContain("Plan exactly 8 weeks");
  expect(requests[0].tools.map((t: any) => t.name)).toContain("save_training_plan");
  expect((await coach.conversation(conv.id))!.display[0]).toEqual({ role: "user", text: "Knee is fine again, give me 11 weeks" });
});

test("MCP: an outside agent reads, writes, exports, ticks off and resets the same plan", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createMcpServer } = await import("../src/mcp.ts");
  const l = new Library(new NodeDisk(mkdtempSync(join(tmpdir(), "tartan-plan-mcp-"))));
  const server = createMcpServer({ library: l, allowSync: false });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    if (r.isError) throw new Error(r.content[0]!.text);
    return JSON.parse(r.content[0]!.text);
  };

  const tools = (await client.listTools()).tools;
  expect(tools.find((t) => t.name === "reset_training_plan")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  expect(tools.find((t) => t.name === "save_training_plan")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("training_plan");
  const prompt = await client.getPrompt({ name: "training_plan", arguments: { target: "end of March" } });
  expect((prompt.messages[0]!.content as { text: string }).text).toContain('Plan up to "end of March"');

  const m = mondayOf(today());
  expect(await call("save_training_plan", { title: "From an agent", summary: "x", weeks: [{ start: m, focus: "Build", sessions: [{ date: today(), kind: "easy", title: "Easy, 40'", duration_min: 40, notes: 'say "hi", then go' }] }] })).toMatchObject({ saved: true, weeks: 1 });
  expect((await call("get_training_plan")).plan).toMatchObject({ title: "From an agent", model: "an MCP agent" });
  await call("mark_plan_session", { date: today(), kind: "easy" });
  expect((await call("get_training_plan")).weeks[0].days.find((d: any) => d.date === today()).sessions[0]).toMatchObject({ status: "done", manual: true });

  const { csv } = await call("export_training_plan_csv");
  const [head, row] = csv.trim().split("\n");
  expect(head).toBe("week,week_start,week_focus,date,weekday,kind,title,duration_min,distance_km,target,notes,status,done_with,done_km,done_min");
  expect(row).toContain(`1,${m},Build,${today()}`);
  expect(row).toContain('"say ""hi"", then go",done,marked by hand');

  await call("set_training_availability", { days_per_week: 4, long_run_day: "Sun" });
  expect((await call("get_goals")).goals.availability).toMatchObject({ days_per_week: 4, long_run_day: "Sun" });
  expect(await call("reset_training_plan")).toEqual({ cleared: true });
  expect((await call("get_training_plan")).plan).toBeNull();
});

// ------------------------------------------------------------------ readiness and swaps

import { readiness } from "../src/readiness.ts";

test("readiness: form and the morning check-in", () => {
  expect(readiness(0, null)).toEqual({ level: "ready", reasons: [], form: 0 });
  expect(readiness(-35, null)).toMatchObject({ level: "go easy", reasons: ["fatigue well above fitness"] });
  expect(readiness(-20, { date: "2026-10-18", sleep: 1, legs: 2 })).toMatchObject({ level: "go easy", reasons: ["carrying some fatigue", "slept badly"] });
  expect(readiness(-35, { date: "2026-10-18", sleep: 1, legs: 1 })).toMatchObject({ level: "rest" });
  // One bad night alone: still ready.
  expect(readiness(0, { date: "2026-10-18", sleep: 1, legs: 2 }).level).toBe("ready");
  expect(readiness(-20, { date: "2026-10-18", sleep: 3, legs: 3 }).level).toBe("ready");
});

test("plans: a hard session swapped for an easy run on a bad day, and back", async () => {
  const plans = new Plans(lib);
  const now = new Date(2026, 8, 16, 12);
  await plans.swap("2026-09-16", "intervals", "slept badly, heavy legs");
  await plans.save(PLAN, { conversation: "c4" }); // survives the coach rewriting the plan
  let v = await plans.view(now);
  const today = v.weeks[1]!.days.find((d) => d.date === "2026-09-16")!.sessions[0]!;
  expect(today).toMatchObject({ kind: "easy", title: "Easy run", duration_min: 45, swapped_from: "6 × 800 m", swap_kind: "intervals", status: "today" });
  expect(today.notes).toBe("Swapped from 6 × 800 m: slept badly, heavy legs.");
  await expect(plans.swap("2026-09-16", "tempo", "x")).rejects.toThrow(/no such session/);
  await plans.swap("2026-09-16", "intervals", "", true);
  v = await plans.view(now);
  expect(v.weeks[1]!.days.find((d) => d.date === "2026-09-16")!.sessions[0]).toMatchObject({ kind: "intervals", title: "6 × 800 m" });
});
