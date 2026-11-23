package dev.freesuunto.app.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
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
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.freesuunto.app.R
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Milestones (src/milestones.ts): earned moments, never gamified pressure. One quiet card on Today
 * for a new one, a line on the workout that earned it, a picture to share. And Your season
 * (src/season.ts), from Progress: this year or this plan, briefly, with a tall picture to share.
 */
data class Moment(
    val id: String, val kind: String, val date: String, val activity: String?, val title: String, val note: String,
    val figure: String? = null, val figureLabel: String? = null,
)

private fun JSONObject.s(k: String) = if (has(k) && !isNull(k)) optString(k).ifEmpty { null } else null
private inline fun <T> JSONArray?.list(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it)?.let(f) }

fun parseMoments(a: JSONArray?): List<Moment> = a.list { Moment(it.optString("id"), it.optString("kind"), it.optString("date"), it.s("activity"), it.optString("title"), it.optString("note"), it.s("figure"), it.s("figure_label")) }

/** The glyph for a kind of milestone. */
fun momentGlyph(kind: String) = when (kind) {
    "best" -> "spark"; "race" -> "flag"; "longest", "first" -> "route"; "week", "month" -> "trends"; "steady" -> "check"; "swim" -> "swim"; "ride" -> "ride"; else -> "spark"
}

/** A milestone to the share sheet as a picture. */
fun shareMoment(context: android.content.Context, m: Moment, colour: Int) {
    runCatching { ShareCard.share(context, ShareCard.milestone(context, m, colour), "tartan-${m.kind}-${m.date}", m.title) }
}

/**
 * A new milestone on Today, quietly: the title, the coach's line, Share and put away. The spark pops
 * in once (still under reduced motion); a tap opens the workout that earned it.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun MilestoneCard(m: Moment, modifier: Modifier, open: (String) -> Unit, dismiss: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val context = LocalContext.current
    val colour = shareColour()
    val still = LocalReducedMotion.current
    val pop = remember { androidx.compose.animation.core.Animatable(if (still) 1f else 0.6f) }
    val spring = MaterialTheme.motionScheme.slowSpatialSpec<Float>()
    LaunchedEffect(Unit) { if (!still) pop.animateTo(1f, spring) }
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(data.goodContainer)
            .let { x -> m.activity?.let { id -> x.press(scale = 0.98f, label = m.title) { open(id) } } ?: x }
            .padding(start = 20.dp, top = 18.dp, bottom = 12.dp, end = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Box(Modifier.size(44.dp).graphicsLayer { scaleX = pop.value; scaleY = pop.value }.clip(CircleShape).background(data.good), contentAlignment = Alignment.Center) {
                Icon(Glyphs[momentGlyph(m.kind)], null, Modifier.size(24.dp), tint = data.goodContainer)
            }
            Column(Modifier.weight(1f).padding(start = 14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(m.title, style = MaterialTheme.typography.titleLarge, color = data.good)
                Text(m.note, style = MaterialTheme.typography.bodyMedium, color = cs.onSurface)
            }
            IconButton(onClick = dismiss) { Icon(Glyphs["close"], stringResource(R.string.common_dismiss), Modifier.size(18.dp), tint = cs.onSurfaceVariant) }
        }
        Row(Modifier.padding(start = 50.dp)) {
            TextButton(onClick = { shareMoment(context, m, colour) }) {
                Icon(Glyphs["share"], null, Modifier.size(18.dp), tint = data.good)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.share_share), color = data.good)
            }
        }
    }
}

/** On the workout that earned them: each milestone in a line, with a picture to share. */
@Composable
fun MilestoneLines(list: List<Moment>, modifier: Modifier) {
    if (list.isEmpty()) return
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val context = LocalContext.current
    val colour = shareColour()
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(data.goodContainer).padding(vertical = 6.dp)) {
        list.forEach { m ->
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Glyphs[momentGlyph(m.kind)], null, Modifier.size(20.dp), tint = data.good)
                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                    Text(m.title, style = MaterialTheme.typography.titleSmall, color = data.good)
                    Text(m.note, style = MaterialTheme.typography.bodySmall, color = cs.onSurface)
                }
                IconButton(onClick = { shareMoment(context, m, colour) }) { Icon(Glyphs["share"], stringResource(R.string.season_share_milestone), Modifier.size(18.dp), tint = data.good) }
            }
        }
    }
}

// ---------------------------------------------------------------- Your season

data class SeasonBest(val name: String, val label: String, val timeS: Int, val date: String, val activity: String, val pb: Boolean)
data class SeasonRace(val id: String, val date: String, val name: String, val km: Double, val timeS: Int)
data class SeasonWeek(val week: String, val km: Double, val met: Boolean?)
data class SeasonLong(val id: String, val date: String, val km: Double, val name: String?)

