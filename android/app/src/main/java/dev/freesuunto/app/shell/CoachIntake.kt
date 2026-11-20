package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.animateContentSize
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.runtime.remember
import androidx.compose.animation.core.tween
import androidx.compose.animation.togetherWith
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.fadeOut
import androidx.compose.animation.fadeIn
import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The first plan (web/views/plan.ts make, makeBasic): the answers saved, then the coach plans out
 * loud (its steps, then a few sentences) and the plan appears; without an AI key, a plan by
 * Tartan's own rules (src/basic-plan.ts).
 */
class PlanMaker(private val scope: CoroutineScope, private val actions: CoachActions) {
    var running by mutableStateOf(false)
    val steps = mutableStateListOf<Pair<String, Boolean>>()
    var text by mutableStateOf("")
    var conversation by mutableStateOf<String?>(null)
    /** How it ended: "saved", "proposed", "none"; null while it hasn't. */
    var outcome by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
    val shown get() = running || outcome != null
    /** Back to the questions (after it couldn't plan). */
    fun reset() { if (!running) { outcome = null; error = null; text = ""; steps.clear() } }

    fun make(target: String?, availability: JSONObject, ai: Boolean) {
        if (running) return
        running = true; steps.clear(); text = ""; outcome = null; error = null; conversation = null
        scope.launch {
            try {
                val (st, body) = actions.send("/api/plan/availability", "PUT", availability.toString())
                if (st !in 200..299) { error = str(R.string.coach_couldn_t_save_your_answers, st); outcome = "none"; return@launch }
                val args = JSONObject().apply { target?.let { put("target", it) } }.toString()
                if (!ai) {
                    val (s2, b2) = actions.send("/api/plan/basic", "POST", args)
                    if (s2 !in 200..299) { error = runCatching { JSONObject(b2).optString("error") }.getOrNull()?.ifEmpty { null } ?: str(R.string.coach_couldn_t_make_the_plan, s2); outcome = "none"; return@launch }
                    outcome = "saved"
                    actions.planMade(str(R.string.coach_your_plan_is_ready))
                    return@launch
                }
                var saved = false
                var proposed = 0
                val status = actions.stream("/api/plan/update", args) { line ->
                    val m = runCatching { JSONObject(line) }.getOrNull() ?: return@stream
                    when (m.optString("type")) {
                        "conversation" -> conversation = m.optString("id")
                        "tool" -> { for (i in steps.indices) steps[i] = steps[i].first to true; steps.add(m.optString("label") to false) }
                        "plan" -> if (m.optInt("proposed") > 0) proposed = m.optInt("proposed") else saved = true
                        "text" -> text += m.optString("delta")
                        "error" -> error = m.optString("message")
                    }
                }
                for (i in steps.indices) steps[i] = steps[i].first to true
                if (status !in 200..299 && error == null) error = str(R.string.coach_the_coach_couldn_t_plan_just, status)
                outcome = if (saved) "saved" else if (proposed > 0) "proposed" else "none"
                if (saved) actions.planMade(str(R.string.coach_your_plan_is_ready))
                else if (proposed > 0) actions.planMade(plural(R.plurals.coach_suggests_accept, proposed, proposed))
            } finally { running = false }
        }
    }
}

private val DAYS3 get() = listOf(str(R.string.coach_mon), str(R.string.coach_tue), str(R.string.coach_wed), str(R.string.coach_thu), str(R.string.coach_fri), str(R.string.coach_sat), str(R.string.coach_sun))

