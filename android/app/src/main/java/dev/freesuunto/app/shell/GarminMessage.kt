package dev.freesuunto.app.shell

import org.json.JSONArray
import org.json.JSONObject

/**
 * The message the phone sends Tartan's Garmin watch app (garmin/source/Plan.mc reads it): the
 * engine's plan for it (rpc garminPlan, src/workout/garmin.ts) as the objects Garmin's companion
 * SDK serialises: maps, lists, strings and Integers (a Long arrives on the watch as a Long, which
 * the watch app doesn't compare with its Numbers). Pure, so it's tested on the JVM.
 */
object GarminMessage {
    /** The most a message to the watch should hold: later days go first when a week is bigger. */
    const val MAX_CHARS = 8000

    /** Whether the plan goes to a Garmin at all: only when the watch is one (the brand decides). */
    fun goesToGarmin(brand: String?) = brand == "garmin"

    /** The watch's message from the engine's answer ({ key, message }), or null when there's nothing to send. */
    fun fromEngine(answer: String?): Pair<String, Map<String, Any>>? {
        if (answer == null || answer == "null") return null
        val o = runCatching { JSONObject(answer) }.getOrNull() ?: return null
        val m = o.optJSONObject("message") ?: return null
        return o.optString("key") to build(m)
    }

    /** The message, its days trimmed from the end until it fits (today's always stays). */
    fun build(message: JSONObject, maxChars: Int = MAX_CHARS): Map<String, Any> {
        val m = JSONObject(message.toString())
        val days = m.optJSONArray("days") ?: JSONArray()
        while (days.length() > 1 && m.toString().length > maxChars) days.remove(days.length() - 1)
        m.put("days", days)
        @Suppress("UNCHECKED_CAST")
        return monkey(m) as Map<String, Any>
    }

    /** JSON as the SDK's types: JSONObject → LinkedHashMap, JSONArray → ArrayList, whole numbers → Integer. */
    fun monkey(v: Any?): Any? = when (v) {
        null, JSONObject.NULL -> null
        is JSONObject -> LinkedHashMap<String, Any?>().also { out -> v.keys().forEach { k -> out[k] = monkey(v.opt(k)) } }
        is JSONArray -> ArrayList<Any?>().also { out -> for (i in 0 until v.length()) out.add(monkey(v.opt(i))) }
        is Long -> if (v in Int.MIN_VALUE..Int.MAX_VALUE) v.toInt() else v.toDouble()
        is Double -> if (v == Math.floor(v) && !v.isInfinite() && kotlin.math.abs(v) < Int.MAX_VALUE) v.toInt() else v.toFloat()
        is Float -> v
        is Number -> v.toInt()
        is Boolean, is String -> v
        else -> v.toString()
    }

    /** The first day's title (today's session, else the next), for "sent: Intervals, today". */
    fun firstTitle(message: Map<String, Any>): Pair<String, String>? {
        val days = message["days"] as? List<*> ?: return null
        val d = days.firstOrNull() as? Map<*, *> ?: return null
        return (d["title"] as? String ?: return null) to (d["date"] as? String ?: "")
    }

    /** Whether a message from the watch asks for the plan ({ t: "want" }). */
    fun asksForPlan(msg: Any?): Boolean = (msg as? Map<*, *>)?.get("t") == "want"

    // ---------------------------------------------------------------- The watch's day (garmin/source/Body.mc)

    /** Whether a message from the watch carries the day's body numbers ({ t: "day", days: [...] }). */
    fun isDay(msg: Any?): Boolean = (msg as? Map<*, *>)?.get("t") == "day"

    /** What the phone sends the watch to have the day's numbers now (Tartan opened). */
    val ASK_DAY: Map<String, Any> = mapOf("t" to "ask", "v" to 1)

    /**
     * What the watch may send, as the engine's SignalValues (src/signals.ts): each number's range.
     * Nothing else is taken: no sleep stages or HRV (Connect IQ doesn't give them; other sources do).
     */
    val DAY_RANGES: Map<String, ClosedFloatingPointRange<Double>> = mapOf(
        "energy" to 0.0..100.0,
        "stress" to 0.0..100.0,
        "sleep_score" to 0.0..100.0,
        "recovery_h" to 0.0..240.0,
        "breathing_rate" to 3.0..60.0,
        "resting_hr" to 20.0..200.0,
        "vo2max" to 10.0..100.0,
        "night_hr_min" to 20.0..200.0,
        "spo2_max" to 50.0..100.0,
    )
    /** The night's times, when the watch has real ones (local "YYYY-MM-DDTHH:MM"). */
    private val DAY_TIMES = setOf("sleep_start", "sleep_end")
    private val TIME = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$")

    /** The days a message may be for: today, the two before (a phone that was away), tomorrow (a watch a time zone ahead). */
    fun dayAllowed(date: String, today: java.time.LocalDate): Boolean {
        val d = runCatching { java.time.LocalDate.parse(date) }.getOrNull() ?: return false
        return date.length == 10 && !d.isBefore(today.minusDays(2)) && !d.isAfter(today.plusDays(1))
    }

    /**
     * The watch's message, checked, as the engine's signalsPut arguments ({ days: [...] } with
     * source "garmin"): each day's date within reach of today, each value a number in its range
     * (one decimal at most) or, for the night's times, a real time. What isn't is left out; null
     * when nothing in the message holds.
     */
    fun signalDays(msg: Any?, today: java.time.LocalDate): JSONObject? {
        if (!isDay(msg)) return null
        val days = (msg as Map<*, *>)["days"] as? List<*> ?: return null
        val out = JSONArray()
        for (d in days.take(7)) {
            val m = d as? Map<*, *> ?: continue
            val date = m["date"] as? String ?: continue
            if (!dayAllowed(date, today)) continue
            val day = JSONObject().put("date", date).put("source", "garmin")
            var any = false
            for ((k, v) in m) {
                val key = k as? String ?: continue
                val range = DAY_RANGES[key]
                if (range != null) {
                    val n = (v as? Number)?.toDouble()?.takeIf { it.isFinite() && it in range } ?: continue
                    val r = Math.round(n * 10) / 10.0
                    day.put(key, if (r == Math.floor(r)) r.toLong() else r)
                    any = true
                } else if (key in DAY_TIMES && v is String && TIME.matches(v) && v.substring(0, 10).let { s -> s == date || s == java.time.LocalDate.parse(date).minusDays(1).toString() }) {
                    day.put(key, v)
                    any = true
                }
            }
            if (any) out.put(day)
        }
        return if (out.length() == 0) null else JSONObject().put("days", out)
    }

    /**
     * The engine's signalsPut arguments for a message from the watch, only while the watch is a
     * Garmin (the brand the engine keeps, the same switch as the plan): a Suunto never takes them.
     */
    fun signalsFor(brand: String?, msg: Any?, today: java.time.LocalDate): String? =
        if (!goesToGarmin(brand)) null else signalDays(msg, today)?.toString()
}
