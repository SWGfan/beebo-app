package com.beeboentertainment.movie.livetv

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.server.FakeServer
import com.beeboentertainment.movie.server.ServerException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.TimeZone

private val J = ApiClient.JSON
private val UTC = TimeZone.getTimeZone("UTC")
private const val MIN = 60_000L

private fun ch(key: String, number: String, name: String = "N$number", fav: Boolean = false, hidden: Boolean = false) =
    LiveChannel(key = key, number = number, name = name, favourite = fav, hidden = hidden)

class LiveTvLogicTest {

    @Test fun `channel numbers sort numerically with sub-channels`() {
        assertEquals(2 to 0, LiveTvLogic.numberKey("2"))
        assertEquals(7 to 1, LiveTvLogic.numberKey("7.1"))
        assertEquals(Int.MAX_VALUE to 0, LiveTvLogic.numberKey("abc"))
        val ordered = LiveTvLogic.order(listOf(ch("a", "10"), ch("b", "2"), ch("c", "7.10"), ch("d", "7.2")))
        assertEquals(listOf("b", "d", "c", "a"), ordered.map { it.key })
    }

    @Test fun `favourites come first and hidden channels never show`() {
        val list = listOf(ch("a", "1"), ch("b", "5", fav = true), ch("c", "3", hidden = true), ch("d", "2"))
        assertEquals(listOf("b", "a", "d"), LiveTvLogic.order(list).map { it.key })
        assertEquals(listOf("a", "d", "b"), LiveTvLogic.order(list, favouritesFirst = false).map { it.key })
        assertEquals(listOf("b"), LiveTvLogic.favouritesOnly(list).map { it.key })
        assertTrue(LiveTvLogic.order(listOf(ch("", "1"))).isEmpty())
    }

    @Test fun `channel up and down wrap round`() {
        val list = LiveTvLogic.order(listOf(ch("a", "1"), ch("b", "2"), ch("c", "3")))
        assertEquals("b", LiveTvLogic.neighbour(list, "a", 1)!!.key)
        assertEquals("c", LiveTvLogic.neighbour(list, "a", -1)!!.key)
        assertEquals("a", LiveTvLogic.neighbour(list, "c", 1)!!.key)
        assertEquals("a", LiveTvLogic.neighbour(list, "gone", 1)!!.key)
        assertNull(LiveTvLogic.neighbour(emptyList(), "a", 1))
    }

    @Test fun `favouriting updates just that channel`() {
        val out = LiveTvLogic.withFavourite(listOf(ch("a", "1"), ch("b", "2")), "b", true)
        assertEquals(listOf(false, true), out.map { it.favourite })
    }

    @Test fun `channel names are cleaned and fall back to the number`() {
        assertEquals("BBC ONE", LiveTvLogic.channelName(ch("a", "1", name = "BBC‮ ONE")))
        assertEquals("Channel 12", LiveTvLogic.channelName(ch("a", "12", name = " ")))
    }

    @Test fun `clock formats are fixed and zone aware`() {
        val t = 1709553600000L // 2024-03-04 12:00 UTC
        assertEquals("12:00 PM", LiveTvLogic.clock(t, UTC))
        assertEquals("12:30 AM", LiveTvLogic.clock(t + 12 * 60 * MIN + 30 * MIN, UTC))
        assertEquals("8:30 PM", LiveTvLogic.clock(t + 8 * 60 * MIN + 30 * MIN, UTC))
        assertEquals("20:30", LiveTvLogic.clock(t + 8 * 60 * MIN + 30 * MIN, UTC, twentyFourHour = true))
        assertEquals("7:00 AM", LiveTvLogic.clock(t, TimeZone.getTimeZone("GMT-5")))
        assertEquals("", LiveTvLogic.clock(0, UTC))
    }

