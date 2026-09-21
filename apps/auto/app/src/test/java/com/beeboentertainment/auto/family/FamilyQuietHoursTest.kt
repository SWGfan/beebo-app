package com.beeboentertainment.auto.family

import com.beeboentertainment.movie.campsite.quiet.QuietHours
import com.beeboentertainment.movie.campsite.quiet.QuietSettings
import com.beeboentertainment.movie.campsite.tripclock.TripClockState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.GregorianCalendar
import java.util.TimeZone

/**
 * Quiet hours as the car sees them. The window arithmetic itself is the phone app's own code, synced
 * into this build (see build.gradle.kts), so these tests also prove the shared code compiles and
 * behaves here: across midnight, across time zones, and across a daylight-saving change.
 */
class FamilyQuietHoursTest {

    private val toronto = TimeZone.getTimeZone("America/Toronto")
    private val sydney = TimeZone.getTimeZone("Australia/Sydney")
    private val night = QuietSettings(enabled = true, startMinute = 22 * 60, endMinute = 6 * 60)

    private fun at(zone: TimeZone, y: Int, mo: Int, d: Int, h: Int, mi: Int = 0): Long =
        GregorianCalendar(zone).apply { clear(); set(y, mo - 1, d, h, mi, 0) }.timeInMillis

    private fun env(now: Long, zone: TimeZone, q: QuietSettings = night, handsFree: Boolean = true) = FamilyEnv(
        nowMs = now, zone = zone, quietSettings = q, ageBand = AgeBand.MIDDLE,
        clock = TripClockState(), handsFreeGamesOk = handsFree,
    )

    @Test
    fun `a window that crosses midnight is quiet on both sides of midnight`() {
        assertTrue(env(at(toronto, 2026, 7, 10, 22, 0), toronto).quiet)
        assertTrue(env(at(toronto, 2026, 7, 10, 23, 59), toronto).quiet)
        assertTrue(env(at(toronto, 2026, 7, 11, 0, 0), toronto).quiet)
        assertTrue(env(at(toronto, 2026, 7, 11, 5, 59), toronto).quiet)
        assertFalse(env(at(toronto, 2026, 7, 11, 6, 0), toronto).quiet)
        assertFalse(env(at(toronto, 2026, 7, 10, 21, 59), toronto).quiet)
        assertFalse(env(at(toronto, 2026, 7, 10, 14, 0), toronto).quiet)
    }

    @Test
    fun `quiet hours that are switched off are never quiet`() {
        assertFalse(env(at(toronto, 2026, 7, 10, 23, 0), toronto, night.copy(enabled = false)).quiet)
        assertFalse("an empty window is never quiet", env(at(toronto, 2026, 7, 10, 23, 0), toronto, night.copy(startMinute = 600, endMinute = 600)).quiet)
    }

    @Test
    fun `the same instant is quiet or not depending on the zone the phone is in`() {
        val instant = at(toronto, 2026, 7, 10, 23, 30) // 11:30 pm in Toronto is 1:30 pm the next day in Sydney
        assertTrue(env(instant, toronto).quiet)
        assertFalse(env(instant, sydney).quiet)
    }

    @Test
    fun `the window is wall-clock time across a daylight saving change`() {
        // Toronto springs forward on 2026-03-08 at 2 am: the night of the 7th-8th is an hour shorter.
        assertTrue(env(at(toronto, 2026, 3, 8, 5, 30), toronto).quiet)
        assertFalse(env(at(toronto, 2026, 3, 8, 6, 30), toronto).quiet)
        // Autumn: the clocks go back on 2026-11-01, and 5:30 am is still inside a window that ends at 6.
        assertTrue(env(at(toronto, 2026, 11, 1, 5, 30), toronto).quiet)
        assertFalse(env(at(toronto, 2026, 11, 1, 6, 30), toronto).quiet)
    }

    @Test
    fun `the shared quiet status says when it flips`() {
        val now = at(toronto, 2026, 7, 10, 23, 0)
        val status = QuietHours.status(night, now, toronto)
        assertNotNull(status)
        assertTrue(status!!.active)
        assertEquals(at(toronto, 2026, 7, 11, 6, 0), status.changeAtMs)
        assertNull(QuietHours.status(night.copy(enabled = false), now, toronto))
    }

    // ---- what quiet hours do to Family Fun ----------------------------------------------------------

    @Test
    fun `during quiet hours a game cannot be started even with hands-free on`() {
        val quietNow = env(at(toronto, 2026, 7, 10, 23, 0), toronto, handsFree = true)
        assertTrue(quietNow.quiet)
        val queue = FamilyScripts.gameQueue(
            GameKind.ALPHABET, 5, quietNow, FamilyGate.Surface.CAR_MEDIA_BROWSER, FamilyRuntime.WORST_CASE,
        )
        assertTrue(queue.isEmpty())
        val rows = FamilyMenu.games(quietNow)
        assertEquals(1, rows.size)
        assertEquals(FamilyIds.NOTE, rows[0].id)
        assertEquals(FamilyGate.CAR_NOTE_QUIET, rows[0].title)
    }

    @Test
    fun `quiet hours that begin in the middle of a queue stop the next round from being spoken`() {
        val id = FamilyIds.round(GameKind.SOUND, 3, 2, AgeBand.MIDDLE)
        val daytime = env(at(toronto, 2026, 7, 10, 15, 0), toronto)
        val bedtime = env(at(toronto, 2026, 7, 10, 22, 30), toronto)
        assertNotNull(FamilyScripts.forPlayback(id, daytime))
        assertNull(FamilyScripts.forPlayback(id, bedtime))
    }

    @Test
    fun `a story in quiet hours is read slowly with longer pauses`() {
        val story = Stories.ALL.first()
        val id = FamilyIds.storyPart(story.id, 0)
        val day = FamilyScripts.forPlayback(id, env(at(toronto, 2026, 7, 10, 15, 0), toronto))!!
        val evening = FamilyScripts.forPlayback(id, env(at(toronto, 2026, 7, 10, 22, 30), toronto))!!
        assertEquals(FamilyScripts.RATE_NORMAL, day.speechRate, 0f)
        assertEquals(FamilyScripts.RATE_CALM, evening.speechRate, 0f)
        assertTrue(evening.speechRate < day.speechRate)
        assertTrue(evening.script.pauseMs > day.script.pauseMs)
        assertEquals("same words", day.script.spokenText, evening.script.spokenText)
    }

    @Test
    fun `the trip clock glance is available in quiet hours`() {
        val row = FamilyMenu.root(env(at(toronto, 2026, 7, 10, 23, 0), toronto)).first { it.id == FamilyIds.CLOCK }
        assertTrue(row.playable)
    }

    @Test
    fun `the default sleep timer for a quiet-hours story is twenty minutes`() {
        assertEquals(20, SleepTimerLogic.QUIET_HOURS_DEFAULT_MINUTES)
    }
}
