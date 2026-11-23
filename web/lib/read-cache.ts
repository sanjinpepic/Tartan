/**
 * What's been read stays read until something changes it. Your data changes only when something
 * writes it (a sync, a session marked, a plan saved, a note…), and every write goes through the
 * API as a POST, PUT or DELETE. So a GET of your own data is answered from memory until the next
 * write, the next day, or ten minutes at most (a paired PC can change things the phone doesn't
 * see). A write anywhere clears it all and tells whoever listens (Tartan 2's native screens).
 *
 * Only routes of your own data are kept; the coach's model checks, the weather, the sync log,
 * Strava's connection and the watch's files are always asked fresh.
 */
const KEEP = [
  "/api/today",
  "/api/plan",
  "/api/dashboard",
  "/api/days",
  "/api/week",
  "/api/durability",
  "/api/readiness",
  "/api/health",
  "/api/body",
  "/api/library/",
  "/api/activity/",
  "/api/goals",
  "/api/profile",
  "/api/race-shape",
  "/api/shoes",
  "/api/notes",
  "/api/lifts",
  "/api/routes",
  "/api/coach/status",
  "/api/coach/conversations",
];
const MAX_AGE = 10 * 60_000;

interface Kept {
  at: number;
  day: string;
  status: number;
  type: string;
  body: string;
}

type Requester = { request(path: string, init?: RequestInit): Promise<Response> };

const localDay = () => new Date().toLocaleDateString("sv");
const keepable = (path: string) => KEEP.some((k) => (k.endsWith("/") ? path.startsWith(k) : path === k || path.startsWith(`${k}?`) || path.startsWith(`${k}/`)));

const listeners = new Set<(path: string) => void>();
/** Called after every write (a sync, a mark, a save…), with the path written to. */
export function onDataChanged(fn: (path: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const forgetters = new Set<() => void>();
/**
 * Something changed the data without a write through the API (the engine kept new weather for
 * workouts in the background): forget what's kept and tell whoever listens, as a write does.
 */
export function dataChanged(path: string): void {
  for (const f of forgetters) f();
  for (const fn of listeners) fn(path);
}

/** Wrap an API so reads of your data are kept until a write. Returns a way to forget everything. */
export function keepReads(api: Requester): () => void {
  const kept = new Map<string, Kept>();
  const flying = new Map<string, Promise<Kept | null>>();
  let generation = 0;
  const forget = () => {
    kept.clear();
    flying.clear();
    generation++;
  };
  forgetters.add(forget);
  const real = api.request.bind(api);
  const answer = (k: Kept) => new Response(k.body, { status: k.status, headers: { "content-type": k.type } });
  api.request = async (path: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      const res = await real(path, init);
      if (!res.ok) return res;
      const wrote = () => {
        forget();
        for (const fn of listeners) fn(path);
      };
      wrote();
      // A streamed answer (the coach's chat) keeps writing until it ends (the plan, the conversation):
      // forget again then.
      if (res.body && /ndjson|event-stream/.test(res.headers.get("content-type") ?? "")) {
        const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: wrote }));
        return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      return res;
    }
    if (!keepable(path)) return real(path, init);
    const hit = kept.get(path);
    if (hit && hit.day === localDay() && Date.now() - hit.at < MAX_AGE) return answer(hit);
    // One read in flight per path: a second asker waits for the first.
    let p = flying.get(path);
    if (!p) {
      const gen = generation;
      p = (async () => {
        const res = await real(path, init);
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
        const k: Kept = { at: Date.now(), day: localDay(), status: res.status, type: res.headers.get("content-type") ?? "application/json", body: await res.text() };
        // A write landed while this was being read: answer with it, but don't keep it.
        if (gen === generation) kept.set(path, k);
        return k;
      })().finally(() => flying.delete(path));
      flying.set(path, p);
    }
    const k = await p.catch(() => null);
    return k ? answer(k) : real(path, init);
  };
  return forget;
}
