package com.beeboentertainment.auto.family

import com.beeboentertainment.movie.campsite.tripclock.KidUnit
import com.beeboentertainment.movie.campsite.tripclock.TripClockLogic
import com.beeboentertainment.movie.campsite.tripclock.TripClockState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.GregorianCalendar
import java.util.TimeZone

/**
 * The Trip Clock glance. The countdown is the phone app's own [TripClockLogic] (synced into this
 * build), so these tests also check the car reads the same numbers the phone does.
 */
class TripGlanceTest {

    private val toronto = TimeZone.getTimeZone("America/Toronto")
    private val la = TimeZone.getTimeZone("America/Los_Angeles")
    private val min = 60_000L
    private val t0 = 1_800_000_000_000L

    private fun at(zone: TimeZone, y: Int, mo: Int, d: Int, h: Int, mi: Int = 0): Long =
        GregorianCalendar(zone).apply { clear(); set(y, mo - 1, d, h, mi, 0) }.timeInMillis

    private fun running(lengthMin: Int, unit: GlanceUnit): TripClockState =
        TripClockLogic.start(t0, t0 + lengthMin * min, 0, KidUnit.NONE, 0).copy(kidUnit = unit.wire)

    // ---- the words ---------------------------------------------------------------------------------

    @Test
    fun `about three more movies`() {
        val g = TripGlance.glance(running(300, GlanceUnit.MOVIES), t0, toronto)
        assertEquals("About 3 more movies", g.title)
        assertTrue(g.running)
    }

    @Test
    fun `a few more songs`() {
        // 14 minutes is four songs.
        val g = TripGlance.glance(running(14, GlanceUnit.SONGS), t0, toronto)
        assertEquals("A few more songs", g.title)
    }

    @Test
    fun `movie phrases across the range`() {
        fun say(m: Int) = TripGlance.kidPhrase(m * min, GlanceUnit.MOVIES)
        assertEquals("Almost there!", say(4))
        assertEquals("Less than a movie to go", say(30))
        assertEquals("About 1 more movie", say(80))
        assertEquals("About 1 more movie", say(120))
        assertEquals("About 2 more movies", say(180))
        assertEquals("About 9 more movies", say(900))
        assertEquals("Lots more movies", say(1200))
    }

    @Test
    fun `episode and song phrases across the range`() {
        fun eps(m: Int) = TripGlance.kidPhrase(m * min, GlanceUnit.EPISODES)
        assertEquals("Less than an episode to go", eps(9))
        assertEquals("About 1 more episode", eps(20))
        assertEquals("About 3 more episodes", eps(66))
        assertEquals("Lots more episodes", eps(600))
        fun songs(m: Int) = TripGlance.kidPhrase(m * min, GlanceUnit.SONGS)
        assertEquals("Just 1 more song", songs(5))
        assertEquals("A few more songs", songs(10))
        assertEquals("A bunch more songs", songs(30))
        assertEquals("Lots more songs", songs(90))
    }

    @Test
    fun `plain time is available for a parent who does not want units`() {
        val g = TripGlance.glance(running(75, GlanceUnit.NONE), t0, toronto)
        assertEquals("About 1 hour 15 min to go", g.title)
        assertFalse("no repeat of the same time in the spoken line", g.spoken.contains("That is about"))
    }

    @Test
    fun `an unknown or old unit reads as movies`() {
        assertEquals(GlanceUnit.MOVIES, GlanceUnit.fromWire("something-else"))
        assertEquals(GlanceUnit.MOVIES, GlanceUnit.fromWire(null))
        assertEquals(GlanceUnit.SONGS, GlanceUnit.fromWire("songs"))
    }

    // ---- always an estimate ---------------------------------------------------------------------------

    @Test
    fun `every state carries the estimate only line`() {
        val states = listOf(
            TripClockState(),
            running(200, GlanceUnit.MOVIES),
            running(200, GlanceUnit.MOVIES).copy(arrivedAtMs = t0 + 10 * min),
        )
        states.forEachIndexed { i, s ->
            val now = if (i == 2) t0 + 20 * min else t0
            val g = TripGlance.glance(s, now, toronto)
            if (g.running) assertEquals(TripGlance.DISCLAIMER, g.subtitle)
            assertTrue("spoken line $i", g.spoken.contains("Estimate only. Use your navigation app for directions."))
        }
        // And late.
        val late = TripGlance.glance(running(30, GlanceUnit.MOVIES), t0 + 40 * min, toronto)
        assertEquals(TripGlance.DISCLAIMER, late.subtitle)
        assertTrue(late.spoken.endsWith(TripGlance.DISCLAIMER))
    }

