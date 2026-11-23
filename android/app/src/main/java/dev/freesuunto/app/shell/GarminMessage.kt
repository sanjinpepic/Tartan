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
}
