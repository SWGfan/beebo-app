package com.beeboentertainment.movie.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules behind casting away from home, where this phone stands between the TV and the home
 * computer. Nothing here talks to a socket, a Chromecast or a network - see PhoneCastRelay for
 * the parts that do, and the report that came with this change for what could NOT be tested
 * (a real Chromecast, on real Wi-Fi, was never in the loop).
 */
class PhoneCastRulesTest {

    private val token = "0123456789abcdef0123456789abcdef"

    // ------------------------------------------------------------------ the token

    @Test fun `a token only matches itself`() {
        assertTrue(PhoneCastRules.tokenMatches(token, token))
        assertFalse(PhoneCastRules.tokenMatches(token, token.dropLast(1)))
        assertFalse(PhoneCastRules.tokenMatches(token, token.dropLast(1) + "0"))
        assertFalse(PhoneCastRules.tokenMatches(token, token.uppercase()))
        assertFalse(PhoneCastRules.tokenMatches(token, ""))
        assertFalse(PhoneCastRules.tokenMatches(token, null))
        // No session running: nothing matches, not even an empty guess.
        assertFalse(PhoneCastRules.tokenMatches(null, token))
        assertFalse(PhoneCastRules.tokenMatches(null, null))
        assertFalse(PhoneCastRules.tokenMatches("", ""))
    }

    @Test fun `a token is 32 hex characters`() {
        val made = PhoneCastRules.tokenFrom(ByteArray(PhoneCastRules.TOKEN_BYTES) { (it * 17).toByte() })
        assertEquals(PhoneCastRules.TOKEN_BYTES * 2, made.length)
        assertTrue(made.all { it in "0123456789abcdef" })
        assertEquals("00", PhoneCastRules.tokenFrom(byteArrayOf(0)))
        assertEquals("ff", PhoneCastRules.tokenFrom(byteArrayOf(-1)))
    }

    // ------------------------------------------------------------------ routing

    @Test fun `only this film's own files are served, and only with the right token`() {
        val slots = setOf(0, 1)
        assertEquals(
            PhoneCastRules.Routed.Serve(0),
            PhoneCastRules.route("GET", "/c/$token/0", token, slots)
        )
        assertEquals(
            PhoneCastRules.Routed.Serve(1),
            PhoneCastRules.route("HEAD", "/c/$token/1", token, slots)
        )
        // A query string the TV tacked on changes nothing.
        assertEquals(
            PhoneCastRules.Routed.Serve(0),
            PhoneCastRules.route("GET", "/c/$token/0?x=1#y", token, slots)
        )
        // Wrong token: refused, and told nothing about which slots exist.
        assertEquals(
            PhoneCastRules.Routed.Forbidden,
            PhoneCastRules.route("GET", "/c/${"f".repeat(32)}/0", token, slots)
        )
        assertEquals(
            PhoneCastRules.Routed.Forbidden,
            PhoneCastRules.route("GET", "/c/${"f".repeat(32)}/9", token, slots)
        )
        // Right token, a slot this film never had.
        assertEquals(PhoneCastRules.Routed.NotFound, PhoneCastRules.route("GET", "/c/$token/7", token, slots))
    }

    @Test fun `there is nothing else on this server at all`() {
        val slots = setOf(0)
        for (target in listOf(
            "/", "/index.html", "/c", "/c/", "/c/$token", "/c/$token/", "/file", "/favicon.ico",
            "/c/$token/0/extra", "/c/$token/../0", "/C/$token/0", "//c/$token/0",
            "/c/$token/00000", "/c/$token/-1", "/c/$token/x", "/c//0",
        )) {
            assertEquals("target $target", PhoneCastRules.Routed.NotFound, PhoneCastRules.route("GET", target, token, slots))
        }
    }

    @Test fun `nothing but GET and HEAD fetches anything`() {
        for (method in listOf("POST", "PUT", "DELETE", "PATCH", "TRACE", "CONNECT")) {
            assertEquals(
                PhoneCastRules.Routed.MethodNotAllowed,
                PhoneCastRules.route(method, "/c/$token/0", token, setOf(0))
            )
        }
        assertEquals(PhoneCastRules.Routed.Serve(0), PhoneCastRules.route("get", "/c/$token/0", token, setOf(0)))
    }

