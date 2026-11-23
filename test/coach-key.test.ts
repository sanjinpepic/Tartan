/** A key is asked of its provider before it's saved: works, or why not. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Coach } from "../src/coach.ts";
import { MemoryDisk } from "../src/disk.ts";
import { Library } from "../src/library.ts";

let google: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  google = Bun.serve({
    port: 0,
    fetch(req) {
      const key = req.headers.get("x-goog-api-key") ?? new URL(req.url).searchParams.get("key");
      if (key !== "AIzaGoodKey-0123456789012345678901" && key !== "AQ.Ab8RN6Good_Key-0123456789abcdef") return Response.json({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }, { status: 400 });
      return Response.json({ models: [{ name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedActions: ["generateContent"] }, { name: "models/embedding-001", supportedActions: ["embedContent"] }] });
    },
  });
});
afterAll(() => google.stop(true));

test("a Gemini key: checked with Google; a wrong or half-pasted one is said plainly", async () => {
  const coach = new Coach(new Library(new MemoryDisk()), { googleBaseUrl: google.url.toString().replace(/\/$/, "") });
  expect(await coach.checkKey("google", "AIzaGoodKey-0123456789012345678901")).toEqual({ ok: true, models: 1 });
  // The newer key shape (AQ.…) goes to Google like any other.
  expect(await coach.checkKey("google", "AQ.Ab8RN6Good_Key-0123456789abcdef")).toEqual({ ok: true, models: 1 });
  expect((await coach.checkKey("google", "AQ.Ab8RN6Wrong_Key-0123456789abcd")).ok).toBe(false);
  expect(await coach.checkKey("google", "AQ.Ab8 RN6 has spaces 0123456789")).toMatchObject({ ok: false });
  const bad = await coach.checkKey("google", "AIzaWrongKey-012345678901234567890");
  expect(bad.ok).toBe(false);
  expect((bad as { error: string }).error).toMatch(/key/i);
  expect(await coach.checkKey("google", "sk-ant-123")).toMatchObject({ ok: false, error: expect.stringContaining("doesn't look like a Gemini key") });
  expect(await coach.checkKey("anthropic", "AIza123")).toMatchObject({ ok: false, error: expect.stringContaining("sk-ant-") });
  // Nothing was saved by checking.
  expect((await coach.status()).providers.find((p) => p.id === "google")!.keySource).toBeNull();
});
