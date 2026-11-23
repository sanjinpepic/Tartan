/**
 * Decode an Android HCI snoop log (btsnoop_hci.log) into whiteboard frames, one line each:
 *   bun scripts/btsnoop.ts btsnoop_hci.log [--full] > decoded.txt
 * ">" is phone → watch, "<" watch → phone. The output can contain tokens the app sends the
 * watch (Settings/Wifi/Cloud/STTAuthorization): keep it out of the repository.
 */
import { readFileSync } from "node:fs";
import { describeFrame } from "../src/protocol/blackbox.ts";
import { Deframer } from "../src/protocol/codec.ts";

const buf = readFileSync(process.argv[2]!);
const magic = buf.subarray(0, 8).toString("latin1");
const link = buf.readUInt32BE(12);
console.log("magic", JSON.stringify(magic), "datalink", link);
let at = 16;
type Rec = { t: number; sent: boolean; data: Buffer };
const recs: Rec[] = [];
while (at + 24 <= buf.length) {
  const incl = buf.readUInt32BE(at + 4);
  const flags = buf.readUInt32BE(at + 8);
  const ts = Number(buf.readBigUInt64BE(at + 16));
  const data = buf.subarray(at + 24, at + 24 + incl);
  recs.push({ t: ts, sent: (flags & 1) === 0, data });
  at += 24 + incl;
}
console.log("records", recs.length);
// ACL reassembly → L2CAP → ATT
const pending = new Map<string, Buffer>();
const att: Array<{ t: number; sent: boolean; conn: number; pdu: Buffer }> = [];
for (const r of recs) {
  let d = r.data;
  if (link === 1002) {
    if (d[0] !== 0x02) continue;
    d = d.subarray(1);
  }
  if (d.length < 4) continue;
  const hdr = d.readUInt16LE(0);
  const conn = hdr & 0x0fff;
  const pb = (hdr >> 12) & 3;
  const payload = d.subarray(4, 4 + d.readUInt16LE(2));
  const key = `${r.sent}:${conn}`;
  let l2: Buffer;
  if (pb === 1) {
    const prev = pending.get(key);
    if (!prev) continue;
    l2 = Buffer.concat([prev, payload]);
  } else l2 = payload;
  const need = l2.readUInt16LE(0) + 4;
  if (l2.length < need) {
    pending.set(key, l2);
    continue;
  }
  pending.delete(key);
  const cid = l2.readUInt16LE(2);
  if (cid !== 4) continue;
  att.push({ t: r.t, sent: r.sent, conn, pdu: l2.subarray(4, need) });
}
console.log("att pdus", att.length);
// Find GATT handles: count write/notify per handle
const counts = new Map<string, number>();
for (const a of att) {
  const op = a.pdu[0]!;
  if ([0x52, 0x12, 0x1b, 0x1d].includes(op)) {
    const k = `${a.conn} ${a.sent ? "tx" : "rx"} op${op.toString(16)} h${a.pdu.readUInt16LE(1).toString(16)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
}
console.log([...counts].sort((a, b) => b[1] - a[1]).slice(0, 20));
// UUID discovery: Read By Type responses / Find info, print 128-bit UUIDs with handles
for (const a of att) {
  if (a.pdu[0] === 0x09 && !a.sent) {
    const len = a.pdu[1]!;
    for (let i = 2; i + len <= a.pdu.length; i += len) {
      const e = a.pdu.subarray(i, i + len);
      if (len === 21) console.log("char decl", "handle", e.readUInt16LE(0).toString(16), "value", e.readUInt16LE(3).toString(16), "uuid", Buffer.from(e.subarray(5)).reverse().toString("hex"));
    }
  }
}

// Deframe whiteboard traffic: tx = writes (0x52/0x12), rx = notifications (0x1b)
const dir = process.argv[3] ?? "";
const frames: Array<{ t: number; sent: boolean; f: Uint8Array }> = [];
const dTx = new Map<number, Deframer>();
const dRx = new Map<number, Deframer>();
let curT = 0;
for (const a of att) {
  const op = a.pdu[0]!;
  const sent = a.sent;
  if (!((sent && (op === 0x52 || op === 0x12)) || (!sent && op === 0x1b))) continue;
  const h = a.pdu.readUInt16LE(1);
  const m = sent ? dTx : dRx;
  const key = h * 16 + a.conn;
  if (!m.has(key)) m.set(key, new Deframer((f) => frames.push({ t: curT, sent, f })));
  curT = a.t;
  m.get(key)!.push(new Uint8Array(a.pdu.subarray(3)));
}
console.log("whiteboard frames", frames.length);
const t0 = frames[0]?.t ?? 0;
/** `--full` prints whole payloads (for rebuilding a file the app sent); otherwise they're cut short. */
const full = process.argv.includes("--full");
for (const { t, sent, f } of frames) console.log(`${((t - t0) / 1e6).toFixed(2).padStart(8)} ${sent ? ">" : "<"} ${describeFrame(f, full)}`);
