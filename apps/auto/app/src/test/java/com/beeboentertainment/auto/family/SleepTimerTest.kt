package com.beeboentertainment.auto.family

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sleep timer: fade, then silence, then nothing plays again. Driven by a fake clock. */
class SleepTimerTest {

    private val min = 60_000L
    private val t0 = 5_000_000L

    @Test
    fun `volume stays full until the last minute then falls in a straight line to nothing`() {
        val s = SleepTimerLogic.start(t0, 30)
        assertEquals(t0 + 30 * min, s.endAtMs)
        assertEquals(1f, SleepTimerLogic.volumeAt(s, t0), 0f)
        assertEquals(1f, SleepTimerLogic.volumeAt(s, t0 + 29 * min), 0f)
        assertEquals(0.5f, SleepTimerLogic.volumeAt(s, t0 + 29 * min + 30_000), 0.001f)
        assertEquals(0.25f, SleepTimerLogic.volumeAt(s, t0 + 29 * min + 45_000), 0.001f)
        assertEquals(0f, SleepTimerLogic.volumeAt(s, t0 + 30 * min), 0f)
        assertEquals(0f, SleepTimerLogic.volumeAt(s, t0 + 31 * min), 0f)
    }

    @Test
    fun `the volume never rises while it fades`() {
        val s = SleepTimerLogic.start(t0, 15)
        var last = 1f
        var now = t0
        while (now <= s.endAtMs + 5_000) {
            val v = SleepTimerLogic.volumeAt(s, now)
            assertTrue("$v after $last", v <= last + 1e-6f)
            assertTrue(v in 0f..1f)
            last = v
            now += 1_000
        }
    }

    @Test
    fun `a short timer fades over a fifth of its length`() {
        val s = SleepTimerLogic.start(t0, 1)
        assertEquals(12_000L, SleepTimerLogic.fadeMs(s))
        assertEquals(1f, SleepTimerLogic.volumeAt(s, t0 + 40_000), 0f)
        assertTrue(SleepTimerLogic.volumeAt(s, t0 + 54_000) < 1f)
        assertEquals(60_000L, SleepTimerLogic.fadeMs(SleepTimerLogic.start(t0, 45)))
    }

    @Test
    fun `when the time is up it stops, and it keeps saying stop`() {
        val s = SleepTimerLogic.start(t0, 15)
        assertFalse(SleepTimerLogic.tick(s, t0 + 14 * min).stop)
        assertFalse(SleepTimerLogic.tick(s, t0 + 15 * min - 1).stop)
        val done = SleepTimerLogic.tick(s, t0 + 15 * min)
        assertTrue(done.stop)
        assertEquals(0f, done.volume, 0f)
        // A late tick (the phone was asleep) still only ever says stop: nothing can start playing.
        assertTrue(SleepTimerLogic.tick(s, t0 + 6 * 60 * min).stop)
        assertEquals(0f, SleepTimerLogic.tick(s, t0 + 6 * 60 * min).volume, 0f)
    }

    @Test
    fun `remaining time is counted from the start and never below zero`() {
        val s = SleepTimerLogic.start(t0, 20)
        assertEquals(20 * min, SleepTimerLogic.remainingMs(s, t0))
        assertEquals(5 * min, SleepTimerLogic.remainingMs(s, t0 + 15 * min))
        assertEquals(0L, SleepTimerLogic.remainingMs(s, t0 + 99 * min))
        assertTrue(SleepTimerLogic.expired(s, t0 + 20 * min))
        assertFalse(SleepTimerLogic.expired(s, t0 + 20 * min - 1))
    }

    @Test
    fun `durations are limited to something sensible`() {
        assertEquals(1 * min, SleepTimerLogic.start(t0, 0).durationMs)
        assertEquals(180 * min, SleepTimerLogic.start(t0, 100_000).durationMs)
    }

    @Test
    fun `the one car button cycles off, 15, 30, 45, off`() {
        assertEquals(15, SleepTimerLogic.nextChoice(null, t0))
        assertEquals(30, SleepTimerLogic.nextChoice(SleepTimerLogic.start(t0, 15), t0 + min))
        assertEquals(45, SleepTimerLogic.nextChoice(SleepTimerLogic.start(t0, 30), t0 + min))
        assertNull(SleepTimerLogic.nextChoice(SleepTimerLogic.start(t0, 45), t0 + min))
        // An expired timer counts as off, so the next press starts a fresh one.
        assertEquals(15, SleepTimerLogic.nextChoice(SleepTimerLogic.start(t0, 45), t0 + 46 * min))
        // A timer of some other length (the quiet-hours default) goes back to the first choice.
        assertEquals(15, SleepTimerLogic.nextChoice(SleepTimerLogic.start(t0, 20), t0 + min))
    }

    @Test
    fun `the label says what is left`() {
        val s = SleepTimerLogic.start(t0, 30)
        assertEquals("Off", SleepTimerLogic.label(null, t0))
        assertEquals("30 min left", SleepTimerLogic.label(s, t0))
        assertEquals("10 min left", SleepTimerLogic.label(s, t0 + 20 * min))
        assertEquals("under a minute left", SleepTimerLogic.label(s, t0 + 30 * min - 30_000))
        assertEquals("Off", SleepTimerLogic.label(s, t0 + 31 * min))
    }

    @Test
    fun `nothing about the timer depends on the wall clock`() {
        // The state is two numbers. Any steadily increasing clock works, which is why the service uses elapsed time.
        val a = SleepTimerLogic.start(0L, 15)
        val b = SleepTimerLogic.start(9_000_000_000L, 15)
        assertEquals(a.durationMs, b.durationMs)
        assertEquals(SleepTimerLogic.volumeAt(a, 14 * min + 30_000), SleepTimerLogic.volumeAt(b, 9_000_000_000L + 14 * min + 30_000), 0f)
    }
}
