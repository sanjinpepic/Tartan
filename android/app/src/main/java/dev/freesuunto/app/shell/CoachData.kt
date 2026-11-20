package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * What native Coach shows, from the routes the web Coach tab reads: GET /api/plan (PlanView in
 * web/types.ts), /api/coach/status and /api/plan/weekly. Only what's drawn.
 */
data class Coach(
    val plan: PlanInfo?,
    val weeks: List<PWeek>,
    val today: String,
    val goal: String?,
    val proposal: Proposal?,
    val lastChange: LastChange?,
    val weekly: Weekly?,
    /** The coach can talk (a key, or Model Hub ready): the ask bar; else its setup. */
    val ready: Boolean,
    /** No plan yet: what the intake asks, and what the coach already knows. */
    val intake: Intake? = null,
    /** Said you're ill (since this date): Better now leads the life changes. */
    val ill: String? = null,
)

/** The first plan's questions (web/views/plan.ts intakeCard): the answers so far, the last four weeks, the race. */
data class Intake(
    val days: Int?, val hours: Int?, val longDay: String?, val notes: String,
    val runs: Int, val kmWeek: Double, val longest: Double, val workouts: Int, val hoursWeek: Double,
    val raceName: String?, val raceKm: Double?, val raceDate: String?, val hasTargets: Boolean,
)

data class PlanInfo(val title: String, val summary: String, val advice: List<String>, val zones: List<Zone>, val updated: String, val conversation: String?)

data class Zone(val name: String, val line: String, val use: String?)

data class Change(val type: String, val headline: String, val detail: String, val why: String?)

data class Proposal(val at: String, val base: String, val changes: List<Change>, val note: String?, val from: String, val conversation: String?)

data class LastChange(val at: String, val changes: List<Change>, val auto: Boolean)

data class Weekly(val week: String, val at: String, val text: String, val changed: Boolean, val proposed: Int, val conversation: String?)

data class PSession(val date: String, val kind: String, val title: String, val line: String, val status: String, val manual: Boolean)

data class Extra(val id: String, val label: String)

data class PDay(val date: String, val sessions: List<PSession>, val extras: List<Extra>)

data class PWeek(
    val start: String,
    val focus: String,
    val days: List<PDay>,
    val km: Double,
    val minutes: Double,
    val planned: Int,
    val done: Int,
    val doneKm: Double,
    val doneMinutes: Double,
    /** past, current or future. */
    val time: String,
) {
    val race get() = days.any { d -> d.sessions.any { it.kind == "race" } }
}

private fun JSONObject.str(k: String) = if (has(k) && !isNull(k)) optString(k).ifEmpty { null } else null
private fun JSONObject.num(k: String) = if (has(k) && !isNull(k)) optDouble(k).takeUnless { it.isNaN() } else null
private fun <T> JSONArray?.each(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it)?.let(f) }
private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }

val KIND_LABEL get() = mapOf(
    "easy" to str(R.string.coach_easy), "long" to str(R.string.coach_long), "tempo" to str(R.string.coach_tempo), "intervals" to str(R.string.coach_intervals), "hills" to str(R.string.coach_hills),
    "recovery" to str(R.string.coach_recovery), "race" to str(R.string.common_race), "strength" to str(R.string.common_strength), "cross" to str(R.string.coach_cross_training), "rest" to str(R.string.common_rest),
)

/**
 * The session's kind as a word, unless its name already says it ("Easy run" isn't followed by
 * "Easy"): null then.
 */
fun kindWord(kind: String, title: String): String? = (KIND_LABEL[kind] ?: kind.takeIf { it.isNotEmpty() })?.takeUnless { title.contains(it, ignoreCase = true) }

/**
 * A target as read: ranges with a proper dash ("103–119 bpm", "6:28–7:09 /km"), and without a
 * leading kind word the line already says ("easy, 103–119 bpm" on an easy run: "103–119 bpm").
 */
