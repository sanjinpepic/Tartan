package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale

/** The muscles in the app's order (src/strength/exercises.ts MUSCLES). */
val MUSCLES = listOf(
    "traps", "delts", "chest", "biceps", "triceps", "forearms", "lats", "upper_back", "lower_back",
    "abs", "obliques", "hip_flexors", "glutes", "glute_med", "adductors", "quads", "hamstrings", "calves", "tibialis",
)

/** One muscle now (src/fatigue.ts MuscleState). */
data class MuscleNow(
    val level: Int, val state: String, val freshInH: Double?, val score: Double, val lastWorked: String?,
    val causes: List<Cause>, val sore: Triple<String, Int, String>?,
) {
    data class Cause(val date: String, val what: String, val kind: String, val share: Double)
}

/** The watch's figures for Body (GET /api/health). */
data class Health(
    val restHr: Int?, val restDate: String?, val baseline: Int?,
    val sleep: String?, val sleepNote: String?,
    val oxygen: Double?, val oxygenAt: String?,
    val steps: Int, val activeKcal: Double?,
    val todayHr: List<Double?>, val latestAt: String?,
)

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }
private fun JSONObject.dbl(k: String): Double? = if (!has(k) || isNull(k)) null else optDouble(k).takeUnless { it.isNaN() }
private fun <T> JSONArray?.each(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it)?.let(f) }

fun parseBody(json: String): Map<String, MuscleNow> {
    val ms = JSONObject(json).optJSONObject("muscles") ?: return emptyMap()
    return MUSCLES.associateWith { m ->
        val s = ms.optJSONObject(m) ?: JSONObject()
        MuscleNow(
            s.optInt("level"), s.optString("state", "fresh"), s.dbl("fresh_in_h"), s.optDouble("score", 0.0), s.text("last_worked"),
            s.optJSONArray("causes").each { MuscleNow.Cause(it.optString("date"), it.optString("what"), it.optString("kind"), it.optDouble("share")) },
            s.optJSONObject("sore")?.let { Triple(it.optString("area"), it.optInt("level"), it.optString("date")) },
        )
    }
}

fun parseHealth(json: String, today: String = LocalDate.now().toString()): Health {
    val h = JSONObject(json)
    val days = h.optJSONArray("days").each { it }
    val day = days.firstOrNull { it.optString("date") == today }
    val rest = days.firstOrNull { it.dbl("resting_hr") != null }
    val sl = day?.optJSONObject("sleep")
    val night = day?.optJSONObject("night")
    val hm = { t: Double -> java.time.Instant.ofEpochMilli(t.toLong()).atZone(java.time.ZoneId.systemDefault()).toLocalTime().toString().take(5) }
    val (sleep, note) = when {
        sl != null -> {
            val m = sl.optJSONObject("minutes") ?: JSONObject()
            val stages = if (m.optDouble("deep", 0.0) + m.optDouble("rem", 0.0) > 0) str(R.string.body_stages, duration(m.optDouble("deep")), duration(m.optDouble("rem"))) else ""
            duration(m.optDouble("asleep")) to "${hm(sl.optDouble("start"))}–${hm(sl.optDouble("end"))}$stages${day.dbl("hrv_ms")?.let { str(R.string.body_hrv, it.toInt()) } ?: ""}"
        }
        night != null -> duration(night.optDouble("minutes")) to str(R.string.body_night_estimated, night.optString("start").drop(11).take(5), night.optString("end").drop(11).take(5), night.optInt("hr_avg"))
        else -> null to null
    }
    val ox = days.flatMap { d -> d.optJSONArray("spo2").each { it }.reversed() }.firstOrNull()
    val hr = h.optJSONArray("today_hr")
    return Health(
        rest?.dbl("resting_hr")?.toInt(), rest?.optString("date"), h.dbl("resting_baseline")?.toInt(),
        sleep, note, ox?.dbl("pct"), ox?.text("at"), day?.optInt("steps") ?: 0, day?.dbl("active_kcal"),
        if (hr == null) emptyList() else (0 until hr.length()).map { if (hr.isNull(it)) null else hr.optDouble(it) },
        h.optJSONObject("latest")?.text("at"),
    )
}

