/**
 * Local web app + API + MCP endpoint.
 *
 *   /            the Web Bluetooth UI
 *   /api/...     storage for watch backups, Strava connect/sync, the activity library
 *   /mcp         MCP (Streamable HTTP) for LLM agents
 *
 * Binds to localhost by default. With `lan: true` it also listens on the network, but a phone
 * reaches it only through pairing and the end-to-end encrypted tunnel (src/link.ts): every
 * other route answers this computer's own browser and tools alone, and only under this
 * computer's own names (a Host check, so a web page can't reach it by DNS rebinding).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { fileURLToPath } from "node:url";
import { hostname, networkInterfaces } from "node:os";
import { b64, PairingDesk, serveTunnel, showCode, unb64 } from "./link.ts";
import { readJson } from "./disk.ts";
import index from "../web/index.html";
import { createApi, ndjson } from "./api.ts";
import { Analytics } from "./analytics.ts";
import { Coach } from "./coach.ts";
import { NodeDisk } from "./disk-node.ts";
import { Library } from "./library.ts";
import { createMcpServer } from "./mcp.ts";
import { LocalStore } from "./store.ts";

export interface ServerOptions {
  port?: number;
  hostname?: string;
  store?: LocalStore;
  /** Accept authenticated requests from other devices (the Android app). */
  lan?: boolean;
  quiet?: boolean;
  /** For tests: Anthropic SDK client options (e.g. a mock baseURL). */
  coachClient?: { baseURL?: string };
}

