/**
 * What of Tartan's tools beyond the running coach someone already uses, so the phone can keep a new
 * user's screens short and leave a power user's as they are. Nothing is ever hidden for good: a
 * tool not in use waits under Settings → More → More tools, and shows where it belongs once it has
 * something of yours (a saved route, a face, a lift, a paired PC, a watch read…).
 *
 * The engine answers its half (GET /api/in-use: what's in your data); the page adds what only it
 * knows (a watch read or connected, faces installed, a paired PC) and both screens read the result
 * from rpc:prefs, so Android and iPhone decide the same way.
 */

/** Each tool, true when it's in use: shown where it belongs; false: under More tools. */
export interface InUse {
  /** A Suunto over Bluetooth: Settings → Watch, the Coach tab's line about the watch, sending watch workouts to Strava. */
  watch: boolean;
  /** The watch face builder: in Settings → Watch. */
  faces: boolean;
  /** Routes: the Workouts | Routes switch on Activities, the routes card in Settings → Watch. */
  routes: boolean;
  /** Strength sessions with Lift: exercise demos in Settings → Training. */
  lift: boolean;
  /** intervals.icu: in Settings → Sources. */
  icu: boolean;
  /** Tartan on your PC: in Settings → More at the top. */
  pc: boolean;
  /** AI agents over MCP (they reach the phone's data through the PC). */
  agents: boolean;
}

/** What tells: counts from the data, and what the page knows. Anything left out counts as none. */
export interface UseFacts {
  routes: number;
  /** Faces saved from the builder. */
  faces: number;
  /** Tartan faces this phone put on the watch. */
  facesOnWatch: number;
  /** Strength sessions logged with Lift. */
  lifts: number;
  /** Strength sessions in the plan, today or ahead. */
  strengthAhead: number;
  /** intervals.icu connected. */
  icu: boolean;
  /** Paired with Tartan on a PC. */
  pc: boolean;
  /** A watch read, connected now, or sent workouts. */
  watch: boolean;
  /** Calls from an AI agent over MCP (not the coach's own). */
  agentCalls: number;
}

export const NOTHING_IN_USE: InUse = { watch: false, faces: false, routes: false, lift: false, icu: false, pc: false, agents: false };

/** The decision, the same for both phones. */
export function inUse(f: Partial<UseFacts>): InUse {
  const faces = (f.faces ?? 0) > 0 || (f.facesOnWatch ?? 0) > 0;
  const pc = !!f.pc;
  return {
    // A face is on a watch, so faces bring the watch's settings with them.
    watch: !!f.watch || faces,
    faces,
    routes: (f.routes ?? 0) > 0,
    lift: (f.lifts ?? 0) > 0 || (f.strengthAhead ?? 0) > 0,
    icu: !!f.icu,
    pc,
    agents: pc || (f.agentCalls ?? 0) > 0,
  };
}

/** The engine's half, from the data: what GET /api/in-use answers. */
export async function dataFacts(d: {
  routes: () => Promise<unknown[]>;
  faces: () => Promise<unknown[]>;
  lifts: () => Promise<unknown[]>;
  plan: () => Promise<{ weeks: Array<{ sessions: Array<{ date: string; kind: string }> }> } | null>;
  icu: () => Promise<{ connected: boolean }>;
  events: () => Promise<Array<{ lane: string; kind?: string }>>;
  today: string;
}): Promise<Partial<UseFacts>> {
  const none = <T>(p: Promise<T>, empty: T) => p.catch(() => empty);
  const [routes, faces, lifts, plan, icu, events] = await Promise.all([
    none(d.routes(), []),
    none(d.faces(), []),
    none(d.lifts(), []),
    none(d.plan(), null),
    none(d.icu(), { connected: false }),
    none(d.events(), []),
  ]);
  return {
    routes: routes.length,
    faces: faces.length,
    lifts: lifts.length,
    strengthAhead: (plan?.weeks ?? []).flatMap((w) => w.sessions).filter((s) => s.kind === "strength" && s.date >= d.today).length,
    icu: !!icu.connected,
    agentCalls: events.filter((e) => e.lane === "agent" && e.kind !== "coach").length,
  };
}
