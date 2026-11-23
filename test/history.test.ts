/** A long Gemini chat sends only what was said in its older exchanges. */
import { expect, test } from "bun:test";
import type { Content } from "@google/genai";
import { compactHistory } from "../src/coach/history.ts";

const big = "x".repeat(30_000);
/** One exchange: the athlete asks, the coach looks something up (a big answer), then says something. */
const exchange = (n: number): Content[] => [
  { role: "user", parts: [{ text: `Today is 2026-11-${10 + n}.` }, { text: `Question ${n}` }] },
  { role: "model", parts: [{ text: "thinking…", thought: true }, { functionCall: { id: `c${n}`, name: "get_training_summary", args: {} }, thoughtSignature: "sig" }] },
  { role: "user", parts: [{ functionResponse: { id: `c${n}`, name: "get_training_summary", response: { output: big } } }] },
  { role: "model", parts: [{ text: `Answer ${n}`, thoughtSignature: "sig2" }] },
];

test("under the budget nothing changes", () => {
  const c = exchange(1);
  expect(compactHistory(c)).toBe(false);
  expect(c).toEqual(exchange(1));
});

test("past it, older exchanges keep only the words; the last two stay whole", () => {
  const c = [...exchange(1), ...exchange(2), ...exchange(3), ...exchange(4)];
  expect(compactHistory(c)).toBe(true);
  expect(c.slice(0, 4)).toEqual([
    { role: "user", parts: [{ text: "Today is 2026-11-11." }, { text: "Question 1" }] },
    { role: "model", parts: [{ text: "Answer 1" }] },
    { role: "user", parts: [{ text: "Today is 2026-11-12." }, { text: "Question 2" }] },
    { role: "model", parts: [{ text: "Answer 2" }] },
  ]);
  expect(c.slice(4)).toEqual([...exchange(3), ...exchange(4)]);
  expect(JSON.stringify(c).length).toBeLessThan(JSON.stringify([...exchange(3), ...exchange(4)]).length + 500);
  // Roles still alternate.
  for (let i = 1; i < 4; i++) expect(c[i]!.role).not.toBe(c[i - 1]!.role);
  // Again: nothing more to shorten that way.
  expect(compactHistory(c)).toBe(false);
});

test("photos become a word; an exchange with no answer in words still alternates", () => {
  const c: Content[] = [
    { role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: big } }, { text: "What shoe is this?" }] },
    { role: "model", parts: [{ functionCall: { name: "get_shoes", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "get_shoes", response: { output: big } } }] },
    ...exchange(2),
    ...exchange(3),
  ];
  expect(compactHistory(c)).toBe(true);
  expect(c.slice(0, 2)).toEqual([
    { role: "user", parts: [{ text: "[a photo]" }, { text: "What shoe is this?" }] },
    { role: "model", parts: [{ text: "(no answer)" }] },
  ]);
});
