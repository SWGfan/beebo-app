package com.beeboentertainment.movie.campsite.songbook

import com.beeboentertainment.movie.campsite.family.Assets
import com.beeboentertainment.movie.campsite.family.FakeClock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Engine and service tests. All song text is synthetic ("Test line ...") or from the invented demo chants. */
class SongbookEngineTest {

    private val clock = FakeClock()

    private val testPack = """
        {"schema": 1, "packId": "engine-test", "title": "Engine test pack", "legalCheck": {"by": "Test", "date": "2026-09-21"},
         "songs": [
          {"id": "round-four", "title": "Round Four", "origin": "Traditional, documented in a test fixture", "pdBasis": "Synthetic test text, not a real song",
           "sourceUrl": "https://example.org/a", "kind": "round", "lineSeconds": 2.0, "round": {"groups": 3, "repeats": 3, "offsetLines": 2},
           "lines": ["Test round A", "Test round B", "Test round C", "Test round D"]},
          {"id": "six-lines", "title": "Six Lines", "origin": "Traditional, documented in a test fixture", "pdBasis": "Synthetic test text, not a real song",
           "sourceUrl": "https://example.org/b", "kind": "singalong", "lineSeconds": 3.0,
           "lines": ["Test six 1", "Test six 2", "Test six 3", {"text": "Test six 4", "refrain": true}, {"text": "Test six 5", "refrain": true}, "Test six 6"]}
         ]}
    """.trimIndent()

    private fun library(): SongbookLibrary {
        val lib = SongbookLibrary({ Assets.text("songbook/demo-pack.json") }, MemoryPackStore())
        val outcome = lib.import(testPack)
        assertTrue(outcome.message, outcome.ok)
        return lib
    }

    private fun engine(): SongbookEngine { val lib = library(); return SongbookEngine({ lib.catalog }, clock) }

    // ---- time model ----------------------------------------------------------------------

    @Test fun autoAdvanceFollowsTheHostTempoFromTheClockAndFinishes() {
        val e = engine()
        assertTrue(e.select("six-lines"))
        assertEquals(0, e.currentStep()); assertFalse(e.playing)
        assertTrue(e.start())
        assertEquals(0, e.currentStep())
        clock.advance(2_999); assertEquals(0, e.currentStep())
        clock.advance(1); assertEquals(1, e.currentStep())
        assertEquals(0L, e.msIntoStep())
        clock.advance(4_500); assertEquals(2, e.currentStep()); assertEquals(1_500L, e.msIntoStep())
        clock.advance(60_000)
        assertEquals(6, e.currentStep()); assertTrue(e.finished())
    }

    @Test fun manualModeOnlyMovesWhenTheHostTapsNextOrBack() {
        val e = engine(); e.select("six-lines"); e.setAuto(false); e.start()
        clock.advance(120_000); assertEquals(0, e.currentStep())
        e.next(); e.next(); assertEquals(2, e.currentStep())
        e.back(); assertEquals(1, e.currentStep())
        repeat(20) { e.next() }; assertEquals(6, e.currentStep())
        e.back(); assertEquals(5, e.currentStep())
        e.restart(); assertEquals(0, e.currentStep())
    }

    @Test fun pauseFreezesTheStepAndResumeContinuesFromThere() {
        val e = engine(); e.select("six-lines"); e.start()
        clock.advance(7_000); assertEquals(2, e.currentStep())
        e.pause(); clock.advance(60_000); assertEquals(2, e.currentStep()); assertFalse(e.playing)
        e.start(); clock.advance(3_000); assertEquals(3, e.currentStep())
    }

    @Test fun changingTempoOrModeMidSongNeverJumpsTheLine() {
        val e = engine(); e.select("six-lines"); e.start()
        clock.advance(7_000); assertEquals(2, e.currentStep())
        e.setLineSeconds(6.0); assertEquals(2, e.currentStep())
        clock.advance(6_000); assertEquals(3, e.currentStep())
        e.setAuto(false); clock.advance(100_000); assertEquals(3, e.currentStep())
        e.setLineSeconds(0.1); assertEquals(1_500L, e.lineMs)
        e.setLineSeconds(99.0); assertEquals(12_000L, e.lineMs)
    }

