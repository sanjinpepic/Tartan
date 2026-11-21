package dev.freesuunto.app.shell

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.background
import androidx.compose.ui.geometry.Offset
import androidx.activity.ComponentActivity
import android.graphics.Canvas
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.test.swipe
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import androidx.compose.ui.unit.dp
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.unit.toSize
import java.io.File
import java.time.LocalDate

/**
 * Tartan 2's native screens rendered on the JVM (Robolectric's real graphics), from the demo's
 * data (test/resources/shots, saved from scripts/seed-demo.ts with a basic plan): PNGs to look at
 * without a phone, in light and dark, at a Pixel's size. And the floating bar's slide: press on
 * Today, slide to Activities, let go, and Activities is chosen.
 *   ./gradlew :app:testDebugUnitTest --tests '*TartanShotsTest*' -Dshots=/some/dir
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-port-xxhdpi")
class TartanShotsTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val out = File(System.getProperty("shots") ?: "build/shots").apply { mkdirs() }
    private val day = LocalDate.of(2026, 10, 29)

    private fun fixture(name: String) = javaClass.classLoader!!.getResource("shots/$name")!!.readText()
    private val today by lazy { parseToday(fixture("today.json"), fixture("plan.json"), day) }

    private val none = object : TodayActions {
        override fun go(hash: String) {}
        override fun openActivity(id: String) {}
        override fun openSession(date: String, kind: String) {}
        override fun openBoard() {}
        override fun refresh() {}
    }

    /** The board and the gear as the app floats them over every screen (a watch synced 2h ago, Strava syncing). */
    @androidx.compose.runtime.Composable
    private fun Chrome(folded: Boolean, back: (() -> Unit)? = null) {
        androidx.compose.runtime.CompositionLocalProvider(LocalBoard provides BoardState(listOf(Lane("watch", "ok", "2h", "watch"), Lane("strava", "busy", "···", "strava"))) {}) {
            TopChrome(folded, onSettings = {}, back = back)
        }
    }

    private fun save(name: String) {
        // The window drawn into a bitmap (captureToImage waits for a hardware frame Robolectric never sends).
        rule.waitForIdle()
        val v = rule.activity.window.decorView
        val bmp = Bitmap.createBitmap(v.width, v.height, Bitmap.Config.ARGB_8888)
        v.draw(Canvas(bmp))
        File(out, "$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** Share cards: a run (its route, distance, time, pace, heart rate) and the week. */
    @Test fun shareCards() {
        val ctx = rule.activity
        val loop = (0..120).map { i -> val a = i / 120.0 * 2 * Math.PI; (60.195 + 0.0045 * kotlin.math.sin(a) + 0.001 * kotlin.math.sin(a * 3)) to (24.905 + 0.009 * kotlin.math.cos(a)) }
        val w = Workout(
            id = "x", start = "2026-11-08T07:30:00Z", startLocal = "2026-11-08T09:30:00", sport = "Run", name = "Sunday long run", device = null, description = null,
            distanceKm = 16.42, movingMin = 94.5, elevationM = 120.0, avgHr = 143, maxHr = 161, pace = "5:45", speedKmh = 10.4, calories = 1100.0, feeling = null,
            copies = emptyList(), provenance = emptyMap(), splits = emptyList(), latlng = loop, distance = emptyList(), velocity = emptyList(), heartrate = emptyList(), altitude = emptyList(),
            streamsFrom = null, zones = emptyList(), load = null, profileMax = 190, zonesSource = null,
        )
        val red = 0xFFA63A2B.toInt()
        File(out, "share-run.png").outputStream().use { ShareCard.workout(ctx, w, red).compress(Bitmap.CompressFormat.PNG, 100, it) }
        val week = Week(days = listOf(0.0, 9.2, 7.1, 8.8, 0.0, 6.4, 16.4).mapIndexed { i, km -> Day("2026-11-0${2 + i}", km, false) }, km = 47.9, goalKm = 50.0, goalSays = null, workouts = 5, planDone = 5, planSessions = 6, minutes = 285.0)
        File(out, "share-week.png").outputStream().use { ShareCard.week(ctx, week, red, java.time.LocalDate.parse("2026-11-08")).compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** A run as a Live Update: promoted, the distance in the status bar, public on the lock screen, Tartan's red, Pause. */
    @Test fun liveRun() {
        val ctx = rule.activity
        org.robolectric.Shadows.shadowOf(ctx.application).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        val nm = ctx.getSystemService(android.app.NotificationManager::class.java)
        nm.createNotificationChannel(android.app.NotificationChannel("com.equimaps.capacitor_background_geolocation", "Your run", android.app.NotificationManager.IMPORTANCE_DEFAULT))
        val now = System.currentTimeMillis()
        val r = RecNow("recording", now - 1_800_000, null, emptyList(), "Morning run", 5240.0, 1800, 40.0, 148, 5, null, "HRM", 151, 3.1, goalKm = 9.0, planTitle = "Tempo")
        LiveUpdates.run(ctx, r)
        val n = org.robolectric.Shadows.shadowOf(nm).allNotifications.single()
        val x = n.extras
        assertEquals("5.24 km", x.getString(android.app.Notification.EXTRA_TITLE))
        assertEquals(true, x.getBoolean("android.requestPromotedOngoing"))
        assertEquals("5.2 km", x.getCharSequence("android.shortCriticalText").toString())
        assertEquals(androidx.core.app.NotificationCompat.CATEGORY_WORKOUT, n.category)
        assertEquals(android.app.Notification.VISIBILITY_PUBLIC, n.visibility)
        assertEquals(LiveUpdates.BRAND, n.color)
        assertEquals("Pause", n.actions.single().title.toString())
        assert(x.getCharSequence(android.app.Notification.EXTRA_TEXT).toString().contains("of 9.0 km"))
        // The time ticks by itself: the system's chronometer, from when the moving time began.
        assertEquals(true, x.getBoolean(android.app.Notification.EXTRA_SHOW_CHRONOMETER))
        assert(kotlin.math.abs(n.`when` - (now - 1_800_000)) < 5_000)
    }

    /** The home-screen widget, drawn from what the app sends it (TodayWidget). */
    @Test fun widget() {
        val ctx = rule.activity
        ctx.getSharedPreferences(dev.freesuunto.app.TodayWidget.PREFS, android.content.Context.MODE_PRIVATE).edit().putString("data", """{"when":"Mon 9 Nov","label":"Today's session","title":"Tempo","detail":"50 min · 4:50/km for 20 min","ready":"Fresh","tone":"good","km":17.4,"goal":41,"days":[{"km":0,"future":false},{"km":8.2,"future":false},{"km":0,"future":false},{"km":9.2,"future":false,"today":true},{"km":0,"future":true},{"km":0,"future":true},{"km":0,"future":true}],"week":"17.4 of 41 km this week","watch_on":true,"watch_at":${System.currentTimeMillis() - 2 * 3600_000},"strava_on":true,"strava_at":${System.currentTimeMillis() - 300_000}}""").commit()
        drawWidget(ctx, "widget")
        // Recording: the run's clock (ticking on a phone), its distance and pace, "Recording".
        val now = System.currentTimeMillis()
        ctx.getSharedPreferences(dev.freesuunto.app.TodayWidget.PREFS, android.content.Context.MODE_PRIVATE).edit().putString("run", """{"paused":false,"moving_s":1694,"from":${now - 1_694_000},"line":"5.24 km · 5:23 /km · 151 bpm","title":"Tempo"}""").commit()
        drawWidget(ctx, "widget-recording")
        ctx.getSharedPreferences(dev.freesuunto.app.TodayWidget.PREFS, android.content.Context.MODE_PRIVATE).edit().remove("run").commit()
    }

    private fun drawWidget(ctx: android.content.Context, name: String) {
        val rv = dev.freesuunto.app.TodayWidget.views(ctx)
        val host = android.widget.FrameLayout(ctx)
        val v = rv.apply(ctx, host)
        val d = ctx.resources.displayMetrics.density
        val w = (360 * d).toInt(); val h = (180 * d).toInt()
        v.measure(android.view.View.MeasureSpec.makeMeasureSpec(w, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(h, android.view.View.MeasureSpec.EXACTLY))
        v.layout(0, 0, w, h)
        val bmp = Bitmap.createBitmap(w + 48, h + 48, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawColor(0xFF7A8C9E.toInt())
        c.translate(24f, 24f)
        v.draw(c)
        File(out, "$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun todayShot(name: String, dark: Boolean) {
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    TodayScreen(today, refreshing = false, actions = none, date = day)
                    Chrome(folded = false)
                    FloatingBar("today", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        // Past the arrivals: cards in, the ring filled, the bars up.
        rule.mainClock.advanceTimeBy(2500)
        save(name)
    }

    @Test fun todayLight() = todayShot("today-light", dark = false)

    /** Workouts in but no plan yet (no key): Today offers to make one, by Tartan's rules, from Coach. */
    private fun todayNoPlanShot(name: String, dark: Boolean) {
        val t = parseToday(fixture("today.json"), null, day)
        assertEquals(false, t.planOn)
        val went = mutableListOf<String>()
        val actions = object : TodayActions by none { override fun go(hash: String) { went.add(hash) } }
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    TodayScreen(t, refreshing = false, actions = actions, date = day)
                    Chrome(folded = false)
                    FloatingBar("today", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        save(name)
        rule.onNodeWithText("Make my plan").performClick()
        assertEquals(listOf("coach"), went)
    }

    @Test fun todayNoPlan() = todayNoPlanShot("today-noplan", dark = false)
    @Test fun todayNoPlanDark() = todayNoPlanShot("today-noplan-dark", dark = true)

    /** A plan whose last day has gone: Today says so and offers the next one. */
    @Test fun todayPlanEnded() {
        val ended = org.json.JSONObject(fixture("plan.json")).apply {
            val weeks = getJSONArray("weeks")
            for (k in 0 until weeks.length()) weeks.getJSONObject(k).put("when", "past")
            put("today", "2027-03-01")
        }
        val t = parseToday(fixture("today.json"), ended.toString(), LocalDate.of(2027, 3, 1))
        assertEquals(false, t.planOn)
        assertEquals(true, t.planEnded)
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Box(Modifier.fillMaxSize()) { TodayScreen(t, refreshing = false, actions = none, date = LocalDate.of(2027, 3, 1)) } } }
        rule.mainClock.advanceTimeBy(2500)
        save("today-plan-ended")
        rule.onNodeWithText("Your plan has ended").assertExists()
        rule.onNodeWithText("Make the next one").assertExists()
        // And Coach asks for the next one, as for the first.
        assertEquals(true, parseCoach(ended.toString(), null, null).let { it.ended && it.intake != null })
    }

    /**
     * Today's session (an easy run on 29 Oct): on a day with a reason (heavy rain you said puts
     * you off), its card suggests the swim inside it; taken, a line with Undo; on a normal day only
     * a quiet "Different plan today?", which opens the choices.
     */
    private val dayChoicesJson = """{"date":"2026-10-29","kind":"easy","title":"Easy run","choices":[{"to":"nudge"},{"to":"swim","minutes":45},{"to":"short","minutes":20},{"to":"move","day":"2026-10-30"}],"reason":"When you change a run, you usually pick a swim.","stance":{"lead":"either"}}"""
    private fun dayReadiness(swap: String) = """{"date":"2026-10-29","checkin":{"sleep":2,"legs":2},"sleep_measured":null,"niggles":[],"readiness":{"level":"ready","reasons":[],"form":-4},"session":{"title":"Easy run","kind":"easy","hard":false,"done":false},"suggest_swap":false,"bad_weather":"swim","avoid":["rain"],"day_swap":$swap,"day_choices":$dayChoicesJson}"""
    private val offerJson = """{"state":"offer","date":"2026-10-29","kind":"easy","title":"Easy run","why":"Heavy rain, wind 40 km/h at 17:00","reason":"You said heavy rain puts you off.","choices":[{"to":"swim","minutes":45},{"to":"move","day":"2026-10-30"},{"to":"short","minutes":20},{"to":"run"}]}"""
    private val takenJson = """{"state":"taken","date":"2026-10-29","kind":"easy","title":"Easy run","choices":[{"to":"swim","minutes":45}]}"""

    private fun dayModel(swap: String, sent: MutableList<Pair<String, String?>>): TodayModel {
        val api = object : SettingsApi by shellApi {
            override suspend fun get(path: String): String? = if (path == "/api/readiness") dayReadiness(swap) else shellApi.get(path)
            override suspend fun send(path: String, method: String, body: String?): Pair<Int, String> {
                sent.add(path to body)
                return if (path == "/api/today/nudge") 200 to """{"text":"You've run 3 times this week, 21 km. Today keeps it going. Just start: 10 minutes easy, then decide.","from":"rules"}"""
                else 200 to dayReadiness(if (body?.contains("undo") == true || body?.contains("keep") == true) "null" else takenJson)
            }
        }
        return TodayModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), api, keys).also {
            it.load(null, null, object : WorkoutApi {
                override suspend fun get(path: String) = null
                override suspend fun send(path: String, method: String, body: String?) = 200 to "{}"
            })
        }
    }

    private fun todayDayShot(name: String, dark: Boolean, swap: String, sent: MutableList<Pair<String, String?>> = mutableListOf()): TodayModel {
        val more = dayModel(swap, sent)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    TodayScreen(today, refreshing = false, actions = none, date = day, more = more)
                    Chrome(folded = false)
                    FloatingBar("today", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        save(name)
        return more
    }

    @Test fun todaySuggested() {
        val sent = mutableListOf<Pair<String, String?>>()
        val more = todayDayShot("today-suggested", dark = false, swap = offerJson, sent = sent)
        rule.onNodeWithText("Swim instead").performClick()
        rule.mainClock.advanceTimeBy(500)
        org.json.JSONObject(sent.last().second!!).let { b -> assertEquals("swim", b.getString("to")); assertEquals("easy", b.getString("kind")); assertEquals("heavy rain, wind 40 km/h at 17:00", b.getString("reason")) }
        assertEquals(true, more.check?.swap?.taken)
        rule.onNodeWithText("Undo").performClick()
        assertEquals(true, org.json.JSONObject(sent.last().second!!).getBoolean("undo"))
    }
    @Test fun todaySuggestedDark() { todayDayShot("today-suggested-dark", dark = true, swap = offerJson) }
    @Test fun todayTaken() { todayDayShot("today-taken", dark = false, swap = takenJson) }

    /** Run anyway: the suggestion goes for the day, and the run stays as planned. */
    @Test fun runAnyway() {
        val sent = mutableListOf<Pair<String, String?>>()
        val more = todayDayShot("today-suggested-run", dark = false, swap = offerJson, sent = sent)
        rule.onNodeWithText("Run anyway").performClick()
        rule.mainClock.advanceTimeBy(500)
        assertEquals("keep", org.json.JSONObject(sent.single().second!!).getString("to"))
        assertEquals(null, more.check?.swap)
        assertEquals(0, rule.onAllNodesWithText("Run anyway").fetchSemanticsNodes().size)
    }

    /** A normal day: no button in the card, only the quiet way in, which opens the choices. */
    @Test fun todayNormal() {
        todayDayShot("today-normal", dark = false, swap = "null")
        assertEquals(0, rule.onAllNodesWithText("Swim instead").fetchSemanticsNodes().size)
        assertEquals(0, rule.onAllNodesWithText("Run anyway").fetchSemanticsNodes().size)
        rule.onNodeWithText("Different plan today?").performClick()
        rule.mainClock.advanceTimeBy(1500)
        rule.onNodeWithText("No guilt either way. A few ways to go:").assertExists()
    }

    /** Different plan today?: the choices in your order, and a nudge from your own data. */
    private fun choicesShot(name: String, dark: Boolean) {
        val sent = mutableListOf<Pair<String, String?>>()
        val more = dayModel("null", sent)
        val c = more.check!!.choices!!
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = dark) { Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLow).padding(top = 48.dp)) { DayChoicesBody(c, more) {} } } }
        rule.mainClock.advanceTimeBy(1000)
        save(name)
        rule.onNodeWithText("Give me a nudge").performClick()
        rule.mainClock.advanceTimeBy(800)
        assertEquals("/api/today/nudge", sent.last().first)
        rule.onNodeWithText("You've run 3 times this week", substring = true).assertExists()
        save("$name-nudge")
        rule.onNodeWithText("A shorter version").performClick()
        org.json.JSONObject(sent.last().second!!).let { b -> assertEquals("short", b.getString("to")); assertEquals("not feeling it", b.getString("reason")) }
    }
    @Test fun todayChoices() = choicesShot("today-choices", dark = false)
    @Test fun todayChoicesDark() = choicesShot("today-choices-dark", dark = true)

    /** A new best stays at the top of Today for a few days; ✕ puts it back under what's worth knowing. */
    @Test fun newBestCelebrated() {
        androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>().getSharedPreferences("tartan-today", 0).edit().clear().commit()
        val bests = listOf(
            Takeaway("good", "New best 5k: 26:30", "5:18 /km, set yesterday.", "a1", "pb-5k", "2026-10-28T07:30:00Z"),
            Takeaway("good", "New best 1k: 4:54", "4:54 /km, set yesterday.", "a1", "pb-1k", "2026-10-28T07:30:00Z"),
            Takeaway("good", "New best 10k: 55:10", "set Mon 12 Oct.", "a2", "pb-10k", "2026-10-12T07:30:00Z"),
        )
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { TodayScreen(today.copy(takeaways = bests), refreshing = false, actions = none, date = day) } }
        rule.waitForIdle()
        // Yesterday's two bests lead, the 17-day-old one doesn't.
        rule.onNodeWithText("New best 5k: 26:30").assertExists()
        rule.onNodeWithText("1k 4:54").assertExists()
        rule.onNodeWithText("New best 10k: 55:10").assertDoesNotExist()
        save("today-best")
        rule.onNodeWithContentDescription("Dismiss").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("New best 5k: 26:30").assertDoesNotExist()
        rule.onNodeWithText("More today").performScrollTo().performClick()
        rule.waitForIdle()
        rule.onNodeWithText("New best 5k: 26:30").assertExists()
    }

    /** Today leads with the session, how you are and the week; the numbers and the rest wait under "More today". */
    @Test fun moreTodayFolds() {
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { TodayScreen(today, refreshing = false, actions = none, date = day) } }
        rule.onNodeWithText("Fatigue").assertDoesNotExist()
        rule.onNodeWithText("More today").performScrollTo().performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Fatigue").assertExists()
        rule.onNodeWithText("Less").assertExists()
    }

    @Test fun todayDark() = todayShot("today-dark", dark = true)

    @Test fun readsTheDemo() {
        assertEquals("Building fitness", today.readiness.title)
        assertNotNull(today.session)
        assertEquals(7, today.week.days.size)
    }

    @Test fun slideAlongTheBar() {
        var chosen by mutableStateOf<String?>(null)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize()) {
                    val current = remember { mutableStateOf("today") }
                    FloatingBar(chosen ?: current.value, hidden = false, onSelect = { chosen = it }, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(500)
        val bar = rule.onRoot()
        // The bar spans the screen less 16dp a side (at most 420dp): press on Today, slide to the third tab.
        val y = { h: Int -> h - with(rule.density) { 44.dp.toPx() } }
        bar.performTouchInput { down(Offset(width * 0.15f, y(height))) }
        rule.mainClock.advanceTimeBy(100)
        bar.performTouchInput { moveTo(Offset(width * 0.45f, y(height))) }
        rule.mainClock.advanceTimeBy(100)
        bar.performTouchInput { moveTo(Offset(width * 0.62f, y(height))) }
        rule.mainClock.advanceTimeBy(600)
        // The page follows the slide: resting on Activities has already brought it up.
        assertEquals("activities", chosen)
        save("bar-sliding")
        bar.performTouchInput { up() }
        rule.mainClock.advanceTimeBy(600)
        assertEquals("activities", chosen)
        save("bar-landed")
    }

    /** On Activities (the wide tab), a tap on Coach's icon is Coach, not Today (the grid's mistake). */
    @Test fun tapWhatYouSee() {
        var chosen by mutableStateOf<String?>(null)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize()) {
                    FloatingBar("activities", hidden = false, onSelect = { chosen = it }, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(800)
        // Coach's pill near its left edge, as drawn (where an even grid said Today): 16dp margin + 8dp padding, Today's pill (1 of 5.4 shares), a 4dp gap, then Coach's.
        val x = with(rule.density) {
            val w = (412.dp - 32.dp - 16.dp - 12.dp).toPx()
            (16.dp + 8.dp).toPx() + w / 5.4f + 4.dp.toPx() + w / 5.4f * 0.1f
        }
        rule.onRoot().performTouchInput {
            val y = height - 44.dp.toPx()
            down(Offset(x, y))
            up()
        }
        rule.mainClock.advanceTimeBy(300)
        assertEquals("coach", chosen)
    }

    private val coachActions = object : CoachActions {
        override fun openSession(date: String, kind: String) {}
        override fun openActivity(id: String) {}
        override fun chat(conversation: String?, prefill: String?) {}
        override fun go(hash: String) {}
        override fun dismissWeekly(week: String) {}
        override suspend fun post(path: String, body: String?): String? = null
        // A Suunto in reach, three of the coming week's five sessions on it (the Coach tab's watch line).
        override suspend fun watchWeek(send: Boolean): org.json.JSONObject? = org.json.JSONObject("""{"canBluetooth":true,"wanted":5,"onWatch":3}""")
    }

    /** The demo's plan, with a suggestion from the coach waiting and the week's review. */
    private val coach by lazy {
        val plan = org.json.JSONObject(fixture("plan.json"))
        plan.put("proposal", org.json.JSONObject("""{"at":"2026-10-29T07:10:00Z","base":"x","source":"weekly","note":"Your long runs have been steady; one more easy day gives the build room.","changes":[{"type":"added","date":"2026-10-30","title":"Easy run","detail":"40 min easy, 103-119 bpm"},{"type":"changed","date":"2026-11-01","title":"Long run","detail":"95 min instead of 88","why":"You held 5:23/km at 138 bpm last Sunday."}]}"""))
        parseCoach(plan.toString(), """{"ready":true}""", """{"week":"2026-10-26","at":"2026-10-29T06:00:00Z","text":"A solid week: **three runs**, all easy.\n\n- Keep Sunday's long run steady\n- Thursday's easy run can be shorter if your legs are heavy","changed":false}""")
    }

    private fun coachShot(name: String, dark: Boolean, scroll: Int = 0) {
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    CoachScreen(coach, coachActions)
                    Chrome(folded = true)
                    FloatingBar("coach", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        if (scroll > 0) {
            rule.onRoot().performTouchInput { swipeUp(startY = height * 0.8f, endY = height * 0.8f - scroll, durationMillis = 400) }
            rule.mainClock.advanceTimeBy(1500)
        }
        save(name)
    }

    @Test fun coachLight() = coachShot("coach-light", dark = false)

    @Test fun coachDark() = coachShot("coach-dark", dark = true)

    @Test fun coachWeek() = coachShot("coach-week", dark = false, scroll = 1800)

    /** Settings → Sources → Plan on your watch: the choice (kept on the phone), and Health Connect's Send. */
    @Test fun planOnYourWatch() {
        val state = org.json.JSONObject("""{"wanted":5,"intervals":{"connected":true,"on":true,"there":5},"hc":{"status":"available","on":true,"plan":false},"line":null}""")
        var asked: String? = null
        val api = object : SettingsApi by extrasApi {
            override suspend fun rpc(name: String, args: org.json.JSONObject): String? =
                if (name == "planOut") { args.optString("op").takeIf { it != "state" }?.let { asked = it }; state.toString() } else extrasApi.rpc(name, args)
            override suspend fun call(name: String, args: org.json.JSONObject): Result<String> = rpc(name, args)?.let { Result.success(it) } ?: Result.failure(Exception("It didn't go through."))
        }
        val ctx: android.content.Context = org.robolectric.RuntimeEnvironment.getApplication()
        PlanDest.set(ctx, "intervals")
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Column(Modifier.fillMaxSize().verticalScroll(androidx.compose.foundation.rememberScrollState()).padding(16.dp)) { PlanWatchCard(api, Modifier) }
            }
        }
        rule.mainClock.advanceTimeBy(1000)
        rule.onNodeWithText("Kept up to date on intervals.icu.").assertExists()
        save("settings-plan-watch")
        rule.onNodeWithText("Samsung, Pixel and others").performClick()
        rule.mainClock.advanceTimeBy(300)
        assertEquals("hc", PlanDest.get(ctx))
        // The plan stays on intervals.icu too until it's stopped: said here, with Stop.
        rule.onNodeWithText("Also kept up to date on intervals.icu.").assertExists()
        save("settings-plan-watch-also")
        rule.onNodeWithText("Send").performClick()
        rule.mainClock.advanceTimeBy(500)
        assertEquals("hc", asked)
        PlanDest.set(ctx, "suunto")
    }

    /** Something came up: the button, its sheet, the Away sheet, what it sends. */
    @Test fun coachLifeAway() {
        var sent: String? = null
        val actions = object : CoachActions by coachActions {
            override suspend fun send(path: String, method: String, body: String?): Pair<Int, String> { sent = "$method $path $body"; return 200 to """{"said":"Easy runs only 16 Nov to 22 Nov.","changes":3}""" }
        }
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize().padding(16.dp)) { LifeButton("2026-11-10", null, actions) {} }
            }
        }
        rule.mainClock.advanceTimeBy(800)
        save("coach-life")
        // One button at the plan's head opens the four in a sheet.
        rule.onNodeWithText("Change plan").performClick()
        rule.mainClock.advanceTimeBy(800)
        rule.onNodeWithText("Something came up?").assertExists()
        rule.onNodeWithText("I'm away").performClick()
        rule.mainClock.advanceTimeBy(800)
        rule.onNodeWithText("Next week").performClick()
        rule.onNodeWithText("Easy runs").performClick()
        rule.mainClock.advanceTimeBy(800)
        rule.onNodeWithText("Change my plan").performClick()
        rule.mainClock.advanceTimeBy(800)
        assertEquals("""POST /api/plan/life {"type":"away","from":"2026-11-16","to":"2026-11-22","train":"easy"}""", sent)
    }

    @Test fun coachLifeIll() {
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = true) { Box(Modifier.fillMaxSize().padding(16.dp)) { LifeButton("2026-11-14", "2026-11-10", coachActions) {} } } }
        rule.mainClock.advanceTimeBy(800)
        rule.onNodeWithText("Feeling better?").assertExists()
        rule.onNodeWithText("I'm ill").assertDoesNotExist()
        save("coach-life-ill-dark")
        // Ill four days: "About a week" picked.
        assertEquals(7, lifeBody(Life.BETTER, "2026-11-14", 7, 0, false).getInt("days"))
        assertEquals("2026-11-14", lifeBody(Life.AWAY, "2026-11-14", 3, 2, false).getString("from"))
        assertEquals("2026-11-27", lifeBody(Life.AWAY, "2026-11-14", 3, 2, false).getString("to"))
    }

    @Test fun readsThePlan() {
        assertEquals("18 weeks of steady building", coach.plan!!.title)
        assertEquals(2, coach.proposal!!.changes.size)
        assertEquals("current", coach.weeks.first { it.time == "current" }.time)
    }

    /** A coach that answers from a script, its answer in lines as the page would stream them. */
    private fun scriptedChat(): ChatModel {
        val api = object : ChatApi {
            override suspend fun get(path: String): String? = when {
                path == "/api/coach/status" -> """{"ready":true,"model":"claude-x","models":[{"id":"claude-x","label":"Claude Opus 5.5"}],"photos":true,"voice":true}"""
                path == "/api/coach/conversations" -> """[{"id":"c1","title":"My long run","updated":"2026-10-29T07:00:00Z"}]"""
                path.startsWith("/api/coach/conversations/") -> """{"display":[{"role":"user","text":"How was Sunday's long run?"},{"role":"assistant","text":"Steady and **well paced**: 14 km at 5:23/km, heart rate 138.","tools":["Reading your long runs","Checking how ready you are"],"by":"Gemma 4 E2B on your phone"}]}"""
                else -> null
            }
            override suspend fun stream(path: String, body: String, onLine: (String) -> Unit): Int {
                listOf(
                    """{"type":"conversation","id":"c1","title":"My long run"}""",
                    """{"type":"tool","name":"get_readiness","label":"Checking how ready you are"}""",
                    """{"type":"tool","name":"get_training_plan","label":"Reading your plan"}""",
                    """{"type":"text","delta":"Yes: keep it **easy**, "}""",
                    """{"type":"text","delta":"about 40 minutes below 119 bpm."}""",
                    """{"type":"plan","updated":"2026-10-29","proposed":1}""",
                    """{"type":"done","stop":"end_turn"}""",
                ).forEach(onLine)
                return 200
            }
        }
        return ChatModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), api)
    }

    @Test fun chatStreams() {
        val chat = scriptedChat()
        chat.open(null, false, null)
        assertEquals("c1", chat.conversation)
        assertEquals(2, chat.messages.size)
        chat.send("Easy run tomorrow?")
        val reply = chat.messages.last()
        assertEquals("Yes: keep it **easy**, about 40 minutes below 119 bpm.", reply.text)
        assertEquals(listOf("Checking how ready you are", "Reading your plan"), reply.steps.map { it.label })
        assert(reply.steps.all { it.done })
        assertEquals("1 change to the plan · review it", reply.links.single().first)
        assert(!chat.busy)
    }

    /**
     * The chat read from disk (opening it again, a slow first load) while an answer streams in: the
     * answer stays on screen and finishes there, and a deliberate reload shows it as saved.
     */
    @Test fun chatKeepsTheAnswerComing() {
        val slow = kotlinx.coroutines.CompletableDeferred<Unit>()
        val answer = kotlinx.coroutines.CompletableDeferred<Unit>()
        var reads = 0
        val api = object : ChatApi {
            override suspend fun get(path: String): String? = when {
                path == "/api/coach/status" -> """{"ready":true,"model":"m","models":[],"photos":true,"voice":true}"""
                path == "/api/coach/conversations" -> """[{"id":"c1","title":"Runs","updated":"2026-11-06T07:00:00Z"}]"""
                path.startsWith("/api/coach/conversations/") -> { reads++; slow.await(); """{"display":[{"role":"user","text":"Old question"},{"role":"assistant","text":"Old answer"}]}""" }
                else -> null
            }
            override suspend fun stream(path: String, body: String, onLine: (String) -> Unit): Int {
                onLine("""{"type":"conversation","id":"c1"}""")
                onLine("""{"type":"text","delta":"Half "}""")
                answer.await()
                onLine("""{"type":"text","delta":"and whole."}""")
                return 200
            }
        }
        val chat = ChatModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), api)
        chat.open(null, false, null)
        assert(chat.loading)
        // Sent while the conversation is still loading: the load, when it lands, doesn't wipe it.
        chat.send("New question")
        slow.complete(Unit)
        assertEquals(listOf("New question", "Half "), chat.messages.map { it.text })
        // Opened again mid-answer (from Coach, or by name): no reload over the live answer.
        chat.open("c1", true, null)
        chat.ensure()
        assertEquals(1, reads)
        answer.complete(Unit)
        assertEquals("and whole.", chat.messages.last().text.removePrefix("Half "))
        assert(!chat.busy && !chat.messages.last().streaming)
        // Back on the chat later: read quietly from disk.
        chat.ensure()
        assertEquals(2, reads)
        assertEquals(listOf("Old question", "Old answer"), chat.messages.map { it.text })
    }

    private fun chatShot(name: String, dark: Boolean, empty: Boolean = false) {
        val chat = scriptedChat()
        if (empty) chat.open(null, true, null) else { chat.open(null, false, null); chat.send("Easy run tomorrow?") }
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    ChatScreen(chat, go = {})
                    Chrome(folded = true, back = {})
                    FloatingBar("chat", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        save(name)
    }

    @Test fun chatLight() = chatShot("chat-light", dark = false)

    @Test fun chatDark() = chatShot("chat-dark", dark = true)

    @Test fun chatEmpty() = chatShot("chat-empty", dark = false, empty = true)

    /** Hold the coach's answer: Copy message and Report reply; reporting asks why, then marks it. */
    @Test fun chatReport() {
        val chat = scriptedChat()
        chat.open(null, false, null)
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Box(Modifier.fillMaxSize()) { ChatScreen(chat, go = {}) } } }
        rule.mainClock.advanceTimeBy(2500)
        rule.onNodeWithText("Steady and", substring = true).performTouchInput { longClick() }
        rule.mainClock.advanceTimeBy(1000)
        rule.onNodeWithText("Copy message").assertExists()
        save("chat-menu")
        rule.onNodeWithText("Report reply").assertExists()
        // Reported: marked under the reply.
        chat.report(chat.messages.last(), "Made-up numbers", "") {}
        rule.mainClock.advanceTimeBy(1000)
        rule.onNodeWithText("Reported: Made-up numbers").assertExists()
    }

    /** A turn that failed stays in the chat with its error and Ask again (the question isn't lost). */
    @Test fun chatFailedTurn() {
        val api = object : ChatApi {
            override suspend fun get(path: String): String? = when {
                path == "/api/coach/status" -> """{"ready":true,"model":"x","models":[],"photos":true,"voice":true}"""
                path == "/api/coach/conversations" -> """[{"id":"c9","title":"Route","updated":"2026-11-14T10:00:00Z"}]"""
                path.startsWith("/api/coach/conversations/") -> """{"display":[{"role":"user","text":"A scenic 5 km from here","failed":true},{"role":"assistant","text":"","failed":true,"error":"Couldn't reach Google: the connection dropped (Tartan asked again once). Check the connection and ask again."},{"role":"user","text":"Try again"},{"role":"assistant","text":"Here it is: a loop round the the harbour, mostly on park paths.","routes":[{"id":"r1","name":"Green 5 km loop in Harbour","km":5.1,"ascent_m":12,"loop":true,"on_watch":true,"scenery":"68% on trails and paths, 74% through parks, woods or meadows, 41% by water","preview":[[4.53,51.925],[4.52944,51.92604],[4.52793,51.92703],[4.52585,51.92794],[4.52374,51.92872],[4.522,51.92933],[4.52085,51.92976],[4.52022,51.92997],[4.51978,51.92997],[4.51915,51.92976],[4.518,51.92933],[4.51626,51.92872],[4.51415,51.92794],[4.51207,51.92703],[4.51056,51.92604],[4.51,51.925],[4.51056,51.92396],[4.51207,51.92297],[4.51415,51.92206],[4.51626,51.92128],[4.518,51.92067],[4.51915,51.92024],[4.51978,51.92003],[4.52022,51.92003],[4.52085,51.92024],[4.522,51.92067],[4.52374,51.92128],[4.52585,51.92206],[4.52793,51.92297],[4.52944,51.92396],[4.53,51.925]]}]}]}"""
                else -> null
            }
            override suspend fun stream(path: String, body: String, onLine: (String) -> Unit): Int = 200
        }
        val chat = ChatModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), api)
        chat.open(null, false, null)
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Box(Modifier.fillMaxSize()) { ChatScreen(chat, go = {}) } } }
        rule.mainClock.advanceTimeBy(2500)
        rule.onNodeWithText("Ask again").assertExists()
        rule.onNodeWithText("Green 5 km loop in Harbour").assertExists()
        rule.onNodeWithText("5.1 km · 12 m climb · loop").assertExists()
        rule.onNodeWithText("On your watch").assertExists()
        save("chat-failed")
    }

    /** Report reply: why, a note, and whether it goes to Tartan's developer (the dialog's form). */
    @Test fun chatReportForm() {
        val f = ReportState()
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(24.dp)) { Text("Report this reply", style = MaterialTheme.typography.headlineSmall); ReportForm(f) } } }
        rule.onNodeWithText("Made-up numbers").performClick()
        rule.waitForIdle()
        save("chat-report")
        assertEquals("Made-up numbers", f.reason)
        assertEquals(true, f.send)
    }
    /** An answer that's taking a while: what the coach is doing, for how long, and that leaving is fine. */
    @Test fun chatWorking() {
        val chat = scriptedChat()
        chat.open(null, false, null)
        chat.messages.add(Msg(true, "Build me a 10k plan around my long runs"))
        chat.messages.add(Msg(false).also { it.streaming = true; it.started -= 47_000; it.steps.add(Step("Reading your long runs").also { s -> s.done = true }); it.steps.add(Step("Checking how ready you are")) })
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Box(Modifier.fillMaxSize()) { ChatScreen(chat, go = {}); Chrome(folded = true) } } }
        rule.mainClock.advanceTimeBy(2500)
        save("chat-working")
    }

    /** The demo's 30 runs, with one turned into a ride and one matched across the watch and Strava. */
    private val acts by lazy {
        val a = org.json.JSONArray(fixture("activities.json"))
        a.getJSONObject(1).put("sport", "Ride").put("name", "Gravel loop").put("avg_pace_min_km", org.json.JSONObject.NULL)
        a.getJSONObject(0).put("sources", org.json.JSONArray(listOf("watch", "strava")))
        parseActivities(a.toString())
    }

    private val actsActions = object : ActivitiesActions {
        override fun openActivity(id: String) {}
        override fun go(hash: String) {}
    }

    private fun actsShot(name: String, dark: Boolean) {
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    ActivitiesScreen(acts, actsActions)
                    Chrome(folded = true)
                    FloatingBar("activities", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        save(name)
    }

    @Test fun activitiesLight() = actsShot("activities-light", dark = false)

    /** Material's controls on the native screens tick under the finger like the cards (Buttons.kt). */
    @Test fun buttonsAndSwitchesTick() {
        var view: android.view.View? = null
        var on by mutableStateOf(false)
        var taps = 0
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                view = androidx.compose.ui.platform.LocalView.current
                androidx.compose.foundation.layout.Column {
                    TextButton(onClick = { taps++ }) { Text("Tap me") }
                    Switch(on, { on = it }, Modifier.testTag("switch"))
                }
            }
        }
        val shadow = org.robolectric.Shadows.shadowOf(view!!)
        assertEquals(-1, shadow.lastHapticFeedbackPerformed())
        rule.onNodeWithText("Tap me").performClick()
        rule.waitForIdle()
        assertEquals(1, taps)
        val tick = if (android.os.Build.VERSION.SDK_INT >= 34) android.view.HapticFeedbackConstants.SEGMENT_TICK else android.view.HapticFeedbackConstants.VIRTUAL_KEY
        assertEquals(tick, shadow.lastHapticFeedbackPerformed())
        rule.onNodeWithTag("switch").performClick()
        rule.waitForIdle()
        assertEquals(true, on)
        assertEquals(tick, shadow.lastHapticFeedbackPerformed())
    }

    /** Scrolling a list down folds the bar small; one tap on another tab still goes there, and touching it unfolds it. */
    @Test fun barFoldsWhileScrolling() {
        val fold = NavFold()
        var chosen by mutableStateOf<String?>(null)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                androidx.compose.runtime.CompositionLocalProvider(LocalNavFold provides fold) {
                    val conn = remember { fold.connection(24f) }
                    Box(Modifier.fillMaxSize().nestedScroll(conn)) {
                        ActivitiesScreen(acts, actsActions)
                        Chrome(folded = true)
                    }
                    Box(Modifier.fillMaxSize()) {
                        FloatingBar(chosen ?: "activities", hidden = false, onSelect = { chosen = it }, modifier = Modifier.align(Alignment.BottomCenter), folded = fold.folded, onUnfold = { fold.folded = false })
                    }
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        assertEquals(false, fold.folded)
        rule.onRoot().performTouchInput { swipe(Offset(width / 2f, height * 0.6f), Offset(width / 2f, height * 0.3f), 300) }
        rule.mainClock.advanceTimeBy(1500)
        assertEquals(true, fold.folded)
        save("nav-folded")
        // Back up a little: it unfolds.
        rule.onRoot().performTouchInput { swipe(Offset(width / 2f, height * 0.3f), Offset(width / 2f, height * 0.5f), 300) }
        rule.mainClock.advanceTimeBy(1500)
        assertEquals(false, fold.folded)
        // Folded again, a tap on the folded pill's Coach goes straight there and unfolds it.
        rule.onRoot().performTouchInput { swipe(Offset(width / 2f, height * 0.6f), Offset(width / 2f, height * 0.3f), 300) }
        rule.mainClock.advanceTimeBy(1500)
        assertEquals(true, fold.folded)
        // The folded pill is 232dp wide, centred: Coach is its second quarter.
        val dp = rule.density.density
        rule.onRoot().performTouchInput {
            val left = width / 2f - 116 * dp
            val x = left + 8 * dp + (216 * dp) * 0.375f
            val y = height - 12 * dp - 26 * dp
            down(Offset(x, y)); up()
        }
        rule.mainClock.advanceTimeBy(800)
        assertEquals("coach", chosen)
        assertEquals(false, fold.folded)
    }

    @Test fun activitiesDark() = actsShot("activities-dark", dark = true)

    @Test fun filtersAndSearch() {
        assertEquals(30, acts.size)
        // A ride without a pace (JSON null) says its heart rate instead, as the web does, not "null /km".
        assertEquals("50 min · 145 bpm", acts.first { it.name == "Gravel loop" }.small)
        val (runs, nRuns) = weeks(acts, "run", "")
        assertEquals(29, nRuns)
        assert(runs.all { w -> w.acts.all { it.family == "run" } })
        assertEquals(1, weeks(acts, "ride", "").second)
        assertEquals(listOf("Gravel loop"), weeks(acts, "all", "gravel").first.flatMap { it.acts }.map { it.name })
        // Weeks start on Monday and come newest first.
        val all = weeks(acts, "all", "").first
        assert(all.all { it.monday.dayOfWeek == java.time.DayOfWeek.MONDAY })
        assert(all.zipWithNext().all { (a, b) -> a.monday > b.monday })
    }

    /** Progress on the demo's data: every route answered from the saved fixtures. */
    private fun progressModel(): ProgressModel = ProgressModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined)) { path ->
        when {
            path.startsWith("/api/dashboard") -> fixture("dashboard.json")
            path.startsWith("/api/race-shape") -> fixture("race-shape.json")
            path.startsWith("/api/days") -> fixture("days.json")
            path.startsWith("/api/durability") -> fixture("durability.json")
            path.startsWith("/api/week") -> fixture("week.json")
            path == "/api/plan" -> fixture("plan.json")
            else -> null
        }
    }

    private val progressActions = object : ProgressActions {
        override fun openActivity(id: String) {}
        override fun go(hash: String) {}
    }

    private fun progressShot(name: String, dark: Boolean, range: Int = 84, scroll: Int = 0) {
        val m = progressModel()
        m.range = range
        m.ensure()
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    ProgressScreen(m, progressActions)
                    Chrome(folded = true)
                    FloatingBar("trends", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        if (scroll > 0) {
            rule.onRoot().performTouchInput { swipeUp(startY = height * 0.85f, endY = height * 0.85f - scroll, durationMillis = 500) }
            rule.mainClock.advanceTimeBy(2000)
        }
        save(name)
    }

    @Test fun progressLight() = progressShot("progress-light", dark = false)

    @Test fun progressDark() = progressShot("progress-dark", dark = true)

    @Test fun progressCharts() = progressShot("progress-charts", dark = false, scroll = 1700)

    @Test fun progressMore() = progressShot("progress-more", dark = false, scroll = 3400)

    @Test fun progressWeek() = progressShot("progress-week", dark = false, range = 7)

    @Test fun readsProgress() {
        val m = progressModel()
        m.ensure()
        val d = m.dash[84]!!
        assertEquals("12 weeks", d.totals[0].label)
        assert(d.weeks.isNotEmpty() && d.fitness.size > 1)
        assertEquals(listOf("5k", "10k", "Half"), m.shape[84]!!.map { it.name })
        assert(m.durability[84]!!.runs.isNotEmpty())
        m.range = 7
        m.ensure()
        assertEquals(7, m.weeks[""]!!.days.size)
        assertEquals("25:30", clock(1530))
        assertEquals("1:52:10", clock(6730))
    }

    /** Pull to sync, said in the chip: pulling, far enough to let go, syncing. */
    @Test fun pullStates() {
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                androidx.compose.runtime.CompositionLocalProvider(LocalBoard provides BoardState(listOf(Lane("watch", "ok", "2h", "watch"), Lane("strava", "ok", "5m", "strava"))) {}) {
                    androidx.compose.foundation.layout.Column(Modifier.fillMaxSize().background(androidx.compose.material3.MaterialTheme.colorScheme.surface)) {
                        TopChrome(folded = false, onSettings = {}, pull = 0.5f)
                        TopChrome(folded = false, onSettings = {}, pull = 1.1f)
                        TopChrome(folded = false, onSettings = {}, syncing = true)
                        TopChrome(folded = true, onSettings = {})
                    }
                }
            }
        }
        rule.mainClock.advanceTimeBy(1500)
        save("pull-states")
    }

    /** Settings on the demo's data; writes are kept to look at. */
    private val sent = mutableListOf<Triple<String, String, String?>>()
    private fun settingsModel(): SettingsModel = SettingsModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), object : SettingsApi {
        override suspend fun get(path: String): String? = when (path) {
            "/api/goals" -> fixture("goals.json")
            "/api/profile" -> fixture("profile.json")
            "/api/schedule" -> fixture("schedule.json")
            "/api/plan" -> fixture("plan.json")
            "/api/coach/status" -> fixture("coach-status.json")
            "/api/coach/memory" -> """{"notes":[{"id":"n1","kind":"health","text":"Left Achilles niggle in spring 2026; keep hills gentle."},{"id":"n2","kind":"preference","text":"Prefers long runs on Sunday mornings."}]}"""
            else -> null
        }
        override suspend fun send(path: String, method: String, body: String?): Pair<Int, String> { sent.add(Triple(path, method, body)); return 200 to "{}" }
        override suspend fun rpc(name: String, args: org.json.JSONObject): String? = if (name == "prefs") """{"colours":"wallpaper","weekly":true,"demos":"me","version":"0.3.0-tartan2.9","build":"20261028-1800"}""" else "null"
    })

    private val settingsActions = object : SettingsActions {
        override fun go(hash: String) {}
        override fun parts() = mapOf("nav" to true, "today" to true, "coach" to true, "chat" to true, "activities" to true, "progress" to true, "settings" to true)
        override fun setPart(name: String, on: Boolean) {}
    }

    private fun settingsShot(name: String, group: String, dark: Boolean = false, scroll: Int = 0) {
        val m = settingsModel()
        m.ensure()
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    SettingsScreen(m, group, settingsActions)
                    Chrome(folded = true)
                    FloatingBar("settings", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        if (scroll > 0) {
            rule.onRoot().performTouchInput { swipeUp(startY = height * 0.85f, endY = height * 0.85f - scroll, durationMillis = 500) }
            rule.mainClock.advanceTimeBy(2000)
        }
        save(name)
    }

    @Test fun settingsTraining() = settingsShot("settings-training", "training")

    @Test fun settingsTimes() = settingsShot("settings-times", "training", scroll = 1900)

    /** On a bad-weather day: Run anyway, Swim, Bike or Treadmill, saved with the training times. */
    private fun badWeatherShot(name: String, dark: Boolean) {
        val m = settingsModel()
        m.ensure()
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    SettingsScreen(m, "training", settingsActions)
                    Chrome(folded = true)
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        rule.onNodeWithText("The dark").performScrollTo()
        rule.mainClock.advanceTimeBy(1500)
        save(name)
        rule.onNodeWithText("Swim").performClick()
        rule.mainClock.advanceTimeBy(500)
        assertEquals("swim", org.json.JSONObject(sent.last { it.first == "/api/schedule" }.third!!).getString("bad_weather"))
        rule.onNodeWithText("Ice and snow").performClick()
        rule.mainClock.advanceTimeBy(500)
        assertEquals("[\"ice\"]", org.json.JSONObject(sent.last { it.first == "/api/schedule" }.third!!).getJSONArray("avoid").toString())
    }

    @Test fun settingsBadWeather() = badWeatherShot("settings-bad-weather", dark = false)
    @Test fun settingsBadWeatherDark() = badWeatherShot("settings-bad-weather-dark", dark = true)

    @Test fun settingsCoach() = settingsShot("settings-coach", "coach")

    /** The note after a run: on unless turned off (src/after-run.ts), with the other notifications. */
    @Test fun afterRunSwitch() {
        assert(SettingsModel.parseTimes(fixture("schedule.json")).runNote)
        val off = org.json.JSONObject(fixture("schedule.json")).apply { getJSONObject("prefs").put("notify", org.json.JSONObject().put("morning", true).put("morning_at", "07:30").put("review", true).put("run", false)) }
        assert(!SettingsModel.parseTimes(off.toString()).runNote)
        val m = settingsModel()
        m.ensure()
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { SettingsScreen(m, "training", settingsActions) } }
        rule.waitForIdle()
        rule.onNodeWithText("After a run").performScrollTo()
        // Its switch is the toggle in the same row: turn it off.
        rule.onAllNodes(androidx.compose.ui.test.isToggleable()).fetchSemanticsNodes().size.let { assert(it >= 5) }
        val row = rule.onNodeWithText("After a run").fetchSemanticsNode().boundsInRoot
        val toggles = rule.onAllNodes(androidx.compose.ui.test.isToggleable())
        val idx = toggles.fetchSemanticsNodes().indexOfFirst { kotlin.math.abs(it.boundsInRoot.center.y - row.center.y) < 120 }
        assert(idx >= 0)
        toggles[idx].performClick()
        rule.waitForIdle()
        val put = sent.last { it.first == "/api/schedule" }
        assertEquals(false, org.json.JSONObject(put.third!!).getJSONObject("notify").getBoolean("run"))
    }

    @Test fun settingsMore() = settingsShot("settings-more", "more", dark = true)

    @Test fun savesTargets() {
        val m = settingsModel()
        m.ensure()
        val g = m.goals!!
        assertEquals(45.0, g.weeklyKm)
        assertEquals("Helsinki Half", g.raceName)
        assertEquals(6300, g.raceTarget)
        m.saveGoals(g.copy(weeklyKm = 50.0))
        val (path, method, body) = sent.last()
        assertEquals("/api/goals" to "PUT", path to method)
        val b = org.json.JSONObject(body!!)
        assertEquals(50.0, b.getDouble("weekly_km"), 0.0)
        assertEquals("Helsinki Half", b.getJSONObject("race").getString("name"))
        assertEquals(2, m.notes.size)
    }

    /** A row wider than its room (the race distances in a card): a drag scrolls it, a tap still picks. */
    @Test fun wideRowScrolls() {
        var picked by mutableStateOf(0)
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.width(220.dp).background(androidx.compose.ui.graphics.Color.White)) {
                    Segmented(listOf("No race", "5 km", "10 km", "Half", "Marathon"), picked, { picked = it })
                }
            }
        }
        rule.waitForIdle()
        val far = rule.onNodeWithText("Marathon")
        val before = far.fetchSemanticsNode().positionInRoot.x
        assert(before + 40 > with(rule.density) { 220.dp.toPx() }) { "Marathon should start off the edge: $before" }
        rule.onRoot().performTouchInput { swipe(Offset(width * 0.8f, centerY), Offset(width * 0.1f, centerY), 200) }
        rule.waitForIdle()
        val after = far.fetchSemanticsNode().let { androidx.compose.ui.geometry.Rect(it.positionInRoot, it.size.toSize()) }
        assertEquals(0, picked)
        assert(after.left < before && after.right <= with(rule.density) { 220.dp.toPx() } + 1) { "Marathon should have scrolled into view: $before -> $after" }
        far.performClick()
        rule.waitForIdle()
        assertEquals(4, picked)
        save("segmented-scrolled")
    }

    /** A workout's sheet on the demo's run (a watch copy added, notes, shoes, a finish with next time). */
    private val wsent = mutableListOf<Triple<String, String, String?>>()
    private fun workoutModel(): WorkoutModel = WorkoutModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), object : WorkoutApi {
        override suspend fun get(path: String): String? = when {
            path.endsWith("/finish") -> fixture("finish.json")
            path.startsWith("/api/activity/") -> fixture("workout.json")
            path.startsWith("/api/notes") -> fixture("notes.json")
            path.startsWith("/api/shoes/run") -> fixture("shoes-run.json")
            path.startsWith("/api/body/workout") -> fixture("worked.json")
            else -> null
        }
        override suspend fun send(path: String, method: String, body: String?): Pair<Int, String> {
            wsent.add(Triple(path, method, body))
            return 200 to if (path == "/api/notes") """{"notes":[{"id":"n3","run":"atnlz3k","date":"2026-10-28","tag":"note","text":"windy"}]}""" else """{"strava":"set"}"""
        }
    }, "atnlz3k", kotlinx.coroutines.Dispatchers.Unconfined)

    private fun workoutShot(name: String, dark: Boolean = false, scroll: Int = 0) {
        val m = workoutModel()
        m.load()
        val sc = androidx.compose.foundation.ScrollState(0)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize().background(androidx.compose.material3.MaterialTheme.colorScheme.surface)) {
                    WorkoutBody(m, {}, {}, Modifier.padding(top = 40.dp).verticalScroll(sc))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        if (scroll > 0) {
            rule.runOnUiThread { sc.dispatchRawDelta(scroll.toFloat()) }
            rule.mainClock.advanceTimeBy(1500)
        }
        save(name)
    }

    @Test fun workoutLight() = workoutShot("workout-light")

    @Test fun workoutDark() = workoutShot("workout-dark", dark = true)

    @Test fun workoutCharts() = workoutShot("workout-charts", scroll = 3600)

    @Test fun workoutSources() = workoutShot("workout-sources", scroll = 8000)

    @Test fun readsTheWorkout() {
        val m = workoutModel()
        m.load()
        val w = m.workout!!
        assertEquals("Morning easy run", w.name)
        assertEquals(listOf("watch", "strava"), w.copies.map { it.source })
        assert(w.isRun && w.shod)
        assertEquals(201, w.route.size)
        assertEquals(7, w.splits.size)
        assertEquals("Novablast 5", m.shoes.first { it.id == m.shoe }.name)
        assertEquals(2, m.notes.size)
        assertEquals(4, m.feeling)
        assertEquals(-5, m.finish!!.next!!.shiftS)
        // The charts are even steps of distance, from 0 to the whole way.
        val a = along(w)
        assertEquals(0.0, a.km.first(), 1e-9)
        assertEquals(w.distance.filterNotNull().last() / 1000, a.km.last(), 1e-9)
        assert(a.pace!!.filterNotNull().all { it in 240.0..480.0 }) { "pace in s/km" }
        // A note being written is kept when the sheet closes.
        m.draftTag = "niggle"; m.draftArea = "calf"
        m.keepDraft()
        val (path, method, body) = wsent.last()
        assertEquals("/api/notes" to "POST", path to method)
        assertEquals("calf", org.json.JSONObject(body!!).getString("area"))
        assertEquals("", m.draft)
        assertEquals(listOf("n3"), m.notes.map { it.id })
        // Shoes: none, then said so.
        m.pickShoe(null)
        assertEquals("This run counts to no shoes.", m.said)
    }

    /** The page's answers for Today's extras and the session sheet (body pictures: none, as without WebGL). */
    private val tsent = mutableListOf<Triple<String, String, String?>>()
    private val shellApi = object : SettingsApi {
        override suspend fun get(path: String): String? = when {
            path == "/api/readiness" -> fixture("readiness.json")
            path == "/api/health" -> fixture("health.json")
            path == "/api/shoes" -> """{"shoes":[],"runs":{"count":30,"first":"2026-09-09T01:24:20.532Z"}}"""
            path == "/api/plan" -> fixture("plan-session.json")
            path.startsWith("/api/plan/review") -> null
            else -> null
        }
        override suspend fun send(path: String, method: String, body: String?): Pair<Int, String> { tsent.add(Triple(path, method, body)); return 200 to fixture("readiness.json") }
        override suspend fun rpc(name: String, args: org.json.JSONObject): String? = when (name) {
            "raceWeek" -> fixture("raceweek.json")
            "routine" -> fixture("routine.json")
            "prefs" -> """{"paired":false}"""
            else -> null
        }
    }
    private val keys = object : KeyStore {
        val m = HashMap<String, String>()
        override fun get(key: String) = m[key]
        override fun set(key: String, value: String) { m[key] = value }
    }

    private fun todayRaceShot(name: String, scroll: Int = 0, dark: Boolean = false, file: String = "today-race.json", scrollTo: String? = null) {
        val d = LocalDate.of(2026, 10, 28)
        val t = parseToday(fixture(file), fixture("plan-session.json"), d, java.time.Instant.parse("2026-10-28T20:00:00Z"))
        val more = TodayModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), shellApi, keys)
        more.load(t.race, t.last, object : WorkoutApi {
            override suspend fun get(path: String) = if (path.endsWith("/finish")) fixture("finish.json") else null
            override suspend fun send(path: String, method: String, body: String?) = 200 to "{}"
        })
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    TodayScreen(t, refreshing = false, actions = none, date = d, more = more)
                    Chrome(folded = scroll > 0)
                    FloatingBar("today", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        if (scroll > 0) {
            rule.onRoot().performTouchInput { swipeUp(startY = height * 0.85f, endY = height * 0.85f - scroll, durationMillis = 500) }
            rule.mainClock.advanceTimeBy(2000)
        }
        // To a card by its words: swiped up until it's a third of the way down (the clock stays paused).
        scrollTo?.let { text ->
            repeat(4) {
                val top = rule.onNodeWithText(text).fetchSemanticsNode().positionInRoot.y
                val h = rule.onRoot().fetchSemanticsNode().size.height
                val by = top - h * 0.45f
                if (by > 40f) {
                    rule.onRoot().performTouchInput { swipeUp(startY = height * 0.9f, endY = height * 0.9f - by.coerceAtMost(height * 0.8f), durationMillis = 600) }
                    rule.mainClock.advanceTimeBy(2000)
                }
            }
        }
        save(name)
    }

    @Test fun todayRace() = todayRaceShot("today-race")

    /**
     * The pair-hint note on a narrow phone with large text: its second button drops to the next line
     * instead of squeezing to a letter or two a line (the owner's phone: "Typ / e it / inst / ead").
     */
    @Test @Config(qualifiers = "w360dp-h640dp-port-xxhdpi") fun noteCardNarrow() {
        rule.setContent {
            val d = androidx.compose.ui.platform.LocalDensity.current
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(d.density, fontScale = 1.3f)) {
                TartanTheme(wallpaper = false, dark = false) {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface).padding(16.dp)) {
                        NoteCard(
                            "phone", androidx.compose.ui.res.stringResource(dev.freesuunto.app.R.string.today_tartan_on_your_pc_too),
                            androidx.compose.ui.res.stringResource(dev.freesuunto.app.R.string.today_pair_them_the_same_plan_coach),
                            androidx.compose.ui.res.stringResource(dev.freesuunto.app.R.string.today_scan_my_pc_s_code), androidx.compose.ui.res.stringResource(dev.freesuunto.app.R.string.today_type_it_instead), Modifier, {}, {}, {},
                        )
                    }
                }
            }
        }
        rule.waitForIdle()
        save("note-card-narrow")
        // Each button's words on one line: the second sits below the first.
        val scan = rule.onNodeWithText("Scan my PC's code", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val type = rule.onNodeWithText("Type it instead", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val line = 26 * rule.activity.resources.displayMetrics.density * 1.5f
        assert(type.height < line && scan.height < line) { "a button's words wrapped: ${type.height}, ${scan.height}" }
        assert(type.top > scan.bottom - 1) { "Type it instead should drop below Scan my PC's code" }
    }

    /** Twelve weeks to race week: the countdown, the prediction moved, the target; the taper in the last two weeks. */
    @Test fun todayCountdown() {
        val t = parseToday(fixture("today-countdown.json"), fixture("plan-session.json"), LocalDate.of(2026, 10, 28))
        val c = t.race!!.countdown!!
        assertEquals(40, c.daysToGo)
        assertEquals(-90, c.changeS)
        assert(!c.taper)
        todayRaceShot("today-countdown", file = "today-countdown.json", scrollTo = "3:20 to find")
        rule.onNodeWithText("1:30 quicker than a month ago").assertExists()
        rule.onNodeWithText("3:20 to find").assertExists()
    }

    @Test fun todayTaperDark() = todayRaceShot("today-taper-dark", dark = true, file = "today-taper.json", scrollTo = "The taper")

    /** The morning check stays open until sleep and legs are both answered; changed, Done folds it. */
    @Test fun morningCheckFoldsWhenComplete() {
        val m = TodayModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), shellApi, keys)
        fun check(sleep: Int?, legs: Int?) = Check("2026-11-19", sleep, legs, null, answered = sleep != null || legs != null, measured = false, level = "ready", reasons = emptyList(), sessionTitle = null, sessionKind = null, sessionDone = false, swappedFrom = null, swapKind = null, suggestSwap = false)
        m.check = check(null, 3)
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { MorningCheck(m) } }
        // Legs answered, sleep not: still asking.
        rule.onNodeWithText("How do you feel this morning?").assertExists()
        rule.onNodeWithText("Sleep").assertExists()
        // Both answered: folded to what you said.
        m.check = check(2, 3)
        rule.waitForIdle()
        rule.onNodeWithText("How do you feel this morning?").assertDoesNotExist()
        // Change opens it; Done folds it again.
        rule.onNodeWithText("Change").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("How do you feel this morning?").assertExists()
        rule.onNodeWithText("Done").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("How do you feel this morning?").assertDoesNotExist()
        assertEquals(false, m.checkEditing)
    }

    @Test fun todayCheck() = todayRaceShot("today-check", scroll = 2700)

    @Test fun todayCheckDark() = todayRaceShot("today-check-dark", scroll = 3600, dark = true)

    private val sessionActions = object : SessionActions {
        override fun openWorkout(id: String) {}
        override fun chat(conversation: String?, prefill: String?) {}
        override fun go(hash: String) {}
    }

    private fun sessionShot(name: String, date: String, kind: String, scroll: Int = 0) {
        val m = SessionModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), shellApi, date, kind)
        m.load()
        val sc = androidx.compose.foundation.ScrollState(0)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize().background(androidx.compose.material3.MaterialTheme.colorScheme.surface)) {
                    SessionBody(m, sessionActions, {}, Modifier.padding(top = 40.dp).verticalScroll(sc))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        if (scroll > 0) { rule.runOnUiThread { sc.dispatchRawDelta(scroll.toFloat()) }; rule.mainClock.advanceTimeBy(1000) }
        save(name)
    }

    @Test fun sessionIntervals() = sessionShot("session-intervals", "2026-10-28", "intervals")

    @Test fun sessionStrength() = sessionShot("session-strength", "2026-10-30", "strength", scroll = 500)

    @Test fun readsTheMorningCheck() {
        val c = parseCheck(fixture("readiness.json"))
        assertEquals("Go easy today.", c.verdict)
        assertEquals("calf" to 1, c.pain)
        assert(c.suggestSwap && !c.measured)
        val more = TodayModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), shellApi, keys)
        more.load(null, null, object : WorkoutApi { override suspend fun get(path: String) = null; override suspend fun send(path: String, method: String, body: String?) = 200 to "{}" })
        assertEquals(52, more.vitals!!.rest)
        assertEquals(5, more.vitals!!.restDiff)
        more.answer(legs = 3)
        val b = org.json.JSONObject(tsent.last().third!!)
        assertEquals(1, b.getInt("sleep"))
        assertEquals(3, b.getInt("legs"))
        assertEquals("calf", b.getJSONObject("pain").getString("area"))
        more.answer(clearPain = true)
        assert(org.json.JSONObject(tsent.last().third!!).isNull("pain"))
        more.swap(undo = false) {}
        assertEquals("/api/plan/swap", tsent.last().first)
        // The session sheet finds its session, its blocks, and the routine for a strength day.
        val s = findSession(fixture("plan-session.json"), "2026-10-28", "intervals")!!
        assertEquals(listOf(1 to "Warm up 15 min", 5 to "Run 1 km, then Recover 2 min", 1 to "Cool down 10 min"), s.steps)
        assert(s.canMark)
        val r = parseRoutine(fixture("routine.json"))
        assert(r.basic && r.items.isNotEmpty())
        // Race week from the page: pacing for the target, the checklist.
        val w = parseRaceWeek(fixture("raceweek.json"))!!
        assertEquals(6300, w.pacing!!.timeS)
        assert(w.checklist.isNotEmpty())
    }

    private val bodyApi = object : SettingsApi {
        override suspend fun get(path: String): String? = when (path) { "/api/body" -> fixture("body.json"); "/api/health" -> fixture("health.json"); else -> null }
        override suspend fun send(path: String, method: String, body: String?) = 200 to "{}"
        override suspend fun rpc(name: String, args: org.json.JSONObject): String? = if (name == "exercises") fixture("exercises.json") else null
    }

    private fun bodyShot(name: String, dark: Boolean, scroll: Int = 0) {
        val m = BodyModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), bodyApi)
        m.ensure()
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = dark) {
                Box(Modifier.fillMaxSize()) {
                    BodyScreen(m, back = {})
                    Chrome(folded = true)
                    FloatingBar("you", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        if (scroll > 0) {
            rule.onRoot().performTouchInput { swipeUp(startY = height * 0.85f, endY = height * 0.85f - scroll, durationMillis = 500) }
            rule.mainClock.advanceTimeBy(2000)
        }
        save(name)
    }

    @Test fun bodyLight() = bodyShot("body-light", dark = false)

    @Test fun bodyDark() = bodyShot("body-dark", dark = true)

    @Test fun bodyVitals() = bodyShot("body-vitals", dark = false, scroll = 1400)

    @Test fun readsTheBody() {
        val b = parseBody(fixture("body.json"))
        assertEquals(19, b.size)
        val need = needing(b)
        assert(need.first() in listOf("calves", "quads", "hamstrings")) { need.toString() }
        assert(bodySummary(b).isNotEmpty())
        assertEquals("calf", b.getValue("calves").sore!!.first)
        val h = parseHealth(fixture("health.json"), "2026-10-28")
        assertEquals(52, h.restHr)
        assertEquals("7 h 18", h.sleep)
        assertEquals("about 2 days", inHours(48.0))
        assertEquals("about 6 h", inHours(6.0))
    }

    private val sourcesApi = object : SettingsApi {
        override suspend fun get(path: String): String? = when (path) {
            "/api/strava/status" -> """{"configured":true,"clientId":"cid","connected":true,"can_upload":false,"athlete":{"firstname":"Test","lastname":"Runner"},"activities":30,"lastSync":"2026-10-28T18:12:20.774Z","pendingDetails":4,"stoppedForRateLimit":false}"""
            "/api/strava/send-watch" -> """{"enabled":true,"since":"2026-10-01T10:00:00Z","connected":true,"can_upload":false,"sent":0,"last":null,"errors":[]}"""
            else -> null
        }
        override suspend fun send(path: String, method: String, body: String?) = 200 to "{}"
        override suspend fun rpc(name: String, args: org.json.JSONObject): String? = when (name) {
            "hc" -> """{"status":"available","on":true,"kinds":{"workouts":true,"vitals":true,"activity":false,"sleep":true},"missing":{"workouts":false,"vitals":true,"activity":false,"sleep":false},"last":{"at":1761670000000,"written":214,"covered":3,"sleep":7},"note":null}"""
            "pcState" -> "null"
            else -> null
        }
    }

    @Test fun settingsSources() {
        val m = settingsModel()
        m.ensure()
        val src = SourcesModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), sourcesApi)
        src.watch = parseWatch("""{"connected":true,"connecting":false,"demo":false,"name":"Suunto Run 2","facts":[["Watch","Suunto Run 2"],["Battery","81%"],["Firmware","2.36.12"],["Serial","x"]],"cwd":"/","listing":{"dirs":["Logbook"],"files":[]},"job":{"title":"Backing up","text":"12 of 40 files","value":12,"max":40},"running":true,"mode":"files","canBluetooth":true,"noFileAccess":false}""")
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize()) {
                    SettingsScreen(m, "sources", settingsActions, sources = src)
                    Chrome(folded = true)
                    FloatingBar("settings", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        save("settings-sources")
        rule.onRoot().performTouchInput { swipeUp(startY = height * 0.85f, endY = height * 0.85f - 2200, durationMillis = 500) }
        rule.mainClock.advanceTimeBy(2000)
        save("settings-sources-2")
        assertEquals(26, src.strava!!.detailed)
        assertEquals(true, src.hc!!.missing["vitals"])
    }

    private val extrasApi = object : SettingsApi {
        override suspend fun get(path: String): String? = when (path) {
            "/api/shoes" -> """{"shoes":[{"id":"s1","name":"Novablast 5","since":"2026-06-01","start_km":0,"limit_km":700,"kind":"daily","strava_id":"g1","km":612,"runs":71,"used":0.87},{"id":"s2","name":"Metaspeed Sky","since":"2026-08-10","start_km":0,"limit_km":400,"km":88,"runs":6,"used":0.22},{"id":"s3","name":"Pegasus 40","since":"2025-11-01","start_km":0,"limit_km":700,"retired":"2026-06-01","km":702,"runs":80,"used":1.0}],"assign":{},"strava":{"connected":true,"can_write":true},"to_strava":{"s1":3}}"""
            "/api/coach/status" -> fixture("coach-status.json")
            else -> null
        }
        override suspend fun send(path: String, method: String, body: String?) = 200 to "{}"
        override suspend fun rpc(name: String, args: org.json.JSONObject): String? = when (name) {
            "fuel" -> """{"drink":true,"drinkMin":15,"gel":true,"gelMin":40,"fromMin":75}"""
            "runner" -> """{"public":false,"choice":"suunto"}"""
            "faces" -> """{"canBluetooth":true,"faces":[{"id":"tt","name":"Tartan Track","builtin":true,"onWatch":true,"picture":null},{"id":"f1","name":"Night run","builtin":false,"onWatch":false,"picture":null}]}"""
            "weekFace" -> "null"
            "backup" -> """{"pass":true,"weekly":true,"last":1761600000000,"where":"Documents/Tartan","failed":null,"min":8,"said":null}"""
            "recorder" -> """{"armed":false,"recording":false,"last":null}"""
            "pcState" -> """{"url":"http://192.168.1.20:5173","name":"Desk PC"}"""
            "hc" -> """{"status":"available","on":false,"kinds":{},"missing":{},"last":null}"""
            else -> null
        }
    }

    private fun extrasShot(name: String, group: String, scroll: Int = 0) {
        val m = settingsModel()
        m.ensure()
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined)
        val src = SourcesModel(scope, extrasApi)
        val x = SettingsExtras(ShoesModel(scope, extrasApi), CoachSetupModel(scope, extrasApi), WatchGroupModel(scope, extrasApi), MoreModel(scope, extrasApi), src)
        src.ensure()
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize()) {
                    SettingsScreen(m, group, settingsActions, sources = src, extras = x)
                    Chrome(folded = true)
                    FloatingBar("settings", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        if (scroll > 0) {
            rule.onRoot().performTouchInput { swipeUp(startY = height * 0.85f, endY = height * 0.85f - scroll, durationMillis = 500) }
            rule.mainClock.advanceTimeBy(2000)
        }
        save(name)
    }

    @Test fun settingsShoes() = extrasShot("settings-shoes", "training", scroll = 4300)

    @Test fun settingsCoachSetup() = extrasShot("settings-coach-setup", "coach")

    @Test fun settingsWatch() = extrasShot("settings-watch", "watch")

    /** The model menu's Other: a typed name (as Google writes it) is what's saved, on its own. */
    @Test fun coachModelTyped() {
        val sent = mutableListOf<String>()
        val api = object : SettingsApi by extrasApi {
            override suspend fun send(path: String, method: String, body: String?): Pair<Int, String> { body?.let { sent += it }; return 200 to "{}" }
        }
        val m = CoachSetupModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), api)
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Column(Modifier.fillMaxSize().verticalScroll(androidx.compose.foundation.rememberScrollState())) { CoachSetupCard(m, Modifier) } } }
        rule.waitForIdle()
        // Not set up: the free Gemini key leads. Claude, then the model under More options.
        rule.onNodeWithText("My own Claude key").performClick()
        rule.onNodeWithText("More options").performClick()
        rule.onNodeWithText("Change").performScrollTo().performClick()
        rule.onAllNodesWithText("Claude Sonnet 5.5 · Best for the chat").onLast().performScrollTo().performClick()
        rule.onNodeWithText("Other: type a model name").performClick()
        rule.onAllNodes(androidx.compose.ui.test.hasSetTextAction()).onLast().performScrollTo()
        rule.onAllNodes(androidx.compose.ui.test.hasSetTextAction()).onLast().performTextInput("models/Claude-Opus-6 ")
        rule.waitForIdle()
        save("settings-coach-model-other")
        // Saved on its own, a moment after the last change (no Save button).
        rule.mainClock.advanceTimeBy(1500)
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(2))
        rule.waitForIdle()
        assertEquals("claude-opus-6", org.json.JSONObject(sent.last()).optString("model"))
    }

    @Test fun settingsMoreAll() = extrasShot("settings-more-all", "more", scroll = 1600)

    /** The face builder's list, out of the way under More → Advanced; a face opens the builder. */
    @Test fun advancedFaceBuilder() {
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined)
        val went = mutableListOf<String>()
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Column(Modifier.fillMaxSize().verticalScroll(androidx.compose.foundation.rememberScrollState()).padding(16.dp)) { AdvancedCard(MoreModel(scope, extrasApi), Modifier, WatchGroupModel(scope, extrasApi)) { went += it } } } }
        rule.waitForIdle()
        rule.onNodeWithText("Watch face builder").performClick()
        rule.waitForIdle()
        save("settings-advanced-faces")
        rule.onNodeWithText("Night run").performClick()
        rule.onNodeWithText("Design a face").performClick()
        assertEquals(listOf("face/f1", "face/new"), went)
    }

    /** The step runner, under More → Advanced since 2.57 (no longer in Settings → Watch): Suunto's by default, Tartan's own to try. */
    @Test fun advancedRunner() {
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined)
        val set = mutableListOf<String>()
        val api = object : SettingsApi by extrasApi {
            override suspend fun rpc(name: String, args: org.json.JSONObject): String? {
                if (name == "runner" && args.has("set")) set += args.optString("set")
                return extrasApi.rpc(name, args)
            }
        }
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Column(Modifier.fillMaxSize().verticalScroll(androidx.compose.foundation.rememberScrollState()).padding(16.dp)) { AdvancedCard(MoreModel(scope, api), Modifier, WatchGroupModel(scope, api)) } } }
        rule.waitForIdle()
        rule.onNodeWithText("Step runner").performClick()
        rule.waitForIdle()
        save("settings-advanced-runner")
        rule.onNodeWithText("Tartan's own").performClick()
        rule.waitForIdle()
        assertEquals(listOf("tartan"), set)
    }

    /** No cloud key while the chat is on Model Hub: Tartan's rules plan, and a Gemini key can be added right there. */
    @Test fun coachPlannerNoKeyShot() {
        val st = org.json.JSONObject(fixture("coach-status.json"))
        st.put("provider", "modelhub")
        st.getJSONArray("providers").put(org.json.JSONObject("""{"id":"modelhub","label":"Model Hub on this phone","keyName":"","keyHelp":"","keySource":"Gemma-4-E2B-it","model":"model-hub","models":[]}"""))
        st.put("hub", org.json.JSONObject("""{"installed":true,"allowed":true,"model":"Gemma-4-E2B-it","context":4096}"""))
        st.put("planner", org.json.JSONObject("""{"choice":"auto","uses":"rules"}"""))
        val sent = mutableListOf<String>()
        val api = object : SettingsApi by extrasApi {
            override suspend fun get(path: String): String? = if (path == "/api/coach/status") st.toString() else extrasApi.get(path)
            // The key is asked of Google first (here: it works), then saved.
            override suspend fun send(path: String, method: String, body: String?): Pair<Int, String> =
                if (path == "/api/coach/check-key") 200 to """{"ok":true,"models":3}""" else { body?.let { sent += it }; 200 to "{}" }
        }
        val m = CoachSetupModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), api)
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Column(Modifier.fillMaxSize().verticalScroll(androidx.compose.foundation.rememberScrollState())) { CoachSetupCard(m, Modifier) } } }
        rule.waitForIdle()
        // Who plans is under More options.
        rule.onNodeWithText("More options").performClick()
        rule.waitForIdle()
        save("settings-coach-planner-nokey")
        rule.onAllNodes(androidx.compose.ui.test.hasSetTextAction()).onLast().performTextInput("AIzaSyTestTestTestTestTest123")
        rule.mainClock.advanceTimeBy(1500)
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(2))
        rule.waitForIdle()
        assertEquals("AIzaSyTestTestTestTestTest123", org.json.JSONObject(sent.last()).optString("googleKey"))
    }

    /** Model Hub's conversations: carried on one question on, and a prepared one for its first question. */
    @Test fun hubReuse() {
        val k = "system\u0000tools"
        // Opened for a question at 0: the next question (2) carries on; the same turns again don't.
        assert(dev.freesuunto.app.carriesOn(k, 0, false, k, 2, false))
        assert(!dev.freesuunto.app.carriesOn(k, 0, false, k, 0, false))
        // Prepared at 0 (the chat screen opened): its first question, at 0, carries on.
        assert(dev.freesuunto.app.carriesOn(k, 0, true, k, 0, false))
        // Preparing what's loaded (back on the chat after an answer) carries on and marks it.
        assert(dev.freesuunto.app.carriesOn(k, 0, false, k, 2, true))
        assert(dev.freesuunto.app.carriesOn(k, 2, false, k, 2, true))
        // Other instructions (a new day) or a different chat length: opened again.
        assert(!dev.freesuunto.app.carriesOn(k, 0, true, "other", 0, false))
        assert(!dev.freesuunto.app.carriesOn(k, 0, true, k, 4, false))
        assert(!dev.freesuunto.app.carriesOn(k, 0, true, k, -1, false))
    }

    /** Coach settings on Model Hub: ready with its model, and Tartan's old model file to remove (×). */
    @Test fun coachModelHubShot() {
        val st = org.json.JSONObject(fixture("coach-status.json"))
        st.put("provider", "modelhub")
        st.getJSONArray("providers").put(org.json.JSONObject("""{"id":"modelhub","label":"Model Hub on this phone","keyName":"","keyHelp":"","keySource":"Gemma-4-E2B-it","model":"model-hub","models":[]}"""))
        st.put("hub", org.json.JSONObject("""{"installed":true,"allowed":true,"model":"Gemma-4-E2B-it","context":4096,"vision":true,"backend":"Tensor TPU","firstMs":900,"tokensPerSecond":21.4,"update":"a newer file on Hugging Face (2.6 GB)","oldFile":{"name":"gemma-4-E2B-it_Google_Tensor_G5.litertlm","size":3953110901}}"""))
        st.put("planner", org.json.JSONObject("""{"choice":"auto","uses":"google","model":"Gemini 3.8 Flash"}"""))
        // A Gemini key: Gemini answers online, the phone offline (the switch to keep it on the phone).
        st.getJSONArray("providers").let { ps -> (0 until ps.length()).map { ps.getJSONObject(it) }.first { it.getString("id") == "google" }.put("keySource", "saved in Tartan") }
        st.put("answers", "Gemini 3.8 Flash; offline, Gemma 4 E2B on your phone")
        val api = object : SettingsApi by extrasApi {
            override suspend fun get(path: String): String? = if (path == "/api/coach/status") st.toString() else extrasApi.get(path)
        }
        val m = CoachSetupModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), api)
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Column(Modifier.fillMaxSize().verticalScroll(androidx.compose.foundation.rememberScrollState())) { CoachSetupCard(m, Modifier) } } }
        rule.waitForIdle()
        save("settings-coach-model-hub")
        java.util.Locale.setDefault(java.util.Locale.UK)
        assertEquals("Model Hub is installed. Allow Tartan to use its models.", parseHub(org.json.JSONObject("""{"installed":true,"allowed":false}"""))!!.line())
        val waiting = parseHub(org.json.JSONObject("""{"installed":true,"allowed":true,"model":"Gemma-4-E2B-it","notApproved":"Model Hub is waiting for you to approve Tartan."}"""))!!
        assertEquals("Approve Tartan in Model Hub. Model Hub is waiting for you to approve Tartan.", waiting.line())
        assert(!waiting.ready)
        assertEquals(
            "Ready: Gemma-4-E2B-it, reading up to 4,096 tokens at once. Running on the Tensor TPU. The last answer began after 0.9 s and came at about 21 tokens a second.",
            parseHub(st.getJSONObject("hub"))!!.line(),
        )
    }

    @Test fun shoeKinds() {
        assertEquals("racing", kindFromName("Metaspeed Sky Paris"))
        assertEquals("trail", kindFromName("Speedgoat 6"))
        assertEquals("daily", kindFromName("Novablast 5"))
        assertEquals(400, limitFor("racing"))
        val c = parseCoachSetup(fixture("coach-status.json"))
        assert(c.providers.isNotEmpty())
    }

    private val routesApi = object : SettingsApi {
        override suspend fun get(path: String): String? = when (path) {
            "/api/routes" -> """{"routes":[{"id":"r1","name":"Töölönlahti loop","distance_m":6420,"ascent_m":38,"loop":true,"watch":{"id":3},"preview":[[24.93,60.18],[24.94,60.185],[24.95,60.183],[24.945,60.176],[24.93,60.18]]},{"id":"r2","name":"Nuuksio trails","distance_m":14800,"ascent_m":212,"loop":false,"preview":[[24.5,60.3],[24.52,60.31],[24.55,60.305],[24.57,60.32]]}],"home":[24.94,60.17]}"""
            else -> null
        }
        override suspend fun send(path: String, method: String, body: String?) = 200 to "{}"
        override suspend fun rpc(name: String, args: org.json.JSONObject): String? = when (name) {
            "routeHeights" -> org.json.JSONArray().apply { val n = args.getJSONArray("line").length(); for (i in 0 until n) put(20.0 + i * 5) }.toString()
            else -> null
        }
    }

    @Test fun routesList() {
        val m = RoutesModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), routesApi)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize()) {
                    RoutesScreen(m, object : RoutesActions { override fun go(hash: String) {} })
                    Chrome(folded = true)
                    FloatingBar("activities", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        save("routes-list")
        assertEquals(2, m.routes!!.size)
    }

    @Test fun editsARoute() = kotlinx.coroutines.runBlocking {
        val e = RouteEditor(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), routesApi, "new", 0)
        e.mode = "straight"
        e.add(24.93 to 60.18); e.add(24.94 to 60.18); e.add(24.94 to 60.19)
        assertEquals(3, e.wp.size); assertEquals(2, e.segs.size)
        assert(e.total in 1500.0..1700.0) { "${e.total}" }
        e.outAndBack()
        assertEquals(5, e.wp.size); assertEquals(4, e.segs.size)
        assertEquals(e.wp.first(), e.wp.last())
        e.undo()
        assertEquals(3, e.wp.size)
        e.reverse()
        assertEquals(24.94 to 60.19, e.wp.first())
        e.remove(1)
        assertEquals(2, e.wp.size); assertEquals(1, e.segs.size)
        kotlinx.coroutines.delay(700)
        assertEquals(e.line.size, e.elevation?.size)
        assertEquals(0 to 0, climb(listOf(10.0, 11.0, 12.0, 11.0)))
        assertEquals(10 to 4, climb(listOf(10.0, 20.0, 16.0)))
        assert(!e.mayLeave() && e.mayLeave()) { "asks once" }
    }

    private val recordApi = object : SettingsApi {
        override suspend fun get(path: String): String? = when (path) {
            "/api/recordings" -> """[{"id":"rec-1","name":"Morning run","start":"2026-10-27T06:10:00Z","end":"2026-10-27T06:52:00Z","distance_m":8120,"moving_s":2460,"strava":{"status":"done"}},{"id":"rec-2","name":"Run","start":"2026-10-25T17:00:00Z","end":"2026-10-25T17:31:00Z","distance_m":5030,"moving_s":1820}]"""
            else -> null
        }
        override suspend fun send(path: String, method: String, body: String?) = 200 to "{}"
        override suspend fun rpc(name: String, args: org.json.JSONObject): String? = if (name == "recCues") "true" else "true"
    }

    @Test fun recordRunning() {
        val m = RecordModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), recordApi)
        val start = java.time.Instant.now().minusSeconds(1800)
        m.rec = parseRec("""{"status":"recording","start":"$start","end":null,"pauses":[{"from":${start.toEpochMilli() + 600_000},"to":${start.toEpochMilli() + 660_000}}],"name":null,"summary":{"distance_m":5230,"moving_s":1740,"elevation_m":42,"avg_hr":148},"accuracy":6,"gpsError":null,"hr":{"name":"Polar H10","bpm":152},"now":3.1}""")
        assertEquals(1740L, m.rec!!.moving(start.toEpochMilli() + 1_800_000))
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize()) {
                    RecordScreen(m, back = {})
                    FloatingBar("today", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(1500)
        save("record-running")
        assertEquals(true, m.cues)
        assertEquals(2, m.past!!.size)
    }

    /** Record with today's session to guide: the switch before the run, the step card during it. */
    private val guidedApi = object : SettingsApi by recordApi {
        var lapped = false
        override suspend fun rpc(name: String, args: org.json.JSONObject): String? = when (name) {
            "recGuide" -> """{"on":true,"session":{"name":"Tue 6 x 800 m","steps":14,"first":"Warm up · 15:00 · 130–145 bpm"}}"""
            "recLap" -> { lapped = true; "true" }
            else -> recordApi.rpc(name, args)
        }
        override suspend fun call(name: String, args: org.json.JSONObject): Result<String> = rpc(name, args)?.let { Result.success(it) } ?: Result.failure(Exception("It didn't go through."))
    }

    @Test fun recordGuided() {
        val m = RecordModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), guidedApi)
        val start = java.time.Instant.now().minusSeconds(1500)
        m.rec = parseRec("""{"status":"recording","start":"$start","end":null,"pauses":[],"name":null,"summary":{"distance_m":4410,"moving_s":1500,"elevation_m":12,"avg_hr":151},"accuracy":5,"gpsError":null,"hr":{"name":"Polar H10","bpm":171},"now":4.3,"guide":{"name":"Tue 6 x 800 m","index":5,"total":14,"label":"Rep 3 of 6","detail":"800 m · 3:50–4:00 /km","kind":"run","left_m":420,"share":0.475,"next":"Recover · 1:30 · easy","done":false}}""")
        assertEquals("420 m left", m.rec!!.guide!!.left)
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { RecordScreen(m, back = {}) } }
        rule.mainClock.advanceTimeBy(1500)
        rule.onNodeWithText("Rep 3 of 6").assertExists()
        rule.onNodeWithText("Then: Recover · 1:30 · easy").assertExists()
        save("record-guided")
        rule.onNodeWithText("Next step").performClick()
        rule.mainClock.advanceTimeBy(500)
        assertEquals(true, guidedApi.lapped)
    }

    @Test fun recordIdleGuided() {
        val m = RecordModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), guidedApi)
        m.rec = parseRec("""{"status":"idle","start":null,"end":null,"pauses":[],"name":null,"summary":null,"accuracy":null,"gpsError":null,"hr":null,"now":0}""")
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { RecordScreen(m, back = {}) } }
        rule.mainClock.advanceTimeBy(1500)
        rule.onNodeWithText("Guide me through 6 x 800 m").assertExists()
        save("record-idle-guided")
    }

    @Test fun recordIdle() {
        val m = RecordModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), recordApi)
        m.rec = parseRec("""{"status":"idle","start":null,"end":null,"pauses":[],"name":null,"summary":null,"accuracy":null,"gpsError":null,"hr":null,"now":0}""")
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { RecordScreen(m, back = {}) } }
        rule.mainClock.advanceTimeBy(1500)
        save("record-idle")
    }

    private val liftPut = mutableListOf<String>()
    private val liftApi = object : SettingsApi {
        override suspend fun get(path: String): String? = when {
            path.startsWith("/api/lifts/session") -> """{"date":"2026-10-28","title":"Strength: legs and core","planned":true,"log":null,"targets":[{"id":"squat","name":"Squat","sets":3,"reps":10,"kg":40,"loaded":true,"rule":"add","why":"All sets done with 2 in reserve last time.","last":{"text":"3 × 10 at 37.5 kg","date":"2026-10-21"},"rest_s":120},{"id":"glute_bridge","name":"Glute bridge","sets":3,"reps":12,"loaded":false,"rule":"start","why":"New this block.","rest_s":60},{"id":"calf_raise","name":"Calf raise","sets":2,"seconds":40,"each_side":true,"loaded":false,"rule":"","why":"","rest_s":45}]}"""
            path.startsWith("/api/lifts/from-watch") -> "null"
            else -> null
        }
        override suspend fun send(path: String, method: String, body: String?): Pair<Int, String> {
            liftPut.add(body ?: "")
            return 200 to """{"summary":{"minutes":34,"sets":8,"volume_kg":1260,"prs":[{"name":"Squat","text":"3 × 10 at 40 kg","before":"37.5 kg"}],"next":[{"name":"Squat","last":"40 kg","next":"42.5 kg","why":"Every set done"}]}}"""
        }
        override suspend fun rpc(name: String, args: org.json.JSONObject): String? = if (name == "exercises") fixture("exercises.json") else null
    }

    @Test fun liftSession() = kotlinx.coroutines.runBlocking {
        val m = LiftModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), liftApi, "2026-10-28")
        m.load().join()
        assertEquals(3, m.exercises.size)
        assertEquals(40.0, m.exercises[0].sets[0].kg)
        m.tick(0, 0)
        assert(m.started != null && m.restEnd > 0) { "a ticked set starts the rest" }
        assertEquals("Then set 2", m.restNext)
        m.setValue(0, 1, kg = 42.5)
        assertEquals(42.5, m.exercises[0].sets[1].kg)
        m.addSet(1)
        assertEquals(4, m.exercises[1].sets.size)
        kotlinx.coroutines.delay(700)
        assert(liftPut.size == 1 && org.json.JSONObject(liftPut[0]).getJSONArray("exercises").length() == 3) { "saved once, debounced" }
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize()) {
                    LiftScreen(m, back = {}, done = {})
                    FloatingBar("today", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(1500)
        save("lift-session")
        assert(m.finish())
        assertEquals(1, m.summary!!.prs.size)
        assert(m.finishedAt != null)
    }

    private val faceSaves = mutableListOf<String>()
    private val faceApi = object : SettingsApi {
        override suspend fun get(path: String): String? = null
        override suspend fun send(path: String, method: String, body: String?) = 204 to ""
        override suspend fun rpc(name: String, args: org.json.JSONObject): String? = when (name) {
            "faceStart" -> fixture("face-start.json")
            "faceSave" -> { faceSaves.add(args.toString()); args.getJSONObject("design").put("id", "2099000001").toString() }
            else -> null
        }
    }

    @Test fun faceBuilder() = kotlinx.coroutines.runBlocking {
        var saved = 0
        val m = FaceModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), faceApi, "copy") { saved++ }
        m.load().join()
        assertEquals("My Tartan Track", m.d!!.optString("name"))
        assertEquals(5, m.presets.size)
        m.edit { put("hands", "sword") }
        m.part = "s0"; m.setColour("#a3c6ff")
        assertEquals("#a3c6ff", m.d!!.getJSONArray("seconds").getString(0))
        m.part = "track"; m.setColour("#1f5c3a")
        m.replace(m.presets[1].design)
        assertEquals("My Tartan Track", m.d!!.optString("name"))
        assertEquals("2099000001", m.d!!.optString("id"))
        assert(!m.mayLeave() && m.mayLeave()) { "asks once" }
        m.save()?.join()
        assertEquals(1, saved); assert(m.saved && !m.dirty)
        assertEquals(false, org.json.JSONObject(faceSaves[0]).getBoolean("saved"))
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize()) {
                    FaceBuilderScreen(m, back = {}, go = { _, _ -> })
                    Chrome(folded = true)
                    FloatingBar("settings", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(1500)
        save("face-builder")
    }

    private fun introShot(name: String, step: Int) {
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined)
        val calls = mutableListOf<String>()
        val api = object : SettingsApi {
            override suspend fun get(path: String) = null
            override suspend fun send(path: String, method: String, body: String?) = 200 to "{}"
            override suspend fun rpc(name: String, args: org.json.JSONObject): String? { calls.add(name); return "true" }
        }
        val m = IntroModel(scope, api, step)
        val settings = settingsModel().also { it.ensure() }
        val src = SourcesModel(scope, sourcesApi)
        val extras = SettingsExtras(coachSetup = CoachSetupModel(scope, extrasApi), more = MoreModel(scope, extrasApi), sources = src)
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { IntroBody(m, settings, src, extras) } }
        rule.mainClock.advanceTimeBy(3000)
        save(name)
        if (step == 0) {
            m.go(1); assertEquals(1, m.step); m.back(); assertEquals(0, m.step)
            m.open("pc"); assertEquals("pc", m.page); m.back(); assertEquals("steps", m.page)
            m.done(false); assert(m.leaving)
            assert("introStep" in calls && "introDone" in calls)
        }
    }

    @Test fun introWelcome() = introShot("intro-welcome", 0)
    @Test fun introTimes() = introShot("intro-times", 3)
    @Test fun introPlaces() = introShot("intro-places", 4)
    @Test fun introSources() = introShot("intro-sources", 1)

    @Test fun pageSnack() {
        var acted = -1
        var shown by androidx.compose.runtime.mutableStateOf<PageSnack?>(PageSnack(7, "Strava sync failed: the connection was reset.", true, "Try again", null))
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize()) {
                    TodayScreen(today, refreshing = false, actions = none, date = day)
                    PageSnackbar(shown, { acted = it }, { shown = null }, Modifier.align(Alignment.BottomCenter).padding(bottom = 80.dp))
                    FloatingBar("today", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(1500)
        save("page-snack")
        rule.onNodeWithText("Try again").performClick()
        rule.mainClock.advanceTimeBy(500)
        assertEquals(7, acted)
        assertEquals(null, shown)
    }

    @Test fun boardSheet() {
        var synced = ""
        val lanes = listOf(
            Lane("watch", "fail", "!", "warn", "Watch", "The watch didn't answer. Bring it closer and try again. · 12 min ago", true),
            Lane("strava", "ok", "5m", "strava", "Strava", "Synced 5 min ago", false),
        )
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Box(Modifier.fillMaxSize()) { BoardBody(lanes, { synced = it }, {}, Modifier.padding(top = 48.dp)) } } }
        rule.mainClock.advanceTimeBy(1000)
        save("board-sheet")
        rule.onNodeWithText("Try again").performClick()
        assertEquals("watch", synced)
    }

    private val noPlanJson = """{"plan":null,"weeks":[],"today":"2026-10-28","availability":{"days_per_week":4,"long_run_day":"Sun"},"goals":{"race":{"name":"Helsinki Half","distance_km":21.1,"date":"2027-03-14"}},"coach_ready":false,"recent":{"days":28,"workouts":14,"runs":12,"run_km_per_week":31.4,"hours_per_week":3.6,"longest_run_km":16.2}}"""

    private fun noPlanShot(name: String, ready: Boolean) {
        val coach = parseCoach(noPlanJson, """{"ready":$ready}""", null)
        assertEquals(null, coach.plan); assertEquals(4, coach.intake!!.days); assertEquals("2027-03-14", coach.intake!!.raceDate)
        val posted = mutableListOf<String>()
        val actions = object : CoachActions {
            override fun openSession(date: String, kind: String) {}
            override fun openActivity(id: String) {}
            override fun chat(conversation: String?, prefill: String?) {}
            override fun go(hash: String) {}
            override fun dismissWeekly(week: String) {}
            override suspend fun post(path: String, body: String?): String? = null
            override suspend fun send(path: String, method: String, body: String?): Pair<Int, String> { posted.add("$method $path $body"); return 200 to "{}" }
            override suspend fun stream(path: String, body: String, onLine: (String) -> Unit): Int {
                posted.add("STREAM $path $body")
                listOf("""{"type":"conversation","id":"c1"}""", """{"type":"tool","label":"Reading your last 4 weeks"}""", """{"type":"tool","label":"Checking how ready you are"}""", """{"type":"text","delta":"Here's a **12-week** build to your half."}""", """{"type":"plan"}""").forEach(onLine)
                return 200
            }
        }
        val maker = PlanMaker(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), actions)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            TartanTheme(wallpaper = false, dark = false) {
                Box(Modifier.fillMaxSize()) {
                    CoachScreen(coach, actions, maker = maker)
                    Chrome(folded = true)
                    FloatingBar("coach", hidden = false, onSelect = {}, modifier = Modifier.align(Alignment.BottomCenter))
                }
            }
        }
        rule.mainClock.advanceTimeBy(2500)
        save(name)
        if (ready) {
            maker.make("2027-03-14", org.json.JSONObject().put("days_per_week", 4), true)
            assertEquals("saved", maker.outcome); assertEquals(2, maker.steps.size)
            assert(posted[0].startsWith("PUT /api/plan/availability") && posted[1].startsWith("STREAM /api/plan/update")) { posted.toString() }
            rule.mainClock.advanceTimeBy(1500)
            save("$name-made")
        } else {
            maker.make(null, org.json.JSONObject(), false)
            assert(posted.any { it.startsWith("POST /api/plan/basic") }) { posted.toString() }
        }
    }

    @Test fun coachNoPlan() = noPlanShot("coach-noplan", false)
    @Test fun coachNoPlanAi() = noPlanShot("coach-noplan-ai", true)

    @Test fun pairSheet() = kotlinx.coroutines.runBlocking {
        val calls = mutableListOf<String>()
        val api = object : SettingsApi {
            override suspend fun get(path: String) = null
            override suspend fun send(path: String, method: String, body: String?) = 200 to "{}"
            override suspend fun rpc(name: String, args: org.json.JSONObject): String? { calls.add(name); return when (name) {
                "pairCheck" -> """{"home":["http://192.168.1.20:5173"],"replacing":true,"current":"Old PC"}"""
                "pairConnect" -> """{"url":"http://192.168.1.20:5173","name":"Desk PC"}"""
                "pairSync" -> """{"pulled":412,"pushed":3,"merged":0,"changed":true,"line":"Up to date: 412 from your PC, 3 to your PC."}"""
                else -> "true"
            } }
        }
        val m = PairModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), api, listOf("http://192.168.1.20:5173", "http://10.0.0.5:5173"), "K7QM3XPA9R", false)
        m.start().join()
        assertEquals("ask", m.phase); assertEquals("Old PC", m.replacing)
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { Box(Modifier.fillMaxSize()) { PairBody(m, {}, Modifier.padding(top = 48.dp)) } } }
        rule.mainClock.advanceTimeBy(800)
        save("pair-ask")
        m.connect()
        assertEquals("done", m.phase); assert(m.reopen); assertEquals("Desk PC", m.name)
        rule.mainClock.advanceTimeBy(800)
        save("pair-done")
        m.finish {}
        assertEquals(listOf("pairCheck", "pairConnect", "pairSync", "reopen"), calls)
    }

    private fun flowShot(name: String, draw: @androidx.compose.runtime.Composable (SourcesModel) -> Unit, setup: (SourcesModel) -> Unit) {
        val src = SourcesModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), sourcesApi)
        setup(src)
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { draw(src) } }
        rule.mainClock.advanceTimeBy(1500)
        save(name)
    }

    @Test fun stravaFlowIntro() = flowShot("strava-flow-0", { StravaFlow(it, window = false, start = 0) {} }) { it.strava = StravaNow(false, false, null, "", null, false, 0, 0, false) }
    @Test fun stravaFlowForm() = flowShot("strava-flow-1", { StravaFlow(it, window = false, start = 1) {} }) { it.strava = StravaNow(false, false, null, "", null, false, 0, 0, false) }
    @Test fun stravaFlowKeys() = flowShot("strava-flow-2", { StravaFlow(it, window = false, start = 2) {} }) { it.strava = StravaNow(false, false, null, "", null, false, 0, 0, false) }
    @Test fun stravaFlowDone() = flowShot("strava-flow-4", { StravaFlow(it, window = false, start = 4) {} }) { it.strava = StravaNow(true, true, "123456", "Sanna", null, true, 412, 120, false) }
    @Test fun watchFlowReady() = flowShot("watch-flow-0", { WatchFlow(it, window = false, start = 0) {} }) { it.watch = parseWatch("""{"connected":false,"connecting":false,"name":"","canBluetooth":true}""") }
    @Test fun watchFlowLooking() = flowShot("watch-flow-1", { WatchFlow(it, window = false, start = 1) {} }) { it.watch = parseWatch("""{"connected":false,"connecting":true,"name":"","canBluetooth":true}""") }
    @Test fun watchFlowBackup() = flowShot("watch-flow-2", { WatchFlow(it, window = false, start = 2) {} }) { it.watch = parseWatch("""{"connected":true,"connecting":false,"name":"Suunto Run 2","canBluetooth":true,"running":true,"facts":[["Battery","84%"],["Firmware","2.31.20"]],"job":{"title":"Backing up the watch","text":"14 of 37 files · 2.1 MB","value":14,"max":37}}""") }

    @Test fun brandMotion() {
        var done = false
        rule.mainClock.autoAdvance = false
        rule.setContent { TartanTheme(wallpaper = false, dark = false) { BrandIntro { done = true } } }
        rule.mainClock.advanceTimeBy(700); save("brand-1")
        rule.mainClock.advanceTimeBy(900); save("brand-2")
        rule.mainClock.advanceTimeBy(1000); save("brand-3")
        rule.mainClock.advanceTimeBy(2000)
        assert(done) { "hands over to the intro" }
    }
}
