package com.beeboentertainment.movie.player

import androidx.media3.datasource.HttpDataSource
import java.util.Collections
import java.util.IdentityHashMap

/**
 * The four-spot away-from-home limit is enforced by the home Beebo server after it has
 * successfully identified an actual video request. It has a dedicated header so an unrelated
 * HTTP 429, such as a retry throttle, can never look like a household limit.
 */
object RemoteStreamCapacity {
    const val ERROR_HEADER = "x-beebo-remote-error"
    const val LIMIT_ERROR = "away_stream_limit"
    const val MESSAGE = "All 4 away-from-home viewing spots are in use. Ask someone in your household to stop watching, then try again."

    /** Returns the customer-facing limit message only for the documented server response. */
    fun messageFor(status: Int, headers: Map<String, List<String>>): String? {
        if (status != 429) return null
        val value = headers.entries.firstOrNull { it.key.equals(ERROR_HEADER, ignoreCase = true) }
            ?.value
            ?.any { it.trim().equals(LIMIT_ERROR, ignoreCase = true) }
            ?: false
        return MESSAGE.takeIf { value }
    }

    /**
     * Media3 preserves the HTTP status and headers in the causal chain. Follow it defensively:
     * a wrapped network exception must not hide the capacity answer, and a malformed loop cannot
     * hang the player error handler.
     */
    fun messageFor(error: Throwable?): String? {
        val seen = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
        var current = error
        while (current != null && seen.add(current)) {
            if (current is HttpDataSource.InvalidResponseCodeException) {
                messageFor(current.responseCode, current.headerFields)?.let { return it }
            }
            current = current.cause
        }
        return null
    }
}