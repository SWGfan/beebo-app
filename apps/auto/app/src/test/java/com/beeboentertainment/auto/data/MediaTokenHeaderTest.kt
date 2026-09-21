package com.beeboentertainment.auto.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class MediaTokenHeaderTest {

    private val base = "https://example-house.duckdns.org:47811"

    @Before
    fun reset() = MediaTokenHeader.forgetAll()

    @Test
    fun `split takes mt out of a stream url and keeps everything else`() {
        val s = MediaTokenHeader.split("$base/file?id=QUJD%3D&mt=1789000000000.a-b_c")!!
        assertEquals("$base/file?id=QUJD%3D", s.url)
        assertEquals("1789000000000.a-b_c", s.token)

        val sub = MediaTokenHeader.split("$base/subtitles/file?kind=tv&id=x&i=2&mt=9.z")!!
        assertEquals("$base/subtitles/file?kind=tv&id=x&i=2", sub.url)
        assertEquals("9.z", sub.token)

        val first = MediaTokenHeader.split("$base/tvfile?mt=1.q&id=y")!!
        assertEquals("$base/tvfile?id=y", first.url)
    }

    @Test
    fun `split leaves alone anything that is not a tokened stream url`() {
        assertNull(MediaTokenHeader.split("$base/file?id=x"))
        assertNull(MediaTokenHeader.split("$base/file?id=x&mt="))
        assertNull(MediaTokenHeader.split("$base/api/movies?mt=1.a"))
        assertNull(MediaTokenHeader.split("$base/poster?id=x&format=mt"))
        assertNull(MediaTokenHeader.split("file:///sdcard/Movies/x.mp4"))
        assertNull(MediaTokenHeader.split("not a url at all"))
    }

    @Test
    fun `header form only for a server that advertised it`() {
        val url = "$base/file?id=x&mt=1.a"
        assertNull(MediaTokenHeader.forPlayback(url))

        MediaTokenHeader.noteResponse("$base/api/movies", "1")
        assertEquals("$base/file?id=x", MediaTokenHeader.forPlayback(url)!!.url)

        // A different port or scheme is a different server.
        assertFalse(MediaTokenHeader.serverAccepts("http://example-house.duckdns.org:47811/file"))
        assertFalse(MediaTokenHeader.serverAccepts("https://example-house.duckdns.org/file"))
        // Default ports compare equal to explicit ones.
        MediaTokenHeader.noteResponse("https://hub.example.com/api/ping", "1")
        assertTrue(MediaTokenHeader.serverAccepts("https://HUB.example.com:443/file?id=x"))
    }

    @Test
    fun `a response without the capability turns it back off`() {
        MediaTokenHeader.noteResponse("$base/api/ping", "1")
        assertTrue(MediaTokenHeader.serverAccepts("$base/file"))
        MediaTokenHeader.noteResponse("$base/api/movies", null)
        assertFalse(MediaTokenHeader.serverAccepts("$base/file"))
        assertNull(MediaTokenHeader.forPlayback("$base/file?id=x&mt=1.a"))
    }
}
