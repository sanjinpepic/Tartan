package dev.freesuunto.app.shell

import android.content.Context
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import androidx.core.content.FileProvider
import androidx.core.content.res.ResourcesCompat
import dev.freesuunto.app.R
import java.io.File
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Share cards: a workout or the week as a picture (1080 × 1350, the shape social apps show
 * whole), in the app's colour, to post or send. Drawn on a plain canvas, so it needs no screen;
 * shared through the app's FileProvider from its cache. Nothing is uploaded by Tartan (a
 * workout's map comes from the map's own server, as the map under its route does).
 */
object ShareCard {
    const val W = 1080
    const val H = 1350

    private class Ink(context: Context, val bg: Int) {
        val numbers: Typeface = runCatching { ResourcesCompat.getFont(context, R.font.barlow_condensed_600) }.getOrNull() ?: Typeface.DEFAULT_BOLD
        val words: Typeface = runCatching { ResourcesCompat.getFont(context, R.font.google_sans_flex) }.getOrNull() ?: Typeface.DEFAULT
        fun paint(size: Float, face: Typeface, color: Int, bold: Boolean = false) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = size; typeface = if (bold) Typeface.create(face, Typeface.BOLD) else face; this.color = color
        }
    }

    /** The background: the colour, deepening down the card. */
    private fun base(c: Canvas, color: Int) {
        val deep = blend(color, 0xFF000000.toInt(), 0.45f)
        c.drawRect(0f, 0f, W.toFloat(), H.toFloat(), Paint().apply { shader = LinearGradient(0f, 0f, 0f, H.toFloat(), color, deep, Shader.TileMode.CLAMP) })
    }

    private fun blend(a: Int, b: Int, t: Float): Int {
        fun ch(s: Int) = (((a shr s) and 0xFF) * (1 - t) + ((b shr s) and 0xFF) * t).roundToInt() and 0xFF
        return (0xFF shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }

    private fun mark(c: Canvas, ink: Ink) {
        val p = ink.paint(40f, ink.words, 0xCCFFFFFF.toInt(), bold = true)
        c.drawText("Tartan", 72f, H - 64f, p)
    }

    /** A number with its label under it, from (x, y) its top. */
    private fun stat(c: Canvas, ink: Ink, x: Float, y: Float, value: String, label: String) {
        c.drawText(value, x, y + 96f, ink.paint(110f, ink.numbers, 0xFFFFFFFF.toInt()))
        c.drawText(label.uppercase(Locale.getDefault()), x, y + 142f, ink.paint(32f, ink.words, 0xB3FFFFFF.toInt(), bold = true).apply { letterSpacing = 0.08f })
    }

    private fun time(min: Double): String {
        val s = (min * 60).roundToInt()
        return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
    }

    /** Where a workout's route goes: the top of the card, over the name and the numbers. */
    val routeBox = RectF(96f, 96f, W - 96f, 640f)

    /** What's behind a workout's card: the colour (as every card), a street map, or a photo. */
    sealed interface Backdrop {
        data object Colour : Backdrop
        class Map(val streets: Streets) : Backdrop
        class Photo(val bitmap: Bitmap) : Backdrop
    }

    /** A street map the size of the card, and the route's points on it (in the card's pixels). */
    class Streets(val bitmap: Bitmap, val points: List<PointF>)

    /** The map's paper: the card's colour, deep, so the white line and words read on it. */
    fun mapPaper(color: Int) = blend(color, 0xFF000000.toInt(), 0.62f)

    /** A picture's middle, cropped to fill the card. */
    private fun cover(c: Canvas, b: Bitmap) {
        val k = max(W.toFloat() / b.width, H.toFloat() / b.height)
        val sw = W / k; val sh = H / k
        val src = android.graphics.Rect(((b.width - sw) / 2).roundToInt(), ((b.height - sh) / 2).roundToInt(), ((b.width + sw) / 2).roundToInt(), ((b.height + sh) / 2).roundToInt())
        c.drawBitmap(b, src, RectF(0f, 0f, W.toFloat(), H.toFloat()), Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
    }

    /** Over a map or a photo: the lower part darkened (and a little at the top for a photo's route), so white reads on any picture. */
    private fun scrim(c: Canvas, top: Boolean) {
        val black = 0xFF000000.toInt()
        fun a(alpha: Float) = (black and 0x00FFFFFF) or ((alpha * 255).roundToInt() shl 24)
        c.drawRect(0f, 0f, W.toFloat(), H.toFloat(), Paint().apply {
            shader = LinearGradient(0f, 0f, 0f, H.toFloat(), intArrayOf(a(0f), a(0.5f), a(0.72f), a(0.8f)), floatArrayOf(0.42f, 0.56f, 0.78f, 1f), Shader.TileMode.CLAMP)
        })
        if (top) c.drawRect(0f, 0f, W.toFloat(), 720f, Paint().apply {
            shader = LinearGradient(0f, 0f, 0f, 720f, a(0.3f), a(0f), Shader.TileMode.CLAMP)
        })
    }

    /** The route fitted into the card's route box: equirectangular, east–west squeezed by latitude. */
    internal fun fitted(route: List<Pair<Double, Double>>): List<PointF> {
        val box = routeBox
        val lat0 = route.map { it.first }.average()
        val k = cos(Math.toRadians(lat0))
        val xs = route.map { it.second * k }
        val ys = route.map { -it.first }
        val (x0, x1, y0, y1) = listOf(xs.min(), xs.max(), ys.min(), ys.max())
        val s = minOf(box.width() / max(1e-9, x1 - x0), box.height() / max(1e-9, y1 - y0)).toFloat()
        val ox = box.left + (box.width() - (x1 - x0).toFloat() * s) / 2
        val oy = box.top + (box.height() - (y1 - y0).toFloat() * s) / 2
        return route.indices.map { PointF(ox + ((xs[it] - x0).toFloat() * s), oy + ((ys[it] - y0).toFloat() * s)) }
    }

    /**
     * A workout: its route drawn big, then name and day, distance, time, pace (or speed) and heart
     * rate. On the colour, a map (the route where it ran) or a photo (the route over it, or none).
     * [ends]: the route's start drawn as a dot (not when its ends are hidden).
     */
    fun workout(context: Context, w: Workout, color: Int, backdrop: Backdrop = Backdrop.Colour, ends: Boolean = true): Bitmap {
        val bmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val ink = Ink(context, color)
        val pts: List<PointF> = when (backdrop) {
            is Backdrop.Colour -> { base(c, color); if (w.route.size >= 2) fitted(w.route) else emptyList() }
            is Backdrop.Map -> {
                c.drawColor(mapPaper(color))
                c.drawBitmap(backdrop.streets.bitmap, null, RectF(0f, 0f, W.toFloat(), H.toFloat()), Paint(Paint.FILTER_BITMAP_FLAG))
                scrim(c, top = false)
                backdrop.streets.points
            }
            is Backdrop.Photo -> {
                c.drawColor(0xFF000000.toInt())
                cover(c, backdrop.bitmap)
                scrim(c, top = w.route.size >= 2)
                if (w.route.size >= 2) fitted(w.route) else emptyList()
            }
        }
        if (pts.size >= 2) {
            val path = Path()
            pts.forEachIndexed { i, p -> if (i == 0) path.moveTo(p.x, p.y) else path.lineTo(p.x, p.y) }
            // On a picture the soft outline is a little darker, so the white holds on light streets or sky.
            val under = if (backdrop is Backdrop.Colour) 0x33000000 else 0x59000000
            c.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 30f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; this.color = under })
            c.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 14f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; this.color = 0xFFFFFFFF.toInt() })
            if (ends) c.drawCircle(pts[0].x, pts[0].y, 16f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = 0xFFFFFFFF.toInt() })
        } else if (backdrop is Backdrop.Colour) {
            // No route (a treadmill, the gym): the sport's name big instead.
            c.drawText(w.sport.replaceFirstChar { it.uppercase() }, 96f, 520f, ink.paint(150f, ink.words, 0x40FFFFFF, bold = true))
        }
        val day = runCatching { LocalDate.parse((w.startLocal ?: w.start).take(10)).format(DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.getDefault())) }.getOrDefault(w.start.take(10))
        c.drawText((w.name ?: w.sport).take(28), 72f, 760f, ink.paint(64f, ink.words, 0xFFFFFFFF.toInt(), bold = true))
        c.drawText(day, 72f, 816f, ink.paint(38f, ink.words, 0xCCFFFFFF.toInt()))
        val stats = listOfNotNull(
            w.distanceKm?.takeIf { it > 0 }?.let { "%.2f".format(Locale.getDefault(), it) to "km" },
            w.movingMin?.takeIf { it > 0 }?.let { time(it) to str(R.string.share_time) },
            if (w.isRun) w.pace?.let { it to str(R.string.share_per_km) } else w.speedKmh?.let { "%.1f".format(Locale.getDefault(), it) to "km/h" },
            w.avgHr?.let { "$it" to str(R.string.share_avg_bpm) },
        )
        stats.take(4).forEachIndexed { i, (v, l) -> stat(c, ink, 72f + (i % 2) * 480f, 850f + (i / 2) * 175f, v, l) }
        mark(c, ink)
        // The map's data, credited as the map under the workout's route is.
        if (backdrop is Backdrop.Map) {
            val p = ink.paint(26f, ink.words, 0x99FFFFFF.toInt())
            val said = "© OpenStreetMap"
            c.drawText(said, W - 72f - p.measureText(said), H - 66f, p)
        }
        return bmp
    }

    /**
     * The route without about its first and last [metres] (where it starts and ends is often
     * home): what a map shows of it. A short one keeps its middle half.
     */
    fun trimEnds(route: List<Pair<Double, Double>>, metres: Double = 200.0): List<Pair<Double, Double>> {
        if (route.size < 3) return route
        val along = DoubleArray(route.size)
        for (i in 1 until route.size) along[i] = along[i - 1] + metresBetween(route[i - 1], route[i])
        val total = along.last()
        val cut = if (total >= metres * 4) metres else total / 4
        val kept = route.indices.filter { along[it] >= cut && along[it] <= total - cut }.map { route[it] }
        return if (kept.size >= 2) kept else route.subList(route.size / 2 - 1, route.size / 2 + 1)
    }

    private fun metresBetween(a: Pair<Double, Double>, b: Pair<Double, Double>): Double {
        val r = 6_371_000.0
        val p1 = Math.toRadians(a.first); val p2 = Math.toRadians(b.first)
        val dp = p2 - p1; val dl = Math.toRadians(b.second - a.second)
        val h = kotlin.math.sin(dp / 2).let { it * it } + kotlin.math.cos(p1) * kotlin.math.cos(p2) * kotlin.math.sin(dl / 2).let { it * it }
        return 2 * r * kotlin.math.asin(kotlin.math.sqrt(h.coerceIn(0.0, 1.0)))
    }

    /** The week: its kilometres big, against the goal, a bar per day, workouts and time. */
    fun week(context: Context, w: Week, color: Int, today: LocalDate = LocalDate.now()): Bitmap {
        val bmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val ink = Ink(context, color)
        base(c, color)
        val monday = today.minusDays((today.dayOfWeek.value - 1).toLong())
        c.drawText(str(R.string.share_week_of, monday.format(DateTimeFormatter.ofPattern("d MMMM", Locale.getDefault()))), 72f, 150f, ink.paint(44f, ink.words, 0xCCFFFFFF.toInt(), bold = true))
        c.drawText("%.1f".format(Locale.getDefault(), w.km), 64f, 420f, ink.paint(300f, ink.numbers, 0xFFFFFFFF.toInt()))
        c.drawText(if (w.goalKm > 0) str(R.string.share_km_of, "%.0f".format(Locale.getDefault(), w.goalKm)) else str(R.string.common_km_unit), 72f, 490f, ink.paint(48f, ink.words, 0xCCFFFFFF.toInt(), bold = true))
        // A bar per day, Monday to Sunday.
        val most = max(1.0, w.days.maxOfOrNull { it.km } ?: 1.0)
        val left = 72f; val right = W - 72f; val base = 960f; val tall = 360f
        val gap = 24f
        val bw = (right - left - gap * 6) / 7
        val letters = str(R.string.common_day_letters).split(" ")
        w.days.take(7).forEachIndexed { i, d ->
            val x = left + i * (bw + gap)
            val h = if (d.km > 0) max(16f, (d.km / most * tall).toFloat()) else 10f
            c.drawRoundRect(RectF(x, base - h, x + bw, base), 18f, 18f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = if (d.km > 0) 0xFFFFFFFF.toInt() else 0x40FFFFFF })
            c.drawText(letters[i], x + bw / 2 - 12f, base + 56f, ink.paint(36f, ink.words, 0xB3FFFFFF.toInt(), bold = true))
        }
        stat(c, ink, 72f, 1060f, "${w.workouts}", plural(R.plurals.share_workouts_label, w.workouts))
        if (w.minutes > 0) stat(c, ink, 552f, 1060f, time(w.minutes), str(R.string.share_time))
        mark(c, ink)
        return bmp
    }

    /** Words wrapped to a width, drawn from (x, y) their top; returns the bottom. */
    private fun words(c: Canvas, text: String, x: Float, y: Float, width: Int, paint: Paint, lines: Int = 4): Float {
        val tp = android.text.TextPaint(paint)
        val layout = android.text.StaticLayout.Builder.obtain(text, 0, text.length, tp, width)
            .setMaxLines(lines).setEllipsize(android.text.TextUtils.TruncateAt.END).setLineSpacing(0f, 1.12f).build()
        c.save(); c.translate(x, y); layout.draw(c); c.restore()
        return y + layout.height
    }

    /** A small four-point star: the milestone's spark. */
    private fun spark(c: Canvas, cx: Float, cy: Float, r: Float, color: Int) {
        val p = Path().apply {
            moveTo(cx, cy - r)
            quadTo(cx + r * 0.16f, cy - r * 0.16f, cx + r, cy)
            quadTo(cx + r * 0.16f, cy + r * 0.16f, cx, cy + r)
            quadTo(cx - r * 0.16f, cy + r * 0.16f, cx - r, cy)
            quadTo(cx - r * 0.16f, cy - r * 0.16f, cx, cy - r)
            close()
        }
        c.drawPath(p, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color })
    }

    private fun longDay(iso: String) = runCatching { LocalDate.parse(iso.take(10)).format(DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.getDefault())) }.getOrDefault(iso.take(10))

    /** A milestone: its number big (a time, the kilometres), the title, the coach's line, the day. */
    fun milestone(context: Context, m: Moment, color: Int): Bitmap {
        val bmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val ink = Ink(context, color)
        base(c, color)
        spark(c, 120f, 170f, 46f, 0xFFFFFFFF.toInt())
        c.drawText(longDay(m.date), 196f, 186f, ink.paint(42f, ink.words, 0xCCFFFFFF.toInt(), bold = true))
        val figure = m.figure ?: ""
        var y = 300f
        if (figure.isNotEmpty()) {
            val size = if (figure.length > 6) 250f else 330f
            c.drawText(figure, 60f, y + size * 0.82f, ink.paint(size, ink.numbers, 0xFFFFFFFF.toInt()))
            y += size * 0.9f
            m.figureLabel?.let { c.drawText(it.uppercase(Locale.getDefault()), 72f, y + 44f, ink.paint(40f, ink.words, 0xCCFFFFFF.toInt(), bold = true).apply { letterSpacing = 0.08f }) }
            y += 120f
        }
        y = words(c, m.title, 72f, y, W - 144, ink.paint(68f, ink.words, 0xFFFFFFFF.toInt(), bold = true), 3) + 28f
        words(c, m.note, 72f, y, W - 144, ink.paint(40f, ink.words, 0xE6FFFFFF.toInt()), 4)
        mark(c, ink)
        return bmp
    }

    private const val TALL = 1920

    /** Your season, tall: the running big, then the week, the longest, bests, races, the weeks in a row, the coach's line. */
    fun season(context: Context, s: Season, color: Int): Bitmap {
        val bmp = Bitmap.createBitmap(W, TALL, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val ink = Ink(context, color)
        val deep = blend(color, 0xFF000000.toInt(), 0.5f)
        c.drawRect(0f, 0f, W.toFloat(), TALL.toFloat(), Paint().apply { shader = LinearGradient(0f, 0f, 0f, TALL.toFloat(), color, deep, Shader.TileMode.CLAMP) })
        val white = 0xFFFFFFFF.toInt(); val soft = 0xCCFFFFFF.toInt(); val faint = 0x33FFFFFF
        c.drawText(str(R.string.season_your_season).uppercase(Locale.getDefault()), 72f, 150f, ink.paint(40f, ink.words, soft, bold = true).apply { letterSpacing = 0.1f })
        c.drawText(s.label.take(30), 72f, 226f, ink.paint(68f, ink.words, white, bold = true))
        c.drawText("%.0f".format(Locale.getDefault(), s.km), 56f, 480f, ink.paint(280f, ink.numbers, white))
        c.drawText(str(R.string.season_km_of_running).uppercase(Locale.getDefault()), 72f, 546f, ink.paint(40f, ink.words, soft, bold = true).apply { letterSpacing = 0.08f })
        stat(c, ink, 72f, 586f, "${s.runs}", plural(R.plurals.season_runs_label, s.runs))
        stat(c, ink, 400f, 586f, "%.0f".format(Locale.getDefault(), s.minutes / 60.0), str(R.string.season_hours))
        if (s.climbM > 0) stat(c, ink, 728f, 586f, "%,d".format(Locale.getDefault(), s.climbM), str(R.string.season_metres_up))
        var y = 820f
        val line = ink.paint(44f, ink.words, white, bold = true)
        val sub = ink.paint(36f, ink.words, soft)
        fun row(head: String, value: String) {
            c.drawText(head, 72f, y, sub)
            c.drawText(value, W - 72f - line.measureText(value), y, line)
            y += 70f
        }
        // At most five lines: the week, the longest, races, then new bests.
        listOfNotNull(
            s.biggestWeek?.let { str(R.string.season_biggest_week) to "%.1f km".format(Locale.getDefault(), it.second) },
            s.longest?.let { str(R.string.season_longest_run) to "%.1f km".format(Locale.getDefault(), it.km) },
        ).plus(s.races.take(2).map { it.name.take(26) to clockOf(it.timeS) })
            .plus(s.bests.filter { it.pb }.map { str(R.string.season_new_best, it.label) to clockOf(it.timeS) })
            .take(5).forEach { (h, v) -> row(h, v) }
        // The weeks, a bar each, filled where the target was met.
        y += 30f
        if (s.weeks.isNotEmpty()) {
            val most = max(1.0, s.weeks.maxOf { it.km })
            val n = s.weeks.size
            val gap = if (n > 30) 6f else 12f
            val bw = (W - 144f - gap * (n - 1)) / n
            val tall = 140f
            s.weeks.forEachIndexed { i, wk ->
                val x = 72f + i * (bw + gap)
                val h = if (wk.km > 0) max(12f, (wk.km / most * tall).toFloat()) else 8f
                c.drawRoundRect(RectF(x, y + tall - h, x + bw, y + tall), bw / 2, bw / 2, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = if (wk.met == true) white else if (wk.km > 0) 0x80FFFFFF.toInt() else faint })
            }
            y += tall + 54f
            val said = if (s.weeksWithTarget > 0) str(R.string.season_weeks_on_target, s.weeksMet, s.weeksWithTarget) else plural(R.plurals.season_weeks, n, n)
            c.drawText(said, 72f, y, sub)
            y += 60f
        }
        s.crossLine?.let { y = words(c, it, 72f, y, W - 144, sub, 2) + 30f }
        // The coach's line, set apart.
        y += 10f
        val end = words(c, s.closing, 108f, y, W - 180, ink.paint(44f, ink.words, white), 3)
        c.drawRect(72f, y + 6f, 80f, end - 4f, Paint().apply { this.color = soft })
        c.drawText("Tartan", 72f, TALL - 72f, ink.paint(40f, ink.words, soft, bold = true))
        return bmp
    }

    private fun clockOf(s: Int) = if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)

    /** The picture to the share sheet (from the app's cache, read-only to the app chosen). */
    fun share(context: Context, bmp: Bitmap, name: String, text: String? = null) {
        val dir = File(context.cacheDir, "share").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, "$name.png")
        file.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(Intent.EXTRA_STREAM, uri)
            text?.let { putExtra(Intent.EXTRA_TEXT, it) }
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(send, str(R.string.share_share)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

/** The app's colour, deep enough for white on it (in the dark theme, primary is the light one). */
@androidx.compose.runtime.Composable
fun shareColour(): Int {
    val cs = androidx.compose.material3.MaterialTheme.colorScheme
    val c = if (cs.primary.luminance() > 0.4f) cs.inversePrimary else cs.primary
    return c.toArgb()
}
