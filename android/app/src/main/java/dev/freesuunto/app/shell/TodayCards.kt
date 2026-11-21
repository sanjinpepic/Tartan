package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

private val CARD = RoundedCornerShape(28.dp)

@Composable
private fun TCard(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val m = modifier.fillMaxWidth().let { if (onClick != null) it.press(onClick = onClick) else it }
    Column(m.clip(CARD).background(MaterialTheme.colorScheme.surfaceContainer).padding(20.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }
}

/** A day's planned session on Today: what, the shoes for it, the weather-free details, and Mark done. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun TodaySession(s: Session, modifier: Modifier, open: () -> Unit, openWorkout: (String) -> Unit, mark: (() -> Unit)?) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val done = s.status == "done"
    TCard(modifier, open) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(52.dp).clip(RoundedCornerShape(18.dp)).background(if (done) data.goodContainer else cs.primaryContainer), contentAlignment = Alignment.Center) {
                Icon(if (done) Glyphs["check"] else Glyphs[if (s.kind == "strength") "bolt" else "run"], null, tint = if (done) data.good else cs.onPrimaryContainer)
            }
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                // The session's name leads; when and what kind sit under it.
                Text(s.title, style = MaterialTheme.typography.titleLarge)
                Text(listOf(if (done) stringResource(R.string.common_done_today) else kindWord(s.kind, s.title)?.let { stringResource(R.string.today_today, it) } ?: stringResource(R.string.common_today), s.detail).filter { it.isNotEmpty() }.joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            Icon(Glyphs["chevron"], null, tint = cs.onSurfaceVariant)
        }
        if (!done) s.shoe?.let { (name, why) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Glyphs["run"], null, Modifier.size(16.dp), tint = cs.onSurfaceVariant)
                Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(name) }; append(" · $why") }, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 8.dp))
            }
        }
        s.notes?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        when {
            s.activityId != null && s.did != null -> Row(
                Modifier.fillMaxWidth().press(scale = 0.98f, onClick = { openWorkout(s.activityId) }).clip(RoundedCornerShape(16.dp)).background(data.goodContainer).padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Glyphs["check"], null, Modifier.size(16.dp), tint = data.good)
                Text(s.did, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f).padding(start = 8.dp))
                Icon(Glyphs["chevron"], null, Modifier.size(16.dp))
            }
            s.manual -> Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Glyphs["check"], null, Modifier.size(16.dp), tint = data.good)
                Text(stringResource(R.string.common_marked_done_by_you), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 8.dp))
            }
            mark != null -> FilledTonalButton(onClick = mark, shapes = ButtonDefaults.shapes()) { Icon(Glyphs["check"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.common_mark_done)) }
        }
    }
}

/** No session today: a rest day, and what's next. */
@Composable
fun RestDay(next: Session?, modifier: Modifier, open: (Session) -> Unit, toPlan: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    TCard(modifier, next?.let { { open(it) } }) {
        Text(stringResource(R.string.common_rest_day), style = MaterialTheme.typography.titleLarge)
        next?.let { n -> Text(stringResource(R.string.today_next_session, dayName(n.date), n.title, n.detail.split(" · ").take(2).joinToString(" · ").let { if (it.isEmpty()) "" else " · $it" }), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
        TextButton(onClick = toPlan, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(stringResource(R.string.today_see_the_plan)) }
    }
}

/**
 * No plan yet: Tartan's own rules make one from the workouts it has, no key needed. Make my plan
 * opens Coach's few questions (each with Not sure), then the plan is there.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun NoPlanCard(modifier: Modifier, make: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    TCard(modifier, make) {
        Text(stringResource(R.string.coach_no_plan_yet), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.today_tartan_makes_one_from_your_workouts), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        Button(onClick = make, shapes = ButtonDefaults.shapes()) { Icon(Glyphs["spark"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.coach_make_my_plan)) }
    }
}

/** This morning's body from the watch: resting heart rate against your usual, last night, oxygen. A tap opens Body. */
@Composable
fun VitalsRow(v: Vitals, open: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    Row(Modifier.fillMaxWidth().press(scale = 0.98f, label = stringResource(R.string.common_your_body), onClick = open).clip(RoundedCornerShape(18.dp)).background(cs.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        @Composable
        fun item(icon: String, value: String, label: String, warn: Boolean = false, m: Modifier) = Row(m, verticalAlignment = Alignment.CenterVertically) {
            Icon(Glyphs[icon], null, Modifier.size(16.dp), tint = if (warn) data.watch else cs.onSurfaceVariant)
            Column(Modifier.padding(start = 6.dp)) {
                Text(value, style = Figure.S, color = if (warn) data.watch else cs.onSurface)
                Text(label, style = MaterialTheme.typography.labelSmall, color = cs.onSurfaceVariant)
            }
        }
        val d = v.restDiff
        // Only what the watch measured: a missing reading is left out, not shown as a dash.
        v.rest?.let { item("heart", it.toString(), if (d != null && kotlin.math.abs(d) >= 3) stringResource(R.string.today_resting_diff, "${if (d > 0) "+" else "−"}${kotlin.math.abs(d)}") else stringResource(R.string.today_resting), d != null && d >= 7, Modifier.weight(1f)) }
        v.sleepMin?.let { item("moon", duration(it), stringResource(R.string.today_last_night), m = Modifier.weight(1f)) }
        v.oxygen?.let { item("drop", "${Math.round(it)}%", stringResource(R.string.today_oxygen), m = Modifier.weight(1f)) }
        Icon(Glyphs["chevron"], null, Modifier.size(16.dp), tint = cs.onSurfaceVariant)
    }
}

private val SLEEP get() = listOf(str(R.string.today_badly), "OK", str(R.string.today_well))
private val LEGS get() = listOf(str(R.string.today_heavy), str(R.string.today_normal), str(R.string.common_fresh))
private val HURT get() = listOf(str(R.string.today_a_niggle), str(R.string.today_sore), str(R.string.today_painful))

/** A row of three answers; the chosen one filled. */
@Composable
private fun Answers(label: String?, words: List<String>, chosen: Int?, enabled: Boolean = true, pick: (Int) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        label?.let { Text(it, style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant, modifier = Modifier.width(52.dp)) }
        words.forEachIndexed { i, w ->
            val on = chosen == i + 1
            Text(
                w,
                style = MaterialTheme.typography.labelLarge,
                color = if (on) cs.onPrimary else if (enabled) cs.onSurface else cs.onSurface.copy(alpha = 0.4f),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                modifier = Modifier.weight(1f).let { if (enabled) it.press(scale = 0.94f, role = Role.RadioButton, onClick = { pick(i + 1) }) else it }
                    .clip(RoundedCornerShape(if (on) 20.dp else 12.dp)).background(if (on) cs.primary else cs.surfaceContainerHigh).padding(vertical = 10.dp),
            )
        }
    }
}

/**
 * The morning check (web/views/today.ts morningCheck): how your legs feel (and how you slept,
 * when the watch didn't measure the night), something that hurts, then the verdict; on a bad
 * day with a hard session planned, the offer to swap it for an easy run. It stays open until
 * every question asked is answered, then folds to what you said, with Change; changed, it folds
 * again with Done or a few seconds after the last answer (not while picking where it hurts).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MorningCheck(m: TodayModel) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val c = m.check ?: return
    var painOpen by remember { mutableStateOf(false) }
    var area by remember { mutableStateOf<String?>(null) }
    val open = !c.complete || m.checkEditing
    // Changing it: fold a few seconds after the last answer, unless you're picking where it hurts.
    LaunchedEffect(m.checkTouched, painOpen, c.complete) {
        if (m.checkEditing && c.complete && !painOpen && m.checkTouched > 0) { kotlinx.coroutines.delay(3000); m.checkEditing = false }
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.animateContentSize()) {
        if (!open) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.today_morning_check, c.reasons.joinToString(stringResource(R.string.common_list_sep)).ifEmpty { stringResource(R.string.today_all_good) }), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { m.checkTouched = 0; m.checkEditing = true }) { Text(stringResource(R.string.common_change)) }
            }
        } else {
            Text(if (c.measured) stringResource(R.string.today_how_do_your_legs_feel_this) else stringResource(R.string.today_how_do_you_feel_this_morning), style = MaterialTheme.typography.titleLarge)
            if (!c.measured) Answers(stringResource(R.string.today_sleep), SLEEP, c.sleep, !m.busy) { m.answer(sleep = it) }
            Answers(if (c.measured) null else stringResource(R.string.today_legs), LEGS, c.legs, !m.busy) { m.answer(legs = it) }
            if (painOpen) {
                Text(stringResource(R.string.today_where_does_it_hurt), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Words.AREAS.forEach { a ->
                        val on = (area ?: c.pain?.first) == a
                        Text(
                            Words.area(a), style = MaterialTheme.typography.labelLarge, color = if (on) cs.onPrimary else cs.onSurface,
                            modifier = Modifier.press(scale = 0.94f, role = Role.RadioButton, onClick = { area = if (area == a) null else a })
                                .clip(RoundedCornerShape(12.dp)).background(if (on) cs.primary else cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                    }
                }
                Text(stringResource(R.string.today_how_much), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
                val where = area ?: c.pain?.first
                Answers(null, HURT, c.pain?.takeIf { it.first == where }?.second, where != null && !m.busy) { lv -> painOpen = false; m.answer(pain = where!! to lv) }
                TextButton(onClick = { painOpen = false; area = null; m.answer(clearPain = true) }) { Text(stringResource(R.string.today_nothing_hurts)) }
            } else {
                TextButton(onClick = { painOpen = true }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                    Text(c.pain?.let { (a, lv) -> stringResource(R.string.today_pain_change, Words.area(a), HURT.getOrElse(lv - 1) { "" }.lowercase()) } ?: stringResource(R.string.today_something_hurts))
                }
            }
            if (c.complete) Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = when (c.level) { "ready" -> data.good; "rest" -> cs.error; else -> data.watch })) { append(c.verdict) }
                    if (c.why.isNotEmpty()) append(" ${c.why}")
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            if (m.checkEditing && c.complete && !painOpen) FilledTonalButton(onClick = { m.checkEditing = false }) { Text(stringResource(R.string.common_done)) }
        }
        when {
            c.swappedFrom != null && !c.sessionDone -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.today_is_swapped_for_an_easy_run, c.swappedFrom), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { m.swap(undo = true) {} }, enabled = !m.busy) { Text(stringResource(R.string.today_undo_the_swap)) }
            }
            c.suggestSwap && c.sessionTitle != null -> FilledTonalButton(onClick = { m.swap(undo = false) {} }, enabled = !m.busy) { Text(stringResource(R.string.today_swap_for_an_easy_run, c.sessionTitle)) }
        }
    }
}

/** What the readiness numbers mean, folded. */
@Composable
fun Explain(r: Readiness) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Column(Modifier.animateContentSize()) {
        TextButton(onClick = { open = !open }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(if (open) stringResource(R.string.today_hide_what_the_numbers_mean) else stringResource(R.string.today_what_do_these_numbers_mean)) }
        if (open) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(
                stringResource(R.string.today_fitness_n, Math.round(r.fitness)) to stringResource(R.string.today_your_average_daily_training_effort_over),
                stringResource(R.string.today_fatigue_n, Math.round(r.fatigue)) to stringResource(R.string.today_the_same_average_over_just_the),
                stringResource(R.string.today_form_n, "${if (r.form > 0) "+" else ""}${Math.round(r.form)}") to stringResource(R.string.today_fitness_minus_fatigue_below_10_you),
            ).forEach { (k, v) ->
                Text(k, style = MaterialTheme.typography.titleSmall)
                Text(v, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
        }
    }
}

/** The way to Body: muscles, sleep and vitals. */
@Composable
fun BodyLink(open: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().press(scale = 0.98f, label = stringResource(R.string.common_your_body), onClick = open).clip(RoundedCornerShape(18.dp)).background(cs.surfaceContainerHigh).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(36.dp).clip(CircleShape).background(cs.secondaryContainer), contentAlignment = Alignment.Center) { Icon(Glyphs["body"], null, Modifier.size(20.dp), tint = cs.onSecondaryContainer) }
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text(stringResource(R.string.common_your_body), style = MaterialTheme.typography.titleSmall)
            Text(stringResource(R.string.today_muscles_sleep_and_vitals), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
        Icon(Glyphs["chevron"], null, Modifier.size(18.dp), tint = cs.onSurfaceVariant)
    }
}

/** Your race: when, the target, and the prediction against it. A tap opens Progress. */
@Composable
fun RaceCard(r: RaceGoal, modifier: Modifier, open: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val whenText = r.daysToGo?.let { d -> if (d > 1) stringResource(R.string.today_in_days, d) else if (d == 1) "tomorrow" else if (d == 0) "today" else "done" }
    TCard(modifier, open) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(r.name, style = MaterialTheme.typography.titleLarge)
                Text(listOfNotNull(stringResource(R.string.common_n_km, km(r.km, 1)), r.date?.let { dateShort(it) }, r.targetS?.let { stringResource(R.string.today_target, clock(it)) }).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                whenText?.let { Text(it, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FlexRound), color = cs.primary) }
                r.onTrack?.let { on ->
                    Text(
                        if (on) stringResource(R.string.today_on_track) else r.predictedS?.let { stringResource(R.string.today_predicted, clock(it)) } ?: stringResource(R.string.today_behind_target),
                        style = MaterialTheme.typography.labelMedium, color = if (on) data.good else cs.onSurfaceVariant,
                        modifier = Modifier.clip(CircleShape).background(if (on) data.goodContainer else cs.surfaceContainerHigh).padding(horizontal = 10.dp, vertical = 4.dp),
                    )
                }
            }
        }
    }
}

