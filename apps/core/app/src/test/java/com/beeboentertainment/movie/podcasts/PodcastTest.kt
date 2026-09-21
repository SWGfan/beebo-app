package com.beeboentertainment.movie.podcasts

import com.beeboentertainment.movie.audiobooks.AudiobookLogic
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.server.FakeServer
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val J = ApiClient.JSON
private const val SHOW = "0123456789ab"
private const val EP = "0123456789ab.0123456789abcdef"

private fun ep(
    key: String = EP, played: Boolean = false, progress: Double = 0.0, duration: Double = 3600.0,
    stream: String = "/api/podcasts/episode/$key/stream", queued: Boolean = false, downloaded: Boolean = false,
) = EpisodeDto(key = key, feedId = SHOW, title = "T", durationSec = duration, played = played, progressSec = progress, stream = stream, inQueue = queued, downloaded = downloaded)

class PodcastLogicTest {

    @Test fun `ids and feed addresses are validated before they go anywhere`() {
        assertTrue(PodcastLogic.isEpisodeKey(EP))
        assertFalse(PodcastLogic.isEpisodeKey("nope"))
        assertFalse(PodcastLogic.isEpisodeKey("../x"))
        assertTrue(PodcastLogic.isShowId(SHOW))
        assertFalse(PodcastLogic.isShowId(EP))
        assertEquals("https://feeds.example.com/show.xml", PodcastLogic.feedAddressOrNull(" https://feeds.example.com/show.xml "))
        assertNull(PodcastLogic.feedAddressOrNull("ftp://feeds.example.com/a"))
        assertNull(PodcastLogic.feedAddressOrNull("https://user:pw@example.com/feed"))
        assertNull(PodcastLogic.feedAddressOrNull("https://exa mple.com/feed"))
        assertNull(PodcastLogic.feedAddressOrNull("javascript:alert(1)"))
        assertNull(PodcastLogic.feedAddressOrNull("a"))
    }

    @Test fun `an episode resumes where you were, restarts when played, and skips the last seconds`() {
        assertEquals(1200.0, PodcastLogic.resumeSec(ep(progress = 1200.0)), 0.0)
        assertEquals(0.0, PodcastLogic.resumeSec(ep(progress = 1200.0, played = true)), 0.0)
        assertEquals(0.0, PodcastLogic.resumeSec(ep(progress = 3.0, duration = 3600.0)), 0.0)
        assertEquals(0.0, PodcastLogic.resumeSec(ep(progress = 3595.0, duration = 3600.0)), 0.0)
        assertEquals(0.0, PodcastLogic.resumeSec(ep(progress = Double.NaN)), 0.0)
    }

    @Test fun `a show's own speed beats the podcast-wide speed, and both are clamped`() {
        val prefs = PodcastPrefs(speed = 1.5, speedByFeed = mapOf(SHOW to 2.0, "other0000000" to 9.0))
        assertEquals(2.0, PodcastLogic.speedFor(prefs, SHOW), 0.0)
        assertEquals(1.5, PodcastLogic.speedFor(prefs, "ffffffffffff"), 0.0)
        assertEquals(3.0, PodcastLogic.speedFor(prefs, "other0000000"), 0.0)
        assertEquals(1.0, PodcastLogic.speedFor(PodcastPrefs(speed = 0.0), SHOW), 0.0)
    }

    @Test fun `episode subtitle shows date, length and progress`() {
        // 2024-03-04 12:00 UTC
        val at = 1709553600000L
        assertEquals("Mar 4, 2024 · 1 h 0 min", PodcastLogic.subtitle(ep().copy(publishedAt = at)))
        assertEquals("Mar 4, 2024 · 1 h 0 min · 30 min left", PodcastLogic.subtitle(ep(progress = 1800.0).copy(publishedAt = at)))
        assertEquals("1 h 0 min · Played", PodcastLogic.subtitle(ep(played = true)))
        assertEquals("", PodcastLogic.subtitle(ep(duration = 0.0)))
        assertEquals("under a minute", PodcastLogic.lengthLabel(30.0))
        assertEquals("45 min", PodcastLogic.lengthLabel(2700.0))
    }

    @Test fun `title carries season and episode and is cleaned`() {
        assertEquals("S2E5 · Hello", PodcastLogic.title(ep().copy(title = "Hello", season = 2, episode = 5)))
        assertEquals("E7 · Hello", PodcastLogic.title(ep().copy(title = "Hello", episode = 7)))
        assertEquals("Untitled episode", PodcastLogic.title(ep().copy(title = "  ")))
        assertEquals("A B", PodcastLogic.title(ep().copy(title = "A‮B")))
    }

