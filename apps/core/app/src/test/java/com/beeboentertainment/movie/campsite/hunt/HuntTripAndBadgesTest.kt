package com.beeboentertainment.movie.campsite.hunt

import android.content.SharedPreferences
import com.beeboentertainment.movie.badges.BADGES
import com.beeboentertainment.movie.badges.BadgeInputs
import com.beeboentertainment.movie.badges.BadgeStore
import com.beeboentertainment.movie.badges.badgeEarned
import com.beeboentertainment.movie.recap.TripRecapBuilder
import com.beeboentertainment.movie.trip.HuntFind
import com.beeboentertainment.movie.trip.MomentKind
import com.beeboentertainment.movie.trip.PackingSnapshot
import com.beeboentertainment.movie.trip.SlideKind
import com.beeboentertainment.movie.trip.TallyResult
import com.beeboentertainment.movie.trip.TripBook
import com.beeboentertainment.movie.trip.TripLogic
import com.beeboentertainment.movie.trip.TripSlides
import com.beeboentertainment.movie.trip.TripStore
import com.beeboentertainment.movie.trip.TripStoreSink
import com.beeboentertainment.movie.trip.TripSummaryBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a finished hunt leaves in the Trip Journal (a `hunt` moment, counts only) and in the badge counters. */
class HuntTripAndBadgesTest {

    private val hour = 3_600_000L

    private fun running(): TripBook =
        TripLogic.start(TripBook(), "t1", "Lake", 100 * hour, emptyList(), emptySet(), PackingSnapshot())

    private val tally = TallyResult(
        id = "hunt-1000", title = "Scavenger hunt: Camp Basics",
        text = "Scavenger hunt: Camp Basics, best list 5 of 8 items (2 players)", found = 5, total = 8, names = listOf("Ann", "ann", " Ben "),
    )

    // ---- the trip moment -------------------------------------------------------------------

    @Test fun aFinishedHuntIsOneHuntMomentWithCountsAndNoLocation() {
        val once = TripLogic.recordHuntCard(running(), tally, 101 * hour)
        val moment = once.active!!.moments.single { it.kind == MomentKind.HUNT }
        assertEquals("hunt", moment.kind)
        assertTrue(moment.id.startsWith(TripLogic.HUNT_CARD_PREFIX))
        assertEquals(tally.text, moment.text)
        assertEquals(listOf("Ann", "Ben"), moment.names)
        assertNull(moment.lat); assertNull(moment.lng)
        // Asking again updates it in place and keeps the first time.
        val twice = TripLogic.recordHuntCard(once, tally.copy(text = "Scavenger hunt: Camp Basics, best list 6 of 8 items (2 players)", found = 6), 105 * hour)
        val moments = twice.active!!.moments.filter { it.kind == MomentKind.HUNT }
        assertEquals(1, moments.size)
        assertEquals(101 * hour, moments.single().at)
        assertTrue(moments.single().text.contains("6 of 8"))
    }

    @Test fun nothingIsKeptWithNoTripOrNothingFound() {
        val book = running()
        assertSame(book, TripLogic.recordHuntCard(book, tally.copy(found = 0), 1L))
        assertSame(book, TripLogic.recordHuntCard(book, tally.copy(total = 0), 1L))
        val none = TripBook()
        assertEquals(none, TripLogic.recordHuntCard(none, tally, 1L))
    }

    @Test fun aHuntMomentDoesNotChangeTheGpsWaypointWordsInTheRecap() {
        val book = TripLogic.recordHunt(TripLogic.recordHuntCard(running(), tally, 101 * hour), listOf(HuntFind("w1", "Big rock", "Kit")), 102 * hour)
        val trip = book.active!!
        assertEquals(2, trip.moments.count { it.kind == MomentKind.HUNT })
        val summary = TripSummaryBuilder.build(trip, emptyList(), emptyList(), emptySet(), now = 200 * hour)
        assertEquals("only the waypoint is a waypoint", listOf("Big rock"), summary.hunt.map { it.title })
        assertEquals(1, summary.huntCards.size)
        assertFalse(summary.isEmpty)

        val slide = TripSlides.build(summary, emptyList(), now = 200 * hour).single { it.kind == SlideKind.HUNT }
        assertEquals("1 hunt played · 1 waypoint found", slide.subtitle)
        assertTrue(slide.lines.first().contains("best list 5 of 8"))
        assertTrue(slide.lines.any { it.contains("Big rock") && it.contains("found by Kit") })

        val recap = TripRecapBuilder.buildForTrip(summary, now = 200 * hour).stats.joinToString("\n") { it.text }
        assertTrue(recap, recap.contains("Scavenger hunt: 1 waypoint found"))
        assertTrue(recap, recap.contains("best list 5 of 8 items (2 players)"))
    }

    @Test fun aTripWithOnlyAHuntCardStillGetsItsSlideAndIsNotEmpty() {
        val trip = TripLogic.recordHuntCard(running(), tally, 101 * hour).active!!
        val summary = TripSummaryBuilder.build(trip, emptyList(), emptyList(), emptySet(), now = 200 * hour)
        assertTrue(summary.hunt.isEmpty())
        val slide = TripSlides.build(summary, emptyList(), now = 200 * hour).single { it.kind == SlideKind.HUNT }
        assertEquals("1 hunt played", slide.subtitle)
    }

