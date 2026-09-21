package com.beeboentertainment.movie.audiobooks

import com.beeboentertainment.movie.audio.AudioKind
import com.beeboentertainment.movie.audio.AudioStreamRules
import com.beeboentertainment.movie.audio.SpokenTimeline
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.server.FakeServer
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val J = ApiClient.JSON

class SpokenTimelineTest {
    private val parts = listOf(
        SpokenTimeline.Part(0, 0.0, 3600.0),
        SpokenTimeline.Part(1, 3600.0, 3600.0),
        SpokenTimeline.Part(2, 7200.0, 1800.0),
    )

    @Test fun `locate finds the part and the offset in it`() {
        assertEquals(SpokenTimeline.Located(0, 0.0), SpokenTimeline.locate(parts, 0.0))
        assertEquals(SpokenTimeline.Located(0, 3599.0), SpokenTimeline.locate(parts, 3599.0))
        assertEquals(SpokenTimeline.Located(1, 0.0), SpokenTimeline.locate(parts, 3600.0))
        assertEquals(SpokenTimeline.Located(2, 100.0), SpokenTimeline.locate(parts, 7300.0))
    }

    @Test fun `locate parks past the end at the end of the last part and copes with junk`() {
        assertEquals(SpokenTimeline.Located(2, 1800.0), SpokenTimeline.locate(parts, 99999.0))
        assertEquals(SpokenTimeline.Located(0, 0.0), SpokenTimeline.locate(parts, -5.0))
        assertEquals(SpokenTimeline.Located(0, 0.0), SpokenTimeline.locate(parts, Double.NaN))
        assertEquals(SpokenTimeline.Located(0, 0.0), SpokenTimeline.locate(emptyList(), 50.0))
    }

    @Test fun `book position adds the part start`() {
        assertEquals(3700.0, SpokenTimeline.bookPosition(parts, 1, 100.0), 0.0001)
        assertEquals(0.0, SpokenTimeline.bookPosition(parts, 9, 100.0), 0.0001)
    }

    @Test fun `skip crosses part boundaries and stays inside the book`() {
        // 10 s before the end of part 0, skip forward 30 s: 20 s into part 1.
        assertEquals(SpokenTimeline.Located(1, 20.0), SpokenTimeline.skipFrom(parts, 0, 3590.0, 30.0, 9000.0))
        // 5 s into part 1, skip back 15: 10 s before the end of part 0.
        assertEquals(SpokenTimeline.Located(0, 3590.0), SpokenTimeline.skipFrom(parts, 1, 5.0, -15.0, 9000.0))
        assertEquals(SpokenTimeline.Located(0, 0.0), SpokenTimeline.skipFrom(parts, 0, 5.0, -15.0, 9000.0))
        assertEquals(SpokenTimeline.Located(2, 1800.0), SpokenTimeline.skipFrom(parts, 2, 1790.0, 30.0, 9000.0))
    }

    @Test fun `a single file with no part info still skips inside itself`() {
        assertEquals(SpokenTimeline.Located(0, 45.0), SpokenTimeline.skipFrom(emptyList(), 0, 15.0, 30.0, 0.0))
    }
}

class AudioStreamRulesTest {
    private val base = "https://home.example"

    @Test fun `each of the server's audio addresses is recognised`() {
        assertEquals(AudioKind.MUSIC, AudioStreamRules.kindOf("$base/api/music/track/${"a".repeat(20)}/stream?codecs=mp3", base))
        assertEquals(AudioKind.AUDIOBOOK, AudioStreamRules.kindOf("$base/api/audiobooks/book/${"b".repeat(16)}/stream/2", base))
        assertEquals(AudioKind.AUDIOBOOK, AudioStreamRules.kindOf("$base/api/audiobooks/book/${"b".repeat(16)}/stream", base))
        assertEquals(AudioKind.PODCAST, AudioStreamRules.kindOf("$base/api/podcasts/episode/${"c".repeat(12)}.${"d".repeat(16)}/stream", base))
        assertEquals(AudioKind.RADIO, AudioStreamRules.kindOf("$base/api/radio/session/${"e".repeat(16)}/stream", base))
    }

