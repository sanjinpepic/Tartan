package dev.freesuunto.app.shell

import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.os.Build
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Locale

/** The groups, as the web's Settings has them. */
private val GROUPS get() = listOf(
    // A line under the tabs only where it says something the cards don't: where More tools are.
    Triple("sources", str(R.string.common_sources), ""),
    Triple("training", str(R.string.settings_training), ""),
    Triple("coach", str(R.string.common_coach), ""),
    Triple("watch", str(R.string.common_watch), ""),
    Triple("more", str(R.string.common_more), str(R.string.settings_ai_agents_the_face_builder_and)),
)
val NATIVE_SETTINGS = setOf("sources", "training", "coach", "watch", "more")

/** What Settings asks of the app: another screen (a group still the web's is `settings/<group>`). */
interface SettingsActions {
    fun go(hash: String)
    /** The Tartan 2 parts on and off, as `configure` takes them. */
    fun parts(): Map<String, Boolean>
    fun setPart(name: String, on: Boolean)
}

private val CARD = RoundedCornerShape(28.dp)

/**
 * Settings, native: the five groups as a slide-able row (Sources and Watch open the web's, for
 * Bluetooth, sign-ins and files), and Training, Coach and More drawn here. Each native group ends
 * with the way to what's still the web's in it (shoes; the coach's AI; your PC, backups, the log).
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun SettingsScreen(m: SettingsModel, group: String, actions: SettingsActions, navSpace: Boolean = true, sources: SourcesModel? = null, extras: SettingsExtras = SettingsExtras()) {
    val cs = MaterialTheme.colorScheme
    val pageScroll = rememberScrollState()
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { m.ensure() }
    LaunchedEffect(m.said) { m.said?.let { snack.showSnackbar(it); m.said = null } }
    LaunchedEffect(sources?.said) { sources?.said?.let { snack.showSnackbar(it); sources.said = null } }
    LaunchedEffect(extras.shoes?.said) { extras.shoes?.said?.let { snack.showSnackbar(it); extras.shoes.said = null } }
    LaunchedEffect(extras.coachSetup?.said) { extras.coachSetup?.said?.let { snack.showSnackbar(it); extras.coachSetup.said = null } }
    LaunchedEffect(extras.watch?.said) { extras.watch?.said?.let { snack.showSnackbar(it); extras.watch.said = null } }
    LaunchedEffect(extras.more?.said) { extras.more?.said?.let { snack.showSnackbar(it); extras.more.said = null } }
    // Watch only with a watch in use (src/in-use.ts), or while it's open (from More → More tools).
    val inUse = LocalInUse.current
    val groups = GROUPS.filter { it.first != "watch" || inUse.watch || group == "watch" }
    val at = groups.indexOfFirst { it.first == group }.coerceAtLeast(0)
    var forward by remember { mutableStateOf(true) }

    androidx.compose.runtime.CompositionLocalProvider(LocalExtras provides extras) {
    Box(Modifier.fillMaxSize().background(cs.surface)) {
        Column(
            Modifier.fillMaxSize().imePadding().verticalScroll(pageScroll).padding(start = 16.dp, end = 16.dp, top = top + 60.dp, bottom = bottom + if (navSpace) 104.dp else 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PageHeader(stringResource(R.string.common_settings))
            Segmented(groups.map { it.second }, at, { i -> forward = i > at; actions.go("settings/${groups[i].first}") })
            if (groups[at].third.isNotEmpty()) Text(groups[at].third, style = MaterialTheme.typography.bodyLarge, color = cs.onSurfaceVariant)
            AnimatedContent(
                group,
                transitionSpec = {
                    val d = if (forward) 1 else -1
                    (fadeIn(tween(220, 60)) + slideInHorizontally { d * it / 10 }) togetherWith (fadeOut(tween(140)) + slideOutHorizontally { -d * it / 10 })
                },
                label = "group",
            ) { g ->
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    when (g) {
                        "sources" -> sources?.let { SourcesGroup(it) }
                        "coach" -> CoachGroup(m, actions)
                        "watch" -> extras.watch?.let { WatchGroup(it, actions::go, extras.sources ?: sources) }
                        "more" -> MoreGroup(m, actions)
                        else -> TrainingGroup(m, actions)
                    }
                }
            }
        }
        TopScrim(pageScroll.value > 0)
        SnackbarHost(snack, Modifier.align(Alignment.BottomCenter).padding(bottom = bottom + if (navSpace) 96.dp else 16.dp, start = 16.dp, end = 16.dp))
    }
    }
}

/** The native parts of Settings beyond its own model (null only in tests that leave one out). */
class SettingsExtras(val shoes: ShoesModel? = null, val coachSetup: CoachSetupModel? = null, val watch: WatchGroupModel? = null, val more: MoreModel? = null, val sources: SourcesModel? = null)
val LocalExtras = androidx.compose.runtime.staticCompositionLocalOf { SettingsExtras() }

