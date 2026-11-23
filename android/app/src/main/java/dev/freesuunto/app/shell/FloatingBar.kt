package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.unit.lerp
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

data class Tab(val id: String, val label: String, val icon: String)

val TABS get() = listOf(Tab("today", str(R.string.common_today), "today"), Tab("coach", str(R.string.common_coach), "coach"), Tab("activities", str(R.string.common_activities), "list"), Tab("trends", str(R.string.common_progress), "trends"))

/** The tab a web view belongs to (the web's own nav does the same in app.ts). */
fun tabOf(view: String): String? = when (view) {
    "chat" -> "coach"
    "route", "routes" -> "activities"
    "lift", "you" -> "today"
    "today", "coach", "activities", "trends" -> view
    else -> null
}

/**
 * Whether the bar is folded small: scrolling down a screen folds it (the current tab's name goes,
 * the pill gets shorter and narrower, every tab still a tap away), scrolling back up, reaching
 * another screen or touching the bar unfolds it. Shared by the bar and the screens above it, which
 * sit a little lower while it's small.
 */
class NavFold {
    var folded by mutableStateOf(false)

    /** Scrolls, from any list on a screen: a run of [threshold] px one way folds or unfolds, so a nudge doesn't. */
    fun connection(threshold: Float): NestedScrollConnection = object : NestedScrollConnection {
        var run = 0f
        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            val dy = consumed.y
            // Already at the top and still pulling down: unfold.
            if (dy == 0f) { if (available.y > 0f) { run = 0f; folded = false }; return Offset.Zero }
            if ((dy < 0f) != (run < 0f)) run = 0f
            run += dy
            if (run < -threshold) folded = true else if (run > threshold) folded = false
            return Offset.Zero
        }
    }
}

val LocalNavFold = staticCompositionLocalOf { NavFold() }

/** How much lower a screen's bottom controls sit as the bar folds (it's 12 dp shorter folded), moving with it. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun navDrop(): androidx.compose.ui.unit.Dp {
    val small = LocalNavFold.current.folded
    if (LocalReducedMotion.current) return if (small) 12.dp else 0.dp
    return androidx.compose.animation.core.animateDpAsState(if (small) 12.dp else 0.dp, MaterialTheme.motionScheme.defaultSpatialSpec(), label = "navDrop").value
}

/** How long the lens rests on a tab while sliding before its page comes up (passing over quickly doesn't load each). */
private const val DWELL_MS = 90L

