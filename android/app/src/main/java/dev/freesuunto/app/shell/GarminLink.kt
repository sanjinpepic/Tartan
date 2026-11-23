package dev.freesuunto.app.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.garmin.android.connectiq.ConnectIQ
import com.garmin.android.connectiq.IQApp
import com.garmin.android.connectiq.IQDevice
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/** A Garmin watch as Garmin Connect reports it. */
data class GarminDevice(val id: Long, val name: String, val connected: Boolean)

/** The Garmin watch Tartan works with: its name, Garmin Connect, whether Tartan's app is on it, the last plan sent. */
data class GarminNow(
    val name: String,
    /** "ok", "missing" (Garmin Connect isn't installed), "update" (too old) or "error". */
    val gcm: String,
    /** Tartan's watch app on the watch: true, false, or null (not known: the watch is away). */
    val app: Boolean?,
    val sentTitle: String?,
    val sentDate: String?,
    val sentAt: Long?,
    val error: String?,
)

/** What the screens ask of the Garmin side (GarminLink on a phone; a stand-in in the screenshot tests). */
interface GarminApi {
    /** The watches Garmin Connect knows, or null when Garmin Connect isn't on this phone. */
    suspend fun known(): List<GarminDevice>?
    /** Work with this watch from now on: remember it and send it the plan. */
    suspend fun use(d: GarminDevice): GarminNow
    /** How the watch stands (null: no Garmin set). */
    suspend fun now(): GarminNow?
    /** Send the plan again now. */
    suspend fun sendNow(): GarminNow?
    /** Not a Garmin any more: forget it. */
    fun forget()
    /** Where to get Tartan's watch app (the release page, docs/garmin.md). */
    fun getWatchApp()
    /** Garmin Connect in the Play Store. */
    fun getGarminConnect()
}

/**
 * Garmin's Connect IQ companion SDK (com.garmin.connectiq:ciq-companion-app-sdk): the watches
 * Garmin Connect knows, messages to and from Tartan's watch app (garmin/), whether the app is on
 * the watch. Started only when the watch is a Garmin (or Find my watch looks for one); a phone with
 * a Suunto never touches it.
 *
 * The plan goes when the app opens, when the plan changes (TartanShellPlugin.changed) and when the
 * watch app asks ({ t: "want" }); only when it changed since the last send, unless asked.
 *
 * The other way, the watch app sends the day's body numbers ({ t: "day" }, garmin/source/Body.mc)
 * about every half hour and when it opens; they reach `onDay` while Tartan's process is alive (the
 * SDK hands messages only to a running Tartan: one while it's closed is lost). So each time Tartan
 * opens or comes back, the phone asks the watch for its day again ({ t: "ask" }), at most every
 * ten minutes.
 */
class GarminLink(private val context: Context, private val plan: suspend () -> String?) : GarminApi {
    private val prefs = context.getSharedPreferences("garmin", Context.MODE_PRIVATE)
    private var ciq: ConnectIQ? = null
    private var ready: CompletableDeferred<String>? = null
    private val app = IQApp(APP_ID)
    private var listening: IQDevice? = null
    /** The watch asked for the plan (it opened, or it has none). */
    var onWant: (() -> Unit)? = null
    /** The watch sent the day's body numbers (GarminMessage.signalsFor checks them). */
    var onDay: ((Any?) -> Unit)? = null

    /** Garmin Connect's SDK, set up once: "ok", "missing", "update" or "error". */
    private suspend fun start(): String {
        ready?.let { return withTimeoutOrNull(8000) { it.await() } ?: "error" }
        val d = CompletableDeferred<String>()
        ready = d
        val c = ConnectIQ.getInstance(context.applicationContext, ConnectIQ.IQConnectType.WIRELESS)
        ciq = c
        runCatching {
            // No dialogs of Garmin's own: the screens say what's missing, in Tartan's words.
            c.initialize(context.applicationContext, false, object : ConnectIQ.ConnectIQListener {
                override fun onSdkReady() { d.complete("ok") }
                override fun onInitializeError(status: ConnectIQ.IQSdkErrorStatus?) {
                    d.complete(when (status) { ConnectIQ.IQSdkErrorStatus.GCM_NOT_INSTALLED -> "missing"; ConnectIQ.IQSdkErrorStatus.GCM_UPGRADE_NEEDED -> "update"; else -> "error" })
                    ready = null
                }
                override fun onSdkShutDown() { ready = null; listening = null }
            })
        }.onFailure { d.complete("error"); ready = null }
        return withTimeoutOrNull(8000) { d.await() } ?: "error"
    }

    override suspend fun known(): List<GarminDevice>? {
        val s = start()
        if (s == "missing" || s == "update") return null
        if (s != "ok") return emptyList()
        val c = ciq ?: return emptyList()
        val connected = runCatching { c.connectedDevices.map { it.deviceIdentifier }.toSet() }.getOrDefault(emptySet())
        return runCatching { c.knownDevices.map { GarminDevice(it.deviceIdentifier, it.friendlyName ?: "Garmin watch", it.deviceIdentifier in connected) } }.getOrDefault(emptyList())
    }

    private fun device(): IQDevice? {
        val id = prefs.getLong("id", 0L).takeIf { it != 0L } ?: return null
        return IQDevice(id, prefs.getString("name", "") ?: "")
    }

    override suspend fun use(d: GarminDevice): GarminNow {
        prefs.edit().putLong("id", d.id).putString("name", d.name).remove("key").remove("askedAt").apply()
        listening = null
        return sendNow() ?: GarminNow(d.name, "ok", null, null, null, null, null)
    }

