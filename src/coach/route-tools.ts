/**
 * Routes in the chat: the card a route shows as, and the coach's make_route and show_route
 * tools.
 */
import { z } from "zod";
import type { Coach } from "../coach.ts";
import { makeRoute, usualStart as startOf, type RouteAsk } from "../route-maker.ts";
import { UA, type Get } from "../route-finder.ts";
import { lineOf, Routes, thin, type LngLat, type Route } from "../routes.ts";
import { sceneryWords } from "../scenery.ts";
import { sportFamily } from "../merge.ts";
import { today } from "../plan.ts";
import { matchRuns, routeFromRun, usualOf, type RunTrack } from "../route-from-run.ts";
import type { DataTool } from "../tools.ts";

/** A route as the chat shows it: a card with its line, to tap and open. */
export interface RouteCard {
  id: string;
  name: string;
  km: number;
  ascent_m?: number;
  loop: boolean;
  /** Sent to the watch. */
  on_watch: boolean;
  /** The line thinned to ~60 points, [lon, lat]. */
  preview: LngLat[];
  /** How green it is, in words, when the coach weighed it (src/scenery.ts). */
  scenery?: string;
}

export function routeCard(r: Route, scenery?: string): RouteCard {
  const line = lineOf(r.segments);
  return {
    id: r.id,
    name: r.name,
    km: Math.round(r.distance_m / 10) / 100,
    ...(r.ascent_m !== undefined ? { ascent_m: Math.round(r.ascent_m) } : {}),
    loop: line.length > 2 && Math.hypot((line[0]![0] - line.at(-1)![0]) * 55_000, (line[0]![1] - line.at(-1)![1]) * 111_000) < 60,
    on_watch: !!r.watch,
    preview: thin(line, 60),
    ...(scenery ? { scenery } : {}),
  };
}



/** show_route: a saved route as a card in the chat (the athlete taps it to open it). */
export function showRouteTool(c: Coach): DataTool {
  return {
    name: "show_route",
    description: "Show one of the athlete's saved routes in the chat as a card they can tap to open (its line, distance, climb, whether it's on the watch). Find its id with list_routes. Use it whenever you talk about a particular route.",
    schema: z.object({ id: z.string() }),
    readOnly: true,
    run: async (a) => {
      const r = await new Routes(c.lib.disk).get(String((a as { id: string }).id));
      if (!r) return { error: "No such route: look it up with list_routes." };
      const card = routeCard(r);
      if (!c.routesShown.some((c) => c.id === card.id)) c.routesShown.push(card);
      return { shown: r.name, km: card.km, note: "It's in the chat as a card; they tap it to open it. Don't repeat its numbers at length." };
    },
  };
}


