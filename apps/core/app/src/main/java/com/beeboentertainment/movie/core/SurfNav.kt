package com.beeboentertainment.movie.core

/**
 * Index arithmetic for Surf mode ("Not Sure What To Watch?").
 *
 * The server hands back {index, total} for a seeded shuffle. Previous/Next just step `i`,
 * but they have to wrap: previous at 0 goes to total-1, next at total-1 goes back to 0.
 * Kept pure so it can be unit-tested without a device.
 */
object SurfNav {

    /** Wrap any integer into [0, total). Returns 0 when the pool is empty. */
    fun wrap(index: Int, total: Int): Int {
        if (total <= 0) return 0
        val m = index % total
        return if (m < 0) m + total else m
    }

    fun next(index: Int, total: Int): Int = wrap(index + 1, total)

    fun previous(index: Int, total: Int): Int = wrap(index - 1, total)

    /** Human-facing "3 of 40". 1-based. Empty pool renders as "0 of 0". */
    fun label(index: Int, total: Int): String =
        if (total <= 0) "0 of 0" else "${wrap(index, total) + 1} of $total"

    /**
     * Where playback should start for a surf pick.
     * The API returns startFraction (0.5) meaning "drop them into the middle".
     * durationMs may be unknown (<= 0) at the moment we ask, in which case we return 0
     * and the caller re-applies the seek once the duration is known.
     */
    fun startPositionMs(durationMs: Long, startFraction: Double): Long {
        if (durationMs <= 0L) return 0L
        val f = startFraction.coerceIn(0.0, 0.99)
        return (durationMs * f).toLong()
    }
}
