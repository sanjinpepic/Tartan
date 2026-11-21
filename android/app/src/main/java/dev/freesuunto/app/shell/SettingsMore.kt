package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

data class BackupNow(val pass: Boolean, val weekly: Boolean, val last: Long?, val where: String?, val failed: String?, val min: Int)
data class Recorder(val armed: Boolean, val recording: Boolean, val last: String?)

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }

/** Settings → More's own parts (web/views/backup.ts, settings.ts): backups, the intro, the recorder and the log. */
class MoreModel(private val scope: CoroutineScope, private val api: SettingsApi) {
    var backup by mutableStateOf<BackupNow?>(null)
    var recorder by mutableStateOf<Recorder?>(null)
    var log by mutableStateOf<String?>(null)
    var version by mutableStateOf("")
    var busy by mutableStateOf<String?>(null)
    var said by mutableStateOf<String?>(null)
    /** A backup came back: the app starts again with it. */
    var restored by mutableStateOf(false)

    fun ensure() = scope.launch { backup(JSONObject().put("op", "state")); recorder("state") }

    private suspend fun backup(args: JSONObject): Boolean {
        val r = api.call("backup", args)
        r.onFailure { said = it.message }
        val o = r.getOrNull()?.let { JSONObject(it) } ?: return false
        backup = BackupNow(o.optBoolean("pass"), o.optBoolean("weekly"), o.optLong("last").takeIf { it > 0 }, o.text("where"),
            o.optJSONObject("failed")?.let { str(R.string.settings_weekly_backup_failed, ago(java.time.Instant.ofEpochMilli(it.optLong("at")).toString()), it.optString("text")) }, o.optInt("min", 8))
        o.text("said")?.let { said = it }
        if (o.optBoolean("restored")) restored = true
        return true
    }

    fun backupDo(op: String, extra: JSONObject.() -> Unit = {}) {
        busy = "backup"
        scope.launch { backup(JSONObject().put("op", op).apply(extra)); busy = null }
    }

    fun restore(name: String, bytes: ByteArray, pass: String) {
        busy = "restore"
        scope.launch {
            val b64 = withContext(Dispatchers.Default) { Base64.encodeToString(bytes, Base64.NO_WRAP) }
            backup(JSONObject().put("op", "restore").put("name", name).put("data", b64).put("pass", pass))
            busy = null
        }
    }

    fun recorder(op: String) = scope.launch {
        api.call("recorder", JSONObject().put("op", op)).fold({ j ->
            val o = JSONObject(j)
            val l = o.optJSONObject("last")
            recorder = Recorder(o.optBoolean("armed"), o.optBoolean("recording"), l?.let { str(R.string.settings_last_recording, it.optString("name"), ago(it.optString("started")), bytes(it.optDouble("bytes"))) })
        }, { said = it.message })
    }

    fun readLog() = scope.launch {
        api.rpc("log")?.let { j -> JSONObject(j).let { log = it.optString("text"); version = str(R.string.common_version_build, it.optString("version"), it.optString("build")) } }
    }

    fun replayIntro() = scope.launch { api.call("replayIntro") }
}

private fun bytes(n: Double) = if (n < 1024) "${n.toInt()} B" else if (n < 1024 * 1024) str(R.string.settings_kb, Math.round(n / 1024)) else str(R.string.settings_mb, String.format(java.util.Locale.getDefault(), "%.1f", n / 1024 / 1024))

