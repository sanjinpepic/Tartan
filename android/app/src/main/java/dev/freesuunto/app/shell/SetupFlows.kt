package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearWavyProgressIndicator
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay

/**
 * The two setups that make Tartan work, each its own full-screen moment: connecting Strava (your
 * own API app, step by step, the sign-in, then your workouts arriving) and connecting the watch
 * (getting it ready, finding it, the first backup). Shared: a progress line, a big title, a
 * picture, one thing to do at a time, the main action under the thumb.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Flow(
    steps: Int, step: Int, forward: Boolean, onClose: () -> Unit, onBack: (() -> Unit)?,
    action: (@Composable () -> Unit)?, window: Boolean = true, content: @Composable androidx.compose.foundation.layout.ColumnScope.(Int) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    // In its own window over everything (tests draw it in place).
    val frame: @Composable (@Composable () -> Unit) -> Unit = if (window) { c -> Dialog(onDismissRequest = { onBack?.invoke() ?: onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) { c() } } else { c -> c() }
    frame {
        Box(Modifier.fillMaxSize().background(cs.surface).safeDrawingPadding()) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    FilledTonalIconButton(onClick = onClose) { Icon(Glyphs["close"], stringResource(R.string.common_close)) }
                    Row(Modifier.weight(1f).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (i in 0 until steps) {
                            val fill by animateFloatAsState(if (i <= step) 1f else 0f, MaterialTheme.motionScheme.defaultSpatialSpec(), label = "step")
                            Box(Modifier.weight(1f).height(6.dp).clip(CircleShape).background(cs.surfaceContainerHighest)) {
                                Box(Modifier.fillMaxHeight().fillMaxWidth(fill.coerceIn(0f, 1f)).clip(CircleShape).background(cs.primary))
                            }
                        }
                    }
                    Spacer(Modifier.width(48.dp))
                }
                AnimatedContent(step, Modifier.weight(1f), transitionSpec = {
                    val d = if (forward) 1 else -1
                    (fadeIn(tween(220, 60)) + slideInHorizontally(spring(Spring.DampingRatioLowBouncy, Spring.StiffnessMediumLow)) { d * it / 4 }) togetherWith (fadeOut(tween(140)) + slideOutHorizontally(tween(220)) { -d * it / 6 })
                }, label = "flow") { s ->
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) { content(s) }
                }
                if (action != null || onBack != null) Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (onBack != null) { FilledTonalIconButton(onClick = onBack, Modifier.size(56.dp)) { Icon(Glyphs["chevron"], stringResource(R.string.common_back), Modifier.size(22.dp).graphicsLayer { scaleX = -1f }) }; Spacer(Modifier.width(12.dp)) }
                    Box(Modifier.weight(1f)) { action?.invoke() }
                }
            }
        }
    }
}

@Composable
private fun Headline(title: String, lede: String) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, style = MaterialTheme.typography.displaySmall.copy(fontFamily = FlexRound, fontWeight = FontWeight.Bold), modifier = Modifier.semantics { heading() })
        Text(lede, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The main action: full width, tall, the label (and a spinner while it works). */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun Primary(label: String, enabled: Boolean = true, busy: Boolean = false, onClick: () -> Unit) {
    val view = LocalView.current
    Button(onClick = onClick, enabled = enabled && !busy, modifier = Modifier.fillMaxWidth().height(56.dp), shapes = ButtonDefaults.shapes()) {
        if (busy) { LoadingIndicator(Modifier.size(24.dp), color = MaterialTheme.colorScheme.primary); Spacer(Modifier.width(10.dp)) }
        Text(label, style = MaterialTheme.typography.titleMedium)
    }
}

/** One thing to check, with its icon in a soft shape. */
@Composable
private fun Point(icon: String, title: String, line: String) {
    val cs = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(cs.primaryContainer), contentAlignment = Alignment.Center) { Icon(Glyphs[icon], null, Modifier.size(22.dp), tint = cs.onPrimaryContainer) }
        Column(Modifier.padding(start = 14.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(line, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        }
    }
}

