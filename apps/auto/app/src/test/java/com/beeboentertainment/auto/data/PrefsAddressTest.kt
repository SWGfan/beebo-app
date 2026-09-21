package com.beeboentertainment.auto.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The saved address: the old DuckDNS default is gone, and name.beebo.tv is kept as the tunnel's name. */
class PrefsAddressTest {

    @Test
    fun theOldDuckDnsDefaultCountsAsUnset() {
        assertEquals("", Prefs.migrateSavedBaseUrl("https://example-house.duckdns.org:47811"))
        assertEquals("", Prefs.migrateSavedBaseUrl("http://example-house.duckdns.org:47811"))
        assertEquals("", Prefs.migrateSavedBaseUrl("HTTPS://Example-House.DuckDNS.org:47811/"))
        assertEquals("", Prefs.migrateSavedBaseUrl(" example-house.duckdns.org "))
        assertEquals("", Prefs.migrateSavedBaseUrl(null))
        assertEquals("", Prefs.migrateSavedBaseUrl(""))
    }

    @Test
    fun everyOtherSavedAddressIsKeptAsItWas() {
        assertEquals("http://192.168.1.10:47811", Prefs.migrateSavedBaseUrl("http://192.168.1.10:47811"))
        assertEquals("https://nick.beebo.tv", Prefs.migrateSavedBaseUrl("https://nick.beebo.tv"))
        // Same DuckDNS host on a different port is somebody's own setup, not the old default.
        assertEquals(
            "https://example-house.duckdns.org:8443",
            Prefs.migrateSavedBaseUrl("https://example-house.duckdns.org:8443"),
        )
        assertEquals("https://other.duckdns.org:47811", Prefs.migrateSavedBaseUrl("https://other.duckdns.org:47811"))
    }

    @Test
    fun aBeeboTvNameIsTheTunnelNotAServerWithAPort() {
        assertEquals("https://nick.beebo.tv", Prefs.normalizeBaseUrl("nick.beebo.tv"))
        assertEquals("https://nick.beebo.tv", Prefs.normalizeBaseUrl("https://Nick.beebo.tv/"))
        assertEquals("https://nick.beebo.tv", Prefs.normalizeBaseUrl("http://nick.beebo.tv:47811/api"))
    }

    @Test
    fun directAddressesStillGetPort47811() {
        assertEquals("http://192.168.1.10:47811", Prefs.normalizeBaseUrl("192.168.1.10"))
        assertEquals("https://host:47811", Prefs.normalizeBaseUrl("https://host:47811/"))
        assertEquals("http://beebo.local:8080", Prefs.normalizeBaseUrl("beebo.local:8080"))
        assertEquals("", Prefs.normalizeBaseUrl("  "))
        // Not personal beebo.tv addresses: treated like any other host.
        assertEquals("http://www.beebo.tv:47811", Prefs.normalizeBaseUrl("www.beebo.tv"))
    }

    @Test
    fun badAddressesSaySoWithoutMentioningDuckDns() {
        try {
            Prefs.normalizeBaseUrl("http:/host")
            fail("accepted a broken address")
        } catch (e: InvalidServerAddressException) {
            assertTrue(e.message!!.isNotBlank())
            assertTrue(!e.message!!.contains("duckdns", ignoreCase = true))
        }
    }
}
