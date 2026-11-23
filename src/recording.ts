/**
 * Runs recorded on the phone: GPS points (and heart rate when a sensor is connected), kept in
 * recordings/<id>.json, summarised the same way as other sources, and exported as TCX for
 * Strava's upload API. Once Strava has the uploaded copy, merging makes it one workout.
 */
import { joinPath, readJson, type Disk } from "./disk.ts";

export interface RecordedPoint {
  /** Milliseconds since the epoch. */
  t: number;
  lat: number;
  lon: number;
  alt?: number | null;
  /** Horizontal accuracy, metres. */
  acc?: number;
  hr?: number;
}

export interface Recording {
  id: string;
  sport: string;
  name?: string;
  /** ISO start. */
  start: string;
  end?: string;
  points: RecordedPoint[];
  /** Heart rate readings without a position (a sensor sends more often than GPS). */
  hr?: Array<{ t: number; bpm: number }>;
  /** Paused stretches, epoch ms. */
  pauses: Array<{ from: number; to?: number }>;
  strava?: { upload_id?: number; activity_id?: number; status: "uploading" | "done" | "error"; error?: string; at: string };
  /** A guided run (src/workout/guided.ts): the plan's session and where the guide got to. */
  guide?: { date: string; kind: string; name: string; state: import("./workout/guided.ts").GuideState };
  /** Where each lap began after the first (epoch ms): a guided run's steps. Strava shows them as laps. */
  laps?: number[];
}

export interface RecordingSummary {
  id: string;
  sport: string;
  name?: string;
  start: string;
  end?: string;
  distance_m: number;
  moving_s: number;
  elapsed_s: number;
  elevation_m: number;
  avg_hr?: number;
  max_hr?: number;
  points: number;
  strava?: Recording["strava"];
}

const DIR = "recordings";
/** Fixes worse than this are too vague to count towards distance. */
const MAX_ACCURACY_M = 35;
/** Faster than this between two fixes is a GPS jump, not running. */
const MAX_SPEED_MS = 12;

/** Metres between two coordinates (haversine). */
export function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const paused = (r: Recording, t: number) => r.pauses.some((p) => t >= p.from && (p.to === undefined || t < p.to));

/** The usable track: accurate fixes, no jumps, nothing while paused; with running distance. */
export function track(r: Recording): Array<RecordedPoint & { d: number }> {
  const out: Array<RecordedPoint & { d: number }> = [];
  let d = 0;
  let prev: RecordedPoint | null = null;
  for (const p of r.points) {
    if ((p.acc ?? 0) > MAX_ACCURACY_M || paused(r, p.t)) continue;
    if (prev) {
      const step = metres(prev.lat, prev.lon, p.lat, p.lon);
      const dt = (p.t - prev.t) / 1000;
      if (dt <= 0) continue;
      // A resumed run starts a new segment: don't draw distance across the pause.
      const acrossPause = r.pauses.some((x) => x.to !== undefined && x.from >= prev!.t && x.to <= p.t);
      if (!acrossPause) {
        if (step / dt > MAX_SPEED_MS) continue;
        d += step;
      }
    }
    out.push({ ...p, d });
    prev = p;
  }
  return out;
}

/** Heart rate nearest to a moment (within 5 s), from the points or the separate sensor readings. */
function hrAt(r: Recording, t: number): number | undefined {
  let best: { bpm: number; dt: number } | undefined;
  for (const h of r.hr ?? []) {
    const dt = Math.abs(h.t - t);
    if (dt <= 5000 && (!best || dt < best.dt)) best = { bpm: h.bpm, dt };
  }
  return best?.bpm;
}

export function summarize(r: Recording): RecordingSummary {
  const tr = track(r);
  const startT = Date.parse(r.start);
  const endT = r.end ? Date.parse(r.end) : (r.points.at(-1)?.t ?? startT);
  const pausedMs = r.pauses.reduce((n, p) => n + ((p.to ?? endT) - p.from), 0);
  let climb = 0;
  for (let i = 1; i < tr.length; i++) {
    const a = tr[i - 1]!.alt;
    const b = tr[i]!.alt;
    if (a != null && b != null && b - a > 0.5) climb += b - a;
  }
  const hrs = [...(r.hr ?? []).map((h) => h.bpm), ...r.points.map((p) => p.hr).filter((x): x is number => !!x)];
  return {
    id: r.id,
    sport: r.sport,
    name: r.name,
    start: r.start,
    end: r.end,
    distance_m: Math.round(tr.at(-1)?.d ?? 0),
    moving_s: Math.max(0, Math.round((endT - startT - pausedMs) / 1000)),
    elapsed_s: Math.max(0, Math.round((endT - startT) / 1000)),
    elevation_m: Math.round(climb),
    avg_hr: hrs.length ? Math.round(hrs.reduce((n, x) => n + x, 0) / hrs.length) : undefined,
    max_hr: hrs.length ? Math.max(...hrs) : undefined,
    points: r.points.length,
    strava: r.strava,
  };
}

