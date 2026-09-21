package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.AudioFocusAction
import com.beeboentertainment.movie.core.AudioFocusPolicy
import com.beeboentertainment.movie.core.BackgroundPlaybackPolicy
import com.beeboentertainment.movie.core.BackgroundPlaybackSetting
import com.beeboentertainment.movie.core.MediaMetadataBuilder
import com.beeboentertainment.movie.core.MemoryKeyValueStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Keep playing with the screen off" — the toggle, the pause-or-continue decision, audio focus,
 * and the metadata the lock-screen controls show.
 */
class BackgroundPlaybackTest {

    /* ------------------------------ the toggle ------------------------------ */

    @Test
    fun `the toggle is off by default, like the website`() {
        val s = BackgroundPlaybackSetting(MemoryKeyValueStore())
        assertFalse(s.enabled)
        assertFalse(BackgroundPlaybackSetting.DEFAULT)
    }

    @Test
    fun `turning it on is remembered across videos and sessions`() {
        val store = MemoryKeyValueStore()
        BackgroundPlaybackSetting(store).enabled = true
        // a brand new setting object over the same store == a later video, or a later app launch
        assertTrue(BackgroundPlaybackSetting(store).enabled)
    }

    @Test
    fun `turning it back off is remembered too`() {
        val store = MemoryKeyValueStore()
        val s = BackgroundPlaybackSetting(store)
        s.enabled = true
        s.enabled = false
        assertFalse(BackgroundPlaybackSetting(store).enabled)
    }

    @Test
    fun `toggle flips and returns the new state`() {
        val s = BackgroundPlaybackSetting(MemoryKeyValueStore())
        assertTrue(s.toggle())
        assertTrue(s.enabled)
        assertFalse(s.toggle())
        assertFalse(s.enabled)
    }

    @Test
    fun `the label matches the website wording`() {
        val s = BackgroundPlaybackSetting(MemoryKeyValueStore())
        assertEquals("🎧 Screen off: Off", s.label())
        s.enabled = true
        assertEquals("🎧 Screen off: On", s.label())
    }

    @Test
    fun `the storage key is stable so nobody's preference silently resets`() {
        assertEquals("keep_playing_background", BackgroundPlaybackSetting.KEY)
    }

    /* -------------------- pause-or-continue on background ------------------- */

    @Test
    fun `with the toggle off, backgrounding pauses - normal phone behaviour`() {
        assertTrue(
            BackgroundPlaybackPolicy.shouldPauseOnBackground(
                keepPlayingEnabled = false, isCasting = false, isPlaying = true
            )
        )
    }

    @Test
    fun `with the toggle on, backgrounding keeps playing`() {
        assertFalse(
            BackgroundPlaybackPolicy.shouldPauseOnBackground(
                keepPlayingEnabled = true, isCasting = false, isPlaying = true
            )
        )
    }

    @Test
    fun `casting always keeps playing, whatever the toggle says`() {
        // the TV owns playback; locking the phone must not stop the film
        assertFalse(
            BackgroundPlaybackPolicy.shouldPauseOnBackground(
                keepPlayingEnabled = false, isCasting = true, isPlaying = true
            )
        )
        assertFalse(
            BackgroundPlaybackPolicy.shouldPauseOnBackground(
                keepPlayingEnabled = true, isCasting = true, isPlaying = true
            )
        )
    }

    @Test
    fun `already paused stays paused rather than being paused again`() {
        assertFalse(
            BackgroundPlaybackPolicy.shouldPauseOnBackground(
                keepPlayingEnabled = false, isCasting = false, isPlaying = false
            )
        )
    }

    /* ------------------------- service teardown rules ----------------------- */

    @Test
    fun `closing the player stops the service, backgrounding does not`() {
        assertTrue(BackgroundPlaybackPolicy.shouldStopServiceOnClose(isFinishing = true, isCasting = false))
        assertFalse(BackgroundPlaybackPolicy.shouldStopServiceOnClose(isFinishing = false, isCasting = false))
    }

    @Test
    fun `closing the player while casting leaves the TV playing`() {
        assertFalse(BackgroundPlaybackPolicy.shouldStopServiceOnClose(isFinishing = true, isCasting = true))
    }

    @Test
    fun `reaching the end tears the notification down`() {
        assertTrue(BackgroundPlaybackPolicy.shouldStopServiceOnEnded())
    }

    /* ------------------------------ audio focus ----------------------------- */

    @Test
    fun `a phone call pauses`() {
        assertEquals(
            AudioFocusAction.PAUSE,
            AudioFocusPolicy.onFocusChange(AudioFocusPolicy.AUDIOFOCUS_LOSS_TRANSIENT, isCasting = false)
        )
    }

