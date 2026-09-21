package com.beeboentertainment.movie.rtc

import okio.ByteString.Companion.encodeUtf8
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteRulesTest {

    // ---------------------------------------------------------------- cookies

    @Test fun `cookie jar keeps, replaces, expires and forgets`() {
        var now = 1_000_000L
        val jar = TunnelCookieJar { now }
        assertNull(jar.header())
        jar.store(listOf("sid=abc; Path=/; HttpOnly", "theme=dark; Max-Age=60", "bad", "=novalue"))
        assertEquals("sid=abc; theme=dark", jar.header())
        jar.store(listOf("sid=xyz"))
        assertEquals("sid=xyz; theme=dark", jar.header())
        now += 61_000
        assertEquals("sid=xyz", jar.header())
        jar.store(listOf("sid=; Max-Age=0"))
        assertNull(jar.header())
        jar.store(listOf("a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT"))
        assertNull(jar.header())
        jar.store(listOf("b=2; Expires=Wed, 21 Oct 2099 07:28:00 GMT", "c=3\r\nInjected: x"))
        assertEquals("b=2", jar.header())
        jar.clear()
        assertNull(jar.header())
    }

    // ---------------------------------------------------------------- backoff

    @Test fun `reconnect backoff`() {
        assertEquals(listOf(0L, 1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 30_000L, 30_000L), (1..8).map { ReconnectBackoff.delayMs(it) })
        assertEquals(1_200L, ReconnectBackoff.delayMs(2, jitter = 1.0))
        assertEquals(800L, ReconnectBackoff.delayMs(2, jitter = -1.0))
        assertEquals(1, ReconnectBackoff.attemptAfterNetworkChange())
        assertEquals(25_000L, ReconnectBackoff.HONEST_FAILURE_MS)
    }

    // ---------------------------------------------------------------- routing

    @Test fun `plain addresses are untouched`() {
        assertEquals(Route.Plain, RouteRule.decide("https://192.168.1.5:47811", null, NetworkKind.LOCAL, true, true))
        assertEquals(Route.Plain, RouteRule.decide(null, null, NetworkKind.OTHER, false, false))
    }

    @Test fun `name dot beebo dot tv goes direct only at home with a proven address`() {
        val base = "https://nick.beebo.tv"
        val lan = "http://192.168.1.5:47811"
        assertEquals(Route.Direct("nick", lan), RouteRule.decide(base, lan, NetworkKind.LOCAL, true, true))
        assertEquals(Route.Tunnel("nick"), RouteRule.decide(base, lan, NetworkKind.LOCAL, true, false))     // didn't answer as us
        assertEquals(Route.Tunnel("nick"), RouteRule.decide(base, lan, NetworkKind.OTHER, true, true))      // mobile data
        assertEquals(Route.Tunnel("nick"), RouteRule.decide(base, lan, NetworkKind.LOCAL, false, true))     // not signed in
        assertEquals(Route.Tunnel("nick"), RouteRule.decide(base, null, NetworkKind.LOCAL, true, true))     // no address known
        assertEquals(Route.Tunnel("nick"), RouteRule.decide(base, "https://nick.beebo.tv", NetworkKind.LOCAL, true, true))
        assertFalse(RouteRule.shouldProbeLan(lan, NetworkKind.NONE, true))
        assertTrue(RouteRule.shouldProbeLan(lan, NetworkKind.LOCAL, true))
    }

    @Test fun `which URLs ride the tunnel, and rewriting`() {
        assertTrue(RouteRule.isTunnelUrl("https://nick.beebo.tv/api/movies?q=a", "nick"))
        assertTrue(RouteRule.isTunnelUrl("https://NICK.beebo.tv./file?id=1", "nick"))
        assertFalse(RouteRule.isTunnelUrl("https://nick.beebo.tv/rtc/poll?box=v1", "nick"))
        assertFalse(RouteRule.isTunnelUrl("https://other.beebo.tv/api/movies", "nick"))
        assertFalse(RouteRule.isTunnelUrl("https://image.tmdb.org/t/p/w500/x.jpg", "nick"))
        assertEquals("http://192.168.1.5:47811/file?id=a%20b&mt=1", RouteRule.rewriteToDirect("https://nick.beebo.tv/file?id=a%20b&mt=1", "192.168.1.5:47811/".let { "http://$it" }))
        assertEquals("/api/x?y=1", RouteRule.tunnelPath("https://nick.beebo.tv/api/x?y=1"))
        assertEquals("/", RouteRule.tunnelPath("https://nick.beebo.tv"))
    }

    // ---------------------------------------------------------------- casting

    @Test fun `casting is off away from home, moved to the computer at home, unchanged otherwise`() {
        assertEquals(CastRule.Decision.Blocked, CastRule.decide(Route.Tunnel("nick")))
        assertNull(CastRule.castUrl("https://nick.beebo.tv/file?id=1&mt=t", CastRule.Decision.Blocked))
        val home = CastRule.decide(Route.Direct("nick", "http://192.168.1.5:47811"))
        assertEquals("http://192.168.1.5:47811/file?id=1&mt=t", CastRule.castUrl("https://nick.beebo.tv/file?id=1&mt=t", home))
        assertEquals("https://image.tmdb.org/x.jpg", CastRule.castUrl("https://image.tmdb.org/x.jpg", home))
        assertEquals(CastRule.Decision.Allowed, CastRule.decide(Route.Plain))
        assertEquals("https://host:47811/file", CastRule.castUrl("https://host:47811/file", CastRule.Decision.Allowed))
        assertTrue(CastRule.EXPLANATION.contains("at home"))
    }

    @Test fun `away from home, casting is offered on Wi-Fi and refused on mobile data`() {
        val away = Route.Tunnel("nick")
        // On Wi-Fi, with an address a TV could reach: the phone passes the video on.
        assertEquals(
            CastRule.Decision.ViaPhone("nick"),
            CastRule.decide(away, NetworkKind.LOCAL, phoneCanRelay = true)
        )
        // Mobile data: refused, however capable the phone is - it would be paid for twice.
        assertEquals(CastRule.Decision.Blocked, CastRule.decide(away, NetworkKind.OTHER, phoneCanRelay = true))
        assertEquals(CastRule.Decision.Blocked, CastRule.decide(away, NetworkKind.NONE, phoneCanRelay = true))
        // On Wi-Fi but with no usable address (no interface the TV could reach): refused.
        assertEquals(CastRule.Decision.Blocked, CastRule.decide(away, NetworkKind.LOCAL, phoneCanRelay = false))
        // At home and on a plain address the extra facts change nothing.
        assertEquals(
            CastRule.Decision.AllowedVia("http://192.168.1.5:47811", "nick"),
            CastRule.decide(Route.Direct("nick", "http://192.168.1.5:47811"), NetworkKind.LOCAL, true)
        )
        assertEquals(CastRule.Decision.Allowed, CastRule.decide(Route.Plain, NetworkKind.OTHER, true))
        // The old one-argument answer is untouched, for callers that can't relay (the photo viewer).
        assertEquals(CastRule.Decision.Blocked, CastRule.decide(away))
    }

    @Test fun `through the phone, only the tunnel's own URLs are swapped`() {
        val viaPhone = CastRule.decide(Route.Tunnel("nick"), NetworkKind.LOCAL, phoneCanRelay = true)
        val handed = mutableListOf<String>()
        val stand = { url: String -> handed += url; "http://192.168.1.44:52411/c/deadbeef/${handed.size - 1}" }
        assertEquals(
            "http://192.168.1.44:52411/c/deadbeef/0",
            CastRule.castUrl("https://nick.beebo.tv/file?id=1&mt=t", viaPhone, stand)
        )
        // A poster already out on the internet is left alone: the TV can fetch that itself.
        assertEquals("https://image.tmdb.org/x.jpg", CastRule.castUrl("https://image.tmdb.org/x.jpg", viaPhone, stand))
        assertEquals(listOf("https://nick.beebo.tv/file?id=1&mt=t"), handed)
        // If the phone can't stand in for it after all, the answer is an honest "can't cast this".
        assertNull(CastRule.castUrl("https://nick.beebo.tv/file?id=2", viaPhone) { null })
    }

    @Test fun `the reason shown where the cast button would be follows the network`() {
        assertEquals(CastRule.EXPLANATION, CastRule.blockedExplanation(NetworkKind.LOCAL))
        assertEquals(CastRule.NEEDS_WIFI, CastRule.blockedExplanation(NetworkKind.OTHER))
        assertEquals(CastRule.NEEDS_WIFI, CastRule.blockedExplanation(NetworkKind.NONE))
        assertTrue(CastRule.NEEDS_WIFI.contains("Wi-Fi"))
        assertTrue(CastRule.NEEDS_WIFI.contains("mobile data"))
        assertTrue(CastRule.blockedTitle(NetworkKind.OTHER).contains("Wi-Fi"))
        assertTrue(CastRule.VIA_PHONE_NOTE.contains("this phone"))
        assertTrue(CastRule.VIA_PHONE_NOTE.contains("Wi-Fi"))
    }

    // ---------------------------------------------------------------- one sign-in screen

    @Test fun `what Home holds`() {
        assertEquals(HomeEntry.Name("nick"), HomeEntry.parse("nick"))
        assertEquals(HomeEntry.Name("nick"), HomeEntry.parse(" Nick "))
        assertEquals(HomeEntry.Name("nick"), HomeEntry.parse("nick.beebo.tv"))
        assertEquals(HomeEntry.Name("nick-will"), HomeEntry.parse("https://nick-will.beebo.tv/"))
        assertEquals(HomeEntry.Email("fay@example.com"), HomeEntry.parse("Fay@Example.com"))
        assertEquals(HomeEntry.Address("https://192.168.1.5:47811"), HomeEntry.parse("192.168.1.5:47811"))
        assertEquals(HomeEntry.Address("http://beebo.local:47811"), HomeEntry.parse("http://beebo.local:47811/"))
        assertEquals(HomeEntry.Address("https://localhost"), HomeEntry.parse("localhost"))
        assertEquals(HomeEntry.Invalid, HomeEntry.parse(""))
        assertEquals(HomeEntry.Invalid, HomeEntry.parse("a@b"))
    }

    @Test fun `sign-in order - at home first when the computer's address is known`() {
        val lan = "http://192.168.1.5:47811"
        assertEquals(listOf(SignInPlan.Step.Direct(lan), SignInPlan.Step.Remote), SignInPlan.steps(HomeEntry.Name("nick"), lan, NetworkKind.LOCAL))
        assertEquals(listOf(SignInPlan.Step.Direct(lan), SignInPlan.Step.Remote), SignInPlan.steps(HomeEntry.Email("f@x.com"), lan, NetworkKind.LOCAL))
        assertEquals(listOf(SignInPlan.Step.Remote), SignInPlan.steps(HomeEntry.Name("nick"), lan, NetworkKind.OTHER))
        assertEquals(listOf(SignInPlan.Step.Remote), SignInPlan.steps(HomeEntry.Name("nick"), null, NetworkKind.LOCAL))
        assertEquals(listOf(SignInPlan.Step.Remote), SignInPlan.steps(HomeEntry.Name("nick"), "https://nick.beebo.tv", NetworkKind.LOCAL))
        assertEquals(listOf(SignInPlan.Step.Direct("https://h:1")), SignInPlan.steps(HomeEntry.Address("https://h:1"), lan, NetworkKind.OTHER))
        assertEquals(emptyList<SignInPlan.Step>(), SignInPlan.steps(HomeEntry.Invalid, lan, NetworkKind.LOCAL))
    }

    @Test fun `the saved sign-in round-trips and rejects junk`() {
        val m = RemoteSignIn(RemoteSignIn.Kind.MEMBER, "fay@example.com", "kid", "p\"w")
        assertEquals(m, RemoteSignIn.fromJson(m.toJson()))
        assertTrue(m.homeIsEmail)
        assertFalse(RemoteSignIn(RemoteSignIn.Kind.MEMBER, "nick", "kid", "x").homeIsEmail)
        assertNull(RemoteSignIn.fromJson(null))
        assertNull(RemoteSignIn.fromJson("{}"))
        assertNull(RemoteSignIn.fromJson("""{"kind":"MEMBER","home":"nick","id":"","secret":"x"}"""))
        assertNull(RemoteSignIn.fromJson("""{"kind":"NOPE","home":"nick","id":"a","secret":"x"}"""))
    }

    @Test fun `viewer token - expiry and who signed in`() {
        fun tok(json: String) = json.encodeUtf8().base64Url().trimEnd('=') + ".c2ln"
        val member = ViewerToken.parse(tok("""{"v":1,"typ":"viewer","name":"nick","via":"member","member":"kid","exp":2000}"""))!!
        assertEquals(2000L, member.expiresAtSec)
        assertFalse(member.isOwner)
        assertTrue(ViewerToken.parse(tok("""{"typ":"viewer","exp":2000}"""))!!.isOwner)
        assertFalse(member.isStale(1000))
        assertTrue(member.isStale(1701))
        assertNull(ViewerToken.parse("nope"))
        assertNull(ViewerToken.parse(null))
    }

    @Test fun `plain words for sign-in refusals`() {
        assertTrue(RemoteMessages.signIn("no_active_subscription", 402, "nick").contains("active subscription"))
        assertTrue(RemoteMessages.signIn("no_active_subscription", 402, "").startsWith("This Beebo"))
        assertTrue(RemoteMessages.signIn("invalid_credentials", 401, "").contains("same username and password"))
        assertEquals("That Beebo account email and password didn't match.", RemoteMessages.signIn("invalid_credentials", 401, "", owner = true))
        assertTrue(RemoteMessages.signIn("too_many_attempts", 429, "nick", 61).contains("2 minutes"))
        assertTrue(RemoteMessages.hostOffline("nick").contains("isn't online"))
        assertTrue(RemoteMessages.remoteSession("household_pass").contains("your own username"))
        assertEquals(RemoteMessages.UPDATE_HOST, RemoteMessages.remoteSession(""))
        assertTrue(RelayUrls.usable("turn:relay.example.com:3478?transport=udp"))
        assertTrue(RelayUrls.usable("turns:relay.example.com:443?transport=tcp"))
        assertFalse(RelayUrls.usable("turn:relay.example.com:53"))
        assertFalse(RelayUrls.usable("stun:stun.cloudflare.com:3478"))
    }
}