export async function startServer(opts: ServerOptions = {}) {
  const store = opts.store ?? new LocalStore(new NodeDisk());
  const library = new Library(store.disk);
  const analytics = new Analytics(library);
  const coach = new Coach(library, opts.coachClient);
  const api = createApi({ store, library, analytics, coach, stravaRedirect: (req) => `${new URL(req.url).origin}/api/strava/callback` });
  const lan = !!opts.lan;
  // The old plain-HTTP pairing token is gone (phones use the encrypted link): don't leave it lying around.
  if (await store.disk.readText("pairing-token.txt").catch(() => null)) await store.disk.write("pairing-token.txt", "", { secret: true }).catch(() => {});

  // Phones paired with this PC, each with its own link key (src/link.ts), owner-only on disk.
  const DEVICES = "link/devices.json";
  type Devices = Record<string, { key: string; name: string; at: string }>;
  const devices = async () => (await readJson<Devices>(store.disk, DEVICES)) ?? {};
  const desk = new PairingDesk(async (device, key, name) => {
    const all = await devices();
    all[device] = { key: b64(key), name, at: new Date().toISOString() };
    await store.disk.write(DEVICES, JSON.stringify(all), { secret: true });
  }, hostname());
  const seen = new Map<string, number>();
  const startedAt = Date.now();
  /** Pairing and the tunnel answer any origin (the phone app): what they carry is sealed or proves itself. */
  const open = (fn: (req: Request) => Promise<Response>) => async (req: Request) => {
    if (!hostOk(req)) return new Response("unknown host", { status: 421 });
    const res = opts.lan ? await fn(req) : Response.json({ error: "Start Tartan on the PC with --lan to pair a phone." }, { status: 409 });
    res.headers.set("access-control-allow-origin", req.headers.get("origin") ?? "*");
    return res;
  };

  // Assigned right after Bun.serve(); handlers only run once it is set.
  let ref: { requestIP(req: Request): { address: string } | null; port?: number } | null = null;
  /** This computer: loopback, or one of its own network addresses (its browser opened at the LAN address). */
  const own = () => new Set(Object.values(networkInterfaces()).flat().filter(Boolean).map((i) => i!.address));
  let mine = own();
  setInterval(() => (mine = own()), 60_000).unref?.();
  const isLocal = (req: Request) => {
    const ip = (ref?.requestIP(req)?.address ?? "").replace(/^::ffff:/, "");
    return ip === "127.0.0.1" || ip === "::1" || mine.has(ip);
  };
  /**
   * Asked for by one of this computer's own names: localhost, a loopback address, one of its
   * network addresses, or its host name. A page that points its own domain at 127.0.0.1 (DNS
   * rebinding) arrives with that domain in Host, and is turned away before anything else.
   */
  const names = () => new Set(["localhost", "127.0.0.1", "::1", hostname().toLowerCase(), `${hostname().toLowerCase()}.local`, ...mine]);
  const hostOk = (req: Request) => {
    const host = (req.headers.get("host") ?? "").toLowerCase();
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
    if (!m) return false;
    const name = m[1]!.replace(/^\[|\]$/g, "");
    return names().has(name) && (!m[2] || !ref?.port || Number(m[2]) === ref.port);
  };
  /** This computer's own browser (same origin) or its own tools (no Origin), under its own name. */
  const allowed = (req: Request) => {
    if (!hostOk(req) || !isLocal(req)) return false;
    const origin = req.headers.get("origin");
    return !origin || origin === new URL(req.url).origin;
  };
  const cors = (req: Request): Record<string, string> =>
    req.method === "OPTIONS"
      ? {
          "access-control-allow-origin": req.headers.get("origin") ?? "*",
          "access-control-allow-headers": "content-type, x-tartan-device, mcp-session-id, mcp-protocol-version",
          "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
        }
      : {};
  const guard =
    (fn: (req: Request) => Response | Promise<Response>) =>
    async (req: Request): Promise<Response> => {
      if (!hostOk(req)) return new Response("unknown host", { status: 421 });
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      if (!allowed(req)) {
        // Readable by the phone app so it can say why instead of a bare network error.
        const origin = req.headers.get("origin");
        return new Response("forbidden: this computer only (phones use the encrypted link)", { status: 403, headers: origin ? { "access-control-allow-origin": origin } : {} });
      }
      const res = await fn(req);
      for (const [k, v] of Object.entries(cors(req))) res.headers.set(k, v);
      return res;
    };
  /** Every API route answers CORS preflight (the Android app calls from another origin). */
  const withPreflight = <R extends Record<string, unknown>>(routes: R): R => {
    for (const [path, handlers] of Object.entries(routes)) {
      if (path.startsWith("/api/") || path === "/mcp") {
        if (handlers && typeof handlers === "object" && !("OPTIONS" in handlers)) {
          (handlers as Record<string, unknown>).OPTIONS = guard(() => new Response(null, { status: 204 }));
        }
      }
    }
    return routes;
  };

  const server = Bun.serve({
    port: opts.port ?? 5173,
    hostname: opts.hostname ?? "127.0.0.1",
    development: process.env.NODE_ENV !== "production" && !opts.lan,
    idleTimeout: 255,
    routes: withPreflight({
      "/": index,
      // The map's worker and stylesheet, loaded by the route editor (web/lib/map.ts); the app ships copies in dist/maplibre/.
      "/maplibre/:file": (req: Request & { params: { file: string } }) => {
        const file = req.params.file;
        if (!["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs", "maplibre-gl.css"].includes(file)) return new Response("not found", { status: 404 });
        return new Response(Bun.file(fileURLToPath(new URL(`../node_modules/maplibre-gl/dist/${file}`, import.meta.url))), {
          headers: { "content-type": file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": "max-age=86400" },
        });
      },

      // Everything else under /api/ is the shared handler (see fetch below); these need the PC.
      "/api/strava/callback": {
        GET: async (req: Request) => {
          const q = new URL(req.url).searchParams;
          if (q.get("error") || !q.get("code")) return Response.redirect("/?strava=denied#sync", 302);
          try {
            await api.stravaExchange(q.get("state") ?? "", q.get("code")!, q.get("scope") ?? undefined);
            return Response.redirect("/?strava=connected#sync", 302);
          } catch (e) {
            return Response.redirect(`/?strava=error&message=${encodeURIComponent((e as Error).message)}#sync`, 302);
          }
        },
      },

      // ---------------------------------------------------------------- pairing a phone, and its encrypted link
      "/api/pair/start": {
        // On this PC only: a code to type on the phone, good for 10 minutes.
        POST: guard(async (req) => {
          if (!opts.lan) return Response.json({ error: "Start Tartan on the PC with --lan (bun src/cli.ts serve --lan) so the phone can reach it." }, { status: 409 });
          if (!isLocal(req)) return new Response("forbidden", { status: 403 });
          const { code, until } = desk.start();
          return Response.json({ code: showCode(code), until, urls: lanUrls(ref?.port ?? 0), name: hostname() });
        }),
      },
      // The page the PC's QR code opens on the phone: a tap hands the address and code to Tartan.
      "/pair": (req: Request) => {
        if (!opts.lan) return new Response("not found", { status: 404 });
        const q = new URL(req.url).searchParams;
        const code = (q.get("code") ?? "").replace(/[^0-9A-Za-z-]/g, "").slice(0, 13);
        const base = `http://${req.headers.get("host") ?? ""}`.replace(/[^\w.:/-]/g, "");
        return new Response(pairPage(base, code), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      },
      // The phone looks for this PC among its addresses: the first that answers is the one.
      "/api/pair/ping": { GET: open(async () => Response.json({ tartan: true, name: hostname() })) },
      "/api/pair/hello": {
        POST: open(async (req) => {
          const r = await desk.hello((await req.json().catch(() => ({}))) as { pub?: string });
          return Response.json(r, { status: "error" in r ? 403 : 200 });
        }),
      },
      "/api/pair/confirm": {
        POST: open(async (req) => {
          const r = await desk.confirm((await req.json().catch(() => ({}))) as { session?: string; proof?: string; name?: string });
          return Response.json(r, { status: "error" in r ? 403 : 200 });
        }),
      },
      "/api/link/tunnel": {
        POST: open((req) => serveTunnel(req, async (d) => ((await devices())[d] ? unb64((await devices())[d]!.key) : null), async (r) => (await api.handle(r)) ?? new Response("not found", { status: 404 }), seen, startedAt)),
      },
      "/api/link/devices": {
        // On this PC only: the phones paired with it, and forgetting one.
        GET: guard(async (req) => (isLocal(req) ? Response.json(Object.entries(await devices()).map(([id, d]) => ({ id, name: d.name, at: d.at }))) : new Response("forbidden", { status: 403 }))),
        DELETE: guard(async (req) => {
          if (!isLocal(req)) return new Response("forbidden", { status: 403 });
          const id = new URL(req.url).searchParams.get("id") ?? "";
          const all = await devices();
          delete all[id];
          await store.disk.write(DEVICES, JSON.stringify(all), { secret: true });
          return new Response(null, { status: 204 });
        }),
      },

      // ---------------------------------------------------------------- server info for the UI
      "/api/server": {
        GET: guard(async (req) =>
          Response.json({
            mcpUrl: `${new URL(req.url).origin}/mcp`,
            cliPath: fileURLToPath(new URL("./cli.ts", import.meta.url)),
            bunPath: process.execPath,
            platform: process.platform,
            dataDir: store.root,
            lan,
            lanUrls: lan ? lanUrls(ref?.port ?? 0) : [],
          }),
        ),
      },

      // ---------------------------------------------------------------- MCP
      "/mcp": {
        POST: guard(async (req) => {
          // Stateless: a fresh server + transport per request, JSON responses.
          const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          const mcp = createMcpServer({ library });
          await mcp.connect(transport);
          const res = await transport.handleRequest(req);
          void mcp.close();
          return res;
        }),
        GET: guard(() => new Response("Method not allowed: this MCP endpoint is stateless (POST only).", { status: 405, headers: { allow: "POST" } })),
        DELETE: guard(() => new Response(null, { status: 405 })),
      },
    }),
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (!path.startsWith("/api/")) return new Response("not found", { status: 404 });
      // Everything a device copies (keys and health among it) goes only through the encrypted
      // tunnel, or to the browser on this PC: never in the clear over the network.
      if ((path.startsWith("/api/transfer/") || path.startsWith("/api/link/") || path.startsWith("/api/backup")) && !isLocal(req)) return new Response("only through the encrypted link", { status: 403 });
      return guard(async (r) => (await api.handle(r)) ?? new Response("not found", { status: 404 }))(req);
    },
    error: (e) => Response.json({ error: e.message }, { status: e.message.startsWith("refusing path") ? 400 : 500 }),
  });

  ref = server;
  if (!opts.quiet) {
    console.error(`Tartan is running at ${server.url.hostname === "0.0.0.0" ? `http://localhost:${server.port}/` : server.url}  (data: ${store.root})`);
    console.error(`MCP endpoint: ${server.url.hostname === "0.0.0.0" ? `http://localhost:${server.port}/` : server.url}mcp`);
    if (lan) {
      console.error(`LAN mode: the Android app can reach this computer at ${lanUrls(server.port!).join(" or ")}`);
      console.error(`Pair a phone: open Tartan here, Settings → More → Phone app → Pair a phone (a code to type on the phone).`);
    }
    console.error("Open the UI in Chrome or Edge (Web Bluetooth is not available in Firefox or Safari).");
  }
  return server;
}

/** A small page for the phone's browser: open Tartan with this PC's address and the code. */
function pairPage(base: string, code: string): string {
  const q = `url=${encodeURIComponent(base)}&code=${encodeURIComponent(code)}`;
  const intent = `intent://localhost/pair?${q}#Intent;scheme=tartan;package=dev.freesuunto.app;end`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open in Tartan</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px 20px;background:#fbf6f4;color:#231a17;display:grid;gap:16px;max-width:420px}h1{font-size:28px;margin:0}a.b{display:block;text-align:center;padding:16px;border-radius:28px;background:#a8321f;color:#fff;font-weight:700;text-decoration:none}code{font-size:20px;letter-spacing:.1em}p{margin:0;color:#5c4f4a}</style>
<h1>Pair with Tartan</h1><p>This phone pairs with Tartan on your PC, end to end encrypted.</p>
<a class="b" href="${intent}">Open in Tartan</a>
<p>Nothing happens? Install Tartan on this phone first, or in the app go to Settings → More → Your PC and type <b>${base.replace(/^http:\/\//, "")}</b> and the code <code>${code}</code>.</p>
<script>setTimeout(function(){location.href=${JSON.stringify(`tartan://localhost/pair?${q}`)}},300)</script>`;
}

/** Adapters a phone on the Wi-Fi can't reach: virtual machines, containers, WSL, VPNs. */
const VIRTUAL = /vethernet|wsl|docker|br-|veth|virbr|vbox|virtualbox|vmware|vmnet|hyper-v|tailscale|zerotier|utun|tun\d|tap\d|wg\d|loopback/i;

/** This PC's addresses on the network, the Wi-Fi/Ethernet ones (home ranges) first. */
function lanUrls(port: number): string[] {
  const rank = (name: string, ip: string) => (VIRTUAL.test(name) ? 3 : /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : 2);
  return Object.entries(networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).filter((i) => i.family === "IPv4" && !i.internal).map((i) => ({ name, ip: i.address })))
    .sort((a, b) => rank(a.name, a.ip) - rank(b.name, b.ip))
    .map((i) => `http://${i.ip}:${port}`);
}

if (import.meta.main) {
  await startServer({ port: Number(process.env.PORT ?? 5173), hostname: process.env.HOST ?? "127.0.0.1", lan: process.env.LAN === "1" });
}