@Composable
fun SetCard(title: String, icon: String, sub: String? = null, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth().clip(CARD).background(cs.surfaceContainer).padding(20.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // The title speaks for itself: no icon before it (the same few repeated meant nothing).
        Text(title, style = MaterialTheme.typography.titleLarge)
        sub?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
        content()
    }
}

private val FIELD = RoundedCornerShape(14.dp)

/** A labelled field: the label above, the value in a light box with a hairline edge. */
@Composable
fun Field(label: String, value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier, number: Boolean = false, placeholder: String = "", secret: Boolean = false) {
    val cs = MaterialTheme.colorScheme
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
        // Lighter than the card with a hairline edge (readable in daylight); the edge turns primary while typing.
        var focused by remember { mutableStateOf(false) }
        Box(Modifier.fillMaxWidth().height(48.dp).clip(FIELD).background(cs.raised).border(if (focused) 2.dp else 1.dp, if (focused) cs.primary else cs.outlineVariant, FIELD).padding(horizontal = 14.dp), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty()) Text(placeholder, color = cs.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
            BasicTextField(
                value, onChange, Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }, singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = cs.onSurface), cursorBrush = SolidColor(cs.primary),
                keyboardOptions = KeyboardOptions(keyboardType = if (number) KeyboardType.Decimal else if (secret) KeyboardType.Password else KeyboardType.Text),
                visualTransformation = if (secret) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            )
        }
    }
}