    @Test fun `another host or a look-alike path never gets the token`() {
        assertNull(AudioStreamRules.kindOf("https://evil.example/api/audiobooks/book/${"b".repeat(16)}/stream", base))
        assertNull(AudioStreamRules.kindOf("$base.evil.example/api/audiobooks/book/${"b".repeat(16)}/stream", base))
        assertNull(AudioStreamRules.kindOf("$base/api/audiobooks/book/${"b".repeat(16)}/stream/../../admin", base))
        assertNull(AudioStreamRules.kindOf("$base/api/audiobooks/book/short/stream", base))
        assertNull(AudioStreamRules.kindOf("$base/x/api/radio/session/${"e".repeat(16)}/stream", base))
        assertNull(AudioStreamRules.kindOf("$base/api/radio/session/${"e".repeat(16)}/stream", null))
    }

    @Test fun `spoken kinds are the ones that are not music, and radio cannot seek`() {
        assertFalse(AudioKind.MUSIC.spoken)
        assertTrue(AudioKind.AUDIOBOOK.spoken && AudioKind.PODCAST.spoken && AudioKind.RADIO.spoken)
        assertFalse(AudioKind.RADIO.seekable)
        assertTrue(AudioKind.PODCAST.seekable)
        assertEquals(AudioKind.MUSIC, AudioKind.fromId("nonsense"))
        assertEquals(AudioKind.PODCAST, AudioKind.fromId("podcast"))
    }
}

class AudiobookLogicTest {

    @Test fun `speed is 0_5x to 3x in 0_05 steps with junk falling back to 1x`() {
        assertEquals(1.0, AudiobookLogic.clampSpeed(null), 0.0)
        assertEquals(1.0, AudiobookLogic.clampSpeed(Double.NaN), 0.0)
        assertEquals(1.0, AudiobookLogic.clampSpeed(-2.0), 0.0)
        assertEquals(0.5, AudiobookLogic.clampSpeed(0.1), 0.0)
        assertEquals(3.0, AudiobookLogic.clampSpeed(9.0), 0.0)
        assertEquals(1.25, AudiobookLogic.clampSpeed(1.26), 0.0001)
        assertEquals(1.5, AudiobookLogic.clampSpeed(1.5), 0.0)
    }

    @Test fun `speed labels and the tap to cycle presets`() {
        assertEquals("1x", AudiobookLogic.speedLabel(1.0))
        assertEquals("1.25x", AudiobookLogic.speedLabel(1.25))
        assertEquals("2.5x", AudiobookLogic.speedLabel(2.5))
        assertEquals(1.25, AudiobookLogic.nextPreset(1.0), 0.0)
        assertEquals(0.5, AudiobookLogic.nextPreset(3.0), 0.0)
        assertEquals(1.5, AudiobookLogic.nextPreset(1.3), 0.0)
    }

    private val chapters = AudiobookLogic.chapters(listOf(ChapterDto("Intro", 0.0, 100.0), ChapterDto("Two", 100.0, 250.0), ChapterDto("", 250.0, 400.0)))

    @Test fun `chapters are sorted, cleaned and given names when blank`() {
        assertEquals(listOf("Intro", "Two", "Chapter 3"), chapters.map { it.title })
        assertEquals("A B", AudiobookLogic.chapters(listOf(ChapterDto("A‮B", 0.0, 1.0))).single().title)
    }

    @Test fun `chapter lookup`() {
        assertEquals(-1, AudiobookLogic.chapterIndexAt(emptyList(), 5.0))
        assertEquals(0, AudiobookLogic.chapterIndexAt(chapters, 0.0))
        assertEquals(1, AudiobookLogic.chapterIndexAt(chapters, 100.0))
        assertEquals(1, AudiobookLogic.chapterIndexAt(chapters, 249.9))
        assertEquals(2, AudiobookLogic.chapterIndexAt(chapters, 9999.0))
    }