/** Backups: a passphrase (twice, written down), Back up now, every week by itself, restore. */
@Composable
fun BackupCard(m: MoreModel, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    LaunchedEffect(Unit) { m.ensure() }
    val b = m.backup ?: return
    var restoring by remember { mutableStateOf(false) }
    var file by remember { mutableStateOf<Pair<String, ByteArray>?>(null) }
    var pass by remember { mutableStateOf("") }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u: Uri? ->
        if (u == null) return@rememberLauncherForActivityResult
        file = runCatching {
            val name = context.contentResolver.query(u, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "backup.tartan"
            name to (context.contentResolver.openInputStream(u)?.use { it.readBytes() } ?: ByteArray(0))
        }.getOrNull()
    }
    SetCard(
        stringResource(R.string.settings_backups), "history",
        b.last?.let { stringResource(if (b.where == "Documents/Tartan") R.string.settings_last_backup_docs else R.string.settings_last_backup, ago(java.time.Instant.ofEpochMilli(it).toString())) } ?: stringResource(R.string.settings_no_backup_yet_if_this_phone),
        modifier,
    ) {
        if (!b.pass) {
            var a by remember { mutableStateOf("") }
            var again by remember { mutableStateOf("") }
            Text(stringResource(R.string.settings_backups_are_encrypted_with_a_passphrase, b.min), style = MaterialTheme.typography.bodyMedium)
            Field(stringResource(R.string.settings_passphrase), a, { a = it }, secret = true)
            Field(stringResource(R.string.settings_the_same_again), again, { again = it }, secret = true)
            val bad = if (a.isNotEmpty() && a.length < b.min) stringResource(R.string.settings_at_least_characters, b.min) else if (again.isNotEmpty() && a != again) stringResource(R.string.settings_the_two_don_t_match) else null
            bad?.let { Text(it, color = cs.error, style = MaterialTheme.typography.bodySmall) }
            Button(onClick = { m.backupDo("setPass") { put("pass", a) } }, enabled = bad == null && a.length >= b.min && a == again) { Text(stringResource(R.string.settings_set_passphrase)) }
        } else {
            Button(onClick = { m.backupDo("now") }, enabled = m.busy == null) { Icon(Glyphs["down"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(if (m.busy == "backup") stringResource(R.string.settings_backing_up) else stringResource(R.string.common_back_up_now)) }
            SwitchRow(stringResource(R.string.settings_every_week_by_itself), stringResource(R.string.settings_into_documents_tartan_on_this_phone), b.weekly) { on -> m.backupDo("weekly") { put("on", on) } }
            b.failed?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = LocalData.current.watch) }
            TextButton(onClick = { m.backupDo("change") }) { Text(stringResource(R.string.settings_change_passphrase)) }
        }
        TextButton(onClick = { restoring = !restoring }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(stringResource(R.string.settings_restore_from_a_backup)) }
        if (restoring) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = { pick.launch(arrayOf("*/*")) }) { Text(file?.first ?: stringResource(R.string.settings_pick_the_backup_file)) }
            Field(stringResource(R.string.settings_its_passphrase), pass, { pass = it }, secret = true)
            Text(stringResource(R.string.settings_what_s_in_the_backup_replaces), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            Button(onClick = { file?.let { (n, bytes) -> m.restore(n, bytes, pass) } }, enabled = file != null && pass.isNotEmpty() && m.busy == null) { Icon(Glyphs["undo"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(if (m.busy == "restore") stringResource(R.string.settings_restoring) else stringResource(R.string.settings_restore)) }
        }
    }
}

private val TOOLS get() = listOf(
    "get_overview" to str(R.string.settings_what_data_exists_activity_counts_sources),
    "get_takeaways" to str(R.string.settings_the_most_useful_things_to_know),
    "list_activities" to str(R.string.settings_every_workout_once_filtered_by_date),
    "get_activity" to str(R.string.settings_one_workout_laps_splits_best_efforts),
    "get_activity_streams" to str(R.string.settings_heart_rate_pace_cadence_power_altitude),
    "get_training_summary" to str(R.string.settings_totals_per_week_month_or_year),
    "get_training_load" to str(R.string.settings_fitness_fatigue_and_form_from_heart),
    "get_hr_zones" to str(R.string.settings_time_in_zones_for_a_workout),
    "get_efficiency_trend" to str(R.string.settings_easy_run_metres_per_heartbeat_week),
    "get_durability" to str(R.string.settings_how_well_the_effort_holds_on),
    "get_weather" to str(R.string.settings_the_forecast_at_each_planned_session),
    "get_best_efforts" to str(R.string.settings_personal_bests_per_distance),
    "get_athlete_profile" to str(R.string.settings_profile_totals_and_heart_rate_settings),
    "list_watch_files / read_watch_file" to str(R.string.settings_files_copied_off_the_watch),
    "get_week" to str(R.string.settings_one_week_day_by_day_against),
    "get_training_plan" to str(R.string.settings_the_plan_each_session_done_missed),
    "save_training_plan" to str(R.string.settings_write_or_change_the_plan_the),
    "mark_plan_session" to str(R.string.settings_tick_a_session_off_by_hand),
    "swap_plan_session" to str(R.string.settings_swap_a_session_on_the_day),
    "get_habits" to str(R.string.settings_what_puts_you_off_and_your_habits),
    "log_workout / remove_logged_workout" to str(R.string.settings_log_a_workout_nothing_recorded),
    "set_training_availability" to str(R.string.settings_days_hours_and_long_run_day),
    "get_training_times / set_training_times" to str(R.string.settings_when_you_usually_train_reminders_and),
    "export_training_plan_csv / _ics / reset_training_plan" to str(R.string.settings_export_the_plan_or_its_calendar),
    "list_routes / get_route / save_route" to str(R.string.settings_your_routes_as_points_or_gpx),
    "list_watch_faces / save_watch_face" to str(R.string.settings_watch_faces_from_the_face_builder),
    "sync_strava / backup_watch" to str(R.string.settings_pull_new_data_in),
)

/** Advanced: AI agents (on the PC), the watch face builder, the watch recorder, the activity log. */
@Composable
fun AdvancedCard(m: MoreModel, modifier: Modifier, faces: WatchGroupModel? = null, go: (String) -> Unit = {}) {
    val cs = MaterialTheme.colorScheme
    val clip = LocalClipboardManager.current
    SetCard(stringResource(R.string.settings_advanced), "settings", null, modifier) {
        var agents by remember { mutableStateOf(false) }
        TextButton(onClick = { agents = !agents }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(stringResource(R.string.settings_ai_agents_mcp)) }
        if (agents) Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.settings_give_claude_code_claude_desktop_cursor), style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.settings_agents_connect_to_tartan_on_a), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            TOOLS.forEach { (n, d) -> Column { Text(n, style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace); Text(d, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) } }
        }
        // The face builder: kept, but out of the way (Settings → Watch keeps the week on a face).
        if (faces != null) {
            var builder by remember { mutableStateOf(false) }
            TextButton(onClick = { builder = !builder }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(stringResource(R.string.settings_watch_face_builder)) }
            if (builder) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.settings_design_your_own_watch_faces_colours), style = MaterialTheme.typography.bodyMedium)
                FaceList(faces, go)
            }
        }
        // Which step runner guided workouts carry, in the owner's build only (Settings → Watch until
        // 2.57): Suunto's, proven on the owner's watch, by default; Tartan's own, the public build's, to try.
        if (faces != null) {
            LaunchedEffect(Unit) { faces.readRunner() }
            faces.runner?.let { r ->
                var runner by remember { mutableStateOf(false) }
                TextButton(onClick = { runner = !runner }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(stringResource(R.string.settings_step_runner)) }
                if (runner) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.settings_suunto_s_is_proven_on_your), style = MaterialTheme.typography.bodyMedium)
                    Segmented(listOf(stringResource(R.string.settings_suunto_s), stringResource(R.string.settings_tartan_s_own)), if (r == "tartan") 1 else 0, { k -> faces.pickRunner(if (k == 1) "tartan" else "suunto") })
                }
            }
        }
        var rec by remember { mutableStateOf(false) }
        TextButton(onClick = { rec = !rec; if (rec) m.recorder("state") }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(stringResource(R.string.settings_watch_recorder)) }
        if (rec) Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.settings_when_something_goes_wrong_with_the), style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.settings_it_includes_what_the_watch_sends), style = MaterialTheme.typography.bodySmall, color = LocalData.current.watch)
            m.recorder?.let { r ->
                Text(if (r.recording) stringResource(R.string.settings_recording_this_connection_it_s_saved) else if (r.armed) stringResource(R.string.settings_waiting_the_next_connection_to_the) else r.last ?: stringResource(R.string.settings_nothing_recorded_yet), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                ButtonFlow {
                    FilledTonalButton(onClick = { m.recorder(if (r.armed) "cancel" else "arm") }, enabled = !r.recording) { ButtonText(if (r.armed) stringResource(R.string.common_cancel) else stringResource(R.string.settings_record_the_next_connection)) }
                    if (r.last != null && !r.recording) TextButton(onClick = { m.recorder("share") }) { ButtonText(stringResource(R.string.settings_share_recording)) }
                }
            }
        }
        var log by remember { mutableStateOf(false) }
        TextButton(onClick = { log = !log; if (log) m.readLog() }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(stringResource(R.string.settings_activity_log)) }
        if (log) Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                m.log?.ifEmpty { null } ?: stringResource(R.string.settings_nothing_logged_in_this_session_yet),
                fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 15.sp,
                modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).clip(RoundedCornerShape(14.dp)).background(cs.surfaceContainerHigh).verticalScroll(rememberScrollState(Int.MAX_VALUE)).horizontalScroll(rememberScrollState()).padding(12.dp),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                FilledTonalButton(onClick = { clip.setText(AnnotatedString("Tartan ${m.version}\n${m.log ?: ""}")); m.said = str(R.string.settings_log_copied_paste_it_wherever_you) }) { Text(stringResource(R.string.settings_copy_log)) }
                Text(m.version, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, modifier = Modifier.padding(start = 12.dp))
            }
        }
    }
}