    @Test
    fun `the disclaimer is the phone app's own wording, not a copy`() {
        assertEquals("Estimate only. Use your navigation app for directions.", TripGlance.DISCLAIMER)
        assertEquals("For passengers. Never for the driver.", TripGlance.PASSENGERS)
    }

    @Test
    fun `when it is not running the glance says so and never invents a time`() {
        val g = TripGlance.glance(TripClockState(), t0, toronto)
        assertFalse(g.running)
        assertEquals("Trip Clock is not running", g.title)
        assertFalse(g.title.any { it.isDigit() })
    }

    @Test
    fun `arriving says you are here, and running late never does`() {
        val arrived = running(60, GlanceUnit.MOVIES).copy(arrivedAtMs = t0 + 50 * min)
        assertEquals("You're here!", TripGlance.glance(arrived, t0 + 55 * min, toronto).title)
        val late = TripGlance.glance(running(60, GlanceUnit.MOVIES), t0 + 75 * min, toronto)
        assertEquals("A little longer than planned", late.title)
        assertFalse(late.spoken.contains("here"))
    }

    @Test
    fun `plus fifteen minutes from the phone app's logic moves the words`() {
        val s = running(100, GlanceUnit.MOVIES)
        assertEquals("About 1 more movie", TripGlance.glance(s, t0, toronto).title)
        val pushed = TripClockLogic.adjust(TripClockLogic.adjust(s, 15, t0), 15, t0)
        assertEquals("About 1 more movie", TripGlance.glance(pushed, t0, toronto).title) // 130 min
        val more = TripClockLogic.adjust(TripClockLogic.adjust(pushed, 15, t0), 15, t0)
        assertEquals("About 2 more movies", TripGlance.glance(more, t0, toronto).title) // 160 min
    }

    // ---- same numbers as the phone -----------------------------------------------------------------------

    @Test
    fun `the car and the phone agree on the time left`() {
        val s = running(140, GlanceUnit.EPISODES)
        val view = TripClockLogic.view(s, t0 + 70 * min, toronto)
        assertEquals("1 hour 10 min", view.leftText)
        assertEquals("1 hour 10 min", TripGlance.timeLeftText(s, t0 + 70 * min, toronto))
        assertTrue(TripGlance.glance(s, t0 + 70 * min, toronto).spoken.contains("about 1 hour 10 min"))
    }

    @Test
    fun `a trip across the spring clock change counts real time`() {
        // Leave Toronto at 1:00 am on the night the clocks jump forward; arrive at 4:00 am. Two real hours, not three.
        val leave = at(toronto, 2026, 3, 8, 1, 0)
        val eta = at(toronto, 2026, 3, 8, 4, 0)
        assertEquals(2 * 60 * min, eta - leave)
        val s = TripClockLogic.start(leave, eta, 0, KidUnit.NONE, 0).copy(kidUnit = GlanceUnit.MOVIES.wire)
        assertEquals("About 1 more movie", TripGlance.glance(s, leave, toronto).title) // 120 minutes
        assertEquals("2 hours", TripGlance.timeLeftText(s, leave, toronto))
    }

    @Test
    fun `a phone that changes time zone does not change how long is left`() {
        val s = running(180, GlanceUnit.MOVIES)
        val inToronto = TripGlance.glance(s, t0 + 30 * min, toronto)
        val inLosAngeles = TripGlance.glance(s, t0 + 30 * min, la)
        assertEquals(inToronto.title, inLosAngeles.title)
        assertEquals(inToronto.spoken, inLosAngeles.spoken)
    }

    @Test
    fun `the glance never carries a coordinate, a name or a route`() {
        // The saved state has no field for any of them: a place cannot reach the car by accident.
        val fields = TripClockState::class.java.declaredFields.map { it.name.lowercase() }
        listOf("lat", "lon", "location", "coord", "route", "name", "address", "gps").forEach { bad ->
            assertFalse("field containing $bad", fields.any { it.contains(bad) })
        }
    }
}