    @Test fun `previous chapter restarts this one unless it just began`() {
        assertEquals(100.0, AudiobookLogic.previousChapterStart(chapters, 130.0)!!, 0.0)
        assertEquals(0.0, AudiobookLogic.previousChapterStart(chapters, 101.0)!!, 0.0)
        assertEquals(0.0, AudiobookLogic.previousChapterStart(chapters, 2.0)!!, 0.0)
        assertNull(AudiobookLogic.previousChapterStart(emptyList(), 5.0))
    }

    @Test fun `next chapter`() {
        assertEquals(100.0, AudiobookLogic.nextChapterStart(chapters, 5.0)!!, 0.0)
        assertNull(AudiobookLogic.nextChapterStart(chapters, 260.0))
    }

    @Test fun `a minutes timer counts the wall clock, fades over the last ten seconds and fires`() {
        val t = AudiobookLogic.sleepMinutes(30, 1_000_000)!!
        assertEquals(1_000_000 + 30 * 60_000L, t.endsAtMs)
        val early = AudiobookLogic.sleepStatus(t, 1_000_000, 0.0)
        assertFalse(early.done); assertEquals(1f, early.volume, 0f); assertEquals(1800.0, early.remainingSec, 0.001)
        val fading = AudiobookLogic.sleepStatus(t, t.endsAtMs - 5_000, 0.0)
        assertFalse(fading.done); assertEquals(0.5f, fading.volume, 0.01f)
        val done = AudiobookLogic.sleepStatus(t, t.endsAtMs, 0.0)
        assertTrue(done.done); assertEquals(0f, done.volume, 0f)
        assertNull(AudiobookLogic.sleepMinutes(0, 5))
        assertEquals(720 * 60_000L, AudiobookLogic.sleepMinutes(99999, 0)!!.endsAtMs)
    }

    @Test fun `an end of chapter timer stops at the boundary with no fade`() {
        val t = AudiobookLogic.sleepAtChapterEnd(chapters, 130.0)!!
        assertEquals(250.0, t.endPosSec, 0.0)
        val mid = AudiobookLogic.sleepStatus(t, 0, 200.0)
        assertFalse(mid.done); assertEquals(1f, mid.volume, 0f)
        assertTrue(AudiobookLogic.sleepStatus(t, 0, 250.0).done)
        assertNull(AudiobookLogic.sleepAtChapterEnd(emptyList(), 5.0))
        assertNull(AudiobookLogic.sleepAtChapterEnd(chapters, 9999.0))
    }

    @Test fun `sleep labels`() {
        val now = 10_000L
        assertNull(AudiobookLogic.sleepLabel(null, now, 0.0))
        assertEquals("Sleep · end of chapter", AudiobookLogic.sleepLabel(AudiobookLogic.Sleep.ChapterEnd(50.0), now, 0.0))
        assertEquals("Sleep · 14:32", AudiobookLogic.sleepLabel(AudiobookLogic.Sleep.Minutes(now + 871_500), now, 0.0))
    }

    private fun prog(pos: Double, at: Long, finished: Boolean = false, speed: Double? = null) =
        BookProgress(bookId = "b", position = pos, duration = 1000.0, updatedAt = at, finished = finished, speed = speed)

    @Test fun `the newest listen wins, whichever device it was on`() {
        val server = prog(500.0, 2000, speed = 1.5)
        // The car heard more recently than this phone did: the server's position stands.
        var r = AudiobookLogic.resolveResume(server, AudiobookLogic.LocalPosition("b", 100.0, 1000), 1000.0)
        assertEquals(500.0, r.positionSec, 0.0); assertEquals(AudiobookLogic.ResumeSource.SERVER, r.source); assertEquals(1.5, r.speed!!, 0.0)
        // This phone listened after the last sync: its position stands.
        r = AudiobookLogic.resolveResume(server, AudiobookLogic.LocalPosition("b", 700.0, 3000, 2.0), 1000.0)
        assertEquals(700.0, r.positionSec, 0.0); assertEquals(AudiobookLogic.ResumeSource.THIS_DEVICE, r.source); assertEquals(2.0, r.speed!!, 0.0)
        // A tie goes to the server.
        r = AudiobookLogic.resolveResume(server, AudiobookLogic.LocalPosition("b", 700.0, 2000), 1000.0)
        assertEquals(AudiobookLogic.ResumeSource.SERVER, r.source)
    }