/**
 * Feedback for Tartan's developer: an issue on GitHub, filled in with the version, Android and the
 * phone (you see and edit it before sending), and the activity log as a file to attach. Nothing
 * leaves the phone unless you send it.
 */
@Composable
fun FeedbackCard(m: MoreModel, modifier: Modifier) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val uri = androidx.compose.ui.platform.LocalUriHandler.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    SetCard(stringResource(R.string.settings_send_feedback), "send", stringResource(R.string.settings_you_see_everything_before_it_s), modifier) {
        ButtonFlow {
            FilledTonalButton(onClick = {
                val about = str(R.string.settings_tartan_android, Feedback.version(context), android.os.Build.VERSION.RELEASE, android.os.Build.MANUFACTURER, android.os.Build.MODEL)
                runCatching { uri.openUri(Feedback.issue("", str(R.string.settings_what_happened_or_what_would_help, about))) }
            }) { ButtonText(stringResource(R.string.settings_write_to_the_developer)) }
            TextButton(onClick = {
                scope.launch {
                    m.readLog().join()
                    runCatching {
                        val dir = java.io.File(context.cacheDir, "share").apply { mkdirs() }
                        val f = java.io.File(dir, "tartan-log.txt").apply { writeText("Tartan ${m.version}\n\n${m.log ?: ""}") }
                        val u = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", f)
                        val send = android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_STREAM, u).addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        context.startActivity(android.content.Intent.createChooser(send, str(R.string.settings_share_the_log)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
                    }.onFailure { m.said = str(R.string.settings_couldn_t_share_the_log, it.message) }
                }
            }) { Text(stringResource(R.string.settings_share_the_log)) }
        }
        Text(stringResource(R.string.settings_the_log_lists_connections_syncs_and), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
