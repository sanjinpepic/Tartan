/**
 * End-to-end test of the BlueZ D-Bus transport against a mock bluetoothd on a private
 * dbus-daemon. Skipped when dbus-daemon is not installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchSession } from "../src/protocol/session.ts";
import { Bluez } from "../src/transport/bluez.ts";
import { startFakeBluez } from "./sim/fake-bluez.ts";

const hasDaemon = Bun.which("dbus-daemon") !== null;
let daemon: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  if (!hasDaemon) return;
  const dir = mkdtempSync(join(tmpdir(), "tartan-dbus-"));
  const address = `unix:path=${join(dir, "bus")}`;
  daemon = Bun.spawn(["dbus-daemon", "--session", "--nofork", "--nopidfile", `--address=${address}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 50 && !(await Bun.file(join(dir, "bus")).exists()); i++) await Bun.sleep(20);
  process.env.DBUS_SYSTEM_BUS_ADDRESS = address;
});

afterAll(() => daemon?.kill());

describe.skipIf(!hasDaemon)("BlueZ transport (mock bluetoothd)", () => {
  const files = { "/logs/run.bin": new Uint8Array(3000).map((_, i) => (i * 7) & 0xff) };

  test("pair with passkey, connect, list and download", async () => {
    const fake = await startFakeBluez({ files, passkey: "123456", mtu: 127 });
    try {
      const log: string[] = [];
      const bz = await Bluez.connect();
      const paired = await bz.pair({ scanMs: 3000, askPasskey: async () => "123456", log: (m) => log.push(m) });
      expect(paired.name).toBe("Suunto Race 2 0042");
      expect(fake.state).toMatchObject({ paired: true, trusted: true, discovering: false, passkeyEntered: 123456 });
      bz.close();

      const bz2 = await Bluez.connect();
      const link = await bz2.open({ scanMs: 3000, log: (m) => log.push(m) });
      expect(link.chunkSize).toBe(124);
      expect(link.battery).toBe(87);
      const s = new WatchSession(link, { chunkDelayMs: 0, frameGapMs: 0 });
      await s.open();
      expect((await s.listDir("/")).dirs).toEqual(["logs"]);
      expect(await s.readFile("/logs/run.bin")).toEqual(files["/logs/run.bin"]);
      await s.close();
      expect(fake.state.connected).toBe(false);
    } finally {
      fake.stop();
    }
  }, 30_000);

  test("connecting without a bond fails with a helpful message", async () => {
    const fake = await startFakeBluez({ files });
    try {
      const bz = await Bluez.connect();
      await expect(bz.open({ scanMs: 2000 })).rejects.toThrow(/tartan pair/);
      bz.close();
    } finally {
      fake.stop();
    }
  }, 30_000);
});
