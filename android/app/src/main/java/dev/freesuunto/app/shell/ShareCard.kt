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
 * shared through the app's FileProvider from its cache. Nothing is uploaded by Tartan.
 */
object ShareCard {
    private const val W = 1080
    private const val H = 1350

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

    /** A workout: its route drawn big, then name and day, distance, time, pace (or speed) and heart rate. */
    fun workout(context: Context, w: Workout, color: Int): Bitmap {
        val bmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val ink = Ink(context, color)
        base(c, color)
        val route = w.route
        val top = 96f
        val box = RectF(96f, top, W - 96f, 640f)
        if (route.size >= 2) {
            // Equirectangular, east–west squeezed by latitude, fitted to the box.
            val lat0 = route.map { it.first }.average()
            val k = cos(Math.toRadians(lat0))
            val xs = route.map { it.second * k }
            val ys = route.map { -it.first }
            val (x0, x1, y0, y1) = listOf(xs.min(), xs.max(), ys.min(), ys.max())
            val s = minOf(box.width() / max(1e-9, x1 - x0), box.height() / max(1e-9, y1 - y0)).toFloat()
            val ox = box.left + (box.width() - (x1 - x0).toFloat() * s) / 2
            val oy = box.top + (box.height() - (y1 - y0).toFloat() * s) / 2
            val path = Path()
            route.indices.forEach { i ->
                val px = ox + ((xs[i] - x0).toFloat() * s); val py = oy + ((ys[i] - y0).toFloat() * s)
                if (i == 0) path.moveTo(px, py) else path.lineTo(px, py)
            }
            c.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 30f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; this.color = 0x33000000 })
            c.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 14f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; this.color = 0xFFFFFFFF.toInt() })
            c.drawCircle(ox + ((xs[0] - x0).toFloat() * s), oy + ((ys[0] - y0).toFloat() * s), 16f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = 0xFFFFFFFF.toInt() })
        } else {
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
        return bmp
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
