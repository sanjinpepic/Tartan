package dev.freesuunto.app.shell

import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearWavyProgressIndicator
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/** What Coach can ask of the app. `post` writes (through the page, so syncs, the calendar and the cache all hear of it) and returns an error, or null. */
interface CoachActions {
    fun openSession(date: String, kind: String)
    fun openActivity(id: String)
    /** The chat: a conversation to continue (or a new one), and words to start with. */
    fun chat(conversation: String?, prefill: String?)
    fun go(hash: String)
    fun dismissWeekly(week: String)
    suspend fun post(path: String, body: String?): String?
    /** For making the first plan: a plain call, one that streams, and the plan made (read again; a word). */
    suspend fun send(path: String, method: String, body: String?): Pair<Int, String> = 599 to ""
    suspend fun stream(path: String, body: String, onLine: (String) -> Unit): Int = 599
    fun planMade(said: String) {}
    /** The coming 7 days on the watch: how many of how many (null: can't tell); with `send`, send them and say how it went. */
    suspend fun watchWeek(send: Boolean): JSONObject? = null
    /** The coming week on other watches (rpc planOut): "state", "intervals", "intervalsOff", "hc", "hcOff" or "files"; {error} when it failed. */
    suspend fun planOut(op: String): JSONObject? = null
}

/** A session kind's colour, as `.k-*` on the web: easy green, long blue, tempo orange, hard brick; strength, swims and rides grey. */
@Composable
fun kindColour(kind: String): Color {
    val d = LocalData.current
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    return when (kind) {
        "easy", "recovery" -> d.good
        "long" -> d.pace
        "tempo", "hills" -> Color(0xFFD8653B)
        "intervals", "race" -> if (dark) Color(0xFFF7BC95) else Color(0xFF5E1D10)
        else -> if (dark) Color(0xFF8F8280) else Color(0xFF9A8B88)
    }
}

/** A session kind's icon: strength a bolt, a swim and a ride their own, the rest a run. */
fun kindGlyph(kind: String): String = when (kind) { "strength" -> "bolt"; "swim" -> "swim"; "ride" -> "ride"; else -> "run" }

private fun Color.luminance() = 0.2126f * red + 0.7152f * green + 0.0722f * blue

private val CARD = RoundedCornerShape(28.dp)