/** Done: a check that lands with a bounce in a ring that fills. */
@Composable
private fun Success(modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val ring = remember { Animatable(0f) }
    val tick = remember { Animatable(0f) }
    LaunchedEffect(Unit) { ring.animateTo(1f, tween(520)); tick.animateTo(1f, spring(Spring.DampingRatioMediumBouncy, Spring.StiffnessLow)) }
    Box(modifier.size(112.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            drawCircle(data.goodContainer, size.minDimension / 2)
            drawArc(data.good, -90f, 360f * ring.value, false, style = Stroke(6.dp.toPx(), cap = StrokeCap.Round), topLeft = Offset(3.dp.toPx(), 3.dp.toPx()), size = androidx.compose.ui.geometry.Size(size.width - 6.dp.toPx(), size.height - 6.dp.toPx()))
        }
        Icon(Glyphs["check"], null, Modifier.size(52.dp).graphicsLayer { scaleX = tick.value; scaleY = tick.value; alpha = tick.value.coerceIn(0f, 1f) }, tint = data.good)
    }
}

// ------------------------------------------------------------------ Strava

/**
 * Connecting Strava: why your own app, making it (the form's values to copy), its two keys, the
 * sign-in in Strava's tab (we wait here and notice when you're back), then your workouts arriving.
 * With the keys already saved it starts at the sign-in.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun StravaFlow(s: SourcesModel, window: Boolean = true, start: Int? = null, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val st = s.strava
    val clip = LocalClipboardManager.current
    var step by rememberSaveable { mutableStateOf(start ?: if (st?.configured == true && st.clientId != null) 3 else 0) }
    var forward by remember { mutableStateOf(true) }
    var id by rememberSaveable { mutableStateOf(st?.clientId ?: "") }
    var secret by rememberSaveable { mutableStateOf("") }
    fun go(to: Int) { forward = to > step; step = to }
    val idOk = Regex("^\\d{3,10}$").matches(id)
    val secretOk = Regex("^[0-9a-fA-F]{40}$").matches(secret)
    // Waiting for Strava's tab: read again every few seconds; connected moves on by itself.
    LaunchedEffect(step) {
        if (step != 3) return@LaunchedEffect
        repeat(120) { delay(2500); s.forget(); s.ensure(); if (s.strava?.connected == true) { forward = true; step = 4; return@LaunchedEffect } }
    }
    LaunchedEffect(st?.connected) { if (st?.connected == true && step < 4) { forward = true; step = 4 } }
    Flow(
        5, step, forward, onClose, window = window,
        onBack = if (step in 1..3) ({ go(step - 1) }) else null,
        action = {
            when (step) {
                0 -> Primary(str(R.string.setup_let_s_do_it)) { go(1) }
                1 -> Primary(str(R.string.setup_i_ve_made_it)) { go(2) }
                2 -> Primary(str(R.string.setup_connect_to_strava), idOk && (secretOk || (st?.configured == true && secret.isEmpty())), s.busy == "strava") { s.stravaConnect(id, secret.ifEmpty { null }); go(3) }
                3 -> FilledTonalButton(onClick = { s.stravaConnect(if (st?.configured == true) null else id, secret.ifEmpty { null }) }, enabled = s.busy != "strava", modifier = Modifier.fillMaxWidth().height(56.dp), shapes = ButtonDefaults.shapes()) { Text(str(R.string.setup_open_strava_again)) }
                else -> Primary(str(R.string.common_done)) { onClose() }
            }
        },
    ) { now ->
        when (now) {
            0 -> {
                Bridge(Modifier.fillMaxWidth().height(150.dp))
                Headline(str(R.string.setup_bring_in_your_strava_history), str(R.string.setup_every_workout_you_ve_recorded_with))
                Point("folder", str(R.string.setup_yours_on_this_phone), str(R.string.setup_your_workouts_are_stored_here_not))
                Point("sync", str(R.string.setup_then_it_keeps_up_by_itself), str(R.string.setup_new_workouts_arrive_when_you_open))
                Point("spark", str(R.string.setup_already_on_strava_from_your_watch), str(R.string.setup_if_the_suunto_app_sends_your))
            }
            1 -> {
                Headline(str(R.string.setup_make_your_strava_app), str(R.string.setup_strava_s_api_page_opens_in))
                Primary(str(R.string.setup_open_strava_s_api_page)) { s.open("https://www.strava.com/settings/api") }
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(cs.surfaceContainer).padding(vertical = 4.dp)) {
                    listOf("Application name" to "Tartan", "Category" to "Training", "Website" to "http://localhost", "Authorization Callback Domain" to "localhost").forEach { (k, v) -> CopyRow(k, v) { clip.setText(AnnotatedString(v)) } }
                }
                Text(str(R.string.setup_strava_also_asks_for_an_icon), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
            2 -> {
                Headline(str(R.string.setup_paste_its_two_keys), str(R.string.setup_on_the_same_page_strava_now))
                KeyField(str(R.string.setup_client_id), id, idOk, str(R.string.setup_a_number_like_123456), { clip.getText()?.text?.trim()?.filter { it.isDigit() } }) { id = it.filter { c -> c.isDigit() } }
                KeyField(str(R.string.setup_client_secret), secret, secretOk, if (st?.configured == true) str(R.string.setup_saved_already_paste_a_new_one) else str(R.string.setup_40_letters_and_digits), { clip.getText()?.text?.trim() }) { secret = it.filter { c -> !c.isWhitespace() } }
            }
            3 -> {
                Waiting(Modifier.fillMaxWidth().height(160.dp))
                Headline(str(R.string.setup_approve_on_strava), str(R.string.setup_in_strava_s_tab_tap_authorize))
                Text(str(R.string.setup_tartan_asks_to_read_your_activities), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                s.stravaUrl?.let { url ->
                    TextButton(onClick = { clip.setText(AnnotatedString(url)); s.said = str(R.string.setup_sign_in_link_copied_paste_it) }) { Text(str(R.string.setup_tab_didn_t_open_copy_the)) }
                }
            }
            else -> {
                Success(Modifier.align(Alignment.CenterHorizontally).padding(top = 24.dp))
                Headline(str(R.string.setup_strava_is_connected), stringResource(R.string.setup_workouts_on_their_way, st?.name?.takeIf { it.isNotEmpty() }?.let { stringResource(R.string.setup_hello, it) } ?: ""))
                if (s.busy == "strava") LinearWavyProgressIndicator(Modifier.fillMaxWidth())
                st?.takeIf { it.activities > 0 }?.let { Text(str(R.string.setup_workouts_here_so_far, it.activities), style = MaterialTheme.typography.titleMedium) }
            }
        }
    }
}

/** A value from Strava's form, tap to copy; it says so with a tick. */
@Composable
private fun CopyRow(label: String, value: String, copy: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val view = LocalView.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1800); copied = false } }
    val tint by animateColorAsState(if (copied) LocalData.current.good else cs.primary, label = "copied")
    Row(
        Modifier.fillMaxWidth().press(scale = 0.98f, label = stringResource(R.string.setup_copy, label)) { view.feel(Haptic.Click); copy(); copied = true }.padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace)
        }
        Icon(Glyphs[if (copied) "check" else "file"], if (copied) stringResource(R.string.common_copied) else stringResource(R.string.setup_copy_2), Modifier.size(20.dp), tint = tint)
        Text(if (copied) stringResource(R.string.common_copied) else stringResource(R.string.setup_copy_2), style = MaterialTheme.typography.labelLarge, color = tint, modifier = Modifier.padding(start = 6.dp))
    }
}

