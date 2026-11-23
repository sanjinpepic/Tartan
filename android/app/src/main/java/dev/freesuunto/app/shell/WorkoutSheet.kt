package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs

private val CARD = RoundedCornerShape(28.dp)
private fun num(x: Double, digits: Int = 0) = String.format(Locale.getDefault(), "%.${digits}f", x)

/**
 * A workout, as a sheet over whichever screen opened it (web/views/detail.ts): it comes up from
 * the bottom, at full height, with the workout or its outline while it loads; pull it down or
 * press back to close. A note you were writing is kept when it closes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkoutSheet(m: WorkoutModel, onClose: () -> Unit, go: (String) -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val close: () -> Unit = { scope.launch { state.hide() }.invokeOnCompletion { m.keepDraft(); onClose() } }
    ModalBottomSheet(
        onDismissRequest = { m.keepDraft(); onClose() },
        sheetState = state,
        // Below the status bar when it's all the way up, the handle in reach.
        modifier = Modifier.statusBarsPadding(),
        containerColor = MaterialTheme.colorScheme.surface,
        contentWindowInsets = { androidx.compose.foundation.layout.WindowInsets(0) },
    ) {
        // The whole height from the start: the workout arrives after the sheet opens, and the sheet
        // shouldn't stop at the outline's height and then jump.
        Box(Modifier.fillMaxWidth().fillMaxHeight().imePadding()) {
            WorkoutBody(m, close, { close(); go(it) }, Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding())
            Said(m.said, { m.said = null }, Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
        }
    }
}

/** A word after a write ("Noted. Nice one."), a few seconds at the bottom of the sheet. */
@Composable
fun Said(text: String?, gone: () -> Unit, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(text) { if (text != null) { delay(4500); gone() } }
    AnimatedVisibility(text != null, modifier, enter = fadeIn() + slideInVertically { it / 2 }, exit = fadeOut() + slideOutVertically { it / 2 }) {
        Text(
            text ?: "",
            color = cs.inverseOnSurface,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(16.dp).clip(RoundedCornerShape(16.dp)).background(cs.inverseSurface).padding(horizontal = 16.dp, vertical = 12.dp),
        )
    }
}

/** The sheet's content (tested on its own: Robolectric draws no dialog windows). */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun WorkoutBody(m: WorkoutModel, close: () -> Unit, go: (String) -> Unit, modifier: Modifier = Modifier) {
    val w = m.workout
    // The outline dissolves into the workout; the sheet itself stays where it is.
    val phase = if (m.failed != null) "failed" else if (w == null) "loading" else "ready"
    AnimatedContent(phase, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "workout") { p ->
        Column(modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when (p) {
                "failed" -> Failed(m.failed ?: "", close)
                "loading" -> Outline()
                else -> Content(m, m.workout ?: return@Column, close, go)
            }
        }
    }
}

@Composable
private fun Failed(why: String, close: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(why, style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.workout_it_may_still_be_syncing_try), color = cs.onSurfaceVariant)
        FilledTonalButton(onClick = close) { Text(stringResource(R.string.common_close)) }
    }
}

