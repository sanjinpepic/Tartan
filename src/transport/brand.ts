/**
 * Which watch this is: Tartan works with one watch at a time, and its brand decides everything.
 * A Suunto is read and written over Bluetooth with Suunto's own protocol (src/protocol/); a Garmin
 * gets the day's session through Garmin Connect, to Tartan's watch app (garmin/, docs/garmin.md),
 * and its runs come back the way any Garmin run does (intervals.icu, Strava, Health Connect).
 *
 * "Find my watch" tells them apart by what a watch advertises over Bluetooth (the company id in
 * its manufacturer data: Bluetooth SIG's 0x0087 is Garmin, 0x009F is Suunto; else its name) and by
 * whether Garmin Connect reports a watch, and settles on one.
 */

export type WatchBrand = "suunto" | "garmin";

/** Bluetooth SIG company identifiers, as they lead a watch's manufacturer data. */
export const GARMIN_COMPANY = 0x0087;
export const SUUNTO_COMPANY = 0x009f;

/** Garmin's watch families, as their advertised names start or contain them. */
const GARMIN_NAME = /\b(garmin|forerunner|f[eē]nix|epix|venu|v[ií]voactive|vivomove|instinct|enduro|marq|quatix|tactix|descent|approach|bounce|d2 (air|mach|charlie|delta|bravo))\b|^(fr|fenix)\s?\d/i;
const SUUNTO_NAME = /\bsuunto\b/i;

/**
 * A watch's brand from what it advertises: the manufacturer data's company id first, then its
 * name. Anything else (headphones, a heart-rate strap, another brand's watch) is null.
 */
export function brandOf(x: { companies?: readonly number[]; name?: string | null }): WatchBrand | null {
  const c = x.companies ?? [];
  if (c.includes(GARMIN_COMPANY)) return "garmin";
  if (c.includes(SUUNTO_COMPANY)) return "suunto";
  const name = x.name ?? "";
  if (SUUNTO_NAME.test(name)) return "suunto";
  if (GARMIN_NAME.test(name)) return "garmin";
  return null;
}

/** The company ids in a Bluetooth scan result's manufacturer data (keyed by the id, in decimal or hex). */
export function companiesOf(manufacturerData: Record<string, unknown> | undefined | null): number[] {
  return Object.keys(manufacturerData ?? {})
    .map((k) => (/^0x/i.test(k) ? parseInt(k, 16) : Number(k)))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff);
}

export interface FoundWatch {
  brand: WatchBrand;
  name: string;
  /** Bluetooth address (Android) or identifier (iOS), for a Suunto to connect to; Garmin Connect's id for a Garmin. */
  id?: string;
  /** How it was found: advertising nearby, reported by Garmin Connect, or a Suunto this phone has paired. */
  via: "nearby" | "garmin-connect" | "paired";
  rssi?: number;
}

/**
 * One watch out of what was found, in this order: the strongest watch advertising nearby (a watch
 * woken next to the phone is the one meant); a watch Garmin Connect has connected right now; one
 * it knows; a Suunto this phone has paired. A Garmin found nearby takes Garmin Connect's name and
 * id for it when Garmin Connect has one, since that's the way its sessions go.
 */
export function pickWatch(nearby: FoundWatch[], garminConnect: Array<{ id: string; name: string; connected?: boolean }>, paired: FoundWatch | null): FoundWatch | null {
  const best = [...nearby].sort((a, b) => (b.rssi ?? -127) - (a.rssi ?? -127))[0];
  const gc = garminConnect.find((d) => d.connected) ?? garminConnect[0];
  if (best) {
    if (best.brand === "garmin" && gc) return { brand: "garmin", name: gc.name || best.name, id: gc.id, via: "garmin-connect" };
    return best;
  }
  if (gc) return { brand: "garmin", name: gc.name, id: gc.id, via: "garmin-connect" };
  return paired;
}

/** Suunto's Bluetooth work (backups, workouts, faces, routes) runs only for a Suunto (or before any watch is set). */
export const usesSuunto = (brand: WatchBrand | null): boolean => brand !== "garmin";
/** Sessions go to Garmin Connect only for a Garmin. */
export const usesGarmin = (brand: WatchBrand | null): boolean => brand === "garmin";
