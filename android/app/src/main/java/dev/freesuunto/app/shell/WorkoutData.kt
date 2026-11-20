package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** One source's copy of a workout: what that source measured. */
data class Copy(
    val source: String, val start: String?, val device: String?,
    val elapsedS: Double?, val movingS: Double?, val distanceM: Double?, val avgHr: Double?, val maxHr: Double?,
    val avgSpeed: Double?, val elevationM: Double?, val cadence: Double?, val power: Double?, val calories: Double?,
    val hasStreams: Boolean,
)

data class Split(val n: Int, val speed: Double?, val hr: Double?, val elev: Double?)

data class HrZone(val zone: Int, val name: String, val seconds: Double, val lo: Int, val hi: Int)

data class Effort(val load: Double, val estimated: Boolean, val label: String, val rank: String?)

/** A workout as its sheet shows it (GET /api/activity/:id, web/types.ts ActivityView). */
data class Workout(
    val id: String, val start: String, val startLocal: String?, val sport: String, val name: String?, val device: String?, val description: String?,
    val distanceKm: Double?, val movingMin: Double?, val elevationM: Double?, val avgHr: Int?, val maxHr: Int?,
    val pace: String?, val speedKmh: Double?, val calories: Double?, val feeling: Int?,
    val copies: List<Copy>, val provenance: Map<String, String>, val splits: List<Split>,
    val latlng: List<Pair<Double, Double>?>, val distance: List<Double?>, val velocity: List<Double?>, val heartrate: List<Double?>, val altitude: List<Double?>,
    val streamsFrom: String?, val zones: List<HrZone>, val load: Effort?, val profileMax: Int, val zonesSource: String?,
) {
    val isRun get() = Regex("run|walk|hik|trail|treadmill", RegexOption.IGNORE_CASE).containsMatchIn(sport)
    /** Counts to a pair of shoes. */
    val shod get() = Regex("run|jog|trail|treadmill", RegexOption.IGNORE_CASE).containsMatchIn(sport)
    val route get() = latlng.filterNotNull()
}

/** A run, finished (src/run-finish.ts RunFinish). */
data class Finish(val plan: PlanDone?, val records: List<Record>, val last: Last?, val next: Next?) {
    data class PlanDone(val title: String, val summary: String?, val onTarget: Int?, val total: Int?)
    data class Record(val name: String, val timeS: Int, val rank: Int)
    data class Last(val date: String, val name: String?, val pace: String?, val hr: Int?, val nowPace: String?, val nowHr: Int?, val verdict: String, val text: String)
    data class Next(val date: String, val kind: String, val title: String, val rule: String, val why: String, val shiftS: Int?, val applied: Boolean)
    val empty get() = plan == null && records.isEmpty() && last == null && next == null
}

data class RunNote(val id: String, val tag: String, val text: String, val area: String?)

data class Shoe(val id: String, val name: String, val retired: Boolean)

data class Worked(val muscle: String, val level: Int, val share: Double)

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }
private fun JSONObject.dbl(k: String): Double? = if (!has(k) || isNull(k)) null else optDouble(k).takeUnless { it.isNaN() }
private fun JSONObject.int(k: String): Int? = dbl(k)?.let { Math.round(it).toInt() }
private fun <T> JSONArray?.each(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it)?.let(f) }
private fun JSONArray?.numbers(): List<Double?> = if (this == null) emptyList() else (0 until length()).map { i -> if (isNull(i)) null else optDouble(i).takeUnless { it.isNaN() } }