/** The sheet's own shape while the workout loads: head, route, numbers. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Outline() {
    val cs = MaterialTheme.colorScheme
    val block = cs.surfaceContainerHigh
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(48.dp).clip(CircleShape).background(block))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.width(200.dp).height(18.dp).clip(RoundedCornerShape(9.dp)).background(block))
            Box(Modifier.width(140.dp).height(12.dp).clip(RoundedCornerShape(6.dp)).background(block))
        }
    }
    Box(Modifier.fillMaxWidth().height(220.dp).clip(CARD).background(block), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(56.dp)) }
    repeat(3) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.weight(1f).height(72.dp).clip(RoundedCornerShape(20.dp)).background(block))
            Box(Modifier.weight(1f).height(72.dp).clip(RoundedCornerShape(20.dp)).background(block))
        }
    }
}

private val LONG = DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.getDefault())

/** "Tuesday 28 October · 08:18 · Suunto Run 2" (the local start, as the web's sheet). */
fun whenLine(w: Workout): String {
    val t = runCatching { LocalDateTime.parse(w.startLocal?.take(19)) }.getOrNull()
        ?: runCatching { LocalDateTime.ofInstant(Instant.parse(w.start), ZoneId.systemDefault()) }.getOrNull()
    // A no-break space before each dot, so a wrapped line never starts with one.
    return listOfNotNull(t?.format(LONG), t?.let { "%02d:%02d".format(it.hour, it.minute) }, w.device).joinToString("\u00A0· ")
}

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3ExpressiveApi::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun Content(m: WorkoutModel, w: Workout, close: () -> Unit, go: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var i = 0
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.size(48.dp).clip(CircleShape).background(cs.primaryContainer), contentAlignment = Alignment.Center) {
                Icon(Glyphs.sport(w.sport), null, Modifier.size(26.dp), tint = cs.onPrimaryContainer)
            }
            Column(Modifier.weight(1f)) {
                Text(w.name ?: w.sport, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                Text(whenLine(w), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            val colour = shareColour()
            // The card previewed first: the colour, the map or a photo behind it (ShareWorkout.kt).
            var sharing by remember { mutableStateOf(false) }
            FilledTonalIconButton(onClick = { sharing = true }) { Icon(Glyphs["share"], stringResource(R.string.workout_share_as_a_picture)) }
            if (sharing) ShareWorkoutSheet(w, colour) { sharing = false }
            FilledTonalIconButton(onClick = close) { Icon(Glyphs["close"], stringResource(R.string.common_close)) }
        }
        // The weather it was in, one line in words under the date (the full width, past the buttons).
        w.weather?.let { WeatherSentence(it, Modifier.padding(start = 60.dp)) }
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        w.copies.map { it.source }.distinct().sortedBy { Words.ORDER.indexOf(it) }.forEach { SourceChip(it) }
        if (w.copies.size > 1) Chip("check", stringResource(R.string.workout_matched_one_workout))
    }
    w.description?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
    // What it earned: a new best, the longest run, a race (src/milestones.ts).
    MilestoneLines(m.milestones, Modifier.reveal(i++))
    // The route, and under it what the run's moments say, each tied to its stretch on the map.
    val bring = remember { BringIntoViewRequester() }
    if (w.route.size >= 2 || w.moments.isNotEmpty()) Column(Modifier.reveal(i++).bringIntoViewRequester(bring), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val marks = momentMarks(w)
        if (w.route.size >= 2) RouteCard(w.route, stringResource(R.string.workout_route_of, w.name ?: w.sport), marks = marks, chosen = m.moment, onPick = m::pick)
        MomentRows(w.moments, marks, m.moment, m::pick)
    }
    // Opened from the note after the run (or "Just in"): the map and its moments in view.
    LaunchedEffect(w.id) { if (m.atMoments && w.moments.isNotEmpty()) { delay(350); bring.bringIntoView() } }
    Stats(w, Modifier.reveal(i++))
    if (w.isRun) m.finish?.let { FinishCard(it, m, Modifier.reveal(i++)) }
    w.load?.rank?.let { rank -> Note(stringResource(R.string.workout_effort_scores_how_long_and_how, w.load.label.lowercase(), rank)) }
    HowItWent(m, Modifier.reveal(i++))
    AlongTheWay(w, m.moment, Modifier.reveal(i++))
    if (w.zones.any { it.seconds > 0 }) Zones(w, Modifier.reveal(i++))
    if (w.shod && m.shoes.isNotEmpty()) ShoesRow(m)
    if (m.worked.isNotEmpty()) WorkedCard(m.worked, m.figure) { go("you") }
    if (w.splits.isNotEmpty()) Splits(w)
    SourcesCard(w)
    if (w.toldOnly) RemoveTold(m, close)
}

/** A workout only told to the coach: a quiet way to take it back, asked once. Recorded ones never show it. */
@Composable
private fun RemoveTold(m: WorkoutModel, close: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var asking by remember { mutableStateOf(false) }
    TextButton(onClick = { asking = true }, enabled = !m.busy) { Text(stringResource(R.string.workout_remove), color = cs.error) }
    if (asking) AlertDialog(
        onDismissRequest = { asking = false },
        title = { Text(stringResource(R.string.workout_remove_this_workout)) },
        text = { Text(stringResource(R.string.workout_remove_it_was_told)) },
        confirmButton = { TextButton(onClick = { asking = false; m.removeTold(close) }) { Text(stringResource(R.string.workout_remove)) } },
        dismissButton = { TextButton(onClick = { asking = false }) { Text(stringResource(R.string.common_cancel)) } },
    )
}

@Composable
private fun Note(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 4.dp))

@Composable
private fun Chip(icon: String, text: String, tint: Color? = null, fill: Color? = null) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.clip(CircleShape).background(fill ?: cs.surfaceContainerHigh).padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Glyphs[icon], null, Modifier.size(14.dp), tint = tint ?: cs.onSurfaceVariant)
        Text(text, style = MaterialTheme.typography.labelMedium, color = cs.onSurface)
    }
}

@Composable
private fun SourceChip(s: String) {
    val icon = when (s) { "strava" -> "strava"; "watch" -> "watch"; "phone" -> "phone"; else -> "folder" }
    // Where it came from is a fact, not a status: a neutral chip.
    Chip(icon, Words.SOURCE[s] ?: s)
}

