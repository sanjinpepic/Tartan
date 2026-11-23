/**
 * The Run 2's 10-minute trend log, the way the Suunto app reads it on every connection (HCI
 * capture of 18 Oct 2026):
 *
 *   GET /Activity/TrendData (i64 ms)   one page of records; 202 = more, 200 = the last page
 *
 * and the next page is asked for with the last record's time. The watch keeps about a day of
 * them, so they have to be read at least daily to keep a history. Reads only.
 *
 * A page is a struct (type 0xab05) holding an array of 40-byte records, laid out like this (the
 * fields Tartan reads were checked against a day of them; an optional field is a presence byte,
 * then its value, and an absent one leaves stale bytes behind, so only present ones count):
 *
 *   0  f32  energy in the 10 minutes, joules (0 while still: active energy)
 *   4  u32  steps in the 10 minutes
 *   8  u64  start of the 10 minutes, ms since the epoch (UTC)
 *   16 opt u8   heart rate, bpm (when the watch was worn)
 *   20 opt f32  blood oxygen, a fraction (0.97 = 97%), when the watch measured it
 *   28 opt f32  not known yet (seen once: -5.5)
 *   36 opt u8   not known yet (always 45 so far)
 *
 * Page: u16 count, u16 (stale), u32 offset of the first record from the struct's start, then a
 * presence byte and a byte (01 ff), then the records.
 */
import type { Reply } from "./codec.ts";

export interface TrendRecord {
  /** Start of the 10 minutes, ms since the epoch. */
  t: number;
  steps: number;
  /** Active energy, joules. */
  energy_j: number;
  hr?: number;
  /** Blood oxygen, percent. */
  spo2?: number;
  /** The field at 28 while its meaning is unknown. */
  x28?: number;
}

export const TREND_TYPE = 0xab05;
export const TREND_RECORD = 40;
/** A record covers ten minutes. */
export const TREND_STEP_MS = 600_000;

/** A page's records (from the struct's bytes). */
export function decodeTrendPage(s: Uint8Array): TrendRecord[] {
  if (s.length < 8) return [];
  const v = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const n = v.getUint16(0, true);
  const off = v.getUint32(4, true);
  const out: TrendRecord[] = [];
  for (let k = 0; k < n; k++) {
    const at = off + k * TREND_RECORD;
    // The last record may come without its last optional field.
    if (at + 37 > s.length) break;
    const t = Number(v.getBigUint64(at + 8, true));
    if (!(t > 1.5e12 && t < 4e12)) continue;
    const energy = v.getFloat32(at, true);
    const r: TrendRecord = { t, steps: v.getUint32(at + 4, true), energy_j: Number.isFinite(energy) && energy >= 0 && energy < 1e8 ? Math.round(energy) : 0 };
    const hr = s[at + 16] ? s[at + 17]! : 0;
    if (hr >= 25 && hr <= 240) r.hr = hr;
    const ox = s[at + 20] ? v.getFloat32(at + 24, true) : NaN;
    const pct = ox > 0 && ox <= 1 ? ox * 100 : ox;
    if (pct >= 50 && pct <= 100) r.spo2 = Math.round(pct * 10) / 10;
    if (s[at + 28]) {
      const x = v.getFloat32(at + 32, true);
      if (Number.isFinite(x)) r.x28 = Math.round(x * 1000) / 1000;
    }
    out.push(r);
  }
  return out;
}

/** A page's struct bytes (the simulator's answer, and tests). */
export function encodeTrendPage(records: TrendRecord[]): Uint8Array {
  const off = 12;
  const s = new Uint8Array(off + records.length * TREND_RECORD);
  const v = new DataView(s.buffer);
  v.setUint16(0, records.length, true);
  v.setUint32(4, off, true);
  s[8] = 1;
  s[9] = 0xff;
  records.forEach((r, k) => {
    const at = off + k * TREND_RECORD;
    v.setFloat32(at, r.energy_j, true);
    v.setUint32(at + 4, r.steps, true);
    v.setBigUint64(at + 8, BigInt(r.t), true);
    if (r.hr !== undefined) [s[at + 16], s[at + 17]] = [1, r.hr];
    if (r.spo2 !== undefined) {
      s[at + 20] = 1;
      v.setFloat32(at + 24, r.spo2 / 100, true);
    }
    if (r.x28 !== undefined) {
      s[at + 28] = 1;
      v.setFloat32(at + 32, r.x28, true);
    }
    [s[at + 36], s[at + 37]] = [1, 45];
  });
  return s;
}

/** The time parameter: i64 ms. */
export function timeParam(ms: number): Uint8Array {
  const p = new Uint8Array(10);
  const v = new DataView(p.buffer);
  v.setUint16(0, 8, true);
  v.setBigInt64(2, BigInt(Math.floor(ms)), true);
  return p;
}

/** A struct reply's bytes: u16 type, u16 header (length, log2 alignment), padding, struct. */
export function replyStruct(raw: Uint8Array): Uint8Array | null {
  if (raw.length < 22) return null;
  const hdr = raw[16]! | (raw[17]! << 8);
  const align = 1 << ((hdr >> 9) & 7);
  const start = 18 + ((align - (18 % align)) % align);
  const end = Math.min(raw.length - 4, 18 + (hdr & 0x1ff));
  return start <= end ? raw.subarray(start, end) : null;
}

export interface TrendRpc {
  rpc(path: string, params: Uint8Array[]): Promise<Reply | null>;
  log(line: string): void;
}

/**
 * Every record the watch has, paging on from `sinceMs` (the watch answers from its oldest when
 * it doesn't know the time, so the whole day usually comes back), sorted and without repeats.
 */
export async function readTrendLog(r: TrendRpc, sinceMs: number, maxPages = 40): Promise<{ records: TrendRecord[]; pages: number }> {
  const byTime = new Map<number, TrendRecord>();
  let at = sinceMs;
  let pages = 0;
  for (; pages < maxPages; pages++) {
    const rep = await r.rpc("/Activity/TrendData", [timeParam(at)]);
    const status = rep?.status ?? 0;
    if (status !== 200 && status !== 202) {
      r.log(`[trends] page ${pages + 1}: ${status || "no reply"}`);
      break;
    }
    const s = rep ? replyStruct(rep.raw) : null;
    const type = rep && rep.raw.length > 16 ? rep.raw[14]! | (rep.raw[15]! << 8) : 0;
    const got = s && type === TREND_TYPE ? decodeTrendPage(s) : [];
    for (const x of got) byTime.set(x.t, x);
    const last = got.at(-1)?.t;
    if (status === 200 || last === undefined || last === at) {
      pages++;
      break;
    }
    at = last;
  }
  const records = [...byTime.values()].sort((a, b) => a.t - b.t);
  const worn = records.filter((x) => x.hr !== undefined).length;
  const ox = records.filter((x) => x.spo2 !== undefined);
  r.log(
    `[trends] ${records.length} records in ${pages} pages` +
      (records.length ? `, ${new Date(records[0]!.t).toISOString()} to ${new Date(records.at(-1)!.t).toISOString()}; heart rate in ${worn}; blood oxygen in ${ox.length}${ox.length ? ` (${ox.map((x) => x.spo2).join(", ")})` : ""}` : ""),
  );
  return { records, pages };
}