/** Race week takes over from the countdown at this many days to go (src/race-countdown.ts). */
const val RACE_WEEK_DAYS = 7

/**
 * From twelve weeks out until race week: the days to go, the predicted time and how it moved over
 * the last four weeks, the target and whether it's on track, and in the last two weeks the taper.
 * A tap opens Progress.
 */
@Composable
fun RaceCountdownCard(r: RaceGoal, c: RaceGoal.Countdown, modifier: Modifier, open: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    TCard(modifier, open) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(r.name, style = MaterialTheme.typography.titleLarge)
                Text(listOfNotNull(stringResource(R.string.common_n_km, km(r.km, 1)), r.date?.let { dateShort(it) }).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("${c.daysToGo}", style = Figure.M, color = cs.primary)
                Text(androidx.compose.ui.res.pluralStringResource(R.plurals.today_days_to_go, c.daysToGo), style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant)
            }
        }
        val p = r.predictedS
        if (p == null) Text(stringResource(R.string.today_no_prediction_yet), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val moved = c.changeS?.let { ch ->
                if (kotlin.math.abs(ch) < 5) stringResource(R.string.today_same_as_a_month_ago)
                else stringResource(if (ch < 0) R.string.today_quicker_than_a_month_ago else R.string.today_slower_than_a_month_ago, clock(kotlin.math.abs(ch)))
            }
            RaceTile(stringResource(R.string.today_predicted_2), clock(p), moved, if ((c.changeS ?: 0) <= -5) data.good else cs.onSurfaceVariant, Modifier.weight(1f))
            r.targetS?.let { t ->
                val gap = c.gapS
                RaceTile(
                    stringResource(R.string.common_target), clock(t),
                    gap?.let { if (it <= 0) stringResource(R.string.today_on_track) else stringResource(R.string.today_to_find, clock(it)) },
                    if (gap != null && gap <= 0) data.good else cs.onSurfaceVariant, Modifier.weight(1f),
                )
            }
        }
        if (c.taper) Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(cs.secondaryContainer).padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.today_the_taper), style = MaterialTheme.typography.titleSmall, color = cs.onSecondaryContainer)
            Text(stringResource(R.string.today_the_taper_text), style = MaterialTheme.typography.bodyMedium, color = cs.onSecondaryContainer)
        }
    }
}

