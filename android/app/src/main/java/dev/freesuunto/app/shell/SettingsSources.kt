package dev.freesuunto.app.shell

import androidx.compose.ui.res.stringResource
import dev.freesuunto.app.R
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** The watch as the page holds it (web/watch.ts WatchState), pushed on every change. */
data class WatchNow(
    val connected: Boolean, val connecting: Boolean, val name: String, val facts: List<Pair<String, String>>,
    val cwd: String, val dirs: List<String>, val files: List<String>,
    val job: Job?, val running: Boolean, val logbook: Boolean, val canBluetooth: Boolean, val noFileAccess: Boolean,
    /** The one watch Tartan works with (src/transport/brand.ts): "suunto", "garmin" or null (none yet), and its name. */
    val brand: String? = null, val brandName: String = "",
) {
    data class Job(val title: String, val text: String, val value: Double?, val max: Double?)
}

fun parseWatch(json: String): WatchNow {
    val o = JSONObject(json)
    val l = o.optJSONObject("listing")
    fun strs(a: JSONArray?) = if (a == null) emptyList() else (0 until a.length()).map { a.optString(it) }
    return WatchNow(
        o.optBoolean("connected"), o.optBoolean("connecting"), o.optString("name"),
        o.optJSONArray("facts")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONArray(it)?.let { p -> p.optString(0) to p.optString(1) } } } ?: emptyList(),
        o.optString("cwd", "/"), strs(l?.optJSONArray("dirs")).sorted(), strs(l?.optJSONArray("files")).sorted(),
        o.optJSONObject("job")?.let { j -> WatchNow.Job(j.optString("title"), j.optString("text"), j.takeIf { it.has("value") && !it.isNull("value") }?.optDouble("value"), j.takeIf { it.has("max") && !it.isNull("max") }?.optDouble("max")) },
        o.optBoolean("running"), o.optString("mode") == "logbook", o.optBoolean("canBluetooth", true), o.optBoolean("noFileAccess"),
        o.text("brand")?.takeIf { it == "suunto" || it == "garmin" }, o.text("brandName") ?: "",
    )
}

data class StravaNow(
    val connected: Boolean, val configured: Boolean, val clientId: String?, val name: String, val lastSync: String?,
    val canUpload: Boolean, val activities: Int, val detailed: Int, val rateLimited: Boolean,
)

data class SendWatchNow(val enabled: Boolean, val since: String?, val connected: Boolean, val canUpload: Boolean, val sent: Int, val lastName: String?, val error: String?)

/** intervals.icu: connected as whom, how many workouts, the last round. */
data class IcuNow(val connected: Boolean, val name: String?, val workouts: Int, val line: String?)

data class HcNow(val status: String, val on: Boolean, val kinds: Map<String, Boolean>, val missing: Map<String, Boolean>, val lastLine: String?)

private fun JSONObject.text(k: String): String? = if (!has(k) || isNull(k)) null else optString(k).ifEmpty { null }

/**
 * Settings → Sources, native (web/views/sync.ts): Strava, the watch, workout files from other
 * apps, sending watch workouts to Strava, Health Connect and your PC. Bluetooth, the sign-ins
 * and Health Connect are the page's work, asked for over the bridge (`rpc:…`).
 */
/** What Find my watch settled on (web/watch.ts find): one watch, its brand, how it was found. */
data class FoundWatch(val brand: String, val name: String, val id: String?, val via: String)

class SourcesModel(private val scope: CoroutineScope, val api: SettingsApi, var garminApi: GarminApi? = null) {
    var watch by mutableStateOf<WatchNow?>(null)
    /** The Garmin, when the watch is one (GarminLink). */
    var garmin by mutableStateOf<GarminNow?>(null)
    var found by mutableStateOf<FoundWatch?>(null)
    /**
     * Where Find my watch is: "idle", "looking", "none" (nothing found), "suunto" (connecting it),
     * "garmin" (set up), "garmin-missing" (Garmin Connect isn't on the phone), "garmin-pair" (it
     * doesn't know this watch yet).
     */
    var finding by mutableStateOf("idle")
    var strava by mutableStateOf<StravaNow?>(null)
    var sendWatch by mutableStateOf<SendWatchNow?>(null)
    var hc by mutableStateOf<HcNow?>(null)
    var icu by mutableStateOf<IcuNow?>(null)
    var pc by mutableStateOf<Pair<String, String?>?>(null)
    var pcRead by mutableStateOf(false)
    var syncLines by mutableStateOf<List<String>>(emptyList())
    var pcLine by mutableStateOf<String?>(null)
    var busy by mutableStateOf<String?>(null)
    var said by mutableStateOf<String?>(null)
    var stravaUrl by mutableStateOf<String?>(null)
    private var read = false

    fun forget() { read = false }