    @Test fun `nothing saved means the start, a finished book starts over, and the position stays in the book`() {
        assertEquals(AudiobookLogic.Resume(0.0, AudiobookLogic.ResumeSource.NONE, null), AudiobookLogic.resolveResume(null, null, 1000.0))
        assertEquals(0.0, AudiobookLogic.resolveResume(prog(995.0, 5, finished = true), null, 1000.0).positionSec, 0.0)
        assertEquals(1000.0, AudiobookLogic.resolveResume(prog(5000.0, 5), null, 1000.0).positionSec, 0.0)
        assertEquals(0.0, AudiobookLogic.resolveResume(null, AudiobookLogic.LocalPosition("b", -4.0, 5), 1000.0).positionSec, 0.0)
    }

    @Test fun `positions are pushed on a timer and on a big jump`() {
        assertTrue(AudiobookLogic.shouldPush(0, 0.0, 100, 0.0))
        assertFalse(AudiobookLogic.shouldPush(1000, 50.0, 5000, 54.0))
        assertTrue(AudiobookLogic.shouldPush(1000, 50.0, 17_000, 66.0))
        assertFalse("nothing moved (paused)", AudiobookLogic.shouldPush(1000, 50.0, 17_000, 50.0))
        assertTrue("a seek", AudiobookLogic.shouldPush(1000, 50.0, 5000, 400.0))
    }

    @Test fun `finished follows the server rule`() {
        assertTrue(AudiobookLogic.isFinished(36000.0 - 40, 36000.0))
        assertFalse(AudiobookLogic.isFinished(36000.0 - 60, 36000.0))
        assertTrue(AudiobookLogic.isFinished(295.0, 300.0))
        assertFalse(AudiobookLogic.isFinished(0.0, 0.0))
    }

    @Test fun `time formatting`() {
        assertEquals("1:02:05", AudiobookLogic.formatClock(3725.0))
        assertEquals("1:05", AudiobookLogic.formatClock(65.0))
        assertEquals("0:00", AudiobookLogic.formatClock(-4.0))
        assertEquals("1 h 2 min", AudiobookLogic.formatLeft(3725.0))
        assertEquals("under a minute", AudiobookLogic.formatLeft(30.0))
        assertEquals("2 h", AudiobookLogic.formatLeft(7200.0))
        assertEquals("45 min", AudiobookLogic.formatLeft(2700.0))
        assertEquals("0 min", AudiobookLogic.formatLeft(0.0))
    }

    @Test fun `series place`() {
        assertEquals("Discworld · Book 5", AudiobookLogic.seriesPlace("Discworld", 5.0))
        assertEquals("Discworld · Book 2.5", AudiobookLogic.seriesPlace("Discworld", 2.5))
        assertEquals("Discworld", AudiobookLogic.seriesPlace("Discworld", null))
        assertNull(AudiobookLogic.seriesPlace(null, 3.0))
    }

    @Test fun `a part's stream address must be an audiobook stream path on this server`() {
        assertEquals("/api/audiobooks/book/x/stream/0", AudiobookLogic.streamPath(PartDto(stream = "/api/audiobooks/book/x/stream/0")))
        assertNull(AudiobookLogic.streamPath(PartDto(stream = "https://evil.example/api/audiobooks/book/x/stream/0")))
        assertNull(AudiobookLogic.streamPath(PartDto(stream = "/api/music/track/x/stream")))
        assertNull(AudiobookLogic.streamPath(PartDto(stream = "")))
    }

    @Test fun `status line for a book row`() {
        val fresh = BookBrief(id = "a", duration = 7200.0)
        assertEquals("2 h", AudiobookLogic.statusLine(fresh))
        val going = fresh.copy(status = "in_progress", progress = BookProgress(remaining = 1800.0, fraction = 0.75))
        assertEquals("30 min left", AudiobookLogic.statusLine(going))
        assertEquals("Finished", AudiobookLogic.statusLine(fresh.copy(status = "finished", progress = BookProgress(finished = true))))
    }
}

