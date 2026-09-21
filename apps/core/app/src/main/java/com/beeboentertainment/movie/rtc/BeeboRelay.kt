package com.beeboentertainment.movie.rtc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Beebo Relay: Beebo's own TURN server (relay1.beebo.tv), for when this phone and the home
 * computer can't reach each other directly (a router with no open ports on both ends).
 *
 * The Worker hands out short-lived TURN REST credentials at POST /rtc/relay/credentials, with the
 * viewer token. They are added to the ICE servers alongside STUN; ICE still prefers a direct
 * path and only uses the relay when nothing else works.
 *
 * No Android or WebRTC types here, so RemoteRulesTest-style JVM tests cover every rule
 * (BeeboRelayTest). The phone app (RemoteAccess) and the car app (AutoRemote) both use it.
 */

/** One ICE server in plain values; BeeboTunnel turns these into PeerConnection.IceServer. */
data class IceSpec(val urls: List<String>, val username: String? = null, val credential: String? = null)

/** What asking the Worker for relay credentials came to. */
sealed class RelayFetch {
    data class Granted(val servers: List<IceSpec>, val expiresAtSec: Long) : RelayFetch()
    /** The Worker said no (404 relay off, 401/402/403/429/503), or answered with something unusable. */
    data class Refused(val status: Int, val reason: String) : RelayFetch()
    /** No answer at all: network error, or no answer in time. */
    data class Failed(val reason: String) : RelayFetch()
}

object BeeboRelay {
    /** Beebo's own coturn (OVH) answers STUN on 3478; replaced Cloudflare's public stun.cloudflare.com. */
    const val STUN_URL = "stun:relay1.beebo.tv:3478"
    const val PATH = "/rtc/relay/credentials"

    /** How long a connection attempt waits for credentials before going ahead without them. */
    const val WAIT_MS = 2_000L
    /** Reuse cached credentials only while more than this is left before they expire... */
    const val REUSE_MIN_LEFT_MS = 60 * 60_000L
    /** ...and only while the cache is younger than this. */
    const val REUSE_MAX_AGE_MS = 30 * 60_000L
    /** After a refusal (relay off, not enabled, capped...), don't ask again for this long. */
    const val REFUSED_BACKOFF_MS = 5 * 60_000L
    /** After no answer at all (network, timeout), a shorter pause. */
    const val FAILED_BACKOFF_MS = 60_000L

    private const val MAX_SERVERS = 4
    private const val MAX_URLS = 8
    private const val MAX_SECRET = 512

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * turn:/turns: host:port with an optional ?transport=udp|tcp and nothing else. Host is a DNS
     * name, an IPv4 address or a bracketed IPv6 address.
     */
    private val STRICT = Regex(
        """^turns?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\]):(\d{1,5})(?:\?transport=(?:udp|tcp))?$""",
        RegexOption.IGNORE_CASE,
    )

    /** A TURN URL worth handing to WebRTC: strict shape, a real port, never 53. */
    fun usableUrl(url: String): Boolean {
        val m = STRICT.matchEntire(url) ?: return false
        val port = m.groupValues[1].toIntOrNull() ?: return false
        return port in 1..65535 && port != 53 && RelayUrls.usable(url)
    }

