package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.PairLink
import com.beeboentertainment.movie.core.PairLinks
import com.beeboentertainment.movie.core.PairMessages
import com.beeboentertainment.movie.core.PairParse
import com.beeboentertainment.movie.core.PairProblem
import com.beeboentertainment.movie.core.PairRequests
import com.beeboentertainment.movie.core.ServerTrust
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The beebo://pair link: what the desktop QR says, and every hostile thing a QR code could say instead. */
class PairLinkTest {

    private fun ok(raw: String?): PairLink = (PairLinks.parse(raw) as? PairParse.Ok)?.link ?: error("expected a link for: $raw")
    private fun rejected(raw: String?): PairProblem = (PairLinks.parse(raw) as? PairParse.Rejected)?.problem ?: error("expected a rejection for: $raw")

    @Test
    fun `the desktop's link gives the address and the house name`() {
        val l = ok("beebo://pair?server=192.168.1.20:47811&name=thesmiths")
        assertEquals(PairLink("192.168.1.20:47811", "thesmiths", ServerTrust.HOME_NETWORK), l)
    }

    @Test
    fun `the name is optional, and a link without a port is fine`() {
        assertEquals(PairLink("192.168.1.20:47811", null, ServerTrust.HOME_NETWORK), ok("beebo://pair?server=192.168.1.20:47811"))
        assertEquals("pc-1.local", ok("beebo://pair?server=pc-1.local").server)
    }

    @Test
    fun `percent-encoded colons and brackets from other generators decode`() {
        assertEquals("192.168.1.20:47811", ok("beebo://pair?server=192.168.1.20%3A47811").server)
        val v6 = ok("beebo://pair?server=%5Bfe80::1%5D:47811")
        assertEquals("[fe80::1]:47811", v6.server)
        assertEquals(ServerTrust.HOME_NETWORK, v6.trust)
    }

    @Test
    fun `scheme and host are case-insensitive, unknown fields are ignored, order does not matter`() {
        val l = ok("BEEBO://PAIR?utm=x&name=Smiths&server=10.0.0.5:47811&v=2")
        assertEquals("10.0.0.5:47811", l.server)
        assertEquals("smiths", l.houseName)
        assertEquals("10.0.0.5:47811", ok("beebo://pair/?server=10.0.0.5:47811").server)
    }

    @Test
    fun `old plain addresses still work, from a QR or the clipboard`() {
        assertEquals("192.168.1.20:47811", ok("http://192.168.1.20:47811").server)
        assertEquals("192.168.1.20:47811", ok("http://192.168.1.20:47811/").server)
        assertEquals("192.168.1.20:47811", ok("192.168.1.20:47811").server)
        assertEquals("192.168.1.20:47811", ok("  192.168.1.20:47811\n").server)
        val tv = ok("https://thesmiths.beebo.tv")
        assertEquals(ServerTrust.BEEBO_TV, tv.trust)
        assertEquals("thesmiths", tv.houseName)
    }

    @Test
    fun `trust is worked out from the address, not from anything the link claims`() {
        assertEquals(ServerTrust.HOME_NETWORK, ok("beebo://pair?server=10.1.2.3:1").trust)
        assertEquals(ServerTrust.HOME_NETWORK, ok("beebo://pair?server=172.16.0.9:1").trust)
        assertEquals(ServerTrust.HOME_NETWORK, ok("beebo://pair?server=172.31.255.255:1").trust)
        assertEquals(ServerTrust.OTHER, ok("beebo://pair?server=172.32.0.1:1").trust)
        assertEquals(ServerTrust.HOME_NETWORK, ok("beebo://pair?server=100.101.1.1:1").trust)
        assertEquals(ServerTrust.OTHER, ok("beebo://pair?server=8.8.8.8:47811").trust)
        assertEquals(ServerTrust.OTHER, ok("beebo://pair?server=evil.example.com:47811").trust)
        assertEquals(ServerTrust.OTHER, ok("beebo://pair?server=192.168.1.20.evil.com:47811").trust)
        assertEquals(ServerTrust.BEEBO_TV, ok("beebo://pair?server=smiths.beebo.tv").trust)
        assertEquals(ServerTrust.OTHER, ok("beebo://pair?server=beebo.tv.evil.com").trust)
        assertEquals(ServerTrust.OTHER, ok("beebo://pair?server=a.b.beebo.tv").trust)
        assertEquals(ServerTrust.OTHER, ok("beebo://pair?server=www.beebo.tv").trust)
        assertEquals(ServerTrust.HOME_NETWORK, ok("beebo://pair?server=mypc:47811").trust)
        assertEquals(ServerTrust.HOME_NETWORK, ok("beebo://pair?server=[fd12:3456::1]:47811").trust)
        assertEquals(ServerTrust.OTHER, ok("beebo://pair?server=[2001:db8::1]:47811").trust)
    }