class AudiobookModelsTest {
    @Test fun `a book answer from the server decodes, extra fields ignored`() {
        val body = """
            {"ok":true,"book":{"id":"0123456789abcdef","title":"The Way of Kings","author":"Brandon Sanderson","authorId":"aid","narrator":"Kramer","series":"Stormlight","seriesId":"sid","seriesIndex":1,"year":2010,"duration":162000,"partCount":2,
              "cover":"/api/audiobooks/cover/abc","description":"Long.","chaptersSource":"chpl","unreadable":false,
              "chapters":[{"title":"Prologue","start":0,"end":500.5}],
              "parts":[{"index":0,"title":"a","start":0,"duration":81000,"codec":"aac","stream":"/api/audiobooks/book/0123456789abcdef/stream/0"},
                       {"index":1,"title":"b","start":81000,"duration":81000,"codec":"aac","stream":"/api/audiobooks/book/0123456789abcdef/stream/1"}]},
             "progress":{"bookId":"0123456789abcdef","position":1234.5,"duration":162000,"fraction":0.0076,"remaining":160765.5,"finished":false,"updatedAt":1790000000000,"speed":1.25,"deviceId":"car","bookmarkCount":1},
             "speed":1.25,"bookmarks":[{"id":"a1b2c3d4e5f6","at":100.5,"note":"nice","createdAt":5}],
             "nextInSeries":null,"prefs":{"speed":1,"skipBack":15,"skipForward":30,"sleepMinutes":0,"sleepEndOfChapter":false}}
        """.trimIndent()
        val r = J.decodeFromString(BookResponse.serializer(), body)
        assertEquals("The Way of Kings", r.book.title)
        assertEquals(2, r.book.parts.size)
        assertEquals(81000.0, r.book.parts[1].start, 0.0)
        assertEquals(1.25, r.progress!!.speed!!, 0.0)
        assertEquals("nice", r.bookmarks.single().note)
        assertNull(r.nextInSeries)
        assertEquals(30, r.prefs.skipForward)
        assertEquals(2, AudiobookLogic.parts(r.book).size)
    }

    @Test fun `the continue shelf and status decode`() {
        val c = J.decodeFromString(ContinueResponse.serializer(), """{"ok":true,"items":[{"book":{"id":"a","title":"T","author":"A","duration":10},"progress":{"bookId":"a","position":5,"duration":10,"fraction":0.5,"remaining":5,"updatedAt":9}}],"nextUp":[{"book":{"id":"b","title":"N"},"series":{"id":"s","name":"S"}}]}""")
        assertEquals(0.5, c.items.single().progress.fraction, 0.0)
        assertEquals("S", c.nextUp.single().series.name)
        val st = J.decodeFromString(AudiobookStatus.serializer(), """{"ok":true,"configured":true,"scanning":false,"bookCount":12,"lookup":{"enabled":false}}""")
        assertTrue(st.configured); assertEquals(12, st.bookCount)
    }

    @Test fun `books in a list carry progress and status`() {
        val r = J.decodeFromString(BooksResponse.serializer(), """{"ok":true,"total":1,"offset":0,"items":[{"id":"a","title":"T","author":"A","duration":10,"status":"in_progress","progress":{"bookId":"a","fraction":0.2,"remaining":8,"updatedAt":1},"next":true}]}""")
        assertEquals("in_progress", r.items.single().status)
        assertTrue(r.items.single().next)
    }
}