/** Where the athlete usually starts: their recent workouts with GPS (src/route-maker.ts usualStart). */
export async function usualStart(c: Coach): Promise<LngLat | null> {
  const rows = (await c.lib.activities()).filter((r) => r.streams_from).slice(0, 12);
  const starts: LngLat[] = [];
  for (const r of rows) {
    const raw = await c.lib.rawStreams(await c.lib.find(r.id)).catch(() => null);
    const ll = raw?.columns.latlng?.find((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") as [number, number] | undefined;
    if (ll) starts.push([ll[1], ll[0]]);
  }
  return startOf(starts);
}


/**
 * make_route: a route from what the athlete asks, routed on OpenStreetMap, saved in Routes and,
 * when they ask, sent to the watch (the phone only).
 */
export function makeRouteTool(c: Coach): DataTool {
  return {
    name: "make_route",
    description:
      "Make a running route and save it in Routes: a loop, out and back, or to a place; starting here (where the phone is: the default), home (where they usually start) or a place by name; preferring nature (parks, woods, trails, water), quiet (away from busy roads), flat or hilly. Take the distance from what they ask, else today's planned run. Set send_to_watch only when they ask to put it on the watch. Then say what it is: distance, climb, how green, and where it starts exactly as the answer's 'starts' says (never a town you assume).",
    schema: z.object({
      km: z.number().optional().describe("how far, in km (not needed for shape 'to')"),
      start: z.string().optional().describe("'here', 'home', or a place by name"),
      shape: z.enum(["loop", "out_and_back", "to"]).optional(),
      to: z.string().optional().describe("a place by name: where shape 'to' goes, or where an out and back turns"),
      prefer: z.enum(["nature", "quiet", "flat", "hilly", "any"]).optional(),
      name: z.string().optional(),
      send_to_watch: z.boolean().optional(),
    }),
    readOnly: false,
    run: async (a) => {
      const o = c.clientOptions.routes ?? {};
      const get: Get = o.get ?? ((url, init) => (c.lib.fetch ?? fetch)(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...init?.headers } }));
      const made = await makeRoute(a as RouteAsk, { get, whereAmI: o.whereAmI, home: () => usualStart(c) });
      const routes = new Routes(c.lib.disk);
      let saved = await routes.save(made.route);
      let watch = o.sendRoute ? "Not sent to the watch (they can from Routes)." : "Saved here; sending to the watch is done from Routes on the phone.";
      if ((a as { send_to_watch?: boolean }).send_to_watch && o.sendRoute) {
        try {
          const r = await o.sendRoute({ name: saved.name, line: lineOf(saved.segments), elevation: saved.elevation, waypoints: saved.waypoints });
          saved = await routes.save({ ...saved, watch: { id: r.id, sent: new Date().toISOString(), name: saved.name } });
          watch = "On the watch: they find it under the sport mode's navigation (routes).";
        } catch (e) {
          watch = `Not on the watch: ${(e as Error).message}. They can send it from Routes.`;
        }
      }
      c.routesShown.push(routeCard(saved, made.scenery ? sceneryWords(made.scenery) : undefined));
      return {
        saved: saved.name,
        km: made.km,
        ...(made.ascent_m !== undefined ? { climb_m: made.ascent_m } : {}),
        starts: `${made.from}${made.place ? `, in ${made.place}` : ""}`,
        ...(made.scenery ? { scenery: sceneryWords(made.scenery) } : {}),
        weighed: `${made.weighed} candidate${made.weighed === 1 ? "" : "s"}, the best kept`,
        watch,
        where: "Shown in the chat as a card with its line (they tap it to open it), and kept in Routes. Don't repeat its numbers at length.",
      };
    },
  };
}


/** A run's GPS line and heights, [lon, lat] (null without one). */
async function trackOf(c: Coach, row: { id: string; start: string; name?: string; distance_km?: number }): Promise<RunTrack | null> {
  const raw = await c.lib.rawStreams(await c.lib.find(row.id)).catch(() => null);
  const ll = raw?.columns.latlng ?? [];
  const alt = raw?.columns.altitude;
  const line: LngLat[] = [];
  const elevation: number[] = [];
  ll.forEach((p, i) => {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number" || (p[0] === 0 && p[1] === 0)) return;
    line.push([p[1], p[0]]);
    elevation.push(typeof alt?.[i] === "number" ? (alt[i] as number) : NaN);
  });
  if (line.length < 2) return null;
  return { id: row.id, start: row.start, name: row.name, distance_km: row.distance_km, line, ...(elevation.every(Number.isFinite) ? { elevation } : {}) };
}

/**
 * route_from_run: a route from one of the athlete's own runs (found by date words, name, distance,
 * or as their usual one), as it was, reversed, longer or shorter; saved in Routes and shown as a
 * card, sent to the watch when asked.
 */