/** A key to paste: the field, Paste, and a tick once it looks right. */
@Composable
private fun KeyField(label: String, value: String, ok: Boolean, hint: String, fromClipboard: () -> String?, onChange: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            Field(label, value, onChange, Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            FilledTonalButton(onClick = { fromClipboard()?.let(onChange) }, modifier = Modifier.height(48.dp)) { Text(stringResource(R.string.setup_paste)) }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (ok) { Icon(Glyphs["check"], null, Modifier.size(16.dp), tint = LocalData.current.good); Spacer(Modifier.width(6.dp)) }
            Text(if (ok) stringResource(R.string.setup_looks_right) else if (value.isEmpty()) hint else stringResource(R.string.setup_not_quite, hint), style = MaterialTheme.typography.bodySmall, color = if (ok) LocalData.current.good else if (value.isEmpty()) cs.onSurfaceVariant else cs.error)
        }
    }
}

/** Your phone and your own Strava app, a line running between them. */
@Composable
private fun Bridge(modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val t by rememberInfiniteTransition(label = "bridge").animateFloat(0f, 1f, infiniteRepeatable(tween(1600, easing = LinearEasing)), label = "dash")
    Box(modifier.semantics { contentDescription = str(R.string.setup_strava_and_this_phone_connected) }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val y = size.height / 2
            val l = size.width * 0.22f
            val r = size.width * 0.78f
            val dash = 10.dp.toPx()
            drawLine(cs.primary, Offset(l, y), Offset(r, y), 4.dp.toPx(), StrokeCap.Round, PathEffect.dashPathEffect(floatArrayOf(dash, dash), -t * dash * 2))
            drawCircle(cs.primaryContainer, 44.dp.toPx(), Offset(l, y))
            drawCircle(data.effort.copy(alpha = 0.18f).compositeOver(cs.surface), 44.dp.toPx(), Offset(r, y))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceAround) {
            Icon(Glyphs["phone"], null, Modifier.size(36.dp), tint = cs.onPrimaryContainer)
            Icon(Glyphs["strava"], null, Modifier.size(36.dp), tint = data.effort)
        }
    }
}

