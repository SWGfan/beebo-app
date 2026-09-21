package com.beeboentertainment.movie.rtc

import java.io.IOException

/**
 * One request's reply as it arrives over the tunnel, handed from the thread that receives data
 * channel messages to the thread reading the response body. No Android, so the tricky parts -
 * memory bounds, a dropped connection mid-film, resuming - have JVM tests (StreamExchangeTest).
 *
 * ## Why a reply can "pause" and "resume"
 * A data channel can't push back on the sender from the receiving side without stalling every
 * other request on it (and WebRTC's own thread with it). But a player stops reading once its
 * buffer is full, while the PC keeps sending the rest of the film. So when more than
 * [highWaterBytes] is waiting unread, the tunnel tells the PC to stop (`abort`), keeps what
 * already arrived, and when the reader has used it all, asks again from the next byte with a
 * Range request under a new id. The same path carries a reply over a reconnect: when the
 * connection drops (Wi-Fi to mobile data), a ranged reply is marked [paused] instead of failed,
 * and the reader picks it up on the new connection at exactly the byte it had reached.
 *
 * Only a reply that can be resumed byte-exactly is ([resumable]): a GET answered 200 or 206 by a
 * server that does ranges. Anything else fails honestly when its connection goes.
 *
 * Bytes for an id that is no longer current (stragglers from before a resume) are dropped, and
 * the resume range starts right after the last byte accepted, so nothing is doubled or lost.
 */
