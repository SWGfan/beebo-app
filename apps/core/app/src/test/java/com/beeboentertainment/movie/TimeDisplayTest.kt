package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.MemoryKeyValueStore
import com.beeboentertainment.movie.core.TimeRemainingLabel
import com.beeboentertainment.movie.core.TimeRemainingSetting
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The player's "show time remaining" toggle: the duration-label formatting and the
 * remembered-across-videos setting behind it.
 */
class TimeDisplayTest {

    /* ------------------------------ the toggle ------------------------------ */

    @Test
    fun `off by default, like every player's first launch`() {
        val s = TimeRemainingSetting(MemoryKeyValueStore())
        assertFalse(s.enabled)
        assertFalse(TimeRemainingSetting.DEFAULT)
    }

    @Test
    fun `turning it on is remembered across videos and sessions`() {
        val store = MemoryKeyValueStore()
        TimeRemainingSetting(store).enabled = true
        // a brand new setting object over the same store == a later video, or a later app launch
        assertTrue(TimeRemainingSetting(store).enabled)
    }

    @Test
    fun `turning it back off is remembered too`() {
        val store = MemoryKeyValueStore()
        val s = TimeRemainingSetting(store)
        s.enabled = true
        s.enabled = false
        assertFalse(TimeRemainingSetting(store).enabled)
    }

    @Test
    fun `toggle flips and returns the new state`() {
        val s = TimeRemainingSetting(MemoryKeyValueStore())
        assertTrue(s.toggle())
        assertTrue(s.enabled)
        assertFalse(s.toggle())
        assertFalse(s.enabled)
    }

    @Test
    fun `the storage key is stable so nobody's preference silently resets`() {
        assertEquals("show_time_remaining", TimeRemainingSetting.KEY)
    }

    /* ------------------------------ the label -------------------------------- */

    @Test
    fun `off shows the total length, exactly like Media3's own default`() {
        assertEquals("58:50", TimeRemainingLabel.forDuration(durationMs = 3_530_000L, positionMs = 600_000L, showRemaining = false))
    }

    @Test
    fun `on shows a negative countdown to the end`() {
        // 58:50 total, 13:34 in -> 45:16 left
        assertEquals(
            "-45:16",
            TimeRemainingLabel.forDuration(durationMs = 3_530_000L, positionMs = 814_000L, showRemaining = true)
        )
    }

    @Test
    fun `right at the start, remaining is the full length`() {
        assertEquals("-58:50", TimeRemainingLabel.forDuration(3_530_000L, 0L, showRemaining = true))
    }

    @Test
    fun `right at the end, remaining floors at zero rather than going negative twice`() {
        assertEquals("-0:00", TimeRemainingLabel.forDuration(3_530_000L, 3_530_000L, showRemaining = true))
        assertEquals("-0:00", TimeRemainingLabel.forDuration(3_530_000L, 9_000_000L, showRemaining = true))
    }

    @Test
    fun `an unknown duration falls back to the plain zero, never a misleading negative`() {
        assertEquals("0:00", TimeRemainingLabel.forDuration(0L, 0L, showRemaining = true))
        assertEquals("0:00", TimeRemainingLabel.forDuration(-1L, 0L, showRemaining = true))
    }

    @Test
    fun `hour-long runtimes use the h-mm-ss form, same as formatMs elsewhere`() {
        // 5,025,000 ms = 1h 23m 45s (same figure ResumeStoreTest uses for formatMs itself).
        assertEquals("1:23:45", TimeRemainingLabel.forDuration(5_025_000L, 0L, showRemaining = false))
        assertEquals("-1:23:45", TimeRemainingLabel.forDuration(5_025_000L, 0L, showRemaining = true))
    }
}
