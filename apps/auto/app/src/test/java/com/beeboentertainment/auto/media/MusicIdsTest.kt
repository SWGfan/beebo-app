package com.beeboentertainment.auto.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Music browse ids the car hands back to us, and the album art paths the (exported) artwork
 * provider will fetch. Both are boundaries: an id has to round-trip exactly, and a path that is
 * not really album art must never be fetched on another app's behalf.
 */
class MusicIdsTest {

    private val trackId = "0123456789abcdef0123"
    private val albumId = "fedcba9876543210"

    @Test
    fun `playable ids round-trip`() {
        assertEquals("track" to trackId, MusicIds.parsePlayable(MusicIds.track(trackId)))
        assertEquals("album" to albumId, MusicIds.parsePlayable(MusicIds.albumPlay(albumId)))
        assertEquals("artist" to albumId, MusicIds.parsePlayable(MusicIds.artistPlay(albumId)))
        assertEquals("shuffle" to "", MusicIds.parsePlayable(MusicIds.SHUFFLE_ALL))
    }

    @Test
    fun `browsable ids round-trip`() {
        assertEquals(trackId, MusicIds.parseArtist(MusicIds.artist(trackId)))
        assertEquals(albumId, MusicIds.parseAlbum(MusicIds.album(albumId)))
        assertNull(MusicIds.parseAlbum(MusicIds.artist(albumId)))
        assertNull(MusicIds.parseArtist(MusicIds.album(albumId)))
        assertNull(MusicIds.parseArtist("music/artist/"))
        assertNull(MusicIds.parseAlbum("music/album/"))
    }

    @Test
    fun `nothing else is playable or music`() {
        for (id in listOf("", "music", "music/play", "music/play/", "music/play/track/", "music/play/nonsense/x",
            "play/movie/abc", "tab/movies", "music/artists", MusicIds.artist(albumId))) {
            assertNull("playable: $id", MusicIds.parsePlayable(id))
        }
        assertNull(MediaIds.parsePlayable(MusicIds.track(trackId)), "a music id is not a film id")
        assertTrue(MusicIds.isMusic(MusicIds.TAB))
        assertTrue(MusicIds.isMusic(MusicIds.ALBUMS))
        assertTrue(MusicIds.isMusic(MusicIds.track(trackId)))
        assertFalse(MusicIds.isMusic("play/movie/abc"))
        assertFalse(MusicIds.isMusic("tab/movies"))
        assertFalse(MusicIds.isMusic("musicx/albums"))
    }

    @Test
    fun `album art paths the provider may fetch`() {
        assertTrue(ArtworkUris.isArtworkPath("/api/music/cover/" + "a".repeat(32)))
        assertTrue(ArtworkUris.isArtworkPath("/api/music/cover/0123456789abcdef0123456789abcdef"))
        for (bad in listOf(
            "/api/music/cover/" + "a".repeat(31),
            "/api/music/cover/" + "a".repeat(33),
            "/api/music/cover/" + "A".repeat(32),
            "/api/music/cover/../../api/me",
            "/api/music/cover/" + "a".repeat(32) + "?x=1",
            "/api/music/cover/" + "a".repeat(32) + "\n/evil",
            "/api/music/track/" + "a".repeat(20) + "/stream",
            "/api/music/cover/",
        )) {
            assertFalse("accepted: $bad", ArtworkUris.isArtworkPath(bad))
        }
    }

    private fun assertNull(actual: Any?, message: String) = org.junit.Assert.assertNull(message, actual)
}