fun parseWorkout(json: String): Workout {
    val v = JSONObject(json)
    val a = v.getJSONObject("detail")
    val st = v.optJSONObject("streams")
    val s = st?.optJSONObject("streams")
    val ll = s?.optJSONArray("latlng")
    val latlng = if (ll == null) emptyList() else (0 until ll.length()).map { i ->
        ll.optJSONArray(i)?.takeIf { it.length() == 2 }?.let { p -> p.optDouble(0).takeUnless { it.isNaN() }?.let { la -> p.optDouble(1).takeUnless { it.isNaN() }?.let { lo -> la to lo } } }
    }
    val prov = a.optJSONObject("provenance")
    val load = v.optJSONObject("load")
    val profile = v.optJSONObject("profile") ?: JSONObject()
    return Workout(
        a.optString("id"), a.optString("start"), a.text("start_local"), a.optString("sport"), a.text("name"), a.text("device"), a.text("description"),
        a.dbl("distance_km"), a.dbl("moving_min"), a.dbl("elevation_m"), a.int("avg_hr"), a.int("max_hr"),
        a.text("avg_pace_min_km"), a.dbl("avg_speed_kmh"), a.dbl("calories"), a.int("feeling"),
        a.optJSONArray("copies").each { c ->
            Copy(
                c.optString("source"), c.text("start"), c.text("device"), c.dbl("elapsed_s"), c.dbl("moving_s"), c.dbl("distance_m"), c.dbl("avg_hr"), c.dbl("max_hr"),
                c.dbl("avg_speed"), c.dbl("elevation_m"), c.dbl("avg_cadence"), c.dbl("avg_power"), c.dbl("calories"), c.optBoolean("has_streams"),
            )
        },
        prov?.keys()?.asSequence()?.associateWith { prov.optString(it) } ?: emptyMap(),
        a.optJSONArray("splits_metric").each { Split(it.optInt("split"), it.dbl("average_speed"), it.dbl("average_heartrate"), it.dbl("elevation_difference")) },
        latlng, s?.optJSONArray("distance").numbers(), s?.optJSONArray("velocity").numbers(), s?.optJSONArray("heartrate").numbers(), s?.optJSONArray("altitude").numbers(),
        st?.text("from"),
        v.optJSONArray("zones").each { z -> HrZone(z.optInt("zone"), z.optString("name"), z.optDouble("seconds", 0.0), z.optJSONArray("bpm")?.optInt(0) ?: 0, z.optJSONArray("bpm")?.optInt(1) ?: 0) },
        load?.let { Effort(it.optDouble("load"), it.optBoolean("estimated"), it.optString("label"), it.text("rank")) },
        profile.optInt("max_hr"), profile.text("zones_source"),
    )
}

fun parseFinish(json: String): Finish? {
    if (json.isBlank() || json.trim() == "null") return null
    val f = JSONObject(json)
    return Finish(
        f.optJSONObject("plan")?.let { p -> Finish.PlanDone(p.optString("title"), p.text("summary"), p.optJSONObject("work")?.optInt("onTarget"), p.optJSONObject("work")?.optInt("total")) },
        f.optJSONArray("records").each { Finish.Record(it.optString("name"), it.optInt("time_s"), it.optInt("rank")) },
        f.optJSONObject("last")?.let { l ->
            val now = l.optJSONObject("now") ?: JSONObject()
            Finish.Last(l.optString("date"), l.text("name"), l.text("pace"), l.int("hr"), now.text("pace"), now.int("hr"), l.optString("verdict"), l.optString("text"))
        },
        f.optJSONObject("next")?.let { n -> Finish.Next(n.optString("date"), n.optString("kind"), n.optString("title"), n.optString("rule"), n.optString("why"), n.int("shift_s"), n.optBoolean("applied")) },
    ).takeUnless { it.empty }
}

fun parseNotes(json: String): Pair<List<RunNote>, Int?> {
    val o = JSONObject(json)
    return o.optJSONArray("notes").each { RunNote(it.optString("id"), it.optString("tag"), it.optString("text"), it.text("area")) } to o.int("feeling")
}

