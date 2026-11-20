package dev.freesuunto.app.shell

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The Tartan T (the launcher icon's): a crossbar, and two track lanes that bend down into the stem. */
private val MARK = listOf(
    "M167,150H720A70,70 0 0 1 790,220V298A70,70 0 0 1 720,368H615A197.7,197.7 0 0 0 425,225H92A75,75 0 0 1 167,150Z",
    "M92,247H425A167,167 0 0 1 592,414V665A77,80 0 0 1 515,745V428A145,145 0 0 0 370,283H92Z",
    "M92,303H370A119,119 0 0 1 489,422V745H373V425A53,55 0 0 0 320,370H165A73,67 0 0 1 92,303Z",
)
/** The mark's box in its own units (the SVG's viewBox). */
private const val MX = 92f
private const val MY = 150f
private const val MW = 698f
private const val MH = 595f

private val TARTAN = Color(0xFFA8321F)
private val CREAM = Color(0xFFFDF3EE)
private val EMPHASIZED = CubicBezierEasing(0.2f, 0f, 0f, 1f)

/**
 * The first time Tartan opens: on the track's red, lanes stream past like the straight at speed,
 * then the three pieces of the T draw themselves in (a crossbar, two lanes bending into the stem),
 * fill, settle with a little spring as the lanes stop, a finish line sweeps across and the name
 * lands under the mark. Then the whole thing opens out into the intro. About 2.6 s; with reduced
 * motion, the mark and the name, still, for a moment.
 */
@Composable
fun BrandIntro(onDone: () -> Unit) {
    val reduced = LocalReducedMotion.current
    val pieces = remember { MARK.map { PathParser().parsePathString(it).toPath() } }
    val lengths = remember { pieces.map { PathMeasure().apply { setPath(it, false) }.length } }
    val speed = remember { Animatable(if (reduced) 0f else 1f) }
    val trace = remember { List(3) { Animatable(if (reduced) 1f else 0f) } }
    val fill = remember { Animatable(if (reduced) 1f else 0f) }
    val settle = remember { Animatable(if (reduced) 1f else 0.9f) }
    val finish = remember { Animatable(if (reduced) 1f else 0f) }
    val name = remember { Animatable(if (reduced) 1f else 0f) }
    val lanes = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        if (reduced) { delay(900); onDone(); return@LaunchedEffect }
        coroutineScope {
            // The lanes stream by until the mark has landed, slowing as it does.
            val streaming = launch { lanes.animateTo(40f, tween(40_000, easing = LinearEasing)) }
            delay(250)
            trace.forEachIndexed { i, a -> launch { delay(i * 170L); a.animateTo(1f, tween(820, easing = EMPHASIZED)) } }
            delay(820)
            val f = async { fill.animateTo(1f, tween(360)) }
            launch { speed.animateTo(0f, tween(900, easing = EMPHASIZED)) }
            settle.animateTo(1f, spring(Spring.DampingRatioMediumBouncy, Spring.StiffnessLow))
            f.await()
            launch { finish.animateTo(1f, tween(520, easing = EMPHASIZED)) }
            delay(160)
            name.animateTo(1f, spring(Spring.DampingRatioLowBouncy, Spring.StiffnessMediumLow))
            delay(650)
            streaming.cancel()
        }
        // The intro takes over from here (it opens out over this: IntroScreen's crossfade).
        onDone()
    }
    Box(
        Modifier.fillMaxSize().background(TARTAN).semantics { contentDescription = "Tartan" },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            // The straight at speed: thin lane lines running past, fewer and stiller as the mark lands.
            val lane = 26.dp.toPx()
            val n = (size.height / lane).toInt() + 2
            for (k in 0 until n) {
                val y = k * lane + (size.height % lane) / 2
                val dash = 120.dp.toPx() + (k % 3) * 40.dp.toPx()
                val gap = 90.dp.toPx() + (k % 4) * 30.dp.toPx()
                val shift = (lanes.value * size.width * (0.6f + (k % 5) * 0.15f)) % (dash + gap)
                drawLine(
                    CREAM.copy(alpha = 0.10f * speed.value + 0.03f), Offset(-dash, y), Offset(size.width + dash, y), 1.dp.toPx(),
                    pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(dash, gap), -shift),
                )
            }
            // The mark, 44% of the width, a little above the middle.
            val w = size.width * 0.44f
            val k = w / MW
            val h = MH * k
            val left = (size.width - w) / 2
            val top = size.height / 2 - h * 0.72f
            // Scaled about its own middle as it settles.
            val z = k * settle.value
            translate(left + w / 2, top + h / 2) {
                scale(z, z, pivot = Offset.Zero) {
                    translate(-(MX + MW / 2), -(MY + MH / 2)) {
                        pieces.forEachIndexed { i, p ->
                            val t = trace[i].value
                            if (t > 0f && fill.value < 1f) {
                                // Each piece traced as an outline, like a lane being painted.
                                val seg = Path()
                                PathMeasure().apply { setPath(p, false) }.getSegment(0f, lengths[i] * t, seg, true)
                                drawPath(seg, CREAM.copy(alpha = 1f - fill.value), style = Stroke(3.dp.toPx() / z, cap = StrokeCap.Round, join = StrokeJoin.Round))
                            }
                            if (fill.value > 0f) drawPath(p, CREAM.copy(alpha = fill.value))
                        }
                    }
                }
            }
            // The finish line: a bright stroke across, under the mark, that fades as it passes.
            if (finish.value in 0.001f..0.999f) {
                val x = size.width * finish.value
                drawLine(Color(0xFFFF6A4D).copy(alpha = 1f - finish.value), Offset(x, 0f), Offset(x, size.height), 4.dp.toPx(), StrokeCap.Round)
            }
        }
        Text(
            "Tartan",
            style = TextStyle(fontFamily = FlexRound, fontWeight = FontWeight.Bold, fontSize = 44.sp, letterSpacing = (0.12f * (1f - name.value)).em, color = CREAM),
            modifier = Modifier.align(Alignment.Center).padding(top = 230.dp).graphicsLayer { alpha = name.value.coerceIn(0f, 1f); translationY = (1f - name.value) * 24.dp.toPx() },
        )
    }
}
