/**
 * Material You (TartanThemePlugin): the colours Android made from your wallpaper, or Tartan's own.
 * The wallpaper's are the default in the Android app on Android 12+; Settings → More → Colours
 * switches. They replace the tonal tokens (primary, the surfaces, ink, outline) in light and dark;
 * the data colours, zones, status colours and the timing board stay Tartan's, so a chart reads the
 * same whatever the wallpaper.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

type Roles = Record<string, string>;
const Theme = registerPlugin<{ colors(): Promise<{ available: boolean; light?: Roles; dark?: Roles }> }>("TartanTheme");
const KEY = "tartan.colours";
const STYLE = "wallpaper-colours";

export type ColourChoice = "wallpaper" | "tartan";

export function colourChoice(): ColourChoice {
  try {
    return localStorage.getItem(KEY) === "tartan" ? "tartan" : "wallpaper";
  } catch {
    return "wallpaper";
  }
}

let cached: Promise<{ light: Roles; dark: Roles } | null> | null = null;
/** The wallpaper's colours, when this phone has them (asked again with `fresh`, e.g. coming back to the app). */
export function wallpaperColours(fresh = false): Promise<{ light: Roles; dark: Roles } | null> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(null);
  if (!cached || fresh)
    cached = Theme.colors()
      .then((r) => (r.available && r.light?.primary && r.dark?.primary ? { light: r.light, dark: r.dark } : null))
      .catch(() => null);
  return cached;
}

/** Tartan's tokens from Material's roles. */
export function tokens(r: Roles, dark: boolean): string {
  const v: Record<string, string | undefined> = {
    "--primary": r.primary,
    "--on-primary": r.on_primary,
    "--primary-container": r.primary_container,
    "--on-primary-container": r.on_primary_container,
    "--secondary-container": r.secondary_container,
    "--on-secondary-container": r.on_secondary_container,
    "--inverse-surface": r.inverse_surface,
    "--inverse-on": r.inverse_on_surface,
    "--inverse-primary": r.inverse_primary,
    "--bg": r.surface,
    "--surface-1": r.surface_container,
    "--surface-2": dark ? r.surface_container_high : r.surface_container_highest,
    "--surface-3": dark ? r.surface_container_highest : r.surface_dim,
    "--outline": r.outline_variant,
    "--hairline": r.outline_variant && r.surface_container ? `color-mix(in srgb, ${r.outline_variant} 55%, ${r.surface_container})` : undefined,
    "--ink": r.on_surface,
    "--ink-2": r.on_surface_variant,
    "--ink-3": r.outline,
  };
  return Object.entries(v)
    .filter(([, x]) => x && /^(#[0-9a-f]{6}|color-mix\([^;{}]*\))$/i.test(x))
    .map(([k, x]) => `${k}: ${x};`)
    .join(" ");
}

/** Put the chosen colours on the page (and the status bar's); false when Tartan's own are showing. */
export async function applyColours(fresh = false): Promise<boolean> {
  document.getElementById(STYLE)?.remove();
  const meta = (scheme: "light" | "dark", colour: string) => document.querySelector<HTMLMetaElement>(`meta[name="theme-color"][media*="${scheme}"]`)?.setAttribute("content", colour);
  if (colourChoice() === "tartan") {
    meta("light", "#fff8f6");
    meta("dark", "#1a1110");
    return false;
  }
  const c = await wallpaperColours(fresh);
  if (!c) return false;
  const style = Object.assign(document.createElement("style"), { id: STYLE });
  style.textContent = `:root { ${tokens(c.light, false)} }\n@media (prefers-color-scheme: dark) { :root { ${tokens(c.dark, true)} } }`;
  document.head.append(style);
  meta("light", c.light.surface ?? "#fff8f6");
  meta("dark", c.dark.surface ?? "#1a1110");
  return true;
}

/**
 * One design, two materials: the floating bars are solid tonal Material on Android (and the web),
 * glass on iOS. Layout, type, shapes and motion are the same; only what the bars are made of differs.
 */
export function applyMaterial(): void {
  document.documentElement.dataset.material = Capacitor.getPlatform() === "ios" ? "glass" : "tonal";
}

export async function setColourChoice(c: ColourChoice): Promise<void> {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    // no storage: this visit only
  }
  await applyColours();
  window.dispatchEvent(new Event("tartan:colours"));
}
