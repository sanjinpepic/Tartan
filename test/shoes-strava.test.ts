/** Shoes and Strava: its pairs come in with the sync, and a linked pair can be set on its runs there. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDisk } from "../src/disk-node.ts";
import { Library } from "../src/library.ts";
import { Shoes, shoeRuns, shoesNow, toStrava } from "../src/shoes.ts";
import type { StravaAthlete } from "../src/strava/client.ts";
import { syncStrava } from "../src/strava/sync.ts";
import { startMockStrava } from "./sim/mock-strava.ts";

let mock: ReturnType<typeof startMockStrava>;
beforeEach(() => {
  mock = startMockStrava({ activities: 6 });
  process.env.STRAVA_API_BASE = `${mock.url}/api/v3`;
  process.env.STRAVA_OAUTH_BASE = `${mock.url}/oauth`;
});
afterEach(() => mock.stop());

async function setup(scope: string) {
  const lib = new Library(new NodeDisk(mkdtempSync(join(tmpdir(), "tartan-shoes-"))));
  await lib.strava.writeSecret({ clientId: "cid", clientSecret: "secret" }, "config.json");
  await (await lib.strava.client())!.exchangeCode("good-code", scope);
  await syncStrava((await lib.strava.client())!, lib.strava);
  lib.invalidate();
  return lib;
}

test("Strava's pair comes in once, with its runs; a run moved to it is set on Strava", async () => {
  const lib = await setup("read,activity:read_all,profile:read_all,activity:write");
  const athlete = (await lib.strava.read<StravaAthlete>("athlete.json"))!;
  const shoes = new Shoes(lib.disk);
  expect(await shoes.importStrava(athlete.shoes!, await shoeRuns(lib))).toEqual({ added: ["Saucony Endorphin Speed 4"], linked: [] });
  expect((await shoes.importStrava(athlete.shoes!, await shoeRuns(lib))).added).toEqual([]);

  const v = await shoesNow(lib);
  const pair = v.shoes[0]!;
  // The only pair: all six runs count to it (three have it on Strava, three have none), plus the 42 km from before.
  expect(pair).toMatchObject({ strava_id: "g11", runs: 6, start_km: 42 });
  expect(v.strava).toEqual({ connected: true, can_write: true });
  // The three without a pair on Strava are the ones to set there.
  expect(v.to_strava[pair.id]).toBe(3);

  const data = await shoes.read();
  const bare = toStrava(await shoeRuns(lib), data, pair.id)[0]!;
  await (await lib.strava.client())!.updateActivity(bare.strava!, { gear_id: "g11" });
  await lib.strava.setGear(bare.strava!, "g11");
  expect(mock.counts.gear).toBe(1);
  expect(mock.activities.find((a) => String(a.id) === bare.strava)!.gear_id).toBe("g11");
  expect(toStrava(await shoeRuns(lib), data, pair.id)).toHaveLength(2);
  // Moved to no shoes here: not counted, not offered.
  await shoes.assign(bare.id, null);
  expect((await shoesNow(lib)).shoes[0]!.runs).toBe(5);
});

test("without permission to change activities, nothing is sent", async () => {
  const lib = await setup("read,activity:read_all,profile:read_all");
  expect((await shoesNow(lib)).strava).toEqual({ connected: true, can_write: false });
  expect((await lib.strava.client())!.canUpload).toBe(false);
});
