package dev.freesuunto.app.shell

import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearWavyProgressIndicator
import androidx.compose.material3.LoadingIndicator
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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** A picture from the page (a data URL) as an image. */
suspend fun picture(url: String?): ImageBitmap? = url?.let { u ->
    withContext(Dispatchers.Default) { runCatching { Base64.decode(u.substringAfter(","), Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }.getOrNull() }
}

data class FaceItem(val id: String, val name: String, val builtin: Boolean, val onWatch: Boolean, val picture: ImageBitmap?)
data class Fuel(val drink: Boolean, val drinkMin: Int, val gel: Boolean, val gelMin: Int, val fromMin: Int)
data class WeekFace(val picture: ImageBitmap?, val bases: List<Pair<String, String>>, val base: String, val keep: Boolean)

/** Settings → Watch (web/views/watch-settings.ts): guided workouts' reminders, the week on a face, routes; and the face builder's list (FaceList, under More → Advanced). */
class WatchGroupModel(private val scope: CoroutineScope, private val api: SettingsApi) {
    var faces by mutableStateOf<List<FaceItem>?>(null)
    var canBluetooth by mutableStateOf(true)
    var onWatch by mutableStateOf<Pair<Int, List<Pair<String, String>>>?>(null)
    var fuel by mutableStateOf<Fuel?>(null)
    var runner by mutableStateOf<String?>(null)
    var week by mutableStateOf<WeekFace?>(null)
    var noWeek by mutableStateOf(false)
    var busy by mutableStateOf<String?>(null)
    var said by mutableStateOf<String?>(null)
    var weekLine by mutableStateOf<String?>(null)
    private var read = false

    fun forget() { read = false }

    fun ensure() {
        if (read) return
        read = true
        scope.launch {
            api.rpc("fuel")?.let { readFuel(it) }
            readRunner()
            api.rpc("faces", JSONObject().put("size", 160))?.let { j ->
                val o = JSONObject(j)
                canBluetooth = o.optBoolean("canBluetooth", true)
                val a = o.optJSONArray("faces")
                faces = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { f ->
                    FaceItem(f.optString("id"), f.optString("name"), f.optBoolean("builtin"), f.optBoolean("onWatch"), picture(f.optString("picture").ifEmpty { null }))
                }
            }
            weekFace(JSONObject())
        }
    }

    private fun readFuel(j: String) = JSONObject(j).let { fuel = Fuel(it.optBoolean("drink"), it.optInt("drinkMin", 15), it.optBoolean("gel"), it.optInt("gelMin", 40), it.optInt("fromMin", 75)) }

    fun setFuel(change: JSONObject) {
        scope.launch { api.rpc("fuel", JSONObject().put("set", change))?.let { readFuel(it) } }
    }

    /** The step runner (owner's build only; null in the public build), for Settings → More → Advanced. */
    suspend fun readRunner() { api.rpc("runner")?.let { r -> JSONObject(r).let { runner = if (it.optBoolean("public")) null else it.optString("choice") } } }

    fun pickRunner(c: String) {
        runner = c
        scope.launch { api.rpc("runner", JSONObject().put("set", c)) }
    }

    private suspend fun weekFace(args: JSONObject) {
        val r = api.call("weekFace", args.put("size", 296))
        r.onFailure { said = it.message }
        val j = r.getOrNull() ?: return
        if (j == "null") { noWeek = true; return }
        val o = JSONObject(j)
        val bases = o.optJSONArray("bases")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { it.optString("id") to it.optString("name") } } ?: emptyList()
        week = WeekFace(picture(o.optString("picture")), bases, o.optString("base"), o.optBoolean("keep"))
        if (!o.isNull("said")) weekLine = o.optString("said")
    }

    fun weekBase(id: String) = scope.launch { weekFace(JSONObject().put("base", id)) }
    fun weekKeep(on: Boolean) { week = week?.copy(keep = on); scope.launch { weekFace(JSONObject().put("keep", on)) } }
    fun weekSend() {
        busy = "week"
        weekLine = str(R.string.settings_drawing_the_face_and_sending_it)
        scope.launch { weekFace(JSONObject().put("send", true)); busy = null }
    }

    fun install(f: FaceItem) {
        busy = f.id
        scope.launch {
            api.call("faceInstall", JSONObject().put("id", f.id).put("builtin", f.builtin)).fold({ said = str(R.string.settings_is_on_your_watch, f.name) }, { said = it.message })
            busy = null
            read = false
            ensure()
        }
    }

    fun check() {
        busy = "check"
        scope.launch {
            api.call("facesOnWatch").fold({ j ->
                val o = JSONObject(j)
                val a = o.optJSONArray("mine")
                onWatch = o.optInt("total") to (if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { it.optString("id") to it.optString("name") })
            }, { said = it.message })
            busy = null
        }
    }

    fun remove(id: String, name: String) {
        busy = id
        scope.launch {
            api.call("faceRemove", JSONObject().put("id", id).put("name", name)).fold({ r ->
                said = if (r == "true") str(R.string.settings_is_off_your_watch, name) else str(R.string.settings_wasn_t_on_your_watch, name)
                onWatch = onWatch?.let { (n, l) -> (n - 1) to l.filter { it.first != id } }
            }, { said = it.message })
            busy = null
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun WatchGroup(m: WatchGroupModel, go: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { m.ensure() }
    var i = 0
    m.fuel?.let { f ->
        SetCard(stringResource(R.string.settings_guided_workouts), "watch", stringResource(R.string.settings_drink_and_gel_reminders_on_sessions, f.fromMin), Modifier.reveal(i++)) {
            SwitchRow(stringResource(R.string.settings_drink_reminders), if (f.drink) stringResource(R.string.settings_a_few_sips_every_minutes, f.drinkMin) else stringResource(R.string.settings_off_no_drink_reminders), f.drink) { m.setFuel(JSONObject().put("drink", it)) }
            if (f.drink) Segmented(listOf(10, 15, 20).map { stringResource(R.string.common_min, it) }, listOf(10, 15, 20).indexOf(f.drinkMin).coerceAtLeast(0), { k -> m.setFuel(JSONObject().put("drinkMin", listOf(10, 15, 20)[k])) })
            SwitchRow(stringResource(R.string.settings_gel_reminders), if (f.gel) stringResource(R.string.settings_a_gel_every_minutes, f.gelMin) else stringResource(R.string.settings_off_no_gel_reminders), f.gel) { m.setFuel(JSONObject().put("gel", it)) }
            if (f.gel) Segmented(listOf(30, 40, 45).map { stringResource(R.string.common_min, it) }, listOf(30, 40, 45).indexOf(f.gelMin).coerceAtLeast(0), { k -> m.setFuel(JSONObject().put("gelMin", listOf(30, 40, 45)[k])) })
            Text(stringResource(R.string.settings_changes_reach_the_watch_the_next), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
    }
    m.week?.let { w ->
        SetCard(stringResource(R.string.settings_your_week_on_a_face), "watch", null, Modifier.reveal(i++)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(148.dp).clip(CircleShape).background(androidx.compose.ui.graphics.Color.Black)) { w.picture?.let { Image(it, stringResource(R.string.settings_your_week_on_a_watch_face), Modifier.size(148.dp)) } }
                Text(stringResource(R.string.settings_each_day_s_mark_from_your), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant, modifier = Modifier.padding(start = 14.dp))
            }
            Text(stringResource(R.string.settings_drawn_on), style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant)
            Segmented(w.bases.map { it.second }, w.bases.indexOfFirst { it.first == w.base }.coerceAtLeast(0), { k -> m.weekBase(w.bases[k].first) })
            FilledTonalButton(onClick = { m.weekSend() }, enabled = m.canBluetooth && m.busy == null) { Icon(Glyphs["watch"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.settings_put_it_on_the_watch)) }
            if (m.busy == "week") LinearWavyProgressIndicator(Modifier.fillMaxWidth())
            m.weekLine?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            SwitchRow(stringResource(R.string.settings_keep_it_up_to_date), stringResource(R.string.settings_when_a_new_week_starts_or), w.keep) { m.weekKeep(it) }
            Text(stringResource(R.string.settings_a_face_is_a_picture_made), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
    }
    SetCard(stringResource(R.string.common_routes), "route", stringResource(R.string.settings_made_under_activities_routes_sent_to), Modifier.reveal(i)) {
        FilledTonalButton(onClick = { go("routes") }) { Text(stringResource(R.string.settings_open_routes)) }
    }
}

/**
 * The watch face builder's list (Settings → More → Advanced): Tartan's faces and yours, a tap to
 * open one in the builder, the watch button to install it; Design a face; what's on the watch.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun FaceList(m: WatchGroupModel, go: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { m.ensure() }
    val list = m.faces
    if (list == null) { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { LoadingIndicator() }; return }
    list.forEachIndexed { k, f ->
        val first = k == 0; val last = k == list.lastIndex
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(if (first) 20.dp else 6.dp, if (first) 20.dp else 6.dp, if (last) 20.dp else 6.dp, if (last) 20.dp else 6.dp)).background(cs.surfaceContainerHigh)
                .press(scale = 0.98f, label = f.name, onClick = { go(if (f.builtin) "face/copy" else "face/${f.id}") }).padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(64.dp).clip(CircleShape).background(androidx.compose.ui.graphics.Color.Black)) { f.picture?.let { Image(it, null, Modifier.size(64.dp)) } }
            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                Text(f.name, style = MaterialTheme.typography.titleSmall)
                Text(if (f.builtin) stringResource(R.string.settings_tartan_s_own_tap_to_make) else if (f.onWatch) stringResource(R.string.common_on_your_watch_label) else stringResource(R.string.settings_not_on_your_watch_yet), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
            FilledTonalIconButton(onClick = { m.install(f) }, enabled = m.canBluetooth && m.busy == null) {
                if (m.busy == f.id) LoadingIndicator(Modifier.size(20.dp)) else Icon(Glyphs["watch"], stringResource(R.string.settings_install_on_the_watch, f.name))
            }
        }
    }
    ButtonFlow {
        Button(onClick = { go("face/new") }) { Icon(Glyphs["plus"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); ButtonText(stringResource(R.string.settings_design_a_face)) }
        FilledTonalButton(onClick = { m.check() }, enabled = m.canBluetooth && m.busy == null) { Icon(Glyphs["watch"], null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); ButtonText(stringResource(R.string.settings_check_the_watch)) }
    }
    if (m.busy == "check") LinearWavyProgressIndicator(Modifier.fillMaxWidth())
    m.onWatch?.let { (total, mine) ->
        Text(pluralStringResource(R.plurals.watch_faces_on_watch, total, total, mine.size, if (mine.isNotEmpty()) stringResource(R.string.watch_remove_takes_one_off) else ""), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        mine.forEach { (id, name) ->
            var armed by remember(id) { mutableStateOf(false) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(R.string.settings_on_your_watch, id), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                }
                TextButton(onClick = { if (armed) m.remove(id, name) else armed = true }, enabled = m.busy == null) { Text(if (armed) stringResource(R.string.common_tap_again_to_remove) else stringResource(R.string.common_remove), color = cs.error) }
            }
        }
    }
}
