package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.ChromeVisibilityModel
import com.beeboentertainment.movie.core.PipPolicy
import com.beeboentertainment.movie.core.PlayerChromePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Picture-in-Picture eligibility, sizing, and what happens to the chrome inside a PiP window. */
class PipPolicyTest {

    /* ----------------------------- availability ----------------------------- */

    @Test
    fun `pip needs both the os version and the hardware feature`() {
        assertTrue(PipPolicy.isSupported(sdkInt = 34, hasFeature = true))
        assertTrue(PipPolicy.isSupported(sdkInt = 26, hasFeature = true))
        // below Android 8 there is no PiP at all
        assertFalse(PipPolicy.isSupported(sdkInt = 25, hasFeature = true))
        assertFalse(PipPolicy.isSupported(sdkInt = 24, hasFeature = true))
        // and some devices simply don't declare the feature
        assertFalse(PipPolicy.isSupported(sdkInt = 34, hasFeature = false))
        assertEquals(26, PipPolicy.MIN_SDK)
    }

    @Test
    fun `the button is hidden rather than shown dead`() {
        assertTrue(PipPolicy.canOfferPip(supported = true, isCasting = false, isFinishing = false))
        assertFalse(PipPolicy.canOfferPip(supported = false, isCasting = false, isFinishing = false))
    }

    @Test
    fun `pip is not offered while a chromecast owns playback`() {
        // the video is already on the TV; a thumbnail on the phone would be pointless
        assertFalse(PipPolicy.canOfferPip(supported = true, isCasting = true, isFinishing = false))
    }

    @Test
    fun `pip is not offered once the player is closing`() {
        assertFalse(PipPolicy.canOfferPip(supported = true, isCasting = false, isFinishing = true))
    }

    /* ------------------------------ auto-enter ------------------------------ */

    @Test
    fun `pressing home while playing drops into pip`() {
        assertTrue(
            PipPolicy.shouldAutoEnterOnLeave(
                supported = true, isPlaying = true, isCasting = false,
                isFinishing = false, alreadyInPip = false
            )
        )
    }

    @Test
    fun `pressing home while paused just leaves`() {
        assertFalse(
            PipPolicy.shouldAutoEnterOnLeave(
                supported = true, isPlaying = false, isCasting = false,
                isFinishing = false, alreadyInPip = false
            )
        )
    }

    @Test
    fun `auto-enter is suppressed while casting, while finishing, and when already in pip`() {
        assertFalse(
            PipPolicy.shouldAutoEnterOnLeave(true, isPlaying = true, isCasting = true, isFinishing = false, alreadyInPip = false)
        )
        assertFalse(
            PipPolicy.shouldAutoEnterOnLeave(true, isPlaying = true, isCasting = false, isFinishing = true, alreadyInPip = false)
        )
        assertFalse(
            PipPolicy.shouldAutoEnterOnLeave(true, isPlaying = true, isCasting = false, isFinishing = false, alreadyInPip = true)
        )
        assertFalse(
            PipPolicy.shouldAutoEnterOnLeave(false, isPlaying = true, isCasting = false, isFinishing = false, alreadyInPip = false)
        )
    }

    /* ----------------------------- aspect ratio ----------------------------- */

    @Test
    fun `an ordinary video keeps its own shape`() {
        assertEquals(1920 to 1080, PipPolicy.aspectRatio(1920, 1080))
        assertEquals(1280 to 720, PipPolicy.aspectRatio(1280, 720))
        assertTrue(PipPolicy.isAcceptableAspect(1920, 1080))
    }

    @Test
    fun `an unknown video size falls back to sixteen by nine`() {
        assertEquals(16 to 9, PipPolicy.aspectRatio(0, 0))
        assertEquals(16 to 9, PipPolicy.aspectRatio(-1, 720))
        assertFalse(PipPolicy.isAcceptableAspect(0, 0))
    }

    @Test
    fun `extreme shapes are clamped instead of making android throw`() {
        // ultra-wide scope prints exceed Android's 2.39 limit
        val wide = PipPolicy.aspectRatio(3000, 1000)
        assertTrue(wide.first.toDouble() / wide.second <= PipPolicy.MAX_ASPECT + 0.001)
        assertFalse(PipPolicy.isAcceptableAspect(3000, 1000))

        // and a very tall video is below the lower bound
        val tall = PipPolicy.aspectRatio(100, 1000)
        assertTrue(tall.first.toDouble() / tall.second >= PipPolicy.MIN_ASPECT)
        assertFalse(PipPolicy.isAcceptableAspect(100, 1000))
    }

    /* --------------------------- chrome inside pip --------------------------- */

    @Test
    fun `everything is hidden in a pip window, including the up next card`() {
        // a PiP window is a couple of centimetres across - any overlay makes it useless
        assertFalse(
            PlayerChromePolicy.shouldShowChrome(
                controllerVisible = true, upNextShowing = true, inPictureInPicture = true
            )
        )
        assertFalse(
            PlayerChromePolicy.shouldShowChrome(
                controllerVisible = false, upNextShowing = false, inPictureInPicture = true
            )
        )
        // ...but out of PiP the up-next exemption still applies
        assertTrue(
            PlayerChromePolicy.shouldShowChrome(
                controllerVisible = false, upNextShowing = true, inPictureInPicture = false
            )
        )
    }

    @Test
    fun `no hide is scheduled while in pip - there is nothing left to hide`() {
        assertFalse(
            PlayerChromePolicy.shouldScheduleHide(
                isPlaying = true, upNextShowing = false, inPictureInPicture = true
            )
        )
    }

    @Test
    fun `entering pip hides the chrome and leaving restores it`() {
        var now = 0L
        val m = ChromeVisibilityModel { now }
        now = 1_000
        m.onIsPlayingChanged(true)
        assertTrue(m.chromeVisible)

        m.onPipChanged(true)
        assertTrue(m.inPictureInPicture)
        assertFalse(m.chromeVisible)
        assertFalse(m.hidePending)

        now = 5_000
        m.onPipChanged(false)
        assertFalse(m.inPictureInPicture)
        assertTrue(m.chromeVisible)
        assertTrue(m.hidePending)                 // and the countdown starts again
        assertEquals(3_000L, m.msUntilHide())
    }

    @Test
    fun `the up next card does not force chrome back on inside pip`() {
        val m = ChromeVisibilityModel { 0L }
        m.onIsPlayingChanged(true)
        m.onPipChanged(true)
        m.onUpNextChanged(true)
        assertFalse(m.chromeVisible)
        // leaving PiP hands it back to the normal exemption
        m.onPipChanged(false)
        assertTrue(m.chromeVisible)
    }

    @Test
    fun `a hide timer firing while in pip changes nothing`() {
        val m = ChromeVisibilityModel { 0L }
        m.onIsPlayingChanged(true)
        m.onPipChanged(true)
        m.onHideTimerFired()
        assertFalse(m.chromeVisible)
        m.onPipChanged(false)
        assertTrue(m.chromeVisible)      // never stuck hidden after leaving PiP
    }
}