/** The headline numbers, two to a row: each a tonal tile, the number large and its unit small. */
@Composable
private fun Stats(w: Workout, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val stats = buildList {
        w.distanceKm?.let { add(Triple(stringResource(R.string.common_distance), num(it, 2), "km")) }
        add(Triple(stringResource(R.string.workout_moving_time), w.movingMin?.let { duration(it) } ?: "–", ""))
        if (w.isRun && w.pace != null) add(Triple(stringResource(R.string.common_avg_pace), w.pace, "/km")) else w.speedKmh?.let { add(Triple(stringResource(R.string.workout_avg_speed), num(it, 1), "km/h")) }
        w.avgHr?.let { add(Triple(stringResource(R.string.common_avg_heart_rate), "$it", "bpm")) }
        w.maxHr?.let { add(Triple(stringResource(R.string.workout_max_heart_rate), "$it", "bpm")) }
        w.elevationM?.let { add(Triple(stringResource(R.string.common_climb), num(it), "m")) }
        w.load?.let { add(Triple(if (it.estimated) stringResource(R.string.workout_effort_estimated) else stringResource(R.string.common_effort), num(it.load), it.label.lowercase())) }
        w.calories?.takeIf { it > 0 }?.let { add(Triple(stringResource(R.string.workout_energy), num(it), "kcal")) }
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        stats.chunked(2).forEachIndexed { r, pair ->
            // Each pair as tall as its taller tile.
            Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                pair.forEachIndexed { c, (k, v, unit) ->
                    // A connected group: round on the outside, tighter where tiles meet.
                    val top = r == 0
                    val bottom = r == (stats.size - 1) / 2
                    val big = 24.dp
                    val small = 8.dp
                    val shape = RoundedCornerShape(
                        topStart = if (top && c == 0) big else small, topEnd = if (top && (c == 1 || pair.size == 1)) big else small,
                        bottomStart = if (bottom && c == 0) big else small, bottomEnd = if (bottom && (c == 1 || pair.size == 1)) big else small,
                    )
                    Column(Modifier.weight(1f).fillMaxHeight().clip(shape).background(cs.surfaceContainer).padding(horizontal = 16.dp, vertical = 12.dp)) {
                        Text(k, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant)
                        Text(
                            buildAnnotatedString {
                                append(v)
                                if (unit.isNotEmpty()) withStyle(SpanStyle(fontSize = MaterialTheme.typography.labelLarge.fontSize, color = cs.onSurfaceVariant, fontFamily = Flex, fontWeight = FontWeight.Medium)) { append(" $unit") }
                            },
                            style = Figure.M,
                        )
                    }
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun Card(title: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null, content: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer).padding(20.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
            action?.invoke()
        }
        content()
    }
}

/** A line of the finish card: its glyph in a tonal circle, a title and what it says. */
@Composable
private fun FinishRow(icon: String, title: String, content: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(32.dp).clip(CircleShape).background(cs.secondaryContainer), contentAlignment = Alignment.Center) {
            Icon(Glyphs[icon], null, Modifier.size(16.dp), tint = cs.onSecondaryContainer)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            content()
        }
    }
}

