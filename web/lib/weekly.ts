/** When the weekly review runs (web/sync.ts), and its switch. */

/** localStorage: "1" when the weekly review is switched off (Settings → Coach). */
export const WEEKLY_OFF = "freesuunto.weekly.off";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The week the review is for: from Sunday 5 pm the coming one; on Monday and Tuesday (when
 * Sunday was missed) the one under way; otherwise none.
 */
export function reviewWeek(now = new Date()): string | null {
  const day = now.getDay();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((day + 6) % 7));
  if (day === 0) return now.getHours() >= 17 ? iso(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7)) : null;
  return day === 1 || day === 2 ? iso(monday) : null;
}