    @Test fun `now and next lines`() {
        val t = 1709553600000L
        val c = LiveChannel(key = "k", number = "5", name = "Five",
            now = Programme("The News", "", t, t + 30 * MIN), next = Programme("Weather‮", "", t + 30 * MIN, t + 45 * MIN))
        assertEquals("The News · until 12:30 PM", LiveTvLogic.nowLine(c, UTC))
        assertEquals("Next: Weather at 12:30 PM", LiveTvLogic.nextLine(c, UTC))
        assertNull(LiveTvLogic.nowLine(ch("a", "1"), UTC))
        assertNull(LiveTvLogic.nextLine(c.copy(next = Programme(title = " ")), UTC))
    }

    @Test fun `progress through a programme`() {
        val p = Programme("x", "", 1000, 3000)
        assertEquals(0f, LiveTvLogic.progress(p, 500), 0f)
        assertEquals(0.5f, LiveTvLogic.progress(p, 2000), 0.0001f)
        assertEquals(1f, LiveTvLogic.progress(p, 9000), 0f)
        assertEquals(0f, LiveTvLogic.progress(null, 9000), 0f)
        assertEquals(0f, LiveTvLogic.progress(Programme("x", "", 5, 5), 9), 0f)
    }

    @Test fun `title line adds the episode title`() {
        assertEquals("Show - Pilot", LiveTvLogic.titleLine("Show", "Pilot"))
        assertEquals("Show", LiveTvLogic.titleLine("Show", " "))
        assertEquals("Untitled", LiveTvLogic.titleLine(" ", ""))
    }

    private fun prog(startMin: Long, stopMin: Long, title: String = "P") = GuideProgramme(start = startMin * MIN, stop = stopMin * MIN, title = title)

    @Test fun `guide cells are clipped to the window and marked when they continue`() {
        val from = 0L; val to = 180 * MIN
        val cells = LiveTvLogic.cells(listOf(prog(-30, 30, "A"), prog(30, 90, "B"), prog(150, 240, "C"), prog(300, 400, "Out")), from, to)
        assertEquals(listOf("A", "B", "C"), cells.map { it.programme.title })
        assertEquals(0f, cells[0].offsetMin, 0f); assertEquals(30f, cells[0].lengthMin, 0f)
        assertTrue(cells[0].cutOffLeft); assertFalse(cells[0].cutOffRight)
        assertEquals(30f, cells[1].offsetMin, 0f); assertEquals(60f, cells[1].lengthMin, 0f)
        assertEquals(150f, cells[2].offsetMin, 0f); assertEquals(30f, cells[2].lengthMin, 0f)
        assertTrue(cells[2].cutOffRight)
    }

    @Test fun `overlapping or backwards programmes never sit on top of each other`() {
        val cells = LiveTvLogic.cells(listOf(prog(0, 60, "A"), prog(30, 90, "B"), prog(100, 100, "Zero"), prog(120, 110, "Back")), 0, 180 * MIN)
        assertEquals(listOf("A", "B"), cells.map { it.programme.title })
        assertEquals(60f, cells[1].offsetMin, 0f)
        assertEquals(30f, cells[1].lengthMin, 0f)
        assertTrue(LiveTvLogic.cells(listOf(prog(0, 60)), 100, 100).isEmpty())
    }

    @Test fun `guide time marks are every half hour`() {
        val marks = LiveTvLogic.timeMarks(1709553600000L, 1709553600000L + 90 * MIN, UTC)
        assertEquals(listOf(0f to "12:00 PM", 30f to "12:30 PM", 60f to "1:00 PM"), marks)
        assertEquals(45f, LiveTvLogic.nowOffsetMin(0, 180 * MIN, 45 * MIN)!!, 0f)
        assertNull(LiveTvLogic.nowOffsetMin(0, 180 * MIN, 999 * MIN))
    }