    fun ensure() {
        if (read) return
        read = true
        scope.launch {
            val s = scope.async { api.get("/api/strava/status") }
            val w = scope.async { api.get("/api/strava/send-watch") }
            val h = scope.async { api.rpc("hc") }
            val p = scope.async { api.rpc("pcState") }
            val i = scope.async { api.get("/api/intervals/status") }
            i.await()?.let { runCatching { icu = parseIcu(it) } }
            s.await()?.let { runCatching { strava = parseStrava(it) } }
            w.await()?.let { runCatching { sendWatch = parseSendWatch(it) } }
            h.await()?.let { runCatching { hc = parseHc(it) } }
            p.await().let { j -> pc = j?.takeIf { it != "null" }?.let { runCatching { JSONObject(it).let { o -> o.optString("url") to o.text("name") } }.getOrNull() }; pcRead = true }
        }
    }

    private fun parseStrava(json: String): StravaNow {
        val o = JSONObject(json)
        val a = o.optJSONObject("athlete")
        val acts = o.optInt("activities")
        return StravaNow(o.optBoolean("connected"), o.optBoolean("configured"), o.text("clientId"), listOfNotNull(a?.text("firstname"), a?.text("lastname")).joinToString(" "), o.text("lastSync"), o.optBoolean("can_upload"), acts, acts - o.optInt("pendingDetails"), o.optBoolean("stoppedForRateLimit"))
    }

    private fun parseIcu(json: String): IcuNow {
        val o = JSONObject(json)
        val l = o.optJSONObject("last")
        val line = l?.let {
            val at = ago(it.optString("at"))
            it.text("error")?.let { e -> str(R.string.settings_last_try, at, e) }
                ?: str(R.string.sources_last_round, at, it.optInt("added"), it.optInt("pending").takeIf { n -> n > 0 }?.let { n -> str(R.string.sources_more_next_time, n) } ?: "", it.optInt("strava").takeIf { n -> n > 0 }?.let { n -> str(R.string.sources_icu_from_strava, n) } ?: "")
        }
        return IcuNow(o.optBoolean("connected"), o.text("name"), o.optInt("workouts"), line)
    }

    /** Connect intervals.icu with its key (and athlete ID, optional); then bring in what's there. */
    fun icuConnect(key: String, athlete: String, done: () -> Unit = {}) {
        busy = "icu"
        scope.launch {
            val (st, text) = api.send("/api/intervals/config", "PUT", JSONObject().put("key", key).put("athlete", athlete).toString())
            if (st in 200..299) {
                done()
                said = JSONObject(text).text("name")?.let { str(R.string.sources_icu_connected_as, it) } ?: str(R.string.sources_icu_connected)
                icuSyncNow(quiet = true)
            } else said = runCatching { JSONObject(text).optString("error") }.getOrNull()?.ifEmpty { null } ?: str(R.string.settings_couldn_t_connect, st)
            busy = null
        }
    }

    fun icuSyncNow(quiet: Boolean = false) {
        busy = "icu"
        scope.launch {
            val (st, text) = api.send("/api/intervals/sync", "POST", "{}")
            val o = runCatching { JSONObject(text) }.getOrNull()
            if (st in 200..299) { if (!quiet || (o?.optInt("added") ?: 0) > 0) said = str(R.string.sources_new_from_icu, o?.optInt("added") ?: 0, o?.optInt("pending")?.takeIf { it > 0 }?.let { str(R.string.sources_more_next_time, it) } ?: "") }
            else said = o?.text("error") ?: "intervals.icu couldn't be reached."
            api.get("/api/intervals/status")?.let { runCatching { icu = parseIcu(it) } }
            busy = null
        }
    }

    fun icuStop() = scope.launch {
        api.send("/api/intervals/config", "DELETE", null)
        icu = IcuNow(false, null, 0, null)
        said = str(R.string.settings_disconnected_from_intervals_icu_the_workouts)
    }

    private fun parseSendWatch(json: String): SendWatchNow {
        val o = JSONObject(json)
        val e = o.optJSONArray("errors")?.optJSONObject(0)
        return SendWatchNow(o.optBoolean("enabled"), o.text("since"), o.optBoolean("connected"), o.optBoolean("can_upload"), o.optInt("sent"), o.optJSONObject("last")?.text("name"), e?.let { str(R.string.sources_send_failed, it.text("name") ?: str(R.string.sources_a_workout), it.text("error") ?: str(R.string.sources_couldnt_be_sent)) })
    }

    private fun parseHc(json: String): HcNow {
        val o = JSONObject(json)
        fun map(k: String) = o.optJSONObject(k)?.let { m -> m.keys().asSequence().associateWith { m.optBoolean(it) } } ?: emptyMap()
        val l = o.optJSONObject("last")
        val line = l?.let {
            val at = ago(java.time.Instant.ofEpochMilli(it.optLong("at")).toString())
            it.text("error")?.let { e -> str(R.string.settings_last_try, at, e) }
                ?: str(R.string.sources_shared, at, it.optInt("written"), it.optInt("covered").takeIf { c -> c > 0 }?.let { c -> plural(R.plurals.sources_covered, c, c) } ?: "", it.optInt("sleep").takeIf { n -> n > 0 }?.let { n -> str(R.string.sources_nights_read, n) } ?: "", it.optInt("imported").takeIf { n -> n > 0 }?.let { n -> plural(R.plurals.sources_brought_in, n, n) } ?: "")
        }
        o.text("note")?.let { said = it }
        return HcNow(o.optString("status"), o.optBoolean("on"), map("kinds"), map("missing"), line ?: if (o.optBoolean("on")) str(R.string.settings_not_shared_yet) else null)
    }