class PendingPositionsTest {
    private class MemStore : PendingPositions.StringStore {
        val map = mutableMapOf<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String) { map[key] = value }
        override fun remove(key: String) { map.remove(key) }
    }

    @Test fun `positions are kept per person and the newest one wins`() {
        val store = MemStore()
        val a = PendingPositions(store, "alex")
        val b = PendingPositions(store, "sam")
        a.put(AudiobookLogic.LocalPosition("book1", 100.0, 10))
        a.put(AudiobookLogic.LocalPosition("book1", 50.0, 5))
        assertEquals(100.0, a.get("book1")!!.position, 0.0)
        a.put(AudiobookLogic.LocalPosition("book1", 200.0, 20, 1.5))
        assertEquals(200.0, a.get("book1")!!.position, 0.0)
        assertEquals(1.5, a.get("book1")!!.speed!!, 0.0)
        assertNull("another person's phone profile sees nothing", b.get("book1"))
    }

    @Test fun `sent positions are cleared, but not ones saved after they were read`() {
        val p = PendingPositions(MemStore(), "alex")
        p.put(AudiobookLogic.LocalPosition("a", 1.0, 10))
        p.put(AudiobookLogic.LocalPosition("b", 2.0, 11))
        val sent = p.all()
        p.put(AudiobookLogic.LocalPosition("a", 9.0, 50))
        p.clearSent(sent)
        assertNull(p.get("b"))
        assertEquals(9.0, p.get("a")!!.position, 0.0)
    }

    @Test fun `a damaged store is treated as empty`() {
        val store = MemStore()
        store.map["audiobook_pending_alex"] = "{not json"
        assertTrue(PendingPositions(store, "alex").all().isEmpty())
    }

    @Test fun `the key cannot be made to collide by a hostile user id`() {
        val store = MemStore()
        PendingPositions(store, "../../x").put(AudiobookLogic.LocalPosition("a", 1.0, 1))
        assertTrue(store.map.keys.all { it.startsWith("audiobook_pending_") && !it.contains("/") && !it.contains(".") })
    }
}

class AudiobookClientTest {
    private val okBody = """{"ok":true}"""

    @Test fun `progress is saved with a put and the documented body`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"applied":true,"progress":null}""" }
        val r = AudiobookClient(fake.json()).saveProgress("0123456789abcdef", 12.5, 1.25, "android-abc", 1790000000000)
        assertTrue(r.applied)
        assertEquals("PUT https://home.example/api/audiobooks/book/0123456789abcdef/progress", fake.requests.single().method + " " + fake.requests.single().url)
        assertEquals("""{"position":12.5,"speed":1.25,"deviceId":"android-abc","updatedAt":1790000000000}""", fake.bodies.single())
    }

    @Test fun `a device catching up sends a batch of at most 100`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"results":[]}""" }
        val items = (1..130).map { AudiobookLogic.LocalPosition("b$it", it.toDouble(), it.toLong()) }
        AudiobookClient(fake.json()).saveBatch(items, "dev")
        assertEquals("POST", fake.requests.single().method)
        assertEquals("/api/audiobooks/progress/batch", fake.requests.single().url.encodedPath)
        assertEquals(100, Regex("\"bookId\"").findAll(fake.bodies.single()).count())
    }

    @Test fun `books ask with the filters and paging`() = runBlocking {
        val fake = FakeServer { 200 to """{"ok":true,"items":[]}""" }
        AudiobookClient(fake.json()).books(status = "in_progress", q = "king", offset = 20, limit = 50)
        val url = fake.requests.single().url
        assertEquals("/api/audiobooks/books", url.encodedPath)
        assertEquals("in_progress", url.queryParameter("status"))
        assertEquals("king", url.queryParameter("q"))
        assertEquals("20", url.queryParameter("offset"))
        assertEquals("50", url.queryParameter("limit"))
    }

    @Test fun `bookmarks and prefs use the documented routes`() = runBlocking {
        val fake = FakeServer { req ->
            when {
                req.url.encodedPath.endsWith("/bookmarks") -> 201 to """{"ok":true,"bookmark":{"id":"a1b2c3d4e5f6","at":9.5,"note":"x","createdAt":1}}"""
                else -> 200 to okBody
            }
        }
        val c = AudiobookClient(fake.json())
        assertEquals("a1b2c3d4e5f6", c.addBookmark("0123456789abcdef", 9.5, "x").bookmark!!.id)
        c.deleteBookmark("0123456789abcdef", "a1b2c3d4e5f6")
        c.setPrefs(speed = 1.5, sleepEndOfChapter = true)
        assertEquals(listOf("POST", "DELETE", "PUT"), fake.requests.map { it.method })
        assertEquals("""{"at":9.5,"note":"x"}""", fake.bodies[0])
        assertEquals("""{"speed":1.5,"sleepEndOfChapter":true}""", fake.bodies[2])
    }
}
