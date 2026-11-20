package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

/**
 * What native Progress shows, from the routes the web's Progress reads: GET /api/dashboard?days=,
 * /api/race-shape, /api/days, /api/durability (a range) and /api/week with /api/plan (the Week).
 */
data class Totals(val label: String, val km: Double, val workouts: Int, val hours: Double, val climb: Double)

data class WeekBar(val week: String, val km: Double, val workouts: Int)

data class Point(val date: String, val value: Double)

data class ZoneShare(val zone: Int, val name: String, val seconds: Double)

data class Best(val name: String, val seconds: Int, val pace: String?, val date: String, val activity: String)

data class Race(val name: String, val km: Double, val date: String?, val daysToGo: Int?, val predicted: Int?, val target: Int?, val targetPace: String?, val fromText: String?)

data class Dash(
    val days: Int,
    val totals: List<Totals>,
    val weeks: List<WeekBar>,
    val targetKm: Double?,
    val weekHit: Pair<Int, Int>?,
    val fitness: List<Point>,
    val estimatedShare: Double,
    val zones: List<ZoneShare>,
    val zoneWorkouts: Int,
    val efficiency: List<Point>,
    val bests: List<Best>,
    val changing: List<Takeaway>,
    val race: Race?,
)

data class ShapeLine(val name: String, val metres: Double, val weeks: List<Pair<String, Double?>>, val from: String?)

data class DayLoad(val date: String, val load: Double, val n: Int, val runKm: Double, val id: String?, val name: String?)

data class LongRun(val date: String, val text: String, val drift: Double, val steady: Boolean, val held: String)

data class Durab(val summary: String, val runs: List<LongRun>)

data class WeekDay(val date: String, val km: Double, val minutes: Double, val workouts: Int, val load: Double, val future: Boolean)

data class WeekV(
    val start: String,
    val end: String,
    val current: Boolean,
    val prev: String?,
    val next: String?,
    val km: Double,
    val minutes: Double,
    val workouts: Int,
    val climb: Double,
    val load: Double,
    val before: Triple<Double, Double, Double>,
    val usualLoad: Double,
    val days: List<WeekDay>,
    val acts: List<Act>,
    val zones: List<ZoneShare>,
    val sports: List<Triple<String, Double, Double>>,
    /** The plan's week, when there is one: done of planned, the focus, km. */
    val plan: String?,
)

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }
private fun JSONObject.dbl(k: String): Double? = if (!has(k) || isNull(k)) null else optDouble(k).takeUnless { it.isNaN() }
private fun <T> JSONArray?.each(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it)?.let(f) }

/** Seconds as a race clock: "25:30", "1:52:10". */
fun clock(s: Int): String {
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}" else "$m:${sec.toString().padStart(2, '0')}"
}

val RANGE_LABEL get() = mapOf(7 to str(R.string.progress_week), 84 to str(R.string.progress_12_weeks), 182 to str(R.string.progress_6_months), 365 to str(R.string.progress_1_year))

