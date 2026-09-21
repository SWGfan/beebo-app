package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.LibrarySection
import com.beeboentertainment.movie.core.MainNav
import com.beeboentertainment.movie.core.PlayerKeyAction
import com.beeboentertainment.movie.core.PlayerRemoteKeys
import com.beeboentertainment.movie.core.SelectPressTracker
import com.beeboentertainment.movie.core.TvDetection
import com.beeboentertainment.movie.core.TvFeatures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Android TV: detection, phone-only features, remote keys in the player, select long-press. */
class TvSupportTest {

    /* ------------------------------ detection ------------------------------ */

    // Configuration.UI_MODE_TYPE_* and UI_MODE_NIGHT_YES, as the platform defines them.
    private val normal = 0x01
    private val desk = 0x02
    private val car = 0x03
    private val television = 0x04
    private val watch = 0x06
    private val nightYes = 0x20

    @Test
    fun `television ui mode is a TV`() {
        assertTrue(TvDetection.isTelevision(television, hasLeanbackFeature = false))
    }

    @Test
    fun `night mode bits do not hide a television`() {
        assertTrue(TvDetection.isTelevision(television or nightYes, hasLeanbackFeature = false))
    }

    @Test
    fun `leanback feature alone is a TV`() {
        assertTrue(TvDetection.isTelevision(normal, hasLeanbackFeature = true))
    }

    @Test
    fun `phones, docks, cars and watches are not TVs`() {
        for (mode in listOf(normal, desk, car, watch, normal or nightYes, 0)) {
            assertFalse("mode $mode", TvDetection.isTelevision(mode, hasLeanbackFeature = false))
        }
    }

    @Test
    fun `platform constants match`() {
        assertEquals(0x0f, TvDetection.UI_MODE_TYPE_MASK)
        assertEquals(0x04, TvDetection.UI_MODE_TYPE_TELEVISION)
    }

    /* --------------------------- phone-only features --------------------------- */

    @Test
    fun `hotspot, sensor and camera-roll features are hidden on a TV only`() {
        for (route in listOf("campsite", "starchart", "nearby", "scavengerhunt", "spacesaver")) {
            assertFalse(route, TvFeatures.isAvailable(route, isTv = true))
            assertTrue(route, TvFeatures.isAvailable(route, isTv = false))
        }
    }

    /* --------------------------------- games --------------------------------- */

    @Test
    fun `a game shows on a TV unless it needs touch, a camera or passing the device round`() {
        assertTrue(TvFeatures.gameShowsOnTv(needsTouch = false, usesCamera = false, passThePhone = false))
        assertFalse(TvFeatures.gameShowsOnTv(needsTouch = true, usesCamera = false, passThePhone = false))
        assertFalse(TvFeatures.gameShowsOnTv(needsTouch = false, usesCamera = true, passThePhone = false))
        assertFalse(TvFeatures.gameShowsOnTv(needsTouch = false, usesCamera = false, passThePhone = true))
        // Phones list everything; a TV lists what a remote can host, guests or not.
        assertTrue(TvFeatures.gameListed(showOnTv = false, isTv = false))
        assertTrue(TvFeatures.gameListed(showOnTv = true, isTv = true))
        assertFalse(TvFeatures.gameListed(showOnTv = false, isTv = true))
    }

    @Test
    fun `games that need other phones are listed on a TV unless their host side needs touch, camera or passing round`() {
        val catalog = com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog
        val needGuests = catalog.ALL.filter { it.needsGuests }
        assertTrue(needGuests.isNotEmpty())
        for (g in needGuests) {
            assertEquals(g.id, g.showOnTv, TvFeatures.gameListed(g.showOnTv, isTv = true))
        }
        assertTrue("a TV can now offer a guests game", needGuests.any { TvFeatures.gameListed(it.showOnTv, isTv = true) })
        for (g in catalog.ALL.filter { it.needsTouch || it.usesCamera || it.passThePhone }) {
            assertFalse(g.id, TvFeatures.gameListed(g.showOnTv, isTv = true))
        }
    }

