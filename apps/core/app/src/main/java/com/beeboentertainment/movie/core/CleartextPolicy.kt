package com.beeboentertainment.movie.core

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

/**
 * Plain http is only for the local network; everything else must be https.
 *
 * Why this lives in code and not only in res/xml/network_security_config.xml: Android's network
 * security config matches exact host names (and their subdomains) only. It has no way to say
 * "any address in 192.168.0.0/16". A home Beebo on the LAN is reached at whatever address the
 * router gave it (http://192.168.1.50:47811, http://10.0.0.7:47811, a Tailscale 100.x address),
 * so the platform config has to leave cleartext permitted, and this policy narrows it for every
 * request the app makes: [install] puts [Guard] on the shared OkHttp client (the API, posters, the
 * player, subtitles, downloads, hub calls) and on the app's other clients, twice: as an application
 * interceptor, so a refused request never opens a connection, and as a network interceptor, so a
 * redirect to plain http on the internet is refused before anything is sent.
 *
 * Allowed over http:
 *  - loopback: localhost, 127.0.0.0/8, ::1 (Campsite Mode's own server on this phone)
 *  - private IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (home Wi-Fi, a phone hotspot:
 *    192.168.43.x and friends, Wi-Fi Direct 192.168.49.x)
 *  - carrier-grade NAT 100.64.0.0/10 (Tailscale)
 *  - link-local 169.254.0.0/16, fe80::/10, and IPv6 unique-local fc00::/7
 *  - names that only exist on a local network: a single label (beebo-pc), .local (mDNS),
 *    .lan, .home, .home.arpa, .internal
 */
object CleartextPolicy {

    private val LOCAL_SUFFIXES = listOf(".local", ".lan", ".home", ".home.arpa", ".internal")

    /** May the app send this request? https always; http only to a local-network host. */
    fun isAllowed(url: String?): Boolean {
        val u = url?.trim()?.toHttpUrlOrNull() ?: return false
        return u.isHttps || isLocalHost(u.host)
    }

    fun isLocalHost(rawHost: String?): Boolean {
        val host = rawHost?.trim()?.lowercase()?.removePrefix("[")?.removeSuffix("]")?.removeSuffix(".") ?: return false
        if (host.isEmpty()) return false
        if (host == "localhost" || host.endsWith(".localhost")) return true
        ipv4(host)?.let { return isPrivateIpv4(it) }
        if (host.contains(':')) return isLocalIpv6(host)
        if (LOCAL_SUFFIXES.any { host.endsWith(it) }) return true
        // A bare name with no dot can't be a public internet host.
        return !host.contains('.') && host.all { it.isLetterOrDigit() || it == '-' }
    }

    private fun ipv4(host: String): IntArray? {
        val parts = host.split('.')
        if (parts.size != 4) return null
        val out = IntArray(4)
        for ((i, p) in parts.withIndex()) {
            if (p.isEmpty() || p.length > 3 || !p.all { it.isDigit() }) return null
            val n = p.toInt()
            if (n > 255) return null
            out[i] = n
        }
        return out
    }

    private fun isPrivateIpv4(a: IntArray): Boolean = when {
        a[0] == 10 -> true
        a[0] == 127 -> true
        a[0] == 172 && a[1] in 16..31 -> true
        a[0] == 192 && a[1] == 168 -> true
        a[0] == 100 && a[1] in 64..127 -> true
        a[0] == 169 && a[1] == 254 -> true
        else -> false
    }

    private fun isLocalIpv6(host: String): Boolean {
        val h = host.substringBefore('%')
        if (h == "::1") return true
        // IPv4-mapped (::ffff:192.168.1.5)
        if (h.startsWith("::ffff:")) return ipv4(h.removePrefix("::ffff:"))?.let { isPrivateIpv4(it) } ?: false
        val first = h.substringBefore(':')
        if (first.isEmpty() || first.length > 4) return false
        // A short group has leading zeros ("fc" is 0x00fc), so it is never fc00::/7 or fe80::/10.
        val word = first.toIntOrNull(16) ?: return false
        return (word and 0xFE00) == 0xFC00 || (word and 0xFFC0) == 0xFE80
    }

    /** Adds [Guard] both before connecting and on every network hop (redirects). */
    fun install(builder: okhttp3.OkHttpClient.Builder): okhttp3.OkHttpClient.Builder =
        builder.addInterceptor(Guard()).addNetworkInterceptor(Guard())

    /** Refuses a plain-http request to anywhere but the local network, before it is sent. */
    class Guard : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val url = chain.request().url
            if (!url.isHttps && !isLocalHost(url.host)) {
                throw IOException("Plain http is only allowed on your local network. Use an https address for ${url.host}.")
            }
            return chain.proceed(chain.request())
        }
    }
}
