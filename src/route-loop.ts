/**
 * Loop routes from a start point: "10 km from here". Three turning points on a circle through
 * the start (its centre `r` away in a chosen direction), routed along paths in one go without
 * turning back at the points (so no dead-end spurs out to a point that lands off the paths), and
 * the circle scaled up to twice more until the loop is within 7% of the distance asked for.
 * Each direction gives a different loop; one more than 15% off isn't offered.
 */
import { lineOf, metres, type LngLat } from "./routes.ts";

export interface Loop {
  /** Start, three turning points, start again. */
  waypoints: LngLat[];
  /** The routed line between each pair of waypoints. */
  legs: LngLat[][];
  km: number;
  /** The direction the loop heads out in, degrees from north. */
  bearing: number;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The point `m` metres from `p` towards `bearing` degrees (great circle). */
export function offset(p: LngLat, bearing: number, m: number): LngLat {
  const [lon, lat] = [rad(p[0]), rad(p[1])];
  const d = m / R;
  const b = rad(bearing);
  const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(b));
  const lon2 = lon + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return [r6(deg(lon2)), r6(deg(lat2))];
}

/**
 * One routed line through `stops` (first and last the same for a loop), cut into a leg per pair
 * of stops at the line's closest points to each, in order. The stops come back moved onto the
 * line, and each leg starts and ends exactly on them.
 */
export function splitLoop(line: LngLat[], stops: LngLat[]): { legs: LngLat[][]; points: LngLat[] } {
  const cut = [0];
  for (let k = 1; k < stops.length - 1; k++) {
    let best = cut.at(-1)!;
    let bestD = Infinity;
    // Forward from the last cut, and not past what the remaining stops need.
    for (let i = cut.at(-1)! + 1; i < line.length - (stops.length - 1 - k); i++) {
      const d = metres(stops[k]!, line[i]!);
      if (d < bestD) [best, bestD] = [i, d];
    }
    cut.push(best);
  }
  cut.push(line.length - 1);
  const points = cut.map((i) => line[i]!);
  const legs = cut.slice(1).map((end, k) => line.slice(cut[k]!, end + 1));
  return { legs, points };
}

/** Start, then the circle's points a quarter, a half and three quarters round, then start. */
export function loopWaypoints(start: LngLat, bearing: number, r: number): LngLat[] {
  const centre = offset(start, bearing, r);
  const back = (bearing + 180) % 360;
  return [start, ...[90, 180, 270].map((a) => offset(centre, (back + a) % 360, r)), start];
}

const lengthKm = (legs: LngLat[][]) => {
  const line = lineOf(legs.map((coords) => ({ mode: "paths" as const, coords })));
  let m = 0;
  for (let i = 1; i < line.length; i++) m += metres(line[i - 1]!, line[i]!);
  return m / 1000;
};

/**
 * Up to `count` loops of about `km` from `start`, each heading out a different way. `route`
 * finds the way between two points (null when there's none); a loop with a leg that can't be
 * routed is left out.
 */
export async function makeLoops(
  start: LngLat,
  km: number,
  route: (a: LngLat, b: LngLat) => Promise<LngLat[] | null>,
  o: { count?: number; firstBearing?: number; loop?: (points: LngLat[]) => Promise<{ legs: LngLat[][]; points: LngLat[] } | null> } = {},
): Promise<Loop[]> {
  const count = o.count ?? 3;
  const first = o.firstBearing ?? Math.floor(Math.random() * 360);
  // Paths wander: a routed loop runs about a quarter longer than the circle's chords.
  const guess = (km * 1000) / (4 * Math.SQRT2 * 1.25);
  const one = async (bearing: number): Promise<Loop | null> => {
    let r = guess;
    let best: Loop | null = null;
    for (let tries = 0; tries < 3; tries++) {
      let waypoints = loopWaypoints(start, bearing, r);
      let legs: LngLat[][] = [];
      // The whole loop at once when the router can; else leg by leg.
      const whole = o.loop ? await o.loop(waypoints) : null;
      if (whole) [legs, waypoints] = [whole.legs, whole.points];
      else {
        for (let i = 1; i < waypoints.length; i++) {
          const leg = await route(waypoints[i - 1]!, waypoints[i]!);
          if (!leg || leg.length < 2) return best;
          legs.push(leg);
        }
      }
      const got = lengthKm(legs);
      const loop = { waypoints, legs, km: Math.round(got * 100) / 100, bearing };
      if (!best || Math.abs(got - km) < Math.abs(best.km - km)) best = loop;
      if (Math.abs(got / km - 1) <= 0.07) break;
      r *= km / got;
    }
    return best;
  };
  const loops = await Promise.all(Array.from({ length: count }, (_, i) => one((first + (i * 360) / count) % 360)));
  // Only loops near the distance asked for.
  return loops.filter((l): l is Loop => !!l && Math.abs(l.km / km - 1) <= 0.15).sort((a, b) => Math.abs(a.km - km) - Math.abs(b.km - km));
}
