package dev.freesuunto.app.shell

import dev.freesuunto.app.R
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** A point as the routes store it: longitude, latitude. */
typealias LngLat = Pair<Double, Double>

data class RouteItem(val id: String, val name: String, val km: Double, val ascent: Int?, val loop: Boolean, val onWatch: Boolean, val preview: List<LngLat>)

/** One leg between two points: along paths (as found) or straight. */
class Seg(val mode: String, val coords: List<LngLat>)

data class Loop(val km: Double, val bearing: Double, val waypoints: List<LngLat>, val legs: List<List<LngLat>>)

data class PaceSplit(val km: Int, val metres: Double, val paceS: Double, val cumulativeS: Double, val climbM: Int)

/** Metres between two points (src/routes.ts metres: haversine). */
fun metres(a: LngLat, b: LngLat): Double {
    val r = 6371008.8
    val p1 = Math.toRadians(a.second); val p2 = Math.toRadians(b.second)
    val dp = p2 - p1; val dl = Math.toRadians(b.first - a.first)
    val h = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
    return 2 * r * atan2(sqrt(h), sqrt(1 - h))
}

/** The whole line of legs, without the repeated joins (src/routes.ts lineOf). */
fun lineOf(segs: List<Seg>): List<LngLat> {
    val out = ArrayList<LngLat>()
    segs.forEach { s -> s.coords.forEachIndexed { i, p -> if (i > 0 || out.isEmpty() || out.last() != p) out.add(p) } }
    return out
}

/** Climb and descent from heights, ignoring wobbles under 3 m (src/routes.ts climb). */
fun climb(h: List<Double>): Pair<Int, Int> {
    var up = 0.0; var down = 0.0
    var ref = h.firstOrNull() ?: return 0 to 0
    for (v in h.drop(1)) {
        val d = v - ref
        if (d >= 3) { up += d; ref = v } else if (d <= -3) { down -= d; ref = v }
    }
    return Math.round(up).toInt() to Math.round(down).toInt()
}

fun kmText(m: Double) = if (m < 10_000) String.format(java.util.Locale.getDefault(), "%.2f", m / 1000) else String.format(java.util.Locale.getDefault(), "%.1f", m / 1000)

private fun pts(a: JSONArray?): List<LngLat> = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONArray(it)?.let { p -> p.optDouble(0) to p.optDouble(1) } }
private fun JSONArray.ofPoints(l: List<LngLat>) = apply { l.forEach { put(JSONArray().put(it.first).put(it.second)) } }
fun pointsJson(l: List<LngLat>) = JSONArray().ofPoints(l)

fun parseRoutes(json: String): Pair<List<RouteItem>, LngLat?> {
    val o = JSONObject(json)
    val a = o.optJSONArray("routes")
    val list = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { r ->
        RouteItem(r.optString("id"), r.optString("name"), r.optDouble("distance_m", 0.0), if (r.has("ascent_m") && !r.isNull("ascent_m")) r.optInt("ascent_m") else null, r.optBoolean("loop"), r.has("watch") && !r.isNull("watch"), pts(r.optJSONArray("preview")))
    }
    val home = o.optJSONArray("home")?.let { it.optDouble(0) to it.optDouble(1) }
    return list to home
}

/** Routes: the list (Activities → Routes) and importing a GPX file. */
class RoutesModel(private val scope: CoroutineScope, val api: SettingsApi) {
    var routes by mutableStateOf<List<RouteItem>?>(null)
    var home by mutableStateOf<LngLat?>(null)
    var said by mutableStateOf<String?>(null)
    private var read = false

    fun forget() { read = false }
    fun ensure() {
        if (read) return
        read = true
        scope.launch { api.get("/api/routes")?.let { runCatching { parseRoutes(it) }.getOrNull() }?.let { (l, h) -> routes = l; home = h } }
    }

    /** A GPX file picked on the phone; the new route's id (it opens in the editor). */
    suspend fun import(name: String, text: String): String? {
        val (st, body) = api.send("/api/routes/import?name=${java.net.URLEncoder.encode(name.removeSuffix(".gpx").removeSuffix(".GPX"), "UTF-8")}", "POST", text)
        val r = runCatching { JSONObject(body) }.getOrNull()
        if (st !in 200..299 || r == null) { said = r?.optString("error")?.ifEmpty { null } ?: str(R.string.routes_couldn_t_import_it, st); return null }
        said = str(R.string.routes_imported, r.optString("name"), kmText(r.optDouble("distance_m")))
        read = false
        return r.optString("id")
    }
}

