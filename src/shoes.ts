/**
 * Shoes and their kilometres. Each pair has a day you started wearing it; a run counts to the
 * newest pair started on or before that day (the pair you were wearing then), unless you moved
 * that run to another pair. Kilometres already on a pair when it was added count too. Kept in
 * gear/shoes.json, so it goes to the PC with everything else.
 *
 * Strava: your shoes there come in with the sync (athlete.json, needs profile:read_all) and link
 * to a pair of the same name, and a run that has a pair on Strava (its gear_id) counts to that
 * pair. Strava's API can't create shoes, only set which existing pair a run used, so a pair made
 * here reaches Strava once you add it there by name.
 */
import { readJson, type Disk } from "./disk.ts";
import type { Library } from "./library.ts";
import { sportFamily } from "./merge.ts";
import { Plans } from "./plan.ts";

const FILE = "gear/shoes.json";
export const DEFAULT_LIMIT_KM = 700;
export const RACING_LIMIT_KM = 400;
/** A photo kept with the pair: small, since it lives in shoes.json. */
export const MAX_PHOTO_CHARS = 160_000;
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export interface Shoe {
  id: string;
  name: string;
  /** First day worn (YYYY-MM-DD). */
  since: string;
  /** Kilometres on them before Tartan counted. */
  start_km: number;
  /** When they're due to retire (most running shoes last 500-800 km). */
  limit_km: number;
  retired?: string;
  /** The same pair on Strava (gear id like g123). */
  strava_id?: string;
  /** Your photo of them, a small data URL. */
  photo?: string;
  /** What they're for; unset, it's guessed from the name. */
  kind?: ShoeKind;
}
/** Daily trainers take most runs; racing shoes the fast days; trail shoes the trails. */
export type ShoeKind = "daily" | "racing" | "trail";
export const SHOE_KINDS: ShoeKind[] = ["daily", "racing", "trail"];
export interface ShoeData {
  shoes: Shoe[];
  /** A run moved to another pair (or to none: null). */
  assign: Record<string, string | null>;
}
export interface Run {
  id: string;
  start: string;
  km: number;
  /** The pair Strava has on this run, when it's on Strava. */
  gear?: string | null;
  /** Its Strava activity id. */
  strava?: string;
  /** What the run asked of shoes: a trail, or a fast day in the plan. */
  need?: ShoeKind;
}
/** A pair as Strava lists it on the athlete. */
export interface StravaShoe {
  id: string;
  name?: string;
  nickname?: string | null;
  distance?: number;
  retired?: boolean;
}
export interface ShoeTotal extends Shoe {
  km: number;
  runs: number;
  /** Share of the limit used, 0-1+. */
  used: number;
}

const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Which pair a run counts to: the one you moved it to, else the pair Strava has on it, else the newest pair you'd started by then (retired ones only before they retired). */
export function shoeFor(run: Run, data: ShoeData): string | null {
  if (run.id in data.assign) return data.assign[run.id] ?? null;
  const linked = run.gear ? data.shoes.find((s) => s.strava_id === run.gear) : undefined;
  if (linked) return linked.id;
  const d = day(run.start);
  const worn = data.shoes.filter((s) => s.since <= d && (!s.retired || d <= s.retired)).sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0));
  // A pair made for what the run was (a trail, a fast day); else a daily pair (racing shoes
  // aren't worn for easy miles); else whichever pair you had.
  const need = run.need ?? "daily";
  return (worn.find((s) => kindOf(s) === need) ?? worn.find((s) => kindOf(s) !== "racing") ?? worn[0])?.id ?? null;
}

export const kindOf = (s: Pick<Shoe, "kind" | "name">): ShoeKind => s.kind ?? kindFromName(s.name);

const FAST = new Set(["race", "intervals", "tempo"]);
/** What a planned session asks of shoes. */
export function sessionNeeds(kind: string, title = "", sport = ""): ShoeKind {
  if (/trail/i.test(`${title} ${sport}`)) return "trail";
  return FAST.has(kind) ? "racing" : "daily";
}

export interface ShoePick {
  id: string;
  name: string;
  /** Why this pair, in a few words. */
  why: string;
}

/**
 * Which pair to wear for a session: one of its kind with life left (the newest), else a daily
 * pair. Only when there's a choice (two or more pairs in use): with one pair there's nothing to say.
 */
