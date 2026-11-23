package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** The morning check (GET/PUT /api/readiness): what you said, and the verdict. */
data class Check(
    val date: String,
    val sleep: Int?, val legs: Int?, val pain: Pair<String, Int>?,
    val answered: Boolean,
    /** The watch measured last night: sleep isn't asked. */
    val measured: Boolean,
    val level: String, val reasons: List<String>,
    val sessionTitle: String?, val sessionKind: String?, val sessionDone: Boolean,
    val swappedFrom: String?, val swapKind: String?, val suggestSwap: Boolean,
    /** Today's change (src/day-swap.ts): suggested in the session card with its reason, or taken (with Undo). */
    val swap: DaySwap? = null,
    /** The ways to change today's session when you ask (Different plan today?). */
    val choices: DayChoices? = null,
    /** Last night as the body signals have it (src/signals.ts), when tracked or estimated. */
    val night: Night? = null,
) {
    /** "Ready for today." / "Go easy today." / "Rest or go very easy today." */
    val verdict get() = when (level) { "ready" -> str(R.string.today_ready_for_today); "rest" -> str(R.string.today_rest_or_go_very_easy_today); else -> str(R.string.today_go_easy_today) }
    val why get() = reasons.joinToString(", ").replaceFirstChar { it.uppercase() }.let { if (it.isEmpty()) "" else "$it." }
    /** Every question asked is answered: legs, and sleep when the watch didn't measure the night. */
    val complete get() = legs != null && (measured || sleep != null)
}

/** One way to change today's run: `to` swim, ride, treadmill, short, move, nudge or run (anyway); a swim's, ride's or short run's minutes; the day it moves to. */
data class DayChoice(val to: String, val minutes: Int?, val day: String?)

/**
 * Today's change: `taken` (with Undo) or suggested; the planned session (date, kind, title); what
 * the day is like then ("Icy at 07:00") and why that matters to you; the choices in your order.
 */
data class DaySwap(val taken: Boolean, val date: String, val kind: String, val title: String, val why: String?, val reason: String?, val choices: List<DayChoice>)

/** Different plan today?: the choices in your order, what's learned in a line, and the stance's line (lead with the run, or ease off). */
data class DayChoices(val date: String, val kind: String, val title: String, val choices: List<DayChoice>, val reason: String?, val lead: String, val line: String?)

private fun choicesOf(a: JSONArray?): List<DayChoice> = a.each { DayChoice(it.optString("to"), it.dbl("minutes")?.toInt(), it.text("day")) }

/**
 * Last night from the body signals (src/signals.ts): minutes asleep; the stages and time awake when
 * the night was tracked in stages; the source's score; and who measured it, in words.
 */
data class Night(val asleep: Double, val deep: Double?, val light: Double?, val rem: Double?, val awake: Double?, val score: Int?, val from: String?) {
    /** Tracked in stages: the bar can be drawn. */
    val staged get() = deep != null && light != null && rem != null && (deep + light + rem) > 0
}

/**
 * This morning's body from the body signals (src/signals.ts), whichever watch or app measured it:
 * resting heart rate against your usual, last night, energy on waking against the usual, HRV and
 * the night's highest oxygen. Only what was measured; `from`: who measured most of it, in words.
 */
data class Vitals(
    val rest: Int?, val restDiff: Int?, val sleepMin: Double?, val oxygen: Double?,
    val energy: Int? = null, val energyDiff: Int? = null, val hrv: Int? = null, val night: Night? = null, val from: String? = null,
)

/** A body-signal source in words (src/signals.ts SOURCE_NAME). */
fun sourceName(s: String?): String? = when (s) {
    "garmin" -> str(R.string.signals_from_garmin)
    "suunto" -> str(R.string.signals_from_suunto)
    "health_connect" -> "Health Connect"
    "apple_health" -> "Apple Health"
    "sample" -> str(R.string.signals_from_sample)
    "told" -> str(R.string.signals_from_told)
    else -> null
}

/** Last night from the readiness answer's `signals` (null when nothing was measured). */
fun parseNight(r: JSONObject): Night? {
    val d = r.optJSONObject("signals") ?: return null
    val asleep = d.dbl("sleep_min") ?: return null
    val from = d.optJSONObject("from")
    return Night(asleep, d.dbl("deep_min"), d.dbl("light_min"), d.dbl("rem_min"), d.dbl("awake_min"), d.dbl("sleep_score")?.toInt(), sourceName(from?.text("sleep_min")))
}

/** Race week (src/race-week.ts, via the page): focus, pacing, fuel and the checklist. */
data class RaceWeek(
    val daysToGo: Int, val focusTitle: String, val focusText: String,
    val pacing: Pacing?, val fuel: List<String>, val checklist: List<String>,
) {
    data class Pacing(val timeS: Int, val paceS: Double, val fromTarget: Boolean, val checkpoints: List<Pair<Double, Int>>, val start: String)
}

