package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant

/** A run being recorded, as the page's recorder holds it (web/recorder.ts), pushed on every change. */
data class RecNow(
    val status: String, val start: Long?, val end: Long?, val pauses: List<Pair<Long, Long?>>, val name: String?,
    val distance: Double, val movingS: Int?, val elevation: Double?, val avgHr: Int?,
    val accuracy: Int?, val gpsError: String?, val hrName: String?, val bpm: Int?, val nowMps: Double,
    /** Today's planned run, when there is one: its distance and name (for the Live Update). */
    val goalKm: Double? = null, val planTitle: String? = null,
    /** A guided run (src/workout/guided.ts): the step it's on. */
    val guide: GuideNow? = null,
) {
    /** Seconds moving at `now` (the clock moves without a GPS fix). */
    fun moving(now: Long): Long {
        val s = start ?: return 0
        val e = end ?: now
        val paused = pauses.sumOf { (from, to) -> (to ?: e) - from }
        return maxOf(0, (e - s - paused) / 1000)
    }
}

/** A guided run's step, as the page's guide has it (GuideView). */
data class GuideNow(
    val name: String, val index: Int, val total: Int, val label: String, val detail: String, val kind: String,
    val leftS: Int?, val leftM: Int?, val share: Float, val next: String?, val done: Boolean,
) {
    /** "4:10 left", "420 m left". */
    val left: String? get() = if (done) null else leftS?.let { str(R.string.record_clock_left, "${it / 60}:${(it % 60).toString().padStart(2, '0')}") } ?: leftM?.let { str(R.string.record_m_left, it) }
}

fun parseGuide(o: JSONObject?): GuideNow? = o?.let {
    GuideNow(
        it.optString("name"), it.optInt("index"), it.optInt("total"), it.optString("label"), it.optString("detail"), it.optString("kind"),
        if (it.has("left_s")) it.optInt("left_s") else null, if (it.has("left_m")) it.optInt("left_m") else null,
        it.optDouble("share", 0.0).toFloat(), it.optString("next").ifEmpty { null }, it.optBoolean("done"),
    )
}

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }

fun parseRec(json: String): RecNow {
    val o = JSONObject(json)
    val sum = o.optJSONObject("summary")
    val hr = o.optJSONObject("hr")
    val p = o.optJSONArray("pauses")
    return RecNow(
        o.optString("status", "idle"), o.text("start")?.let { Instant.parse(it).toEpochMilli() }, o.text("end")?.let { Instant.parse(it).toEpochMilli() },
        if (p == null) emptyList() else (0 until p.length()).mapNotNull { p.optJSONObject(it) }.map { it.optLong("from") to (if (it.has("to") && !it.isNull("to")) it.optLong("to") else null) },
        o.text("name"), sum?.optDouble("distance_m", 0.0) ?: 0.0, sum?.optInt("moving_s"), sum?.optDouble("elevation_m"), sum?.optInt("avg_hr")?.takeIf { it > 0 },
        if (o.isNull("accuracy")) null else o.optInt("accuracy"), o.text("gpsError"), hr?.text("name"), hr?.optInt("bpm")?.takeIf { it > 0 }, o.optDouble("now", 0.0),
        o.optDouble("goal_km").takeIf { !it.isNaN() && it > 0 }, o.text("plan_title"),
        parseGuide(o.optJSONObject("guide")),
    )
}

/** Today's planned run a guided run follows: its name, how many steps, the first. */
data class GuideSession(val name: String, val steps: Int, val first: String)

data class PastRun(val id: String, val name: String, val start: String, val km: Double, val movingS: Int, val strava: String?)

/** Record (web/views/record.ts): start, pause, finish a run with the phone's GPS; keep it and send it to Strava. */
class RecordModel(private val scope: CoroutineScope, private val api: SettingsApi) {
    var rec by mutableStateOf<RecNow?>(null)
    var past by mutableStateOf<List<PastRun>?>(null)
    var cues by mutableStateOf(false)
    var said by mutableStateOf<String?>(null)
    var busy by mutableStateOf<String?>(null)
    /** Guide today's planned session (on unless switched off), and the session it would follow. */
    var guideOn by mutableStateOf(true)
    var session by mutableStateOf<GuideSession?>(null)

    fun ensure() = scope.launch {
        api.rpc("recCues")?.let { cues = it == "true" }
        readGuide(api.rpc("recGuide"))
        readPast()
    }