fun tidyTarget(target: String, kind: String? = null): String {
    val ranged = target.replace(Regex("""(\d)\s?-\s?(\d)"""), "$1–$2")
    val word = kind?.let { KIND_LABEL[it] }
    return if (word != null && ranged.startsWith("$word, ", ignoreCase = true)) ranged.substring(word.length + 2) else ranged
}

/** Minutes as the web writes them (fmtDuration): "45 min", "1 h 05". */
fun duration(min: Double): String {
    val m = Math.round(min).toInt()
    return if (m < 60) str(R.string.common_min, m) else "${m / 60} h ${(m % 60).toString().padStart(2, '0')}"
}

fun km(x: Double, digits: Int = if (x < 10) 1 else 0): String = String.format(Locale.getDefault(), "%.${digits}f", x)

private val SHORT = DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())
fun dateShort(iso: String): String = runCatching { LocalDate.parse(iso.take(10)).format(SHORT) }.getOrDefault(iso)
fun dayName(iso: String): String = runCatching { LocalDate.parse(iso.take(10)).dayOfWeek.getDisplayName(java.time.format.TextStyle.SHORT, Locale.getDefault()) }.getOrDefault("")
fun range(start: String): String = runCatching { "${dateShort(start)} – ${dateShort(LocalDate.parse(start).plusDays(6).toString())}" }.getOrDefault(start)

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
fun ago(iso: String, now: Instant = Instant.now()): String {
    val at = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
    val m = Duration.between(at, now).toMinutes()
    return when {
        m < 1 -> str(R.string.coach_just_now)
        m < 60 -> plural(R.plurals.coach_minutes_ago, m.toInt(), m.toInt())
        m < 60 * 24 -> plural(R.plurals.coach_hours_ago, (m / 60).toInt(), (m / 60).toInt())
        else -> plural(R.plurals.coach_days_ago, (m / 1440).toInt(), (m / 1440).toInt())
    }
}

private val CHANGE_WORD get() = mapOf("added" to str(R.string.common_new), "removed" to str(R.string.coach_out), "moved" to str(R.string.coach_moved), "changed" to str(R.string.coach_changed), "zones" to str(R.string.coach_zones), "length" to str(R.string.coach_length))
val FROM get() = mapOf("chat" to str(R.string.coach_from_your_conversation), "update" to str(R.string.coach_your_new_plan), "weekly" to str(R.string.coach_from_the_weekly_review), "agent" to str(R.string.coach_from_an_outside_agent), "life" to str(R.string.coach_from_what_you_told_tartan))

private fun change(c: JSONObject): Change {
    val type = c.optString("type")
    val whenText = c.str("date")?.let { "${dayName(it)} ${dateShort(it)}" }
    val title = c.str("title")?.let { listOfNotNull(whenText, it).joinToString(" · ") }
    return Change(type, listOfNotNull(CHANGE_WORD[type] ?: type, title).joinToString(": "), c.optString("detail"), c.str("why"))
}

private fun session(date: String, s: JSONObject): PSession {
    val a = s.optJSONObject("activity")
    val line = if (a != null) {
        str(R.string.coach_did) + (listOfNotNull(a.num("distance_km")?.let { str(R.string.common_n_km, km(it, 1)) }, a.num("moving_min")?.let { duration(it) }).joinToString(" · ").ifEmpty { a.str("name") ?: a.optString("sport") })
    } else {
        listOfNotNull(kindWord(s.optString("kind"), s.optString("title")), s.num("duration_min")?.let { duration(it) }, s.num("distance_km")?.let { str(R.string.common_n_km, km(it)) }).joinToString(" · ")
    }
    return PSession(date, s.optString("kind"), s.optString("title"), line, s.optString("status"), s.optBoolean("manual"))
}

