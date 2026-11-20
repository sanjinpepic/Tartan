package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import org.json.JSONArray
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A workout in the list (Activity in web/types.ts), only what a row shows. */
data class Act(
    val id: String,
    /** Local time, as the watch or Strava recorded it. */
    val start: LocalDateTime?,
    val sport: String,
    val name: String,
    val km: Double?,
    val minutes: Double?,
    val pace: String?,
    val hr: Int?,
    val sources: List<String>,
    val device: String?,
) {
    /** Run, ride or other, as the web's filter has it. */
    val family: String get() {
        val s = sport.lowercase()
        return when {
            Regex("run|jog|trail|treadmill").containsMatchIn(s) -> "run"
            Regex("ride|cycl|bik").containsMatchIn(s) -> "ride"
            else -> "other"
        }
    }
    val big: String get() = km?.let { str(R.string.common_n_km, String.format(Locale.getDefault(), "%.2f", it)) } ?: minutes?.let { duration(it) } ?: ""
    val small: String get() = listOfNotNull(if (km != null) minutes?.let { duration(it) } else null, pace?.let { str(R.string.common_per_km, it) } ?: hr?.let { str(R.string.common_n_bpm, it) }).joinToString(" · ")
    val whenText: String get() = start?.format(DateTimeFormatter.ofPattern("EEE d MMM · HH:mm", Locale.getDefault())) ?: ""
}

/** A week of workouts: its Monday and totals. */
data class ActWeek(val monday: java.time.LocalDate, val acts: List<Act>) {
    val km get() = acts.sumOf { it.km ?: 0.0 }
    val minutes get() = acts.sumOf { it.minutes ?: 0.0 }
}

/** A string field, or null when it's missing, JSON null or empty (optString gives "null" for null). */
private fun org.json.JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }

fun parseActivities(json: String): List<Act> {
    val a = JSONArray(json)
    return (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { o ->
        val start = (o.text("start_local") ?: o.text("start") ?: "").take(19)
        Act(
            o.optString("id"),
            runCatching { LocalDateTime.parse(start) }.getOrNull(),
            o.text("sport") ?: str(R.string.common_workout),
            o.text("name") ?: o.text("sport") ?: str(R.string.common_workout),
            if (o.isNull("distance_km") || !o.has("distance_km")) null else o.optDouble("distance_km"),
            if (o.isNull("moving_min") || !o.has("moving_min")) null else o.optDouble("moving_min"),
            o.text("avg_pace_min_km"),
            if (o.has("avg_hr") && !o.isNull("avg_hr")) o.optDouble("avg_hr").toInt() else null,
            o.optJSONArray("sources")?.let { s -> (0 until s.length()).map { s.optString(it) } } ?: emptyList(),
            o.text("device"),
        )
    }
}

/** The list as shown: the filter and the search, grouped by week, the latest 400. */
fun weeks(all: List<Act>, filter: String, query: String): Pair<List<ActWeek>, Int> {
    val q = query.trim().lowercase()
    val rows = all.filter { (filter == "all" || it.family == filter) && (q.isEmpty() || "${it.name} ${it.sport} ${it.device ?: ""}".lowercase().contains(q)) }
    val groups = rows.take(400).groupBy { a -> a.start?.toLocalDate()?.let { it.minusDays((it.dayOfWeek.value - 1).toLong()) } ?: java.time.LocalDate.MIN }
    return groups.map { (k, v) -> ActWeek(k, v) } to rows.size
}
