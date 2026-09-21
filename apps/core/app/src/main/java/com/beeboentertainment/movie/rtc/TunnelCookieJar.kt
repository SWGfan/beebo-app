package com.beeboentertainment.movie.rtc

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * The cookies the home server set for this phone, kept for as long as the phone stays signed in
 * to one `name.beebo.tv` address - across reconnects, which the host agent's own per-connection
 * jar can't survive (each reconnect is a new connection on the PC).
 *
 * The app's own API calls sign in with a bearer token, not a cookie, but the home server's web
 * routes (and anything it adds later) use its session cookie, and a tunnel that forgot it on
 * every Wi-Fi change would sign the user out of those at random.
 *
 * One origin only, so Domain and Path are not needed: everything goes to the same server.
 * Only name=value is ever sent back. Thread-safe. No Android, so it has a JVM test.
 */
class TunnelCookieJar(private val clock: () -> Long = System::currentTimeMillis) {

    private data class Entry(val value: String, val expiresAtMs: Long?)

    private val cookies = LinkedHashMap<String, Entry>()

    /** Take in every Set-Cookie from one response. */
    @Synchronized
    fun store(setCookies: List<String>) {
        val now = clock()
        for (raw in setCookies) {
            val parts = raw.split(';')
            val nv = parts.first()
            val i = nv.indexOf('=')
            if (i <= 0) continue
            val name = nv.substring(0, i).trim()
            val value = nv.substring(i + 1).trim()
            if (name.isEmpty() || name.any { it == '\r' || it == '\n' } || value.any { it == '\r' || it == '\n' }) continue

            var expires: Long? = null
            var maxAgeSeen = false
            for (attr in parts.drop(1)) {
                val k = attr.substringBefore('=').trim().lowercase()
                val v = attr.substringAfter('=', "").trim()
                when (k) {
                    // Max-Age wins over Expires (RFC 6265 5.3 step 3).
                    "max-age" -> v.toLongOrNull()?.let { expires = now + it * 1000; maxAgeSeen = true }
                    "expires" -> if (!maxAgeSeen) parseHttpDate(v)?.let { expires = it }
                }
            }
            if (expires != null && expires!! <= now) cookies.remove(name)
            else cookies[name] = Entry(value, expires)
        }
    }

    /** The Cookie header for the next request, or null when there is nothing to send. */
    @Synchronized
    fun header(): String? {
        val now = clock()
        cookies.entries.removeAll { (_, e) -> e.expiresAtMs != null && e.expiresAtMs <= now }
        if (cookies.isEmpty()) return null
        return cookies.entries.joinToString("; ") { "${it.key}=${it.value.value}" }
    }

    @Synchronized
    fun clear() = cookies.clear()

    companion object {
        private val FORMATS = listOf(
            "EEE, dd MMM yyyy HH:mm:ss zzz",
            "EEE, dd-MMM-yyyy HH:mm:ss zzz",
            "EEE, dd-MMM-yy HH:mm:ss zzz",
            "EEE MMM d HH:mm:ss yyyy",
        )

        fun parseHttpDate(s: String): Long? {
            for (f in FORMATS) {
                val fmt = SimpleDateFormat(f, Locale.US).apply {
                    timeZone = TimeZone.getTimeZone("GMT")
                    isLenient = false
                }
                val d = runCatching { fmt.parse(s) }.getOrNull()
                if (d != null) return d.time
            }
            return null
        }
    }
}
