package dev.freesuunto.app

import dev.freesuunto.app.shell.str
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseRoute
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.records.ExerciseCompletionGoal
import androidx.health.connect.client.records.ExercisePerformanceTarget
import androidx.health.connect.client.records.PlannedExerciseBlock
import androidx.health.connect.client.records.PlannedExerciseSessionRecord
import androidx.health.connect.client.records.PlannedExerciseStep
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Percentage
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Velocity
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.reflect.KClass

/**
 * Health Connect for Tartan (web/lib/health-connect.ts): writes the records the page builds
 * (src/health-connect.ts: workouts with their heart rate, distance and route, and the watch's
 * heart rate, blood oxygen, resting heart rate, steps and active energy), reads other apps'
 * workouts (so none is written twice) and sleep and HRV, and removes what Tartan wrote. Records
 * carry a client record id, so writing one again updates it instead of adding another.
 */
@CapacitorPlugin(name = "TartanHealth")
class TartanHealthPlugin : Plugin() {
    private companion object {
        /** Apps that write workouts to Health Connect, by name (their labels may not be readable). */
        val KNOWN_APPS = mapOf(
            "com.sec.android.app.shealth" to str(R.string.health_samsung_health), "com.stt.android.suunto" to "Suunto",
            "com.google.android.apps.fitness" to str(R.string.health_google_fit), "com.fitbit.FitbitMobile" to "Fitbit",
            "com.garmin.android.apps.connectmobile" to str(R.string.health_garmin_connect), "fi.polar.polarflow" to str(R.string.health_polar_flow),
            "com.coros.coros" to "COROS", "com.strava" to "Strava", "com.withings.wiscale2" to "Withings",
            "com.huawei.health" to str(R.string.health_huawei_health), "com.mi.health" to str(R.string.health_mi_fitness), "com.xiaomi.wearable" to str(R.string.health_mi_fitness),
            "com.huami.watch.hmwatchmanager" to "Zepp", "com.google.android.apps.wear.companion" to str(R.string.health_pixel_watch),
            "com.oura.android" to "Oura", "com.whoop.android" to "WHOOP", "com.runtastic.android" to str(R.string.health_adidas_running),
            "com.nike.plusgps" to str(R.string.health_nike_run_club), "com.wahoofitness.fitness" to "Wahoo",
        )
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private fun client(): HealthConnectClient = HealthConnectClient.getOrCreate(context)

    private fun run(call: PluginCall, work: suspend () -> JSObject) {
        scope.launch {
            try {
                call.resolve(work())
            } catch (e: Exception) {
                call.reject(e.message ?: e.javaClass.simpleName, e)
            }
        }
    }

    /** "available", "update" (Health Connect needs installing or updating) or "unavailable". */
    @PluginMethod
    fun status(call: PluginCall) {
        val s = HealthConnectClient.getSdkStatus(context)
        val out = JSObject()
        out.put(
            "status",
            when (s) {
                HealthConnectClient.SDK_AVAILABLE -> "available"
                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update"
                else -> "unavailable"
            },
        )
        call.resolve(out)
    }

    @PluginMethod
    fun granted(call: PluginCall) = run(call) {
        JSObject().put("granted", JSArray(client().permissionController.getGrantedPermissions().toList()))
    }

    /** Health Connect's own permission screen for `permissions` (its permission names). */
    @PluginMethod
    fun requestAccess(call: PluginCall) {
        val wanted = call.getArray("permissions")?.toList<String>()?.toSet() ?: emptySet()
        val intent = PermissionController.createRequestPermissionResultContract().createIntent(context, wanted)
        startActivityForResult(call, intent, "accessResult")
    }

    @ActivityCallback
    fun accessResult(call: PluginCall?, result: ActivityResult) {
        call ?: return
        val got = PermissionController.createRequestPermissionResultContract().parseResult(result.resultCode, result.data)
        // The screen answers with what was granted on it; the full set comes from the client.
        run(call) {
            val all = client().permissionController.getGrantedPermissions()
            JSObject().put("granted", JSArray((all + got).toList()))
        }
    }

    /** Health Connect's settings, where access is managed (or its Play Store page to install it). */
    @PluginMethod
    fun openSettings(call: PluginCall) {
        val intent = android.content.Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            val store = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("market://details?id=com.google.android.apps.healthdata"))
            store.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(store)
        }
        call.resolve()
    }

    // ------------------------------------------------------------------ write

    private fun offset(t: Instant): ZoneOffset = ZoneId.systemDefault().rules.getOffset(t)
    private fun at(o: JSONObject, key: String): Instant = Instant.ofEpochMilli(o.getLong(key))

    private fun metadata(o: JSONObject): Metadata {
        val d = o.optJSONObject("device")
        val device = Device(
            type = when (d?.optString("type")) {
                "watch" -> Device.TYPE_WATCH
                "phone" -> Device.TYPE_PHONE
                else -> Device.TYPE_UNKNOWN
            },
            manufacturer = d?.optString("manufacturer")?.ifEmpty { null },
            model = d?.optString("model")?.ifEmpty { null },
        )
        val id = o.getString("id")
        val version = o.optLong("version", 1)
        return if (o.optString("method") == "active") Metadata.activelyRecorded(device, id, version) else Metadata.autoRecorded(device, id, version)
    }

    private fun exerciseType(name: String): Int = when (name) {
        "running" -> ExerciseSessionRecord.EXERCISE_TYPE_RUNNING
        "running_treadmill" -> ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL
        "biking" -> ExerciseSessionRecord.EXERCISE_TYPE_BIKING
        "biking_stationary" -> ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY
        "walking" -> ExerciseSessionRecord.EXERCISE_TYPE_WALKING
        "hiking" -> ExerciseSessionRecord.EXERCISE_TYPE_HIKING
        "swimming_pool" -> ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL
        "swimming_open_water" -> ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER
        "strength_training" -> ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING
        "weightlifting" -> ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING
        "yoga" -> ExerciseSessionRecord.EXERCISE_TYPE_YOGA
        "pilates" -> ExerciseSessionRecord.EXERCISE_TYPE_PILATES
        "hiit" -> ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING
        "rowing" -> ExerciseSessionRecord.EXERCISE_TYPE_ROWING
        "rowing_machine" -> ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE
        "skiing" -> ExerciseSessionRecord.EXERCISE_TYPE_SKIING
        "snowboarding" -> ExerciseSessionRecord.EXERCISE_TYPE_SNOWBOARDING
        "elliptical" -> ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL
        "stair_climbing" -> ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING
        "paddling" -> ExerciseSessionRecord.EXERCISE_TYPE_PADDLING
        "skating" -> ExerciseSessionRecord.EXERCISE_TYPE_SKATING
        "rock_climbing" -> ExerciseSessionRecord.EXERCISE_TYPE_ROCK_CLIMBING
        "soccer" -> ExerciseSessionRecord.EXERCISE_TYPE_SOCCER
        "tennis" -> ExerciseSessionRecord.EXERCISE_TYPE_TENNIS
        "badminton" -> ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON
        "golf" -> ExerciseSessionRecord.EXERCISE_TYPE_GOLF
        "surfing" -> ExerciseSessionRecord.EXERCISE_TYPE_SURFING
        "calisthenics" -> ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS
        else -> ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT
    }

    private fun record(o: JSONObject, routeAllowed: Boolean): Record? {
        val meta = metadata(o)
        return when (o.getString("type")) {
            "exercise" -> {
                val start = at(o, "start")
                val end = at(o, "end")
                val pts = o.optJSONArray("route")
                val route = if (routeAllowed && pts != null && pts.length() > 1) {
                    ExerciseRoute(
                        (0 until pts.length()).mapNotNull { i ->
                            val p = pts.getJSONArray(i)
                            val t = Instant.ofEpochMilli(p.getLong(0))
                            if (t.isBefore(start) || !t.isBefore(end)) null
                            else ExerciseRoute.Location(
                                time = t,
                                latitude = p.getDouble(1),
                                longitude = p.getDouble(2),
                                altitude = if (p.length() > 3 && !p.isNull(3)) Length.meters(p.getDouble(3)) else null,
                            )
                        },
                    )
                } else null
                ExerciseSessionRecord(
                    startTime = start,
                    startZoneOffset = offset(start),
                    endTime = end,
                    endZoneOffset = offset(end),
                    metadata = meta,
                    exerciseType = exerciseType(o.optString("exercise")),
                    title = o.optString("title").ifEmpty { null },
                    notes = o.optString("notes").ifEmpty { null },
                    exerciseRoute = route,
                )
            }
            "heartRate" -> {
                val s = o.getJSONArray("samples")
                val samples = (0 until s.length()).map { i ->
                    val p = s.getJSONArray(i)
                    HeartRateRecord.Sample(time = Instant.ofEpochMilli(p.getLong(0)), beatsPerMinute = p.getLong(1))
                }
                if (samples.isEmpty()) null
                else HeartRateRecord(startTime = at(o, "start"), startZoneOffset = offset(at(o, "start")), endTime = at(o, "end"), endZoneOffset = offset(at(o, "end")), samples = samples, metadata = meta)
            }
            "steps" -> StepsRecord(startTime = at(o, "start"), startZoneOffset = offset(at(o, "start")), endTime = at(o, "end"), endZoneOffset = offset(at(o, "end")), count = o.getLong("count"), metadata = meta)
            "distance" -> DistanceRecord(startTime = at(o, "start"), startZoneOffset = offset(at(o, "start")), endTime = at(o, "end"), endZoneOffset = offset(at(o, "end")), distance = Length.meters(o.getDouble("meters")), metadata = meta)
            "activeCalories" -> ActiveCaloriesBurnedRecord(startTime = at(o, "start"), startZoneOffset = offset(at(o, "start")), endTime = at(o, "end"), endZoneOffset = offset(at(o, "end")), energy = Energy.kilocalories(o.getDouble("kcal")), metadata = meta)
            "oxygenSaturation" -> OxygenSaturationRecord(time = at(o, "time"), zoneOffset = offset(at(o, "time")), percentage = Percentage(o.getDouble("percent")), metadata = meta)
            "restingHeartRate" -> RestingHeartRateRecord(time = at(o, "time"), zoneOffset = offset(at(o, "time")), beatsPerMinute = o.getLong("bpm"), metadata = meta)
            else -> null
        }
    }

    /** Write (or update, by client record id) records; answers how many were written. */
    @PluginMethod
    fun write(call: PluginCall) = run(call) {
        val list = call.getArray("records") ?: JSArray()
        val granted = client().permissionController.getGrantedPermissions()
        val routeAllowed = HealthPermission.PERMISSION_WRITE_EXERCISE_ROUTE in granted
        val records = (0 until list.length()).mapNotNull { i -> record(list.getJSONObject(i), routeAllowed) }
        // Only the kinds this app may write; the rest are left out, not failed.
        val allowed = records.filter { HealthPermission.getWritePermission(it::class) in granted }
        for (chunk in allowed.chunked(500)) client().insertRecords(chunk)
        JSObject().put("written", allowed.size).put("skipped", records.size - allowed.size)
    }

    // ------------------------------------------------------------------ the plan's coming week

    private fun plannedStep(o: JSONObject, exercise: Int): PlannedExerciseStep {
        val phase = when (o.optString("phase")) {
            "warmup" -> PlannedExerciseStep.EXERCISE_PHASE_WARMUP
            "cooldown" -> PlannedExerciseStep.EXERCISE_PHASE_COOLDOWN
            "recovery" -> PlannedExerciseStep.EXERCISE_PHASE_RECOVERY
            "rest" -> PlannedExerciseStep.EXERCISE_PHASE_REST
            else -> PlannedExerciseStep.EXERCISE_PHASE_ACTIVE
        }
        val goal = when {
            o.has("distance_m") -> ExerciseCompletionGoal.DistanceGoal(Length.meters(o.getDouble("distance_m")))
            o.has("duration_s") -> ExerciseCompletionGoal.DurationGoal(java.time.Duration.ofSeconds(o.getLong("duration_s")))
            else -> ExerciseCompletionGoal.ManualCompletion
        }
        val range = { k: String -> o.optJSONArray(k)?.takeIf { it.length() == 2 }?.let { it.getDouble(0) to it.getDouble(1) } }
        val targets = listOfNotNull(
            range("hr")?.let { (lo, hi) -> ExercisePerformanceTarget.HeartRateTarget(lo, hi) },
            range("speed")?.let { (lo, hi) -> ExercisePerformanceTarget.SpeedTarget(Velocity.metersPerSecond(lo), Velocity.metersPerSecond(hi)) },
            range("power")?.let { (lo, hi) -> ExercisePerformanceTarget.PowerTarget(Power.watts(lo), Power.watts(hi)) },
        )
        return PlannedExerciseStep(exerciseType = exercise, exercisePhase = phase, completionGoal = goal, performanceTargets = targets, description = o.optString("description").ifEmpty { null })
    }

    private fun planned(o: JSONObject): PlannedExerciseSessionRecord {
        val exercise = exerciseType(o.optString("exercise"))
        val blocks = o.getJSONArray("blocks").let { bs ->
            (0 until bs.length()).map { i ->
                val b = bs.getJSONObject(i)
                val steps = b.getJSONArray("steps")
                PlannedExerciseBlock(repetitions = b.optInt("repetitions", 1), steps = (0 until steps.length()).map { plannedStep(steps.getJSONObject(it), exercise) }, description = b.optString("description").ifEmpty { null })
            }
        }
        val start = at(o, "start")
        val end = at(o, "end")
        return PlannedExerciseSessionRecord(
            startTime = start, startZoneOffset = offset(start), endTime = end, endZoneOffset = offset(end),
            metadata = Metadata.manualEntry(clientRecordId = o.getString("id"), clientRecordVersion = System.currentTimeMillis()),
            blocks = blocks, exerciseType = exercise, title = o.optString("title").ifEmpty { null }, notes = o.optString("notes").ifEmpty { null },
        )
    }

    /**
     * The plan's coming week as planned exercise sessions: Tartan's from the start of today on come
     * out, these go in (none: just out). Says so when this Health Connect has no planned workouts
     * (older versions) or the permission isn't given, instead of failing.
     */
    @PluginMethod
    fun writePlanned(call: PluginCall) = run(call) {
        val c = client()
        if (c.features.getFeatureStatus(HealthConnectFeatures.FEATURE_PLANNED_EXERCISE) != HealthConnectFeatures.FEATURE_STATUS_AVAILABLE)
            return@run JSObject().put("written", 0).put("removed", 0).put("unsupported", true)
        if (HealthPermission.getWritePermission(PlannedExerciseSessionRecord::class) !in c.permissionController.getGrantedPermissions())
            return@run JSObject().put("written", 0).put("removed", 0).put("denied", true)
        val list = call.getArray("records") ?: JSArray()
        val records = (0 until list.length()).map { planned(list.getJSONObject(it)) }
        val from = java.time.LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant()
        // An app can only remove its own records: others' planned workouts stay.
        c.deleteRecords(PlannedExerciseSessionRecord::class, TimeRangeFilter.after(from))
        if (records.isNotEmpty()) c.insertRecords(records)
        JSObject().put("written", records.size).put("removed", 1)
    }

    // ------------------------------------------------------------------ read

    private val ownPackage get() = context.packageName

    private suspend fun <T : Record> read(type: KClass<T>, start: Instant, end: Instant): List<T> {
        val out = mutableListOf<T>()
        var token: String? = null
        do {
            val res = client().readRecords(ReadRecordsRequest(type, TimeRangeFilter.between(start, end), pageToken = token))
            out += res.records
            token = res.pageToken
        } while (token != null && out.size < 5000)
        return out
    }

    /** Other apps' workouts, sleep (with stages) and HRV between `start` and `end` (ms). */
    @PluginMethod
    fun read(call: PluginCall) = run(call) {
        val start = Instant.ofEpochMilli(call.getLong("start") ?: 0L)
        val end = Instant.ofEpochMilli(call.getLong("end") ?: System.currentTimeMillis())
        val granted = client().permissionController.getGrantedPermissions()
        val can = { k: KClass<out Record> -> HealthPermission.getReadPermission(k) in granted }
        val out = JSObject()
        val sessions = JSONArray()
        if (can(ExerciseSessionRecord::class)) {
            for (r in read(ExerciseSessionRecord::class, start, end)) {
                if (r.metadata.dataOrigin.packageName == ownPackage) continue
                sessions.put(JSONObject().put("start", r.startTime.toEpochMilli()).put("end", r.endTime.toEpochMilli()).put("source", r.metadata.dataOrigin.packageName).put("title", r.title ?: ""))
            }
        }
        out.put("exercise", sessions)
        val sleep = JSONArray()
        if (can(SleepSessionRecord::class)) {
            for (r in read(SleepSessionRecord::class, start, end)) {
                val stages = JSONArray()
                for (s in r.stages) stages.put(JSONArray().put(s.startTime.toEpochMilli()).put(s.endTime.toEpochMilli()).put(s.stage))
                sleep.put(JSONObject().put("id", r.metadata.id).put("start", r.startTime.toEpochMilli()).put("end", r.endTime.toEpochMilli()).put("source", r.metadata.dataOrigin.packageName).put("stages", stages))
            }
        }
        out.put("sleep", sleep)
        val hrv = JSONArray()
        if (can(HeartRateVariabilityRmssdRecord::class)) {
            for (r in read(HeartRateVariabilityRmssdRecord::class, start, end)) {
                if (r.metadata.dataOrigin.packageName == ownPackage) continue
                hrv.put(JSONArray().put(r.time.toEpochMilli()).put(r.heartRateVariabilityMillis).put(r.metadata.dataOrigin.packageName))
            }
        }
        out.put("hrv", hrv)
        out
    }

    /** Health Connect's sport to its name here (exerciseType's, the other way). */
    private fun exerciseName(t: Int): String = when (t) {
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "running"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "running_treadmill"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "biking"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "biking_stationary"
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "walking"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "hiking"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "swimming_pool"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "swimming_open_water"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING -> "strength_training"
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> "weightlifting"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "yoga"
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES -> "pilates"
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING -> "hiit"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING -> "rowing"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE -> "rowing_machine"
        ExerciseSessionRecord.EXERCISE_TYPE_SKIING -> "skiing"
        ExerciseSessionRecord.EXERCISE_TYPE_PADDLING -> "paddling"
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS -> "calisthenics"
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> "elliptical"
        else -> "other"
    }

    /** The name of the app that wrote a record, as people know it. */
    private fun appName(pkg: String): String = KNOWN_APPS[pkg]
        ?: runCatching { context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrNull()
        ?: pkg.split(".").lastOrNull { it !in setOf("android", "app", "apps", "mobile") }?.replaceFirstChar { it.uppercase() } ?: pkg

    /**
     * Other apps' workouts in full, newest first: each with its heart rate, distance and speed
     * (from the same app where it has them) and its route where Health Connect lets Tartan read
     * it. `known` ids are left out; at most `limit` (more: true when there were more).
     */
    @PluginMethod
    fun workouts(call: PluginCall) = run(call) {
        val start = Instant.ofEpochMilli(call.getLong("start") ?: 0L)
        val end = Instant.ofEpochMilli(call.getLong("end") ?: System.currentTimeMillis())
        val known = call.getArray("known")?.toList<String>()?.toSet() ?: emptySet()
        val limit = call.getInt("limit") ?: 20
        val granted = client().permissionController.getGrantedPermissions()
        val can = { k: KClass<out Record> -> HealthPermission.getReadPermission(k) in granted }
        val out = JSONArray()
        var more = false
        if (can(ExerciseSessionRecord::class)) {
            val all = read(ExerciseSessionRecord::class, start, end).filter { it.metadata.dataOrigin.packageName != ownPackage && it.metadata.id !in known }.sortedByDescending { it.startTime }
            more = all.size > limit
            for (r in all.take(limit)) {
                val origin = r.metadata.dataOrigin.packageName
                // The session's own app's readings; another app's (not Tartan's) when it has none.
                fun <T : Record> mine(list: List<T>): List<T> = list.filter { it.metadata.dataOrigin.packageName == origin }.ifEmpty { list.filter { it.metadata.dataOrigin.packageName != ownPackage } }
                val o = JSONObject().put("id", r.metadata.id).put("start", r.startTime.toEpochMilli()).put("end", r.endTime.toEpochMilli())
                    .put("source", origin).put("app", appName(origin)).put("sport", exerciseName(r.exerciseType)).put("title", r.title ?: "")
                if (can(HeartRateRecord::class)) o.put("hr", JSONArray().also { a -> mine(read(HeartRateRecord::class, r.startTime, r.endTime)).forEach { h -> h.samples.forEach { s -> a.put(JSONArray().put(s.time.toEpochMilli()).put(s.beatsPerMinute)) } } })
                if (can(DistanceRecord::class)) o.put("distance", JSONArray().also { a -> mine(read(DistanceRecord::class, r.startTime, r.endTime)).forEach { d -> a.put(JSONArray().put(d.startTime.toEpochMilli()).put(d.endTime.toEpochMilli()).put(d.distance.inMeters)) } })
                if (can(SpeedRecord::class)) o.put("speed", JSONArray().also { a -> mine(read(SpeedRecord::class, r.startTime, r.endTime)).forEach { v -> v.samples.forEach { s -> a.put(JSONArray().put(s.time.toEpochMilli()).put(s.speed.inMetersPerSecond)) } } })
                (r.exerciseRouteResult as? ExerciseRouteResult.Data)?.exerciseRoute?.route?.let { pts ->
                    o.put("route", JSONArray().also { a -> pts.forEach { p -> a.put(JSONArray().put(p.time.toEpochMilli()).put(p.latitude).put(p.longitude).put(p.altitude?.inMeters ?: JSONObject.NULL)) } })
                }
                out.put(o)
            }
        }
        JSObject().put("sessions", out).put("more", more)
    }

    /** Remove everything Tartan wrote (an app can only remove its own records). */
    @PluginMethod
    fun removeOurs(call: PluginCall) = run(call) {
        val granted = client().permissionController.getGrantedPermissions()
        val all = TimeRangeFilter.after(Instant.EPOCH)
        val kinds: List<KClass<out Record>> = listOf(
            ExerciseSessionRecord::class, HeartRateRecord::class, StepsRecord::class, DistanceRecord::class,
            ActiveCaloriesBurnedRecord::class, OxygenSaturationRecord::class, RestingHeartRateRecord::class,
            PlannedExerciseSessionRecord::class,
        )
        var n = 0
        for (k in kinds) if (HealthPermission.getWritePermission(k) in granted) {
            client().deleteRecords(k, all)
            n++
        }
        JSObject().put("kinds", n)
    }
}
