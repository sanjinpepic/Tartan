/**
 * Send watch workouts to Strava (opt in, Settings → Sources). For people whose watch doesn't
 * reach Strava through the Suunto app. It runs when a watch sync has just saved new workouts,
 * never on a timer, and is careful so Strava never gets doubles:
 *  - only workouts that started after the switch was turned on (never a bulk upload of history);
 *  - only workouts Strava doesn't have: no Strava copy merged with it, checked again against a
 *    fresh Strava sync right before uploading;
 *  - one stable external id per workout, so a retry can't create a second copy.
 * What can't go yet (no upload permission, Strava down) is tried again at the next watch sync.
 * The file is a TCX built from the watch's own time series (GPS, altitude, distance, heart rate).
 */
import { sportFamily, type MergedActivity } from "./merge.ts";
import type { ActivityRow, Library } from "./library.ts";
import { syncStrava } from "./strava/sync.ts";
import { isImportFolder } from "./import.ts";
import { slug } from "./slug.ts";

const STATE = "watch-uploads.json";
const MAX_TRIES = 3;

export interface WatchUploadState {
  enabled: boolean;
  /** When it was turned on: older workouts are never sent. */
  since?: string;
  /** By watch copy key. */
  sent: Record<string, { status: "done" | "on-strava" | "skipped" | "error"; activity_id?: number; error?: string; tries?: number; at: string; name?: string; start?: string }>;
}

export interface WatchUploadResult {
  enabled: boolean;
  sent: number;
  /** Turned out to be on Strava already. */
  found: number;
  errors: string[];
  /** Why nothing could be sent at all (Strava not connected, no upload permission). */
  blocked?: string;
}