/** "today", "yesterday", or the weekday. */
fun whenDay(date: String, today: LocalDate = LocalDate.now()): String = when (date.take(10)) {
    today.toString() -> str(R.string.body_today_lower)
    today.minusDays(1).toString() -> str(R.string.body_yesterday_lower)
    else -> runCatching { LocalDate.parse(date.take(10)).dayOfWeek.getDisplayName(TextStyle.FULL, Locale.getDefault()) }.getOrDefault(date)
}

/** "today", "yesterday", "on Monday" this week, else "on 3 Oct". */
fun onDay(date: String, today: LocalDate = LocalDate.now()): String {
    val d = runCatching { LocalDate.parse(date.take(10)) }.getOrNull() ?: return date
    val days = java.time.temporal.ChronoUnit.DAYS.between(d, today)
    val w = whenDay(date, today)
    return if (days in 0..1) w else if (days < 7) str(R.string.body_on, w) else str(R.string.body_on, dateShort(date))
}

/** "about 20 h", "about 2 days". */
fun inHours(h: Double) = if (h < 36) str(R.string.body_about_h, maxOf(1, Math.round(h).toInt())) else str(R.string.body_about_days, Math.round(h / 24))

private fun names(ms: List<String>): String {
    val n = ms.map { (Words.MUSCLE[it] ?: it).lowercase() }
    return if (n.size < 2) n.firstOrNull() ?: "" else str(R.string.common_and, n.dropLast(1).joinToString(str(R.string.common_list_sep)), n.last())
}
private fun list3(ms: List<String>) = if (ms.size > 3) str(R.string.body_and_more, ms.take(3).joinToString(str(R.string.common_list_sep)) { (Words.MUSCLE[it] ?: it).lowercase() }) else names(ms)

/** Muscles with anything in them (or sore), most tired first. */
fun needing(b: Map<String, MuscleNow>) = MUSCLES.filter { (b[it]?.level ?: 0) > 0 || b[it]?.sore != null }.sortedByDescending { b[it]?.score ?: 0.0 }

/** One line on the body as a whole (web/views/you.ts summary). */
fun bodySummary(b: Map<String, MuscleNow>): String {
    val tired = MUSCLES.filter { b[it]?.state == "fatigued" }
    val rec = MUSCLES.filter { b[it]?.state == "recovering" }
    if (tired.isEmpty() && rec.isEmpty()) {
        val light = MUSCLES.filter { (b[it]?.level ?: 0) > 0 }
        return if (light.isNotEmpty()) str(R.string.body_fresh_carry_a_little_from_your, list3(light).replaceFirstChar { it.uppercase() }) else str(R.string.body_everything_s_fresh_nothing_from_your)
    }
    val lead = tired.ifEmpty { rec }
    val top = lead.mapNotNull { b[it]?.causes?.firstOrNull() }.maxByOrNull { it.share }
    val what = top?.let { str(R.string.body_mostly_from, if (it.what.lowercase().startsWith("the ")) it.what else str(R.string.body_your_thing, it.what), onDay(it.date)) } ?: ""
    return plural(if (tired.isNotEmpty()) R.plurals.body_worked_hard else R.plurals.body_still_recovering, lead.size, lead.size, list3(lead).replaceFirstChar { it.uppercase() }, what)
}

/** Body: the muscles now, sleep and the watch's vitals; and every exercise, to say what trains a muscle. */
class BodyModel(private val scope: CoroutineScope, val api: SettingsApi) {
    var muscles by mutableStateOf<Map<String, MuscleNow>?>(null)
    var health by mutableStateOf<Health?>(null)
    var healthMissing by mutableStateOf(false)
    var figure by mutableStateOf("m")
    var exercises by mutableStateOf<List<Routine.Exercise>>(emptyList())
    private var read = false

    fun forget() { read = false }

