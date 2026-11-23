package dev.freesuunto.app.shell

import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** One set as logged. */
data class LiftSet(val done: Boolean, val reps: Int?, val seconds: Int?, val kg: Double?)

/** What the next step is for an exercise (src/strength/log.ts Target). */
data class LiftTarget(val name: String, val loaded: Boolean, val rule: String, val why: String, val last: String?, val restS: Int)

/** One exercise in the log: its dose, its sets, and how many reps were left after the last. */
class LiftEx(val id: String, val target: JSONObject, val sets: androidx.compose.runtime.snapshots.SnapshotStateList<LiftSet>, rir: Int?) {
    var rir by mutableStateOf(rir)
    val timed get() = target.has("seconds") && !target.has("reps")
    val allDone get() = sets.isNotEmpty() && sets.all { it.done }
}

/** The finished session (src/strength/log.ts Summary). */
data class LiftSummary(val minutes: Int, val sets: Int, val volume: Int, val prs: List<Triple<String, String, String>>, val next: List<List<String>>)

private val RULE get() = mapOf("start" to str(R.string.lift_first_time), "add" to str(R.string.lift_more_weight), "more reps" to str(R.string.lift_a_rep_more), "longer" to str(R.string.common_longer), "hold" to str(R.string.common_same_again), "ease" to str(R.string.lift_lighter))
private fun kg(x: Double) = if (x == Math.rint(x)) str(R.string.lift_kg, x.toInt()) else str(R.string.lift_kg_decimal, String.format(java.util.Locale.getDefault(), "%.1f", x))
private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }

/** "3 × 10 at 40 kg" for a target. */
fun doseOf(t: JSONObject) = str(R.string.lift_dose, t.optInt("sets"), if (t.has("reps")) t.optInt("reps").toString() else str(R.string.lift_dose_seconds, t.optInt("seconds"))) + (if (t.optBoolean("each_side")) str(R.string.lift_each_side) else "") + (if (t.has("kg") && !t.isNull("kg")) str(R.string.lift_at_kg, kg(t.optDouble("kg"))) else "")

/**
 * #lift/<date>, native (web/views/lift.ts): a strength session as you lift it. Each exercise with
 * its sets filled in from last time and the next step with why; tick a set and the rest counts
 * down (a notification when it's over); how many reps were left; Finish: records, next time.
 */
class LiftModel(private val scope: CoroutineScope, val api: SettingsApi, val date: String) {
    var title by mutableStateOf("")
    var isToday by mutableStateOf(false)
    val exercises = mutableStateListOf<LiftEx>()
    val targets = mutableStateMapOf<String, LiftTarget>()
    var started by mutableStateOf<String?>(null)
    var finishedAt by mutableStateOf<String?>(null)
    var open by mutableStateOf(0)
    var loaded by mutableStateOf(false)
    var summary by mutableStateOf<LiftSummary?>(null)
    var fromWatch by mutableStateOf<Pair<String, List<Pair<String, Int>>>?>(null)
    var said by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    var catalog by mutableStateOf<Map<String, Routine.Exercise>>(emptyMap())
    val thumbs = mutableStateMapOf<String, Frames>()
    // The rest between sets.
    var restEnd by mutableLongStateOf(0L)
    var restFor by mutableStateOf(0)
    var restNext by mutableStateOf("")
    var restGo by mutableStateOf(false)
    private var saving: Job? = null

    val doneCount get() = exercises.count { it.allDone }

