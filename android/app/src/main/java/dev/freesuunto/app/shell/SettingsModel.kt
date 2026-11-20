package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** What Settings asks of the app: reads, writes (status and body) and the page's own abilities (`rpc`). */
interface SettingsApi {
    suspend fun get(path: String): String?
    suspend fun send(path: String, method: String, body: String?): Pair<Int, String>
    /** Something only the page can do (web/lib/shell.ts RPC): its answer as JSON, or null. */
    suspend fun rpc(name: String, args: JSONObject = JSONObject()): String?
    /** The same, with why it failed when it did (the page's error, in words). */
    suspend fun call(name: String, args: JSONObject = JSONObject()): Result<String> = rpc(name, args)?.let { Result.success(it) } ?: Result.failure(Exception(str(R.string.settings_it_didn_t_go_through)))
}

data class Goals(val weeklyKm: Double?, val weeklyWorkouts: Int?, val longRunKm: Double?, val raceKm: Double?, val raceName: String?, val raceDate: String?, val raceTarget: Int?)

data class Profile(val maxHr: Int, val restHr: Int, val maxSource: String, val sex: String?, val fromWatch: Boolean, val limits: List<Int>, val canUseWatch: Boolean)

data class Times(
    val weekday: String,
    val weekend: String,
    val days: Map<String, String>,
    val remind: Boolean,
    val before: Int,
    val after: Boolean,
    val calendar: Boolean,
    val calendarId: String?,
    val calendarName: String?,
    val next: String?,
    val anySlots: Boolean,
    /** The morning notification (and its time) and Sunday's review nudge. */
    val morning: Boolean = true,
    val morningAt: String = "07:30",
    val review: Boolean = true,
    /** A note from the coach after each new run (src/after-run.ts). */
    val runNote: Boolean = true,
)

data class Note(val id: String, val text: String, val kind: String)

data class WebPrefs(val colours: String, val weekly: Boolean, val demos: String, val version: String, val build: String)

data class CoachInfo(val provider: String, val model: String, val ready: Boolean)

data class PlanInfoS(val title: String, val weeks: Int, val updated: String, val approval: String)

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }
private fun JSONObject.dbl(k: String): Double? = if (!has(k) || isNull(k)) null else optDouble(k).takeUnless { it.isNaN() || it == 0.0 }

/**
 * Settings, native (Training, Coach, More): what they show, read once and kept until a write; and
 * saving, through the page so the cache, the calendar and the reminders all hear of it.
 */
class SettingsModel(private val scope: CoroutineScope, private val api: SettingsApi) {
    var goals by mutableStateOf<Goals?>(null)
    var profile by mutableStateOf<Profile?>(null)
    var times by mutableStateOf<Times?>(null)
    var plan by mutableStateOf<PlanInfoS?>(null)
    var hasPlan by mutableStateOf(false)
    var coach by mutableStateOf<CoachInfo?>(null)
    val notes = mutableStateListOf<Note>()
    var prefs by mutableStateOf<WebPrefs?>(null)
    /** Something said after a save ("Targets saved…"), shown once. */
    var said by mutableStateOf<String?>(null)
    private var read = false

    fun forget() { read = false }

