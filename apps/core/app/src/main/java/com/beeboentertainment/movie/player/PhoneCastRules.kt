package com.beeboentertainment.movie.player

/**
 * The rules behind "cast to a TV while you are away from home", kept free of Android and of
 * sockets so every one of them has a JVM test (PhoneCastRulesTest).
 *
 * ## What the phone is doing
 * Away from home the video only exists at the far end of this phone's private tunnel to the
 * home computer. A Chromecast cannot join that tunnel: hand it `https://name.beebo.tv/file?...`
 * and it fetches a name that does not lead to the home computer, and the TV just spins.
 *
 * So the phone becomes the middleman. It runs a very small web server on its own Wi-Fi address,
 * hands the TV `http://<this phone>:<port>/c/<token>/<slot>`, and answers each of the TV's
 * requests - Range requests included, which is how a Chromecast seeks - by asking the home
 * computer for the same bytes down the tunnel it already has and passing them straight on.
 *
 * ## What this file decides
 *  - the shape of those URLs, and how a request line is turned back into "which of this item's
 *    files is being asked for" ([route]);
 *  - that the token must match, on every single request, compared in constant time;
 *  - what to do with the TV's `Range:` header ([rangeFor]);
 *  - which headers the answer carries ([responseHeaders]).
 *
 * The server itself (PhoneCastRelay) holds the sockets, the wake lock and the one item's URLs.
 */
object PhoneCastRules {

    /** Every URL the TV is given starts here. Nothing else on the server answers at all. */
    const val PATH_PREFIX = "/c/"

    /** Video, its sidecar subtitles and its poster. A cap so a session can never grow into a proxy. */
    const val MAX_SLOTS = 16

    /** 128 bits of randomness, as hex. Long enough that guessing it is not a plan. */
    const val TOKEN_BYTES = 16

    /** The phone reads ahead of the TV by at most this much, then waits for the TV to catch up. */
    const val COPY_BUFFER_BYTES = 64 * 1024

    // ------------------------------------------------------------------ the token

    fun tokenFrom(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }

    /**
     * Same token? Compared without an early exit, so the time taken says nothing about how much
     * of a guess was right.
     */
    fun tokenMatches(expected: String?, given: String?): Boolean {
        if (expected.isNullOrEmpty() || given.isNullOrEmpty()) return false
        if (expected.length != given.length) return false
        var diff = 0
        for (i in expected.indices) diff = diff or (expected[i].code xor given[i].code)
        return diff == 0
    }

    // ------------------------------------------------------------------- the URLs

    /** The address handed to the TV for one of this item's files. */
    fun url(host: String, port: Int, token: String, slot: Int): String =
        "http://$host:$port$PATH_PREFIX$token/$slot"

    /** What a request turned out to be. Everything that is not [Serve] is refused. */
    sealed class Routed {
        /** Serve slot [slot] of the item being cast. */
        data class Serve(val slot: Int) : Routed()
        data object NotFound : Routed()
        /** Right shape, wrong or stale token: the answer says nothing more than "no". */
        data object Forbidden : Routed()
        data object MethodNotAllowed : Routed()
        /**
         * The TV asking, before it fetches, what it is allowed to do. Answered with the same
         * permission every reply here carries and nothing else - not even whether the token was
         * right, because the answer is the same either way.
         */
        data object Preflight : Routed()
    }

    /**
     * Turn one request line into a decision.
     *
     * [target] is the raw request target exactly as the TV sent it. There is no directory
     * listing, no root page and no other route: a request that is not `/c/<token>/<slot>` for a
     * slot this session actually registered is a 404, whatever it looks like. `..` cannot help
     * anyone here because nothing is ever read from a path - the slot is a number, looked up in
     * the session's own small list of URLs.
     */
    fun route(method: String, target: String, expectedToken: String?, slots: Set<Int>): Routed {
        val m = method.uppercase()
        // A Cast receiver fetches a subtitle file with a script rather than a <video> tag, and
        // some ask permission first. Saying yes costs nothing: permission to read is all this
        // server ever gives, and the token still has to be right to get any bytes.
        if (m == "OPTIONS") return Routed.Preflight
        if (m != "GET" && m != "HEAD") return Routed.MethodNotAllowed
        val path = target.substringBefore('?').substringBefore('#')
        if (!path.startsWith(PATH_PREFIX)) return Routed.NotFound
        val rest = path.substring(PATH_PREFIX.length)
        val slash = rest.indexOf('/')
        if (slash <= 0) return Routed.NotFound
        val token = rest.substring(0, slash)
        val slotText = rest.substring(slash + 1)
        if (slotText.isEmpty() || slotText.length > 3 || !slotText.all { it.isDigit() }) return Routed.NotFound
        // The token is checked before the slot is looked up, so a wrong token learns nothing
        // about which slots exist.
        if (!tokenMatches(expectedToken, token)) return Routed.Forbidden
        val slot = slotText.toInt()
        if (slot !in slots) return Routed.NotFound
        return Routed.Serve(slot)
    }

