package dev.freesuunto.app.shell

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlin.math.abs

/**
 * A connected button group (DESIGN.md): each choice its own tonal segment, 8dp where they meet and
 * 20dp at the ends; the chosen one in primary, fully round. Tap one, or press and slide across:
 * the choice under the finger lights with a low click per segment and letting go picks it, as on
 * the bar and the web's rows.
 *
 * Wider than the space it has (Settings' groups, the race distances), it scrolls sideways, faded at
 * the edge that has more, and keeps the chosen one in view: then a sideways drag scrolls, and the
 * slide starts after a short hold instead.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun Segmented(options: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    val motion = MaterialTheme.motionScheme
    val view = LocalView.current
    val slop = LocalViewConfiguration.current.touchSlop
    val pick by rememberUpdatedState(onSelect)
    val chosen by rememberUpdatedState(selected)
    var hover by remember { mutableIntStateOf(-1) }
    val items = remember(options.size) { arrayOfNulls<LayoutCoordinates>(options.size) }
    val row = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val scroll = rememberScrollState()
    val hold = LocalViewConfiguration.current.longPressTimeoutMillis
    val edge = with(androidx.compose.ui.platform.LocalDensity.current) { 28.dp.toPx() }

    // The chosen one, whole and with a little of its neighbour, when the row scrolls.
    LaunchedEffect(selected, scroll.maxValue) {
        if (scroll.maxValue == 0) return@LaunchedEffect
        val c = items.getOrNull(selected)?.takeIf { it.isAttached } ?: return@LaunchedEffect
        val x = c.positionInParent().x
        val w = c.size.width
        val view0 = scroll.value
        val port = scroll.viewportSize
        val to = when {
            x - edge < view0 -> (x - edge).toInt()
            x + w + edge > view0 + port -> (x + w + edge - port).toInt()
            else -> return@LaunchedEffect
        }
        scroll.animateScrollTo(to.coerceIn(0, scroll.maxValue), motion.defaultSpatialSpec())
    }

    fun at(local: androidx.compose.ui.geometry.Offset): Int {
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

    Box(
        modifier
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .drawWithContent {
                drawContent()
                val left = scroll.value > 0
                val right = scroll.value < scroll.maxValue
                if (left) drawRect(Brush.horizontalGradient(0f to Color.Transparent, 1f to Color.Black, startX = 0f, endX = edge), size = size.copy(width = edge), blendMode = BlendMode.DstIn)
                if (right) drawRect(Brush.horizontalGradient(0f to Color.Black, 1f to Color.Transparent, startX = size.width - edge, endX = size.width), topLeft = androidx.compose.ui.geometry.Offset(size.width - edge, 0f), size = size.copy(width = edge), blendMode = BlendMode.DstIn)
            }
            .horizontalScroll(scroll),
    ) {
    Row(
        Modifier
            .onGloballyPositioned { row[0] = it }
            .pointerInput(options.size) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    val first = at(down.position)
                    val scrolls = scroll.maxValue > 0
                    var sliding = false
                    var gone = false
                    while (true) {
                        val e = awaitPointerEvent()
                        val c = e.changes.firstOrNull { it.id == down.id } ?: break
                        if (!c.pressed) break
                        val moved = abs(c.position.x - down.position.x) > slop
                        if (!sliding && moved) {
                            // A row that scrolls: a drag right away is the scroll's; after a hold it slides.
                            if (scrolls && c.uptimeMillis - down.uptimeMillis < hold) { gone = true; break }
                            sliding = true
                        }
                        if (sliding) {
                            val next = at(c.position)
                            if (next != hover) { hover = next; view.feel(Haptic.Detent) }
                            c.consume()
                        }
                    }
                    if (gone) { hover = -1; return@awaitEachGesture }
                    val landed = if (sliding) hover else first
                    hover = -1
                    if (landed >= 0 && landed != chosen) {
                        view.feel(Haptic.Click)
                        pick(landed)
                    }
                }
            },
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        options.forEachIndexed { i, label ->
            val on = if (hover >= 0) i == hover else i == selected
            val first = i == 0
            val last = i == options.lastIndex
            val outer by animateDpAsState(if (on) 20.dp else 20.dp, motion.defaultSpatialSpec(), label = "outer")
            val inner by animateDpAsState(if (on) 20.dp else 8.dp, motion.defaultSpatialSpec(), label = "inner")
            val fill by animateColorAsState(if (on) cs.primary else cs.surfaceContainerHigh, motion.defaultEffectsSpec(), label = "fill")
            val ink by animateColorAsState(if (on) cs.onPrimary else cs.onSurfaceVariant, motion.defaultEffectsSpec(), label = "ink")
            val squash by animateFloatAsState(if (hover == i) 0.97f else 1f, motion.fastSpatialSpec(), label = "squash")
            val shape = RoundedCornerShape(
                topStart = if (first) outer else inner, bottomStart = if (first) outer else inner,
                topEnd = if (last) outer else inner, bottomEnd = if (last) outer else inner,
            )
            Box(
                Modifier
                    .height(40.dp)
                    .onGloballyPositioned { items[i] = it }
                    .graphicsLayer { scaleX = squash; scaleY = squash }
                    .clip(shape)
                    .background(fill)
                    .semantics {
                        role = Role.RadioButton
                        this.selected = i == selected
                        onClick(label = label) { pick(i); true }
                    }
                    // Five or more (Settings' groups): a little tighter, so they fit a phone's width whole.
                    .padding(horizontal = if (options.size >= 5) 12.dp else 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, color = ink, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
    }
}