    @Test
    fun `another media app taking focus for good pauses`() {
        assertEquals(
            AudioFocusAction.PAUSE,
            AudioFocusPolicy.onFocusChange(AudioFocusPolicy.AUDIOFOCUS_LOSS, isCasting = false)
        )
    }

    @Test
    fun `a duckable interruption ducks instead of pausing`() {
        assertEquals(
            AudioFocusAction.DUCK,
            AudioFocusPolicy.onFocusChange(
                AudioFocusPolicy.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK, isCasting = false
            )
        )
        assertEquals(0.2f, AudioFocusPolicy.volumeFor(AudioFocusAction.DUCK), 0.0001f)
        assertEquals(1.0f, AudioFocusPolicy.volumeFor(AudioFocusAction.CONTINUE), 0.0001f)
        assertEquals(1.0f, AudioFocusPolicy.volumeFor(AudioFocusAction.PAUSE), 0.0001f)
    }

    @Test
    fun `regaining focus continues`() {
        assertEquals(
            AudioFocusAction.CONTINUE,
            AudioFocusPolicy.onFocusChange(AudioFocusPolicy.AUDIOFOCUS_GAIN, isCasting = false)
        )
    }

    @Test
    fun `while casting, phone audio focus is irrelevant`() {
        // the phone isn't making the sound, so nothing another app does should stop the TV
        listOf(
            AudioFocusPolicy.AUDIOFOCUS_LOSS,
            AudioFocusPolicy.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioFocusPolicy.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
        ).forEach {
            assertEquals(AudioFocusAction.CONTINUE, AudioFocusPolicy.onFocusChange(it, isCasting = true))
        }
    }

    @Test
    fun `an unrecognised focus code does not stop playback`() {
        assertEquals(AudioFocusAction.CONTINUE, AudioFocusPolicy.onFocusChange(999, isCasting = false))
    }

    /* --------------------------- notification metadata ---------------------- */

    @Test
    fun `a movie shows its title and poster on the lock screen`() {
        val m = MediaMetadataBuilder.forItem(
            title = "Heat",
            posterUrl = "http://host:47811/media/poster/123.jpg",
            kind = "movie"
        )
        assertEquals("Heat", m.title)
        assertEquals("Movie", m.subtitle)
        assertEquals("http://host:47811/media/poster/123.jpg", m.artworkUri)
        assertEquals("movie", m.kind)
    }

    @Test
    fun `a tv episode says so`() {
        val m = MediaMetadataBuilder.forItem("The Wire — S1E2", null, "tv")
        assertEquals("TV episode", m.subtitle)
        assertEquals("tv", m.kind)
    }

    @Test
    fun `no cached poster means no artwork rather than a broken image`() {
        assertNull(MediaMetadataBuilder.forItem("Heat", null, "movie").artworkUri)
        assertNull(MediaMetadataBuilder.forItem("Heat", "   ", "movie").artworkUri)
    }

    @Test
    fun `a downloaded copy is labelled as such`() {
        assertEquals("Downloaded movie", MediaMetadataBuilder.forItem("Heat", null, "movie", offline = true).subtitle)
        assertEquals("Downloaded episode", MediaMetadataBuilder.forItem("S1E2", null, "tv", offline = true).subtitle)
    }

    @Test
    fun `a blank title still gives the notification something to show`() {
        assertEquals("Beebo Entertainment", MediaMetadataBuilder.forItem("   ", null, "movie").title)
        assertEquals("Beebo Entertainment", MediaMetadataBuilder.forItem(null, null, "movie").title)
    }

    @Test
    fun `both is never used as an item kind in metadata`() {
        // "both" describes a surf pool, not something that can be playing
        assertEquals("movie", MediaMetadataBuilder.forItem("X", null, "both").kind)
    }

    @Test
    fun `the extras keys the service reads back are stable`() {
        assertEquals("beebo.kind", MediaMetadataBuilder.EXTRA_KIND)
        assertEquals("beebo.itemId", MediaMetadataBuilder.EXTRA_ITEM_ID)
    }

    /* ------------------------- boolean store round-trip --------------------- */

    @Test
    fun `the key value store handles booleans without disturbing resume positions`() {
        val store = MemoryKeyValueStore()
        store.putBoolean("flag", true)
        store.putLong("resume_abc", 600_000L)
        assertTrue(store.getBoolean("flag", false))
        assertEquals(600_000L, store.getLong("resume_abc", 0L))
        assertFalse(store.getBoolean("never_set", false))
        assertTrue(store.getBoolean("never_set", true))
    }
}