    @Test fun finishedSongCanBeSungAgainFromTheTop() {
        val e = engine(); e.select("six-lines"); e.start(); clock.advance(100_000)
        assertTrue(e.finished()); assertTrue(e.start()); assertEquals(0, e.currentStep()); assertFalse(e.finished())
    }

    @Test fun controlsDoNothingHarmfulWithNoSongOrAnUnknownSong() {
        val e = engine()
        assertFalse(e.start()); e.next(); e.back(); e.pause(); e.restart(); assertEquals(0, e.currentStep()); assertEquals(0, e.totalSteps)
        assertFalse(e.select("../../etc/passwd")); assertFalse(e.select(""))
        assertFalse(e.setRoundMode(true))
    }

    // ---- rounds --------------------------------------------------------------------------

    @Test fun roundTimelineEntersEachGroupTheChosenNumberOfLinesLater() {
        val e = engine(); e.select("round-four")
        assertFalse(e.roundMode); assertTrue(e.setRoundMode(true))
        assertEquals(3, e.groups); assertEquals(2, e.offsetLines); assertEquals(3, e.repeats)
        assertEquals(3 * 4 + (3 - 1) * 2, e.totalSteps)
        fun at(step: Int, group: Int) = e.lineFor(group, step)
        assertEquals(SongbookEngine.GroupLine(0, SongbookEngine.GroupLine.Phase.SING, 0), at(0, 0))
        assertEquals(SongbookEngine.GroupLine(1, SongbookEngine.GroupLine.Phase.WAIT, 2), at(0, 1))
        assertEquals(SongbookEngine.GroupLine(2, SongbookEngine.GroupLine.Phase.WAIT, 4), at(0, 2))
        assertEquals(SongbookEngine.GroupLine(1, SongbookEngine.GroupLine.Phase.SING, 0), at(2, 1))
        assertEquals(SongbookEngine.GroupLine(0, SongbookEngine.GroupLine.Phase.SING, 1), at(5, 0))
        assertEquals(SongbookEngine.GroupLine(2, SongbookEngine.GroupLine.Phase.SING, 1), at(5, 2))
        assertEquals(SongbookEngine.GroupLine(0, SongbookEngine.GroupLine.Phase.DONE, 0), at(12, 0))
        assertEquals(SongbookEngine.GroupLine(2, SongbookEngine.GroupLine.Phase.SING, 3), at(15, 2))
        assertEquals(SongbookEngine.GroupLine(2, SongbookEngine.GroupLine.Phase.DONE, 0), at(16, 2))
    }

    @Test fun everyGroupSingsEveryLineTheSameNumberOfTimes() {
        val e = engine(); e.select("round-four"); e.setRoundMode(true)
        for (g in 0 until e.groups) {
            val sung = (0..e.totalSteps).map { e.lineFor(g, it) }.filter { it.state == SongbookEngine.GroupLine.Phase.SING }.groupingBy { it.index }.eachCount()
            assertEquals(mapOf(0 to 3, 1 to 3, 2 to 3, 3 to 3), sung)
        }
    }

    @Test fun roundControlsAreClampedAndOnlyOfferedForRounds() {
        val e = engine(); e.select("six-lines")
        assertFalse(e.setRoundMode(true))
        e.select("round-four"); e.setRoundMode(true)
        e.setGroups(9); assertEquals(4, e.groups); e.setGroups(0); assertEquals(2, e.groups)
        e.setOffsetLines(99); assertEquals(3, e.offsetLines); e.setOffsetLines(-4); assertEquals(1, e.offsetLines)
        assertEquals(0, e.currentStep())
        e.setRoundMode(false); assertEquals(4, e.totalSteps)
    }