fun parseDash(json: String): Dash {
    val d = JSONObject(json)
    val days = d.optInt("days")
    val weeks = d.optJSONArray("weeks").each { WeekBar(it.optString("week"), it.dbl("distance_km") ?: 0.0, it.optInt("activities")) }
    val t = d.optJSONObject("totals") ?: JSONObject()
    fun tot(label: String, o: JSONObject?) = Totals(label, o?.dbl("distance_km") ?: 0.0, o?.optInt("activities") ?: 0, o?.dbl("hours") ?: 0.0, o?.dbl("elevation_m") ?: 0.0)
    val inRange = Totals(
        RANGE_LABEL[days] ?: str(R.string.progress_days, days),
        weeks.sumOf { it.km }, weeks.sumOf { it.workouts },
        d.optJSONArray("weeks").each { it.dbl("moving_hours") ?: 0.0 }.sum(),
        d.optJSONArray("weeks").each { it.dbl("elevation_m") ?: 0.0 }.sum(),
    )
    val targets = d.optJSONObject("targets")
    val race = targets?.optJSONObject("race")?.let { r ->
        val from = r.optJSONObject("from")
        Race(
            r.text("name") ?: str(R.string.common_km_race, km(r.optDouble("distance_km"), 1)), r.optDouble("distance_km"), r.text("date"),
            if (r.has("days_to_go")) r.optInt("days_to_go") else null, r.dbl("predicted_s")?.toInt(), r.dbl("target_s")?.toInt(), r.text("target_pace"),
            from?.let { str(R.string.progress_best_this_year, it.optString("name"), clock(it.optInt("time_s")), dateShort(it.optString("date"))) },
        )
    }
    return Dash(
        days,
        listOf(inRange, tot(str(R.string.progress_this_month), t.optJSONObject("month")), tot(str(R.string.progress_this_year), t.optJSONObject("year"))),
        weeks.reversed(),
        targets?.optJSONObject("goals")?.dbl("weekly_km"),
        targets?.optJSONObject("week")?.let { it.optInt("hit") to it.optInt("of_weeks") },
        d.optJSONObject("load")?.optJSONArray("series").each { Point(it.optString("date"), it.optDouble("fitness")) },
        d.optJSONObject("load")?.optDouble("estimated_share", 0.0) ?: 0.0,
        d.optJSONObject("zones")?.optJSONArray("zones").each { ZoneShare(it.optInt("zone"), it.optString("name"), it.optDouble("seconds")) },
        d.optJSONObject("zones")?.optInt("activities") ?: 0,
        d.optJSONArray("efficiency").each { Point(it.optString("week"), it.optDouble("m_per_beat")) },
        d.optJSONArray("bests").each { Best(it.optString("name"), it.optInt("time_s"), it.text("pace_min_km"), it.optString("date"), it.optString("activity")) }.let { b ->
            val order = listOf("400m", "1/2 mile", "1k", "1 mile", "2 mile", "5k", "10k", "15k", "10 mile", "20k", "Half-Marathon", "30k", "Marathon")
            b.sortedBy { order.indexOf(it.name).let { i -> if (i < 0) 99 else i } }
        },
        d.optJSONArray("takeaways").each { Takeaway(it.optString("tone"), it.optString("title"), it.optString("detail")) to it.optString("horizon") }.filter { it.second == "trend" }.map { it.first },
        race,
    )
}

fun parseShape(json: String): List<ShapeLine> = JSONObject(json).optJSONArray("distances").each { d ->
    val weeks = d.optJSONArray("weeks").each { w -> w.optString("week") to w.dbl("s") }
    val lastFrom = d.optJSONArray("weeks").each { it.text("from") }.lastOrNull { it != null }
    ShapeLine(d.optString("name"), d.optDouble("metres"), weeks, lastFrom)
}.filter { l -> l.weeks.count { it.second != null } >= 2 }

fun parseDays(json: String): List<DayLoad> = JSONArray(json).each { DayLoad(it.optString("date"), it.optDouble("load"), it.optInt("n"), it.optDouble("run_km"), it.text("id"), it.text("name")) }

fun parseDurability(json: String): Durab {
    val d = JSONObject(json)
    return Durab(d.optString("summary"), d.optJSONArray("runs").each {
        val mins = it.optInt("minutes")
        LongRun(
            it.optString("date"),
            (it.dbl("km")?.let { k -> str(R.string.progress_long_km, mins, km(k, 1)) } ?: str(R.string.common_min, mins)) + (if (it.optBoolean("steady")) "" else str(R.string.progress_not_steady)),
            it.optDouble("drift_pct"), it.optBoolean("steady"),
            if (it.isNull("holds_until_min") || !it.has("holds_until_min")) str(R.string.progress_held_to_the_end) else str(R.string.progress_slipped_from, it.optInt("holds_until_min")),
        )
    })
}

