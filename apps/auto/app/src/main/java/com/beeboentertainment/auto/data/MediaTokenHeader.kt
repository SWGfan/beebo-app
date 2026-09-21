package com.beeboentertainment.auto.data

import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.ConcurrentHashMap

/**
 * Moves a stream URL's media token (`mt=`) into a request header when the phone plays the
 * stream itself.
 *
 * The server puts `mt` in every stream and subtitle URL because a Cast receiver and a browser's
 * <video> cannot send headers. A URL is also what proxies, tunnels and logs write down, so when
 * ExoPlayer on this phone is the one fetching, the token goes in [HEADER] and the URL goes
 * without it. Http.streamClient does the swap per request; the MediaItem keeps the full URL.
 * (A copy of the phone app's core/MediaTokenHeader.kt; the two apps share no module.)
 *
 * Only for servers that said they read the header ([CAPABILITY] on any response, recorded by
 * [noteResponse]); an older server, or one this process has not heard from yet, keeps the URL
 * form exactly as before. Free of Android so it can be unit tested.
 */
object MediaTokenHeader {

    const val HEADER = "X-Beebo-Media-Token"
    const val CAPABILITY = "X-Beebo-Media-Token-Header"

    private val TOKEN_PATHS = listOf("/file", "/tvfile", "/subtitles/file")
    private val supported: MutableSet<String> = ConcurrentHashMap.newKeySet()

    data class Split(val url: String, val token: String)

    /**
     * Record whether the server at [url] advertised header support. A response from the same
     * origin without it (an older server after a downgrade, a proxy's error page) turns it back
     * off, which only ever falls back to the URL form.
     */
    fun noteResponse(url: String, capability: String?) {
        val o = origin(url) ?: return
        if (capability?.trim() == "1") supported.add(o) else supported.remove(o)
    }

    fun serverAccepts(url: String): Boolean = origin(url)?.let { it in supported } ?: false

    /** The header form of [url] if its server accepts it, else null (play the URL as is). */
    fun forPlayback(url: String): Split? = if (serverAccepts(url)) split(url) else null

    /** [url] without its `mt` parameter, plus the token; null if it is not a tokened stream URL. */
    fun split(url: String): Split? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        val path = uri.rawPath ?: return null
        if (TOKEN_PATHS.none { path.endsWith(it) }) return null
        val rawQuery = uri.rawQuery ?: return null
        var token: String? = null
        val kept = rawQuery.split('&').filter { pair ->
            val name = pair.substringBefore('=')
            if (name == "mt") {
                if (token == null) token = decode(pair.substringAfter('=', ""))
                false
            } else true
        }
        val t = token?.takeIf { it.isNotEmpty() } ?: return null
        val q = url.indexOf('?')
        val hash = url.indexOf('#', q).let { if (it < 0) "" else url.substring(it) }
        val query = if (kept.isEmpty()) "" else "?" + kept.joinToString("&")
        return Split(url.substring(0, q) + query + hash, t)
    }

    internal fun origin(url: String): String? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        val port = when {
            uri.port != -1 -> uri.port
            scheme == "https" -> 443
            scheme == "http" -> 80
            else -> return null
        }
        return "$scheme://$host:$port"
    }

    internal fun forgetAll() = supported.clear()

    private fun decode(s: String): String =
        runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)
}