/**
 * Coach, native: the plan first. Under the header, This week or the whole plan with Change plan
 * beside it (ill, away, busy: LifeButton) and one line on the watch (WatchLine); the week's
 * sessions; the coach's suggestion (or what it last changed) and the week's review under the week
 * they change; then the plan at a glance, the paces and zones, the pointers; the ask bar above
 * the bar. A session opens its sheet; the ask bar opens the chat. Where the plan goes for the watch
 * is set in Settings → Sources (PlanWatchCard).
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun CoachScreen(coach: Coach?, actions: CoachActions, weeklySeen: String? = null, navSpace: Boolean = true, maker: PlanMaker? = null, setup: CoachSetupModel? = null) {
    val cs = MaterialTheme.colorScheme
    val pageScroll = rememberScrollState()
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var mode by rememberSaveable { mutableStateOf(0) }
    var busy by remember { mutableStateOf<String?>(null) }
    val barSpace = if (navSpace) 88.dp else 12.dp
    val write: (String, String?, String, String) -> Unit = { path, body, doing, done ->
        busy = doing
        scope.launch {
            val err = actions.post(path, body)
            busy = null
            snack.showSnackbar(err?.let { str(R.string.coach_couldn_t, it) } ?: done)
        }
    }

    Box(Modifier.fillMaxSize().background(cs.surface)) {
        Column(
            Modifier
                .fillMaxSize()
                // Above the keyboard while typing (the first plan's answers), so the field stays in view.
                .imePadding()
                .verticalScroll(pageScroll)
                .padding(start = 16.dp, end = 16.dp, top = top + 60.dp, bottom = bottom + barSpace + 84.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val p = coach?.plan
            PageHeader(stringResource(R.string.common_coach), subtitle = if (p != null) pluralStringResource(R.plurals.coach_plan_updated_weeks, coach.weeks.size, coach.weeks.size, ago(p.updated)) else stringResource(R.string.coach_your_plan_and_your_coach))
            if (coach == null) {
                Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(64.dp)) }
                return@Column
            }
            // No plan yet, or the last one has ended (and nothing new is waiting): making one.
            if (p == null || (coach.ended && coach.proposal == null)) { NoPlan(coach, maker, setup, actions); return@Column }
            var i = 0
            val current = coach.weeks.firstOrNull { it.time == "current" }
            val later = coach.weeks.filter { it.time == "future" }
            val say: (String) -> Unit = { said -> scope.launch { snack.showSnackbar(said) } }
            // The plan first: which weeks, a change of plan (ill, away, busy), and one line on the watch.
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Segmented(listOf(stringResource(R.string.common_this_week), stringResource(R.string.coach_whole_plan)), mode, { mode = it }, Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                LifeButton(coach.today, coach.ill, actions, say = say)
            }
            WatchLine(actions, coach.today, Modifier.fillMaxWidth().padding(start = 4.dp), say)
            // A suggestion from the week's review carries the review: one card, not two that seem to disagree.
            val weekly = coach.weekly?.takeIf { it.week != weeklySeen && runCatching { java.time.LocalDate.parse(it.week).plusDays(6) >= java.time.LocalDate.parse(coach.today) }.getOrDefault(false) }
            val fromReview = coach.proposal?.from == FROM["weekly"]
            // What the coach suggests or last changed, and the week's review: right under the week they change.
            val changes: @Composable () -> Unit = {
                coach.proposal?.let { pr ->
                    ProposalCard(pr, busy, Modifier.reveal(i++), review = weekly?.text?.takeIf { fromReview },
                        accept = { write("/api/plan/proposal", """{"accept":true,"base":${org.json.JSONObject.quote(pr.base)}}""", str(R.string.coach_accepting), str(R.string.coach_plan_changed_your_watch_gets_it)) },
                        keep = { write("/api/plan/proposal", """{"accept":false}""", str(R.string.coach_keeping), str(R.string.coach_kept_your_plan_as_it_was)) },
                        talk = pr.conversation?.let { c -> { actions.chat(c, null) } })
                } ?: coach.lastChange?.let { l ->
                    UndoCard(l, Modifier.reveal(i++)) { write("/api/plan/revert", null, str(R.string.coach_undoing), str(R.string.coach_your_plan_is_back_as_it)) }
                }
                weekly?.takeIf { !fromReview || coach.proposal == null }?.let { w ->
                    WeeklyCard(w, Modifier.reveal(i++), close = { actions.dismissWeekly(w.week) }, talk = { actions.chat(w.conversation, null) })
                }
            }
            Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (mode == 0) {
                    if (current != null) WeekCard(current, stringResource(R.string.common_this_week), coach.today, actions, Modifier.reveal(i++))
                    else EmptyCard(stringResource(R.string.coach_no_sessions_this_week), stringResource(R.string.coach_ask_your_coach_to_carry_the))
                    changes()
                    later.firstOrNull()?.let { WeekCard(it, stringResource(R.string.common_next_week), coach.today, actions, Modifier.reveal(i++)) }
                    if (later.size > 1) {
                        FilledTonalButton(onClick = { mode = 1 }, shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth()) {
                            Text(pluralStringResource(R.plurals.coach_more_weeks, later.size - 1, later.size - 1))
                        }
                    }
                } else {
                    WholePlan(coach, actions)
                    changes()
                }
            }
            Overview(p, coach.goal, current, Modifier.reveal(i++))
            if (p.zones.isNotEmpty()) Zones(p.zones)
            if (p.advice.isNotEmpty()) Advice(p.advice)
        }
        // The status bar's soft fade, as on Today.
        TopScrim(pageScroll.value > 0)
        // The ask bar, above the floating bar (or the coach's setup, without one), over a soft fade so
        // the plan scrolls away beneath them rather than showing between.
        if (coach != null && (coach.plan != null || coach.ready)) {
            Box(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(bottom + barSpace + 96.dp)
                    .background(Brush.verticalGradient(0f to cs.surface.copy(alpha = 0f), 0.35f to cs.surface.copy(alpha = 0.92f), 1f to cs.surface)),
            )
            Column(Modifier.align(Alignment.BottomCenter).padding(start = 16.dp, end = 16.dp, bottom = bottom + barSpace - navDrop())) {
                SnackbarHost(snack)
                if (coach.plan == null) AskBar(stringResource(R.string.coach_or_just_ask_your_coach_anything)) { actions.chat(null, null) }
                else if (coach.ready) AskBar(stringResource(R.string.coach_ask_your_coach_or_change_the)) { actions.chat(coach.plan.conversation, null) }
                else FilledTonalButton(onClick = { actions.go("settings/coach") }, shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth()) {
                    Icon(Glyphs["coach"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.coach_set_up_your_coach_to_talk))
                }
            }
        }
    }
}

@Composable
fun AskBar(text: String, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(
        Modifier
            .fillMaxWidth()
            .widthIn(max = 640.dp)
            .height(56.dp)
            .press(scale = 0.98f, label = text, onClick = onClick)
            .clip(CircleShape)
            .background(cs.surfaceContainerHigh)
            .padding(start = 20.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, Modifier.weight(1f), color = cs.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Box(Modifier.size(44.dp).clip(CircleShape).background(cs.primary), contentAlignment = Alignment.Center) {
            Icon(Glyphs["up"], null, Modifier.size(20.dp).graphicsLayer { rotationZ = 90f }, tint = cs.onPrimary)
        }
    }
}

@Composable
private fun Card(modifier: Modifier = Modifier, fill: Color = MaterialTheme.colorScheme.surfaceContainer, content: @Composable () -> Unit) {
    Box(modifier.fillMaxWidth().clip(CARD).background(fill).padding(20.dp)) { content() }
}

@Composable
private fun EmptyCard(title: String, text: String) = Card {
    Column { Text(title, style = MaterialTheme.typography.titleLarge); Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

@Composable
private fun ChangeRows(changes: List<Change>) {
    val cs = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        changes.forEach { c ->
            Row {
                Box(Modifier.padding(top = 2.dp).size(28.dp).clip(CircleShape).background(cs.secondaryContainer), contentAlignment = Alignment.Center) {
                    Icon(Glyphs[when (c.type) { "added" -> "plus"; "removed" -> "warn"; "zones" -> "heart"; else -> "spark" }], null, Modifier.size(16.dp), tint = cs.onSecondaryContainer)
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(c.headline, style = MaterialTheme.typography.titleSmall)
                    Text(c.detail, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                    c.why?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ProposalCard(p: Proposal, busy: String?, modifier: Modifier, review: String? = null, accept: () -> Unit, keep: () -> Unit, talk: (() -> Unit)?) {
    val cs = MaterialTheme.colorScheme
    val n = p.changes.size
    Card(modifier, fill = cs.primaryContainer) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column {
                Text(if (review != null) pluralStringResource(R.plurals.coach_review_changes, n, n) else pluralStringResource(R.plurals.coach_suggests, n, n), style = MaterialTheme.typography.titleLarge, color = cs.onPrimaryContainer)
                Text("${p.from} · ${ago(p.at)}", style = MaterialTheme.typography.bodyMedium, color = cs.onPrimaryContainer.copy(alpha = 0.75f))
            }
            review?.let { Markdown(it, cs.onPrimaryContainer) }
            p.note?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = cs.onPrimaryContainer) }
            Box(Modifier.clip(RoundedCornerShape(20.dp)).background(cs.surfaceContainerLowest.copy(alpha = 0.6f)).padding(14.dp)) { ChangeRows(p.changes) }
            Text(stringResource(R.string.coach_days_already_behind_you_stay_as), style = MaterialTheme.typography.bodySmall, color = cs.onPrimaryContainer.copy(alpha = 0.8f))
            ButtonFlow {
                Button(onClick = accept, enabled = busy == null, shapes = ButtonDefaults.shapes()) {
                    Icon(Glyphs["check"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); ButtonText(if (busy == "Accepting") stringResource(R.string.coach_accepting_2) else stringResource(R.string.coach_accept))
                }
                // Declines it (the plan stays as it is): said as what it does.
                TextButton(onClick = keep, enabled = busy == null) { ButtonText(stringResource(R.string.coach_keep_my_plan)) }
                talk?.let { TextButton(onClick = it) { ButtonText(stringResource(R.string.coach_ask_about_it)) } }
            }
        }
    }
}

@Composable
private fun UndoCard(l: LastChange, modifier: Modifier, undo: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var open by rememberSaveable { mutableStateOf(false) }
    val n = l.changes.size
    Card(modifier) {
        Column(Modifier.animateContentSize()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).press(onClick = { open = !open }), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Glyphs["check"], null, Modifier.size(18.dp), tint = LocalData.current.good)
                    Spacer(Modifier.width(8.dp))
                    Text(if (l.auto) pluralStringResource(R.plurals.coach_made_changes, n, n, ago(l.at)) else pluralStringResource(R.plurals.coach_changes_taken, n, n, ago(l.at)), style = MaterialTheme.typography.titleSmall)
                }
                TextButton(onClick = undo) { Text(stringResource(R.string.common_undo)) }
            }
            if (open) { Spacer(Modifier.height(10.dp)); ChangeRows(l.changes) }
        }
    }
}

@Composable
private fun WeeklyCard(w: Weekly, modifier: Modifier, close: () -> Unit, talk: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Card(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(if (w.proposed > 0) stringResource(R.string.coach_changes_suggested_for_next_week) else if (w.changed) stringResource(R.string.coach_next_week_adjusted) else stringResource(R.string.coach_next_week_stays_as_planned), style = MaterialTheme.typography.titleLarge)
                    Text(stringResource(R.string.coach_week_review, dayName(w.at)), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
                FilledTonalIconButton(onClick = close, colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = cs.surfaceContainerHigh)) {
                    Icon(Glyphs["plus"], stringResource(R.string.coach_put_away), Modifier.size(18.dp).graphicsLayer { rotationZ = 45f })
                }
            }
            Markdown(w.text)
            TextButton(onClick = talk) { Icon(Glyphs["coach"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.coach_talk_it_through)) }
        }
    }
}

/** The coach's words, simply: paragraphs, "- " points and **bold**. */
@Composable
fun Markdown(text: String, color: Color = MaterialTheme.colorScheme.onSurface) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        text.trim().split(Regex("\n\\s*\n")).forEach { para ->
            val lines = para.lines()
            if (lines.all { it.trimStart().startsWith("- ") || it.trimStart().startsWith("* ") }) {
                lines.forEach { l ->
                    Row { Text("•", color = color, modifier = Modifier.width(16.dp)); Text(bold(l.trimStart().drop(2)), color = color, style = MaterialTheme.typography.bodyLarge) }
                }
            } else {
                val h = para.trimStart().startsWith("#")
                Text(bold(para.trimStart('#', ' ').replace("\n", " ")), color = color, style = if (h) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

private fun bold(s: String): AnnotatedString = buildAnnotatedString {
    var rest = s
    while (true) {
        val a = rest.indexOf("**")
        val b = if (a >= 0) rest.indexOf("**", a + 2) else -1
        if (a < 0 || b < 0) { append(rest); break }
        append(rest.substring(0, a))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(rest.substring(a + 2, b)) }
        rest = rest.substring(b + 2)
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Overview(p: PlanInfo, goal: String?, w: PWeek?, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    var more by rememberSaveable { mutableStateOf(false) }
    Card(modifier) {
        Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(p.title, style = MaterialTheme.typography.headlineSmall)
            goal?.let {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Glyphs["clock"], null, Modifier.size(16.dp), tint = cs.primary); Spacer(Modifier.width(6.dp))
                    Text(it, style = MaterialTheme.typography.titleSmall, color = cs.primary)
                }
            }
            if (w != null && w.planned > 0) {
                val share = (w.done.toFloat() / w.planned).coerceIn(0f, 1f)
                val shown by animateFloatAsState(share, MaterialTheme.motionScheme.slowSpatialSpec(), label = "share")
                Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.Bottom) {
                    Text(stringResource(R.string.coach_of_sessions, w.done, w.planned), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    Text(if (w.km > 0) stringResource(R.string.coach_of_km_this_week, km(w.doneKm, 1), km(w.km, 0)) else duration(w.doneMinutes), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
                LinearWavyProgressIndicator(
                    progress = { shown },
                    modifier = Modifier.fillMaxWidth().height(14.dp),
                    color = if (share >= 1f) LocalData.current.good else cs.primary,
                    trackColor = cs.surfaceContainerHighest,
                )
            }
            Text(p.summary, style = MaterialTheme.typography.bodyLarge, color = cs.onSurfaceVariant, maxLines = if (more) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis)
            if (p.summary.length > 160) TextButton(onClick = { more = !more }) { Text(if (more) stringResource(R.string.common_less) else stringResource(R.string.common_more)) }
        }
    }
}

@Composable
private fun WeekCard(w: PWeek, title: String, today: String, actions: CoachActions, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Card(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            Text(listOfNotNull(range(w.start), w.km.takeIf { it > 0 }?.let { stringResource(R.string.common_n_km, km(it, 0)) }, w.minutes.takeIf { it > 0 }?.let { duration(it) }).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            if (w.focus.isNotEmpty()) Text(w.focus, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
            Spacer(Modifier.height(8.dp))
            Days(w, today, actions)
        }
    }
}

/** A week day by day: the date, then each session as a quiet row (its colour, its name, one line, where it stands). */
@Composable
private fun Days(w: PWeek, today: String, actions: CoachActions) {
    val cs = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        w.days.forEach { d ->
            val isToday = d.date == today
            val past = d.date < today
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.Top) {
                Column(Modifier.width(48.dp).padding(top = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(dayName(d.date), style = MaterialTheme.typography.labelMedium, color = if (isToday) cs.primary else cs.onSurfaceVariant)
                    Box(
                        Modifier.size(34.dp).clip(RoundedCornerShape(12.dp)).background(if (isToday) cs.primary else Color.Transparent),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(d.date.takeLast(2).trimStart('0'), fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, color = if (isToday) cs.onPrimary else if (past) cs.onSurfaceVariant else cs.onSurface)
                    }
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (d.sessions.isEmpty() && d.extras.isEmpty()) {
                        Text(stringResource(R.string.common_rest), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(start = 12.dp, top = 14.dp))
                    }
                    d.sessions.forEach { s -> SessionRow(s) { actions.openSession(s.date, s.kind) } }
                    d.extras.forEach { x ->
                        Row(Modifier.press(onClick = { actions.openActivity(x.id) }).clip(CircleShape).background(cs.secondaryContainer).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            // Done, beyond the plan: a tick, not a plus (which reads as "add this").
                            Icon(Glyphs["check"], null, Modifier.size(14.dp), tint = cs.onSecondaryContainer); Spacer(Modifier.width(4.dp))
                            Text(x.label, style = MaterialTheme.typography.labelLarge, color = cs.onSecondaryContainer)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionRow(s: PSession, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    Row(
        Modifier.fillMaxWidth().press(scale = 0.98f, label = s.title, onClick = onClick).clip(RoundedCornerShape(18.dp)).background(cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(kindColour(s.kind)))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(s.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(s.line, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        when (s.status) {
            "done" -> Box(Modifier.size(28.dp).clip(CircleShape).background(data.goodContainer), contentAlignment = Alignment.Center) { Icon(Glyphs["check"], stringResource(R.string.common_done), Modifier.size(16.dp), tint = data.good) }
            "missed" -> Pill(stringResource(R.string.coach_missed), cs.errorContainer, cs.onErrorContainer)
            "today" -> Pill(stringResource(R.string.common_today), cs.primary, cs.onPrimary)
        }
    }
}

@Composable
private fun Pill(text: String, fill: Color, ink: Color) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = ink, modifier = Modifier.clip(CircleShape).background(fill).padding(horizontal = 10.dp, vertical = 4.dp))
}

/** Every week at a glance: number, focus, volume as a bar on one scale, a dot a day; tap for its days. */
@Composable
private fun WholePlan(c: Coach, actions: CoachActions) {
    val cs = MaterialTheme.colorScheme
    val max = (c.weeks.maxOfOrNull { if (it.km > 0) it.km else it.minutes } ?: 1.0).coerceAtLeast(1.0)
    val byKm = c.weeks.all { it.km > 0 }
    var open by rememberSaveable { mutableStateOf(c.weeks.indexOfFirst { it.time == "current" }) }
    Card {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(stringResource(R.string.coach_the_whole_plan), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.coach_weeks, c.weeks.size), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(bottom = 10.dp))
            c.weeks.forEachIndexed { i, w ->
                val vol = if (byKm) w.km else w.minutes
                val state = when (w.time) { "past" -> stringResource(R.string.coach_of_done, w.done, w.planned); "current" -> stringResource(R.string.coach_this_week_of_done, w.done, w.planned); else -> stringResource(R.string.common_sessions, w.planned) }
                val first = i == 0
                val last = i == c.weeks.lastIndex
                val shape = RoundedCornerShape(if (first) 20.dp else 6.dp, if (first) 20.dp else 6.dp, if (last) 20.dp else 6.dp, if (last) 20.dp else 6.dp)
                Column(Modifier.fillMaxWidth().clip(shape).background(if (w.time == "current") cs.secondaryContainer else cs.surfaceContainerHigh)) {
                    Row(Modifier.fillMaxWidth().press(scale = 0.99f, onClick = { open = if (open == i) -1 else i }).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("${i + 1}", fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, modifier = Modifier.width(28.dp), color = if (w.time == "past") cs.onSurfaceVariant else cs.onSurface)
                        Column(Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(w.focus, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                if (w.race) { Spacer(Modifier.width(6.dp)); Pill(stringResource(R.string.common_race_week), cs.primary, cs.onPrimary) }
                            }
                            Text(listOf(range(w.start), if (byKm) stringResource(R.string.common_n_km, km(vol, 0)) else duration(vol), state).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                            Box(Modifier.padding(top = 6.dp).fillMaxWidth().height(6.dp).clip(CircleShape).background(cs.surfaceContainerHighest)) {
                                Box(Modifier.fillMaxWidth((vol / max).toFloat().coerceIn(0.04f, 1f)).height(6.dp).clip(CircleShape).background(if (w.time == "past") cs.outline else cs.primary))
                            }
                        }
                        Spacer(Modifier.width(10.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            w.days.forEach { d ->
                                val s = d.sessions.firstOrNull()
                                val k = s?.let { kindColour(it.kind) }
                                Box(
                                    Modifier.size(8.dp).clip(CircleShape).let {
                                        when {
                                            s == null -> it.background(cs.surfaceContainerHighest)
                                            s.status == "done" -> it.background(k!!)
                                            s.status == "missed" -> it.background(k!!.copy(alpha = 0.3f))
                                            else -> it.border(1.5.dp, k!!, CircleShape)
                                        }
                                    },
                                )
                            }
                        }
                    }
                    AnimatedVisibility(open == i, enter = expandVertically(MaterialTheme.motionScheme.defaultSpatialSpec()) + fadeIn(), exit = shrinkVertically(MaterialTheme.motionScheme.defaultSpatialSpec()) + fadeOut()) {
                        Box(Modifier.padding(start = 4.dp, end = 8.dp, bottom = 8.dp)) { Days(w, c.today, actions) }
                    }
                }
            }
        }
    }
}

@Composable
private fun Zones(zones: List<Zone>) {
    val cs = MaterialTheme.colorScheme
    var open by rememberSaveable { mutableStateOf(false) }
    Card(Modifier.press(scale = 0.99f, onClick = { open = !open })) {
        Column(Modifier.animateContentSize()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.coach_your_paces_and_zones), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                Icon(Glyphs["chevron"], null, Modifier.graphicsLayer { rotationZ = if (open) 90f else 0f }, tint = cs.onSurfaceVariant)
            }
            if (open) {
                Spacer(Modifier.height(12.dp))
                zones.forEach { z ->
                    Row(Modifier.padding(vertical = 6.dp)) {
                        Text(z.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.width(110.dp))
                        Column(Modifier.weight(1f)) {
                            Text(z.line, style = MaterialTheme.typography.bodyMedium)
                            z.use?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Advice(advice: List<String>) = Card {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.coach_pointers_from_your_coach), style = MaterialTheme.typography.titleLarge)
        advice.forEach { a -> Row { Text("•", modifier = Modifier.width(16.dp)); Text(a, style = MaterialTheme.typography.bodyLarge) } }
    }
}