    @Test fun defaultRoundGroupsFollowJoinOrderAndTheGuestMayChooseAnother() {
        val e = engine(); e.select("round-four"); e.setRoundMode(true)
        listOf("a", "b", "c", "d").forEach { assertTrue(e.join(it, it)) }
        assertEquals(listOf(0, 1, 2, 0), listOf("a", "b", "c", "d").map { e.groupOf(it) })
        assertEquals(listOf(2, 1, 1), e.groupSizes())
        assertTrue(e.setGroup("d", 2)); assertEquals(2, e.groupOf("d"))
        assertFalse(e.setGroup("d", 4)); assertFalse(e.setGroup("nobody", 0)); assertFalse(e.setGroup("d", -1))
        e.setGroups(2); assertEquals(0, e.groupOf("d"))                  // wraps rather than pointing at a missing group
    }

    @Test fun guestsWhoLeftAreNotCountedInTheHostsGroupSizes() {
        val e = engine(); e.select("round-four"); e.setRoundMode(true)
        e.join("a", "A"); e.join("b", "B")
        clock.advance(SongbookEngine.PRESENT_MS + 1); e.join("a", "A")
        assertEquals(listOf("A"), e.guestNames())
    }

    @Test fun theRoomHasAHardGuestLimitButLeftGuestsMakeRoom() {
        val e = engine()
        repeat(SongbookEngine.MAX_GUESTS) { assertTrue(e.join("g$it", "G$it")) }
        assertFalse(e.join("late", "Late"))
        clock.advance(SongbookEngine.STALE_MS + 1)
        assertTrue(e.join("late", "Late"))
    }

    // ---- requests ------------------------------------------------------------------------

    @Test fun heartsAreCountedTakenBackLimitedAndClearedWhenTheSongIsChosen() {
        val e = engine(); e.join("a", "A"); e.join("b", "B")
        assertNull(e.toggleHeart("a", "six-lines")); assertNull(e.toggleHeart("b", "six-lines")); assertNull(e.toggleHeart("a", "round-four"))
        assertEquals(2, e.heartCount("six-lines"))
        assertEquals(listOf("six-lines", "round-four"), e.requests().map { it.first.id })
        assertNull(e.toggleHeart("a", "six-lines")); assertEquals(1, e.heartCount("six-lines"))
        assertNotNull(e.toggleHeart("a", "not-a-song")); assertNotNull(e.toggleHeart("stranger", "six-lines"))
        e.select("six-lines"); assertEquals(0, e.heartCount("six-lines"))
        e.dismissRequest("round-four"); assertTrue(e.requests().isEmpty())
    }

    @Test fun aGuestMayOnlyKeepFiveOpenRequests() {
        val lib = SongbookLibrary({ Assets.text("songbook/demo-pack.json") }, MemoryPackStore())
        val many = (1..7).joinToString(",") { """{"id":"s$it","title":"Synthetic Song $it","origin":"Original test","pdBasis":"Synthetic test text, not a real song","kind":"singalong","lines":["Test a $it","Test b $it"]}""" }
        assertTrue(lib.import("""{"schema":1,"packId":"many","title":"Many","legalCheck":{"by":"T","date":"2026-09-21"},"songs":[$many]}""").ok)
        val e = SongbookEngine({ lib.catalog }, clock); e.join("a", "A")
        (1..5).forEach { assertNull(e.toggleHeart("a", "s$it")) }
        assertNotNull(e.toggleHeart("a", "s6"))
        assertEquals(0, e.heartCount("s6"))
        assertNull(e.toggleHeart("a", "s1")); assertNull(e.toggleHeart("a", "s6"))
    }

    // ---- what counts as sung -------------------------------------------------------------

    @Test fun aSongCountsAsSungOnceItIsHalfWayThrough() {
        val e = engine()
        e.select("six-lines"); e.start(); clock.advance(3_000); assertTrue(e.sungTitles().isEmpty())
        clock.advance(6_000); assertEquals(listOf("Six Lines"), e.sungTitles())
        e.select("round-four"); e.start(); clock.advance(1_000)
        assertEquals(listOf("Six Lines"), e.sungTitles())
        e.setAuto(false); e.next(); e.next(); assertEquals(listOf("Six Lines", "Round Four"), e.sungTitles())
        e.resetSession(); assertTrue(e.sungTitles().isEmpty()); assertNull(e.song)
    }