    /** The Worker's answer, by HTTP status and body text. */
    fun parseResponse(status: Int, body: String): RelayFetch {
        val obj = runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull()
        if (status != 200) {
            val code = (obj?.get("error") as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
            return RelayFetch.Refused(status, code.ifEmpty { "http_$status" })
        }
        if (obj == null) return RelayFetch.Refused(200, "malformed")
        val expiresAt = (obj["expiresAt"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
            ?: return RelayFetch.Refused(200, "malformed")
        val servers = parseServers(obj["iceServers"] as? JsonArray)
        if (servers.isEmpty()) return RelayFetch.Refused(200, "no_usable_servers")
        return RelayFetch.Granted(servers, expiresAt)
    }

    /** The viewer page's own-relay rules: at most 4 entries and 8 URLs each, string credentials. */
    fun parseServers(arr: JsonArray?): List<IceSpec> {
        if (arr == null) return emptyList()
        val out = mutableListOf<IceSpec>()
        for (e in arr.take(MAX_SERVERS)) {
            val o = e as? JsonObject ?: continue
            val user = secret(o["username"]) ?: continue
            val cred = secret(o["credential"]) ?: continue
            val urls = when (val u = o["urls"]) {
                is JsonPrimitive -> if (u.isString) listOf(u.content) else emptyList()
                is JsonArray -> u.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                else -> emptyList()
            }.filter(::usableUrl).take(MAX_URLS)
            if (urls.isEmpty()) continue
            out.add(IceSpec(urls, user, cred))
        }
        return out
    }

    private fun secret(e: Any?): String? {
        val p = e as? JsonPrimitive ?: return null
        if (!p.isString) return null
        return p.content.takeIf { it.isNotEmpty() && it.length <= MAX_SECRET }
    }

    /** STUN first (the direct path), then the relay. */
    fun iceSpecs(relay: List<IceSpec>, stunUrls: List<String> = listOf(STUN_URL)): List<IceSpec> =
        listOf(IceSpec(stunUrls)) + relay

    enum class CacheDecision { REUSE, FETCH, BACKOFF }

    fun decide(nowMs: Long, cachedExpiresAtSec: Long?, cachedAtMs: Long, retryNotBeforeMs: Long): CacheDecision {
        if (cachedExpiresAtSec != null &&
            cachedExpiresAtSec * 1000 - nowMs > REUSE_MIN_LEFT_MS &&
            nowMs - cachedAtMs < REUSE_MAX_AGE_MS
        ) return CacheDecision.REUSE
        if (nowMs < retryNotBeforeMs) return CacheDecision.BACKOFF
        return CacheDecision.FETCH
    }

    /** Hosts of TURN URLs ("relay1.beebo.tv"), lower case. */
    fun hostOf(url: String?): String? {
        if (url == null) return null
        val rest = url.substringAfter(':', "").substringBefore('?')
        if (rest.isEmpty()) return null
        val host = if (rest.startsWith("[")) rest.substringBefore(']') + "]" else rest.substringBeforeLast(':')
        return host.lowercase().takeIf { it.isNotEmpty() }
    }
}

/**
 * Beebo Relay credentials for one house, cached, never holding a connection up for long.
 *
 * [serversFor] returns the TURN servers to add for the next connection attempt, or nothing:
 *  - cached credentials with more than an hour left (and fetched under 30 min ago) are reused;
 *  - otherwise they are fetched, waiting at most [waitMs]; an answer that comes later still
 *    fills the cache for the next attempt;
 *  - any failure means STUN only, logged once, and no new request for a while (5 min after a
 *    refusal, 1 min after no answer).
 * A running connection keeps its relay allocation; credentials only matter when a new
 * PeerConnection is made, which is exactly when this is asked.
 */
class BeeboRelayCredentials(
    private val fetch: (token: String) -> RelayFetch,
    private val clock: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
    private val waitMs: Long = BeeboRelay.WAIT_MS,
    private val start: (Runnable) -> Unit = { r -> Thread(r, "beebo-relay-credentials").apply { isDaemon = true }.start() },
) {
    private val lock = Object()
    private var cached: RelayFetch.Granted? = null
    private var cachedAt = 0L
    private var retryNotBefore = 0L
    private var inFlight = false

    fun serversFor(token: String): List<IceSpec> = synchronized(lock) {
        when (BeeboRelay.decide(clock(), cached?.expiresAtSec, cachedAt, retryNotBefore)) {
            BeeboRelay.CacheDecision.REUSE -> return cached!!.servers
            BeeboRelay.CacheDecision.BACKOFF -> return emptyList()
            BeeboRelay.CacheDecision.FETCH -> {}
        }
        if (!inFlight) {
            inFlight = true
            val ok = runCatching {
                start(Runnable {
                    val r = try { fetch(token) } catch (e: Exception) { RelayFetch.Failed(e.javaClass.simpleName) }
                    record(r)
                })
            }
            if (ok.isFailure) { inFlight = false; record(RelayFetch.Failed("no_thread")); return emptyList() }
        }
        val deadline = System.nanoTime() + waitMs * 1_000_000
        while (inFlight) {
            val leftMs = (deadline - System.nanoTime()) / 1_000_000
            if (leftMs <= 0) {
                log("Beebo Relay credentials took over ${waitMs} ms; connecting without the relay")
                return emptyList()
            }
            try { lock.wait(leftMs) } catch (_: InterruptedException) { Thread.currentThread().interrupt(); return emptyList() }
        }
        val c = cached ?: return emptyList()
        // Just fetched: use it even with under an hour left, as long as it hasn't run out.
        return if (c.expiresAtSec * 1000 - clock() > 60_000) c.servers else emptyList()
    }

    /** Forget everything (signed out, another house). */
    fun clear() = synchronized(lock) { cached = null; cachedAt = 0; retryNotBefore = 0 }

    private fun record(r: RelayFetch) = synchronized(lock) {
        val now = clock()
        when (r) {
            is RelayFetch.Granted -> { cached = r; cachedAt = now; retryNotBefore = 0 }
            is RelayFetch.Refused -> {
                cached = null
                retryNotBefore = now + BeeboRelay.REFUSED_BACKOFF_MS
                log("Beebo Relay not available (${r.status} ${r.reason}); direct connection only")
            }
            is RelayFetch.Failed -> {
                retryNotBefore = now + BeeboRelay.FAILED_BACKOFF_MS
                log("Beebo Relay credentials unavailable (${r.reason}); direct connection only")
            }
        }
        inFlight = false
        lock.notifyAll()
    }
}

/** How the open tunnel reaches the home computer. */
enum class TunnelPath {
    UNKNOWN, DIRECT, BEEBO_RELAY, CLOUDFLARE_RELAY, RELAY;

    val isRelay: Boolean get() = this == BEEBO_RELAY || this == CLOUDFLARE_RELAY || this == RELAY
}

/** Which path the selected ICE candidate pair uses, from WebRTC stats in plain values. */
object TunnelPathRule {
    /** One RTCStats entry: its id, type ("transport", "candidate-pair", ...) and members. */
    data class Stat(val id: String, val type: String, val members: Map<String, Any?>)

    fun label(path: TunnelPath): String? = when (path) {
        TunnelPath.DIRECT -> "Direct connection"
        TunnelPath.BEEBO_RELAY -> "Through Beebo Relay"
        TunnelPath.CLOUDFLARE_RELAY -> "Through Cloudflare Relay"
        TunnelPath.RELAY -> "Through a relay · provider not identified"
        TunnelPath.UNKNOWN -> null
    }

    /**
     * [beeboRelayHosts]: hosts of the Beebo Relay servers this connection was given.
     * [configuredIceUrls]: every ICE URL it was given, to tell Beebo's relay from the house's own
     * when WebRTC doesn't say which server a relay candidate came from.
     */
    fun fromStats(stats: Collection<Stat>, beeboRelayHosts: Set<String>, configuredIceUrls: List<String>): TunnelPath {
        val byId = stats.associateBy { it.id }
        val pairId = stats.filter { it.type == "transport" }.firstNotNullOfOrNull { it.members["selectedCandidatePairId"] as? String }
        val pair = pairId?.let { byId[it] }?.takeIf { it.type == "candidate-pair" }
            ?: stats.filter { it.type == "candidate-pair" && it.members["nominated"] == true && it.members["state"] == "succeeded" }.singleOrNull()
            ?: return TunnelPath.UNKNOWN
        val local = (pair.members["localCandidateId"] as? String)?.let { byId[it] }
        val remote = (pair.members["remoteCandidateId"] as? String)?.let { byId[it] }
        if (local == null && remote == null) return TunnelPath.UNKNOWN
        val onlyBeebo = configuredIceUrls
            .filter { it.startsWith("turn:", true) || it.startsWith("turns:", true) }
            .let { turn -> turn.isNotEmpty() && turn.all { BeeboRelay.hostOf(it) in beeboRelayHosts } }
        return decide(
            local?.members?.get("candidateType") as? String,
            remote?.members?.get("candidateType") as? String,
            local?.members?.get("url") as? String,
            beeboRelayHosts,
            onlyBeebo,
        )
    }

    fun decide(
        localType: String?,
        remoteType: String?,
        localUrl: String?,
        beeboRelayHosts: Set<String>,
        onlyBeeboRelaysConfigured: Boolean,
    ): TunnelPath {
        if (localType == null && remoteType == null) return TunnelPath.UNKNOWN
        if (localType == "relay") {
            val host = BeeboRelay.hostOf(localUrl?.takeIf { it.isNotBlank() })
            return when {
                host != null -> providerOf(host, beeboRelayHosts)
                onlyBeeboRelaysConfigured -> TunnelPath.BEEBO_RELAY
                else -> TunnelPath.RELAY
            }
        }
        // The home computer's end is relayed: through a relay, but not one this phone chose.
        if (remoteType == "relay") return TunnelPath.RELAY
        val directTypes = setOf("host", "srflx", "prflx")
        return if (localType in directTypes && remoteType in directTypes) TunnelPath.DIRECT else TunnelPath.UNKNOWN
    }

    fun providerOf(host: String?, beeboRelayHosts: Set<String>): TunnelPath = when {
        host == null -> TunnelPath.RELAY
        host.lowercase() in beeboRelayHosts -> TunnelPath.BEEBO_RELAY
        host.equals("turn.cloudflare.com", true) || host.endsWith(".turn.cloudflare.com", true) -> TunnelPath.CLOUDFLARE_RELAY
        else -> TunnelPath.RELAY
    }

    /** ICE emits this whenever the selected route changes, including after connection opens. */
    fun fromCandidates(localSdp: String?, remoteSdp: String?, beeboAddresses: Set<String>): TunnelPath {
        fun type(sdp: String?): String? = sdp?.trim()?.split(Regex("\\s+"))?.let { parts ->
            val at = parts.indexOf("typ"); if (at >= 0) parts.getOrNull(at + 1) else null
        }
        val localType = type(localSdp)
        val remoteType = type(remoteSdp)
        val relayed = listOf(localSdp, remoteSdp).filter { type(it) == "relay" }
        if (relayed.isNotEmpty()) {
            val beebo = relayed.any { it?.trim()?.split(Regex("\\s+"))?.getOrNull(4) in beeboAddresses }
            return if (beebo) TunnelPath.BEEBO_RELAY else TunnelPath.RELAY
        }
        return decide(localType, remoteType, null, emptySet(), false)
    }
}
