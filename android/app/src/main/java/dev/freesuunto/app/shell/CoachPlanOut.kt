package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Where the plan goes for the athlete's watch, picked in Settings → Sources (Plan on your watch):
 * "suunto" (over Bluetooth, the default), "intervals" (intervals.icu passes it to Garmin and the
 * others it links), "hc" (Health Connect's planned workouts, for Samsung, Pixel and others) or
 * "files" (.fit workout files for any watch's app). Kept on the phone only; the engine's calls are
 * the same as before (watchWeek, planOut).
 */
object PlanDest {
    private const val KEY = "dest"
    val ALL = listOf("suunto", "intervals", "hc", "files")
    private fun prefs(c: Context) = c.getSharedPreferences("tartan.plan", Context.MODE_PRIVATE)
    /** Bumped on a change, so what shows with the choice (intervals.icu in Sources) follows it at once. */
    private var changes by mutableStateOf(0)
    fun get(c: Context): String { changes; return prefs(c).getString(KEY, null)?.takeIf { it in ALL } ?: "suunto" }
    fun set(c: Context, v: String) { prefs(c).edit().putString(KEY, v).apply(); changes++ }
}

/** What the coming week looks like where it goes, in a few words, and the one thing to do. */
private data class Out(val line: String, val done: Boolean, val button: String?, val op: String?)

/** The coming week where the plan goes, from watchWeek (Suunto) or planOut (the others). Null: nothing to show. */
private fun outOf(dest: String, s: JSONObject): Out? = when (dest) {
    "suunto" -> if (!s.optBoolean("canBluetooth") || s.optInt("wanted") == 0) null else {
        val on = s.optInt("onWatch"); val want = s.optInt("wanted")
        Out(str(R.string.coach_on_your_watch_of, on, want), on >= want, if (on >= want) str(R.string.coach_send_again) else str(R.string.common_send), "send")
    }
    "intervals" -> s.optJSONObject("intervals").let { i ->
        when {
            s.optInt("wanted") == 0 -> null
            i?.optBoolean("connected") != true -> Out("intervals.icu isn't connected", false, str(R.string.coach_set_up), "go:settings/sources")
            i.optBoolean("on") -> Out(str(R.string.coach_on_intervals_icu_kept_up_to), true, str(R.string.coach_send_again), "intervals")
            else -> Out(str(R.string.coach_not_on_intervals_icu_yet), false, str(R.string.common_send), "intervals")
        }
    }
    "hc" -> s.optJSONObject("hc").let { h ->
        when {
            s.optInt("wanted") == 0 || h?.optString("status") != "available" -> null
            h.optBoolean("plan") -> Out(str(R.string.coach_in_health_connect_kept_up_to), true, str(R.string.coach_send_again), "hc")
            else -> Out(str(R.string.coach_not_in_health_connect_yet), false, str(R.string.common_send), "hc")
        }
    }
    else -> if (s.optInt("wanted") == 0) null else Out(str(R.string.coach_the_week_as_fit_files), false, str(R.string.common_save), "files")
}

/**
 * The Coach tab's one quiet line about the watch: the coming week where the athlete's plan goes
 * (Settings → Sources → Plan on your watch), and Send. What came of it goes to `say`.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun WatchLine(actions: CoachActions, today: String, modifier: Modifier = Modifier, say: (String) -> Unit, watch: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    val dest = PlanDest.get(LocalContext.current)
    // A Suunto's line only with a watch in use (src/in-use.ts): the default choice isn't a watch you have.
    if (dest == "suunto" && !watch) return
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<JSONObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    val read: suspend () -> JSONObject? = { if (dest == "suunto") actions.watchWeek(false) else actions.planOut("state") }
    LaunchedEffect(today, dest) { state = read() }
    val o = state?.let { outOf(dest, it) } ?: return
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Icon(Glyphs[if (o.done) "check" else "watch"], null, Modifier.size(18.dp), tint = if (o.done) LocalData.current.good else cs.onSurfaceVariant)
        Text(o.line, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 8.dp))
        if (o.button != null && o.op != null) TextButton(onClick = {
            if (o.op.startsWith("go:")) { actions.go(o.op.removePrefix("go:")); return@TextButton }
            busy = true
            scope.launch {
                val r = if (dest == "suunto") actions.watchWeek(true) else actions.planOut(o.op)
                say(r?.optString("error")?.ifEmpty { null } ?: r?.optString("line")?.ifEmpty { null } ?: if (dest == "suunto") str(R.string.coach_couldn_t_reach_the_watch_keep) else str(R.string.common_it_didn_t_go_through_try))
                state = read()
                busy = false
            }
        }, enabled = !busy) { if (busy) LoadingIndicator(Modifier.size(20.dp)) else Text(o.button) }
    }
}

/**
 * Settings → Sources: where the plan goes for your watch. A Suunto takes it over Bluetooth;
 * intervals.icu passes it to Garmin and the others it links; Health Connect holds it for Samsung,
 * Pixel and other watch apps; any watch's app opens .fit files. The Coach tab sends to the choice.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PlanWatchCard(api: SettingsApi, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var dest by remember { mutableStateOf(PlanDest.get(context)) }
    var out by remember { mutableStateOf<JSONObject?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var line by remember { mutableStateOf<String?>(null) }
    val state: suspend () -> JSONObject? = { api.call("planOut", JSONObject().put("op", "state")).getOrNull()?.let { runCatching { JSONObject(it) }.getOrNull() } }
    LaunchedEffect(Unit) { out = state() }
    val run: (String) -> Unit = { op ->
        busy = op
        scope.launch {
            val r = api.call("planOut", JSONObject().put("op", op)).fold({ runCatching { JSONObject(it) }.getOrNull() }, { JSONObject().put("error", it.message) })
            line = r?.optString("error")?.ifEmpty { null } ?: r?.optString("line")?.ifEmpty { null } ?: str(R.string.common_it_didn_t_go_through_try)
            if (r != null && !r.has("error")) out = r
            busy = null
        }
    }
    val icu = out?.optJSONObject("intervals")
    val hc = out?.optJSONObject("hc")
    SetCard(stringResource(R.string.coach_plan_on_your_watch), "watch", null, modifier) {
        val choices = listOfNotNull(
            Choice("suunto", "Suunto", stringResource(R.string.coach_over_bluetooth_as_guided_workouts)),
            Choice("intervals", stringResource(R.string.coach_garmin_and_others), stringResource(R.string.coach_through_intervals_icu_which_passes_it)),
            Choice("hc", stringResource(R.string.coach_samsung_pixel_and_others), stringResource(R.string.coach_as_planned_workouts_in_health_connect)).takeIf { hc?.optString("status") == "available" || dest == "hc" },
            Choice("files", stringResource(R.string.coach_any_watch), stringResource(R.string.coach_the_week_as_fit_files_to)),
        )
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            choices.forEachIndexed { k, c ->
                ChoiceRow(c, c.id == dest, first = k == 0, last = k == choices.lastIndex) { dest = c.id; line = null; PlanDest.set(context, c.id) }
            }
        }
        @Composable
        fun Act(button: String, op: String, stop: String? = null, on: Boolean = false) {
            ButtonFlow {
                FilledTonalButton(onClick = { run(op) }, enabled = busy == null, shapes = ButtonDefaults.shapes()) { if (busy == op) LoadingIndicator(Modifier.size(20.dp)) else ButtonText(button) }
                if (on && stop != null) TextButton(onClick = { run(stop) }, enabled = busy == null) { if (busy == stop) LoadingIndicator(Modifier.size(20.dp)) else ButtonText(stringResource(R.string.common_stop)) }
            }
        }
        when (dest) {
            "intervals" -> when {
                icu?.optBoolean("connected") != true -> Text(stringResource(R.string.coach_connect_intervals_icu_above_first), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                else -> { if (icu.optBoolean("on")) Text(stringResource(R.string.coach_kept_up_to_date_on_intervals), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant); Act(stringResource(R.string.common_send), "intervals", "intervalsOff", icu.optBoolean("on")) }
            }
            "hc" -> { if (hc?.optBoolean("plan") == true) Text(stringResource(R.string.coach_kept_up_to_date_in_health), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant); Act(stringResource(R.string.common_send), "hc", "hcOff", hc?.optBoolean("plan") == true) }
            "files" -> Act(stringResource(R.string.common_save), "files")
            else -> {}
        }
        // Kept up to date somewhere else as well (picked before, or Health Connect's own switch until
        // 2.57): said, with Stop, so it can be turned off from here.
        @Composable
        fun Also(text: String, stop: String) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(text, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, modifier = Modifier.weight(1f))
                TextButton(onClick = { run(stop) }, enabled = busy == null) { if (busy == stop) LoadingIndicator(Modifier.size(20.dp)) else Text(stringResource(R.string.common_stop)) }
            }
        }
        if (dest != "intervals" && icu?.optBoolean("on") == true) Also(stringResource(R.string.coach_also_kept_up_to_date_on), "intervalsOff")
        if (dest != "hc" && hc?.optBoolean("plan") == true) Also(stringResource(R.string.coach_also_kept_up_to_date_in), "hcOff")
        line?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(cs.surfaceContainerHigh).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Glyphs["info"], null, Modifier.size(16.dp), tint = cs.onSurfaceVariant)
            Text(stringResource(R.string.coach_apple_watch_takes_workouts_only_from), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
        }
    }
}
