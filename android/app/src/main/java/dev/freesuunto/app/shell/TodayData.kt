package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

/**
 * What native Today shows, read from the same two routes the web Today reads: GET /api/today
 * (TodayView in web/types.ts) and GET /api/plan (PlanView). Only the fields drawn here.
 */
data class Today(
    val readiness: Readiness,
    val last: Last?,
    val week: Week,
    val session: Session?,
    val takeaways: List<Takeaway>,
    /** Every session today (usually one), and on a rest day the next one. */
    val sessions: List<Session> = listOfNotNull(session),
    val next: Session? = null,
    val race: RaceGoal? = null,
    /** The plan covers today or days ahead (else no session or rest card). */
    val planOn: Boolean = false,
    /** There is a plan, but its last day has gone: Today offers the next one. */
    val planEnded: Boolean = false,
    /** The demo's sample data (src/sample.ts): Today says so, with the way out. */
    val sample: Boolean = false,
    /** Tartan's T in the header (src/today-mark.ts), when the engine sends it. */
    val mark: Mark? = null,
)

/** The T's state (rest, session, best, tired, race) and its line for screen readers. */
data class Mark(val state: String, val label: String)

/**
 * Your race (targets.race: your target's, else the plan's next race): when, the target, and how the
 * prediction compares. `json`: as the page has it, for race week. `countdown`: from twelve weeks out
 * (src/race-countdown.ts).
 */
data class RaceGoal(
    val name: String, val km: Double, val date: String?, val targetS: Int?, val daysToGo: Int?, val predictedS: Int?, val onTrack: Boolean?, val json: String,
    val countdown: Countdown? = null,
) {
    /** How the prediction moved over four weeks (minus: quicker), against the target (minus: quicker), and the taper. */
    data class Countdown(val daysToGo: Int, val changeS: Int?, val gapS: Int?, val taper: Boolean)
}

data class Readiness(val state: String, val title: String, val advice: String, val why: String, val fitness: Double, val fatigue: Double, val form: Double)

data class Last(
    val id: String, val name: String, val sport: String, val start: String, val km: Double?, val minutes: Double?, val pace: String?, val hr: Int?, val label: String,
    val effort: Double = 0.0, val rank: String? = null, val estimated: Boolean = false, val feeling: Int? = null,
    /** Seconds in each heart-rate zone, Z1 to Z5, and the top of Z2 (easy). */
    val zones: List<Double> = emptyList(), val easyCap: Int? = null,
    /** A real run in the last day and a half: it leads Today as "Just in". */
    val justIn: Boolean = false,
) {
    /** A recording started by accident: no effort or heart rate to read into. */
    val trivial get() = (km ?: 0.0) < 0.5 && (minutes ?: 0.0) < 5
}

data class Day(val date: String, val km: Double, val future: Boolean)

data class Week(
    val days: List<Day>,
    val km: Double,
    /** What the week is measured against: the plan's distance, else your target, else your usual week. */
    val goalKm: Double,
    val goalSays: String?,
    val workouts: Int,
    val planDone: Int,
    val planSessions: Int,
    val minutes: Double = 0.0,
    val climb: Double = 0.0,
    /** "of 4" (your target) or "of ~4" (your usual). */
    val workoutsOf: String = "",
    /** "Long run: 21.5 of 16 km in the last 2 weeks". */
    val longRun: String? = null,
    /** About how much a day the target still needs ("about 4.8 km a day"), when it's your own target. */
    val perDay: String? = null,
)

data class Session(
    val date: String, val kind: String, val title: String, val detail: String, val status: String,
    val activityId: String? = null, val did: String? = null, val manual: Boolean = false, val notes: String? = null,
    /** Which shoes, when you have more than one pair in use: name and why. */
    val shoe: Pair<String, String>? = null,
)