/** GET /api/season (src/season.ts). */
data class Season(
    val range: String, val label: String, val from: String, val to: String, val empty: Boolean,
    val km: Double, val minutes: Double, val runs: Int, val climbM: Int,
    val biggestWeek: Pair<String, Double>?, val longest: SeasonLong?, val bests: List<SeasonBest>, val races: List<SeasonRace>,
    val weeks: List<SeasonWeek>, val weeksMet: Int, val weeksWithTarget: Int, val crossLine: String?, val milestones: Int, val closing: String, val hasPlan: Boolean,
)

fun parseSeason(json: String): Season {
    val o = JSONObject(json)
    val r = o.optJSONObject("run") ?: JSONObject()
    return Season(
        o.optString("range"), o.optString("label"), o.optString("from"), o.optString("to"), o.optBoolean("empty"),
        r.optDouble("km", 0.0), r.optDouble("minutes", 0.0), r.optInt("runs"), r.optInt("climb_m"),
        o.optJSONObject("biggest_week")?.let { it.optString("week") to it.optDouble("km", 0.0) },
        o.optJSONObject("longest")?.let { SeasonLong(it.optString("id"), it.optString("date"), it.optDouble("km", 0.0), it.s("name")) },
        o.optJSONArray("bests").list { SeasonBest(it.optString("name"), it.optString("label"), it.optInt("time_s"), it.optString("date"), it.optString("activity"), it.optBoolean("pb")) },
        o.optJSONArray("races").list { SeasonRace(it.optString("id"), it.optString("date"), it.optString("name"), it.optDouble("km", 0.0), it.optInt("time_s")) },
        o.optJSONArray("weeks").list { SeasonWeek(it.optString("week"), it.optDouble("km", 0.0), if (it.has("met") && !it.isNull("met")) it.optBoolean("met") else null) },
        o.optInt("weeks_met"), o.optInt("weeks_with_target"), o.optJSONObject("cross")?.s("line"), o.optInt("milestones"), o.optString("closing"), o.optBoolean("has_plan"),
    )
}

private val DAY_MONTH = DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())
private fun dayMonth(iso: String) = runCatching { LocalDate.parse(iso.take(10)).format(DAY_MONTH) }.getOrDefault(iso)
private fun n1(x: Double) = String.format(Locale.getDefault(), "%.1f", x)
private fun hours(min: Double) = if (min >= 600) String.format(Locale.getDefault(), "%.0f", min / 60) else String.format(Locale.getDefault(), "%.1f", min / 60)

/** From Progress: Your season, a row that opens it. */
@Composable
fun SeasonRow(onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().press(scale = 0.98f, onClick = onClick).clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainer).padding(20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(cs.primaryContainer), contentAlignment = Alignment.Center) { Icon(Glyphs["spark"], null, tint = cs.onPrimaryContainer) }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.season_your_season), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.season_row_sub), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        }
        Icon(Glyphs["chevron"], null, tint = cs.onSurfaceVariant)
    }
}

/** Your season, in a sheet over Progress: This year or This plan. */
@Composable
fun SeasonSheet(m: ProgressModel, actions: ProgressActions, onClose: () -> Unit) {
    Sheet(onClose, full = true) { close ->
        SeasonBody(m, { id -> close(); actions.openActivity(id) }, close, Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding())
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalLayoutApi::class)
@Composable
fun SeasonBody(m: ProgressModel, open: (String) -> Unit, close: () -> Unit, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    var range by remember { mutableStateOf("year") }
    LaunchedEffect(range) { m.loadSeason(range) }
    val s = m.season[range]
    val context = LocalContext.current
    val colour = shareColour()
    Column(modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.season_your_season), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                s?.let { Text(if (it.range == "plan") it.label else stringResource(R.string.season_since, dayMonth(it.from)), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
            }
            if (s != null && !s.empty) FilledTonalIconButton(onClick = { runCatching { ShareCard.share(context, ShareCard.season(context, s, colour), "tartan-season-${s.label}") } }) { Icon(Glyphs["share"], stringResource(R.string.season_share)) }
            FilledTonalIconButton(onClick = close) { Icon(Glyphs["close"], stringResource(R.string.common_close)) }
        }
        if (s?.hasPlan == true || range == "plan") {
            val opts = listOf("year", "plan")
            Segmented(listOf(stringResource(R.string.season_this_year), stringResource(R.string.season_this_plan)), opts.indexOf(range), { range = opts[it] })
        }
        when {
            s == null -> Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) { LoadingIndicator(Modifier.size(64.dp)) }
            s.empty -> EmptySeason(s)
            else -> SeasonCards(s, open)
        }
    }
}

