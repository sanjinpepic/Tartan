package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/** A photo for the coach: the JPEG to send (base64) and a small one to show. */
class Photo(val data: String, val thumb: String, val bitmap: ImageBitmap)

/** One step the coach took to answer ("Checking how ready you are"), running or done. */
class Step(val label: String) {
    var done by mutableStateOf(false)
}

/** A message in the chat. The coach's grows as its answer streams in. */
class Msg(val user: Boolean, text: String = "", val image: ImageBitmap? = null) {
    var text by mutableStateOf(text)
    val steps = mutableStateListOf<Step>()
    var streaming by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    /** When the answer was asked for: how long the coach has been at it. */
    var started = System.currentTimeMillis()
    /** "Plan updated · see the plan", "2 changes · review them": where they go. */
    val links = mutableStateListOf<Pair<String, String>>()
    /** Who answered ("Gemma 4 E2B on your phone", "Gemini 3.8 Flash"). */
    var by by mutableStateOf<String?>(null)
    /** Flagged by you (Report reply): the reason. */
    var reported by mutableStateOf<String?>(null)
    /** Routes in this answer, as cards to tap (made by the coach, or a saved one it showed). */
    val routes = mutableStateListOf<ChatRoute>()
    /** Just sent or just begun answering: it rises in once (a chat read back doesn't). */
    var fresh = false
}

/** A route in the chat (src/coach.ts RouteCard). */
data class ChatRoute(val id: String, val name: String, val km: Double, val ascent: Int?, val loop: Boolean, val onWatch: Boolean, val preview: List<LngLat>, val scenery: String?) {
    companion object {
        fun parse(o: JSONObject): ChatRoute {
            val p = o.optJSONArray("preview")
            val pts = (0 until (p?.length() ?: 0)).mapNotNull { p!!.optJSONArray(it) }.map { it.optDouble(0) to it.optDouble(1) }
            return ChatRoute(o.optString("id"), o.optString("name"), o.optDouble("km", 0.0), if (o.has("ascent_m") && !o.isNull("ascent_m")) o.optInt("ascent_m") else null, o.optBoolean("loop"), o.optBoolean("on_watch"), pts, o.optString("scenery").ifEmpty { null })
        }
    }
}

/** A reply reported, for Tartan's developer: what was asked, what came back, who wrote it. */
data class Reported(val question: String, val reply: String, val by: String?)

data class ChatStatus(val ready: Boolean, val model: String, val photos: Boolean, val voice: Boolean)

data class Conv(val id: String, val title: String, val updated: String)

/** What the chat asks of the app: plain API calls, and one whose answer streams line by line. */
interface ChatApi {
    suspend fun get(path: String): String?
    /** POST, each NDJSON line to `onLine` as it comes; the HTTP status. */
    suspend fun stream(path: String, body: String, onLine: (String) -> Unit): Int
    /** The chat is on screen: get it ready for its question (Model Hub; nothing elsewhere). */
    suspend fun prepare(conversation: String?) {}
    /** POST, the answer's body (null: it failed). */
    suspend fun post(path: String, body: String): String? = null
}

/**
 * The coach's chat, native (the web's renderChat in web/views/coach.ts): a conversation, its
 * messages, sending one (with a photo) and reading the answer as it streams: the steps the coach
 * takes, its words, whether it changed the plan or suggests changes.
 */
class ChatModel(private val scope: CoroutineScope, private val api: ChatApi) {
    var status by mutableStateOf<ChatStatus?>(null)
    /** The conversation open; null: a new one. */
    var conversation by mutableStateOf<String?>(null)
    val messages = mutableStateListOf<Msg>()
    var draft by mutableStateOf("")
    var photo by mutableStateOf<Photo?>(null)
    var busy by mutableStateOf(false)
    var loading by mutableStateOf(false)
    var list by mutableStateOf<List<Conv>>(emptyList())
    /** An answer finished (the app tells you when you were elsewhere). */
    var onAnswered: ((Msg) -> Unit)? = null
    /** Bumped when the chat should take the keyboard (opened to ask something). */
    var focusAsk by mutableStateOf(0)