    private suspend fun readPast() {
        api.get("/api/recordings")?.let { j ->
            runCatching {
                val a = org.json.JSONArray(j)
                past = (0 until a.length()).mapNotNull { a.optJSONObject(it) }.filter { it.text("end") != null }.take(20).map {
                    PastRun(it.optString("id"), it.text("name") ?: str(R.string.common_run), it.optString("start"), it.optDouble("distance_m", 0.0) / 1000, it.optInt("moving_s"), it.optJSONObject("strava")?.optString("status"))
                }
            }
        }
    }

    private fun run(label: String, name: String, args: JSONObject = JSONObject(), after: suspend (String) -> Unit = {}) {
        busy = label
        scope.launch { api.call(name, args).fold({ after(it) }, { said = it.message }); busy = null }
    }

    fun start() = run("start", "recStart")
    fun pause() = run("pause", "recPause")
    fun resume() = run("resume", "recResume")
    fun finish() = run("finish", "recFinish")
    fun heart() = run("heart", "recHeart")
    private fun readGuide(json: String?) {
        val o = json?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return
        guideOn = o.optBoolean("on", true)
        session = o.optJSONObject("session")?.let { GuideSession(it.optString("name"), it.optInt("steps"), it.optString("first")) }
    }
    fun guide(on: Boolean) { guideOn = on; scope.launch { readGuide(api.rpc("recGuide", JSONObject().put("on", on))) } }
    fun lap() = run("lap", "recLap")
    fun voice(on: Boolean) { cues = on; scope.launch { api.call("recCues", JSONObject().put("on", on)) } }
    fun keep(name: String, strava: Boolean) = run("keep", "recKeep", JSONObject().put("name", name).put("strava", strava)) { r -> JSONObject(r).text("said")?.let { said = it }; readPast() }
    fun discard() = run("discard", "recDiscard")
    fun upload(id: String) = run(id, "recUpload", JSONObject().put("id", id)) { r -> said = runCatching { org.json.JSONArray("[$r]").optString(0) }.getOrNull(); readPast() }
}

private fun pace(mps: Double): String {
    if (mps <= 0.3) return "–:––"
    val s = Math.round(1000 / mps).toInt()
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
}

