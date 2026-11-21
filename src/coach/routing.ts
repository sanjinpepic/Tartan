/**
 * What a phone chat's message asks for, by its words (src/coach.ts routes the turn by it).
 */


/**
 * What a message to the coach on the phone asks for, as far as its words tell (English): a whole
 * new plan, or one session changed (`told`: asked for, not wondered about). Only for the phone's
 * own answers (offline, no key, or kept on the phone): its model can miss its tools, so it's
 * nudged to them, and a change it didn't make is made for it. Online with a key, the cloud model
 * reads the message itself.
 */
export function routeOf(text: string): { kind: "plan" | "edit"; told?: boolean } | null {
  const t = text.toLowerCase().replace(/[’']/g, "'");
  const race = String.raw`(race|marathon|half|ultra|trail|triathlon|\d+ ?k\b|10 ?km|5 ?km)`;
  const plan = new RegExp(
    [
      String.raw`\b(new|fresh|another|different|whole|entire|full|longer|shorter)\s+(training\s+)?(plan|block|program|programme|schedule)\b`,
      String.raw`\b(re-?plan|rebuild|redo|rewrite|remake|start over|restart)\b.*\b(plan|block|program|programme|schedule)\b`,
      String.raw`\b(plan|block|program|programme|schedule)\b.*\b(re-?plan|rebuild|redo|rewrite|remake|start over|restart)\b`,
      String.raw`\b(make|build|write|create|give)\s+(me\s+)?(a|my)\s+(training\s+)?plan\b`,
      String.raw`\bplan\b.*\b(for|towards?|up to)\b.*\b${race}`,
      String.raw`\b(signed up|registered|entered|booked)\b.*\b${race}`,
      String.raw`\bchange (my|the) (whole |entire )?(training )?plan\b`,
    ].join("|"),
  );
  if (plan.test(t)) return { kind: "plan", told: true };
  const verbs = String.raw`(move|shift|swap|switch|skip|drop|cancel|remove|delete|shorten|lengthen|replace|reschedule|push|postpone|bring forward|add|change|make|turn|cut)`;
  const what = String.raw`\b(run|runs|session|sessions|workout|long run|tempo|intervals?|easy|recovery|hills?|rest day|ride|swim|strength|gym|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)\b`;
  if (new RegExp(String.raw`\b${verbs}\b.*${what}`).test(t)) {
    const told = new RegExp(String.raw`^(please\s+|ok(ay)?,?\s+|hey,?\s+)?(${verbs}\b|(can|could|would|will) you\b|i (want|need|'d like|would like) (you )?to ${verbs}\b|let's ${verbs}\b)`).test(t.trim());
    return { kind: "edit", told };
  }
  return null;
}

/** How long a cloud model thinks before it answers. */
export type Effort = "low" | "medium" | "high";

/**
 * The thinking a message needs, by its words: making or reviewing a plan (`planning`, or a
 * message asking for a new one) deep, changing a session some, anything else a quick answer.
 * Deep thinking on a plain question only makes it slow, and a long silence while the model
 * thinks is what phone networks drop.
 */
export function effortOf(text: string, planning = false): Effort {
  if (planning) return "high";
  const r = routeOf(text);
  return r?.kind === "plan" ? "high" : r?.kind === "edit" ? "medium" : "low";
}