    @Test
    fun `anything outside the home network needs the person to agree first`() {
        assertNull(PairMessages.confirmation(ok("beebo://pair?server=192.168.1.20:47811")))
        assertNull(PairMessages.confirmation(ok("beebo://pair?server=smiths.beebo.tv")))
        val msg = PairMessages.confirmation(ok("beebo://pair?server=203.0.113.5:47811"))
        assertNotNull(msg)
        assertTrue(msg!!.contains("203.0.113.5:47811"))
        assertTrue(msg.contains("trust"))
    }

    @Test
    fun `hostile servers are refused`() {
        val bad = listOf(
            "beebo://pair?server=user:pass@192.168.1.20:47811",
            "beebo://pair?server=192.168.1.20@evil.com",
            "beebo://pair?server=http://192.168.1.20:47811/../../etc",
            "beebo://pair?server=192.168.1.20:47811/admin",
            "beebo://pair?server=192.168.1.20:47811%2Fadmin",
            "beebo://pair?server=192.168.1.20:47811?x=1",
            "beebo://pair?server=192.168.1.20:47811%23frag",
            "beebo://pair?server=javascript:alert(1)",
            "beebo://pair?server=file:///sdcard/x",
            "beebo://pair?server=ftp://192.168.1.20",
            "beebo://pair?server=intent://scan#Intent;end",
            "beebo://pair?server=192.168.1.20:0",
            "beebo://pair?server=192.168.1.20:65536",
            "beebo://pair?server=192.168.1.20:-1",
            "beebo://pair?server=192.168.1.20:80a",
            "beebo://pair?server=192.168.1.20:",
            "beebo://pair?server=256.1.1.1:47811",
            "beebo://pair?server=1.2.3:47811",
            "beebo://pair?server=192.168.1.20:47811:99",
            "beebo://pair?server=fe80::1",
            "beebo://pair?server=[fe80::1",
            "beebo://pair?server=[fe80::zz]:1",
            "beebo://pair?server=-bad.example.com",
            "beebo://pair?server=bad_.example.com",
            "beebo://pair?server=exa mple.com",
            "beebo://pair?server=exam%20ple.com",
            "beebo://pair?server=host%00.evil.com",
            "beebo://pair?server=host%0d%0aHost:evil.com",
            "beebo://pair?server=%E0%A4%A",
            "beebo://pair?server=%ZZ",
            "beebo://pair?server=%C0%AF",
            "beebo://pair?server=ex%25ample.com",
            "beebo://pair?server=\\\\evil\\share",
            "beebo://pair?server=.",
            "beebo://pair?server=..",
            "beebo://pair?server=a..b.com",
        )
        for (raw in bad) {
            val r = PairLinks.parse(raw)
            assertTrue("should be refused: $raw -> $r", r is PairParse.Rejected)
        }
    }

    @Test
    fun `missing, empty or doubled fields are refused`() {
        assertEquals(PairProblem.MISSING_SERVER, rejected("beebo://pair"))
        assertEquals(PairProblem.MISSING_SERVER, rejected("beebo://pair?"))
        assertEquals(PairProblem.MISSING_SERVER, rejected("beebo://pair?server="))
        assertEquals(PairProblem.MISSING_SERVER, rejected("beebo://pair?name=smiths"))
        assertEquals(PairProblem.MALFORMED, rejected("beebo://pair?server=10.0.0.5:1&server=8.8.8.8:1"))
        assertEquals(PairProblem.MALFORMED, rejected("beebo://pair?server=10.0.0.5:1&SERVER=8.8.8.8:1"))
        assertEquals(PairProblem.MALFORMED, rejected("beebo://pair?server=10.0.0.5:1&name=a&name=b"))
    }

