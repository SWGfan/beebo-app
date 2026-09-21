package com.beeboentertainment.movie.music

import kotlin.random.Random

/**
 * The Music player's queue rules, free of Android so they can be unit tested.
 *
 * The queue itself is Media3's playlist inside [MusicPlaybackService]; that is what gives
 * gapless playback and lets the lock screen, a headset and Android Auto move through it. These
 * functions decide what the buttons do to it: the shuffle order (the song you tapped plays
 * first, the rest in random order), the order Up Next is shown in, what repeat means for
 * "next", where "Play next" inserts, and when Previous restarts the song instead.
 */
object MusicQueueLogic {

    /** Repeat, in the order the button cycles through it. */
    enum class Repeat { OFF, ALL, ONE }

    // Media3's Player.REPEAT_MODE_* values, kept here so this file needs no Media3 import.
    const val MEDIA3_REPEAT_OFF = 0
    const val MEDIA3_REPEAT_ONE = 1
    const val MEDIA3_REPEAT_ALL = 2

    /** Previous restarts the song once it has played this long, like every music player. */
    const val RESTART_THRESHOLD_MS = 3_000L

    fun nextRepeat(r: Repeat): Repeat = when (r) {
        Repeat.OFF -> Repeat.ALL
        Repeat.ALL -> Repeat.ONE
        Repeat.ONE -> Repeat.OFF
    }

    fun toMedia3(r: Repeat): Int = when (r) {
        Repeat.OFF -> MEDIA3_REPEAT_OFF
        Repeat.ONE -> MEDIA3_REPEAT_ONE
        Repeat.ALL -> MEDIA3_REPEAT_ALL
    }

    fun fromMedia3(mode: Int): Repeat = when (mode) {
        MEDIA3_REPEAT_ONE -> Repeat.ONE
        MEDIA3_REPEAT_ALL -> Repeat.ALL
        else -> Repeat.OFF
    }

    /**
     * A play order over [size] songs that starts with [first] and visits every other song once in
     * random order. [first] outside the list gives a plain random order.
     */
    fun shuffledOrder(size: Int, first: Int, random: Random = Random.Default): IntArray {
        if (size <= 0) return IntArray(0)
        val rest = (0 until size).filter { it != first }.toMutableList()
        // Fisher-Yates
        for (i in rest.size - 1 downTo 1) {
            val j = random.nextInt(i + 1)
            val t = rest[i]; rest[i] = rest[j]; rest[j] = t
        }
        return if (first in 0 until size) (listOf(first) + rest).toIntArray() else rest.toIntArray()
    }

    /** The unshuffled play order: 0, 1, 2, ... */
    fun straightOrder(size: Int): IntArray = IntArray(size.coerceAtLeast(0)) { it }

    /**
     * The songs still to come after [current] in [order], as indices into the playlist, at most
     * [limit]. With repeat ALL the list carries on from the top of the order and stops just
     * before [current] comes round again. Repeat ONE lists what Next would go to, which is the
     * same as OFF.
     */
    fun upNext(order: IntArray, current: Int, repeat: Repeat, limit: Int = Int.MAX_VALUE): List<Int> {
        val pos = order.indexOf(current)
        if (pos < 0) return emptyList()
        val after = order.drop(pos + 1)
        val wrapped = if (repeat == Repeat.ALL) order.take(pos) else emptyList()
        return (after + wrapped).take(limit.coerceAtLeast(0))
    }

    /**
     * The song after [current]. [auto] is true when the song simply ended: then repeat ONE plays it
     * again. Pressing Next always moves on (repeat ONE acts like OFF, as Media3 does).
     * Null at the end of the queue with repeat off.
     */
    fun nextIndex(order: IntArray, current: Int, repeat: Repeat, auto: Boolean): Int? {
        val pos = order.indexOf(current)
        if (pos < 0) return null
        if (auto && repeat == Repeat.ONE) return current
        if (pos + 1 < order.size) return order[pos + 1]
        return if (repeat == Repeat.ALL && order.isNotEmpty()) order[0] else null
    }

    /** The song before [current], or null at the start with repeat off. */
    fun previousIndex(order: IntArray, current: Int, repeat: Repeat): Int? {
        val pos = order.indexOf(current)
        if (pos < 0) return null
        if (pos > 0) return order[pos - 1]
        return if (repeat == Repeat.ALL && order.isNotEmpty()) order[order.size - 1] else null
    }

    enum class PreviousAction { RESTART, PREVIOUS }

    /** Previous: restart a song that has played for a few seconds, or has nothing before it. */
    fun previousAction(positionMs: Long, hasPrevious: Boolean): PreviousAction =
        if (positionMs > RESTART_THRESHOLD_MS || !hasPrevious) PreviousAction.RESTART else PreviousAction.PREVIOUS

    /**
     * Where "Play next" puts a song: straight after the current one, behind any songs already
     * added with Play next since the current song started, so several play in the order chosen.
     */
    fun playNextIndex(current: Int, size: Int, playNextCount: Int): Int =
        (current + 1 + playNextCount.coerceAtLeast(0)).coerceIn(0, size.coerceAtLeast(0))

    /** Where "Add to queue" puts a song: the end. */
    fun addToQueueIndex(size: Int): Int = size.coerceAtLeast(0)

    /** 185.4 -> "3:05", 3723 -> "1:02:03", null or negative -> "". */
    fun formatDuration(seconds: Double?): String {
        if (seconds == null || seconds.isNaN() || seconds < 0) return ""
        val total = seconds.toLong()
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
    }

    /** An album's length in words: "42 min", "1 hr 5 min". */
    fun formatLength(seconds: Double?): String {
        if (seconds == null || seconds <= 0) return ""
        val minutes = Math.round(seconds / 60.0)
        return if (minutes >= 60) "${minutes / 60} hr ${minutes % 60} min" else "$minutes min"
    }
}
