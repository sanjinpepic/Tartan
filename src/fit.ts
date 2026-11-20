/**
 * Minimal FIT (Flexible and Interoperable Data Transfer) decoder: enough to turn an
 * activity file into a summary, laps and a time series. Handles definition messages,
 * compressed timestamp headers, developer fields (skipped) and both byte orders.
 */

const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z in Unix seconds
const SEMICIRCLE = 180 / 2 ** 31;

export interface FitActivity {
  sport?: string;
  subSport?: number;
  startTime?: string;
  session?: Record<string, number | string>;
  laps: Array<Record<string, number | string>>;
  records: FitRecord[];
  device?: { manufacturer?: number; product?: number; serial?: number };
}

export interface FitRecord {
  time: string;
  lat?: number;
  lon?: number;
  altitude?: number;
  heartRate?: number;
  cadence?: number;
  distance?: number;
  speed?: number;
  power?: number;
  temperature?: number;
}

const SPORTS: Record<number, string> = {
  0: "generic", 1: "running", 2: "cycling", 3: "transition", 4: "fitness_equipment", 5: "swimming",
  10: "training", 11: "walking", 12: "cross_country_skiing", 13: "alpine_skiing", 15: "rowing",
  16: "mountaineering", 17: "hiking", 19: "paddling", 21: "e_biking", 25: "golf", 37: "stand_up_paddleboarding",
  41: "kayaking", 43: "snowshoeing", 53: "diving",
};

/** Field number → [name, scale, offset] for the messages we care about. */
type FieldMap = Record<number, [string, number, number]>;
const SESSION: FieldMap = {
  253: ["timestamp", 1, 0], 2: ["start_time", 1, 0], 5: ["sport", 1, 0], 6: ["sub_sport", 1, 0],
  7: ["total_elapsed_time", 1000, 0], 8: ["total_timer_time", 1000, 0], 9: ["total_distance", 100, 0],
  11: ["total_calories", 1, 0], 14: ["avg_speed", 1000, 0], 15: ["max_speed", 1000, 0],
  16: ["avg_heart_rate", 1, 0], 17: ["max_heart_rate", 1, 0], 18: ["avg_cadence", 1, 0], 19: ["max_cadence", 1, 0],
  20: ["avg_power", 1, 0], 21: ["max_power", 1, 0], 22: ["total_ascent", 1, 0], 23: ["total_descent", 1, 0],
  124: ["enhanced_avg_speed", 1000, 0], 125: ["enhanced_max_speed", 1000, 0],
};
const LAP: FieldMap = {
  253: ["timestamp", 1, 0], 2: ["start_time", 1, 0], 7: ["total_elapsed_time", 1000, 0], 8: ["total_timer_time", 1000, 0],
  9: ["total_distance", 100, 0], 11: ["total_calories", 1, 0], 13: ["avg_speed", 1000, 0], 15: ["avg_heart_rate", 1, 0],
  16: ["max_heart_rate", 1, 0], 17: ["avg_cadence", 1, 0], 21: ["total_ascent", 1, 0], 22: ["total_descent", 1, 0],
  110: ["enhanced_avg_speed", 1000, 0],
};
const RECORD: FieldMap = {
  253: ["timestamp", 1, 0], 0: ["lat", 1, 0], 1: ["lon", 1, 0], 2: ["altitude", 5, 500], 3: ["heartRate", 1, 0],
  4: ["cadence", 1, 0], 5: ["distance", 100, 0], 6: ["speed", 1000, 0], 7: ["power", 1, 0], 13: ["temperature", 1, 0],
  73: ["enhanced_speed", 1000, 0], 78: ["enhanced_altitude", 5, 500],
};

interface FieldDef { num: number; size: number; baseType: number }
interface Definition { global: number; little: boolean; fields: FieldDef[]; devSize: number }

export function isFit(data: Uint8Array): boolean {
  return data.length >= 14 && data[8] === 0x2e && data[9] === 0x46 && data[10] === 0x49 && data[11] === 0x54;
}

const iso = (fitSeconds: number) => new Date((fitSeconds + FIT_EPOCH) * 1000).toISOString();

function readValue(view: DataView, at: number, size: number, baseType: number, little: boolean): number | null {
  const t = baseType & 0x1f;
  switch (t) {
    case 0x00: case 0x02: case 0x0a: case 0x0d: { const v = view.getUint8(at); return v === 0xff && t !== 0x0a ? null : v; }
    case 0x01: { const v = view.getInt8(at); return v === 0x7f ? null : v; }
    case 0x03: { if (size < 2) return null; const v = view.getInt16(at, little); return v === 0x7fff ? null : v; }
    case 0x04: case 0x0b: { if (size < 2) return null; const v = view.getUint16(at, little); return v === 0xffff || (t === 0x0b && v === 0) ? null : v; }
    case 0x05: { if (size < 4) return null; const v = view.getInt32(at, little); return v === 0x7fffffff ? null : v; }
    case 0x06: case 0x0c: { if (size < 4) return null; const v = view.getUint32(at, little); return v === 0xffffffff || (t === 0x0c && v === 0) ? null : v; }
    case 0x08: return size >= 4 ? view.getFloat32(at, little) : null;
    case 0x09: return size >= 8 ? view.getFloat64(at, little) : null;
    default: return null; // strings, byte arrays, 64-bit ints: not needed here
  }
}

