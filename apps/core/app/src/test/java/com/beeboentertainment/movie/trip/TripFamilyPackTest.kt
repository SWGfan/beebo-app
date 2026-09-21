package com.beeboentertainment.movie.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Trip Journal's Family Pack A moments: plate and sign tallies, the trip clock's arrival and stops. */
class TripFamilyPackTest {

    private val hour = 3_600_000L

    private fun running(): TripBook =
        TripLogic.start(TripBook(), "t1", "Lake", 100 * hour, emptyList(), emptySet(), PackingSnapshot())

    @Test
    fun `a tally is kept once per round on the running trip and never with a location`() {
        val tally = TallyResult("r1", "Plate hunt", "Spotted 34 of 64 jurisdictions", 34, 64, listOf("Ann", "ann", " Ben "))
        val once = TripLogic.recordTally(running(), tally, 101 * hour)
        val twice = TripLogic.recordTally(once, tally.copy(text = "Spotted 40 of 64 jurisdictions"), 102 * hour)
        val moments = twice.active!!.moments.filter { it.kind == MomentKind.TALLY }
        assertEquals(1, moments.size)
        assertEquals("Spotted 40 of 64 jurisdictions", moments.single().text)
        assertEquals("names are de-duplicated like every other moment", listOf("Ann", "Ben"), moments.single().names)
        assertNull(moments.single().lat)
        assertNull(moments.single().lng)
    }

    @Test
    fun `a tally with nothing to count, or with no trip, changes nothing`() {
        val book = running()
        assertSame(book, TripLogic.recordTally(book, TallyResult("r", "Plate hunt", "x", 0, 0), 1L))
        val none = TripBook()
        assertEquals(none, TripLogic.recordTally(none, TallyResult("r", "Plate hunt", "Spotted 1 of 2", 1, 2), 1L))
    }

    @Test
    fun `arrival is written once and keeps its first time and the trip keeps running`() {
        val first = TripLogic.recordArrival(running(), 110 * hour)
        val second = TripLogic.recordArrival(first, 120 * hour)
        val arrived = second.active!!.moments.filter { it.kind == MomentKind.ARRIVED }
        assertEquals(1, arrived.size)
        assertEquals(110 * hour, arrived.single().at)
        assertTrue(second.active!!.running)
        assertEquals(TripBook(), TripLogic.recordArrival(TripBook(), 1L))
    }

    @Test
    fun `a stop is cleaned, keeps its own time and only carries a position when the trip opted in`() {
        val book = running()
        val plain = TripLogic.recordStop(book, StopResult("a", " Snack stop ", 105 * hour, 1.0, 2.0), 106 * hour)
        val stop = plain.active!!.moments.single { it.kind == MomentKind.STOP }
        assertEquals("Snack stop", stop.title)
        assertEquals(105 * hour, stop.at)
        assertNull(stop.lat)
        assertNull(stop.lng)

        val opted = TripLogic.recordStop(TripLogic.setSaveLocation(book, true), StopResult("b", "Fuel", 0L, 3.0, 4.0), 107 * hour)
        val fuel = opted.active!!.moments.single { it.kind == MomentKind.STOP }
        assertEquals(107 * hour, fuel.at) // no time given: now
        assertEquals(3.0, fuel.lat!!, 0.0)
        // A stop with only one coordinate is not a position.
        val half = TripLogic.recordStop(TripLogic.setSaveLocation(book, true), StopResult("c", "Half", 1L, 3.0, null), 1L)
        assertNull(half.active!!.moments.single { it.kind == MomentKind.STOP }.lat)
    }

    @Test
    fun `the moment kinds are the wire strings the saved trips use`() {
        assertEquals("tally", MomentKind.TALLY)
        assertEquals("arrived", MomentKind.ARRIVED)
        assertEquals("stop", MomentKind.STOP)
        // The existing kinds did not change.
        assertEquals(listOf("departed", "home", "story", "hunt"), listOf(MomentKind.DEPARTED, MomentKind.HOME, MomentKind.STORY, MomentKind.HUNT))
    }
}