/** A run, finished (web/views/finish.ts): against the plan, records, against last time, next time. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FinishCard(f: Finish, m: WorkoutModel, modifier: Modifier, title: String = stringResource(R.string.common_against_the_plan), bare: Boolean = false) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    // Inside another card (Today's "Just in"): the rows alone, under a small title.
    val frame: @Composable (@Composable () -> Unit) -> Unit = if (bare) { c -> Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) { Text(title, style = MaterialTheme.typography.titleMedium); c() } } else { c -> Card(title, modifier) { c() } }
    frame {
        f.plan?.let { p ->
            val line = if (p.total != null && p.total > 1) stringResource(R.string.workout_of_reps_on_target, p.onTarget.toString(), p.total) else p.summary?.trimEnd('.') ?: stringResource(R.string.common_done)
            FinishRow("check", p.title) { Text(line, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
        }
        if (f.records.isNotEmpty()) FinishRow("spark", if (f.records.any { it.rank == 1 }) stringResource(R.string.workout_records) else stringResource(R.string.workout_among_your_best)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                f.records.take(4).forEach { r ->
                    Text(
                        buildAnnotatedString {
                            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append("${Words.RANK.getOrElse(r.rank) { "" }} ${Words.DISTANCE[r.name] ?: r.name}") }
                            append(" ${clock(r.timeS)}")
                        },
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.clip(CircleShape).background(if (r.rank == 1) data.goodContainer else cs.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
            }
        }
        f.last?.let { l ->
            FinishRow(when (l.verdict) { "fitter" -> "up"; "harder" -> "down"; else -> "history" }, stringResource(R.string.workout_against_last_time)) {
                Text(l.text, style = MaterialTheme.typography.bodyMedium)
                Text(stringResource(R.string.workout_compare_line, l.nowPace ?: "–", l.nowHr?.toString() ?: "–", l.pace ?: "–", l.hr?.toString() ?: "–", dayName(l.date), dateShort(l.date), l.name?.let { " ($it)" } ?: ""), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
        }
        f.next?.let { n ->
            FinishRow("spark", stringResource(R.string.workout_next_time, dayName(n.date), dateShort(n.date), n.title)) {
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = when (n.rule) { "faster" -> data.good; "easier", "slow down" -> data.watch; else -> cs.primary })) { append(Words.RULE[n.rule] ?: n.rule) }
                        append(" ${n.why}")
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (n.applied) Text(stringResource(R.string.workout_changed_on_the_plan), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                n.shiftS?.let { s ->
                    if (n.applied) TextButton(onClick = { m.adjust() }, enabled = !m.busy) { Text(stringResource(R.string.common_undo)) }
                    else FilledTonalButton(onClick = { m.adjust() }, enabled = !m.busy) { Text(stringResource(if (s < 0) R.string.workout_use_it_faster else R.string.workout_use_it_easier, abs(s))) }
                }
            }
        }
    }
}

private data class Tag(val label: String, val hint: String, val icon: String)
private val TAGS get() = linkedMapOf(
    "win" to Tag(str(R.string.workout_win), "e.g. first sub-25 5k", "spark"),
    "niggle" to Tag(str(R.string.workout_niggle), "e.g. tight after the hills", "warn"),
    "note" to Tag(str(R.string.workout_note), "e.g. windy, started too fast", "bookmark"),
)

/**
 * How it went, in your words and the watch's (web/views/notes.ts): "How did it feel?" from the
 * watch, your notes on the run, and a new one: a tag and a few words, kept by themselves (no
 * Save) when you press done, leave the box, finish speaking or close the sheet.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun HowItWent(m: WorkoutModel, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val view = LocalView.current
    val speak = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val said = r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() ?: return@rememberLauncherForActivityResult
        m.draft = listOf(m.draft.trim(), said).filter { it.isNotEmpty() }.joinToString(" ")
        scope.launch { m.keep() }
    }
    Card(stringResource(R.string.workout_your_notes), modifier) {
        m.feeling?.let { f ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (k in 1..5) Box(Modifier.size(10.dp).clip(CircleShape).background(if (k <= f) data.good else cs.surfaceContainerHighest))
                }
                Text(stringResource(R.string.common_felt, (Words.FEELING[f] ?: "").lowercase()), style = MaterialTheme.typography.titleSmall)
                Text(stringResource(R.string.common_on_your_watch), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
        }
        m.notes.forEach { n ->
            val tag = TAGS[n.tag] ?: TAGS.getValue("note")
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(if (n.tag == "win") data.goodContainer else if (n.tag == "niggle") data.watchContainer else cs.surfaceContainerHigh).padding(start = 14.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Glyphs[tag.icon], null, Modifier.size(14.dp))
                        Text(tag.label + (n.area?.let { " · ${Words.area(it)}" } ?: ""), style = MaterialTheme.typography.labelMedium)
                    }
                    if (n.text.isNotBlank()) Text(n.text, style = MaterialTheme.typography.bodyMedium)
                }
                IconButton(onClick = { m.removeNote(n) }) { Icon(Glyphs["close"], stringResource(R.string.workout_remove_this, tag.label.lowercase()), Modifier.size(18.dp)) }
            }
        }
        m.removed?.let { n ->
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(cs.inverseSurface).padding(start = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.workout_tag_removed, (TAGS[n.tag] ?: TAGS.getValue("note")).label), style = MaterialTheme.typography.bodyMedium, color = cs.inverseOnSurface, modifier = Modifier.weight(1f))
                TextButton(onClick = { m.undoRemove() }) { Text(stringResource(R.string.common_undo), color = cs.inversePrimary) }
            }
        }
        var open by remember { mutableStateOf(false) }
        if (m.notes.isNotEmpty() && !open && m.draft.isEmpty()) {
            TextButton(onClick = { open = true }) { Icon(Glyphs["plus"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.workout_add_a_note)) }
        } else {
            Segmented(TAGS.values.map { it.label }, TAGS.keys.indexOf(m.draftTag), { m.draftTag = TAGS.keys.elementAt(it) })
            AnimatedVisibility(m.draftTag == "niggle", enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.workout_where), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Words.AREAS.forEach { a ->
                            val on = m.draftArea == a
                            Text(
                                Words.area(a),
                                style = MaterialTheme.typography.labelLarge,
                                color = if (on) cs.onPrimary else cs.onSurface,
                                modifier = Modifier.press(scale = 0.94f, role = androidx.compose.ui.semantics.Role.RadioButton, onClick = { m.draftArea = if (on) null else a })
                                    .clip(RoundedCornerShape(12.dp)).background(if (on) cs.primary else cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 10.dp),
                            )
                        }
                    }
                }
            }
            var was by remember { mutableStateOf(false) }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.weight(1f).heightIn(min = 48.dp).clip(RoundedCornerShape(16.dp)).background(cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 12.dp), contentAlignment = Alignment.CenterStart) {
                    if (m.draft.isEmpty()) Text(TAGS[m.draftTag]?.hint ?: "", color = cs.onSurfaceVariant.copy(alpha = 0.7f), style = MaterialTheme.typography.bodyLarge)
                    BasicTextField(
                        m.draft, { m.draft = it.take(280) },
                        Modifier.fillMaxWidth().onFocusChanged { f -> if (was && !f.isFocused) scope.launch { m.keep() }; was = f.isFocused },
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = cs.onSurface), cursorBrush = SolidColor(cs.primary),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                    )
                }
                FilledTonalIconButton(onClick = {
                    focus.clearFocus()
                    runCatching { speak.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_PROMPT, str(R.string.workout_how_did_it_go))) }
                }) { Icon(Glyphs["mic"], stringResource(R.string.workout_say_it_instead)) }
            }
            if (m.hasDraft) Text(if (m.saving) stringResource(R.string.common_saving) else stringResource(R.string.workout_kept_by_itself_when_you_re), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
    }
}

/** Pace (or speed), heart rate and elevation over distance: one crosshair across all three. */
@Composable
private fun AlongTheWay(w: Workout, chosen: Int, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val charts = remember(w) { along(w) }
    if (charts.km.isEmpty()) return
    var at by remember { mutableIntStateOf(-1) }
    // The moments' stretches, on the charts' even steps of distance; the chosen one stands out.
    val still = LocalReducedMotion.current
    val colours = momentColours()
    val weights = w.moments.indices.map { k -> animateFloatAsState(if (chosen == k) 1f else if (chosen >= 0) -0.3f else 0f, if (still) snap() else spring(dampingRatio = 1f, stiffness = 300f), label = "band").value }
    val bands = w.moments.mapIndexedNotNull { k, mo ->
        val total = charts.km.last().takeIf { it > 0 } ?: return@mapIndexedNotNull null
        fun step(km: Double) = (km / total * (charts.km.size - 1)).toInt().coerceIn(0, charts.km.size - 1)
        val a = w.kmAt(mo.fromI) ?: mo.fromM / 1000
        val b = w.kmAt(mo.toI) ?: mo.toM / 1000
        // Done well in Good's tonal container (green over the card's warm tone goes grey), to work on in a wash of the accent.
        val wt = weights[k]
        val shade = if (mo.good) data.goodContainer.copy(alpha = (0.55f + (if (wt < 0) 1f else 0.45f) * wt).coerceIn(0f, 1f)) else colours.second.copy(alpha = (0.07f + 0.09f * wt).coerceIn(0f, 1f))
        ChartBand(step(a), kotlin.math.ceil(b / total * (charts.km.size - 1)).toInt().coerceIn(0, charts.km.size - 1), shade)
    }
    val kmAt = { i: Int -> charts.km.getOrNull(i)?.let { str(R.string.common_n_km, num(it, if (it < 10) 1 else 0)) } ?: "" }
    Card(stringResource(R.string.workout_along_the_way), modifier) {
        charts.pace?.let { p ->
            LineChart(
                p, data.pace, if (w.isRun) stringResource(R.string.workout_pace) else stringResource(R.string.workout_speed),
                { i -> str(R.string.workout_at_km, if (w.isRun) str(R.string.common_per_km, clock(p[i]!!.toInt())) else str(R.string.workout_kmh, num(p[i]!!, 1)), kmAt(i)) },
                invert = w.isRun, area = false, yLabel = { if (w.isRun) clock(it.toInt()) else num(it, 1) }, height = 140, link = at, onLink = { at = it }, bands = bands,
            )
        }
        charts.hr?.let { h ->
            LineChart(h, LocalData.current.effort, stringResource(R.string.common_heart_rate), { i -> str(R.string.workout_bpm_at, h[i]!!.toInt(), kmAt(i)) }, area = false, yLabel = { "${it.toInt()}" }, height = 140, link = at, onLink = { at = it }, bands = bands)
        }
        charts.alt?.let { a ->
            LineChart(a, cs.outline, stringResource(R.string.workout_elevation), { i -> str(R.string.workout_m_at, a[i]!!.toInt(), kmAt(i)) }, yLabel = { "${it.toInt()} m" }, minSpan = 20.0, height = 110, link = at, onLink = { at = it }, bands = bands)
        }
    }
}