/** Waiting for the other side: three dots breathing in turn. */
@Composable
private fun Waiting(modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val t by rememberInfiniteTransition(label = "wait").animateFloat(0f, 3f, infiniteRepeatable(tween(1500, easing = LinearEasing)), label = "dots")
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        for (i in 0..2) {
            val k = (1f - kotlin.math.abs(((t - i + 3f) % 3f) - 0.5f) * 1.2f).coerceIn(0.25f, 1f)
            Box(Modifier.size(18.dp).graphicsLayer { scaleX = 0.7f + 0.5f * k; scaleY = 0.7f + 0.5f * k; alpha = k }.clip(CircleShape).background(cs.primary))
        }
    }
}

// ------------------------------------------------------------------ The watch

/**
 * Connecting the watch, one watch whatever its brand: get it ready (close and awake; the words
 * don't name a brand yet), find it (what advertises nearby and what Garmin Connect reports, down to
 * one watch: src/transport/brand.ts), then connected, in its brand's words. A Suunto: what it is,
 * and the first backup with its progress. A Garmin: the plan sent to Tartan's watch app through
 * Garmin Connect, and how to get the app on the watch. Garmin Connect missing is said only for a Garmin.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun WatchFlow(s: SourcesModel, window: Boolean = true, start: Int? = null, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val w = s.watch
    val garminSet = s.finding == "garmin" || (start == null && w?.brand == "garmin" && s.garmin != null)
    var step by rememberSaveable { mutableStateOf(start ?: if (w?.connected == true) 2 else 0) }
    var forward by remember { mutableStateOf(true) }
    var tried by remember { mutableStateOf(false) }
    fun go(to: Int) { forward = to > step; step = to }
    LaunchedEffect(w?.connected) { if (w?.connected == true && step < 2) { forward = true; step = 2 } }
    LaunchedEffect(s.finding) { if (s.finding == "garmin" && step < 2) { forward = true; step = 2 } }
    val looking = s.finding == "looking" || w?.connecting == true || s.busy == "watch"
    val garmin = garminSet || (step == 2 && w?.brand == "garmin" && w.connected != true)
    Flow(
        3, step, forward, onClose, window = window,
        onBack = if (step == 1 && !looking) ({ go(0) }) else null,
        action = {
            when {
                step == 0 -> Primary(str(R.string.setup_find_my_watch), w?.canBluetooth != false) { tried = true; s.find(); go(1) }
                step == 1 && s.finding == "garmin-missing" -> Primary(str(R.string.watchfind_get_garmin_connect)) { s.garminApi?.getGarminConnect() }
                step == 1 -> if (!looking) Primary(str(R.string.setup_look_again)) { s.find() } else Primary(str(R.string.setup_looking), busy = true) {}
                garmin -> Primary(str(R.string.common_done)) { onClose() }
                w?.running == true -> FilledTonalButton(onClick = { s.watchCancel() }, modifier = Modifier.fillMaxWidth().height(56.dp)) { Text(str(R.string.setup_stop_the_backup)) }
                w?.job == null && !tried -> Primary(str(R.string.setup_back_up_my_watch)) { tried = true; s.watchBackup() }
                else -> Primary(str(R.string.common_done)) { onClose() }
            }
        },
    ) { now ->
        when {
            now == 0 -> {
                WatchPicture(Modifier.fillMaxWidth().height(190.dp), false)
                Headline(str(R.string.common_connect_your_watch), str(R.string.watchfind_tartan_finds_it))
                Point("watch", str(R.string.setup_close_and_awake), str(R.string.setup_keep_the_watch_next_to_the))
                Point("phone", str(R.string.setup_paired_with_this_phone_already), str(R.string.watchfind_paired_either_way))
                if (w?.canBluetooth == false) Text(str(R.string.setup_bluetooth_is_off_or_not_allowed), color = cs.error, style = MaterialTheme.typography.bodyMedium)
            }
            now == 1 -> {
                WatchPicture(Modifier.fillMaxWidth().height(220.dp), looking)
                when (s.finding) {
                    "garmin-missing" -> { BrandChip("garmin", s.found?.name); Headline(str(R.string.watchfind_its_a_garmin), str(R.string.watchfind_install_garmin_connect)); TextButton(onClick = { s.find() }) { Text(str(R.string.setup_look_again)) } }
                    "garmin-pair" -> { BrandChip("garmin", s.found?.name); Headline(str(R.string.watchfind_its_a_garmin), str(R.string.watchfind_pair_in_garmin_connect)) }
                    "suunto" -> { BrandChip("suunto", s.found?.name); if (looking) Headline(str(R.string.setup_looking_for_your_watch), str(R.string.watchfind_connecting_suunto)) else Headline(str(R.string.setup_no_watch_yet), str(R.string.setup_it_didn_t_answer_check_it)) }
                    else -> if (looking) Headline(str(R.string.setup_looking_for_your_watch), str(R.string.watchfind_it_takes_a_few_seconds))
                    else {
                        Headline(str(R.string.setup_no_watch_yet), str(R.string.watchfind_it_didnt_answer))
                        // Android's own list, for a Suunto that isn't advertising its brand.
                        TextButton(onClick = { s.finding = "suunto"; s.watchConnect() }) { Text(str(R.string.watchfind_pick_it_from_a_list)) }
                    }
                }
            }
            garmin -> GarminConnected(s)
            else -> {
                if (w?.job == null && w?.running != true) Success(Modifier.align(Alignment.CenterHorizontally).padding(top = 16.dp))
                else WatchPicture(Modifier.fillMaxWidth().height(170.dp), true)
                BrandChip("suunto", null)
                Headline(stringResource(R.string.setup_connected_to, w?.name?.ifEmpty { null } ?: stringResource(R.string.setup_your_watch)), if (w?.job == null) str(R.string.setup_back_it_up_now_to_bring) else str(R.string.setup_bringing_in_what_s_on_it))
                w?.facts?.filter { it.first in listOf("Battery", str(R.string.common_firmware)) }?.takeIf { it.isNotEmpty() }?.let { f ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        f.forEach { (k, v) ->
                            Column(Modifier.weight(1f).clip(RoundedCornerShape(20.dp)).background(cs.surfaceContainer).padding(14.dp)) {
                                Text(k, style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
                                Text(v, style = Figure.S)
                            }
                        }
                    }
                }
                w?.job?.let { j ->
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(cs.surfaceContainer).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(j.title, style = MaterialTheme.typography.titleMedium)
                        if (j.value != null) LinearWavyProgressIndicator(progress = { (j.value / (j.max ?: 1.0)).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                        else LinearWavyProgressIndicator(Modifier.fillMaxWidth())
                        Text(j.text, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/** The watch's brand, small, over the title: what Tartan found. */
