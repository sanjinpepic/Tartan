/**
 * Fat-finger help for the route editor: a tap near a path lands on the path. The map's own
 * paths, tracks and streets (OpenMapTiles' "transportation" layer) are what can be snapped to;
 * the nearest point on them within `radius` screen pixels wins.
 */
import type { Map as MlMap } from "maplibre-gl";

export type Px = { x: number; y: number };

/** OpenMapTiles transportation classes you can't run along. */
const NOT_ON_FOOT = new Set(["motorway", "raceway", "rail", "transit", "ferry", "aerialway", "bus_guideway", "busway"]);

/** The nearest point to `p` on any of `lines` (screen pixels), if one is within `radius`. */
export function nearestOnLines(p: Px, lines: Px[][], radius: number): Px | null {
  let best: Px | null = null;
  let bestD = radius * radius;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d <= bestD) [best, bestD] = [q, d];
    }
  }
  return best;
}

/** The point on the nearest path drawn within `radius` px of `p`, as [lng, lat], or null. */
export function snapToPath(map: MlMap, p: Px, radius = 28): [number, number] | null {
  const box: [[number, number], [number, number]] = [
    [p.x - radius, p.y - radius],
    [p.x + radius, p.y + radius],
  ];
  const lines: Px[][] = [];
  for (const f of map.queryRenderedFeatures(box)) {
    if (f.sourceLayer !== "transportation" || NOT_ON_FOOT.has(String(f.properties?.class))) continue;
    const g = f.geometry;
    const parts: number[][][] = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const part of parts) lines.push(part.map((c) => map.project([c[0]!, c[1]!])));
  }
  const q = nearestOnLines(p, lines, radius);
  if (!q) return null;
  const at = map.unproject([q.x, q.y]);
  return [Math.round(at.lng * 1e6) / 1e6, Math.round(at.lat * 1e6) / 1e6];
}
