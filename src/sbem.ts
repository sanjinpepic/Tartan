/**
 * SBEM, the binary format the Suunto Run 2 hands workouts over in (/Logbook/byId/{id}/Summary
 * and /Data). Recovered from one real workout (docs/run2-resources.md):
 *
 *   "SBEM0103" | chunk* ;  chunk = id u8 | len u8 (0xff: then len u32) | len bytes
 *
 * Summary: one 0x22 chunk per lap/window (405 bytes on the Run 2), then a 0x20 chunk with the
 * workout: end time @0, start time @8 (8-byte times), duration ms u32 @16, … the sport name as
 * text near the end ("Running"). Times are watch-local milliseconds in the low 6 bytes and the
 * watch's UTC offset in 15-minute steps in the last byte.
 *
 * Only what the sample proves is decoded; distance, heart rate and the samples in Data need a
 * longer workout (and /Logbook/byId/{id}/Descriptors) to map.
 */

export interface SbemChunk {
  id: number;
  data: Uint8Array;
}

export function parseSbem(b: Uint8Array): { version: string; chunks: SbemChunk[] } | null {
  if (b.length < 8 || new TextDecoder().decode(b.subarray(0, 4)) !== "SBEM") return null;
  const version = new TextDecoder().decode(b.subarray(4, 8));
  const chunks: SbemChunk[] = [];
  let at = 8;
  while (at + 2 <= b.length) {
    const id = b[at]!;
    let len = b[at + 1]!;
    at += 2;
    if (len === 0xff) {
      if (at + 4 > b.length) break;
      len = (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
      at += 4;
    }
    if (at + len > b.length) break;
    chunks.push({ id, data: b.subarray(at, at + len) });
    at += len;
  }
  return { version, chunks };
}

/** An 8-byte SBEM time: watch-local ms in bytes 0–5, UTC offset in 15-minute steps in byte 7. */
export function sbemTime(b: Uint8Array, at: number): { utc: number; offsetMin: number } | null {
  if (at + 8 > b.length) return null;
  let local = 0;
  for (let i = 5; i >= 0; i--) local = local * 256 + b[at + i]!;
  if (!local) return null;
  const offsetMin = ((b[at + 7]! << 24) >> 24) * 15;
  return { utc: local - offsetMin * 60_000, offsetMin };
}

export interface SbemWorkout {
  /** UTC ms. */
  start: number;
  end: number;
  duration_s: number;
  /** The watch's UTC offset when it recorded, minutes. */
  offsetMin: number;
  sport: string;
  laps: number;
}

/** The workout in a logbook Summary: its 0x20 chunk, and the 0x22 laps before it. */
export function sbemSummary(b: Uint8Array): SbemWorkout | null {
  const f = parseSbem(b);
  const w = f?.chunks.find((c) => c.id === 0x20);
  if (!f || !w || w.data.length < 20) return null;
  const end = sbemTime(w.data, 0);
  const start = sbemTime(w.data, 8);
  if (!start) return null;
  const ms = (w.data[16]! | (w.data[17]! << 8) | (w.data[18]! << 16) | (w.data[19]! << 24)) >>> 0;
  // The sport name: the last run of letters (≥ 3) in the chunk.
  const words = new TextDecoder("latin1").decode(w.data).match(/[A-Za-z][A-Za-z ]{2,}/g) ?? [];
  return {
    start: start.utc,
    end: end?.utc ?? start.utc + ms,
    duration_s: Math.round(ms / 1000),
    offsetMin: start.offsetMin,
    sport: words.at(-1)?.trim() || "unknown",
    laps: f.chunks.filter((c) => c.id === 0x22).length,
  };
}

// ---------------------------------------------------------------- descriptors

/**
 * The descriptors (/Logbook/byId/{id}/Descriptors) are SBEM too: chunks of id 0, each a u16
 * descriptor id and text lines. An item is `<PTH>path` + `<FRM>format[,precision=..][,nillable=..]`
 * (+ `<MOD>x/60,y*60`: raw → SI unit, and back). `<DELTAREF>n` + `<FRM>dint8`: a difference to
 * item n's last value. A group is `<GRP>a,b,c`: a data chunk with that id holds those items'
 * values back to back. Trailing items may be left off when there is nothing to report.
 */
export interface SbemItem {
  id: number;
  path?: string;
  /** Base format: local64, uint8 … float32, utf8, enum, bool, d0, dint8 … */
  format: string;
  enumValues?: Record<number, string>;
  nillable?: number;
  deltaRef?: number;
  mod?: (x: number) => number;
  group?: number[];
}

const SIZE: Record<string, number> = {
  local64: 8, uint8: 1, int8: 1, bool: 1, enum: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4,
  uint64: 8, int64: 8, float64: 8, d0: 0, dint8: 1, duint8: 1, dint16: 2, duint16: 2, dint32: 4, duint32: 4,
};

/** `x/60` style unit formulas from the watch: numbers, x, PI and arithmetic only. */
function modFn(expr: string): ((x: number) => number) | undefined {
  const e = expr.trim();
  if (!e || !/^[\sx0-9.+\-*/()^PI]+$/.test(e) || /[A-Za-z]/.test(e.replace(/PI|x/g, ""))) return undefined;
  try {
    // eslint-disable-next-line no-new-func -- whitelisted to arithmetic on x above
    return new Function("x", `"use strict"; return (${e.replace(/PI/g, "Math.PI").replace(/\^/g, "**")});`) as (x: number) => number;
  } catch {
    return undefined;
  }
}

export function parseDescriptors(b: Uint8Array): Map<number, SbemItem> {
  const out = new Map<number, SbemItem>();
  for (const c of parseSbem(b)?.chunks ?? []) {
    if (c.id !== 0 || c.data.length < 3) continue;
    const id = c.data[0]! | (c.data[1]! << 8);
    const tags: Record<string, string> = {};
    for (const line of new TextDecoder().decode(c.data.subarray(2)).replace(/\0+$/, "").split("\n")) {
      const m = /^<(\w+)>(.*)$/.exec(line.trim());
      if (m) tags[m[1]!] = m[2]!;
    }
    if (tags.GRP !== undefined) {
      out.set(id, { id, format: "group", group: tags.GRP.split(",").map(Number).filter((n) => Number.isFinite(n)) });
      continue;
    }
    const [fmt = "", ...opts] = (tags.FRM ?? "").split(",");
    const item: SbemItem = { id, path: tags.PTH, format: fmt.startsWith("enum") ? "enum" : fmt };
    if (fmt.startsWith("enum:")) {
      item.enumValues = {};
      for (const kv of [fmt.slice(5), ...opts].join(",").split(",")) {
        const [k, v] = kv.split("=");
        if (k !== undefined && v !== undefined && /^\d+$/.test(k)) item.enumValues[Number(k)] = v;
      }
    }
    for (const o of opts) if (o.startsWith("nillable=")) item.nillable = Number(o.slice(9));
    if (tags.DELTAREF !== undefined) item.deltaRef = Number(tags.DELTAREF);
    if (tags.MOD) item.mod = modFn(tags.MOD.split(",")[0]!);
    out.set(id, item);
  }
  return out;
}

// ---------------------------------------------------------------- records

export type SbemValue = number | string | boolean | null;
/** One data chunk decoded: path → value (SI units after <MOD>), and its group id. */
export interface SbemRecord {
  group: number;
  /** Watch-local ms of this record, when it carries a time. */
  time?: number;
  offsetMin?: number;
  values: Record<string, SbemValue>;
}

function readNum(fmt: string, b: Uint8Array, at: number): number {
  const v = new DataView(b.buffer, b.byteOffset + at);
  switch (fmt) {
    case "uint8": case "bool": case "enum": case "duint8": return v.getUint8(0);
    case "int8": case "dint8": return v.getInt8(0);
    case "uint16": case "duint16": return v.getUint16(0, true);
    case "int16": case "dint16": return v.getInt16(0, true);
    case "uint32": case "duint32": return v.getUint32(0, true);
    case "int32": case "dint32": return v.getInt32(0, true);
    case "float32": return v.getFloat32(0, true);
    case "float64": return v.getFloat64(0, true);
    case "uint64": case "int64": return Number(v.getBigUint64(0, true));
    default: return 0;
  }
}

/**
 * Decode every chunk of a Summary or Data file with its descriptors. Deltas are chained: an
 * item with <DELTAREF>n adds to item n's last raw value, which it then becomes.
 */
export function decodeSbem(b: Uint8Array, descriptors: Map<number, SbemItem>): SbemRecord[] {
  const last = new Map<number, number>();
  const lastOffset = new Map<number, number>();
  const out: SbemRecord[] = [];
  for (const c of parseSbem(b)?.chunks ?? []) {
    const g = descriptors.get(c.id)?.group;
    if (!g) continue;
    const rec: SbemRecord = { group: c.id, values: {} };
    let at = 0;
    for (const itemId of g) {
      const item = descriptors.get(itemId);
      if (!item || at >= c.data.length) break; // trailing items left off
      const fmt = item.format;
      let size = SIZE[fmt];
      if (fmt === "utf8") {
        const end = c.data.indexOf(0, at);
        size = (end < 0 ? c.data.length : end) - at + 1;
      }
      if (size === undefined || at + size > c.data.length) break;
      // Where the value belongs: a delta item writes into its reference's chain and path.
      const ref = item.deltaRef !== undefined ? descriptors.get(item.deltaRef) : undefined;
      const target = ref ?? item;
      const path = target.path ?? `#${target.id}`;
      let value: SbemValue;
      if (fmt === "utf8") value = new TextDecoder().decode(c.data.subarray(at, at + size - 1));
      else if (fmt === "local64") {
        const t = sbemTime(c.data, at);
        value = t ? t.utc + t.offsetMin * 60_000 : null;
        if (t) {
          last.set(item.id, value as number);
          lastOffset.set(item.id, t.offsetMin);
        }
      } else if (item.deltaRef !== undefined) {
        const prev = last.get(item.deltaRef);
        if (prev === undefined) value = null;
        else {
          const raw = fmt === "d0" ? prev : prev + readNum(fmt, c.data, at);
          last.set(item.deltaRef, raw);
          value = ref?.format === "local64" ? raw : finish(ref ?? item, raw);
        }
      } else {
        const raw = readNum(fmt, c.data, at);
        last.set(item.id, raw);
        value = finish(item, raw);
      }
      if (ref?.format === "local64" || fmt === "local64") {
        // Times: the record's own clock when the path is the timeline's.
        if (/TimeISO8601$/.test(path) && typeof value === "number") {
          rec.time = value;
          rec.offsetMin = lastOffset.get(item.deltaRef ?? item.id) ?? lastOffset.get(item.id);
        }
      }
      if (!(path in rec.values) || rec.values[path] === null) rec.values[path] = value;
      at += size;
    }
    out.push(rec);
  }
  return out;
}

function finish(item: SbemItem, raw: number): SbemValue {
  if (item.nillable !== undefined && raw === item.nillable) return null;
  if (item.format === "float32" && (Number.isNaN(raw) || raw === -16000000)) return null;
  if (item.format === "bool") return raw !== 0;
  if (item.format === "enum") return item.enumValues?.[raw] ?? raw;
  return item.mod ? item.mod(raw) : raw;
}

// ---------------------------------------------------------------- workouts

export interface SbemWorkoutFull extends SbemWorkout {
  moving_s?: number;
  distance_m?: number;
  avg_hr?: number;
  max_hr?: number;
  avg_speed?: number;
  avg_cadence?: number;
  avg_power?: number;
  calories?: number;
  ascent_m?: number;
  descent_m?: number;
  /** The heart-rate zones set on the watch: lower limits of zones 2–5, bpm. */
  hr_zones?: [number, number, number, number];
  /** The watch's personal max and resting heart rate, bpm (when set). */
  personal_max_hr?: number;
  personal_rest_hr?: number;
  /** "How did it feel?", answered on the watch after the workout: 1 poor … 5 excellent. */
  feeling?: Feeling;
}

export type Feeling = 1 | 2 | 3 | 4 | 5;
export const FEELING_NAME: Record<Feeling, string> = { 1: "Poor", 2: "Average", 3: "Good", 4: "Very good", 5: "Excellent" };
/**
 * The watch's answer to "How did it feel?" (SML Header.Feeling), as 1-5. Suunto writes a number
 * (0 when it wasn't answered); a name is read too, in case a firmware writes one.
 */
export function feelingOf(v: unknown): Feeling | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5) return v as Feeling;
  if (typeof v === "string") {
    const i = ["poor", "average", "good", "very good", "excellent"].indexOf(v.trim().toLowerCase().replace(/_/g, " "));
    return i >= 0 ? ((i + 1) as Feeling) : undefined;
  }
  return undefined;
}