/** The moments' two colours: done well (good) and to work on (the accent). */
@Composable
private fun momentColours(): Pair<Color, Color> = LocalData.current.good to MaterialTheme.colorScheme.primary

/** A run's moments as marks on its route card: the stretch, the pin and the number's colour on it. */
@Composable
private fun momentMarks(w: Workout): List<RouteMark> {
    val (good, work) = momentColours()
    val onGood = LocalData.current.goodContainer
    val onWork = MaterialTheme.colorScheme.onPrimary
    return remember(w, good, work) { w.moments.map { mo -> RouteMark(w.stretch(mo), mo.at, if (mo.good) good else work, if (mo.good) onGood else onWork) } }
}

/**
 * Under the map, a compact row for each moment: its number in a small circle in its colour, then
 * the line. Tap one to choose it on the map and the charts; tap it again to let it go. Nothing at
 * all when there are none.
 */
@Composable
private fun MomentRows(moments: List<RunMoment>, marks: List<RouteMark>, chosen: Int, pick: (Int) -> Unit) {
    if (moments.isEmpty()) return
    val cs = MaterialTheme.colorScheme
    val still = LocalReducedMotion.current
    Column {
        moments.forEachIndexed { k, mo ->
            val on = chosen == k
            val fill by animateColorAsState(if (on) cs.secondaryContainer else cs.secondaryContainer.copy(alpha = 0f), if (still) snap() else spring(dampingRatio = 1f, stiffness = 400f), label = "row")
            val said = stringResource(if (mo.good) R.string.workout_moment_good else R.string.workout_moment_work_on, k + 1, mo.text)
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(fill)
                    .press(scale = 0.98f) { pick(k) }
                    .clearAndSetSemantics { contentDescription = said; selected = on; role = Role.Button; onClick { pick(k); true } }
                    .padding(horizontal = 10.dp, vertical = 9.dp),
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(Modifier.padding(top = 1.dp).size(22.dp).clip(CircleShape).background(marks.getOrNull(k)?.colour ?: cs.primary), contentAlignment = Alignment.Center) {
                    Text("${k + 1}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = marks.getOrNull(k)?.ink ?: cs.onPrimary)
                }
                Text(mo.text, style = MaterialTheme.typography.bodyMedium, color = cs.onSurface, modifier = Modifier.weight(1f))
            }
        }
    }
}

