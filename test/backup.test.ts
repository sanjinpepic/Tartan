import { describe, expect, test } from "bun:test";
import { backupName, makeBackup, readBackup, restoreBackup } from "../src/backup.ts";
import { MemoryDisk } from "../src/disk.ts";

const PASS = "correct horse battery";

async function filled(): Promise<MemoryDisk> {
  const d = new MemoryDisk();
  await d.write("coach/plan.json", JSON.stringify({ title: "10k" }));
  await d.write("strength/log.json", "[]");
  await d.write("watch/Suunto Run 2 0A1B2C/logs/1.sml", Uint8Array.from([0, 1, 2, 250, 255]));
  await d.write("strava/tokens.json", '{"refresh":"r"}');
  await d.write("cache/streams/1.json", "x".repeat(1000));
  await d.write("strava/oauth-states.json", "{}");
  await d.write("events.jsonl", "{}\n");
  return d;
}

describe("backup", () => {
  test("everything comes back, binary and text, with the app's settings; caches and one-time state stay out", async () => {
    const file = await makeBackup(await filled(), PASS, { "freesuunto.remind": "on" }, new Date("2026-10-24T10:00:00Z"));
    const b = await readBackup(file, PASS);
    expect(b.created).toBe("2026-10-24T10:00:00.000Z");
    expect(b.app).toEqual({ "freesuunto.remind": "on" });
    expect(b.files.map((f) => f.path).sort()).toEqual(["coach/plan.json", "strava/tokens.json", "strength/log.json", "watch/Suunto Run 2 0A1B2C/logs/1.sml"]);
    const fresh = new MemoryDisk();
    expect(await restoreBackup(fresh, b)).toBe(4);
    expect([...((await fresh.read("watch/Suunto Run 2 0A1B2C/logs/1.sml")) ?? [])]).toEqual([0, 1, 2, 250, 255]);
    expect(await fresh.readText("coach/plan.json")).toBe('{"title":"10k"}');
  });
  test("nothing readable inside without the passphrase", async () => {
    const file = await makeBackup(await filled(), PASS);
    const text = new TextDecoder("latin1").decode(file);
    expect(text.startsWith("TARTANBK")).toBe(true);
    for (const s of ["10k", "refresh", "plan.json", "Suunto"]) expect(text.includes(s)).toBe(false);
  });
  test("a wrong passphrase, a changed byte, or another file fail in words", async () => {
    const file = await makeBackup(await filled(), PASS);
    await expect(readBackup(file, "wrong horse battery")).rejects.toThrow(/wrong passphrase/);
    const bent = file.slice();
    bent[bent.length - 20]! ^= 1;
    await expect(readBackup(bent, PASS)).rejects.toThrow(/wrong passphrase, or the file was changed/);
    const header = file.slice();
    header[30]! ^= 1;
    await expect(readBackup(header, PASS)).rejects.toThrow();
    await expect(readBackup(new TextEncoder().encode("not a backup at all, just some text here"), PASS)).rejects.toThrow(/isn't a Tartan backup/);
  });
  test("a short passphrase is refused; the file is named by day", async () => {
    await expect(makeBackup(new MemoryDisk(), "short")).rejects.toThrow(/at least 8/);
    expect(backupName(new Date("2026-10-24T10:00:00Z"))).toBe("tartan-backup-2026-10-24.tartan");
  });
});