    @Test fun `busy tuner and not-allowed messages`() {
        assertEquals("All 2 tuners are busy right now.", LiveTvLogic.message("tuners_busy", "All 2 tuners are busy right now."))
        assertTrue(LiveTvLogic.message("tuners_busy", null).contains("tuner"))
        assertTrue(LiveTvLogic.message("restricted_profile", null).contains("parental controls"))
        assertTrue(LiveTvLogic.message("not_available_to_guests", null).contains("other households"))
        assertTrue(LiveTvLogic.message("off", null).contains("turned off"))
        assertTrue(LiveTvLogic.message("tuner_timeout", null).contains("tuner"))
        assertEquals("Server said.", LiveTvLogic.message("odd", "Server said."))
        assertTrue(LiveTvLogic.isNotAllowed("restricted_profile"))
        assertTrue(LiveTvLogic.isNotAllowed("not_available_to_guests"))
        assertFalse(LiveTvLogic.isNotAllowed("tuners_busy"))
    }

    @Test fun `only a live hls path on this server is played`() {
        assertEquals("/livetv/hls/abc.def/index.m3u8", LiveTvLogic.playlistPath(WatchResponse(url = "/livetv/hls/abc.def/index.m3u8")))
        assertNull(LiveTvLogic.playlistPath(WatchResponse(url = "http://192.168.1.50:5004/auto/v5")))
        assertNull(LiveTvLogic.playlistPath(WatchResponse(url = "//evil.example/livetv/hls/x/index.m3u8")))
        assertNull(LiveTvLogic.playlistPath(WatchResponse(url = "/api/music/track/x/stream")))
        assertNull(LiveTvLogic.playlistPath(WatchResponse(url = "/livetv/hls/../admin")))
    }

    @Test fun `the live badge and go live follow the offset from the live edge`() {
        assertEquals("LIVE", LiveTvLogic.liveBadge(null))
        assertEquals("LIVE", LiveTvLogic.liveBadge(3_000))
        assertTrue(LiveTvLogic.isAtLive(null))
        assertTrue(LiveTvLogic.isAtLive(5_000))
        assertFalse(LiveTvLogic.isAtLive(8_000))
        assertEquals("-2:30 behind live", LiveTvLogic.liveBadge(150_000))
        assertEquals("-1:05:00 behind live", LiveTvLogic.liveBadge(3_900_000))
        assertNull(LiveTvLogic.behindLiveSec(-5))
    }

    @Test fun `rewind window wording`() {
        assertEquals("up to 90 minutes", LiveTvLogic.rewindWindow(90))
        assertEquals("up to 2 h", LiveTvLogic.rewindWindow(120))
        assertEquals("", LiveTvLogic.rewindWindow(0))
    }

    @Test fun `remote keys map to channel and transport actions`() {
        assertEquals(LiveTvLogic.Key.PLAY_PAUSE, LiveTvLogic.keyFor(85))
        assertEquals(LiveTvLogic.Key.REWIND, LiveTvLogic.keyFor(89))
        assertEquals(LiveTvLogic.Key.FAST_FORWARD, LiveTvLogic.keyFor(90))
        assertEquals(LiveTvLogic.Key.CHANNEL_UP, LiveTvLogic.keyFor(166))
        assertEquals(LiveTvLogic.Key.CHANNEL_DOWN, LiveTvLogic.keyFor(167))
        assertEquals(LiveTvLogic.Key.GO_LIVE, LiveTvLogic.keyFor(87))
        assertEquals(LiveTvLogic.Key.NONE, LiveTvLogic.keyFor(4))
    }
}

class LiveTvModelsTest {
    @Test fun `a channels answer decodes including what's on now and next`() {
        val r = J.decodeFromString(
            ChannelsResponse.serializer(),
            """{"ok":true,"hasGuide":true,"drmHidden":2,"drmNote":"n","channels":[
                {"key":"hdhr:1234:5.1","number":"5.1","name":"Five","hd":true,"hidden":false,"favourite":true,
                 "now":{"title":"News","subTitle":"","start":1000,"stop":2000,"isNew":true},"next":null,"guide":true}]}"""
        )
        val c = r.channels.single()
        assertTrue(c.favourite && c.hd && c.guide)
        assertEquals("News", c.now!!.title)
        assertNull(c.next)
        assertEquals(2, r.drmHidden)
    }

