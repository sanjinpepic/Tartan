import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDisk } from "../src/disk.ts";
import { NodeDisk } from "../src/disk-node.ts";
import { findPc, frame, isHomeAddress, pairWith, seal, tunnel, unb64, unseal, type Link } from "../src/link.ts";
import { startServer } from "../src/server.ts";
import { LocalStore } from "../src/store.ts";
import { listFiles, pull, push, readState, reconcile, remote, syncWith } from "../src/transfer.ts";

const pcDisk = new NodeDisk(mkdtempSync(join(tmpdir(), "tartan-pc-")));
const server = await startServer({ port: 0, hostname: "127.0.0.1", lan: true, quiet: true, store: new LocalStore(pcDisk) });
afterAll(() => server.stop(true));
const url = server.url.origin;
const KEY = "sk-ant-api-SECRET-0123456789";
await pcDisk.write("coach/settings.json", JSON.stringify({ apiKey: KEY }), { secret: true });
await pcDisk.write("coach/plan.json", JSON.stringify({ title: "Autumn 10k", updated: "2026-10-19T10:00:00Z", weeks: [] }));
await pcDisk.write("strava/tokens.json", JSON.stringify({ refresh_token: "r" }));
await pcDisk.write("strava/config.json", JSON.stringify({ client_id: "1" }));
await pcDisk.write("cache/best-efforts.json", "{}");
await pcDisk.write("coach/checkins.json", JSON.stringify({ "2026-10-18": { date: "2026-10-18", legs: 2 } }));

/** Long enough that a file written next is newer: Linux stamps files from a clock that only ticks every few ms. */
const later = () => new Promise((r) => setTimeout(r, 30));

/** Every byte that crossed the "network", to look for anything in the clear. */
const wire: string[] = [];
const spy: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.body) wire.push(new TextDecoder("latin1").decode(init.body instanceof Uint8Array ? init.body : new TextEncoder().encode(String(init.body))));
  const res = await fetch(input, init);
  const copy = res.clone();
  wire.push(new TextDecoder("latin1").decode(new Uint8Array(await copy.arrayBuffer())));
  return res;
}, { preconnect: fetch.preconnect });

const start = async () => (await (await fetch(`${url}/api/pair/start`, { method: "POST" })).json()) as { code: string };

