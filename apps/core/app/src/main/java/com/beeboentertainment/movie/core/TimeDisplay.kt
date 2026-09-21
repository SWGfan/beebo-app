package com.beeboentertainment.movie.core

/**
 * The player's "show time remaining" toggle — Plex/YouTube-style: tapping the duration label
 * (the one on the far side of the seek bar from the elapsed-time label) flips it between the
 * file's total length and a negative countdown to the end. Elapsed time is never touched by
 * this: it always reads how much of the file has played.
 *
 * Kept pure, like [BackgroundPlaybackSetting] next to it, so the formatting and the
 * remembered-across-videos behaviour can be asserted without Android or Media3.
 */
class TimeRemainingSetting(private val store: KeyValueStore) {

    companion object {
        /** Must stay stable — changing it would silently reset everyone's preference. */
        const val KEY = "show_time_remaining"

        /** OFF by default: a fresh install shows the total length, same as every player. */
        const val DEFAULT = false
    }

    var enabled: Boolean
        get() = store.getBoolean(KEY, DEFAULT)
        set(value) { store.putBoolean(KEY, value) }

    /** Flip it and return the new state. */
    fun toggle(): Boolean {
        val next = !enabled
        enabled = next
        return next
    }
}

/**
 * What the duration label should read, given the toggle above.
 *
 * OFF (the default): the file's total length, e.g. "58:50" — exactly what Media3's own control
 * view already shows.
 *
 * ON: how much is left, as a countdown with a leading "-", e.g. "-45:16". A duration that isn't
 * known yet (still loading, or the server never sent one) falls back to the plain "0:00" rather
 * than a misleading "-0:00".
 */
object TimeRemainingLabel {
    fun forDuration(durationMs: Long, positionMs: Long, showRemaining: Boolean): String {
        if (!showRemaining || durationMs <= 0) return formatMs(durationMs)
        val remaining = (durationMs - positionMs).coerceAtLeast(0)
        return "-" + formatMs(remaining)
    }
}