    @Test fun `a guide answer decodes with rows and programmes`() {
        val g = J.decodeFromString(
            GuideResponse.serializer(),
            """{"ok":true,"from":0,"to":10800000,"hasGuide":true,"rows":[{"channel":"k","number":"5","name":"Five","favourite":false,
                "programmes":[{"start":0,"stop":1800000,"title":"A","subTitle":"s","isNew":false,"season":1,"episode":2,"categories":["News"]}]}]}"""
        )
        assertEquals(1, g.rows.single().programmes.size)
        assertEquals(2, g.rows.single().programmes.single().episode)
    }

    @Test fun `a watch answer decodes`() {
        val w = J.decodeFromString(
            WatchResponse.serializer(),
            """{"ok":true,"url":"/livetv/hls/T.T/index.m3u8","ticket":"T.T","mimeType":"application/x-mpegURL","live":true,"quality":"720p","encoder":"x264",
               "channel":{"key":"k","number":"5","name":"Five"},"timeshiftMinutes":90,"now":null}"""
        )
        assertEquals("T.T", w.ticket)
        assertEquals(90, w.timeshiftMinutes)
    }

    @Test fun `status decodes`() {
        val s = J.decodeFromString(LiveStatus.serializer(), """{"ok":true,"enabled":true,"devices":1,"channelCount":42,"drmHidden":0,"guide":{"hasGuide":true},"dvr":{},"isAdmin":false,"quality":"720p","timeshiftMinutes":90}""")
        assertTrue(s.enabled); assertEquals(42, s.channelCount)
    }
}

class LiveTvClientTest {
    @Test fun `favourite and watch use the documented routes and bodies`() = runBlocking {
        val fake = FakeServer { req ->
            if (req.url.encodedPath == "/api/livetv/watch") 200 to """{"ok":true,"url":"/livetv/hls/T/index.m3u8","ticket":"T","live":true,"channel":{"key":"k"}}"""
            else 200 to """{"ok":true,"favourite":true}"""
        }
        val c = LiveTvClient(fake.json())
        assertTrue(c.setFavourite("hdhr:1:5", true).favourite)
        assertEquals("T", c.watch("hdhr:1:5").ticket)
        c.stop("T")
        assertEquals(
            listOf("POST /api/livetv/favourite", "POST /api/livetv/watch", "POST /api/livetv/stop"),
            fake.requests.map { it.method + " " + it.url.encodedPath }
        )
        assertEquals("""{"channel":"hdhr:1:5","on":true}""", fake.bodies[0])
        assertEquals("""{"channel":"hdhr:1:5"}""", fake.bodies[1])
        assertEquals("""{"ticket":"T"}""", fake.bodies[2])
    }

    @Test fun `every tuner busy is a 503 the screen can explain`() = runBlocking {
        val fake = FakeServer { 503 to """{"ok":false,"error":"tuners_busy","message":"All 2 tuners are busy right now. Try again in a little while."}""" }
        try { LiveTvClient(fake.json()).watch("k"); org.junit.Assert.fail() } catch (e: ServerException) {
            assertEquals(503, e.status)
            assertEquals("tuners_busy", e.code)
            assertEquals("All 2 tuners are busy right now. Try again in a little while.", LiveTvLogic.message(e.code, e.message))
        }
    }

    @Test fun `a profile with parental controls is refused with its own code`() = runBlocking {
        val fake = FakeServer { 403 to """{"ok":false,"error":"restricted_profile","message":"Live TV is not available on profiles with parental controls."}""" }
        try { LiveTvClient(fake.json()).channels(); org.junit.Assert.fail() } catch (e: ServerException) {
            assertTrue(LiveTvLogic.isNotAllowed(e.code))
        }
    }

    @Test fun `the guide asks for hours and an optional start`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"rows":[]}""" }
        LiveTvClient(fake.json()).guide(hours = 6, fromMs = 12345)
        assertEquals("6", fake.requests.single().url.queryParameter("hours"))
        assertEquals("12345", fake.requests.single().url.queryParameter("from"))
    }
}