/**
 * The floating navigation pill (DESIGN.md, One design, two materials), drawn by Android.
 *
 * Tap: the tab whose pill is under your finger, as drawn (the current one is wider than the rest).
 * Slide: press anywhere and move sideways. The tabs even out and a lens follows your finger, a low
 * click for each tab it reaches; resting on a tab brings its page up, so the page follows the
 * slide; letting go settles there. While sliding the tabs are equal, so the lens is exactly under
 * the finger and nothing moves beneath it. Dragging up off the bar lets go without changing tab.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun FloatingBar(current: String?, hidden: Boolean, onSelect: (String) -> Unit, modifier: Modifier = Modifier, atRoot: Boolean = true, folded: Boolean = false, onUnfold: () -> Unit = {}) {
    val cs = MaterialTheme.colorScheme
    val motion = MaterialTheme.motionScheme
    val view = LocalView.current
    val density = LocalDensity.current
    val slop = LocalViewConfiguration.current.touchSlop
    val scope = rememberCoroutineScope()
    val select by rememberUpdatedState(onSelect)
    val currentIndex = TABS.indexOfFirst { it.id == current }

    var held by remember { mutableStateOf(false) }
    var sliding by remember { mutableStateOf(false) }
    // While a finger is down: the tab it's on (a tap's) or the lens's (a slide's).
    var hover by remember { mutableIntStateOf(-1) }
    var rowWidth by remember { mutableFloatStateOf(0f) }
    val items = remember { arrayOfNulls<LayoutCoordinates>(TABS.size) }
    val row = remember { arrayOfNulls<LayoutCoordinates>(1) }

    val lit = if (hover >= 0) hover else currentIndex
    val small = folded && !held && !sliding
    // Folding springs like everything else; with reduced motion it just changes.
    val fold = if (LocalReducedMotion.current) (if (small) 1f else 0f) else animateFloatAsState(if (small) 1f else 0f, motion.defaultSpatialSpec(), label = "fold").value
    val unfold by rememberUpdatedState(onUnfold)
    val drop by animateFloatAsState(if (hidden) 1f else 0f, motion.defaultSpatialSpec(), label = "drop")
    val lift by animateFloatAsState(if (held) 1.03f else 1f, motion.fastSpatialSpec(), label = "lift")
    val shape = RoundedCornerShape(32.dp)
    val pad = with(density) { 8.dp.toPx() }
    val gap = with(density) { 4.dp.toPx() }

    // The lens: where it is, in the bar's content, while sliding.
    val lensX = remember { Animatable(0f) }
    val cell = if (rowWidth > 0) (rowWidth - 2 * pad - gap * (TABS.size - 1)) / TABS.size else 0f
    // The gesture below starts once and runs for every touch: it reads these as they are now.
    val cellNow by rememberUpdatedState(cell)
    val currentNow by rememberUpdatedState(current)
    // On a screen opened from a tab (the chat under Coach), its tab takes you back to the tab.
    val atRootNow by rememberUpdatedState(atRoot)
    val currentIndexNow by rememberUpdatedState(currentIndex)
    LaunchedEffect(hover, sliding, cell) {
        if (sliding && hover >= 0) lensX.animateTo(hover * (cell + gap), motion.fastSpatialSpec())
    }

    /** The tab drawn under a point of the bar: by the tabs' real bounds, else the nearest. */
    fun drawnAt(local: Offset): Int {
        val r = row[0] ?: return -1
        val x = r.localToRoot(local).x
        var best = -1
        var d = Float.MAX_VALUE
        items.forEachIndexed { i, c ->
            val b = c?.takeIf { it.isAttached }?.boundsInRoot() ?: return@forEachIndexed
            val dist = if (x < b.left) b.left - x else if (x > b.right) x - b.right else 0f
            if (dist < d) { d = dist; best = i }
        }
        return best
    }

    /** The lens's tab for a point while sliding: equal cells, as the tabs are then. */
    fun cellAt(x: Float): Int = if (cellNow <= 0f) 0 else ((x - pad) / (cellNow + gap)).toInt().coerceIn(0, TABS.lastIndex)

    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.navigationBars)
            .padding(start = 16.dp, end = 16.dp, bottom = 12.dp, top = 12.dp),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Box(
            Modifier
                .width(lerp(minOf(maxWidth, 420.dp), 232.dp, fold))
                .height(lerp(64.dp, 52.dp, fold))
                .graphicsLayer {
                    // Down and out of the way for the keyboard or a sheet; a touch bigger while held.
                    translationY = drop * (size.height + 48.dp.toPx())
                    alpha = 1f - drop
                    scaleX = lift
                    scaleY = lift
                }
                .shadow(8.dp, shape, ambientColor = Color(0x33280C06), spotColor = Color(0x44280C06))
                .clip(shape)
                .background(cs.surfaceContainerHigh)
                .onGloballyPositioned { row[0] = it; rowWidth = it.size.width.toFloat() }
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        held = true
                        unfold()
                        hover = drawnAt(down.position)
                        var cancelled = false
                        var dwell: Job? = null
                        var shownIndex = currentIndexNow
                        while (true) {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) break
                            // Dragged up off the bar: let go without choosing.
                            if (change.position.y < -size.height) { cancelled = true; break }
                            if (!sliding && abs(change.position.x - down.position.x) > slop) {
                                sliding = true
                                scope.launch { lensX.snapTo(cellAt(down.position.x) * (cellNow + gap)) }
                            }
                            if (sliding) {
                                val next = cellAt(change.position.x)
                                if (next != hover) {
                                    hover = next
                                    view.feel(Haptic.Detent)
                                    // The page follows once the lens rests on a tab.
                                    dwell?.cancel()
                                    dwell = scope.launch {
                                        delay(DWELL_MS)
                                        if (next != shownIndex) {
                                            shownIndex = next
                                            select(TABS[next].id)
                                        }
                                    }
                                }
                            }
                            change.consume()
                        }
                        dwell?.cancel()
                        val chosen = hover
                        held = false
                        sliding = false
                        hover = -1
                        if (!cancelled && chosen >= 0) {
                            view.feel(Haptic.Click)
                            if (chosen != shownIndex || TABS[chosen].id != currentNow || !atRootNow) select(TABS[chosen].id)
                        }
                    }
                },
        ) {
            // The lens, under the tabs while sliding.
            val lensAlpha by animateFloatAsState(if (sliding) 1f else 0f, motion.fastEffectsSpec(), label = "lens")
            if (cell > 0f) {
                Box(
                    Modifier
                        .padding(8.dp)
                        .offset { androidx.compose.ui.unit.IntOffset(lensX.value.toInt(), 0) }
                        .width(with(density) { cell.toDp() })
                        .fillMaxHeight()
                        .graphicsLayer { alpha = lensAlpha }
                        .clip(RoundedCornerShape(24.dp))
                        .background(cs.primaryContainer),
                )
            }
            Row(
                Modifier.fillMaxWidth().fillMaxHeight().padding(8.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TABS.forEachIndexed { i, tab ->
                    val on = i == lit
                    // Sliding: all equal, the lens shows where you are. Else the lit tab grows and says its name.
                    val grow by animateFloatAsState(if (on && !sliding && !small) 2.4f else 1f, motion.defaultSpatialSpec(), label = "grow")
                    val fill by animateColorAsState(if (on && !sliding) cs.primaryContainer else Color.Transparent, motion.defaultEffectsSpec(), label = "fill")
                    val ink by animateColorAsState(if (on) cs.onPrimaryContainer else cs.onSurfaceVariant, motion.defaultEffectsSpec(), label = "ink")
                    val squash by animateFloatAsState(if (on && held && !sliding) 0.94f else 1f, motion.fastSpatialSpec(), label = "squash")
                    Row(
                        Modifier
                            .weight(grow)
                            .fillMaxHeight()
                            .onGloballyPositioned { items[i] = it }
                            .graphicsLayer { scaleX = squash; scaleY = squash }
                            .clip(RoundedCornerShape(24.dp))
                            .background(fill)
                            .semantics(mergeDescendants = true) {
                                role = Role.Tab
                                selected = i == currentIndex
                                onClick(label = tab.label) { select(tab.id); true }
                            }
                            .padding(horizontal = 12.dp),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TabIcon(tab, on, ink)
                        AnimatedVisibility(
                            on && !sliding && !small,
                            enter = expandHorizontally(motion.defaultSpatialSpec()) + fadeIn(motion.defaultEffectsSpec()),
                            exit = shrinkHorizontally(motion.defaultSpatialSpec()) + fadeOut(motion.fastEffectsSpec()),
                        ) {
                            Text(tab.label, Modifier.padding(start = 8.dp), color = ink, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Clip)
                        }
                    }
                }
            }
        }
    }
}

/** The icon pops (from 80% with a spring) when its tab lights up. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun TabIcon(tab: Tab, on: Boolean, tint: Color) {
    val k = remember { Animatable(1f) }
    val spec = MaterialTheme.motionScheme.fastSpatialSpec<Float>()
    LaunchedEffect(on) {
        if (on) {
            k.snapTo(0.8f)
            k.animateTo(1f, spec)
        }
    }
    Box(Modifier.size(24.dp).graphicsLayer { scaleX = k.value; scaleY = k.value }, contentAlignment = Alignment.Center) {
        Icon(Glyphs[tab.icon], contentDescription = null, tint = tint)
    }
}
