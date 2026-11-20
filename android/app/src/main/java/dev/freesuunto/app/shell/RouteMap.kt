package dev.freesuunto.app.shell

import android.content.Context
import android.os.Build
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.math.PI
import kotlin.math.ln
import kotlin.math.tan

/**
 * A workout's route as a picture, as the web's route card: the line is drawn at once (Web
 * Mercator, fitted with a margin), and the streets under it, OpenFreeMap's in the app's own
 * colours, fade in when MapLibre has drawn them. Never a control: it takes no touches, so the
 * sheet scrolls and drags over it. Offline (or on the JVM in tests) the line alone stays.
 */
@Composable
fun RouteCard(route: List<Pair<Double, Double>>, label: String, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    val density = LocalDensity.current.density
    BoxWithConstraints(modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainerHigh).semantics { contentDescription = label }) {
        val w = constraints.maxWidth
        val h = constraints.maxHeight
        val line = remember(route) { thin(route, 600) }
        var street by remember(route, w, h) { mutableStateOf<Street?>(null) }
        val shown = remember(route, w, h) { Animatable(0f) }
        val dark = cs.surface.luminance() < 0.5f
        LaunchedEffect(route, w, h, dark) {
            if (line.size < 2 || w <= 0) return@LaunchedEffect
            street = streets(context, line, (w / density).toInt(), (h / density).toInt(), density, cs) ?: return@LaunchedEffect
            shown.animateTo(1f, tween(420))
        }
        val ink = cs.primary
        val paper = cs.surfaceContainerLowest
        Canvas(Modifier.fillMaxSize()) {
            val s = street
            val pts: List<Offset> = if (s != null) {
                drawImage(s.bitmap, dstSize = IntSize(size.width.toInt(), size.height.toInt()), alpha = shown.value)
                val k = size.width / s.width
                s.points.map { Offset(it.x * k, it.y * k) }
            } else fit(line, size, 28.dp.toPx())
            if (pts.size < 2) return@Canvas
            val path = Path().apply { moveTo(pts[0].x, pts[0].y); pts.drop(1).forEach { lineTo(it.x, it.y) } }
            drawPath(path, paper, style = Stroke(7.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            drawPath(path, ink, style = Stroke(3.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            // Start: an open dot; finish: a filled one (as the web's ends).
            drawCircle(ink, 6.dp.toPx(), pts.last())
            drawCircle(ink, 6.dp.toPx(), pts.first())
            drawCircle(paper, 4.dp.toPx(), pts.first())
        }
        if (street != null) Text(
            "© OpenStreetMap",
            fontSize = 9.sp,
            color = cs.onSurfaceVariant,
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 14.dp, bottom = 8.dp).background(cs.surfaceContainerLowest.copy(alpha = 0.7f), RoundedCornerShape(4.dp)).padding(horizontal = 4.dp),
        )
    }
}

private fun Color.luminance() = 0.2126f * red + 0.7152f * green + 0.0722f * blue

/** At most `n` points, evenly picked (the first and last kept). */
private fun thin(route: List<Pair<Double, Double>>, n: Int): List<Pair<Double, Double>> =
    if (route.size <= n) route else (0 until n).map { route[(it.toLong() * (route.size - 1) / (n - 1)).toInt()] }

private fun mercY(lat: Double) = ln(tan(PI / 4 + Math.toRadians(lat) / 2))

/** The route fitted into a size with a margin, north up, in Web Mercator. */
private fun fit(route: List<Pair<Double, Double>>, size: Size, pad: Float): List<Offset> {
    if (route.size < 2) return emptyList()
    val xs = route.map { Math.toRadians(it.second) }
    val ys = route.map { mercY(it.first) }
    val (x0, x1) = xs.min() to xs.max()
    val (y0, y1) = ys.min() to ys.max()
    val k = minOf((size.width - 2 * pad) / (x1 - x0).coerceAtLeast(1e-9), (size.height - 2 * pad) / (y1 - y0).coerceAtLeast(1e-9))
    val ox = (size.width - (x1 - x0) * k) / 2
    val oy = (size.height - (y1 - y0) * k) / 2
    return xs.indices.map { Offset((ox + (xs[it] - x0) * k).toFloat(), (oy + (y1 - ys[it]) * k).toFloat()) }
}

/** The streets as a picture, and the route's points on it (in the picture's dp). */
private class Street(val bitmap: ImageBitmap, val width: Float, val points: List<Offset>)

/** Pictures made this session, by route and size and colours (WebGL-like contexts are scarce; pictures are cheap). */
private val made = object : LinkedHashMap<String, Street>(8, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Street>?) = size > 6
}

private suspend fun streets(context: Context, line: List<Pair<Double, Double>>, w: Int, h: Int, density: Float, cs: ColorScheme): Street? {
    // Robolectric has no MapLibre: the line alone.
    if (Build.FINGERPRINT == "robolectric") return null
    val key = "${line.first()}${line.last()}${line.size}:$w×$h:${cs.surface.toArgb()}:${cs.primary.toArgb()}"
    made[key]?.let { return it }
    val style = mapStyle(context, cs) ?: return null
    val lats = line.map { it.first }
    val lngs = line.map { it.second }
    return runCatching {
        suspendCancellableCoroutine<Street?> { done ->
            org.maplibre.android.MapLibre.getInstance(context.applicationContext)
            val bounds = org.maplibre.android.geometry.LatLngBounds.from(lats.max(), lngs.max(), lats.min(), lngs.min())
            val opts = org.maplibre.android.snapshotter.MapSnapshotter.Options(w, h)
                .withStyleBuilder(org.maplibre.android.maps.Style.Builder().fromJson(style))
                .withRegion(bounds)
                .withPadding(28, 28, 28, 28)
                .withPixelRatio(density)
                .withLogo(false)
                .withAttribution(false)
            val snap = org.maplibre.android.snapshotter.MapSnapshotter(context, opts)
            done.invokeOnCancellation { runCatching { snap.cancel() } }
            snap.start(
                { s ->
                    var pts = line.map { (la, lo) -> s.pixelForLatLng(org.maplibre.android.geometry.LatLng(la, lo)).let { Offset(it.x, it.y) } }
                    // In the picture's dp; should a version answer in its pixels, back to dp.
                    if (pts.maxOf { it.x } > w * 1.2f) pts = pts.map { it / density }
                    if (done.isActive) done.resume(Street(s.bitmap.asImageBitmap(), w.toFloat(), pts))
                },
                { if (done.isActive) done.resume(null) },
            )
        }
    }.getOrNull()?.also { made[key] = it }
}

/** OpenFreeMap's Positron, recoloured to Tartan's paper and ink (web/lib/map.ts brandStyle). */
private var styleJson: String? = null
private val styled = HashMap<String, String>()

suspend fun mapStyle(context: Context, cs: ColorScheme): String? = withContext(Dispatchers.IO) {
    val key = "${cs.surface.toArgb()}:${cs.onSurface.toArgb()}"
    styled[key]?.let { return@withContext it }
    val file = java.io.File(context.cacheDir, "map-style.json")
    val base = styleJson ?: runCatching {
        (java.net.URL("https://tiles.openfreemap.org/styles/positron").openConnection() as java.net.HttpURLConnection).run {
            connectTimeout = 6000; readTimeout = 8000
            inputStream.bufferedReader().use { it.readText() }
        }.also { runCatching { file.writeText(it) } }
    }.getOrNull() ?: runCatching { file.takeIf { it.exists() }?.readText() }.getOrNull() ?: return@withContext null
    styleJson = base
    val bg = cs.surface
    val ink = cs.onSurface
    val dark = bg.luminance() < 0.4f
    fun mix(a: Color, b: Color, t: Float) = Color(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t)
    fun hex(c: Color) = String.format("#%06X", 0xFFFFFF and c.toArgb())
    val water = hex(mix(bg, Color(0xFF5B8DB8), if (dark) 0.35f else 0.22f))
    val green = hex(mix(bg, Color(0xFF5F8F5A), if (dark) 0.22f else 0.16f))
    val building = hex(mix(bg, ink, if (dark) 0.12f else 0.07f))
    val road = if (dark) hex(mix(bg, Color.White, 0.16f)) else "#FFFFFF"
    val casing = hex(mix(bg, ink, if (dark) 0.25f else 0.14f))
    val path = hex(mix(bg, ink, if (dark) 0.55f else 0.42f))
    val label = hex(mix(bg, ink, 0.7f))
    val border = hex(mix(bg, ink, 0.3f))
    val paper = hex(bg)
    runCatching {
        val s = JSONObject(base)
        val layers = s.getJSONArray("layers")
        for (i in 0 until layers.length()) {
            val l = layers.getJSONObject(i)
            val id = l.optString("id").lowercase()
            val paint = l.optJSONObject("paint") ?: JSONObject().also { l.put("paint", it) }
            fun has(r: String) = Regex(r).containsMatchIn(id)
            when (l.optString("type")) {
                "background" -> paint.put("background-color", paper)
                "fill" -> {
                    paint.put("fill-color", when { has("water|ocean|lake|river") -> water; has("park|wood|forest|grass|green|landcover|nature|meadow|scrub") -> green; has("building") -> building; else -> paper })
                    if (has("building")) paint.put("fill-outline-color", building)
                }
                "line" -> when {
                    has("water|river|stream|canal") -> paint.put("line-color", water)
                    has("boundary|admin") -> paint.put("line-color", border)
                    has("path|track|pedestrian|foot|steps|cycle|bridleway") -> { paint.put("line-color", path); paint.put("line-opacity", 0.75) }
                    has("casing|outline") -> paint.put("line-color", casing)
                    has("road|highway|street|tunnel|bridge|motorway|trunk|primary|secondary|tertiary|minor|service") -> paint.put("line-color", road)
                    has("rail") -> paint.put("line-color", casing)
                }
                "symbol" -> { paint.put("text-color", label); paint.put("text-halo-color", paper); paint.put("text-halo-width", 1.4) }
            }
        }
        s.toString()
    }.getOrNull()?.also { styled[key] = it }
}
