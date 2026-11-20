/**
 * A FIT activity file written from a workout Tartan was given in another shape (Health Connect,
 * intervals.icu, a GPX file): file id, the samples as records, one lap, one session and the
 * activity, little-endian, with both CRCs. Kept like a file copied off a watch, it merges, reads
 * and exports (Strava takes it) the same way (src/import.ts). Read back by src/fit.ts.
 */

export interface FitSample {
  /** ms since 1970. */
  t: number;
  lat?: number;
  lon?: number;
  altitude?: number;
  hr?: number;
  cadence?: number;
  /** Metres from the start. */
  distance?: number;
  /** m/s. */
  speed?: number;
  power?: number;
}

export interface FitWorkout {
  /** ms since 1970. */
  start: number;
  end: number;
  /** "running", "cycling", "walking", "hiking", "swimming", "training"… (FIT's sport names; others: generic). */
  sport: string;
  /** Moving time, s (default: elapsed). */
  moving_s?: number;
  distance_m?: number;
  calories?: number;
  avg_hr?: number;
  max_hr?: number;
  ascent_m?: number;
  samples: FitSample[];
}

const FIT_EPOCH_MS = 631065600_000;
const SPORT: Record<string, number> = {
  generic: 0, running: 1, cycling: 2, fitness_equipment: 4, swimming: 5, training: 10, walking: 11,
  cross_country_skiing: 12, alpine_skiing: 13, rowing: 15, mountaineering: 16, hiking: 17, paddling: 19,
  e_biking: 21, golf: 25, stand_up_paddleboarding: 37, kayaking: 41, snowshoeing: 43,
};

// Base types: enum, uint8, uint16, sint32, uint32.
const ENUM = 0x00, U8 = 0x02, U16 = 0x84, S32 = 0x85, U32 = 0x86;
const SIZE: Record<number, number> = { [ENUM]: 1, [U8]: 1, [U16]: 2, [S32]: 4, [U32]: 4 };
const INVALID: Record<number, number> = { [ENUM]: 0xff, [U8]: 0xff, [U16]: 0xffff, [S32]: 0x7fffffff, [U32]: 0xffffffff };

type Field = [num: number, type: number];
const FILE_ID: Field[] = [[0, ENUM], [1, U16], [2, U16], [4, U32]];
const RECORD: Field[] = [[253, U32], [0, S32], [1, S32], [78, U32], [3, U8], [4, U8], [5, U32], [73, U32], [7, U16]];
const LAP: Field[] = [[253, U32], [2, U32], [7, U32], [8, U32], [9, U32]];
const SESSION: Field[] = [[253, U32], [2, U32], [5, ENUM], [6, ENUM], [7, U32], [8, U32], [9, U32], [11, U16], [16, U8], [17, U8], [22, U16], [124, U32]];
const ACTIVITY: Field[] = [[253, U32], [0, U32], [1, U16], [2, ENUM], [3, ENUM], [4, ENUM]];

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
export function fitCrc(bytes: Uint8Array, crc = 0): number {
  for (const b of bytes) {
    let tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf]!;
    tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf]!;
  }
  return crc;
}

