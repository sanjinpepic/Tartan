package dev.modelhub.client

import org.json.JSONArray
import org.json.JSONObject

/** Something Model Hub couldn't do. [code] is one of ModelHubContract's ERROR_ codes. */
class ModelHubException(val code: Int, message: String, cause: Throwable? = null) :
  Exception(message, cause)

/** A model downloaded in Model Hub, ready for apps to use. */
data class HubModel(
  /** The name to ask for it by (ConversationOptions.model), e.g. "Gemma-4-E2B-it". */
  val name: String,
  val displayName: String,
  val description: String,
  val sizeBytes: Long,
  /** The most tokens it can hold at once (instructions, the chat and the answer). */
  val contextTokens: Int,
  /** Where it can run, in the order Model Hub tries them: "npu", "gpu", "cpu". */
  val accelerators: List<String>,
  /** It can look at images. */
  val vision: Boolean,
  /** It can listen to audio. */
  val audio: Boolean,
  /** It can think before it answers (Message.thinking). */
  val thinking: Boolean,
  /** The model Model Hub uses when an app doesn't name one. */
  val isDefault: Boolean,
  /** What Model Hub's last update check found for it; null if it wasn't checked. */
  val update: HubModelUpdate? = null,
) {
  companion object {
    fun from(o: JSONObject, defaultName: String?) =
      HubModel(
        name = o.getString("name"),
        displayName = o.optString("displayName", o.getString("name")),
        description = o.optString("description"),
        sizeBytes = o.optLong("sizeBytes", -1),
        contextTokens = o.optInt("contextTokens", 0),
        accelerators = o.optJSONArray("accelerators").strings(),
        vision = o.optBoolean("vision"),
        audio = o.optBoolean("audio"),
        thinking = o.optBoolean("thinking"),
        isDefault = o.getString("name") == defaultName,
        update = o.optJSONObject("update")?.let { HubModelUpdate.from(it) },
      )
  }
}

/**
 * An update for a model, found by Model Hub's checks. Model Hub never downloads on its own: show
 * [summary] and open Model Hub (ModelHub.updatesIntent) for the person to download it there.
 */
data class HubModelUpdate(
  val available: Boolean,
  /** "list" (a newer tested file in the Gallery's model list) or "huggingface" (a newer file there). */
  val source: String?,
  val sizeBytes: Long?,
  /** A line to show, e.g. "a newer file on Hugging Face (2.6 GB) · Faster decode". */
  val summary: String,
) {
  companion object {
    fun from(o: JSONObject) =
      HubModelUpdate(
        available = o.optBoolean("available"),
        source = o.optString("source").takeIf { !o.isNull("source") && it.isNotEmpty() },
        sizeBytes = if (o.has("sizeBytes") && !o.isNull("sizeBytes")) o.optLong("sizeBytes") else null,
        summary = o.optString("summary"),
      )
  }
}

/** What Model Hub has loaded now. [json] has every field, including ones added later. */
class HubStatus(val json: JSONObject) {
  val loaded: Boolean get() = json.optBoolean("loaded")
  val model: String? get() = json.optString("model").takeIf { it.isNotEmpty() }
  /** The processor it runs on: "npu", "gpu" or "cpu". */
  val backend: String? get() = json.optString("backend").takeIf { it.isNotEmpty() }
  val contextTokens: Int get() = json.optInt("contextTokens", 0)
  val vision: Boolean get() = json.optBoolean("vision")
  val audio: Boolean get() = json.optBoolean("audio")
  /** It is writing an answer (for this app or another). */
  val busy: Boolean get() = json.optBoolean("busy")

  override fun toString() = json.toString()
}

/** A tool call the model wants: run it in your app and send the result back (Message.toolResults). */
data class ToolCall(val name: String, val args: JSONObject) {
  internal fun toJson(): JSONObject = JSONObject().put("name", name).put("args", args)

  companion object {
    internal fun from(o: JSONObject) = ToolCall(o.getString("name"), o.optJSONObject("args") ?: JSONObject())
  }
}

/** A tool's result for the model. [result] is JSON (an object, a list or a plain value) or text. */
data class ToolResult(val name: String, val result: String) {
  internal fun toJson(): JSONObject = JSONObject().put("name", name).put("result", result)
}

/** One turn of a chat that happened before, to start a conversation from. */
sealed class Turn {
  data class User(val text: String) : Turn()

  data class Model(val text: String, val toolCalls: List<ToolCall> = emptyList()) : Turn()

  data class Tool(val results: List<ToolResult>) : Turn()

