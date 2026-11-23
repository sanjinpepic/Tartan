package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** One planned session as its sheet shows it (web/types.ts PlanSession, from GET /api/plan). */
data class PlanSessionV(
    val date: String, val today: String, val kind: String, val title: String, val status: String,
    val minutes: Double?, val km: Double?, val target: String?, val notes: String?,
    /** The structured session, block by block: "3 ×" and "Run 1 km, then Recover 2 min". */
    val steps: List<Pair<Int, String>>,
    /** Strength: the exercises as the plan has them (JSON, for the page's routine). */
    val exercises: JSONArray?,
    val manual: Boolean,
    val activityId: String?, val did: String?,
    val adjusted: Pair<Int, String>?,
    /** Strength logged in the app: finished, records; null when not started. */
    val lift: Pair<Boolean, Int>?,
    val conversation: String?,
    /** The weather expected at your training time, while it's in the forecast (outdoors only). */
    val weather: Weather? = null,
) {
    val canMark get() = activityId == null && !manual && (status == "missed" || status == "today")
    val strength get() = kind == "strength" || (exercises?.length() ?: 0) > 0
    val liftable get() = kind == "strength" && date <= today
    /** "Today", or "Thu 30 Oct". */
    val whenText get() = if (date == today) str(R.string.common_today) else "${dayName(date)} ${dateShort(date)}"
}

/** How a done session went against its plan (GET /api/plan/review). */
data class Review(val summary: String, val inRange: Double?, val steps: List<Step>, val error: String?) {
    data class Step(val label: String, val sub: String, val actual: String, val verdict: String, val off: String)
}

/** A strength routine (rpc:routine): its exercises and what they work. */
data class Routine(val basic: Boolean, val primary: List<String>, val secondary: List<String>, val items: List<Exercise>) {
    data class Exercise(val id: String, val name: String, val kind: String, val equipment: String?, val dose: String, val cues: List<String>, val why: String, val primary: List<String>, val secondary: List<String>)
}

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }
private fun JSONObject.dbl(k: String): Double? = if (!has(k) || isNull(k)) null else optDouble(k).takeUnless { it.isNaN() }
private fun <T> JSONArray?.each(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it)?.let(f) }
private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }

private val STEP get() = mapOf("warmup" to str(R.string.session_warm_up), "run" to str(R.string.common_run), "recover" to str(R.string.session_recover), "cooldown" to str(R.string.session_cool_down))
private fun one(x: Double) = if (x == Math.rint(x)) x.toInt().toString() else String.format(java.util.Locale.getDefault(), "%.1f", x)

fun findSession(planJson: String, date: String, kind: String?): PlanSessionV? {
    val v = JSONObject(planJson)
    val day = v.optJSONArray("weeks").each { it }.flatMap { w -> w.optJSONArray("days").each { it } }.firstOrNull { it.optString("date") == date } ?: return null
    val s = day.optJSONArray("sessions").each { it }.firstOrNull { it.optString("kind") != "rest" && (kind == null || it.optString("kind") == kind) } ?: return null
    fun len(x: JSONObject) = x.dbl("distance_m")?.let { if (it >= 1000) str(R.string.common_n_km, one(it / 1000)) else "${it.toInt()} m" } ?: x.dbl("duration_s")?.let { duration(it / 60) } ?: ""
    val steps = s.optJSONArray("steps").each { b ->
        b.optInt("repeat", 1) to b.optJSONArray("steps").each { x -> listOf(STEP[x.optString("kind")] ?: x.optString("kind"), len(x)).filter { it.isNotEmpty() }.joinToString(" ") }.joinToString(str(R.string.session_then))
    }
    val a = s.optJSONObject("activity")
    val did = a?.let { listOfNotNull(it.dbl("distance_km")?.let { k -> str(R.string.common_n_km, one(k)) }, it.dbl("moving_min")?.let { m -> duration(m) }).joinToString(" · ").ifEmpty { it.text("name") ?: it.optString("sport") } }
    val lift = v.optJSONObject("lifts")?.optJSONObject(date)?.let { it.optBoolean("finished") to it.optInt("prs") }
    return PlanSessionV(
        date, v.optString("today"), s.optString("kind"), s.optString("title"), s.optString("status"),
        s.dbl("duration_min"), s.dbl("distance_km"), s.text("target"), s.text("notes"), steps,
        s.optJSONArray("exercises"), s.optBoolean("manual"), a?.text("id"), did?.let { str(R.string.common_did, it) },
        s.optJSONObject("adjusted")?.let { it.optInt("shift_s") to it.optString("reason") }, lift,
        v.optJSONObject("plan")?.text("conversation"),
        parseWeather(s.optJSONObject("weather")),
    )
}

