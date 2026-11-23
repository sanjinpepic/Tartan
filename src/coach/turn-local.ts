/**
 * A turn on Model Hub's model on the phone (coach-litert.ts): it calls the tools itself, then
 * answers; a change it was asked for and didn't make goes to the planner or Tartan's rules.
 */
import type { Coach, CloudPick } from "../coach.ts";
import { LOCAL_SYSTEM, localError, localTurn } from "../coach-litert.ts";
import { today } from "../plan.ts";
import { failTurn, localHistory, shown, type ChatImage, type CoachEvent, type Conversation, type Reply } from "./conversation.ts";
import { toolLabel } from "./labels.ts";
import type { routeOf } from "./routing.ts";
import { hubLabel, TURN } from "./settings.ts";

/** A turn on Model Hub's model (coach-litert.ts): it calls the read-only tools itself, then answers. */
export async function* chatLocal(c: Coach, conv: Conversation, text: string, instructions?: string, images: ChatImage[] = [], route: ReturnType<typeof routeOf> = null, cloud: CloudPick | null = null): AsyncGenerator<CoachEvent> {
  const model = c.clientOptions.modelHub;
  const name = model ? (await model.status()).name : null;
  if (!model || !name) return yield { type: "error", message: "This conversation runs on Model Hub: allow Tartan to use it and download a model there (Coach settings)." };
  const history = localHistory(conv);
  conv.display.push(shown(text, images));
  const gemma = `${hubLabel(name)} on your phone`;
  const reply: Reply = { role: "assistant", text: "", tools: [], by: gemma };
  conv.display.push(reply);
  yield { type: "by", label: gemma };
  // A change asked for: the model is pointed at its tools (in its words only; the chat shows yours).
  const nudge = route?.kind === "edit" ? "\n\n(Tartan: if they want a session changed, call edit_session; don't just say it's done.)" : route?.kind === "plan" ? "\n\n(Tartan: they want a new plan: call change_plan.)" : "";
  const called = new Set<string>();
  try {
    const system = await localSystem(c, instructions);
    // The chat's id and its length before this question: the phone carries on in it when it can.
    for await (const ev of localTurn({ model, tools: [...c.tools, c.editSessionTool(), c.changePlanTool()], system, history, text: text + nudge, id: conv.id, turns: conv.display.length - 2, ...(images[0] ? { image: images[0].data } : {}) })) {
      if (ev.type === "tool") called.add(ev.name);
      if (ev.type === "text") {
        reply.text += ev.delta;
        yield { type: "text", delta: ev.delta };
      } else if (ev.type === "loaded") {
        const label = `Running on the phone's ${ev.backend}`;
        reply.tools.push(label);
        yield { type: "tool", name: "model", label };
      } else {
        const label = toolLabel(ev.name);
        reply.tools.push(label);
        yield { type: "tool", name: ev.name, label };
      }
    }
    const planner = (await c.status(TURN)).planner;
    if (called.has("change_plan") && planner.model) {
      reply.by = `${gemma}, plan by ${planner.model}`;
      yield { type: "by", label: reply.by };
    }
    // Asked for a change the model didn't make: the planner makes it, or Tartan's rules; else say so.
    const changed = called.has("edit_session") || called.has("change_plan");
    if (route && route.told && !changed) {
      const more = (delta: string) => {
        reply.text += delta;
        return { type: "text" as const, delta };
      };
      if (cloud && planner.uses !== "rules") {
        reply.by = `${gemma}, plan by ${cloud.planLabel}`;
        yield { type: "by", label: reply.by };
        const label = `Handing the change to ${cloud.planLabel}`;
        reply.tools.push(label);
        yield { type: "tool", name: "handoff", label };
        yield more("\n\n");
        for await (const ev of c.planBy(text)) {
          if (ev.type === "text") yield more(ev.delta);
          else if (ev.type === "tool") {
            reply.tools.push(ev.label);
            yield ev;
          } else if (ev.type === "error") yield more(`\n\n(${ev.message})`);
        }
      } else if (route.kind === "plan") {
        const r = await c.rulesReplan();
        yield more(`\n\n${String(r.done ?? r.error ?? "")}`);
      } else yield more("\n\n(The plan hasn't changed: say which day's session and where it should go, or change it on the Coach tab.)");
    }
    void c.lib.local.logEvent({ lane: "agent", kind: "coach" });
    yield { type: "done", stop: "end_turn" };
  } catch (e) {
    failTurn(conv, localError(e));
    yield { type: "error", message: localError(e) };
  } finally {
    if (conv.display.length) await c.save(conv);
  }
}


/** A model on the phone's instructions: the coach's, today, what it remembers, and this answer's own. */
export async function localSystem(c: Coach, instructions?: string): Promise<string> {
  const notes = await c.memory.prompt();
  return [LOCAL_SYSTEM, `Today is ${today()}.`, notes ? `What you remember about the athlete:\n${notes.slice(0, 800)}` : "", instructions ? `Instructions for this answer: ${instructions.slice(0, 600)}` : ""].filter(Boolean).join("\n\n");
}
