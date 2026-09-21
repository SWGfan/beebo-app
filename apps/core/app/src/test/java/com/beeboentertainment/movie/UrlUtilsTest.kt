package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.UrlUtils
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Base URL + relative path joining. The contract says `poster` and `stream` are always
 * server-relative, and the owner types the base URL by hand, so both halves are messy.
 */
class UrlUtilsTest {

    @Test
    fun `normalize adds https scheme when missing - the server has a real certificate now`() {
        assertEquals(
            "https://example-house.duckdns.org:47811",
            UrlUtils.normalizeBaseUrl("example-house.duckdns.org:47811")
        )
        // a bare LAN address gets https too; the upgrade probe is what decides if it sticks
        assertEquals("https://10.0.0.5:47811", UrlUtils.normalizeBaseUrl("10.0.0.5:47811"))
    }

    /* ------------------------------ https upgrade ---------------------------- */

    @Test
    fun `an existing http install is upgraded to https, keeping host and port`() {
        assertEquals(
            "https://example-house.duckdns.org:47811",
            UrlUtils.upgradeToHttps("http://example-house.duckdns.org:47811")
        )
        assertTrue(UrlUtils.needsHttpsUpgrade("http://example-house.duckdns.org:47811"))
    }

    @Test
    fun `a non-default port survives the upgrade untouched`() {
        assertEquals("https://192.168.1.50:8096", UrlUtils.upgradeToHttps("http://192.168.1.50:8096"))
        assertEquals("https://example.com:1234", UrlUtils.upgradeToHttps("http://example.com:1234"))
        // and a path, if someone typed one
        assertEquals("https://example.com:1234/media", UrlUtils.upgradeToHttps("http://example.com:1234/media"))
    }

    @Test
    fun `an address already on https is left exactly as it was`() {
        val already = "https://example-house.duckdns.org:47811"
        assertEquals(already, UrlUtils.upgradeToHttps(already))
        assertFalse(UrlUtils.needsHttpsUpgrade(already))
    }

    @Test
    fun `a bare hostname comes out as https and needs no further upgrade`() {
        assertEquals(
            "https://example-house.duckdns.org:47811",
            UrlUtils.upgradeToHttps("example-house.duckdns.org:47811")
        )
        assertFalse(UrlUtils.needsHttpsUpgrade("example-house.duckdns.org:47811"))
    }

    @Test
    fun `an upgrade is idempotent`() {
        val once = UrlUtils.upgradeToHttps("http://host:47811")
        assertEquals(once, UrlUtils.upgradeToHttps(once))
    }

    @Test
    fun `empty or garbage input does not crash and asks for no upgrade`() {
        assertNull(UrlUtils.upgradeToHttps(null))
        assertNull(UrlUtils.upgradeToHttps(""))
        assertNull(UrlUtils.upgradeToHttps("   "))
        assertNull(UrlUtils.upgradeToHttps("http://"))
        assertFalse(UrlUtils.needsHttpsUpgrade(null))
        assertFalse(UrlUtils.needsHttpsUpgrade(""))
        assertFalse(UrlUtils.needsHttpsUpgrade("http://"))
    }

    @Test
    fun `trailing slashes and whitespace are handled while upgrading`() {
        assertEquals("https://host:47811", UrlUtils.upgradeToHttps("  http://host:47811///  "))
    }

    @Test
    fun `relative stream and poster paths join onto an https base`() {
        // nothing in the app may assume http:// — the cast receiver now gets https URLs
        assertEquals(
            "https://host:47811/file?id=abc&mt=deadbeef",
            UrlUtils.join("https://host:47811", "/file?id=abc&mt=deadbeef")
        )
        assertEquals(
            "https://host:47811/media/poster/123.jpg",
            UrlUtils.join("https://host:47811/", "media/poster/123.jpg")
        )
    }