    @Test fun `asking permission first is answered the same way whatever was asked`() {
        // A Cast receiver fetching a subtitle file with a script may ask first. The answer never
        // depends on the token or the slot, so it gives nothing away.
        for (target in listOf("/c/$token/0", "/c/${"f".repeat(32)}/0", "/", "/anything")) {
            assertEquals(
                PhoneCastRules.Routed.Preflight,
                PhoneCastRules.route("OPTIONS", target, token, setOf(0))
            )
        }
        val headers = PhoneCastRules.preflightHeaders().toMap()
        assertEquals("*", headers["Access-Control-Allow-Origin"])
        assertEquals("0", headers["Content-Length"])
        assertTrue(headers["Access-Control-Allow-Headers"]!!.contains("Range"))
        // Reading only: nothing here ever lets anyone send anything.
        assertFalse(headers["Access-Control-Allow-Methods"]!!.contains("POST"))
        assertFalse(headers["Access-Control-Allow-Methods"]!!.contains("PUT"))
    }

    @Test fun `with no session running, nothing is served`() {
        assertEquals(PhoneCastRules.Routed.Forbidden, PhoneCastRules.route("GET", "/c/$token/0", null, emptySet()))
        assertEquals(PhoneCastRules.Routed.Forbidden, PhoneCastRules.route("GET", "/c/$token/0", "", setOf(0)))
    }

    // ------------------------------------------------------------ what can be passed on

    @Test fun `a whole file can be passed on, a converted stream cannot`() {
        assertTrue(PhoneCastRules.canPassThrough("https://nick.beebo.tv/file?id=1&mt=t"))
        assertTrue(PhoneCastRules.canPassThrough("https://nick.beebo.tv/tvfile?id=1&mt=t"))
        assertTrue(PhoneCastRules.canPassThrough("https://nick.beebo.tv/subtitles/file?i=0&mt=t"))
        assertTrue(PhoneCastRules.canPassThrough("https://image.tmdb.org/t/p/w500/x.jpg"))
        // A converting stream is a playlist naming pieces of its own; passing it on byte for
        // byte would leave the TV asking this phone for files nobody registered.
        assertFalse(PhoneCastRules.canPassThrough("https://nick.beebo.tv/hls/abc/index.m3u8"))
        assertFalse(PhoneCastRules.canPassThrough("https://nick.beebo.tv/hls/abc/index.m3u8?t=9"))
        assertFalse(PhoneCastRules.canPassThrough("https://nick.beebo.tv/hls/abc/INDEX.M3U8"))
        assertFalse(PhoneCastRules.canPassThrough("https://nick.beebo.tv/dash/abc/manifest.mpd"))
    }

    // ------------------------------------------------------------------ Range

    @Test fun `the TV's range is passed on to the home computer`() {
        assertEquals(PhoneCastRules.RangeDecision.Pass("bytes=0-"), PhoneCastRules.rangeFor("bytes=0-"))
        assertEquals(PhoneCastRules.RangeDecision.Pass("bytes=1048576-"), PhoneCastRules.rangeFor("bytes=1048576-"))
        assertEquals(PhoneCastRules.RangeDecision.Pass("bytes=100-199"), PhoneCastRules.rangeFor("bytes=100-199"))
        assertEquals(PhoneCastRules.RangeDecision.Pass("bytes=5-5"), PhoneCastRules.rangeFor("bytes=5-5"))
        // The last N bytes, which is how a player finds an mp4's index when it is at the end.
        assertEquals(PhoneCastRules.RangeDecision.Pass("bytes=-65536"), PhoneCastRules.rangeFor("bytes=-65536"))
        // Whitespace and capitals as senders really write them.
        assertEquals(PhoneCastRules.RangeDecision.Pass("bytes=10-20"), PhoneCastRules.rangeFor("Bytes= 10 - 20 "))
    }

