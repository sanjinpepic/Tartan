/**
 * The phone app's own mode, end to end in Chromium (`?device-storage`: Tartan runs in the
 * page on browser storage, as it does on the phone). Connects the mock Strava through its
 * consent redirect, syncs, opens every screen, backs up the demo watch. No PC API is used.
 *   bun scripts/phone-e2e.ts [screenshot dir]
 *
 * The page is served from the production bundle, as in the APK: Bun's development bundler
 * trips over a circular import in the Anthropic SDK, which only the phone mode loads.
 */
process.env.NODE_ENV = "production";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { NodeDisk } from "../src/disk-node.ts";
import { mondayOf, today } from "../src/plan.ts";
import { DEFAULT_FUEL, workoutFor, workoutKey } from "../src/workout/from-plan.ts";
import { startServer } from "../src/server.ts";
import { LocalStore } from "../src/store.ts";
import { startMockStrava } from "../test/sim/mock-strava.ts";

const out = process.argv[2];
const mock = startMockStrava({ activities: 20 });
const claude = startMockClaude();
for (const [i, a] of mock.activities.entries()) {
  const t = new Date(Date.now() - (i * 2 + 1) * 86400_000);
  a.start_date = t.toISOString();
  a.start_date_local = new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().replace("Z", "");
}
// The PC server only serves the page here; an empty data dir proves nothing comes from it.
const http = await startServer({ port: 0, store: new LocalStore(new NodeDisk(mkdtempSync(join(tmpdir(), "fs-pc-")))), quiet: true });
const base = `${http.url}?device-storage`;
const pcCalls: string[] = [];