    fun load() = scope.launch {
        val j = api.get("/api/lifts/session?date=${java.net.URLEncoder.encode(date, "UTF-8")}") ?: run { said = str(R.string.lift_couldn_t_open_this_session); return@launch }
        val s = JSONObject(j)
        title = s.optString("title")
        isToday = s.optString("date") == java.time.LocalDate.now().toString()
        val ts = s.optJSONArray("targets")
        for (i in 0 until (ts?.length() ?: 0)) ts!!.optJSONObject(i)?.let { t ->
            targets[t.optString("id")] = LiftTarget(t.optString("name"), t.optBoolean("loaded"), t.optString("rule"), t.optString("why"), t.optJSONObject("last")?.let { l -> "${l.optString("text")} · ${dateShort(l.optString("date"))}" }, t.optInt("rest_s", 90))
        }
        val log = s.optJSONObject("log")
        exercises.clear()
        if (log != null) {
            started = log.text("started"); finishedAt = log.text("finished")
            val es = log.optJSONArray("exercises")
            for (i in 0 until (es?.length() ?: 0)) es!!.optJSONObject(i)?.let { e ->
                val sets = e.optJSONArray("sets")
                exercises.add(LiftEx(e.optString("id"), e.optJSONObject("target") ?: JSONObject(), mutableStateListOf<LiftSet>().apply {
                    for (k in 0 until (sets?.length() ?: 0)) sets!!.optJSONObject(k)?.let { x -> add(LiftSet(x.optBoolean("done"), x.takeIf { it.has("reps") }?.optInt("reps"), x.takeIf { it.has("seconds") }?.optInt("seconds"), x.takeIf { it.has("kg") && !it.isNull("kg") }?.optDouble("kg"))) }
                }, if (e.has("rir")) e.optInt("rir") else null))
            }
        } else for (i in 0 until (ts?.length() ?: 0)) ts!!.optJSONObject(i)?.let { t ->
            val target = JSONObject().put("sets", t.optInt("sets"))
            if (t.has("reps")) target.put("reps", t.optInt("reps"))
            if (t.has("seconds")) target.put("seconds", t.optInt("seconds"))
            if (t.has("kg") && !t.isNull("kg")) target.put("kg", t.optDouble("kg"))
            if (t.optBoolean("each_side")) target.put("each_side", true)
            exercises.add(LiftEx(t.optString("id"), target, mutableStateListOf<LiftSet>().apply {
                repeat(t.optInt("sets")) { add(LiftSet(false, t.takeIf { it.has("reps") }?.optInt("reps"), if (t.has("reps")) null else t.optInt("seconds"), t.takeIf { it.has("kg") && !it.isNull("kg") }?.optDouble("kg"))) }
            }, null))
        }
        open = exercises.indexOfFirst { e -> e.sets.any { !it.done } }.coerceAtLeast(0)
        loaded = true
        // Done on the watch as a guided workout: offered to tick in one go.
        if (finishedAt == null && exercises.none { e -> e.sets.any { it.done } }) api.get("/api/lifts/from-watch?date=$date")?.takeIf { it != "null" }?.let { w ->
            runCatching {
                val o = JSONObject(w)
                val a = o.optJSONArray("sets")
                val sets = (0 until (a?.length() ?: 0)).mapNotNull { a!!.optJSONObject(it) }.map { it.optString("id") to it.optInt("done") }
                val total = sets.sumOf { (id, n) -> minOf(n, exercises.firstOrNull { it.id == id }?.sets?.size ?: 0) }
                if (total > 0) fromWatch = plural(R.plurals.lift_from_watch_sets, total, total, o.optJSONObject("activity")?.optString("name").toString(), o.optJSONObject("activity")?.optInt("minutes").toString()) to sets
            }
        }
        api.rpc("exercises")?.let { runCatching { catalog = parseRoutine(JSONObject().put("items", JSONObject(it).optJSONArray("items")).toString()).items.associateBy { e -> e.id } } }
        for (e in exercises) catalog[e.id]?.let { c -> bodyFrames(api, JSONObject().put("exercise", c.id).put("primary", JSONArray(c.primary)).put("secondary", JSONArray(c.secondary)).put("width", 144).put("height", 120).put("loop", 1))?.let { thumbs[c.id] = it } ?: return@launch }
    }

    private fun logJson() = JSONObject().apply {
        put("date", date); put("title", title); put("started", started ?: "")
        finishedAt?.let { put("finished", it) }
        put("exercises", JSONArray().apply {
            exercises.forEach { e ->
                put(JSONObject().apply {
                    put("id", e.id); put("target", e.target)
                    put("sets", JSONArray().apply { e.sets.forEach { s -> put(JSONObject().put("done", s.done).apply { s.reps?.let { put("reps", it) }; s.seconds?.let { put("seconds", it) }; s.kg?.let { put("kg", it) } }) } })
                    e.rir?.let { put("rir", it) }
                })
            }
        })
    }