    fun ensure() {
        if (read) return
        read = true
        scope.launch {
            val b = scope.async { api.get("/api/body") }
            val h = scope.async { api.get("/api/health") }
            val e = scope.async { api.rpc("exercises") }
            b.await()?.let { runCatching { muscles = parseBody(it) } }
            h.await()?.let { runCatching { health = parseHealth(it) } } ?: run { healthMissing = true }
            e.await()?.let { j ->
                runCatching {
                    val o = JSONObject(j)
                    figure = o.optString("figure", "m")
                    exercises = parseRoutine(JSONObject().put("items", o.optJSONArray("items")).toString()).items
                }
            }
        }
    }
}

private val CARD = RoundedCornerShape(28.dp)
private val STATE get() = mapOf("fresh" to str(R.string.common_fresh), "recovering" to str(R.string.body_recovering), "fatigued" to str(R.string.body_worked_hard))
private val PAIN get() = listOf("", str(R.string.body_a_little), str(R.string.body_clearly), str(R.string.body_a_lot))

/**
 * Body, native (web/views/you.ts): how your body is now. The muscles on the heat scale from
 * fresh to worked hard, running and lifting together; a tap on one says how it is, when it'll be
 * fresh, why, and what trains it. Then sleep and the watch's vitals. Not a tab: back goes back.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun BodyScreen(m: BodyModel, back: () -> Unit, navSpace: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    var open by remember { mutableStateOf<String?>(null) }
    var exercise by remember { mutableStateOf<Routine.Exercise?>(null) }
    Box(Modifier.fillMaxSize().background(cs.surface)) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = top + 60.dp, bottom = bottom + if (navSpace) 104.dp else 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PageHeader(stringResource(R.string.body_body), subtitle = stringResource(R.string.body_muscles_sleep_and_recovery))
            var i = 0
            val b = m.muscles
            Column(Modifier.fillMaxWidth().reveal(i++).clip(CARD).background(cs.surfaceContainer).padding(20.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.body_muscles), style = MaterialTheme.typography.titleLarge)
                if (b == null) { Box(Modifier.fillMaxWidth().height(200.dp), contentAlignment = Alignment.Center) { LoadingIndicator() }; return@Column }
                Text(bodySummary(b), style = MaterialTheme.typography.bodyLarge)
                BodyMap(b.mapValues { it.value.level }, Modifier.padding(horizontal = 8.dp), m.figure, open, onMuscle = { open = it })
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) { HeatLegend(stringResource(R.string.common_fresh), stringResource(R.string.body_worked_hard)) }
                val need = needing(b)
                val shades = heat()
                if (need.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    need.take(8).forEach { mu ->
                        val s = b.getValue(mu)
                        Row(
                            Modifier.press(scale = 0.95f, label = Words.MUSCLE[mu], onClick = { open = mu }).clip(RoundedCornerShape(14.dp)).background(cs.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(shades[s.level.coerceIn(0, 4)]))
                            Column(Modifier.padding(start = 8.dp)) {
                                Text(Words.MUSCLE[mu] ?: mu, style = MaterialTheme.typography.labelLarge)
                                Text(s.freshInH?.let { stringResource(R.string.body_fresh_in_short, inHours(it).replace(stringResource(R.string.body_about_prefix), "~")) } ?: if (s.sore != null) stringResource(R.string.body_sore) else stringResource(R.string.body_a_little_worked), style = MaterialTheme.typography.labelSmall, color = cs.onSurfaceVariant)
                            }
                            if (s.sore != null) Icon(Glyphs["warn"], null, Modifier.padding(start = 6.dp).size(14.dp), tint = LocalData.current.watch)
                        }
                    }
                }
                Text(stringResource(R.string.body_tap_a_muscle_to_see_how), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                var every by remember { mutableStateOf(false) }
                val others = MUSCLES.filter { it !in need }
                if (others.isNotEmpty()) {
                    TextButton(onClick = { every = !every }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(if (every) stringResource(R.string.body_fewer) else stringResource(R.string.body_every_muscle)) }
                    if (every) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        others.forEach { mu ->
                            Text(Words.MUSCLE[mu] ?: mu, style = MaterialTheme.typography.labelLarge, modifier = Modifier.press(scale = 0.95f, onClick = { open = mu }).clip(RoundedCornerShape(14.dp)).background(cs.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 10.dp))
                        }
                    }
                }
                Fold(stringResource(R.string.body_how_is_this_worked_out), stringResource(R.string.body_from_your_workouts_of_the_last))
            }
            Vitals(m, Modifier.reveal(i))
        }
    }
    open?.let { mu -> m.muscles?.get(mu)?.let { s -> MuscleSheet(mu, s, m, { open = null }) { exercise = it } } }
    exercise?.let { e -> ExerciseSheet(e, m.api) { exercise = null } }
}

/** Words folded behind a line. */
@Composable
fun Fold(title: String, text: String) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.animateContentSize()) {
        TextButton(onClick = { open = !open }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(title) }
        if (open) Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Sleep and vitals: four tiles, today's heart rate, where they come from. */
@Composable
private fun Vitals(m: BodyModel, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val h = m.health
    Column(modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer).padding(20.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.body_sleep_and_vitals), style = MaterialTheme.typography.titleLarge)
        val at = h?.latestAt?.let { a -> stringResource(R.string.body_from_your_watch_at, if (a.take(10) == LocalDate.now().toString()) a.drop(11).take(5) else whenDay(a)) } ?: stringResource(R.string.body_from_your_watch)
        Text(at, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        if (h == null) {
            if (m.healthMissing) Text(stringResource(R.string.body_nothing_from_the_watch_yet), color = cs.onSurfaceVariant) else Box(Modifier.fillMaxWidth().height(120.dp), contentAlignment = Alignment.Center) { LoadingIndicator() }
            return@Column
        }
        val diff = if (h.restHr != null && h.baseline != null) h.restHr - h.baseline else null
        val today = LocalDate.now().toString()
        val tiles = listOf(
            Tile("heart", stringResource(R.string.body_resting_heart_rate), h.restHr?.let { "$it" } ?: "–", h.restHr?.let { " bpm" } ?: "",
                when {
                    h.restHr == null -> stringResource(R.string.body_wear_the_watch_to_bed)
                    diff == null -> if (h.restDate == today) stringResource(R.string.body_lowest_still_half_hour_today) else stringResource(R.string.body_lowest_still_half_hour, whenDay(h.restDate ?: ""))
                    kotlin.math.abs(diff) < 3 -> stringResource(R.string.body_your_usual, h.baseline.toString())
                    else -> "${if (diff > 0) "+" else "−"}${kotlin.math.abs(diff)}".let { d -> if (h.restDate == today) stringResource(R.string.body_on_your_usual, d, h.baseline.toString()) else stringResource(R.string.body_on_your_usual_when, d, h.baseline.toString(), whenDay(h.restDate ?: "")) }
                },
                if (diff != null && diff >= 7) data.watch else if (diff != null && diff <= -3) data.good else null),
            Tile("moon", stringResource(R.string.body_last_night), h.sleep ?: "–", "", h.sleepNote ?: stringResource(R.string.body_wear_the_watch_to_bed)),
            Tile("drop", stringResource(R.string.body_blood_oxygen), h.oxygen?.let { "${Math.round(it)}" } ?: "–", h.oxygen?.let { "%" } ?: "",
                h.oxygenAt?.let { a -> if (a.take(10) == LocalDate.now().toString()) stringResource(R.string.body_at_time, a.drop(11).take(5)) else stringResource(R.string.body_day_at_time, whenDay(a).replaceFirstChar { c -> c.uppercase() }, a.drop(11).take(5)) } ?: stringResource(R.string.body_no_reading_yet),
                if ((h.oxygen ?: 100.0) < 92) data.watch else null),
            Tile("walk", stringResource(R.string.body_steps_today), String.format(Locale.getDefault(), "%,d", h.steps), "", h.activeKcal?.takeIf { it > 0 }?.let { stringResource(R.string.body_kcal_active, Math.round(it)) } ?: stringResource(R.string.body_so_far)),
        )
        tiles.chunked(2).forEachIndexed { r, pair ->
            Row(Modifier.height(androidx.compose.foundation.layout.IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                pair.forEachIndexed { c, t ->
                    val big = 22.dp; val small = 8.dp
                    val shape = RoundedCornerShape(if (r == 0 && c == 0) big else small, if (r == 0 && c == 1) big else small, if (r == 1 && c == 1) big else small, if (r == 1 && c == 0) big else small)
                    Column(Modifier.weight(1f).fillMaxHeight().clip(shape).background(cs.surfaceContainerHigh).padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Glyphs[t.icon], null, Modifier.size(16.dp), tint = t.tone ?: cs.onSurfaceVariant)
                            Text(t.label, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
                        }
                        Text(
                            androidx.compose.ui.text.buildAnnotatedString {
                                append(t.value)
                                if (t.unit.isNotEmpty()) withStyle(androidx.compose.ui.text.SpanStyle(fontSize = MaterialTheme.typography.labelLarge.fontSize, color = cs.onSurfaceVariant)) { append(t.unit) }
                            },
                            style = Figure.M, color = t.tone ?: cs.onSurface,
                        )
                        Text(t.note, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                    }
                }
            }
        }
        val got = h.todayHr.filterNotNull()
        if (got.size >= 2) {
            Row {
                Text(stringResource(R.string.body_heart_rate_today), style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                Text(stringResource(R.string.common_bpm_range, got.min().toInt(), got.max().toInt()), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
            }
            Sparkline(h.todayHr)
            Row { listOf("00", "12", "24").forEachIndexed { k, s -> Text(s, style = MaterialTheme.typography.labelSmall, color = cs.onSurfaceVariant, textAlign = if (k == 0) androidx.compose.ui.text.style.TextAlign.Start else if (k == 1) androidx.compose.ui.text.style.TextAlign.Center else androidx.compose.ui.text.style.TextAlign.End, modifier = Modifier.weight(1f)) } }
        }
        Fold(stringResource(R.string.body_where_do_these_come_from), stringResource(R.string.body_tartan_reads_the_watch_s_10))
    }
}

private class Tile(val icon: String, val label: String, val value: String, val unit: String, val note: String, val tone: androidx.compose.ui.graphics.Color? = null)

/** Today's heart rate every 10 minutes as a line, with gaps where the watch wasn't worn; noon marked. */
@Composable
private fun Sparkline(hr: List<Double?>) {
    val cs = MaterialTheme.colorScheme
    val got = hr.filterNotNull()
    val lo = got.min(); val hi = got.max()
    Canvas(Modifier.fillMaxWidth().height(56.dp).semantics { contentDescription = str(R.string.body_heart_rate_today_to_bpm, lo.toInt(), hi.toInt()) }) {
        val x = { i: Int -> i / 143f * size.width }
        val y = { v: Double -> (size.height - 4.dp.toPx() - ((v - lo) / maxOf(1.0, hi - lo)).toFloat() * (size.height - 8.dp.toPx())) }
        drawLine(cs.outlineVariant, Offset(size.width / 2, 0f), Offset(size.width / 2, size.height), 1.dp.toPx())
        val p = Path()
        hr.forEachIndexed { i, v -> if (v != null) { if (i > 0 && hr[i - 1] != null) p.lineTo(x(i), y(v)) else p.moveTo(x(i), y(v)) } }
        drawPath(p, cs.error, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

/** One muscle (you.ts openMuscle): how it is, when it'll be fresh, why, and what trains it. */
@Composable
private fun MuscleSheet(mu: String, s: MuscleNow, m: BodyModel, onClose: () -> Unit, openExercise: (Routine.Exercise) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val shades = heat()
    val verdict = if (s.state == "fresh") (if (s.lastWorked != null) stringResource(R.string.body_fresh_and_ready_to_work) else stringResource(R.string.body_fresh_nothing_has_loaded_it_lately))
    else stringResource(if (s.state == "fatigued") R.string.body_carrying_fresh_again else R.string.body_getting_there_fresh_again, inHours(s.freshInH ?: 0.0))
    val exs = (m.exercises.filter { mu in it.primary } + m.exercises.filter { mu in it.secondary && mu !in it.primary }).take(6)
    Sheet(onClose) { close ->
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(start = 16.dp, end = 16.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(Words.MUSCLE[mu] ?: mu, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(shades[s.level.coerceIn(0, 4)]))
                        Text(STATE[s.state] ?: s.state, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
                    }
                }
                FilledTonalIconButton(onClick = close) { Icon(Glyphs["close"], stringResource(R.string.common_close)) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(verdict, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Box(Modifier.width(140.dp)) { BodyMap(mapOf(mu to maxOf(2, s.level)), figure = m.figure, selected = mu, label = stringResource(R.string.body_where_it_is)) }
            }
            s.sore?.let { (area, lv, date) ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(data.watchContainer).padding(14.dp)) {
                    Icon(Glyphs["warn"], null, Modifier.size(18.dp), tint = data.watch)
                    Text(
                        stringResource(R.string.body_you_said_hurt, if (area == "other") stringResource(R.string.body_body_lower) else Words.area(area).lowercase(), PAIN.getOrElse(lv) { "" }, onDay(date)) +
                            if (lv >= 2) stringResource(R.string.body_let_it_settle_before_loading_it) else stringResource(R.string.body_easy_work_is_fine_if_it),
                        style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 10.dp),
                    )
                }
            }
            if (s.causes.isNotEmpty()) {
                Text(stringResource(R.string.body_why), style = MaterialTheme.typography.titleLarge)
                val total = s.causes.sumOf { it.share }
                Text(stringResource(if (total < 0.95) R.string.body_still_in_it_older else R.string.body_still_in_it), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                s.causes.forEach { c ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(32.dp).clip(CircleShape).background(cs.secondaryContainer), contentAlignment = Alignment.Center) {
                            Icon(Glyphs[when (c.kind) { "run" -> "run"; "strength" -> "bolt"; else -> "other" }], null, Modifier.size(16.dp), tint = cs.onSecondaryContainer)
                        }
                        Column(Modifier.weight(1f).padding(start = 12.dp)) {
                            Text(c.what, style = MaterialTheme.typography.titleSmall)
                            Text(onDay(c.date).removePrefix("on ").replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                        }
                        Box(Modifier.width(64.dp).height(8.dp).clip(CircleShape).background(cs.surfaceContainerHighest)) {
                            Box(Modifier.fillMaxWidth(c.share.toFloat().coerceIn(0f, 1f)).height(8.dp).clip(CircleShape).background(cs.primary))
                        }
                        Text("${Math.round(c.share * 100)}%", style = MaterialTheme.typography.labelLarge, modifier = Modifier.width(44.dp).padding(start = 8.dp))
                    }
                }
            }
            s.lastWorked?.let { Text(stringResource(R.string.body_last_worked, onDay(it)), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
            if (exs.isNotEmpty()) {
                Text(if (s.state == "fresh") stringResource(R.string.body_exercises_for_it) else stringResource(R.string.body_exercises_for_it_when_it_s), style = MaterialTheme.typography.titleLarge)
                exs.forEachIndexed { i, e ->
                    val first = i == 0; val last = i == exs.lastIndex
                    Row(
                        Modifier.fillMaxWidth().press(scale = 0.98f, label = e.name, onClick = { openExercise(e) })
                            .clip(RoundedCornerShape(if (first) 20.dp else 6.dp, if (first) 20.dp else 6.dp, if (last) 20.dp else 6.dp, if (last) 20.dp else 6.dp))
                            .background(cs.surfaceContainer).padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(e.name, style = MaterialTheme.typography.titleSmall)
                            Text(if (mu in e.primary) stringResource(R.string.body_works_it) else stringResource(R.string.body_helps_it), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                        }
                        Icon(Glyphs["chevron"], null, Modifier.size(18.dp), tint = cs.onSurfaceVariant)
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
