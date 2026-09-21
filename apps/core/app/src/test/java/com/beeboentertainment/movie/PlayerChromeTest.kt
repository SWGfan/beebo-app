package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.ChromeVisibilityModel
import com.beeboentertainment.movie.core.PlayerChromePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The player's custom chrome (top bar, surf row) must behave like ordinary video controls:
 * up on touch, gone after ~3 seconds of playing untouched, back on any touch, and never stuck.
 */
class PlayerChromeTest {

    /** Fake clock so the whole timeline runs headlessly. */
    private var now = 0L
    private fun model() = ChromeVisibilityModel { now }

    /* -------------------------------- policy -------------------------------- */

    @Test
    fun `the timeout is three seconds, as asked for`() {
        assertEquals(3_000L, PlayerChromePolicy.HIDE_TIMEOUT_MS)
    }

    @Test
    fun `chrome follows the player controller, except that up next overrides it`() {
        assertTrue(PlayerChromePolicy.shouldShowChrome(controllerVisible = true, upNextShowing = false))
        assertFalse(PlayerChromePolicy.shouldShowChrome(controllerVisible = false, upNextShowing = false))
        // the up-next card carries a countdown, so nothing fades out from under it
        assertTrue(PlayerChromePolicy.shouldShowChrome(controllerVisible = false, upNextShowing = true))
    }

    @Test
    fun `a hide is only ever scheduled while actually playing`() {
        assertTrue(PlayerChromePolicy.shouldScheduleHide(isPlaying = true, upNextShowing = false))
        assertFalse(PlayerChromePolicy.shouldScheduleHide(isPlaying = false, upNextShowing = false))
        assertFalse(PlayerChromePolicy.shouldScheduleHide(isPlaying = true, upNextShowing = true))

        assertEquals(3_000L, PlayerChromePolicy.hideDelayMs(isPlaying = true, upNextShowing = false))
        assertNull(PlayerChromePolicy.hideDelayMs(isPlaying = false, upNextShowing = false))
        assertNull(PlayerChromePolicy.hideDelayMs(isPlaying = true, upNextShowing = true))
    }

    /* ------------------------------- timeline ------------------------------- */

    @Test
    fun `chrome starts visible with nothing scheduled`() {
        val m = model()
        assertTrue(m.chromeVisible)
        assertFalse(m.hidePending)
        assertNull(m.msUntilHide())
    }

    @Test
    fun `playing then three seconds untouched hides it`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        assertTrue(m.chromeVisible)
        assertTrue(m.hidePending)