    @Test
    fun `every game in the catalog gets the TV rule from its capability facts`() {
        val catalog = com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog
        val hiddenOnTv = catalog.ALL.filter { !it.showOnTv }.map { it.id }.toSet() +
            catalog.SOLO.filter { !it.showOnTv }.map { it.id }
        assertEquals(
            setOf(
                catalog.ALL.first { it.needsTouch }.id,
                catalog.ALL.first { it.usesCamera }.id,
                catalog.ALL.first { it.passThePhone }.id,
                "solitaire",
            ),
            hiddenOnTv,
        )
        for (g in catalog.ALL) assertEquals(g.id, !g.needsTouch && !g.usesCamera && !g.passThePhone, g.showOnTv)
        for (g in catalog.SOLO) assertEquals(g.id, !g.needsTouch, g.showOnTv)
        // A TV still has room games and solo puzzles to list.
        assertTrue(catalog.ALL.any { TvFeatures.gameListed(it.showOnTv, isTv = true) })
        assertTrue(catalog.SOLO.any { TvFeatures.gameListed(it.showOnTv, isTv = true) })
    }

    @Test
    fun `the main flows stay available on a TV`() {
        for (route in listOf("movies", "tv", "continue", "surf", "games", "guest-games", "settings",
            "spacesaver-gallery", "watch-together", "stories", "trivia", "packing")) {
            assertTrue(route, TvFeatures.isAvailable(route, isTv = true))
        }
    }

    @Test
    fun `phone-only features name themselves for the notice`() {
        assertEquals("Campsite Mode", TvFeatures.phoneOnlyName("campsite"))
        assertNull(TvFeatures.phoneOnlyName("movies"))
    }

    @Test
    fun `visible filters menus on a TV and leaves phones alone`() {
        val routes = listOf("campsite", "starchart", "badges", "recap")
        assertEquals(listOf("badges", "recap"), TvFeatures.visible(routes, isTv = true) { it })
        assertEquals(routes, TvFeatures.visible(routes, isTv = false) { it })
    }

    /* ------------------------------ downloads ------------------------------ */

    @Test
    fun `downloads are unavailable on a TV and untouched on a phone`() {
        assertFalse(TvFeatures.isAvailable(MainNav.DOWNLOADS, isTv = true))
        assertTrue(TvFeatures.isAvailable(MainNav.DOWNLOADS, isTv = false))
        assertFalse(TvFeatures.downloadsAvailable(isTv = true))
        assertTrue(TvFeatures.downloadsAvailable(isTv = false))
    }

    @Test
    fun `downloads name themselves for the notice, and a TV menu drops them`() {
        assertEquals("Downloads", TvFeatures.phoneOnlyName(MainNav.DOWNLOADS))
        val routes = listOf("downloads", "badges", "campsite")
        assertEquals(listOf("badges"), TvFeatures.visible(routes, isTv = true) { it })
        assertEquals(routes, TvFeatures.visible(routes, isTv = false) { it })
    }

    @Test
    fun `hiding downloads leaves the other TV routes as they were`() {
        for (route in listOf("library", "home", "browse", "watch-together", "settings", "show/{key}")) {
            assertTrue(route, TvFeatures.isAvailable(route, isTv = true))
        }
        for (route in listOf("campsite", "starchart", "nearby", "scavengerhunt", "spacesaver")) {
            assertFalse(route, TvFeatures.isAvailable(route, isTv = true))
        }
    }

    @Test
    fun `the Library has no Downloads chip on a TV`() {
        assertEquals(LibrarySection.entries.toList(), LibrarySection.visibleOn(isTv = false))
        val onTv = LibrarySection.visibleOn(isTv = true)
        assertFalse(LibrarySection.DOWNLOADS in onTv)
        assertEquals(LibrarySection.entries.filter { it != LibrarySection.DOWNLOADS }, onTv)
    }

    @Test
    fun `a saved Downloads section falls back to the Watchlist on a TV only`() {
        assertEquals(LibrarySection.WATCHLIST, LibrarySection.DOWNLOADS.onDevice(isTv = true))
        assertEquals(LibrarySection.DOWNLOADS, LibrarySection.DOWNLOADS.onDevice(isTv = false))
        for (section in LibrarySection.entries.filter { it != LibrarySection.DOWNLOADS }) {
            assertEquals(section, section.onDevice(isTv = true))
        }
    }

