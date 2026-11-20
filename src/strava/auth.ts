import type { StravaClient, StravaTokens } from "./client.ts";

/**
 * One-shot OAuth callback listener for the CLI: prints the Strava consent URL, waits for
 * the redirect to http://localhost:<port>/strava/callback and exchanges the code.
 */
export async function authorizeInteractive(client: StravaClient, opts: { port?: number; log?: (m: string) => void } = {}): Promise<StravaTokens> {
  const log = opts.log ?? console.error;
  const state = crypto.randomUUID();
  const port = opts.port ?? 8721;
  const redirect = `http://localhost:${port}/strava/callback`;
  let settle!: { resolve: (t: StravaTokens) => void; reject: (e: Error) => void };
  const done = new Promise<StravaTokens>((resolve, reject) => (settle = { resolve, reject }));

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/strava/callback") return new Response("not found", { status: 404 });
      const page = (msg: string) => new Response(`<!doctype html><meta charset=utf-8><title>Tartan</title><p style="font:16px system-ui;padding:2rem">${msg}</p>`, { headers: { "content-type": "text/html" } });
      if (url.searchParams.get("state") !== state) return page("State mismatch. Start again from the terminal.");
      const error = url.searchParams.get("error");
      if (error) {
        settle.reject(new Error(`Strava authorization was declined (${error})`));
        return page("Authorization declined. You can close this tab.");
      }
      try {
        const tokens = await client.exchangeCode(url.searchParams.get("code") ?? "");
        settle.resolve(tokens);
        return page("Strava is connected. You can close this tab and go back to the terminal.");
      } catch (e) {
        settle.reject(e as Error);
        return page(`Token exchange failed: ${(e as Error).message}`);
      }
    },
  });
  log(`Open this URL in a browser on this computer and approve access:\n\n  ${client.authorizeUrl(redirect, state)}\n`);
  try {
    return await done;
  } finally {
    server.stop(true);
  }
}