    override fun forget() {
        runCatching { device()?.let { ciq?.unregisterForEvents(it) } }
        listening = null
        prefs.edit().clear().apply()
    }

    /** Listen for the watch app asking for the plan. */
    private fun listen(c: ConnectIQ, dev: IQDevice) {
        if (listening == dev) return
        runCatching {
            c.registerForAppEvents(dev, app) { _, _, messages, _ ->
                val all = messages.orEmpty()
                all.filter { GarminMessage.isDay(it) }.forEach { onDay?.invoke(it) }
                if (all.any { GarminMessage.asksForPlan(it) }) onWant?.invoke()
            }
            listening = dev
        }
    }

    /** Whether Tartan's app is on the watch (null when the watch doesn't answer). */
    private suspend fun installed(c: ConnectIQ, dev: IQDevice): Boolean? {
        val d = CompletableDeferred<Boolean?>()
        runCatching {
            c.getApplicationInfo(APP_ID, dev, object : ConnectIQ.IQApplicationInfoListener {
                override fun onApplicationInfoReceived(a: IQApp?) { d.complete(true) }
                override fun onApplicationNotInstalled(id: String?) { d.complete(false) }
            })
        }.onFailure { d.complete(null) }
        return withTimeoutOrNull(6000) { d.await() }
    }

    override suspend fun now(): GarminNow? {
        val dev = device() ?: return null
        return GarminNow(dev.friendlyName ?: "", prefs.getString("gcm", "ok") ?: "ok", if (prefs.contains("app")) prefs.getBoolean("app", false) else null, prefs.getString("title", null), prefs.getString("date", null), prefs.getLong("at", 0L).takeIf { it > 0 }, prefs.getString("error", null))
    }

    override suspend fun sendNow(): GarminNow? = sync(force = true)

    /**
     * The plan to the watch, when the watch is a Garmin and it changed since the last send (or
     * `force`). Says how it went in now().
     */
    suspend fun sync(force: Boolean = false): GarminNow? {
        val saved = device() ?: return null
        val s = start()
        prefs.edit().putString("gcm", s).apply()
        if (s != "ok") return now()
        val c = ciq ?: return now()
        // Garmin Connect's own record of the watch, when it has it (its status with it).
        val dev = runCatching { c.knownDevices.firstOrNull { it.deviceIdentifier == saved.deviceIdentifier } }.getOrNull() ?: saved
        listen(c, dev)
        val got = installed(c, dev)
        if (got != null) prefs.edit().putBoolean("app", got).apply()
        if (got == false) { prefs.edit().putString("error", null).apply(); return now() }
        val (key, msg) = GarminMessage.fromEngine(plan()) ?: return now().also { askDay(c, dev) }
        if (!force && key == prefs.getString("key", null)) return now().also { askDay(c, dev) }
        val status = CompletableDeferred<ConnectIQ.IQMessageStatus?>()
        runCatching { c.sendMessage(dev, app, msg) { _, _, st -> status.complete(st) } }.onFailure { status.complete(null) }
        val st = withTimeoutOrNull(20_000) { status.await() }
        val first = GarminMessage.firstTitle(msg)
        if (st == ConnectIQ.IQMessageStatus.SUCCESS) {
            prefs.edit().putString("key", key).putString("title", first?.first).putString("date", first?.second).putLong("at", System.currentTimeMillis()).putString("error", null).apply()
        } else {
            prefs.edit().putString("error", when (st) {
                ConnectIQ.IQMessageStatus.FAILURE_DEVICE_NOT_CONNECTED, null -> "not connected"
                ConnectIQ.IQMessageStatus.FAILURE_MESSAGE_TOO_LARGE -> "too large"
                else -> st.name.lowercase()
            }).apply()
        }
        askDay(c, dev)
        return now()
    }

    /**
     * Ask the watch app for the day's numbers (it answers with { t: "day" }, to onDay): on the
     * watches whose background takes phone messages it answers even when closed, on the others the
     * next time it opens (when it sends its day anyway). At most every ten minutes.
     */
    private suspend fun askDay(c: ConnectIQ, dev: IQDevice) {
        if (System.currentTimeMillis() - prefs.getLong("askedAt", 0L) < 10 * 60_000L) return
        prefs.edit().putLong("askedAt", System.currentTimeMillis()).apply()
        val done = CompletableDeferred<Unit>()
        runCatching { c.sendMessage(dev, app, GarminMessage.ASK_DAY) { _, _, _ -> done.complete(Unit) } }.onFailure { done.complete(Unit) }
        withTimeoutOrNull(20_000) { done.await() }
    }

    /** A day the engine couldn't take when it came (signalsPut's arguments): kept for the next sync. */
    fun keepDay(args: String) { prefs.edit().putString("dayKept", args).apply() }
    /** The day kept, taken out (null when none). */
    fun takeKeptDay(): String? = prefs.getString("dayKept", null)?.also { prefs.edit().remove("dayKept").apply() }

    override fun getWatchApp() = open(WATCH_APP_URL)
    override fun getGarminConnect() = open("market://details?id=$GCM_PACKAGE")

    private fun open(url: String) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            .onFailure { if (url.startsWith("market:")) open("https://play.google.com/store/apps/details?id=$GCM_PACKAGE") }
    }

    companion object {
        /** Tartan's watch app (garmin/manifest.xml). */
        const val APP_ID = "7bc40c05-a772-4b51-a5ed-b3aeb2671553"
        const val GCM_PACKAGE = "com.garmin.android.apps.connectmobile"
        const val WATCH_APP_URL = "https://github.com/sanjinpepic/Tartan/releases/tag/garmin"
    }
}