/** Time series in the library's channel names (time from start in s, distance in m). */
export function streams(r: Recording): Record<string, unknown[]> | null {
  const tr = track(r);
  if (tr.length < 2) return null;
  const t0 = Date.parse(r.start);
  const cols: Record<string, unknown[]> = {
    time: tr.map((p) => Math.round((p.t - t0) / 1000)),
    distance: tr.map((p) => Math.round(p.d * 10) / 10),
    latlng: tr.map((p) => [p.lat, p.lon]),
  };
  if (tr.some((p) => p.alt != null)) cols.altitude = tr.map((p) => p.alt ?? null);
  const hr = tr.map((p) => p.hr ?? hrAt(r, p.t) ?? null);
  if (hr.some((x) => x !== null)) cols.heartrate = hr;
  cols.velocity = tr.map((p, i) => {
    const j = Math.max(0, i - 5); // ~5 fixes back smooths GPS jitter
    const dt = (p.t - tr[j]!.t) / 1000;
    return dt > 0 ? Math.round(((p.d - tr[j]!.d) / dt) * 100) / 100 : null;
  });
  return cols;
}

/** Speed over the last `window_s` seconds of the track (m/s); 0 without two fixes in it. */
export function speedNow(tr: Array<{ t: number; d: number }>, window_s = 30): number {
  const last = tr.at(-1);
  if (!last) return 0;
  const recent = tr.filter((p) => p.t >= last.t - window_s * 1000);
  const first = recent[0]!;
  return recent.length > 1 && last.t > first.t ? (last.d - first.d) / ((last.t - first.t) / 1000) : 0;
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Garmin TCX, which Strava's upload API accepts (data_type "tcx"). */
export function toTcx(r: Recording): string {
  const s = summarize(r);
  const tr = track(r);
  const sport = /run|jog|trail/i.test(r.sport) ? "Running" : /ride|cycl|bik/i.test(r.sport) ? "Biking" : "Other";
  const point = (p: (typeof tr)[number]) => {
    const hr = p.hr ?? hrAt(r, p.t);
    return (
      `<Trackpoint><Time>${new Date(p.t).toISOString()}</Time>` +
      `<Position><LatitudeDegrees>${p.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${p.lon.toFixed(7)}</LongitudeDegrees></Position>` +
      (p.alt != null ? `<AltitudeMeters>${p.alt.toFixed(1)}</AltitudeMeters>` : "") +
      `<DistanceMeters>${p.d.toFixed(1)}</DistanceMeters>` +
      (hr ? `<HeartRateBpm><Value>${Math.round(hr)}</Value></HeartRateBpm>` : "") +
      `</Trackpoint>`
    );
  };
  // One lap, or one per guided step (each from its start to the next one's).
  const endT = r.end ? Date.parse(r.end) : (tr.at(-1)?.t ?? Date.parse(r.start));
  const starts = [Date.parse(r.start), ...(r.laps ?? []).filter((t) => t > Date.parse(r.start) && t < endT).sort((a, b) => a - b)];
  const laps = starts.map((from, i) => {
    const to = starts[i + 1] ?? endT + 1;
    const own = tr.filter((p) => p.t >= from && p.t < to);
    const paused = r.pauses.reduce((n, x) => n + Math.max(0, Math.min(x.to ?? endT, to) - Math.max(x.from, from)), 0);
    const time = starts.length === 1 ? s.moving_s : Math.max(0, Math.round((Math.min(to, endT) - from - paused) / 1000));
    const dist = starts.length === 1 ? s.distance_m : Math.round(own.length ? own.at(-1)!.d - (tr.filter((p) => p.t < from).at(-1)?.d ?? own[0]!.d) : 0);
    const hrs = own.map((p) => p.hr ?? hrAt(r, p.t)).filter((x): x is number => !!x);
    const avg = starts.length === 1 ? s.avg_hr : hrs.length ? Math.round(hrs.reduce((n, x) => n + x, 0) / hrs.length) : undefined;
    const max = starts.length === 1 ? s.max_hr : hrs.length ? Math.max(...hrs) : undefined;
    return `<Lap StartTime="${new Date(from).toISOString()}"><TotalTimeSeconds>${time}</TotalTimeSeconds><DistanceMeters>${dist}</DistanceMeters><Calories>0</Calories>${avg ? `<AverageHeartRateBpm><Value>${avg}</Value></AverageHeartRateBpm>` : ""}${max ? `<MaximumHeartRateBpm><Value>${max}</Value></MaximumHeartRateBpm>` : ""}<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>
<Track>
${own.map(point).join("\n")}
</Track></Lap>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
<Activities><Activity Sport="${sport}"><Id>${r.start}</Id>
${laps.join("\n")}
<Notes>${esc(r.name ?? "")}</Notes>
<Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Name>Tartan (phone)</Name></Creator>
</Activity></Activities>
</TrainingCenterDatabase>
`;
}

/** recordings/<id>.json on the data disk. */
export class RecordingStore {
  constructor(readonly disk: Disk) {}

  private path(id: string): string {
    if (!/^[a-z0-9-]{6,40}$/i.test(id)) throw new Error(`refusing recording id ${id}`);
    return joinPath(DIR, `${id}.json`);
  }

  get(id: string): Promise<Recording | null> {
    return readJson<Recording>(this.disk, this.path(id));
  }

  async put(r: Recording): Promise<void> {
    await this.disk.write(this.path(r.id), JSON.stringify(r));
  }

  async remove(id: string): Promise<void> {
    // Disks have no delete: an empty marker hides it everywhere.
    await this.disk.write(this.path(id), "null");
  }

  async all(): Promise<Recording[]> {
    const out: Recording[] = [];
    for (const e of await this.disk.list(DIR)) {
      if (!e.name.endsWith(".json")) continue;
      const r = await readJson<Recording>(this.disk, joinPath(DIR, e.name));
      if (r?.points) out.push(r);
    }
    return out.sort((a, b) => b.start.localeCompare(a.start));
  }
}