    /** Saved as you go (after the first ticked set), so closing the app loses nothing. */
    fun save() {
        if (started == null) return
        saving?.cancel()
        saving = scope.launch { delay(500); api.send("/api/lifts", "PUT", logJson().toString()) }
    }

    fun tick(i: Int, k: Int) {
        val e = exercises[i]
        val s = e.sets[k]
        e.sets[k] = s.copy(done = !s.done)
        if (!s.done) {
            if (started == null) started = java.time.Instant.now().toString()
            // Rest before the next set (or the next exercise), not after the very last.
            val nextSet = e.sets.indexOfFirst { !it.done }
            val nextEx = exercises.withIndex().firstOrNull { (j, x) -> j > i && x.sets.any { !it.done } }
            val label = if (nextSet >= 0) str(R.string.lift_then_set, nextSet + 1) else nextEx?.let { str(R.string.lift_then, (targets[it.value.id]?.name ?: it.value.id).lowercase()) } ?: ""
            if (label.isNotEmpty()) rest(targets[e.id]?.restS ?: 90, label) else stopRest()
        }
        save()
    }

    fun setValue(i: Int, k: Int, kg: Double? = null, reps: Int? = null, seconds: Int? = null) {
        val e = exercises[i]; val s = e.sets[k]
        e.sets[k] = s.copy(kg = kg ?: s.kg, reps = reps ?: s.reps, seconds = seconds ?: s.seconds)
        save()
    }

    fun addSet(i: Int) { val e = exercises[i]; val l = e.sets.lastOrNull(); e.sets.add(LiftSet(false, l?.reps, l?.seconds, l?.kg)) }

    fun setRir(i: Int, v: Int) {
        exercises[i].rir = v
        save()
        exercises.indexOfFirst { e -> e.sets.any { !it.done } }.takeIf { it >= 0 }?.let { open = it }
    }

    fun rest(seconds: Int, next: String) {
        restFor = seconds; restEnd = System.currentTimeMillis() + seconds * 1000L; restNext = next; restGo = false
        scope.launch { api.call("restNote", JSONObject().put("at", restEnd).put("next", next)) }
    }
    fun shiftRest(d: Int) { restEnd += d * 1000L; restFor = maxOf(restFor + d, 1); scope.launch { api.call("restNote", JSONObject().put("at", restEnd).put("next", restNext)) } }
    fun stopRest() { restEnd = 0L; restGo = false; scope.launch { api.call("restNote") } }

    fun tickFromWatch() {
        val w = fromWatch ?: return
        for ((id, n) in w.second) exercises.firstOrNull { it.id == id }?.let { e -> for (k in 0 until minOf(n, e.sets.size)) e.sets[k] = e.sets[k].copy(done = true) }
        if (started == null) started = java.time.Instant.now().toString()
        open = exercises.indexOfFirst { e -> e.sets.any { !it.done } }.coerceAtLeast(0)
        fromWatch = null
        save()
    }

