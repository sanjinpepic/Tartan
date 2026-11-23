/**
 * What the sync board shows: for the watch and for Strava, when each last came in, whether a
 * round is running, and the last failure in plain words. Automatic rounds report here, so a
 * failure turns its lane amber instead of disappearing into the log.
 */
export type Lane = "watch" | "strava";
export interface LaneState {
  /** Last round that worked (ms). */
  ok: number | null;
  /** Last failure since then, in plain words, with what to try. */
  error: { at: number; text: string; fix?: string } | null;
  running: boolean;
}

const KEY = "freesuunto.lanes";
const blank = (): LaneState => ({ ok: null, error: null, running: false });
let lanes: Record<Lane, LaneState> = { watch: blank(), strava: blank() };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Record<Lane, Partial<LaneState>>> | null;
  for (const l of ["watch", "strava"] as const) lanes[l] = { ...blank(), ...saved?.[l], running: false };
} catch {
  // no storage: the board starts empty
}

const subs = new Set<(l: Record<Lane, LaneState>) => void>();
function emit(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lanes));
  } catch {
    // no storage: the board still updates
  }
  for (const f of subs) f(lanes);
}

export const getLanes = () => lanes;
export function onLanes(f: (l: Record<Lane, LaneState>) => void): () => void {
  subs.add(f);
  f(lanes);
  return () => subs.delete(f);
}

export function laneRunning(l: Lane, running: boolean): void {
  lanes = { ...lanes, [l]: { ...lanes[l], running } };
  emit();
}
export function laneOk(l: Lane, at = Date.now()): void {
  lanes = { ...lanes, [l]: { ...lanes[l], ok: Math.max(at, lanes[l].ok ?? 0), error: null, running: false } };
  emit();
}
export function laneFailed(l: Lane, e: unknown): void {
  lanes = { ...lanes, [l]: { ...lanes[l], error: { at: Date.now(), ...plainSyncError(l, e) }, running: false } };
  emit();
}
/** A time from elsewhere (Strava's own last sync, the watch's last read) when it's newer than ours. */
export function laneSeen(l: Lane, at: number | null | undefined): void {
  if (!at || at <= (lanes[l].ok ?? 0)) return;
  lanes = { ...lanes, [l]: { ...lanes[l], ok: at } };
  emit();
}

/** "now", "4m", "2h", "3d": short enough for the board. */
export function sinceShort(at: number | null, now = Date.now()): string {
  if (!at) return "–";
  const m = Math.round((now - at) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

/**
 * A sync failure as the board says it: what happened and what to try. The raw message stays in
 * the log; it means something to a developer, not to someone back from a run.
 */
export function plainSyncError(l: Lane, e: unknown): { text: string; fix?: string } {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  if (l === "strava") {
    if (/rate.?limit|429|too many/.test(m)) return { text: "Strava asked Tartan to slow down.", fix: "It picks up by itself in 15 minutes." };
    if (/401|unauthori[sz]ed|invalid.?grant|token|sign.?in|not connected/.test(m)) return { text: "Strava wants you to sign in again.", fix: "Settings → Sources → Strava → Connect." };
    // Android didn't trust the certificate it was shown: something between the phone and Strava
    // (a Wi-Fi sign-in page, a VPN or ad blocker that inspects secure traffic) answered instead.
    if (/trust anchor|certpath|certificate|ssl|handshake/.test(m)) return { text: "The phone couldn't trust the connection to Strava.", fix: "A Wi-Fi sign-in page, or a VPN or ad blocker that checks secure traffic, may be in the way. Try on mobile data." };
    if (/fetch|network|offline|timed? ?out|econn|enotfound|abort/.test(m)) return { text: "Couldn't reach Strava.", fix: "Check the connection; Tartan tries again when you next open it." };
    return { text: "Strava didn't answer as expected.", fix: "Try again in a minute. The details are in Settings → More → Log." };
  }
  if (/bluetooth.*(off|disabled|unavailable)|adapter|not enabled/.test(m)) return { text: "Bluetooth is off.", fix: "Turn it on and try again." };
  if (/permission|denied|not allowed/.test(m)) return { text: "Tartan isn't allowed to use Bluetooth.", fix: "Allow Nearby devices for Tartan in Android's settings." };
  if (/not found|no device|scan|out of range|timed? ?out|timeout|didn't answer|no answer/.test(m)) return { text: "Couldn't find the watch.", fix: "Keep it close and awake, and close the Suunto app if it's open (it holds the watch's Bluetooth). Then try again." };
  if (/busy|in use|another|being set up/.test(m)) return { text: "The watch is busy with something else.", fix: "Try again in a moment." };
  if (/disconnect|gatt|lost|closed/.test(m)) return { text: "The watch dropped the connection.", fix: "Try again with the watch close by." };
  return { text: "The watch sync didn't finish.", fix: "Try again. The details are in Settings → More → Log." };
}
