package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Tartan 2: the first run, native (web/views/onboard.ts). Five short steps, each doing something
 * real: hello (a timing board where your watch, Strava and your coach cross the line), bringing
 * workouts in, the coach, when you train, and where things live. Skippable at every step; where
 * you are is kept by the page, so the intro comes back to it.
 */
class IntroModel(private val scope: CoroutineScope, private val api: SettingsApi, start: Int) {
    var step by mutableStateOf(start.coerceIn(0, LAST))
    /** "steps", or the welcome's other ways in: "pc" (from your PC), "backup". */
    var page by mutableStateOf("steps")
    var forward by mutableStateOf(true)
    var leaving by mutableStateOf(false)
    /** The first time (the intro from its start): Tartan's mark draws itself in before the first step. */
    var brand by mutableStateOf(start == 0)

    fun go(to: Int) {
        if (to > LAST) return done(false)
        forward = to > step || page != "steps"
        step = to.coerceAtLeast(0); page = "steps"
        scope.launch { api.call("introStep", JSONObject().put("step", step)) }
    }
    fun open(p: String) { forward = true; page = p; scope.launch { api.call("introStep", JSONObject().put("step", 0)) } }
    /** Tartan with sample data, on storage of its own (Today has the way back). */
    fun demo() { scope.launch { api.call("demo", JSONObject().put("op", "start")) } }
    fun back() { if (page != "steps") { forward = false; page = "steps" } else if (step > 0) go(step - 1) }
    /** Shown once: Today (or the whole app again, after a copy from the PC). */
    fun done(reload: Boolean) {
        if (leaving) return
        leaving = true
        scope.launch { api.call("introDone", JSONObject().put("reload", reload)) }
    }

    companion object { const val LAST = 4 }
}

private val TIMES get() = listOf(str(R.string.common_preset_before_work) to "06:30", str(R.string.common_preset_lunch) to "12:00", str(R.string.common_preset_after_work) to "18:00", str(R.string.common_preset_evening) to "20:00")

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun IntroScreen(m: IntroModel, settings: SettingsModel, sources: SourcesModel, extras: SettingsExtras, close: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    val reduced = LocalReducedMotion.current
    // In and out: the whole thing settles in on the slow spring, and shrinks away when done.
    val shown = remember { Animatable(if (reduced) 1f else 0f) }
    val spec = MaterialTheme.motionScheme.slowSpatialSpec<Float>()
    LaunchedEffect(m.leaving) {
        if (!m.leaving) shown.animateTo(1f, spec)
        else { if (!reduced) shown.animateTo(0f, tween(380)); close() }
    }
    Dialog(onDismissRequest = { m.back() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false, dismissOnClickOutside = false)) {
        // The mark first; it opens out (a little larger, fading) as the intro comes in under it.
        AnimatedContent(m.brand, transitionSpec = {
            fadeIn(tween(380, 120)) togetherWith (fadeOut(tween(420)) + androidx.compose.animation.scaleOut(tween(420), targetScale = 1.08f))
        }, label = "brand") { brand ->
            if (brand) BrandIntro { m.brand = false }
            else IntroBody(m, settings, sources, extras, Modifier.graphicsLayer {
                alpha = shown.value.coerceIn(0f, 1f)
                val s = 0.94f + 0.06f * shown.value
                scaleX = s; scaleY = s
            })
        }
    }
}

