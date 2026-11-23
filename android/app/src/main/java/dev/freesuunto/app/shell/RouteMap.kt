package dev.freesuunto.app.shell

import android.content.Context
import android.os.Build
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateRectAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
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
import kotlin.math.max
import kotlin.math.tan

/** A stretch of the route to mark (a moment, src/run-moments.ts): its points, its pin, its colour and the number's. */
class RouteMark(val line: List<Pair<Double, Double>>, val at: Pair<Double, Double>?, val colour: Color, val ink: Color)

/**
 * Robolectric has no MapLibre: a test can hand the card a stand-in for the streets (a picture
 * of the card's size in dp), fitted the way the line alone is. Never set in the app.
 */
val LocalStreetsStandIn = staticCompositionLocalOf<((Int, Int) -> ImageBitmap)?> { null }

/**
 * A workout's route as a picture, as the web's route card: the line is drawn at once (Web
 * Mercator, fitted with a margin), and the streets under it, OpenFreeMap's in the app's own
 * colours, fade in when MapLibre has drawn them. Not a map you move: the sheet scrolls and drags
 * over it. Offline (or on the JVM in tests) the line alone stays.
 *
 * With marks (a run's moments): each stretch glows in its colour under the line and a numbered
 * pin sits at its middle. Tapping a pin chooses it (`onPick`); the chosen one stands out, the
 * others step back, and the picture eases in to frame it (at once with animations off).
 */