    fun ensure() {
        if (read) return
        read = true
        scope.launch {
            val g = scope.async { api.get("/api/goals") }
            val p = scope.async { api.get("/api/profile") }
            val t = scope.async { api.get("/api/schedule") }
            val pl = scope.async { api.get("/api/plan") }
            val c = scope.async { api.get("/api/coach/status") }
            val m = scope.async { api.get("/api/coach/memory") }
            val w = scope.async { api.rpc("prefs") }
            g.await()?.let { runCatching { goals = parseGoals(it) } }
            p.await()?.let { runCatching { profile = parseProfile(it) } }
            t.await()?.let { runCatching { times = parseTimes(it) } }
            pl.await()?.let { runCatching { JSONObject(it) }.getOrNull() }?.let { v ->
                val pp = v.optJSONObject("plan")
                hasPlan = pp != null
                plan = pp?.let { PlanInfoS(it.optString("title"), v.optJSONArray("weeks")?.length() ?: 0, it.optString("updated"), v.text("approval") ?: "ask") }
                    ?: PlanInfoS("", 0, "", v.text("approval") ?: "ask")
            }
            c.await()?.let { runCatching { JSONObject(it) }.getOrNull() }?.let { s ->
                val providers = s.optJSONArray("providers")
                val pid = s.optString("provider")
                val label = (0 until (providers?.length() ?: 0)).mapNotNull { providers!!.optJSONObject(it) }.firstOrNull { it.optString("id") == pid }?.optString("label") ?: pid
                val mid = s.optString("model")
                val models = s.optJSONArray("models")
                val mlabel = (0 until (models?.length() ?: 0)).mapNotNull { models!!.optJSONObject(it) }.firstOrNull { it.optString("id") == mid }?.optString("label") ?: mid
                coach = CoachInfo(label, mlabel, s.optBoolean("ready"))
            }
            m.await()?.let { runCatching { JSONObject(it).optJSONArray("notes") }.getOrNull() }?.let { a ->
                notes.clear()
                for (i in 0 until a.length()) a.optJSONObject(i)?.takeUnless { it.optBoolean("gone") }?.let { notes.add(Note(it.optString("id"), it.optString("text"), it.optString("kind"))) }
            }
            w.await()?.let { runCatching { JSONObject(it) }.getOrNull() }?.let {
                prefs = WebPrefs(it.optString("colours", "wallpaper"), it.optBoolean("weekly", true), it.optString("demos", "me"), it.optString("version"), it.optString("build"))
            }
        }
    }

    /** A write: on success, read everything again (and say `ok`); on failure, say why. */
    /** The card saved last on its own, as you typed (its key: "targets", "heart"): it says "Saved". */
    var autosaved by mutableStateOf<String?>(null)

    /**
     * Save, and read the settings again; quiet (`quietly` names the card): saved as you type, so
     * no message and no reading again, which would reset a field still being typed in.
     */
    private fun write(path: String, method: String, body: JSONObject?, ok: String?, quietly: String? = null, after: () -> Unit = {}) {
        scope.launch {
            val (st, text) = api.send(path, method, body?.toString())
            val err = runCatching { JSONObject(text).text("error") }.getOrNull()
            if (st in 200..299 && err == null) {
                after()
                if (quietly != null) { autosaved = quietly; return@launch }
                said = ok
                read = false
                ensure()
            } else said = str(R.string.common_couldnt_save, err ?: str(R.string.common_didnt_go_through_status, st))
        }
    }

    fun saveGoals(g: Goals, quiet: Boolean = false) {
        val b = JSONObject()
        g.weeklyKm?.let { b.put("weekly_km", it) }
        g.weeklyWorkouts?.let { b.put("weekly_workouts", it) }
        g.longRunKm?.let { b.put("long_run_km", it) }
        if (g.raceKm != null && g.raceKm > 0) b.put("race", JSONObject().put("distance_km", g.raceKm).apply {
            g.raceName?.let { put("name", it) }; g.raceDate?.let { put("date", it) }; g.raceTarget?.let { put("target_s", it) }
        })
        write("/api/goals", "PUT", b, str(R.string.settings_targets_saved_today_and_progress_use), if (quiet) "targets" else null)
    }

    fun saveProfile(max: Int?, rest: Int, sex: String?, quiet: Boolean = false) =
        write("/api/profile", "PUT", JSONObject().put("max_hr", max ?: JSONObject.NULL).put("rest_hr", rest).put("sex", sex ?: JSONObject.NULL), str(R.string.settings_heart_rate_settings_saved), if (quiet) "heart" else null)

    fun useWatchZones(rest: Int, sex: String?) =
        write("/api/profile", "PUT", JSONObject().put("rest_hr", rest).put("sex", sex ?: JSONObject.NULL), str(R.string.settings_using_your_watch_s_heart_rate))

    fun saveTimes(change: JSONObject, ok: String?) = write("/api/schedule", "PUT", change, ok)

    fun approval(mode: String) = write("/api/plan/approval", "PUT", JSONObject().put("mode", mode), null)

    fun resetPlan() = write("/api/plan/reset", "POST", null, str(R.string.settings_plan_cleared_your_coach_can_make))