/** A note on Today about shoes: found on Strava (once), or asking which you run in. */
data class ShoesNote(val title: String, val text: String, val go: String, val quiet: String, val key: String)

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }
private fun JSONObject.dbl(k: String): Double? = if (!has(k) || isNull(k)) null else optDouble(k).takeUnless { it.isNaN() }
private fun <T> JSONArray?.each(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it)?.let(f) }
private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }

fun parseCheck(json: String): Check {
    val r = JSONObject(json)
    val c = r.optJSONObject("checkin")
    val v = r.optJSONObject("readiness") ?: JSONObject()
    val s = r.optJSONObject("session")
    return Check(
        r.optString("date"),
        c?.dbl("sleep")?.toInt(), c?.dbl("legs")?.toInt(), c?.optJSONObject("pain")?.let { it.optString("area") to it.optInt("level") },
        c != null, r.has("sleep_measured") && !r.isNull("sleep_measured"),
        v.optString("level", "ready"), v.optJSONArray("reasons").strings(),
        s?.text("title"), s?.text("kind"), s?.optBoolean("done") ?: false, s?.text("swapped_from"), s?.text("swap_kind"), r.optBoolean("suggest_swap"),
        r.optJSONObject("day_swap")?.let { w ->
            DaySwap(w.optString("state") == "taken", w.optString("date"), w.optString("kind"), w.optString("title"), w.text("why"), w.text("reason"), choicesOf(w.optJSONArray("choices")))
        },
        r.optJSONObject("day_choices")?.let { c ->
            val st = c.optJSONObject("stance")
            DayChoices(c.optString("date"), c.optString("kind"), c.optString("title"), choicesOf(c.optJSONArray("choices")), c.text("reason"), st?.text("lead") ?: "either", st?.text("line"))
        },
        parseNight(r),
    )
}

/** This morning's body from the readiness answer (GET /api/readiness: `signals` and `usual`); null when nothing was measured. */
fun parseVitals(json: String): Vitals? {
    val r = JSONObject(json)
    val d = r.optJSONObject("signals") ?: return null
    val u = r.optJSONObject("usual")
    val rest = d.dbl("resting_hr")?.let { Math.round(it).toInt() }
    val base = u?.dbl("resting_hr")?.let { Math.round(it).toInt() }
    val energy = d.dbl("energy")?.let { Math.round(it).toInt() }
    val energyBase = u?.dbl("energy")?.let { Math.round(it).toInt() }
    val night = parseNight(r)
    val v = Vitals(
        rest, if (rest != null && base != null) rest - base else null, night?.asleep, d.dbl("spo2_max"),
        energy, if (energy != null && energyBase != null) energy - energyBase else null, d.dbl("hrv_ms")?.let { Math.round(it).toInt() }, night,
        // Who measured it: the night's source, else the resting heart rate's, else the energy's.
        d.optJSONObject("from")?.let { f -> sourceName(f.text("sleep_min") ?: f.text("resting_hr") ?: f.text("energy") ?: f.text("hrv_ms")) },
    )
    return if (listOf(v.rest, v.sleepMin, v.oxygen, v.energy, v.hrv).all { it == null }) null else v
}

fun parseRaceWeek(json: String): RaceWeek? {
    if (json.isBlank() || json.trim() == "null") return null
    val w = JSONObject(json)
    val f = w.optJSONObject("focus") ?: JSONObject()
    val p = w.optJSONObject("pacing")
    val fuel = w.optJSONObject("fuel")
    return RaceWeek(
        w.optInt("days_to_go"), f.optString("title"), f.optString("text"),
        p?.let { RaceWeek.Pacing(it.optInt("time_s"), it.optDouble("pace_s"), it.optString("from") == "target", it.optJSONArray("checkpoints").each { c -> c.optDouble("at_km") to c.optInt("time_s") }, it.optString("start")) },
        fuel?.optJSONArray("before").strings() + fuel?.optJSONArray("during").strings(),
        w.optJSONArray("checklist").strings(),
    )
}

/** Small things Today remembers on the phone (a note dismissed, race-week ticks). */
interface KeyStore {
    fun get(key: String): String?
    fun set(key: String, value: String)
}

/**
 * What Today reads beyond its own cached view, each when it comes: the morning check, the
 * watch's vitals, race week, a fresh run's finish, and the notes about shoes and your PC.
 */