    private var opened = false
    /** Bumped by every load and send: a load that finishes after a newer one (or a send) is dropped. */
    private var gen = 0

    /** Open the chat: a given conversation (null: a new one; absent: your latest) and words to start with. */
    fun open(conversation: String?, given: Boolean, prefill: String?) {
        opened = true
        if (prefill != null) draft = prefill
        if (prefill != null || given) focusAsk++
        scope.launch {
            readStatus()
            // An answer still coming in stays live on screen; only another conversation, asked for by name, replaces it.
            if (busy && (!given || conversation == this@ChatModel.conversation)) return@launch
            val id = if (given) conversation else JSONArray(api.get("/api/coach/conversations") ?: "[]").optJSONObject(0)?.optString("id")
            load(id)
        }
    }

    /** Shown without being opened from somewhere: the latest conversation, once. */
    fun ensure() {
        if (!opened) open(null, false, null)
        // Back on the chat: the conversation as saved, quietly (an answer that finished out of view shows).
        else scope.launch { readStatus(); if (!busy) conversation?.let { load(it, quiet = true) } }
    }

    private suspend fun readStatus() {
        val s = api.get("/api/coach/status")?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return
        val id = s.optString("model")
        val models = s.optJSONArray("models")
        // Who answers ("Gemini 3.8 Flash; offline, Gemma 4 E2B on your phone"), else the model's name.
        val label = s.optString("answers").ifEmpty { null } ?: (0 until (models?.length() ?: 0)).mapNotNull { models!!.optJSONObject(it) }.firstOrNull { it.optString("id") == id }?.optString("label") ?: id
        status = ChatStatus(s.optBoolean("ready"), label, s.optBoolean("photos", true), s.optBoolean("voice", true))
    }

    /** Show a conversation as saved; quiet: keep what's on screen until it's read (no spinner, no flash). */
    suspend fun load(id: String?, quiet: Boolean = false) {
        val mine = ++gen
        conversation = id
        if (id == null) { loading = false; messages.clear(); scope.launch { api.prepare(null) }; return }
        if (!quiet) { messages.clear(); loading = true; scope.launch { api.prepare(id) } }
        val c = api.get("/api/coach/conversations/$id")?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (mine != gen) return
        loading = false
        val display = c?.optJSONArray("display") ?: return
        val read = (0 until display.length()).mapNotNull { display.optJSONObject(it) }.map { m ->
            Msg(m.optString("role") == "user", m.optString("text"), m.optString("image").ifEmpty { null }?.let(::decode)).also { msg ->
                m.optJSONArray("tools")?.let { t -> for (k in 0 until t.length()) msg.steps.add(Step(t.optString(k)).also { it.done = true }) }
                msg.by = m.optString("by").ifEmpty { null }
                msg.reported = m.optString("reported").ifEmpty { null }
                // A turn that failed: its error, kept with the question (Ask again).
                if (m.optBoolean("failed") && msg.user.not()) msg.error = m.optString("error").ifEmpty { str(R.string.chat_this_answer_didn_t_come_through) }
                m.optJSONArray("routes")?.let { a -> for (k in 0 until a.length()) a.optJSONObject(k)?.let { msg.routes.add(ChatRoute.parse(it)) } }
                // Before cards: a route kept as a name and distance only.
                if (msg.routes.isEmpty()) m.optJSONObject("route")?.let { msg.routes.add(ChatRoute.parse(it)) }
            }
        }
        if (quiet && read.size == messages.size && read.zip(messages).all { (a, b) -> a.text == b.text }) return
        messages.clear()
        messages.addAll(read)
    }

    fun newChat() = scope.launch { load(null) }

    /** A reply that failed: its question asked again. */
    fun retry(m: Msg) {
        val i = messages.indexOf(m)
        val q = messages.subList(0, i.coerceAtLeast(0)).lastOrNull { it.user }?.text ?: return
        send(q)
    }

