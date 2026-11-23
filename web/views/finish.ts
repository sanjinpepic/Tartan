/**
 * A run, finished (src/run-finish.ts): how it went against its planned session, the records in
 * it, against the last run like it, and next time's rule with its reason; a pace change can be
 * put on that session (and taken back). In Today's last workout and a run's own sheet.
 */
import type { RunFinish, RunRule } from "../../src/run-finish.ts";
import { dateShort, el, fmtClock, icon } from "../lib/dom.ts";
import { thud } from "../lib/haptics.ts";
import { act, app, notify } from "../state.ts";

const RULE: Record<RunRule, string> = { faster: "Faster", easier: "Easier", hold: "Same again", "on target": "Right on", "slow down": "Slow down" };
const RANK = ["", "Best", "2nd best", "3rd best"];
const NAME: Record<string, string> = { "400m": "400 m", "1k": "1 km", "1 mile": "mile", "5k": "5 km", "10k": "10 km", "15k": "15 km", "Half-Marathon": "half marathon", "30k": "30 km", Marathon: "marathon" };
const day = (d: string) => new Date(`${d}T12:00:00`);
const when = (d: string) => `${day(d).toLocaleDateString([], { weekday: "short" })} ${dateShort(day(d))}`;

/** The finish block for a run, filled in when its data arrives; empty (hidden) for anything else. */
export function runFinish(id: string): HTMLElement {
  const box = el("div", { class: "finish", hidden: true });
  const load = () =>
    app.api
      .json<RunFinish | null>(`/api/activity/${encodeURIComponent(id)}/finish`)
      .then((f) => {
        if (!f || (!f.plan && !f.records.length && !f.last && !f.next)) return;
        box.replaceChildren(...content(f, load));
        box.hidden = false;
      })
      .catch(() => {});
  void load();
  return box;
}

function content(f: RunFinish, reload: () => Promise<void>): Node[] {
  const out: Node[] = [];
  const row = (ic: string, title: string, ...body: Array<Node | string | null>) => el("div", { class: "finish-row" }, el("span", { class: "finish-ic", "aria-hidden": "true" }, icon(ic, "ic sm")), el("div", {}, el("h3", {}, title), ...body));

  if (f.plan) {
    const w = f.plan.work;
    const line = w && w.total > 1 ? `${w.onTarget} of ${w.total} reps on target` : f.plan.summary ?? "Done";
    out.push(row("check", f.plan.title, el("p", {}, line.replace(/\.$/, ""), w && w.total > 1 && f.plan.summary ? el("span", { class: "sub" }, ` · ${f.plan.summary.replace(/^\d+ of \d+ reps on target;?\s*/, "").replace(/\.$/, "")}`) : null)));
  }
  if (f.records.length) {
    out.push(
      row(
        "spark",
        f.records.some((r) => r.rank === 1) ? "Records" : "Among your best",
        el("div", { class: "chips finish-records" }, ...f.records.slice(0, 4).map((r) => el("span", { class: `chip quiet${r.rank === 1 ? " best" : ""}` }, el("b", {}, `${RANK[r.rank]} ${NAME[r.name] ?? r.name}`), ` ${fmtClock(r.time_s)}`))),
      ),
    );
  }
  if (f.last) {
    out.push(row(f.last.verdict === "fitter" ? "up" : f.last.verdict === "harder" ? "down" : "history", "Against last time", el("p", {}, f.last.text), el("p", { class: "sub" }, `${f.last.now.pace ?? "–"} /km at ${f.last.now.hr ?? "–"} bpm, against ${f.last.pace ?? "–"} at ${f.last.hr ?? "–"} on ${when(f.last.date)}${f.last.name ? ` (${f.last.name})` : ""}`)));
  }
  if (f.next) {
    const n = f.next;
    const btn = n.shift_s
      ? el("button", { type: "button", class: `btn ${n.applied ? "text" : "tonal"} small` }, n.applied ? "Undo" : `Use it: ${Math.abs(n.shift_s)} s/km ${n.shift_s < 0 ? "faster" : "easier"}`)
      : null;
    if (btn)
      btn.onclick = () =>
        void act(btn, n.applied ? "Undoing" : "Changing the session", async () => {
          const res = await app.api.request("/api/plan/adjust", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: n.date, kind: n.kind, shift_s: n.shift_s, reason: n.why, from: f.id, undo: n.applied }) });
          const r = (await res.json()) as { error?: string };
          if (r.error) throw new Error(r.error);
          thud();
          notify(n.applied ? `${n.title} is back as planned.` : `${n.title} on ${when(n.date)}: ${Math.abs(n.shift_s!)} s/km ${n.shift_s! < 0 ? "faster" : "easier"}. On your watch with the next sync.`);
          await reload();
        });
    out.push(
      row(
        "spark",
        `Next time: ${when(n.date)}, ${n.title}`,
        el("p", {}, el("b", { class: `finish-rule r-${n.rule.replace(" ", "-")}` }, RULE[n.rule]), ` ${n.why}`),
        n.applied ? el("p", { class: "sub" }, "Changed on the plan.") : null,
        btn ? el("div", { class: "row" }, btn) : null,
      ),
    );
  }
  return out;
}