    @Test
    fun `normalize strips trailing slashes`() {
        assertEquals(
            "http://example-house.duckdns.org:47811",
            UrlUtils.normalizeBaseUrl("http://example-house.duckdns.org:47811/")
        )
        assertEquals(
            "http://10.0.0.5:47811",
            UrlUtils.normalizeBaseUrl("  http://10.0.0.5:47811///  ")
        )
    }

    @Test
    fun `normalize keeps https untouched`() {
        assertEquals("https://example.com", UrlUtils.normalizeBaseUrl("https://example.com"))
    }

    @Test
    fun `normalize rejects empty input`() {
        assertNull(UrlUtils.normalizeBaseUrl(null))
        assertNull(UrlUtils.normalizeBaseUrl("   "))
        assertNull(UrlUtils.normalizeBaseUrl("http://"))
    }

    @Test
    fun `join handles trailing slash on base and leading slash on path`() {
        val expected = "http://host:47811/media/poster/123.jpg"
        assertEquals(expected, UrlUtils.join("http://host:47811", "/media/poster/123.jpg"))
        assertEquals(expected, UrlUtils.join("http://host:47811/", "/media/poster/123.jpg"))
        assertEquals(expected, UrlUtils.join("http://host:47811//", "/media/poster/123.jpg"))
        assertEquals(expected, UrlUtils.join("http://host:47811/", "media/poster/123.jpg"))
    }

    @Test
    fun `join preserves stream query string`() {
        assertEquals(
            "http://host:47811/file?id=abc%3D%3D&mt=deadbeef",
            UrlUtils.join("http://host:47811/", "/file?id=abc%3D%3D&mt=deadbeef")
        )
    }

    @Test
    fun `join returns null for a null path so callers can show a placeholder`() {
        // poster is null whenever the server has no cached poster
        assertNull(UrlUtils.join("http://host:47811", null))
        assertNull(UrlUtils.join("http://host:47811", ""))
    }

    @Test
    fun `join returns null when there is no base url yet`() {
        assertNull(UrlUtils.join(null, "/file?id=1"))
    }

    @Test
    fun `join leaves absolute urls alone`() {
        assertEquals(
            "http://other:1234/x.jpg",
            UrlUtils.join("http://host:47811", "http://other:1234/x.jpg")
        )
    }

    @Test
    fun `query skips blank values and encodes the rest`() {
        assertEquals("", UrlUtils.query("genre" to null, "q" to ""))
        assertEquals("?genre=28", UrlUtils.query("genre" to "28", "q" to null))
        assertEquals("?q=star%20wars", UrlUtils.query("q" to "star wars"))
        assertEquals("?kind=movie&i=3", UrlUtils.query("kind" to "movie", "genre" to null, "i" to "3"))
    }

    /* ------------------------------ name.beebo.tv ---------------------------- */

    @Test
    fun `a personal beebo tv address is recognised however it was typed`() {
        assertEquals("samplehouse", UrlUtils.beeboTvName("samplehouse.beebo.tv"))
        assertEquals("nick", UrlUtils.beeboTvName("  HTTPS://Nick.Beebo.TV/  "))
        assertEquals("nick", UrlUtils.beeboTvName("http://nick.beebo.tv:443/some/path?x=1"))
        assertEquals("nick", UrlUtils.beeboTvName("nick.beebo.tv."))
    }

    @Test
    fun `home servers and non-personal beebo addresses are not mistaken for one`() {
        assertNull(UrlUtils.beeboTvName("beebo.tv"))
        assertNull(UrlUtils.beeboTvName("www.beebo.tv"))
        assertNull(UrlUtils.beeboTvName("a.b.beebo.tv"))
        assertNull(UrlUtils.beeboTvName("nickbeebo.tv"))
        assertNull(UrlUtils.beeboTvName("nick.beebo.tv.evil.com"))
        assertNull(UrlUtils.beeboTvName("192.168.1.50:47811"))
        assertNull(UrlUtils.beeboTvName("https://example-house.duckdns.org:47811"))
        assertNull(UrlUtils.beeboTvName(""))
        assertNull(UrlUtils.beeboTvName(null))
    }
}