export function parseFit(data: Uint8Array): FitActivity {
  if (!isFit(data)) throw new Error("not a FIT file");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerSize = data[0]!;
  const dataSize = view.getUint32(4, true);
  const end = Math.min(headerSize + dataSize, data.length);
  const defs = new Map<number, Definition>();
  const out: FitActivity = { laps: [], records: [] };
  let lastTimestamp = 0;
  let at = headerSize;

  const decode = (def: Definition, map: FieldMap | null, start: number): Record<string, number> => {
    const values: Record<string, number> = {};
    let p = start;
    for (const f of def.fields) {
      if (map && map[f.num]) {
        const raw = readValue(view, p, f.size, f.baseType, def.little);
        if (raw !== null) {
          const [name, scale, offset] = map[f.num]!;
          values[name] = raw / scale - offset;
        }
      } else if (f.num === 253) {
        const raw = readValue(view, p, f.size, f.baseType, def.little);
        if (raw !== null) values.timestamp = raw;
      }
      p += f.size;
    }
    return values;
  };

  while (at < end) {
    const header = data[at++]!;
    if (header & 0x80) {
      // Compressed timestamp header: local type in bits 5-6, 5-bit time offset.
      const local = (header >> 5) & 0x03;
      const offset = header & 0x1f;
      lastTimestamp = (lastTimestamp & ~0x1f) + offset + (offset < (lastTimestamp & 0x1f) ? 0x20 : 0);
      const def = defs.get(local);
      if (!def) throw new Error(`FIT: undefined local message ${local}`);
      handle(def, at, lastTimestamp);
      at += size(def);
      continue;
    }
    const local = header & 0x0f;
    if (header & 0x40) {
      const hasDev = (header & 0x20) !== 0;
      const little = data[at + 1] === 0;
      const global = little ? view.getUint16(at + 2, true) : view.getUint16(at + 2, false);
      const count = data[at + 4]!;
      const fields: FieldDef[] = [];
      let p = at + 5;
      for (let i = 0; i < count; i++, p += 3) fields.push({ num: data[p]!, size: data[p + 1]!, baseType: data[p + 2]! });
      let devSize = 0;
      if (hasDev) {
        const n = data[p++]!;
        for (let i = 0; i < n; i++, p += 3) devSize += data[p + 1]!;
      }
      defs.set(local, { global, little, fields, devSize });
      at = p;
    } else {
      const def = defs.get(local);
      if (!def) throw new Error(`FIT: data message for undefined local type ${local}`);
      handle(def, at, null);
      at += size(def);
    }
  }
  if (out.session?.sport !== undefined) out.sport = SPORTS[Number(out.session.sport)] ?? `sport ${out.session.sport}`;
  return out;

  function size(def: Definition): number {
    return def.fields.reduce((n, f) => n + f.size, 0) + def.devSize;
  }

  function handle(def: Definition, start: number, compressedTs: number | null): void {
    switch (def.global) {
      case 0: {
        const v = decode(def, { 1: ["manufacturer", 1, 0], 2: ["product", 1, 0], 3: ["serial", 1, 0] }, start);
        out.device = { manufacturer: v.manufacturer, product: v.product, serial: v.serial };
        break;
      }
      case 18: {
        const v = decode(def, SESSION, start);
        out.session = withTimes(v);
        if (v.start_time !== undefined) out.startTime = iso(v.start_time);
        if (v.sub_sport !== undefined) out.subSport = v.sub_sport;
        break;
      }
      case 19:
        out.laps.push(withTimes(decode(def, LAP, start)));
        break;
      case 20: {
        const v = decode(def, RECORD, start);
        const ts = v.timestamp ?? compressedTs;
        if (ts === undefined || ts === null) break;
        if (v.timestamp !== undefined) lastTimestamp = v.timestamp;
        const r: FitRecord = { time: iso(ts) };
        if (v.lat !== undefined && v.lon !== undefined) {
          r.lat = +(v.lat * SEMICIRCLE).toFixed(6);
          r.lon = +(v.lon * SEMICIRCLE).toFixed(6);
        }
        const alt = v.enhanced_altitude ?? v.altitude;
        if (alt !== undefined) r.altitude = +alt.toFixed(1);
        const spd = v.enhanced_speed ?? v.speed;
        if (spd !== undefined) r.speed = +spd.toFixed(3);
        for (const k of ["heartRate", "cadence", "distance", "power", "temperature"] as const) if (v[k] !== undefined) r[k] = v[k];
        out.records.push(r);
        break;
      }
      default: {
        const v = decode(def, null, start);
        if (v.timestamp !== undefined) lastTimestamp = v.timestamp;
      }
    }
  }
}

function withTimes(v: Record<string, number>): Record<string, number | string> {
  const o: Record<string, number | string> = { ...v };
  for (const k of ["timestamp", "start_time"]) if (typeof v[k] === "number") o[k] = iso(v[k]!);
  return o;
}
