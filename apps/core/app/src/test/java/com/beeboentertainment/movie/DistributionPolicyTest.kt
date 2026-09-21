package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.DistributionPolicy
import com.beeboentertainment.movie.hub.HubClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class DistributionPolicyTest {

    @Test
    fun `play build drops purchase-adjacent and arbitrary-link features`() {
        assertFalse(DistributionPolicy.showsRelayBalanceBanner(isPlayBuild = true))
        assertFalse(DistributionPolicy.opensWebsiteLinks(isPlayBuild = true))
        assertFalse(DistributionPolicy.offersAddSource(isPlayBuild = true))
        assertFalse(DistributionPolicy.trustsHubPaymentMessage(isPlayBuild = true))
    }

    @Test
    fun `website build keeps them`() {
        assertTrue(DistributionPolicy.showsRelayBalanceBanner(isPlayBuild = false))
        assertTrue(DistributionPolicy.opensWebsiteLinks(isPlayBuild = false))
        assertTrue(DistributionPolicy.offersAddSource(isPlayBuild = false))
        assertTrue(DistributionPolicy.trustsHubPaymentMessage(isPlayBuild = false))
    }

    @Test
    fun `plain address has no scheme or www`() {
        assertEquals("beeboentertainment.com/will-beebo-work.html",
            DistributionPolicy.plainAddress("https://www.beeboentertainment.com/will-beebo-work.html"))
        assertEquals("example.com", DistributionPolicy.plainAddress("http://example.com/"))
    }

    @Test
    fun `hub 402 text from the server is dropped in the play build`() {
        val server = "Subscribe at beeboentertainment.com/#pricing"
        assertEquals(server, HubClient.messageFor(402, server, isPlayBuild = false))
        val play = HubClient.messageFor(402, server, isPlayBuild = true)
        assertFalse(play.contains("pricing", ignoreCase = true))
        assertFalse(play.contains("beeboentertainment", ignoreCase = true))
        // Other codes are unaffected.
        assertEquals("boom", HubClient.messageFor(500, "boom", isPlayBuild = true))
    }

    @Test
    fun `the screens actually consult the policy`() {
        val root = File("src/main/java/com/beeboentertainment/movie")
        fun read(p: String) = File(root, p).readText()
        assertTrue(read("rtc/RemoteAccess.kt").contains("DistributionPolicy.showsRelayBalanceBanner"))
        assertTrue(read("ui/screens/RemoteBanners.kt").contains("DistributionPolicy.opensWebsiteLinks"))
        assertTrue(read("ui/screens/SetupScreen.kt").contains("DistributionPolicy.opensWebsiteLinks"))
        assertTrue(read("ui/MainActivity.kt").contains("DistributionPolicy.offersAddSource"))
    }
}
