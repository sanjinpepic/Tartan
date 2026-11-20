package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.animation.animateContentSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.LocalDate
import java.util.Locale

private val RANGES = listOf(7, 84, 182, 365)

/** The zone ramp, light and dark (the web's --z1…--z5). */
@Composable
fun zoneColours(): List<Color> = if (MaterialTheme.colorScheme.surface.let { 0.2126f * it.red + 0.7152f * it.green + 0.0722f * it.blue } < 0.5f)
    listOf(Color(0xFF822E1B), Color(0xFFB14325), Color(0xFFD8653B), Color(0xFFED8F60), Color(0xFFF7BC95))
else listOf(Color(0xFFF7BC95), Color(0xFFED8F60), Color(0xFFD8653B), Color(0xFFB14325), Color(0xFF5E1D10))

/** What Progress asks of the app: a workout's sheet, another screen. */
interface ProgressActions {
    fun openActivity(id: String)
    fun go(hash: String)
}

private val CARD = RoundedCornerShape(28.dp)

/**
 * Progress, native (the web's renderTrends): the long view, one range control scoping every card.
 * A range: totals, what's changing, the race, race shape, weekly distance, fitness, consistency,
 * intensity mix, easy-run efficiency, long runs, personal bests. The Week: one week day by day,
 * stepping back and forth. A new range slides in from the side of the option picked.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ProgressScreen(m: ProgressModel, actions: ProgressActions, navSpace: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    val pageScroll = rememberScrollState()
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    var forward by remember { mutableStateOf(true) }
    LaunchedEffect(m.range, m.weekOf) { m.ensure() }

    Box(Modifier.fillMaxSize().background(cs.surface)) {
        Column(
            Modifier.fillMaxSize().verticalScroll(pageScroll).padding(start = 16.dp, end = 16.dp, top = top + 60.dp, bottom = bottom + if (navSpace) 104.dp else 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PageHeader(stringResource(R.string.common_progress), subtitle = stringResource(R.string.progress_how_your_training_is_adding_up))
            Segmented(RANGES.map { RANGE_LABEL.getValue(it) }, RANGES.indexOf(m.range), { i ->
                forward = i > RANGES.indexOf(m.range)
                m.range = RANGES[i]
            })
            AnimatedContent(
                m.range to (if (m.range == 7) m.weekOf ?: "" else ""),
                transitionSpec = {
                    val d = if (forward) 1 else -1
                    (fadeIn(tween(220, 60)) + slideInHorizontally { d * it / 8 }) togetherWith (fadeOut(tween(140)) + slideOutHorizontally { -d * it / 8 })
                },
                label = "range",
            ) { (r, wk) ->
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (r == 7) {
                        val w = m.weeks[wk]
                        if (w == null) Loading() else WeekView(w, actions, onStep = { to, fwd -> forward = fwd; m.weekOf = to })
                    } else {
                        val d = m.dash[r]
                        if (d == null) Loading() else RangeView(r, d, m.shape[r], m.dayLoads[r], m.durability[r], actions)
                    }
                    // What all this training is doing to your muscles: the Body page.
                    Row(
                        Modifier.fillMaxWidth().press(scale = 0.98f, onClick = { actions.go("you") }).clip(CARD).background(cs.surfaceContainer).padding(20.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(cs.primaryContainer), contentAlignment = Alignment.Center) { Icon(Glyphs["heart"], null, tint = cs.onPrimaryContainer) }
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.common_your_body), style = MaterialTheme.typography.titleMedium)
                            Text(stringResource(R.string.progress_which_muscles_your_training_loads_and), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                        }
                        Icon(Glyphs["chevron"], null, tint = cs.onSurfaceVariant)
                    }
                }
            }
        }
        TopScrim(pageScroll.value > 0)
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Loading() = Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(64.dp)) }

@Composable
private fun Card(modifier: Modifier = Modifier, title: String? = null, sub: String? = null, how: String? = null, content: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    // How it's worked out: behind the ⓘ by the title, so the card leads with what it found.
    var showHow by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer).animateContentSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (title != null) Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                if (how != null) IconButton(onClick = { showHow = !showHow }, modifier = Modifier.size(36.dp)) {
                    Icon(Glyphs["info"], if (showHow) stringResource(R.string.progress_hide_how) else stringResource(R.string.progress_how_it_s_worked_out), Modifier.size(18.dp), tint = if (showHow) cs.primary else cs.onSurfaceVariant)
                }
            }
            sub?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
            if (how != null && showHow) Text(how, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
        }
        content()
    }
}

/** A number that counts up to its value when it first shows (from where it was, when it changes). */
@Composable
private fun CountUp(value: Double, format: (Double) -> String, size: Int = 34) {
    val a = remember { Animatable(0f) }
    LaunchedEffect(value) { a.animateTo(value.toFloat(), tween(700, easing = FastOutSlowInEasing)) }
    Text(format(a.value.toDouble()), fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = size.sp, lineHeight = size.sp)
}

