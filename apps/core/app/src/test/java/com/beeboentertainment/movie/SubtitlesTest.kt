package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.ExpiringCache
import com.beeboentertainment.movie.core.SubtitlePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Sidecar subtitles: which one a remembered preference picks, when the service puts them on an
 * item it moved to by itself, and the short-lived list cache the Activity and service share.
 */
class SubtitlesTest {

    /* ------------------------------ the track id ----------------------------- */

    @Test
    fun `each sidecar gets its own stable id`() {
        assertEquals("beebo-sub-0", SubtitlePolicy.tag(0))
        assertEquals(SubtitlePolicy.tag(1), SubtitlePolicy.tag(1))
        assertNotEquals(SubtitlePolicy.tag(0), SubtitlePolicy.tag(1))
    }

    /* --------------------------- remembered choice --------------------------- */

    @Test
    fun `subtitles off selects nothing, whatever is on offer`() {
        assertEquals(-1, SubtitlePolicy.rememberedIndex(listOf("en", "es"), subtitlesOn = false, wantedLanguage = "es"))
    }

    @Test
    fun `nothing on offer selects nothing even with subtitles on`() {
        assertEquals(-1, SubtitlePolicy.rememberedIndex(emptyList(), subtitlesOn = true, wantedLanguage = "en"))
    }

    @Test
    fun `the remembered language is found wherever it sits`() {
        assertEquals(1, SubtitlePolicy.rememberedIndex(listOf("en", "es"), subtitlesOn = true, wantedLanguage = "es"))
        assertEquals(1, SubtitlePolicy.rememberedIndex(listOf("en", "ES"), subtitlesOn = true, wantedLanguage = "es"))
    }

    @Test
    fun `the first of two same-language sidecars wins`() {
        // "English" then "English (SDH)": the language cannot tell them apart, so the first.
        assertEquals(0, SubtitlePolicy.rememberedIndex(listOf("en", "en"), subtitlesOn = true, wantedLanguage = "en"))
    }

    @Test
    fun `an unmatched or unknown language falls back to the first sidecar`() {
        assertEquals(0, SubtitlePolicy.rememberedIndex(listOf("fr", "de"), subtitlesOn = true, wantedLanguage = "en"))
        assertEquals(0, SubtitlePolicy.rememberedIndex(listOf(null, "de"), subtitlesOn = true, wantedLanguage = null))
        assertEquals(0, SubtitlePolicy.rememberedIndex(listOf("de"), subtitlesOn = true, wantedLanguage = " "))
    }

    /* --------------------- the service attaching them itself -------------------- */

    private fun attach(
        subtitlesOn: Boolean = true,
        casting: Boolean = false,
        itemId: String? = "ep-2",
        uri: String? = "https://beebo.example/tvfile?id=ep-2",
        alreadyAttached: Boolean = false
    ) = SubtitlePolicy.shouldAttach(subtitlesOn, casting, itemId, uri, alreadyAttached)

    @Test
    fun `a bare streamed episode gets its sidecars when subtitles are on`() {
        assertTrue(attach())
        assertTrue(attach(uri = "http://192.168.1.20:8080/tvfile?id=ep-2"))
    }

    @Test
    fun `no re-prepare when the viewer does not want subtitles`() {
        assertFalse(attach(subtitlesOn = false))
    }

    @Test
    fun `an item that already carries sidecars is left alone`() {
        assertFalse(attach(alreadyAttached = true))
    }

    @Test
    fun `never while casting, where the receiver cannot use them`() {
        assertFalse(attach(casting = true))
    }

    @Test
    fun `a downloaded file never reaches for the network`() {
        assertFalse(attach(uri = "file:///data/user/0/com.beeboentertainment.movie/files/ep-2.mp4"))
        assertFalse(attach(uri = null))
    }

    @Test
    fun `an item with no library id has no sidecar list to ask for`() {
        assertFalse(attach(itemId = null))
        assertFalse(attach(itemId = ""))
    }

    /* ------------------------------ list cache ------------------------------- */

    @Test
    fun `a cached answer is reused until it expires`() {
        var now = 1_000L
        val cache = ExpiringCache<List<String>>(ttlMs = 600_000L, maxEntries = 4) { now }
        cache.put("tv|ep-1", listOf("en"))
        now += 599_999L
        assertEquals(listOf("en"), cache.get("tv|ep-1"))
        now += 1L
        assertNull(cache.get("tv|ep-1"))
    }

    @Test
    fun `an empty answer is still an answer`() {
        val cache = ExpiringCache<List<String>>(ttlMs = 1_000L, maxEntries = 4) { 0L }
        cache.put("movie|m-1", emptyList())
        assertEquals(emptyList<String>(), cache.get("movie|m-1"))
        assertNull(cache.get("movie|m-2"))
    }

    @Test
    fun `the least recently used entry is dropped past the limit`() {
        val cache = ExpiringCache<Int>(ttlMs = 1_000L, maxEntries = 2) { 0L }
        cache.put("a", 1)
        cache.put("b", 2)
        cache.get("a")          // a is now more recent than b
        cache.put("c", 3)
        assertEquals(1, cache.get("a"))
        assertNull(cache.get("b"))
        assertEquals(3, cache.get("c"))
    }
}
