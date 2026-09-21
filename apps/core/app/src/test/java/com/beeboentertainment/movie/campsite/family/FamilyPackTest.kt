package com.beeboentertainment.movie.campsite.family

import com.beeboentertainment.movie.campsite.CampsiteServer
import com.beeboentertainment.movie.campsite.quiet.QuietView
import com.beeboentertainment.movie.campsite.tripclock.ClockStop
import com.beeboentertainment.movie.campsite.tripclock.KidUnit
import com.beeboentertainment.movie.campsite.tripclock.TripClockLogic
import com.beeboentertainment.movie.campsite.tripclock.TripClockState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.util.TimeZone

class FamilyPackTest {

    private fun quiet(active: Boolean, headphones: Boolean = false, startsInMs: Long = -1L) = QuietView(
        enabled = true, active = active, headphones = headphones, changeAtMs = 0L,
        endText = if (active) "6:00 AM" else "", startsInMs = startsInMs, windowText = "10:00 PM to 6:00 AM",
    )

    private fun clockView(stopTitle: String = "Snack"): com.beeboentertainment.movie.campsite.tripclock.TripClockView {
        val now = 1_000_000_000L
        val state = TripClockLogic.start(now, now + 120 * 60_000L, 0, KidUnit.EPISODES, 30).copy(
            stops = listOf(ClockStop("s", stopTitle, now + 30 * 60_000L)),
        )
        return TripClockLogic.view(state, now + 60 * 60_000L, TimeZone.getTimeZone("UTC"))
    }

    // ---- the status JSON --------------------------------------------------------------------------

    @Test
    fun `the status carries the banner text and the clock only to a phone that joined`() {
        val pack = FamilyPackA(quiet = { quiet(true) }, clock = { clockView() })
        val guest = Json.parseToJsonElement(pack.statusJson(joined = true)).jsonObject
        val q = guest.getValue("quiet").jsonObject
        assertTrue(q.getValue("active").jsonPrimitive.content.toBoolean())
        assertEquals("Quiet hours until 6:00 AM. Please keep the sound down.", q.getValue("banner").jsonPrimitive.content)
        assertEquals("Check your campground's posted quiet hours.", q.getValue("note").jsonPrimitive.content)
        val c = guest.getValue("clock").jsonObject
        assertEquals("1 hour", c.getValue("left").jsonPrimitive.content)
        assertEquals("about 3 episodes", c.getValue("kid").jsonPrimitive.content)
        assertEquals("Estimate only. Use your navigation app for directions.", c.getValue("disclaimer").jsonPrimitive.content)
        assertEquals("Snack", c.getValue("stops").jsonArray[0].jsonObject.getValue("title").jsonPrimitive.content)

        val stranger = Json.parseToJsonElement(pack.statusJson(joined = false)).jsonObject
        assertEquals(JsonNull, stranger.getValue("clock"))
        assertTrue("the banner still shows on the landing page", stranger.getValue("quiet").jsonObject.getValue("banner").jsonPrimitive.content.isNotEmpty())
    }

    @Test
    fun `the warning shows only in the fifteen minutes before quiet hours`() {
        fun warn(startsIn: Long) = Json.parseToJsonElement(FamilyPackA(quiet = { quiet(false, startsInMs = startsIn) }, clock = null).statusJson(true))
            .jsonObject.getValue("quiet").jsonObject.getValue("warn").jsonPrimitive.content
        assertEquals("", warn(-1))
        assertEquals("", warn(16 * 60_000L))
        assertEquals("Quiet hours start in 12 min. Please start winding down.", warn(12 * 60_000L))
    }

    @Test
    fun `with nothing configured the status is empty and never fails`() {
        val json = Json.parseToJsonElement(FamilyPackA.NONE.statusJson(joined = true)).jsonObject
        assertEquals(JsonNull, json.getValue("quiet"))
        assertEquals(JsonNull, json.getValue("clock"))
        val stopped = FamilyPackA(quiet = null, clock = { com.beeboentertainment.movie.campsite.tripclock.TripClockLogic.view(TripClockState(), 0L, TimeZone.getTimeZone("UTC")) })
        assertEquals(JsonNull, Json.parseToJsonElement(stopped.statusJson(true)).jsonObject.getValue("clock"))
    }

    @Test
    fun `a host typed stop name travels as JSON data and no location is in the status`() {
        val evil = "<img src=x onerror=alert(1)>\"</script>"
        val text = FamilyPackA(quiet = null, clock = { clockView(evil) }).statusJson(true)
        val back = Json.parseToJsonElement(text).jsonObject.getValue("clock").jsonObject.getValue("stops").jsonArray[0].jsonObject.getValue("title").jsonPrimitive.content
        assertTrue(back.contains("<img"))
        listOf("\"lat\"", "\"lng\"", "latitude", "longitude", "gps").forEach { assertFalse(it, text.lowercase().contains(it)) }
    }

    // ---- the banner -----------------------------------------------------------------------------------