    @Test fun `download wording follows the state`() {
        assertEquals("Streams from the show", PodcastLogic.downloadLabel(ep(), null))
        assertEquals("Kept on your computer", PodcastLogic.downloadLabel(ep(downloaded = true), null))
        assertEquals("Kept on your computer (5 MB)", PodcastLogic.downloadLabel(ep(), DownloadInfo(downloaded = true, size = 5_300_000, status = "downloaded")))
        assertEquals("Copying to your computer…", PodcastLogic.downloadLabel(ep(), DownloadInfo(status = "downloading")))
        assertEquals("The copy failed: no_space", PodcastLogic.downloadLabel(ep(), DownloadInfo(status = "failed", error = "no_space")))
        assertTrue(PodcastLogic.canDownload(ep(), null))
        assertFalse(PodcastLogic.canDownload(ep(downloaded = true), null))
        assertFalse(PodcastLogic.canDownload(ep(), DownloadInfo(status = "queued")))
    }

    @Test fun `what plays after an episode is the rest of the queue without repeats or played ones`() {
        val a = ep("aaaaaaaaaaaa.aaaaaaaaaaaaaaaa"); val b = ep("bbbbbbbbbbbb.bbbbbbbbbbbbbbbb"); val c = ep("cccccccccccc.cccccccccccccccc", played = true)
        val d = ep("dddddddddddd.dddddddddddddddd"); val noAudio = ep("eeeeeeeeeeee.eeeeeeeeeeeeeeee", stream = "")
        assertEquals(listOf(b.key, d.key), PodcastLogic.upNext(a.key, listOf(a, b, c, d, noAudio, b)).map { it.key })
        assertEquals(listOf(a.key, b.key), PodcastLogic.upNext("zzzzzzzzzzzz.zzzzzzzzzzzzzzzz", listOf(a, b)).map { it.key })
        assertTrue(PodcastLogic.upNext(d.key, listOf(a, b, c, d)).isEmpty())
    }

    @Test fun `only podcast stream paths on this server are played`() {
        assertEquals("/api/podcasts/episode/$EP/stream", PodcastLogic.streamPath(ep()))
        assertNull(PodcastLogic.streamPath(ep(stream = "https://evil.example/api/podcasts/episode/$EP/stream")))
        assertNull(PodcastLogic.streamPath(ep(stream = "/api/music/track/x/stream")))
        assertNull(PodcastLogic.streamPath(ep(stream = "/api/podcasts/episode/../../x")))
    }

    @Test fun `show notes are plain text, never markup`() {
        val e = ep().copy(notesHtml = "<p>Hi <a href=\"https://x.example\">there</a></p><script>bad()</script><img src=x onerror=1>")
        val t = PodcastLogic.notes(e)
        assertEquals("Hi there", t)
        assertEquals("Fallback", PodcastLogic.notes(ep().copy(notesHtml = "", summary = "Fallback")))
    }

    @Test fun `chapters hide the hidden ones, sort, and name the blank ones`() {
        val c = PodcastLogic.chapters(listOf(ChapterItem(60.0, null, "Two"), ChapterItem(0.0, 60.0, "One"), ChapterItem(30.0, null, "Secret", hidden = true), ChapterItem(120.0, null, "")))
        assertEquals(listOf("One", "Two", "Chapter 3"), c.map { it.title })
        assertEquals(0, AudiobookLogic.chapterIndexAt(c, 10.0))
    }

    @Test fun `sleep at the end of an episode needs a known length`() {
        assertEquals(3600.0, PodcastLogic.sleepAtEpisodeEnd(3600.0)!!.endPosSec, 0.0)
        assertNull(PodcastLogic.sleepAtEpisodeEnd(0.0))
        val t = PodcastLogic.sleepAtEpisodeEnd(100.0)!!
        assertTrue(AudiobookLogic.sleepStatus(t, 0, 100.0).done)
    }

    @Test fun `followed show labels`() {
        assertEquals("3 new", PodcastLogic.unplayedLabel(ShowDto(unplayed = 3)))
        assertEquals("Up to date", PodcastLogic.unplayedLabel(ShowDto()))
        assertEquals("Loading episodes…", PodcastLogic.unplayedLabel(ShowDto(pending = true)))
        assertEquals("Couldn't be refreshed", PodcastLogic.unplayedLabel(ShowDto(error = "network_error")))
    }
}

