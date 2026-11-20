/**
 * The way on foot for the route editor (src/route-finder.ts): over Android's HTTP stack on the
 * phone (web/native-fetch.ts), which names Tartan as the map services ask; in a browser the
 * browser's own (setting a User-Agent there would only add a CORS preflight).
 */
import { routeFinder, UA, type PathResult } from "../../src/route-finder.ts";
import { nativeFetch } from "../native-fetch.ts";
import { isNative, log } from "../state.ts";

export type { PathResult };
const f = routeFinder((url) => nativeFetch(url, { headers: isNative ? { "User-Agent": UA, Accept: "application/json" } : { Accept: "application/json" } }), log);
export const footpath = f.footpath;
export const footloop = f.footloop;
export const heights = f.heights;
