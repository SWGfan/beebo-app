package com.beeboentertainment.auto.sources

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The classification rules in [SourceProbe] are pure — they touch no Android
 * API and no network — so they run on a plain JVM. These pin the two decisions
 * a pasted link turns on: how a bare address is normalised into a URL, and what
 * counts as directly-playable media (by Content-Type and by path extension).
 */
class SourceProbeTest {

    // --------------------------------------------------------------- normalize

    @Test
    fun `normalize defaults a missing scheme to https`() {
        // Unlike the LAN base URL, arbitrary links default to https, not http.
        assertEquals("https://example.com/clip.mp4", SourceProbe.normalize("example.com/clip.mp4"))
    }

    @Test
    fun `normalize keeps an explicit scheme and the path`() {
        assertEquals("http://host/a/b.m3u8", SourceProbe.normalize("  http://host/a/b.m3u8  "))
        assertEquals("https://host/v.mp4", SourceProbe.normalize("https://host/v.mp4"))
    }

    @Test
    fun `normalize rejects blank and non-http input`() {
        for (bad in listOf("", "   ", "ftp://host/file")) {
            try {
                val out = SourceProbe.normalize(bad)
                fail("expected '$bad' to be rejected, got '$out'")
            } catch (e: IllegalArgumentException) {
                assertTrue("rejection must carry a message", !e.message.isNullOrBlank())
            }
        }
    }

    // ----------------------------------------------------- media content-type

    @Test
    fun `isMediaContentType recognizes audio video and hls`() {
        assertTrue(SourceProbe.isMediaContentType("video/mp4"))
        assertTrue(SourceProbe.isMediaContentType("audio/mpeg"))
        assertTrue(SourceProbe.isMediaContentType("application/vnd.apple.mpegurl"))
        assertTrue(SourceProbe.isMediaContentType("application/x-mpegurl"))
        // Charset parameters and casing must not defeat it.
        assertTrue(SourceProbe.isMediaContentType("VIDEO/WEBM; charset=utf-8"))
    }

    @Test
    fun `isMediaContentType rejects html json and null`() {
        assertFalse(SourceProbe.isMediaContentType("text/html"))
        assertFalse(SourceProbe.isMediaContentType("application/json"))
        assertFalse(SourceProbe.isMediaContentType(null))
    }

    // ------------------------------------------------------------ media path

    @Test
    fun `isMediaPath recognizes known extensions ignoring the query`() {
        for (u in listOf(
            "https://h/a/movie.mp4",
            "https://h/song.MP3",
            "https://h/stream.m3u8?token=abc",
            "https://h/clip.mkv",
        )) {
            assertTrue(u, SourceProbe.isMediaPath(u))
        }
    }

    @Test
    fun `isMediaPath is false for non-media and bare hosts`() {
        assertFalse(SourceProbe.isMediaPath("https://h/page.html"))
        assertFalse(SourceProbe.isMediaPath("https://h/api/movies"))
        assertFalse(SourceProbe.isMediaPath("https://h"))
    }

    // ----------------------------------------------------------- parse index

    @Test
    fun `parseIndex reads an items array and resolves relative urls`() {
        val body = """
            { "items": [
              { "title": "One", "stream": "/media/1.mp4" },
              { "name": "Two", "url": "https://cdn.example/2.mkv" }
            ] }
        """.trimIndent()
        val items = SourceProbe.parseIndex("https://host/api", body)!!
        assertEquals(2, items.size)
        assertEquals("One", items[0].label)
        assertEquals("https://host/media/1.mp4", items[0].url)
        assertEquals("https://cdn.example/2.mkv", items[1].url)
    }

    @Test
    fun `parseIndex returns null when nothing looks like a listing`() {
        assertNull(SourceProbe.parseIndex("https://host", "<html>not json</html>"))
        assertNull(SourceProbe.parseIndex("https://host", """{"ok":true}"""))
    }
}
