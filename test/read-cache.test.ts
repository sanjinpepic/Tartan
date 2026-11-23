import { expect, test } from "bun:test";
import { keepReads, onDataChanged } from "../web/lib/read-cache.ts";

test("reads of your data are kept until a write; a write clears them and says so", async () => {
  let n = 0;
  const api = {
    request: async (path: string, init: RequestInit = {}) => {
      n++;
      if ((init.method ?? "GET") !== "GET") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      return Response.json({ path, n });
    },
  };
  keepReads(api);
  let told = 0;
  const stop = onDataChanged(() => told++);

  const a = await (await api.request("/api/today")).json();
  const b = await (await api.request("/api/today")).json();
  expect(b).toEqual(a); // kept
  expect(n).toBe(1);
  // Two at once: one read.
  await Promise.all([api.request("/api/plan"), api.request("/api/plan")]);
  expect(n).toBe(2);
  // Not your data (the weather, the sync log): asked each time.
  await api.request("/api/weather");
  await api.request("/api/weather");
  expect(n).toBe(4);

  await api.request("/api/plan/mark", { method: "PUT", body: "{}" });
  expect(told).toBe(1);
  const c = await (await api.request("/api/today")).json();
  expect(c.n).toBeGreaterThan(a.n); // read again after the write
  stop();
});