/** The intro's pages, back and on (in its own window: IntroScreen). */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun IntroBody(m: IntroModel, settings: SettingsModel, sources: SourcesModel, extras: SettingsExtras, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    run {
        Box(modifier.fillMaxSize().background(cs.surface).safeDrawingPadding()) {
            Column(Modifier.fillMaxSize()) {
                // The steps so far, and Skip.
                Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (i in 0..IntroModel.LAST) {
                            val fill by animateFloatAsState(if (i <= m.step) 1f else 0f, MaterialTheme.motionScheme.defaultSpatialSpec(), label = "step")
                            Box(Modifier.weight(1f).height(6.dp).clip(CircleShape).background(cs.surfaceContainerHighest)) {
                                Box(Modifier.fillMaxHeight().fillMaxWidth(fill.coerceIn(0f, 1f)).clip(CircleShape).background(cs.primary))
                            }
                        }
                    }
                    TextButton(onClick = { m.done(false) }) { Text(stringResource(R.string.intro_skip_setup)) }
                }
                AnimatedContent(
                    m.page to m.step,
                    Modifier.weight(1f),
                    transitionSpec = {
                        val d = if (m.forward) 1 else -1
                        (fadeIn(tween(220, 60)) + slideInHorizontally(spring(Spring.DampingRatioLowBouncy, Spring.StiffnessMediumLow)) { d * it / 4 }) togetherWith
                            (fadeOut(tween(140)) + slideOutHorizontally(tween(220)) { -d * it / 6 })
                    },
                    label = "intro",
                ) { (page, step) ->
                    Column(
                        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        when {
                            page == "pc" -> FromPc(m, sources)
                            page == "backup" -> FromBackup(m, extras)
                            step == 0 -> Welcome(m)
                            step == 1 -> {
                                Title(stringResource(R.string.intro_bring_in_your_workouts), stringResource(R.string.intro_connect_any_of_these_health_connect))
                                IntroSources(sources)
                                Fine(stringResource(R.string.intro_files_from_other_apps_and_more))
                            }
                            step == 2 -> {
                                Title(stringResource(R.string.intro_add_your_coach), stringResource(R.string.intro_the_coach_reads_your_workouts_builds))
                                extras.coachSetup?.let { CoachSetupCard(it, Modifier) }
                            }
                            step == 3 -> Times(settings)
                            else -> Places()
                        }
                    }
                }
                // Back, and on.
                if (m.page != "steps" || m.step > 0) Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    FilledTonalIconButton(onClick = { m.back() }, Modifier.size(56.dp)) { Icon(Glyphs["chevron"], stringResource(R.string.common_back), Modifier.size(22.dp).graphicsLayer { scaleX = -1f }) }
                    Spacer(Modifier.width(12.dp))
                    if (m.page == "steps") {
                        val ready = extras.coachSetup?.setup?.ready == true
                        val cta = when (m.step) { 2 -> if (ready) stringResource(R.string.common_continue) else stringResource(R.string.intro_skip_for_now); IntroModel.LAST -> stringResource(R.string.common_start); else -> stringResource(R.string.common_continue) }
                        Button(onClick = { view.feel(if (m.step == IntroModel.LAST) Haptic.Confirm else Haptic.Click); m.go(m.step + 1) }, modifier = Modifier.weight(1f).height(56.dp), shapes = ButtonDefaults.shapes()) {
                            Text(cta, style = MaterialTheme.typography.titleMedium)
                        }
                    }
                }
            }
            val said = sources.said ?: extras.coachSetup?.said ?: extras.more?.said ?: settings.said
            Said(said, { if (sources.said != null) sources.said = null else if (extras.coachSetup?.said != null) extras.coachSetup.said = null else if (extras.more?.said != null) extras.more.said = null else settings.said = null }, Modifier.align(Alignment.BottomCenter).padding(bottom = 88.dp))
        }
    }
}