const ends = (rec: SbemRecord | undefined, suffix: string): SbemValue | undefined => {
  if (!rec) return undefined;
  for (const [k, v] of Object.entries(rec.values)) if (k.endsWith(suffix) && v !== null) return v;
  return undefined;
};
const num = (v: SbemValue | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * A workout from its Summary, decoded with the log's descriptors: the header (SML.Header.*:
 * DateTime, Duration, PauseDuration, Distance, Energy, Ascent, Activity) and the whole-workout
 * window (Windows.Window, Type=Move: HR, speed, cadence, power). Values are SI: HR and cadence
 * in Hz, energy in J.
 */
export function decodeWorkout(summary: Uint8Array, descriptors: Map<number, SbemItem>): SbemWorkoutFull | null {
  const recs = decodeSbem(summary, descriptors);
  const header = recs.find((r) => ends(r, "Header.Duration") !== undefined || ends(r, "Header.DateTime") !== undefined);
  if (!header) return null;
  const move = recs.find((r) => ends(r, "Window.Type") === "Move");
  const startLocal = num(ends(header, "Header.DateTime"));
  const offsetMin = header.offsetMin ?? 0;
  const elapsed = num(ends(header, "Header.Duration"));
  if (startLocal === undefined) return null;
  const start = startLocal - offsetMin * 60_000;
  const pause = num(ends(header, "Header.PauseDuration")) ?? 0;
  // The watch writes 0 where it measured nothing (no HR strap, indoors): not a value.
  const pos = (v: number | undefined) => (v !== undefined && v > 0 ? v : undefined);
  const hz = (v: number | undefined) => (pos(v) !== undefined ? Math.round(v! * 60) : undefined);
  const energy = num(ends(header, "Header.Energy")) ?? num(ends(move, "Window.Energy"));
  return {
    start,
    end: start + (elapsed ?? 0) * 1000,
    duration_s: Math.round(elapsed ?? 0),
    offsetMin,
    sport: (ends(header, "Header.Activity") as string | undefined) || "unknown",
    laps: recs.filter((r) => ["Lap", "Autolap", "Interval"].includes(String(ends(r, "Window.Type")))).length,
    moving_s: num(ends(move, "Window.Duration")) ?? (elapsed !== undefined ? Math.max(0, elapsed - pause) : undefined),
    distance_m: pos(num(ends(header, "Header.Distance")) ?? num(ends(move, "Window.Distance"))),
    avg_hr: hz(num(ends(move, "HR.Avg"))),
    max_hr: hz(num(ends(move, "HR.Max"))),
    avg_speed: pos(num(ends(move, "Speed.Avg"))),
    avg_cadence: hz(num(ends(move, "Cadence.Avg"))),
    avg_power: pos(num(ends(move, "Power.Avg"))),
    calories: energy !== undefined && energy > 0 ? energy / 4184 : undefined,
    hr_zones: zoneLimits(header),
    // Personal values are SI (Hz) like every heart rate in SML; bpm if a firmware writes bpm.
    personal_max_hr: bpm(num(ends(header, "Personal.MaxHR"))),
    personal_rest_hr: bpm(num(ends(header, "Personal.RestHR"))),
    ascent_m: pos(num(ends(header, "Header.Ascent")) ?? num(ends(move, "Window.Ascent"))),
    descent_m: pos(num(ends(header, "Header.Descent")) ?? num(ends(move, "Window.Descent"))),
    feeling: feelingOf(ends(header, "Header.Feeling")),
  };
}

