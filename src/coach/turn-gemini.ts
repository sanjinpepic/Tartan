/**
 * A turn on Gemini: the same tools and instructions through Gemini function calling.
 */
import type { Coach } from "../coach.ts";
import { today } from "../plan.ts";
import { failTurn, shown, type ChatImage, type CoachEvent, type Conversation, type Reply } from "./conversation.ts";
import { toolLabel } from "./labels.ts";
import type { Effort } from "./routing.ts";
import { SYSTEM } from "./prompt.ts";
import { MAX_RESULT_CHARS, MAX_TOOL_ROUNDS, modelLabel } from "./settings.ts";
// The Gemini module (and Google's SDK) loads only when a Gemini conversation needs it.
const gemini = () => import("../coach-gemini.ts");

/** A Gemini conversation's turn: the same tools and instructions through Gemini function calling. */
export async function* chatGemini(c: Coach, conv: Conversation, text: string, instructions?: string, images: ChatImage[] = [], effort: Effort = "low"): AsyncGenerator<CoachEvent> {
  const s = await c.settings();
  const key = c.keyFor(s, "google").key;
  if (!key) return yield { type: "error", message: "This conversation runs on Gemini: add your Gemini API key in Coach settings." };
  conv.contents ??= [];
  const mark = conv.contents.length;
  const memoryBefore = conv.memory;
  const notes = await c.notesFor(conv);
  conv.contents.push({ role: "user", parts: [{ text: `Today is ${today()}.` }, ...notes.map((n) => ({ text: n })), ...(instructions ? [{ text: instructions }] : []), ...images.map((i) => ({ inlineData: { mimeType: i.mime, data: i.data } })), { text }] });
  conv.display.push(shown(text, images));
  const reply: Reply = { role: "assistant", text: "", tools: [], by: modelLabel("google", conv.model) };
  conv.display.push(reply);
  yield { type: "by", label: reply.by! };
  const { GEMINI_FALLBACK, geminiError, geminiTurn } = await gemini();
  try {
    let stop = "STOP";
    for await (const ev of geminiTurn(conv.contents, { apiKey: key, model: conv.model, system: SYSTEM, tools: c.tools, maxRounds: MAX_TOOL_ROUNDS, maxResultChars: MAX_RESULT_CHARS, baseUrl: c.clientOptions.googleBaseUrl, thinking: effort, fallback: GEMINI_FALLBACK })) {
      if (ev.type === "text") {
        reply.text += ev.delta!;
        yield { type: "text", delta: ev.delta! };
      } else if (ev.type === "tool") {
        const label = toolLabel(ev.name!);
        reply.tools.push(label);
        yield { type: "tool", name: ev.name!, label };
      } else if (ev.type === "model") {
        // The chosen model too busy: the lighter one answers, and the reply says so.
        reply.by = modelLabel("google", ev.model!);
        yield { type: "by", label: reply.by };
      } else stop = ev.stop ?? stop;
    }
    if (stop === "MAX_TOKENS") yield { type: "error", message: "The answer was cut off at the length limit." };
    if (stop === "CUT") yield { type: "error", message: "Google's answer broke off midway. Ask again to hear the rest." };
    if (stop === "SAFETY" || stop === "PROHIBITED_CONTENT") {
      const note = "\n\nI can't help with that one.";
      reply.text += note;
      yield { type: "text", delta: note };
    }
    void c.lib.local.logEvent({ lane: "agent", kind: "coach" });
    yield { type: "done", stop: stop.toLowerCase() };
  } catch (e) {
    // Append-only and valid: the API's history drops this unfinished turn; the chat keeps it, marked.
    conv.contents.splice(mark);
    failTurn(conv, geminiError(e));
    conv.memory = memoryBefore;
    yield { type: "error", message: geminiError(e) };
  } finally {
    if (conv.display.length) await c.save(conv);
  }
}
