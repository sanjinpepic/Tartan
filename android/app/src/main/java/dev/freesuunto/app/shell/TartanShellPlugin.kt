package dev.freesuunto.app.shell

import androidx.compose.ui.input.nestedscroll.nestedScroll

import dev.freesuunto.app.R
import android.content.Context
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.ui.Modifier
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Tartan 2 (the tartan-2 branch): native Compose parts drawn over the web app (web/lib/shell.ts).
 *
 * Two views sit on top of the WebView: the floating bar (bottom, its own height) and the native
 * screens (Today, Coach; the whole screen, only while one of them is showing, sliding between
 * each other and the web pages the way the bar goes). Everything else is still the web app, which
 * keeps running underneath, says where it is after each route ("route"), and answers the native
 * screens' API calls ("api" → `reply`), so they read exactly what the web screens read. Each part
 * can be turned off (Settings → More → Tartan 2 preview) to compare with the web version.
 */
@CapacitorPlugin(name = "TartanShell")
class TartanShellPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<Pair<Int, String>>>()
    /** Streamed answers in flight: each line to its reader. */
    private val streams = ConcurrentHashMap<String, (String) -> Unit>()
    private val prefs by lazy { context.getSharedPreferences("tartan-shell", Context.MODE_PRIVATE) }

    // What the Compose views draw; set from the web's route events and the preferences.
    private var view by mutableStateOf("today")
    private var hidden by mutableStateOf(false)
    private var wallpaper by mutableStateOf(true)
    private var navOn by mutableStateOf(true)

    /** The bar folds small while a screen scrolls down (FloatingBar.kt). */
    private val navFold = NavFold()
    private var todayOn by mutableStateOf(true)
    private var coachOn by mutableStateOf(true)
    private var chatOn by mutableStateOf(true)
    private var activitiesOn by mutableStateOf(true)
    private var progressOn by mutableStateOf(true)
    private var settingsOn by mutableStateOf(true)
    private var workoutOn by mutableStateOf(true)
    private var bodyOn by mutableStateOf(true)
    private var routesOn by mutableStateOf(true)
    private var recordOn by mutableStateOf(true)
    /** The workout whose sheet is open (native), if any. */
    private var workout by mutableStateOf<WorkoutModel?>(null)
    /** The planned session whose sheet is open, if any. */
    private var session by mutableStateOf<SessionModel?>(null)
    /** The sync board's sheet is open (native; with no source yet the chip leads to Sources). */
    private var boardOpen by mutableStateOf(false)
    private fun openBoard() { if (board.isEmpty()) go("settings/sources", null) else boardOpen = true }

    /** The QR scanner open for the page (lib/qr-scan.ts), and the call waiting for what it read. */
    private var scanning by mutableStateOf<String?>(null)
    private var scanCall: PluginCall? = null
    /** Pairing with the PC from its code (views/pc-link.ts openPairLink). */
    private var pairing by mutableStateOf<PairModel?>(null)

    /** A message from the page while a native screen shows (state.ts notify). */
    private var pageSnack by mutableStateOf<PageSnack?>(null)
    /** A word after something done in a sheet that has closed ("Easy run marked done."). */
    private var said by mutableStateOf<String?>(null)
    /** The page's address after the #, for which Settings group is showing. */
    private var hash by mutableStateOf("")
    /** The Settings group last shown natively (where the gear opens). */
    private var settingsGroup by mutableStateOf("training")
    private var activities by mutableStateOf<List<Act>?>(null)
    private var today by mutableStateOf<Today?>(null)
    private var coach by mutableStateOf<Coach?>(null)
    private var weeklySeen by mutableStateOf<String?>(null)
    private var refreshing by mutableStateOf(false)
    private var board by mutableStateOf<List<Lane>>(emptyList())
    /** The native screen showing (null: a web page), and which way the last move went in the bar. */
    private var shown by mutableStateOf<String?>(null)
    private var forward by mutableStateOf(true)
    /** Today's title has scrolled away: the board folds. */
    private var todayFolded by mutableStateOf(false)
    /** How far Today is pulled down (1: letting go syncs). */
    private var todayPull by mutableStateOf(0f)

    private var screen: ComposeView? = null
    private var barView: ComposeView? = null

    /** Screens whose data needs reading again: something wrote since (a sync, a mark…). And the day each was read. */
    private val stale = mutableSetOf("today", "coach", "activities")
    /** Every workout, kept as a file (it can be a few thousand): drawn at once on the next start. */
    private val activitiesFile by lazy { java.io.File(context.cacheDir, "activities.json") }
    private val readOn = HashMap<String, String>()
    private var synced: CompletableDeferred<Unit>? = null

    override fun load() {
        // Every part is native (the phone has no web screens): the old switches' preferences are ignored.
        scope.launch(Dispatchers.IO) {
            val kept = runCatching { activitiesFile.takeIf { it.exists() }?.readText()?.let(::parseActivities) }.getOrNull()
            if (kept != null && activities == null) activities = kept
        }
        weeklySeen = prefs.getString("weeklySeen", null)
        prefs.getString("inUse", null)?.let { j -> runCatching { InUse.parse(org.json.JSONObject(j)) }.getOrNull()?.let { inUse = it } }
        readInUse()
        // Last time's screens, drawn at once while (and only if) they're read again.
        val plan = prefs.getString("planJson", null)
        prefs.getString("todayJson", null)?.let { t -> today = runCatching { parseToday(t, plan) }.getOrNull() }
        if (plan != null) coach = runCatching { parseCoach(plan, prefs.getString("statusJson", null), prefs.getString("weeklyJson", null)) }.getOrNull()
        activity.runOnUiThread { attach() }
        // A Garmin gets the plan on open (nothing happens for a Suunto).
        garminSync()
        // Opened with a workout file (or one shared to Tartan) from another app, or from a notification.
        activity.intent?.let { openShared(it); openFrom(it) }
    }

    override fun handleOnNewIntent(intent: android.content.Intent) {
        super.handleOnNewIntent(intent)
        openShared(intent)
        openFrom(intent)
    }

    /** A notification tapped (LiveUpdates): the screen it's about. */
    private fun openFrom(intent: android.content.Intent) {
        val where = intent.getStringExtra(LiveUpdates.EXTRA_OPEN) ?: return
        intent.removeExtra(LiveUpdates.EXTRA_OPEN)
        activity.runOnUiThread { go(where, null) }
    }

    /**
     * Workout files opened with Tartan or shared to it (FIT, GPX, TCX from Garmin Connect, Coros,
     * Polar, Komoot…): each into the library through the page, then a word on how it went and the
     * way to Activities. Only content and file links: Strava's sign-in return isn't one.
     */
    private fun openShared(intent: android.content.Intent) {
        val uris: List<android.net.Uri> = when (intent.action) {
            android.content.Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            android.content.Intent.ACTION_SEND -> listOfNotNull(androidx.core.content.IntentCompat.getParcelableExtra(intent, android.content.Intent.EXTRA_STREAM, android.net.Uri::class.java))
            android.content.Intent.ACTION_SEND_MULTIPLE -> androidx.core.content.IntentCompat.getParcelableArrayListExtra(intent, android.content.Intent.EXTRA_STREAM, android.net.Uri::class.java) ?: emptyList()
            else -> emptyList()
        }.filter { it.scheme == "content" || it.scheme == "file" }
        if (uris.isEmpty()) return
        // Once: coming back to the app (or turning it) doesn't import it again.
        intent.action = null
        scope.launch {
            val files = kotlinx.coroutines.withContext(Dispatchers.IO) {
                uris.mapNotNull { u ->
                    runCatching {
                        val name = context.contentResolver.query(u, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: u.lastPathSegment ?: "workout"
                        name to (context.contentResolver.openInputStream(u)?.use { it.readBytes() } ?: ByteArray(0))
                    }.getOrNull()
                }
            }
            var added = 0
            var already = 0
            val failed = mutableListOf<String>()
            for ((name, bytes) in files) {
                val b64 = kotlinx.coroutines.withContext(Dispatchers.Default) { android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP) }
                shellApi.call("importFit", org.json.JSONObject().put("name", name).put("data", b64)).fold({ r -> if (org.json.JSONObject(r).optBoolean("already")) already++ else added++ }, { failed += it.message ?: name })
            }
            val text = listOfNotNull(
                if (added > 0) plural(R.plurals.shell_added_workouts, added, added) else null,
                if (already > 0) plural(R.plurals.common_already_here, already, already) else null,
                failed.firstOrNull(),
            ).joinToString(" ")
            if (added > 0) { stale.add("activities"); stale.add("today") }
            activity.runOnUiThread { pageSnack = PageSnack(0, text, failed.isNotEmpty() && added == 0, null, 6000) }
        }
    }

    private val reducedMotion get() = runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)

    private val workoutApi = object : WorkoutApi {
        override suspend fun get(path: String) = this@TartanShellPlugin.get(path)
        override suspend fun send(path: String, method: String, body: String?) = api(path, method, body)
    }

    /** A workout's sheet: native when that part is on, else the page's. `moments`: at the run's moments on the map. */
    private fun openWorkout(id: String, moments: Boolean = false) {
        if (!workoutOn) return go("", id)
        workout = WorkoutModel(scope, workoutApi, id, atMoments = moments).also { it.load() }
        body.ensure()
        // The sheet is a window of its own, but its view has to be there to hold it.
        screen?.let { it.removeCallbacks(hide); it.visibility = View.VISIBLE }
    }

    private fun closeWorkout() {
        workout = null
        screen?.let { it.removeCallbacks(hide); it.postDelayed(hide, 300) }
    }

    /** A planned session's sheet, native. */
    private fun openSession(date: String, kind: String) {
        session = SessionModel(scope, shellApi, date, kind).also { it.load() }
        screen?.let { it.removeCallbacks(hide); it.visibility = View.VISIBLE }
    }

    private val sessionActions: SessionActions = object : SessionActions {
        override fun openWorkout(id: String) { this@TartanShellPlugin.openWorkout(id) }
        override fun chat(conversation: String?, prefill: String?) { coachActions.chat(conversation, prefill) }
        override fun go(hash: String) { this@TartanShellPlugin.go(hash, null) }
    }

    /** Reads, writes and the page's own abilities, for the native models. */
    private val shellApi = object : SettingsApi {
        override suspend fun get(path: String) = this@TartanShellPlugin.get(path)
        override suspend fun send(path: String, method: String, body: String?) = api(path, method, body)
        override suspend fun rpc(name: String, args: org.json.JSONObject) = api("rpc:$name", "POST", args.toString()).let { (st, b) -> if (st in 200..299) b else null }
        override suspend fun call(name: String, args: org.json.JSONObject): Result<String> = api("rpc:$name", "POST", args.toString()).let { (st, b) ->
            if (st in 200..299) Result.success(b)
            else Result.failure(Exception(runCatching { org.json.JSONObject(b).optString("error") }.getOrNull()?.ifEmpty { null } ?: if (st == 599) str(R.string.shell_no_answer_is_the_app_busy) else str(R.string.shell_it_didn_t_go_through, st)))
        }
    }

    /** What Today reads beyond its view: the morning check, vitals, race week, a fresh run's finish. */
    private val todayMore by lazy {
        TodayModel(scope, shellApi, object : KeyStore {
            override fun get(key: String) = prefs.getString("today.$key", null)
            override fun set(key: String, value: String) = prefs.edit().putString("today.$key", value).apply()
        })
    }
    private fun loadMore() { todayMore.load(today?.race, today?.last, workoutApi) }

    private val todayActions = object : TodayActions {
        // "trends/week" (the This week card): Progress on this week, whatever range it showed last.
        override fun go(hash: String) = if (hash == "trends/week") { progress.weekOf = null; progress.range = 7; go("trends", null) } else go(hash, null)
        override fun chat() { notifyListeners("go", JSObject().put("hash", "").put("action", "chat")) }
        override fun leaveDemo() { scope.launch { shellApi.call("demo", org.json.JSONObject().put("op", "leave")) } }
        override fun openActivity(id: String) = openWorkout(id)
        override fun openRun(id: String) = openWorkout(id, moments = true)
        override fun openSession(date: String, kind: String) = this@TartanShellPlugin.openSession(date, kind)
        override fun openBoard() = this@TartanShellPlugin.openBoard()
        // Pull to refresh is Sync now: the sync writes, the write says changed, Today reads again.
        override fun refresh() {
            refreshing = true
            val done = CompletableDeferred<Unit>()
            synced = done
            notifyListeners("go", JSObject().put("hash", "").put("action", "sync"))
            scope.launch {
                runCatching { withTimeout(20_000) { done.await() } }
                fetchToday()
                refreshing = false
            }
        }
    }

    private val coachActions = object : CoachActions {
        override fun openSession(date: String, kind: String) = this@TartanShellPlugin.openSession(date, kind)
        override fun openActivity(id: String) = openWorkout(id)
        override fun chat(conversation: String?, prefill: String?) =
            notifyListeners("go", JSObject().put("hash", "").put("action", "chat").apply { conversation?.let { put("conversation", it) }; prefill?.let { put("prefill", it) } })
        override fun go(hash: String) = go(hash, null)
        override fun dismissWeekly(week: String) {
            weeklySeen = week
            prefs.edit().putString("weeklySeen", week).apply()
        }
        override suspend fun post(path: String, body: String?): String? {
            val (status, text) = api(path, "POST", body)
            if (status in 200..299) {
                val err = runCatching { org.json.JSONObject(text).optString("error").ifEmpty { null } }.getOrNull()
                return err
            }
            return runCatching { org.json.JSONObject(text).optString("error") }.getOrNull()?.ifEmpty { null } ?: str(R.string.shell_it_didn_t_go_through_2, status)
        }
        override suspend fun send(path: String, method: String, body: String?) = api(path, method, body)
        override suspend fun stream(path: String, body: String, onLine: (String) -> Unit): Int {
            val id = UUID.randomUUID().toString()
            streams[id] = onLine
            return try { api(path, "POST", body, id = id, stream = true).first } finally { streams.remove(id) }
        }
        override suspend fun watchWeek(send: Boolean) = shellApi.call("watchWeek", org.json.JSONObject().put("send", send)).getOrNull()?.let { runCatching { org.json.JSONObject(it) }.getOrNull() }
        override suspend fun planOut(op: String) = shellApi.call("planOut", org.json.JSONObject().put("op", op)).fold({ runCatching { org.json.JSONObject(it) }.getOrNull() }, { org.json.JSONObject().put("error", it.message) })
        override fun planMade(said: String) {
            this@TartanShellPlugin.said = said
            stale.addAll(listOf("today", "coach"))
            scope.launch { shellApi.call("syncSchedule"); fetchCoach() }
        }
    }
    /** What to ask the coach first, from what you have: a plan or not, a race or not. */
    private fun chatSuggestions(): List<String> {
        val c = coach
        return listOf(
            str(R.string.common_how_is_my_training_going),
            if (c?.plan != null) str(R.string.shell_should_i_change_anything_this_week) else str(R.string.common_make_me_a_training_plan),
            str(R.string.common_was_my_last_run_too_hard),
            c?.goal?.let { str(R.string.shell_am_i_on_track, it) } ?: str(R.string.shell_what_race_could_i_aim_for),
            str(R.string.common_why_has_my_easy_pace_changed),
        )
    }

    /** The first plan, made on Coach (kept while you look elsewhere). */
    private val planMaker by lazy { PlanMaker(scope, coachActions) }

    /** The chat: its conversation and messages live here, so they stay while you look elsewhere. */
    private val chat by lazy {
        ChatModel(scope, object : ChatApi {
            override suspend fun get(path: String) = this@TartanShellPlugin.get(path)
            override suspend fun prepare(conversation: String?) { api("/api/coach/prepare", "POST", org.json.JSONObject().put("conversation", conversation ?: org.json.JSONObject.NULL).toString()) }
            override suspend fun post(path: String, body: String) = api(path, "POST", body).let { (st, b) -> if (st in 200..299) b else null }
            override suspend fun stream(path: String, body: String, onLine: (String) -> Unit): Int {
                val id = UUID.randomUUID().toString()
                streams[id] = onLine
                return try { api(path, "POST", body, id = id, stream = true).first } finally { streams.remove(id) }
            }
        }).also { c ->
            // Away from the app while it answers: a Live Update, then "Your coach answered".
            c.onAnswered = { reply ->
                LiveUpdates.coachWorking(context, false)
                if (!inFront && reply.error == null) LiveUpdates.coachAnswered(context, reply.text, reply.by)
            }
        }
    }

    /** Settings: what Training, Coach and More show, and saving it. */
    private val settings by lazy {
        SettingsModel(scope, object : SettingsApi {
            override suspend fun get(path: String) = this@TartanShellPlugin.get(path)
            override suspend fun send(path: String, method: String, body: String?) = api(path, method, body)
            override suspend fun rpc(name: String, args: org.json.JSONObject) = api("rpc:$name", "POST", args.toString()).let { (st, b) -> if (st in 200..299) b else null }
        }) { tookInUse(it) }
    }

    /** The tools beyond the coach in use (src/in-use.ts): where each shows, the rest under More → More tools. Last time's at once; on the first start not known until the engine answers. */
    private var inUse by mutableStateOf(InUse.UNKNOWN)
    private fun tookInUse(u: InUse) {
        if (u == inUse) return
        inUse = u
        prefs.edit().putString("inUse", u.json()).apply()
    }
    private fun readInUse() = scope.launch {
        api("rpc:prefs", "POST", "{}").let { (st, b) -> if (st in 200..299) runCatching { InUse.parse(org.json.JSONObject(b).optJSONObject("inUse")) }.getOrNull()?.let { tookInUse(it) } }
    }
    private fun partsMap() = mapOf("nav" to navOn, "today" to todayOn, "coach" to coachOn, "chat" to chatOn, "activities" to activitiesOn, "progress" to progressOn, "settings" to settingsOn, "workout" to workoutOn, "body" to bodyOn, "routes" to routesOn, "record" to recordOn)
    private fun setPart(name: String, on: Boolean) {
        when (name) {
            "nav" -> navOn = on; "today" -> todayOn = on; "coach" -> coachOn = on; "chat" -> chatOn = on
            "activities" -> activitiesOn = on; "progress" -> progressOn = on; "settings" -> settingsOn = on; "workout" -> workoutOn = on; "body" -> bodyOn = on; "routes" -> routesOn = on; "record" -> recordOn = on
        }
        prefs.edit().putBoolean(name, on).apply()
        // The page draws what isn't native: it hears of the change.
        notifyListeners("parts", JSObject().apply { partsMap().forEach { (k, v) -> put(k, v) } })
        showScreen()
    }
    private val settingsActions = object : SettingsActions {
        override fun go(hash: String) = go(hash, null)
        override fun parts() = partsMap()
        override fun setPart(name: String, on: Boolean) = this@TartanShellPlugin.setPart(name, on)
    }

    /** Settings → Sources: Strava, the watch, files, Health Connect, your PC. */
    private val sources: SourcesModel by lazy { SourcesModel(scope, shellApi, garminLink) }

    /**
     * A Garmin watch (GarminLink): the plan to Tartan's watch app through Garmin Connect, when the
     * app opens, when the plan changes and when the watch asks. Only when the watch is a Garmin: a
     * Suunto never starts Garmin's SDK.
     */
    private val garminLink: GarminLink by lazy {
        GarminLink(context) { api("rpc:garminPlan", "POST", "{}").let { (st, b) -> if (st in 200..299) b else null } }.also { it.onWant = { garminSync(true) } }
    }
    private var garminBusy = false
    private fun garminSync(force: Boolean = false): kotlinx.coroutines.Job = scope.launch {
        if (garminBusy) return@launch
        val brand = api("rpc:watchBrand", "POST", "{}").let { (st, b) -> if (st in 200..299) runCatching { org.json.JSONObject(b).optString("brand") }.getOrNull() else null }
        if (!GarminMessage.goesToGarmin(brand)) return@launch
        garminBusy = true
        try { garminLink.sync(force)?.let { g -> activity.runOnUiThread { sources.garmin = g } } } finally { garminBusy = false }
    }

    /** The rest of Settings, native: shoes, the coach's AI, Watch, More. */
    private val settingsExtras by lazy {
        SettingsExtras(ShoesModel(scope, shellApi), CoachSetupModel(scope, shellApi), WatchGroupModel(scope, shellApi), MoreModel(scope, shellApi), sources)
    }

    /** Routes: the list, and the editor open (by the address: route/<id>, route/new, route/new/loop-10). */
    private val routes by lazy { RoutesModel(scope, shellApi) }
    private var routeEditor by mutableStateOf<RouteEditor?>(null)
    private val routesActions = object : RoutesActions { override fun go(hash: String) = this@TartanShellPlugin.go(hash, null) }
    private fun editorFor(h: String): RouteEditor {
        val parts = h.split("/")
        val id = parts.getOrNull(1)?.let { java.net.URLDecoder.decode(it, "UTF-8") } ?: "new"
        val loop = if (id == "new") Regex("^loop-(\\d+)$").find(parts.getOrNull(2) ?: "")?.groupValues?.get(1)?.toIntOrNull() ?: 0 else 0
        val cur = routeEditor
        // The same route (or one just saved from new): keep the editor as it is.
        if (cur != null && (cur.id == id || cur.savedId == id) && cur.wantLoop == loop) return cur
        return RouteEditor(scope, shellApi, id, loop).also { routeEditor = it }
    }

    /** Record: a run on the phone (the page's recorder; its state comes with every change). */
    private val record by lazy { RecordModel(scope, shellApi) }
    /** Lift: the strength session open (by the address: lift/<date>). */
    private var lift by mutableStateOf<LiftModel?>(null)
    private fun liftFor(h: String): LiftModel {
        val date = h.split("/").getOrNull(1)?.ifEmpty { null } ?: java.time.LocalDate.now().toString()
        lift?.takeIf { it.date == date }?.let { return it }
        return LiftModel(scope, shellApi, date).also { lift = it; it.load() }
    }

    /** The face builder open (by the address: face/<id>, face/new, face/copy). */
    private var face by mutableStateOf<FaceModel?>(null)
    private fun faceFor(h: String): FaceModel {
        val arg = h.split("/").getOrNull(1)?.ifEmpty { null }?.let { java.net.URLDecoder.decode(it, "UTF-8") } ?: "new"
        face?.takeIf { it.arg == arg || it.savedId == arg }?.let { return it }
        return FaceModel(scope, shellApi, arg) { settingsExtras.watch?.forget() }.also { face = it }
    }

    /** The first run, native while it's open (the page keeps which step it's at). */
    private var intro by mutableStateOf<IntroModel?>(null)

    /** Body: the muscles now, sleep and vitals. */
    private val body by lazy { BodyModel(scope, shellApi) }

    /** Progress: what it has read, by range and week. */
    private val progress by lazy { ProgressModel(scope) { get(it) } }
    private val progressActions = object : ProgressActions {
        override fun openActivity(id: String) = openWorkout(id)
        override fun go(hash: String) = go(hash, null)
    }

    private val activitiesActions = object : ActivitiesActions {
        override fun openActivity(id: String) = openWorkout(id)
        override fun go(hash: String) = go(hash, null)
    }

    @OptIn(ExperimentalLayoutApi::class)
    private fun attach() {
        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        val motionOff = reducedMotion
        // The native screens: the whole screen while one is up and nothing is open over it.
        val s = ComposeView(activity).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            visibility = View.GONE
            setContent {
                TartanTheme(wallpaper, motionOff) {
                    // Between tabs the screens slide the way the bar goes; to a web page this one slides
                    // out over it (the page slides in on its own underneath).
                    androidx.compose.runtime.CompositionLocalProvider(LocalBoard provides BoardState(board) { openBoard() }, LocalNavFold provides navFold, LocalInUse provides inUse) {
                    // Every screen opens with the bar at full size.
                    androidx.compose.runtime.LaunchedEffect(shown) { navFold.folded = false }
                    val foldScroll = androidx.compose.runtime.remember { navFold.connection(activity.resources.displayMetrics.density * 24f) }
                    // Under the screens as they slide, the app's own surface (not the window's grey); none
                    // while the page shows, so it slides in underneath.
                    val under by androidx.compose.animation.animateColorAsState(if (shown != null) androidx.compose.material3.MaterialTheme.colorScheme.surface else androidx.compose.ui.graphics.Color.Transparent, tween(220), label = "under")
                    AnimatedContent(
                        shown,
                        androidx.compose.ui.Modifier.fillMaxSize().background(under).nestedScroll(foldScroll),
                        transitionSpec = {
                            val d = if (forward) 1 else -1
                            (fadeIn(tween(220, 40)) + slideInHorizontally { d * it / 8 }) togetherWith (fadeOut(tween(160)) + slideOutHorizontally { -d * it / 8 })
                        },
                        label = "screens",
                    ) { which ->
                        when (which) {
                            "today" -> TodayScreen(today, refreshing, todayActions, navSpace = navOn, onFolded = { todayFolded = it }, onPull = { todayPull = it }, more = todayMore)
                            "coach" -> CoachScreen(coach, coachActions, weeklySeen, navSpace = navOn, maker = planMaker, setup = settingsExtras.coachSetup)
                            "chat" -> ChatScreen(chat, go = { go(it, null) }, navSpace = navOn, suggestions = chatSuggestions())
                            "activities" -> ActivitiesScreen(activities, activitiesActions, navSpace = navOn)
                            "trends" -> ProgressScreen(progress, progressActions, navSpace = navOn)
                            "settings" -> SettingsScreen(settings, settingsGroup, settingsActions, navSpace = navOn, sources = sources, extras = settingsExtras)
                            "you" -> BodyScreen(body, back = { notifyListeners("back", JSObject()) }, navSpace = navOn)
                            "routes" -> RoutesScreen(routes, routesActions, navSpace = navOn)
                            "route" -> routeEditor?.let { RouteEditorScreen(it, back = { go("routes", null) }, navSpace = navOn) }
                            "face" -> face?.let { FaceBuilderScreen(it, back = { notifyListeners("back", JSObject()) }, go = { h, word -> if (word != null) said = word; go(h, null) }, navSpace = false) }
                            "record" -> RecordScreen(record, back = { go("today", null) }, navSpace = false)
                            "lift" -> lift?.let { LiftScreen(it, back = { notifyListeners("back", JSObject()) }, done = { go("today", null) }, navSpace = false) }
                            else -> Spacer(Modifier.fillMaxSize())
                        }
                    }
                    // The board and the gear stay put above the sliding screens; the board folds in place.
                    // Not over the route editor: its own row (back, the name, where am I) holds the top.
                    androidx.compose.animation.AnimatedVisibility(shown != null && shown !in OWN_TOP, enter = fadeIn(), exit = fadeOut()) {
                        val onToday = shown == "today"
                        TopChrome(folded = !onToday || todayFolded, onSettings = { go("settings", null) }, pull = if (onToday) todayPull else 0f, syncing = onToday && refreshing, rec = record.rec.takeIf { shown != "record" }, onRec = { go("record", null) },
                            back = if (shown in SUB) ({ notifyListeners("back", JSObject()) }) else null)
                    }
                    workout?.let { w -> w.figure = body.figure; WorkoutSheet(w, onClose = { if (workout === w) closeWorkout() }, go = { go(it, null) }) }
                    session?.let { m -> SessionSheet(m, sessionActions) { word -> if (session === m) { session = null; said = word; screen?.let { it.removeCallbacks(hide); it.postDelayed(hide, 300) } } } }
                    pairing?.let { p -> PairSheet(p) { if (pairing === p) { pairing = null; sources.forget(); sources.ensure(); later() } } }
                    scanning?.let { hint -> QrScanner(hint) { text -> scanning = null; scanCall?.resolve(JSObject().put("text", text)); scanCall = null; later() } }
                    if (boardOpen) BoardSheet(board, { id -> notifyListeners("go", JSObject().put("hash", "").put("action", "laneSync").put("lane", id)) }) { boardOpen = false }
                    intro?.let { m -> IntroScreen(m, settings, sources, settingsExtras) { if (intro === m) { intro = null; screen?.let { it.removeCallbacks(hide); it.postDelayed(hide, 300) } } } }
                    androidx.compose.foundation.layout.Box(Modifier.fillMaxSize()) {
                        Said(said, { said = null }, Modifier.align(androidx.compose.ui.Alignment.BottomCenter).navigationBarsPadding().padding(bottom = if (navOn) 88.dp else 8.dp))
                    }
                    }
                }
            }
        }
        // The bar: its own height at the bottom, so touches above it reach the page.
        val bar = ComposeView(activity).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent {
                TartanTheme(wallpaper, motionOff) {
                    // The page's messages, native, over whatever shows (a native screen or the page) and
                    // above the bar: on top, so their buttons take the touch.
                    androidx.compose.foundation.layout.Column(horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
                        PageSnackbar(pageSnack, { id -> notifyListeners("snack", JSObject().put("id", id)) }, { pageSnack = null }, if (navOn) Modifier else Modifier.navigationBarsPadding())
                        // Out of the way while typing in a native screen too.
                        // Away while lifting, recording or designing a face too: those screens need the room and the thumb.
                        if (navOn) FloatingBar(tabOf(view), hidden || WindowInsets.isImeVisible || shown in FULL, onSelect = { go(it, null) }, atRoot = tabOf(view) == view, folded = navFold.folded, onUnfold = { navFold.folded = false })
                    }
                }
            }
        }
        // The native screens go under the page, which is see-through wherever it has nothing to
        // show (html.native-screen): its sheets, dialogs and messages then open over the native
        // screen, not over an empty page. Touches go to the native screen unless one is open
        // (routeTouch, from MainActivity). The bar stays on top.
        root.addView(s, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        bridge.webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        screen = s
        barView = bar
        current = java.lang.ref.WeakReference(this)
        showScreen()
        // Back, as Android apps do it (the page decides: web/lib/shell.ts onBack). Added after
        // Capacitor's own handler, so it comes first.
        activity.onBackPressedDispatcher.addCallback(activity, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // An unsaved route asks once before it's left.
                if (shown == "route" && routeEditor?.mayLeave() == false) return
                if (shown == "face" && face?.mayLeave() == false) return
                notifyListeners("back", JSObject())
            }
        })
    }

    /** Which native screen this view gets, if any. Coach only with a plan: making one is the web's still. */
    private fun nativeFor(v: String): String? = when {
        v == "today" && todayOn -> "today"
        v == "coach" && coachOn -> "coach"
        v == "chat" && chatOn -> "chat"
        v == "activities" && activitiesOn -> "activities"
        v == "trends" && progressOn -> "trends"
        v == "you" && bodyOn -> "you"
        v == "routes" && routesOn -> "routes"
        v == "route" && routesOn -> { editorFor(hash); "route" }
        v == "record" && recordOn -> "record"
        v == "face" && settingsOn -> { faceFor(hash); "face" }
        v == "lift" && recordOn -> { liftFor(hash); "lift" }
        v == "settings" && settingsOn -> settingsGroupOf(hash)?.let { settingsGroup = it; "settings" }
        else -> null
    }

    /** The native Settings group an address asks for (an unknown one: the last shown). */
    private fun settingsGroupOf(h: String): String? {
        // Back from Strava's sign-in (#sync): Sources.
        if (h.startsWith("sync")) return "sources"
        val parts = h.split("/")
        val g = parts.getOrNull(1)?.ifEmpty { null } ?: return settingsGroup
        return g.takeIf { it in NATIVE_SETTINGS } ?: settingsGroup
    }

    /**
     * The native screens take touches only while one is up; otherwise the view is gone and the page
     * gets them (after the slide out, so that shows).
     */
    private fun showScreen() {
        val next = nativeFor(view)
        // The page goes see-through over a native screen, and back to itself over its own.
        if ((next != null) != (shown != null) || !told) {
            told = true
            notifyListeners("screen", JSObject().put("native", next != null), true)
        }
        shown = next
        val s = screen ?: return
        s.removeCallbacks(hide)
        if (next != null) s.visibility = View.VISIBLE else s.postDelayed(hide, 300)
        when (next) {
            "chat" -> chat.ensure()
            "trends" -> progress.ensure()
            "settings" -> settings.ensure()
            "you" -> body.ensure()
            "routes" -> routes.ensure()
            "record" -> record.ensure()
            "lift", "face" -> {}
            null -> {}
            else -> freshen(next)
        }
    }
    private var told = false

    /** Where the current touch goes: the bar or the native screen; null while the page takes it. */
    private var touchTarget: View? = null

    /**
     * Touches over a native screen: the screen is under the page, so the page would take them.
     * While a native screen shows and nothing of the page's is open over it, a touch goes to the
     * bar when it lands on it, else to the screen. Null: the page takes it as usual.
     */
    fun routeTouch(ev: android.view.MotionEvent): Boolean? {
        if (ev.actionMasked == android.view.MotionEvent.ACTION_DOWN) {
            touchTarget = null
            val s = screen ?: return null
            if (shown == null || hidden || s.visibility != View.VISIBLE) return null
            val b = barView
            touchTarget = if (b != null && navOn && b.visibility == View.VISIBLE && deliver(b, ev)) b else s
            if (touchTarget === b) return true
        }
        val t = touchTarget ?: return null
        deliver(t, ev)
        if (ev.actionMasked == android.view.MotionEvent.ACTION_UP || ev.actionMasked == android.view.MotionEvent.ACTION_CANCEL) touchTarget = null
        return true
    }

    /** A window-coordinate touch to a view, in its own coordinates. */
    private fun deliver(v: View, ev: android.view.MotionEvent): Boolean {
        val at = IntArray(2).also { v.getLocationInWindow(it) }
        val e = android.view.MotionEvent.obtain(ev).apply { offsetLocation(-at[0].toFloat(), -at[1].toFloat()) }
        return try { v.dispatchTouchEvent(e) } finally { e.recycle() }
    }

    private val hide = Runnable { if (nativeFor(view) == null && workout == null && session == null && intro == null && pairing == null && scanning == null) screen?.visibility = View.GONE }

    /** Read a screen's data again only when something changed since, or the day did. */
    private fun freshen(which: String) {
        val day = java.time.LocalDate.now().toString()
        val have = when (which) { "today" -> today != null; "coach" -> coach != null; else -> activities != null }
        if (which == "chat") return
        if (which in stale || !have || readOn[which] != day) scope.launch {
            when (which) { "today" -> fetchToday(); "coach" -> fetchCoach(); else -> fetchActivities() }
        }
    }

    /** Ask the web app to show a screen (a hash), or a workout's sheet. */
    private fun go(hash: String, activityId: String?) {
        notifyListeners("go", JSObject().put("hash", hash).apply { activityId?.let { put("activity", it) } })
    }

    /** An API call answered by the web app (the phone's own data, or the paired PC's): status and body. */
    private suspend fun api(path: String, method: String = "GET", body: String? = null, id: String = UUID.randomUUID().toString(), stream: Boolean = false): Pair<Int, String> {
        val wait = CompletableDeferred<Pair<Int, String>>()
        pending[id] = wait
        // Kept until the page listens, for calls made while it is still starting.
        notifyListeners("api", JSObject().put("id", id).put("method", method).put("path", path).put("stream", stream).apply { body?.let { put("body", it) } }, true)
        return try {
            withTimeout(if (method == "GET") 20_000 else if (stream) 600_000 else 120_000) { wait.await() }
        } catch (_: Exception) {
            599 to ""
        } finally {
            pending.remove(id)
        }
    }

    private suspend fun get(path: String): String? = api(path).let { (st, b) -> if (st in 200..299) b else null }

    private suspend fun fetchToday() {
        stale.remove("today")
        val t = scope.async { get("/api/today") }
        val p = scope.async { get("/api/plan") }
        val todayJson = t.await() ?: run { stale.add("today"); return }
        val planJson = p.await()
        today = runCatching { parseToday(todayJson, planJson) }.getOrNull() ?: today
        readOn["today"] = java.time.LocalDate.now().toString()
        loadMore()
        prefs.edit().putString("todayJson", todayJson).putString("planJson", planJson).apply()
    }

    private suspend fun fetchCoach() {
        stale.remove("coach")
        val p = scope.async { get("/api/plan") }
        val st = scope.async { get("/api/coach/status") }
        val w = scope.async { get("/api/plan/weekly") }
        val planJson = p.await() ?: run { stale.add("coach"); return }
        val statusJson = st.await()
        val weeklyJson = w.await()
        coach = runCatching { parseCoach(planJson, statusJson, weeklyJson) }.getOrNull() ?: coach
        readOn["coach"] = java.time.LocalDate.now().toString()
        prefs.edit().putString("planJson", planJson).putString("statusJson", statusJson).putString("weeklyJson", weeklyJson).apply()
        // A plan made or gone: Coach draws again.
        activity.runOnUiThread { showScreen() }
    }

    private suspend fun fetchActivities() {
        stale.remove("activities")
        val json = get("/api/library/activities?limit=3000") ?: run { stale.add("activities"); return }
        activities = kotlinx.coroutines.withContext(Dispatchers.Default) { runCatching { parseActivities(json) }.getOrNull() } ?: activities
        readOn["activities"] = java.time.LocalDate.now().toString()
        scope.launch(Dispatchers.IO) { runCatching { activitiesFile.writeText(json) } }
    }

    @PluginMethod
    fun parts(call: PluginCall) {
        call.resolve(JSObject().put("available", true).apply { partsMap().forEach { (k, v) -> put(k, v) } })
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        call.getString("colours")?.let { wallpaper = it != "tartan" }
        activity.runOnUiThread { showScreen() }
        call.resolve(JSObject().apply { partsMap().forEach { (k, v) -> put(k, v) } })
    }

    @PluginMethod
    fun route(call: PluginCall) {
        val next = call.getString("view") ?: "today"
        val from = TABS.indexOfFirst { it.id == tabOf(view) }
        val to = TABS.indexOfFirst { it.id == tabOf(next) }
        if (from >= 0 && to >= 0 && from != to) forward = to > from
        // Within a tab: into a screen opened from it (the chat from Coach) goes forward, back out goes back.
        else if (from == to && next != view) forward = next != TABS.getOrNull(to)?.id
        view = next
        hash = call.getString("hash") ?: ""
        hidden = call.getBoolean("hidden") ?: false
        call.getString("colours")?.let { wallpaper = it != "tartan" }
        activity.runOnUiThread { showScreen() }
        call.resolve()
    }

    @PluginMethod
    fun reply(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("no id")
        pending[id]?.complete((call.getInt("status") ?: 599) to (call.getString("body") ?: ""))
        call.resolve()
    }

    /** One line of a streamed answer (the chat), as the page reads it. */
    @PluginMethod
    fun chunk(call: PluginCall) {
        val id = call.getString("id") ?: return call.resolve()
        val line = call.getString("line") ?: return call.resolve()
        val read = streams[id]
        if (read != null) activity.runOnUiThread { read(line) }
        call.resolve()
    }

    /** Open the chat: a conversation (null: a new one; absent: the latest) and words to start with. */
    @PluginMethod
    fun chat(call: PluginCall) {
        val given = call.data.has("conversation")
        val conversation = if (given && !call.data.isNull("conversation")) call.getString("conversation") else null
        val prefill = call.getString("prefill")
        activity.runOnUiThread { chat.open(conversation, given, prefill) }
        call.resolve()
    }

    /** A workout's sheet, asked for by the page (a workout opened from one of its screens): true when native. */
    @PluginMethod
    fun workout(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("no id")
        if (!workoutOn) return call.resolve(JSObject().put("native", false))
        val moments = call.getString("at") == "moments"
        activity.runOnUiThread { openWorkout(id, moments) }
        call.resolve(JSObject().put("native", true))
    }

    /** The watch as the page holds it, on every change: native Sources shows it. */
    @PluginMethod
    fun watch(call: PluginCall) {
        val st = call.getString("state")
        if (st != null) runCatching { parseWatch(st) }.getOrNull()?.let { w ->
            activity.runOnUiThread { sources.watch = w }
            // A backup under way: a Live Update while it lasts (the quick checks on open aren't).
            val big = w.job?.max?.let { it >= 5 } == true
            if (big || watchLive) { watchLive = big; LiveUpdates.watch(context, w.job.takeIf { big }) }
        }
        call.resolve()
    }

    /**
     * Where the phone is now, for the coach's routes ("a loop from here"): every location source
     * asked at once (fused, network, GPS), the first fix wins, within 25 s. A remembered fix only
     * when it's under 10 minutes old: an older one may be another city (you travelled since).
     * {} when there's no fresh fix, location is off or not allowed. With the fix's age and accuracy.
     */
    @PluginMethod
    @android.annotation.SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    fun here(call: PluginCall) {
        val fine = androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED
        val coarse = androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED
        val lm = context.getSystemService(android.location.LocationManager::class.java)
        if ((!fine && !coarse) || lm == null) return call.resolve(JSObject().put("why", str(R.string.shell_location_isn_t_allowed_for_tartan)))
        val all = buildList {
            if (android.os.Build.VERSION.SDK_INT >= 31) add(android.location.LocationManager.FUSED_PROVIDER)
            add(android.location.LocationManager.NETWORK_PROVIDER)
            add(android.location.LocationManager.GPS_PROVIDER)
        }
        val providers = all.filter { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }
        if (providers.isEmpty()) return call.resolve(JSObject().put("why", str(R.string.shell_location_is_off_on_the_phone)))
        val now = System.currentTimeMillis()
        val ageOf = { l: android.location.Location -> (now - l.time).coerceAtLeast(0) }
        val recent = providers.mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }.filter { ageOf(it) < 600_000 }.maxByOrNull { it.time }
        val answer = { l: android.location.Location? ->
            call.resolve(if (l == null) JSObject().put("why", str(R.string.shell_no_location_fix_in_25_seconds)) else JSObject().put("lon", l.longitude).put("lat", l.latitude).put("age_s", ageOf(l) / 1000).put("accuracy_m", if (l.hasAccuracy()) l.accuracy.toDouble() else JSObject.NULL))
        }
        // Under a minute old: good as new.
        if (recent != null && ageOf(recent) < 60_000) return answer(recent)
        var done = false
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        // The first fix from any source; none in 25 s: the remembered one if it's under 10 minutes old.
        val first = { l: android.location.Location? -> if (l != null && !done) { done = true; answer(l) } }
        handler.postDelayed({ if (!done) { done = true; answer(recent) } }, 25_000)
        for (p in providers) runCatching {
            if (android.os.Build.VERSION.SDK_INT >= 30) lm.getCurrentLocation(p, null, context.mainExecutor) { l -> first(l) }
            else lm.requestSingleUpdate(p, { l: android.location.Location -> first(l) }, android.os.Looper.getMainLooper())
        }
    }

    /** A message from the page over a native screen: a native snackbar, so its buttons take the touch. */
    @PluginMethod
    fun snack(call: PluginCall) {
        val s = PageSnack(call.getInt("id") ?: 0, call.getString("text") ?: "", call.getBoolean("error") ?: false, call.getString("action"), call.getInt("ms")?.toLong())
        activity.runOnUiThread { pageSnack = s }
        call.resolve()
    }

    /** Scan a QR code natively for the page; resolves with the text (null: cancelled). */
    @PluginMethod
    fun scan(call: PluginCall) {
        activity.runOnUiThread {
            scanCall?.resolve(JSObject().put("text", null as String?))
            scanCall = call
            scanning = call.getString("hint") ?: str(R.string.shell_point_at_the_qr_code)
            screen?.let { it.removeCallbacks(hide); it.visibility = View.VISIBLE }
        }
    }

    /** The PC's pairing link: the native sheet. */
    @PluginMethod
    fun pair(call: PluginCall) {
        val a = call.getArray("urls")
        val urls = (0 until (a?.length() ?: 0)).map { a!!.optString(it) }
        val p = PairModel(scope, shellApi, urls, call.getString("code") ?: "", call.getBoolean("ask") ?: true)
        activity.runOnUiThread { pairing = p; screen?.let { it.removeCallbacks(hide); it.visibility = View.VISIBLE } }
        call.resolve()
    }

    /** The screens' view goes once nothing native is left over the page. */
    private fun later() { screen?.let { it.removeCallbacks(hide); it.postDelayed(hide, 300) } }

    /** The intro, at a step (first run, or Settings → More → the intro again). */
    @PluginMethod
    fun intro(call: PluginCall) {
        val step = call.getInt("step") ?: 0
        activity.runOnUiThread {
            if (intro?.leaving != false) intro = IntroModel(scope, shellApi, step)
            screen?.let { it.removeCallbacks(hide); it.visibility = View.VISIBLE }
        }
        call.resolve()
    }

    /** The run being recorded, as the page's recorder holds it, on every change: native Record shows it. */
    @PluginMethod
    fun recorder(call: PluginCall) {
        val st = call.getString("state")
        if (st != null) runCatching { parseRec(st) }.getOrNull()?.let { r ->
            activity.runOnUiThread { record.rec = r }
            // The run in the status bar and on the lock screen (Live Update), while it's recorded.
            LiveUpdates.run(context, r)
            dev.freesuunto.app.TodayWidget.recording(context, r)
        }
        call.resolve()
    }

    /** The sync board's lanes, as the web chip shows them (app.ts showBoard). */
    @PluginMethod
    fun board(call: PluginCall) {
        val a = call.getArray("lanes")
        board = (0 until (a?.length() ?: 0)).mapNotNull { i ->
            val o = a!!.optJSONObject(i) ?: return@mapNotNull null
            Lane(o.optString("id"), o.optString("state"), o.optString("text"), o.optString("glyph"), o.optString("name"), o.optString("status"), o.optBoolean("failed"))
        }
        call.resolve()
    }

    /** A click you feel, asked for by the page (its rows of choices slide like the bar). */
    @PluginMethod
    fun feel(call: PluginCall) {
        val h = when (call.getString("kind")) { "detent" -> Haptic.Detent; "confirm" -> Haptic.Confirm; else -> Haptic.Click }
        activity.runOnUiThread { bridge.webView.feel(h) }
        call.resolve()
    }

    /** The page wrote something (a sync brought workouts in, a session was marked, a plan saved…). */
    @PluginMethod
    fun changed(call: PluginCall) {
        stale.addAll(listOf("today", "coach", "activities"))
        // Something new may be in use now (a route saved, a watch read, a PC paired).
        readInUse()
        // Progress reads again what it shows; other ranges when they're next picked.
        activity.runOnUiThread {
            progress.forget(); if (shown == "trends") progress.ensure()
            settings.forget(); if (shown == "settings") settings.ensure()
            sources.forget(); if (shown == "settings" && settingsGroup == "sources") sources.ensure()
            settingsExtras.watch?.forget()
            body.forget(); if (shown == "you") body.ensure()
            routes.forget(); if (shown == "routes") routes.ensure()
        }
        synced?.complete(Unit)
        activity.runOnUiThread { shown?.let { freshen(it) } }
        // The plan may have changed: a Garmin gets it again if so (only changes go).
        garminSync()
        call.resolve()
    }

    /** Back on Today with nothing open: leave, to the home screen (the app stays as it was). */
    @PluginMethod
    fun leave(call: PluginCall) {
        activity.runOnUiThread { activity.moveTaskToBack(true) }
        call.resolve()
    }

    companion object {
        /** Screens that take the whole screen: no floating bar over them. */
        private val FULL = setOf("lift", "record", "face")
        /** Screens opened from a tab, with back in the top controls (the page's Back: the chat to Coach). */
        private val SUB = setOf("chat", "you", "record", "lift")
        /** Screens with their own row across the top: no board chip or gear over them. */
        private val OWN_TOP = setOf("route")
        private var current: java.lang.ref.WeakReference<TartanShellPlugin>? = null

        /** Pause or Resume from the run's notification (LiveUpdates.RunActions). */
        fun runAction(what: String) {
            val p = current?.get() ?: return
            p.activity.runOnUiThread { if (what == "pause") p.record.pause() else p.record.resume() }
        }

        /** MainActivity's dispatchTouchEvent asks here first (see routeTouch). */
        @JvmStatic
        fun route(ev: android.view.MotionEvent): Boolean? = current?.get()?.routeTouch(ev)
    }

    /** Whether Tartan is on screen: the coach's answer is a notification only when it isn't. */
    private var inFront = true
    private var watchLive = false

    override fun handleOnPause() {
        super.handleOnPause()
        inFront = false
        if (chat.busy) LiveUpdates.coachWorking(context, true)
    }

    override fun handleOnResume() {
        inFront = true
        LiveUpdates.coachWorking(context, false)
        super.handleOnResume()
        shown?.let { freshen(it) }
        garminSync()
    }
}
