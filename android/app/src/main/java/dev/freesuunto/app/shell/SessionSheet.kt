package dev.freesuunto.app.shell

import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs

private val CARD = RoundedCornerShape(28.dp)

/** A sheet the native way: up from the bottom at full height, down by a pull or back. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Sheet(onClose: () -> Unit, full: Boolean = false, content: @Composable (close: () -> Unit) -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val close: () -> Unit = { scope.launch { state.hide() }.invokeOnCompletion { onClose() } }
    ModalBottomSheet(onDismissRequest = onClose, sheetState = state, modifier = Modifier.statusBarsPadding(), containerColor = MaterialTheme.colorScheme.surface, contentWindowInsets = { androidx.compose.foundation.layout.WindowInsets(0) }) {
        // Full: the whole height from the start, for what arrives after it opens (no jump).
        if (full) Box(Modifier.fillMaxHeight()) { content(close) } else content(close)
    }
}

/**
 * A planned session (web/views/plan.ts openSession): what, how much, the target, the blocks of a
 * structured run, the coach's notes, a strength routine with the body at work, how it went
 * against the plan once done, and Mark done / Ask your coach.
 */
@Composable
fun SessionSheet(m: SessionModel, actions: SessionActions, onClose: (said: String?) -> Unit) {
    Sheet({ onClose(null) }, full = true) { close ->
        LaunchedEffect(m.done) { if (m.done) { close(); onClose(m.said) } }
        Box(Modifier.fillMaxWidth()) {
            SessionBody(m, actions, close, Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding())
            Said(m.said.takeUnless { m.done }, { m.said = null }, Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalLayoutApi::class)
@Composable
fun SessionBody(m: SessionModel, actions: SessionActions, close: () -> Unit, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    var exercise by remember { mutableStateOf<Routine.Exercise?>(null) }
    val phase = if (m.missing) "missing" else if (m.session == null) "loading" else "ready"
    AnimatedContent(phase, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "session") { p ->
        Column(modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val s = m.session
            when {
                p == "missing" -> {
                    Text(stringResource(R.string.session_this_session_isn_t_on_the), style = MaterialTheme.typography.titleLarge)
                    FilledTonalButton(onClick = close) { Text(stringResource(R.string.common_close)) }
                }
                p == "loading" || s == null -> Box(Modifier.fillMaxWidth().height(260.dp), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(56.dp)) }
                else -> {
                    val kc = kindColour(s.kind)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(Modifier.size(14.dp).clip(CircleShape).background(kc))
                        Column(Modifier.weight(1f)) {
                            Text(s.title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                            Text(listOfNotNull(s.whenText, kindWord(s.kind, s.title)).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                        }
                        FilledTonalIconButton(onClick = close) { Icon(Glyphs["close"], stringResource(R.string.common_close)) }
                    }
                    // The weather expected then, one line in words under the title (as a workout's sheet has its own).
                    s.weather?.let { WeatherSentence(it, Modifier.padding(start = 26.dp)) }
                    val stats = listOfNotNull(s.minutes?.let { stringResource(R.string.session_time) to duration(it) }, s.km?.let { stringResource(R.string.session_distance) to stringResource(R.string.common_n_km, km(it)) })
                    if (stats.isNotEmpty()) Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        stats.forEachIndexed { i, (k, v) ->
                            val shape = RoundedCornerShape(if (i == 0) 24.dp else 8.dp, if (i == stats.lastIndex) 24.dp else 8.dp, if (i == stats.lastIndex) 24.dp else 8.dp, if (i == 0) 24.dp else 8.dp)
                            Column(Modifier.weight(1f).fillMaxHeight().clip(shape).background(cs.surfaceContainer).padding(horizontal = 16.dp, vertical = 12.dp)) {
                                Text(k, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant)
                                Text(v, style = Figure.M)
                            }
                        }
                    }
                    s.target?.let { t ->
                        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(kc.copy(alpha = 0.14f)).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.common_target), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant, modifier = Modifier.width(64.dp))
                            Text(tidyTarget(t), style = MaterialTheme.typography.titleMedium)
                        }
                    }
                    s.adjusted?.let { (shift, reason) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Glyphs["spark"], null, Modifier.size(16.dp), tint = cs.primary)
                            Text(stringResource(if (shift < 0) R.string.session_faster_than_planned else R.string.session_easier_than_planned, abs(shift), reason.substringBefore(":").lowercase()), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).padding(start = 8.dp))
                            TextButton(onClick = { m.undoAdjust() }, enabled = !m.busy) { Text(stringResource(R.string.common_undo)) }
                        }
                    }
                    if (s.steps.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        s.steps.forEachIndexed { i, (rep, text) ->
                            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(if (i == 0) 20.dp else 6.dp, if (i == 0) 20.dp else 6.dp, if (i == s.steps.lastIndex) 20.dp else 6.dp, if (i == s.steps.lastIndex) 20.dp else 6.dp)).background(cs.surfaceContainer).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("${i + 1}", style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant, modifier = Modifier.width(22.dp))
                                if (rep > 1) Text("$rep ×", style = MaterialTheme.typography.titleSmall, color = kc, modifier = Modifier.padding(end = 8.dp))
                                Text(text, style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                    }
                    s.notes?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
                    if (s.strength) Strength(m) { exercise = it }
                    s.did?.let { did ->
                        Row(
                            Modifier.fillMaxWidth().press(scale = 0.98f, onClick = { close(); actions.openWorkout(s.activityId!!) }).clip(RoundedCornerShape(20.dp)).background(LocalData.current.goodContainer).padding(horizontal = 16.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Glyphs["check"], null, Modifier.size(18.dp), tint = LocalData.current.good)
                            Text(did, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f).padding(start = 10.dp))
                            Icon(Glyphs["chevron"], null, Modifier.size(18.dp))
                        }
                    }
                    if (s.manual) Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Glyphs["check"], null, Modifier.size(16.dp), tint = LocalData.current.good)
                        Text(stringResource(R.string.common_marked_done_by_you), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).padding(start = 8.dp))
                        TextButton(onClick = { m.mark(false) }, enabled = !m.busy) { Text(stringResource(R.string.common_undo)) }
                    }
                    m.review?.let { ReviewCard(it) }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (s.liftable) Button(onClick = { close(); actions.go("lift/${s.date}") }, shapes = ButtonDefaults.shapes()) {
                            Icon(Glyphs[if (s.lift?.first == true) "check" else "bolt"], null, Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(s.lift?.let { (fin, prs) -> if (fin) (if (prs > 0) pluralStringResource(R.plurals.session_logged_records, prs, prs) else stringResource(R.string.session_logged)) else stringResource(R.string.common_continue) } ?: if (s.status == "done") stringResource(R.string.session_log_the_sets) else stringResource(R.string.common_start))
                        }
                        if (s.canMark) {
                            if (s.liftable) TextButton(onClick = { m.mark(true) }, enabled = !m.busy) { Text(stringResource(R.string.session_mark_done_without_logging)) }
                            else Button(onClick = { m.mark(true) }, enabled = !m.busy, shapes = ButtonDefaults.shapes()) { Icon(Glyphs["check"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.common_mark_done)) }
                        }
                        val ask: () -> Unit = { close(); actions.chat(s.conversation, str(R.string.session_about, dayName(s.date), dateShort(s.date), s.title)) }
                        FilledTonalButton(onClick = ask, shapes = ButtonDefaults.shapes()) { Icon(Glyphs["coach"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.common_ask_your_coach)) }
                        // For any watch's app: the session as a .fit workout (a Suunto gets it over Bluetooth).
                        if (s.status != "done" && s.kind != "rest" && s.date >= s.today) TextButton(onClick = { m.saveFit() }, enabled = !m.busy) { Icon(Glyphs["share"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.session_save_as_a_fit_workout)) }
                    }
                }
            }
        }
    }
    exercise?.let { e -> ExerciseSheet(e, m.api) { exercise = null } }
}

