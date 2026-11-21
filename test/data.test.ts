/**
 * Strava sync (against a mock Strava API), FIT parsing, the library and the MCP server
 * over both an in-memory client and real HTTP.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDisk } from "../src/disk-node.ts";
import { parseFit } from "../src/fit.ts";
import { durability } from "../src/durability.ts";
import { Library } from "../src/library.ts";
import { createMcpServer } from "../src/mcp.ts";
import { startServer } from "../src/server.ts";
import { LocalStore } from "../src/store.ts";
import { StravaStore, syncStrava } from "../src/strava/sync.ts";
import { Weather } from "../src/weather.ts";
import { encodeFit } from "./sim/fit-fixture.ts";
import { startMockStrava } from "./sim/mock-strava.ts";


test("FIT decoder: session, sport and records", () => {
  const fit = parseFit(encodeFit());
  expect(fit.sport).toBe("running");
  expect(fit.session).toMatchObject({ total_distance: 5000, avg_heart_rate: 150, max_heart_rate: 178, total_ascent: 85, total_timer_time: 1750 });
  expect(fit.startTime).toBe(new Date((1_100_000_000 + 631065600) * 1000).toISOString());
  expect(fit.records).toHaveLength(3);
  expect(fit.records[1]).toMatchObject({ heartRate: 141, altitude: 20, distance: 30 });
  expect(fit.records[0]!.lat).toBeCloseTo(60.17, 4);
});

// ------------------------------------------------------------------ Strava + library + MCP

let mock: ReturnType<typeof startMockStrava>;
let root: string;

beforeAll(async () => {
  mock = startMockStrava({ activities: 40, shortLimit: 30, expireTokens: true });
  root = mkdtempSync(join(tmpdir(), "tartan-data-"));
  process.env.STRAVA_API_BASE = `${mock.url}/api/v3`;
  process.env.STRAVA_OAUTH_BASE = `${mock.url}/oauth`;
});
afterAll(() => mock.stop());

describe("Strava", () => {
  test("OAuth, incremental sync, refresh, and pausing at the rate limit", async () => {
    const store = new StravaStore(new NodeDisk(root));
    await store.writeSecret({ clientId: "cid", clientSecret: "secret" }, "config.json");
    const client = (await store.client())!;
    expect(client.authorizeUrl("http://localhost:5173/api/strava/callback", "s")).toContain("scope=read%2Cactivity%3Aread_all");
    await expect(client.exchangeCode("bad")).rejects.toThrow(/400/);
    await client.exchangeCode("good-code");
    expect(await store.read("tokens.json")).toMatchObject({ refresh_token: "ref-1" });

    // Window allows 30 requests: athlete + stats + 1 list page + ~13 activities × 2 → pauses.
    const first = await syncStrava(client, store);
    expect(first.total).toBe(40);
    expect(first.added).toBe(40);
    expect(first.stoppedForRateLimit).toBe(true);
    expect(first.detailed).toBeGreaterThan(5);
    expect(first.pendingDetails).toBe(40 - first.detailed);
    expect(mock.counts.refresh).toBeGreaterThan(0); // tokens expire immediately in the mock

    // Next window: a fresh client (as the next CLI run would be) picks up where it stopped.
    let done = first.detailed;
    for (let i = 0; i < 5 && done < 40; i++) {
      mock.resetWindow();
      const again = await syncStrava((await store.client())!, store);
      expect(again.added).toBe(0);
      done += again.detailed;
    }
    expect(done).toBe(40);
    expect((await store.ids("streams")).size).toBe(40);

    // A new workout appears on Strava → only it is added.
    mock.resetWindow();
    mock.addActivity({ ...mock.activities[0]!, id: 9999, name: "Fresh run", start_date: "2026-12-30T07:00:00Z", start_date_local: "2026-12-30T09:00:00" });
    const inc = await syncStrava((await store.client())!, store);
    expect(inc).toMatchObject({ added: 1, total: 41, detailed: 1, pendingDetails: 0 });
  }, 30_000);
});

describe("library + MCP", () => {
  beforeAll(async () => {
    // A FIT file copied off the watch + a cloud export duplicate of a Strava workout.
    const local = new LocalStore(new NodeDisk(root));
    await local.saveInfo("Suunto Run 2 0042", { name: "Suunto Run 2 0042" });
    await local.sink("Suunto Run 2 0042").put("/logs/run.fit", encodeFit());
    const s = new Date(Date.parse("2026-01-05T06:00:00Z") + 30_000).getTime();
    await local.disk.write(local.cloudPath("workouts.json"), JSON.stringify([{ workoutKey: "abc", activityId: 1, startTime: s, totalTime: 2700, totalDistance: 8000 }]));
  });

  test("library merges copies of the same workout", async () => {
    const lib = new Library(new NodeDisk(root));
    const all = await lib.activities({ limit: 1000 });
    expect(all).toHaveLength(42); // 41 Strava + 1 watch-only FIT; the cloud copy merged into strava:1000
    const merged = all.find((r) => r.sources.includes("suunto-cloud"))!;
    expect(merged.sources.sort()).toEqual(["strava", "suunto-cloud"]);
    expect((await lib.activity(merged.id)).copies).toHaveLength(2);
    expect((await lib.activity("strava:1000")).id).toBe(merged.id); // source ids resolve to the canonical one
    const watch = all.filter((r) => r.sources.includes("watch"));
    expect(watch).toHaveLength(1);
    expect(watch[0]).toMatchObject({ sport: "running", distance_km: 5, avg_hr: 150, streams_from: "watch" });
    expect(await lib.activities({ source: "suunto-cloud" })).toHaveLength(1);
    const weeks = await lib.summary({ period: "week", since: "2026-01-01", until: "2026-01-31" });
    expect(weeks[0]).toHaveProperty("week");
    expect(weeks.reduce((n, w) => n + (w.activities as number), 0)).toBe(14); // the duplicate is not counted twice
  });

  test("MCP tools over an in-memory client", async () => {
    const server = createMcpServer({ library: new Library(new NodeDisk(root)) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "backup_watch", "export_training_plan_csv", "export_training_plan_ics", "forget_memory", "get_activity", "get_activity_streams", "get_athlete_profile", "get_best_efforts", "get_body", "get_durability", "get_efficiency_trend", "get_goals",
      "get_health", "get_hr_zones", "get_lifts", "get_memory", "get_overview", "get_readiness", "get_route", "get_run_notes", "get_shoes", "get_takeaways", "get_training_load", "get_training_plan", "get_training_summary", "get_training_times", "get_weather", "get_week", "list_activities",
      "list_routes", "list_watch_faces", "list_watch_files", "log_workout", "mark_plan_session", "read_watch_file", "remember", "remove_logged_workout", "reset_training_plan", "review_session", "save_route", "save_training_plan", "save_watch_face", "set_training_availability", "set_training_times", "sync_strava", "update_memory",
    ]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
      if (r.isError) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text);
    };
    const overview = await call("get_overview");
    expect(overview.strava).toMatchObject({ connected: true, activities: 41, with_full_detail: 41 });
    expect(overview.activities.total).toBe(42);
    expect(overview.watches[0]).toMatchObject({ name: "Suunto Run 2 0042", files: 1 });

    const runs = await call("list_activities", { sport: "trail", limit: 3 });
    expect(runs).toHaveLength(3);
    expect(runs.every((r: { sport: string }) => r.sport === "TrailRun")).toBe(true);

    const detail = await call("get_activity", { id: "strava:1003" });
    expect(detail.provenance.name).toBe("strava");
    expect(detail).toMatchObject({ description: "felt good", detail_synced: true });
    expect(detail.laps).toHaveLength(2);
    expect(detail.map).toBeUndefined(); // heavy fields (polyline, segment efforts) are not passed through
    // Each copy carries what its source measured, for the side-by-side Sources view.
    expect(detail.copies).toEqual([expect.objectContaining({ source: "strava", id: "strava:1003", distance_m: 14000, avg_hr: 143, start: "2026-01-11T06:00:00.000Z" })]);

    const streams = await call("get_activity_streams", { id: "strava:1003", keys: ["heartrate"], max_points: 100 });
    expect(streams.original_points).toBe(1500); // a sample every 3 s over its 75 minutes
    expect(streams.streams.heartrate.length).toBeLessThanOrEqual(101);
    expect(Object.keys(streams.streams)).toEqual(["heartrate"]);

    const dur = await call("get_durability", { weeks: 104 });
    expect(Array.isArray(dur.runs)).toBe(true);
    expect(typeof dur.summary).toBe("string");

    const best = await call("get_best_efforts");
    expect(best.map((b: { name: string }) => b.name).sort()).toEqual(["1k", "5k"]);

    const file = await call("read_watch_file", { watch: "Suunto-Run-2-0042", path: "/logs/run.fit" });
    expect(file.kind).toBe("FIT activity file");
    const watchStreams = await call("get_activity_streams", { id: "watch:Suunto-Run-2-0042/logs/run.fit" });
    expect(watchStreams.from).toBe("watch");
    expect(watchStreams.streams.heartrate).toEqual([140, 141, 142]);
    expect(watchStreams.streams.time).toEqual([0, 10, 20]);

    const err = (await client.callTool({ name: "get_activity", arguments: { id: "nope" } })) as { isError?: boolean };
    expect(err.isError).toBe(true);

    mock.resetWindow();
    const sync = await call("sync_strava");
    expect(sync).toMatchObject({ total: 41, added: 0 });
    await client.close();
  });

  test("MCP over HTTP at /mcp, and the cross-origin guard", async () => {
    const http = await startServer({ port: 0, store: new LocalStore(new NodeDisk(root)), quiet: true });
    try {
      const client = new Client({ name: "http-test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}mcp`)));
      const r = (await client.callTool({ name: "list_activities", arguments: { limit: 2 } })) as { content: Array<{ text: string }> };
      expect(JSON.parse(r.content[0]!.text)).toHaveLength(2);
      await client.close();

      const evil = await fetch(`${http.url}mcp`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
      expect(evil.status).toBe(403);
      const status = await (await fetch(`${http.url}api/strava/status`)).json();
      expect(status).toMatchObject({ configured: true, connected: true, activities: 41 });
    } finally {
      http.stop(true);
    }
  });

  test("LAN mode: only this computer may use the API; other devices go through the encrypted link", async () => {
    const http = await startServer({ port: 0, store: new LocalStore(new NodeDisk(root)), quiet: true, lan: true, hostname: "127.0.0.1" });
    try {
      const info = (await (await fetch(`${http.url}api/server`)).json()) as Record<string, unknown>;
      expect(info.lan).toBe(true);
      expect(info).not.toHaveProperty("token");
      const url = `${http.url}api/watches/Phone-Watch/file?path=/logs/a.bin`;
      // A web page on another origin is refused, even with the old pairing-token header.
      const cross = await fetch(url, { method: "PUT", headers: { origin: "http://localhost", "x-freesuunto-token": "anything" }, body: "x" });
      expect(cross.status).toBe(403);
      // DNS rebinding: a foreign name pointing at this computer.
      const rebound = await fetch(`${http.url}api/library/overview`, { headers: { host: `evil.example:${new URL(http.url).port}` } });
      expect(rebound.status).toBe(421);
      const wrongPort = await fetch(`${http.url}api/library/overview`, { headers: { host: "localhost:1" } });
      expect(wrongPort.status).toBe(421);
      // This computer itself, same origin: fine.
      const ok = await fetch(url, { method: "PUT", body: "x" });
      expect(ok.status).toBe(204);
    } finally {
      http.stop(true);
    }
  });

  test("weather: what a past run was run in, asked once, where it started; the long runs' summary says when heat explains drift", async () => {
    const lib = new Library(new NodeDisk(root));
    const urls: string[] = [];
    const weather = new Weather(lib, async (u) => {
      urls.push(u);
      const day = new URL(u).searchParams.get("start_date")!;
      const time = Array.from({ length: 24 }, (_, h) => `${day}T${String(h).padStart(2, "0")}:00`);
      return Response.json({ hourly: { time, temperature_2m: time.map((_, h) => 10 + h), dew_point_2m: time.map(() => 18) } });
    });
    const run = (await lib.activities({ sport: "run" })).find((r) => r.streams_from)!;
    const was = (await weather.run(run.id))!;
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("historical-forecast-api.open-meteo.com");
    expect(urls[0]).toMatch(/latitude=60\.1\d?&longitude=24\.9\d?/); // to about a kilometre
    // The hour in the middle of the run, in UTC.
    const mid = new Date(Date.parse(run.start) + ((run.elapsed_min ?? run.moving_min ?? 0) * 60_000) / 2);
    expect(was.time).toBe(`${mid.toISOString().slice(0, 13)}:00`);
    expect(was.temp_c).toBe(10 + mid.getUTCHours());
    expect(await weather.run(run.id)).toEqual(was);
    expect(urls).toHaveLength(1);
    const d = await durability(lib, 104, Date.parse("2026-12-31"), weather);
    expect(d.runs.find((r) => r.weather)).toBeDefined();
  });
});