    /** Finish: the plan's session ticks off; the summary with records and next time. */
    suspend fun finish(): Boolean {
        stopRest()
        finishedAt = finishedAt ?: java.time.Instant.now().toString()
        busy = true
        saving?.cancel()
        val (st, text) = api.send("/api/lifts", "PUT", logJson().toString())
        busy = false
        val r = runCatching { JSONObject(text) }.getOrNull()
        val s = r?.optJSONObject("summary") ?: run { said = str(R.string.lift_not_saved, r?.text("error") ?: st.toString()); return false }
        val prs = s.optJSONArray("prs"); val next = s.optJSONArray("next")
        summary = LiftSummary(
            s.optInt("minutes"), s.optInt("sets"), s.optInt("volume_kg"),
            (0 until (prs?.length() ?: 0)).mapNotNull { prs!!.optJSONObject(it) }.map { Triple(it.optString("name"), it.optString("text"), it.optString("before")) },
            (0 until (next?.length() ?: 0)).mapNotNull { next!!.optJSONObject(it) }.map { listOf(it.optString("name"), it.optString("last"), it.optString("next"), it.optString("why")) },
        )
        return true
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun LiftScreen(m: LiftModel, back: () -> Unit, done: () -> Unit, navSpace: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    LaunchedEffect(m) { if (!m.loaded) m.load() }
    var how by remember { mutableStateOf<Routine.Exercise?>(null) }
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(armed) { if (armed) { delay(6000); armed = false } }
    Box(Modifier.fillMaxSize().background(cs.surface)) {
        Column(
            Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = top + 60.dp, bottom = bottom + if (navSpace) 200.dp else 120.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            PageHeader(m.title.ifEmpty { stringResource(R.string.common_strength) }, subtitle = stringResource(R.string.lift_progress, if (m.isToday) stringResource(R.string.lift_today) else dateShort(m.date), m.doneCount, m.exercises.size))
            if (!m.loaded) { Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) { LoadingIndicator() }; return@Column }
            m.fromWatch?.let { (line, _) ->
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.secondaryContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) { Icon(Glyphs["watch"], null, Modifier.size(20.dp)); Text(stringResource(R.string.lift_done_on_your_watch), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 8.dp)) }
                    Text(line, style = MaterialTheme.typography.bodyMedium)
                    Text(stringResource(R.string.lift_the_watch_doesn_t_count_reps), style = MaterialTheme.typography.bodySmall)
                    ButtonFlow {
                        Button(onClick = { m.tickFromWatch() }) { ButtonText(stringResource(R.string.lift_tick_the_sets)) }
                        TextButton(onClick = { m.fromWatch = null }) { ButtonText(stringResource(R.string.common_not_now)) }
                    }
                }
            }
            m.exercises.forEachIndexed { i, e -> ExerciseCard(m, i, e) { c -> how = c } }
        }
        // The rest, and Finish, under the thumb.
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = bottom + if (navSpace) 92.dp else 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Rest(m)
            if (armed) {
                val left = m.exercises.size - m.doneCount
                Text(pluralStringResource(R.plurals.lift_not_done_finish, left, left), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
            Button(onClick = {
                if (m.exercises.none { e -> e.sets.any { it.done } }) return@Button back()
                val left = m.exercises.size - m.doneCount
                if (left > 0 && m.finishedAt == null && !armed) { armed = true; return@Button }
                armed = false
                scope.launch { if (m.finish()) view.feel(Haptic.Confirm) }
            }, enabled = m.loaded && !m.busy, modifier = Modifier.fillMaxWidth().height(56.dp), shapes = ButtonDefaults.shapes()) {
                Icon(Glyphs["check"], null, Modifier.size(20.dp)); Spacer(Modifier.width(8.dp))
                Text(if (armed) stringResource(R.string.lift_finish_with_left, m.exercises.size - m.doneCount) else if (m.finishedAt != null) stringResource(R.string.common_save) else stringResource(R.string.common_finish))
            }
        }
        Said(m.said, { m.said = null }, Modifier.align(Alignment.Center))
    }
    how?.let { c -> ExerciseSheet(c, m.api) { how = null } }
    m.summary?.let { s -> LiftDone(s, m.title) { m.summary = null; done() } }
}