export function pickShoe(need: ShoeKind, kind: string, totals: ShoeTotal[], date: string): ShoePick | null {
  const live = totals.filter((s) => !s.retired && s.since <= date);
  if (live.length < 2) return null;
  const fresh = (k: ShoeKind) => live.filter((s) => kindOf(s) === k && s.used < 1).sort((a, b) => (a.since < b.since ? 1 : -1))[0];
  const want = fresh(need);
  if (want) return { id: want.id, name: want.name, why: need === "racing" ? (kind === "race" ? "race day" : "a fast day") : need === "trail" ? "for the trail" : "easy miles: save the others" };
  const daily = fresh("daily") ?? live.filter((s) => kindOf(s) !== "racing").sort((a, b) => a.used - b.used)[0];
  return daily ? { id: daily.id, name: daily.name, why: need === "trail" ? "no trail pair: your daily pair" : "your daily pair" } : null;
}

/**
 * When a pair is near or past its limit, what to do: move its kind of runs to another pair of
 * that kind with life left, or have the next pair ready.
 */
export function switchAdvice(s: ShoeTotal, totals: ShoeTotal[]): string {
  const k = kindOf(s);
  const other = totals.find((x) => x.id !== s.id && !x.retired && kindOf(x) === k && x.used < 0.9);
  const what = k === "racing" ? "races and fast days" : k === "trail" ? "trail runs" : "easy and long runs";
  if (s.used >= 1) return other ? `Past the ${s.limit_km} km you set: ${other.name} can take your ${what}. Retire these in Settings → Training.` : `Past the ${s.limit_km} km you set: time for a new pair for your ${what}, or retire these in Settings → Training.`;
  return other ? `Close to the ${s.limit_km} km you set: start giving your ${what} to ${other.name}.` : `Close to the ${s.limit_km} km you set: worth having the next pair ready${k === "racing" ? ", and not racing in a new one" : ""}.`;
}

/** Every pair with its kilometres, the ones in use first. */
export function shoeTotals(runs: Run[], data: ShoeData): ShoeTotal[] {
  const km = new Map<string, { km: number; runs: number }>();
  for (const r of runs) {
    const id = shoeFor(r, data);
    if (!id) continue;
    const t = km.get(id) ?? { km: 0, runs: 0 };
    km.set(id, { km: t.km + r.km, runs: t.runs + 1 });
  }
  return data.shoes
    .map((s) => {
      const t = km.get(s.id) ?? { km: 0, runs: 0 };
      const total = Math.round((s.start_km + t.km) * 10) / 10;
      return { ...s, km: total, runs: t.runs, used: s.limit_km > 0 ? total / s.limit_km : 0 };
    })
    .sort((a, b) => Number(!!a.retired) - Number(!!b.retired) || (a.since < b.since ? 1 : -1));
}

/** Pairs near or past their limit and still in use: for Today's "Worth knowing". */
export function wornOut(totals: ShoeTotal[]): ShoeTotal[] {
  return totals.filter((s) => !s.retired && s.used >= 0.9);
}

/** How far a pair usually lasts, from what it is: racing shoes wear out sooner. */
export function limitFor(kind: string | undefined): number {
  return kind === "racing" ? RACING_LIMIT_KM : DEFAULT_LIMIT_KM;
}
const RACING = /\b(vaporfly|alphafly|metaspeed|adios pro|adizero pro|endorphin (pro|elite)|rocket ?x|sc elite|fuelcell elite|deviate elite|cielo|takumi|racer|spikes?)\b/i;
/** A guess from the name alone, for pairs that come from Strava. */
const TRAIL = /\b(trail|speedgoat|peregrine|cascadia|xodus|mafate|torrent|sense ride|genesis|terrex|hierro|wildhorse|ultra glide|catamount|agility peak|lone peak)\b/i;
export const kindFromName = (name: string): ShoeKind => (RACING.test(name) ? "racing" : TRAIL.test(name) ? "trail" : "daily");

const same = (a: string, b: string) => {
  const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const x = n(a);
  const y = n(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x))));
};

/**
 * Bring Strava's pairs in: one already linked keeps its link (and takes Strava's retirement and
 * kilometres from before Tartan's runs), one with the same name as a pair here gets linked, any
 * other is added. Kilometres: Strava's total less what Tartan counts from the runs on that pair.
 */
