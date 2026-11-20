package dev.freesuunto.app.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.graphics.drawable.IconCompat
import dev.freesuunto.app.MainActivity
import dev.freesuunto.app.R
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Live Updates (Android 16 and later; promoted ongoing notifications): what's happening right now,
 * as a chip in the status bar, at the top of the shade and on the lock screen, in Tartan's red
 * with its own glyphs.
 *
 *  - A run being recorded: distance in the chip, time, pace and heart rate, progress towards the
 *    planned distance with a mark at each kilometre, Pause or Resume. It is the recording
 *    service's own notification (the same id), so there's only ever one.
 *  - A watch backup: its files as progress.
 *  - The coach answering while you're elsewhere; then "Your coach answered" (its words hidden on
 *    the lock screen unless Android shows private content there).
 *
 * On older Android they're ordinary notifications with the same content. Nothing is shown when
 * notifications are off for Tartan.
 */
object LiveUpdates {
    /** Tartan's red (the reminders' iconColor in capacitor.config.ts). */
    const val BRAND = 0xFFA8321F.toInt()
    private const val GOLD = 0xFFF2B33D.toInt()

    /** The recording service's notification and channel (@capacitor-community/background-geolocation). */
    private const val RUN_ID = 28351
    private const val RUN_CHANNEL = "com.equimaps.capacitor_background_geolocation"
    private const val WATCH_ID = 4202
    private const val COACH_ID = 4203
    private const val ANSWER_ID = 4204
    private const val LIVE_CHANNEL = "tartan-live"
    private const val COACH_CHANNEL = "tartan-coach"

    const val EXTRA_OPEN = "tartan.open"
    const val ACTION_RUN = "dev.freesuunto.app.RUN"
    const val EXTRA_RUN = "tartan.run"

    private var lastRun = 0L
    private var lastRunStatus: String? = null