    @Test fun `no range means the whole film`() {
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor(null))
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor(""))
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor("   "))
    }

    @Test fun `a range that makes no sense is ignored, not refused`() {
        // RFC 7233: a Range a server cannot understand is ignored, and the whole thing sent.
        // Playing (and paying a little more for seeking) beats refusing to play.
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor("items=0-10"))
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor("bytes"))
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor("bytes="))
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor("bytes=abc-def"))
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor("bytes=1-2-3"))
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor("bytes=-"))
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor("bytes=0-99,200-299"))
        // Absurdly long: ignored rather than parsed.
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor("bytes=" + "9".repeat(200)))
        // Bigger than a Long: not a number this phone can use, so the whole thing goes.
        assertEquals(PhoneCastRules.RangeDecision.Whole, PhoneCastRules.rangeFor("bytes=99999999999999999999-"))
    }

    @Test fun `a range that can never be satisfied is refused with 416`() {
        assertEquals(PhoneCastRules.RangeDecision.Unsatisfiable, PhoneCastRules.rangeFor("bytes=500-100"))
        assertEquals(PhoneCastRules.RangeDecision.Unsatisfiable, PhoneCastRules.rangeFor("bytes=1-0"))
        // "the last zero bytes" is a real request for nothing at all.
        assertEquals(PhoneCastRules.RangeDecision.Unsatisfiable, PhoneCastRules.rangeFor("bytes=-0"))
    }

    // ------------------------------------------------------------------ the answer

    @Test fun `the answer says what the home computer said, plus what a TV needs`() {
        val headers = PhoneCastRules.responseHeaders(
            upstreamStatus = 206,
            contentType = "video/mp4",
            contentLength = 1000,
            contentRange = "bytes 100-1099/50000",
        ).toMap()
        assertEquals("video/mp4", headers["Content-Type"])
        assertEquals("1000", headers["Content-Length"])
        assertEquals("bytes 100-1099/50000", headers["Content-Range"])
        // Without this a Chromecast cannot seek at all.
        assertEquals("bytes", headers["Accept-Ranges"])
        assertEquals("no-store", headers["Cache-Control"])
        // The receiver page is served from the internet, so this phone is a different origin.
        assertEquals("*", headers["Access-Control-Allow-Origin"])
        assertTrue(headers["Access-Control-Expose-Headers"]!!.contains("Content-Range"))
    }

    @Test fun `a whole-file answer carries no Content-Range, and an unknown length no header`() {
        val whole = PhoneCastRules.responseHeaders(200, "video/mp4", 50_000, null).toMap()
        assertEquals("50000", whole["Content-Length"])
        assertNull(whole["Content-Range"])
        assertEquals("bytes", whole["Accept-Ranges"])
        // A Content-Range on a 200 would be a lie; drop it whatever the home computer sent.
        assertNull(PhoneCastRules.responseHeaders(200, "video/mp4", 5, "bytes 0-4/5").toMap()["Content-Range"])
        val unknown = PhoneCastRules.responseHeaders(200, null, -1, null).toMap()
        assertNull(unknown["Content-Length"])
        assertEquals("application/octet-stream", unknown["Content-Type"])
    }

    @Test fun `nothing from the home computer can smuggle in a header of its own`() {
        val sneaky = PhoneCastRules.responseHeaders(
            upstreamStatus = 206,
            contentType = "video/mp4\r\nSet-Cookie: x=1",
            contentLength = 10,
            contentRange = "bytes 0-9/10\r\nLocation: http://evil",
        ).toMap()
        assertEquals("application/octet-stream", sneaky["Content-Type"])
        assertNull(sneaky["Content-Range"])
        assertNull(sneaky["Set-Cookie"])
        assertNull(sneaky["Location"])
    }

    @Test fun `the address handed to the TV is plain and predictable`() {
        assertEquals(
            "http://192.168.1.44:52411/c/$token/3",
            PhoneCastRules.url("192.168.1.44", 52411, token, 3)
        )
        assertTrue(PhoneCastRules.statusLine(206).startsWith("HTTP/1.1 206 "))
        assertTrue(PhoneCastRules.statusLine(416).contains("Range Not Satisfiable"))
    }
}