@Composable
private fun Title(title: String, lede: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.displaySmall.copy(fontFamily = FlexRound, fontWeight = FontWeight.Bold), modifier = Modifier.semantics { heading() })
        Text(lede, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Fine(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Welcome(m: IntroModel) {
    val cs = MaterialTheme.colorScheme
    val reduced = LocalReducedMotion.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(28.dp).clip(RoundedCornerShape(9.dp)).background(cs.primary), contentAlignment = Alignment.Center) {
            Text("T", color = cs.onPrimary, style = TextStyle(fontFamily = FlexRound, fontWeight = FontWeight.Black, fontSize = 18.sp))
        }
        Spacer(Modifier.width(8.dp))
        Text("Tartan", style = MaterialTheme.typography.titleLarge.copy(fontFamily = FlexRound, fontWeight = FontWeight.Bold))
    }
    Board()
    // Hello lands with a bounce, after the lanes have crossed the line.
    val hello = remember { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(Unit) { if (!reduced) { delay(900); hello.animateTo(1f, spring(Spring.DampingRatioMediumBouncy, Spring.StiffnessLow)) } }
    Text(
        stringResource(R.string.intro_hello), style = MaterialTheme.typography.displayLarge.copy(fontFamily = FlexRound, fontWeight = FontWeight.Black),
        modifier = Modifier.semantics { heading() }.graphicsLayer { alpha = hello.value.coerceIn(0f, 1f); val s = 0.6f + 0.4f * hello.value; scaleX = s; scaleY = s; transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0.5f) },
    )
    Text(stringResource(R.string.intro_your_training_yours_to_keep_is), style = MaterialTheme.typography.titleMedium, color = cs.onSurfaceVariant)
    Choice("spark", stringResource(R.string.intro_i_m_new_to_tartan), stringResource(R.string.intro_set_me_up_workouts_coach_training), 0) { m.go(1) }
    Choice("pc", stringResource(R.string.intro_i_use_tartan_on_my_pc), stringResource(R.string.intro_bring_it_all_over_plan_coach), 1) { m.open("pc") }
    Choice("history", stringResource(R.string.intro_i_have_a_backup), stringResource(R.string.intro_restore_a_tartan_backup_file), 2) { m.open("backup") }
    TextButton(onClick = { m.demo() }) { Text(stringResource(R.string.intro_just_looking_try_it_with_sample)) }
    Fine(stringResource(R.string.intro_works_with_health_connect_intervals_icu))
}

/** A way in: a big row with its icon in a shape that turns a little rounder as it's pressed. */
@Composable
private fun Choice(icon: String, title: String, sub: String, i: Int, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    val src = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    val down by src.collectIsPressedAsState()
    val corner by animateDpAsState(if (down) 36.dp else 24.dp, MaterialTheme.motionScheme.fastSpatialSpec(), label = "corner")
    val scale by animateFloatAsState(if (down) 0.97f else 1f, MaterialTheme.motionScheme.fastSpatialSpec(), label = "scale")
    Row(
        Modifier.fillMaxWidth().reveal(i + 3).graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(RoundedCornerShape(corner)).background(cs.surfaceContainer)
            .clickable(src, androidx.compose.material3.ripple(), onClickLabel = title) { view.feel(Haptic.Click); onClick() }.padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(48.dp).clip(RoundedCornerShape(if (down) 24.dp else 14.dp)).background(cs.primaryContainer), contentAlignment = Alignment.Center) {
            Icon(Glyphs[icon], null, Modifier.size(24.dp), tint = cs.onPrimaryContainer)
        }
        Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(sub, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        }
        Icon(Glyphs["chevron"], null, Modifier.size(18.dp), tint = cs.onSurfaceVariant)
    }
}

/**
 * The welcome's timing board: your watch, Strava and your coach, a lane each, run to the finish
 * line one after another; each lights the line as it crosses.
 */
