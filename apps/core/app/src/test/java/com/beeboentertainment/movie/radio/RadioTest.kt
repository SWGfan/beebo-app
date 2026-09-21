package com.beeboentertainment.movie.radio

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.server.FakeServer
import com.beeboentertainment.movie.server.ServerException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val J = ApiClient.JSON
private const val RB = "rb:12345678-1234-1234-1234-123456789abc"
private const val SESSION = "0123456789abcdef"

class RadioLogicTest {

    @Test fun `station and session ids are validated`() {
        assertTrue(RadioLogic.isStationId(RB))
        assertTrue(RadioLogic.isStationId("c:0123456789ab"))
        assertFalse(RadioLogic.isStationId("rb:short"))
        assertFalse(RadioLogic.isStationId("../etc"))
        assertTrue(RadioLogic.isSessionId(SESSION))
        assertFalse(RadioLogic.isSessionId("xyz"))
    }

    @Test fun `station line has country, up to three tags and bitrate, all cleaned`() {
        val s = Station(id = RB, name = "Jazz‮ FM", country = "France", tags = listOf("jazz", "smooth", "lounge", "extra"), bitrate = 128)
        assertEquals("France · jazz, smooth, lounge · 128 kbps", RadioLogic.subtitle(s))
        assertEquals("Jazz FM", RadioLogic.name(s))
        assertEquals("Unnamed station", RadioLogic.name(Station(name = " ")))
        assertEquals("", RadioLogic.subtitle(Station()))
    }

    @Test fun `now playing line prefers artist and title, then the raw line`() {
        fun session(np: NowPlaying?) = RadioSession(id = SESSION, nowPlaying = np)
        assertEquals("Miles Davis - So What", RadioLogic.nowPlayingLine(session(NowPlaying("Miles Davis - So What", "Miles Davis", "So What"))))
        assertEquals("Just A Title", RadioLogic.nowPlayingLine(session(NowPlaying("Just A Title", "", "Just A Title"))))
        assertEquals("Raw Line", RadioLogic.nowPlayingLine(session(NowPlaying("Raw Line", "", ""))))
        assertNull(RadioLogic.nowPlayingLine(session(null)))
        assertNull(RadioLogic.nowPlayingLine(null))
        assertEquals("A B - C", RadioLogic.nowPlayingLine(session(NowPlaying("x", "A‮B", "C"))))
    }

    @Test fun `state wording`() {
        assertEquals("Live", RadioLogic.stateLabel("live"))
        assertEquals("Connecting…", RadioLogic.stateLabel("connecting"))
        assertEquals("Reconnecting…", RadioLogic.stateLabel("reconnecting"))
        assertEquals("This station isn't answering (http_404)", RadioLogic.stateLabel("failed", "http_404"))
        assertEquals("", RadioLogic.stateLabel("something new"))
    }

    @Test fun `polling is quick while connecting and relaxed once live`() {
        assertTrue(RadioLogic.pollDelayMs("connecting") < RadioLogic.pollDelayMs("live"))
        assertTrue(RadioLogic.pollDelayMs("live") <= RadioLogic.pollDelayMs("closed"))
    }

    @Test fun `only the relay of this very session is played`() {
        assertEquals("/api/radio/session/$SESSION/stream", RadioLogic.streamPath(RadioSession(id = SESSION, stream = "/api/radio/session/$SESSION/stream")))
        assertNull(RadioLogic.streamPath(RadioSession(id = SESSION, stream = "http://stream.example/live.mp3")))
        assertNull(RadioLogic.streamPath(RadioSession(id = SESSION, stream = "//stream.example/live.mp3")))
        assertNull(RadioLogic.streamPath(RadioSession(id = "bad", stream = "/api/radio/session/bad/stream")))
        assertNull(RadioLogic.streamPath(RadioSession(id = SESSION, stream = "/api/podcasts/episode/x/stream")))
    }

    @Test fun `a station address the person types must be a plain web address`() {
        assertEquals("https://radio.example/live", RadioLogic.stationAddressOrNull(" https://radio.example/live "))
        assertEquals("http://192.168.1.5:8000/stream", RadioLogic.stationAddressOrNull("http://192.168.1.5:8000/stream"))
        assertNull(RadioLogic.stationAddressOrNull("file:///etc/passwd"))
        assertNull(RadioLogic.stationAddressOrNull("https://u:p@radio.example/live"))
        assertNull(RadioLogic.stationAddressOrNull("radio.example/live"))
        assertNull(RadioLogic.stationAddressOrNull("https://a b.example"))
    }