@Composable
fun RouteCard(route: List<Pair<Double, Double>>, label: String, modifier: Modifier = Modifier, marks: List<RouteMark> = emptyList(), chosen: Int = -1, onPick: ((Int) -> Unit)? = null) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    val density = LocalDensity.current.density
    val standIn = LocalStreetsStandIn.current
    val still = LocalReducedMotion.current
    val measure = rememberTextMeasurer()
    BoxWithConstraints(modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(28.dp)).background(cs.surfaceContainerHigh).semantics { contentDescription = label }) {
        val w = constraints.maxWidth
        val h = constraints.maxHeight
        val line = remember(route) { thin(route, 600) }
        var street by remember(route, w, h) { mutableStateOf<Street?>(null) }
        val shown = remember(route, w, h) { Animatable(0f) }
        val dark = cs.surface.luminance() < 0.5f
        // Framed closer on a moment: the streets drawn finer so they stay sharp.
        val fine = marks.isNotEmpty()
        LaunchedEffect(route, w, h, dark) {
            if (line.size < 2 || w <= 0) return@LaunchedEffect
            street = (if (standIn != null) Street(standIn((w / density).toInt(), (h / density).toInt()), w / density, fit(line, Size(w / density, h / density), 28f)) else null)
                ?: streets(context, line, (w / density).toInt(), (h / density).toInt(), if (fine) minOf(density * 2, 6f) else density, cs) ?: return@LaunchedEffect
            shown.animateTo(1f, tween(420))
        }
        val full = Size(w.toFloat(), h.toFloat())
        val proj = remember(street, line, w, h) { street?.let { it.proj.scaled(w / it.width) } ?: fit(line, full, 28 * density) }
        val stretches = remember(marks, proj) { marks.map { m -> thin(m.line, 200).map(proj::at) } }
        val pins = remember(marks, proj) { marks.map { m -> m.at?.let(proj::at) } }
        // Where the picture looks: all of it, or the chosen moment framed with room around it.
        val target = remember(chosen, stretches, pins, w, h) {
            val pts = stretches.getOrNull(chosen).orEmpty() + listOfNotNull(pins.getOrNull(chosen))
            if (pts.isEmpty()) Rect(0f, 0f, w.toFloat(), h.toFloat()) else frame(pts, full, 40 * density, 2.4f)
        }
        val view by animateRectAsState(target, if (still) snap() else spring(dampingRatio = 1f, stiffness = Spring.StiffnessVeryLow), label = "frame")
        val focus = marks.indices.map { k -> animateFloatAsState(if (chosen == k) 1f else 0f, if (still) snap() else spring(dampingRatio = 1f, stiffness = 300f), label = "mark").value }
        val any by animateFloatAsState(if (chosen in marks.indices) 1f else 0f, if (still) snap() else spring(dampingRatio = 1f, stiffness = 300f), label = "marks")
        val ink = cs.primary
        val paper = cs.surfaceContainerLowest
        val number = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = Flex)
        val tap by rememberUpdatedState { at: Offset ->
            val z = w / view.width
            pins.indexOfFirst { p -> p != null && ((p - view.topLeft) * z - at).getDistance() <= 24 * density }.takeIf { it >= 0 }?.let { onPick?.invoke(it) }
        }
        Canvas(Modifier.fillMaxSize().then(if (onPick != null && marks.isNotEmpty()) Modifier.pointerInput(Unit) { detectTapGestures { tap(it) } } else Modifier)) {
            val z = size.width / view.width
            fun on(p: Offset) = (p - view.topLeft) * z
            street?.let { s ->
                withTransform({ scale(z, z, pivot = Offset.Zero); translate(-view.left, -view.top) }) {
                    drawImage(s.bitmap, dstSize = IntSize(size.width.toInt(), size.height.toInt()), alpha = shown.value)
                }
            }
            val pts = line.map { on(proj.at(it)) }
            if (pts.size < 2) return@Canvas
            fun path(xs: List<Offset>) = Path().apply { moveTo(xs[0].x, xs[0].y); xs.drop(1).forEach { lineTo(it.x, it.y) } }
            // Each moment's stretch, a glow under the line in its colour.
            stretches.forEachIndexed { k, st ->
                if (st.size < 2) return@forEachIndexed
                val alpha = 0.3f + 0.25f * focus[k] - 0.16f * any * (1 - focus[k])
                drawPath(path(st.map(::on)), marks[k].colour.copy(alpha = alpha), style = Stroke((13 + 4 * focus[k]).dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
            val p = path(pts)
            drawPath(p, paper, style = Stroke(7.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            drawPath(p, ink, style = Stroke(3.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            // Start: an open dot; finish: a filled one (as the web's ends).
            drawCircle(ink, 6.dp.toPx(), pts.last())
            drawCircle(ink, 6.dp.toPx(), pts.first())
            drawCircle(paper, 4.dp.toPx(), pts.first())
            // The pins, numbered in route order; the chosen one a little larger, on top.
            (pins.indices.filter { it != chosen } + listOfNotNull(chosen.takeIf { it in pins.indices })).forEach { k ->
                val c = pins[k]?.let(::on) ?: return@forEach
                val r = (9 + 2 * focus[k]).dp.toPx()
                val fade = 1f - 0.45f * any * (1 - focus[k])
                drawCircle(paper.copy(alpha = fade), r + 2.dp.toPx(), c)
                drawCircle(marks[k].colour.copy(alpha = fade), r, c)
                val t = measure.measure("${k + 1}", number.copy(color = marks[k].ink.copy(alpha = fade)))
                drawText(t, topLeft = Offset(c.x - t.size.width / 2f, c.y - t.size.height / 2f))
            }
        }
        if (street != null && standIn == null) Text(
            "© OpenStreetMap",
            fontSize = 9.sp,
            color = cs.onSurfaceVariant,
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 14.dp, bottom = 8.dp).background(cs.surfaceContainerLowest.copy(alpha = 0.7f), RoundedCornerShape(4.dp)).padding(horizontal = 4.dp),
        )
    }
}

private fun Color.luminance() = 0.2126f * red + 0.7152f * green + 0.0722f * blue

/** At most `n` points, evenly picked (the first and last kept). */
internal fun thin(route: List<Pair<Double, Double>>, n: Int): List<Pair<Double, Double>> =
    if (route.size <= n) route else (0 until n).map { route[(it.toLong() * (route.size - 1) / (n - 1)).toInt()] }

private fun mercY(lat: Double) = ln(tan(PI / 4 + Math.toRadians(lat) / 2))

/** Web Mercator onto the card: x = ax·longitude (radians) + bx, y = ay·mercY(latitude) + by. */
internal class Proj(val ax: Double, val bx: Double, val ay: Double, val by: Double) {
    fun at(p: Pair<Double, Double>) = Offset((ax * Math.toRadians(p.second) + bx).toFloat(), (ay * mercY(p.first) + by).toFloat())
    fun scaled(k: Float) = Proj(ax * k, bx * k, ay * k, by * k)
}

/** The route fitted into a size with a margin, north up, in Web Mercator. */
private fun fit(route: List<Pair<Double, Double>>, size: Size, pad: Float): Proj {
    if (route.size < 2) return Proj(0.0, size.width / 2.0, 0.0, size.height / 2.0)
    val xs = route.map { Math.toRadians(it.second) }
    val ys = route.map { mercY(it.first) }
    val (x0, x1) = xs.min() to xs.max()
    val (y0, y1) = ys.min() to ys.max()
    val k = minOf((size.width - 2 * pad) / (x1 - x0).coerceAtLeast(1e-9), (size.height - 2 * pad) / (y1 - y0).coerceAtLeast(1e-9))
    val ox = (size.width - (x1 - x0) * k) / 2
    val oy = (size.height - (y1 - y0) * k) / 2
    return Proj(k, ox - x0 * k, -k, oy + y1 * k)
}

/** The projection a snapshot drew with, read back from where it put the route's points (a line fit on each axis). */
private fun projOf(line: List<Pair<Double, Double>>, pts: List<Offset>): Proj {
    fun fit1(u: List<Double>, v: List<Double>): Pair<Double, Double> {
        val mu = u.average(); val mv = v.average()
        val su = u.sumOf { (it - mu) * (it - mu) }.coerceAtLeast(1e-18)
        val a = u.indices.sumOf { (u[it] - mu) * (v[it] - mv) } / su
        return a to mv - a * mu
    }
    val (ax, bx) = fit1(line.map { Math.toRadians(it.second) }, pts.map { it.x.toDouble() })
    val (ay, by) = fit1(line.map { mercY(it.first) }, pts.map { it.y.toDouble() })
    return Proj(ax, bx, ay, by)
}

/**
 * The part of the card to show so `pts` fill it with `pad` round them: the card's shape, no
 * closer than `zoom` times, kept inside the picture.
 */
internal fun frame(pts: List<Offset>, size: Size, pad: Float, zoom: Float): Rect {
    var w = (pts.maxOf { it.x } - pts.minOf { it.x }) + 2 * pad
    var h = (pts.maxOf { it.y } - pts.minOf { it.y }) + 2 * pad
    val aspect = size.width / size.height
    if (w / h < aspect) w = h * aspect else h = w / aspect
    if (w < size.width / zoom) { w = size.width / zoom; h = size.height / zoom }
    if (w >= size.width) return Rect(0f, 0f, size.width, size.height)
    val cx = (pts.maxOf { it.x } + pts.minOf { it.x }) / 2
    val cy = (pts.maxOf { it.y } + pts.minOf { it.y }) / 2
    val left = (cx - w / 2).coerceIn(0f, size.width - w)
    val top = (cy - h / 2).coerceIn(0f, size.height - h)
    return Rect(left, top, left + w, top + h)
}

/** The streets as a picture, how the route was projected onto it (in the picture's dp), and its width. */
private class Street(val bitmap: ImageBitmap, val width: Float, val proj: Proj)

/** Pictures made this session, by route and size and colours (WebGL-like contexts are scarce; pictures are cheap). */
private val made = object : LinkedHashMap<String, Street>(8, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Street>?) = size > 6
}

private suspend fun streets(context: Context, line: List<Pair<Double, Double>>, w: Int, h: Int, ratio: Float, cs: ColorScheme): Street? {
    // Robolectric has no MapLibre: the line alone.
    if (Build.FINGERPRINT == "robolectric") return null
    val key = "${line.first()}${line.last()}${line.size}:$w×$h@$ratio:${cs.surface.toArgb()}:${cs.primary.toArgb()}"
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
                .withPixelRatio(ratio)
                .withLogo(false)
                .withAttribution(false)
            val snap = org.maplibre.android.snapshotter.MapSnapshotter(context, opts)
            done.invokeOnCancellation { runCatching { snap.cancel() } }
            snap.start(
                { s ->
                    var pts = line.map { (la, lo) -> s.pixelForLatLng(org.maplibre.android.geometry.LatLng(la, lo)).let { Offset(it.x, it.y) } }
                    // In the picture's dp; should a version answer in its pixels, back to dp.
                    if (pts.maxOf { it.x } > w * 1.2f) pts = pts.map { it / ratio }
                    if (done.isActive) done.resume(Street(s.bitmap.asImageBitmap(), w.toFloat(), projOf(line, pts)))
                },
                { if (done.isActive) done.resume(null) },
            )
        }
    }.getOrNull()?.also { made[key] = it }
}

/** OpenFreeMap's Positron, recoloured to Tartan's paper and ink (web/lib/map.ts brandStyle). */
private var styleJson: String? = null
private val styled = HashMap<String, String>()

suspend fun mapStyle(context: Context, cs: ColorScheme): String? = mapStyle(context, cs.surface, cs.onSurface)

/** The same, in any paper and ink (the share card's map: its own colour, deep, with white). */
suspend fun mapStyle(context: Context, bg: Color, ink: Color): String? = withContext(Dispatchers.IO) {
    val key = "${bg.toArgb()}:${ink.toArgb()}"
    styled[key]?.let { return@withContext it }
    val file = java.io.File(context.cacheDir, "map-style.json")
    val base = styleJson ?: runCatching {
        (java.net.URL("https://tiles.openfreemap.org/styles/positron").openConnection() as java.net.HttpURLConnection).run {
            connectTimeout = 6000; readTimeout = 8000
            inputStream.bufferedReader().use { it.readText() }
        }.also { runCatching { file.writeText(it) } }
    }.getOrNull() ?: runCatching { file.takeIf { it.exists() }?.readText() }.getOrNull() ?: return@withContext null
    styleJson = base
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

/**
 * The route's points on the share card (its pixels), from what the snapshot answered ([got]).
 * MapLibre answers in the snapshot's points or in its pixels (twice that, at 2×) depending on the
 * version, so the route's own spread from the camera's sums ([xs], [ys] in Mercator 0..1, the
 * world [world] points wide, centred on [tx], [ty] in a [w] × [h] picture) says which: the answer
 * is scaled to match. A guess from where the points lie went wrong for a narrow route (doubled,
 * pushed sideways off its streets). Should the answer make no sense, the sums' own points.
 */
internal fun onCard(got: List<Pair<Float, Float>>, xs: List<Double>, ys: List<Double>, world: Double, tx: Double, ty: Double, w: Int, h: Int): List<android.graphics.PointF> {
    val mine = xs.indices.map { i -> ((xs[i] - tx) * world + w / 2.0) * 2 to ((ys[i] - ty) * world + h / 2.0) * 2 }
    fun spread(p: List<Pair<Double, Double>>) = max(p.maxOf { it.first } - p.minOf { it.first }, p.maxOf { it.second } - p.minOf { it.second })
    val theirs = got.map { it.first.toDouble() to it.second.toDouble() }
    val want = spread(mine)
    val have = if (theirs.size == mine.size && theirs.all { it.first.isFinite() && it.second.isFinite() }) spread(theirs) else 0.0
    val k = if (have > 0 && want > 0) listOf(1.0, 2.0).minBy { kotlin.math.abs(ln(have * it / want)) } else 0.0
    val pts = if (k > 0 && kotlin.math.abs(ln(have * k / want)) < 0.2) theirs.map { it.first * k to it.second * k } else mine
    return pts.map { android.graphics.PointF(it.first.toFloat(), it.second.toFloat()) }
}

/**
 * The share card's map (ShareCard.Streets): the whole card, 1080 × 1350, in the card's own colour
 * made deep, with the route framed in the card's route box (the top) and the stats' part below
 * it. The camera is worked out here (Web Mercator, MapLibre's 512-point world), so the box holds
 * the route whatever its shape; the points come back in the card's pixels. Null offline (no
 * style, or no tiles in time) and on the JVM in tests.
 */
suspend fun cardStreets(context: Context, route: List<Pair<Double, Double>>, colour: Int): ShareCard.Streets? {
    if (Build.FINGERPRINT == "robolectric" || route.size < 2) return null
    val line = thin(route, 600)
    val paper = Color(ShareCard.mapPaper(colour))
    val style = mapStyle(context, paper, Color.White) ?: return null
    // In the snapshot's points (half the card's pixels, drawn at 2×).
    val w = ShareCard.W / 2; val h = ShareCard.H / 2
    val box = ShareCard.routeBox
    val bw = box.width() / 2; val bh = box.height() / 2
    val bcx = box.centerX() / 2; val bcy = box.centerY() / 2
    fun mx(lng: Double) = (lng + 180) / 360
    fun my(lat: Double) = (1 - mercY(lat) / PI) / 2
    val xs = line.map { mx(it.second) }; val ys = line.map { my(it.first) }
    val dx = (xs.max() - xs.min()).coerceAtLeast(1e-7); val dy = (ys.max() - ys.min()).coerceAtLeast(1e-7)
    // The world's size in points at the zoom that fits the route in the box (no closer than 17).
    val world = minOf(bw / dx, bh / dy, 512.0 * (1 shl 17))
    val zoom = kotlin.math.log2(world / 512.0)
    val cx = (xs.max() + xs.min()) / 2; val cy = (ys.max() + ys.min()) / 2
    val tx = cx + (w / 2.0 - bcx) / world
    val ty = cy + (h / 2.0 - bcy) / world
    val lat = Math.toDegrees(kotlin.math.atan(kotlin.math.sinh(PI * (1 - 2 * ty))))
    val lng = tx * 360 - 180
    return runCatching {
        kotlinx.coroutines.withTimeoutOrNull(25_000) {
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<ShareCard.Streets?> { done ->
                    org.maplibre.android.MapLibre.getInstance(context.applicationContext)
                    val camera = org.maplibre.android.camera.CameraPosition.Builder()
                        .target(org.maplibre.android.geometry.LatLng(lat, lng)).zoom(zoom).build()
                    val opts = org.maplibre.android.snapshotter.MapSnapshotter.Options(w, h)
                        .withStyleBuilder(org.maplibre.android.maps.Style.Builder().fromJson(style))
                        .withCameraPosition(camera)
                        .withPixelRatio(2f)
                        .withLogo(false)
                        .withAttribution(false)
                    val snap = org.maplibre.android.snapshotter.MapSnapshotter(context, opts)
                    done.invokeOnCancellation { runCatching { snap.cancel() } }
                    snap.start(
                        { s ->
                            val got = line.map { (la, lo) -> s.pixelForLatLng(org.maplibre.android.geometry.LatLng(la, lo)) }
                            if (done.isActive) done.resume(ShareCard.Streets(s.bitmap, onCard(got.map { it.x to it.y }, xs, ys, world, tx, ty, w, h)))
                        },
                        { if (done.isActive) done.resume(null) },
                    )
                }
            }
        }
    }.getOrNull()
}