/** Record, native: a run with the phone's GPS (the page records it; this draws it). */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun RecordScreen(m: RecordModel, back: () -> Unit, navSpace: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    LaunchedEffect(Unit) { m.ensure() }
    val r = m.rec ?: RecNow("idle", null, null, emptyList(), null, 0.0, null, null, null, null, null, null, null, 0.0)
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(r.status) { while (r.status == "recording") { now = System.currentTimeMillis(); delay(1000) } }
    Box(Modifier.fillMaxSize().background(cs.surface)) {
        Column(
            Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = top + 60.dp, bottom = bottom + if (navSpace) 104.dp else 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PageHeader(stringResource(R.string.common_record), subtitle = stringResource(R.string.record_a_run_with_your_phone_s))
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(32.dp)).background(cs.surfaceContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                if (r.status == "finished") { Finished(m, r); return@Column }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    when (r.status) {
                        "recording" -> {
                            val pulse by rememberInfiniteTransition(label = "live").animateFloat(1f, 0.3f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "dot")
                            Box(Modifier.size(10.dp).alpha(pulse).clip(CircleShape).background(cs.error))
                            Text(stringResource(R.string.common_recording), style = MaterialTheme.typography.titleMedium, color = cs.error, modifier = Modifier.padding(start = 8.dp))
                        }
                        "paused" -> { Icon(Glyphs["pause"], null, Modifier.size(18.dp), tint = data.watch); Text(stringResource(R.string.common_paused), style = MaterialTheme.typography.titleMedium, color = data.watch, modifier = Modifier.padding(start = 8.dp)) }
                        else -> Text(stringResource(R.string.record_ready_to_record), style = MaterialTheme.typography.titleMedium, color = cs.onSurfaceVariant)
                    }
                }
                r.guide?.takeIf { r.status != "idle" }?.let { g -> GuideCard(g, live = r.status == "recording", busy = m.busy == "lap") { m.lap() } }
                val moving = r.moving(now)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Big(stringResource(R.string.common_time), clock(moving.toInt()), "", Modifier.weight(1f))
                    Big(stringResource(R.string.common_distance), String.format(java.util.Locale.getDefault(), "%.2f", r.distance / 1000), "km", Modifier.weight(1f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Small(stringResource(R.string.common_avg_pace), pace(if (moving > 0) r.distance / moving else 0.0), "/km", Modifier.weight(1f))
                    Small(stringResource(R.string.record_pace_now), if (r.status == "recording") pace(r.nowMps) else "–:––", "/km", Modifier.weight(1f))
                    Small(stringResource(R.string.common_heart_rate), r.bpm?.toString() ?: "–", if (r.bpm != null) "bpm" else "", Modifier.weight(1f))
                }
                when {
                    r.gpsError != null -> Line("warn", r.gpsError, cs.error)
                    r.accuracy == null -> if (r.status == "idle") Line("pin", stringResource(R.string.record_the_gps_starts_with_the_run), cs.onSurfaceVariant) else Row(verticalAlignment = Alignment.CenterVertically) { LoadingIndicator(Modifier.size(22.dp)); Text(stringResource(R.string.record_finding_gps), modifier = Modifier.padding(start = 8.dp)) }
                    else -> Line("pin", if (r.accuracy <= 15) stringResource(R.string.record_gps_good_m, r.accuracy) else if (r.accuracy <= 35) stringResource(R.string.record_gps_fair_m, r.accuracy) else stringResource(R.string.record_weak_gps_m_distance_waits_for, r.accuracy), if (r.accuracy <= 15) data.good else if (r.accuracy <= 35) data.watch else cs.error)
                }
                // Finishing can't be undone: the first tap asks, the second finishes.
                var finishArmed by remember { mutableStateOf(false) }
                LaunchedEffect(finishArmed) { if (finishArmed) { delay(4000); finishArmed = false } }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    when (r.status) {
                        "idle" -> Big2("play", stringResource(R.string.record_start_run), true, m.busy == null, Modifier.weight(1f)) { m.start() }
                        else -> {
                            if (r.status == "recording") Big2("pause", stringResource(R.string.common_pause), true, true, Modifier.weight(1f)) { m.pause() }
                            else Big2("play", stringResource(R.string.common_resume), true, true, Modifier.weight(1f)) { m.resume() }
                            Big2("stop", if (finishArmed) stringResource(R.string.record_tap_to_finish) else stringResource(R.string.common_finish), false, m.busy == null, Modifier.weight(1f)) { if (finishArmed) { finishArmed = false; m.finish() } else finishArmed = true }
                        }
                    }
                }
                FilledTonalButton(onClick = { m.heart() }, enabled = m.busy != "heart") { Icon(Glyphs["heart"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(r.hrName ?: stringResource(R.string.record_connect_heart_rate), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) }
                if (r.status == "idle") m.session?.let { ses ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.record_guide_me_through, ses.name.replace(Regex("^\\w{3} "), "")), style = MaterialTheme.typography.labelLarge)
                            Text(if (ses.steps > 1) stringResource(R.string.record_step_by_step_more, ses.first, ses.steps - 1) else stringResource(R.string.record_step_by_step, ses.first), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                        }
                        Switch(m.guideOn, { m.guide(it) }, Modifier.padding(start = 12.dp))
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.record_voice_cues), style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                    Switch(m.cues, { m.voice(it) })
                }
                if (r.status == "idle") Text(stringResource(R.string.record_keeps_recording_with_the_screen_off), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
            Past(m)
        }
        Said(m.said, { m.said = null }, Modifier.align(Alignment.BottomCenter).padding(bottom = bottom + if (navSpace) 88.dp else 8.dp))
    }
}

@Composable
private fun Big(label: String, value: String, unit: String, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
        Row(verticalAlignment = Alignment.Bottom) {
            Text(value, fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 56.sp, lineHeight = 56.sp)
            if (unit.isNotEmpty()) Text(" $unit", style = MaterialTheme.typography.titleMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
        }
    }
}

@Composable
private fun Small(label: String, value: String, unit: String, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.clip(RoundedCornerShape(18.dp)).background(cs.surfaceContainerHigh).padding(12.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant)
        Row(verticalAlignment = Alignment.Bottom) {
            Text(value, fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 28.sp, lineHeight = 30.sp)
            if (unit.isNotEmpty()) Text(" $unit", style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
        }
    }
}

@Composable
private fun Line(icon: String, text: String, tint: androidx.compose.ui.graphics.Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Glyphs[icon], null, Modifier.size(16.dp), tint = tint)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = tint, modifier = Modifier.padding(start = 8.dp))
    }
}