@Composable
private fun Board() {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val reduced = LocalReducedMotion.current
    val lanes = listOf(Triple(stringResource(R.string.common_watch), stringResource(R.string.intro_straight_off_your_wrist_over_bluetooth), data.watch), Triple("Strava", stringResource(R.string.intro_your_whole_history_every_stream), data.effort), Triple(stringResource(R.string.common_coach), stringResource(R.string.intro_a_plan_built_around_your_week), data.pace))
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainerLow).padding(vertical = 6.dp).semantics { contentDescription = str(R.string.intro_your_watch_strava_and_your_coach) },
    ) {
        lanes.forEachIndexed { i, (name, sub, hue) ->
            val run = remember { Animatable(if (reduced) 1f else 0f) }
            val flash = remember { Animatable(0f) }
            LaunchedEffect(Unit) {
                if (reduced) return@LaunchedEffect
                delay(250L + i * 220L)
                run.animateTo(1f, spring(Spring.DampingRatioLowBouncy, Spring.StiffnessVeryLow))
            }
            LaunchedEffect(run.value >= 0.98f) { if (run.value >= 0.98f && !reduced) { flash.snapTo(1f); flash.animateTo(0f, tween(700)) } }
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(30.dp).clip(RoundedCornerShape(10.dp)).background(hue), contentAlignment = Alignment.Center) {
                    Text("${i + 1}", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Black), color = Color.White)
                }
                Column(Modifier.width(132.dp).padding(start = 10.dp)) {
                    Text(name, style = MaterialTheme.typography.titleSmall)
                    Text(sub, style = MaterialTheme.typography.labelSmall, color = cs.onSurfaceVariant, maxLines = 2)
                }
                Canvas(Modifier.weight(1f).height(30.dp)) {
                    val y = size.height / 2
                    val end = size.width - 6.dp.toPx()
                    // The lane, the finish line, the runner.
                    drawLine(cs.outlineVariant, Offset(0f, y), Offset(end, y), 2.dp.toPx(), StrokeCap.Round, PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx())))
                    drawLine(hue.copy(alpha = 0.35f + 0.65f * flash.value), Offset(end, 2.dp.toPx()), Offset(end, size.height - 2.dp.toPx()), (3f + 4f * flash.value).dp.toPx(), StrokeCap.Round)
                    val x = 7.dp.toPx() + (end - 14.dp.toPx()) * run.value
                    drawLine(hue, Offset(0f, y), Offset(x, y), 3.dp.toPx(), StrokeCap.Round)
                    drawCircle(hue, 7.dp.toPx(), Offset(x, y))
                    if (flash.value > 0f) drawCircle(hue.copy(alpha = 0.3f * flash.value), (7f + 12f * (1f - flash.value)).dp.toPx(), Offset(end, y))
                }
            }
        }
    }
}

@Composable
private fun FromPc(m: IntroModel, sources: SourcesModel) {
    LaunchedEffect(Unit) { sources.ensure() }
    Title(stringResource(R.string.intro_bring_it_over_from_your_pc), stringResource(R.string.intro_your_phone_pairs_with_tartan_on))
    PcCard(sources, Modifier)
    if (sources.pc != null) {
        Fine(stringResource(R.string.intro_connect_strava_on_this_phone_in))
        Button(onClick = { m.done(true) }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text(stringResource(R.string.common_open_tartan), style = MaterialTheme.typography.titleMedium) }
    }
}

@Composable
private fun FromBackup(m: IntroModel, extras: SettingsExtras) {
    val more = extras.more ?: return
    // Restored: the page starts again with it, and the intro is over.
    LaunchedEffect(more.restored) { if (more.restored) { delay(900); m.done(false) } }
    Title(stringResource(R.string.intro_restore_your_backup), stringResource(R.string.intro_pick_the_backup_file_tartan_backup))
    BackupCard(more, Modifier)
}