    @Test
    fun `the banner is added to a page once, after the body opens and before it closes`() {
        val page = "<!doctype html><html><head><title>x</title></head><body class=\"a\"><main>hi</main></body></html>"
        val out = FamilyBanner.inject(page)
        assertTrue(out.indexOf("<body class=\"a\">") < out.indexOf("id=\"beebo-quiet\""))
        assertTrue(out.indexOf("id=\"beebo-quiet\"") < out.indexOf("<main>"))
        assertTrue(out.indexOf("/api/family") < out.lastIndexOf("</body>"))
        assertEquals("added once, not twice", out, FamilyBanner.inject(out))
        assertEquals("not a page, left alone", "plain text", FamilyBanner.inject("plain text"))
        assertEquals("no body tag, left alone", "<p>fragment</p>", FamilyBanner.inject("<p>fragment</p>"))
    }

    @Test
    fun `the banner script polls about every four seconds, writes text only and sends nothing`() {
        val js = FamilyBanner.SCRIPT
        assertTrue(js.contains("setInterval(poll,4000)"))
        assertTrue(js.contains("textContent"))
        listOf("innerHTML", "outerHTML", "eval(", "document.write", "method:", "POST", "localStorage", "sendBeacon").forEach {
            assertFalse(it, js.contains(it))
        }
        assertTrue(FamilyBanner.DIV.contains("role=\"status\""))
        assertFalse("a poll no longer than five seconds", Regex("""setInterval\(poll,(\d+)\)""").find(js)!!.groupValues[1].toInt() > 5000)
    }

    // ---- through the real HTTP server ----------------------------------------------------------------------

    private fun open(server: CampsiteServer, path: String, cookie: String? = null, method: String = "GET"): HttpURLConnection =
        (URL("http://127.0.0.1:${server.boundPort}$path").openConnection() as HttpURLConnection).apply {
            connectTimeout = 3000; readTimeout = 3000; instanceFollowRedirects = false; requestMethod = method
            if (cookie != null) setRequestProperty("Cookie", cookie)
        }

    private fun join(server: CampsiteServer, name: String): String {
        val c = open(server, "/join?name=$name&next=clock")
        try {
            assertEquals(302, c.responseCode)
            assertEquals("/clock", c.getHeaderField("Location"))
            return c.headerFields.entries.filter { it.key.equals("Set-Cookie", true) }.flatMap { it.value }.joinToString("; ") { it.substringBefore(';') }
        } finally { c.disconnect() }
    }

    @Test
    fun `the server serves the status, the clock page and a banner on every page`() {
        val server = CampsiteServer(0, { emptyList() }, { null }, gamesPage = { "<html><body><p>games</p></body></html>" })
        server.family = FamilyPackA(quiet = { quiet(true, headphones = true) }, clock = { clockView() })
        server.start()
        try {
            // The clock page needs a joined phone.
            val anon = open(server, "/clock")
            try { assertEquals(302, anon.responseCode); assertEquals("/join?next=clock", anon.getHeaderField("Location")) } finally { anon.disconnect() }
            val cookie = join(server, "Kit")

            val page = open(server, "/clock", cookie)
            try {
                assertEquals(200, page.responseCode)
                val html = page.inputStream.bufferedReader().readText()
                assertTrue(html.contains("Are we there yet?"))
                assertTrue(html.contains("Estimate only. Use your navigation app for directions."))
                assertTrue("the banner is on this page too", html.contains("id=\"beebo-quiet\""))
            } finally { page.disconnect() }

            // Every other HTML page carries the banner without being edited.
            val games = open(server, "/games", cookie)
            try { assertTrue(games.inputStream.bufferedReader().readText().contains("id=\"beebo-quiet\"")) } finally { games.disconnect() }
            val landing = open(server, "/")
            try { assertTrue(landing.inputStream.bufferedReader().readText().contains("id=\"beebo-quiet\"")) } finally { landing.disconnect() }

            // The status: the clock only for a joined phone; the headphones-only banner for everybody.
            val joined = open(server, "/api/family", cookie)
            val joinedJson = try { assertEquals(200, joined.responseCode); Json.parseToJsonElement(joined.inputStream.bufferedReader().readText()).jsonObject } finally { joined.disconnect() }
            assertEquals("Quiet hours until 6:00 AM. Headphones only, please.", joinedJson.getValue("quiet").jsonObject.getValue("banner").jsonPrimitive.content)
            assertEquals("about 3 episodes", joinedJson.getValue("clock").jsonObject.getValue("kid").jsonPrimitive.content)
            val stranger = open(server, "/api/family")
            val strangerJson = try { Json.parseToJsonElement(stranger.inputStream.bufferedReader().readText()).jsonObject } finally { stranger.disconnect() }
            assertEquals(JsonNull, strangerJson.getValue("clock"))
            assertEquals("no-store", (open(server, "/api/family").also { it.responseCode }).getHeaderField("Cache-Control"))

            // GET only.
            val post = open(server, "/api/family", cookie, "POST")
            try { assertEquals(405, post.responseCode) } finally { post.disconnect() }
        } finally { server.stop() }
    }

    @Test
    fun `a server with no family features still answers`() {
        val server = CampsiteServer(0, { emptyList() }, { null })
        server.start()
        try {
            val c = open(server, "/api/family")
            try {
                assertEquals(200, c.responseCode)
                val json = Json.parseToJsonElement(c.inputStream.bufferedReader().readText()).jsonObject
                assertEquals(JsonNull, json.getValue("quiet"))
            } finally { c.disconnect() }
        } finally { server.stop() }
    }
}