@Composable
private fun EmptySeason(s: Season) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainer).padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Glyphs["run"], null, Modifier.size(32.dp), tint = cs.primary)
        Text(stringResource(R.string.season_empty_title), style = MaterialTheme.typography.titleLarge)
        Text(s.closing, style = MaterialTheme.typography.bodyLarge, color = cs.onSurfaceVariant)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SeasonCards(s: Season, open: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    var i = 0
    // The running, big.
    Column(Modifier.reveal(i++).fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.primaryContainer).padding(20.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(String.format(Locale.getDefault(), "%.0f", s.km), fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 72.sp, lineHeight = 72.sp, color = cs.onPrimaryContainer)
            Text(" " + stringResource(R.string.season_km_of_running), style = MaterialTheme.typography.titleMedium, color = cs.onPrimaryContainer.copy(alpha = 0.8f), modifier = Modifier.padding(bottom = 10.dp))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp), modifier = Modifier.padding(top = 6.dp)) {
            Small(pluralStringRes(R.plurals.season_runs_label, s.runs), "${s.runs}", cs.onPrimaryContainer)
            Small(stringResource(R.string.season_hours), hours(s.minutes), cs.onPrimaryContainer)
            if (s.climbM > 0) Small(stringResource(R.string.season_metres_up), String.format(Locale.getDefault(), "%,d", s.climbM), cs.onPrimaryContainer)
        }
    }
    // The biggest week and the longest run, side by side.
    Row(Modifier.reveal(i++).fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        s.biggestWeek?.let { (wk, km) -> Tile(stringResource(R.string.season_biggest_week), n1(km), stringResource(R.string.season_week_of, dayMonth(wk)), Modifier.weight(1f), null) }
        s.longest?.let { l -> Tile(stringResource(R.string.season_longest_run), n1(l.km), dayMonth(l.date), Modifier.weight(1f)) { open(l.id) } }
    }
    if (s.bests.isNotEmpty() || s.races.isNotEmpty()) Column(Modifier.reveal(i++).fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainer).padding(vertical = 8.dp)) {
        s.races.forEach { r -> Line("flag", r.name, clock(r.timeS), stringResource(R.string.season_race_line, n1(r.km), dayMonth(r.date)), true) { open(r.id) } }
        val pbs = s.bests.any { it.pb }
        s.bests.filter { it.pb || !pbs }.forEach { b -> Line("spark", b.label, clock(b.timeS), if (b.pb) stringResource(R.string.season_new_best_on, dayMonth(b.date)) else stringResource(R.string.season_season_best_on, dayMonth(b.date)), b.pb) { open(b.activity) } }
    }
    // The weeks in a row: filled where the target was met. Never a streak; a miss is just a week.
    Column(Modifier.reveal(i++).fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(if (s.weeksWithTarget > 0) stringResource(R.string.season_weeks_on_target, s.weeksMet, s.weeksWithTarget) else stringResource(R.string.season_week_by_week), style = MaterialTheme.typography.titleMedium)
        val most = maxOf(1.0, s.weeks.maxOfOrNull { it.km } ?: 1.0)
        val said = stringResource(R.string.season_weeks_described, s.weeks.size, s.weeksMet)
        Row(Modifier.fillMaxWidth().height(64.dp).semantics { contentDescription = said }, horizontalArrangement = Arrangement.spacedBy(if (s.weeks.size > 30) 2.dp else 4.dp), verticalAlignment = Alignment.Bottom) {
            s.weeks.forEach { w ->
                val f = if (w.km > 0) (w.km / most).toFloat().coerceIn(0.12f, 1f) else 0.06f
                Box(Modifier.weight(1f).fillMaxHeight(f).clip(RoundedCornerShape(3.dp)).background(if (w.met == true) data.good else if (w.km > 0) cs.primary.copy(alpha = 0.45f) else cs.surfaceContainerHighest))
            }
        }
        s.crossLine?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
    }
    // The coach's line.
    Row(Modifier.reveal(i++).fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainerHigh).padding(20.dp)) {
        Box(Modifier.width(3.dp).height(48.dp).clip(CircleShape).background(cs.primary))
        Column(Modifier.padding(start = 14.dp)) {
            Text(stringResource(R.string.common_coach), style = MaterialTheme.typography.labelLarge, color = cs.primary)
            Text(s.closing, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

@Composable
private fun pluralStringRes(id: Int, n: Int) = androidx.compose.ui.res.pluralStringResource(id, n)

@Composable
private fun Small(label: String, value: String, ink: androidx.compose.ui.graphics.Color) {
    Column {
        Text(value, style = Figure.M, color = ink)
        Text(label, style = MaterialTheme.typography.labelMedium, color = ink.copy(alpha = 0.8f))
    }
}

@Composable
private fun Tile(label: String, value: String, sub: String, modifier: Modifier, onClick: (() -> Unit)?) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.fillMaxHeight().clip(RoundedCornerShape(24.dp)).let { if (onClick != null) it.press(scale = 0.98f, onClick = onClick) else it }.background(cs.surfaceContainer).padding(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
        Row(verticalAlignment = Alignment.Bottom) {
            Text(value, style = Figure.M)
            Text(" km", style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
        }
        Text(sub, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
    }
}

@Composable
private fun Line(glyph: String, head: String, value: String, sub: String, good: Boolean, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    Row(Modifier.fillMaxWidth().press(scale = 0.98f, onClick = onClick).padding(horizontal = 20.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Glyphs[glyph], null, Modifier.size(20.dp), tint = if (good) data.good else cs.onSurfaceVariant)
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text(head, style = MaterialTheme.typography.titleSmall)
            Text(sub, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
        Text(value, style = Figure.S)
    }
}
