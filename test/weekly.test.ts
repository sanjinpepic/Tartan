import { expect, test } from "bun:test";
import { reviewWeek } from "../web/lib/weekly.ts";

test("the weekly review runs from Sunday 5 pm for the coming week, or Monday and Tuesday for this one", () => {
  expect(reviewWeek(new Date(2026, 9, 18, 16, 59))).toBeNull(); // Sunday afternoon
  expect(reviewWeek(new Date(2026, 9, 18, 17, 0))).toBe("2026-10-19"); // Sunday evening: next week
  expect(reviewWeek(new Date(2026, 9, 19, 8))).toBe("2026-10-19"); // Monday
  expect(reviewWeek(new Date(2026, 9, 20, 22))).toBe("2026-10-19"); // Tuesday
  expect(reviewWeek(new Date(2026, 9, 21, 9))).toBeNull(); // Wednesday
  expect(reviewWeek(new Date(2026, 9, 25, 20))).toBe("2026-10-26"); // across a month end
  expect(reviewWeek(new Date(2026, 10, 1, 18))).toBe("2026-11-02");
});