    /** Something the page does, under a label; what it says (or why it failed), and then read again. */
    private fun run(label: String, name: String, args: JSONObject = JSONObject(), ok: (String) -> String? = { null }) {
        busy = label
        scope.launch {
            api.call(name, args).fold({ r -> ok(r)?.let { said = it } }, { e -> said = e.message })
            busy = null
            read = false
            ensure()
        }
    }

    fun watchConnect() = run("watch", "watchConnect")

    /** The watch's brand: what the page holds (pushed with the watch's state). */
    val brand: String? get() = watch?.brand

    /**
     * Find my watch: Garmin Connect's watches (when it's on this phone) and what advertises nearby
     * go to the page, which settles on one watch (src/transport/brand.ts pickWatch). A Suunto then
     * connects as before; a Garmin becomes the watch and gets the plan through Garmin Connect.
     */
    fun find() {
        finding = "looking"
        found = null
        scope.launch {
            val g = garminApi
            val known = g?.known()
            val noGcm = g != null && known == null
            val list = JSONArray().apply { known.orEmpty().forEach { put(JSONObject().put("id", it.id.toString()).put("name", it.name).put("connected", it.connected)) } }
            api.call("watchFind", JSONObject().put("garmin", list)).fold({ r ->
                val f = runCatching { JSONObject(r).optJSONObject("found") }.getOrNull()
                val w = f?.let { FoundWatch(it.optString("brand"), it.optString("name"), it.text("id"), it.optString("via")) }
                found = w
                when {
                    w == null -> finding = "none"
                    w.brand == "suunto" -> useSuunto(w)
                    noGcm -> finding = "garmin-missing"
                    w.via != "garmin-connect" || w.id?.toLongOrNull() == null -> finding = "garmin-pair"
                    else -> useGarmin(GarminDevice(w.id.toLong(), w.name, true))
                }
            }, { said = it.message; finding = "none" })
        }
    }

    /** A Suunto: Garmin is forgotten, and the Suunto connects (and is the watch once it has). */
    private fun useSuunto(w: FoundWatch) {
        finding = "suunto"
        garminApi?.forget()
        garmin = null
        run("watch", "watchConnect", JSONObject().apply { if (w.id != null) put("deviceId", w.id).put("name", w.name) })
    }

    /** A Garmin: it's the watch now (the page stops any Suunto work), and the plan goes to it. */
    fun useGarmin(d: GarminDevice) {
        finding = "garmin"
        scope.launch {
            api.call("watchBrand", JSONObject().put("set", "garmin").put("name", d.name))
            garmin = GarminNow(d.name, "ok", null, null, null, null, null)
            garmin = garminApi?.use(d) ?: garmin
        }
    }

    fun readGarmin() = scope.launch { if (brand == "garmin") garmin = garminApi?.now() }
    fun garminSend() {
        busy = "garmin"
        scope.launch { garmin = garminApi?.sendNow() ?: garmin; busy = null }
    }
    fun watchBackup(path: String = "/", force: Boolean = false) = run("watch", "watchBackup", JSONObject().put("path", path).put("force", force)) { n -> n.toIntOrNull()?.let { if (it > 0) plural(R.plurals.sources_saved_files, it, it) else str(R.string.settings_nothing_new_on_the_watch) } }
    fun watchDisconnect() = run("watch", "watchDisconnect")
    fun watchCancel() = scope.launch { api.call("watchCancel") }
    fun watchBrowse(path: String) = scope.launch { api.call("watchBrowse", JSONObject().put("path", path)).onFailure { said = it.message } }
    fun watchSave(path: String) = run("file", "watchSaveOne", JSONObject().put("path", path))

    fun stravaSync(full: Boolean) {
        busy = "strava"
        syncLines = emptyList()
        scope.launch {
            api.call("stravaSync", JSONObject().put("full", full)).fold({ r ->
                val o = JSONObject(r)
                val a = o.optJSONArray("lines")
                syncLines = if (a == null) emptyList() else (0 until a.length()).map { a.optString(it) }
                o.optJSONObject("result")?.let { said = if (it.optInt("added") > 0) plural(R.plurals.sources_strava_new, it.optInt("added"), it.optInt("added")) else str(R.string.settings_strava_nothing_new) }
            }, { said = it.message })
            busy = null
            read = false
            ensure()
        }
    }

