package com.beeboentertainment.movie.rtc

/**
 * The rules for a download that uses several tunnel connections at once ("stripes"), with no
 * Android in it so every rule has a JVM test (TunnelStripeTest). It decides HOW MANY connections
 * a download deserves and cuts the file into the byte ranges they fetch; opening the extra
 * connections and reading their bodies is the caller's job (the Downloads code).
 *
 * ## Why
 * One WebRTC connection is one SCTP association with one congestion window. On a path with delay
 * and a little loss (a phone on mobile data, a friend's Wi-Fi) that window, not the home
 * computer's CPU, sets the speed: it is halved at every loss and grows back by a packet per round
 * trip. Measured through a network model in docs/TUNNEL-THROUGHPUT.md: 40 ms round trip and 0.2%
 * loss give about 1 MB/s on one connection, about 1.6 with three and 2.4 with six. Two things
 * that do NOT help: several data channels on one connection (one association, one window), and
 * several requests for one file on ONE connection (the host reads a new range of a file it is
 * already sending as a seek, and stops the older one).
 *
 * ## How
 * The primary connection is the ordinary one. Each extra connection is made exactly like it (own
 * offer to the Worker, own answer) and says `hello(stripeOf = <primary's viewerId>)` first; a host
 * that is not new enough, or that refuses (a different signed-in viewer, too many), answers without
 * `stripeOf`, and that connection is closed and the download carries on with what it has. Every
 * connection then repeatedly takes the next unfetched segment of the file ([Assigner]) and asks for
 * it with a Range request. A segment whose connection dies goes back on the queue.
 *
 * ## Costs the caller must weigh
 *  - Each extra connection uses one of the home computer's fixed UDP ports (ten by default,
 *    shared by every viewer) and, through a relay, one more allocation.
 *  - The home upload link is shared with the household: several connections press on it harder
 *    than one. Use them for downloads the person asked for, not for playback, and stop them if
 *    the download is paused.
 *  - It needs a resumable answer (a 200 or 206 from a server that does ranges) and a known length.
 */
object TunnelStripe {

    /** Below this a second connection costs more (a handshake) than it saves. */
    const val MIN_BYTES = 32L * 1024 * 1024

    /** What one Range request asks for. Small enough that a slow connection does not hold the end up. */
    const val SEGMENT_BYTES = 4L * 1024 * 1024

    /** Connections in all, the primary included. The host allows 4 extra; more than 4 total gains little. */
    const val MAX_CONNECTIONS = 4

    /**
     * How many connections a download of [contentLength] bytes should use: [requested] (at most
     * [MAX_CONNECTIONS]) when the host offers stripes and the download can be resumed byte-exactly,
     * otherwise 1.
     */
    fun connectionsFor(host: TunnelProtocol.HostFeatures, contentLength: Long, resumable: Boolean, requested: Int = MAX_CONNECTIONS): Int {
        if (!resumable || !host.stripe || host.isLegacy) return 1
        if (contentLength < MIN_BYTES) return 1
        return requested.coerceIn(1, MAX_CONNECTIONS).coerceAtMost(1 + host.stripes)
    }

    /**
     * The file, or the part of it a Range asked for, cut into segments.
     * [start]..[endInclusive] are byte offsets into the resource.
     */
    class Plan(val start: Long, val endInclusive: Long, val segmentBytes: Long = SEGMENT_BYTES) {
        init {
            require(start >= 0 && endInclusive >= start) { "empty range" }
            require(segmentBytes > 0) { "segment size" }
        }

        val totalBytes: Long get() = endInclusive - start + 1
        val segments: Int get() = ((totalBytes + segmentBytes - 1) / segmentBytes).toInt()

        fun segmentStart(i: Int): Long { check(i in 0 until segments); return start + i * segmentBytes }
        fun segmentEnd(i: Int): Long = minOf(segmentStart(i) + segmentBytes - 1, endInclusive)
        fun segmentLength(i: Int): Long = segmentEnd(i) - segmentStart(i) + 1

        /** The Range header value for segment [i]. */
        fun range(i: Int): String = "bytes=${segmentStart(i)}-${segmentEnd(i)}"

        companion object {
            /** From a `Content-Range: bytes a-b/total` (a 206) or, for a 200, the Content-Length. */
            fun of(contentRange: String?, contentLength: Long): Plan? {
                val m = contentRange?.let { Regex("""^\s*bytes\s+(\d+)-(\d+)/(\d+|\*)\s*$""").find(it) }
                if (m != null) {
                    val a = m.groupValues[1].toLongOrNull() ?: return null
                    val b = m.groupValues[2].toLongOrNull() ?: return null
                    return if (b >= a) Plan(a, b) else null
                }
                return if (contentLength > 0) Plan(0, contentLength - 1) else null
            }
        }
    }

    /**
     * Hands out segment numbers to the connections' workers, each to one worker at a time, in
     * order, and takes back one whose worker failed. Safe to call from several threads.
     */
    class Assigner(private val segmentCount: Int) {
        private val pending = ArrayDeque<Int>().also { q -> for (i in 0 until segmentCount) q.addLast(i) }
        private val done = BooleanArray(segmentCount)
        private var doneCount = 0

        /** The next segment to fetch, or null when none is waiting (others may still be in flight). */
        @Synchronized fun next(): Int? = pending.removeFirstOrNull()

        /** The worker fetched [i] completely. */
        @Synchronized fun complete(i: Int) {
            if (!done[i]) { done[i] = true; doneCount++ }
        }

        /** The worker could not finish [i]: someone else will. It goes to the front, so the file fills in order. */
        @Synchronized fun requeue(i: Int) {
            if (!done[i] && i !in pending) pending.addFirst(i)
        }

        @Synchronized fun finished(): Boolean = doneCount == segmentCount
        @Synchronized fun remaining(): Int = segmentCount - doneCount
    }
}
