package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.statusBars
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The sync board as the page last drew it, and how to open it: for every native screen's chip. */
class BoardState(val lanes: List<Lane>, val open: () -> Unit)

val LocalBoard = staticCompositionLocalOf<BoardState?> { null }

/** The chip in its screen's top corner, from [LocalBoard]: folded to its dots everywhere but Today (as on the web). */
@Composable
fun SyncChip(folded: Boolean, modifier: Modifier, pull: Float = 0f, syncing: Boolean = false) {
    val b = LocalBoard.current ?: return
    SyncChip(b.lanes, folded, modifier, b.open, pull, syncing)
}

/**
 * The sync board as a chip (DESIGN.md, the connection pill): a lane per source with a dot, its
 * icon and how long since it last came in (the timing face), amber with a warning sign when its
 * last round failed, the dot breathing while it syncs. In Tartan's tonal colour (primary
 * container). Folded, it is just the dots, a touch bigger (a failed lane keeps its sign); every
 * source fine, they become one green dot. The fold is a motion: times and icons draw in on the
 * spring, the pill closes around the dots. Tap for the board in words, with Sync now.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun SyncChip(lanes: List<Lane>, folded: Boolean, modifier: Modifier, onClick: () -> Unit, pull: Float = 0f, syncing: Boolean = false) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val motion = MaterialTheme.motionScheme
    val text = cs.onPrimaryContainer
    val muted = cs.onPrimaryContainer.copy(alpha = 0.7f)
    val line = cs.onPrimaryContainer.copy(alpha = 0.18f)
    val breathe = rememberInfiniteTransition(label = "breathe")
    val pulse by breathe.animateFloat(0.35f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "pulse")
    val allFine = lanes.size > 1 && lanes.all { it.state == "ok" || it.state == "on" }
    val merged = folded && allFine
    // Pull to sync, said in the chip: it leans into the pull, then says so.
    val lean by androidx.compose.animation.core.animateFloatAsState(1f + 0.06f * pull.coerceIn(0f, 1.2f), motion.fastSpatialSpec(), label = "lean")
    val said = when {
        syncing -> stringResource(R.string.sync_syncing)
        pull >= 1f -> stringResource(R.string.sync_let_go_to_sync)
        pull > 0.08f -> stringResource(R.string.sync_pull_to_sync)
        else -> null
    }
    Row(
        modifier
            .graphicsLayer { scaleX = lean; scaleY = lean; transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0.5f) }
            .height(34.dp)
            .press(onClick = onClick, label = stringResource(R.string.sync_sync_details))
            .clip(CircleShape)
            .background(cs.primaryContainer)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (lanes.isEmpty()) {
            Icon(Glyphs["plus"], null, Modifier.padding(start = 6.dp).size(15.dp), tint = muted)
            AnimatedVisibility(!folded, enter = expandHorizontally(motion.defaultSpatialSpec()) + fadeIn(), exit = shrinkHorizontally(motion.defaultSpatialSpec()) + fadeOut()) {
                Text(stringResource(R.string.common_connect), color = text, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(start = 6.dp, end = 4.dp))
            }
            Spacer(Modifier.width(6.dp))
            return@Row
        }
        lanes.forEachIndexed { i, l ->
            val fail = l.state == "fail"
            // Every source fine and folded: the others give way to the first, which turns green.
            AnimatedVisibility(!(merged && i > 0), enter = expandHorizontally(motion.defaultSpatialSpec()) + fadeIn(), exit = shrinkHorizontally(motion.defaultSpatialSpec()) + fadeOut()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AnimatedVisibility(i > 0 && !folded, enter = fadeIn(), exit = fadeOut()) { Box(Modifier.width(1.dp).height(20.dp).background(line)) }
                    val dotColour by animateColorAsState(
                        // By state only: amber failed, primary while syncing, green fine.
                        when {
                            fail -> data.watch
                            l.state == "busy" -> cs.primary
                            else -> data.good
                        },
                        motion.defaultEffectsSpec(), label = "dot",
                    )
                    val dot by animateDpAsState(if (merged) 10.dp else if (folded) 8.dp else 6.dp, motion.defaultSpatialSpec(), label = "dotSize")
                    Row(Modifier.padding(horizontal = if (folded) 6.dp else 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(dot).graphicsLayer { alpha = if (l.state == "busy") pulse else 1f }.clip(CircleShape).background(dotColour))
                        // Folded too: the source's icon says whose dot it is.
                        AnimatedVisibility(!merged || fail, enter = expandHorizontally(motion.defaultSpatialSpec()) + fadeIn(), exit = shrinkHorizontally(motion.defaultSpatialSpec()) + fadeOut()) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Spacer(Modifier.width(5.dp))
                                Icon(Glyphs[if (fail) "warn" else l.glyph.ifEmpty { l.id }], null, Modifier.size(15.dp), tint = if (fail) data.watch else muted)
                            }
                        }
                        AnimatedVisibility(!folded, enter = expandHorizontally(motion.defaultSpatialSpec()) + fadeIn(), exit = shrinkHorizontally(motion.defaultSpatialSpec()) + fadeOut()) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Spacer(Modifier.width(5.dp))
                                Text(l.text, color = if (fail) data.watch else text, fontFamily = Condensed, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 18.sp)
                            }
                        }
                    }
                }
            }
        }
        AnimatedVisibility(said != null, enter = expandHorizontally(motion.defaultSpatialSpec()) + fadeIn(), exit = shrinkHorizontally(motion.defaultSpatialSpec()) + fadeOut()) {
            Text(said ?: "", color = text, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(start = 2.dp, end = 10.dp))
        }
    }
}

/**
 * What floats at the top of every native screen: the sync board (left) and the gear (right). One
 * of each, above the screens, so moving between tabs they stay where they are while the pages
 * slide beneath, and the board folds or unfolds in place: full on Today until its title scrolls
 * away, folded everywhere else. Settings → the gear.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun TopChrome(folded: Boolean, onSettings: () -> Unit, modifier: Modifier = Modifier, pull: Float = 0f, syncing: Boolean = false, rec: RecNow? = null, onRec: () -> Unit = {}, back: (() -> Unit)? = null) {
    val cs = MaterialTheme.colorScheme
    val top = androidx.compose.foundation.layout.WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    Box(modifier.fillMaxWidth().padding(top = top)) {
        // On a screen opened from a tab (the chat, Body, Record, Strength): back, always in reach,
        // however far down the page is scrolled; the chip moves over for it.
        AnimatedVisibility(back != null, Modifier.align(Alignment.TopStart).padding(top = 8.dp, start = 12.dp), enter = fadeIn(), exit = fadeOut()) {
            FilledTonalIconButton(
                onClick = { back?.invoke() },
                modifier = Modifier.size(44.dp),
                shapes = IconButtonDefaults.shapes(),
                colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = cs.surfaceContainerHigh, contentColor = cs.onSurfaceVariant),
            ) { Icon(Glyphs["chevron"], contentDescription = stringResource(R.string.common_back), modifier = Modifier.size(20.dp).graphicsLayer { rotationZ = 180f }) }
        }
        val chipStart by androidx.compose.animation.core.animateDpAsState(if (back != null) 64.dp else 16.dp, label = "chip")
        SyncChip(folded && pull <= 0.08f && !syncing, Modifier.align(Alignment.TopStart).padding(top = 13.dp, start = chipStart), pull, syncing)
        // A run being recorded: its clock, and the way back to it, from any screen.
        AnimatedVisibility(rec?.status == "recording" || rec?.status == "paused", Modifier.align(Alignment.TopCenter).padding(top = 12.dp), enter = fadeIn() + expandHorizontally(), exit = fadeOut() + shrinkHorizontally()) {
            rec?.let { RecChip(it, onRec) }
        }
        FilledTonalIconButton(
            onClick = onSettings,
            modifier = Modifier.align(Alignment.TopEnd).padding(top = 8.dp, end = 12.dp).size(44.dp),
            shapes = IconButtonDefaults.shapes(),
            colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = cs.surfaceContainerHigh, contentColor = cs.onSurfaceVariant),
        ) { Icon(Glyphs["settings"], contentDescription = stringResource(R.string.common_settings)) }
    }
}

/** The run being recorded (web's .rec-chip): a beating dot and the moving time; tap to go back to it. */
@Composable
private fun RecChip(r: RecNow, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var now by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(System.currentTimeMillis()) }
    androidx.compose.runtime.LaunchedEffect(r.status) { while (r.status == "recording") { now = System.currentTimeMillis(); kotlinx.coroutines.delay(1000) } }
    val beat by rememberInfiniteTransition(label = "rec").animateFloat(1f, 0.35f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "dot")
    val s = r.moving(now)
    val clock = if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
    Row(
        Modifier.height(36.dp).clip(CircleShape).background(cs.errorContainer).press(scale = 0.95f, label = stringResource(R.string.sync_back_to_the_run), onClick = onClick).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.foundation.layout.Box(Modifier.size(10.dp).graphicsLayer { alpha = if (r.status == "recording") beat else 1f }.clip(CircleShape).background(cs.error))
        Spacer(Modifier.width(8.dp))
        Text(if (r.status == "paused") stringResource(R.string.sync_paused, clock) else clock, style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = cs.onErrorContainer)
    }
}
