/**
 * Routes the coach makes from what you ask ("5 km near home", "from here, somewhere green",
 * "to the lake and back"): where it starts (here, home, or a place by name), its shape (a loop,
 * out and back, or to a place), how far, and what you'd like it to be (nature, quiet, flat,
 * hilly). Several candidates are routed along paths (src/route-loop.ts, src/route-finder.ts),
 * scored (src/scenery.ts for green and quiet, heights for flat and hilly) and the best kept, as a
 * route like one drawn in the editor.
 */
import { routeFinder, type Get } from "./route-finder.ts";
import { makeLoops, offset } from "./route-loop.ts";
import { climb, lineOf, metres, type LngLat, type RouteInput } from "./routes.ts";
import { features, sceneryOf, sceneryScore, type Scenery } from "./scenery.ts";

export type Shape = "loop" | "out_and_back" | "to";
export type Prefer = "nature" | "quiet" | "flat" | "hilly" | "any";

export interface RouteAsk {
  km?: number;
  /** "here", "home", or a place ("the harbour", "Central Park, Helsinki"). */
  start?: string;
  shape?: Shape;
  /** Where to, for shape "to" (or the turning point of an out and back). */
  to?: string;
  prefer?: Prefer;
  name?: string;
}

export interface MadeRoute {
  route: RouteInput;
  km: number;
  ascent_m?: number;
  scenery?: Scenery;
  /** Where it starts, in words ("your usual start", "where you are", "Kaivopuisto"). */
  from: string;
  /** The start's place on the map ("Kallio, Helsinki"), when the map knows it. */
  place?: string;
  /** The start, [lon, lat]. */
  start: LngLat;
  /** How many candidates were weighed. */
  weighed: number;
}

