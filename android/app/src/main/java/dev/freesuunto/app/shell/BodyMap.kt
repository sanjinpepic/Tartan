package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import android.content.Context
import android.graphics.Region
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import dev.freesuunto.app.R
import org.json.JSONObject

/**
 * The 2D muscle map, native (web/lib/muscles.ts): a body from the front and from the back, each
 * muscle its own shape, shaded on the one heat scale. The outlines are MuscleMap's (Melih Colpan,
 * MIT; vendor/MuscleMap-LICENSE), from res/raw/musclemap.json (scripts/musclemap-asset.ts).
 */
private class Part(val name: String, val path: Path, val region: Region?, val body: Boolean, val other: Boolean)
private class View2(val x: Float, val y: Float, val w: Float, val h: Float, val parts: List<Part>)
private class Figure2(val front: View2, val back: View2)

/** Parts that are the body, not a muscle: drawn quiet, never shaded. */
private val BODY = setOf("head", "hair", "neck", "hands", "feet", "knees", "ankles")
/** Muscles the map draws that the app has no use for yet. */
private val OTHER = setOf("serratus")
/** The side glutes have no shape of their own: they shade the glutes. */
private val SHARES = mapOf("glute_med" to "glutes")

private val figures = HashMap<String, Figure2>()

private suspend fun figure(context: Context, which: String): Figure2? = figures[which] ?: withContext(Dispatchers.Default) {
    runCatching {
        val all = JSONObject(context.resources.openRawResource(R.raw.musclemap).bufferedReader().use { it.readText() })
        fun view(o: JSONObject): View2 {
            val vb = o.optString("vb").split(" ").map { it.toFloat() }
            val ps = o.getJSONObject("parts")
            val parts = ps.keys().asSequence().map { name ->
                val p = ps.getJSONObject(name)
                val path = Path()
                for (side in listOf("l", "r", "c")) p.optJSONArray(side)?.let { a -> for (i in 0 until a.length()) path.addPath(PathParser().parsePathString(a.getString(i)).toPath()) }
                val region = if (name in BODY || name in OTHER) null else Region().apply {
                    setPath(path.asAndroidPath(), Region(vb[0].toInt(), vb[1].toInt(), (vb[0] + vb[2]).toInt(), (vb[1] + vb[3]).toInt()))
                }
                Part(name, path, region, name in BODY, name in OTHER)
            }.toList()
            return View2(vb[0], vb[1], vb[2], vb[3], parts)
        }
        val f = all.getJSONObject(which)
        Figure2(view(f.getJSONObject("front")), view(f.getJSONObject("back")))
    }.getOrNull()
}?.also { figures[which] = it }

/** The heat scale's five steps (styles.css --heat-0 … --heat-4). */
@Composable
fun heat(): List<Color> {
    val cs = MaterialTheme.colorScheme
    val h0 = lerp(cs.surfaceContainerHigh, cs.outline, 0.22f)
    return listOf(h0, lerp(h0, cs.primary, 0.24f), lerp(h0, cs.primary, 0.46f), lerp(h0, cs.primary, 0.70f), cs.primary)
}

/**
 * Front and back, shaded by `levels` (0-4 a muscle). `onMuscle`: a tap on a muscle (it's then
 * marked selected); without, a picture. `figure`: "m" or "f".
 */
@Composable
fun BodyMap(levels: Map<String, Int>, modifier: Modifier = Modifier, figure: String = "m", selected: String? = null, onMuscle: ((String) -> Unit)? = null, label: String = stringResource(R.string.body_your_muscles_front_and_back)) {
    val context = LocalContext.current
    val view = LocalView.current
    var fig by remember(figure) { mutableStateOf(figures[figure]) }
    LaunchedEffect(figure) { if (fig == null) fig = figure(context, figure) }
    val shades = heat()
    val quiet = MaterialTheme.colorScheme.surfaceContainerHighest
    val ink = MaterialTheme.colorScheme.onSurface
    // Each drawn muscle's level: its own, or the strongest of those it stands for.
    val drawn = remember(levels) { HashMap<String, Int>().also { out -> levels.forEach { (m, v) -> val at = SHARES[m] ?: m; out[at] = maxOf(out[at] ?: 0, v) } } }
    val sel = selected?.let { SHARES[it] ?: it }
    val f = fig
    val ratio = if (f != null) (f.front.w + f.back.w) / maxOf(f.front.h, f.back.h) else 1.1f
    Canvas(
        modifier.fillMaxWidth().aspectRatio(ratio).semantics { contentDescription = label }
            .let { m ->
                if (onMuscle == null || f == null) m else m.pointerInput(f) {
                    detectTapGestures { at ->
                        val k = size.width / (f.front.w + f.back.w)
                        val (v, x0) = if (at.x < f.front.w * k) f.front to 0f else f.back to f.front.w * k
                        val vx = (at.x - x0) / k + v.x
                        val vy = at.y / k + v.y
                        v.parts.firstOrNull { it.region?.contains(vx.toInt(), vy.toInt()) == true }?.let { p -> view.feel(Haptic.Click); onMuscle(p.name) }
                    }
                }
            },
    ) {
        val ff = f ?: return@Canvas
        val k = size.width / (ff.front.w + ff.back.w)
        listOf(ff.front to 0f, ff.back to ff.front.w * k).forEach { (v, x0) ->
            withTransform({ translate(x0, 0f); scale(k, k, Offset.Zero); translate(-v.x, -v.y) }) {
                v.parts.forEach { p ->
                    val c = when {
                        p.body -> quiet
                        p.other -> shades[0]
                        else -> shades[(drawn[p.name] ?: 0).coerceIn(0, 4)]
                    }
                    drawPath(p.path, c)
                    if (p.name == sel) drawPath(p.path, ink, style = Stroke(6f))
                }
            }
        }
    }
}

/** The heat scale's key: words at each end of its five steps. */
@Composable
fun HeatLegend(low: String = stringResource(R.string.common_less), high: String = stringResource(R.string.common_more)) {
    val cs = MaterialTheme.colorScheme
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(low, style = MaterialTheme.typography.labelSmall, color = cs.onSurfaceVariant)
        heat().forEach { Box(Modifier.size(14.dp, 10.dp).clip(RoundedCornerShape(3.dp)).background(it)) }
        Text(high, style = MaterialTheme.typography.labelSmall, color = cs.onSurfaceVariant)
    }
}
