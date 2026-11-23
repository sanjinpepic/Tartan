package dev.freesuunto.app.shell

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What the phone sends Tartan's Garmin watch app (GarminMessage), from the engine's plan for it
 * (src/workout/garmin.ts), and that the watch's brand decides the way: a Suunto never touches
 * Garmin, a Garmin never Suunto's Bluetooth.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class GarminTest {
    /** The engine's answer for a week: an interval session today (written out step by step) and an easy run tomorrow. */
    private val engine = """{"key":"2026-11-23-abc","message":{"v":1,"made":"2026-11-23","days":[
        {"date":"2026-11-23","title":"Intervals","sport":"running","sum":"3 x 800 m","steps":[
          {"k":"warmup","l":"Warm up","t":900,"h":[120,140]},
          {"k":"run","l":"Rep 1 of 3","d":800,"p":[230,240]},{"k":"recover","l":"Recover","t":90},
          {"k":"run","l":"Rep 2 of 3","d":800,"p":[230,240]},{"k":"recover","l":"Recover","t":90},
          {"k":"run","l":"Rep 3 of 3","d":800,"p":[230,240]},{"k":"recover","l":"Recover","t":90},
          {"k":"cooldown","l":"Cool down","t":600}]},
        {"date":"2026-11-24","title":"Easy Run","sport":"running","sum":"45 min","steps":[{"k":"run","l":"Run","t":2700,"h":[135,148],"n":"Drink: A few sips"}]}]}}"""

    @Test fun theMessageFromASession() {
        val (key, m) = GarminMessage.fromEngine(engine)!!
        assertEquals("2026-11-23-abc", key)
        assertEquals(1, m["v"])
        assertEquals("2026-11-23", m["made"])
        val days = m["days"] as List<*>
        assertEquals(2, days.size)
        val today = days[0] as Map<*, *>
        assertEquals("Intervals", today["title"])
        assertEquals("running", today["sport"])
        assertEquals("3 x 800 m", today["sum"])
        val steps = today["steps"] as List<*>
        assertEquals(8, steps.size)
        val rep = steps[1] as Map<*, *>
        assertEquals("Rep 1 of 3", rep["l"])
        // Whole numbers go as Integers (what the watch compares with its Numbers), ranges as lists.
        assertTrue(rep["d"] is Int)
        assertEquals(800, rep["d"])
        assertEquals(listOf(230, 240), rep["p"])
        assertTrue((rep["p"] as List<*>).all { it is Int })
        assertNull(rep["t"])
        assertEquals(listOf(120, 140), (steps[0] as Map<*, *>)["h"])
        assertEquals("Drink: A few sips", (((days[1] as Map<*, *>)["steps"] as List<*>)[0] as Map<*, *>)["n"])
        assertEquals("Intervals" to "2026-11-23", GarminMessage.firstTitle(m))
    }

    @Test fun aBigWeekLosesItsLastDaysNotToday() {
        val m = JSONObject(engine).getJSONObject("message")
        val small = GarminMessage.build(m, maxChars = 400)
        assertEquals(1, (small["days"] as List<*>).size)
        assertEquals("2026-11-23", ((small["days"] as List<*>)[0] as Map<*, *>)["date"])
        assertEquals(2, (GarminMessage.build(m)["days"] as List<*>).size)
    }

    @Test fun nothingToSend() {
        assertNull(GarminMessage.fromEngine(null))
        assertNull(GarminMessage.fromEngine("null"))
        assertNull(GarminMessage.fromEngine("{\"key\":\"x\"}"))
    }

    @Test fun theWatchAsking() {
        assertTrue(GarminMessage.asksForPlan(mapOf("t" to "want", "v" to 1)))
        assertFalse(GarminMessage.asksForPlan(mapOf("t" to "other")))
        assertFalse(GarminMessage.asksForPlan("want"))
    }

    @Test fun theBrandIsTheSwitch() {
        assertTrue(GarminMessage.goesToGarmin("garmin"))
        assertFalse(GarminMessage.goesToGarmin("suunto"))
        assertFalse(GarminMessage.goesToGarmin(null))
    }

    /** The page and Garmin's side, recorded: which RPCs ran, and what was asked of Garmin. */
    private class Fake(private val found: String?) : SettingsApi {
        val calls = mutableListOf<String>()
        override suspend fun get(path: String): String? = null
        override suspend fun send(path: String, method: String, body: String?) = 200 to "{}"
        override suspend fun rpc(name: String, args: JSONObject): String? {
            calls += name
            return when (name) {
                "watchFind" -> """{"found":${found ?: "null"},"nearby":1}"""
                else -> "true"
            }
        }
    }
    private class FakeGarmin(private val known: List<GarminDevice>?) : GarminApi {
        val did = mutableListOf<String>()
        override suspend fun known(): List<GarminDevice>? { did += "known"; return known }
        override suspend fun use(d: GarminDevice): GarminNow { did += "use ${d.id}"; return GarminNow(d.name, "ok", true, null, null, null, null) }
        override suspend fun now(): GarminNow? = null
        override suspend fun sendNow(): GarminNow? { did += "send"; return null }
        override fun forget() { did += "forget" }
        override fun getWatchApp() {}
        override fun getGarminConnect() {}
    }

    @Test fun aSuuntoNeverGoesTheGarminWay() {
        val api = Fake("""{"brand":"suunto","name":"Suunto Run 2","id":"AA:BB","via":"nearby"}""")
        val g = FakeGarmin(emptyList())
        val s = SourcesModel(CoroutineScope(Dispatchers.Unconfined), api, g)
        s.find()
        assertEquals("suunto", s.finding)
        assertTrue("connects the Suunto", "watchConnect" in api.calls)
        assertFalse("no Garmin brand set", "watchBrand" in api.calls)
        assertFalse("nothing sent to a Garmin", g.did.any { it.startsWith("use") || it == "send" })
        assertTrue("Garmin forgotten", "forget" in g.did)
    }

    @Test fun aGarminNeverGoesTheSuuntoWay() {
        val api = Fake("""{"brand":"garmin","name":"Forerunner 265","id":"42","via":"garmin-connect"}""")
        val g = FakeGarmin(listOf(GarminDevice(42, "Forerunner 265", true)))
        val s = SourcesModel(CoroutineScope(Dispatchers.Unconfined), api, g)
        s.find()
        assertEquals("garmin", s.finding)
        assertFalse("no Suunto connection", "watchConnect" in api.calls)
        assertTrue("the brand set", "watchBrand" in api.calls)
        assertTrue("the plan goes to the Garmin", "use 42" in g.did)
    }

    @Test fun aGarminWithoutGarminConnectSaysSo() {
        val api = Fake("""{"brand":"garmin","name":"Forerunner 265","id":"CC:DD","via":"nearby"}""")
        val s = SourcesModel(CoroutineScope(Dispatchers.Unconfined), api, FakeGarmin(null))
        s.find()
        assertEquals("garmin-missing", s.finding)
        assertFalse("watchConnect" in api.calls)
        assertFalse("watchBrand" in api.calls)
        // Garmin Connect there but not knowing the watch: pair it there first.
        val s2 = SourcesModel(CoroutineScope(Dispatchers.Unconfined), api, FakeGarmin(emptyList()))
        s2.find()
        assertEquals("garmin-pair", s2.finding)
    }
}
