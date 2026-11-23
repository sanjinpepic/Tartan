/**
 * The sync board's model (the engine's part): which sources have a lane (the watch once one is
 * paired or has been read, Strava once connected), and each lane's state, its short time, its
 * line in words. web/app.ts draws it as the chip; native Today draws it from shellBoard.
 */
import { ago } from "./dom.ts";
import { getLanes, laneSeen, onLanes, sinceShort, type Lane } from "./lanes.ts";
import { isNative } from "../state.ts";
import { stravaStatus, syncStravaNow, syncWatchNow } from "../sync.ts";
import * as watch from "../watch.ts";

export const BOARD: Record<Lane, { name: string; icon: string; idle: string; sync: () => Promise<void> }> = {
  watch: { name: "Watch", icon: "watch", idle: "Not read yet. Pair it in Settings → Sources.", sync: syncWatchNow },
  strava: { name: "Strava", icon: "strava", idle: "Not synced yet.", sync: syncStravaNow },
};

let stravaOn = false;
let watchOn = false;
export const boardLanes = (): Lane[] => [...(watchOn ? (["watch"] as const) : []), ...(stravaOn ? (["strava"] as const) : [])];

export interface LaneModel {
  id: Lane;
  /** busy, fail, on (the watch connected), ok. */
  state: string;
  busy: boolean;
  failed: boolean;
  /** The chip's few characters: "···", "on", "5m". */
  text: string;
  glyph: string;
  name: string;
  /** The board's line: when, or what went wrong and what to try. */
  status: string;
  /** For a screen reader: "Strava: synced 5 min ago". */
  said: string;
}

export function boardModel(): LaneModel[] {
  const lanes = getLanes();
  const w = watch.getState();
  return boardLanes().map((id) => {
    const s = lanes[id];
    const busy = s.running || (id === "watch" && !!(w.job || w.connecting));
    const on = id === "watch" && w.connected;
    const state = busy ? "busy" : s.error ? "fail" : on ? "on" : "ok";
    const failed = !!s.error && !busy;
    return {
      id,
      state,
      busy,
      failed,
      text: busy ? "···" : on && !s.error ? "on" : sinceShort(s.ok),
      glyph: failed ? "warn" : BOARD[id].icon,
      name: BOARD[id].name,
      status: busy ? "Syncing now…" : s.error ? `${s.error.text}${s.error.fix ? ` ${s.error.fix}` : ""} · ${ago(new Date(s.error.at))}` : on ? `Connected${s.ok ? `, synced ${ago(new Date(s.ok))}` : ""}` : s.ok ? `Synced ${ago(new Date(s.ok))}` : BOARD[id].idle,
      said: `${BOARD[id].name}: ${busy ? "syncing" : s.error ? s.error.text.replace(/\.$/, "") : on ? "connected" : s.ok ? `synced ${ago(new Date(s.ok))}` : "not synced yet"}`,
    };
  });
}

/** Follow the board: `changed` runs whenever a lane changes, a source joins, and every minute ("5m" moves). */
export function followBoard(changed: () => void): void {
  const lookAround = async () => {
    const last = watch.lastSync();
    laneSeen("watch", last ? Date.parse(last.at) : null);
    watchOn = !!last || (isNative && (await watch.knowsPairedWatch().catch(() => false)));
    const st = await stravaStatus();
    stravaOn = !!st?.connected;
    laneSeen("strava", st?.lastSync ? Date.parse(st.lastSync) : null);
    changed();
  };
  watch.onWatch(() => {
    if (watch.lastSync() && !watchOn) watchOn = true;
    changed();
  });
  onLanes(() => changed());
  void lookAround();
  setInterval(changed, 60_000);
  // A source connected in Settings joins on the next screen change.
  window.addEventListener("hashchange", () => void lookAround());
}
