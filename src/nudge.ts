/**
 * A nudge, when you ask for one ("Not feeling it?" on Today, or in the chat): one to three short
 * sentences from your own data, never preachy. Tartan's rules write it; with a cloud AI key the
 * coach says the same facts in its own words (Coach.nudgeWords), and these stand when it can't.
 */
export interface NudgeFacts {
  session: { title: string; kind: string; minutes?: number };
  /** This week so far (Monday to yesterday): runs and km. */
  week: { runs: number; km: number };
  /** Days since your last run, when there was one. */
  since_last?: number | null;
  /** How easy runs felt on the watch afterwards (1 poor … 5 excellent): the average and how many. */
  easy_felt?: { avg: number; n: number } | null;
  /** Times a nudge got you out of the door, of the times you asked. */
  nudged?: { ran: number; n: number } | null;
  /** Your race, when it's within twelve weeks. */
  race?: { name: string; days: number } | null;
  /** The stance (src/day-swap.ts stanceFor): lead with the run, or ease off, and its line. */
  stance?: { lead: "run" | "others" | "either"; line?: string };
}

const HARD = new Set(["tempo", "intervals", "hills"]);
const one = (n: number) => (Math.round(n * 10) / 10).toString();

/** The nudge in Tartan's words, and its facts in a line each (for the coach to word). */
export function nudgeLines(f: NudgeFacts): { text: string; facts: string[] } {
  const facts: string[] = [`Today's session: ${f.session.title}${f.session.minutes ? `, ${f.session.minutes} min` : ""} (${f.session.kind}).`];
  const lines: string[] = [];
  // A genuine reason: no push, an easy way out is fine.
  if (f.stance?.lead === "others") {
    facts.push(`A genuine reason to ease off today${f.stance.line ? `: ${f.stance.line}` : ""}`);
    const text = [f.stance.line ?? "An easy change is fine today.", "Or go out for 10 easy minutes if you feel like it, and see."].join(" ");
    return { text, facts };
  }
  // A key run or a third change in ten days: the run leads, said plainly.
  if (f.stance?.lead === "run" && f.stance.line) {
    facts.push(`Lead with the run: ${f.stance.line}`);
    lines.push(f.stance.line);
  }
  // What you've done: the week, the race, or the break.
  if (f.race && f.race.days > 0 && f.race.days <= 84) {
    facts.push(`${f.race.days} days to ${f.race.name}.`);
    lines.push(`${f.race.days} days to ${f.race.name}. This is one of the runs that gets you there.`);
  } else if (f.week.runs > 0) {
    facts.push(`This week so far: ${f.week.runs} run${f.week.runs === 1 ? "" : "s"}, ${one(f.week.km)} km.`);
    lines.push(`You've run ${f.week.runs === 1 ? "once" : `${f.week.runs} times`} this week, ${one(f.week.km)} km. Today would make it ${f.week.runs + 1}.`);
  } else if (f.since_last != null && f.since_last >= 3) {
    facts.push(`${f.since_last} days since the last run.`);
    lines.push(`It's been ${f.since_last} days since your last run, so the first few minutes may feel stiff. They pass.`);
  }
  // How it usually goes for you.
  if (f.nudged && f.nudged.n >= 3 && f.nudged.ran / f.nudged.n >= 0.5) {
    facts.push(`A nudge got them running ${f.nudged.ran} of ${f.nudged.n} times.`);
    lines.push(`The last times you asked for a nudge, you ran ${f.nudged.ran} of ${f.nudged.n}.`);
  } else if (f.easy_felt && f.easy_felt.n >= 3 && f.easy_felt.avg >= 3.5) {
    facts.push(`Easy runs felt ${one(f.easy_felt.avg)} of 5 on average afterwards (${f.easy_felt.n} runs).`);
    lines.push("Your easy runs nearly always feel good by the end, going by the watch.");
  }
  // And the way in.
  lines.push(HARD.has(f.session.kind) ? "Just start: warm up for 10 minutes, then decide if the reps are on." : "Just start: 10 minutes easy, then decide. Coming home then is fine too.");
  return { text: (lines.length > 3 ? [lines[0]!, ...lines.slice(-2)] : lines).join(" "), facts };
}