    @Test
    fun `the old Downloads route forwards to the Library without opening Downloads on a TV`() {
        assertEquals(
            MainNav.Migration(MainNav.LIBRARY, librarySection = LibrarySection.DOWNLOADS),
            MainNav.migrate(MainNav.DOWNLOADS),
        )
        assertEquals(MainNav.Migration(MainNav.LIBRARY), MainNav.migrate(MainNav.DOWNLOADS, isTv = true))
        // No other old route changes on a TV.
        for (route in MainNav.LEGACY_ROUTES.filter { it != MainNav.DOWNLOADS }) {
            assertEquals(route, MainNav.migrate(route), MainNav.migrate(route, isTv = true))
        }
    }

    /* ------------------------------ purchases ------------------------------ */

    @Test
    fun `purchase flows are unavailable on a TV and untouched on a phone`() {
        assertFalse(TvFeatures.purchasesAvailable(isTv = true))
        assertTrue(TvFeatures.purchasesAvailable(isTv = false))
    }

    @Test
    fun `a TV gets the manage-on-phone line in place of the purchase controls`() {
        assertEquals(TvFeatures.MANAGE_ON_PHONE_MESSAGE, TvFeatures.purchaseNotice(isTv = true))
        assertNull(TvFeatures.purchaseNotice(isTv = false))
    }

    @Test
    fun `the manage-on-phone line says where to go and passes the Payments policy wording`() {
        val message = TvFeatures.MANAGE_ON_PHONE_MESSAGE
        assertTrue(message.contains("phone"))
        assertTrue(message.contains("beebo.tv"))
        // The same rules as PaymentsGuardTest and checkPlayDebugPolicy.
        val forbidden = listOf(
            Regex("""(?i)\bsubscribe\b"""),
            Regex("""(?:[$€£]\s?\d)|(?:\d\s?(?:USD|EUR|GBP)\b)"""),
            Regex("""(?i)\d+(?:[.,]\d+)?\s*(?:/|per|a)\s*(?:month|mo|year|yr|week|day)\b"""),
            Regex("""(?i)subscription\s+(?:price|cost|fee)"""),
            Regex("""(?i)\b(?:buy now|buy beebo|purchase|top up|pay as you go|upgrade to|go premium|start your subscription|pricing|checkout)\b"""),
            Regex("""(?i)(?:stripe\.com|/checkout|/subscribe|/buy\b|buy\.html|pricing\.html|#pricing|/billing|/wallet/topup|/relay/buy)"""),
            Regex("""(?i)(?:renew|pay|subscribe|purchase|buy)[^"]{0,80}(?:beeboentertainment\.com|beebo\.tv|beebotv\.com)"""),
            Regex("""(?i)\bfor kids\b|(?<![.\w])children\b"""),
        )
        for (rule in forbidden) assertFalse(rule.pattern, rule.containsMatchIn(message))
    }

    /* ------------------------------ player keys ------------------------------ */

    private fun tv(key: Int, visible: Boolean = false, repeat: Int = 0) =
        PlayerRemoteKeys.actionFor(key, controlsVisible = visible, isTv = true, repeatCount = repeat)

    @Test
    fun `left and right seek while the controls are hidden`() {
        assertEquals(PlayerKeyAction.SEEK_BACK, tv(PlayerRemoteKeys.KEYCODE_DPAD_LEFT))
        assertEquals(PlayerKeyAction.SEEK_FORWARD, tv(PlayerRemoteKeys.KEYCODE_DPAD_RIGHT))
        // held down, it keeps seeking
        assertEquals(PlayerKeyAction.SEEK_FORWARD, tv(PlayerRemoteKeys.KEYCODE_DPAD_RIGHT, repeat = 5))
    }

    @Test
    fun `left and right move focus once the controls are up`() {
        assertEquals(PlayerKeyAction.DEFAULT, tv(PlayerRemoteKeys.KEYCODE_DPAD_LEFT, visible = true))
        assertEquals(PlayerKeyAction.DEFAULT, tv(PlayerRemoteKeys.KEYCODE_DPAD_RIGHT, visible = true))
    }