/**
 * The route editor (web/views/routes.ts renderRouteEditor): points tapped on the map, each leg
 * along paths (the page asks the path finder) or straight, undo, back to start, out and back,
 * reverse; heights and the profile once the line settles; loops from here; save, send to the
 * watch or share as GPX; race pacing for a target time.
 */
class RouteEditor(private val scope: CoroutineScope, val api: SettingsApi, val id: String, val wantLoop: Int) {
    var loaded by mutableStateOf(id == "new")
    var missing by mutableStateOf(false)
    var savedId by mutableStateOf<String?>(null)
    var name by mutableStateOf("")
    var wp by mutableStateOf<List<LngLat>>(emptyList())
    var segs by mutableStateOf<List<Seg>>(emptyList())
    var pending by mutableStateOf<Set<Seg>>(emptySet())
    var elevation by mutableStateOf<List<Double>?>(null)
    var mode by mutableStateOf("paths")
    var dirty by mutableStateOf(false)
    var loops by mutableStateOf<List<Loop>>(emptyList())
    var finding by mutableStateOf<Int?>(null)
    var busy by mutableStateOf<String?>(null)
    var said by mutableStateOf<String?>(null)
    var status by mutableStateOf<String?>(null)
    /** The first sight of the route to fit the map to (set once loaded). */
    var fitTo by mutableStateOf<List<LngLat>?>(null)
    private val undo = ArrayList<Pair<List<LngLat>, List<Seg>>>()
    var canUndo by mutableStateOf(false)
    private var heightsJob: Job? = null
    private var leaveArmed = false

    val line get() = lineOf(segs)
    val total get() = line.let { l -> (1 until l.size).sumOf { metres(l[it - 1], l[it]) } }

    fun load() = scope.launch {
        if (id == "new") return@launch
        val json = api.get("/api/routes/${java.net.URLEncoder.encode(id, "UTF-8")}") ?: run { missing = true; return@launch }
        runCatching {
            val r = JSONObject(json)
            savedId = r.optString("id")
            name = r.optString("name")
            wp = pts(r.optJSONArray("waypoints"))
            val a = r.optJSONArray("segments")
            segs = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { Seg(it.optString("mode", "straight"), pts(it.optJSONArray("coords"))) }
            elevation = r.optJSONArray("elevation")?.let { e -> (0 until e.length()).map { e.optDouble(it) } }
            fitTo = line
        }.onFailure { missing = true }
        loaded = true
    }

    private fun snapshot() {
        undo.add(wp to segs)
        if (undo.size > 60) undo.removeAt(0)
        canUndo = true
        dirty = true
    }

    /** A leg from a to b: straight at once, then along paths when the path finder answers. */
    private fun segment(a: LngLat, b: LngLat): Seg {
        val s = Seg(mode, listOf(a, b))
        if (mode == "paths") {
            pending = pending + s
            scope.launch {
                val r = api.call("routePath", JSONObject().put("a", JSONArray().put(a.first).put(a.second)).put("b", JSONArray().put(b.first).put(b.second))).getOrNull()?.let { runCatching { JSONObject(it) }.getOrNull() }
                pending = pending - s
                val i = segs.indexOf(s)
                if (i < 0) return@launch settled()
                val found = r?.optJSONArray("line")?.let { pts(it) }?.takeIf { it.size >= 2 }
                segs = segs.toMutableList().also { it[i] = if (found != null) Seg("paths", found) else Seg("straight", listOf(a, b)) }
                if (found == null) said = if (r?.optString("reason") == "no-path") str(R.string.routes_no_path_between_those_points_so) else str(R.string.routes_couldn_t_reach_the_path_finder)
                settled()
            }
        }
        return s
    }

    fun add(p: LngLat) {
        snapshot()
        if (wp.isNotEmpty()) segs = segs + segment(wp.last(), p)
        wp = wp + p
        settled()
    }

