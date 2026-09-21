package com.beeboentertainment.auto.media

import android.util.Log
import androidx.media3.common.Player
import com.beeboentertainment.auto.data.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.Dispatchers

/**
 * Keeps the server's Continue Watching in step with what the car is playing,
 * so a film started in the car shows up on the phone and the website with the
 * right resume point.
 *
 * The server's own contract: open a watch session once when playback starts,
 * then POST progress periodically. Sessions opened here are NOT marked as
 * surf sessions — someone deliberately picking a title in the car means it.
 *
 * Every entry point here is called from ExoPlayer's application looper, which
 * is the main thread, while the pushes themselves run on IO. The session ids
 * cross that boundary, so they are volatile and every in-flight open is tagged
 * with the mediaId it belongs to: a slow session open for one film arriving
 * after the user has skipped to another would otherwise file the second film's
 * position against the first, and the server writes that straight to history.
 */
class ProgressReporter(
    private val api: ApiClient,
    private val scope: CoroutineScope,
    private val player: Player,
) {
    @Volatile private var sessionId: String? = null
    @Volatile private var sessionMediaId: String? = null
    @Volatile private var ticker: Job? = null
    @Volatile private var opener: Job? = null

    fun onMediaChanged(mediaId: String?, kind: String, serverId: String?) {
        if (mediaId == null || serverId == null) {
            stop()
            return
        }
        if (mediaId == sessionMediaId && (sessionId != null || opener?.isActive == true)) return

        // No final push for the item being left behind: by the time this
        // callback runs the player has already moved on, so its position is
        // the new item's, and posting that against the old session would reset
        // the resume point of the film the user just left. The ticker covers
        // the last twenty seconds of it.
        sessionMediaId = mediaId
        sessionId = null
        opener?.cancel()
        opener = scope.launch { openSession(mediaId, kind, serverId) }
        startTicker()
    }

    fun onPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) {
            startTicker()
            return
        }
        ticker?.cancel()
        ticker = null
        val id = sessionId ?: return
        val at = positionNow() ?: return
        pushDetached(id, at)
    }

    /**
     * The final push is the one that matters most and the one most easily lost:
     * onDestroy calls this and then cancels the scope and releases the player
     * on the very next lines. So the position is read here, synchronously, and
     * the POST goes out on a coroutine that is not a child of the scope.
     */
    fun stop() {
        val id = sessionId
        val at = positionNow()
        ticker?.cancel()
        ticker = null
        opener?.cancel()
        opener = null
        sessionId = null
        sessionMediaId = null
        if (id != null && at != null) pushDetached(id, at)
    }

    /**
     * One failed open used to mean the whole film reported nothing, because
     * nothing ever asked again.
     */
    private suspend fun openSession(mediaId: String, kind: String, serverId: String) {
        var backoff = OPEN_BACKOFF_MS
        for (attempt in 0 until OPEN_ATTEMPTS) {
            if (sessionMediaId != mediaId) return
            val r = runCatching { api.startWatchSession(kind, serverId, surf = false) }
                .onFailure { Log.w(TAG, "watch-session open failed", it) }
                .getOrNull()
            if (sessionMediaId != mediaId) return
            if (r != null && r.ok && !r.sessionId.isNullOrBlank()) {
                sessionId = r.sessionId
                return
            }
            if (attempt < OPEN_ATTEMPTS - 1) {
                delay(backoff)
                backoff *= 2
            }
        }
        Log.w(TAG, "gave up opening a watch session; progress will not be recorded")
    }

    private fun startTicker() {
        if (ticker?.isActive == true) return
        ticker = scope.launch {
            while (isActive) {
                delay(INTERVAL_MS)
                push()
            }
        }
    }

    private suspend fun push() {
        val id = sessionId ?: return
        val at = withContext(Dispatchers.Main) { positionNow() } ?: return
        post(id, at)
    }

    private fun pushDetached(id: String, at: Pair<Double, Double>) {
        scope.launch(NonCancellable) {
            withTimeoutOrNull(FINAL_PUSH_TIMEOUT_MS) { post(id, at) }
        }
    }

    private suspend fun post(id: String, at: Pair<Double, Double>) {
        // A zero is never worth sending and can do harm: an item that has just
        // been cleared reports position 0, and the server would write that over
        // a real resume point.
        if (at.first <= 0) return
        runCatching { api.reportProgress(id, at.first, at.second) }
            .onFailure { Log.w(TAG, "progress failed", it) }
    }

    /**
     * (position, duration) in seconds. Only safe on the player's application
     * looper, which every caller but the ticker is already on; the ticker hops
     * back to it first.
     */
    private fun positionNow(): Pair<Double, Double>? = runCatching {
        val pos = player.currentPosition / 1000.0
        val dur = player.duration
        pos to (if (dur > 0) dur / 1000.0 else 0.0)
    }.getOrNull()

    private companion object {
        const val TAG = "ProgressReporter"
        const val INTERVAL_MS = 20_000L
        const val OPEN_ATTEMPTS = 4
        const val OPEN_BACKOFF_MS = 2_000L
        const val FINAL_PUSH_TIMEOUT_MS = 8_000L
    }
}