    @Test fun `favourites are found by id`() {
        val favs = listOf(Station(id = RB), Station(id = "c:0123456789ab"))
        assertTrue(RadioLogic.isFavourite(favs, RB))
        assertFalse(RadioLogic.isFavourite(favs, "c:ffffffffffff"))
    }

    @Test fun `refusals read in plain words`() {
        assertTrue(RadioLogic.refusal("not_audio", null).contains("audio"))
        assertEquals("That station isn't available right now.", RadioLogic.refusal("http_404", null))
        assertEquals("Server said so.", RadioLogic.refusal("weird", "Server said so."))
    }
}

class RadioModelsTest {
    @Test fun `a browse answer decodes and the station's own stream address is not kept`() {
        val r = J.decodeFromString(
            StationsResponse.serializer(),
            """{"ok":true,"stations":[{"id":"$RB","name":"N","url":"http://secret-stream.example/live","homepage":"https://n.example","favicon":"https://n.example/a.png","tags":["a","b"],"country":"UK","countryCode":"GB","language":"english","codec":"MP3","bitrate":128,"votes":12,"source":"radio-browser"}]}"""
        )
        val s = r.stations.single()
        assertEquals(128, s.bitrate)
        assertEquals(listOf("a", "b"), s.tags)
        assertFalse("Station has no url field", Station::class.java.declaredFields.any { it.name == "url" })
    }

    @Test fun `a session answer decodes with now playing and history`() {
        val r = J.decodeFromString(
            PlayResponse.serializer(),
            """{"ok":true,"session":{"id":"$SESSION","station":{"id":"$RB","name":"N","favicon":"","homepage":"","source":"radio-browser"},"state":"live","error":"",
               "nowPlaying":{"raw":"A - B","artist":"A","title":"B","at":5},"history":[{"raw":"C - D","artist":"C","title":"D","at":1}],
               "info":{"name":"N","genre":"jazz","bitrate":128,"contentType":"audio/mpeg","hasMetadata":true},"reconnects":0,"listeners":1,"startedAt":9,
               "recording":{"active":false},"stream":"/api/radio/session/$SESSION/stream"}}"""
        )
        assertEquals("live", r.session.state)
        assertEquals("A", r.session.nowPlaying!!.artist)
        assertEquals(1, r.session.history.size)
        assertTrue(r.session.info.hasMetadata)
    }
}

class RadioClientTest {
    @Test fun `browse asks with a name or a tag, ordered by votes`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"stations":[]}""" }
        RadioClient(fake.json()).browse(name = "jazz", tag = null)
        val u = fake.requests.single().url
        assertEquals("/api/radio/browse", u.encodedPath)
        assertEquals("jazz", u.queryParameter("name"))
        assertNull(u.queryParameter("tag"))
        assertEquals("votes", u.queryParameter("order"))
        assertEquals("60", u.queryParameter("limit"))
    }

    @Test fun `playing a station posts its id and favourites encode the colon`() = runBlocking {
        val fake = FakeServer { req ->
            if (req.url.encodedPath == "/api/radio/play") 201 to """{"ok":true,"session":{"id":"$SESSION","stream":"/api/radio/session/$SESSION/stream"}}"""
            else 200 to """{"ok":true,"favorites":[]}"""
        }
        val c = RadioClient(fake.json())
        val s = c.play(RB).session
        assertEquals(SESSION, s.id)
        c.removeFavourite(RB)
        c.addFavourite(Station(id = RB, name = "N"))
        assertEquals("""{"stationId":"$RB"}""", fake.bodies[0])
        assertEquals("DELETE /api/radio/favorites/rb%3A12345678-1234-1234-1234-123456789abc", fake.requests[1].method + " " + fake.requests[1].url.encodedPath)
        assertEquals("""{"id":"$RB"}""", fake.bodies[2])
    }

    @Test fun `a station that cannot be reached surfaces the server's reason`() = runBlocking {
        val fake = FakeServer { 502 to """{"ok":false,"error":"http_404"}""" }
        try { RadioClient(fake.json()).play(RB); org.junit.Assert.fail() } catch (e: ServerException) {
            assertEquals("http_404", e.code)
            assertEquals("That station isn't available right now.", RadioLogic.refusal(e.code, e.message))
        }
    }

    @Test fun `stopping releases the relay with a delete and custom stations use the documented body`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"custom":[],"station":null}""" }
        val c = RadioClient(fake.json())
        c.stop(SESSION)
        c.addCustom("Mine", "https://radio.example/live")
        assertEquals("DELETE /api/radio/session/$SESSION", fake.requests[0].method + " " + fake.requests[0].url.encodedPath)
        assertEquals("""{"name":"Mine","url":"https://radio.example/live"}""", fake.bodies[1])
    }
}