/** The words on the web (lib/dom.ts, src/run-notes.ts, src/readiness.ts, src/strength/exercises.ts). */
object Words {
    val FEELING get() = mapOf(1 to str(R.string.workout_poor), 2 to str(R.string.workout_average), 3 to str(R.string.workout_good), 4 to str(R.string.workout_very_good), 5 to str(R.string.workout_excellent))
    val RULE get() = mapOf("faster" to str(R.string.workout_faster), "easier" to str(R.string.workout_easier), "hold" to str(R.string.common_same_again), "on target" to str(R.string.workout_right_on), "slow down" to str(R.string.workout_slow_down))
    val RANK get() = listOf("", str(R.string.workout_best), str(R.string.workout_2nd_best), str(R.string.workout_3rd_best))
    val DISTANCE get() = mapOf("400m" to "400 m", "1k" to str(R.string.workout_1_km), "1 mile" to str(R.string.workout_mile), "5k" to str(R.string.workout_5_km), "10k" to str(R.string.workout_10_km), "15k" to str(R.string.workout_15_km), "Half-Marathon" to str(R.string.workout_half_marathon), "30k" to str(R.string.workout_30_km), "Marathon" to str(R.string.workout_marathon))
    /** Where it niggles, head to toe (lib/areas.ts). */
    val AREAS = listOf("back", "hip", "hamstring", "quad", "knee", "shin", "calf", "achilles", "ankle", "foot", "other")
    private val PAIN get() = mapOf("foot" to str(R.string.workout_area_foot), "ankle" to str(R.string.workout_area_ankle), "achilles" to str(R.string.workout_achilles), "calf" to str(R.string.workout_area_calf), "shin" to str(R.string.workout_area_shin), "knee" to str(R.string.workout_area_knee), "hamstring" to str(R.string.workout_area_hamstring), "quad" to str(R.string.workout_area_thigh), "hip" to str(R.string.workout_area_hip), "back" to str(R.string.workout_area_back))
    fun area(a: String) = if (a == "other") str(R.string.workout_elsewhere) else (PAIN[a] ?: a).replaceFirstChar { it.uppercase() }
    val MUSCLE get() = mapOf(
        "traps" to str(R.string.workout_traps), "delts" to str(R.string.workout_shoulders), "chest" to str(R.string.workout_chest), "biceps" to str(R.string.workout_biceps), "triceps" to str(R.string.workout_triceps), "forearms" to str(R.string.workout_forearms),
        "lats" to str(R.string.workout_lats), "upper_back" to str(R.string.workout_upper_back), "lower_back" to str(R.string.workout_lower_back), "abs" to str(R.string.workout_abs), "obliques" to str(R.string.workout_obliques),
        "hip_flexors" to str(R.string.workout_hip_flexors), "glutes" to str(R.string.workout_glutes), "glute_med" to str(R.string.workout_side_glutes), "adductors" to str(R.string.workout_inner_thighs), "quads" to str(R.string.workout_quads),
        "hamstrings" to str(R.string.workout_hamstrings), "calves" to str(R.string.workout_calves), "tibialis" to str(R.string.workout_shins),
    )
    val SOURCE get() = mapOf("watch" to str(R.string.common_watch), "strava" to "Strava", "phone" to str(R.string.workout_phone), "suunto-cloud" to str(R.string.workout_cloud))
    val SOURCE_LONG get() = mapOf("watch" to str(R.string.common_watch), "strava" to "Strava", "phone" to str(R.string.common_recorded_on_this_phone), "suunto-cloud" to str(R.string.workout_suunto_cloud_export))
    val ORDER = listOf("watch", "strava", "phone", "suunto-cloud")

    /** "Mostly calves, quads and glutes; some shins." */
    fun worked(muscles: List<Worked>): String {
        fun list(xs: List<String>) = if (xs.size < 2) xs.firstOrNull() ?: "" else str(R.string.common_and, xs.dropLast(1).joinToString(str(R.string.common_list_sep)), xs.last())
        val top = muscles.filter { it.share >= 0.5 }.take(4).map { (MUSCLE[it.muscle] ?: it.muscle).lowercase() }
        val rest = muscles.filter { it.share < 0.5 }.take(3).map { (MUSCLE[it.muscle] ?: it.muscle).lowercase() }
        return if (rest.isNotEmpty()) str(R.string.workout_mostly_some, list(top), list(rest)) else str(R.string.workout_mostly, list(top))
    }
}

