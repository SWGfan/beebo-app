package com.beeboentertainment.movie.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Hands a beebo://pair link from the Activity (cold start or an already-open app) to the sign-in
 * screen. The screen parses it with [PairLinks], pre-fills Home, and calls [consume]. A link that
 * nobody picks up (the app is already signed in) simply waits and is replaced by the next one.
 */
object PairRequests {
    private val _pending = MutableStateFlow<String?>(null)
    val pending: StateFlow<String?> = _pending.asStateFlow()

    @Volatile private var offeredAtMs = 0L

    /** [dataString] is the intent's data. Returns whether it was a pairing link. */
    fun offer(dataString: String?, nowMs: Long = System.currentTimeMillis()): Boolean {
        val s = dataString?.trim().orEmpty()
        if (!s.startsWith(PairLinks.PREFIX, ignoreCase = true)) return false
        offeredAtMs = nowMs
        _pending.value = s.take(PairLinks.MAX_LENGTH + 1)
        return true
    }

    /** A link that arrived while the app was already signed in must not surface days later after a sign-out. */
    fun isFresh(nowMs: Long = System.currentTimeMillis(), maxAgeMs: Long = MAX_AGE_MS): Boolean =
        _pending.value != null && nowMs - offeredAtMs <= maxAgeMs

    fun consume() { _pending.value = null }

    const val MAX_AGE_MS = 10 * 60 * 1000L
}