class StreamExchange(
    val method: String,
    initialWireId: String,
    private val highWaterBytes: Long = DEFAULT_HIGH_WATER,
) {
    companion object {
        const val DEFAULT_HIGH_WATER = 8L * 1024 * 1024
    }

    sealed class Take {
        class Chunk(val bytes: ByteArray) : Take()
        data object End : Take()
        /** Everything received has been read; ask for the rest with [beginResume]. */
        data object NeedsResume : Take()
    }

    private val lock = Object()
    private val queue = ArrayDeque<ByteArray>()

    @Volatile var wireId: String = initialWireId
        private set

    private var head: TunnelProtocol.ResponseHead? = null
    private var headError: IOException? = null
    private var ended = false
    private var error: IOException? = null
    private var queuedBytes = 0L
    /** Body bytes accepted since the first response began, across resumes. */
    private var acceptedTotal = 0L
    private var cancelled = false

    /** The PC was asked to stop (reader behind, or the connection went) and must be asked again. */
    var paused = false
        private set

    /** Start and end of what the first reply covered, for resuming. */
    private var spanStart = 0L
    private var spanEnd: Long? = null
    private var resumingFrom: Long? = null

    var resumable = false
        private set

    // ------------------------------------------------------------ from the channel

    /** Returns true when the PC should be told to stop sending this id (reader too far behind). */
    fun onBinary(id: String, payload: ByteArray): Boolean = synchronized(lock) {
        if (id != wireId || cancelled || ended || error != null) return false
        if (head == null) return false
        if (payload.isNotEmpty()) {
            queue.addLast(payload)
            queuedBytes += payload.size
            acceptedTotal += payload.size
            lock.notifyAll()
        }
        if (resumable && !paused && queuedBytes > highWaterBytes) {
            paused = true
            return true
        }
        false
    }

    fun onHead(id: String, h: TunnelProtocol.ResponseHead) = synchronized(lock) {
        if (id != wireId || cancelled) return
        val from = resumingFrom
        if (from != null) {
            resumingFrom = null
            val start = TunnelProtocol.contentRangeStart(h.headers.firstOrNull { it.first.equals("Content-Range", true) }?.second)
            if (h.status != 206 || start != from) {
                error = IOException("Your home computer couldn't carry on from where the video had got to.")
            }
            lock.notifyAll()
            return
        }
        if (head != null) return
        head = h
        val crange = h.headers.firstOrNull { it.first.equals("Content-Range", true) }?.second
        val acceptsRanges = crange != null ||
            h.headers.any { it.first.equals("Accept-Ranges", true) && it.second.equals("bytes", true) }
        resumable = method.equals("GET", true) && (h.status == 200 || h.status == 206) && acceptsRanges &&
            (h.status == 206 || h.contentLength >= 0)
        if (crange != null) {
            spanStart = TunnelProtocol.contentRangeStart(crange) ?: 0L
            spanEnd = Regex("""^\s*bytes\s+\d+-(\d+)/""").find(crange)?.groupValues?.get(1)?.toLongOrNull()
        } else {
            spanStart = 0L
            spanEnd = if (h.contentLength > 0) h.contentLength - 1 else null
        }
        lock.notifyAll()
    }

    fun onEnd(id: String) = synchronized(lock) {
        if (id != wireId) return
        ended = true
        paused = false
        lock.notifyAll()
    }

    fun onErr(id: String, status: Int) = synchronized(lock) {
        if (id != wireId) return
        val e = IOException(
            if (status == 413) "That upload is too large for your home computer."
            else "Your home computer couldn't serve that ($status)."
        )
        if (head == null) headError = e else error = e
        lock.notifyAll()
    }

    /**
     * The connection this id was on has gone. A resumable reply that is under way waits to be
     * resumed; anything else fails with [reason]. Returns true if it will resume.
     */
    fun onLinkLost(reason: String): Boolean = synchronized(lock) {
        if (ended || cancelled || error != null) return false
        // A resume request whose own connection went is simply asked again on the next one.
        val canResume = head != null && resumable
        if (canResume) {
            paused = true
            resumingFrom = null
        } else {
            val e = IOException(reason)
            if (head == null) headError = e else error = e
            resumingFrom = null
        }
        lock.notifyAll()
        canResume
    }

    // --------------------------------------------------------------- the reader

    /** Wait for the status line. Throws what the PC or the connection said instead. */
    fun awaitHead(timeoutMs: Long): TunnelProtocol.ResponseHead = synchronized(lock) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (head == null && headError == null && !cancelled) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) throw IOException("Your home computer didn't answer in time.")
            lock.wait(left)
        }
        headError?.let { throw it }
        if (cancelled) throw IOException("Canceled")
        head!!
    }

    fun take(timeoutMs: Long): Take = synchronized(lock) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val next = queue.removeFirstOrNull()
            if (next != null) {
                queuedBytes -= next.size
                return Take.Chunk(next)
            }
            if (ended) return Take.End
            error?.let { throw it }
            if (cancelled) throw IOException("Canceled")
            if (paused && resumingFrom == null) return Take.NeedsResume
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) throw IOException("Your home computer stopped sending.")
            lock.wait(left)
        }
        @Suppress("UNREACHABLE_CODE")
        Take.End
    }

    /**
     * Carry on under [newWireId]. Returns the Range header to request; bytes for the old id are
     * ignored from now on. The reply to it must be a 206 starting at exactly that byte.
     */
    fun beginResume(newWireId: String): String = synchronized(lock) {
        check(paused) { "not paused" }
        val from = spanStart + acceptedTotal
        wireId = newWireId
        paused = false
        resumingFrom = from
        TunnelProtocol.resumeRange(spanStart, spanEnd, acceptedTotal)
    }

    /**
     * Wait until a resume request has been answered (or its connection dropped too). Always true
     * then: the reader goes back to [take], which hands out what arrived and says NeedsResume
     * again if the PC was paused once more (reader behind) or the link went (a new link).
     */
    fun awaitResumed(timeoutMs: Long): Boolean = synchronized(lock) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (resumingFrom != null && error == null && !cancelled) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) throw IOException("Your home computer didn't answer in time.")
            lock.wait(left)
        }
        error?.let { throw it }
        if (cancelled) throw IOException("Canceled")
        true
    }

    /** Also covers a failed resume request's delivery. */
    fun fail(e: IOException) = synchronized(lock) {
        if (head == null) headError = e else error = e
        resumingFrom = null
        lock.notifyAll()
    }

    fun cancel() = synchronized(lock) {
        cancelled = true
        queue.clear()
        queuedBytes = 0
        lock.notifyAll()
    }

    val isFinished: Boolean get() = synchronized(lock) { ended || cancelled || error != null || headError != null }

    internal val queuedForTest: Long get() = synchronized(lock) { queuedBytes }
}
