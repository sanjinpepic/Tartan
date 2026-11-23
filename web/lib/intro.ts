/**
 * Whether and where the intro shows (views/onboard.ts on the web, IntroScreen natively): shown
 * once, resumed at its step when Strava's sign-in leaves the app and comes back, skipped by an
 * install that already has workouts; `force` replays it from Settings.
 */
import { app } from "../state.ts";
import { shellIntro } from "./shell.ts";

export const DONE = "freesuunto.onboarded";
export const STEP = "freesuunto.onboard.step";
export const LAST = 4;
export const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // no storage: the intro simply shows again next time
    }
  },
};

/** The web's own intro (views/onboard.ts), when the app has one: set by its entry. */
let webIntro: ((step: number) => void) | null = null;
export const setWebIntro = (f: (step: number) => void) => void (webIntro = f);

export async function maybeOnboard(force = false): Promise<void> {
  if (document.querySelector(".onboard")) return;
  let step = Number(store.get(STEP) ?? -1);
  if (!force) {
    if (store.get(DONE)) return;
    if (step < 0) {
      const o = await app.api.json<{ activities?: { total?: number } }>("/api/library/overview").catch(() => null);
      if ((o?.activities?.total ?? 0) > 0) return store.set(DONE, "1");
    }
  } else step = 0;
  const at = Math.max(0, Math.min(LAST, step));
  // Tartan 2: the intro is native.
  if (await shellIntro(at)) return;
  webIntro?.(at);
}

/** The native intro: where it is (Strava's sign-in leaves the app and comes back to it). */
export const introStep = (step: number) => store.set(STEP, String(step));
/** The native intro is over: shown once; Today, or the whole app again after a copy or a restore. */
export function introDone(reload = false, toToday = true): void {
  store.set(DONE, "1");
  store.set(STEP, null);
  if (reload) return location.reload();
  if (!toToday) return;
  if (location.hash !== "#today" && location.hash !== "") location.hash = "#today";
}