/**
 * Coach with no plan yet, in one order: what Tartan already knows, then one question at a time,
 * then Make my plan; while the coach plans, that takes the questions' place. Without an AI key
 * the plan comes from Tartan's own rules, and the AI's setup waits folded at the bottom.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun NoPlan(coach: Coach, maker: PlanMaker?, setup: CoachSetupModel?, actions: CoachActions) {
    val a = coach.intake ?: return
    val cs = MaterialTheme.colorScheme
    // 1. Where you are.
    Column(Modifier.fillMaxWidth().reveal(0).clip(RoundedCornerShape(28.dp)).background(cs.primaryContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(stringResource(R.string.coach_let_s_make_your_plan), style = MaterialTheme.typography.headlineSmall, color = cs.onPrimaryContainer)
        Text(knows(a), style = MaterialTheme.typography.bodyLarge, color = cs.onPrimaryContainer)
    }
    // 2. The questions, or 3. the plan being made.
    if (maker?.shown == true) {
        Live(maker, actions, Modifier.reveal(1))
        if (!maker.running && maker.outcome == "none") FilledTonalButton(onClick = { maker.reset() }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.coach_back_to_the_questions)) }
    } else Questions(a, coach.ready, maker, Modifier.reveal(1))
    // Without a key: the AI coach, optional, folded.
    if (!coach.ready && setup != null && maker?.running != true) AiOffer(setup, Modifier.reveal(2))
}

private fun knows(a: Intake): String = listOfNotNull(
    if (a.runs > 0) plural(R.plurals.coach_knows_runs, a.runs, a.runs, km(a.kmWeek, 1), km(a.longest, 1))
    else if (a.workouts > 0) str(R.string.coach_you_ve_trained_about_hours_a, km(a.hoursWeek, 1))
    else str(R.string.coach_no_workouts_from_the_last_four),
    a.raceDate?.let { d -> str(R.string.coach_your_race_is_on, a.raceName ?: str(R.string.common_km_race, km(a.raceKm ?: 0.0, 1)), dateShort(d)) },
).joinToString(" ")

/** The coach planning: its steps as they go, what it says, the way into the conversation. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalLayoutApi::class)
@Composable
private fun Live(m: PlanMaker, actions: CoachActions, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.primaryContainer).padding(20.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (m.running) LoadingIndicator(Modifier.size(28.dp), color = cs.onPrimaryContainer)
            else Icon(Glyphs["coach"], null, Modifier.size(22.dp), tint = cs.onPrimaryContainer)
            Spacer(Modifier.width(10.dp))
            Text(if (m.running) stringResource(R.string.coach_your_coach_is_planning) else if (m.outcome == "none") stringResource(R.string.coach_no_plan_yet) else stringResource(R.string.coach_your_coach), style = MaterialTheme.typography.titleMedium, color = cs.onPrimaryContainer)
        }
        if (m.steps.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            m.steps.forEach { (label, done) ->
                Row(Modifier.clip(CircleShape).background(cs.surface.copy(alpha = 0.6f)).padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (done) Icon(Glyphs["check"], null, Modifier.size(14.dp), tint = cs.primary) else LoadingIndicator(Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp)); Text(label, style = MaterialTheme.typography.labelMedium)
                }
            }
        }
        if (m.text.isNotEmpty()) Markdown(m.text, cs.onPrimaryContainer)
        else if (m.outcome == "none") Text(m.error ?: stringResource(R.string.coach_no_answer_from_the_coach_try), color = cs.onPrimaryContainer)
        m.conversation?.takeIf { !m.running }?.let { c -> TextButton(onClick = { actions.chat(c, null) }) { Icon(Glyphs["coach"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.coach_talk_it_through_with_your_coach)) } }
    }
}

/** One question at a time: days, hours, the long run's day, then a date and Make my plan. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalLayoutApi::class)
@Composable
private fun Questions(a: Intake, ai: Boolean, maker: PlanMaker?, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var step by rememberSaveable { mutableStateOf(0) }
    var forward by remember { mutableStateOf(true) }
    var days by rememberSaveable { mutableStateOf(a.days?.toString() ?: "") }
    var hours by rememberSaveable { mutableStateOf(a.hours?.toString() ?: "") }
    var long by rememberSaveable { mutableStateOf(a.longDay ?: "") }
    var target by rememberSaveable { mutableStateOf(a.raceDate?.let { dateShort(it) } ?: "") }
    var notes by rememberSaveable { mutableStateOf(a.notes) }
    val last = 3
    fun go(to: Int) { forward = to > step; step = to.coerceIn(0, last) }
    // A tap answers and moves on, after a beat to see it chosen.
    fun answer(set: () -> Unit) { view.feel(Haptic.Click); set(); scope.launch { kotlinx.coroutines.delay(220); go(step + 1) } }
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainer).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(str(R.string.common_of, step + 1, last + 1), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant, modifier = Modifier.width(56.dp))
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (i in 0..last) Box(Modifier.weight(1f).height(4.dp).clip(CircleShape).background(if (i <= step) cs.primary else cs.surfaceContainerHighest))
            }
        }
        AnimatedContent(step, transitionSpec = {
            val d = if (forward) 1 else -1
            (fadeIn(tween(200, 60)) + slideInHorizontally { d * it / 5 }) togetherWith (fadeOut(tween(120)) + slideOutHorizontally { -d * it / 5 })
        }, label = "question") { s ->
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                when (s) {
                    0 -> Ask(str(R.string.coach_how_many_days_a_week_can), listOf("" to str(R.string.coach_not_sure)) + (2..7).map { "$it" to "$it" }, days) { v -> answer { days = v } }
                    1 -> Ask(str(R.string.coach_about_how_many_hours_a_week), listOf("" to str(R.string.coach_not_sure)) + listOf(2, 3, 4, 5, 6, 8, 10).map { "$it" to "$it h" }, hours) { v -> answer { hours = v } }
                    2 -> Ask(str(R.string.coach_which_day_suits_the_long_run), listOf("" to str(R.string.coach_any_day)) + DAYS3.map { it to it }, long) { v -> answer { long = v } }
                    else -> {
                        Text(str(R.string.coach_building_to_a_date), style = MaterialTheme.typography.titleLarge)
                        Field(if (a.raceDate != null) str(R.string.coach_your_race_day_clear_it_for) else str(R.string.coach_optional_leave_it_empty_for_8), target, { target = it.take(80) }, placeholder = "e.g. 14 March, end of June")
                        if (ai) Field(str(R.string.coach_anything_else_your_coach_should_know), notes, { notes = it.take(300) }, placeholder = str(R.string.coach_injuries_no_running_on_thursdays))
                        Text(
                            if (ai) str(R.string.coach_your_coach_plans_around_these_and) else str(R.string.coach_tartan_plans_by_its_own_rules),
                            style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant,
                        )
                        Button(
                            onClick = {
                                view.feel(Haptic.Confirm)
                                val avail = JSONObject().apply {
                                    days.toIntOrNull()?.let { put("days_per_week", it) }
                                    hours.toIntOrNull()?.let { put("hours_per_week", it) }
                                    if (long.isNotEmpty()) put("long_run_day", long)
                                    if (ai && notes.isNotBlank()) put("notes", notes.trim())
                                }
                                // The race's own date when it's the one shown, as the page sends it.
                                val t = target.trim().ifEmpty { null }?.let { if (a.raceDate != null && it == dateShort(a.raceDate)) a.raceDate else it }
                                maker?.make(t, avail, ai)
                            },
                            enabled = maker != null, modifier = Modifier.fillMaxWidth().height(56.dp), shapes = ButtonDefaults.shapes(),
                        ) { Icon(Glyphs["spark"], null, Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)); Text(str(R.string.coach_make_my_plan), style = MaterialTheme.typography.titleMedium) }
                    }
                }
            }
        }
        if (step > 0) TextButton(onClick = { go(step - 1) }) { Icon(Glyphs["chevron"], null, Modifier.size(16.dp).graphicsLayer { scaleX = -1f }); Spacer(Modifier.width(4.dp)); Text(str(R.string.common_back)) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Ask(title: String, options: List<Pair<String, String>>, now: String, pick: (String) -> Unit) {
    Text(title, style = MaterialTheme.typography.titleLarge)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        options.forEach { (v, label) ->
            FilterChip(now == v, { pick(v) }, label = { Text(label, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(vertical = 8.dp)) },
                leadingIcon = if (now == v) { { Icon(Glyphs["check"], null, Modifier.size(18.dp)) } } else null)
        }
    }
}

/** Without a key: a coach that talks and changes the plan when you ask, set up only if you want it. */
@Composable
private fun AiOffer(setup: CoachSetupModel, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    var open by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(cs.surfaceContainerLow).press(scale = 0.98f, label = stringResource(R.string.coach_an_ai_coach)) { open = !open }.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Glyphs["coach"], null, Modifier.size(22.dp), tint = cs.primary)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(stringResource(R.string.coach_want_a_coach_to_talk_to), style = MaterialTheme.typography.titleSmall)
                Text(stringResource(R.string.coach_add_your_own_ai_key_it), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            Icon(Glyphs["chevron"], null, Modifier.graphicsLayer { rotationZ = if (open) 90f else 0f }, tint = cs.onSurfaceVariant)
        }
        if (open) CoachSetupCard(setup, Modifier)
    }
}
