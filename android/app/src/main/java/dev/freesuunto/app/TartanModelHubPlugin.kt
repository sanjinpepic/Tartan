package dev.freesuunto.app

import dev.freesuunto.app.shell.str
import android.content.Intent
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import dev.modelhub.client.Conversation
import dev.modelhub.client.ConversationOptions
import dev.modelhub.client.HubEvent
import dev.modelhub.client.Message
import dev.modelhub.client.ModelHub
import dev.modelhub.client.ModelHubException
import dev.modelhub.client.ToolResult
import dev.modelhub.client.Turn
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The coach on Model Hub (dev.modelhub, the owner's fork of AI Edge Gallery with an API for other
 * apps): the model is downloaded once, in Model Hub, for every app on the phone, and Model Hub runs
 * it (on the Tensor TPU when it can). For src/coach-litert.ts through web/lib/modelhub.ts, with the
 * same start / send / end as TartanLiteRtPlugin, so the coach's tool loop drives either.
 * From Model Hub's API_GUIDE.md §13 (github.com/sanjinpepic/edge-gallery-), its client library
 * copied as it is into dev.modelhub.*.
 *
 *  - state(): installed, allowed, the default model (its context, photos, an update), any error;
 *  - allow(): Android's permission prompt ("Allow Tartan to use the AI models in Model Hub?");
 *  - open({what: "app" | "updates"}): Model Hub, or its Updates screen;
 *  - load(): the model loaded now; where it runs and its context;
 *  - start({id, system, tools, history, turns, temperature}) / send({id, text | toolResults, image})
 *    / end({id}): a conversation, its words as "hubText" events {id, text}.
 */
/**
 * An open conversation carries on for a start() with the same instructions, tools and temperature
 * when the chat is one question on (turns = its turns + 2), or when it was prepared and nothing has
 * been asked since (the same turns: its first question, or preparing it again). Else it's reopened.
 */
fun carriesOn(openKey: String, openTurns: Int, openPrepared: Boolean, key: String, turns: Int, prepare: Boolean): Boolean =
    openKey == key && turns >= 0 && (turns == openTurns + 2 || (turns == openTurns && (openPrepared || prepare)))