    fun move(i: Int, p: LngLat) {
        snapshot()
        wp = wp.toMutableList().also { it[i] = p }
        segs = segs.toMutableList().also { s ->
            if (i > 0) s[i - 1] = segment(wp[i - 1], p)
            if (i < wp.size - 1) s[i] = segment(p, wp[i + 1])
        }
        settled()
    }

    fun remove(i: Int) {
        snapshot()
        when {
            wp.size == 1 -> { wp = emptyList(); segs = emptyList() }
            i == 0 -> { wp = wp.drop(1); segs = segs.drop(1) }
            i == wp.size - 1 -> { wp = wp.dropLast(1); segs = segs.dropLast(1) }
            else -> {
                val s = segs.toMutableList()
                s.subList(i - 1, i + 1).clear()
                s.add(i - 1, segment(wp[i - 1], wp[i + 1]))
                segs = s
                wp = wp.toMutableList().also { it.removeAt(i) }
            }
        }
        settled()
    }

    fun toStart() { if (wp.size >= 2) add(wp.first()) }

    fun outAndBack() {
        if (wp.size < 2) return
        snapshot()
        val back = segs.reversed().map { Seg(it.mode, it.coords.reversed()) }
        wp = wp + wp.dropLast(1).reversed()
        segs = segs + back
        settled()
    }

    fun reverse() {
        if (wp.size < 2) return
        snapshot()
        wp = wp.reversed()
        segs = segs.reversed().map { Seg(it.mode, it.coords.reversed()) }
        settled()
    }

    fun undo() {
        val h = undo.removeLastOrNull() ?: return
        wp = h.first; segs = h.second
        canUndo = undo.isNotEmpty()
        settled()
    }

    /** Heights follow once the line has settled (half a second without a change). */
    private fun settled() {
        heightsJob?.cancel()
        val l = line
        if (l.size < 2) { elevation = null; return }
        if (pending.isNotEmpty() || elevation?.size == l.size) return
        elevation = null
        heightsJob = scope.launch {
            delay(500)
            val h = api.call("routeHeights", JSONObject().put("line", pointsJson(l))).getOrNull()?.takeIf { it != "null" }?.let { j -> runCatching { JSONArray(j).let { a -> (0 until a.length()).map { a.optDouble(it) } } }.getOrNull() }
            if (lineOf(segs) == l) elevation = h
        }
    }