fun parseWeek(json: String, planJson: String?): WeekV {
    val w = JSONObject(json)
    val t = w.optJSONObject("totals") ?: JSONObject()
    val p = w.optJSONObject("previous") ?: JSONObject()
    val days = w.optJSONArray("days")
    val acts = (0 until (days?.length() ?: 0)).flatMap { i -> days!!.optJSONObject(i)?.optJSONArray("activities")?.let { parseActivities(it.toString()) } ?: emptyList() }
    val start = w.optString("start")
    val plan = planJson?.let { runCatching { JSONObject(it) }.getOrNull() }?.optJSONArray("weeks").each { it }.firstOrNull { it.optString("start") == start }?.let { pw ->
        val planned = pw.optJSONObject("planned") ?: JSONObject()
        val done = pw.optJSONObject("done") ?: JSONObject()
        val pkm = planned.optDouble("km", 0.0)
        str(R.string.progress_plan_sessions_done, done.optInt("sessions"), planned.optInt("sessions")) + listOfNotNull(pw.text("focus"), if (pkm > 0) str(R.string.progress_km_of_km, km(done.optDouble("km", 0.0), 1), km(pkm, 0)) else null).joinToString(" · ").let { if (it.isEmpty()) "" else "\n$it" }
    }
    return WeekV(
        start, w.optString("end"), w.optBoolean("current"), w.text("prev"), w.text("next"),
        t.optDouble("km", 0.0), t.optDouble("minutes", 0.0), t.optInt("workouts"), t.optDouble("climb", 0.0), t.optDouble("load", 0.0),
        Triple(p.optDouble("km", 0.0), p.optDouble("minutes", 0.0), p.optDouble("load", 0.0)),
        w.optJSONObject("usual")?.optDouble("load", 0.0) ?: 0.0,
        days.each { WeekDay(it.optString("date"), it.optDouble("km", 0.0), it.optDouble("minutes", 0.0), it.optInt("workouts"), it.optDouble("load", 0.0), it.optBoolean("future")) },
        acts,
        w.optJSONArray("zones").each { ZoneShare(it.optInt("zone"), it.optString("name"), it.optDouble("seconds")) },
        w.optJSONArray("sports").each { Triple(it.optString("sport"), it.optDouble("km", 0.0), it.optDouble("minutes", 0.0)) },
        plan,
    )
}

/** What Progress has read, by range; the Week by its start. Read again only after a write (or a new day). */
class ProgressModel(private val scope: CoroutineScope, private val get: suspend (String) -> String?) {
    var range by mutableStateOf(84)
    /** The week the Week range shows: null, this week. */
    var weekOf by mutableStateOf<String?>(null)
    val dash = mutableStateMapOf<Int, Dash>()
    val shape = mutableStateMapOf<Int, List<ShapeLine>>()
    val dayLoads = mutableStateMapOf<Int, List<DayLoad>>()
    val durability = mutableStateMapOf<Int, Durab>()
    val weeks = mutableStateMapOf<String, WeekV>()
    private var readOn: String? = null

    fun forget() {
        dash.clear(); shape.clear(); dayLoads.clear(); durability.clear(); weeks.clear()
    }

    /** What the range (or the week) shows, read if it isn't yet. */
    fun ensure() {
        val today = LocalDate.now().toString()
        if (readOn != today) { forget(); readOn = today }
        if (range == 7) {
            val key = weekOf ?: ""
            if (key !in weeks) scope.launch {
                val w = scope.async { get("/api/week${weekOf?.let { "?start=$it" } ?: ""}") }
                val p = scope.async { get("/api/plan") }
                w.await()?.let { runCatching { parseWeek(it, p.await()) }.getOrNull() }?.let { weeks[key] = it }
            }
            return
        }
        val r = range
        if (r in dash) return
        val n = (r / 7).coerceIn(8, 52)
        val gridWeeks = (r / 7).coerceIn(12, 53)
        scope.launch {
            val d = scope.async { get("/api/dashboard?days=$r") }
            val s = scope.async { get("/api/race-shape?weeks=$n") }
            val g = scope.async { get("/api/days?days=${gridWeeks * 7}") }
            val u = scope.async { get("/api/durability?weeks=${maxOf(8, r / 7)}") }
            d.await()?.let { runCatching { parseDash(it) }.getOrNull() }?.let { dash[r] = it }
            s.await()?.let { runCatching { parseShape(it) }.getOrNull() }?.let { shape[r] = it }
            g.await()?.let { runCatching { parseDays(it) }.getOrNull() }?.let { dayLoads[r] = it }
            u.await()?.let { runCatching { parseDurability(it) }.getOrNull() }?.let { durability[r] = it }
        }
    }
}