/** A tappable value in a field's pill (a date, a time). */
@Composable
fun PickField(label: String, value: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
        Box(Modifier.fillMaxWidth().height(48.dp).press(scale = 0.98f, label = label, onClick = onClick).clip(FIELD).background(cs.raised).border(1.dp, cs.outlineVariant, FIELD).padding(horizontal = 14.dp), contentAlignment = Alignment.CenterStart) {
            Text(value, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

@Composable
fun SwitchRow(title: String, sub: String, on: Boolean, onChange: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(sub, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Switch(on, onChange, thumbContent = if (on) { { Icon(Glyphs["check"], null, Modifier.size(14.dp)) } } else null)
    }
}


private fun num(x: Double?): String = x?.let { if (it == Math.rint(it)) it.toInt().toString() else String.format(Locale.US, "%.1f", it) } ?: ""

/** "1:52:30", "52:30" or "52" (minutes) to seconds. */
private fun parseTime(s: String): Int? {
    val p = s.trim().split(":").map { it.toIntOrNull() ?: return null }
    return when (p.size) { 1 -> p[0] * 60; 2 -> p[0] * 60 + p[1]; 3 -> p[0] * 3600 + p[1] * 60 + p[2]; else -> null }
}

/**
 * A card that saves itself: `value` (null while it can't be saved, a half-written time say) a
 * moment after it last changed, unless it's what was there at first or what was saved last; then
 * a quiet "Saved" under it.
 */
@Composable
private fun <T> AutoSave(card: String, value: T?, m: SettingsModel, save: (T) -> Unit) {
    var last by remember { mutableStateOf(value) }
    LaunchedEffect(value) {
        if (value == null || value == last) return@LaunchedEffect
        kotlinx.coroutines.delay(900)
        last = value
        save(value)
    }
    AnimatedVisibility(m.autosaved == card && value == last, enter = fadeIn(), exit = fadeOut()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Glyphs["check"], null, Modifier.size(14.dp), tint = LocalData.current.good)
            Text(stringResource(R.string.common_saved), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
        }
    }
}

private val RACES get() = listOf(str(R.string.settings_race_no_race) to null, "5 km" to 5.0, "10 km" to 10.0, str(R.string.settings_race_half) to 21.0975, str(R.string.settings_race_marathon) to 42.195, str(R.string.common_other) to -1.0)
private val PRESETS get() = listOf(str(R.string.common_preset_before_work) to "06:30", str(R.string.common_preset_lunch) to "12:00", str(R.string.common_preset_after_work) to "18:00", str(R.string.common_preset_evening) to "20:00")
private val DAYS get() = listOf("mon" to str(R.string.settings_monday), "tue" to str(R.string.settings_tuesday), "wed" to str(R.string.settings_wednesday), "thu" to str(R.string.settings_thursday), "fri" to str(R.string.settings_friday), "sat" to str(R.string.settings_saturday), "sun" to str(R.string.settings_sunday))
/** On a bad-weather day: what you'd rather, and what's said when it's chosen. */
private val BAD_WEATHER get() = listOf(
    Triple("run", str(R.string.settings_run_anyway), str(R.string.settings_bad_weather_run)),
    Triple("swim", str(R.string.settings_swim), str(R.string.settings_bad_weather_swim)),
    Triple("ride", str(R.string.settings_bike), str(R.string.settings_bad_weather_ride)),
    Triple("treadmill", str(R.string.settings_treadmill), str(R.string.settings_bad_weather_treadmill)),
)
/** What puts you off, as the engine names it (src/schedule.ts AVOID). */
private val AVOID get() = listOf("ice" to str(R.string.settings_avoid_ice), "rain" to str(R.string.settings_avoid_rain), "wind" to str(R.string.settings_avoid_wind), "cold" to str(R.string.settings_avoid_cold), "heat" to str(R.string.settings_avoid_heat), "dark" to str(R.string.settings_avoid_dark))
private val COLD = listOf(-10, -5, 0, 5)
private val LEADS get() = listOf(15 to str(R.string.settings_15_min), 30 to str(R.string.settings_30_min), 60 to str(R.string.settings_1_hour), 120 to str(R.string.settings_2_hours))

@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun TrainingGroup(m: SettingsModel, actions: SettingsActions) {
    val cs = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    var i = 0
    // Targets.
    m.goals?.let { g ->
        var km by rememberSaveable(g) { mutableStateOf(num(g.weeklyKm)) }
        var workouts by rememberSaveable(g) { mutableStateOf(g.weeklyWorkouts?.toString() ?: "") }
        var long by rememberSaveable(g) { mutableStateOf(num(g.longRunKm)) }
        val known = RACES.indexOfFirst { it.second != null && it.second!! > 0 && g.raceKm != null && kotlin.math.abs(it.second!! - g.raceKm) < 0.05 }
        var race by rememberSaveable(g) { mutableStateOf(if (g.raceKm == null) 0 else if (known >= 0) known else RACES.lastIndex) }
        var other by rememberSaveable(g) { mutableStateOf(if (known < 0) num(g.raceKm) else "") }
        var name by rememberSaveable(g) { mutableStateOf(g.raceName ?: "") }
        var date by rememberSaveable(g) { mutableStateOf(g.raceDate ?: "") }
        var target by rememberSaveable(g) { mutableStateOf(g.raceTarget?.let(::clock) ?: "") }
        var picking by remember { mutableStateOf(false) }
        SetCard(stringResource(R.string.settings_targets), "spark", if (m.plan != null) stringResource(R.string.settings_while_your_plan_runs_it_sets) else stringResource(R.string.settings_leave_a_field_empty_for_no), Modifier.reveal(i++)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field(stringResource(R.string.settings_a_week_km), km, { km = it }, Modifier.weight(1f), number = true, placeholder = "none")
                Field(stringResource(R.string.common_workouts_title), workouts, { workouts = it }, Modifier.weight(1f), number = true, placeholder = "none")
                Field(stringResource(R.string.settings_long_run_km), long, { long = it }, Modifier.weight(1f), number = true, placeholder = "none")
            }
            Text(stringResource(R.string.common_race), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
            Segmented(RACES.map { it.first }, race, { race = it })
            AnimatedVisibility(race > 0, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Field(stringResource(R.string.settings_race_name), name, { name = it }, placeholder = "e.g. Göteborgsvarvet")
                    if (race == RACES.lastIndex) Field(stringResource(R.string.settings_race_distance_km), other, { other = it }, number = true)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PickField(stringResource(R.string.settings_date), date.ifEmpty { stringResource(R.string.settings_pick_a_day) }.let { d -> runCatching { dateShort(d) + " " + LocalDate.parse(d).year }.getOrDefault(d) }, { picking = true }, Modifier.weight(1f))
                        Field(stringResource(R.string.common_target_time), target, { target = it }, Modifier.weight(1f), placeholder = "h:mm:ss")
                    }
                }
            }
            // Saved as you go, a moment after the last change; a half-written target time waits.
            val t = parseTime(target)
            val timeOk = target.isBlank() || t != null
            if (!timeOk) Text(stringResource(R.string.settings_write_the_target_time_like_1), style = MaterialTheme.typography.bodySmall, color = cs.error)
            val dist = if (race == RACES.lastIndex) other.replace(',', '.').toDoubleOrNull() else RACES[race].second
            val goals = Goals(km.replace(',', '.').toDoubleOrNull()?.takeIf { it > 0 }, workouts.toIntOrNull()?.takeIf { it > 0 }, long.replace(',', '.').toDoubleOrNull()?.takeIf { it > 0 },
                dist?.takeIf { race > 0 && it > 0 }, name.ifBlank { null }.takeIf { race > 0 }, date.ifBlank { null }.takeIf { race > 0 }, t.takeIf { race > 0 })
            AutoSave("targets", goals.takeIf { timeOk }, m) { m.saveGoals(it, quiet = true) }
        }
        if (picking) {
            val st = rememberDatePickerState(initialSelectedDateMillis = runCatching { LocalDate.parse(date).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() }.getOrNull())
            DatePickerDialog(
                onDismissRequest = { picking = false },
                confirmButton = { TextButton(onClick = { st.selectedDateMillis?.let { date = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString() }; picking = false }) { Text("OK") } },
                dismissButton = { TextButton(onClick = { picking = false }) { Text(stringResource(R.string.common_cancel)) } },
            ) { DatePicker(st) }
        }
    }
    // Heart rate.
    m.profile?.let { p ->
        var max by rememberSaveable(p) { mutableStateOf(p.maxHr.toString()) }
        var rest by rememberSaveable(p) { mutableStateOf(p.restHr.toString()) }
        var sex by rememberSaveable(p) { mutableStateOf(when (p.sex) { "M" -> 1; "F" -> 2; else -> 0 }) }
        val sexValue = { listOf(null, "M", "F")[sex] }
        SetCard(stringResource(R.string.common_heart_rate), "heart", if (p.fromWatch && p.limits.size >= 4) stringResource(R.string.settings_zones_come_from_your_watch_z2, p.limits[0], p.limits[1], p.limits[2], p.limits[3], p.maxSource) else stringResource(R.string.settings_heart_rate_zones_and_effort_scores, p.maxSource), Modifier.reveal(i++)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field(stringResource(R.string.settings_max), max, { max = it }, Modifier.weight(1f), number = true)
                Field(stringResource(R.string.settings_resting), rest, { rest = it }, Modifier.weight(1f), number = true)
            }
            Text(stringResource(R.string.settings_sex_for_effort_scores_and_exercise), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
            Segmented(listOf(stringResource(R.string.settings_not_set), stringResource(R.string.settings_male), stringResource(R.string.settings_female)), sex, { sex = it })
            // Saved as you go. The max is saved only when it's yours: an untouched estimate (or the
            // watch's) stays automatic.
            val own = p.maxSource == "set by you" || max.toIntOrNull() != p.maxHr
            val heart = Triple(if (own) max.toIntOrNull() else null, rest.toIntOrNull() ?: p.restHr, sexValue())
            AutoSave("heart", heart.takeIf { max.isBlank() || max.toIntOrNull() != null }, m) { (mx, rs, sx) -> m.saveProfile(mx, rs, sx, quiet = true) }
            if (p.canUseWatch) FilledTonalButton(onClick = { m.useWatchZones(rest.toIntOrNull() ?: p.restHr, sexValue()) }, shapes = ButtonDefaults.shapes()) { Text(stringResource(R.string.settings_use_my_watch_s_zones)) }
        }
    }
    // Training times.
    m.times?.let { t ->
        var editing by remember { mutableStateOf<String?>(null) }
        var ownDays by rememberSaveable { mutableStateOf(t.days.isNotEmpty()) }
        SetCard(stringResource(R.string.settings_training_times), "clock", null, Modifier.reveal(i++)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PickField(stringResource(R.string.common_weekdays), t.weekday, { editing = "weekday" }, Modifier.weight(1f))
                PickField(stringResource(R.string.common_weekends), t.weekend, { editing = "weekend" }, Modifier.weight(1f))
            }
            // Two by two, as in the intro: four presets that never leave one alone on a line.
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PRESETS.chunked(2).forEach { pair ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        pair.forEach { (label, time) ->
                            val on = t.weekday == time
                            Column(
                                Modifier.weight(1f).press(label = label, onClick = { m.saveTimes(JSONObject().put("weekday", time), str(R.string.settings_weekday_sessions_at, time)) })
                                    .clip(RoundedCornerShape(16.dp)).background(if (on) cs.primary else cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 8.dp),
                            ) {
                                Text(label, style = MaterialTheme.typography.labelLarge, color = if (on) cs.onPrimary else cs.onSurface)
                                Text(time, style = MaterialTheme.typography.bodySmall, color = if (on) cs.onPrimary else cs.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().press(scale = 0.99f, onClick = { ownDays = !ownDays }), verticalAlignment = Alignment.CenterVertically) {
                Text(if (t.days.isNotEmpty()) pluralStringResource(R.plurals.settings_own_time_days, t.days.size, t.days.size) else stringResource(R.string.settings_a_different_time_on_some_days), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Icon(Glyphs["chevron"], null, Modifier.graphicsLayer { rotationZ = if (ownDays) 90f else 0f }, tint = cs.onSurfaceVariant)
            }
            if (ownDays) {
                DAYS.chunked(2).forEach { pair ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        pair.forEach { (k, name) -> PickField(name, t.days[k] ?: stringResource(R.string.settings_same), { editing = k }, Modifier.weight(1f)) }
                        if (pair.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
            Text(t.next ?: if (m.hasPlan) stringResource(R.string.settings_no_sessions_ahead_in_your_plan) else stringResource(R.string.settings_your_coach_s_plan_will_use), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            SwitchRow(stringResource(R.string.common_remind_me), stringResource(R.string.settings_a_notification_before_each_session_with), t.remind) { on ->
                scope.launch {
                    if (on && !m.allowReminders()) { m.said = str(R.string.settings_notifications_are_off_for_tartan_turn); return@launch }
                    m.saveTimes(JSONObject().put("remind", JSONObject().put("on", on).put("before_min", t.before).put("after", t.after)), if (on) str(R.string.settings_reminders_on) else str(R.string.settings_reminders_off))
                }
            }
            if (t.remind) Segmented(LEADS.map { stringResource(R.string.settings_before, it.second).replace(" min before", " min") }, LEADS.indexOfFirst { it.first == t.before }.coerceAtLeast(0), { k ->
                m.saveTimes(JSONObject().put("remind", JSONObject().put("on", true).put("before_min", LEADS[k].first).put("after", t.after)), null)
            })
            SwitchRow(stringResource(R.string.settings_after_a_session), stringResource(R.string.settings_half_an_hour_after_it_should), t.after) { on ->
                scope.launch {
                    if (on && !m.allowReminders()) { m.said = str(R.string.settings_notifications_are_off_for_tartan_turn); return@launch }
                    m.saveTimes(JSONObject().put("remind", JSONObject().put("on", t.remind).put("before_min", t.before).put("after", on)), if (on) str(R.string.settings_nudges_after_sessions_on) else str(R.string.settings_nudges_after_sessions_off))
                }
            }
            val notify = { morning: Boolean, at: String, review: Boolean -> JSONObject().put("notify", JSONObject().put("morning", morning).put("morning_at", at).put("review", review)) }
            SwitchRow(stringResource(R.string.settings_each_morning), stringResource(R.string.settings_how_you_are_and_what_s, t.morningAt), t.morning) { on ->
                scope.launch {
                    if (on && !m.allowReminders()) { m.said = str(R.string.settings_notifications_are_off_for_tartan_turn); return@launch }
                    m.saveTimes(notify(on, t.morningAt, t.review), if (on) str(R.string.settings_a_word_each_morning_at, t.morningAt) else str(R.string.settings_no_morning_notification))
                }
            }
            if (t.morning) PickField(stringResource(R.string.settings_morning_notification_at), t.morningAt, { editing = "morning" })
            SwitchRow(stringResource(R.string.settings_sunday_evening_review), stringResource(R.string.settings_at_19_00_on_sundays_a), t.review) { on ->
                scope.launch {
                    if (on && !m.allowReminders()) { m.said = str(R.string.settings_notifications_are_off_for_tartan_turn); return@launch }
                    m.saveTimes(notify(t.morning, t.morningAt, on), if (on) str(R.string.settings_a_nudge_on_sunday_evenings) else str(R.string.settings_no_sunday_nudge))
                }
            }
            SwitchRow(stringResource(R.string.settings_after_a_run), stringResource(R.string.settings_after_a_run_sub), t.runNote) { on ->
                scope.launch {
                    if (on && !m.allowReminders()) { m.said = str(R.string.settings_notifications_are_off_for_tartan_turn); return@launch }
                    m.saveTimes(JSONObject().put("notify", JSONObject().put("run", on)), if (on) str(R.string.settings_a_note_after_each_run) else str(R.string.settings_no_note_after_runs))
                }
            }
            var calendars by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
            SwitchRow(stringResource(R.string.settings_add_to_my_calendar), stringResource(R.string.settings_every_session_ahead_as_an_event), t.calendar) { on ->
                scope.launch {
                    if (!on) { m.saveTimes(JSONObject().put("calendar", JSONObject().put("on", false)), str(R.string.settings_your_plan_s_future_sessions_are)); return@launch }
                    val list = m.calendars()
                    if (list == null) { m.said = str(R.string.settings_tartan_can_t_reach_your_calendar); return@launch }
                    if (list.isEmpty()) { m.said = str(R.string.settings_no_calendar_on_this_phone_takes); return@launch }
                    calendars = list
                    val keep = list.firstOrNull { it.first == t.calendarId } ?: list.first()
                    m.saveTimes(JSONObject().put("calendar", JSONObject().put("on", true).put("calendar_id", keep.first).put("calendar_name", keep.second)), str(R.string.settings_your_sessions_are_going_into, keep.second))
                }
            }
            if (t.calendar) {
                LaunchedEffect(Unit) { if (calendars.isEmpty()) calendars = m.calendars() ?: emptyList() }
                if (calendars.size > 1) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    calendars.forEach { (id, title) ->
                        val on = id == t.calendarId
                        Text(title, style = MaterialTheme.typography.labelLarge, color = if (on) cs.onPrimary else cs.onSurface, modifier = Modifier.press(label = title, onClick = {
                            m.saveTimes(JSONObject().put("calendar", JSONObject().put("on", true).put("calendar_id", id).put("calendar_name", title)), str(R.string.settings_your_sessions_are_moving_to, title))
                        }).clip(CircleShape).background(if (on) cs.primary else cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 8.dp))
                    }
                }
            }
            FilledTonalButton(onClick = { m.saveFile("/api/plan/calendar.ics", str(R.string.settings_tartan_training_ics, LocalDate.now()), "text/calendar") }, enabled = t.anySlots, shapes = ButtonDefaults.shapes()) {
                Text(stringResource(R.string.settings_calendar_file_ics))
            }
            Text(stringResource(R.string.settings_the_file_opens_in_any_calendar), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
        editing?.let { which ->
            val now = when (which) { "weekday" -> t.weekday; "weekend" -> t.weekend; "morning" -> t.morningAt; else -> t.days[which] ?: t.weekday }
            val (h, mm) = now.split(":").let { (it.getOrNull(0)?.toIntOrNull() ?: 7) to (it.getOrNull(1)?.toIntOrNull() ?: 0) }
            val st = rememberTimePickerState(h, mm, is24Hour = true)
            val name = DAYS.firstOrNull { it.first == which }?.second
            AlertDialog(
                onDismissRequest = { editing = null },
                title = { Text(name?.let { stringResource(R.string.common_sessions, it) } ?: when (which) { "weekday" -> stringResource(R.string.common_weekday_sessions); "morning" -> stringResource(R.string.settings_each_morning_at); else -> stringResource(R.string.common_weekend_sessions) }) },
                text = { TimePicker(st) },
                confirmButton = {
                    TextButton(onClick = {
                        val v = "%02d:%02d".format(st.hour, st.minute)
                        when (which) {
                            "weekday", "weekend" -> m.saveTimes(JSONObject().put(which, v), str(R.string.settings_sessions_at, which.replaceFirstChar { it.uppercase() }, v))
                            "morning" -> m.saveTimes(JSONObject().put("notify", JSONObject().put("morning", true).put("morning_at", v).put("review", t.review)), str(R.string.settings_a_word_each_morning_at, v))
                            else -> m.saveTimes(JSONObject().put("days", JSONObject(t.days.plus(which to v))), str(R.string.settings_s_at, name, v))
                        }
                        editing = null
                    }) { Text("OK") }
                },
                dismissButton = {
                    if (name != null && t.days.containsKey(which)) TextButton(onClick = {
                        m.saveTimes(JSONObject().put("days", JSONObject(t.days.minus(which))), str(if (which == "sat" || which == "sun") R.string.settings_days_at_weekend_time else R.string.settings_days_at_weekday_time, name))
                        editing = null
                    }) { Text(stringResource(R.string.settings_same_as_usual)) } else TextButton(onClick = { editing = null }) { Text(stringResource(R.string.common_cancel)) }
                },
            )
        }
    }
    // On a bad-weather day: run anyway (nothing offered), or a swim, a ride, the treadmill.
    m.times?.let { t ->
        SetCard(stringResource(R.string.settings_bad_weather), "drop", stringResource(R.string.settings_bad_weather_sub), Modifier.reveal(i++)) {
            val opts = BAD_WEATHER
            Segmented(opts.map { it.second }, opts.indexOfFirst { it.first == t.badWeather }.coerceAtLeast(0), { k ->
                if (opts[k].first != t.badWeather) m.saveTimes(JSONObject().put("bad_weather", opts[k].first), opts[k].third)
            })
            // What puts you off: ticked, Today suggests a change on such days.
            Text(stringResource(R.string.settings_what_puts_you_off), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AVOID.forEach { (k, label) ->
                    val on = k in t.avoid
                    Text(label, style = MaterialTheme.typography.labelLarge, color = if (on) cs.onPrimary else cs.onSurface, modifier = Modifier.press(label = label, role = androidx.compose.ui.semantics.Role.Checkbox, onClick = {
                        val next = if (on) t.avoid - k else AVOID.map { it.first }.filter { it in t.avoid || it == k }
                        m.saveTimes(JSONObject().put("avoid", org.json.JSONArray(next)), if (next.isEmpty()) str(R.string.settings_avoid_none) else str(R.string.settings_avoid_saved))
                    }).clip(CircleShape).background(if (on) cs.primary else cs.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 8.dp))
                }
            }
            if ("cold" in t.avoid) {
                Text(stringResource(R.string.settings_cold_is_below), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
                Segmented(COLD.map { "$it °C" }, COLD.indexOf(t.coldBelow).coerceAtLeast(0), { k -> m.saveTimes(JSONObject().put("cold_below", COLD[k]), null) })
            }
            Text(stringResource(R.string.settings_avoid_sub), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
    }
    // Exercise demos, with strength sessions (lifts logged or planned); else under More → More tools.
    if (LocalInUse.current.lift && m.prefs != null) DemosCard(m, Modifier.reveal(i++))
    // The plan: export, reset.
    m.plan?.let { pl ->
        var armed by remember { mutableStateOf(false) }
        LaunchedEffect(armed) { if (armed) { kotlinx.coroutines.delay(4000); armed = false } }
        SetCard(stringResource(R.string.settings_training_plan), "coach", if (m.hasPlan) pluralStringResource(R.plurals.settings_plan_line, pl.weeks, pl.weeks, pl.title, ago(pl.updated)) else stringResource(R.string.settings_no_plan_yet_your_coach_makes), Modifier.reveal(i++)) {
            if (m.hasPlan) {
                ButtonFlow {
                    FilledTonalButton(onClick = { m.saveFile("/api/plan/export.csv", str(R.string.settings_training_plan_csv, LocalDate.now()), "text/csv") }, shapes = ButtonDefaults.shapes()) { ButtonText(stringResource(R.string.settings_export_as_csv)) }
                    TextButton(onClick = { if (armed) { armed = false; m.resetPlan() } else armed = true }) {
                        ButtonText(if (armed) stringResource(R.string.settings_tap_again_to_clear_the_plan) else stringResource(R.string.settings_reset_plan), color = cs.error)
                    }
                }
                Text(stringResource(R.string.settings_the_csv_has_one_row_per), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            } else FilledTonalButton(onClick = { actions.go("coach") }) { Text(stringResource(R.string.settings_go_to_coach)) }
        }
    }
    LocalExtras.current.shoes?.let { ShoesCard(it, Modifier) }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun CoachGroup(m: SettingsModel, actions: SettingsActions) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    var i = 0
    val setup = LocalExtras.current.coachSetup
    if (setup != null) CoachSetupCard(setup, Modifier.reveal(i++))
    else m.coach?.let { c ->
        SetCard(stringResource(R.string.settings_your_coach_s_ai), "coach", null, Modifier.reveal(i++)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(c.provider, style = MaterialTheme.typography.titleMedium)
                    Text(c.model, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                }
                Text(if (c.ready) stringResource(R.string.settings_ready_2) else stringResource(R.string.settings_needs_setting_up), style = MaterialTheme.typography.labelLarge, color = if (c.ready) data.good else data.watch,
                    modifier = Modifier.clip(CircleShape).background(if (c.ready) data.goodContainer else data.watchContainer).padding(horizontal = 12.dp, vertical = 6.dp))
            }
        }
    }
    m.plan?.let { pl ->
        val choices = listOf(
            Triple("ask", stringResource(R.string.settings_ask_me_every_time), stringResource(R.string.settings_every_change_waits_for_your_ok)),
            Triple("small", stringResource(R.string.settings_small_changes_go_straight_in), stringResource(R.string.settings_a_session_moved_within_its_week)),
            Triple("auto", stringResource(R.string.settings_my_coach_decides), stringResource(R.string.settings_the_coach_changes_the_plan_itself)),
        )
        SetCard(stringResource(R.string.settings_plan_changes), "spark", null, Modifier.reveal(i++)) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                choices.forEachIndexed { k, (id, title, line) ->
                    val on = pl.approval == id
                    val first = k == 0
                    val last = k == choices.lastIndex
                    Row(
                        Modifier.fillMaxWidth().press(scale = 0.98f, label = title, onClick = { m.approval(id) })
                            .clip(RoundedCornerShape(if (first) 20.dp else 6.dp, if (first) 20.dp else 6.dp, if (last) 20.dp else 6.dp, if (last) 20.dp else 6.dp))
                            .background(if (on) cs.secondaryContainer else cs.surfaceContainerHigh).padding(16.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Box(Modifier.padding(top = 2.dp).size(20.dp).clip(CircleShape).background(if (on) cs.primary else Color.Transparent).border(2.dp, if (on) cs.primary else cs.outline, CircleShape), contentAlignment = Alignment.Center) {
                            if (on) Box(Modifier.size(8.dp).clip(CircleShape).background(cs.onPrimary))
                        }
                        Spacer(Modifier.width(12.dp))
                        Column { Text(title, style = MaterialTheme.typography.titleSmall); Text(line, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant) }
                    }
                }
            }
            Text(stringResource(R.string.settings_days_behind_you_are_never_changed), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
    }
    m.prefs?.let { p ->
        SetCard(stringResource(R.string.settings_weekly_review), "clock", null, Modifier.reveal(i++)) {
            SwitchRow(stringResource(R.string.settings_look_back_every_sunday), stringResource(R.string.settings_sunday_evening_your_coach_looks_back), p.weekly) { on ->
                m.setPref("weekly", JSONObject().put("on", on)) { it.copy(weekly = on) }
            }
        }
    }
    SetCard(stringResource(R.string.settings_what_your_coach_remembers), "spark", null, Modifier.reveal(i)) {
        val kinds = mapOf("athlete" to stringResource(R.string.settings_you), "health" to stringResource(R.string.settings_health), "preference" to stringResource(R.string.settings_likes), "goal" to stringResource(R.string.settings_goal), "lesson" to stringResource(R.string.settings_learned))
        if (m.notes.isEmpty() && m.forgotten == null) Text(stringResource(R.string.settings_nothing_yet_tell_the_coach_something), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        m.forgotten?.let { (_, n) ->
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(cs.inverseSurface).padding(start = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.settings_forgotten, n.text), style = MaterialTheme.typography.bodyMedium, color = cs.inverseOnSurface, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                TextButton(onClick = { m.unforget() }) { Text(stringResource(R.string.common_undo), color = cs.inversePrimary) }
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            m.notes.forEachIndexed { k, n ->
                val first = k == 0
                val last = k == m.notes.lastIndex
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(if (first) 20.dp else 6.dp, if (first) 20.dp else 6.dp, if (last) 20.dp else 6.dp, if (last) 20.dp else 6.dp))
                        .background(cs.surfaceContainerHigh).padding(start = 14.dp, top = 10.dp, bottom = 10.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(kinds[n.kind] ?: n.kind, style = MaterialTheme.typography.labelMedium, color = cs.onSecondaryContainer, modifier = Modifier.clip(CircleShape).background(cs.secondaryContainer).padding(horizontal = 8.dp, vertical = 3.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(n.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Box(Modifier.size(40.dp).press(label = stringResource(R.string.settings_forget, n.text), onClick = { m.forgetNote(n) }), contentAlignment = Alignment.Center) {
                        Icon(Glyphs["plus"], null, Modifier.size(18.dp).graphicsLayer { rotationZ = 45f }, tint = cs.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/** Who shows the strength exercises (Settings → Training, or More → More tools without strength sessions). */
@Composable
fun DemosCard(m: SettingsModel, modifier: Modifier) {
    if (m.prefs == null) return
    SetCard(stringResource(R.string.settings_exercise_demos), "bolt", demosLine(m), modifier) { DemosPicker(m) }
}

@Composable
fun demosLine(m: SettingsModel): String = m.profile?.sex?.let { s -> stringResource(if (s == "F") R.string.settings_like_me_woman else R.string.settings_like_me_man) } ?: stringResource(R.string.settings_like_me_follows_the_sex_in)

@Composable
fun DemosPicker(m: SettingsModel) {
    val p = m.prefs ?: return
    val choices = listOf("me" to stringResource(R.string.settings_like_me), "m" to stringResource(R.string.settings_man), "f" to stringResource(R.string.settings_woman), "mix" to stringResource(R.string.settings_both))
    Segmented(choices.map { it.second }, choices.indexOfFirst { it.first == p.demos }.coerceAtLeast(0), { k ->
        m.setPref("demos", JSONObject().put("choice", choices[k].first)) { it.copy(demos = choices[k].first) }
    })
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun MoreGroup(m: SettingsModel, actions: SettingsActions) {
    val cs = MaterialTheme.colorScheme
    var i = 0
    val x = LocalExtras.current
    // Paired: at the top, as before. Not yet: under More tools.
    val inUse = LocalInUse.current
    x.sources?.takeIf { inUse.pc || it.pc != null }?.let { PcCard(it, Modifier.reveal(i++)) }
    x.more?.let { BackupCard(it, Modifier.reveal(i++)) }
    SetCard(stringResource(R.string.common_your_data), "folder", stringResource(R.string.settings_kept_in_this_app_s_own), Modifier.reveal(i++)) {
        m.prefs?.let { Text(stringResource(R.string.common_version_build, it.version, it.build), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
        x.more?.let { mm -> TextButton(onClick = { mm.replayIntro() }) { Text(stringResource(R.string.settings_replay_the_intro)) } }
    }
    // Then how it looks, and the rest.
    m.prefs?.let { p ->
        if (Build.VERSION.SDK_INT >= 31) SetCard(stringResource(R.string.common_colours), "spark", null, Modifier.reveal(i++)) {
            Segmented(listOf(stringResource(R.string.settings_your_wallpaper), "Tartan"), if (p.colours == "tartan") 1 else 0, { k ->
                val c = if (k == 1) "tartan" else "wallpaper"
                m.setPref("colours", JSONObject().put("choice", c)) { it.copy(colours = c) }
            })
        }
    }
    x.more?.let { FeedbackCard(it, Modifier.reveal(i++)) }
    x.more?.let { MoreToolsCard(it, Modifier.reveal(i++), x.watch, actions::go, m, x.sources) }
}