    @Test
    fun `centre, up and down are left to PlayerView`() {
        for (key in listOf(PlayerRemoteKeys.KEYCODE_DPAD_CENTER, PlayerRemoteKeys.KEYCODE_DPAD_UP,
            PlayerRemoteKeys.KEYCODE_DPAD_DOWN, PlayerRemoteKeys.KEYCODE_ENTER, PlayerRemoteKeys.KEYCODE_BACK)) {
            assertEquals(PlayerKeyAction.DEFAULT, tv(key))
            assertEquals(PlayerKeyAction.DEFAULT, tv(key, visible = true))
        }
    }

    @Test
    fun `media keys act whether or not the controls are up`() {
        for (visible in listOf(false, true)) {
            assertEquals(PlayerKeyAction.TOGGLE_PLAY_PAUSE, tv(PlayerRemoteKeys.KEYCODE_MEDIA_PLAY_PAUSE, visible))
            assertEquals(PlayerKeyAction.TOGGLE_PLAY_PAUSE, tv(PlayerRemoteKeys.KEYCODE_HEADSETHOOK, visible))
            assertEquals(PlayerKeyAction.PLAY, tv(PlayerRemoteKeys.KEYCODE_MEDIA_PLAY, visible))
            assertEquals(PlayerKeyAction.PAUSE, tv(PlayerRemoteKeys.KEYCODE_MEDIA_PAUSE, visible))
            assertEquals(PlayerKeyAction.PAUSE, tv(PlayerRemoteKeys.KEYCODE_MEDIA_STOP, visible))
            assertEquals(PlayerKeyAction.SEEK_BACK, tv(PlayerRemoteKeys.KEYCODE_MEDIA_REWIND, visible))
            assertEquals(PlayerKeyAction.SEEK_FORWARD, tv(PlayerRemoteKeys.KEYCODE_MEDIA_FAST_FORWARD, visible))
            assertEquals(PlayerKeyAction.SEEK_BACK, tv(PlayerRemoteKeys.KEYCODE_MEDIA_SKIP_BACKWARD, visible))
            assertEquals(PlayerKeyAction.SEEK_FORWARD, tv(PlayerRemoteKeys.KEYCODE_MEDIA_SKIP_FORWARD, visible))
            assertEquals(PlayerKeyAction.NEXT, tv(PlayerRemoteKeys.KEYCODE_MEDIA_NEXT, visible))
            assertEquals(PlayerKeyAction.PREVIOUS, tv(PlayerRemoteKeys.KEYCODE_MEDIA_PREVIOUS, visible))
        }
    }

    @Test
    fun `a held play-pause or next key does not flicker or skip a whole season`() {
        assertEquals(PlayerKeyAction.DEFAULT, tv(PlayerRemoteKeys.KEYCODE_MEDIA_PLAY_PAUSE, repeat = 1))
        assertEquals(PlayerKeyAction.DEFAULT, tv(PlayerRemoteKeys.KEYCODE_MEDIA_NEXT, repeat = 3))
        // but a held fast-forward keeps going
        assertEquals(PlayerKeyAction.SEEK_FORWARD, tv(PlayerRemoteKeys.KEYCODE_MEDIA_FAST_FORWARD, repeat = 3))
    }

    @Test
    fun `phones keep their D-pad behaviour`() {
        assertEquals(PlayerKeyAction.DEFAULT,
            PlayerRemoteKeys.actionFor(PlayerRemoteKeys.KEYCODE_DPAD_LEFT, controlsVisible = false, isTv = false))
    }

    @Test
    fun `back hides the controls first on a TV only`() {
        assertTrue(PlayerRemoteKeys.backHidesControls(isTv = true, controlsVisible = true))
        assertFalse(PlayerRemoteKeys.backHidesControls(isTv = true, controlsVisible = false))
        assertFalse(PlayerRemoteKeys.backHidesControls(isTv = false, controlsVisible = true))
    }