  internal fun toJson(): JSONObject =
    when (this) {
      is User -> JSONObject().put("role", "user").put("text", text)
      is Model ->
        JSONObject().put("role", "model").put("text", text).apply {
          if (toolCalls.isNotEmpty()) put("toolCalls", JSONArray(toolCalls.map { it.toJson() }))
        }
      is Tool -> JSONObject().put("role", "tool").put("results", JSONArray(results.map { it.toJson() }))
    }
}

/** How a conversation starts. Everything is optional. */
data class ConversationOptions(
  /** A model's name (HubModel.name); Model Hub's default model if null. */
  val model: String? = null,
  /** The system instruction. */
  val system: String? = null,
  /**
   * Tools the model may call, each an OpenAPI function description as JSON:
   * {"name": "...", "description": "...", "parameters": {"type": "object", ...}}.
   */
  val tools: List<String> = emptyList(),
  /** Earlier turns of the chat. */
  val history: List<Turn> = emptyList(),
  val temperature: Double? = null,
  val topK: Int? = null,
  val topP: Double? = null,
  /** Hold tool calls to their schema (constrained decoding). On by default when there are tools. */
  val constrainedToolCalls: Boolean = tools.isNotEmpty(),
  /**
   * Get ready now: Model Hub loads the model and reads the system prompt, tools and history in the
   * background, so the first message only has to read the question. For opening a chat when its
   * screen opens, before the person has typed anything.
   */
  val prepare: Boolean = false,
) {
  internal fun toJson(extraHistory: List<Turn> = emptyList()): JSONObject =
    JSONObject().apply {
      model?.let { put("model", it) }
      system?.let { put("system", it) }
      if (tools.isNotEmpty()) put("tools", JSONArray(tools))
      val all = history + extraHistory
      if (all.isNotEmpty()) put("history", JSONArray(all.map { it.toJson() }))
      temperature?.let { put("temperature", it) }
      topK?.let { put("topK", it) }
      topP?.let { put("topP", it) }
      put("constrainedToolCalls", constrainedToolCalls)
      if (prepare) put("prepare", true)
    }
}

/** A message to the model: words, images and audio, or the results of the tools it called. */
data class Message(
  val text: String? = null,
  /** Encoded images (PNG, JPEG, WebP), for a model with vision. */
  val images: List<ByteArray> = emptyList(),
  /** Audio clips (WAV), for a model with audio. */
  val audio: List<ByteArray> = emptyList(),
  /** The results of the tool calls in the last answer. */
  val toolResults: List<ToolResult> = emptyList(),
  /** Let the model think first (for models that can; the thinking arrives as HubEvent.Thinking). */
  val thinking: Boolean = false,
  /** At most this many tokens in the answer. */
  val maxOutputTokens: Int? = null,
) {
  internal fun toJson(): JSONObject =
    JSONObject().apply {
      text?.let { put("text", it) }
      if (images.isNotEmpty()) put("images", JSONArray(images.indices.toList()))
      if (audio.isNotEmpty()) put("audio", JSONArray(audio.indices.map { it + images.size }))
      if (toolResults.isNotEmpty()) put("toolResults", JSONArray(toolResults.map { it.toJson() }))
      if (thinking) put("thinking", true)
      maxOutputTokens?.let { put("maxOutputTokens", it) }
    }

  /** Images first, then audio clips: the order of the indices in [toJson]. */
  internal val attachments: List<ByteArray>
    get() = images + audio
}

/** The model's answer to one message. */
data class Answer(
  val text: String,
  val thinking: String,
  /** Tools the model wants run; send their results back to get its answer. */
  val toolCalls: List<ToolCall>,
  /** How it went: {"backend", "firstTokenMs", "tokensPerSecond", "tokens", "contextUsed", ...}. */
  val stats: JSONObject,
) {
  companion object {
    internal fun from(o: JSONObject) =
      Answer(
        text = o.optString("text"),
        thinking = o.optString("thinking"),
        toolCalls =
          o.optJSONArray("toolCalls")?.let { a -> (0 until a.length()).map { ToolCall.from(a.getJSONObject(it)) } }
            ?: emptyList(),
        stats = o.optJSONObject("stats") ?: JSONObject(),
      )
  }
}

/** What arrives while Model Hub works on a message. */
sealed class HubEvent {
  /** Progress: {"type": "load", "backend", "ok", "error"}, {"type": "queued"}, ... */
  data class Progress(val json: JSONObject) : HubEvent()

  /** The next piece of the answer. */
  data class Text(val delta: String) : HubEvent()

  /** The next piece of the model's thinking. */
  data class Thinking(val delta: String) : HubEvent()

  /** The whole answer; always the last event. */
  data class Answered(val answer: Answer) : HubEvent()
}

internal fun JSONArray?.strings(): List<String> =
  if (this == null) emptyList() else (0 until length()).map { getString(it) }
