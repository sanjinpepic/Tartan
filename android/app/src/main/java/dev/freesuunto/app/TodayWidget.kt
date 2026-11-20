package dev.freesuunto.app

import dev.freesuunto.app.shell.str
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import androidx.core.content.res.ResourcesCompat
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Today on the home screen: the day's session and its detail, how you are, the week's
 * kilometres, and when the watch and Strava last came in (the sync board's lanes). The app
 * writes what to show (TartanWidgetPlugin) after each sync and when it goes to the background;
 * the widget only draws it, and works out "2h" / "5m" itself so the times keep moving.
 */
class TodayWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) manager.updateAppWidget(id, views(context))
    }

    companion object {
        const val PREFS = "tartan_widget"

        private var runDrawn = 0L
        private var runStatus: String? = null

        /**
         * A run being recorded, on the widget: its clock ticks by itself; distance and pace are
         * redrawn when it pauses or resumes and every half minute. Gone (back to Today) when it ends.
         */
        fun recording(context: Context, r: dev.freesuunto.app.shell.RecNow) {
            val live = r.status == "recording" || r.status == "paused"
            val now = System.currentTimeMillis()
            if (r.status == runStatus && (!live || now - runDrawn < 30_000)) return
            runStatus = r.status
            runDrawn = now
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (!live) { prefs.edit().remove("run").apply(); refresh(context); return }
            val moving = r.moving(now)
            val km = r.distance / 1000
            val pace = if (km >= 0.05) (moving / km).toInt() else null
            val line = listOfNotNull(str(R.string.common_n_km, String.format(java.util.Locale.getDefault(), "%.2f", km)), pace?.let { str(R.string.common_per_km, "%d:%02d".format(it / 60, it % 60)) }, r.bpm?.let { str(R.string.common_n_bpm, it) }).joinToString(" · ")
            val o = JSONObject().put("paused", r.status == "paused").put("moving_s", moving).put("from", now - moving * 1000).put("line", line).put("title", r.planTitle ?: "")
            prefs.edit().putString("run", o.toString()).apply()
            refresh(context)
        }

        /** Redraw every Tartan widget on the home screen. */
        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, TodayWidget::class.java))
            for (id in ids) manager.updateAppWidget(id, views(context))
        }

        /** "now", "4m", "2h", "3d", or "–" when never. */
        private fun since(at: Long, now: Long): String {
            if (at <= 0) return "–"
            val m = (now - at) / 60_000
            return when {
                m < 1 -> str(R.string.widget_now)
                m < 60 -> str(R.string.widget_minutes_short, m)
                m < 48 * 60 -> str(R.string.widget_hours_short, (m + 30) / 60)
                else -> str(R.string.widget_days_short, (m + 720) / 1440)
            }
        }

        fun views(context: Context): RemoteViews {
            val v = RemoteViews(context.packageName, R.layout.widget_today)
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("data", null)
            val d = try { if (raw != null) JSONObject(raw) else null } catch (e: Exception) { null }
            if (d == null) {
                v.setTextViewText(R.id.w_title, str(R.string.common_open_tartan))
                v.setTextViewText(R.id.w_detail, str(R.string.today_today_s_session_and_your_week))
                v.setViewVisibility(R.id.w_ready, View.GONE)
                v.setViewVisibility(R.id.w_label, View.GONE)
                v.setViewVisibility(R.id.w_foot, View.GONE)
                v.setViewVisibility(R.id.w_week_img, View.GONE)
            } else {
                val now = System.currentTimeMillis()
                v.setTextViewText(R.id.w_when, d.optString("when", str(R.string.common_today)))
                // How you are, as a pill in its colour: good to go, steady, or take it easy.
                val (pill, ink) = when (d.optString("tone")) {
                    "good" -> R.drawable.widget_pill_good to R.color.widget_on_good_container
                    "warn" -> R.drawable.widget_pill_warn to R.color.widget_on_warn_container
                    else -> R.drawable.widget_pill_accent to R.color.widget_on_accent_container
                }
                v.setInt(R.id.w_ready, "setBackgroundResource", pill)
                v.setTextColor(R.id.w_ready, context.getColor(ink))
                v.setTextViewText(R.id.w_label, d.optString("label", ""))
                v.setViewVisibility(R.id.w_label, if (d.optString("label", "").isEmpty()) View.GONE else View.VISIBLE)
                v.setViewVisibility(R.id.w_foot, View.VISIBLE)
                // The week as on Today: a picture of the wavy ring and the day bars (the line in words when there's none).
                val week = runCatching { weekImage(context, d) }.getOrNull()
                v.setViewVisibility(R.id.w_week_img, if (week != null) View.VISIBLE else View.GONE)
                if (week != null) v.setImageViewBitmap(R.id.w_week_img, week)
                v.setTextViewText(R.id.w_title, d.optString("title", str(R.string.common_rest_day)))
                v.setViewVisibility(R.id.w_title, View.VISIBLE)
                v.setViewVisibility(R.id.w_clock, View.GONE)
                v.setTextViewText(R.id.w_detail, d.optString("detail", ""))
                v.setViewVisibility(R.id.w_detail, if (d.optString("detail", "").isEmpty()) View.GONE else View.VISIBLE)
                v.setTextViewText(R.id.w_ready, d.optString("ready", ""))
                v.setViewVisibility(R.id.w_ready, if (d.optString("ready", "").isEmpty()) View.GONE else View.VISIBLE)
                v.setTextViewText(R.id.w_week, d.optString("week", ""))
                v.setViewVisibility(R.id.w_week, if (d.optString("week", "").isEmpty() || week != null) View.GONE else View.VISIBLE)
                val lanes = ArrayList<String>()
                if (d.optBoolean("watch_on", false)) lanes.add(str(R.string.widget_watch_lane, if (d.optBoolean("watch_failed", false)) "!" else since(d.optLong("watch_at", 0), now)))
                if (d.optBoolean("strava_on", false)) lanes.add(str(R.string.widget_strava_lane, if (d.optBoolean("strava_failed", false)) "!" else since(d.optLong("strava_at", 0), now)))
                v.setTextViewText(R.id.w_lanes, lanes.joinToString("  ·  "))
                v.setViewVisibility(R.id.w_lanes, if (lanes.isEmpty()) View.GONE else View.VISIBLE)
            }
            // A run being recorded: its time ticking, its distance and pace, a tap to Record.
            val run = runCatching { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("run", null)?.let { JSONObject(it) } }.getOrNull()
            if (run != null) {
                val paused = run.optBoolean("paused")
                val moving = run.optLong("moving_s")
                // The clock counts from when the moving time began (the system ticks it; paused, it stands).
                val base = android.os.SystemClock.elapsedRealtime() - (if (paused) moving * 1000 else System.currentTimeMillis() - run.optLong("from"))
                v.setViewVisibility(R.id.w_title, View.GONE)
                v.setViewVisibility(R.id.w_clock, View.VISIBLE)
                v.setChronometer(R.id.w_clock, base, null, !paused)
                v.setInt(R.id.w_ready, "setBackgroundResource", R.drawable.widget_pill_accent)
                v.setTextColor(R.id.w_ready, context.getColor(R.color.widget_on_accent_container))
                v.setTextViewText(R.id.w_ready, if (paused) str(R.string.common_paused) else str(R.string.common_recording))
                v.setViewVisibility(R.id.w_ready, View.VISIBLE)
                v.setTextViewText(R.id.w_label, run.optString("title").ifEmpty { str(R.string.common_your_run) })
                v.setViewVisibility(R.id.w_label, View.VISIBLE)
                v.setTextViewText(R.id.w_detail, run.optString("line"))
                v.setViewVisibility(R.id.w_detail, View.VISIBLE)
            }
            // A tap opens Tartan on Today (on Record during a run).
            val open = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                if (run != null) putExtra(dev.freesuunto.app.shell.LiveUpdates.EXTRA_OPEN, "record")
            }
            v.setOnClickPendingIntent(R.id.w_root, PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            return v
        }

        /**
         * The week as Today draws it, as a picture (a widget can't run the app's own views): the
         * wavy ring filling towards the week's goal (flat when empty or reached, green when
         * reached), the kilometres in the app's condensed numerals with "of 41" under them, and
         * a bar a day (today in the colour, days ahead quieter). In the wallpaper's colours.
         */
        fun weekImage(context: Context, d: JSONObject): Bitmap? {
            val days = d.optJSONArray("days") ?: return null
            if (days.length() == 0) return null
            val km = d.optDouble("km", 0.0)
            val goal = d.optDouble("goal", 0.0)
            val dp = context.resources.displayMetrics.density
            val w = (112 * dp).toInt()
            val h = (148 * dp).toInt()
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val c = Canvas(bmp)
            val accent = context.getColor(R.color.widget_accent)
            val good = context.getColor(R.color.widget_good)
            val track = context.getColor(R.color.widget_track)
            val trackHigh = context.getColor(R.color.widget_track_high)
            val ink = context.getColor(R.color.widget_on_surface)
            val muted = context.getColor(R.color.widget_muted)
            val numerals = runCatching { ResourcesCompat.getFont(context, R.font.barlow_condensed_600) }.getOrNull() ?: Typeface.DEFAULT_BOLD
            val share = if (goal > 0) (km / goal).coerceIn(0.0, 1.0).toFloat() else 0f
            val reached = goal > 0 && km >= goal

            // The ring: a plain track, and the done part waving along it (M3 Expressive).
            val stroke = 7 * dp
            val size = min(w.toFloat(), h - 52 * dp) - stroke
            val cx = w / 2f
            val cy = stroke / 2 + size / 2
            val r = size / 2 - 3 * dp
            val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = stroke; strokeCap = Paint.Cap.ROUND }
            val gap = if (share in 0.001f..0.999f) 0.12f else 0f
            val start = -90f
            val sweep = 360f * share
            if (share < 0.999f) {
                ring.color = track
                c.drawArc(RectF(cx - r, cy - r, cx + r, cy + r), start + sweep + gap * 57.3f, 360f - sweep - 2 * gap * 57.3f, false, ring)
            }
            if (share > 0.001f) {
                ring.color = if (reached) good else accent
                val wave = share > 0.02f && share < 0.999f
                val amp = if (wave) 1.1f * dp else 0f
                val waves = max(5, (2 * PI * r / (22 * dp)).toInt())
                val path = Path()
                val steps = max(24, (sweep * 2).toInt())
                for (k in 0..steps) {
                    val a = Math.toRadians((start + sweep * k / steps).toDouble())
                    val rr = r + amp * sin(waves * a).toFloat()
                    val x = cx + rr * cos(a).toFloat()
                    val y = cy + rr * sin(a).toFloat()
                    if (k == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                c.drawPath(path, ring)
            }
            // The kilometres in the middle, "of 41" or "km" under them.
            val big = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = numerals; color = ink; textAlign = Paint.Align.CENTER; textSize = 30 * dp }
            val text = String.format(java.util.Locale.getDefault(), "%.1f", km)
            c.drawText(text, cx, cy + 6 * dp, big)
            val small = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = muted; textAlign = Paint.Align.CENTER; textSize = 11 * dp }
            c.drawText(if (goal > 0) str(R.string.widget_of_km, String.format(java.util.Locale.getDefault(), "%.0f", goal)) else str(R.string.common_km_unit), cx, cy + 20 * dp, small)

            // A bar a day, Monday to Sunday, as on Today.
            val n = min(7, days.length())
            val top = h - 44 * dp
            val bottom = h - 18 * dp
            val gapX = 4 * dp
            val bw = (w - gapX * (n - 1)) / n
            val most = max(1.0, (0 until n).maxOf { days.optJSONObject(it)?.optDouble("km", 0.0) ?: 0.0 })
            val fill = Paint(Paint.ANTI_ALIAS_FLAG)
            for (k in 0 until n) {
                val o = days.optJSONObject(k) ?: continue
                val x = k * (bw + gapX)
                val corner = min(bw / 2, 5 * dp)
                fill.color = trackHigh
                c.drawRoundRect(RectF(x, top, x + bw, bottom), corner, corner, fill)
                val dk = o.optDouble("km", 0.0)
                if (dk > 0) {
                    val hh = max(corner * 2, ((dk / most) * (bottom - top)).toFloat())
                    fill.color = if (o.optBoolean("today")) accent else if (o.optBoolean("future")) track else (accent and 0x00FFFFFF) or (0x8C shl 24)
                    c.drawRoundRect(RectF(x, bottom - hh, x + bw, bottom), corner, corner, fill)
                }
                // Its letter under it (today's in the colour), as on Today.
                val letter = runCatching { (o.optString("date").takeIf { it.length >= 10 }?.let { java.time.LocalDate.parse(it.take(10)).dayOfWeek } ?: java.time.DayOfWeek.of(k + 1)).getDisplayName(java.time.format.TextStyle.NARROW, java.util.Locale.getDefault()) }.getOrDefault("")
                val lp = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = if (o.optBoolean("today")) accent else muted; textAlign = Paint.Align.CENTER; textSize = 10 * dp; if (o.optBoolean("today")) typeface = Typeface.DEFAULT_BOLD }
                c.drawText(letter, x + bw / 2, h - 4 * dp, lp)
            }
            return bmp
        }
    }
}
