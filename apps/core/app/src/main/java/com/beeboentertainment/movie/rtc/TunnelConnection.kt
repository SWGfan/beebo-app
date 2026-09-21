package com.beeboentertainment.movie.rtc

import java.io.IOException

/**
 * Keeps one [TunnelLink] open, on its own background thread, and tells the UI what it is doing.
 *
 *  - Connecting happens on "beebo-tunnel" only, never on the caller's thread (so never the main
 *    thread), and one attempt at a time.
 *  - A dropped link is replaced at once, then after 1, 2, 4, 8, 15 and every 30 s
 *    ([ReconnectBackoff]); a network change starts the count again.
 *  - Requests ([awaitLink]) wait up to [requestWaitMs] for a link rather than failing the moment
 *    Wi-Fi hands over to mobile data.
 *  - A failure no retry can fix (wrong password, subscription lapsed, signed out) is [fatal]:
 *    it stops retrying and every waiting request fails with its message straight away.
 *  - It only reconnects while someone wants it: [keepAlive] (the app is open, or a film or
 *    download is running) or a request in the last two minutes.
 */
class TunnelConnection(
    private val factory: TunnelLinkFactory,
    private val listener: TunnelLinkListener,
    private val requestWaitMs: Long = ReconnectBackoff.REQUEST_WAIT_MS,
    private val jitter: () -> Double = { 0.0 },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    sealed class Status {
        data object Idle : Status()
        data class Connecting(val attempt: Int, val reconnecting: Boolean) : Status()
        data class Open(
            val relayed: Boolean,
            val legacyHost: Boolean,
            val path: TunnelPath = if (relayed) TunnelPath.RELAY else TunnelPath.UNKNOWN,
        ) : Status() {
            /** "Direct connection", "Through Beebo Relay" or "Through a relay"; null if unknown. */
            val pathLabel: String? get() = TunnelPathRule.label(path)
        }
        /** Not connected, still trying. [message] is the last reason, fit to show. */
        data class Retrying(val message: String, val code: String, val nextAttemptAtMs: Long) : Status()
        /** Not connected, and not trying until [retryNow] or new credentials. */
        data class Failed(val message: String, val code: String) : Status()
        data object Stopped : Status()
    }

    companion object {
        const val DEMAND_WINDOW_MS = 2 * 60_000L
    }

    private val lock = Object()
    private var link: TunnelLink? = null
    private var thread: Thread? = null
    private var stopped = false
    private var wake = false
    private var attempt = 0
    private var everOpened = false
    private var demandUntil = 0L
    private var fatal: TunnelConnectException? = null
    private var lastError: TunnelConnectException? = null

    @Volatile var keepAlive: Boolean = false
        set(v) { field = v; if (v) poke() }

    @Volatile var status: Status = Status.Idle
        private set(v) { field = v; runCatching { onStatus?.invoke(v) } }

    @Volatile var onStatus: ((Status) -> Unit)? = null

    val currentLink: TunnelLink? get() = synchronized(lock) { link?.takeIf { it.isOpen } }

    /** Begin connecting now, without waiting for a request (after signing in, or opening the app). */
    fun start() {
        synchronized(lock) {
            if (stopped) return
            demandUntil = clock() + DEMAND_WINDOW_MS
            ensureThread()
            wake = true
            lock.notifyAll()
        }
    }

    /**
     * A usable link, waiting for one if need be. Throws the connection's own reason when none
     * comes within [requestWaitMs], and at once when the reason is fatal.
     */
    fun awaitLink(): TunnelLink = synchronized(lock) {
        if (stopped) throw IOException("Not connected to your home computer.")
        demandUntil = clock() + DEMAND_WINDOW_MS
        link?.takeIf { it.isOpen }?.let { return it }
        fatal?.let { throw it }
        ensureThread()
        // Wakes a loop parked for want of demand. A loop backing off after a failure is left to
        // finish its wait: a player retrying every second must not turn into a connect storm.
        lock.notifyAll()
        val deadline = clock() + requestWaitMs
        while (true) {
            link?.takeIf { it.isOpen }?.let { return it }
            fatal?.let { throw it }
            if (stopped) throw IOException("Not connected to your home computer.")
            val left = deadline - clock()
            if (left <= 0) {
                throw IOException(lastError?.message ?: "Can't reach your home computer right now.")
            }
            lock.wait(left)
        }
        @Suppress("UNREACHABLE_CODE")
        throw IllegalStateException()
    }

    /** A route can change without closing the data channel. Ignore callbacks from retired links. */
    fun pathChanged(changed: TunnelLink) = synchronized(lock) {
        if (link === changed && changed.isOpen && !stopped) {
            val next = Status.Open(changed.relayed, changed.features.isLegacy, changed.path)
            if (status != next) status = next
        }
    }

    /** Called by the client when a link reports it closed. */
    fun linkLost(lost: TunnelLink) {
        synchronized(lock) {
            if (link !== lost) return
            link = null
            if (stopped) return
            status = Status.Connecting(1, reconnecting = true)
            attempt = 0
            wake = true
            lock.notifyAll()
        }
    }

    /**
     * The phone moved networks. The old path is almost certainly dead even if WebRTC hasn't noticed
     * yet, so drop the link now (requests and films carry on over the next one) and retry at once.
     */
    fun networkChanged(dropLink: Boolean) {
        val old: TunnelLink?
        synchronized(lock) {
            attempt = ReconnectBackoff.attemptAfterNetworkChange() - 1
            old = if (dropLink) link else null
            wake = true
            lock.notifyAll()
        }
        old?.close()   // reports onClosed -> linkLost
    }

    /** "Try again": also clears a fatal failure, e.g. after signing in again. */
    fun retryNow() {
        synchronized(lock) {
            if (stopped) return
            fatal = null
            attempt = 0
            demandUntil = clock() + DEMAND_WINDOW_MS
            ensureThread()
            wake = true
            lock.notifyAll()
        }
    }

    /** Close the link while nothing needs it (the app went to the background). Reopens on demand. */
    fun closeIdle() {
        val old: TunnelLink?
        synchronized(lock) {
            old = link
            link = null
            demandUntil = 0
            if (!stopped) status = Status.Idle
        }
        old?.close()
    }

    fun shutdown() {
        val old: TunnelLink?
        synchronized(lock) {
            stopped = true
            old = link
            link = null
            lock.notifyAll()
        }
        old?.close()
        thread?.interrupt()
        status = Status.Stopped
    }

    private fun poke() = synchronized(lock) { wake = true; lock.notifyAll() }

    private fun wanted(): Boolean = keepAlive || clock() < demandUntil

    private fun ensureThread() {
        if (thread?.isAlive == true) return
        thread = Thread(::loop, "beebo-tunnel").apply { isDaemon = true; start() }
    }

    private fun loop() {
        while (true) {
            synchronized(lock) {
                while (!stopped && (link?.isOpen == true || fatal != null || !wanted())) {
                    if (link == null && fatal == null && status !is Status.Idle && status !is Status.Retrying && status !is Status.Failed) {
                        status = Status.Idle
                    }
                    wake = false
                    try { lock.wait(if (link == null && fatal == null) 30_000 else 0) } catch (_: InterruptedException) { if (stopped) return }
                }
                if (stopped) return
                attempt++
                status = Status.Connecting(attempt, reconnecting = everOpened)
            }

            val opened: TunnelLink? = try {
                factory.connect(listener)
            } catch (e: TunnelConnectException) {
                onAttemptFailed(e); null
            } catch (e: IOException) {
                onAttemptFailed(TunnelConnectException(e.message ?: "Couldn't connect to your home computer.")); null
            } catch (e: RuntimeException) {
                onAttemptFailed(TunnelConnectException(e.message ?: "Couldn't connect to your home computer.")); null
            }

            if (opened != null) {
                synchronized(lock) {
                    if (stopped) { opened.close(); return }
                    link = opened
                    attempt = 0
                    everOpened = true
                    lastError = null
                    fatal = null
                    status = Status.Open(opened.relayed, opened.features.isLegacy, opened.path)
                    lock.notifyAll()
                }
            }
        }
    }

    private fun onAttemptFailed(e: TunnelConnectException) {
        synchronized(lock) {
            lastError = e
            if (e.fatal) {
                fatal = e
                status = Status.Failed(e.message ?: "", e.code)
                lock.notifyAll()
                return
            }
            val delay = ReconnectBackoff.delayMs(attempt + 1, jitter())
            status = Status.Retrying(e.message ?: "", e.code, clock() + delay)
            // Requests waiting on this attempt learn why, but keep waiting out their own deadline.
            lock.notifyAll()
            wake = false
            val until = clock() + delay
            while (!stopped && !wake) {
                val left = until - clock()
                if (left <= 0) break
                try { lock.wait(left) } catch (_: InterruptedException) { if (stopped) return }
            }
        }
    }
}