    /** Strava's sign-in with your API app (or, with no ID, to add upload access): the page opens it. */
    fun stravaConnect(id: String?, secret: String?) {
        busy = "strava"
        scope.launch {
            api.call("stravaConnect", JSONObject().apply { if (id != null) put("clientId", id).put("clientSecret", secret) }).fold({ stravaUrl = runCatching { JSONObject(it).optString("url") }.getOrNull() }, { said = it.message })
            busy = null
        }
    }

    fun open(url: String) = scope.launch { api.call("openUrl", JSONObject().put("url", url)) }

    fun setSendWatch(on: Boolean) {
        sendWatch = sendWatch?.copy(enabled = on)
        scope.launch {
            val (st, text) = api.send("/api/strava/send-watch", "PUT", JSONObject().put("enabled", on).toString())
            if (st in 200..299) { runCatching { sendWatch = parseSendWatch(text) }; said = if (on) str(R.string.settings_on_new_watch_workouts_go_to) else str(R.string.settings_off_watch_workouts_stay_in_tartan) }
            else { sendWatch = sendWatch?.copy(enabled = !on); said = str(R.string.settings_couldn_t_change_it) }
        }
    }

    /** .fit files picked on the phone, each through the page into the library. */
    fun importFit(files: List<Pair<String, ByteArray>>) {
        busy = "import"
        scope.launch {
            var added = 0; var already = 0
            val failed = mutableListOf<String>()
            for ((name, bytes) in files) {
                val b64 = withContext(Dispatchers.Default) { Base64.encodeToString(bytes, Base64.NO_WRAP) }
                api.call("importFit", JSONObject().put("name", name).put("data", b64)).fold({ r -> if (JSONObject(r).optBoolean("already")) already++ else added++ }, { failed += it.message ?: name })
            }
            said = listOfNotNull(
                if (added > 0) plural(R.plurals.sources_imported, added, added) else null,
                if (already > 0) plural(R.plurals.common_already_here, already, already) else null,
                failed.firstOrNull(),
            ).joinToString(" ").ifEmpty { null }
            busy = null
        }
    }

    fun hcDo(op: String, extra: JSONObject.() -> Unit = {}) {
        busy = "hc"
        scope.launch {
            api.call("hc", JSONObject().put("op", op).apply(extra)).fold({ runCatching { hc = parseHc(it) } }, { said = it.message })
            busy = null
        }
    }

    fun pcPair(urls: String, code: String) {
        busy = "pc"
        scope.launch {
            api.call("pcPair", JSONObject().put("urls", urls).put("code", code)).fold({ r -> JSONObject(r).let { pc = it.optString("url") to it.text("name") }; said = str(R.string.settings_paired_bringing_this_phone_and_your); pcSync() }, { said = it.message })
            if (busy == "pc") busy = null
        }
    }

    fun pcScan() = scope.launch { api.call("scanPair").onSuccess { read = false; ensure() }.onFailure { said = it.message } }

    fun pcSync() {
        busy = "pc"
        pcLine = str(R.string.settings_comparing_with_your_pc)
        scope.launch {
            api.call("pcSync").fold({ pcLine = runCatching { JSONArray("[$it]").optString(0) }.getOrNull() ?: it }, { pcLine = null; said = it.message })
            busy = null
        }
    }

    fun pcUnpair() = scope.launch { api.call("pcUnpair"); pc = null; said = str(R.string.settings_unpaired_your_data_stays_on_this) }
}

/** Settings → Sources. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class, ExperimentalLayoutApi::class)
@Composable
fun SourcesGroup(s: SourcesModel, essentials: Boolean = false) {
    LaunchedEffect(Unit) { s.ensure() }
    var i = 0
    StravaCard(s, Modifier.reveal(i++))
    WatchCard(s, Modifier.reveal(i++))
    // The intro: the two that bring workouts in; the rest waits in Settings → Sources.
    if (essentials) return
    // intervals.icu when it's connected or the plan goes through it; else under More → More tools.
    val inUse = LocalInUse.current
    if (inUse.icu || s.icu?.connected == true || PlanDest.get(androidx.compose.ui.platform.LocalContext.current) == "intervals") IcuCard(s, Modifier.reveal(i++))
    ImportCard(s, Modifier.reveal(i++))
    s.sendWatch?.takeIf { it.enabled || inUse.watch }?.let { SendWatchCard(s, it, Modifier.reveal(i++)) }
    HcCard(s, Modifier.reveal(i++))
    // Where the plan goes for your watch (the Coach tab sends there).
    PlanWatchCard(s.api, Modifier.reveal(i))
}

/**
 * intervals.icu: workouts from Garmin, Suunto, Coros, Polar, Wahoo and Zwift through it, with a
 * personal key. Its key and athlete ID are under Settings → Developer Settings there.
 */