/** The streams resampled onto even distance steps (the charts are drawn by index), smoothed. */
class Along(val km: List<Double>, val pace: List<Double?>?, val hr: List<Double?>?, val alt: List<Double?>?)

fun along(w: Workout, n: Int = 160): Along {
    val dist = w.distance
    if (dist.isEmpty()) return Along(emptyList(), null, null, null)
    // A missing distance carries the last one.
    var last = 0.0
    val x = dist.map { d -> (d ?: last).also { last = it } / 1000 }
    val total = x.last()
    if (total <= 0) return Along(emptyList(), null, null, null)
    val steps = (0 until n).map { it * total / (n - 1) }
    val idx = IntArray(n)
    var j = 0
    steps.forEachIndexed { k, s -> while (j < x.size - 1 && x[j + 1] <= s) j++; idx[k] = j }
    fun smooth(v: List<Double?>, win: Int): List<Double?> = v.indices.map { i ->
        val ok = (maxOf(0, i - win)..minOf(v.size - 1, i + win)).mapNotNull { v[it]?.takeIf { d -> d.isFinite() } }
        if (ok.isEmpty()) null else ok.average()
    }
    fun pick(v: List<Double?>) = idx.map { v.getOrNull(it) }
    val pace = w.velocity.takeIf { v -> v.any { (it ?: 0.0) > 0 } }?.let { v ->
        pick(smooth(v.map { s -> if (s != null && s > 0.6) (if (w.isRun) 1000 / s else s * 3.6) else null }, 4))
    }
    val hr = w.heartrate.takeIf { v -> v.any { (it ?: 0.0) > 0 } }?.let { pick(smooth(it, 2)) }
    val alt = w.altitude.takeIf { v -> v.any { it != null } }?.let { pick(smooth(it, 2)) }
    return Along(steps, pace, hr, alt)
}

/** Heart-rate zones: a bar of the shares, a key, the table and where the zones come from. */
@Composable
private fun Zones(w: Workout, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val colours = zoneColours()
    Card(stringResource(R.string.workout_heart_rate_zones), modifier) {
        StackBar(w.zones.mapIndexed { i, z -> z.seconds to colours[i.coerceAtMost(4)] })
        w.zones.forEachIndexed { i, z ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(12.dp).clip(RoundedCornerShape(3.dp)).background(colours[i.coerceAtMost(4)]))
                Text("Z${z.zone} ${z.name}", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 10.dp).weight(1f))
                Text(stringResource(R.string.common_bpm_range, z.lo, z.hi), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, modifier = Modifier.padding(end = 12.dp))
                Text(duration(z.seconds / 60).takeUnless { z.seconds in 1.0..29.0 } ?: stringResource(R.string.workout_1_min), style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.End, modifier = Modifier.width(64.dp))
            }
        }
        Note(
            if (w.zonesSource == "your watch") stringResource(R.string.workout_your_watch_s_zones_z2_from, w.zones.getOrNull(1)?.lo.toString(), w.zones.getOrNull(2)?.lo.toString(), w.zones.getOrNull(3)?.lo.toString(), w.zones.getOrNull(4)?.lo.toString())
            else stringResource(if (w.zonesSource == "your max heart rate") R.string.workout_zones_of_your_max else R.string.workout_zones_of_estimated_max, w.profileMax.toString()),
        )
    }
}