data class Takeaway(val tone: String, val title: String, val detail: String, val activity: String? = null, val id: String = "", val date: String? = null) {
    /** A new personal best (engine id "pb-…"). */
    val best get() = id.startsWith("pb-")
}

/** A lane of the sync board: watch or strava; busy, fail, on or ok; "5m", "on", "···". */
data class Lane(val id: String, val state: String, val text: String, val glyph: String, val name: String = "", val status: String = "", val failed: Boolean = false)

private fun JSONObject.str(k: String) = if (has(k) && !isNull(k)) optString(k) else null
private fun JSONObject.num(k: String) = if (has(k) && !isNull(k)) optDouble(k) else null
private inline fun <T> JSONArray?.map(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).map { f(getJSONObject(it)) }

private fun one(x: Double) = if (x == Math.rint(x)) x.toInt().toString() else String.format("%.1f", x)

fun parseToday(todayJson: String, planJson: String?, today: LocalDate = LocalDate.now(), now: java.time.Instant = java.time.Instant.now()): Today {
    val t = JSONObject(todayJson)
    val r = t.getJSONObject("readiness")
    val readiness = Readiness(
        r.optString("state"), r.optString("title"), r.optString("advice"), r.optString("why"),
        r.optDouble("fitness", 0.0), r.optDouble("fatigue", 0.0), r.optDouble("form", 0.0),
    )
    val last = t.optJSONObject("last")?.let { l ->
        val a = l.getJSONObject("activity")
        val zones = l.optJSONArray("zones").map { it }
        val started = runCatching { java.time.Instant.parse(a.optString("start")) }.getOrNull()
        val fresh = Regex("run", RegexOption.IGNORE_CASE).containsMatchIn(a.optString("sport")) && started != null &&
            java.time.Duration.between(started, now).toHours() < 36 && ((a.num("distance_km") ?: 0.0) >= 0.5 || (a.num("moving_min") ?: 0.0) >= 5)
        Last(
            a.optString("id"), a.str("name") ?: a.optString("sport"), a.optString("sport"), a.str("start_local") ?: a.optString("start"),
            a.num("distance_km"), a.num("moving_min"), a.str("avg_pace_min_km"), a.num("avg_hr")?.toInt(), l.optString("label"),
            l.optDouble("effort", 0.0), l.str("rank"), l.optBoolean("estimated"), a.num("feeling")?.toInt(),
            zones.map { it.optDouble("seconds", 0.0) }, zones.getOrNull(1)?.optJSONArray("bpm")?.optInt(1), fresh,
        )
    }
    val plan = planJson?.let { runCatching { JSONObject(it) }.getOrNull() }
    val planWeek = plan?.optJSONArray("weeks").map { it }.firstOrNull { it.optString("when") == "current" }
    val w = t.getJSONObject("week")
    val km = w.optDouble("km", 0.0)
    val planKm = planWeek?.let { pw -> pw.optJSONObject("planned")?.num("km")?.takeIf { it > 0 } ?: pw.num("target_km") } ?: 0.0
    val targetKm = t.optJSONObject("targets")?.optJSONObject("week")?.num("target_km") ?: 0.0
    val usual = w.optDouble("usual_km", 0.0)
    val (goal, says) = when {
        planKm > 0 -> planKm to str(R.string.today_plan_km, one(planKm))
        targetKm > 0 -> targetKm to str(R.string.common_target_km, one(targetKm))
        usual > 0 -> usual to str(R.string.today_usual_week_km, one(usual))
        else -> 0.0 to null
    }
    val tw = t.optJSONObject("targets")?.optJSONObject("week")
    val lr = t.optJSONObject("targets")?.optJSONObject("long_run")
    val week = Week(
        w.optJSONArray("days").map { Day(it.optString("date"), it.optDouble("km", 0.0), it.optBoolean("future")) },
        km, goal, says, w.optInt("workouts"),
        planWeek?.optJSONObject("done")?.optInt("sessions") ?: 0,
        planWeek?.optJSONObject("planned")?.optInt("sessions") ?: 0,
        w.optDouble("minutes", 0.0), w.optDouble("climb", 0.0),
        tw?.num("target_workouts")?.let { str(R.string.today_of, it.toInt()) } ?: w.num("usual_workouts")?.takeIf { it > 0 }?.let { str(R.string.today_of_2, Math.round(it)) } ?: "",
        lr?.let { str(R.string.today_long_run_of, one(it.optDouble("longest_km")), one(it.optDouble("target_km"))) },
        if (planKm <= 0 && targetKm > 0 && km < targetKm) tw?.let { if (it.optInt("days_left") > 0) str(R.string.today_km_a_day, one(it.optDouble("km_per_day_needed"))) else str(R.string.today_today_lower) } else null,
    )
    val iso = today.toString()
    val picks = plan?.optJSONObject("shoe_picks")
    fun session(date: String, s: JSONObject): Session {
        val bits = listOfNotNull(
            s.num("duration_min")?.let { duration(it) },
            s.num("distance_km")?.let { str(R.string.common_n_km, one(it)) },
            s.str("target")?.let { tidyTarget(it, s.optString("kind")) },
        )
        val a = s.optJSONObject("activity")
        val did = a?.let { listOfNotNull(it.num("distance_km")?.let { k -> str(R.string.common_n_km, one(k)) }, it.num("moving_min")?.let { m -> duration(m) }).joinToString(" · ").ifEmpty { it.str("name") ?: it.optString("sport") } }
        val shoe = picks?.optJSONObject("$date:${s.optString("kind")}")?.let { it.optString("name") to it.optString("why") }
        return Session(date, s.optString("kind"), s.optString("title"), bits.joinToString(" · "), s.optString("status"), a?.str("id"), did?.let { str(R.string.common_did, it) }, s.optBoolean("manual"), s.str("notes"), shoe)
    }
    val days = plan?.optJSONArray("weeks").map { it }.flatMap { wk -> wk.optJSONArray("days").map { it } }
    val sessions = days.firstOrNull { it.optString("date") == iso }?.optJSONArray("sessions").map { it }.filter { it.optString("kind") != "rest" }.map { session(iso, it) }
    val next = days.filter { it.optString("date") > iso }.firstNotNullOfOrNull { d -> d.optJSONArray("sessions").map { it }.firstOrNull { it.optString("kind") != "rest" }?.let { session(d.optString("date"), it) } }
    val planOn = plan?.optJSONObject("plan") != null && (planWeek != null || next != null)
    val race = t.optJSONObject("targets")?.optJSONObject("race")?.let { r ->
        val c = r.optJSONObject("countdown")?.let { c -> RaceGoal.Countdown(c.optInt("days_to_go"), if (c.has("change_s")) c.optInt("change_s") else null, if (c.has("gap_s")) c.optInt("gap_s") else null, c.has("taper")) }
        RaceGoal(r.str("name") ?: str(R.string.common_km_race, one(r.optDouble("distance_km"))), r.optDouble("distance_km"), r.str("date"), r.num("target_s")?.toInt(), r.num("days_to_go")?.toInt(), r.num("predicted_s")?.toInt(), if (r.has("on_track") && !r.isNull("on_track")) r.optBoolean("on_track") else null, r.toString(), c)
    }
    val takeaways = t.optJSONArray("takeaways").map { Takeaway(it.optString("tone"), it.optString("title"), it.optString("detail"), it.str("activity"), it.optString("id"), it.str("date")) }
    val planEnded = plan?.optJSONObject("plan") != null && !planOn
    val mark = t.optJSONObject("mark")?.let { m -> m.str("state")?.let { Mark(it, m.optString("label")) } }
    return Today(readiness, last, week, sessions.firstOrNull(), takeaways, sessions, if (sessions.isEmpty()) next else null, race, planOn, planEnded, t.optBoolean("sample"), mark)
}