@Composable
fun IcuCard(s: SourcesModel, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val i = s.icu
    val uri = androidx.compose.ui.platform.LocalUriHandler.current
    SetCard(
        "intervals.icu", "trends",
        if (i?.connected == true) i.name?.let { stringResource(R.string.sources_icu_connected_as_line, i.workouts, it) } ?: stringResource(R.string.sources_icu_connected_line, i.workouts) else stringResource(R.string.settings_not_connected_brings_in_garmin_coros),
        modifier,
    ) {
        if (i == null) return@SetCard
        if (i.connected) {
            ButtonFlow(gap = 4.dp) {
                FilledTonalButton(onClick = { s.icuSyncNow() }, enabled = s.busy != "icu") { Icon(Glyphs["sync"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); ButtonText(stringResource(R.string.common_sync_now)) }
                TextButton(onClick = { s.icuStop() }) { ButtonText(stringResource(R.string.settings_disconnect)) }
            }
            if (s.busy == "icu") LinearWavyProgressIndicator(Modifier.fillMaxWidth())
            i.line?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
        } else IcuSetup(s) { uri.openUri("https://intervals.icu/settings") }
    }
}

/** The key (and athlete ID, if the key alone isn't enough), where to find them, Connect. */
@Composable
fun IcuSetup(s: SourcesModel, open: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var key by remember { mutableStateOf("") }
    var athlete by remember { mutableStateOf("") }
    Text(stringResource(R.string.settings_in_intervals_icu_open_settings_developer), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
    TextButton(onClick = open) { Text(stringResource(R.string.settings_open_intervals_icu_settings)) }
    Field(stringResource(R.string.settings_api_key), key, { key = it.trim() }, secret = true)
    Field(stringResource(R.string.settings_athlete_id_optional), athlete, { athlete = it.trim() }, placeholder = "i12345")
    Button(onClick = { s.icuConnect(key, athlete) { key = "" } }, enabled = key.length >= 8 && s.busy != "icu") { Text(if (s.busy == "icu") stringResource(R.string.settings_connecting) else stringResource(R.string.common_connect)) }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun StravaCard(s: SourcesModel, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val st = s.strava
    val sub = when {
        st == null -> stringResource(R.string.common_reading)
        st.connected -> (st.lastSync?.let { ago(it) } ?: str(R.string.sources_never)).let { last -> if (st.name.isNotEmpty()) str(R.string.sources_strava_connected_as, last, st.name) else str(R.string.sources_strava_connected, last) }
        else -> stringResource(R.string.settings_not_connected)
    }
    SetCard("Strava", "strava", sub, modifier) {
        if (st == null) return@SetCard
        if (st.connected) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = { s.stravaSync(false) }, enabled = s.busy != "strava", shapes = ButtonDefaults.shapes()) { Icon(Glyphs["sync"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.common_sync_now)) }
                TwoTap(stringResource(R.string.settings_fetch_full_history_again), stringResource(R.string.settings_tap_again_it_takes_a_few), s.busy != "strava") { s.stravaSync(true) }
            }
            if (s.busy == "strava") LinearWavyProgressIndicator(Modifier.fillMaxWidth())
            if (!st.canUpload) Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(cs.secondaryContainer).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.settings_to_send_runs_you_record_on), style = MaterialTheme.typography.bodyMedium, color = cs.onSecondaryContainer)
                Button(onClick = { s.stravaConnect(null, null) }, enabled = s.busy != "strava") { Icon(Glyphs["up"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.settings_allow_uploads)) }
            }
            Text(stringResource(R.string.settings_of_activities_have_full_detail_laps, st.detailed, st.activities), style = MaterialTheme.typography.bodyMedium)
            androidx.compose.material3.LinearProgressIndicator(progress = { if (st.activities > 0) st.detailed.toFloat() / st.activities else 0f }, modifier = Modifier.fillMaxWidth())
            if (st.rateLimited) Text(stringResource(R.string.settings_paused_at_strava_s_rate_limit), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            if (s.syncLines.isNotEmpty()) Fold(stringResource(R.string.settings_what_the_last_sync_did), s.syncLines.joinToString("\n"))
        } else StravaSetup(s, st)
    }
}