/** The shoes this run counts to, and a menu to change it. */
@Composable
private fun ShoesRow(m: WorkoutModel) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    val name = m.shoes.firstOrNull { it.id == m.shoe }?.name ?: stringResource(R.string.workout_no_shoes_counted)
    Row(Modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer).padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Glyphs["run"], null, Modifier.size(20.dp), tint = cs.primary)
        Text(stringResource(R.string.common_shoes), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 10.dp).weight(1f))
        Box {
            FilledTonalButton(onClick = { open = true }) { Text(name); Icon(Glyphs["chevron"], null, Modifier.padding(start = 4.dp).size(16.dp)) }
            DropdownMenu(open, { open = false }) {
                m.shoes.filter { !it.retired || it.id == m.shoe }.forEach { s ->
                    DropdownMenuItem({ Text(s.name) }, { open = false; if (s.id != m.shoe) m.pickShoe(s.id) }, leadingIcon = { if (s.id == m.shoe) Icon(Glyphs["check"], null) })
                }
                DropdownMenuItem({ Text(stringResource(R.string.workout_no_shoes_counted)) }, { open = false; if (m.shoe != null) m.pickShoe(null) }, leadingIcon = { if (m.shoe == null) Icon(Glyphs["check"], null) })
            }
        }
    }
}