        now = 4_000
        assertEquals(0L, m.msUntilHide())
        m.onHideTimerFired()
        assertFalse(m.chromeVisible)      // this is the bug that was reported: it never happened
        assertFalse(m.hidePending)
    }

    @Test
    fun `the countdown counts down`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        now = 2_000
        assertEquals(2_000L, m.msUntilHide())
        now = 3_500
        assertEquals(500L, m.msUntilHide())
        now = 9_999
        assertEquals(0L, m.msUntilHide())   // clamped, never negative
    }

    @Test
    fun `paused keeps the controls up indefinitely`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        now = 4_000
        m.onHideTimerFired()
        assertFalse(m.chromeVisible)

        // pausing brings them straight back and schedules nothing
        m.onIsPlayingChanged(false)
        assertTrue(m.chromeVisible)
        assertFalse(m.hidePending)
        assertNull(m.msUntilHide())
    }

    @Test
    fun `a hide that fires after the user paused is ignored`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        m.onIsPlayingChanged(false)      // paused before the timer fired
        now = 4_000
        m.onHideTimerFired()
        assertTrue(m.chromeVisible)
    }

    @Test
    fun `any touch brings everything back and restarts the countdown`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        now = 4_000
        m.onHideTimerFired()
        assertFalse(m.chromeVisible)

        now = 5_000
        m.onTouch()
        assertTrue(m.chromeVisible)
        assertTrue(m.hidePending)
        assertEquals(3_000L, m.msUntilHide())    // a full fresh 3 seconds
    }

    @Test
    fun `touching while visible re-arms rather than doing nothing`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        now = 3_500                              // 500ms left
        assertEquals(500L, m.msUntilHide())
        m.onTouch()
        assertEquals(3_000L, m.msUntilHide())    // pushed back out to the full timeout
    }

    @Test
    fun `playback starting re-arms the countdown - the buffering trap`() {
        // The website's root cause: one timer armed at load, expiring during buffering, with
        // nothing to re-arm it once the video actually began.
        val m = model()
        now = 0
        m.onTouch()                              // user opened the player and tapped
        assertFalse(m.hidePending)               // not playing yet, so nothing is scheduled

        now = 8_000                              // ...long buffer...
        m.onIsPlayingChanged(true)               // playback finally starts
        assertTrue(m.hidePending)                // and THIS arms the countdown
        assertEquals(3_000L, m.msUntilHide())

        now = 11_000
        m.onHideTimerFired()
        assertFalse(m.chromeVisible)
    }

    @Test
    fun `resuming after a pause re-arms too`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        m.onIsPlayingChanged(false)
        assertFalse(m.hidePending)

        now = 20_000
        m.onIsPlayingChanged(true)
        assertTrue(m.hidePending)
        assertEquals(3_000L, m.msUntilHide())
    }

    /* ------------------------------- up next -------------------------------- */

    @Test
    fun `the up next card keeps the chrome up while its countdown runs`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        now = 4_000
        m.onHideTimerFired()
        assertFalse(m.chromeVisible)

        m.onUpNextChanged(true)
        assertTrue(m.chromeVisible)
        assertFalse(m.hidePending)      // nothing scheduled that could take it away
    }

    @Test
    fun `a hide firing while up next is showing is ignored`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        m.onUpNextChanged(true)
        now = 4_000
        m.onHideTimerFired()
        assertTrue(m.chromeVisible)
    }

    @Test
    fun `the controller hiding underneath cannot take the up next card's chrome away`() {
        val m = model()
        m.onUpNextChanged(true)
        m.onControllerVisibilityChanged(false)
        assertTrue(m.chromeVisible)
    }

    @Test
    fun `dismissing up next hands control back to the normal rules`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        m.onUpNextChanged(true)
        assertFalse(m.hidePending)

        now = 5_000
        m.onUpNextChanged(false)
        assertTrue(m.hidePending)                // back to auto-hiding
        assertEquals(3_000L, m.msUntilHide())
    }

    /* ---------------------------- mirroring / safety ------------------------- */

    @Test
    fun `the model mirrors what the player controller reports`() {
        val m = model()
        m.onIsPlayingChanged(true)
        m.onControllerVisibilityChanged(false)
        assertFalse(m.chromeVisible)
        m.onControllerVisibilityChanged(true)
        assertTrue(m.chromeVisible)
        assertTrue(m.hidePending)                // showing again re-arms
    }

    @Test
    fun `the chrome can never end up stuck hidden`() {
        val m = model()
        now = 1_000
        m.onIsPlayingChanged(true)
        now = 4_000
        m.onHideTimerFired()
        assertFalse(m.chromeVisible)

        // every route back works: a touch, a pause, or the up-next card appearing
        m.onTouch()
        assertTrue(m.chromeVisible)

        m.onControllerVisibilityChanged(false)
        assertFalse(m.chromeVisible)
        m.onIsPlayingChanged(false)
        assertTrue(m.chromeVisible)

        m.onIsPlayingChanged(true)
        m.onControllerVisibilityChanged(false)
        assertFalse(m.chromeVisible)
        m.onUpNextChanged(true)
        assertTrue(m.chromeVisible)
    }

    @Test
    fun `state is exposed for the views to follow`() {
        val m = model()
        m.onIsPlayingChanged(true)
        assertTrue(m.isPlaying)
        assertFalse(m.upNextShowing)
        assertTrue(m.controllerVisible)
        m.onUpNextChanged(true)
        assertTrue(m.upNextShowing)
    }
}
