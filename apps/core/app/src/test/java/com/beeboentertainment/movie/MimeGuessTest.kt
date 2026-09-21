package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.MimeGuess
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Chromecast default receiver needs a correct content type; unlike ExoPlayer it cannot
 * sniff the container. The contract's stream URLs carry no extension in the path, so the
 * guesser has to dig through the query string too.
 */
class MimeGuessTest {

    @Test
    fun `known extensions map to the right types`() {
        assertEquals("video/x-matroska", MimeGuess.fromExtension("mkv"))
        assertEquals("video/x-matroska", MimeGuess.fromExtension(".MKV"))
        assertEquals("video/mp4", MimeGuess.fromExtension("mp4"))
        assertEquals("video/mp4", MimeGuess.fromExtension("m4v"))
        assertEquals("video/x-msvideo", MimeGuess.fromExtension("avi"))
        assertEquals("video/quicktime", MimeGuess.fromExtension("mov"))
        assertEquals("video/mp2t", MimeGuess.fromExtension("ts"))
        assertEquals("video/webm", MimeGuess.fromExtension("webm"))
        assertEquals("application/x-mpegURL", MimeGuess.fromExtension("m3u8"))
    }

    @Test
    fun `unknown or empty extensions return null`() {
        assertNull(MimeGuess.fromExtension("zzz"))
        assertNull(MimeGuess.fromExtension(""))
        assertNull(MimeGuess.fromExtension(null))
    }

    @Test
    fun `extension in the url path wins`() {
        assertEquals(
            "video/x-matroska",
            MimeGuess.forStreamUrl("http://host:47811/media/Some%20Movie.mkv")
        )
    }

    @Test
    fun `extension found in a query parameter value`() {
        assertEquals(
            "video/x-matroska",
            MimeGuess.forStreamUrl("http://host:47811/file?path=%2Fmovies%2FThe%20Thing.mkv&mt=abc123")
        )
    }

    @Test
    fun `extension recovered from a base64 encoded id`() {
        val encoded = java.util.Base64.getEncoder()
            .encodeToString("/srv/movies/Heat (1995).avi".toByteArray())
        val url = "http://host:47811/file?id=" +
            java.net.URLEncoder.encode(encoded, "UTF-8") + "&mt=deadbeef"
        assertEquals("video/x-msvideo", MimeGuess.forStreamUrl(url))
    }

    @Test
    fun `falls back to mp4 when nothing is identifiable`() {
        assertEquals(
            MimeGuess.DEFAULT,
            MimeGuess.forStreamUrl("http://host:47811/file?id=0123456789&mt=deadbeef")
        )
        assertEquals("video/mp4", MimeGuess.DEFAULT)
    }

    @Test
    fun `title hint is used as a last resort`() {
        assertEquals(
            "video/x-matroska",
            MimeGuess.forStreamUrl("http://host:47811/tvfile?id=xyz&mt=abc", hint = "Show - S1E2.mkv")
        )
    }

    @Test
    fun `local downloaded file paths still map correctly`() {
        assertEquals(
            "video/x-matroska",
            MimeGuess.forStreamUrl("file:///data/user/0/com.beeboentertainment.movie/files/offline/Heat_1a2b.mkv")
        )
    }

    @Test
    fun `garbage tails are not mistaken for extensions`() {
        // a 12-char "extension" is not an extension
        assertEquals(MimeGuess.DEFAULT, MimeGuess.forStreamUrl("http://host/file?id=a.verylongthing"))
    }
}