    @Test
    fun `seeks stay inside the film`() {
        val step = PlayerRemoteKeys.SEEK_STEP_MS
        assertEquals(40_000L, PlayerRemoteKeys.seekTarget(30_000L, 100_000L, step))
        assertEquals(20_000L, PlayerRemoteKeys.seekTarget(30_000L, 100_000L, -step))
        assertEquals(0L, PlayerRemoteKeys.seekTarget(4_000L, 100_000L, -step))
        assertEquals(100_000L, PlayerRemoteKeys.seekTarget(95_000L, 100_000L, step))
        // unknown duration (C.TIME_UNSET is negative): no upper clamp
        assertEquals(105_000L, PlayerRemoteKeys.seekTarget(95_000L, Long.MIN_VALUE + 1, step))
    }

    @Test
    fun `select keys cover the remote, a keyboard and a gamepad`() {
        assertTrue(PlayerRemoteKeys.isSelectKey(PlayerRemoteKeys.KEYCODE_DPAD_CENTER))
        assertTrue(PlayerRemoteKeys.isSelectKey(PlayerRemoteKeys.KEYCODE_ENTER))
        assertTrue(PlayerRemoteKeys.isSelectKey(PlayerRemoteKeys.KEYCODE_NUMPAD_ENTER))
        assertTrue(PlayerRemoteKeys.isSelectKey(PlayerRemoteKeys.KEYCODE_BUTTON_A))
        assertFalse(PlayerRemoteKeys.isSelectKey(PlayerRemoteKeys.KEYCODE_DPAD_LEFT))
    }

    @Test
    fun `key codes match android view KeyEvent`() {
        assertEquals(4, PlayerRemoteKeys.KEYCODE_BACK)
        assertEquals(21, PlayerRemoteKeys.KEYCODE_DPAD_LEFT)
        assertEquals(22, PlayerRemoteKeys.KEYCODE_DPAD_RIGHT)
        assertEquals(23, PlayerRemoteKeys.KEYCODE_DPAD_CENTER)
        assertEquals(85, PlayerRemoteKeys.KEYCODE_MEDIA_PLAY_PAUSE)
        assertEquals(89, PlayerRemoteKeys.KEYCODE_MEDIA_REWIND)
        assertEquals(90, PlayerRemoteKeys.KEYCODE_MEDIA_FAST_FORWARD)
        assertEquals(126, PlayerRemoteKeys.KEYCODE_MEDIA_PLAY)
        assertEquals(127, PlayerRemoteKeys.KEYCODE_MEDIA_PAUSE)
        assertEquals(165, PlayerRemoteKeys.KEYCODE_INFO)
        assertEquals(272, PlayerRemoteKeys.KEYCODE_MEDIA_SKIP_FORWARD)
        assertEquals(273, PlayerRemoteKeys.KEYCODE_MEDIA_SKIP_BACKWARD)
    }

    /* ---------------------------- select long-press ---------------------------- */

    @Test
    fun `a quick press is a click`() {
        val t = SelectPressTracker()
        assertEquals(SelectPressTracker.Result.NONE, t.onKeyDown(0))
        assertEquals(SelectPressTracker.Result.CLICK, t.onKeyUp())
    }

    @Test
    fun `holding select is one long click and no click`() {
        val t = SelectPressTracker()
        t.onKeyDown(0)
        assertEquals(SelectPressTracker.Result.LONG_CLICK, t.onKeyDown(1))
        assertEquals(SelectPressTracker.Result.NONE, t.onKeyDown(2))
        assertEquals(SelectPressTracker.Result.NONE, t.onKeyDown(3))
        assertEquals(SelectPressTracker.Result.NONE, t.onKeyUp())
        // and the next press starts fresh
        t.onKeyDown(0)
        assertEquals(SelectPressTracker.Result.CLICK, t.onKeyUp())
    }

    @Test
    fun `a key-up whose press started elsewhere does nothing`() {
        // e.g. select pressed on the previous screen, released after this one took focus
        val t = SelectPressTracker()
        assertEquals(SelectPressTracker.Result.NONE, t.onKeyUp())
        assertEquals(SelectPressTracker.Result.NONE, t.onKeyDown(4))
    }
}