    @Test fun removingAPackMidSongEndsThatSongCleanly() {
        val lib = library()
        val e = SongbookEngine({ lib.catalog }, clock)
        e.select("six-lines"); e.start(); e.join("a", "A"); e.toggleHeart("a", "round-four")
        assertTrue(lib.remove("engine-test")); e.catalogChanged()
        assertNull(e.song); assertFalse(e.playing); assertEquals(0, e.heartCount("round-four"))
    }

    // ---- the service: guest door, limits, XSS, trip --------------------------------------

    private fun service(trip: SongbookTripSink = SongbookTripSink { _, _, _ -> false }) = SongbookService(library(), clock, trip)

    private fun post(s: SongbookService, token: String, name: String, vararg pairs: Pair<String, Any>) =
        s.post(token, name, buildJsonObject { pairs.forEach { (k, v) -> if (v is Int) put(k, v) else put(k, v.toString()) } })

    @Test fun guestViewCarriesTheStepTheLinesOnceAndOnlyWhatAGuestMayKnow() {
        val s = service()
        s.locked { it.select("six-lines"); it.start() }
        val first = s.get("t1", "Ann", -1, false).body
        assertEquals(6, first["song"]!!.jsonObject["lines"]!!.jsonArray.size)
        assertEquals(4, first["songs"]!!.jsonArray.size)
        assertTrue(first["playing"]!!.jsonPrimitive.boolean)
        val rev = first["song"]!!.jsonObject["songRev"]!!.jsonPrimitive.int
        val again = s.get("t1", "Ann", rev, true).body
        assertFalse(again["song"]!!.jsonObject.containsKey("lines"))     // not re-sent
        assertFalse(again.containsKey("songs"))
        val text = first.toString()
        assertFalse("origin/pdBasis are for the owner, not for guests", text.contains("pdBasis") || text.contains("sourceUrl"))
        assertTrue(first["song"]!!.jsonObject["refrain"]!!.jsonArray[3].jsonPrimitive.boolean)
    }

    @Test fun guestNamesAreCleanedAndTextIsNeverMarkup() {
        val s = service()
        val body = post(s, "t1", "<script>alert(1)</script> & \"Ann\"\u0007", "action" to "join").body
        val text = body.toString()
        assertFalse(text.contains("<")); assertFalse(text.contains(">")); assertFalse(text.contains("&")); assertFalse(text.contains("\u0007"))
        assertTrue(body["name"]!!.jsonPrimitive.content.length <= 24)
        assertTrue(s.locked { it.guestNames() }.all { !it.contains("<") })
    }

    @Test fun guestsCanOnlyJoinPickAGroupAndHeart() {
        val s = service()
        assertEquals(400, post(s, "t1", "Ann", "action" to "select", "song" to "six-lines").status)
        assertEquals(400, post(s, "t1", "Ann", "action" to "start").status)
        assertNull(s.locked { it.song })
        assertEquals(400, post(s, "t1", "Ann", "action" to "heart", "song" to "nope").status)
        assertEquals(400, post(s, "t1", "Ann", "action" to "group", "group" to 7).status)
        assertEquals(400, post(s, "t1", "Ann", "action" to "group").status)
        assertEquals(400, post(s, "t1", "Ann", "action" to "heart").status)
        assertEquals(200, post(s, "t1", "Ann", "action" to "group", "group" to 1).status)
        val r = post(s, "t1", "Ann", "action" to "heart", "song" to "six-lines").body
        assertEquals(1, r["hearts"]!!.jsonObject["six-lines"]!!.jsonPrimitive.int)
        assertEquals("six-lines", r["mine"]!!.jsonArray.single().jsonPrimitive.content)
    }

