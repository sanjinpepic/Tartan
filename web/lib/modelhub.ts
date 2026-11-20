/**
 * Model Hub (dev.modelhub: the owner's fork of AI Edge Gallery, with an API for other apps) as the
 * coach's model, through TartanModelHubPlugin. The model is downloaded once, in Model Hub, for every
 * app on the phone. src/coach-litert.ts's tool loop drives it (start / send / end). Only in the
 * Android app.
 */
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { HubState, ModelHubClient } from "../../src/coach-litert.ts";

interface ModelHubPlugin {
  state(): Promise<HubState>;
  allow(): Promise<{ allowed: boolean }>;
  open(o: { what: "app" | "updates" }): Promise<void>;
  dropOld(): Promise<void>;
  load(): Promise<{ backend: string; context?: number; photos?: boolean }>;
  start(o: { id: string; system: string; tools: string[]; history: Array<{ role: string; text: string }>; turns: number; temperature?: number; prepare?: boolean }): Promise<{ reused: boolean }>;
  send(o: { id: string; text?: string; image?: string; toolResults?: Array<{ name: string; result: string }> }): Promise<{ text: string; toolCalls: Array<{ name: string; args: Record<string, unknown> }> }>;
  stop(o: { id: string }): Promise<void>;
  end(o: { id: string }): Promise<void>;
  addListener(e: "hubText", f: (d: { id: string; text: string }) => void): Promise<PluginListenerHandle>;
}
const Hub = registerPlugin<ModelHubPlugin>("TartanModelHub");

export const hubState = () => Hub.state();
/** Android's prompt to let Tartan use Model Hub's models. */
export const allowModelHub = () => Hub.allow();
export const openModelHub = (what: "app" | "updates") => Hub.open({ what });
/** Tartan's own model file from before 2.37 (Model Hub holds the models now): removed, on the owner's word. */
export const dropOldModelFile = () => Hub.dropOld();

export const modelHubClient: ModelHubClient = {
  state: () => Hub.state(),
  // The model Model Hub uses for Tartan (none: it can't answer yet).
  status: async () => {
    const s = await Hub.state().catch(() => null);
    return { name: s?.installed && s.allowed ? s.model : undefined, loaded: !!s?.backend };
  },
  load: () => Hub.load(),
  start: (id, o) => Hub.start({ id, ...o }),
  async send(id, msg, onText) {
    const h = await Hub.addListener("hubText", (d) => d.id === id && onText(d.text));
    try {
      return await Hub.send({ id, ...msg });
    } finally {
      await h.remove();
    }
  },
  end: (id) => Hub.end({ id }),
};