    @Test fun theRealSinkKeepsTheHuntOnARunningTripAndDoesNothingWithoutOne() {
        val disk = com.beeboentertainment.movie.trip.MemoryTripPersistence()
        val store = TripStore(disk, clock = { 5_000L }, newId = { "t1" })
        val sink = TripStoreSink(store)
        sink.huntCard(tally)
        assertNull(disk.text)
        store.start("Lake", emptyList(), emptySet(), PackingSnapshot())
        sink.huntCard(tally)
        assertEquals(1, store.active()!!.moments.count { it.kind == MomentKind.HUNT })
    }

    // ---- badges ----------------------------------------------------------------------------

    @Test fun twoBadgesWereAddedAtTheEndAndNoExistingIdChanged() {
        val ids = BADGES.map { it.id }
        assertEquals(listOf("first_movie", "trivia_5", "packed", "bingo", "veteran", "plate_spotter_20", "alphabet_complete", "quiet_hero"), ids.take(8))
        assertTrue("sharp_eyes" in ids && "full_card" in ids)
        assertEquals(ids.size, ids.toSet().size)
        val none = BadgeInputs(0, 0, false, false, 0)
        assertFalse(badgeEarned("sharp_eyes", none)); assertFalse(badgeEarned("full_card", none))
        assertFalse(badgeEarned("sharp_eyes", none.copy(huntItems = 29)))
        assertTrue(badgeEarned("sharp_eyes", none.copy(huntItems = 30)))
        assertTrue(badgeEarned("full_card", none.copy(huntComplete = true)))
        // Wording: our own, no protected names.
        BADGES.filter { it.id == "sharp_eyes" || it.id == "full_card" }.forEach {
            assertFalse(it.title.lowercase().contains("ranger") || it.title.lowercase().contains("scout"))
        }
    }

    private class MemoryPrefs : SharedPreferences {
        val map = HashMap<String, Any?>()
        override fun getAll(): MutableMap<String, *> = map
        override fun getString(key: String?, defValue: String?): String? = map[key] as String? ?: defValue
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = defValues
        override fun getInt(key: String?, defValue: Int): Int = map[key] as Int? ?: defValue
        override fun getLong(key: String?, defValue: Long): Long = map[key] as Long? ?: defValue
        override fun getFloat(key: String?, defValue: Float): Float = map[key] as Float? ?: defValue
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = map[key] as Boolean? ?: defValue
        override fun contains(key: String?): Boolean = map.containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun edit(): SharedPreferences.Editor = MemoryEditor(map)
    }

    private class MemoryEditor(private val map: HashMap<String, Any?>) : SharedPreferences.Editor {
        override fun putString(key: String?, value: String?): SharedPreferences.Editor { map[key!!] = value; return this }
        override fun putStringSet(key: String?, values: MutableSet<String>?): SharedPreferences.Editor { map[key!!] = values; return this }
        override fun putInt(key: String?, value: Int): SharedPreferences.Editor { map[key!!] = value; return this }
        override fun putLong(key: String?, value: Long): SharedPreferences.Editor { map[key!!] = value; return this }
        override fun putFloat(key: String?, value: Float): SharedPreferences.Editor { map[key!!] = value; return this }
        override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor { map[key!!] = value; return this }
        override fun remove(key: String?): SharedPreferences.Editor { map.remove(key); return this }
        override fun clear(): SharedPreferences.Editor { map.clear(); return this }
        override fun commit(): Boolean = true
        override fun apply() {}
    }

    @Test fun finishedHuntsAddToTwoSmallCountersAndNothingElseIsKept() {
        val prefs = MemoryPrefs()
        BadgeStore.recordHuntRound(prefs, found = 12, complete = false)
        BadgeStore.recordHuntRound(prefs, found = 20, complete = true)
        BadgeStore.recordHuntRound(prefs, found = 0, complete = false)
        assertEquals(32, prefs.map["badge_hunt_items_v1"])
        assertEquals(true, prefs.map["badge_hunt_complete_v1"])
        assertEquals("only two keys were written", setOf("badge_hunt_items_v1", "badge_hunt_complete_v1"), prefs.map.keys)
        // The complete flag latches: a later plain hunt does not clear it.
        BadgeStore.recordHuntRound(prefs, found = 3, complete = false)
        assertEquals(true, prefs.map["badge_hunt_complete_v1"])
        // The sink passes the round through and never throws into a hunt.
        val sink = HuntPrefsBadgeSink(prefs)
        sink.finished(10, false)
        assertEquals(45, prefs.map["badge_hunt_items_v1"])
        HuntPrefsBadgeSink(object : SharedPreferences by prefs {
            override fun edit(): SharedPreferences.Editor = error("prefs unavailable")
        }).finished(1, true)
    }

    // ---- what a hunt record is allowed to say ----------------------------------------------

    @Test fun theTripLineNeverCarriesItemWordsOrGuestTextBeyondNicknames() {
        val card = HuntCards.CAMP_BASICS
        val pick = HuntSelector.select(card, HuntBand.MIDDLE, 8, kotlin.random.Random(1)).getOrThrow()
        val session = HuntSession(HuntSettings(), card, pick.items, 0, "p", 1_000L)
        session.join("t", "Ann", 1_000L); session.start(1_000L)
        session.tick("t", pick.items.first().id, 1_001L)
        session.end(1_002L)
        val line = HuntRecords.tally(session, session.rows(), listOf("Ann"))!!
        assertEquals(1, line.found); assertEquals(8, line.total)
        card.items.forEach { assertFalse(line.text.contains(it.text)); assertFalse(line.title.contains(it.text)) }
        assertEquals(listOf("Ann"), line.names)
        assertNull(HuntRecords.tally(HuntSession(HuntSettings(), card, pick.items, 0, "p", 5L), emptyList(), emptyList()))
    }
}