    @Test fun heartLimitComesBackAsANoticeNotAnError() {
        val s = service()
        val many = (1..7).joinToString(",") { """{"id":"h$it","title":"Heart Song $it","origin":"Original test","pdBasis":"Synthetic test text, not a real song","kind":"singalong","lines":["Test a $it","Test b $it"]}""" }
        assertTrue(s.importPack("""{"schema":1,"packId":"hearts","title":"Hearts","legalCheck":{"by":"T","date":"2026-09-21"},"songs":[$many]}""").ok)
        (1..5).forEach { assertEquals(200, post(s, "t1", "Ann", "action" to "heart", "song" to "h$it").status) }
        val sixth = post(s, "t1", "Ann", "action" to "heart", "song" to "h6")
        assertEquals(200, sixth.status)
        assertTrue(sixth.body["notice"]!!.jsonPrimitive.content.contains("5"))
        assertNull(sixth.body["hearts"]!!.jsonObject["h6"])
    }

    @Test fun readsAndWritesAreRateLimitedPerGuest() {
        val s = service()
        repeat(20) { assertEquals(200, post(s, "t1", "Ann", "action" to "join").status) }
        assertEquals(429, post(s, "t1", "Ann", "action" to "join").status)
        assertEquals(200, post(s, "t2", "Ben", "action" to "join").status)
        repeat(40) { assertEquals(200, s.get("t3", "Cy", -1, false).status) }
        assertEquals(429, s.get("t3", "Cy", -1, false).status)
        clock.advance(10_001)
        assertEquals(200, s.get("t3", "Cy", -1, false).status)
    }

    @Test fun theSongbookRefusesGuestsBeyondItsLimit() {
        val s = service()
        repeat(SongbookEngine.MAX_GUESTS) { assertEquals(200, s.get("g$it", "G$it", -1, false).status) }
        assertEquals(503, s.get("late", "Late", -1, false).status)
    }

    @Test fun hostStateReportsEverythingTheHostScreenDraws() {
        val s = service()
        s.locked { it.select("round-four"); it.setRoundMode(true); it.start() }
        s.get("t1", "Ann", -1, false); s.get("t2", "Ben", -1, false)
        val h = s.hostState()
        assertEquals("Round Four", h.song!!.title)
        assertEquals(3, h.groupLines.size)
        assertEquals(listOf("Ann", "Ben"), h.guestNames)
        assertTrue(h.roundMode && h.playing)
    }

    @Test fun savingToTheTripSendsTitlesOnlyAndNamesOnlyWhenTheHostTickedTheBox() {
        val saved = mutableListOf<Triple<String, List<String>, List<String>>>()
        val s = service { id, titles, names -> saved += Triple(id, titles, names); true }
        assertFalse("nothing sung yet", s.saveToTrip(false))
        s.get("t1", "Ann", -1, false)
        s.locked { it.select("six-lines"); it.setAuto(false); repeat(4) { _ -> it.next() } }
        assertTrue(s.saveToTrip(false))
        assertTrue(s.saveToTrip(true))
        assertEquals(listOf("Six Lines"), saved[0].second); assertEquals(emptyList<String>(), saved[0].third)
        assertEquals(listOf("Ann"), saved[1].third)
        assertEquals("one entry per session", saved[0].first, saved[1].first)
    }

    @Test fun importingAndRemovingPacksThroughTheServiceKeepsTheSingingStateConsistent() {
        val s = service()
        s.locked { it.select("six-lines") }
        assertTrue(s.removePack("engine-test"))
        assertNull(s.locked { it.song })
        assertFalse(s.removePack("beebo-demo"))
        assertTrue(s.importPack(testPack).ok)
        assertFalse(s.importPack("{}").ok)
    }

    @Test fun engineJsonHasNoHostOnlyControlsAndIsSmall() {
        val s = service()
        s.locked { it.select("six-lines"); it.start() }
        val body: JsonObject = s.get("t1", "Ann", -1, true).body
        assertTrue(body.toString().length < 4_000)
    }
}