export function importStrava(data: ShoeData, gear: StravaShoe[], runs: Run[], today = day(new Date().toISOString())): { data: ShoeData; added: string[]; linked: string[] } {
  const added: string[] = [];
  const linked: string[] = [];
  const shoes = [...data.shoes];
  for (const g of gear) {
    if (!g?.id || typeof g.id !== "string") continue;
    const name = String(g.nickname || g.name || "").trim().slice(0, 40);
    const on = runs.filter((r) => r.gear === g.id);
    const days = on.map((r) => day(r.start)).sort();
    const ran = on.reduce((n, r) => n + r.km, 0);
    const start_km = Math.max(0, Math.round(((g.distance ?? 0) / 1000 - ran) * 10) / 10);
    const retired = g.retired ? (days.at(-1) ?? today) : undefined;
    let i = shoes.findIndex((s) => s.strava_id === g.id);
    if (i < 0 && name) {
      i = shoes.findIndex((s) => !s.strava_id && (same(s.name, name) || (!!g.name && same(s.name, g.name))));
      if (i >= 0) {
        linked.push(shoes[i]!.name);
        shoes[i] = { ...shoes[i]!, strava_id: g.id };
        continue;
      }
    }
    if (i >= 0) {
      const s = shoes[i]!;
      shoes[i] = { ...s, start_km: Math.max(s.start_km, start_km), ...(retired && !s.retired ? { retired } : {}) };
      continue;
    }
    if (!name) continue;
    shoes.push({ id: `strava-${g.id}`, name, since: days[0] ?? today, start_km, kind: kindFromName(`${g.name ?? ""} ${name}`), limit_km: limitFor(kindFromName(`${g.name ?? ""} ${name}`)), strava_id: g.id, ...(retired ? { retired } : {}) });
    added.push(name);
  }
  return { data: { ...data, shoes }, added, linked };
}

/** Runs on Strava that Tartan counts to this (linked) pair but Strava has on another or on none. */
export function toStrava(runs: Run[], data: ShoeData, shoe: string): Run[] {
  const s = data.shoes.find((x) => x.id === shoe);
  if (!s?.strava_id) return [];
  return runs.filter((r) => r.strava && r.gear !== s.strava_id && shoeFor(r, data) === shoe);
}

export class Shoes {
  constructor(private readonly disk: Disk) {}

  async read(): Promise<ShoeData> {
    const d = await readJson<ShoeData>(this.disk, FILE);
    return { shoes: Array.isArray(d?.shoes) ? d.shoes : [], assign: d?.assign && typeof d.assign === "object" ? d.assign : {} };
  }
  private async write(d: ShoeData): Promise<ShoeData> {
    await this.disk.write(FILE, JSON.stringify(d, null, 2));
    return d;
  }

  /** Add a pair, or change one (by id). */
  async put(s: Partial<Shoe> & { name: string }): Promise<ShoeData> {
    const name = String(s.name ?? "").trim().slice(0, 40);
    if (!name) throw new Error("give the pair a name");
    const since = /^\d{4}-\d{2}-\d{2}$/.test(s.since ?? "") ? s.since! : day(new Date().toISOString());
    const start_km = Math.max(0, Math.min(5000, Number(s.start_km) || 0));
    const limit_km = Math.max(100, Math.min(3000, Number(s.limit_km) || DEFAULT_LIMIT_KM));
    const d = await this.read();
    const id = s.id && d.shoes.some((x) => x.id === s.id) ? s.id : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const was = d.shoes.find((x) => x.id === id);
    const retired = s.retired === undefined ? was?.retired : /^\d{4}-\d{2}-\d{2}$/.test(s.retired) ? s.retired : undefined;
    // A photo: a new one replaces it, "" takes it off, none given keeps it.
    if (s.photo && (s.photo.length > MAX_PHOTO_CHARS || !PHOTO.test(s.photo))) throw new Error("that photo is too big or not an image");
    const photo = s.photo === undefined ? was?.photo : s.photo || undefined;
    const strava_id = was?.strava_id;
    const kind = SHOE_KINDS.includes(s.kind as ShoeKind) ? s.kind : was?.kind;
    const shoe: Shoe = { id, name, since, start_km, limit_km, ...(kind ? { kind } : {}), ...(retired ? { retired } : {}), ...(strava_id ? { strava_id } : {}), ...(photo ? { photo } : {}) };
    return this.write({ ...d, shoes: [...d.shoes.filter((x) => x.id !== id), shoe] });
  }