export interface RouteDeps {
  get: Get;
  /** Where the phone is now: a fresh fix only (null, or it throws why: no location, or not on a phone). */
  whereAmI?: () => Promise<LngLat | null>;
  /** Where you usually start your runs. */
  home: () => Promise<LngLat | null>;
  log?: (m: string) => void;
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const REVERSE = "https://nominatim.openstreetmap.org/reverse";
/** Further than this from your usual start, you're away: "home" means where you are. */
const AWAY_M = 25_000;

/** The neighbourhood and town at a point ("Kallio, Helsinki"); null when the map can't say. */
export async function placeName(get: Get, at: LngLat): Promise<string | null> {
  try {
    const res = await get(`${REVERSE}?lat=${at[1]}&lon=${at[0]}&format=jsonv2&zoom=14`);
    if (!res.ok) return null;
    const a = ((await res.json()) as { address?: Record<string, string> }).address ?? {};
    const near = a.suburb ?? a.neighbourhood ?? a.quarter ?? a.city_district ?? a.village;
    const town = a.city ?? a.town ?? a.municipality ?? a.village ?? a.county;
    return [...new Set([near, town].filter(Boolean))].join(", ") || null;
  } catch {
    return null;
  }
}

/** A place by name, near `near` when known (OpenStreetMap's Nominatim). */
export async function placeOf(get: Get, q: string, near?: LngLat | null): Promise<{ at: LngLat; name: string } | null> {
  const box = near ? `&viewbox=${near[0] - 0.4},${near[1] + 0.25},${near[0] + 0.4},${near[1] - 0.25}` : "";
  try {
    const res = await get(`${NOMINATIM}?q=${encodeURIComponent(q)}&format=jsonv2&limit=1${box}`);
    if (!res.ok) return null;
    const j = (await res.json()) as Array<{ lat?: string; lon?: string; name?: string; display_name?: string }>;
    const p = j[0];
    if (!p?.lat || !p.lon) return null;
    return { at: [Number(p.lon), Number(p.lat)], name: p.name || p.display_name?.split(",")[0] || q };
  } catch {
    return null;
  }
}

/**
 * Where your runs usually start: of your recent workouts with GPS (newest first), the start that
 * most others began within 400 m of, at its most recent exact point.
 */
export function usualStart(starts: LngLat[]): LngLat | null {
  if (!starts.length) return null;
  let best = starts[0]!;
  let most = 0;
  for (const s of starts) {
    const n = starts.filter((o) => metres(s, o) <= 400).length;
    if (n > most) [best, most] = [s, n];
  }
  return best;
}

const lengthKm = (legs: LngLat[][]) => {
  const line = lineOf(legs.map((coords) => ({ mode: "paths" as const, coords })));
  let m = 0;
  for (let i = 1; i < line.length; i++) m += metres(line[i - 1]!, line[i]!);
  return m / 1000;
};

interface Candidate {
  waypoints: LngLat[];
  legs: LngLat[][];
  km: number;
}

export async function makeRoute(ask: RouteAsk, deps: RouteDeps): Promise<MadeRoute> {
  const finder = routeFinder(deps.get, deps.log);
  const prefer: Prefer = ask.prefer ?? "any";
  const shape: Shape = ask.shape ?? (ask.to ? "to" : "loop");
  const km = ask.km && ask.km > 0 ? Math.min(60, ask.km) : undefined;
  if (shape !== "to" && !km) throw new Error("How far? Say a distance (or the coach takes today's planned run).");

  // Where it starts. Where the phone is, fresh, comes first: you may be far from home.
  const home = await deps.home().catch(() => null);
  let whyNoHere = "";
  const here = deps.whereAmI ? await deps.whereAmI().catch((e: Error) => ((whyNoHere = e.message), null)) : null;
  const away = !!here && !!home && metres(here, home) > AWAY_M;
  const startWord = (ask.start ?? "").trim();
  let start: LngLat | null = null;
  let from = "";
  if (/^(here|current|my location|where i am|near me)$/i.test(startWord)) {
    start = here;
    if (!start) throw new Error(`Tartan couldn't get where you are${whyNoHere ? ` (${whyNoHere.replace(/\.$/, "")})` : ""}: turn on location, step outside for a fix, or say a place to start from.`);
    from = "where you are";
  } else if (/^(home|usual|my usual start|)$/i.test(startWord)) {
    // Asked from home (or nothing said) while you're away: from where you are, and said so.
    const useHere = !!here && (startWord === "" || away);
    start = useHere ? here : (home ?? here);
    if (!start) throw new Error("Tartan doesn't know where you are or where you usually start (no location, no workouts with GPS): say a place to start from.");
    from = useHere ? (away && /home|usual/i.test(startWord) ? "where you are (you're away from your usual start)" : "where you are") : home ? "your usual start" : "where you are";
  } else {
    const p = await placeOf(deps.get, startWord, here ?? home);
    if (!p) throw new Error(`Couldn't find "${startWord}" on the map: try a fuller name (with the town).`);
    [start, from] = [p.at, p.name];
  }
  const place = /^where you are|^your usual start/.test(from) ? await placeName(deps.get, start) : null;

  const candidates: Candidate[] = [];
  const picky = prefer !== "any";
  if (shape === "loop") {
    const loops = await makeLoops(start, km!, async (a, b) => (await finder.footpath(a, b)).line, { count: picky ? 6 : 3, loop: finder.footloop });
    candidates.push(...loops.map((l) => ({ waypoints: l.waypoints, legs: l.legs, km: l.km })));
  } else if (shape === "out_and_back") {
    // Towards the place named, else several ways out; the turn moved until it's half the distance.
    const towards = ask.to ? await placeOf(deps.get, ask.to, start) : null;
    if (ask.to && !towards) throw new Error(`Couldn't find "${ask.to}" on the map: try a fuller name (with the town).`);
    const bearings = towards ? [bearingOf(start, towards.at)] : Array.from({ length: picky ? 6 : 3 }, (_, i) => (Math.random() * 60 + i * (360 / (picky ? 6 : 3))) % 360);
    for (const b of bearings) {
      let reach = (km! * 1000) / 2 / 1.25;
      let best: Candidate | null = null;
      for (let t = 0; t < 3; t++) {
        const turn = offset(start, b, reach);
        const out = (await finder.footpath(start, turn)).line;
        if (!out) break;
        const legs = [out, [...out].reverse()];
        const got = lengthKm(legs);
        const c = { waypoints: [start, out.at(-1)!, start], legs, km: Math.round(got * 100) / 100 };
        if (!best || Math.abs(got - km!) < Math.abs(best.km - km!)) best = c;
        if (Math.abs(got / km! - 1) <= 0.07) break;
        reach *= km! / got;
      }
      if (best && Math.abs(best.km / km! - 1) <= 0.15) candidates.push(best);
    }
  } else {
    if (!ask.to) throw new Error("Where to? Say the place the route should go to.");
    const dest = await placeOf(deps.get, ask.to, start);
    if (!dest) throw new Error(`Couldn't find "${ask.to}" on the map: try a fuller name (with the town).`);
    const p = await finder.footpath(start, dest.at);
    if (!p.line) throw new Error(p.reason === "no-path" ? `There's no way on foot to ${dest.name} from there.` : "The path finders couldn't be reached: check the connection.");
    candidates.push({ waypoints: [start, dest.at], legs: [p.line], km: Math.round(lengthKm([p.line]) * 100) / 100 });
    ask = { ...ask, to: dest.name };
  }
  if (!candidates.length) throw new Error(`No ${km ? `${km} km ` : ""}${shape === "loop" ? "loop" : "route"} along paths from ${from}: try another distance, or another start.`);

  // The best: the most scenic (or quiet, flat, hilly) of those close to the distance.
  const lines = candidates.map((c) => lineOf(c.legs.map((coords) => ({ mode: "paths" as const, coords }))));
  let scenery: Array<Scenery | undefined> = [];
  let pick = 0;
  if (prefer === "nature" || prefer === "quiet") {
    const f = await features(deps.get, lines);
    if (f) {
      scenery = lines.map((l) => sceneryOf(l, f));
      const score = scenery.map((s) => sceneryScore(s!, prefer));
      pick = score.indexOf(Math.max(...score));
    } else deps.log?.("Routes: the map's parks and trails couldn't be read (Overpass); the closest in distance is kept");
  }
  const heightsOf = await Promise.all(lines.map((l, i) => (prefer === "flat" || prefer === "hilly" || i === pick ? finder.heights(l) : Promise.resolve(null))));
  if (prefer === "flat" || prefer === "hilly") {
    const up = heightsOf.map((h, i) => (h ? climb(h).ascent_m / Math.max(0.1, candidates[i]!.km) : prefer === "flat" ? Infinity : -Infinity));
    pick = up.indexOf(prefer === "flat" ? Math.min(...up) : Math.max(...up));
  }
  const c = candidates[pick]!;
  const elevation = heightsOf[pick] ?? undefined;
  const ascent = elevation ? Math.round(climb(elevation).ascent_m) : undefined;
  const flavour = { nature: "green", quiet: "quiet", flat: "flat", hilly: "hilly", any: "" }[prefer];
  const name =
    ask.name?.trim() ||
    (shape === "to" ? `To ${ask.to}` : `${flavour ? `${flavour[0]!.toUpperCase()}${flavour.slice(1)} ` : ""}${Math.round(c.km * 10) / 10} km ${shape === "loop" ? "loop" : "out and back"}${place ? ` in ${place.split(", ")[0]}` : /^(your usual start|where you are)/.test(from) ? "" : ` from ${from}`}`);
  return {
    route: { name, waypoints: c.waypoints, segments: c.legs.map((coords) => ({ mode: "paths" as const, coords })), ...(elevation ? { elevation } : {}) },
    km: c.km,
    ...(ascent !== undefined ? { ascent_m: ascent } : {}),
    ...(scenery[pick] ? { scenery: scenery[pick] } : {}),
    from,
    ...(place ? { place } : {}),
    start,
    weighed: candidates.length,
  };
}

function bearingOf(a: LngLat, b: LngLat): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(r(b[0] - a[0])) * Math.cos(r(b[1]));
  const x = Math.cos(r(a[1])) * Math.sin(r(b[1])) - Math.sin(r(a[1])) * Math.cos(r(b[1])) * Math.cos(r(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
