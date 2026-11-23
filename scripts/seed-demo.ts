/**
 * Demo server for previews and screenshots: a mock Strava with 30 plausible runs, synced into a
 * throwaway data dir, plus sync-log events for the strip. Nothing touches the real data/ folder.
 *   bun scripts/seed-demo.ts /tmp/fs-demo 5199
 */
import { startMockStrava } from "../test/sim/mock-strava.ts";
import { StravaStore, syncStrava } from "../src/strava/sync.ts";
import { LocalStore } from "../src/store.ts";
import { NodeDisk } from "../src/disk-node.ts";
import { startServer } from "../src/server.ts";
const root = process.argv[2]!;
const mock = startMockStrava({ activities: 30 });
const names = ["Morning easy run", "Intervals 6×800 m", "Long run, Nuuksio trails", "Recovery jog", "Tempo 3×10 min", "Hill repeats", "Easy run with strides"];
mock.activities.length = 0;
for (let i = 0; i < 30; i++) {
  const t = Date.now() - (i * 1.7 + 0.4) * 86400_000;
  const long = i % 6 === 2;
  mock.activities.push({ id: 5000 + i, name: names[i % names.length]!, type: "Run", sport_type: i % 5 === 3 ? "TrailRun" : "Run",
    start_date: new Date(t).toISOString(), start_date_local: new Date(t).toISOString().replace("Z", ""),
    distance: long ? 21400 + i * 37 : 7300 + (i % 4) * 1630, moving_time: long ? 7420 : 2410 + (i % 4) * 560, elapsed_time: 2600,
    total_elevation_gain: 40 + (i * 13) % 180, average_speed: long ? 2.88 : 3.02 + (i % 3) * 0.17, max_speed: 4.1,
    average_heartrate: 138 + (i * 7) % 21, max_heartrate: 171, device_name: "Suunto Run 2" });
}
process.env.STRAVA_API_BASE = `${mock.url}/api/v3`; process.env.STRAVA_OAUTH_BASE = `${mock.url}/oauth`;
const strava = new StravaStore(new NodeDisk(root));
await strava.writeSecret({ clientId: "cid", clientSecret: "secret" }, "config.json");
await (await strava.client())!.exchangeCode("good-code");
await syncStrava((await strava.client())!, strava);
const store = new LocalStore(new NodeDisk(root));
const ev: string[] = [];
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400_000).toISOString();
for (const d of [12.6, 10.4, 8.9, 6.3, 4.2, 2.1, 0.35]) ev.push(JSON.stringify({ at: at(d), lane: "strava", kind: "sync", added: d > 9 ? 0 : 1, ok: true }));
for (const d of [11.2, 7.8, 5.1, 2.4]) ev.push(JSON.stringify({ at: at(d), lane: "watch", kind: "backup", added: d === 5.1 ? 0 : 3, ok: d !== 7.8 }));
for (const d of [9.5, 9.49, 6.1, 3.3, 1.2, 0.2, 0.19]) ev.push(JSON.stringify({ at: at(d), lane: "agent", kind: ["list_activities", "get_training_summary", "get_activity_streams"][Math.floor(d) % 3] }));
await Bun.write(`${root}/events.jsonl`, (await Bun.file(`${root}/events.jsonl`).text().catch(() => "")) + ev.join("\n") + "\n");
await startServer({ port: Number(process.argv[3] ?? 5199), store, lan: process.argv[4] === "lan" });