    fun findLoops(km: Int, start: LngLat) {
        finding = km
        status = str(R.string.routes_finding_km_loops, km)
        scope.launch {
            api.call("routeLoops", JSONObject().put("start", JSONArray().put(start.first).put(start.second)).put("km", km)).fold({ j ->
                val a = JSONArray(j)
                loops = (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { l ->
                    val legs = l.optJSONArray("legs")
                    Loop(l.optDouble("km"), l.optDouble("bearing"), pts(l.optJSONArray("waypoints")), if (legs == null) emptyList() else (0 until legs.length()).map { pts(legs.optJSONArray(it)) })
                }
                if (loops.isEmpty()) said = str(R.string.routes_no_km_loop_along_paths_from, km)
                else fitTo = loops.flatMap { it.legs.flatten() }
            }, { said = it.message })
            finding = null
            status = null
        }
    }

    fun pickLoop(l: Loop) {
        snapshot()
        wp = l.waypoints
        segs = l.legs.map { Seg("paths", it) }
        if (name.isBlank()) name = str(R.string.routes_km_loop, String.format(java.util.Locale.getDefault(), "%.1f", l.km))
        loops = emptyList()
        settled()
    }

    private fun defaultName(): String {
        val l = line
        val loop = l.size > 2 && metres(l.first(), l.last()) < 60
        return str(if (loop) R.string.routes_km_loop else R.string.routes_km_route, kmText(total))
    }

    private fun body(watch: JSONObject? = null) = JSONObject().apply {
        put("name", name.trim().ifEmpty { defaultName() })
        put("waypoints", pointsJson(wp))
        put("segments", JSONArray().apply { segs.forEach { put(JSONObject().put("mode", it.mode).put("coords", pointsJson(it.coords))) } })
        elevation?.takeIf { it.size == line.size }?.let { put("elevation", JSONArray(it)) }
        watch?.let { put("watch", it) }
    }

    /** Save; the saved route (its id, and the name it got). */
    suspend fun persist(watch: JSONObject? = null): JSONObject? {
        if (pending.isNotEmpty()) { said = str(R.string.routes_still_finding_the_way_try_again); return null }
        val (st, text) = api.send("/api/routes/${savedId ?: "new"}", "PUT", body(watch).toString())
        val r = runCatching { JSONObject(text) }.getOrNull()
        if (st !in 200..299 || r == null) { said = str(R.string.common_couldnt_save, r?.optString("error") ?: st.toString()); return null }
        savedId = r.optString("id"); name = r.optString("name"); dirty = false
        return r
    }

    fun save() { busy = "save"; scope.launch { persist()?.let { said = str(R.string.common_saved_name, it.optString("name")) }; busy = null } }

    fun send() {
        busy = "send"
        scope.launch {
            val r = persist()
            if (r != null) {
                status = str(R.string.routes_sending_to_the_watch)
                val args = JSONObject().put("name", r.optString("name")).put("line", pointsJson(line)).put("waypoints", pointsJson(wp))
                elevation?.takeIf { it.size == line.size }?.let { args.put("elevation", JSONArray(it)) }
                api.call("routeToWatch", args).fold({ j ->
                    val sent = JSONObject().put("id", JSONObject(j).optInt("id")).put("sent", java.time.Instant.now().toString()).put("name", r.optString("name"))
                    persist(sent)
                    said = str(R.string.routes_on_your_watch_find, r.optString("name"))
                }, { said = str(R.string.routes_still_through_suunto, it.message ?: str(R.string.routes_didnt_go)) })
                status = null
            }
            busy = null
        }
    }

    fun gpx() { busy = "gpx"; scope.launch { persist()?.let { api.call("routeGpx", JSONObject().put("id", it.optString("id"))).onFailure { e -> said = e.message } }; busy = null } }

    /** Leaving with unsaved points: one tap more. True when it may go. */
    fun mayLeave(): Boolean {
        if (!dirty || wp.size < 2 || leaveArmed) return true
        leaveArmed = true
        said = str(R.string.routes_this_route_isn_t_saved_tap)
        scope.launch { delay(4000); leaveArmed = false }
        return false
    }

    // ---- race pacing
    var splits by mutableStateOf<List<PaceSplit>?>(null)
    private var pacing: JSONObject? = null
    var pacingLine by mutableStateOf<String?>(null)

    fun pace(time: String) {
        busy = "pace"
        scope.launch {
            val args = JSONObject().put("time", time).put("line", pointsJson(line))
            elevation?.takeIf { it.size == line.size }?.let { args.put("elevation", JSONArray(it)) }
            api.call("racePacing", args).fold({ j ->
                val o = JSONObject(j)
                pacing = o
                val a = o.optJSONArray("splits")
                splits = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { PaceSplit(it.optInt("km"), it.optDouble("distance_m"), it.optDouble("pace_s"), it.optDouble("cumulative_s"), it.optInt("climb_m")) }
                pacingLine = null
            }, { pacingLine = it.message })
            busy = null
        }
    }

    fun courseToWatch() {
        val p = pacing ?: return
        busy = "pace"
        pacingLine = str(R.string.routes_sending_the_course)
        scope.launch {
            api.call("courseToWatch", JSONObject().put("name", name.trim().ifEmpty { defaultName() }).put("line", p.optJSONArray("line")).put("marks", p.optJSONArray("marks"))).fold({ j ->
                pacingLine = str(R.string.routes_split_every_km, JSONObject(j).optInt("id"))
            }, { pacingLine = it.message })
            busy = null
        }
    }

    fun splitsToWatch() {
        val p = pacing ?: return
        busy = "pace"
        pacingLine = str(R.string.routes_sending_the_pacing_workout)
        scope.launch {
            api.call("splitsToWatch", JSONObject().put("name", "${name.trim().ifEmpty { defaultName() }} ${clock(p.optInt("target"))}").put("splits", p.optJSONArray("splits"))).fold({
                pacingLine = str(R.string.common_the_pacing_workout_is_on_your)
            }, { pacingLine = it.message })
            busy = null
        }
    }
}