let link: Link;
describe("finding the PC", () => {
  test("of its addresses, the one that answers; one that can't be reached doesn't hold it up", async () => {
    const t = Date.now();
    expect(await findPc(["http://10.255.255.1:5173", "http://127.0.0.1:1", url], fetch, 1500)).toBe(url);
    expect(Date.now() - t).toBeLessThan(1500);
  });
  test("none answering: a clear reason within the time, not a spinner", async () => {
    const t = Date.now();
    await expect(findPc(["http://10.255.255.1:5173"], fetch, 600)).rejects.toThrow("Can't reach your PC at 10.255.255.1:5173");
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe("pairing", () => {
  test("a wrong code is refused; five wrong ones close the pairing", async () => {
    const { code } = await start();
    const wrong = code.replace(/^./, (c) => (c === "A" ? "B" : "A"));
    await expect(pairWith(url, wrong, "Phone", spy)).rejects.toThrow("doesn't match");
    for (let i = 0; i < 3; i++) await pairWith(url, wrong, "Phone", spy).catch(() => {});
    await expect(pairWith(url, wrong, "Phone", spy)).rejects.toThrow("too often");
    await expect(pairWith(url, code, "Phone", spy)).rejects.toThrow("No pairing is open");
  });
  test("the right code pairs, whatever its case and dashes", async () => {
    const { code } = await start();
    link = await pairWith(url, code.toLowerCase().replace("-", " "), "Pixel", spy);
    expect(link.device).toBeTruthy();
    expect(unb64(link.key)).toHaveLength(32);
    // Once used, the code is gone.
    await expect(pairWith(url, code, "Pixel", spy)).rejects.toThrow("No pairing is open");
    const devices = (await (await fetch(`${url}/api/link/devices`)).json()) as Array<{ name: string }>;
    expect(devices.map((d) => d.name)).toEqual(["Pixel"]);
  });
});

describe("the encrypted link", () => {
  test("requests and answers go sealed; nothing readable on the wire", async () => {
    const call = tunnel(link, spy);
    const res = await call("/api/transfer/file?path=coach/settings.json");
    expect(await res.text()).toContain(KEY);
    expect(wire.some((w) => w.includes(KEY) || w.includes("settings.json") || w.includes("Autumn"))).toBe(false);
  });
  test("a changed, replayed or unknown message is turned away", async () => {
    const key = unb64(link.key);
    const body = await seal(key, new TextEncoder().encode("x"), link.device);
    const post = (b: Uint8Array, device = link.device) => fetch(`${url}/api/link/tunnel`, { method: "POST", headers: { "x-tartan-device": device }, body: b as BodyInit });
    const flipped = body.slice();
    flipped[20]! ^= 1;
    expect((await post(flipped)).status).toBe(401);
    expect((await post(body, "someone-else")).status).toBe(401);
    // A real request, sent twice.
    const sent: Uint8Array[] = [];
    const keep: typeof fetch = Object.assign(async (i: RequestInfo | URL, init?: RequestInit) => {
      sent.push(init!.body as Uint8Array);
      return fetch(i, init);
    }, { preconnect: fetch.preconnect });
    expect((await tunnel(link, keep)("/api/library/overview")).ok).toBe(true);
    expect((await post(sent[0]!)).status).toBe(409);
    // Sealed before the PC started (a capture replayed after a restart, inside the time window).
    const old = await seal(key, frame({ m: "GET", p: "/api/library/overview", h: {}, ts: Date.now() - 5 * 60_000 }), link.device);
    expect((await post(old)).status).toBe(409);
    // And the reply is only readable with the key.
    await expect(unseal(new Uint8Array(32), body, link.device)).rejects.toThrow();
  });
});

describe("pairing only at home", () => {
  test("private, link-local, .local and bare names pass; the internet doesn't", () => {
    for (const ok of ["http://192.168.1.20:5173", "http://10.0.0.5:5173", "http://172.20.1.1", "http://169.254.3.4", "http://100.101.102.103:5173", "http://[fd12::1]:5173", "http://desk.local:5173", "http://desk:5173", "http://localhost:5173"]) expect(isHomeAddress(ok)).toBe(true);
    for (const no of ["https://evil.example", "http://8.8.8.8", "http://172.32.0.1", "http://192.169.0.1", "http://[2001:db8::1]", "tartan://localhost/pair", "javascript:alert(1)", "not a url"]) expect(isHomeAddress(no)).toBe(false);
  });
  test("findPc never tries an address outside the home network", async () => {
    const tried: string[] = [];
    const f = Object.assign(async (i: RequestInfo | URL) => (tried.push(String(i)), Response.json({ tartan: true })), { preconnect: fetch.preconnect }) as typeof fetch;
    await expect(findPc(["https://evil.example"], f)).rejects.toThrow("home network");
    expect(await findPc(["https://evil.example", "http://192.168.1.20:5173"], f)).toBe("http://192.168.1.20:5173");
    expect(tried.every((t) => t.startsWith("http://192.168.1.20"))).toBe(true);
  });
});

describe("copying and keeping in step", () => {
  test("everything comes over except Strava's sign-in and the caches", async () => {
    const phone = new MemoryDisk();
    const seenProgress: number[] = [];
    const r = await pull(phone, remote(tunnel(link)), (p) => seenProgress.push(p.done));
    const files = (await listFiles(phone)).map((f) => f.path).sort();
    expect(files).toContain("coach/plan.json");
    expect(files).toContain("coach/settings.json");
    expect(files).toContain("strava/config.json");
    expect(files).not.toContain("strava/tokens.json");
    expect(files.some((f) => f.startsWith("cache/") || f.startsWith("link/") || f === "pairing-token.txt")).toBe(false);
    expect(r.files).toBe(files.length);
    expect(seenProgress.at(-1)).toBe(files.length);
    // Again: nothing to copy.
    expect((await pull(phone, remote(tunnel(link)))).files).toBe(0);
  });
  test("lifts and check-ins merge both ways; the newer plan wins", async () => {
    const phone = new MemoryDisk();
    await pull(phone, remote(tunnel(link)));
    await phone.write("strength/log.json", JSON.stringify({ "2026-10-19": { date: "2026-10-19", started: "2026-10-19T16:00:00Z", exercises: [] } }));
    await later();
    await phone.write("coach/plan.json", JSON.stringify({ title: "Autumn 10k, changed on the phone", updated: "2026-10-19T12:00:00Z", weeks: [] }));
    expect(await syncWith(phone, remote(tunnel(link)))).toBe(false);
    const pc = await readState(pcDisk);
    expect(Object.keys(pc.lifts)).toEqual(["2026-10-19"]);
    expect(pc.plan.files["coach/plan.json"]).toContain("changed on the phone");
    expect(Object.keys((await readState(phone)).checkins)).toEqual(["2026-10-18"]);
  });
  test("the other way: the phone sends what the PC lacks, never over something newer there", async () => {
    const phone = new MemoryDisk();
    await phone.write("strength/old.json", "phone's");
    await phone.write("routes/park.json", JSON.stringify({ name: "Park loop" }));
    await phone.write("coach/plan.json", JSON.stringify({ title: "older, on the phone" }));
    // The PC's plan is newer than the phone's copy.
    await later();
    await pcDisk.write("coach/plan.json", JSON.stringify({ title: "Autumn 10k, newer on the PC", updated: "2026-10-19T13:00:00Z", weeks: [] }));
    const r = await push(phone, remote(tunnel(link)));
    expect(r.files).toBeGreaterThanOrEqual(2);
    expect(await pcDisk.readText("routes/park.json")).toContain("Park loop");
    expect(await pcDisk.readText("coach/plan.json")).toContain("newer on the PC");
    expect((await push(phone, remote(tunnel(link)))).files).toBe(0);
  });
  test("both to the latest: union both ways, a fresh side never overwrites a full one, the workout table merges", async () => {
    // The PC has history; the phone is fresh but wrote its own (newer) default settings.
    await pcDisk.write("strava/activities/5000.json", JSON.stringify({ id: 5000 }));
    await pcDisk.write("settings/schedule.json", JSON.stringify({ weekday: "06:30" }));
    await pcDisk.write("activity-links.json", JSON.stringify({ "strava:5000": "atA" }));
    const phone = new MemoryDisk();
    await later();
    await phone.write("settings/schedule.json", JSON.stringify({ weekday: "18:00" }));
    await phone.write("recordings/run-1.json", JSON.stringify({ id: "run-1" }));
    await phone.write("activity-links.json", JSON.stringify({ "phone:run-1": "atP" }));
    const r = await reconcile(phone, remote(tunnel(link)));
    expect(r.pulled).toBeGreaterThan(0);
    expect(await phone.readText("settings/schedule.json")).toContain("06:30");
    expect(await pcDisk.readText("settings/schedule.json")).toContain("06:30");
    expect(await pcDisk.readText("recordings/run-1.json")).toContain("run-1");
    expect(await phone.readText("strava/activities/5000.json")).toContain("5000");
    const links = JSON.parse((await pcDisk.readText("activity-links.json"))!) as Record<string, string>;
    expect(links).toMatchObject({ "strava:5000": "atA", "phone:run-1": "atP" });
    expect(JSON.parse((await phone.readText("activity-links.json"))!)).toEqual(links);
    // Now both have history: the newer copy wins.
    await later();
    await phone.write("settings/schedule.json", JSON.stringify({ weekday: "07:15" }));
    await reconcile(phone, remote(tunnel(link)));
    expect(await pcDisk.readText("settings/schedule.json")).toContain("07:15");
    // And again: nothing to do.
    const again = await reconcile(phone, remote(tunnel(link)));
    expect(again.pulled + again.pushed + again.merged).toBe(0);
  });
});