const STRAVA_SPORT: Record<string, string> = { run: "Run", ride: "Ride", walk: "Walk", swim: "Swim", ski: "NordicSki", paddle: "Kayaking" };
const TCX_SPORT: Record<string, string> = { run: "Running", ride: "Biking" };

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A TCX file from canonical streams (time in s from the start, distance m, latlng, altitude m, heartrate bpm). */
export function streamsToTcx(o: { start: string; sport: string; name?: string; columns: Record<string, unknown[]>; avgHr?: number; maxHr?: number; distanceM?: number; movingS?: number }): string {
  const c = o.columns;
  const time = (c.time ?? []) as number[];
  const t0 = Date.parse(o.start);
  const pts: string[] = [];
  let lastDist = 0;
  for (let i = 0; i < time.length; i++) {
    const t = num(time[i]);
    if (t === undefined) continue;
    const ll = c.latlng?.[i] as [number, number] | null | undefined;
    const alt = num(c.altitude?.[i]);
    const d = num(c.distance?.[i]);
    const hr = num(c.heartrate?.[i]);
    if (d !== undefined) lastDist = d;
    pts.push(
      `<Trackpoint><Time>${new Date(t0 + t * 1000).toISOString()}</Time>` +
        (ll && num(ll[0]) !== undefined && num(ll[1]) !== undefined ? `<Position><LatitudeDegrees>${ll[0].toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${ll[1].toFixed(7)}</LongitudeDegrees></Position>` : "") +
        (alt !== undefined ? `<AltitudeMeters>${alt.toFixed(1)}</AltitudeMeters>` : "") +
        (d !== undefined ? `<DistanceMeters>${d.toFixed(1)}</DistanceMeters>` : "") +
        (hr ? `<HeartRateBpm><Value>${Math.round(hr)}</Value></HeartRateBpm>` : "") +
        `</Trackpoint>`,
    );
  }
  // The lap carries the workout's own totals (the watch's summary), not just what the samples reach.
  const total = Math.max(num(time.at(-1)) ?? 0, o.movingS ?? 0);
  lastDist = Math.max(lastDist, o.distanceM ?? 0);
  const start = new Date(t0).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
<Activities><Activity Sport="${TCX_SPORT[sportFamily(o.sport)] ?? "Other"}"><Id>${start}</Id>
<Lap StartTime="${start}"><TotalTimeSeconds>${Math.round(total)}</TotalTimeSeconds><DistanceMeters>${lastDist.toFixed(1)}</DistanceMeters><Calories>0</Calories>${o.avgHr ? `<AverageHeartRateBpm><Value>${Math.round(o.avgHr)}</Value></AverageHeartRateBpm>` : ""}${o.maxHr ? `<MaximumHeartRateBpm><Value>${Math.round(o.maxHr)}</Value></MaximumHeartRateBpm>` : ""}<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>
<Track>
${pts.join("\n")}
</Track></Lap>
${o.name ? `<Notes>${esc(o.name)}</Notes>` : ""}
<Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Name>Suunto watch via Tartan</Name></Creator>
</Activity></Activities>
</TrainingCenterDatabase>
`;
}

/** A short, stable id per watch copy (Strava's external_id), so a retry is recognised as the same file. */
function externalId(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return `freesuunto-watch-${(h >>> 0).toString(36)}-${key.replace(/[^a-z0-9]+/gi, "").slice(-24)}`;
}

export class WatchToStrava {
  constructor(private readonly lib: Library) {}

  async state(): Promise<WatchUploadState> {
    return (await this.lib.strava.read<WatchUploadState>(STATE)) ?? { enabled: false, sent: {} };
  }

  private save(s: WatchUploadState): Promise<void> {
    return this.lib.strava.write(s, STATE);
  }

  /** Turn it on (from now on) or off. Turning it on again keeps the original start. */
  async setEnabled(on: boolean, now = new Date()): Promise<WatchUploadState> {
    const s = await this.state();
    s.enabled = on;
    if (on && !s.since) s.since = now.toISOString();
    await this.save(s);
    return s;
  }

  /** For Settings: on/off, since when, what was sent, what failed, and whether Strava allows uploads. */
  async status() {
    const s = await this.state();
    const client = await this.lib.strava.client();
    const entries = Object.values(s.sent).sort((a, b) => b.at.localeCompare(a.at));
    return {
      enabled: s.enabled,
      since: s.since,
      connected: !!client?.connected,
      can_upload: !!client?.canUpload,
      sent: entries.filter((e) => e.status === "done").length,
      last: entries.find((e) => e.status === "done") ?? null,
      errors: entries.filter((e) => e.status === "error").map((e) => ({ name: e.name, start: e.start, error: e.error })),
    };
  }

  /** Send what's due. Called after a watch sync saved new workouts; does nothing when nothing is due. */
  async run(now = Date.now()): Promise<WatchUploadResult> {
    const s = await this.state();
    const out: WatchUploadResult = { enabled: s.enabled, sent: 0, found: 0, errors: [] };
    if (!s.enabled || !s.since) return out;
    this.lib.invalidate(); // a watch sync just saved files: read them fresh

    const due = async () => {
      const rows = await this.lib.activities({ since: s.since });
      const list: Array<{ row: ActivityRow; key: string }> = [];
      for (const row of rows) {
        if (!row.sources.includes("watch") || row.sources.includes("strava") || Date.parse(row.start) < Date.parse(s.since!)) continue;
        const m = await this.lib.find(row.id);
        const key = m.members.find((x) => x.source === "watch")?.key;
        // Files imported by hand came from another app, which has its own way to Strava.
        if (!key || isImportFolder(key.slice(6, key.indexOf("/") >= 0 ? key.indexOf("/") : undefined))) continue;
        const prior = s.sent[key];
        if (prior && (prior.status !== "error" || (prior.tries ?? 0) >= MAX_TRIES)) continue;
        list.push({ row, key });
      }
      return list;
    };

    let todo = await due();
    if (!todo.length) return out;
    const client = await this.lib.strava.client();
    if (!client?.connected) return { ...out, blocked: "Strava isn't connected." };
    if (!client.canUpload) return { ...out, blocked: "Strava hasn't allowed uploads yet: tap Allow uploads on the Strava card." };

    // Right before sending: does Strava have them by now (the Suunto app may have uploaded)?
    await syncStrava(client, this.lib.strava).catch(() => undefined);
    this.lib.invalidate();
    const stillDue = new Set((await due()).map((x) => x.key));
    for (const t of todo) if (!stillDue.has(t.key)) {
      s.sent[t.key] = { status: "on-strava", at: new Date(now).toISOString(), name: t.row.name, start: t.row.start };
      out.found++;
    }
    todo = todo.filter((t) => stillDue.has(t.key));

    for (const { row, key } of todo) {
      const base = { at: new Date(now).toISOString(), name: row.name ?? row.sport, start: row.start };
      const m: MergedActivity = await this.lib.find(key);
      const raw = await this.lib.rawStreams(m).catch(() => null);
      if (!raw || raw.source !== "watch" || !(raw.columns.time?.length ?? 0)) {
        s.sent[key] = { ...base, status: "skipped", error: "no time series in the watch copy" };
        continue;
      }
      try {
        const res = await client.upload({
          data: streamsToTcx({
            start: row.start, sport: row.sport, name: row.name, columns: raw.columns, avgHr: row.avg_hr, maxHr: row.max_hr,
            distanceM: row.distance_km !== undefined ? row.distance_km * 1000 : undefined, movingS: row.moving_min !== undefined ? row.moving_min * 60 : undefined,
          }),
          dataType: "tcx",
          externalId: externalId(key),
          ...(row.name ? { name: row.name } : {}),
          sport: STRAVA_SPORT[sportFamily(row.sport)] ?? "Workout",
          description: "From my Suunto watch, via Tartan",
        });
        s.sent[key] = { ...base, status: "done", activity_id: res.activity_id };
        out.sent++;
      } catch (e) {
        const msg = (e as Error).message;
        s.sent[key] = { ...base, status: "error", error: msg, tries: (s.sent[key]?.tries ?? 0) + 1 };
        out.errors.push(`${base.name}: ${msg}`);
      }
    }
    await this.save(s);
    if (out.sent) this.lib.invalidate();
    return out;
  }
}
