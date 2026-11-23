/** Folder-safe name for a watch ("Suunto Run 2 0042" → "Suunto-Run-2-0042"). Shared by server and app. */
export const slug = (name: string) =>
  name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "watch";

/** A sync moment shown on the freshness strip. */
export interface SyncEvent {
  /** ISO time. */
  at: string;
  lane: "watch" | "strava" | "agent";
  /** What happened, e.g. "backup", "sync", "list_activities". */
  kind: string;
  /** How many new items came in (files, activities), when that applies. */
  added?: number;
  ok?: boolean;
  detail?: string;
}