export function writeFit(w: FitWorkout): Uint8Array {
  const chunks: number[] = [];
  const u8 = (n: number) => chunks.push(n & 0xff);
  const put = (v: number, type: number) => {
    const n = SIZE[type]!;
    // sint32 keeps its sign through the shifts; everything else is unsigned.
    for (let i = 0; i < n; i++) u8(type === S32 ? (v >> (8 * i)) & 0xff : Math.floor(v / 2 ** (8 * i)) & 0xff);
  };
  const define = (local: number, global: number, fields: Field[]) => {
    u8(0x40 | local);
    u8(0); // reserved
    u8(0); // little-endian
    put(global, U16);
    u8(fields.length);
    for (const [num, type] of fields) {
      u8(num);
      u8(SIZE[type]!);
      u8(type);
    }
  };
  const message = (local: number, fields: Field[], values: Record<number, number | undefined>) => {
    u8(local);
    for (const [num, type] of fields) {
      const v = values[num];
      const ok = v !== undefined && Number.isFinite(v);
      put(ok ? Math.round(v!) : INVALID[type]!, type);
    }
  };
  const ts = (ms: number) => Math.round((ms - FIT_EPOCH_MS) / 1000);
  const semi = (deg: number) => Math.round((deg * 2 ** 31) / 180);
  const clampU8 = (n?: number) => (n === undefined ? undefined : Math.max(0, Math.min(254, n)));

  const elapsed = Math.max(0, (w.end - w.start) / 1000);
  const moving = w.moving_s ?? elapsed;
  define(0, 0, FILE_ID);
  message(0, FILE_ID, { 0: 4, 1: 255, 2: 0, 4: ts(w.start) });
  define(1, 20, RECORD);
  for (const s of w.samples) {
    message(1, RECORD, {
      253: ts(s.t),
      0: s.lat !== undefined && s.lon !== undefined ? semi(s.lat) : undefined,
      1: s.lat !== undefined && s.lon !== undefined ? semi(s.lon) : undefined,
      78: s.altitude !== undefined ? (s.altitude + 500) * 5 : undefined,
      3: clampU8(s.hr),
      4: clampU8(s.cadence),
      5: s.distance !== undefined ? s.distance * 100 : undefined,
      73: s.speed !== undefined ? s.speed * 1000 : undefined,
      7: s.power,
    });
  }
  define(2, 19, LAP);
  message(2, LAP, { 253: ts(w.end), 2: ts(w.start), 7: elapsed * 1000, 8: moving * 1000, 9: w.distance_m !== undefined ? w.distance_m * 100 : undefined });
  define(3, 18, SESSION);
  message(3, SESSION, {
    253: ts(w.end),
    2: ts(w.start),
    5: SPORT[w.sport] ?? 0,
    6: 0,
    7: elapsed * 1000,
    8: moving * 1000,
    9: w.distance_m !== undefined ? w.distance_m * 100 : undefined,
    11: w.calories,
    16: clampU8(w.avg_hr),
    17: clampU8(w.max_hr),
    22: w.ascent_m,
    124: w.distance_m && moving ? (w.distance_m / moving) * 1000 : undefined,
  });
  define(4, 34, ACTIVITY);
  message(4, ACTIVITY, { 253: ts(w.end), 0: moving * 1000, 1: 1, 2: 0, 3: 26, 4: 1 });

  const data = Uint8Array.from(chunks);
  const header = new Uint8Array(14);
  const hv = new DataView(header.buffer);
  header[0] = 14;
  header[1] = 0x20; // protocol 2.0
  hv.setUint16(2, 2132, true); // profile 21.32
  hv.setUint32(4, data.length, true);
  header.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  hv.setUint16(12, fitCrc(header.subarray(0, 12)), true);
  const out = new Uint8Array(14 + data.length + 2);
  out.set(header, 0);
  out.set(data, 14);
  new DataView(out.buffer).setUint16(14 + data.length, fitCrc(out.subarray(0, 14 + data.length)), true);
  return out;
}

/** Great-circle distance in metres. */
export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The totals a workout's samples imply where it didn't say: distance (the last cumulative one,
 * else along the route), heart rate average and peak, and climb (rises of 2 m or more, so GPS
 * noise doesn't add up). Fills `distance` along the route when the samples carry none.
 */
export function fillTotals(w: FitWorkout): FitWorkout {
  const s = w.samples;
  if (!s.some((x) => x.distance !== undefined)) {
    let d = 0;
    let prev: FitSample | undefined;
    for (const x of s) {
      if (x.lat === undefined || x.lon === undefined) continue;
      if (prev) d += haversine(prev as { lat: number; lon: number }, x as { lat: number; lon: number });
      x.distance = d;
      prev = x;
    }
  }
  const lastDist = [...s].reverse().find((x) => x.distance !== undefined)?.distance;
  const hrs = s.map((x) => x.hr).filter((x): x is number => typeof x === "number" && x > 0);
  let ascent = 0;
  let base: number | undefined;
  for (const x of s) {
    if (x.altitude === undefined) continue;
    if (base === undefined || x.altitude < base) base = x.altitude;
    else if (x.altitude - base >= 2) {
      ascent += x.altitude - base;
      base = x.altitude;
    }
  }
  return {
    ...w,
    distance_m: w.distance_m ?? (lastDist && lastDist > 0 ? lastDist : undefined),
    avg_hr: w.avg_hr ?? (hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : undefined),
    max_hr: w.max_hr ?? (hrs.length ? Math.max(...hrs) : undefined),
    ascent_m: w.ascent_m ?? (s.some((x) => x.altitude !== undefined) ? Math.round(ascent) : undefined),
  };
}