/** A number in a tile: what it is, the number, and a line under it in its own colour. */
@Composable
private fun RaceTile(label: String, value: String, sub: String?, subColour: androidx.compose.ui.graphics.Color, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.clip(RoundedCornerShape(18.dp)).background(cs.surfaceContainerHigh).padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant)
        Text(value, style = Figure.S)
        sub?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = subColour) }
    }
}

/** In the last seven days: race week, the race and today's focus; pacing, fuel and checklist in a sheet. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun RaceWeekCard(r: RaceGoal, w: RaceWeek, modifier: Modifier, open: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val whenText = if (w.daysToGo > 1) stringResource(R.string.today_in_days, w.daysToGo) else if (w.daysToGo == 1) "tomorrow" else "today"
    Column(modifier.fillMaxWidth().clip(CARD).background(cs.primaryContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(r.name, style = MaterialTheme.typography.titleLarge, color = cs.onPrimaryContainer)
                Text(w.pacing?.let { stringResource(R.string.today_race_week_km_for, clock(Math.round(it.paceS).toInt()), clock(it.timeS)) } ?: stringResource(R.string.common_race_week), style = MaterialTheme.typography.bodyMedium, color = cs.onPrimaryContainer.copy(alpha = 0.8f))
            }
            Text(whenText, style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FlexRound), color = cs.onPrimaryContainer)
        }
        Text(w.focusTitle, style = MaterialTheme.typography.titleMedium, color = cs.onPrimaryContainer)
        Text(w.focusText, style = MaterialTheme.typography.bodyMedium, color = cs.onPrimaryContainer)
        FilledTonalButton(onClick = open, shapes = ButtonDefaults.shapes()) { Text(if (w.pacing != null) stringResource(R.string.today_pacing_fuel_and_checklist) else stringResource(R.string.today_fuel_and_checklist)) }
    }
}

/** Race week in full: pacing (and its workout for the watch), fuel, and a checklist kept on the phone. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun RaceWeekSheet(r: RaceGoal, w: RaceWeek, m: TodayModel, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var ticked by remember { mutableStateOf(m.ticked(r)) }
    val whenText = if (w.daysToGo > 1) stringResource(R.string.today_in_days, w.daysToGo) else if (w.daysToGo == 1) "tomorrow" else "today"
    Sheet(onClose) { close ->
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(start = 16.dp, end = 16.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(r.name, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                    Text(stringResource(R.string.today_race_week, whenText), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
                FilledTonalIconButton(onClick = close) { Icon(Glyphs["close"], stringResource(R.string.common_close)) }
            }
            w.pacing?.let { p ->
                Text(stringResource(R.string.today_pacing), style = MaterialTheme.typography.titleLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    val tiles = listOfNotNull(
                        (if (p.fromTarget) stringResource(R.string.common_target) else stringResource(R.string.today_predicted_2)) to clock(p.timeS),
                        stringResource(R.string.today_pace) to stringResource(R.string.common_per_km, clock(Math.round(p.paceS).toInt())),
                        p.checkpoints.firstOrNull()?.let { (k, t) -> str(R.string.today_at_km, km(k, if (k % 1 != 0.0) 1 else 0)) to clock(t) },
                    )
                    tiles.forEach { (k, v) ->
                        Column(Modifier.weight(1f).clip(RoundedCornerShape(18.dp)).background(cs.surfaceContainer).padding(12.dp)) {
                            Text(k, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant)
                            Text(v, style = Figure.S)
                        }
                    }
                }
                Text(
                    (if (p.checkpoints.size > 1) stringResource(R.string.today_even_pace, p.checkpoints.joinToString(str(R.string.common_list_sep)) { (k, t) -> str(R.string.today_km_in, km(k, if (k % 1 != 0.0) 1 else 0), clock(t)) }) else "") + p.start,
                    style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant,
                )
                FilledTonalButton(onClick = { m.pacingToWatch(r, w) }, enabled = !m.busy) { Icon(Glyphs["watch"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.today_pacing_workout_to_the_watch)) }
            }
            Text(stringResource(R.string.today_fuel), style = MaterialTheme.typography.titleLarge)
            w.fuel.forEach { Row { Text("•", modifier = Modifier.width(16.dp), color = cs.primary); Text(it, style = MaterialTheme.typography.bodyMedium) } }
            Text(stringResource(R.string.today_checklist), style = MaterialTheme.typography.titleLarge)
            w.checklist.forEach { item ->
                val on = item in ticked
                Row(Modifier.fillMaxWidth().press(scale = 0.98f, role = Role.Checkbox, onClick = { m.tick(r, item, !on); ticked = m.ticked(r) }), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(on, null)
                    Text(item, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 4.dp))
                }
            }
        }
    }
}

/** A note on Today that goes once dismissed (shoes found on Strava, which shoes, pairing a PC). */
@Composable
fun NoteCard(icon: String, title: String, text: String, go: String, quiet: String, modifier: Modifier, onGo: () -> Unit, onQuiet: () -> Unit, close: (() -> Unit)? = null) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row {
            Box(Modifier.size(40.dp).clip(CircleShape).background(cs.secondaryContainer), contentAlignment = Alignment.Center) { Icon(Glyphs[icon], null, Modifier.size(20.dp), tint = cs.onSecondaryContainer) }
            Column(Modifier.weight(1f).padding(start = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(text, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            close?.let { IconButton(onClick = it) { Icon(Glyphs["close"], stringResource(R.string.common_dismiss), Modifier.size(18.dp)) } }
        }
        // Under the words and the close button, the card's full width: a second button that doesn't fit drops a line.
        ButtonFlow(Modifier.padding(start = 54.dp)) {
            FilledTonalButton(onClick = onGo) { ButtonText(go) }
            TextButton(onClick = onQuiet) { ButtonText(quiet) }
        }
    }
}

/** The last workout's zones as one bar, with how much was easy. */
@Composable
fun EasyBar(zones: List<Double>, cap: Int?) {
    val total = zones.sum()
    if (total <= 0 || zones.size < 2) return
    val easy = Math.round((zones[0] + zones[1]) / total * 100).toInt()
    val colours = zoneColours()
    Text(cap?.let { stringResource(R.string.today_hr_easy_below, easy, it, 100 - easy) } ?: stringResource(R.string.today_hr_easy_zones, easy, 100 - easy), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    StackBar(zones.mapIndexed { i, s -> s to colours[i.coerceAtMost(4)] })
}

/** "Felt good" with five pips, from the watch. */
@Composable
fun Feeling(f: Int) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) { for (k in 1..5) Box(Modifier.size(10.dp).clip(CircleShape).background(if (k <= f) data.good else cs.surfaceContainerHighest)) }
        Text(stringResource(R.string.common_felt, (Words.FEELING[f] ?: "").lowercase()), style = MaterialTheme.typography.titleSmall)
        Text(stringResource(R.string.common_on_your_watch), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
    }
}