class TodayModel(private val scope: CoroutineScope, private val api: SettingsApi, private val keys: KeyStore) {
    var check by mutableStateOf<Check?>(null)
    var vitals by mutableStateOf<Vitals?>(null)
    var raceWeek by mutableStateOf<RaceWeek?>(null)
    var shoes by mutableStateOf<ShoesNote?>(null)
    var pairHint by mutableStateOf(false)
    /** The last run's sheet model, for its finish ("Just in"). */
    var fresh by mutableStateOf<WorkoutModel?>(null)
    var said by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    /** Changing a finished morning check: open again until Done (or a moment after the last answer). */
    var checkEditing by mutableStateOf(false)
    /** Counts answers, so the check can fold a moment after the last one. */
    var checkTouched by mutableIntStateOf(0)
    private var raceFor: String? = null
    private var shoesShown = false

    /** Read again (after a write, a sync, a new day). `race`: the race as the page has it. */
    fun load(race: RaceGoal?, last: Last?, workoutApi: WorkoutApi) = scope.launch {
        val r = scope.async { api.get("/api/readiness") }
        val sh = scope.async { api.get("/api/shoes") }
        val pr = scope.async { api.rpc("prefs") }
        r.await()?.let { runCatching { check = parseCheck(it) }; runCatching { vitals = parseVitals(it) } }
        if (race != null && (race.daysToGo ?: 99) in 0..7) {
            if (raceFor != race.json || raceWeek == null) api.rpc("raceWeek", JSONObject().put("race", JSONObject(race.json)))?.let { runCatching { raceWeek = parseRaceWeek(it); raceFor = race.json } }
        } else raceWeek = null
        if (last != null && last.justIn && !last.trivial && fresh?.id != last.id) fresh = WorkoutModel(scope, workoutApi, last.id).also { it.loadFinish() }
        else fresh?.takeIf { it.id == last?.id }?.loadFinish()
        sh.await()?.let { runCatching { shoes = shoesNote(JSONObject(it)) } }
        pairHint = keys.get("pairHint") == null && pr.await()?.let { runCatching { !JSONObject(it).optBoolean("paired") }.getOrNull() } == true
    }

    private fun shoesNote(v: JSONObject): ShoesNote? {
        val list = v.optJSONArray("shoes").each { it }
        val strava = list.filter { it.text("strava_id") != null && !it.optBoolean("retired") }
        if (strava.isNotEmpty() && (shoesShown || keys.get("shoesFound") == null)) {
            keys.set("shoesFound", "1")
            shoesShown = true
            val n = strava.size
            return ShoesNote(
                if (n == 1) str(R.string.today_found_your_pair) else plural(R.plurals.today_found_pairs, n, n),
                str(R.string.today_shoes_count_from_now, strava.joinToString(str(R.string.common_list_sep)) { str(R.string.today_shoe_km, it.optString("name"), Math.round(it.optDouble("km", 0.0))) }),
                str(R.string.today_see_them), "OK", "shoesFound",
            )
        }
        val runs = v.optJSONObject("runs")
        val first = runs?.text("first")?.let { runCatching { java.time.Instant.parse(it) }.getOrNull() }
        if (list.isEmpty() && keys.get("shoesNudgeOff") == null && (runs?.optInt("count") ?: 0) >= 3 && first != null && java.time.Duration.between(first, java.time.Instant.now()).toDays() > 7)
            return ShoesNote(str(R.string.today_which_shoes_do_you_run_in), str(R.string.today_add_a_pair_and_tartan_counts), str(R.string.common_add_a_pair), str(R.string.common_not_now), "shoesNudgeOff")
        return null
    }

    fun dismissShoes() { shoes?.let { keys.set(it.key, "1") }; shoesShown = false; shoes = null }
    fun dismissPair() { keys.set("pairHint", "1"); pairHint = false }
    /** A milestone put away from Today (and what the same workout earned with it). */
    fun putAway(id: String) = scope.launch { api.send("/api/milestones/seen", "POST", JSONObject().put("id", id).toString()) }

    /** An answer to the morning check: sleep, legs, or where and how much it hurts (null: nothing). */
    fun answer(sleep: Int? = null, legs: Int? = null, pain: Pair<String, Int>? = null, clearPain: Boolean = false, changed: () -> Unit = {}) {
        val c = check ?: return
        val b = JSONObject()
        // Only what's been answered: a question left open stays open (it isn't taken as "OK").
        if (!c.measured) (sleep ?: c.sleep)?.let { b.put("sleep", it) }
        (legs ?: c.legs)?.let { b.put("legs", it) }
        checkTouched++
        val p = if (clearPain) null else pain ?: c.pain
        b.put("pain", p?.let { JSONObject().put("area", it.first).put("level", it.second) } ?: JSONObject.NULL)
        send("/api/readiness", "PUT", b, changed)
    }