/** What the nudge reads: your library and plan, your answers so far (src/habits.ts), the race. */
export async function nudgeFacts(o: {
  lib: { activities(q?: { since?: string; limit?: number }): Promise<Array<{ id: string; sport: string; start: string; start_local?: string; distance_km?: number; feeling?: number }>> };
  view: { today: string; weeks: Array<{ days: Array<{ date: string; sessions: Array<{ kind: string; title: string; status?: string; duration_min?: number; distance_km?: number; activity?: { id: string } }> }> }> };
  session: { kind: string; title: string };
  answers: Array<{ date: string; kind: string; pick?: string }>;
  race: { name?: string; date?: string; distance_km?: number } | null | undefined;
  stance?: NudgeFacts["stance"];
}): Promise<NudgeFacts> {
  const t = o.view.today;
  const day = (r: { start: string; start_local?: string }) => (r.start_local ?? r.start).slice(0, 10);
  const mon = new Date(Date.parse(`${t}T12:00:00Z`) - ((new Date(`${t}T12:00:00Z`).getUTCDay() + 6) % 7) * 86400_000).toISOString().slice(0, 10);
  const rows = (await o.lib.activities({ since: new Date(Date.parse(`${t}T12:00:00Z`) - 90 * 86400_000).toISOString().slice(0, 10), limit: 2000 })).filter((r) => /run|jog|trail|treadmill/i.test(r.sport));
  const week = rows.filter((r) => day(r) >= mon && day(r) < t);
  const last = rows.map(day).filter((d) => d < t).sort().at(-1);
  const days = o.view.weeks.flatMap((w) => w.days);
  const planned = days.find((d) => d.date === t)?.sessions.find((s) => s.kind === o.session.kind);
  // How easy runs felt afterwards on the watch.
  const easyIds = new Set(days.flatMap((d) => d.sessions.filter((s) => ["easy", "recovery", "long"].includes(s.kind) && s.activity).map((s) => s.activity!.id)));
  const felt = rows.filter((r) => easyIds.has(r.id) && r.feeling).map((r) => r.feeling!);
  // The nudges you asked for before, and whether you ran.
  const done = new Set(days.flatMap((d) => d.sessions.filter((s) => s.status === "done").map((s) => `${d.date}:${s.kind}`)));
  const nudges = o.answers.filter((a) => a.pick === "nudge" && a.date < t);
  const raceDays = o.race?.date ? Math.round((Date.parse(`${o.race.date}T12:00:00Z`) - Date.parse(`${t}T12:00:00Z`)) / 86400_000) : null;
  const minutes = planned?.duration_min ?? (planned?.distance_km ? Math.round(planned.distance_km * 6) : undefined);
  return {
    session: { title: o.session.title, kind: o.session.kind, ...(minutes ? { minutes } : {}) },
    week: { runs: week.length, km: week.reduce((n, r) => n + (r.distance_km ?? 0), 0) },
    since_last: last ? Math.round((Date.parse(`${t}T12:00:00Z`) - Date.parse(`${last}T12:00:00Z`)) / 86400_000) : null,
    easy_felt: felt.length ? { avg: felt.reduce((a, b) => a + b, 0) / felt.length, n: felt.length } : null,
    nudged: nudges.length ? { ran: nudges.filter((a) => done.has(`${a.date}:${a.kind}`)).length, n: nudges.length } : null,
    race: raceDays != null && raceDays >= 0 ? { name: o.race?.name ?? `the ${o.race?.distance_km ?? ""} km race`.replace("  ", " "), days: raceDays } : null,
    ...(o.stance ? { stance: o.stance } : {}),
  };
}
