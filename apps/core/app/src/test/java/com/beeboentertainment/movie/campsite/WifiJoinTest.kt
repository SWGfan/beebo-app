package com.beeboentertainment.movie.campsite

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom

class WifiJoinTest {

    @Test fun `location is explained only on Android 8 to 12`() {
        assertFalse(WifiJoin.asksForLocation(25))
        assertTrue(WifiJoin.asksForLocation(26))
        assertTrue(WifiJoin.asksForLocation(32))
        assertFalse(WifiJoin.asksForLocation(33))
        assertFalse(WifiJoin.asksForLocation(36))
        assertTrue(WifiJoin.LOCATION_NOTICE.contains("never reads"))
    }

    @Test fun `password is 8 characters from the unambiguous alphabet`() {
        repeat(500) {
            val p = WifiJoin.newPassword()
            assertEquals(8, p.length)
            assertTrue("bad character in $p", p.all { it in WifiJoin.ALPHABET })
            assertTrue(WifiJoin.isGeneratedPassword(p))
        }
    }

    @Test fun `alphabet has nothing that reads as another character`() {
        for (c in "0O1lIL") assertFalse("$c must not be used", c in WifiJoin.ALPHABET)
        assertEquals(31, WifiJoin.ALPHABET.length)
        assertEquals(WifiJoin.ALPHABET.length, WifiJoin.ALPHABET.toSet().size)
        assertTrue(WifiJoin.ALPHABET.all { it.isUpperCase() || it.isDigit() })
    }

    @Test fun `8 characters is the WPA2 minimum, never shorter`() {
        assertTrue(WifiJoin.PASSWORD_LENGTH >= 8)
    }

    @Test fun `passwords come from the SecureRandom passed in`() {
        // Two generators with the same seed give the same password; so the code really draws
        // from the SecureRandom it is handed, not from some other source.
        val seed = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8)
        val a = SecureRandom.getInstance("SHA1PRNG").apply { setSeed(seed) }
        val b = SecureRandom.getInstance("SHA1PRNG").apply { setSeed(seed) }
        assertEquals(WifiJoin.newPassword(a), WifiJoin.newPassword(b))
    }

    @Test fun `passwords differ run to run and use the whole alphabet`() {
        val seen = HashSet<String>()
        val chars = HashSet<Char>()
        repeat(2000) {
            val p = WifiJoin.newPassword()
            seen += p
            chars += p.toList()
        }
        assertTrue("duplicates in 2000 draws from 31^8", seen.size >= 1999)
        assertEquals(WifiJoin.ALPHABET.toSet(), chars)
    }

    @Test fun `only passwords this app could have made are reused`() {
        assertTrue(WifiJoin.isGeneratedPassword("K7PX3MQ9"))
        assertFalse(WifiJoin.isGeneratedPassword("K7PX 3MQ9"))
        assertFalse(WifiJoin.isGeneratedPassword("k7px3mq9"))
        assertFalse(WifiJoin.isGeneratedPassword("K7PX3MQ0"))
        assertFalse(WifiJoin.isGeneratedPassword("K7PX3MQ"))
        assertFalse(WifiJoin.isGeneratedPassword(""))
    }

    @Test fun `password is split in two for reading aloud`() {
        assertEquals("K7PX 3MQ9", WifiJoin.spacedForReading("K7PX3MQ9"))
        assertEquals("hunter2", WifiJoin.spacedForReading("hunter2"))
    }

    @Test fun `network names obey Android's rules`() {
        assertEquals("BeeboTV", WifiJoin.NETWORK_NAME)
        // WifiP2pConfig.Builder.setNetworkName: ^DIRECT-[a-zA-Z0-9]{2}.* and at most 32 bytes.
        assertTrue(Regex("^DIRECT-[a-zA-Z0-9]{2}.*").matches(WifiJoin.DIRECT_NETWORK_NAME))
        assertTrue(WifiJoin.DIRECT_NETWORK_NAME.toByteArray(Charsets.UTF_8).size <= 32)
        assertTrue(WifiJoin.DIRECT_NETWORK_NAME.endsWith(WifiJoin.NETWORK_NAME))
    }

    @Test fun `plain QR payload`() {
        assertEquals("WIFI:T:WPA;S:BeeboTV;P:K7PX3MQ9;H:false;;", WifiJoin.qrPayload("BeeboTV", "K7PX3MQ9"))
        assertEquals("WIFI:T:WPA;S:DIRECT-BeeboTV;P:K7PX3MQ9;H:false;;", WifiJoin.qrPayload("DIRECT-BeeboTV", "K7PX3MQ9"))
    }

    @Test fun `open network QR has no password field`() {
        assertEquals("WIFI:T:nopass;S:Cafe;;", WifiJoin.qrPayload("Cafe", ""))
        assertEquals("WIFI:T:nopass;S:Cafe;;", WifiJoin.qrPayload("Cafe", "   "))
    }

    @Test fun `every special character is backslash escaped`() {
        assertEquals("a\\\\b", WifiJoin.escape("a\\b"))
        assertEquals("a\\;b", WifiJoin.escape("a;b"))
        assertEquals("a\\,b", WifiJoin.escape("a,b"))
        assertEquals("a\\:b", WifiJoin.escape("a:b"))
        assertEquals("a\\\"b", WifiJoin.escape("a\"b"))
        assertEquals("plain-name_1 2", WifiJoin.escape("plain-name_1 2"))
        assertEquals(
            "WIFI:T:WPA;S:Nick\\;s \\\"Van\\\";P:p\\:w\\,d\\\\;H:false;;",
            WifiJoin.qrPayload("Nick;s \"Van\"", "p:w,d\\"),
        )
    }
}