    /**
     * Can this file be passed on exactly as it is?
     *
     * Yes for a film, a subtitle file and a poster: the phone reads bytes at one end and writes
     * the same bytes out at the other, and nothing inside them points anywhere.
     *
     * No for a converted stream. When the home computer converts a film on the fly it hands out
     * an HLS (or DASH) playlist - a list naming hundreds of small pieces by paths of its own.
     * Giving the TV that playlist would have it come back asking this phone for pieces nobody
     * registered, and it would simply stall. So away from home the TV is sent the film as it
     * already is on the home computer, and the converting is not offered.
     */
    fun canPassThrough(url: String): Boolean {
        val path = url.substringBefore('?').substringBefore('#').lowercase()
        return !path.endsWith(".m3u8") && !path.endsWith(".m3u") && !path.endsWith(".mpd")
    }

    // ------------------------------------------------------------------ Range

    /**
     * What to do with the TV's `Range:` header. The phone does not hold the file, so it does not
     * work out byte offsets itself: it passes a sensible range on to the home computer and hands
     * back whatever comes.
     */
    sealed class RangeDecision {
        /** No usable range: ask for the whole thing. */
        data object Whole : RangeDecision()
        /** Ask the home computer for exactly this. */
        data class Pass(val header: String) : RangeDecision()
        /** Nonsense that can never be satisfied (end before start): 416. */
        data object Unsatisfiable : RangeDecision()
    }

    /**
     * RFC 7233 is clear that a Range header a server cannot make sense of is IGNORED rather than
     * refused, so anything odd here falls back to sending the whole file - which always plays,
     * even if seeking then costs more. Only a range that is real but impossible (`bytes=500-100`)
     * is refused with 416.
     *
     * More than one range in a single header (`bytes=0-99,200-299`) is answered with the whole
     * file: no player Beebo casts to asks for that, and a single body is always a legal answer.
     */
    fun rangeFor(header: String?): RangeDecision {
        val raw = header?.trim().orEmpty()
        if (raw.isEmpty() || raw.length > 128) return RangeDecision.Whole
        if (!raw.startsWith("bytes=", ignoreCase = true)) return RangeDecision.Whole
        val spec = raw.substring(6).trim()
        if (spec.isEmpty() || spec.contains(',')) return RangeDecision.Whole
        val dash = spec.indexOf('-')
        if (dash < 0) return RangeDecision.Whole
        val from = spec.substring(0, dash).trim()
        val to = spec.substring(dash + 1).trim()
        if (from.isEmpty() && to.isEmpty()) return RangeDecision.Whole
        if (!from.all { it.isDigit() } || !to.all { it.isDigit() }) return RangeDecision.Whole
        if (from.isEmpty()) {
            // Suffix range: the last N bytes. N == 0 asks for nothing at all.
            val n = to.toLongOrNull() ?: return RangeDecision.Whole
            if (n <= 0) return RangeDecision.Unsatisfiable
            return RangeDecision.Pass("bytes=-$n")
        }
        val start = from.toLongOrNull() ?: return RangeDecision.Whole
        if (to.isEmpty()) return RangeDecision.Pass("bytes=$start-")
        val end = to.toLongOrNull() ?: return RangeDecision.Whole
        if (end < start) return RangeDecision.Unsatisfiable
        return RangeDecision.Pass("bytes=$start-$end")
    }

    // ------------------------------------------------------------------ the answer

    /**
     * The headers the TV gets back. Whatever the home computer said about the bytes is passed
     * straight through (status, type, length, which part of the file this is); everything else
     * is fixed here so no request can ever talk the phone into a different answer.
     */
    fun responseHeaders(
        upstreamStatus: Int,
        contentType: String?,
        contentLength: Long,
        contentRange: String?,
    ): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>(8)
        out += "Content-Type" to (contentType?.takeIf { it.isNotBlank() && it.none { c -> c == '\r' || c == '\n' } }
            ?: "application/octet-stream")
        out += "Accept-Ranges" to "bytes"
        if (contentLength >= 0) out += "Content-Length" to contentLength.toString()
        if (upstreamStatus == 206 && !contentRange.isNullOrBlank() && contentRange.none { it == '\r' || it == '\n' }) {
            out += "Content-Range" to contentRange
        }
        out += "Cache-Control" to "no-store"
        out += "X-Content-Type-Options" to "nosniff"
        // A Cast receiver page is served from the internet, so it is a different origin from this
        // phone; without these the TV cannot read the reply at all.
        out += "Access-Control-Allow-Origin" to "*"
        out += "Access-Control-Expose-Headers" to "Content-Length, Content-Range, Accept-Ranges"
        out += "Connection" to "close"
        return out
    }

    /** The answer to [Routed.Preflight]: read it, with a range if you like, and nothing more. */
    fun preflightHeaders(): List<Pair<String, String>> = listOf(
        "Access-Control-Allow-Origin" to "*",
        "Access-Control-Allow-Methods" to "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers" to "Range, Accept, Accept-Encoding, Content-Type",
        "Access-Control-Max-Age" to "600",
        "Content-Length" to "0",
        "Connection" to "close",
    )

    fun statusLine(code: Int): String = "HTTP/1.1 $code " + when (code) {
        200 -> "OK"
        204 -> "No Content"
        206 -> "Partial Content"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        416 -> "Range Not Satisfiable"
        502 -> "Bad Gateway"
        504 -> "Gateway Timeout"
        else -> "Error"
    }
}