/** One exercise: its head (thumbnail, name, dose, sets done); open, the next step, the sets to tick, how many were left. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ExerciseCard(m: LiftModel, i: Int, e: LiftEx, how: (Routine.Exercise) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val view = LocalView.current
    val t = m.targets[e.id]
    val isOpen = m.open == i
    val done = e.sets.count { it.done }
    val loaded = t?.loaded ?: e.sets.any { it.kg != null }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(if (e.allDone && !isOpen) data.goodContainer.copy(alpha = 0.5f) else cs.surfaceContainer).animateContentSize()) {
        Row(Modifier.fillMaxWidth().press(scale = 0.99f, onClick = { m.open = if (isOpen) -1 else i }).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            // The exercise's figure once drawn; until then (or if it can't be) the strength mark, not an empty box.
            Box(Modifier.size(64.dp, 54.dp).clip(RoundedCornerShape(14.dp)).background(cs.surfaceContainerHighest), contentAlignment = Alignment.Center) {
                m.thumbs[e.id]?.loop?.firstOrNull()?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
                    ?: Icon(Glyphs["bolt"], null, Modifier.size(22.dp), tint = cs.onSurfaceVariant.copy(alpha = 0.6f))
            }
            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                Text(t?.name ?: m.catalog[e.id]?.name ?: e.id, style = MaterialTheme.typography.titleMedium)
                Text(doseOf(e.target), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            if (e.allDone) Box(Modifier.size(32.dp).clip(CircleShape).background(data.good), contentAlignment = Alignment.Center) { Icon(Glyphs["check"], stringResource(R.string.common_done), Modifier.size(18.dp), tint = cs.surface) }
            else Text("$done/${e.sets.size}", style = MaterialTheme.typography.titleSmall, color = cs.onSurfaceVariant)
        }
        AnimatedVisibility(isOpen, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (t != null && m.finishedAt == null) Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = cs.primary)) { append(RULE[t.rule] ?: t.rule) }; append(" ${t.why}") }, style = MaterialTheme.typography.bodyMedium)
                t?.last?.let { Text(stringResource(R.string.lift_last_time, it), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
                e.sets.forEachIndexed { k, s ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(if (s.done) data.goodContainer else cs.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("${k + 1}", style = MaterialTheme.typography.titleMedium, color = cs.onSurfaceVariant, modifier = Modifier.width(24.dp))
                        if (loaded) Num(s.kg?.let { if (it == Math.rint(it)) "${it.toInt()}" else "$it" } ?: "", "kg", Modifier.weight(1f)) { v -> v.replace(",", ".").toDoubleOrNull()?.let { m.setValue(i, k, kg = it) } }
                        Num((if (e.timed) s.seconds else s.reps)?.toString() ?: "", if (e.timed) stringResource(R.string.lift_s) else stringResource(R.string.lift_reps), Modifier.weight(1f)) { v -> v.toIntOrNull()?.let { if (e.timed) m.setValue(i, k, seconds = it) else m.setValue(i, k, reps = it) } }
                        Box(
                            Modifier.size(48.dp).press(scale = 0.88f, label = stringResource(R.string.lift_set_done, k + 1), onClick = { view.feel(if (s.done) Haptic.Detent else Haptic.Confirm); m.tick(i, k) })
                                .clip(CircleShape).background(if (s.done) data.good else cs.surfaceContainerHighest),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Glyphs["check"], null, Modifier.size(22.dp), tint = if (s.done) cs.surface else cs.onSurfaceVariant) }
                    }
                }
                ButtonFlow(gap = 0.dp) {
                    TextButton(onClick = { m.addSet(i) }) { Icon(Glyphs["plus"], null, Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); ButtonText(stringResource(R.string.lift_add_a_set)) }
                    m.catalog[e.id]?.let { c -> TextButton(onClick = { how(c) }) { ButtonText(stringResource(R.string.lift_how_to_do_it)) } }
                }
                if (e.allDone) {
                    Text(if (e.timed) stringResource(R.string.lift_how_much_longer_could_you_have) else stringResource(R.string.lift_how_many_more_reps_could_you), style = MaterialTheme.typography.bodyMedium)
                    Segmented(listOf("0", "1", "2", "3+"), e.rir ?: -1, { m.setRir(i, it) })
                }
            }
        }
    }
}

/** A number in a set: kg, reps or seconds, typed in place. */
@Composable
private fun Num(value: String, unit: String, modifier: Modifier, put: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var text by remember(value) { mutableStateOf(value) }
    Row(modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        BasicTextField(
            text, { text = it.filter { c -> c.isDigit() || c == '.' || c == ',' }.take(5); put(text) },
            // 48dp tall, for a thumb between sets; the numbers in the timing board's figures.
            Modifier.width(60.dp).heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp)).background(cs.raised).padding(horizontal = 10.dp, vertical = 10.dp),
            singleLine = true, textStyle = Figure.S.copy(color = cs.onSurface, textAlign = TextAlign.End),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), cursorBrush = SolidColor(cs.primary),
        )
        Text(unit, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
    }
}