// WebGL for the route editor's map: software rendering is enough headless.
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--enable-webgl"] });
// The same run on a small phone, in dark, or with Android's large text (review passes):
//   E2E_WIDTH=320 E2E_SCHEME=dark E2E_TEXT=130 bun scripts/phone-e2e.ts out/
const SCHEME = (process.env.E2E_SCHEME === "dark" ? "dark" : "light") as "light" | "dark";
const TEXT = Number(process.env.E2E_TEXT ?? 100);
const page = await browser.newPage({ viewport: { width: Number(process.env.E2E_WIDTH ?? 390), height: 844 }, colorScheme: SCHEME, reducedMotion: "reduce", hasTouch: true, permissions: ["geolocation"], geolocation: { latitude: 60.17, longitude: 24.94, accuracy: 5 } });
// The map style (no network here): a plain background, for the route editor and every workout's map.
await page.route("https://tiles.openfreemap.org/**", (r) => r.fulfill({ json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#eeeeee" } }] } }));
// The forecast where you run (src/weather.ts): a hot, humid week, warmest at 17:00.
await page.route("https://api.open-meteo.com/v1/forecast**", (r) => {
  const day0 = new Date();
  day0.setHours(0, 0, 0, 0);
  const local = (t: Date) => new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const time = Array.from({ length: 8 * 24 }, (_, h) => local(new Date(day0.getTime() + h * 3600_000)));
  const temperature_2m = time.map((_, h) => Math.round(18 + 11 * Math.max(0, Math.sin(((h % 24) - 5) / 24 * 2 * Math.PI))));
  return r.fulfill({ json: { hourly: { time, temperature_2m, dew_point_2m: time.map(() => 19), precipitation_probability: time.map(() => 10), wind_speed_10m: time.map(() => 9) } } });
});
// What past runs were run in: a warm, humid afternoon.
await page.route("https://historical-forecast-api.open-meteo.com/**", (r) => {
  const day = new URL(r.request().url()).searchParams.get("start_date")!;
  const time = Array.from({ length: 24 }, (_, h) => `${day}T${String(h).padStart(2, "0")}:00`);
  return r.fulfill({ json: { hourly: { time, temperature_2m: time.map(() => 24), dew_point_2m: time.map(() => 18) } } });
});
if (process.env.E2E_DEBUG) await page.addInitScript(() => ((globalThis as { E2E_DEBUG?: boolean }).E2E_DEBUG = true));
if (TEXT !== 100) await page.addInitScript((t) => document.addEventListener("DOMContentLoaded", () => (document.documentElement.style.fontSize = `${t}%`)), TEXT);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
// The routes step refuses one routing request on purpose; Chromium logs that 403.
page.on("console", (m) => m.type() === "error" && !(m.text().includes("status of 403") && m.location().url.includes("routing.openstreetmap.de")) && errors.push(m.text()));
page.on("request", (r) => r.url().startsWith(`${http.url}api/`) && pcCalls.push(r.url()));
// Point the in-page Strava client and Claude SDK at the mocks (both read globalThis.process.env).
await page.addInitScript(
  ([m, c]) => ((globalThis as { process?: unknown }).process = { env: { STRAVA_API_BASE: `${m}/api/v3`, STRAVA_OAUTH_BASE: `${m}/oauth`, ANTHROPIC_BASE_URL: c } }),
  [mock.url, claude.url],
);

// Anything wider than the screen (large text, a small phone): named, so a review pass can fix it.
const overflow = () =>
  page.evaluate(() => {
    const w = innerWidth;
    const main = document.getElementById("main");
    const sideways = main ? main.scrollWidth - main.clientWidth : 0;
    // A tap can scroll #main sideways when something is too wide; measure from the left edge.
    if (main) main.scrollLeft = 0;
    const clipped = (e: Element) => {
      for (let p = e.parentElement; p && p.id !== "main" && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if ((o === "auto" || o === "scroll" || o === "hidden" || o === "clip") && p.getBoundingClientRect().right <= w + 1) return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const e of document.querySelectorAll("body *")) {
      const r = e.getBoundingClientRect();
      if (!r.width || r.right <= w + 1 || getComputedStyle(e).position === "fixed" || clipped(e)) continue;
      if ([...e.children].some((c) => c.getBoundingClientRect().right > w + 1)) continue; // report the innermost
      out.push(`${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(" ")[0]}(${Math.round(r.right - w)}px)`);
      if ((globalThis as { E2E_DEBUG?: boolean }).E2E_DEBUG && out.length < 4) {
        const up: string[] = [];
        for (let p: Element | null = e; p && p.id !== "main"; p = p.parentElement) up.push(`${p.tagName.toLowerCase()}.${String((p as HTMLElement).className).split(" ")[0]}:${Math.round(p.getBoundingClientRect().left)}-${Math.round(p.getBoundingClientRect().right)}`);
        out.push(`  up ${up.join(" < ")}`);
      }
    }
    if (sideways > 1) out.unshift(`#main scrolls sideways by ${sideways}px`);
    if ((globalThis as { E2E_DEBUG?: boolean }).E2E_DEBUG && sideways > 1) {
      // The widest box at each level under #main: where the extra width starts.
      let n: Element | null = main;
      const chain: string[] = [];
      while (n && chain.length < 14) {
        const kids = [...n.children].filter((c) => c.getBoundingClientRect().width > 0);
        const widest = kids.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
        if (!widest) break;
        chain.push(`${widest.tagName.toLowerCase()}.${String((widest as HTMLElement).className).split(" ")[0]}:${Math.round(widest.getBoundingClientRect().width)}w/${Math.round(widest.getBoundingClientRect().right)}r`);
        n = widest;
      }
      out.splice(1, 0, `chain ${chain.join(" > ")}`);
    }
    return [...new Set(out)].slice(0, 6);
  });
const step = async (name: string, fn: () => Promise<void>) => {
  await fn();
  // The sync chip never sits over the title in the top bar.
  const clash = await page
    .evaluate(() => {
      const bar = document.getElementById("topbar");
      const title = bar?.querySelector<HTMLElement>(".topbar-title");
      const conn = document.getElementById("conn");
      // The floating design hides the title; only a shown one can clash.
      if (!bar?.classList.contains("scrolled") || !title?.textContent || !conn || getComputedStyle(title).display === "none") return "";
      const r = document.createRange();
      r.selectNodeContents(title);
      const t = r.getBoundingClientRect();
      const c = conn.getBoundingClientRect();
      return c.right > t.left + 1 ? `chip ends at ${Math.round(c.right)}px, "${title.textContent}" starts at ${Math.round(t.left)}px` : "";
    })
    .catch(() => "");
  if (clash) console.log(`    overlap after ${name}: ${clash}`);
  const wide = await overflow().catch(() => []);
  if (wide.length) console.log(`    overflow after ${name}: ${wide.join(", ")}`);
  if (out) await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  console.log(`ok  ${name}`);
};
const snack = () => page.locator("#snack p").textContent();

try {
  await step("first-run-intro", async () => {
    await page.goto(base + "#today");
    await page.waitForSelector(".onboard.in", { timeout: 10_000 });
    if (out) await page.screenshot({ path: `${out}/intro-1-welcome.png` });
    // On the phone the welcome asks first: new here, or from a PC.
    if (!(await page.locator(".ob-choice", { hasText: "I use Tartan on my PC" }).count())) throw new Error("the welcome doesn't offer bringing things over from a PC");
    await page.locator(".ob-choice", { hasText: "I'm new to Tartan" }).click();
    await page.waitForSelector("#ob-title:has-text('Bring in your workouts')");
    if (!(await page.locator(".onboard .group-card").count())) throw new Error("the intro's sources step has no Strava or watch card");
    if (out) await page.screenshot({ path: `${out}/intro-2-sources.png` });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForSelector("#ob-title:has-text('Add your coach')");
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.waitForSelector("#ob-title:has-text('When do you usually train')");
    // A tap on a quick pick sets the weekday time.
    await page.getByRole("radio", { name: /Lunch/ }).click();
    await page.waitForFunction(() => (document.querySelector(".onboard input[type=time]") as HTMLInputElement)?.value === "12:00");
    await page.waitForTimeout(400);
    if (out) await page.screenshot({ path: `${out}/intro-4-times.png` });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForSelector("#ob-title:has-text('Four places')");
    await page.waitForTimeout(500);
    if (out) await page.screenshot({ path: `${out}/intro-5-tabs.png` });
    // The app behind can't be reached while the intro is up.
    if (!(await page.evaluate(() => (document.getElementById("main") as HTMLElement).inert))) throw new Error("the app behind the intro is still interactive");
    await page.getByRole("button", { name: "Start" }).click();
    await page.waitForSelector(".onboard", { state: "detached", timeout: 5000 });
    // Once is enough.
    await page.reload();
    await page.waitForSelector(".today-body", { timeout: 10_000 });
    await page.waitForTimeout(800);
    if (await page.locator(".onboard").count()) throw new Error("the intro came back after it was finished");
  });
  await step("today-empty", async () => {
    await page.goto(base + "#today");
    await page.waitForSelector(".today-body", { timeout: 10_000 });
    if (await page.getByText("lives on your PC").count()) throw new Error("still asks for a PC");
    if (await page.locator("#sync-all, .strip").count()) throw new Error("Today still has the Sync button or the strip");
    if (await page.locator('[data-tab="sync"]').count()) throw new Error("the Sync tab is still in the navigation");
  });
  await step("strava-connected-and-synced-by-itself", async () => {
    // #sync is the old tab's address (bookmarks, Strava's return): it lands in Settings.
    await page.goto(base + "#sync");
    if (!/Settings/.test((await page.locator("#view-title").textContent()) ?? "")) throw new Error("#sync did not open Settings");
    await page.fill('input[name="clientId"]', "123456");
    await page.fill('input[name="clientSecret"]', "0123456789abcdef0123456789abcdef01234567");
    await page.click('button:has-text("Connect Strava")');
    await page.waitForSelector('button:has-text("Sync now")', { timeout: 10_000 });
    if (!page.url().includes("device-storage")) throw new Error(`left device mode: ${page.url()}`);
    // No button pressed: connecting starts the download.
    await page.waitForFunction(() => /\d+ new workouts?\./.test(document.querySelector("#snack p")?.textContent ?? ""), null, { timeout: 20_000 });
    console.log(`    ${await snack()}`);
  });
  await step("sync-now", async () => {
    await page.click('button:has-text("Sync now")');
    await page.waitForFunction(() => /Strava: \d+ new/.test(document.querySelector("#snack p")?.textContent ?? ""), null, { timeout: 20_000 });
    console.log(`    ${await snack()}`);
  });
  await step("sync-board", async () => {
    // The board in the top bar: a Strava lane once it's connected, and a tap gives the lanes in words.
    await page.goto(base + "#today");
    await page.waitForSelector('#conn .lane[data-lane="strava"]', { timeout: 10_000 });
    const label = (await page.locator("#conn").getAttribute("aria-label")) ?? "";
    if (!/Strava: synced/.test(label)) throw new Error(`the board says: ${label}`);
    await page.click("#conn");
    await page.waitForSelector('dialog.board-sheet[open] .board-lane[data-lane="strava"]');
    console.log(`    ${label} | ${(await page.locator("dialog.board-sheet .board-status").first().innerText()).trim()}`);
    if (out) await page.screenshot({ path: `${out}/sync-board.png` });
    await page.locator('dialog.board-sheet button[aria-label="Close"]').click();
    await page.waitForTimeout(400);
  });
  for (const v of ["today", "you", "activities", "trends", "coach", "settings"]) {
    await step(v, async () => {
      await page.goto(base + "#" + v);
      await page.waitForTimeout(1500);
      const err = await page.locator(".empty-card h3").allTextContents();
      if (err.some((t) => /Couldn't load|PC/.test(t))) throw new Error(`${v}: ${err.join(" / ")}`);
    });
  }
  await step("durability", async () => {
    // Progress: the long runs' drift (the mock's 65- and 75-minute runs).
    await page.goto(base + "#trends");
    const card = page.locator(".card.durability");
    await card.locator("h2").waitFor({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    console.log(`    ${await card.locator("p", { hasText: "long run" }).textContent()}`);
  });
  await step("year-grid", async () => {
    // Progress: a square per day, the training days shaded; a tap opens that day's workout.
    await page.goto(base + "#trends");
    const day = page.locator(".day-grid .dg-day[data-id]").last();
    await day.waitFor({ timeout: 10_000 });
    console.log(`    ${await page.locator(".day-grid").getAttribute("aria-label")}`);
    // Race shape: what the runs say you could race, week by week.
    const shape = page.locator("section.race-shape .race-shape-head b");
    await shape.waitFor({ timeout: 15_000 });
    console.log(`    race shape: ${await shape.innerText()}`);
    await day.click();
    await page.waitForSelector("dialog.sheet[open] #sheet-title", { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });
  await step("you-muscle", async () => {
    // The synced runs show on the body, and a tap on a muscle opens it with why.
    await page.goto(base + "#you");
    await page.waitForSelector(".you-chip", { timeout: 10_000 });
    await page.locator('svg[aria-label="From the back"] g[data-m="calves"] path').first().click();
    await page.waitForSelector("dialog.muscle-sheet[open]", { timeout: 30_000 });
    await page.waitForTimeout(800);
    await page.waitForSelector("dialog.muscle-sheet .why", { timeout: 30_000 });
    console.log(`    ${(await page.locator("dialog.muscle-sheet h2").textContent())}: ${await page.locator(".muscle-verdict").textContent()}`);
    await page.locator('dialog.muscle-sheet button[aria-label="Close"]').click();
    await page.waitForTimeout(400);
  });
  await step("run-finish", async () => {
    // Yesterday's run on Today: how it went, records, against last time (from the synced runs).
    await page.goto(base + "#today");
    await page.waitForSelector(".card.last .finish:not([hidden])", { timeout: 20_000 });
    const head = await page.locator(".card.last h2").first().textContent();
    if (head !== "Just in") throw new Error(`the last run's card says ${head}`);
    console.log(`    ${(await page.locator(".card.last .finish h3").allTextContents()).join(" · ")}`);
    if (out) await page.locator(".card.last").screenshot({ path: `${out}/run-finish.png` });
  });
  await step("lift", async () => {
    // A strength session lifted on the phone: sets filled in, a tick starts the rest, the
    // reps left after the last set, then Finish says how it went.
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await page.goto(base + "#lift/" + date);
    await page.waitForSelector(".lift-ex.open .lift-check", { timeout: 10_000 });
    const n = await page.locator(".lift-ex.open .lift-check").count();
    await page.locator(".lift-ex.open .lift-check").first().click();
    await page.waitForSelector(".lift-rest:not([hidden]) .lift-rest-time", { timeout: 3_000 });
    for (let i = 1; i < n; i++) await page.locator(".lift-ex.open .lift-check:not(.on)").first().click();
    await page.locator(".lift-rir .seg").nth(2).click();
    if (out) await page.screenshot({ path: `${out}/lift-under-way.png` });
    // Finish is docked at the bottom; with exercises left, the first tap asks.
    await page.locator(".lift-actions .btn").click();
    await page.waitForFunction(() => /Finish with \d+ left/.test(document.querySelector(".lift-actions .btn")?.textContent ?? ""), null, { timeout: 3_000 });
    if (await page.locator("dialog.lift-done[open]").count()) throw new Error("Finish ended the session with exercises left, without asking");
    await page.locator(".lift-actions .btn").click();
    await page.waitForSelector("dialog.lift-done[open]", { timeout: 10_000 });
    console.log(`    ${(await page.locator("dialog.lift-done h2").textContent())}: ${(await page.locator(".lift-kpis").innerText()).replace(/\s+/g, " ")}; next: ${(await page.locator(".lift-next li").first().innerText()).replace(/\s+/g, " ")}`);
    if (out) await page.screenshot({ path: `${out}/lift-done.png` });
    await page.locator("dialog.lift-done .btn.filled").click();
    await page.waitForFunction(() => location.hash === "#today");
  });
  await step("tab-switch-speed", async () => {
    // Tapping between Today and Trends: time until the dashboard content is on screen.
    const times: number[] = [];
    for (const [tab, sel] of [["trends", ".trends-body .tiles"], ["today", ".today-body .readiness"], ["trends", ".trends-body .tiles"], ["today", ".today-body .readiness"]] as const) {
      const t = Date.now();
      await page.click(`nav [data-tab="${tab}"]`);
      await page.waitForSelector(sel, { timeout: 10_000 });
      times.push(Date.now() - t);
    }
    console.log(`    ${times.map((t) => `${t} ms`).join(", ")}`);
    if (Math.max(...times.slice(2)) > 600) throw new Error(`a repeat tab switch took ${Math.max(...times.slice(2))} ms`);
  });
  await step("targets", async () => {
    await page.goto(base + "#settings");
    // Settings come in four groups; the targets are under Training.
    await page.getByRole("tab", { name: "Training" }).click();
    const form = page.locator("form#targets");
    await form.getByLabel("Distance a week (km)").fill("30");
    await form.getByLabel("Long run (km)").fill("16");
    // The race picker is the app's own dropdown, not the system one.
    await form.locator("button.picker").click();
    await page.getByRole("option", { name: "10 km" }).click();
    if ((await form.locator("select").inputValue()) !== "10") throw new Error("the race picker did not set 10 km");
    if (!/10 km/.test(await form.locator("button.picker").innerText())) throw new Error("the race picker does not show 10 km");
    await form.getByLabel("Race name").fill("Autumn 10k");
    await form.getByLabel("Date").fill(new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10));
    await form.getByLabel("Target time").fill("50:00");
    await form.getByRole("button", { name: "Save targets" }).click();
    await page.waitForFunction(() => /Targets saved/.test(document.querySelector("#snack p")?.textContent ?? ""));
    await page.goto(base + "#today");
    await page.waitForSelector(".race-card", { timeout: 10_000 });
    const week = await page.locator(".card.week").textContent();
    if (!/target 30 km/.test(week ?? "")) throw new Error(`Today's week card has no target: ${week}`);
    await page.goto(base + "#trends");
    await page.waitForSelector(".trends-body .tiles", { timeout: 10_000 });
    const body = await page.locator(".trends-body").textContent();
    if (!/Predicted/.test(body ?? "") || !/target met in \d+ of the last 12 weeks/.test(body ?? "")) throw new Error("Progress lacks the race prediction or the target history");
  });
  await step("record-a-run", async () => {
    await page.goto(base + "#today");
    await page.click('a.btn:has-text("Record")');
    await page.click('button:has-text("Start run")');
    // Run north at ~3 m/s, a fix a second; pause halfway.
    for (let i = 1; i <= 24; i++) {
      await page.context().setGeolocation({ latitude: 60.17 + (i * 3) / 111_195, longitude: 24.94, accuracy: 5 });
      await page.waitForTimeout(1000);
      if (i === 12) {
        await page.click('button:has-text("Pause")');
        if (!(await page.locator(".rec-chip").isVisible())) throw new Error("no recording chip in the top bar");
        await page.click('button:has-text("Resume")');
      }
    }
    const dist = Number((await page.locator(".rstat.big").nth(1).locator("dd").textContent())?.replace(/[^\d.,]/g, "").replace(",", "."));
    if (!(dist > 0.04)) throw new Error(`distance ${dist} km after 24 fixes`);
    await page.click('button:has-text("Finish")');
    await page.waitForSelector('button:has-text("Save")');
    await page.click('button:has-text("Save")');
    await page.waitForFunction(() => /On Strava now|upload failed/i.test(document.querySelector("#snack p")?.textContent ?? ""), null, { timeout: 30_000 });
    const msg = await snack();
    console.log(`    ${msg} (${dist} km recorded)`);
    if (!/On Strava now/.test(msg ?? "")) throw new Error(msg ?? "no upload result");
  });
  await step("recorded-run-is-one-workout", async () => {
    await page.goto(base + "#settings");
    await page.getByRole("tab", { name: "Sources" }).click();
    await page.click('button:has-text("Sync now")');
    // The upload comes back as a new Strava activity (an older "0 new" message doesn't count).
    await page.waitForFunction(() => /Strava: [1-9]\d* new/.test(document.querySelector("#snack p")?.textContent ?? ""), null, { timeout: 20_000 });
    await page.goto(base + "#activities");
    await page.waitForSelector(".groups .row", { timeout: 10_000 });
    // The run recorded here and its Strava upload: one row, with both source badges joined.
    const phone = await page.locator(".groups .row:has(.src-phone)").count();
    const merged = await page.locator(".groups .row:has(.src-badges.merged .src-phone):has(.src-strava)").count();
    if (phone !== 1 || merged !== 1) throw new Error(`expected one merged Strava + Phone workout, got ${phone} phone rows, ${merged} merged; latest rows: ${(await page.locator(".groups .row").evaluateAll((rs) => rs.slice(0, 4).map((r) => r.textContent))).join(" | ")}; snack: ${await snack()}`);
  });
  await step("plan-without-ai", async () => {
    // No AI key: the Coach tab still makes a plan, by Tartan's own rules (src/basic-plan.ts).
    await page.goto(base + "#coach");
    const form = page.locator("form.intake");
    await form.locator("h2", { hasText: "no AI needed" }).waitFor({ timeout: 10_000 });
    await form.getByRole("radiogroup", { name: "Days a week" }).getByRole("radio", { name: "4" }).click();
    await form.getByRole("radiogroup", { name: "Long run day" }).getByRole("radio", { name: "Sun" }).click();
    await form.locator('input[aria-label="Target date"]').fill("end of February");
    await form.getByRole("button", { name: "Make my plan" }).click();
    await page.waitForSelector(".plan-week, .plan-weeks", { timeout: 15_000 });
    console.log(`    ${await snack()} ${await page.locator(".plan-overview h2, .overview h2, section.card h2").first().innerText()}`);
    // Talking it over needs a key: its setup stands where the ask bar would be.
    if (await page.locator(".ask-bar").count()) throw new Error("the ask bar shows without a key");
    if (out) await page.screenshot({ path: `${out}/plan-without-ai-plan.png`, fullPage: true });
    // A guided run (src/workout/guided.ts): with a run on the plan today, Record talks it through
    // step by step; Next step moves on. (On a rest day there's nothing to guide: said, not failed.)
    const runToday = await page.locator(".plan-session.is-today:not(.k-rest):not(.k-strength):not(.k-cross):not(.s-done)").count();
    await page.goto(base + "#record");
    await page.click('button:has-text("Start run")');
    if (runToday) {
      await page.waitForSelector(".guide-step", { timeout: 10_000 });
      const first = await page.locator(".guide-step").innerText();
      if (!/step 1 of \d+/.test(first) || !/left/.test(first)) throw new Error(`the guided run's first step: ${first}`);
      const total = Number(first.match(/step 1 of (\d+)/)![1]);
      if (total > 1) {
        await page.locator(".guide-step").getByRole("button", { name: "Next step" }).click();
        await page.waitForFunction(() => /step 2 of/.test(document.querySelector(".guide-step")?.textContent ?? ""), null, { timeout: 5_000 });
      }
      console.log(`    guided: ${first.replace(/\s+/g, " ").slice(0, 120)}`);
    } else {
      await page.waitForTimeout(2000);
      if (await page.locator(".guide-step").count()) throw new Error("a guided run on a day with no run planned");
      console.log("    no run planned today: nothing to guide (checked that none shows)");
    }
    page.once("dialog", (d) => void d.accept());
    await page.click('button:has-text("Pause")');
    await page.click('button:has-text("Finish")');
    await page.click('button:has-text("Discard")');
    await page.waitForSelector('button:has-text("Start run")', { timeout: 10_000 });
    // Cleared again, so the coach makes the next one (step plan).
    await page.goto(base + "#settings/training");
    const card = page.locator("section.card:has(h2:has-text('Training plan'))");
    await card.getByRole("button", { name: "Reset plan" }).click();
    await card.getByRole("button", { name: "Tap again to clear the plan" }).click();
    await page.waitForFunction(() => /Plan cleared/.test(document.querySelector("#snack p")?.textContent ?? ""));
  });
  await step("coach-answers", async () => {
    await page.goto(base + "#coach");
    // Provider first, then that provider's models, both in the app's own dropdowns.
    await page.getByRole("button", { name: "Provider", exact: true }).click();
    await page.getByRole("option", { name: /Google/ }).click();
    const gemini = await page.getByRole("button", { name: "Model", exact: true }).innerText();
    if (!/Gemini 3\.8 Flash/.test(gemini)) throw new Error(`Google's default model shows as ${gemini}`);
    await page.getByRole("button", { name: "Model", exact: true }).click();
    const options = await page.getByRole("option").allInnerTexts();
    if (!options.some((o) => /Gemini 3\.5 Flash-Lite/.test(o))) throw new Error(`Gemini models offered: ${options.join(" | ")}`);
    if (out) {
      await page.screenshot({ path: `${out}/coach-model-menu.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/coach-model-menu-dark.png` });
      await page.emulateMedia({ colorScheme: SCHEME });
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Provider", exact: true }).click();
    await page.getByRole("option", { name: /Anthropic/ }).click();
    await page.fill('input[aria-label="Anthropic API key"]', "sk-test");
    await page.click('button:has-text("Save")');
    // No plan yet: the coach introduces itself; asking anything opens the conversation.
    await page.waitForSelector("form.intake");
    const intro = await page.locator("form.intake").innerText();
    if (!/km a week/.test(intro)) throw new Error(`the intro doesn't say what the coach knows: ${intro.slice(0, 200)}`);
    if (out) await page.screenshot({ path: `${out}/coach-intro.png`, fullPage: true });
    await page.getByRole("button", { name: /just ask your coach/ }).click();
    await page.waitForSelector('textarea[aria-label="Message the coach"]');
    await page.fill('textarea[aria-label="Message the coach"]', "How am I doing?");
    await page.click('button[aria-label="Send"]');
    await page.waitForFunction(() => /doing well/.test(document.querySelector(".msg.assistant:not(.streaming) .msg-text")?.textContent ?? ""), null, { timeout: 15_000 });
    const tools = await page.locator(".msg.assistant .tool-trail").textContent();
    console.log(`    coach replied, checked: ${tools}`);
    if (!claude.sawBrowserHeader()) throw new Error("the SDK did not send the direct-browser-access header");
  });
  await step("coach-photo", async () => {
    // A photo with a question: a preview while writing, then in the conversation.
    await page.goto(base + "#chat");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await page.locator('.composer input[type="file"]').setInputFiles({ name: "shoe.png", mimeType: "image/png", buffer: png });
    await page.locator(".composer-photo img").waitFor({ timeout: 5000 });
    await page.fill('textarea[aria-label="Message the coach"]', "Are these worn out?");
    const answers = await page.locator(".msg.assistant").count();
    await page.click('button[aria-label="Send"]');
    await page.locator(".msg.user .msg-photo").last().waitFor({ timeout: 5000 });
    // Its own answer (not the one before), finished, with words in it.
    await page.waitForFunction((n) => document.querySelectorAll(".msg.assistant:not(.streaming)").length > n, answers, { timeout: 15_000 });
    if (!/doing well/.test(await page.locator(".msg.assistant").last().innerText())) throw new Error(`the coach's answer to the photo: ${await page.locator(".msg.assistant").last().innerText()} / ${await snack()}`);
    if (await page.locator(".composer-photo img").count()) throw new Error("the photo stayed in the box after sending");
    console.log("    photo sent with the question and shown in the conversation");
  });
  await step("coach-keyboard", async () => {
    // A longer chat, read from the top; then a tap in the box brings the keyboard up.
    for (const q of ["And my long run?", "What about recovery?"]) {
      await page.fill('textarea[aria-label="Message the coach"]', q);
      await page.click('button[aria-label="Send"]');
      await page.waitForFunction((n) => document.querySelectorAll(".msg.assistant:not(.streaming)").length >= n, 2, { timeout: 15_000 });
    }
    // The message box sits just above the tab bar, not a bar's height higher.
    const box0 = await page.evaluate(() => ({ box: Math.round(document.querySelector(".composer")!.getBoundingClientRect().bottom), nav: Math.round(document.getElementById("nav")!.getBoundingClientRect().top) }));
    if (box0.nav - box0.box < 4 || box0.nav - box0.box > 20) throw new Error(`the message box ends at ${box0.box}px, the tab bar starts at ${box0.nav}px`);
    await page.evaluate(() => document.getElementById("main")!.scrollTo({ top: 0, behavior: "instant" }));
    await page.tap('textarea[aria-label="Message the coach"]');
    await page.setViewportSize({ width: Number(process.env.E2E_WIDTH ?? 390), height: 480 }); // the keyboard takes the bottom of the screen
    await page.waitForFunction(() => document.documentElement.classList.contains("kb-open"), null, { timeout: 3000 });
    await page.waitForTimeout(450);
    const gap = await page.evaluate(() => {
      const m = document.getElementById("main")!;
      return m.scrollHeight - (m.scrollTop + m.clientHeight);
    });
    if (gap > 4) throw new Error(`the chat is ${gap}px short of its end with the keyboard up`);
    if (await page.locator("#nav").isVisible()) throw new Error("the tab bar stays up over the keyboard");
    const box = await page.locator(".composer").boundingBox();
    if (!box || box.y + box.height > 480) throw new Error("the message box is under the keyboard");
    if (out) await page.screenshot({ path: `${out}/coach-keyboard-open.png` });
    await page.locator('textarea[aria-label="Message the coach"]').blur();
    await page.setViewportSize({ width: Number(process.env.E2E_WIDTH ?? 390), height: 844 });
    await page.waitForFunction(() => !document.documentElement.classList.contains("kb-open"), null, { timeout: 3000 });
  });
  await step("plan", async () => {
    // Back from the conversation to the plan side of the Coach tab.
    await page.getByRole("link", { name: "Plan" }).click();
    await page.waitForSelector("form.intake");
    await page.getByRole("radiogroup", { name: "Days a week" }).getByRole("radio", { name: "4" }).click();
    await page.getByRole("radiogroup", { name: "Hours a week" }).getByRole("radio", { name: "5 h" }).click();
    await page.getByRole("radiogroup", { name: "Long run day" }).getByRole("radio", { name: "Sun" }).click();
    await page.getByLabel("Target date").fill("end of January");
    await page.getByRole("button", { name: "Make my plan" }).click();
    await page.waitForSelector(".plan-week", { timeout: 15_000 });
    const said = await page.locator(".plan-live .msg-text").innerText();
    if (!/plan is ready/.test(said)) throw new Error(`the coach's note reads: ${said}`);
    const sessions = await page.locator(".plan-week").first().locator(".plan-session").count();
    if (sessions < 4) throw new Error(`this week shows ${sessions} sessions`);
    if (!(await page.locator(".plan-more").count())) throw new Error("no way to the later weeks");
    // This week, next week and the way on are separate cards with the page's spacing between them.
    const gaps = await page.evaluate(() => {
      const r = [...document.querySelectorAll(".plan-content > *")].map((n) => n.getBoundingClientRect());
      return r.slice(1).map((b, i) => Math.round(b.top - r[i]!.bottom));
    });
    if (gaps.some((g) => g < 16)) throw new Error(`plan cards sit ${gaps.join(", ")}px apart`);
    if (out) await page.screenshot({ path: `${out}/plan-full.png`, fullPage: true });
    const done = await page.locator(".plan-week").first().locator(".status-pill.done").count();
    console.log(`    this week: ${done} done, focus on ${await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName)}`);
    if (!claude.lastPlanRequest().includes('Plan up to my target date: \\"end of January\\"')) throw new Error(`the coach wasn't given the target date: ${claude.lastPlanRequest().slice(0, 600)}`);
    if (!(await page.locator(".plan-zones").count())) throw new Error("the plan's paces and zones are missing");
    // A done session with a recording: its sheet says how it went, step by step.
    const doneRow = page.locator(".plan-week .plan-session.s-done");
    if (await doneRow.count()) {
      await doneRow.first().click();
      await page.waitForSelector(".session-sheet[open]");
      if (out) await page.screenshot({ path: `${out}/plan-session-sheet.png` });
      const review = page.locator(".session-sheet .plan-review:not([hidden])");
      if (await review.count().then((n) => n > 0) || (await page.waitForSelector(".session-sheet .plan-review:not([hidden])", { timeout: 4000 }).then(() => true, () => false))) {
        const said = await review.first().innerText();
        if (!said.trim()) throw new Error("the review is empty");
        console.log(`    how it went: ${said.split("\n")[1] ?? said}`);
        if (out) await review.first().screenshot({ path: `${out}/plan-review.png` });
      } else console.log("    (the done session has nothing to compare)");
      await page.locator(".session-sheet .icon-btn[aria-label=Close]").click();
      await page.waitForFunction(() => !document.querySelector(".session-sheet"));
    } else console.log("    (no done session with a recording to review)");
    // A strength session: what it works (the 3D body), its exercises (3D stills), and each one's moving how-to.
    await page.locator(".plan-week .plan-session.k-strength").first().click();
    await page.waitForSelector(".session-sheet[open] .works-body.ready canvas", { timeout: 30_000 });
    const exercises = await page.locator(".session-sheet .ex-row b").allInnerTexts();
    if (exercises.length < 4) throw new Error(`the strength session lists ${exercises.length} exercises`);
    if (!(await page.locator(".session-sheet .works .mm-key.p").count())) throw new Error("no muscles named under the body");
    await page.waitForFunction((n) => document.querySelectorAll(".session-sheet .ex-thumb img.in").length === n, exercises.length, { timeout: 30_000 });
    console.log(`    strength: ${exercises.join(", ")}`);
    if (out) {
      await page.locator(".session-sheet .strength").scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${out}/strength-session.png` });
    }
    // (This run asks for reduced motion, which keeps figures still: allow motion here.)
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator(".session-sheet .ex-row").first().click();
    await page.waitForSelector(".ex-sheet[open] .ex-stage .body-stage.ready canvas", { timeout: 30_000 });
    // It moves: the body looks different half a second later.
    const stage = page.locator(".ex-sheet .ex-stage canvas");
    const f0 = await stage.screenshot();
    await page.waitForTimeout(600);
    const f1 = await stage.screenshot();
    if (f0.equals(f1)) throw new Error("the exercise body doesn't move");
    if (out) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/exercise-sheet.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/exercise-sheet-dark.png` });
      await page.emulateMedia({ colorScheme: SCHEME });
    }
    await page.locator(".ex-sheet .icon-btn[aria-label=Close]").click();
    await page.waitForFunction(() => !document.querySelector(".ex-sheet"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".session-sheet .icon-btn[aria-label=Close]").click();
    await page.waitForFunction(() => !document.querySelector(".session-sheet"));
    // Where the watch is reachable, the coming week's runs are offered as guided workouts.
    // Headless Chromium has no Web Bluetooth: pretend it does until the next page load.
    await page.evaluate(() => Object.defineProperty(navigator, "bluetooth", { value: {}, configurable: true }));
    await page.goto(base + "#today");
    await page.evaluate(() => Object.defineProperty(navigator, "bluetooth", { value: {}, configurable: true }));
    await page.evaluate(() => (location.hash = "#coach"));
    // The plan: one quiet line on the watch above the weeks, no watch card.
    await page.waitForSelector(".watch-line:not([hidden])", { timeout: 10_000 });
    if (await page.locator(".watch-week, .other-watches, .life-card").count()) throw new Error("an old card is still on the Coach tab");
    if (!/^On your watch: 0 of \d+$/.test((await page.locator(".watch-line-text").innerText()).trim())) throw new Error(`the watch line reads: ${await page.locator(".watch-line-text").innerText()}`);
    if (!(await page.locator(".watch-line").getByRole("button", { name: "Send" }).count())) throw new Error("no Send on the watch line");
    if (out) await page.locator(".watch-line").screenshot({ path: `${out}/plan-watch-send.png` });
    // Sessions already on the watch carry a mark, and the send reads as done once all are there.
    const plan = demoPlan();
    const t = today();
    const end = new Date(Date.parse(`${t}T12:00:00Z`) + 6 * 86400_000).toISOString().slice(0, 10);
    const sent: Record<string, { date: string; key: string; name: string }> = {};
    let n = 0;
    for (const w of plan.weeks)
      for (const se of w.sessions as Array<Parameters<typeof workoutFor>[0]>) {
        if (se.kind === "rest" || se.date < t || se.date > end) continue;
        const r = workoutFor(se, plan.zones, DEFAULT_FUEL);
        if ("workout" in r) sent[`tt${String(++n).padStart(6, "0")}`] = { date: se.date, key: workoutKey(se.date, r.workout), name: r.workout.name };
      }
    await page.evaluate((v) => localStorage.setItem("freesuunto.workouts.sent", JSON.stringify(v)), sent);
    await page.evaluate(() => (location.hash = "#today"));
    await page.waitForSelector(".today-body");
    await page.evaluate(() => (location.hash = "#coach"));
    await page.waitForSelector(".plan-week .on-watch", { timeout: 10_000 });
    const marks = await page.locator(".on-watch").count();
    console.log(`    on the plan: ${marks} session(s) marked on your watch; the line reads "${(await page.locator(".watch-line").innerText()).replace(/\s+/g, " ").trim()}"`);
    if (out) {
      // The whole Coach tab, light and dark, with the marks on next week's sessions.
      const showAt = (sel: string) => page.evaluate((q) => { const e = document.querySelector(q); const m = document.getElementById("main")!; if (e) m.scrollTo({ top: m.scrollTop + e.getBoundingClientRect().top - 110, behavior: "instant" as ScrollBehavior }); }, sel);
      await showAt(".plan-week .card-head");
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}/plan-head.png` });
      await showAt(".plan-week ~ .plan-week, .plan-content > :nth-child(2)");
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}/plan-on-watch.png`, fullPage: true });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/plan-on-watch-dark.png`, fullPage: true });
      await page.emulateMedia({ colorScheme: SCHEME });
    }
    // Settings → Watch: guided workouts (drink and gel reminders) and the week on a face.
    await page.evaluate(() => localStorage.setItem("freesuunto.workouts.fuel", JSON.stringify({ gelMin: 30, drinkMin: 15, fromMin: 75, off: true })));
    await page.evaluate(() => (location.hash = "#settings"));
    await page.getByRole("tab", { name: "Watch", exact: true }).click();
    await page.waitForSelector(".workouts-card");
    const drinkSwitch = page.getByRole("switch", { name: "Drink reminders" });
    if ((await drinkSwitch.getAttribute("aria-checked")) !== "false") throw new Error("old 'off' didn't carry over");
    await drinkSwitch.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Drink reminders"]')?.getAttribute("aria-checked") === "true");
    await page.getByRole("radiogroup", { name: "Drink reminders: how often" }).getByRole("radio", { name: "20 min" }).click();
    await page.getByRole("switch", { name: "Gel reminders" }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Gel reminders"]')?.getAttribute("aria-checked") === "true");
    await page.getByRole("switch", { name: "Gel reminders" }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Gel reminders"]')?.getAttribute("aria-checked") === "false");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("freesuunto.workouts.fuel")!));
    if (saved.off !== undefined || saved.drink !== true || saved.gel !== false || saved.drinkMin !== 20) throw new Error(`reminders saved as ${JSON.stringify(saved)}`);
    // The step runner is no longer here: it moved to More → Advanced (checked below).
    if (await page.getByRole("radiogroup", { name: "Workout runner" }).count()) throw new Error("the step runner is still in Settings → Watch");
    await page.waitForSelector(".week-face-card .face-thumb svg");
    if (out) {
      await page.locator(".workouts-card").screenshot({ path: `${out}/settings-workouts.png` });
      await page.locator(".week-face-card").screenshot({ path: `${out}/settings-week-face.png` });
      await page.evaluate(() => { const e = document.querySelector(".workouts-card")!; const m = document.getElementById("main")!; m.scrollTo({ top: m.scrollTop + e.getBoundingClientRect().top - 110, behavior: "instant" as ScrollBehavior }); });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}/settings-watch.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/settings-watch-dark.png` });
      await page.emulateMedia({ colorScheme: SCHEME });
    }
    // With a plan, changes go through the coach: no form. (#plan, the old tab, lands here.)
    await page.goto(base + "#today");
    await page.goto(base + "#plan");
    await page.waitForSelector(".plan-hero");
    if (await page.locator("form.intake").count()) throw new Error("the intake form still shows under the plan");
    if (await page.locator('[data-tab="plan"]').count()) throw new Error("Plan is still a tab of its own");
    if (!(await page.locator('[data-tab="coach"][aria-current="page"]').count())) throw new Error("#plan doesn't land on the Coach tab");
    // The whole plan at a glance: one row per week.
    await page.getByRole("radio", { name: "Whole plan" }).click();
    await page.waitForSelector(".week-row");
    const rows = await page.locator(".week-row").count();
    if (rows !== 3) throw new Error(`the whole plan shows ${rows} weeks, not 3`);
    if (out) await page.screenshot({ path: `${out}/plan-whole.png`, fullPage: true });
    await page.getByRole("radio", { name: "This week" }).click();
    await page.waitForSelector(".plan-week");
    // Forgot the watch: tick a session off by hand from its sheet, then take it back.
    const markable = page.locator(".plan-week .plan-session.s-missed, .plan-week .plan-session.s-today");
    if (await markable.count()) {
      const label = await markable.first().getAttribute("aria-label");
      await markable.first().click();
      await page.locator(".session-sheet").getByRole("button", { name: "Mark done" }).click();
      await page.waitForFunction(() => !document.querySelector(".session-sheet"));
      const row = page.locator(`.plan-week .plan-session[aria-label^="${label!.split(":")[0]}"]`).first();
      await row.click();
      await page.waitForSelector(".session-sheet .plan-manual");
      if (out) await page.screenshot({ path: `${out}/plan-marked.png` });
      await page.locator(".session-sheet .plan-manual .text-btn").click();
      await page.waitForFunction(() => !document.querySelector(".session-sheet"));
      console.log("    marked a session done by hand and undid it");
    } else console.log("    nothing to mark by hand today (no missed or open session this week yet)");
    // "Ask your coach" sits just above the tab bar.
    const ask = await page.evaluate(() => ({ ask: Math.round(document.querySelector(".ask-bar")!.getBoundingClientRect().bottom), nav: Math.round(document.getElementById("nav")!.getBoundingClientRect().top) }));
    if (ask.nav - ask.ask < 4 || ask.nav - ask.ask > 20) throw new Error(`the ask bar ends at ${ask.ask}px, the tab bar starts at ${ask.nav}px`);
    // Ask about one session: the conversation opens with the session named.
    await page.locator(".plan-week .plan-session").first().click();
    await page.locator(".session-sheet .session-ask").click();
    await page.waitForSelector(".msg.assistant");
    const started = await page.locator('textarea[aria-label="Message the coach"]').inputValue();
    if (!/^About \w+ .+: $/.test(started)) throw new Error(`the message starts: ${started}`);
    if (!/plan is ready/.test(await page.locator(".thread").innerText())) throw new Error("the coach didn't open the plan's conversation");
    // Today leads with today's planned session.
    await page.goto(base + "#today");
    await page.waitForSelector(".today-session", { timeout: 10_000 });
    console.log(`    Today: ${(await page.locator(".today-session h2").first().innerText()).trim()}`);
    // The forecast at the session's time (or the next one's, on a rest day), where the latest GPS run started.
    // A session already done today has no forecast (the e2e's recorded run may have ticked it off).
    const wx = page.locator(".today-session .plan-weather:not([hidden])").first();
    const open = await page.locator(".today-session.rest, .today-plan:not(:has(.status-pill.done))").count();
    if (open) console.log(`    ${(await wx.innerText({ timeout: 10_000 })).trim()}`);
    else console.log("    today's session is done: no forecast on it");
  });
  await step("guided-run", async () => {
    // Today's planned run, talked through on Record: its first step, what's left, Next step.
    await page.goto(base + "#record");
    await page.click('button:has-text("Start run")');
    await page.waitForSelector(".guide-step", { timeout: 10_000 });
    const first = await page.locator(".guide-step").innerText();
    if (!/step 1 of \d+/.test(first) || !/Warm up/.test(first) || !/left/.test(first)) throw new Error(`the guided run's first step: ${first}`);
    for (let i = 1; i <= 4; i++) {
      await page.context().setGeolocation({ latitude: 60.17 + (i * 3) / 111_195, longitude: 24.94, accuracy: 5 });
      await page.waitForTimeout(1000);
    }
    await page.locator(".guide-step").getByRole("button", { name: "Next step" }).click();
    await page.waitForFunction(() => /step 2 of/.test(document.querySelector(".guide-step")?.textContent ?? ""), null, { timeout: 5_000 });
    const second = await page.locator(".guide-step").innerText();
    if (out) await page.screenshot({ path: `${out}/guided-run.png` });
    console.log(`    ${first.replace(/\s+/g, " ").slice(0, 80)} → ${second.replace(/\s+/g, " ").slice(0, 80)}`);
    page.once("dialog", (d) => void d.accept());
    await page.click('button:has-text("Pause")');
    await page.click('button:has-text("Finish")');
    await page.click('button:has-text("Discard")');
    await page.waitForSelector('button:has-text("Start run")', { timeout: 10_000 });
  });
  await step("life-changes", async () => {
    // One tap, no chat (src/life.ts): Change plan opens the four; a busy week shortens the rest of it, listed with Undo.
    await page.goto(base + "#coach");
    const change = page.locator(".plan-bar .life-btn");
    await change.waitFor({ timeout: 10_000 });
    if ((await change.innerText()).trim() !== "Change plan") throw new Error(`the plan's button reads ${await change.innerText()}`);
    await change.click();
    await page.locator(".life-sheet .row", { hasText: "Busy week" }).click();
    if (out) await page.screenshot({ path: `${out}/life-busy.png` });
    await page.locator(".life-sheet").getByRole("button", { name: "Make this week shorter" }).click();
    await page.waitForFunction(() => /rest of this week is shorter/.test(document.querySelector("#snack p")?.textContent ?? ""), null, { timeout: 10_000 });
    await page.waitForSelector(".proposal-done", { timeout: 10_000 });
    const taken = await page.locator(".proposal-done summary").innerText();
    if (!/\d+ changes? taken/.test(taken)) throw new Error(`after Busy week: ${taken}`);
    await page.locator(".proposal-done").getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => /back as it was/.test(document.querySelector("#snack p")?.textContent ?? ""), null, { timeout: 10_000 });
    // Ill: three days' rest, and the button asks about feeling better; undone, it doesn't.
    await page.locator(".plan-bar .life-btn").click();
    await page.locator(".life-sheet .row", { hasText: "I'm ill" }).click();
    await page.locator(".life-sheet").getByRole("button", { name: "Rest until I'm better" }).click();
    await page.waitForFunction(() => /Feeling better\?/.test(document.querySelector(".plan-bar .life-btn")?.textContent ?? ""), null, { timeout: 10_000 });
    if (out) await page.screenshot({ path: `${out}/life-ill.png`, fullPage: true });
    await page.locator(".proposal-done").getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => /Change plan/.test(document.querySelector(".plan-bar .life-btn")?.textContent ?? ""), null, { timeout: 10_000 });
    console.log(`    busy week: ${taken.trim()}, undone; ill and undone`);
  });
  await step("morning-check", async () => {
    await page.goto(base + "#today");
    await page.waitForSelector(".morning .morning-row", { timeout: 10_000 });
    await page.getByRole("radiogroup", { name: "Sleep" }).getByRole("radio", { name: "Badly" }).click();
    await page.waitForSelector(".morning-verdict");
    await page.getByRole("radiogroup", { name: "Legs" }).getByRole("radio", { name: "Heavy" }).click();
    await page.waitForFunction(() => /slept badly, heavy legs/i.test(document.querySelector(".morning-verdict")?.textContent ?? ""));
    const verdict = await page.locator(".morning-verdict").innerText();
    console.log(`    ${verdict}`);
    // Something hurts: where, then how much; then nothing again.
    await page.locator(".morning .pain-link").click();
    await page.getByRole("radiogroup", { name: "Where it hurts" }).getByRole("radio", { name: "Calf" }).click();
    if (out) await page.locator(".card.readiness .pain").screenshot({ path: `${out}/morning-pain-open.png` });
    await page.getByRole("radiogroup", { name: "How much" }).getByRole("radio", { name: "A niggle" }).click();
    await page.waitForFunction(() => /niggle in your calf/.test(document.querySelector(".morning-verdict")?.textContent ?? ""));
    if (out) await page.locator(".card.readiness").screenshot({ path: `${out}/morning-pain.png` });
    await page.locator(".morning .pain-link").click();
    await page.getByRole("button", { name: "Nothing hurts" }).click();
    await page.waitForFunction(() => !/niggle/.test(document.querySelector(".morning-verdict")?.textContent ?? ""));
    if (out) await page.locator(".card.readiness").screenshot({ path: `${out}/morning-check.png` });
    // A hard session today would be offered as an easy run instead.
    const swap = page.getByRole("button", { name: /^Swap .* for an easy run$/ });
    if (await swap.count()) {
      await swap.click();
      await page.waitForSelector("text=is swapped for an easy run today");
      console.log("    swapped today's hard session for an easy run");
    }
  });

  await step("week-view", async () => {
    await page.goto(base + "#trends");
    await page.getByRole("radio", { name: "Week", exact: true }).click();
    await page.waitForSelector(".week-nav");
    if ((await page.locator(".week-nav-label b").innerText()) !== "This week") throw new Error("the week view doesn't open on this week");
    if (!(await page.locator(".plan-mini").count())) throw new Error("this week's plan is not linked");
    if (await page.getByRole("button", { name: "Next week" }).isEnabled()) throw new Error("you can step into the future");
    await page.getByRole("button", { name: "Previous week" }).click();
    await page.waitForFunction(() => document.querySelector(".week-nav-label b")?.textContent === "Last week");
    const workouts = await page.locator(".list-card .rows .row").count();
    if (!workouts) throw new Error("last week shows no workouts");
    console.log(`    last week: ${workouts} workouts, ${await page.locator(".tiles .tile-value").first().innerText()} km`);
  });
  await step("bars-stay-put", async () => {
    await page.goto(base + "#trends");
    await page.waitForSelector(".trends-body .card");
    const bars = () => page.evaluate(() => [document.getElementById("nav")!, document.getElementById("topbar")!].map((b) => Math.round(b.getBoundingClientRect().top)).join(","));
    const before = await bars();
    // Scrolled into the page, switching ranges back and forth: sample the bars all the way through.
    await page.evaluate(() => document.getElementById("main")!.scrollTo({ top: 600, behavior: "instant" }));
    const seen = new Set<string>([before]);
    for (const name of ["12 weeks", "6 months", "Week", "1 year", "12 weeks"]) {
      await page.getByRole("radio", { name, exact: true }).click();
      for (let i = 0; i < 6; i++) {
        seen.add(await bars());
        await page.waitForTimeout(80);
      }
    }
    if (seen.size !== 1) throw new Error(`the bars moved while switching ranges: ${[...seen].join(" / ")}`);
    if (await page.evaluate(() => window.scrollY !== 0)) throw new Error("the page itself scrolled; only the content should");
    // Pulling down past the top stretches the content, not the bars, and it springs back.
    await page.evaluate(() => document.getElementById("main")!.scrollTo({ top: 0, behavior: "instant" }));
    const pulled = await page.evaluate(async () => {
      const m = document.getElementById("main")!;
      const target = document.querySelector(".trends-body .card")!;
      const touch = (y: number) => new Touch({ identifier: 1, target, clientX: 200, clientY: y });
      const fire = (type: string, y: number) => target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [touch(y)], changedTouches: [touch(y)] }));
      fire("touchstart", 300);
      for (let y = 310; y <= 500; y += 20) fire("touchmove", y);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const during = { view: document.getElementById("view")!.style.transform, nav: Math.round(document.getElementById("nav")!.getBoundingClientRect().top), top: m.scrollTop };
      fire("touchend", 500);
      await new Promise((r) => setTimeout(r, 700));
      return { ...during, after: document.getElementById("view")!.style.transform };
    });
    if (!/translate3d\(0(px)?, \d/.test(pulled.view)) throw new Error(`the content didn't stretch: ${JSON.stringify(pulled)}`);
    if (String(pulled.nav) !== before.split(",")[0]) throw new Error(`the tab bar moved during the pull: ${JSON.stringify(pulled)}`);
    if (pulled.after) throw new Error(`the content didn't spring back: ${pulled.after}`);
  });
  await step("training-times", async () => {
    await page.goto(base + "#settings");
    await page.getByRole("tab", { name: "Training" }).click();
    const card = page.locator("section.times");
    await card.getByRole("radio", { name: "Lunch · 12:00" }).click();
    await page.waitForFunction(() => /Weekday sessions at 12:00/.test(document.querySelector("#snack p")?.textContent ?? ""));
    // After work, like most people: typed into the field this time.
    await card.getByLabel("Weekdays").fill("18:00");
    await card.getByLabel("Weekdays").dispatchEvent("change");
    await page.waitForSelector('section.times .chip[aria-checked="true"]:has-text("After work")');
    if (!/Next: .+ at (18:00|09:00)\./.test(await card.innerText())) throw new Error(`no next session at your time: ${await card.innerText()}`);
    // The web has no reminders or calendar switches (they're the phone's): only the .ics file.
    if (await card.getByRole("switch").count()) throw new Error("reminder or calendar switches showed outside the app");
    const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Calendar file (.ics)" }).click()]);
    const ics = await (await download.createReadStream()).toArray().then((b) => Buffer.concat(b).toString());
    const starts = [...ics.matchAll(/DTSTART:(\d{8})T(\d{6})/g)].map((m) => ({ dow: new Date(`${m[1]!.slice(0, 4)}-${m[1]!.slice(4, 6)}-${m[1]!.slice(6)}T12:00:00Z`).getUTCDay(), time: m[2] }));
    if (!starts.length) throw new Error(`no events in the .ics: ${ics.slice(0, 300)}`);
    const wrong = starts.filter((s) => s.time !== (s.dow === 0 || s.dow === 6 ? "090000" : "180000"));
    if (wrong.length) throw new Error(`${wrong.length} of ${starts.length} sessions at the wrong time`);
    console.log(`    ${download.suggestedFilename()}: ${starts.length} sessions, weekdays 18:00, weekends 09:00`);
    if (out) await card.screenshot({ path: `${out}/training-times.png` });
  });
  await step("settings-plan", async () => {
    await page.goto(base + "#settings");
    await page.getByRole("tab", { name: "Training" }).click();
    // Scrolled down, the tabs pin right under the top bar (not a bar's height lower).
    await page.evaluate(() => document.getElementById("main")!.scrollTo({ top: 500, behavior: "instant" }));
    await page.waitForTimeout(200);
    const pin = await page.evaluate(() => ({ bar: Math.round(document.querySelector(".settings-bar")!.getBoundingClientRect().top), top: Math.round(document.getElementById("topbar")!.getBoundingClientRect().bottom) }));
    if (Math.abs(pin.bar - pin.top) > 2) throw new Error(`the Settings tabs pin at ${pin.bar}px, the top bar ends at ${pin.top}px`);
    await page.evaluate(() => document.getElementById("main")!.scrollTo({ top: 0, behavior: "instant" }));
    const card = page.locator("section.card:has(h2:has-text('Training plan'))");
    const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Export as CSV" }).click()]);
    const csv = await (await download.createReadStream()).toArray().then((b) => Buffer.concat(b).toString());
    if (!csv.startsWith("week,week_start,week_focus,date") || csv.trim().split("\n").length < 10) throw new Error(`the CSV reads: ${csv.slice(0, 200)}`);
    console.log(`    exported ${download.suggestedFilename()}, ${csv.trim().split("\n").length - 1} sessions`);
    await card.getByRole("button", { name: "Reset plan" }).click();
    await card.getByRole("button", { name: "Tap again to clear the plan" }).click();
    await page.waitForFunction(() => /Plan cleared/.test(document.querySelector("#snack p")?.textContent ?? ""));
    await page.goto(base + "#coach");
    await page.waitForSelector("form.intake");
    if (out) {
      await page.goto(base + "#settings");
      await page.getByRole("tab", { name: "Sources" }).click();
      await page.screenshot({ path: `${out}/settings-sources.png` });
    }
  });
  await step("send-watch-switch", async () => {
    await page.goto(base + "#settings");
    await page.getByRole("tab", { name: "Sources" }).click();
    const sw = page.getByRole("switch", { name: "Send watch workouts to Strava" });
    if ((await sw.getAttribute("aria-checked")) !== "false") throw new Error("sending watch workouts to Strava should start off");
    await sw.click();
    await page.waitForSelector('.send-watch .switch[aria-checked="true"]:not([disabled])');
    const line = await page.locator(".send-watch").innerText();
    if (!/On since|sent since|allowed uploads/.test(line)) throw new Error(`no status under the switch: ${line}`);
    if (out) await page.locator(".send-watch").screenshot({ path: `${out}/send-watch-on.png` });
    await page.getByRole("switch", { name: "Send watch workouts to Strava" }).click();
    await page.waitForSelector('.send-watch .switch[aria-checked="false"]:not([disabled])');
  });
  await step("routes", async () => {
    // The map, the walking router and the heights are outside services: stand-ins here.
    await page.route("https://tiles.openfreemap.org/**", (r) => r.fulfill({ json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#eeeeee" } }] } }));
    const routed: string[] = [];
    // The first request is refused, as an overloaded or picky server would: BRouter takes over.
    await page.route("https://brouter.de/**", (r) => {
      const pts = new URL(r.request().url()).searchParams.get("lonlats")!.split("|").map((p) => p.split(",").map(Number));
      routed.push(r.request().url());
      // Through every point given, a dog-leg between each pair.
      const coordinates = pts.flatMap((b, i) => (i ? [[b[0], pts[i - 1]![1]], b] : [b]));
      return r.fulfill({ json: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates } }] } });
    });
    await page.route("https://routing.openstreetmap.de/**", (r) => {
      if (!routed.length) {
        routed.push("refused");
        return r.fulfill({ status: 403, body: "Forbidden" });
      }
      const pts = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop()!).split(";").map((p) => p.split(",").map(Number));
      routed.push(r.request().url());
      // A dog-leg via a corner between each pair, like a real path around a block.
      const coordinates = pts.flatMap((b, i) => (i ? [[pts[i - 1]![0], b[1]], b] : [b]));
      return r.fulfill({ json: { code: "Ok", routes: [{ geometry: { type: "LineString", coordinates } }], waypoints: pts.map((p) => ({ location: p })) } });
    });
    await page.route("https://api.open-meteo.com/**", (r) => {
      if (r.request().url().includes("/v1/forecast")) return r.fallback();
      const lat = new URL(r.request().url()).searchParams.get("latitude")!.split(",").map(Number);
      return r.fulfill({ json: { elevation: lat.map((l) => Math.round(20 + ((l * 1e4) % 7) * 6)) } });
    });
    await page.goto(base + "#today");
    await page.locator('.nav [data-tab="activities"]').click();
    await page.locator('.library-tabs a[href="#routes"]').click();
    await page.waitForSelector(".routes-empty");
    await page.getByRole("link", { name: "Draw a route" }).click();
    await page.waitForSelector(".route-map canvas", { timeout: 15_000 });
    if (await page.locator("#topbar").isVisible()) throw new Error("the top bar shows over the route editor");
    // Where you are: a dot; a tap on it starts the route there (then undone for the drawing below).
    await page.waitForSelector(".me-dot", { timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.locator(".me-dot").click();
    await page.waitForSelector(".wp.start");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForSelector(".wp", { state: "detached" });
    const map = page.locator(".route-map");
    for (const [x, y] of [[90, 160], [300, 200], [260, 380]] as const) {
      await map.click({ position: { x, y } });
      await page.waitForTimeout(150);
    }
    await page.waitForFunction(() => document.querySelector(".route-status")?.textContent === "");
    if (!routed.some((u) => u.includes("brouter.de"))) throw new Error("a refused path finder didn't fall back to BRouter");
    if (await page.locator(".route-status").textContent() !== "" || /straight line/.test((await page.locator("#snack p").textContent().catch(() => "")) ?? "")) throw new Error("a leg fell back to a straight line");
    await page.getByRole("button", { name: "Back to start" }).click();
    await page.waitForFunction(() => /\d+ m/.test(document.querySelector(".route-climb")?.textContent ?? ""), null, { timeout: 10_000 });
    const km = Number((await page.locator(".route-km").textContent())!.replace(",", "."));
    if (!(km > 0.5)) throw new Error(`the loop measures ${km} km`);
    if ((await page.locator(".wp").count()) !== 4) throw new Error(`${await page.locator(".wp").count()} points on the map, expected 4`);
    // Undo takes the loop back off; the start point closes it again.
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".wp").length === 3);
    await page.locator(".wp.start").click();
    await page.waitForFunction(() => document.querySelectorAll(".wp").length === 4);
    await page.waitForFunction(() => /\d+ m/.test(document.querySelector(".route-climb")?.textContent ?? ""), null, { timeout: 10_000 });
    if (out) await page.screenshot({ path: `${out}/route-editor.png` });
    await page.getByLabel("Route name").fill("Park loop");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => /Saved Park loop/.test(document.querySelector("#snack p")?.textContent ?? ""));
    if (!/#route\/r/.test(page.url())) throw new Error(`the address didn't follow the saved route: ${page.url()}`);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download GPX" }).click()]);
    const gpx = await (await download.createReadStream()).toArray().then((b) => Buffer.concat(b).toString());
    if (!/<trk><name>Park loop<\/name>/.test(gpx) || (gpx.match(/<trkpt /g) ?? []).length < 6 || !gpx.includes("<ele>")) throw new Error(`the GPX reads: ${gpx.slice(0, 400)}`);
    console.log(`    ${download.suggestedFilename()}: ${km} km, ${(gpx.match(/<trkpt /g) ?? []).length} points, ${await page.locator(".route-climb").innerText().then((t) => t.replace(/\s+/g, " "))}`);
    await page.locator('a[aria-label="Back to routes"]').click();
    await page.waitForSelector(".route-item");
    if (!/Park loop[\s\S]*Loop/.test(await page.locator(".route-item").first().innerText())) throw new Error(`the list shows: ${await page.locator(".route-item").first().innerText()}`);
    await page.waitForTimeout(600);
    if (out) await page.screenshot({ path: `${out}/routes.png` });
    // Opening it again shows the same route, ready to change.
    await page.locator(".route-item").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".wp").length === 4, null, { timeout: 15_000 });
    if ((await page.getByLabel("Route name").inputValue()) !== "Park loop") throw new Error("the saved name didn't come back");
    // Race pacing for this course: a split per km for a target time.
    await page.getByRole("button", { name: "Race pace" }).click();
    await page.getByLabel("Target time").fill("9:00");
    await page.getByRole("button", { name: "Work it out" }).click();
    await page.waitForSelector(".pace-table tbody tr");
    const splitRows = await page.locator(".pace-table tbody tr").count();
    const lastTime = await page.locator(".pace-table tbody tr").last().locator("td").nth(2).textContent();
    if (lastTime !== "9:00") throw new Error(`the splits end at ${lastTime}, not the target 9:00`);
    if (out) await page.screenshot({ path: `${out}/route-pacing.png` });
    console.log(`    pacing: ${splitRows} splits, finishing ${lastTime}`);
    await page.getByRole("button", { name: "Close" }).click();
    // A loop from here: three options on the map, one picked becomes the route.
    await page.goto(base + "#route/new");
    await page.waitForSelector(".route-map canvas", { timeout: 15_000 });
    await page.locator(".route-loops").getByRole("button", { name: "5 km", exact: true }).click();
    await page.waitForSelector(".loop-pick", { timeout: 20_000 });
    const options = await page.locator(".loop-pick").allInnerTexts();
    if (!options.length) throw new Error("no loop options");
    if (out) await page.screenshot({ path: `${out}/route-loops.png` });
    await page.locator(".loop-pick").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".wp").length === 5);
    if (!(await page.locator(".route-loops").isHidden())) throw new Error("the loop bar stays after picking one");
    if (!/km loop$/.test(await page.getByLabel("Route name").inputValue())) throw new Error("the loop wasn't named");
    console.log(`    loops: ${options.join(", ")}; picked ${await page.locator(".route-km").textContent()} km`);
    // From the Routes tab in one tap: the editor opens already finding 8 km loops.
    await page.goto(base + "#routes");
    await page.locator(".loop-quick").getByRole("link", { name: "8 km" }).click();
    await page.waitForSelector(".loop-pick", { timeout: 25_000 });
    console.log(`    quick loops: ${(await page.locator(".loop-pick").allInnerTexts()).join(", ")}`);
    if (out) await page.screenshot({ path: `${out}/route-quick-loop.png` });
    await page.goto(base + "#today");
    if (!(await page.locator("#topbar").isVisible())) throw new Error("the top bar stayed hidden after the editor");
  });
  await step("face-builder", async () => {
    // Out of the way since 2.56: Settings → More → Advanced → Watch face builder.
    const openBuilder = async () => {
      await page.getByRole("tab", { name: "More" }).click();
      const more = page.locator("details.face-builder");
      if ((await more.getAttribute("open")) === null) await more.locator("summary").click();
      await page.locator("section.faces").waitFor();
    };
    await page.goto(base + "#settings");
    await openBuilder();
    // The owner's build: which step runner the workouts carry (moved here from Settings → Watch in
    // 2.57). Suunto's by default; Tartan's own to try, and then it stays picked.
    const runnerMore = page.locator("details.runner-row");
    await runnerMore.locator("summary").click();
    const runner = page.getByRole("radiogroup", { name: "Workout runner" });
    if ((await runner.getByRole("radio", { name: "Suunto's" }).getAttribute("aria-checked")) !== "true") throw new Error("the captured runner isn't the default");
    await runner.getByRole("radio", { name: "Tartan's own" }).click();
    await page.waitForFunction(() => localStorage.getItem("freesuunto.workouts.runner") === "tartan");
    if ((await runner.getByRole("radio", { name: "Tartan's own" }).getAttribute("aria-checked")) !== "true") throw new Error("Tartan's runner didn't stay picked");
    if (out) await runnerMore.screenshot({ path: `${out}/settings-runner.png` });
    await runner.getByRole("radio", { name: "Suunto's" }).click();
    if (!(await page.locator(".face-list .face-thumb svg").count())) throw new Error("no face in the list");
    await page.getByRole("link", { name: "Design a face" }).click();
    await page.waitForSelector(".fb-screen svg");
    // A preset, a few choices, a colour, then save and build the package.
    await page.getByRole("button", { name: "Start from Plaid" }).click();
    await page.getByRole("radio", { name: "XII and IX" }).click();
    await page.getByRole("radio", { name: "Lollipop" }).click();
    await page.getByRole("radio", { name: "Hands" }).click();
    await page.getByRole("radio", { name: "Amber", exact: true }).first().click();
    await page.locator("#fb-name").fill("E2E Plaid");
    const svg = await page.locator(".fb-screen").innerHTML();
    if (!svg.includes("XII") || !svg.includes("#ffbe3d")) throw new Error("the preview didn't follow the choices");
    if (out) await page.screenshot({ path: `${out}/face-builder.png` });
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.getByRole("button", { name: "Package (.zip)" }).click()]);
    const z = new Uint8Array(await (await download.createReadStream()).toArray().then((b) => Buffer.concat(b)));
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    const end = z.length - 22;
    const names: string[] = [];
    for (let i = 0, at = dv.getUint32(end + 16, true); i < dv.getUint16(end + 10, true); i++) {
      const len = dv.getUint16(at + 28, true);
      names.push(new TextDecoder().decode(z.subarray(at + 46, at + 46 + len)));
      at += 46 + len;
    }
    const { FACE_IMAGES } = await import("../src/watchface/package.ts");
    const want = [...Object.keys(FACE_IMAGES), "dial_main.bin"].sort();
    if (names.sort().join() !== want.join()) throw new Error(`the package holds ${names.join(", ")}`);
    if (!/#face\/\d{10}$/.test(page.url())) throw new Error(`saving didn't give the face an id: ${page.url()}`);
    console.log(`    ${download.suggestedFilename()}: ${names.length} files, ${(z.length / 1024).toFixed(0)} KB`);
    // It's in the list now.
    await page.getByRole("link", { name: "Back to Settings" }).click();
    await openBuilder();
    await page.waitForSelector('.face-item:has-text("E2E Plaid")');
    if (out) await page.locator("section.faces").screenshot({ path: `${out}/watch-faces.png` });
  });
  await step("activity-sheet", async () => {
    await page.goto(base + "#activities");
    await page.click(".groups .row");
    await page.waitForSelector("dialog.sheet svg", { timeout: 10_000 });
    // Close stays on a phone too (one thumb, TalkBack, switch access), beside pull-to-close.
    if (!(await page.locator('dialog.sheet button[aria-label="Close"]').isVisible())) throw new Error("no Close on the phone's sheet");
    // Where the workout came from: source badges in the list and the sheet, and what each source measured.
    if (!(await page.locator(".groups .row .src-strava").count())) throw new Error("no source badge in the list");
    if (!(await page.locator("dialog.sheet .sources-card").count())) throw new Error("the sheet has no Sources card");
    // The route sits on the real map (as in the route editor), faded in once the map has loaded.
    if (await page.locator("dialog.sheet .route-card").count()) {
      await page.waitForSelector("dialog.sheet .route-card.has-streets .route-street canvas", { timeout: 20_000 });
      if (out) await page.locator("dialog.sheet .route-card").screenshot({ path: `${out}/sheet-map.png` });
    }
    // It opens at the top, at its full height, and doesn't change height once the workout is in.
    const sheet = await page.evaluate(() => {
      const d = document.querySelector("dialog.sheet") as HTMLDialogElement;
      return { top: d.scrollTop, h: d.offsetHeight, vh: innerHeight };
    });
    if (sheet.top > 0) throw new Error(`the sheet opened scrolled ${sheet.top}px down`);
    if (sheet.h < sheet.vh * 0.85) throw new Error(`the sheet is ${sheet.h}px tall in a ${sheet.vh}px window`);
  });
  await step("sheet-drag-closes", async () => {
    // A finger pulling the sheet down from its header.
    await page.evaluate(async () => {
      const d = document.querySelector("dialog.sheet") as HTMLDialogElement;
      const head = d.querySelector(".sheet-head")!;
      const touch = (y: number) => new Touch({ identifier: 1, target: head, clientX: 200, clientY: y });
      const fire = (type: string, y: number) => head.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [touch(y)], changedTouches: [touch(y)] }));
      fire("touchstart", 260);
      for (let y = 270; y <= 560; y += 30) {
        fire("touchmove", y);
        await new Promise((r) => setTimeout(r, 16));
      }
      fire("touchend", 560);
    });
    await page.waitForFunction(() => !(document.querySelector("dialog.sheet") as HTMLDialogElement).open, null, { timeout: 3000 });
  });
  await step("demo-watch-backup", async () => {
    // The watch recorder is armed first, so this connection ends up on tape (step watch-recorder).
    await page.goto(base + "#settings/more");
    await page.click("summary:has-text('Watch recorder')");
    await page.click('button:has-text("Record the next connection")');
    await page.waitForSelector("text=Waiting: the next connection", { timeout: 5000 });
    await page.goto(base + "#settings");
    await page.getByRole("tab", { name: "Sources" }).click();
    // Health Connect is the Android app's: here (a browser) the card says so.
    await page.waitForFunction(() => /In the Android app/.test(document.querySelector(".hc-card")?.textContent ?? ""), null, { timeout: 10_000 });
    await page.click('button:has-text("Try demo watch")');
    await page.click('button:has-text("Back up now")', { timeout: 15_000 });
    await page.waitForFunction(() => /Backed up \d+ new/.test(document.querySelector("#snack p")?.textContent ?? ""), null, { timeout: 30_000 });
    console.log(`    ${await snack()}`);
    await page.click("summary:has-text('Saved on this phone')");
    await page.waitForSelector("details.more table", { timeout: 10_000 });
  });
  await step("watch-recorder", async () => {
    await page.click('button:has-text("Disconnect")');
    await page.goto(base + "#settings/more");
    await page.click("summary:has-text('Watch recorder')");
    await page.waitForSelector("text=Last recording: Demo Suunto Run 2", { timeout: 10_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), page.click('button:has-text("Share recording")')]);
    const file = `${out ?? "/tmp"}/watch.jsonl`;
    await download.saveAs(file);
    const { parseTape, tapeFrames } = await import("../src/protocol/blackbox.ts");
    const tape = parseTape(await Bun.file(file).text());
    const frames = tapeFrames(tape).filter((f) => "frame" in f).length;
    if (frames < 50) throw new Error(`only ${frames} frames on the tape`);
    console.log(`    ${tape.header.name}: ${frames} frames, ${tape.events.length} events`);
  });
  await step("import-fit", async () => {
    // A workout file from another app (Garmin's export, say): Sources → Workout files.
    await page.goto(base + "#settings");
    await page.getByRole("tab", { name: "Sources" }).click();
    const card = page.locator(".import-card");
    const { encodeFit } = await import("../test/sim/fit-fixture.ts");
    await card.locator('input[type="file"]').setInputFiles([{ name: "Garmin run.fit", mimeType: "application/octet-stream", buffer: Buffer.from(encodeFit()) }, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") }]);
    await card.locator(".footnote:not([hidden])").waitFor({ timeout: 10_000 });
    const said = await card.locator(".footnote").innerText();
    if (!/Imported 1 workout/.test(said) || !/isn't a workout file Tartan reads/.test(said)) throw new Error(`the import said: ${said}`);
    console.log(`    ${said}`);
    await card.scrollIntoViewIfNeeded();
  });
  await step("body", async () => {
    // The demo watch's day in the readiness card's strip; a tap opens all of it.
    await page.goto(base + "#today");
    await page.waitForSelector(".readiness .vitals:not([hidden])", { timeout: 10_000 });
    console.log(`    strip: ${(await page.locator(".vitals").innerText()).replace(/\s+/g, " ")}`);
    if (out) {
      await page.evaluate(() => { const e = document.querySelector(".readiness")!; const m = document.getElementById("main")!; m.scrollTo({ top: m.scrollTop + e.getBoundingClientRect().top - 70, behavior: "instant" as ScrollBehavior }); });
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${out}/readiness-vitals.png` });
    }
    // Answered this morning already: just the verdict; and with the night measured, Change asks
    // only about legs.
    await page.waitForSelector(".morning .morning-change");
    if (await page.locator(".morning .morning-row").count()) throw new Error("the answered morning check is still open");
    await page.locator(".morning .morning-change").click();
    const rows = await page.locator(".morning .morning-row").evaluateAll((rs) => rs.map((r) => r.getAttribute("aria-label")));
    if (rows.join() !== "Legs") throw new Error(`the morning check asks: ${rows.join(", ")}`);
    if (out) await page.locator(".card.readiness").screenshot({ path: `${out}/morning-legs-only.png` });
    // The strip leads to You, where sleep and vitals sit under the body.
    await page.locator(".vitals").click();
    await page.waitForSelector(".you-vitals .body-tile.rest", { timeout: 10_000 });
    if (!(await page.evaluate(() => location.hash === "#you"))) throw new Error("the strip didn't open Body");
    // Body isn't a tab: Today stays highlighted, and Body doesn't repeat the readiness card.
    if (await page.locator('.nav [data-tab="you"]').count()) throw new Error("You is still a tab");
    if (await page.locator(".you-ready").count()) throw new Error("Body repeats the readiness card");
    const tiles = await page.locator(".you-vitals .body-tile").evaluateAll((ts) => ts.map((t) => `${t.querySelector("dt")?.textContent}: ${t.querySelector("dd")?.textContent} (${t.querySelector(".body-note")?.textContent})`));
    console.log(`    ${tiles.join("\n    ")}`);
    if (!/\d+ bpm/.test(tiles[0] ?? "")) throw new Error(`no resting heart rate: ${tiles[0]}`);
    if (!/9[67]\s*%/.test(tiles[2] ?? "")) throw new Error(`no blood-oxygen reading: ${tiles[2]}`);
    if (!(await page.locator(".you-vitals .hr-path").count())) throw new Error("no heart-rate line for today");
    if (out) {
      await page.locator(".you-vitals").scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${out}/you-vitals.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/you-vitals-dark.png` });
      await page.emulateMedia({ colorScheme: SCHEME });
    }
  });
  await step("race-week", async () => {
    // The race three days out: Today leads with race week.
    await page.goto(base + "#settings");
    await page.getByRole("tab", { name: "Training" }).click();
    const form = page.locator("form#targets");
    await form.getByLabel("Date").fill(new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10));
    await form.getByRole("button", { name: "Save targets" }).click();
    await page.waitForFunction(() => /Targets saved/.test(document.querySelector("#snack p")?.textContent ?? ""));
    await page.goto(base + "#today");
    await page.waitForSelector(".race-week", { timeout: 10_000 });
    const focus = await page.locator(".race-week .rw-focus h3").innerText();
    // Pacing, fuel and the checklist open from the card, so race week doesn't fill Today.
    if (await page.locator(".today-body .race-week .rw-pacing").count()) throw new Error("race week's pacing is on Today itself");
    await page.locator(".race-week .btn", { hasText: "Pacing" }).click();
    await page.waitForSelector("dialog.rw-sheet[open] .rw-pacing .kpis");
    const pacing = (await page.locator("dialog.rw-sheet .rw-pacing .kpis").innerText()).replace(/\s+/g, " ");
    if (out) await page.screenshot({ path: `${out}/race-week-sheet.png` });
    await page.locator('dialog.rw-sheet button[aria-label="Close"]').click();
    await page.waitForTimeout(400);
    console.log(`    ${focus}; ${pacing}`);
    if (!/5:00 \/km.*At 5 km 25:00/.test(pacing)) throw new Error(`race week pacing reads: ${pacing}`);
    if (out) {
      await page.evaluate(() => { const e = document.querySelector(".race-week")!; const m = document.getElementById("main")!; m.scrollTo({ top: m.scrollTop + e.getBoundingClientRect().top - 70, behavior: "instant" as ScrollBehavior }); });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${out}/race-week.png` });
    }
  });
  // With TOUR=1: every screen top to bottom, light and dark, for a design review.
  if (out && process.env.TOUR) {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [name, hash, tab] of [["today", "#today"], ["body", "#you"], ["coach", "#coach"], ["activities", "#activities"], ["routes", "#routes"], ["progress", "#trends"], ["set-sources", "#settings", "Sources"], ["set-training", "#settings", "Training"], ["set-coach", "#settings", "Coach"], ["set-watch", "#settings", "Watch"], ["set-more", "#settings", "More"]] as const) {
        await page.goto(base + hash);
        if (tab) await page.getByRole("tab", { name: tab }).click();
        await page.waitForTimeout(1500);
        for (let i = 0; i < 6; i++) {
          await page.screenshot({ path: `${out}/tour-${scheme}-${name}-${i}.png` });
          const moved = await page.evaluate(() => {
            const m = document.getElementById("main")!;
            const before = m.scrollTop;
            m.scrollTo({ top: before + 640, behavior: "instant" as ScrollBehavior });
            return m.scrollTop !== before;
          });
          if (!moved) break;
          await page.waitForTimeout(450);
        }
      }
      // A workout's sheet, top to bottom (the longest run, which has the most in it), and the chat.
      await page.goto(base + "#activities");
      await page.locator(".groups .row", { hasText: "Long run 3" }).first().click();
      await page.waitForSelector("dialog.sheet[open] .stat-grid");
      await page.waitForTimeout(900);
      for (let i = 0; i < 6; i++) {
        await page.screenshot({ path: `${out}/tour-${scheme}-sheet-${i}.png` });
        const moved = await page.evaluate(() => {
          const d = document.querySelector("dialog.sheet[open]") as HTMLElement;
          const before = d.scrollTop;
          d.scrollTo({ top: before + 640, behavior: "instant" as ScrollBehavior });
          return d.scrollTop !== before;
        });
        if (!moved) break;
        await page.waitForTimeout(450);
      }
      await page.keyboard.press("Escape");
      await page.goto(base + "#chat");
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${out}/tour-${scheme}-chat-0.png` });
    }
    await page.emulateMedia({ colorScheme: SCHEME });
    console.log("ok  tour");
  }
  await step("shoes", async () => {
    // Strava's pair came in with the sync, and Today said so once.
    await page.evaluate(() => localStorage.removeItem("freesuunto.shoes.found"));
    await page.goto(base + "#today");
    await page.locator(".shoes-note", { hasText: "from Strava" }).waitFor({ timeout: 10_000 });
    await page.goto(base + "#settings/training");
    const card = page.locator(".shoes-card");
    await card.waitFor({ timeout: 10_000 });
    const strava = card.locator(".shoe", { hasText: "Endorphin" });
    await strava.waitFor({ timeout: 10_000 });
    if (!(await strava.locator(".shoe-strava").count())) throw new Error("the Strava pair isn't marked as on Strava");
    // A pair worn since a month ago, with a photo: the runs since then count to it.
    if (out) await card.screenshot({ path: `${out}/shoes-from-strava.png` });
    await card.locator("details.more > summary", { hasText: "Add a pair" }).click();
    await card.locator(".shoe-form input[type=file]").setInputFiles({ name: "shoe.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") });
    await card.locator(".shoe-form .shoe-pic img").waitFor({ timeout: 10_000 });
    // The coach has a key by now: it reads the name off the photo.
    await card.locator('button:has-text("Read the name off it")').click();
    await page.waitForFunction(() => (document.querySelector('input[name="shoe-name"]') as HTMLInputElement)?.value === "Nike Pegasus 41", null, { timeout: 10_000 });
    console.log(`    ${await snack()}`);
    await card.locator('input[name="shoe-name"]').fill("Pegasus 41");
    await card.locator('.shoe-form input[type="date"]').fill(new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
    await card.locator('button:has-text("Add the pair")').click();
    const mine = card.locator(".shoe", { hasText: "Pegasus 41" });
    await mine.locator(".shoe-km").waitFor({ timeout: 10_000 });
    const km = await mine.locator(".shoe-km").innerText();
    if (!/^[1-9]\d* km$/.test(km)) throw new Error(`the new pair has ${km}`);
    if (!(await mine.locator(".shoe-pic img").count())) throw new Error("the photo didn't stay with the pair");
    // Not on Strava: the card says how to get it there.
    await card.locator(".shoe-note", { hasText: "My Gear" }).waitFor({ timeout: 5_000 });
    // Older runs Strava has no pair on: set the Strava pair on them there.
    const push = strava.locator('button:has-text("Set on Strava")');
    if (await push.count()) {
      await push.click();
      await page.waitForFunction(() => /set on \d+ runs? on Strava/.test(document.querySelector("#snack p")?.textContent ?? ""), null, { timeout: 15_000 });
      console.log(`    ${await snack()}`);
    }
    // The Endorphins become the racing pair: Today says which pair suits today's session.
    // The type lives in the pair's editor (Edit), not on the list.
    if (await strava.locator("select.shoe-kind").count()) throw new Error("a type picker on the list again");
    await strava.locator('button:has-text("Edit")').click();
    const editor = strava.locator("form.shoe-editor");
    await editor.waitFor({ timeout: 5_000 });
    await editor.locator("select.shoe-kind").selectOption("racing");
    if (out) await strava.screenshot({ path: `${out}/shoe-editor.png` });
    await editor.locator('button:has-text("Save")').click();
    await page.waitForFunction(() => /saved/.test(document.querySelector("#snack p")?.textContent ?? ""), null, { timeout: 10_000 });
    await card.locator(".shoe", { hasText: "Endorphin" }).locator(".shoe-foot .sub", { hasText: /^Racing/ }).waitFor({ timeout: 5_000 });
    if (out) {
      await card.screenshot({ path: `${out}/shoes-card.png` });
    }
    await page.goto(base + "#today");
    await page.locator(".today-body > section.card").first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    const runToday = await page.locator(".today-plan:not(.k-strength):not(.k-cross):not(.k-rest)").count();
    if (runToday) {
      await page.locator(".plan-shoes").first().waitFor({ timeout: 10_000 });
      console.log(`    today: ${await page.locator(".plan-shoes").first().innerText()}`);
    } else console.log(`    today: no run session (${await page.locator(".today-session h2").first().innerText().catch(() => "no plan")})`);
    await page.goto(base + "#activities");
    await page.locator(".groups .row", { hasText: /run/i }).first().click();
    await page.waitForSelector("dialog.sheet .run-shoes select", { timeout: 10_000 });
    console.log(`    Pegasus 41: ${km}; on the sheet: ${await page.locator("dialog.sheet .run-shoes select option:checked").innerText()}; Strava pair offered: ${(await push.count()) > 0}`);
    await page.keyboard.press("Escape");
  });
  await step("run-notes", async () => {
    // On a run's sheet: a win, a niggle (it asks where) and a note, each kept by itself (no Save).
    await page.goto(base + "#activities");
    await page.locator(".groups .row", { hasText: /run/i }).first().click();
    const card = page.locator("dialog.sheet .notes-card");
    await card.waitFor({ timeout: 10_000 });
    await card.locator('.note-tags .seg[data-tag="win"]').click();
    await card.locator('input[aria-label="Your note"]').fill("Negative split, felt easy");
    if (await card.locator('button:has-text("Save")').count()) throw new Error("there's still a Save button");
    // Done on the keyboard keeps it.
    await card.locator('input[aria-label="Your note"]').press("Enter");
    await card.locator(".run-note.t-win").waitFor({ timeout: 10_000 });
    await card.locator("details.more > summary", { hasText: "Add a note" }).click();
    await card.locator('.note-tags .seg[data-tag="niggle"]').click();
    await card.locator(".note-areas .area-btn", { hasText: "Calf" }).click();
    // Say it instead: a stand-in recognizer hears a long note, word by word (longer than the box).
    await page.evaluate(() => {
      class Fake {
        lang = "";
        interimResults = false;
        continuous = false;
        onresult: ((e: unknown) => void) | null = null;
        onerror: ((e: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          const say = (t: string, fin: boolean, at: number) => setTimeout(() => this.onresult?.({ results: [Object.assign([{ transcript: t }], { isFinal: fin })] }), at);
          say("tight on", false, 100);
          say("tight on the last hill", false, 250);
          say("tight on the last hill, eased off and it settled by the cool-down", false, 450);
          say("tight on the last hill, eased off and it settled by the cool-down", true, 1500);
          setTimeout(() => this.onend?.(), 1600);
        }
        stop() {
          this.onend?.();
        }
      }
      (globalThis as { webkitSpeechRecognition?: unknown; SpeechRecognition?: unknown }).webkitSpeechRecognition = Fake;
      (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = Fake;
    });
    const mic = card.locator(".mic-btn");
    await mic.waitFor({ timeout: 5_000 });
    await mic.click();
    await page.waitForFunction(() => (document.querySelector('dialog.sheet input[aria-label="Your note"]') as HTMLInputElement)?.value === "tight on the last hill, eased off and it settled by the cool-down", null, { timeout: 5_000 });
    console.log(`    spoken: ${await card.locator('input[aria-label="Your note"]').inputValue()}`);
    // A long note: the box follows the newest words, like a ticker.
    await page.waitForFunction(() => {
      const box = document.querySelector('dialog.sheet input[aria-label="Your note"]') as HTMLInputElement;
      return box.scrollWidth > box.clientWidth && box.scrollLeft >= box.scrollWidth - box.clientWidth - 2;
    }, null, { timeout: 3_000 }).catch(() => {
      throw new Error("the note box doesn't follow the words as they come");
    });
    if (out) await card.screenshot({ path: `${out}/note-spoken.png` });
    // Done speaking: kept by itself, and the keyboard stays closed.
    await card.locator(".run-note.t-niggle", { hasText: "Calf" }).waitFor({ timeout: 10_000 });
    if (!/settled by the cool-down/.test(await card.locator(".run-note.t-niggle").innerText())) throw new Error("the spoken words weren't kept with the niggle");
    if (await page.evaluate(() => document.activeElement?.matches('input[aria-label="Your note"]'))) throw new Error("the mic put the focus in the note box (opens the keyboard)");
    // Typed and the sheet closed: kept all the same.
    await card.locator("details.more > summary", { hasText: "Add a note" }).click();
    await card.locator('input[aria-label="Your note"]').fill("Windy on the way back");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog.sheet[open]"), null, { timeout: 5_000 });
    await page.locator(".groups .row", { hasText: /run/i }).first().click();
    await card.locator(".run-note.t-note", { hasText: "Windy on the way back" }).waitFor({ timeout: 10_000 });
    if (out) await card.screenshot({ path: `${out}/run-notes-card.png` });
    console.log(`    ${(await card.locator(".run-note").allInnerTexts()).map((t) => t.replace(/\s+/g, " ")).join(" | ")}`);
    await page.keyboard.press("Escape");
  });
  await step("backup-restore", async () => {
    // A passphrase, a backup, a wrong passphrase refused, then the real one restores.
    await page.goto(base + "#settings/more");
    const card = page.locator(".backup-card");
    await card.waitFor({ timeout: 10_000 });
    const pw = card.locator('input[type="password"]');
    await pw.nth(0).fill("ten lanes of track");
    await pw.nth(1).fill("ten lanes of track");
    await card.locator('button:has-text("Set passphrase")').click();
    const [download] = await Promise.all([page.waitForEvent("download"), card.locator('button:has-text("Back up now")').click()]);
    const file = `${out ?? "/tmp"}/backup.tartan`;
    await download.saveAs(file);
    const bytes = await Bun.file(file).bytes();
    if (new TextDecoder().decode(bytes.subarray(0, 8)) !== "TARTANBK") throw new Error("the download isn't a Tartan backup");
    await card.locator("summary", { hasText: "Restore from a backup" }).click();
    await card.locator('.restore-form input[type="file"]').setInputFiles(file);
    await card.locator('.restore-form input[type="password"]').fill("not the passphrase");
    await card.locator('.restore-form button:has-text("Restore")').click();
    await card.locator(".restore-form .field-error:not([hidden])", { hasText: "Wrong passphrase" }).waitFor({ timeout: 15_000 });
    await card.locator('.restore-form input[type="password"]').fill("ten lanes of track");
    await card.locator('.restore-form button:has-text("Restore")').click();
    await page.waitForFunction(() => /Restored \d+ files/.test(document.querySelector("#snack p")?.textContent ?? ""), null, { timeout: 20_000 });
    console.log(`    ${Math.round(bytes.length / 1024)} KB backup; ${await snack()}`);
    // Everything was in it: workouts, the plan, the coach, the lifts, not just the watch's files.
    const restored = Number(/Restored (\d+) files/.exec((await snack()) ?? "")?.[1] ?? 0);
    if (restored < 40) throw new Error(`only ${restored} files in the backup`);
    await page.waitForLoadState("load");
    await page.waitForTimeout(1500);
  });
  await step("reload-keeps-data", async () => {
    await page.goto(base + "#activities");
    await page.waitForSelector(".groups .row", { timeout: 10_000 });
    console.log(`    ${await page.locator(".groups .row").count()} activities after a reload`);
  });
} finally {
  await browser.close();
  http.stop(true);
  mock.stop();
  claude.stop();
}
if (pcCalls.length) errors.push(`the page called the PC API: ${pcCalls.slice(0, 3).join(", ")}`);
if (errors.length) {
  console.error(`problems:\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.log("phone mode: all good");

/** Just enough of the Claude Messages API (streaming, one tool round) with CORS, as the browser needs. */
function startMockClaude() {
  let browserHeader = false;
  let planRequest = "";
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  const sse = (events: object[]) =>
    new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", ...cors } });
  const start = { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };
  const end = (stop: string) => [{ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
  const text = (t: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, { type: "content_block_stop", index: 0 }];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      browserHeader ||= req.headers.get("anthropic-dangerous-direct-browser-access") === "true";
      const body = (await req.json()) as { messages: Array<{ content: unknown }>; stream?: boolean };
      const last = body.messages.at(-1)!.content;
      // A shoe photo to name (Settings → Training): a plain, non-streamed answer. (A photo in the chat streams.)
      if (!body.stream && Array.isArray(last) && last.some((b: { type: string }) => b.type === "image"))
        return Response.json({ id: "msg", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: '{"name": "Nike Pegasus 41", "kind": "daily"}' }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, { headers: cors });
      // The Plan tab's request names save_training_plan: answer with a plan.
      const planning = JSON.stringify(body.messages[0]!.content).includes("Write my training plan now");
      if (planning) planRequest = JSON.stringify(body.messages[0]!.content);
      if (Array.isArray(last) && last.some((b: { type: string }) => b.type === "tool_result")) return sse([start, ...text(planning ? "Your plan is ready: three runs a week, building to a long run on Sunday." : "You are doing well."), ...end("end_turn")]);
      const call = planning ? { name: "save_training_plan", input: JSON.stringify(demoPlan()) } : { name: "get_takeaways", input: "{}" };
      return sse([
        start,
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: call.name, input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: call.input } },
        { type: "content_block_stop", index: 0 },
        ...end("tool_use"),
      ]);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, sawBrowserHeader: () => browserHeader, lastPlanRequest: () => planRequest, stop: () => server.stop(true) };
}

/** Three weeks from this Monday: an easy run, intervals, a long run, a rest day, strength. */
function demoPlan() {
  const plan = demoPlanWeeks();
  // A run with steps today, whatever day it is, for the guided run (step guided-run). The run
  // recorded earlier today (step record-a-run) ticks off one session, so today has an easy run
  // for it first, then the tempo the guide follows.
  const t = today();
  const w0 = plan.weeks[0]!;
  {
    w0.sessions = w0.sessions.filter((x) => x.date !== t);
    w0.sessions.push({ date: t, kind: "easy", title: "Easy run", duration_min: 30, target: "Z2, 132-146 bpm" } as (typeof w0.sessions)[number]);
    w0.sessions.push({
      date: t, kind: "tempo", title: "Tempo", duration_min: 32, target: "4:55-5:05 /km",
      steps: [
        { steps: [{ kind: "warmup", duration_s: 600, hr: [125, 145] }] },
        { steps: [{ kind: "run", duration_s: 900, pace: [295, 305] }] },
        { steps: [{ kind: "cooldown", duration_s: 420, hr: [120, 140] }] },
      ],
    } as (typeof w0.sessions)[number]);
  }
  return plan;
}

function demoPlanWeeks() {
  const monday = mondayOf(today());
  const at = (week: number, d: number) => new Date(Date.parse(`${monday}T00:00:00Z`) + (week * 7 + d) * 86400_000).toISOString().slice(0, 10);
  return {
    title: "Build your 10k base",
    summary: "Three runs a week around your recent 25 km: easy aerobic running, one quality session and a long run that grows by a kilometre a week, then an easier week. It keeps your preferred Tuesday, Thursday and Sunday running schedule, with 30-minute gym sessions on Wednesdays and Fridays, and an easier week at the end to absorb the training load safely.",
    weeks: [0, 1, 2].map((w) => ({
      start: at(w, 0),
      focus: w === 2 ? "Easier week" : "Maintain a solid routine and mental ease while the long run grows",
      target_km: w === 2 ? 22 : 26 + w * 2,
      target_hours: w === 2 ? 2.5 : 3,
      sessions: [
        { date: at(w, 0), kind: "easy", title: "Easy run", duration_min: 45, distance_km: 8, target: "Z2, 132-146 bpm", notes: "Conversational pace; walk the hills if HR drifts above 150." },
        {
          date: at(w, 2), kind: "intervals", title: w === 2 ? "Strides" : "6 × 800 m", duration_min: 50, target: "4:35-4:45 /km, 2 min jog between",
          steps: [
            { steps: [{ kind: "warmup", duration_s: 900, hr: [130, 145] }] },
            { repeat: 6, steps: [{ kind: "run", distance_m: 800, hr: [165, 175] }, { kind: "recover", duration_s: 120, hr: [115, 135] }] },
            { steps: [{ kind: "cooldown", duration_s: 600, hr: [120, 140] }] },
          ],
        },
        { date: at(w, 3), kind: "strength", title: "Strength and mobility", duration_min: 30 },
        { date: at(w, 4), kind: "rest", title: "Rest" },
        { date: at(w, 6), kind: "long", title: "Long run", distance_km: 14 + w, duration_min: 85 + w * 6, target: "Z2, last 2 km steady" },
      ],
    })),
    advice: ["Keep the easy runs easy: below 146 bpm.", "Move the intervals, not the long run, if a week gets busy."],
    zones: [
      { name: "Easy", pace: "5:50-6:20 /km", heart_rate: "132-146 bpm (Z2)", use: "Easy runs and most of the long run" },
      { name: "Threshold", pace: "4:55-5:05 /km", heart_rate: "160-168 bpm (Z4)", use: "Tempo" },
      { name: "Interval", pace: "4:35-4:45 /km", use: "800 m repeats" },
    ],
  };
}