/** Connecting Strava the first time: what it brings, and the way into the guided setup (StravaFlow). */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun StravaSetup(s: SourcesModel, st: StravaNow) {
    val cs = MaterialTheme.colorScheme
    var open by rememberSaveable { mutableStateOf(false) }
    Text(stringResource(R.string.settings_your_whole_history_with_laps_and), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
    Button(onClick = { open = true }, modifier = Modifier.fillMaxWidth().height(52.dp), shapes = ButtonDefaults.shapes()) {
        Icon(Glyphs["strava"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(if (st.configured) stringResource(R.string.settings_finish_connecting_strava) else stringResource(R.string.settings_connect_strava))
    }
    if (open) StravaFlow(s) { open = false }
}

@Composable
private fun Step(n: Int, bold: String, rest: String) {
    val cs = MaterialTheme.colorScheme
    Row {
        Box(Modifier.size(24.dp).clip(CircleShape).background(cs.primaryContainer), contentAlignment = Alignment.Center) { Text("$n", style = MaterialTheme.typography.labelMedium, color = cs.onPrimaryContainer) }
        Text(
            androidx.compose.ui.text.buildAnnotatedString {
                withStyle(androidx.compose.ui.text.SpanStyle(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)) { append("$bold ") }
                append(rest)
            },
            style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 8.dp),
        )
    }
}

/** The watch: connect, back up, a job's progress, its facts, and its files for the curious. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun WatchCard(s: SourcesModel, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val w = s.watch
    // One watch: its brand decides what this card holds (a Garmin: the plan sent through Garmin Connect; a Suunto: Bluetooth).
    val sub = when {
        w?.brand == "garmin" -> stringResource(R.string.watchfind_brand_line, s.garmin?.name?.ifEmpty { null } ?: w.brandName.ifEmpty { "Garmin" }, "Garmin")
        w?.connected == true -> stringResource(R.string.watchfind_brand_line, stringResource(R.string.common_connected_to, w.name), "Suunto")
        else -> stringResource(R.string.settings_not_connected)
    }
    SetCard(stringResource(R.string.common_watch), "watch", sub, modifier) {
        if (w == null) return@SetCard
        var force by remember { mutableStateOf(false) }
        // Connecting is its own guided screen (WatchFlow); connecting another watch replaces this one.
        var flow by rememberSaveable { mutableStateOf(false) }
        if (flow) WatchFlow(s) { flow = false }
        if (w.brand == "garmin") {
            LaunchedEffect(Unit) { s.readGarmin() }
            GarminStatus(s)
            ButtonFlow(gap = 4.dp) {
                FilledTonalButton(onClick = { s.garminSend() }, enabled = s.busy != "garmin") { Icon(Glyphs["send"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); ButtonText(stringResource(R.string.watchfind_send_now)) }
                TextButton(onClick = { flow = true }) { ButtonText(stringResource(R.string.watchfind_connect_another)) }
            }
            return@SetCard
        }
        when {
            !w.connected && w.connecting -> Row(verticalAlignment = Alignment.CenterVertically) { LoadingIndicator(Modifier.size(28.dp)); Text(stringResource(R.string.settings_connecting_to_the_watch), modifier = Modifier.padding(start = 10.dp)) }
            !w.connected -> Button(onClick = { flow = true }, enabled = s.busy != "watch", modifier = Modifier.fillMaxWidth().height(52.dp), shapes = ButtonDefaults.shapes()) { Icon(Glyphs["watch"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.common_connect_your_watch)) }
            else -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { s.watchBackup("/", force) }, enabled = !w.running, shapes = ButtonDefaults.shapes()) { Icon(Glyphs["sync"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.common_back_up_now)) }
                TwoTap(stringResource(R.string.settings_disconnect), stringResource(R.string.settings_tap_again_to_disconnect), danger = true) { s.watchDisconnect() }
            }
        }
        if (w.logbook || (!w.connected && w.noFileAccess)) Text(stringResource(R.string.settings_this_watch_hands_over_workouts_from), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        w.job?.let { j ->
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(cs.surfaceContainerHigh).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(j.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    if (w.running) TextButton(onClick = { s.watchCancel() }) { Text(stringResource(R.string.common_stop)) }
                }
                if (j.value != null) LinearWavyProgressIndicator(progress = { (j.value / (j.max ?: 1.0)).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                else LinearWavyProgressIndicator(Modifier.fillMaxWidth())
                Text(j.text, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
        }
        if (w.connected) {
            w.facts.filter { it.first in listOf("Watch", stringResource(R.string.settings_battery), stringResource(R.string.common_firmware)) }.forEach { (k, v) ->
                Row { Text(k, style = MaterialTheme.typography.labelLarge, color = cs.onSurfaceVariant, modifier = Modifier.width(96.dp)); Text(v, style = MaterialTheme.typography.bodyMedium) }
            }
            var browse by remember { mutableStateOf(false) }
            TextButton(onClick = { browse = !browse }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text(if (browse) stringResource(R.string.settings_hide_the_watch_s_files) else stringResource(R.string.settings_advanced_browse_the_watch_s_files)) }
            if (browse) Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val parts = w.cwd.split("/").filter { it.isNotEmpty() }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Glyphs["folder"], null, Modifier.size(16.dp))
                    TextButton(onClick = { s.watchBrowse("/") }) { Text("watch") }
                    parts.forEachIndexed { k, p -> Text("/"); TextButton(onClick = { s.watchBrowse("/" + parts.take(k + 1).joinToString("/")) }) { Text(p) } }
                }
                w.dirs.forEach { d -> Row(Modifier.fillMaxWidth().press(scale = 0.98f, onClick = { s.watchBrowse((w.cwd.trimEnd('/') + "/" + d)) }).padding(8.dp), verticalAlignment = Alignment.CenterVertically) { Icon(Glyphs["folder"], null, Modifier.size(18.dp)); Text("$d/", fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f).padding(start = 8.dp)); Icon(Glyphs["chevron"], null, Modifier.size(16.dp)) } }
                w.files.forEach { f -> Row(Modifier.fillMaxWidth().padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) { Text(f, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f)); TextButton(onClick = { s.watchSave(w.cwd.trimEnd('/') + "/" + f) }) { Text(stringResource(R.string.common_save)) } } }
                if (w.dirs.isEmpty() && w.files.isEmpty()) Text(stringResource(R.string.settings_this_folder_is_empty), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                SwitchRow(stringResource(R.string.settings_download_files_again), stringResource(R.string.settings_even_if_i_have_them), force) { force = it }
                FilledTonalButton(onClick = { s.watchBackup(w.cwd, force) }, enabled = !w.running) { Text(stringResource(R.string.settings_back_up_this_folder)) }
            }
        } else Text(stringResource(R.string.settings_every_workout_file_straight_off_your), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
    }
}

/** .fit files from any other watch or app. */
@Composable
private fun ImportCard(s: SourcesModel, modifier: Modifier) {
    val context = LocalContext.current
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris: List<Uri> ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        val files = uris.mapNotNull { u ->
            runCatching {
                val name = context.contentResolver.query(u, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "workout.fit"
                name to (context.contentResolver.openInputStream(u)?.use { it.readBytes() } ?: ByteArray(0))
            }.getOrNull()
        }
        s.importFit(files)
    }
    SetCard(stringResource(R.string.settings_workout_files), "file", stringResource(R.string.settings_share_a_workout_to_tartan_or), modifier) {
        FilledTonalButton(onClick = { pick.launch(arrayOf("*/*")) }, enabled = s.busy != "import") { Icon(Glyphs["plus"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(if (s.busy == "import") stringResource(R.string.settings_importing) else stringResource(R.string.settings_import_workout_files)) }
    }
}

@Composable
private fun SendWatchCard(s: SourcesModel, w: SendWatchNow, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    SetCard(stringResource(R.string.settings_send_watch_workouts_to_strava), "send", null, modifier) {
        SwitchRow(stringResource(R.string.settings_send_them), stringResource(R.string.settings_when_a_watch_sync_brings_in), w.enabled) { s.setSendWatch(it) }
        if (w.enabled) Text(
            when {
                !w.connected -> stringResource(R.string.settings_connect_strava_above_first)
                !w.canUpload -> stringResource(R.string.settings_strava_hasn_t_allowed_uploads_yet)
                w.sent > 0 -> stringResource(R.string.sources_sent_since, w.sent, w.since?.let { dateShort(it) } ?: stringResource(R.string.sources_then), w.lastName?.let { stringResource(R.string.sources_last_name, it) } ?: "")
                else -> stringResource(R.string.sources_on_since, w.since?.let { dateShort(it) } ?: stringResource(R.string.sources_now))
            },
            style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant,
        )
        if (w.enabled) w.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = cs.error) }
    }
}

/** What Health Connect shares, each with one line of fact. The plan's week is in Plan on your watch. */
private val HC_KINDS get() = listOf(
    Triple("import", str(R.string.settings_workouts_from_other_apps), str(R.string.settings_samsung_health_fitbit_coros_and_others)),
    Triple("workouts", str(R.string.common_workouts_title), str(R.string.settings_with_heart_rate_distance_and_route)),
    Triple("vitals", str(R.string.settings_heart_rate_and_blood_oxygen), str(R.string.settings_from_the_watch_s_log_with)),
    Triple("activity", str(R.string.settings_steps_and_active_calories), str(R.string.settings_from_the_watch_s_log)),
    Triple("sleep", str(R.string.settings_sleep_and_hrv_from_other_apps), str(R.string.settings_for_the_body_card_on_today)),
)

/** Health Connect: what's shared, connect or allow what's missing, share now, stop. */
@Composable
private fun HcCard(s: SourcesModel, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val data = LocalData.current
    val h = s.hc
    var stopping by remember { mutableStateOf(false) }
    SetCard(stringResource(R.string.common_health_connect), "heart", null, modifier) {
        if (h == null) return@SetCard
        when (h.status) {
            "unavailable" -> { Text(stringResource(R.string.settings_health_connect_isn_t_available_on), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant); return@SetCard }
            "update" -> { Text(stringResource(R.string.settings_health_connect_needs_installing_or_updating), style = MaterialTheme.typography.bodyMedium); FilledTonalButton(onClick = { s.hcDo("manage") }) { Text(stringResource(R.string.settings_get_health_connect)) }; return@SetCard }
            "web" -> { Text(stringResource(R.string.settings_in_the_android_app), style = MaterialTheme.typography.bodySmall); return@SetCard }
        }
        HC_KINDS.forEach { (k, title, line) ->
            SwitchRow(title, line, h.kinds[k] == true) { s.hcDo("toggle") { put("kind", k) } }
            if (h.missing[k] == true) Row(verticalAlignment = Alignment.CenterVertically) { Icon(Glyphs["warn"], null, Modifier.size(14.dp), tint = data.watch); Text(stringResource(R.string.settings_not_allowed_in_health_connect_yet), style = MaterialTheme.typography.bodySmall, color = data.watch, modifier = Modifier.padding(start = 6.dp)) }
        }
        if (h.on && h.missing.values.any { it }) FilledTonalButton(onClick = { s.hcDo("allow") }, enabled = s.busy != "hc") { Text(stringResource(R.string.settings_allow_what_s_missing)) }
        if (!h.on) Button(onClick = { s.hcDo("connect") }, enabled = s.busy != "hc") { Text(stringResource(R.string.common_connect)) }
        else ButtonFlow(gap = 4.dp) {
            FilledTonalButton(onClick = { s.hcDo("share") }, enabled = s.busy != "hc") { ButtonText(stringResource(R.string.settings_share_now)) }
            TextButton(onClick = { s.hcDo("manage") }) { ButtonText(stringResource(R.string.settings_manage_access)) }
            TextButton(onClick = { stopping = true }) { ButtonText(stringResource(R.string.settings_stop_sharing)) }
        }
        h.lastLine?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant) }
    }
    if (stopping) AlertDialog(
        onDismissRequest = { stopping = false },
        title = { Text(stringResource(R.string.settings_stop_sharing_with_health_connect)) },
        text = { Text(stringResource(R.string.settings_also_remove_everything_tartan_wrote_to)) },
        confirmButton = { TextButton(onClick = { stopping = false; s.hcDo("stop") { put("remove", true) } }) { Text(stringResource(R.string.settings_stop_and_remove)) } },
        dismissButton = { TextButton(onClick = { stopping = false; s.hcDo("stop") { put("remove", false) } }) { Text(stringResource(R.string.settings_stop_keep_them)) } },
    )
}