    private fun channels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(LIVE_CHANNEL) == null) nm.createNotificationChannel(
            NotificationChannel(LIVE_CHANNEL, str(R.string.live_happening_now), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = str(R.string.live_a_watch_backup_or_the_coach)
                setSound(null, null); enableVibration(false); lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            },
        )
        if (nm.getNotificationChannel(COACH_CHANNEL) == null) nm.createNotificationChannel(
            NotificationChannel(COACH_CHANNEL, str(R.string.live_coach_s_answers), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = str(R.string.live_when_the_coach_has_answered_and)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            },
        )
    }

    private fun can(context: Context) = NotificationManagerCompat.from(context).areNotificationsEnabled()

    private fun post(context: Context, id: Int, n: android.app.Notification) {
        runCatching { NotificationManagerCompat.from(context).notify(id, n) }
    }

    private fun cancel(context: Context, id: Int) = runCatching { NotificationManagerCompat.from(context).cancel(id) }

    /** Opens Tartan at `where` (record, chat, settings). */
    private fun open(context: Context, where: String, code: Int): PendingIntent =
        PendingIntent.getActivity(
            context, code,
            Intent(context, MainActivity::class.java).putExtra(EXTRA_OPEN, where).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun runAction(context: Context, what: String, code: Int): PendingIntent =
        PendingIntent.getBroadcast(context, code, Intent(context, RunActions::class.java).setAction(ACTION_RUN).putExtra(EXTRA_RUN, what), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun base(context: Context, channel: String, glyph: Int) = NotificationCompat.Builder(context, channel)
        .setSmallIcon(glyph)
        .setColor(BRAND)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setRequestPromotedOngoing(true)

    private fun clock(s: Long): String = if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)

    /**
     * The run, as the recorder has it (each fix, about once a second; drawn at most every three
     * seconds unless it paused, resumed or ended). Gone when the recording is.
     */
    fun run(context: Context, r: RecNow) {
        val live = r.status == "recording" || r.status == "paused"
        if (!live) { lastRunStatus = r.status; return }
        val now = System.currentTimeMillis()
        if (r.status == lastRunStatus && now - lastRun < 3000) return
        lastRun = now
        lastRunStatus = r.status
        if (!can(context)) return
        val km = r.distance / 1000
        val moving = r.moving(now)
        val paused = r.status == "paused"
        val pace = if (km >= 0.05) (moving / km).roundToInt() else null
        val title = if (paused) str(R.string.live_paused_km, "%.2f".format(Locale.getDefault(), km)) else str(R.string.common_n_km, "%.2f".format(Locale.getDefault(), km))
        // Running, the time ticks by itself (the system's clock, every second, no updates needed);
        // paused, it stands, in the line.
        val text = listOfNotNull(if (paused) clock(moving) else null, pace?.let { str(R.string.common_per_km, "%d:%02d".format(it / 60, it % 60)) }, r.bpm?.let { str(R.string.common_n_bpm, it) }).joinToString(" · ").ifEmpty { str(R.string.live_getting_a_gps_fix) }
        // A guided run: the step and what's left of it lead.
        val g = r.guide?.takeIf { !it.done }
        val b = base(context, RUN_CHANNEL, R.drawable.ic_live_run)
            .setCategory(NotificationCompat.CATEGORY_WORKOUT)
            .setContentTitle(g?.let { listOfNotNull(it.label, it.left).joinToString(" · ") } ?: title)
            .setContentText(g?.let { "$title · ${it.detail}" } ?: text)
            .setSubText(g?.name ?: r.planTitle ?: str(R.string.common_your_run))
            .setShortCriticalText(if (paused) str(R.string.common_paused) else str(R.string.common_n_km, "%.1f".format(Locale.getDefault(), km)))
            .setShowWhen(!paused)
            .setUsesChronometer(!paused)
            .setWhen(now - moving * 1000)
            .setContentIntent(open(context, "record", 1))
            .addAction(if (paused) R.drawable.ic_live_run else R.drawable.ic_live_run, if (paused) str(R.string.common_resume) else str(R.string.common_pause), runAction(context, if (paused) "resume" else "pause", 2))
        // Towards the plan's distance: the way done in red, a mark at each kilometre.
        val goal = r.goalKm?.takeIf { it > 0.2 }
        if (goal != null) {
            val total = (goal * 1000).roundToInt()
            val style = NotificationCompat.ProgressStyle()
                .setStyledByProgress(true)
                .setProgressSegments(listOf(NotificationCompat.ProgressStyle.Segment(total).setColor(BRAND)))
                .setProgress(r.distance.roundToInt().coerceIn(0, total))
                .setProgressTrackerIcon(IconCompat.createWithResource(context, R.drawable.ic_live_run))
            (1 until goal.toInt().coerceAtMost(40)).forEach { k -> style.addProgressPoint(NotificationCompat.ProgressStyle.Point(k * 1000).setColor(GOLD)) }
            b.setStyle(style)
            b.setContentText(str(R.string.live_km_of, text, "%.1f".format(Locale.getDefault(), goal)))
        }
        post(context, RUN_ID, b.build())
    }

    /** A watch backup under way (its files as progress); gone when it's done. */
    fun watch(context: Context, job: WatchNow.Job?) {
        if (job == null) { cancel(context, WATCH_ID); return }
        channels(context)
        if (!can(context)) return
        val max = job.max?.takeIf { it > 0 }
        val style = NotificationCompat.ProgressStyle()
            .setStyledByProgress(true)
            .setProgressTrackerIcon(IconCompat.createWithResource(context, R.drawable.ic_live_watch))
        if (max != null) style.setProgressSegments(listOf(NotificationCompat.ProgressStyle.Segment(max.roundToInt().coerceAtLeast(1)).setColor(BRAND))).setProgress((job.value ?: 0.0).roundToInt())
        else style.setProgressIndeterminate(true)
        val b = base(context, LIVE_CHANNEL, R.drawable.ic_live_watch)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentTitle(job.title.ifEmpty { str(R.string.live_backing_up_your_watch) })
            .setContentText(job.text)
            .setShortCriticalText(if (max != null) "${(job.value ?: 0.0).roundToInt()}/${max.roundToInt()}" else str(R.string.common_watch))
            .setContentIntent(open(context, "settings", 3))
            .setStyle(style)
        post(context, WATCH_ID, b.build())
    }

    /** The coach at work while you're elsewhere (a question can take a minute or two). */
    fun coachWorking(context: Context, on: Boolean) {
        // Android 14 and later: a short service keeps Tartan running until the answer is in (a few
        // minutes at most), so leaving the app doesn't pause it midway ("Failed to fetch").
        if (!on) {
            if (Build.VERSION.SDK_INT >= 34) runCatching { context.stopService(Intent(context, CoachService::class.java)) }
            cancel(context, COACH_ID)
            return
        }
        channels(context)
        if (Build.VERSION.SDK_INT >= 34 && runCatching { context.startForegroundService(Intent(context, CoachService::class.java)) }.isSuccess) return
        if (!can(context)) return
        post(context, COACH_ID, coachNotification(context))
    }

    /** The coach at work, as a Live Update (and the short service's own notification). */
    fun coachNotification(context: Context): android.app.Notification {
        channels(context)
        return base(context, LIVE_CHANNEL, R.drawable.ic_live_coach)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentTitle(str(R.string.live_your_coach_is_answering))
            .setContentText(str(R.string.live_it_s_reading_your_training_you))
            .setShortCriticalText(str(R.string.common_coach))
            .setContentIntent(open(context, "chat", 4))
            .setStyle(NotificationCompat.ProgressStyle().setProgressIndeterminate(true).setProgressTrackerIcon(IconCompat.createWithResource(context, R.drawable.ic_live_coach)))
            .build()
    }

    const val COACH_NOTIFICATION = COACH_ID

    /** The answer came while you were elsewhere: the start of it, the rest in the chat. */
    fun coachAnswered(context: Context, text: String, by: String?) {
        cancel(context, COACH_ID)
        channels(context)
        if (!can(context) || text.isBlank()) return
        val plain = text.replace(Regex("[*_#`>]"), "").trim()
        val hidden = NotificationCompat.Builder(context, COACH_CHANNEL).setSmallIcon(R.drawable.ic_live_coach).setColor(BRAND).setContentTitle(str(R.string.live_your_coach_answered)).build()
        val b = NotificationCompat.Builder(context, COACH_CHANNEL)
            .setSmallIcon(R.drawable.ic_live_coach)
            .setColor(BRAND)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentTitle(str(R.string.live_your_coach_answered))
            .setContentText(plain.take(120))
            .setSubText(by)
            .setStyle(NotificationCompat.BigTextStyle().bigText(plain.take(600)))
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(hidden)
            .setContentIntent(open(context, "chat", 5))
        post(context, ANSWER_ID, b.build())
    }
}

/** Pause and Resume from the run's notification (on the lock screen too), without opening the app. */
class RunActions : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        TartanShellPlugin.runAction(intent.getStringExtra(LiveUpdates.EXTRA_RUN) ?: return)
    }
}

/**
 * Keeps Tartan running while the coach finishes an answer you left (Android 14 and later: a
 * "short service", a few minutes at most, no extra permission). Without it Android may pause the
 * app in the background, and the coach's next request to its model breaks off. Stopped when the
 * answer is in, or by Android at its time limit.
 */
class CoachService : android.app.Service() {
    override fun onBind(intent: Intent?): android.os.IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = LiveUpdates.coachNotification(this)
        runCatching {
            if (Build.VERSION.SDK_INT >= 34) startForeground(LiveUpdates.COACH_NOTIFICATION, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE)
            else startForeground(LiveUpdates.COACH_NOTIFICATION, n)
        }.onFailure { stopSelf() }
        return START_NOT_STICKY
    }

    /** Android's time limit for a short service: stop (the answer may still come if the app is opened). */
    override fun onTimeout(startId: Int) = stopSelf()
    override fun onTimeout(startId: Int, fgsType: Int) = stopSelf()
}
