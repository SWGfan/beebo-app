package com.beeboentertainment.movie.audio

import com.beeboentertainment.movie.core.MainNav
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLDecoder

class AudioRoutesTest {

    @Test fun `every new route is distinct and none is a tab`() {
        assertEquals(AudioRoutes.ALL.size, AudioRoutes.ALL.toSet().size)
        assertTrue(AudioRoutes.ALL.none { it in MainNav.BOTTOM_TABS })
        assertTrue(AudioRoutes.ALL.none { it in MainNav.LEGACY_ROUTES })
        // A pushed screen owns no tab: the bottom bar keeps lighting the tab it was opened from.
        AudioRoutes.ALL.forEach { assertNull(it, MainNav.tabFor(it)) }
    }

    @Test fun `every route has a name for the top bar and the music route keeps its own`() {
        AudioRoutes.ALL.forEach { assertNotNull(it, AudioRoutes.screenName(it)) }
        assertNull(AudioRoutes.screenName("home"))
        assertNull(AudioRoutes.screenName(null))
    }

    @Test fun `the mini player and the notification open the player for what is playing`() {
        assertEquals("music/now", AudioRoutes.nowPlaying(AudioKind.MUSIC))
        assertEquals("audiobooks/listen", AudioRoutes.nowPlaying(AudioKind.AUDIOBOOK))
        assertEquals("podcasts/listen", AudioRoutes.nowPlaying(AudioKind.PODCAST))
        assertEquals("radio/listen", AudioRoutes.nowPlaying(AudioKind.RADIO))
        AudioKind.values().forEach { assertTrue(AudioRoutes.nowPlaying(it) in AudioRoutes.ALL + AudioRoutes.MUSIC_NOW) }
    }

    @Test fun `route builders fill in the argument`() {
        assertEquals("audiobooks/book/0123456789abcdef", AudioRoutes.book("0123456789abcdef"))
        assertEquals("audiobooks/series/s1", AudioRoutes.series("s1"))
        assertEquals("podcasts/show/0123456789ab", AudioRoutes.podcastShow("0123456789ab"))
    }

    @Test fun `a channel key with colons and dots survives the trip through a route`() {
        val route = AudioRoutes.liveTvWatch("hdhr:1234ABCD:5.1")
        val arg = route.removePrefix("livetv/watch/")
        assertFalse(arg.contains(":") || arg.contains("/"))
        assertEquals("hdhr:1234ABCD:5.1", URLDecoder.decode(arg, "UTF-8"))
        assertEquals("a b", URLDecoder.decode(AudioRoutes.liveTvWatch("a b").removePrefix("livetv/watch/"), "UTF-8"))
    }

    @Test fun `clamping the skip lengths to what the server allows`() {
        assertEquals(5, AudioPrefs.clamp(0))
        assertEquals(15, AudioPrefs.clamp(15))
        assertEquals(120, AudioPrefs.clamp(999))
    }
}