  async importStrava(gear: StravaShoe[], runs: Run[]): Promise<{ added: string[]; linked: string[] }> {
    const d = await this.read();
    const r = importStrava(d, gear, runs);
    if (JSON.stringify(r.data) !== JSON.stringify(d)) await this.write(r.data);
    return { added: r.added, linked: r.linked };
  }

  async remove(id: string): Promise<ShoeData> {
    const d = await this.read();
    const assign = Object.fromEntries(Object.entries(d.assign).filter(([, v]) => v !== id));
    return this.write({ shoes: d.shoes.filter((x) => x.id !== id), assign });
  }

  /** Move one run to a pair (or to none); `undefined` goes back to the automatic pair. */
  async assign(run: string, shoe: string | null | undefined): Promise<ShoeData> {
    const d = await this.read();
    const assign = { ...d.assign };
    if (shoe === undefined) delete assign[run];
    else assign[run] = shoe;
    return this.write({ ...d, assign });
  }
}

/** Your runs with their Strava pair, for counting (src/library.ts merges the copies). */
export async function shoeRuns(lib: Library, since?: string): Promise<Run[]> {
  const [rows, ids, index, plan] = await Promise.all([lib.activities(since ? { since } : {}), lib.stravaIds(), lib.strava.index(), new Plans(lib).current().catch(() => null)]);
  const gear = new Map(index.map((a) => [String(a.id), a.gear_id ?? null]));
  // The plan's fast days: a run on one counts to a racing pair, if you have one.
  const fast = new Set((plan?.weeks ?? []).flatMap((w) => w.sessions).filter((x) => sessionNeeds(x.kind, x.title) === "racing").map((x) => x.date));
  return rows
    .filter((r) => sportFamily(r.sport) === "run" && (r.distance_km ?? 0) > 0)
    .map((r) => {
      const strava = ids.get(r.id);
      const need: ShoeKind = /trail/i.test(r.sport) ? "trail" : fast.has(day(r.start)) ? "racing" : "daily";
      return { id: r.id, start: r.start, km: r.distance_km ?? 0, need, ...(strava ? { strava, gear: gear.get(strava) ?? null } : {}) };
    });
}

export interface ShoesView {
  shoes: ShoeTotal[];
  assign: Record<string, string | null>;
  /** Strava connected, and allowed to set a run's shoes (activity:write). */
  strava: { connected: boolean; can_write: boolean };
  /** Per linked pair: runs Strava has on another pair or none. */
  to_strava: Record<string, number>;
  /** With no pairs yet: how many runs, and the first one's day (Today asks once after a week). */
  runs?: { count: number; first: string | null };
}

/** Every pair with its kilometres from your runs (any source), and the runs moved by hand. */
export async function shoesNow(lib: Library): Promise<ShoesView> {
  const data = await new Shoes(lib.disk).read();
  const tokens = await lib.strava.read<{ scope?: string }>("tokens.json");
  const strava = { connected: !!tokens, can_write: !!tokens?.scope?.split(",").includes("activity:write") };
  if (!data.shoes.length) {
    const runs = await shoeRuns(lib);
    return { shoes: [], assign: data.assign, strava, to_strava: {}, runs: { count: runs.length, first: runs.reduce<string | null>((m, r) => (!m || r.start < m ? r.start : m), null) } };
  }
  const first = data.shoes.reduce((m, x) => (x.since < m ? x.since : m), "9999");
  const runs = await shoeRuns(lib, first);
  const to_strava = Object.fromEntries(data.shoes.filter((s) => s.strava_id).map((s) => [s.id, toStrava(runs, data, s.id).length]));
  return { shoes: shoeTotals(runs, data), assign: data.assign, strava, to_strava };
}

/** The pair to wear for each run session from `from` on, keyed `date:kind` (only when there's a choice). */
export async function shoePicks(lib: Library, sessions: Array<{ date: string; kind: string; title?: string }>, from: string): Promise<Record<string, ShoePick>> {
  const ahead = sessions.filter((x) => x.date >= from && !["rest", "strength", "cross", "swim", "ride"].includes(x.kind));
  if (!ahead.length) return {};
  // Nothing to choose between: skip counting.
  if ((await new Shoes(lib.disk).read()).shoes.filter((x) => !x.retired).length < 2) return {};
  const { shoes } = await shoesNow(lib);
  const out: Record<string, ShoePick> = {};
  for (const x of ahead) {
    const p = pickShoe(sessionNeeds(x.kind, x.title), x.kind, shoes, x.date);
    if (p) out[`${x.date}:${x.kind}`] = p;
  }
  return out;
}