/** The rest: a bar running down, −15/+15, Skip; then Go. */
@Composable
private fun Rest(m: LiftModel) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(m.restEnd) {
        while (m.restEnd > 0) {
            now = System.currentTimeMillis()
            if (now >= m.restEnd) { m.restGo = true; view.feel(Haptic.Confirm); delay(4000); m.restGo = false; m.restEnd = 0; break }
            delay(250)
        }
    }
    AnimatedVisibility(m.restEnd > 0, enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
        val left = ((m.restEnd - now) / 1000).toInt().coerceAtLeast(0)
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(if (m.restGo) LocalData.current.goodContainer else cs.inverseSurface).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (m.restGo) stringResource(R.string.lift_go) else "${left / 60}:${(left % 60).toString().padStart(2, '0')}", fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 40.sp, lineHeight = 40.sp, color = if (m.restGo) LocalData.current.good else cs.inverseOnSurface)
                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                    if (!m.restGo) Text(stringResource(R.string.common_rest), style = MaterialTheme.typography.labelMedium, color = cs.inverseOnSurface.copy(alpha = 0.7f))
                    Text(if (m.restGo) m.restNext.removePrefix("Then ").replaceFirstChar { it.uppercase() } else m.restNext, style = MaterialTheme.typography.titleSmall, color = if (m.restGo) cs.onSurface else cs.inverseOnSurface)
                }
                if (!m.restGo) {
                    TextButton(onClick = { m.shiftRest(-15) }) { Text("−15", color = cs.inverseOnSurface) }
                    TextButton(onClick = { m.shiftRest(15) }) { Text("+15", color = cs.inverseOnSurface) }
                    TextButton(onClick = { m.stopRest() }) { Text(stringResource(R.string.lift_skip), color = cs.inversePrimary) }
                }
            }
            if (!m.restGo) LinearProgressIndicator(progress = { 1f - left.toFloat() / maxOf(1, m.restFor) }, modifier = Modifier.fillMaxWidth(), color = cs.inversePrimary, trackColor = cs.inverseOnSurface.copy(alpha = 0.2f))
        }
    }
}

/** Finished: how much, the records, and next time for each exercise. */
@Composable
private fun LiftDone(s: LiftSummary, title: String, close: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Sheet(close) { hide ->
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(start = 16.dp, end = 16.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (s.prs.isNotEmpty()) (if (s.prs.size == 1) stringResource(R.string.lift_a_record_today) else stringResource(R.string.lift_records_today, s.prs.size)) else stringResource(R.string.lift_session_done), style = MaterialTheme.typography.headlineSmall)
            Text(title, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOfNotNull(stringResource(R.string.common_min, s.minutes) to stringResource(R.string.common_time), "${s.sets}" to stringResource(R.string.lift_sets), if (s.volume > 0) stringResource(R.string.lift_kg_decimal, String.format(java.util.Locale.getDefault(), "%,d", s.volume)) to stringResource(R.string.lift_lifted) else null).forEach { (v, k) ->
                    Column(Modifier.weight(1f).clip(RoundedCornerShape(18.dp)).background(cs.surfaceContainer).padding(12.dp)) {
                        Text(v, style = MaterialTheme.typography.titleLarge.copy(fontFamily = FlexRound))
                        Text(k, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant)
                    }
                }
            }
            s.prs.forEach { (n, text, before) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(32.dp).clip(CircleShape).background(LocalData.current.goodContainer), contentAlignment = Alignment.Center) { Icon(Glyphs["spark"], null, Modifier.size(16.dp), tint = LocalData.current.good) }
                    Column(Modifier.padding(start = 10.dp)) { Text(n, style = MaterialTheme.typography.titleSmall); Text(stringResource(R.string.lift_was, text, before), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
                }
            }
            if (s.next.isNotEmpty()) Text(stringResource(R.string.lift_next_time), style = MaterialTheme.typography.titleLarge)
            s.next.forEach { (n, last, next, why) ->
                Column {
                    Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(n) }; append("  $last → "); withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = cs.primary)) { append(next) } }, style = MaterialTheme.typography.bodyMedium)
                    Text(why, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                }
            }
            Text(stringResource(R.string.lift_next_time_s_weights_are_on), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            Button(onClick = hide, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.common_done)) }
        }
    }
}