class PodcastModelsTest {
    @Test fun `a show answer decodes`() {
        val r = J.decodeFromString(
            ShowResponse.serializer(),
            """{"ok":true,"feed":{"id":"$SHOW","title":"A Show","author":"Me","image":"https://cdn.example/a.jpg","episodeCount":2,"unplayed":1,"subscribed":true,"autoDownload":0,"categories":["x"]},
               "total":2,"offset":0,"episodes":[{"key":"$EP","feedId":"$SHOW","feedTitle":"A Show","id":"e1","title":"One","publishedAt":1709553600000,"durationSec":1800,"summary":"s","image":"","season":null,"episode":null,"episodeType":"full","explicit":false,"sizeBytes":100,"link":"","downloaded":true,"downloadPinned":true,"hasSilenceVariant":false,"played":false,"progressSec":12.5,"inQueue":true,"hasChapters":true,"stream":"/api/podcasts/episode/$EP/stream"}]}"""
        )
        assertEquals("A Show", r.feed.title)
        val e = r.episodes.single()
        assertNull(e.season)
        assertTrue(e.downloaded && e.inQueue && e.hasChapters)
        assertEquals(12.5, e.progressSec, 0.0)
    }

    @Test fun `search, chapters, download and prefs answers decode`() {
        val s = J.decodeFromString(PodcastSearchResponse.serializer(), """{"ok":true,"results":[{"title":"T","author":"A","feedUrl":"https://f.example/x","artwork":null,"genre":"News","episodeCount":null,"feedId":"$SHOW","subscribed":false}]}""")
        assertNull(s.results.single().artwork)
        val c = J.decodeFromString(ChaptersResponse.serializer(), """{"ok":true,"source":"json","chapters":[{"start":0,"end":60,"title":"Intro","img":"","url":"","hidden":false}]}""")
        assertEquals(1, c.chapters.size)
        val d = J.decodeFromString(DownloadResponse.serializer(), """{"ok":true,"download":{"downloaded":false,"pinned":false,"size":0,"status":"downloading","error":"","silence":{"ready":false,"status":"none","error":""}}}""")
        assertEquals("downloading", d.download.status)
        val p = J.decodeFromString(PodcastPrefsResponse.serializer(), """{"ok":true,"prefs":{"speed":1.25,"skipSilence":true,"speedByFeed":{"$SHOW":2}}}""")
        assertEquals(2.0, p.prefs.speedByFeed[SHOW]!!, 0.0)
    }
}

class PodcastClientTest {
    @Test fun `following sends the feed address in a post and reads the show back`() = runBlocking {
        val fake = FakeServer { 201 to """{"ok":true,"show":{"id":"$SHOW","title":"X","subscribed":true}}""" }
        val show = PodcastClient(fake.json()).follow("https://feeds.example/x.xml").show
        assertEquals(SHOW, show.id)
        assertEquals("POST /api/podcasts/subscriptions", fake.requests.single().method + " " + fake.requests.single().url.encodedPath)
        assertEquals("""{"url":"https://feeds.example/x.xml"}""", fake.bodies.single())
    }

    @Test fun `queue, progress and played use the documented routes and bodies`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"episodes":[],"played":false,"progressSec":0}""" }
        val c = PodcastClient(fake.json())
        c.queueAdd(EP, next = true)
        c.queueAdd(EP, next = false)
        c.queueRemove(EP)
        c.saveProgress(EP, 12.5, 1800.0)
        c.markPlayed(EP, true)
        assertEquals(
            listOf(
                "POST /api/podcasts/queue", "POST /api/podcasts/queue", "DELETE /api/podcasts/queue/$EP",
                "POST /api/podcasts/episode/$EP/progress", "POST /api/podcasts/episode/$EP/played",
            ),
            fake.requests.map { it.method + " " + it.url.encodedPath }
        )
        assertEquals("""{"episode":"$EP","next":true}""", fake.bodies[0])
        assertEquals("""{"episode":"$EP"}""", fake.bodies[1])
        assertEquals("""{"position":12.5,"duration":1800.0}""", fake.bodies[3])
        assertEquals("""{"played":true}""", fake.bodies[4])
    }

    @Test fun `a per-show speed and a general speed are different bodies`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"prefs":{}}""" }
        val c = PodcastClient(fake.json())
        c.setSpeed(1.5)
        c.setSpeed(2.0, feedId = SHOW)
        assertEquals("""{"speed":1.5}""", fake.bodies[0])
        assertEquals("""{"feedId":"$SHOW","feedSpeed":2.0}""", fake.bodies[1])
    }

    @Test fun `show pages ask for unplayed only when told`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"feed":{},"episodes":[]}""" }
        val c = PodcastClient(fake.json())
        c.show(SHOW, unplayedOnly = true, offset = 60, limit = 30)
        val u = fake.requests.single().url
        assertEquals("1", u.queryParameter("unplayed"))
        assertEquals("60", u.queryParameter("offset"))
        assertEquals("30", u.queryParameter("limit"))
    }

    @Test fun `an older computer answering 404 is a clear error`() = runBlocking {
        val fake = FakeServer { 404 to """{"ok":false,"error":"not_found"}""" }
        try { PodcastClient(fake.json()).status(); org.junit.Assert.fail() } catch (e: com.beeboentertainment.movie.server.ServerException) {
            assertTrue(e.isNotFound)
        }
    }
}
