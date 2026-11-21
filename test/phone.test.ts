/**
 * The Android app runs Tartan in-process (web/local-api.ts). Here that same backend runs on
 * in-memory storage against the mock Strava: connect (surviving the page reload Strava's
 * consent page causes), sync, dashboards, watch backups. No PC involved.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { MemoryDisk } from "../src/disk.ts";
import { LocalApiBackend } from "../web/local-api.ts";
import { startMockStrava } from "./sim/mock-strava.ts";

let mock: ReturnType<typeof startMockStrava>;

beforeAll(() => {
  mock = startMockStrava({ activities: 12 });
  process.env.STRAVA_API_BASE = `${mock.url}/api/v3`;
  process.env.STRAVA_OAUTH_BASE = `${mock.url}/oauth`;
  // The app's page, as the Android WebView serves it.
  (globalThis as { location?: unknown }).location = new URL("http://localhost/");
});
afterAll(() => {
  mock.stop();
  delete process.env.STRAVA_API_BASE;
  delete process.env.STRAVA_OAUTH_BASE;
});

async function ndjson(res: Response): Promise<Array<Record<string, unknown>>> {
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("phone: Strava connect across a reload, sync, dashboards and watch backups, all on the device", async () => {
  const disk = new MemoryDisk();
  const app = new LocalApiBackend(disk);

  // Connect: the authorize URL sends Strava back to the app's own page.
  const { authorizeUrl } = await app.json<{ authorizeUrl: string }>("/api/strava/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "cid", clientSecret: "secret" }),
  });
  expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe("http://localhost/");
  const consent = await fetch(authorizeUrl, { redirect: "manual" });
  const back = new URL(consent.headers.get("location")!);
  expect(back.origin + back.pathname).toBe("http://localhost/");

  // The WebView left for strava.com and came back: a fresh page, so a fresh backend on the same storage.
  const reloaded = new LocalApiBackend(disk);
  const exchange = await reloaded.request("/api/strava/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: back.searchParams.get("state"), code: back.searchParams.get("code") }),
  });
  expect(exchange.status).toBe(204);
  // A state is good once.
  const replay = await reloaded.request("/api/strava/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: back.searchParams.get("state"), code: "good-code" }),
  });
  expect(replay.status).toBe(500);
  expect(((await replay.json()) as { error: string }).error).toContain("stale");

  const status = await reloaded.json<{ connected: boolean; athlete: { firstname: string } }>("/api/strava/status");
  expect(status.connected).toBe(true);
  expect(status.athlete.firstname).toBe("Test");

  // Sync and read it all back through the same routes the screens use.
  const sync = await ndjson(await reloaded.request("/api/strava/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  expect(sync.at(-1)).toMatchObject({ done: { total: 12, added: 12, pendingDetails: 0 } });
  const activities = await reloaded.json<Array<{ id: string; sources: string[] }>>("/api/library/activities?limit=100");
  expect(activities).toHaveLength(12);
  const dash = await reloaded.json<{ takeaways: unknown[] }>("/api/dashboard?days=400");
  expect(Array.isArray(dash.takeaways)).toBe(true);
  const view = await reloaded.json<{ streams?: unknown }>(`/api/activity/${encodeURIComponent(activities[0]!.id)}`);
  expect(view).toBeTruthy();

  // Watch backups land in the phone's storage, in the layout the PC uses.
  const sink = reloaded.sink("Suunto Run 2 0042");
  expect(await sink.has("/logs/a.bin")).toBe(false);
  await sink.put("/logs/a.bin", new Uint8Array([1, 2, 3]));
  expect(await sink.has("/logs/a.bin")).toBe(true);
  expect([...disk.files.keys()]).toContain("watches/Suunto-Run-2-0042/files/logs/a.bin");
  const watches = await reloaded.watches();
  expect(watches[0]).toMatchObject({ id: "Suunto-Run-2-0042", files: 1, bytes: 3 });
  expect(Array.from(await reloaded.readFile("Suunto-Run-2-0042", "/logs/a.bin"))).toEqual([1, 2, 3]);
  await reloaded.logEvent({ lane: "watch", kind: "backup", added: 1, ok: true });
  expect((await reloaded.events(1)).map((e) => e.lane)).toEqual(expect.arrayContaining(["strava", "watch"]));

  // The coach is there too (it needs the user's key), and PC-only routes are not.
  expect(await reloaded.json("/api/coach/status")).toMatchObject({ ready: false });
  expect((await reloaded.request("/api/server")).status).toBe(404);
  expect((await reloaded.request("/api/watches/x/file?path=/../../strava/tokens.json")).status).toBe(400);
});

test("phone app: Strava's mobile consent (Strava app or browser tab) returns through tartan://", async () => {
  const disk = new MemoryDisk();
  const app = new LocalApiBackend(disk, true);
  const { authorizeUrl } = await app.json<{ authorizeUrl: string }>("/api/strava/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "cid", clientSecret: "secret" }),
  });
  const consent = new URL(authorizeUrl);
  expect(consent.pathname).toBe("/oauth/mobile/authorize");
  expect(consent.searchParams.get("redirect_uri")).toBe("tartan://localhost/strava");
  const back = new URL((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!);
  expect(back.protocol).toBe("tartan:");
  // Android may have killed the app while the Strava app was open: a fresh backend, same storage.
  const res = await new LocalApiBackend(disk, true).request("/api/strava/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: back.searchParams.get("state"), code: back.searchParams.get("code") }),
  });
  expect(res.status).toBe(204);
  expect(await app.json("/api/strava/status")).toMatchObject({ connected: true });
});

test("phone: dashboards don't re-read every workout's time series on each open", async () => {
  const mem = new MemoryDisk();
  const app = new LocalApiBackend(mem);
  const { authorizeUrl } = await app.json<{ authorizeUrl: string }>("/api/strava/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "cid", clientSecret: "secret" }) });
  const back = new URL((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!);
  await app.request("/api/strava/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: back.searchParams.get("state"), code: "good-code" }) });
  for (const a of mock.activities) a.start_date = new Date(Date.now() - (a.id - 999) * 2 * 86400_000).toISOString();
  await (await app.request("/api/strava/sync", { method: "POST", body: "{}" })).text();

  // Zones from the cached histograms match zones counted straight from the time series.
  const { Analytics } = await import("../src/analytics.ts");
  const { Library } = await import("../src/library.ts");
  const an = new Analytics(new Library(mem));
  const [m] = await an.lib.merged();
  const raw = (await an.lib.rawStreams(m!))!.columns as { heartrate: number[]; time: number[] };
  const max = (await an.profile()).max_hr;
  const direct = [0, 0, 0, 0, 0];
  const bounds = [0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  for (let i = 1; i < raw.heartrate.length; i++) {
    const dt = raw.time[i]! - raw.time[i - 1]!;
    const f = raw.heartrate[i]! / max;
    const z = bounds.findIndex((b, j) => j < 5 && f >= b && f < bounds[j + 1]!);
    if (dt > 0 && dt <= 30 && z >= 0) direct[z]! += dt;
  }
  expect((await an.zonesFor(m!.id))!.map((z) => z.seconds)).toEqual(direct.map(Math.round));

  // First dashboard builds the caches; after an app restart the next one barely reads anything.
  await app.json("/api/dashboard?days=90");
  let reads = 0;
  const counting = Object.assign(Object.create(mem) as MemoryDisk, {
    read: (p: string) => (reads++, mem.read(p)),
    readText: (p: string) => (reads++, mem.readText(p)),
  });
  const restarted = new LocalApiBackend(counting);
  await restarted.json("/api/dashboard?days=90");
  expect(reads).toBeLessThan(15);
});

test("today: readiness in words, the last workout's effort, and this week; no long-term takeaways", async () => {
  const mem = new MemoryDisk();
  const app = new LocalApiBackend(mem);
  const { authorizeUrl } = await app.json<{ authorizeUrl: string }>("/api/strava/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "cid", clientSecret: "secret" }) });
  const back = new URL((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!);
  await app.request("/api/strava/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: back.searchParams.get("state"), code: "good-code" }) });
  for (const a of mock.activities) a.start_date = new Date(Date.now() - (a.id - 999) * 2 * 86400_000).toISOString();
  await (await app.request("/api/strava/sync", { method: "POST", body: "{}" })).text();

  type Today = {
    readiness: { state: string; title: string; advice: string; why: string; fitness: number; fatigue: number; form: number };
    last: { activity: { id: string }; effort: number; label: string; rank: string; zones: unknown[] | null };
    week: { days: unknown[]; km: number; usual_km: number };
    takeaways: Array<{ id: string; horizon: string }>;
    mark: { state: string; label: string };
  };
  const t = await app.json<Today>("/api/today");
  // Tartan's T in the header: no plan here, so nothing planned (or a best, a tired day).
  expect(["rest", "best", "tired"]).toContain(t.mark.state);
  expect(t.mark.label.length).toBeGreaterThan(3);
  expect(["new", "tired", "building", "steady", "fresh", "rested"]).toContain(t.readiness.state);
  expect(t.readiness.why).toMatch(/in the last 7 days/);
  expect(t.last.effort).toBeGreaterThan(0);
  expect(["Light", "Moderate", "Hard", "Very hard"]).toContain(t.last.label);
  expect(t.last.zones).not.toBeNull();
  expect(t.week.days).toHaveLength(7);
  expect(t.takeaways.every((x) => x.horizon === "now" && x.id !== "form")).toBe(true);
  const d = await app.json<{ takeaways: Array<{ horizon: string }> }>("/api/dashboard?days=84");
  expect(d.takeaways.every((x) => x.horizon === "now" || x.horizon === "trend")).toBe(true);
});

test("targets: saved, tracked this week, and a race prediction from this year's best efforts", async () => {
  const mem = new MemoryDisk();
  const app = new LocalApiBackend(mem);
  const { authorizeUrl } = await app.json<{ authorizeUrl: string }>("/api/strava/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "cid", clientSecret: "secret" }) });
  const back = new URL((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!);
  await app.request("/api/strava/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: back.searchParams.get("state"), code: "good-code" }) });
  for (const a of mock.activities) a.start_date = new Date(Date.now() - (a.id - 999) * 2 * 86400_000).toISOString();
  await (await app.request("/api/strava/sync", { method: "POST", body: "{}" })).text();

  type T = {
    goals: { weekly_km?: number; race?: { distance_km: number } };
    week: { target_km: number; km: number; hit: number; of_weeks: number } | null;
    long_run: { target_km: number; longest_km: number } | null;
    race: { days_to_go: number; predicted_s: number; from: { name: string }; target_pace: string; on_track: boolean } | null;
  };
  expect((await app.json<T>("/api/goals")).week).toBeNull();
  const date = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const saved = await app.json<T>("/api/goals", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ weekly_km: 30, long_run_km: 16, weekly_workouts: -2, race: { name: "Autumn 10k", distance_km: 10, date, target_s: 3000 } }),
  });
  expect(saved.goals.weekly_km).toBe(30);
  expect(saved.week!.target_km).toBe(30);
  expect(saved.week!.of_weeks).toBe(12);
  expect(saved.long_run!.target_km).toBe(16);
  expect(saved.race!.days_to_go).toBe(30);
  expect(saved.race!.target_pace).toBe("5:00");
  expect(saved.race!.from.name).toBe("5k");
  // Riegel from a ~26:40 5k: a 10k a little over 55 minutes.
  expect(saved.race!.predicted_s).toBeGreaterThan(3300);
  expect(saved.race!.predicted_s).toBeLessThan(3500);
  expect(saved.race!.on_track).toBe(false);
  // Today and Progress carry the same progress.
  expect((await app.json<{ targets: T }>("/api/today")).targets.week!.target_km).toBe(30);
  expect((await app.json<{ targets: T }>("/api/dashboard?days=84")).targets.race!.predicted_s).toBe(saved.race!.predicted_s);
});

test("record a run on the phone, upload it to Strava, and it stays one workout", async () => {
  const mem = new MemoryDisk();
  const app = new LocalApiBackend(mem);
  const { authorizeUrl } = await app.json<{ authorizeUrl: string }>("/api/strava/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "cid", clientSecret: "secret" }) });
  expect(new URL(authorizeUrl).searchParams.get("scope")).toContain("activity:write");
  const back = new URL((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!);
  await app.request("/api/strava/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: back.searchParams.get("state"), code: "good-code", scope: back.searchParams.get("scope") }) });
  expect(await app.json("/api/strava/status")).toMatchObject({ connected: true, can_upload: true });

  // 3 km due north in 15 minutes, one fix every 3 s, a 2-minute pause in the middle, one bad fix.
  const t0 = Date.parse("2026-10-10T07:00:00Z");
  const points: Array<{ t: number; lat: number; lon: number; alt: number; acc: number; hr?: number }> = [];
  for (let i = 0; i <= 300; i++) points.push({ t: t0 + i * 3000 + (i > 150 ? 120_000 : 0), lat: 60 + (i * 10) / 111_195, lon: 25, alt: 20 + (i % 20), acc: 6, hr: 140 + (i % 10) });
  points.splice(100, 0, { t: t0 + 100 * 3000 + 1500, lat: 60.5, lon: 25.5, alt: 20, acc: 5 }); // a GPS jump
  points.splice(50, 0, { t: t0 + 50 * 3000 + 1000, lat: 60.01, lon: 25, alt: 20, acc: 80 }); // too vague
  const rec = {
    id: "rec-test-1", sport: "Run", name: "Morning test run", start: new Date(t0).toISOString(), end: new Date(t0 + 300 * 3000 + 120_000).toISOString(),
    points, pauses: [{ from: t0 + 150 * 3000 + 1, to: t0 + 150 * 3000 + 120_000 }],
  };
  expect((await app.request(`/api/recordings/${rec.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(rec) })).status).toBe(204);
  const { summary } = await app.json<{ summary: { distance_m: number; moving_s: number; elapsed_s: number; avg_hr: number } }>(`/api/recordings/${rec.id}`);
  expect(Math.abs(summary.distance_m - 3000)).toBeLessThan(15);
  expect(summary.moving_s).toBe(900);
  expect(summary.elapsed_s).toBe(1020);
  expect(summary.avg_hr).toBeGreaterThan(140);

  // In the library before upload: one phone workout with its own time series.
  let list = await app.json<Array<{ id: string; sources: string[]; distance_km: number }>>("/api/library/activities?limit=100");
  const mine = list.find((a) => a.sources.includes("phone"))!;
  expect(mine.distance_km).toBeCloseTo(3, 1);

  const up = await app.json<{ status: string; activity_id: number }>(`/api/recordings/${rec.id}/upload`, { method: "POST" });
  expect(up.status).toBe("done");
  const tcx = mock.uploads.at(-1)!.tcx!;
  expect(tcx).toContain('<Activity Sport="Running">');
  expect(tcx).toContain("<HeartRateBpm>");
  expect(tcx.match(/<Trackpoint>/g)!.length).toBe(301);

  // Strava's copy comes back with the next sync and merges with the phone's: still one workout.
  await (await app.request("/api/strava/sync", { method: "POST", body: "{}" })).text();
  list = await app.json("/api/library/activities?limit=1000");
  const merged = list.filter((a) => a.sources.includes("phone"));
  expect(merged).toHaveLength(1);
  expect(merged[0]!.sources.sort()).toEqual(["phone", "strava"]);
  expect(merged[0]!.id).toBe(mine.id);

  // Uploading again is a no-op; a second upload of the same file reads as a duplicate, not an error.
  expect((await app.json<{ activity_id: number }>(`/api/recordings/${rec.id}/upload`, { method: "POST" })).activity_id).toBe(up.activity_id);
});

test("Health Connect: workouts out once (none another app has), the watch's log, sleep back in", async () => {
  const mem = new MemoryDisk();
  const app = new LocalApiBackend(mem);
  const { authorizeUrl } = await app.json<{ authorizeUrl: string }>("/api/strava/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "cid", clientSecret: "secret" }) });
  const back = new URL((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!);
  await app.request("/api/strava/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: back.searchParams.get("state"), code: "good-code" }) });
  for (const a of mock.activities) a.start_date = new Date(Date.now() - (a.id - 999) * 2 * 86400_000).toISOString();
  await (await app.request("/api/strava/sync", { method: "POST", body: "{}" })).text();
  const rows = await app.json<Array<{ id: string; start: string; elapsed_min?: number }>>("/api/library/activities?limit=100");
  const recent = rows.filter((r) => Date.parse(r.start) > Date.now() - 30 * 86400_000);
  // The watch's log, as a sync saves it.
  // Yesterday 03:00-04:00: half an hour still (a resting heart rate), then walking.
  const y = new Date(Date.now() - 86400_000);
  const t0 = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 3).getTime();
  const log = Array.from({ length: 6 }, (_, i) => ({ t: t0 + i * 600_000, steps: i < 3 ? 0 : 100, energy_j: i < 3 ? 0 : 8368, hr: 60 + i, ...(i === 2 ? { spo2: 96 } : {}) }));
  await mem.write(`watches/suunto-run-2/files/daily/trends/${t0}.json`, new TextEncoder().encode(JSON.stringify(log)));
  await mem.write("watches/suunto-run-2/info.json", JSON.stringify({ name: "Suunto Run 2" }));

  const post = (body: object) => app.json<{ records: Array<{ type: string; id: string }>; sent: Record<string, string>; covered: number; trends_last: number }>("/api/health-connect/out", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // One of the workouts is already there from another app.
  const other = recent[0]!;
  const os = Date.parse(other.start);
  const first = await post({ since: Date.now() - 30 * 86400_000, sent: {}, trends_after: 0, others: [{ start: os, end: os + (other.elapsed_min ?? 1) * 60_000 }] });
  expect(first.covered).toBe(1);
  expect(Object.keys(first.sent).sort()).toEqual(recent.map((r) => r.id).sort());
  const sessions = first.records.filter((r) => r.type === "exercise");
  expect(sessions.length).toBe(recent.length - 1);
  expect(sessions.some((r) => r.id === `tartan-w-${other.id}`)).toBe(false);
  expect(first.records.some((r) => r.id.startsWith("tartan-w-") && r.type === "heartRate")).toBe(true);
  expect(first.records.filter((r) => r.id.startsWith("tartan-t-")).map((r) => r.type).sort()).toEqual(
    ["activeCalories", "activeCalories", "activeCalories", "heartRate", "oxygenSaturation", "restingHeartRate", "steps", "steps", "steps"].sort(),
  );
  expect(first.trends_last).toBe(log.at(-1)!.t);
  // Next time: nothing new.
  const again = await post({ since: Date.now() - 30 * 86400_000, sent: first.sent, trends_after: first.trends_last });
  expect(again.records).toEqual([]);

  // Sleep read from Health Connect shows on the Body card's data.
  const end = Date.now() - 3600_000;
  await app.request("/api/health-connect/in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sleep: [{ id: "s1", start: end - 7 * 3600_000, end, source: "com.stt.android.suunto", stages: [] }], hrv: [[end, 52.3, "com.stt.android.suunto"]] }) });
  const h = await app.json<{ days: Array<{ sleep: { minutes: { asleep: number } } | null; hrv_ms: number | null }> }>("/api/health");
  const withSleep = h.days.find((d) => d.sleep);
  // (Only when the night ended before 6 pm today, local.)
  if (new Date(end).getHours() < 18) expect(withSleep).toMatchObject({ sleep: { minutes: { asleep: 420 } } });
});
