package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Tartan's charts in Compose (as web/lib/charts.ts draws them): one series in its own hue, quiet
 * axes, numbers in words above. Each grows in when it first shows; press and slide across one to
 * read it point by point, a low click per point.
 */

/** Which index a finger is over, across `n` evenly spaced slots of a width. */
private fun slot(x: Float, width: Float, n: Int) = if (n <= 0) -1 else (x / (width / n)).toInt().coerceIn(0, n - 1)

/** Press and slide to read: the index under the finger while it's down, -1 when it's up. */
@Composable
private fun Modifier.scrub(n: Int, onIndex: (Int) -> Unit): Modifier {
    val view = LocalView.current
    return pointerInput(n) {
        awaitEachGesture {
            val down = awaitFirstDown()
            var at = slot(down.position.x, size.width.toFloat(), n)
            onIndex(at)
            view.feel(Haptic.Detent)
            while (true) {
                val e = awaitPointerEvent()
                val c = e.changes.firstOrNull { it.id == down.id } ?: break
                if (!c.pressed) break
                val next = slot(c.position.x, size.width.toFloat(), n)
                if (next != at) { at = next; onIndex(at); view.feel(Haptic.Detent) }
                // Mostly sideways: ours; mostly up and down: the page scrolls.
                if (kotlin.math.abs(c.position.x - c.previousPosition.x) > kotlin.math.abs(c.position.y - c.previousPosition.y)) c.consume()
            }
            onIndex(-1)
        }
    }
}

/**
 * A chart draws in once, the first time its numbers are seen this run of the app: back on its
 * screen, or scrolled past again, it's simply there. With animations off, at once.
 */
@Composable
private fun grow(key: Any?): Float {
    val still = LocalReducedMotion.current
    val first = remember(key) { Seen.first("chart:${key.hashCode()}") && !still }
    val t = remember(key) { Animatable(if (first) 0f else 1f) }
    LaunchedEffect(key) { if (first) t.animateTo(1f, tween(900, easing = FastOutSlowInEasing)) }
    return t.value
}

/**
 * Columns, one per label (a week, a day): the highlighted one in the series' hue, the others
 * lighter; a dashed reference (a target) when given. Above it, `said(i)` for the column under the
 * finger, else `headline`.
 */
@Composable
fun ColumnChart(
    labels: List<String>,
    values: List<Double>,
    color: Color,
    headline: String,
    said: (Int) -> String,
    modifier: Modifier = Modifier,
    highlight: Int? = null,
    reference: Pair<Double, String>? = null,
    height: Int = 180,
) {
    val cs = MaterialTheme.colorScheme
    val measure = rememberTextMeasurer()
    var at by remember { mutableIntStateOf(-1) }
    val t = grow(values)
    val label = TextStyle(fontSize = 11.sp, color = cs.onSurfaceVariant, fontFamily = Flex)
    Column(modifier) {
        Text(if (at >= 0) said(at) else headline, style = MaterialTheme.typography.labelLarge, color = if (at >= 0) color else cs.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
        Canvas(Modifier.fillMaxWidth().height(height.dp).semantics { contentDescription = headline }.scrub(values.size) { at = it }) {
            val n = values.size
            if (n == 0) return@Canvas
            val bottomPad = 20.dp.toPx()
            val h = size.height - bottomPad
            val top = maxOf(values.maxOrNull() ?: 0.0, reference?.first ?: 0.0).coerceAtLeast(1.0)
            val slotW = size.width / n
            val gap = (slotW * 0.22f).coerceIn(2.dp.toPx(), 10.dp.toPx())
            // Columns at most 24dp wide, rounded only at their data end (DESIGN.md charts).
            val bw = minOf(slotW - gap, 24.dp.toPx())
            val r = minOf(4.dp.toPx(), bw / 2)
            // A quiet floor.
            drawLine(cs.outlineVariant, Offset(0f, h), Offset(size.width, h), 1.dp.toPx())
            values.forEachIndexed { i, v ->
                // Each column rises a moment after the one before.
                val k = ((t * 1.6f) - i.toFloat() / n * 0.6f).coerceIn(0f, 1f)
                val bh = (v / top).toFloat() * h * k
                val x = i * slotW + (slotW - bw) / 2
                val on = i == at || (at < 0 && i == highlight)
                val fill = if (on) color else color.copy(alpha = if (at >= 0 || highlight != null) 0.38f else 0.7f)
                if (bh > 0.5f) drawPath(Path().apply { addRoundRect(RoundRect(x, h - bh, x + bw, h, topLeftCornerRadius = CornerRadius(r, r), topRightCornerRadius = CornerRadius(r, r))) }, fill)
            }
            reference?.let { (v, text) ->
                val y = h - (v / top).toFloat() * h
                drawLine(cs.onSurfaceVariant, Offset(0f, y), Offset(size.width, y), 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 8f)))
                drawText(measure, text, Offset(4.dp.toPx(), y - 16.dp.toPx()), label)
            }
            // Labels: all when few, else the first, the middle and the last.
            val show = if (n <= 8) (0 until n).toList() else listOf(0, n / 2, n - 1)
            show.forEach { i ->
                val l = measure.measure(labels[i], label)
                val cx = (i * slotW + slotW / 2 - l.size.width / 2).coerceIn(0f, size.width - l.size.width)
                drawText(l, topLeft = Offset(cx, h + 4.dp.toPx()))
            }
        }
    }
}