/** Your PC: pair (scan its code, or type it), sync now, unpair. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PcCard(s: SourcesModel, modifier: Modifier) {
    val pc = s.pc
    SetCard(stringResource(R.string.settings_your_pc), "pc", if (pc != null) stringResource(R.string.settings_paired_with_end_to_end_encrypted, pc.second ?: pc.first) else stringResource(R.string.settings_not_paired), modifier) {
        PcBody(s)
    }
}

/** Your PC's inside: paired (sync now, unpair) or the way to pair (also under More → More tools). */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PcBody(s: SourcesModel) {
    val cs = MaterialTheme.colorScheme
    val pc = s.pc
    if (!s.pcRead) return
    run {
        if (pc != null) {
            Text(stringResource(R.string.settings_both_stay_at_the_latest_the, pc.first), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = { s.pcSync() }, enabled = s.busy != "pc") { Icon(Glyphs["sync"], null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.common_sync_now)) }
                TwoTap(stringResource(R.string.settings_unpair), stringResource(R.string.settings_tap_again_plans_and_lifts_stop), danger = true) { s.pcUnpair() }
            }
            if (s.busy == "pc") LinearWavyProgressIndicator(Modifier.fillMaxWidth())
            s.pcLine?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        } else {
            var urls by remember { mutableStateOf("") }
            var code by remember { mutableStateOf("") }
            Step(1, stringResource(R.string.settings_on_your_pc_open_tartan), stringResource(R.string.settings_settings_more_phone_app))
            Step(2, stringResource(R.string.settings_tap_pair_a_phone), stringResource(R.string.settings_it_shows_a_code_for_10))
            Step(3, stringResource(R.string.settings_scan_its_qr_code_here), stringResource(R.string.settings_or_type_the_address_and_code))
            Button(onClick = { s.pcScan() }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.settings_scan_the_code_on_your_pc)) }
            Text(stringResource(R.string.settings_or_type_them), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.fillMaxWidth())
            Field(stringResource(R.string.settings_pc_address), urls, { urls = it }, placeholder = "192.168.1.20:5173")
            Field(stringResource(R.string.settings_code), code, { code = it.uppercase() }, placeholder = "K7QM3-XPA9R")
            FilledTonalButton(onClick = { s.pcPair(urls, code) }, enabled = urls.isNotBlank() && code.isNotBlank() && s.busy != "pc") { Text(stringResource(R.string.common_connect)) }
            Text(stringResource(R.string.settings_end_to_end_encrypted_your_data), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        }
    }
}

/** An action that's costly or hard to undo: the first tap says what happens, the second does it (4 s). */
@Composable
fun TwoTap(label: String, again: String, enabled: Boolean = true, danger: Boolean = false, run: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(armed) { if (armed) { kotlinx.coroutines.delay(4000); armed = false } }
    TextButton(onClick = { if (armed) { armed = false; run() } else armed = true }, enabled = enabled) {
        Text(if (armed) again else label, color = if (danger || armed) cs.error else cs.primary)
    }
}
