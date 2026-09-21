package com.beeboentertainment.auto.family

/**
 * The sleep timer for Roadside Stories (and any Family Fun audio): a wind-down that ends in silence.
 *
 * Plain arithmetic on millisecond readings of any steadily increasing clock, so a test drives it
 * with a fake clock and a wall-clock or time-zone change cannot bend it (the app passes
 * SystemClock.elapsedRealtime). The service asks [tick] about once a second while a timer is set
 * and does what it says.
 *
 * WHAT IT PROMISES. The volume stays where it is until the last stretch, falls in a straight line
 * to nothing, and then playback is paused. After that [tick] only ever says "stopped", so nothing
 * can start playing again because of the timer. It is a timer and a fade. It does not claim to help
 * anyone sleep, and it is not a treatment for anything.
 */
data class SleepTimerState(val startedAtMs: Long, val durationMs: Long) {
    val endAtMs: Long get() = startedAtMs + durationMs
}

/** What the player should do right now. */
data class SleepTick(
    /** Volume to set, 0..1. */
    val volume: Float,
    /** True once the time is up: pause, reset the volume for next time, forget the timer. */
    val stop: Boolean,
)

object SleepTimerLogic {

    /** The choices offered on the phone and in the car (minutes). */
    val CHOICES_MINUTES = listOf(15, 30, 45)

    /** The default when it is quiet hours and the parent has not picked one. */
    const val QUIET_HOURS_DEFAULT_MINUTES = 20

    private const val MAX_FADE_MS = 60_000L
    private const val MIN_MINUTES = 1
    private const val MAX_MINUTES = 180

    fun start(nowMs: Long, minutes: Int): SleepTimerState {
        val m = minutes.coerceIn(MIN_MINUTES, MAX_MINUTES)
        return SleepTimerState(nowMs, m * 60_000L)
    }

    /** The last stretch that fades: a minute, or a fifth of a short timer. */
    fun fadeMs(state: SleepTimerState): Long = minOf(MAX_FADE_MS, state.durationMs / 5)

    fun remainingMs(state: SleepTimerState, nowMs: Long): Long = (state.endAtMs - nowMs).coerceAtLeast(0L)

    fun expired(state: SleepTimerState, nowMs: Long): Boolean = nowMs >= state.endAtMs

    /** Full volume, then a straight line down to zero at the end, then zero. */
    fun volumeAt(state: SleepTimerState, nowMs: Long): Float {
        val left = state.endAtMs - nowMs
        val fade = fadeMs(state)
        return when {
            left <= 0L -> 0f
            left >= fade || fade <= 0L -> 1f
            else -> (left.toDouble() / fade).toFloat().coerceIn(0f, 1f)
        }
    }

    fun tick(state: SleepTimerState, nowMs: Long): SleepTick =
        if (expired(state, nowMs)) SleepTick(0f, stop = true) else SleepTick(volumeAt(state, nowMs), stop = false)

    /** Off, then 15, 30, 45 minutes, then off again: what the one car button cycles through. */
    fun nextChoice(current: SleepTimerState?, nowMs: Long): Int? {
        if (current == null || expired(current, nowMs)) return CHOICES_MINUTES.first()
        val minutesNow = current.durationMs / 60_000L
        val i = CHOICES_MINUTES.indexOfFirst { it.toLong() == minutesNow }
        return when {
            i < 0 -> CHOICES_MINUTES.first()
            i == CHOICES_MINUTES.lastIndex -> null
            else -> CHOICES_MINUTES[i + 1]
        }
    }

    /** "20 min left", "under a minute left", or "Off". */
    fun label(state: SleepTimerState?, nowMs: Long): String {
        if (state == null || expired(state, nowMs)) return "Off"
        val ms = remainingMs(state, nowMs)
        val min = (ms + 59_999L) / 60_000L
        return if (ms < 60_000L) "under a minute left" else "$min min left"
    }
}