fun parseReview(json: String): Review {
    val r = JSONObject(json)
    r.text("error")?.let { return Review("", null, emptyList(), it) }
    fun len(st: JSONObject): String { val m = st.optDouble("metres", 0.0); val s = st.optDouble("seconds", 0.0); return if (m >= 950) str(R.string.common_n_km, String.format(java.util.Locale.getDefault(), "%.2f", m / 1000)) else if (s > 0) duration(s / 60) else "" }
    return Review(
        r.optString("summary"), r.dbl("inRange"),
        r.optJSONArray("steps").each { Review.Step(it.optString("label"), listOf(len(it), it.optString("target")).filter { x -> x.isNotEmpty() }.joinToString(" · "), it.optString("actual"), it.optString("verdict"), it.optString("off")) },
        null,
    )
}

fun parseRoutine(json: String): Routine {
    val r = JSONObject(json)
    return Routine(
        r.optBoolean("basic"), r.optJSONArray("primary").strings(), r.optJSONArray("secondary").strings(),
        r.optJSONArray("items").each { Routine.Exercise(it.optString("id"), it.optString("name"), it.optString("kind"), it.text("equipment"), it.optString("dose"), it.optJSONArray("cues").strings(), it.optString("why"), it.optJSONArray("primary").strings(), it.optJSONArray("secondary").strings()) },
    )
}

/** What a session's sheet asks of the app. */
interface SessionActions {
    fun openWorkout(id: String)
    fun chat(conversation: String?, prefill: String?)
    fun go(hash: String)
}

/**
 * A session's sheet (web/views/plan.ts openSession): the session from the plan, then how it went
 * (when a workout did it), its strength routine with the body at work, and marking it done.
 */
class SessionModel(private val scope: CoroutineScope, val api: SettingsApi, val date: String, val kind: String?) {
    var session by mutableStateOf<PlanSessionV?>(null)
    var missing by mutableStateOf(false)
    var review by mutableStateOf<Review?>(null)
    var routine by mutableStateOf<Routine?>(null)
    var works by mutableStateOf<Frames?>(null)
    /** The page can't draw the body (no WebGL): no pictures, the words alone. */
    var noBody by mutableStateOf(false)
    val thumbs = androidx.compose.runtime.mutableStateMapOf<String, Frames>()
    var said by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    /** True once a write went through: the sheet closes. */
    var done by mutableStateOf(false)

    /** The session as a .fit workout file through the share sheet, for any watch's app (Garmin, Coros…). */
    fun saveFit() = scope.launch {
        val s = session ?: return@launch
        busy = true
        said = api.call("sessionFile", JSONObject().put("date", s.date).put("kind", s.kind)).fold(
            { str(R.string.session_saved_open, runCatching { JSONObject(it).optString("name") }.getOrNull()?.ifEmpty { null } ?: str(R.string.session_the_workout)) },
            { str(R.string.session_couldn_t_make_the_file, it.message) },
        )
        busy = false
    }

    fun load() = scope.launch {
        val json = api.get("/api/plan") ?: run { missing = true; return@launch }
        val s = runCatching { findSession(json, date, kind) }.getOrNull() ?: run { missing = true; return@launch }
        session = s
        if (s.activityId != null && (s.steps.isNotEmpty() || s.target != null))
            api.get("/api/plan/review?date=${s.date}&kind=${java.net.URLEncoder.encode(s.kind, "UTF-8")}")?.let { runCatching { review = parseReview(it) } }
        if (s.strength) {
            val r = api.rpc("routine", JSONObject().put("exercises", s.exercises ?: JSONArray()).apply { s.minutes?.let { put("minutes", it) } })?.let { runCatching { parseRoutine(it) }.getOrNull() } ?: return@launch
            routine = r
            works = bodyFrames(api, JSONObject().put("key", "session").put("primary", JSONArray(r.primary)).put("secondary", JSONArray(r.secondary)).put("width", 300).put("height", 300).put("turn", 24))
            if (works == null) { noBody = true; return@launch }
            for (e in r.items) bodyFrames(api, JSONObject().put("exercise", e.id).put("primary", JSONArray(e.primary)).put("secondary", JSONArray(e.secondary)).put("width", 144).put("height", 120).put("loop", 1))?.let { thumbs[e.id] = it }
        }
    }

    private fun write(path: String, method: String, body: JSONObject, ok: String) {
        busy = true
        scope.launch {
            val (st, text) = api.send(path, method, body.toString())
            val err = runCatching { JSONObject(text).text("error") }.getOrNull()
            if (st in 200..299 && err == null) { said = ok; done = true } else said = str(R.string.common_couldnt_save, err ?: str(R.string.common_didnt_go_through_status, st))
            busy = false
        }
    }

    fun mark(done: Boolean) {
        val s = session ?: return
        write("/api/plan/mark", "PUT", JSONObject().put("date", s.date).put("kind", s.kind).put("done", done), if (done) str(R.string.session_marked_done, s.title) else str(R.string.session_is_no_longer_marked_done, s.title))
    }

    fun undoAdjust() {
        val s = session ?: return
        write("/api/plan/adjust", "PUT", JSONObject().put("date", s.date).put("kind", s.kind).put("undo", true), str(R.string.common_is_back_as_planned, s.title))
    }
}
