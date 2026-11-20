/**
 * The note after a run, on the phone: when new data comes in, the engine is asked for runs of the
 * last day that haven't had their note (src/after-run.ts, claimed once each), and each is posted
 * as a notification on its own channel. Tapping it opens that workout. Phone only.
 */
import { app, isNative, log } from "../state.ts";

let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** A stable notification id per run (Android wants a 32-bit int). */
const notifId = (key: string) => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 2_000_000_000) + 1;
};

/** New data came in: look for new runs a moment later (several writes in a row ask once). */
export function afterRunSoon(ms = 3000): void {
  if (!isNative || localStorage.getItem("tartan.demo") === "1") return;
  clearTimeout(timer);
  timer = setTimeout(() => void noteNewRuns(), ms);
}

/** Post the note for each new run. Safe to call often: each run is claimed once, by the engine. */
export function noteNewRuns(): Promise<void> {
  if (!isNative || localStorage.getItem("tartan.demo") === "1") return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      try {
        await once();
      } catch (e) {
        log(`After a run: ${(e as Error).message}`);
      }
    } while (again);
  })().finally(() => (running = null));
  return running;
}

async function once(): Promise<void> {
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  // Without permission there's nowhere to show it: the runs are still claimed, so none piles up.
  const allowed = (await LocalNotifications.checkPermissions()).display === "granted";
  const online = navigator.onLine !== false;
  const res = await app.api.request(`/api/after-run${allowed && online ? "?coach=1" : ""}`);
  const { notes } = (await res.json()) as { notes: Array<{ id: string; title: string; text: string; by: string }> };
  if (!notes?.length || !allowed) return;
  await LocalNotifications.createChannel({ id: "tartan-runs", name: "After a run", description: "A short note from the coach when a new run comes in.", importance: 3, visibility: 1 }).catch(() => {});
  await LocalNotifications.schedule({
    notifications: notes.map((n) => ({
      id: notifId(`run:${n.id}`),
      title: n.title,
      body: n.text,
      largeBody: n.text,
      channelId: "tartan-runs",
      extra: { tartan: true, key: "run", activity: n.id },
    })),
  });
  log(`After a run: ${notes.length} note${notes.length > 1 ? "s" : ""} (${notes.map((n) => n.by).join(", ")}).`);
}