/** What the workout sheet asks of the app: reads and writes, as the page answers them. */
interface WorkoutApi {
    suspend fun get(path: String): String?
    suspend fun send(path: String, method: String, body: String?): Pair<Int, String>
}

/**
 * One workout's sheet: the workout, then (each when it comes) how the run finished, your notes,
 * its shoes and what it worked. Writes go through the page, so the cache and the coach hear of them.
 */
class WorkoutModel(private val scope: CoroutineScope, private val api: WorkoutApi, val id: String, private val work: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Default) {
    var workout by mutableStateOf<Workout?>(null)
    var failed by mutableStateOf<String?>(null)
    var finish by mutableStateOf<Finish?>(null)
    var notes by mutableStateOf<List<RunNote>>(emptyList())
    var feeling by mutableStateOf<Int?>(null)
    var shoe by mutableStateOf<String?>(null)
    var shoes by mutableStateOf<List<Shoe>>(emptyList())
    var worked by mutableStateOf<List<Worked>>(emptyList())
    /** Which body the map draws (yours, from Settings → Training → sex; the app sets it). */
    var figure by mutableStateOf("m")
    /** Something said after a write, shown once. */
    var said by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    private val enc = java.net.URLEncoder.encode(id, "UTF-8")

    fun load() = scope.launch {
        val w = scope.async { api.get("/api/activity/$enc") }
        val f = scope.async { api.get("/api/activity/$enc/finish") }
        val n = scope.async { api.get("/api/notes?run=$enc") }
        val sh = scope.async { api.get("/api/shoes/run?id=$enc") }
        val b = scope.async { api.get("/api/body/workout?id=$enc") }
        val json = w.await()
        if (json == null) { failed = str(R.string.workout_couldn_t_open_this_workout); return@launch }
        workout = withContext(work) { runCatching { parseWorkout(json) }.getOrNull() } ?: run { failed = str(R.string.workout_couldn_t_read_this_workout); return@launch }
        feeling = workout?.feeling
        f.await()?.let { runCatching { finish = parseFinish(it) } }
        n.await()?.let { runCatching { parseNotes(it) }.getOrNull() }?.let { (list, felt) -> notes = list; felt?.let { feeling = it } }
        sh.await()?.let { runCatching { JSONObject(it) }.getOrNull() }?.let { o ->
            shoes = o.optJSONArray("shoes").each { Shoe(it.optString("id"), it.optString("name"), it.optBoolean("retired")) }
            shoe = o.text("shoe")
        }
        b.await()?.let { runCatching { JSONObject(it).optJSONArray("muscles").each { m -> Worked(m.optString("muscle"), m.optInt("level"), m.optDouble("share")) } }.getOrNull() }?.let { worked = it }
    }

    /** Just the finish (a run on Today, "Just in"). */
    fun loadFinish() = scope.launch { api.get("/api/activity/$enc/finish")?.let { runCatching { finish = parseFinish(it) } } }

    private suspend fun write(path: String, method: String, body: JSONObject?): JSONObject? {
        val (st, text) = api.send(path, method, body?.toString())
        val o = runCatching { JSONObject(text) }.getOrNull()
        val err = o?.text("error")
        if (st !in 200..299 || err != null) { said = str(R.string.common_couldnt_save, err ?: str(R.string.common_didnt_go_through_status, st)); return null }
        return o ?: JSONObject()
    }