fun parseCoach(planJson: String, statusJson: String?, weeklyJson: String?): Coach {
    val v = JSONObject(planJson)
    val p = v.optJSONObject("plan")
    val plan = p?.let {
        PlanInfo(
            it.optString("title"), it.optString("summary"), it.optJSONArray("advice").strings(),
            it.optJSONArray("zones").each { z -> Zone(z.optString("name"), listOfNotNull(z.str("pace"), z.str("heart_rate")).joinToString(" · ").ifEmpty { "–" }, z.str("use")) },
            it.optString("updated"), it.str("conversation"),
        )
    }
    val weeks = v.optJSONArray("weeks").each { w ->
        val planned = w.optJSONObject("planned") ?: JSONObject()
        val done = w.optJSONObject("done") ?: JSONObject()
        PWeek(
            w.optString("start"), w.optString("focus"),
            w.optJSONArray("days").each { d ->
                val date = d.optString("date")
                PDay(date, d.optJSONArray("sessions").each { session(date, it) }.filter { it.kind != "rest" }, d.optJSONArray("extra").each { a ->
                    Extra(a.optString("id"), (a.str("name") ?: a.optString("sport")).let { n -> a.num("distance_km")?.let { str(R.string.coach_extra_km, n, km(it, 1)) } ?: str(R.string.coach_extra, n) })
                })
            },
            planned.num("km")?.takeIf { it > 0 } ?: w.num("target_km") ?: 0.0,
            planned.num("minutes")?.takeIf { it > 0 } ?: (w.num("target_hours")?.times(60) ?: 0.0),
            planned.optInt("sessions"), done.optInt("sessions"), done.optDouble("km", 0.0), done.optDouble("minutes", 0.0),
            w.optString("when"),
        )
    }
    val race = v.optJSONObject("goals")?.optJSONObject("race")
    val target = p?.str("target_date")
    val goal = when {
        race?.str("date") != null && race.str("date") == target -> str(R.string.coach_race_on, race.str("name") ?: str(R.string.common_km_race, km(race.optDouble("distance_km"), 1)), dateShort(target!!))
        target != null -> str(R.string.coach_building_to, dateShort(target))
        else -> null
    }
    val proposal = v.optJSONObject("proposal")?.let {
        Proposal(it.optString("at"), it.optString("base"), it.optJSONArray("changes").each(::change), it.str("note"), FROM[it.optString("source")] ?: str(R.string.coach_from_your_coach), it.str("conversation"))
    }
    val last = v.optJSONObject("last_change")?.let { LastChange(it.optString("at"), it.optJSONArray("changes").each(::change), it.optBoolean("auto")) }
    val weekly = weeklyJson?.let { runCatching { JSONObject(it) }.getOrNull() }?.let {
        Weekly(it.optString("week"), it.optString("at"), it.optString("text"), it.optBoolean("changed"), it.optInt("proposed"), it.str("conversation"))
    }?.takeIf { it.text.isNotBlank() }
    val ready = statusJson?.let { runCatching { JSONObject(it).optBoolean("ready", true) }.getOrNull() } ?: true
    val intake = if (plan != null) null else {
        val a = v.optJSONObject("availability") ?: JSONObject()
        val rc = v.optJSONObject("recent") ?: JSONObject()
        val today = v.optString("today")
        val upcoming = race?.str("date")?.takeIf { it >= today }
        Intake(
            a.optInt("days_per_week").takeIf { it > 0 }, a.optInt("hours_per_week").takeIf { it > 0 }, a.str("long_run_day"), a.str("notes") ?: "",
            rc.optInt("runs"), rc.optDouble("run_km_per_week", 0.0), rc.optDouble("longest_run_km", 0.0), rc.optInt("workouts"), rc.optDouble("hours_per_week", 0.0),
            upcoming?.let { race.str("name") }, upcoming?.let { race.num("distance_km") }, upcoming,
            race != null || v.optJSONObject("goals")?.num("weekly_km") != null,
        )
    }
    val ill = v.optJSONObject("life")?.optJSONObject("ill")?.str("from")
    return Coach(plan, weeks, v.optString("today"), goal, proposal, last, weekly, ready, intake, ill)
}