    /** Swap today's hard session for an easy run, or undo it. */
    fun swap(undo: Boolean, changed: () -> Unit) {
        val c = check ?: return
        val b = JSONObject().put("date", c.date)
        if (undo) b.put("kind", c.swapKind).put("undo", true) else b.put("kind", c.sessionKind).put("reason", c.reasons.joinToString(", ").ifEmpty { str(R.string.today_a_hard_day) })
        send("/api/plan/swap", "POST", b, changed)
    }

    /** The nudge asked for on Today's session (null until it comes), and whether it's coming. */
    var nudge by mutableStateOf<String?>(null)
    var nudging by mutableStateOf(false)

    /**
     * Change today's session: a choice from the card (what it suggested, with its reason) or from
     * Different plan today? (a swim, a ride, the treadmill, a shorter run, another day), or Run
     * anyway. Every change undoes with one tap (undoChange).
     */
    fun change(c: DayChoice, fromCard: Boolean, changed: () -> Unit = {}) {
        val ch = check ?: return
        val (date, kind) = (if (fromCard) ch.swap?.let { it.date to it.kind } else ch.choices?.let { it.date to it.kind }) ?: return
        val b = JSONObject().put("date", date).put("kind", kind)
        val why = if (fromCard) ch.swap?.why?.replaceFirstChar { it.lowercase() } ?: "the weather" else "not feeling it"
        if (c.to == "run") b.put("to", "keep").put("reason", "ran anyway") else { b.put("to", c.to).put("reason", why); c.day?.let { b.put("day", it) } }
        send("/api/plan/swap", "POST", b, changed)
    }

    /** Take today's change back. */
    fun undoChange(changed: () -> Unit = {}) {
        val s = check?.swap?.takeIf { it.taken } ?: return
        send("/api/plan/swap", "POST", JSONObject().put("date", s.date).put("kind", s.kind).put("undo", true), changed)
    }

    /** A few words from your own data (the coach's, with a cloud key; Tartan's otherwise). */
    fun askNudge() {
        if (nudging) return
        nudging = true
        scope.launch {
            val (st, text) = api.send("/api/today/nudge", "POST", "{}")
            val o = runCatching { JSONObject(text) }.getOrNull()
            nudge = if (st in 200..299) o?.text("text") else null
            if (nudge == null) said = str(R.string.common_couldnt_save, o?.text("error") ?: str(R.string.common_didnt_go_through_status, st))
            nudging = false
        }
    }

    private fun send(path: String, method: String, body: JSONObject, changed: () -> Unit) {
        busy = true
        scope.launch {
            val (st, text) = api.send(path, method, body.toString())
            val o = runCatching { JSONObject(text) }.getOrNull()
            if (st in 200..299 && o?.text("error") == null) { runCatching { check = parseCheck(text) }; changed() }
            else said = str(R.string.common_couldnt_save, o?.text("error") ?: str(R.string.common_didnt_go_through_status, st))
            busy = false
        }
    }

    /** Tick today's session off by hand (the watch stayed home). */
    fun mark(date: String, kind: String) {
        busy = true
        scope.launch {
            val (st, text) = api.send("/api/plan/mark", "PUT", JSONObject().put("date", date).put("kind", kind).put("done", true).toString())
            val err = runCatching { JSONObject(text).text("error") }.getOrNull()
            said = if (st in 200..299 && err == null) str(R.string.today_marked_done) else str(R.string.today_couldnt_mark, err ?: str(R.string.common_didnt_go_through_status, st))
            busy = false
        }
    }

    /** The race's even-pace workout onto the watch. */
    fun pacingToWatch(r: RaceGoal, w: RaceWeek) {
        val p = w.pacing ?: return
        busy = true
        scope.launch {
            val ok = api.rpc("pacingToWatch", JSONObject().put("name", "${r.name} ${clock(p.timeS)}").put("distance_km", r.km).put("time_s", p.timeS))
            said = if (ok == "true") str(R.string.common_the_pacing_workout_is_on_your) else str(R.string.today_couldn_t_put_it_on_the)
            busy = false
        }
    }

    fun ticked(r: RaceGoal): Set<String> = keys.get("raceweek.${r.date}")?.let { runCatching { JSONArray(it).strings().toSet() }.getOrNull() } ?: emptySet()
    fun tick(r: RaceGoal, item: String, on: Boolean) {
        val now = ticked(r).let { if (on) it + item else it - item }
        keys.set("raceweek.${r.date}", JSONArray(now.toList()).toString())
    }

    fun scanPair() = scope.launch { api.rpc("scanPair")?.let { if (it == "true") { pairHint = false; keys.set("pairHint", "1") } } }
}