/** What a strength session works (the body turning; drag it), then its exercises in order. */
@Composable
private fun Strength(m: SessionModel, open: (Routine.Exercise) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val r = m.routine
    Column(Modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer).padding(20.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.session_what_it_works), style = MaterialTheme.typography.titleLarge)
        if (r == null) { Box(Modifier.fillMaxWidth().height(120.dp), contentAlignment = Alignment.Center) { LoadingIndicator() }; return@Column }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (!m.noBody) {
                BodyPictures(m.works, stringResource(R.string.session_the_muscles_this_session_works, muscleNames(r.primary + r.secondary)), Modifier.size(150.dp))
                Spacer(Modifier.width(12.dp))
            }
            Box(Modifier.weight(1f)) { Works(r.primary, r.secondary) }
        }
        Text(stringResource(R.string.session_exercises, r.items.size), style = MaterialTheme.typography.titleMedium)
        r.items.forEachIndexed { i, e ->
            val first = i == 0
            val last = i == r.items.lastIndex
            Row(
                Modifier.fillMaxWidth().press(scale = 0.98f, label = e.name, onClick = { open(e) })
                    .clip(RoundedCornerShape(if (first) 20.dp else 6.dp, if (first) 20.dp else 6.dp, if (last) 20.dp else 6.dp, if (last) 20.dp else 6.dp))
                    .background(cs.surfaceContainerHigh).padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (!m.noBody) Box(Modifier.size(72.dp, 60.dp).clip(RoundedCornerShape(14.dp)).background(cs.surfaceContainerHighest), contentAlignment = Alignment.Center) {
                    m.thumbs[e.id]?.loop?.firstOrNull()?.let { Image(it, null, Modifier.size(72.dp, 60.dp), contentScale = ContentScale.Fit) }
                }
                Column(Modifier.weight(1f).padding(start = if (m.noBody) 8.dp else 12.dp)) {
                    Text(e.name, style = MaterialTheme.typography.titleSmall)
                    Text(e.dose, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
                Icon(Glyphs["chevron"], null, Modifier.size(18.dp), tint = cs.onSurfaceVariant)
            }
        }
        if (r.basic) Text(stringResource(R.string.session_a_runner_s_basic_routine_for), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
    }
}

private val KIND get() = mapOf("strength" to str(R.string.common_strength), "core" to str(R.string.session_core), "power" to str(R.string.common_power), "mobility" to str(R.string.session_mobility))

/** One exercise (web/views/strength.ts openExercise): the body moving through it (drag to turn), the dose, three cues, why. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ExerciseSheet(e: Routine.Exercise, api: SettingsApi, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var frames by remember(e.id) { mutableStateOf<Frames?>(null) }
    var none by remember(e.id) { mutableStateOf(false) }
    LaunchedEffect(e.id) {
        frames = bodyFrames(api, JSONObject().put("exercise", e.id).put("primary", JSONArray(e.primary)).put("secondary", JSONArray(e.secondary)).put("width", 300).put("height", 260).put("loop", 20).put("turn", 24))
        none = frames == null
    }
    Sheet(onClose) { close ->
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(start = 16.dp, end = 16.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(e.name, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                    Text(listOfNotNull(KIND[e.kind], e.equipment).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
                FilledTonalIconButton(onClick = close) { Icon(Glyphs["close"], stringResource(R.string.common_close)) }
            }
            if (!none) Column(Modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer), horizontalAlignment = Alignment.CenterHorizontally) {
                BodyPictures(frames, stringResource(R.string.session_how_to_do, e.name), Modifier.fillMaxWidth().height(280.dp))
                if (frames != null) Text(stringResource(R.string.session_drag_to_turn), style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(bottom = 12.dp))
            }
            Text(e.dose, style = MaterialTheme.typography.titleLarge.copy(fontFamily = FlexRound))
            e.cues.forEachIndexed { i, c ->
                Row {
                    Text("${i + 1}", style = MaterialTheme.typography.titleSmall, color = cs.primary, modifier = Modifier.width(24.dp))
                    Text(c, style = MaterialTheme.typography.bodyLarge)
                }
            }
            Text(e.why, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            Works(e.primary, e.secondary)
        }
    }
}

private val VERDICT get() = mapOf("on target" to str(R.string.session_on_target), "fast" to str(R.string.session_fast), "slow" to str(R.string.session_slow), "high" to str(R.string.session_high), "low" to str(R.string.session_low), "no data" to str(R.string.session_no_data), "not done" to str(R.string.session_not_done), "done" to str(R.string.common_done))

/** How it went against the plan: one line, then each block's target, what was done and the verdict. */
@Composable
private fun ReviewCard(r: Review) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    Column(Modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.common_against_the_plan), style = MaterialTheme.typography.titleLarge)
        if (r.error != null) { Text(stringResource(R.string.session_can_t_compare_this_one, r.error), color = cs.onSurfaceVariant); return@Column }
        Text(
            buildAnnotatedString {
                append(r.summary)
                r.inRange?.let { withStyle(SpanStyle(color = cs.onSurfaceVariant)) { append(stringResource(R.string.session_of_the_time_in_range, Math.round(it * 100))) } }
            },
            style = MaterialTheme.typography.bodyLarge,
        )
        r.steps.forEach { st ->
            val tone = when (st.verdict) { "on target", "done" -> data.good; "no data" -> cs.onSurfaceVariant; else -> data.watch }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(st.label, style = MaterialTheme.typography.titleSmall)
                    if (st.sub.isNotEmpty()) Text(st.sub, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                }
                Text(st.actual.ifEmpty { "–" }, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 8.dp))
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(VERDICT[st.verdict] ?: st.verdict) }
                        if (st.off.isNotEmpty()) append(" ${st.off}")
                    },
                    style = MaterialTheme.typography.labelMedium, color = tone,
                    modifier = Modifier.clip(CircleShape).background(tone.copy(alpha = 0.12f)).padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
    }
}
