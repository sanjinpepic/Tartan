/**
 * The Android app runs Tartan itself: library, merging, Strava sync, analytics and the
 * coach, on the phone's own storage. The UI talks to it exactly as it talks to the PC
 * server, only the request never leaves the app.
 */
import { Capacitor } from "@capacitor/core";
import { Analytics } from "../src/analytics.ts";
import { createApi, type Api } from "../src/api.ts";
import { Coach } from "../src/coach.ts";
import type { Disk } from "../src/disk.ts";
import { Library } from "../src/library.ts";
import { LocalStore } from "../src/store.ts";
import { ServerBackend } from "./backend.ts";
import { CapacitorDisk } from "./disk-capacitor.ts";
import { nativeFetch } from "./native-fetch.ts";
import { modelHubClient } from "./lib/modelhub.ts";
import { registerPlugin } from "@capacitor/core";

/** Where the phone is (TartanShellPlugin.here). */
const Here = registerPlugin<{ here(): Promise<{ lon?: number; lat?: number; why?: string; age_s?: number }> }>("TartanShell");

/**
 * Where Strava sends you back to. In the app: the tartan:// link Android routes to it
 * (AndroidManifest.xml), from the Strava app or the browser tab alike. In the desktop preview:
 * the page itself.
 */
export const STRAVA_APP_RETURN = "tartan://localhost/strava";
const previewReturnUrl = () => `${location.origin}${location.pathname}${new URLSearchParams(location.search).has("device-storage") ? "?device-storage" : ""}`;

export class LocalApiBackend extends ServerBackend {
  readonly api: Api;

  constructor(disk: Disk = new CapacitorDisk(), native = Capacitor.isNativePlatform()) {
    super("");
    const store = new LocalStore(disk);
    const library = new Library(disk, { fetch: nativeFetch });
    // The key is the user's own and stays in app storage; requests go from the phone straight to Anthropic.
    // On the phone, Model Hub too: the phone's own models, shared by every app.
    const coach = new Coach(library, {
      dangerouslyAllowBrowser: true,
      ...(native && Capacitor.getPlatform() === "android" ? { modelHub: modelHubClient } : {}),
      // The coach's routes: where the phone is ("a loop from here"), and the watch to send one to.
      ...(native
        ? {
            routes: {
              // A fresh fix only (the phone side never gives one older than 10 minutes); why not, when none.
              whereAmI: async () => {
                const p = await Here.here().catch((e: Error) => ({ why: e.message }) as { lon?: number; lat?: number; why?: string });
                if (typeof p.lon === "number" && typeof p.lat === "number") return [p.lon, p.lat] as [number, number];
                throw new Error(p.why ?? "no location fix");
              },
              sendRoute: async (r: { name: string; line: Array<[number, number]>; elevation?: number[]; waypoints: Array<[number, number]> }) => (await import("./watch.ts")).sendRoute(r),
            },
          }
        : {}),
    });
    this.api = createApi({
      store,
      library,
      analytics: new Analytics(library),
      coach,
      stravaRedirect: native ? () => STRAVA_APP_RETURN : previewReturnUrl,
      stravaMobile: native,
    });
  }

  override async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.api.handle(new Request(new URL(path, "http://tartan.app"), init));
    return res ?? new Response("not found", { status: 404 });
  }

  /** Watch files open through the API, not a URL. */
  override fileUrl(): string {
    return "";
  }
}
