package dev.freesuunto.app.shell

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Tartan's T in Today's header, taking on the day (src/today-mark.ts): a rest day breathes, slow
 * and calm; a session planned holds steady; a new best gets one small shimmer and spark as Today
 * opens; a go-easy morning dims it; race week draws a fine outline round it once. The coach's
 * Blush tile (DESIGN.md), the size of the header's buttons. Reduced motion: still, every state.
 * Tapping it opens the coach.
 */
@Composable
fun TodayMark(mark: Mark, modifier: Modifier = Modifier, size: Dp = 44.dp, onClick: (() -> Unit)? = null) {
    val cs = MaterialTheme.colorScheme
    val reduced = LocalReducedMotion.current
    val t = remember { MARK.map { PathParser().parsePathString(it).toPath() }.reduce { a, b -> Path().apply { addPath(a); addPath(b) } } }
    val state = mark.state
    // Rest: a slow breath (about 9 s in and out).
    val breathing = if (!reduced && state == "rest") {
        rememberInfiniteTransition(label = "breath").animateFloat(0f, 1f, infiniteRepeatable(tween(4500, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "breath")
    } else null
    // A new best: a band of light across the T and a spark, once. Race week: the outline drawn in, once.
    val shine = remember(state) { Animatable(if (!reduced && state == "best") 0f else 1f) }
    val ring = remember(state) { Animatable(if (!reduced && state == "race") 0f else 1f) }
    LaunchedEffect(state, reduced) {
        if (reduced) return@LaunchedEffect
        if (state == "best") { delay(400); shine.animateTo(1f, tween(1400, easing = FastOutSlowInEasing)) }
        if (state == "race") { delay(300); launch { ring.animateTo(1f, tween(1000, easing = LinearOut)) } }
    }
    val tired = state == "tired"
    val tile = cs.primaryContainer.copy(alpha = if (tired) 0.55f else 1f)
    val onTile = cs.onPrimaryContainer
    val base = Modifier.size(size).semantics { contentDescription = mark.label; if (onClick != null) role = Role.Button }
    Canvas(if (onClick != null) modifier.then(base).press(onClick = onClick) else modifier.then(base)) {
        // Read here, so a breath only redraws.
        val breath = breathing?.value ?: 0f
        val ink = onTile.copy(alpha = (if (tired) 0.5f else 1f) * (1f - 0.18f * breath))
        val pad = 3.dp.toPx()
        val inner = this.size.width - pad * 2
        drawRoundRect(tile, Offset(pad, pad), Size(inner, inner), CornerRadius(12.dp.toPx()))
        // Race week: a fine outline round the tile, drawn in from the top once.
        if (state == "race") {
            val w = 1.5.dp.toPx()
            val outline = Path().apply { addRoundRect(androidx.compose.ui.geometry.RoundRect(w / 2, w / 2, this@Canvas.size.width - w / 2, this@Canvas.size.height - w / 2, CornerRadius(14.dp.toPx()))) }
            val seg = if (ring.value >= 1f) outline else Path().also { PathMeasure().apply { setPath(outline, false) }.let { m -> m.getSegment(0f, m.length * ring.value, it, true) } }
            drawPath(seg, cs.primary, style = Stroke(w, cap = StrokeCap.Round))
        }
        // The T, 60% of the tile, a touch smaller as it breathes out.
        val k = inner * 0.6f / MW * (1f - 0.05f * breath)
        val cx = this.size.width / 2
        val cy = this.size.height / 2
        translate(cx, cy) {
            scale(k, k, pivot = Offset.Zero) {
                translate(-(MX + MW / 2), -(MY + MH / 2)) {
                    drawPath(t, ink)
                    // The shimmer: a soft band of light moving across the T, left to right.
                    if (state == "best" && shine.value in 0.001f..0.999f) clipPath(t) {
                        val x = MX - MW * 0.4f + (MW * 1.8f) * shine.value
                        drawRect(
                            Brush.linearGradient(listOf(Color.Transparent, Color.White.copy(alpha = 0.9f), Color.Transparent), Offset(x - MW * 0.22f, MY), Offset(x + MW * 0.22f, MY + MH * 0.35f)),
                            Offset(MX, MY), Size(MW, MH),
                        )
                    }
                }
            }
        }
        // The spark: a small four-point star at the top right that grows and goes as the light passes.
        if (state == "best" && shine.value in 0.3f..0.999f) {
            val p = (shine.value - 0.3f) / 0.7f
            val r = this.size.width * 0.12f * kotlin.math.sin(p * Math.PI).toFloat()
            val sx = this.size.width - pad - this.size.width * 0.14f
            val sy = pad + this.size.width * 0.14f
            val star = Path().apply {
                moveTo(sx, sy - r); quadraticTo(sx, sy, sx + r, sy); quadraticTo(sx, sy, sx, sy + r); quadraticTo(sx, sy, sx - r, sy); quadraticTo(sx, sy, sx, sy - r); close()
            }
            drawPath(star, cs.primary)
        }
    }
}

private val LinearOut = CubicBezierEasing(0.2f, 0f, 0f, 1f)
