/**
 * Screenshots of every screen (desktop 1440 and phone 390, light and dark) against a running
 * demo server. Uses the preinstalled Chromium at /opt/pw-browsers/chromium (cloud sessions).
 *   bun scripts/seed-demo.ts /tmp/fs-demo 5199 &   then   bun scripts/screenshots.ts .impeccable/review/rN
 */
import { chromium, type Page } from "playwright-core";
const out = process.argv[2]!; const base = "http://127.0.0.1:5199/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const errors: string[] = [];
async function page(w: number, h: number, scheme: "light" | "dark" = "light", reduced = false) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: reduced ? "reduce" : "no-preference" });
  p.on("pageerror", (e) => errors.push(`${w}${scheme}: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && errors.push(`${w}${scheme}: ${m.text()}`));
  return p;
}
const settle = (p: Page, ms = 2200) => p.waitForTimeout(ms);
const overflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
for (const scheme of ["light", "dark"] as const) {
  for (const [w, h, tag] of [[1440, 1000, "desktop"], [390, 844, "mobile"]] as const) {
    const p = await page(w, h, scheme, true);
    for (const v of ["today", "activities", "trends", "coach", "sync", "settings"]) {
      await p.goto(base + "#" + v); await settle(p, v === "today" || v === "trends" ? 1800 : 1000);
      if (scheme === "dark" && v !== "today" && v !== "trends") continue;
      await p.screenshot({ path: `${out}/${tag}-${scheme}-${v}.png`, fullPage: true });
      if (await overflow(p)) errors.push(`overflow ${tag} ${scheme} ${v}`);
    }
    if (scheme === "light") {
      await p.goto(base + "#coach"); await settle(p, 900);
      await p.click('button[aria-label="Conversations"]'); await settle(p, 500);
      await p.screenshot({ path: `${out}/${tag}-coach-history.png` });
      await p.click(".history .row"); await settle(p, 700);
      await p.screenshot({ path: `${out}/${tag}-coach-thread.png`, fullPage: true });
    }
    await p.goto(base + "#activities"); await settle(p, 1000);
    await p.click(".groups .row"); await settle(p, 1600);
    await p.screenshot({ path: `${out}/${tag}-${scheme}-sheet.png` });
    if (tag === "desktop") {
      await p.evaluate(() => document.querySelector("dialog.sheet")!.scrollTo(0, 99999)); await settle(p, 300);
      await p.screenshot({ path: `${out}/${tag}-${scheme}-sheet-bottom.png` });
    }
    await p.close();
  }
}
// hover tooltip + scrolled bar + motion mid-flight (no reduced motion)
const m = await page(1440, 1000); await m.goto(base + "#today"); await m.waitForTimeout(250);
await m.screenshot({ path: `${out}/motion-today-250ms.png` });
await m.waitForTimeout(2000);
const svgBox = await m.locator(".today-body .card .viz-svg").first().boundingBox();
if (svgBox) { await m.mouse.move(svgBox.x + svgBox.width * 0.7, svgBox.y + 60); await m.waitForTimeout(300); }
await m.screenshot({ path: `${out}/desktop-hover.png` });
await m.mouse.wheel(0, 500); await m.waitForTimeout(600);
await m.screenshot({ path: `${out}/desktop-scrolled.png` });
await m.evaluate(() => { document.querySelector('.lane[data-lane="strava"]')!.classList.add("running"); document.querySelector("#sync-all")!.classList.add("busy"); window.scrollTo(0, 0); });
await m.waitForTimeout(500);
await m.screenshot({ path: `${out}/desktop-running.png`, clip: { x: 0, y: 0, width: 1440, height: 560 } });
const mm = await page(390, 844); await mm.goto(base + "#today"); await mm.waitForTimeout(2200);
await mm.mouse.wheel(0, 400); await mm.waitForTimeout(600);
await mm.screenshot({ path: `${out}/mobile-scrolled.png` });
console.log("errors:", errors);
await browser.close();
