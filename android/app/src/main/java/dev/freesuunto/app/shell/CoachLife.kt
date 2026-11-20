package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters

/** The one-tap life changes (src/life.ts), by what each is called. */
enum class Life(@androidx.annotation.StringRes val chip: Int, val icon: String) { ILL(R.string.coach_i_m_ill, "heart"), BETTER(R.string.coach_better_now, "check"), AWAY(R.string.coach_i_m_away, "route"), BUSY(R.string.coach_busy_week, "clock") }

/** The days a "how long were you ill" choice stands for, and its words. */
private val ILL_FOR get() = listOf(3 to str(R.string.coach_a_few_days), 7 to str(R.string.coach_about_a_week), 14 to str(R.string.common_longer))

/**
 * Something came up: ill, better again, away, a busy week. One tonal button at the plan's head
 * ("Change plan", or "Feeling better?" while you're ill) opens a sheet with the four; each opens
 * its own short sheet with the choice it needs, and changes the plan by Tartan's rules (no chat,
 * no AI), taken at once with Undo on the Coach tab.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun LifeButton(today: String, ill: String?, actions: CoachActions, modifier: Modifier = Modifier, say: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var menu by remember { mutableStateOf(false) }
    var open by remember { mutableStateOf<Life?>(null) }
    FilledTonalButton(onClick = { menu = true }, shapes = ButtonDefaults.shapes(), modifier = modifier) {
        Icon(Glyphs[if (ill != null) "heart" else "clock"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp))
        Text(if (ill != null) stringResource(R.string.coach_feeling_better) else stringResource(R.string.coach_change_plan))
    }
    if (menu) Sheet(onClose = { menu = false }) { _ ->
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (ill != null) stringResource(R.string.coach_feeling_better) else stringResource(R.string.coach_something_came_up), style = MaterialTheme.typography.headlineSmall)
            if (ill != null) Text(stringResource(R.string.coach_ill_since, dateShort(ill)), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            Spacer(Modifier.height(4.dp))
            val order = if (ill != null) listOf(Life.BETTER, Life.AWAY, Life.BUSY) else listOf(Life.ILL, Life.BETTER, Life.AWAY, Life.BUSY)
            order.forEach { l ->
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(cs.surfaceContainerHigh)
                        .press(scale = 0.98f, label = stringResource(l.chip), onClick = { menu = false; open = l }).padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Glyphs[l.icon], null, Modifier.size(20.dp), tint = cs.primary); Spacer(Modifier.width(12.dp))
                    Text(if (l == Life.BETTER && ill == null) stringResource(R.string.coach_i_was_ill) else stringResource(l.chip), style = MaterialTheme.typography.titleMedium)
                }
            }
        }
    }
    open?.let { l -> LifeSheet(l, today, ill, actions, close = { open = null }, said = say) }
}

/** What a life change would send (POST /api/plan/life), from the sheet's choices. */
fun lifeBody(l: Life, today: String, illFor: Int, away: Int, easy: Boolean): JSONObject {
    val t = LocalDate.parse(today)
    return when (l) {
        Life.ILL -> JSONObject().put("type", "ill")
        Life.BETTER -> JSONObject().put("type", "better").put("days", illFor)
        Life.BUSY -> JSONObject().put("type", "busy")
        Life.AWAY -> {
            val sunday = t.with(TemporalAdjusters.nextOrSame(DayOfWeek.SUNDAY))
            val (from, to) = when (away) {
                0 -> t to sunday
                1 -> sunday.plusDays(1) to sunday.plusDays(7)
                else -> t to t.plusDays(13)
            }
            JSONObject().put("type", "away").put("from", from.toString()).put("to", to.toString()).put("train", if (easy) "easy" else "none")
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun LifeSheet(l: Life, today: String, ill: String?, actions: CoachActions, close: () -> Unit, said: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    // Ill since a date: that many days, to the nearest choice.
    val since = ill?.let { ChronoUnit.DAYS.between(LocalDate.parse(it), LocalDate.parse(today)).toInt() }
    var illFor by remember { mutableIntStateOf(since?.let { d -> ILL_FOR.indexOfFirst { d <= it.first }.takeIf { it >= 0 } ?: 2 } ?: 0) }
    var away by remember { mutableIntStateOf(0) }
    var easy by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Sheet(onClose = close) { hide ->
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(when (l) { Life.ILL -> stringResource(R.string.coach_ill); Life.BETTER -> stringResource(R.string.coach_back_after_being_ill); Life.AWAY -> stringResource(R.string.coach_away); Life.BUSY -> stringResource(R.string.coach_a_busy_week) }, style = MaterialTheme.typography.headlineSmall)
            val words = when (l) {
                Life.ILL -> stringResource(R.string.coach_rest_for_today_and_the_next)
                Life.BETTER -> when (illFor) {
                    0 -> stringResource(R.string.coach_three_days_of_easy_running_a)
                    1 -> stringResource(R.string.coach_a_week_of_easy_running_half)
                    else -> stringResource(R.string.coach_two_weeks_of_easy_running_the)
                }
                Life.AWAY -> if (easy) stringResource(R.string.coach_easy_runs_only_while_you_re) else stringResource(R.string.coach_no_training_while_you_re_away)
                Life.BUSY -> stringResource(R.string.coach_the_rest_of_this_week_shorter)
            }
            if (l == Life.BETTER) {
                Text(stringResource(R.string.coach_how_long_were_you_ill), style = MaterialTheme.typography.labelLarge)
                Segmented(ILL_FOR.map { it.second }, illFor, { illFor = it })
            }
            if (l == Life.AWAY) {
                Text(stringResource(R.string.coach_when), style = MaterialTheme.typography.labelLarge)
                Segmented(listOf(stringResource(R.string.common_this_week), stringResource(R.string.common_next_week), stringResource(R.string.coach_two_weeks)), away, { away = it })
                Text(stringResource(R.string.coach_training_while_away), style = MaterialTheme.typography.labelLarge)
                Segmented(listOf(stringResource(R.string.common_none), stringResource(R.string.coach_easy_runs)), if (easy) 1 else 0, { easy = it == 1 })
            }
            Text(words, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = cs.error) }
            Spacer(Modifier.height(4.dp))
            Button(onClick = {
                busy = true
                error = null
                scope.launch {
                    val (st, text) = actions.send("/api/plan/life", "POST", lifeBody(l, today, ILL_FOR[illFor].first, away, easy).toString())
                    busy = false
                    val o = runCatching { JSONObject(text) }.getOrNull()
                    if (st in 200..299 && o?.has("error") != true) { hide(); said(o?.optString("said")?.ifEmpty { null } ?: str(R.string.coach_plan_changed)) }
                    else error = o?.optString("error")?.ifEmpty { null } ?: str(R.string.common_it_didn_t_go_through_try)
                }
            }, enabled = !busy, shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth()) {
                if (busy) LoadingIndicator(Modifier.size(20.dp))
                else Text(when (l) { Life.ILL -> stringResource(R.string.coach_rest_until_i_m_better); Life.BETTER -> stringResource(R.string.coach_ease_me_back_in); Life.AWAY -> stringResource(R.string.coach_change_my_plan); Life.BUSY -> stringResource(R.string.coach_make_this_week_shorter) })
            }
        }
    }
}