@CapacitorPlugin(
    name = "TartanModelHub",
    permissions = [Permission(alias = "models", strings = [ModelHub.PERMISSION])],
)
class TartanModelHubPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val hub by lazy { ModelHub(context) }
    private val chats = mutableMapOf<String, Live>()
    private val answering = mutableMapOf<String, Job>()
    /** The last answer: how long until its first words (ms), and tokens a second after that. */
    private var lastSpeed: Pair<Long, Double>? = null
    private var lastBackend: String? = null

    /**
     * An open conversation and what it was opened with: carried on while it's the same chat.
     * Prepared (opened before its question, while the chat screen was open), its next question
     * carries on in it with the turns unmoved, once.
     */
    private class Live(val chat: Conversation, val key: String, var turns: Int, var prepared: Boolean = false)

    private fun installed() = ModelHub.isInstalled(context)
    private fun permitted() = ModelHub.hasPermission(context)

    /** A processor as the coach says it. */
    private fun where(backend: String?) = when (backend) {
        "npu" -> "Tensor TPU"
        "gpu" -> "GPU"
        "cpu" -> "CPU"
        null, "" -> "phone"
        else -> backend
    }

    /**
     * Model Hub's last word that it hasn't approved Tartan (ERROR_NOT_APPROVED: the owner approves
     * each app once, in Model Hub's notification, pinned to its signing key), until it next answers.
     * Model Hub's listModels() and status() don't say it, so state() reports what was last heard.
     */
    private val prefs get() = context.getSharedPreferences("tartan.modelhub", android.content.Context.MODE_PRIVATE)
    private fun heardApproved() = prefs.edit().remove("notApproved").apply()

    private fun reject(call: PluginCall, e: Throwable) {
        val code = (e as? ModelHubException)?.code
        if (code == dev.modelhub.api.ModelHubContract.ERROR_NOT_APPROVED) prefs.edit().putString("notApproved", e.message).apply()
        call.reject(e.message ?: e.toString(), code?.toString())
    }

    /**
     * Tartan's own model file from before 2.37, when Tartan ran a model itself (LiteRT-LM): the copy
     * it moved into its storage. Model Hub holds the models now; the owner removes it (dropOld).
     */
    private fun oldFile(): java.io.File? = java.io.File(context.filesDir, "models").listFiles()?.firstOrNull { it.isFile && it.name.endsWith(".litertlm") }

    /** Tartan's own model file from before 2.37, and what that way of running a model left behind. */
    @PluginMethod
    fun dropOld(call: PluginCall) {
        java.io.File(context.filesDir, "models").deleteRecursively()
        java.io.File(context.filesDir, "npu-dispatch").deleteRecursively()
        java.io.File(context.cacheDir, "model-links").deleteRecursively()
        context.getSharedPreferences("tartan.litert", android.content.Context.MODE_PRIVATE).edit().clear().apply()
        call.resolve()
    }

    @PluginMethod
    fun state(call: PluginCall) {
        val out = JSObject().put("installed", installed()).put("allowed", permitted())
        oldFile()?.let { out.put("oldFile", JSObject().put("name", it.name).put("size", it.length())) }
        if (!installed() || !permitted()) return call.resolve(out)
        scope.launch {
            try {
                val models = hub.models()
                val m = models.firstOrNull { it.isDefault } ?: models.firstOrNull()
                if (m != null) {
                    out.put("model", m.displayName.ifEmpty { m.name }).put("context", m.contextTokens).put("vision", m.vision)
                        .put("accelerators", JSArray(m.accelerators))
                    m.update?.takeIf { it.available }?.let { out.put("update", it.summary) }
                }
                lastBackend?.let { out.put("backend", it) }
                lastSpeed?.let { (first, tps) -> out.put("firstMs", first).put("tokensPerSecond", tps) }
                // Approval: from Model Hub's status if it ever says ("approval": approved | pending |
                // denied), else the last refusal heard. Asking (listModels above) is what makes Model
                // Hub post its notification to approve Tartan.
                val approval = runCatching { hub.status().json.optString("approval") }.getOrDefault("")
                if (approval == "approved") heardApproved()
                else if (approval == "pending" || approval == "denied") prefs.edit().putString("notApproved", if (approval == "denied") str(R.string.modelhub_tartan_is_denied_in_model_hub) else str(R.string.modelhub_model_hub_is_waiting_for_you)).apply()
                prefs.getString("notApproved", null)?.let { out.put("notApproved", it) }
            } catch (e: ModelHubException) {
                out.put("error", e.message).put("code", e.code)
            }
            call.resolve(out)
        }
    }

    @PluginMethod
    fun allow(call: PluginCall) {
        if (!installed()) return call.resolve(JSObject().put("allowed", false))
        if (permitted()) call.resolve(JSObject().put("allowed", true))
        else requestPermissionForAlias("models", call, "allowed")
    }

    @PermissionCallback
    private fun allowed(call: PluginCall) = call.resolve(JSObject().put("allowed", permitted()))

    @PluginMethod
    fun open(call: PluginCall) {
        val intent = if (call.getString("what") == "updates") ModelHub.updatesIntent() else ModelHub.launchIntent(context)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent == null) return call.reject(str(R.string.modelhub_model_hub_isn_t_installed))
        runCatching { activity.startActivity(intent) }.fold({ call.resolve() }, { reject(call, it) })
    }

    @PluginMethod
    fun load(call: PluginCall) {
        scope.launch {
            try {
                val s = hub.load()
                heardApproved()
                lastBackend = where(s.backend)
                call.resolve(JSObject().put("backend", str(R.string.modelhub_through_model_hub, lastBackend)).put("context", s.contextTokens).put("photos", s.vision))
            } catch (e: ModelHubException) {
                reject(call, e)
            }
        }
    }

    /** {id, system, tools: string[], history: [{role, text}], turns, temperature, prepare} */
    @PluginMethod
    fun start(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject(str(R.string.modelhub_no_conversation_id))
        val system = call.getString("system")
        val tools = call.getArray("tools")?.toList<String>() ?: emptyList()
        val turns = call.getInt("turns") ?: -1
        val temperature = call.getDouble("temperature")
        val prepare = call.getBoolean("prepare") ?: false
        // The same chat, one question on, with the same instructions and tools: carry on in it
        // (Model Hub keeps what was said, tool calls included).
        val key = listOf(system ?: "", temperature?.toString() ?: "", tools.joinToString("\n")).joinToString("\u0000")
        chats[id]?.let { live ->
            if (carriesOn(live.key, live.turns, live.prepared, key, turns, prepare)) {
                live.turns = turns
                // Preparing what's already loaded marks it for the question; the question uses that up.
                live.prepared = prepare
                return call.resolve(JSObject().put("reused", true))
            }
            chats.remove(id)?.chat?.close()
        }
        val history = call.getArray("history")?.toList<JSONObject>()?.map {
            if (it.optString("role") == "user") Turn.User(it.optString("text")) else Turn.Model(it.optString("text"))
        } ?: emptyList()
        scope.launch {
            try {
                // Prepared: Model Hub answers at once and reads the instructions, tools and chat in the
                // background (LiteRT-LM's prefillPrefaceOnInit); a question meanwhile waits for it.
                val chat = hub.open(ConversationOptions(system = system, tools = tools, history = history, temperature = temperature, prepare = prepare))
                heardApproved()
                chats[id] = Live(chat, key, turns, prepare)
                call.resolve(JSObject().put("reused", false))
            } catch (e: ModelHubException) {
                reject(call, e)
            }
        }
    }

    /** {id, text?, image? (base64), toolResults?: [{name, result}]}; words arrive as "hubText" events. */
    @PluginMethod
    fun send(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject(str(R.string.modelhub_no_conversation_id))
        val chat = chats[id]?.chat ?: return call.reject(str(R.string.modelhub_no_such_conversation), "5")
        val results = call.getArray("toolResults")?.toList<JSONObject>()?.map { ToolResult(it.getString("name"), it.optString("result")) }
        val image = call.getString("image")?.let { runCatching { android.util.Base64.decode(it, android.util.Base64.DEFAULT) }.getOrNull() }
        val message = if (!results.isNullOrEmpty()) Message(toolResults = results) else Message(call.getString("text"), images = listOfNotNull(image))
        answering[id] = scope.launch {
            try {
                chat.send(message).collect { e ->
                    when (e) {
                        is HubEvent.Text -> notifyListeners("hubText", JSObject().put("id", id).put("text", e.delta))
                        is HubEvent.Progress -> notifyListeners("hubProgress", JSObject(e.json.toString()).put("id", id))
                        is HubEvent.Answered -> {
                            heardApproved()
                            val s = e.answer.stats
                            s.optString("backend").takeIf { it.isNotEmpty() }?.let { lastBackend = where(it) }
                            val tps = s.optDouble("tokensPerSecond", 0.0)
                            if (tps > 0 && e.answer.text.isNotEmpty()) lastSpeed = Pair(s.optLong("firstTokenMs"), Math.round(tps * 10) / 10.0)
                            val calls = JSArray()
                            e.answer.toolCalls.forEach { calls.put(JSObject().put("name", it.name).put("args", it.args)) }
                            call.resolve(JSObject().put("text", e.answer.text).put("toolCalls", calls).put("stats", JSObject(s.toString())))
                        }
                        is HubEvent.Thinking -> Unit
                    }
                }
            } catch (e: CancellationException) {
                call.reject(str(R.string.modelhub_stopped), "8")
                throw e
            } catch (e: Throwable) {
                reject(call, e)
            } finally {
                answering.remove(id)
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        answering.remove(call.getString("id") ?: "")?.cancel()
        call.resolve()
    }

    @PluginMethod
    fun end(call: PluginCall) {
        chats.remove(call.getString("id") ?: "")?.chat?.close()
        call.resolve()
    }

    override fun handleOnDestroy() {
        chats.values.forEach { runCatching { it.chat.close() } }
        chats.clear()
        runCatching { hub.close() }
        scope.cancel()
        super.handleOnDestroy()
    }
}