/** A big control: start, pause, resume, finish. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Big2(icon: String, label: String, filled: Boolean, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val content: @Composable () -> Unit = { Icon(Glyphs[icon], null, Modifier.size(22.dp)); Spacer(Modifier.width(8.dp)); Text(label, style = MaterialTheme.typography.titleMedium) }
    if (filled) Button(onClick = onClick, enabled = enabled, modifier = modifier.height(64.dp), shapes = ButtonDefaults.shapes()) { content() }
    else FilledTonalButton(onClick = onClick, enabled = enabled, modifier = modifier.height(64.dp), shapes = ButtonDefaults.shapes()) { content() }
}

/** Finished: the run's numbers, its name, Send to Strava, Save or Discard. */
@Composable
private fun Finished(m: RecordModel, r: RecNow) {
    val cs = MaterialTheme.colorScheme
    var name by remember(r.name) { mutableStateOf(r.name ?: "") }
    var strava by remember { mutableStateOf(true) }
    var asking by remember { mutableStateOf(false) }
    Line("check", stringResource(R.string.record_finished), LocalData.current.good)
    val moving = r.movingS ?: r.moving(System.currentTimeMillis()).toInt()
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Big(stringResource(R.string.common_time), clock(moving), "", Modifier.weight(1f))
        Big(stringResource(R.string.common_distance), String.format(java.util.Locale.getDefault(), "%.2f", r.distance / 1000), "km", Modifier.weight(1f))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Small(stringResource(R.string.common_avg_pace), pace(if (moving > 0) r.distance / moving else 0.0), "/km", Modifier.weight(1f))
        Small(stringResource(R.string.common_climb), r.elevation?.let { "${Math.round(it)}" } ?: "–", "m", Modifier.weight(1f))
        Small(stringResource(R.string.common_avg_heart_rate), r.avgHr?.toString() ?: "–", if (r.avgHr != null) "bpm" else "", Modifier.weight(1f))
    }
    Field(stringResource(R.string.common_name), name, { name = it.take(80) })
    SwitchRow(stringResource(R.string.record_send_to_strava), stringResource(R.string.record_once_it_s_saved_it_joins), strava) { strava = it }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { m.keep(name, strava) }, enabled = m.busy == null) { Icon(Glyphs["check"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.common_save)) }
        TextButton(onClick = { asking = true }) { Text(stringResource(R.string.record_discard), color = cs.error) }
    }
    if (asking) AlertDialog(
        onDismissRequest = { asking = false },
        title = { Text(stringResource(R.string.record_discard_this_run)) },
        text = { Text(stringResource(R.string.record_it_won_t_be_saved_anywhere)) },
        confirmButton = { TextButton(onClick = { asking = false; m.discard() }) { Text(stringResource(R.string.record_discard)) } },
        dismissButton = { TextButton(onClick = { asking = false }) { Text(stringResource(R.string.record_keep_it)) } },
    )
}

/** The runs recorded on this phone, with Send to Strava where it's not there yet. */
@Composable
private fun Past(m: RecordModel) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.common_recorded_on_this_phone), style = MaterialTheme.typography.titleLarge)
        val list = m.past ?: return@Column
        if (list.isEmpty()) { Text(stringResource(R.string.record_runs_you_record_here_appear_in), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant); return@Column }
        list.forEach { p ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(p.name, style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(R.string.record_pending_line, dateShort(p.start), String.format(java.util.Locale.getDefault(), "%.2f", p.km), clock(p.movingS)), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                }
                when (p.strava) {
                    "done" -> Text(stringResource(R.string.common_on_strava), style = MaterialTheme.typography.labelMedium, color = data.good, modifier = Modifier.clip(CircleShape).background(data.goodContainer).padding(horizontal = 10.dp, vertical = 4.dp))
                    else -> FilledTonalButton(onClick = { m.upload(p.id) }, enabled = m.busy == null) { Text(if (p.strava == "error") stringResource(R.string.common_try_again) else stringResource(R.string.record_send_to_strava)) }
                }
            }
        }
    }
}

/** A guided run's step: what it is, what's left, what comes next, and Next step. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun GuideCard(g: GuideNow, live: Boolean, busy: Boolean, next: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val tint = kindColour(when (g.kind) { "run" -> "intervals"; "recover" -> "easy"; else -> "long" })
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(cs.surfaceContainerHigh).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(if (g.done) g.name else stringResource(R.string.record_step_of, g.name, g.index + 1, g.total), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
        Row(verticalAlignment = Alignment.Bottom) {
            Text(g.label, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            g.left?.let { Text(it, style = MaterialTheme.typography.titleMedium, color = tint) }
        }
        Text(g.detail, style = MaterialTheme.typography.bodyLarge)
        androidx.compose.material3.LinearProgressIndicator(progress = { g.share }, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), color = tint, trackColor = cs.surfaceContainerHighest)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(g.next?.let { stringResource(R.string.record_then, it) } ?: if (g.done) "" else stringResource(R.string.record_the_last_step), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, modifier = Modifier.weight(1f))
            if (!g.done && live) FilledTonalButton(onClick = next, enabled = !busy, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.record_next_step)) }
        }
    }
}