/** What it worked: its muscles, shaded by their share of the load (the Body page's model). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WorkedCard(muscles: List<Worked>, figure: String, toBody: () -> Unit) {
    Card(stringResource(R.string.workout_what_it_worked), action = { TextButton(onClick = toBody) { Text(stringResource(R.string.workout_your_body_now)); Icon(Glyphs["chevron"], null, Modifier.size(16.dp)) } }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(150.dp)) { BodyMap(muscles.associate { it.muscle to it.level }, figure = figure, label = stringResource(R.string.workout_the_muscles_it_worked)) }
            Text(Words.worked(muscles), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).padding(start = 12.dp))
        }
    }
}

/** A table: a header row and rows, the first column left, the rest right; scrolls sideways if it must. */
@Composable
private fun Table(head: List<String>, rows: List<List<String>>, weights: List<Float>, bold: (Int, Int) -> Boolean = { _, _ -> false }, dim: (Int, Int) -> Boolean = { _, _ -> false }) {
    val cs = MaterialTheme.colorScheme
    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth()) {
        val width = maxOf(maxWidth, (head.size * 76).dp)
        Column(Modifier.horizontalScroll(rememberScrollState()).width(width)) {
            Row(Modifier.padding(vertical = 6.dp, horizontal = 4.dp)) {
                head.forEachIndexed { c, h -> Text(h, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant, textAlign = if (c == 0) TextAlign.Start else TextAlign.End, modifier = Modifier.weight(weights[c])) }
            }
            rows.forEachIndexed { r, row ->
                Row(Modifier.clip(RoundedCornerShape(8.dp)).background(if (r % 2 == 0) cs.surfaceContainerHigh.copy(alpha = 0.6f) else Color.Transparent).padding(vertical = 8.dp, horizontal = 4.dp)) {
                    row.forEachIndexed { c, v ->
                        Text(
                            v,
                            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (bold(r, c)) FontWeight.Bold else FontWeight.Normal),
                            color = if (dim(r, c)) cs.onSurfaceVariant.copy(alpha = 0.6f) else cs.onSurface,
                            textAlign = if (c == 0) TextAlign.Start else TextAlign.End,
                            modifier = Modifier.weight(weights[c]),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Splits(w: Workout) {
    Card(stringResource(R.string.workout_splits)) {
        Table(
            listOf("km", if (w.isRun) stringResource(R.string.workout_pace) else stringResource(R.string.workout_speed), "HR", stringResource(R.string.workout_elev)),
            w.splits.map { s ->
                listOf(
                    "${s.n}",
                    s.speed?.takeIf { it > 0 }?.let { if (w.isRun) stringResource(R.string.common_per_km, clock(Math.round(1000 / it).toInt())) else stringResource(R.string.workout_km_h, num(it * 3.6, 1)) } ?: "–",
                    s.hr?.let { "${Math.round(it)}" } ?: "–",
                    s.elev?.let { "${if (it > 0) "+" else ""}${Math.round(it)} m" } ?: "–",
                )
            },
            listOf(0.6f, 1.4f, 0.8f, 1f),
        )
    }
}

/**
 * Where it came from (detail.ts sourcesCard): with one source, a line; with more, each one's
 * numbers side by side, the value Tartan shows in bold.
 */
@Composable
private fun SourcesCard(w: Workout) {
    val cs = MaterialTheme.colorScheme
    val copies = w.copies.sortedBy { Words.ORDER.indexOf(it.source).let { i -> if (i < 0) 99 else i } }
    Card(if (copies.size > 1) stringResource(R.string.common_sources) else stringResource(R.string.workout_source)) {
        if (copies.size > 1) {
            val starts = copies.mapNotNull { c -> c.start?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } }
            val apart = if (starts.size > 1) Math.round((starts.max() - starts.min()) / 1000.0) else null
            val how = apart?.let { a -> stringResource(R.string.workout_same_sport_started, if (a < 1) stringResource(R.string.workout_same_second) else if (a < 120) stringResource(R.string.workout_s_apart, a) else stringResource(R.string.workout_min_apart, Math.round(a / 60.0))) } ?: ""
            Text(stringResource(R.string.workout_matched_as_one_workout_it_counts, how), style = MaterialTheme.typography.bodyMedium)
            fun pace(mps: Double?) = mps?.takeIf { it > 0 }?.let { if (w.isRun) str(R.string.common_per_km, clock(Math.round(1000 / it).toInt())) else str(R.string.workout_km_h, num(it * 3.6, 1)) }
            val rows: List<Triple<String, String, (Copy) -> String?>> = listOf(
                Triple(str(R.string.common_distance), "distance_m") { c -> c.distanceM?.takeIf { it > 0 }?.let { str(R.string.common_n_km, num(it / 1000, 2)) } },
                Triple(str(R.string.workout_moving_time), "moving_s") { c -> c.movingS?.takeIf { it > 0 }?.let { clock(it.toInt()) } },
                Triple(str(R.string.workout_total_time), "elapsed_s") { c -> c.elapsedS?.takeIf { it > 0 }?.let { clock(it.toInt()) } },
                Triple(if (w.isRun) str(R.string.common_avg_pace) else str(R.string.workout_avg_speed), "avg_speed") { c -> pace(c.avgSpeed) },
                Triple(str(R.string.common_avg_heart_rate), "avg_hr") { c -> c.avgHr?.takeIf { it > 0 }?.let { str(R.string.common_n_bpm, Math.round(it)) } },
                Triple(str(R.string.workout_max_heart_rate), "max_hr") { c -> c.maxHr?.takeIf { it > 0 }?.let { str(R.string.common_n_bpm, Math.round(it)) } },
                Triple(str(R.string.common_climb), "elevation_m") { c -> c.elevationM?.takeIf { it > 0 }?.let { "${Math.round(it)} m" } },
                Triple(str(R.string.workout_cadence), "avg_cadence") { c -> c.cadence?.takeIf { it > 0 }?.let { str(R.string.workout_min, Math.round(it)) } },
                Triple(str(R.string.common_power), "avg_power") { c -> c.power?.takeIf { it > 0 }?.let { "${Math.round(it)} W" } },
                Triple(str(R.string.workout_energy), "calories") { c -> c.calories?.takeIf { it > 0 }?.let { str(R.string.workout_kcal, Math.round(it)) } },
            )
            val shown = rows.map { (label, field, fmt) -> Triple(label, field, copies.map(fmt)) }.filter { (_, _, cells) -> cells.any { it != null } }
            val table = shown.map { (label, _, cells) -> listOf(label) + cells.map { it ?: "–" } } +
                (if (w.streamsFrom != null) listOf(listOf(str(R.string.workout_map_charts)) + copies.map { c -> if (c.source == w.streamsFrom) "✓" else if (c.hasStreams) "available" else "–" }) else emptyList())
            Table(
                listOf("") + copies.map { Words.SOURCE[it.source] ?: it.source }, table, listOf(1.4f) + copies.map { 1f },
                bold = { r, c -> c > 0 && (shown.getOrNull(r)?.second?.let { w.provenance[it] == copies[c - 1].source } ?: (copies[c - 1].source == w.streamsFrom)) },
                dim = { r, c -> c > 0 && table[r][c] == "–" },
            )
            Text(str(R.string.workout_bold_the_value_tartan_shows_each), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        } else {
            val s = copies.firstOrNull()?.source ?: ""
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SourceChip(s)
                Text(if (s == "watch") str(R.string.workout_read_straight_from_the_watch) else str(R.string.workout_only_on_so_far, Words.SOURCE_LONG[s] ?: s), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/** A message from the page, shown over a native screen: its action, Dismiss; errors stay until dismissed. */
data class PageSnack(val id: Int, val text: String, val error: Boolean, val action: String?, val ms: Long?)

@Composable
fun PageSnackbar(s: PageSnack?, onAction: (Int) -> Unit, gone: () -> Unit, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(s) { s?.ms?.let { delay(it); gone() } }
    // Kept while it slides away.
    var last by remember { mutableStateOf(s) }
    if (s != null) last = s
    AnimatedVisibility(s != null, modifier, enter = fadeIn() + slideInVertically { it / 2 }, exit = fadeOut() + slideOutVertically { it / 2 }) {
        val n = last ?: return@AnimatedVisibility
        androidx.compose.material3.Snackbar(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            shape = RoundedCornerShape(16.dp),
            action = n.action?.let { a -> { TextButton(onClick = { gone(); onAction(n.id) }) { Text(a, color = cs.inversePrimary) } } },
            dismissAction = { TextButton(onClick = gone) { Text(stringResource(R.string.common_dismiss), color = cs.inversePrimary) } },
        ) {
            androidx.compose.foundation.layout.Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                if (n.error) { Icon(Glyphs["warn"], null, Modifier.size(18.dp), tint = cs.inverseOnSurface); androidx.compose.foundation.layout.Spacer(Modifier.width(8.dp)) }
                Text(n.text, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}
