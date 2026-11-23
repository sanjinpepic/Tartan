/** A tiny FIT activity: a 30-minute, 5 km run with three GPS + heart-rate records (2004-11-06 06:13 UTC). */

export function encodeFit(): Uint8Array {
  const bytes: number[] = [];
  const u16 = (n: number) => bytes.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (n: number) => bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const i32 = (n: number) => u32(n >>> 0);
  const def = (local: number, global: number, fields: Array<[number, number, number]>) => {
    bytes.push(0x40 | local, 0, 0);
    u16(global);
    bytes.push(fields.length);
    for (const f of fields) bytes.push(...f);
  };
  const start = 1_100_000_000; // FIT seconds
  def(0, 18, [[253, 4, 0x86], [2, 4, 0x86], [5, 1, 0x00], [7, 4, 0x86], [8, 4, 0x86], [9, 4, 0x86], [16, 1, 0x02], [17, 1, 0x02], [22, 2, 0x84], [124, 4, 0x86]]);
  bytes.push(0);
  u32(start + 1800); u32(start); bytes.push(1); u32(1_800_000); u32(1_750_000); u32(500_000); bytes.push(150, 178); u16(85); u32(2857);
  def(1, 20, [[253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [3, 1, 0x02], [78, 4, 0x86], [5, 4, 0x86]]);
  for (let i = 0; i < 3; i++) {
    bytes.push(1);
    u32(start + i * 10); i32(Math.round((60.17 / 180) * 2 ** 31)); i32(Math.round((24.94 / 180) * 2 ** 31)); bytes.push(140 + i); u32((20 + 500) * 5); u32(i * 3000);
  }
  const header = [14, 0x20, 0x08, 0x08];
  const dataSize = bytes.length;
  const head = [...header, dataSize & 0xff, (dataSize >> 8) & 0xff, (dataSize >> 16) & 0xff, (dataSize >> 24) & 0xff, 0x2e, 0x46, 0x49, 0x54, 0, 0];
  return Uint8Array.from([...head, ...bytes, 0, 0]);
}