    /** Report a reply (kept with the chat); `then` gets it back for an issue to Tartan's developer. */
    fun report(m: Msg, reason: String, note: String, then: (Reported) -> Unit) {
        val id = conversation ?: return
        val index = messages.indexOf(m).takeIf { it >= 0 } ?: return
        m.reported = reason
        scope.launch {
            val r = api.post("/api/coach/report", JSONObject().put("conversation", id).put("index", index).put("reason", reason).put("note", note).toString())
                ?.let { runCatching { JSONObject(it) }.getOrNull() }
            then(Reported(r?.optString("question") ?: "", r?.optString("reply") ?: m.text, r?.optString("by")?.ifEmpty { null } ?: m.by))
        }
    }

    fun readList() = scope.launch {
        list = JSONArray(api.get("/api/coach/conversations") ?: "[]").let { a ->
            (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { Conv(it.optString("id"), it.optString("title"), it.optString("updated")) }
        }
    }

    fun send(said: String) {
        var text = said.trim()
        val sending = photo
        if (sending != null && text.isEmpty()) text = str(R.string.chat_what_do_you_make_of_this)
        if (text.isEmpty() || busy) return
        photo = null
        draft = ""
        messages.add(Msg(true, text, sending?.bitmap).also { it.fresh = true })
        val reply = Msg(false).also { it.streaming = true; it.fresh = true }
        messages.add(reply)
        busy = true
        // A load still on its way would replace these two: it's dropped.
        gen++
        loading = false
        val body = JSONObject().put("conversation", conversation ?: JSONObject.NULL).put("message", text)
        if (sending != null) body.put("images", JSONArray().put(JSONObject().put("mime", "image/jpeg").put("data", sending.data).put("thumb", sending.thumb)))
        scope.launch {
            val status = api.stream("/api/coach/chat", body.toString()) { line ->
                val m = runCatching { JSONObject(line) }.getOrNull() ?: return@stream
                when (m.optString("type")) {
                    "conversation" -> conversation = m.optString("id")
                    "tool" -> {
                        reply.steps.lastOrNull()?.done = true
                        reply.steps.add(Step(m.optString("label")))
                    }
                    "text" -> reply.text += m.optString("delta")
                    "by" -> reply.by = m.optString("label").ifEmpty { null }
                    "plan" -> {
                        val n = m.optInt("proposed")
                        reply.links.add(if (n > 0) plural(R.plurals.chat_changes_review, n, n) to "coach" else str(R.string.chat_plan_updated_see) to "coach")
                    }
                    "route" -> ChatRoute.parse(m).let { r -> if (reply.routes.none { it.id == r.id }) reply.routes.add(r) }
                    "error" -> reply.error = m.optString("message")
                }
            }
            if (status !in 200..299 && reply.error == null) reply.error = str(R.string.chat_the_coach_couldn_t_answer, status)
            reply.steps.forEach { it.done = true }
            reply.streaming = false
            busy = false
            onAnswered?.invoke(reply)
            // Answered while another view of this conversation was put up: show it as saved.
            if (reply !in messages && conversation != null) load(conversation, quiet = true)
        }
    }

    companion object {
        /** A data URL (or bare base64) to a bitmap. */
        fun decode(src: String): ImageBitmap? = runCatching {
            val b64 = src.substringAfter("base64,", src)
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()

        /** A picked photo as the web makes one (chatImage): a JPEG at most 1280px, and a 320px thumbnail. */
        fun photo(bmp: Bitmap): Photo {
            fun jpeg(max: Int, q: Int): ByteArray {
                val k = minOf(1f, max.toFloat() / maxOf(bmp.width, bmp.height))
                val scaled = if (k < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * k).toInt(), (bmp.height * k).toInt(), true) else bmp
                return ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.JPEG, q, it) }.toByteArray()
            }
            val full = Base64.encodeToString(jpeg(1280, 85), Base64.NO_WRAP)
            val small = jpeg(320, 70)
            val thumb = "data:image/jpeg;base64," + Base64.encodeToString(small, Base64.NO_WRAP)
            return Photo(full, thumb, BitmapFactory.decodeByteArray(small, 0, small.size).asImageBitmap())
        }
    }
}