@Composable
fun BrandChip(brand: String, name: String?) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.clip(CircleShape).background(cs.secondaryContainer).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Glyphs["watch"], null, Modifier.size(16.dp), tint = cs.onSecondaryContainer)
        Text(listOfNotNull(if (brand == "garmin") "Garmin" else "Suunto", name?.takeIf { it.isNotBlank() }).joinToString(" · "), style = MaterialTheme.typography.labelLarge, color = cs.onSecondaryContainer, modifier = Modifier.padding(start = 6.dp))
    }
}

/** A Garmin, connected: the plan sent through Garmin Connect, and Tartan's watch app. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun androidx.compose.foundation.layout.ColumnScope.GarminConnected(s: SourcesModel) {
    val g = s.garmin
    Success(Modifier.align(Alignment.CenterHorizontally).padding(top = 16.dp))
    BrandChip("garmin", null)
    Headline(stringResource(R.string.setup_connected_to, g?.name?.ifEmpty { null } ?: stringResource(R.string.setup_your_watch)), str(R.string.watchfind_garmin_how))
    GarminStatus(s)
}

/** The Garmin's state in two panels (the plan sent, the watch app) and what to do about each; Settings shows it too. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun GarminStatus(s: SourcesModel) {
    val cs = MaterialTheme.colorScheme
    val g = s.garmin
    val sent = when {
        g == null || s.busy == "garmin" -> str(R.string.watchfind_sending)
        g.gcm == "missing" -> str(R.string.watchfind_gcm_missing_short)
        g.app == false -> str(R.string.watchfind_not_sent_no_app)
        g.sentTitle != null -> str(R.string.watchfind_sent, g.sentTitle, g.sentDate?.let { dateShort(it) } ?: "")
        g.error != null -> str(R.string.watchfind_not_sent_yet_away)
        else -> str(R.string.watchfind_nothing_to_send)
    }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(cs.surfaceContainer).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(str(R.string.watchfind_the_plan_on_the_watch), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
        Text(sent, style = MaterialTheme.typography.titleMedium)
        if (s.busy == "garmin") LinearWavyProgressIndicator(Modifier.fillMaxWidth())
    }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(cs.surfaceContainer).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(str(R.string.watchfind_tartan_on_the_watch), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
        Text(if (g?.app == true) str(R.string.watchfind_app_installed) else str(R.string.watchfind_app_get_it), style = MaterialTheme.typography.bodyMedium)
        if (g?.app != true) FilledTonalButton(onClick = { s.garminApi?.getWatchApp() }) { Icon(Glyphs["down"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(str(R.string.watchfind_get_the_watch_app)) }
    }
    Text(str(R.string.watchfind_runs_come_back), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
}

/** A round watch with Tartan's track on its face; looking, rings go out from it. */
@Composable
private fun WatchPicture(modifier: Modifier, looking: Boolean) {
    val cs = MaterialTheme.colorScheme
    val t by rememberInfiniteTransition(label = "radar").animateFloat(0f, 1f, infiniteRepeatable(tween(2200, easing = LinearEasing), RepeatMode.Restart), label = "ring")
    Canvas(modifier.semantics { contentDescription = if (looking) str(R.string.setup_looking_for_your_watch) else str(R.string.common_your_watch) }) {
        val c = Offset(size.width / 2, size.height / 2)
        val face = minOf(size.width, size.height) * 0.30f
        if (looking) for (k in 0..2) {
            val p = (t + k / 3f) % 1f
            // Out to the edge of the picture, not past it.
            val reach = minOf(size.width, size.height) / 2 - 3.dp.toPx() - face
            drawCircle(cs.primary.copy(alpha = (1f - p) * 0.35f), face + p * reach, c, style = Stroke(3.dp.toPx()))
        }
        // The strap, the case, the face.
        val strap = face * 0.62f
        drawRoundRect(cs.outlineVariant, Offset(c.x - strap / 2, c.y - face * 1.55f), androidx.compose.ui.geometry.Size(strap, face * 3.1f), androidx.compose.ui.geometry.CornerRadius(strap / 3))
        drawCircle(cs.inverseSurface, face + 8.dp.toPx(), c)
        drawCircle(Color(0xFF0D0B0B), face, c)
        // The track: lanes round the dial, the finish line at 12.
        val red = Color(0xFFE0452B)
        drawCircle(red.copy(alpha = 0.55f), face * 0.86f, c, style = Stroke(2.dp.toPx()))
        drawCircle(red.copy(alpha = 0.35f), face * 0.74f, c, style = Stroke(2.dp.toPx()))
        drawLine(Color(0xFFFF6A4D), Offset(c.x, c.y - face * 0.92f), Offset(c.x, c.y - face * 0.68f), 3.dp.toPx(), StrokeCap.Round)
        // Hands at 10:09.
        fun hand(deg: Float, len: Float, w: Float) {
            val a = Math.toRadians((deg - 90).toDouble())
            drawLine(red, c, Offset(c.x + (kotlin.math.cos(a) * len).toFloat(), c.y + (kotlin.math.sin(a) * len).toFloat()), w, StrokeCap.Round)
        }
        hand(304.5f, face * 0.42f, 5.dp.toPx())
        hand(54f, face * 0.62f, 3.5.dp.toPx())
        drawCircle(red, 5.dp.toPx(), c)
    }
}
