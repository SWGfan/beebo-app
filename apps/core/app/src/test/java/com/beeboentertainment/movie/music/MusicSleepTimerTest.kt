package com.beeboentertainment.movie.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MusicSleepTimerTest {

    @Test
    fun `starting a countdown sets the end point minutes from now`() {
        val state = MusicSleepTimer.start(minutes = 30, nowElapsedMs = 1_000L)
        assertEquals(MusicSleepTimerState.Countdown(1_000L + 30 * 60_000L), state)
    }

    @Test
    fun `remaining time counts down and floors at zero`() {
        val state = MusicSleepTimer.start(minutes = 15, nowElapsedMs = 0L)
        assertEquals(15 * 60_000L, MusicSleepTimer.remainingMs(state, nowElapsedMs = 0L))
        assertEquals(10 * 60_000L, MusicSleepTimer.remainingMs(state, nowElapsedMs = 5 * 60_000L))
        assertEquals(0L, MusicSleepTimer.remainingMs(state, nowElapsedMs = 999 * 60_000L))
    }

    @Test
    fun `off and end-of-track have no countdown remaining`() {
        assertEquals(0L, MusicSleepTimer.remainingMs(MusicSleepTimerState.Off, nowElapsedMs = 0L))
        assertEquals(0L, MusicSleepTimer.remainingMs(MusicSleepTimerState.EndOfTrack, nowElapsedMs = 0L))
    }

    @Test
    fun `a countdown has elapsed once its end point is reached, not before`() {
        val state = MusicSleepTimer.start(minutes = 1, nowElapsedMs = 0L)
        assertFalse(MusicSleepTimer.hasElapsed(state, nowElapsedMs = 59_999L))
        assertTrue(MusicSleepTimer.hasElapsed(state, nowElapsedMs = 60_000L))
        assertTrue(MusicSleepTimer.hasElapsed(state, nowElapsedMs = 999_999L))
    }

    @Test
    fun `off and end-of-track never elapse on their own`() {
        assertFalse(MusicSleepTimer.hasElapsed(MusicSleepTimerState.Off, nowElapsedMs = Long.MAX_VALUE))
        assertFalse(MusicSleepTimer.hasElapsed(MusicSleepTimerState.EndOfTrack, nowElapsedMs = Long.MAX_VALUE))
    }

    @Test
    fun `end-of-track stops there, a countdown or off do not`() {
        assertTrue(MusicSleepTimer.stopsAtTrackEnd(MusicSleepTimerState.EndOfTrack))
        assertFalse(MusicSleepTimer.stopsAtTrackEnd(MusicSleepTimerState.Off))
        assertFalse(MusicSleepTimer.stopsAtTrackEnd(MusicSleepTimer.start(30, 0L)))
    }

    @Test
    fun `off has no label`() {
        assertNull(MusicSleepTimer.label(MusicSleepTimerState.Off, nowElapsedMs = 0L))
    }

    @Test
    fun `end-of-track has a fixed label`() {
        assertEquals("Sleep · end of track", MusicSleepTimer.label(MusicSleepTimerState.EndOfTrack, nowElapsedMs = 0L))
    }

    @Test
    fun `a countdown labels itself with the time left, rounded up to the next second`() {
        val state = MusicSleepTimer.start(minutes = 1, nowElapsedMs = 0L)
        assertEquals("Sleep · 1:00", MusicSleepTimer.label(state, nowElapsedMs = 0L))
        // 30.001s left rounds up to 31s worth of display rather than flashing 0:00 early.
        assertEquals("Sleep · 0:31", MusicSleepTimer.label(state, nowElapsedMs = 29_999L))
        assertEquals("Sleep · 0:00", MusicSleepTimer.label(state, nowElapsedMs = 60_000L))
    }

    @Test
    fun `the duration menu offers 15, 30, 45 and 60 minutes in that order`() {
        assertEquals(listOf(15, 30, 45, 60), MusicSleepTimer.DURATIONS_MINUTES)
    }
}
