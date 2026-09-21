package com.beeboentertainment.movie.rtc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class BeeboRelayTest {

    private val nowSec = 1_800_000_000L

    private fun good(expiresAt: Long = nowSec + 12 * 3600) = """
        {"iceServers":[{"urls":["turn:relay1.beebo.tv:3478?transport=udp","turn:relay1.beebo.tv:3478?transport=tcp",
          "turns:relay1.beebo.tv:443?transport=tcp"],"username":"${expiresAt}:cus_1","credential":"c2VjcmV0"}],
         "expiresAt":$expiresAt,"ttl":43200,"mode":"wallet","switchAtGB":null,"usage":{"gb":1.5}}
    """.trimIndent()

    // --------------------------------------------------------------- parsing

    @Test fun `a good answer keeps all three relay urls, udp tcp and 443`() {
        val r = BeeboRelay.parseResponse(200, good()) as RelayFetch.Granted
        assertEquals(nowSec + 12 * 3600, r.expiresAtSec)
        assertEquals(1, r.servers.size)
        val s = r.servers[0]
        assertEquals(
            listOf("turn:relay1.beebo.tv:3478?transport=udp", "turn:relay1.beebo.tv:3478?transport=tcp", "turns:relay1.beebo.tv:443?transport=tcp"),
            s.urls,
        )
        assertEquals("${nowSec + 12 * 3600}:cus_1", s.username)
        assertEquals("c2VjcmV0", s.credential)
    }

    @Test fun `bad urls are filtered and port 53 is dropped`() {
        val body = """{"expiresAt":$nowSec,"iceServers":[{"urls":[
            "stun:stun.cloudflare.com:3478","turn:relay1.beebo.tv:53","turn:relay1.beebo.tv:53?transport=udp",
            "turn:relay1.beebo.tv","turn:relay1.beebo.tv:3478?transport=sctp","turn:relay1.beebo.tv:3478?x=1",
            "turn:user@relay1.beebo.tv:3478","http://relay1.beebo.tv:3478","turn:relay1.beebo.tv:99999",
            "turn:relay1.beebo.tv:3478/path","turn:[2001:db8::1]:3478","TURNS:relay1.beebo.tv:443?transport=tcp"],
            "username":"u","credential":"p"}]}"""
        val r = BeeboRelay.parseResponse(200, body) as RelayFetch.Granted
        assertEquals(listOf("turn:[2001:db8::1]:3478", "TURNS:relay1.beebo.tv:443?transport=tcp"), r.servers[0].urls)
    }

    @Test fun `entries without string credentials, or overlong ones, are skipped`() {
        val long = "x".repeat(513)
        val url = "\"turn:relay1.beebo.tv:3478\""
        val body = """{"expiresAt":$nowSec,"iceServers":[
            {"urls":$url,"credential":"p"},
            {"urls":$url,"username":42,"credential":"p"},
            {"urls":$url,"username":"u","credential":null},
            {"urls":$url,"username":"$long","credential":"p"}
        ]}"""
        assertEquals(RelayFetch.Refused(200, "no_usable_servers"), BeeboRelay.parseResponse(200, body))
        val ok = """{"expiresAt":$nowSec,"iceServers":[{"urls":$url,"username":"${"x".repeat(512)}","credential":"p"}]}"""
        assertTrue(BeeboRelay.parseResponse(200, ok) is RelayFetch.Granted)
    }

    @Test fun `at most four servers and eight urls each`() {
        val urls = (1..12).joinToString(",") { "\"turn:r$it.beebo.tv:3478\"" }
        val entry = """{"urls":[$urls],"username":"u","credential":"p"}"""
        val body = """{"expiresAt":$nowSec,"iceServers":[${List(6) { entry }.joinToString(",")}]}"""
        val r = BeeboRelay.parseResponse(200, body) as RelayFetch.Granted
        assertEquals(4, r.servers.size)
        assertTrue(r.servers.all { it.urls.size == 8 })
    }

    @Test fun `refusals and malformed bodies become a fallback reason`() {
        assertEquals(RelayFetch.Refused(404, "not_found"), BeeboRelay.parseResponse(404, """{"error":"not_found"}"""))
        assertEquals(RelayFetch.Refused(401, "unauthorized"), BeeboRelay.parseResponse(401, """{"error":"unauthorized"}"""))
        assertEquals(RelayFetch.Refused(402, "no_active_subscription"), BeeboRelay.parseResponse(402, """{"error":"no_active_subscription"}"""))
        assertEquals(RelayFetch.Refused(403, "relay_suspended"), BeeboRelay.parseResponse(403, """{"error":"relay_suspended"}"""))
        assertEquals(RelayFetch.Refused(429, "relay_cap_reached"), BeeboRelay.parseResponse(429, """{"error":"relay_cap_reached"}"""))
        assertEquals(RelayFetch.Refused(503, "http_503"), BeeboRelay.parseResponse(503, "<html>oops</html>"))
        assertEquals(RelayFetch.Refused(301, "http_301"), BeeboRelay.parseResponse(301, ""))
        assertEquals(RelayFetch.Refused(200, "malformed"), BeeboRelay.parseResponse(200, "not json"))
        assertEquals(RelayFetch.Refused(200, "malformed"), BeeboRelay.parseResponse(200, """{"iceServers":[]}"""))
        assertEquals(RelayFetch.Refused(200, "malformed"), BeeboRelay.parseResponse(200, """{"expiresAt":"soon","iceServers":[]}"""))
        assertEquals(RelayFetch.Refused(200, "no_usable_servers"), BeeboRelay.parseResponse(200, """{"expiresAt":1,"iceServers":"x"}"""))
    }

    // ------------------------------------------------------------ ice list

    @Test fun `ice servers are stun first then the relay, or stun only`() {
        val relay = (BeeboRelay.parseResponse(200, good()) as RelayFetch.Granted).servers
        val both = BeeboRelay.iceSpecs(relay)
        assertEquals(2, both.size)
        assertEquals(IceSpec(listOf("stun:relay1.beebo.tv:3478")), both[0])
        assertEquals("stun:relay1.beebo.tv:3478", BeeboRelay.STUN_URL)
        assertNull(both[0].username)
        assertEquals(relay[0], both[1])
        assertEquals(listOf(IceSpec(listOf(BeeboRelay.STUN_URL))), BeeboRelay.iceSpecs(emptyList()))
    }

    // --------------------------------------------------------------- cache

    @Test fun `cache decision reuses, refetches and backs off`() {
        val hour = 3600_000L
        val now = nowSec * 1000
        val exp = nowSec + 12 * 3600
        // Plenty left, fetched 10 minutes ago.
        assertEquals(BeeboRelay.CacheDecision.REUSE, BeeboRelay.decide(now, exp, now - 10 * 60_000, 0))
        // Cache is 31 minutes old: refetch.
        assertEquals(BeeboRelay.CacheDecision.FETCH, BeeboRelay.decide(now, exp, now - 31 * 60_000, 0))
        // Under an hour left: refetch.
        assertEquals(BeeboRelay.CacheDecision.FETCH, BeeboRelay.decide(now, nowSec + 3599, now - 60_000, 0))
        // Nothing cached.
        assertEquals(BeeboRelay.CacheDecision.FETCH, BeeboRelay.decide(now, null, 0, 0))
        // Refused two minutes ago: don't ask again yet.
        assertEquals(BeeboRelay.CacheDecision.BACKOFF, BeeboRelay.decide(now, null, 0, now + 3 * 60_000))
        assertEquals(BeeboRelay.CacheDecision.FETCH, BeeboRelay.decide(now + 3 * 60_000, null, 0, now + 3 * 60_000))
        // Good credentials are still reused during a backoff.
        assertEquals(BeeboRelay.CacheDecision.REUSE, BeeboRelay.decide(now, now / 1000 + 2 * hour / 1000, now, now + hour))
    }

    private val sync: (Runnable) -> Unit = { it.run() }

    @Test fun `credentials are fetched once and reused while fresh`() {
        var clock = nowSec * 1000
        val calls = AtomicInteger()
        val creds = BeeboRelayCredentials(
            fetch = { calls.incrementAndGet(); BeeboRelay.parseResponse(200, good(clock / 1000 + 12 * 3600)) },
            clock = { clock }, start = sync,
        )
        assertEquals(1, creds.serversFor("t").size)
        clock += 20 * 60_000
        assertEquals(1, creds.serversFor("t").size)
        assertEquals(1, calls.get())
        clock += 11 * 60_000   // 31 minutes old: fetched again at this connection
        assertEquals(1, creds.serversFor("t").size)
        assertEquals(2, calls.get())
    }

    @Test fun `a refusal means stun only and no new request for five minutes`() {
        var clock = nowSec * 1000
        val calls = AtomicInteger()
        val logs = mutableListOf<String>()
        val creds = BeeboRelayCredentials(
            fetch = { calls.incrementAndGet(); BeeboRelay.parseResponse(403, """{"error":"relay_not_enabled"}""") },
            clock = { clock }, log = { logs.add(it) }, start = sync,
        )
        assertTrue(creds.serversFor("t").isEmpty())
        assertEquals(1, logs.size)
        assertTrue(logs[0].contains("relay_not_enabled"))
        clock += 4 * 60_000
        assertTrue(creds.serversFor("t").isEmpty())
        assertEquals(1, calls.get())
        clock += 61_000
        assertTrue(creds.serversFor("t").isEmpty())
        assertEquals(2, calls.get())
    }

    @Test fun `a throwing fetch means stun only`() {
        var clock = nowSec * 1000
        val creds = BeeboRelayCredentials(fetch = { throw IllegalStateException("boom") }, clock = { clock }, start = sync)
        assertTrue(creds.serversFor("t").isEmpty())
        clock += 30_000
        assertTrue(creds.serversFor("t").isEmpty())   // backing off, not asking again
    }

    @Test fun `just-fetched credentials with under an hour left are still used, expired ones are not`() {
        val clock = nowSec * 1000
        val short = BeeboRelayCredentials(fetch = { BeeboRelay.parseResponse(200, good(nowSec + 600)) }, clock = { clock }, start = sync)
        assertEquals(1, short.serversFor("t").size)
        val expired = BeeboRelayCredentials(fetch = { BeeboRelay.parseResponse(200, good(nowSec - 10)) }, clock = { clock }, start = sync)
        assertTrue(expired.serversFor("t").isEmpty())
    }

    @Test(timeout = 5_000) fun `a slow fetch gives stun only within the deadline, and fills the cache later`() {
        val release = CountDownLatch(1)
        val fetched = CountDownLatch(1)
        val logs = mutableListOf<String>()
        val calls = AtomicInteger()
        val creds = BeeboRelayCredentials(
            fetch = {
                calls.incrementAndGet()
                release.await(5, TimeUnit.SECONDS)
                BeeboRelay.parseResponse(200, good(System.currentTimeMillis() / 1000 + 12 * 3600)).also { fetched.countDown() }
            },
            log = { synchronized(logs) { logs.add(it) } },
            waitMs = 150,
        )
        val t0 = System.nanoTime()
        assertTrue(creds.serversFor("t").isEmpty())
        val tookMs = (System.nanoTime() - t0) / 1_000_000
        assertTrue("took $tookMs ms", tookMs in 100..1_000)
        assertTrue(synchronized(logs) { logs.any { it.contains("150 ms") } })

        release.countDown()
        assertTrue(fetched.await(2, TimeUnit.SECONDS))
        // The late answer is recorded just after fetch returns; wait for it without a fixed sleep.
        var servers = creds.serversFor("t")
        val until = System.currentTimeMillis() + 2_000
        while (servers.isEmpty() && System.currentTimeMillis() < until) { Thread.sleep(10); servers = creds.serversFor("t") }
        assertEquals(1, servers.size)
        assertEquals(1, calls.get())
    }

    @Test fun `the default wait is two seconds`() {
        assertEquals(2_000L, BeeboRelay.WAIT_MS)
    }

    // ---------------------------------------------------------------- path

    private val beebo = setOf("relay1.beebo.tv")

    @Test fun `selected pair decides direct, beebo relay or another relay`() {
        assertEquals(TunnelPath.DIRECT, TunnelPathRule.decide("srflx", "host", null, beebo, true))
        assertEquals(TunnelPath.DIRECT, TunnelPathRule.decide("host", "prflx", null, beebo, false))
        assertEquals(TunnelPath.BEEBO_RELAY, TunnelPathRule.decide("relay", "srflx", "turn:relay1.beebo.tv:3478?transport=udp", beebo, false))
        assertEquals(TunnelPath.RELAY, TunnelPathRule.decide("relay", "srflx", "turn:turn.example.com:3478", beebo, true))
        // No url in the stats: Beebo's only when Beebo's were the only relays given.
        assertEquals(TunnelPath.BEEBO_RELAY, TunnelPathRule.decide("relay", "host", null, beebo, true))
        assertEquals(TunnelPath.RELAY, TunnelPathRule.decide("relay", "host", "", beebo, false))
        assertEquals(TunnelPath.RELAY, TunnelPathRule.decide("host", "relay", null, beebo, true))
        assertEquals(TunnelPath.UNKNOWN, TunnelPathRule.decide(null, null, null, beebo, true))

        assertEquals("Direct connection", TunnelPathRule.label(TunnelPath.DIRECT))
        assertEquals("Through Beebo Relay", TunnelPathRule.label(TunnelPath.BEEBO_RELAY))
        assertEquals("Through a relay · provider not identified", TunnelPathRule.label(TunnelPath.RELAY))
        assertNull(TunnelPathRule.label(TunnelPath.UNKNOWN))
        assertTrue(TunnelPath.BEEBO_RELAY.isRelay)
        assertFalse(TunnelPath.DIRECT.isRelay)
    }

    @Test fun `stats find the pair from the transport, or the nominated succeeded pair`() {
        fun stat(id: String, type: String, vararg m: Pair<String, Any?>) = TunnelPathRule.Stat(id, type, mapOf(*m))
        val candidates = listOf(
            stat("L1", "local-candidate", "candidateType" to "srflx"),
            stat("L2", "local-candidate", "candidateType" to "relay", "url" to "turns:relay1.beebo.tv:443?transport=tcp"),
            stat("R1", "remote-candidate", "candidateType" to "host"),
            stat("P1", "candidate-pair", "localCandidateId" to "L1", "remoteCandidateId" to "R1", "nominated" to true, "state" to "succeeded"),
            stat("P2", "candidate-pair", "localCandidateId" to "L2", "remoteCandidateId" to "R1", "nominated" to false, "state" to "in-progress"),
        )
        val ice = listOf("stun:stun.cloudflare.com:3478", "turns:relay1.beebo.tv:443?transport=tcp")
        // The transport names P2 as selected.
        assertEquals(
            TunnelPath.BEEBO_RELAY,
            TunnelPathRule.fromStats(candidates + stat("T", "transport", "selectedCandidatePairId" to "P2"), beebo, ice),
        )
        // No transport stats: the nominated, succeeded pair.
        assertEquals(TunnelPath.DIRECT, TunnelPathRule.fromStats(candidates, beebo, ice))
        // No selected pair at all.
        assertEquals(TunnelPath.UNKNOWN, TunnelPathRule.fromStats(candidates.filter { it.type != "candidate-pair" }, beebo, ice))
        assertEquals(TunnelPath.UNKNOWN, TunnelPathRule.fromStats(emptyList(), beebo, ice))
    }

    @Test fun `open status carries the path label`() {
        assertEquals("Through Beebo Relay", TunnelConnection.Status.Open(true, false, TunnelPath.BEEBO_RELAY).pathLabel)
        assertNull(TunnelConnection.Status.Open(false, false).pathLabel)
        assertEquals("Through a relay · provider not identified", TunnelConnection.Status.Open(true, false).pathLabel)
    }

    @Test fun `hosts of turn urls`() {
        assertEquals("relay1.beebo.tv", BeeboRelay.hostOf("turn:relay1.beebo.tv:3478?transport=udp"))
        assertEquals("relay1.beebo.tv", BeeboRelay.hostOf("TURNS:Relay1.Beebo.TV:443"))
        assertEquals("[2001:db8::1]", BeeboRelay.hostOf("turn:[2001:db8::1]:3478"))
        assertEquals("relay1.beebo.tv", BeeboRelay.hostOf("turn:relay1.beebo.tv"))
        assertNull(BeeboRelay.hostOf(null))
        assertNull(BeeboRelay.hostOf("nothing"))
    }
    @Test fun `partial stats never claim a direct connection`() {
        assertEquals(TunnelPath.UNKNOWN, TunnelPathRule.decide("host", null, null, beebo, false))
        assertEquals(TunnelPath.UNKNOWN, TunnelPathRule.decide(null, "srflx", null, beebo, false))
    }

    @Test fun `selected candidate events identify remote and local relays without guessing from wifi`() {
        val direct = "candidate:1 1 udp 1234 192.0.2.1 44000 typ host"
        val relay = "candidate:2 1 udp 2345 203.0.113.8 50001 typ relay raddr 0.0.0.0 rport 0"
        assertEquals(TunnelPath.BEEBO_RELAY, TunnelPathRule.fromCandidates(direct, relay, setOf("203.0.113.8")))
        assertEquals(TunnelPath.BEEBO_RELAY, TunnelPathRule.fromCandidates(relay, direct, setOf("203.0.113.8")))
        assertEquals(TunnelPath.RELAY, TunnelPathRule.fromCandidates(direct, relay, emptySet()))
        assertEquals(TunnelPath.DIRECT, TunnelPathRule.fromCandidates(direct, direct, emptySet()))
        assertEquals(TunnelPath.UNKNOWN, TunnelPathRule.fromCandidates(direct, null, emptySet()))
        assertEquals(TunnelPath.CLOUDFLARE_RELAY, TunnelPathRule.decide("relay", "host", "turn:turn.cloudflare.com:3478", beebo, false))
    }

}