    /** Next time's pace change, put on the session (or taken back). */
    fun adjust() {
        val n = finish?.next ?: return
        val shift = n.shiftS ?: return
        busy = true
        scope.launch {
            val ok = write("/api/plan/adjust", "PUT", JSONObject().put("date", n.date).put("kind", n.kind).put("shift_s", shift).put("reason", n.why).put("from", id).put("undo", n.applied))
            if (ok != null) {
                said = if (n.applied) str(R.string.common_is_back_as_planned, n.title) else str(if (shift < 0) R.string.workout_adjusted_faster else R.string.workout_adjusted_easier, n.title, dayName(n.date), dateShort(n.date), kotlin.math.abs(shift))
                api.get("/api/activity/$enc/finish")?.let { runCatching { finish = parseFinish(it) } }
            }
            busy = false
        }
    }

    /** The note being written: kept by itself when you're done with it (no Save). */
    var draft by mutableStateOf("")
    var draftTag by mutableStateOf("note")
    var draftArea by mutableStateOf<String?>(null)
    var saving by mutableStateOf(false)
    val hasDraft get() = draft.isNotBlank() || (draftTag == "niggle" && draftArea != null)

    /** Keep the note being written, if there is one; the form starts fresh after. */
    suspend fun keep() {
        if (saving || !hasDraft) return
        saving = true
        val area = draftArea.takeIf { draftTag == "niggle" }
        if (addNote(draftTag, draft.trim(), area)) { draft = ""; draftArea = null; draftTag = "note" }
        saving = false
    }

    /** The sheet is closing: keep the note on the app's own scope, which outlives the sheet. */
    fun keepDraft() { if (hasDraft) scope.launch { keep() } }

    /** A win, a niggle (and where) or a note. True when kept. */
    suspend fun addNote(tag: String, text: String, area: String?): Boolean {
        val r = write("/api/notes", "POST", JSONObject().put("run", id).put("tag", tag).put("text", text).apply { area?.let { put("area", it) } }) ?: return false
        r.optJSONArray("notes")?.let { a -> notes = a.each { RunNote(it.optString("id"), it.optString("tag"), it.optString("text"), it.text("area")) } }
        said = when (tag) { "niggle" -> str(R.string.workout_noted_readiness_and_your_coach_take); "win" -> str(R.string.workout_noted_nice_one); else -> str(R.string.workout_noted_your_coach_will_see_it) }
        return true
    }

    /** A note just removed: gone from the list at once, deleted after a few seconds unless undone. */
    var removed by mutableStateOf<RunNote?>(null)
    private var removing: kotlinx.coroutines.Job? = null
    fun removeNote(n: RunNote) {
        removing?.let { it.cancel(); removed?.let { r -> scope.launch { api.send("/api/notes/${java.net.URLEncoder.encode(r.id, "UTF-8")}", "DELETE", null) } } }
        notes = notes - n
        removed = n
        removing = scope.launch {
            kotlinx.coroutines.delay(6000)
            removed = null
            api.send("/api/notes/${java.net.URLEncoder.encode(n.id, "UTF-8")}", "DELETE", null)
        }
    }
    fun undoRemove() {
        val n = removed ?: return
        removing?.cancel(); removing = null
        removed = null
        notes = notes + n
    }

    /** Which shoes this run counts to (null: none), on Strava too where it can. */
    fun pickShoe(to: String?) {
        val was = shoe
        shoe = to
        scope.launch {
            val r = write("/api/shoes/run", "PUT", JSONObject().put("run", id).put("shoe", to ?: JSONObject.NULL))
            if (r == null) { shoe = was; return@launch }
            val name = shoes.firstOrNull { it.id == to }?.name
            said = when {
                to == null -> str(R.string.workout_this_run_counts_to_no_shoes)
                r.text("strava") == "set" -> str(R.string.workout_this_run_counts_to_on_strava, name)
                r.text("strava") == "not-linked" -> str(R.string.workout_this_run_counts_to_isn_t, name, name)
                r.text("strava") == "not-allowed" -> str(R.string.workout_this_run_counts_to_to_change, name)
                r.text("strava") == "failed" -> str(R.string.workout_this_run_counts_to_strava_didn, name)
                else -> str(R.string.workout_this_run_counts_to, name)
            }
        }
    }
}