    /** A note just forgotten: gone at once, deleted after a few seconds unless undone. */
    var forgotten by mutableStateOf<Pair<Int, Note>?>(null)
    private var forgetting: kotlinx.coroutines.Job? = null
    fun forgetNote(n: Note) {
        forgetting?.let { it.cancel(); forgotten?.second?.let { f -> scope.launch { api.send("/api/coach/memory/${java.net.URLEncoder.encode(f.id, "UTF-8")}", "DELETE", null) } } }
        val at = notes.indexOf(n)
        notes.remove(n)
        forgotten = at to n
        forgetting = scope.launch {
            kotlinx.coroutines.delay(6000)
            forgotten = null
            api.send("/api/coach/memory/${java.net.URLEncoder.encode(n.id, "UTF-8")}", "DELETE", null)
        }
    }
    fun unforget() {
        val (at, n) = forgotten ?: return
        forgetting?.cancel(); forgetting = null
        forgotten = null
        notes.add(at.coerceIn(0, notes.size), n)
    }

    fun setPref(name: String, args: JSONObject, update: (WebPrefs) -> WebPrefs) {
        prefs = prefs?.let(update)
        scope.launch { api.rpc(name, args) }
    }

    fun saveFile(path: String, name: String, type: String) = scope.launch {
        api.rpc("saveFile", JSONObject().put("path", path).put("name", name).put("type", type)) ?: run { said = str(R.string.settings_couldn_t_make_the_file) }
    }

    /** Ask Android for notifications (through the page's plugin): true when allowed. */
    suspend fun allowReminders(): Boolean = api.rpc("allowReminders") == "true"

    /** The phone's calendars that take events (asking for calendar access first); null when not allowed. */
    suspend fun calendars(): List<Pair<String, String>>? {
        val a = api.rpc("calendars")?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return null
        return (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { it.optString("id") to it.optString("title") }
    }

    companion object {
        fun parseGoals(json: String): Goals {
            val g = JSONObject(json).optJSONObject("goals") ?: JSONObject()
            val r = g.optJSONObject("race")
            return Goals(g.dbl("weekly_km"), g.dbl("weekly_workouts")?.toInt(), g.dbl("long_run_km"), r?.dbl("distance_km"), r?.text("name"), r?.text("date"), r?.dbl("target_s")?.toInt())
        }

        fun parseProfile(json: String): Profile {
            val p = JSONObject(json)
            val limits = p.optJSONArray("zone_limits")?.let { a -> (0 until a.length()).map { a.optInt(it) } } ?: emptyList()
            val fromWatch = p.optString("zones_source") == "your watch"
            return Profile(p.optInt("max_hr"), p.optInt("rest_hr"), p.optString("max_hr_source"), p.text("sex"), fromWatch, limits, p.has("watch_zones") && !p.isNull("watch_zones") && !fromWatch)
        }

        fun parseTimes(json: String): Times {
            val v = JSONObject(json)
            val p = v.optJSONObject("prefs") ?: JSONObject()
            val days = p.optJSONObject("days")?.let { d -> d.keys().asSequence().mapNotNull { k -> d.text(k)?.let { k to it } }.toMap() } ?: emptyMap()
            val r = p.optJSONObject("remind") ?: JSONObject()
            val c = p.optJSONObject("calendar") ?: JSONObject()
            val slot = v.optJSONArray("slots")?.optJSONObject(0)
            val next = slot?.let {
                val start = it.optString("start")
                val day = runCatching { java.time.LocalDate.parse(start.take(10)).format(java.time.format.DateTimeFormatter.ofPattern("EEEE d MMM", java.util.Locale.getDefault())) }.getOrDefault(start.take(10))
                str(R.string.settings_next_slot, it.optString("title"), day, start.drop(11).take(5))
            }
            return Times(
                p.optString("weekday"), p.optString("weekend"), days,
                r.optBoolean("on"), r.optInt("before_min", 30), r.optBoolean("after", true),
                c.optBoolean("on"), c.text("calendar_id"), c.text("calendar_name"),
                next, (v.optJSONArray("slots")?.length() ?: 0) > 0,
                p.optJSONObject("notify")?.optBoolean("morning", true) ?: true, p.optJSONObject("notify")?.text("morning_at") ?: "07:30", p.optJSONObject("notify")?.optBoolean("review", true) ?: true,
                p.optJSONObject("notify")?.optBoolean("run", true) ?: true,
            )
        }
    }
}