const bpm = (v: number | undefined) => (v === undefined || v <= 0 ? undefined : Math.round(v < 10 ? v * 60 : v));

/** Zones 2–5 lower limits (Header.HrZones.ZoneNLowerLimit, Hz) as bpm, when all four are set and rising. */
function zoneLimits(header: SbemRecord): [number, number, number, number] | undefined {
  const z = [2, 3, 4, 5].map((n) => bpm(num(ends(header, `HrZones.Zone${n}LowerLimit`))));
  if (z.some((x) => x === undefined || x < 60 || x > 240)) return undefined;
  for (let i = 1; i < 4; i++) if (z[i]! <= z[i - 1]!) return undefined;
  return z as [number, number, number, number];
}

/**
 * The time series in Data, in the library's channel names (time in s from `startLocal`, the
 * workout's local start): distance, heartrate (bpm), latlng (degrees), altitude, velocity,
 * cadence (per minute), watts. One row per sample time that carries any of them.
 */
export function decodeStreams(data: Uint8Array, descriptors: Map<number, SbemItem>, startLocal?: number): Record<string, unknown[]> | null {
  const rows = new Map<number, Record<string, number>>();
  const deg = (r: number) => (r * 180) / Math.PI;
  let lastLat: number | undefined;
  let lastLon: number | undefined;
  for (const rec of decodeSbem(data, descriptors)) {
    if (rec.time === undefined) continue;
    const row: Record<string, number> = {};
    const put = (k: string, v: number | undefined) => {
      if (v !== undefined) row[k] = v;
    };
    put("distance", num(ends(rec, "Sample.Distance")));
    const hr = num(ends(rec, "Sample.HR"));
    put("heartrate", hr !== undefined ? Math.round(hr * 60) : undefined);
    // A coordinate whose delta was left off is unchanged: keep the other's last value.
    const latNow = num(ends(rec, "Sample.Latitude")) ?? num(ends(rec, "Sample.GPSLatitude"));
    const lonNow = num(ends(rec, "Sample.Longitude")) ?? num(ends(rec, "Sample.GPSLongitude"));
    const lat = latNow ?? (lonNow !== undefined ? lastLat : undefined);
    const lon = lonNow ?? (latNow !== undefined ? lastLon : undefined);
    if (latNow !== undefined) lastLat = latNow;
    if (lonNow !== undefined) lastLon = lonNow;
    if (lat !== undefined && lon !== undefined && (lat || lon)) {
      row.lat = deg(lat);
      row.lon = deg(lon);
    }
    const alt = num(ends(rec, "Sample.Altitude")) ?? num(ends(rec, "Sample.GPSAltitude"));
    put("altitude", alt !== undefined ? Math.round(alt * 10) / 10 : undefined);
    put("velocity", num(ends(rec, "Sample.Speed")) ?? num(ends(rec, "Sample.GPSSpeed")));
    const cad = num(ends(rec, "Sample.Cadence"));
    put("cadence", cad !== undefined ? Math.round(cad * 60) : undefined);
    put("watts", num(ends(rec, "Sample.Power")));
    if (!Object.keys(row).length) continue;
    rows.set(rec.time, { ...(rows.get(rec.time) ?? {}), ...row });
  }
  const times = [...rows.keys()].sort((a, b) => a - b);
  if (times.length < 2) return null;
  const t0 = startLocal ?? times[0]!;
  const col = (k: string) => times.map((t) => rows.get(t)![k] ?? null);
  const out: Record<string, unknown[]> = { time: times.map((t) => Math.round((t - t0) / 1000)) };
  for (const k of ["distance", "heartrate", "altitude", "velocity", "cadence", "watts"]) {
    const c = col(k);
    if (c.some((v) => v !== null)) out[k] = c;
  }
  const latlng = times.map((t) => (rows.get(t)!.lat !== undefined ? [rows.get(t)!.lat, rows.get(t)!.lon] : null));
  if (latlng.some((v) => v !== null)) out.latlng = latlng;
  return out;
}
