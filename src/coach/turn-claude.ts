/**
 * A turn on Claude: the tool loop through Anthropic's API, streamed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Coach } from "../coach.ts";
import { today } from "../plan.ts";
import { failTurn, shown, type ChatImage, type CoachEvent, type Conversation, type Reply } from "./conversation.ts";
import { toolLabel } from "./labels.ts";
import { SYSTEM } from "./prompt.ts";
import { FALLBACK_MODELS, MAX_RESULT_CHARS, MAX_TOOL_ROUNDS, modelLabel } from "./settings.ts";

/** A Claude conversation's turn. */
export async function* chatClaude(c: Coach, conv: Conversation, text: string, instructions?: string, images: ChatImage[] = []): AsyncGenerator<CoachEvent> {
  if (!c.keyFor(await c.settings(), "anthropic").source) return yield { type: "error", message: "This conversation runs on Claude: add your Anthropic API key in Coach settings." };

  // The date changes daily, so it rides in the user turn, keeping the cached prefix stable; so do the notes.
  const memoryBefore = conv.memory;
  const notes = await c.notesFor(conv);
  conv.messages.push({
    role: "user",
    content: [
      { type: "text", text: `Today is ${today()}.` },
      ...notes.map((n) => ({ type: "text" as const, text: n })),
      ...(instructions ? [{ type: "text" as const, text: instructions }] : []),
      ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mime as "image/jpeg" | "image/png" | "image/webp", data: i.data } })),
      { type: "text", text },
    ],
  });
  conv.display.push(shown(text, images));
  const reply: Reply = { role: "assistant", text: "", tools: [], by: modelLabel("anthropic", conv.model) };
  conv.display.push(reply);
  yield { type: "by", label: reply.by! };

  const client = await c.client();
  const model = conv.model;
  const toolDefs: Anthropic.Beta.BetaTool[] = c.tools.map((t) => {
    const { $schema: _drop, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    };
  });

  let stop = "end_turn";
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 64000,
        system: SYSTEM,
        tools: toolDefs,
        messages: conv.messages,
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      // Relay text deltas as they arrive.
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      stream.on("text", (delta) => {
        queue.push(delta);
        wake?.();
      });
      const done = stream.finalMessage().finally(() => {
        finished = true;
        wake?.();
      });
      while (!finished || queue.length) {
        if (queue.length) {
          const delta = queue.shift()!;
          reply.text += delta;
          yield { type: "text", delta };
        } else {
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      }
      const message = await done;
      stop = message.stop_reason ?? "end_turn";
      conv.messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });

      if (stop === "refusal") {
        const note = "\n\nI can't help with that one.";
        reply.text += note;
        yield { type: "text", delta: note };
        break;
      }
      if (stop === "pause_turn") continue;
      const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (stop !== "tool_use" || !calls.length) {
        if (stop === "max_tokens") yield { type: "error", message: "The answer was cut off at the length limit." };
        break;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        const tool = c.tools.find((t) => t.name === call.name);
        const label = toolLabel(call.name);
        reply.tools.push(label);
        yield { type: "tool", name: call.name, label };
        if (!tool) {
          results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Unknown tool ${call.name}` });
          continue;
        }
        // Streamed tool inputs are not validated by the server: validate here.
        const parsed = tool.schema.safeParse(call.input ?? {});
        if (!parsed.success) {
          results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues.map((i) => i.message) }) });
          continue;
        }
        try {
          const out = JSON.stringify(await tool.run(parsed.data));
          results.push({ type: "tool_result", tool_use_id: call.id, content: out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}… (truncated; ask for a narrower range)` : out });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: (e as Error).message });
        }
      }
      conv.messages.push({ role: "user", content: results });
    }
    void c.lib.local.logEvent({ lane: "agent", kind: "coach" });
    yield { type: "done", stop };
  } catch (e) {
    const message =
      e instanceof Anthropic.AuthenticationError ? "Anthropic rejected the API key. Check it in Coach settings."
      : e instanceof Anthropic.PermissionDeniedError ? "This API key cannot use that model."
      : e instanceof Anthropic.RateLimitError ? "Rate limited by Anthropic. Try again in a minute."
      : e instanceof Anthropic.APIConnectionError ? "Could not reach Anthropic. Check the internet connection."
      : e instanceof Anthropic.APIError ? `Anthropic API error ${e.status}: ${e.message}`
      : (e as Error).message;
    // Keep the transcript append-only and valid: drop this unfinished turn entirely.
    const lastUser = conv.messages.findLastIndex((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "text"));
    if (lastUser >= 0) conv.messages.splice(lastUser);
    failTurn(conv, message);
    conv.memory = memoryBefore;
    yield { type: "error", message };
  } finally {
    if (conv.display.length) await c.save(conv);
  }
}