/** When you train: the quick picks, your own times, reminders; and who you are, if nothing's said. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class, ExperimentalLayoutApi::class)
@Composable
private fun Times(settings: SettingsModel) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { settings.ensure() }
    Title(stringResource(R.string.intro_when_do_you_usually_train), stringResource(R.string.intro_your_plan_s_sessions_go_at))
    val t = settings.times ?: return
    var editing by remember { mutableStateOf<String?>(null) }
    // The quick picks: the chosen one grows rounder and fills.
    TIMES.chunked(2).forEach { pair ->
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            pair.forEach { (label, time) ->
                val on = t.weekday == time
                val corner by animateDpAsState(if (on) 32.dp else 18.dp, MaterialTheme.motionScheme.defaultSpatialSpec(), label = "pick")
                Column(
                    Modifier.weight(1f).press(scale = 0.96f, label = label, onClick = { view.feel(Haptic.Click); settings.saveTimes(JSONObject().put("weekday", time), null) })
                        .clip(RoundedCornerShape(corner)).background(if (on) cs.primary else cs.surfaceContainer).padding(18.dp),
                ) {
                    Text(label, style = MaterialTheme.typography.titleMedium, color = if (on) cs.onPrimary else cs.onSurface)
                    Text(time, style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FlexRound, fontWeight = FontWeight.Bold), color = if (on) cs.onPrimary else cs.onSurfaceVariant)
                }
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PickField(stringResource(R.string.common_weekdays), t.weekday, { editing = "weekday" }, Modifier.weight(1f))
        PickField(stringResource(R.string.common_weekends), t.weekend, { editing = "weekend" }, Modifier.weight(1f))
    }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(cs.surfaceContainer).padding(16.dp)) {
        SwitchRow(stringResource(R.string.common_remind_me), stringResource(R.string.intro_a_notification_minutes_before_each_session, t.before), t.remind) { on ->
            scope.launch {
                // Android asks for notifications right here, on the tap.
                if (on && !settings.allowReminders()) { settings.said = str(R.string.intro_notifications_are_off_for_tartan_allow); return@launch }
                settings.saveTimes(JSONObject().put("remind", JSONObject().put("on", on).put("before_min", t.before).put("after", t.after)), null)
            }
        }
    }
    Fine(stringResource(R.string.intro_a_day_of_its_own_your))
    settings.profile?.takeIf { it.sex == null }?.let { p ->
        var picked by remember { mutableStateOf<String?>(null) }
        Text(stringResource(R.string.intro_you_are), style = MaterialTheme.typography.titleLarge.copy(fontFamily = FlexRound, fontWeight = FontWeight.Bold), modifier = Modifier.padding(top = 8.dp))
        Fine(stringResource(R.string.intro_for_your_effort_scores_and_who))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("M" to stringResource(R.string.intro_a_man), "F" to stringResource(R.string.intro_a_woman), "" to stringResource(R.string.intro_not_saying)).forEach { (v, label) ->
                FilterChip(picked == v, { picked = v; settings.saveProfile(null, p.restHr, v.ifEmpty { null }) }, label = { Text(label) }, leadingIcon = if (picked == v) { { Icon(Glyphs["check"], null, Modifier.size(16.dp)) } } else null)
            }
        }
    }
    editing?.let { which ->
        val now = if (which == "weekday") t.weekday else t.weekend
        val (h, mm) = now.split(":").let { (it.getOrNull(0)?.toIntOrNull() ?: 7) to (it.getOrNull(1)?.toIntOrNull() ?: 0) }
        val st = rememberTimePickerState(h, mm, is24Hour = true)
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(if (which == "weekday") stringResource(R.string.common_weekday_sessions) else stringResource(R.string.common_weekend_sessions)) },
            text = { TimePicker(st) },
            confirmButton = { TextButton(onClick = { settings.saveTimes(JSONObject().put(which, "%02d:%02d".format(st.hour, st.minute)), null); editing = null }) { Text("OK") } },
            dismissButton = { TextButton(onClick = { editing = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}

/** Where things live: the four tabs, each its job. */
@Composable
private fun Places() {
    val cs = MaterialTheme.colorScheme
    Title(stringResource(R.string.intro_four_places_one_job_each), stringResource(R.string.intro_slide_along_the_bar_at_the))
    listOf(
        Triple("today", stringResource(R.string.common_today), stringResource(R.string.intro_how_you_are_what_s_on)),
        Triple("coach", stringResource(R.string.common_coach), stringResource(R.string.intro_your_plan_and_a_coach_to)),
        Triple("list", stringResource(R.string.common_activities), stringResource(R.string.intro_every_workout_once_and_routes_to)),
        Triple("trends", stringResource(R.string.common_progress), stringResource(R.string.intro_how_your_training_adds_up_week)),
    ).forEachIndexed { i, (icon, name, line) ->
        Row(Modifier.fillMaxWidth().reveal(i + 1).clip(RoundedCornerShape(24.dp)).background(cs.surfaceContainer).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(48.dp).clip(CircleShape).background(cs.secondaryContainer), contentAlignment = Alignment.Center) { Icon(Glyphs[icon], null, Modifier.size(24.dp), tint = cs.onSecondaryContainer) }
            Column(Modifier.padding(start = 14.dp)) {
                Text(name, style = MaterialTheme.typography.titleMedium)
                Text(line, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
        }
    }
    Fine(stringResource(R.string.intro_settings_sit_behind_the_sliders_at))
}

/** Where workouts come from: Strava and the watch, each a big choice that opens its guided setup, ticked once connected. */
@Composable
private fun IntroSources(s: SourcesModel) {
    LaunchedEffect(Unit) { s.ensure() }
    var strava by remember { mutableStateOf(false) }
    var watch by remember { mutableStateOf(false) }
    var icu by remember { mutableStateOf(false) }
    Source("heart", stringResource(R.string.common_health_connect), stringResource(R.string.intro_samsung_health_suunto_fitbit_coros_polar), s.hc?.on == true, stringResource(R.string.intro_connected_workouts_come_in_with_each), 0) { s.hcDo("connect") }
    Source("strava", "Strava", stringResource(R.string.intro_your_whole_history_every_stream), s.strava?.connected == true, s.strava?.name?.takeIf { it.isNotEmpty() }?.let { stringResource(R.string.intro_connected_as, it) } ?: stringResource(R.string.intro_connected), 1) { strava = true }
    Source("watch", stringResource(R.string.common_your_watch), stringResource(R.string.intro_straight_off_your_wrist_over_bluetooth), s.watch?.connected == true, s.watch?.name?.ifEmpty { null }?.let { stringResource(R.string.common_connected_to, it) } ?: stringResource(R.string.intro_connected), 2) { watch = true }
    Source("trends", "intervals.icu", stringResource(R.string.intro_garmin_coros_polar_wahoo_zwift_a), s.icu?.connected == true, s.icu?.name?.let { stringResource(R.string.intro_connected_as, it) } ?: stringResource(R.string.intro_connected), 3) { icu = true }
    if (strava) StravaFlow(s) { strava = false }
    if (icu) IcuFlow(s) { icu = false }
    if (watch) WatchFlow(s) { watch = false }
}

@Composable
private fun Source(icon: String, title: String, line: String, done: Boolean, doneLine: String, i: Int, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val view = LocalView.current
    val tone by androidx.compose.animation.animateColorAsState(if (done) data.goodContainer else cs.surfaceContainer, label = "source")
    Row(
        Modifier.fillMaxWidth().reveal(i + 1).clip(RoundedCornerShape(28.dp)).background(tone).press(scale = 0.97f, label = title) { view.feel(Haptic.Click); onClick() }.padding(20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(56.dp).clip(RoundedCornerShape(18.dp)).background(if (done) data.good else cs.primaryContainer), contentAlignment = Alignment.Center) {
            Icon(Glyphs[if (done) "check" else icon], null, Modifier.size(28.dp), tint = if (done) cs.surface else cs.onPrimaryContainer)
        }
        Column(Modifier.weight(1f).padding(horizontal = 16.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            Text(if (done) doneLine else line, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        }
        Text(if (done) stringResource(R.string.common_change) else stringResource(R.string.common_connect), style = MaterialTheme.typography.labelLarge, color = cs.primary)
    }
}

/** intervals.icu from the intro: its key (and athlete ID) in a sheet, the same as in Settings → Sources. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun IcuFlow(s: SourcesModel, close: () -> Unit) {
    val uri = androidx.compose.ui.platform.LocalUriHandler.current
    LaunchedEffect(s.icu?.connected) { if (s.icu?.connected == true) close() }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = close) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("intervals.icu", style = MaterialTheme.typography.headlineSmall)
            IcuSetup(s) { uri.openUri("https://intervals.icu/settings") }
            s.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}