/**
 * A line through the points (nulls leave a gap), drawn in from the left; under it a soft fill
 * when `area`. `invert`: smaller is better and higher (race times). Above it, `said(i)` for the
 * point under the finger, else `headline`.
 */
@Composable
fun LineChart(
    values: List<Double?>,
    color: Color,
    headline: String,
    said: (Int) -> String,
    modifier: Modifier = Modifier,
    area: Boolean = true,
    invert: Boolean = false,
    zero: Boolean = false,
    minSpan: Double = 0.0,
    yLabel: (Double) -> String = { "" },
    height: Int = 160,
    /** Linked charts (a workout's pace, heart rate, elevation): one crosshair, held by the caller. */
    link: Int = -1,
    onLink: ((Int) -> Unit)? = null,
    /** Stretches shaded behind the line (a run's moments), by index, each in its own colour. */
    bands: List<ChartBand> = emptyList(),
) {
    val cs = MaterialTheme.colorScheme
    val measure = rememberTextMeasurer()
    var own by remember { mutableIntStateOf(-1) }
    val at = if (onLink != null) link else own
    val t = grow(values)
    val label = TextStyle(fontSize = 11.sp, color = cs.onSurfaceVariant, fontFamily = Flex)
    Column(modifier) {
        Text(if (at >= 0 && values.getOrNull(at) != null) said(at) else headline, style = MaterialTheme.typography.labelLarge, color = if (at >= 0) color else cs.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
        Canvas(Modifier.fillMaxWidth().height(height.dp).semantics { contentDescription = headline }.scrub(values.size) { if (onLink != null) onLink(it) else own = it }) {
            val pts = values.mapIndexedNotNull { i, v -> v?.let { i to it } }
            if (pts.size < 2) return@Canvas
            var lo = if (zero) 0.0 else pts.minOf { it.second }
            var hi = pts.maxOf { it.second }
            if (hi - lo < minSpan) { val mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2 }
            if (hi - lo < 1e-9) { hi += 1; lo -= 1 }
            val pad = (hi - lo) * 0.08
            lo -= if (zero) 0.0 else pad; hi += pad
            val h = size.height - 6.dp.toPx()
            val n = values.size
            // The scale's two numbers sit in a gutter on the left, clear of the line.
            val hiText = measure.measure(yLabel(if (invert) lo else hi), label)
            val loText = measure.measure(yLabel(if (invert) hi else lo), label)
            val gutter = if (hiText.size.width + loText.size.width == 0) 0f else maxOf(hiText.size.width, loText.size.width) + 8.dp.toPx()
            val w = size.width - gutter
            fun x(i: Int) = gutter + if (n == 1) w / 2 else i * w / (n - 1)
            fun y(v: Double): Float { val f = ((v - lo) / (hi - lo)).toFloat(); return 3.dp.toPx() + (if (invert) f else 1f - f) * (h - 3.dp.toPx()) }
            val line = Path()
            var started = false
            values.forEachIndexed { i, v ->
                if (v == null) { started = false; return@forEachIndexed }
                if (!started) line.moveTo(x(i), y(v)) else line.lineTo(x(i), y(v))
                started = true
            }
            drawText(hiText, topLeft = Offset(0f, 0f))
            drawText(loText, topLeft = Offset(0f, h - loText.size.height))
            bands.forEach { b ->
                val x0 = x(b.from.coerceIn(0, n - 1)); val x1 = x(b.to.coerceIn(0, n - 1))
                drawRoundRect(b.colour, Offset(x0 - 1.dp.toPx(), 0f), Size(maxOf(2.dp.toPx(), x1 - x0 + 2.dp.toPx()), size.height), CornerRadius(4.dp.toPx()))
            }
            clipRect(right = gutter + w * t) {
                if (area) {
                    val fill = Path().apply {
                        val first = pts.first(); val last = pts.last()
                        moveTo(x(first.first), size.height)
                        pts.forEach { (i, v) -> lineTo(x(i), y(v)) }
                        lineTo(x(last.first), size.height)
                        close()
                    }
                    drawPath(fill, Brush.verticalGradient(listOf(color.copy(alpha = 0.12f), color.copy(alpha = 0f))))
                }
                drawPath(line, color, style = Stroke(2.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
            val ix = if (at >= 0 && values.getOrNull(at) != null) at else pts.last().first
            val v = values[ix]!!
            if (at >= 0) drawLine(cs.outline, Offset(x(ix), 0f), Offset(x(ix), size.height), 1.dp.toPx())
            if (t > 0.98f || at >= 0) {
                drawCircle(cs.surfaceContainer, 6.dp.toPx(), Offset(x(ix), y(v)))
                drawCircle(color, 4.dp.toPx(), Offset(x(ix), y(v)))
            }
        }
    }
}

/** A stretch of a chart shaded in a colour (a run's moment), `from`..`to` by index. */
class ChartBand(val from: Int, val to: Int, val colour: Color)

/** Shares as one rounded bar, each part in its colour, 2dp apart, growing in from the left. */
@Composable
fun StackBar(parts: List<Pair<Double, Color>>, modifier: Modifier = Modifier) {
    val t = grow(parts.map { it.first })
    val total = parts.sumOf { it.first }.coerceAtLeast(1e-9)
    Canvas(modifier.fillMaxWidth().height(28.dp).clip(RoundedCornerShape(14.dp))) {
        val gap = 2.dp.toPx()
        var x = 0f
        val shown = parts.filter { it.first > 0 }
        shown.forEachIndexed { i, (v, c) ->
            val w = (v / total).toFloat() * size.width * t
            drawRect(c, Offset(x, 0f), Size((w - if (i < shown.lastIndex) gap else 0f).coerceAtLeast(0f), size.height))
            x += w
        }
    }
}

/** A key for a chart: a swatch and its words. */
@Composable
fun Key(color: Color, text: String, round: Boolean = false) {
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).clip(if (round) CircleShape else RoundedCornerShape(3.dp)).background(color))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
    }
}

/**
 * Every day of the last weeks as a square, a column a week (Monday on top), newest on the right,
 * shaded by the day's effort against your own training days (quartiles); a long range scrolls
 * sideways and opens at the latest week. Tap a day to open its biggest workout.
 */
@Composable
fun DayGrid(weeks: Int, days: List<DayLoad>, open: (String) -> Unit, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    val by = remember(days) { days.associateBy { it.date } }
    val loads = remember(days) { days.filter { it.n > 0 }.map { it.load }.sorted() }
    fun q(p: Double) = loads.getOrNull(minOf(loads.size - 1, (p * loads.size).toInt())) ?: 0.0
    val cuts = listOf(q(0.25), q(0.5), q(0.75))
    fun level(d: DayLoad?) = if (d == null || d.n == 0) 0 else if (d.load <= cuts[0]) 1 else if (d.load <= cuts[1]) 2 else if (d.load <= cuts[2]) 3 else 4
    val shades = listOf(cs.surfaceContainerHighest, cs.primary.copy(alpha = 0.3f), cs.primary.copy(alpha = 0.5f), cs.primary.copy(alpha = 0.75f), cs.primary)
    val today = java.time.LocalDate.now()
    val start = today.minusDays((today.dayOfWeek.value - 1).toLong()).minusWeeks((weeks - 1).toLong())
    val scroll = rememberScrollState()
    LaunchedEffect(weeks) { scroll.scrollTo(scroll.maxValue) }
    Column(modifier) {
        Row(Modifier.horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            for (w in 0 until weeks) {
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    for (i in 0 until 7) {
                        val day = start.plusWeeks(w.toLong()).plusDays(i.toLong())
                        val d = by[day.toString()]
                        val future = day.isAfter(today)
                        Box(
                            Modifier.size(if (weeks > 26) 13.dp else 16.dp).clip(RoundedCornerShape(4.dp))
                                .background(if (future) cs.surfaceContainerHigh.copy(alpha = 0.4f) else shades[level(d)])
                                .let { m -> d?.id?.let { id -> m.press(scale = 0.85f, label = d.name ?: str(R.string.common_workout), onClick = { open(id) }) } ?: m },
                        )
                    }
                }
            }
        }
        Row(Modifier.padding(top = 8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(str(R.string.common_less), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, modifier = Modifier.padding(end = 3.dp))
            shades.forEach { Box(Modifier.size(11.dp).clip(RoundedCornerShape(3.dp)).background(it)) }
            Text(str(R.string.common_more), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, modifier = Modifier.padding(start = 3.dp))
        }
    }
}
