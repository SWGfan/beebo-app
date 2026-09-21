package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.PlayerKeyAction
import com.beeboentertainment.movie.core.PlayerRemoteKeys
import com.beeboentertainment.movie.core.TvDetection
import com.beeboentertainment.movie.core.TvFeatures
import com.beeboentertainment.movie.player.CastAvailability
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Amazon Fire TV / Fire tablet rules that live in shared code (docs/FIRE-TV.md): detection, the
 * Fire remote's keys, the store-sold-in-app switch, and the Cast availability decision. The
 * flavour-specific halves are in testAmazon (no Cast, no Play services) and FlavorSplitTest.
 */
class FireTvSupportTest {

    /* ------------------------------ detection ------------------------------ */

    private val normal = 0x01
    private val television = 0x04

    @Test
    fun `the Fire TV feature alone makes a TV`() {
        assertTrue(TvDetection.isTelevision(normal, hasLeanbackFeature = false, hasFireTvFeature = true))
    }

    @Test
    fun `a Fire tablet is not a TV`() {
        // Touch UI mode, no leanback, no Fire TV feature.
        assertFalse(TvDetection.isTelevision(normal, hasLeanbackFeature = false, hasFireTvFeature = false))
    }

    @Test
    fun `the existing two-argument call still means the same`() {
        assertTrue(TvDetection.isTelevision(television, hasLeanbackFeature = false))
        assertFalse(TvDetection.isTelevision(normal, hasLeanbackFeature = false))
        assertEquals("amazon.hardware.fire_tv", TvDetection.FIRE_TV_FEATURE)
    }

    /* ------------------------------ remote keys ------------------------------ */

    private fun tv(key: Int, visible: Boolean = false, repeat: Int = 0) =
        PlayerRemoteKeys.actionFor(key, controlsVisible = visible, isTv = true, repeatCount = repeat)

    @Test
    fun `the Fire remote rewind and fast-forward keys seek`() {
        // KEYCODE_MEDIA_REWIND / KEYCODE_MEDIA_FAST_FORWARD, held or not, controls up or not.
        for (visible in listOf(false, true)) for (repeat in listOf(0, 3)) {
            assertEquals(PlayerKeyAction.SEEK_BACK, tv(PlayerRemoteKeys.KEYCODE_MEDIA_REWIND, visible, repeat))
            assertEquals(PlayerKeyAction.SEEK_FORWARD, tv(PlayerRemoteKeys.KEYCODE_MEDIA_FAST_FORWARD, visible, repeat))
        }
    }

    @Test
    fun `the Fire remote play-pause key toggles playback`() {
        assertEquals(PlayerKeyAction.TOGGLE_PLAY_PAUSE, tv(PlayerRemoteKeys.KEYCODE_MEDIA_PLAY_PAUSE))
    }

    @Test
    fun `the Menu key brings up the controls while they are hidden`() {
        assertEquals(PlayerKeyAction.SHOW_CONTROLS, tv(PlayerRemoteKeys.KEYCODE_MENU))
        assertEquals(PlayerKeyAction.SHOW_CONTROLS, tv(PlayerRemoteKeys.KEYCODE_INFO))
    }

    @Test
    fun `the Menu key is left alone once the controls are up, when held, and on a phone`() {
        assertEquals(PlayerKeyAction.DEFAULT, tv(PlayerRemoteKeys.KEYCODE_MENU, visible = true))
        assertEquals(PlayerKeyAction.DEFAULT, tv(PlayerRemoteKeys.KEYCODE_MENU, repeat = 2))
        assertEquals(
            PlayerKeyAction.DEFAULT,
            PlayerRemoteKeys.actionFor(PlayerRemoteKeys.KEYCODE_MENU, controlsVisible = false, isTv = false)
        )
    }

    /* ------------------------------ purchases ------------------------------ */

    @Test
    fun `a store that does not sell in the app shows the manage line even on a touch screen`() {
        // A Fire tablet: not a TV, but the Amazon build has no purchase flow either.
        assertFalse(TvFeatures.purchasesAvailable(isTv = false, storeSellsInApp = false))
        assertEquals(TvFeatures.MANAGE_ON_PHONE_MESSAGE, TvFeatures.purchaseNotice(isTv = false, storeSellsInApp = false))
    }

    @Test
    fun `the default is unchanged for the Play build`() {
        assertTrue(TvFeatures.purchasesAvailable(isTv = false))
        assertNull(TvFeatures.purchaseNotice(isTv = false))
        assertEquals(TvFeatures.MANAGE_ON_PHONE_MESSAGE, TvFeatures.purchaseNotice(isTv = true))
    }

    /* ------------------------------ cast decision ------------------------------ */

    @Test
    fun `cast is offered only with the SDK linked and Play services usable`() {
        assertEquals(CastAvailability.Available, CastAvailability.decide(castStackLinked = true, playServicesUsable = true))
        assertEquals(CastAvailability.NoPlayServices, CastAvailability.decide(castStackLinked = true, playServicesUsable = false))
    }

    @Test
    fun `a build without the Cast SDK never offers cast, whatever the device has`() {
        assertEquals(CastAvailability.NoCastStack, CastAvailability.decide(castStackLinked = false, playServicesUsable = true))
        assertEquals(CastAvailability.NoCastStack, CastAvailability.decide(castStackLinked = false, playServicesUsable = false))
    }
}