    @Test
    fun `a bad name refuses the whole link rather than being quietly changed`() {
        for (name in listOf("bad%20name", "-x", "x-", "a.b.c", "sm!ths", "%3Cscript%3E", "a".repeat(64), "..")) {
            assertEquals("name=$name", PairProblem.BAD_NAME, rejected("beebo://pair?server=10.0.0.5:47811&name=$name"))
        }
        assertEquals("smiths", ok("beebo://pair?server=10.0.0.5:47811&name=smiths.beebo.tv").houseName)
    }

    @Test
    fun `things that are not pairing links are not mistaken for one`() {
        for (raw in listOf(null, "", "   ", "hello", "beebo://tv-link?code=ABCD-EFGH", "beebo://pairing?server=10.0.0.5:1", "beebo://pair.evil.com?server=10.0.0.5:1", "beebo://play?server=10.0.0.5:1", "mailto:a@b.c", "tel:123")) {
            assertEquals("raw=$raw", PairProblem.NOT_A_PAIR_LINK, rejected(raw))
        }
    }

    @Test
    fun `control characters, whitespace inside, and huge inputs are refused before any parsing`() {
        assertEquals(PairProblem.MALFORMED, rejected("beebo://pair?server=10.0.0.5:1 "))
        assertEquals(PairProblem.MALFORMED, rejected("beebo://pair?server=10.0.0.5:1\n&name=x"))
        assertEquals(PairProblem.MALFORMED, rejected("beebo://pair?server=10.0.0.5:1 &name=x"))
        assertEquals(PairProblem.TOO_LONG, rejected("beebo://pair?server=" + "a".repeat(400)))
        assertEquals(PairProblem.TOO_LONG, rejected("beebo://pair?server=10.0.0.5:1&junk=" + "9".repeat(5000)))
    }

    @Test
    fun `a fragment or a path cannot carry a second address`() {
        assertEquals("10.0.0.5:1", ok("beebo://pair?server=10.0.0.5:1#server=8.8.8.8:1").server)
        assertEquals(PairProblem.MALFORMED, rejected("beebo://pair/evil?server=10.0.0.5:1"))
    }

    @Test
    fun `an unbalanced percent escape at the very end is refused, not crashed on`() {
        assertEquals(PairProblem.MALFORMED, rejected("beebo://pair?server=10.0.0.5:1&name=%"))
        assertEquals(PairProblem.MALFORMED, rejected("beebo://pair?server=10.0.0.5:1&name=%4"))
    }

    @Test
    fun `the Activity only hands over pairing links, and a new one replaces an unread one`() {
        PairRequests.consume()
        assertTrue(!PairRequests.offer("beebo://tv-link?code=ABCD"))
        assertTrue(!PairRequests.offer(null))
        assertNull(PairRequests.pending.value)
        assertTrue(PairRequests.offer("beebo://pair?server=10.0.0.5:1"))
        assertTrue(PairRequests.offer("beebo://pair?server=10.0.0.6:1"))
        assertEquals("beebo://pair?server=10.0.0.6:1", PairRequests.pending.value)
        PairRequests.consume()
        assertNull(PairRequests.pending.value)
        // a huge link is kept only long enough to be refused as too long
        PairRequests.offer("beebo://pair?server=" + "a".repeat(100_000))
        assertTrue(PairRequests.pending.value!!.length <= PairLinks.MAX_LENGTH + 1)
        assertTrue(PairLinks.parse(PairRequests.pending.value) is PairParse.Rejected)
        PairRequests.consume()
    }

    @Test
    fun `a link nobody picked up goes stale after ten minutes`() {
        PairRequests.consume()
        assertTrue(!PairRequests.isFresh())
        PairRequests.offer("beebo://pair?server=10.0.0.5:1", nowMs = 1_000)
        assertTrue(PairRequests.isFresh(nowMs = 1_000 + PairRequests.MAX_AGE_MS))
        assertTrue(!PairRequests.isFresh(nowMs = 1_001 + PairRequests.MAX_AGE_MS))
        PairRequests.consume()
        assertTrue(!PairRequests.isFresh(nowMs = 1_000))
    }

    @Test
    fun `every problem has words for the person`() {
        for (p in PairProblem.values()) assertTrue(PairMessages.problem(p).isNotBlank())
    }
}