@Composable
private fun Tile(label: String, value: Double, format: (Double) -> String, unit: String, sub: String, modifier: Modifier, lead: Boolean = false) {
    val cs = MaterialTheme.colorScheme
    // As tall as the tallest in its row (the row asks for its intrinsic height).
    Column(modifier.fillMaxHeight().clip(RoundedCornerShape(24.dp)).background(if (lead) cs.primaryContainer else cs.surfaceContainer).padding(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = if (lead) cs.onPrimaryContainer else cs.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.Bottom) {
            CountUp(value, format)
            if (unit.isNotEmpty()) Text(" $unit", style = MaterialTheme.typography.labelLarge, color = if (lead) cs.onPrimaryContainer.copy(alpha = 0.75f) else cs.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
        }
        Text(sub, style = MaterialTheme.typography.bodySmall, color = if (lead) cs.onPrimaryContainer.copy(alpha = 0.8f) else cs.onSurfaceVariant, maxLines = 3)
    }
}

private fun n1(x: Double) = String.format(Locale.getDefault(), "%.1f", x)
private fun n0(x: Double) = String.format(Locale.getDefault(), "%.0f", x)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RangeView(range: Int, d: Dash, shape: List<ShapeLine>?, days: List<DayLoad>?, dur: Durab?, actions: ProgressActions) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    var i = 0
    // Totals: the range, the month, the year (this week is on Today).
    Column(Modifier.reveal(i++), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        d.totals.chunked(3).forEach { row ->
            Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEachIndexed { k, t ->
                    Tile(t.label, t.km, { if (it < 100) n1(it) else n0(it) }, "km", stringResource(R.string.progress_workouts_h, t.workouts, n1(t.hours)), Modifier.weight(1f), lead = k == 0)
                }
            }
        }
    }
    if (d.changing.isNotEmpty()) Card(Modifier.reveal(i++), stringResource(R.string.progress_what_s_changing)) {
        d.changing.take(4).forEach { tk ->
            Row {
                Box(Modifier.padding(top = 2.dp).size(28.dp).clip(CircleShape).background(if (tk.tone == "good") data.goodContainer else if (tk.tone == "watch") data.watchContainer else cs.secondaryContainer), contentAlignment = Alignment.Center) {
                    Icon(Glyphs[if (tk.tone == "good") "check" else if (tk.tone == "watch") "spark" else "up"], null, Modifier.size(16.dp), tint = if (tk.tone == "good") data.good else if (tk.tone == "watch") data.watch else cs.onSecondaryContainer)
                }
                Spacer(Modifier.width(12.dp))
                Column { Text(tk.title, style = MaterialTheme.typography.titleSmall); Text(tk.detail, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
            }
        }
    }
    d.race?.let { r -> RaceCard(r, Modifier.reveal(i++)) }
    shape?.takeIf { it.isNotEmpty() }?.let { s -> RaceShape(s, d.race?.km, Modifier.reveal(i++)) }
    // Weekly distance.
    if (d.weeks.isNotEmpty()) {
        val avg = d.weeks.dropLast(1).let { w -> if (w.isEmpty()) 0.0 else w.sumOf { it.km } / w.size }
        Card(Modifier.reveal(i++), stringResource(R.string.progress_weekly_distance), stringResource(R.string.progress_average_km_a_week, n1(avg)) + (d.weekHit?.let { (h, of) -> stringResource(R.string.progress_target_met_in_of_the_last, h, of) } ?: stringResource(R.string.progress_this_week_highlighted))) {
            ColumnChart(
                d.weeks.map { dateShort(it.week) }, d.weeks.map { it.km }, data.pace,
                headline = stringResource(R.string.progress_this_week_km, n1(d.weeks.last().km)),
                said = { k -> str(R.string.progress_week_of_km_workouts, dateShort(d.weeks[k].week), n1(d.weeks[k].km), d.weeks[k].workouts) },
                highlight = d.weeks.lastIndex,
                reference = d.targetKm?.let { it to stringResource(R.string.common_target_km, n0(it)) },
                height = 200,
            )
        }
    }
    // Fitness.
    Card(Modifier.reveal(i++), stringResource(R.string.common_fitness), d.fitness.let { s ->
        if (s.size < 2) "" else {
            val ch = s.last().value - s.first().value
            if (kotlin.math.abs(ch) < 1) stringResource(R.string.progress_holding_at_since, n0(s.last().value), dateShort(s.first().date)) else stringResource(if (ch > 0) R.string.progress_up_from else R.string.progress_down_from, n0(s.first().value), n0(s.last().value), dateShort(s.first().date))
        }
    }) {
        if (d.fitness.size > 1) LineChart(d.fitness.map { it.value }, data.pace, stringResource(R.string.progress_fitness_now, n0(d.fitness.last().value)), { k -> str(R.string.progress_fitness_2, dateShort(d.fitness[k].date), n0(d.fitness[k].value)) }, zero = true, yLabel = { n0(it) })
        else Text(stringResource(R.string.progress_needs_a_few_weeks_of_workouts), color = cs.onSurfaceVariant)
        Text(stringResource(R.string.progress_your_average_daily_training_effort_over), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        if (d.estimatedShare > 0.3) Text(stringResource(R.string.progress_of_workouts_had_no_heart_rate, Math.round(d.estimatedShare * 100)), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
    }
    Consistency(range, d, days, actions, Modifier.reveal(i++))
    // Intensity mix.
    val zones = zoneColours()
    val total = d.zones.sumOf { it.seconds }
    Card(Modifier.reveal(i++), stringResource(R.string.progress_intensity_mix), if (total > 0) stringResource(R.string.progress_easy_zones_1_2_across_workouts, Math.round((d.zones.take(2).sumOf { it.seconds }) / total * 100), d.zoneWorkouts) else stringResource(R.string.progress_needs_workouts_with_heart_rate)) {
        if (total > 0) {
            StackBar(d.zones.mapIndexed { k, z -> z.seconds to zones[k.coerceIn(0, 4)] })
            FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                d.zones.forEachIndexed { k, z -> Key(zones[k.coerceIn(0, 4)], str(R.string.progress_zone_key, z.zone, z.name, if (z.seconds < 60) str(R.string.progress_under_1_min) else duration(z.seconds / 60))) }
            }
        } else Text(stringResource(R.string.progress_no_heart_rate_time_series_in), color = cs.onSurfaceVariant)
    }
    // Easy-run efficiency.
    Card(Modifier.reveal(i++), stringResource(R.string.progress_easy_run_efficiency), how = stringResource(R.string.progress_how_far_you_go_per_heartbeat)) {
        if (d.efficiency.size >= 2) LineChart(d.efficiency.map { it.value }, data.pace, stringResource(R.string.progress_m_a_beat_lately, String.format(Locale.getDefault(), "%.2f", d.efficiency.last().value)), { k -> str(R.string.progress_week_of_m_a_beat, dateShort(d.efficiency[k].date), String.format(Locale.getDefault(), "%.2f", d.efficiency[k].value)) }, yLabel = { String.format(Locale.getDefault(), "%.2f m", it) })
        else Text(stringResource(R.string.progress_needs_a_few_weeks_of_easy), color = cs.onSurfaceVariant)
    }
    dur?.takeIf { it.runs.isNotEmpty() }?.let { u ->
        Card(Modifier.reveal(i++), stringResource(R.string.progress_long_runs_does_the_effort_hold), how = stringResource(R.string.progress_heart_rate_against_hill_adjusted_pace)) {
            Text(u.summary, style = MaterialTheme.typography.bodyLarge)
            val steady = u.runs.filter { it.steady }.reversed()
            if (steady.size >= 2) LineChart(steady.map { it.drift }, data.pace, stringResource(R.string.progress_drift_per_long_run), { k -> "${dateShort(steady[k].date)} · ${n1(steady[k].drift)}% · ${steady[k].held}" }, area = false, yLabel = { "${n1(it)}%" })
            u.runs.take(5).forEach { run ->
                Row(Modifier.fillMaxWidth()) {
                    Text(dateShort(run.date), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(64.dp), color = cs.onSurfaceVariant)
                    Text(run.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Text("${n1(run.drift)}%", style = MaterialTheme.typography.titleSmall)
                }
            }
        }
    }
    // Personal bests.
    Card(Modifier.reveal(i), stringResource(R.string.progress_personal_bests), how = stringResource(R.string.progress_from_strava_best_efforts_on_synced)) {
        if (d.bests.isEmpty()) Text(stringResource(R.string.progress_synced_strava_runs_with_detail_add), color = cs.onSurfaceVariant)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            d.bests.forEachIndexed { k, b ->
                val first = k == 0
                val last = k == d.bests.lastIndex
                Row(
                    Modifier.fillMaxWidth().press(scale = 0.98f, label = b.name, onClick = { actions.openActivity(b.activity) })
                        .clip(RoundedCornerShape(if (first) 20.dp else 6.dp, if (first) 20.dp else 6.dp, if (last) 20.dp else 6.dp, if (last) 20.dp else 6.dp))
                        .background(cs.surfaceContainerHigh).padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) { Text(b.name, style = MaterialTheme.typography.titleSmall); Text(dateShort(b.date), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(clock(b.seconds), fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 22.sp)
                        b.pace?.let { Text(stringResource(R.string.common_per_km, it), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
                    }
                }
            }
        }
    }
}

@Composable
private fun Kpis(vararg kv: Pair<String, String>) {
    val cs = MaterialTheme.colorScheme
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        kv.forEach { (k, v) ->
            Column(Modifier.weight(1f).clip(RoundedCornerShape(20.dp)).background(cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 10.dp)) {
                Text(k, style = MaterialTheme.typography.labelMedium, color = cs.onSurfaceVariant, maxLines = 1)
                Text(v, fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 26.sp, lineHeight = 28.sp)
            }
        }
    }
}

@Composable
private fun RaceCard(r: Race, modifier: Modifier) {
    val gap = if (r.predicted != null && r.target != null) r.predicted - r.target else null
    Card(modifier, r.name, listOfNotNull(stringResource(R.string.common_n_km, km(r.km, 1)), r.date?.let { dateShort(it) + (r.daysToGo?.takeIf { it >= 0 }?.let { d -> stringResource(R.string.progress_days_to_go, d) } ?: "") }).joinToString(" · ")) {
        Kpis(stringResource(R.string.progress_predicted) to (r.predicted?.let(::clock) ?: "–"), stringResource(R.string.progress_target) to (r.target?.let(::clock) ?: "–"), stringResource(R.string.progress_target_pace) to (r.targetPace?.let { stringResource(R.string.common_per_km, it) } ?: "–"))
        Text(
            if (r.fromText != null) stringResource(R.string.progress_predicted_from_scaled_to_the_race, r.fromText) + (gap?.let { if (it <= 0) stringResource(R.string.progress_that_s_inside_your_target, clock(-it)) else stringResource(R.string.progress_to_find_before_race_day, clock(it)) } ?: "")
            else stringResource(R.string.progress_a_prediction_needs_a_best_effort),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** What your runs say you could race, week by week: a line that rises is getting faster. */
@Composable
private fun RaceShape(lines: List<ShapeLine>, raceKm: Double?, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val start = lines.indexOfFirst { raceKm != null && kotlin.math.abs(it.metres - raceKm * 1000) < 300 }.takeIf { it >= 0 } ?: lines.indexOfFirst { it.name == "10k" }.takeIf { it >= 0 } ?: 0
    var pick by rememberSaveable { mutableStateOf(start) }
    val l = lines[pick.coerceIn(0, lines.lastIndex)]
    val pts = l.weeks.filter { it.second != null }
    val first = pts.first().second!!.toInt()
    val last = pts.last().second!!.toInt()
    val diff = last - first
    Card(modifier, stringResource(R.string.progress_race_shape), stringResource(R.string.progress_what_your_runs_say_you_could)) {
        Segmented(lines.map { it.name }, pick, { pick = it })
        Row {
            Text("${l.name}: ${clock(first)} → ${clock(last)}", style = MaterialTheme.typography.titleSmall)
            Text(" " + (if (kotlin.math.abs(diff) < 5) stringResource(R.string.progress_about_the_same) else stringResource(if (diff < 0) R.string.progress_clock_faster else R.string.progress_clock_slower, clock(kotlin.math.abs(diff)))) + stringResource(R.string.progress_since, dateShort(pts.first().first)), style = MaterialTheme.typography.bodyMedium, color = if (diff < 0) data.good else cs.onSurfaceVariant)
        }
        LineChart(
            l.weeks.map { it.second }, data.pace, stringResource(R.string.progress_predicted_each_week, l.name),
            { k -> l.weeks[k].second?.let { str(R.string.progress_week_of, dateShort(l.weeks[k].first), clock(it.toInt())) } ?: "" },
            area = false, invert = true, minSpan = last * 0.06, yLabel = { clock(it.toInt()) },
        )
        Text(stringResource(R.string.progress_this_weeks_stretch, l.from ?: stringResource(R.string.progress_best)), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
    }
}

/** How regularly you train: workouts a week, active weeks, weeks in a row, and every day as a square. */
@Composable
private fun Consistency(range: Int, d: Dash, days: List<DayLoad>?, actions: ProgressActions, modifier: Modifier) {
    val total = (range + 6) / 7
    val byWeek = d.weeks.associate { it.week.take(10) to it.workouts }
    val today = LocalDate.now()
    val monday = today.minusDays((today.dayOfWeek.value - 1).toLong())
    val all = (total - 1 downTo 0).map { k -> byWeek[monday.minusWeeks(k.toLong()).toString()] ?: 0 }
    val done = all.dropLast(1)
    val active = done.count { it > 0 }
    val avg = if (done.isEmpty()) 0.0 else done.sum().toDouble() / done.size
    var streak = 0
    for (k in all.indices.reversed()) {
        if (all[k] > 0) streak++ else if (k == all.lastIndex) continue else break
    }
    Card(modifier, stringResource(R.string.progress_consistency), how = stringResource(R.string.progress_every_day_you_trained_shaded_by)) {
        Kpis(stringResource(R.string.progress_per_week) to n1(avg), stringResource(R.string.progress_active_weeks) to stringResource(R.string.common_of, active, done.size), stringResource(R.string.progress_in_a_row) to "$streak")
        if (days != null) DayGrid(total.coerceIn(12, 53), days, actions::openActivity)
    }
}

/** The Week: one week day by day; the arrows step back and forth, the content sliding from the side you go. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun WeekView(w: WeekV, actions: ProgressActions, onStep: (String, Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val weeksAgo = runCatching { java.time.temporal.ChronoUnit.WEEKS.between(LocalDate.parse(w.start), LocalDate.now()) }.getOrDefault(0)
    Row(Modifier.fillMaxWidth().clip(CircleShape).background(cs.surfaceContainer).padding(6.dp), verticalAlignment = Alignment.CenterVertically) {
        FilledTonalIconButton(onClick = { w.prev?.let { onStep(it, false) } }, enabled = w.prev != null, shapes = IconButtonDefaults.shapes()) {
            Icon(Glyphs["chevron"], stringResource(R.string.progress_previous_week), Modifier.graphicsLayer { rotationZ = 180f })
        }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(if (w.current) stringResource(R.string.common_this_week) else if (weeksAgo <= 1) stringResource(R.string.progress_last_week) else stringResource(R.string.progress_weeks_ago, weeksAgo), style = MaterialTheme.typography.titleMedium)
            Text("${dateShort(w.start)} – ${dateShort(w.end)}", style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
        FilledTonalIconButton(onClick = { w.next?.let { onStep(it, true) } }, enabled = w.next != null, shapes = IconButtonDefaults.shapes()) {
            Icon(Glyphs["chevron"], stringResource(R.string.common_next_week))
        }
    }
    fun delta(now: Double, before: Double, unit: String, digits: Int): String {
        if (before == 0.0) return if (w.current) str(R.string.progress_so_far) else ""
        // A week under way against a whole one says nothing: the week before, as it stands.
        if (w.current) return str(R.string.progress_so_far_week_before, if (digits > 0) n1(before) else n0(before), unit)
        val d = now - before
        if (kotlin.math.abs(d) < if (digits > 0) 0.05 else 0.5) return str(R.string.progress_same_as_the_week_before)
        return str(R.string.progress_on_the_week_before, "${if (d > 0) "+" else "−"}${if (digits > 0) n1(kotlin.math.abs(d)) else n0(kotlin.math.abs(d))}$unit")
    }
    Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Tile(str(R.string.common_distance), w.km, ::n1, "km", delta(w.km, w.before.first, " km", 1), Modifier.weight(1f), lead = true)
        Tile(str(R.string.common_time), w.minutes / 60, { duration(it * 60) }, "", delta(w.minutes / 60, w.before.second / 60, " h", 1), Modifier.weight(1f))
        // Effort as a share of your usual week (a bare score means nothing on its own); the score only
        // until there's a usual week to measure it by.
        if (w.usualLoad > 0) Tile(str(R.string.common_effort), w.load / w.usualLoad * 100, ::n0, "%", str(R.string.progress_of_your_usual_week), Modifier.weight(1f))
        else Tile(str(R.string.common_effort), w.load, ::n0, "", str(R.string.progress_workouts, w.workouts), Modifier.weight(1f))
    }
    w.plan?.let { p ->
        Row(Modifier.fillMaxWidth().press(scale = 0.98f, onClick = { actions.go("coach") }).clip(CARD).background(cs.surfaceContainer).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clip(RoundedCornerShape(14.dp)).background(cs.primaryContainer), contentAlignment = Alignment.Center) { Icon(Glyphs["coach"], null, tint = cs.onPrimaryContainer) }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) { p.lines().forEachIndexed { k, line -> Text(line, style = if (k == 0) MaterialTheme.typography.titleSmall else MaterialTheme.typography.bodySmall, color = if (k == 0) cs.onSurface else cs.onSurfaceVariant) } }
            Icon(Glyphs["chevron"], null, tint = cs.onSurfaceVariant)
        }
    }
    val byKm = w.km > 0
    val rest = w.days.count { it.workouts == 0 && !it.future }
    Card(title = str(R.string.progress_day_by_day), sub = listOfNotNull(plural(R.plurals.common_workouts, w.workouts, w.workouts), plural(R.plurals.progress_rest_days, rest, rest), w.climb.takeIf { it > 0 }?.let { str(R.string.common_m_climb, n0(it)) }).joinToString(" · ")) {
        val today = LocalDate.now().toString()
        ColumnChart(
            w.days.map { dayName(it.date) }, w.days.map { if (byKm) it.km else it.minutes }, data.pace,
            headline = if (byKm) str(R.string.progress_km_this_week, n1(w.km)) else duration(w.minutes),
            said = { k -> val d = w.days[k]; "${dayName(d.date)} ${dateShort(d.date)} · " + if (d.workouts > 0) "${plural(R.plurals.common_workouts, d.workouts, d.workouts)}, ${duration(d.minutes)}" else str(R.string.progress_rest) },
            highlight = if (w.current) w.days.indexOfFirst { it.date == today }.takeIf { it >= 0 } else null,
        )
    }
    Card(title = str(R.string.common_workouts_title)) {
        if (w.acts.isEmpty()) Text(if (w.current) str(R.string.progress_nothing_yet_this_week) else str(R.string.progress_no_workouts_this_week), color = cs.onSurfaceVariant)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            w.acts.forEachIndexed { k, a ->
                val first = k == 0
                val last = k == w.acts.lastIndex
                Row(
                    Modifier.fillMaxWidth().press(scale = 0.98f, label = a.name, onClick = { actions.openActivity(a.id) })
                        .clip(RoundedCornerShape(if (first) 20.dp else 6.dp, if (first) 20.dp else 6.dp, if (last) 20.dp else 6.dp, if (last) 20.dp else 6.dp))
                        .background(cs.surfaceContainerHigh).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(cs.primaryContainer), contentAlignment = Alignment.Center) { Icon(Glyphs.sport(a.sport), null, Modifier.size(22.dp), tint = cs.onPrimaryContainer) }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) { Text(a.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis); Text(a.whenText, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
                    Column(horizontalAlignment = Alignment.End) { Text(a.big, style = MaterialTheme.typography.titleSmall); if (a.small.isNotEmpty()) Text(a.small, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
                }
            }
        }
    }
    val zones = zoneColours()
    val total = w.zones.sumOf { it.seconds }
    Card(title = str(R.string.progress_intensity_and_sports), sub = if (total > 0) str(R.string.progress_easy_zones_1_2, Math.round(w.zones.take(2).sumOf { it.seconds } / total * 100)) else str(R.string.progress_no_heart_rate_this_week)) {
        if (total > 0) {
            StackBar(w.zones.mapIndexed { k, z -> z.seconds to zones[k.coerceIn(0, 4)] })
        }
        val names = mapOf("run" to str(R.string.progress_running), "ride" to str(R.string.progress_cycling), "swim" to str(R.string.progress_swimming), "walk" to str(R.string.progress_walking), "ski" to str(R.string.progress_skiing), "paddle" to str(R.string.progress_paddling), "other" to str(R.string.common_other))
        if (w.sports.isNotEmpty()) Kpis(*w.sports.take(3).map { (s, k, m) -> (names[s] ?: s) to (if (k > 0) str(R.string.common_n_km, n1(k)) else duration(m)) }.toTypedArray())
    }
}