export function routeFromRunTool(c: Coach): DataTool {
  return {
    name: "route_from_run",
    description:
      "Make a route from one of the athlete's own past runs (its GPS line), saved in Routes like a drawn one: 'the loop I ran last Tuesday but 2 km longer', 'my usual Sunday long run route', 'the river run from last week, reversed'. Find the run by `when` (their date words: 'last tuesday', 'yesterday', 'last week', or YYYY-MM-DD), `weekday`, words from its `name`, about how long it was (`run_km`), or `usual` (the line they run most, from about the same start), or give its `activity` id from list_activities. `km` makes the route that long along paths (an out-and-back spur to lengthen, a cut across to shorten); `reverse` runs it the other way. Set send_to_watch only when they ask. Then say which run it came from and the distance it came to.",
    schema: z.object({
      activity: z.string().optional().describe("the run's id, when you already know it"),
      when: z.string().optional().describe("date words as the athlete said them, or YYYY-MM-DD"),
      weekday: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).optional().describe("only runs on this day of the week (for 'my usual Sunday run')"),
      name: z.string().optional().describe("words from the run's name ('river', 'park')"),
      run_km: z.number().optional().describe("about how long the run was"),
      usual: z.boolean().optional().describe("the line they run most often (of the runs that match)"),
      km: z.number().optional().describe("how long the route should be, in km, when not as the run was ('2 km longer': the run's distance + 2)"),
      change_km: z.number().optional().describe("or how much longer (plus) or shorter (minus) than the run, in km"),
      reverse: z.boolean().optional(),
      route_name: z.string().optional(),
      send_to_watch: z.boolean().optional(),
    }),
    readOnly: false,
    run: async (raw) => {
      const a = raw as { activity?: string; when?: string; weekday?: string; name?: string; run_km?: number; usual?: boolean; km?: number; change_km?: number; reverse?: boolean; route_name?: string; send_to_watch?: boolean };
      const rows = (await c.lib.activities({ since: new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10), limit: 5000 })).filter((r) => sportFamily(r.sport) === "run" && r.streams_from);
      let pool = rows;
      if (a.activity) {
        const m = await c.lib.find(a.activity).catch(() => null);
        pool = m ? rows.filter((r) => r.id === m.id) : [];
        if (!pool.length) return { error: "No run with that id and a GPS line: look it up with list_activities." };
      } else {
        const found = matchRuns(rows, { when: a.when, weekday: a.weekday, name: a.name, km: a.run_km }, today());
        if (found.problem) return { error: found.problem };
        pool = found.rows;
      }
      if (!pool.length) return { error: `No run with a GPS line matched${[a.when && ` "${a.when}"`, a.weekday && ` on ${a.weekday}`, a.name && ` named like "${a.name}"`, a.run_km && ` of about ${a.run_km} km`].filter(Boolean).join(",")}. Ask which run they mean, or look with list_activities.` };
      let track: RunTrack | null = null;
      let repeats = 0;
      if (a.usual && !a.activity) {
        const tracks = (await Promise.all(pool.slice(0, 30).map((r) => trackOf(c, r)))).filter((t): t is RunTrack => !!t);
        const u = usualOf(tracks);
        if (u) [track, repeats] = [u.run, u.repeats];
      } else {
        for (const r of pool.slice(0, 10)) if ((track = await trackOf(c, r))) break;
      }
      if (!track) return { error: "Those runs have no GPS line (a treadmill, or the line didn't sync): there's nothing to follow." };
      const runKm = track.distance_km ?? 0;
      const want = a.km ?? (a.change_km ? Math.round((runKm + a.change_km) * 10) / 10 : undefined);
      const o = c.clientOptions.routes ?? {};
      const get: Get = o.get ?? ((url, init) => (c.lib.fetch ?? fetch)(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...init?.headers } }));
      const made = await routeFromRun(track, { reverse: a.reverse, km: want, name: a.route_name, get });
      const routes = new Routes(c.lib.disk);
      let saved = await routes.save(made.route);
      let watch = o.sendRoute ? "Not sent to the watch (they can from Routes)." : "Saved here; sending to the watch is done from Routes on the phone.";
      if (a.send_to_watch && o.sendRoute) {
        try {
          const r = await o.sendRoute({ name: saved.name, line: lineOf(saved.segments), elevation: saved.elevation, waypoints: saved.waypoints });
          saved = await routes.save({ ...saved, watch: { id: r.id, sent: new Date().toISOString(), name: saved.name } });
          watch = "On the watch: they find it under the sport mode's navigation (routes).";
        } catch (e) {
          watch = `Not on the watch: ${(e as Error).message}. They can send it from Routes.`;
        }
      }
      c.routesShown.push(routeCard(saved));
      return {
        saved: saved.name,
        from_run: { ...made.run, km: Math.round(made.run.km * 100) / 100, ...(repeats > 1 ? { usual: `${repeats} of the ${Math.min(pool.length, 30)} matching runs follow this line` } : {}) },
        km: made.km,
        ...(want ? { asked_km: want } : {}),
        ...(made.how.length ? { changed: made.how.join("; ") } : {}),
        ...(saved.ascent_m !== undefined ? { climb_m: saved.ascent_m } : {}),
        watch,
        where: "Shown in the chat as a card with its line (they tap it to open it), and kept in Routes. Say the distance it came to; don't repeat its numbers at length.",
      };
    },
  };
}
