package com.beeboentertainment.movie.music

/**
 * The Music player's sleep timer: stop playback after a chosen number of minutes, or at the end
 * of whichever track happens to be playing when it fires. Plex has this natively; most Jellyfin
 * apps don't. Beebo didn't either — this is new.
 *
 * Pure and free of Android, like [MusicQueueLogic] next to it, so the countdown and the
 * "has it fired yet" decision can be unit tested without a Handler or a real clock. Every
 * function here takes the current time as a parameter rather than reading one itself; [MusicPlayer]
 * is the one place that calls android.os.SystemClock.elapsedRealtime() and owns the Handler that
 * ticks this once a second.
 */
sealed class MusicSleepTimerState {
    object Off : MusicSleepTimerState()

    /** Stops playback once [endAtElapsedMs] (an elapsedRealtime-style clock reading) is reached. */
    data class Countdown(val endAtElapsedMs: Long) : MusicSleepTimerState()

    /** Stops playback the next time the current track ends, whichever track that turns out to be. */
    object EndOfTrack : MusicSleepTimerState()
}

object MusicSleepTimer {

    /** Duration choices offered in the sheet, in the order they are shown. */
    val DURATIONS_MINUTES = listOf(15, 30, 45, 60)

    fun start(minutes: Int, nowElapsedMs: Long): MusicSleepTimerState.Countdown =
        MusicSleepTimerState.Countdown(nowElapsedMs + minutes * 60_000L)

    /** Time left, floored at zero rather than going negative once it is due. */
    fun remainingMs(state: MusicSleepTimerState, nowElapsedMs: Long): Long = when (state) {
        is MusicSleepTimerState.Countdown -> (state.endAtElapsedMs - nowElapsedMs).coerceAtLeast(0L)
        else -> 0L
    }

    /** Is a countdown due to fire right now? EndOfTrack is decided separately, by [stopsAtTrackEnd]. */
    fun hasElapsed(state: MusicSleepTimerState, nowElapsedMs: Long): Boolean =
        state is MusicSleepTimerState.Countdown && nowElapsedMs >= state.endAtElapsedMs

    /** Does the track that just finished mean "stop here" rather than "play the next one"? */
    fun stopsAtTrackEnd(state: MusicSleepTimerState): Boolean = state is MusicSleepTimerState.EndOfTrack

    /**
     * What the Now Playing screen shows while the timer is armed, or null when it is off. Kept
     * short enough to sit next to the other transport buttons: "Sleep · 14:32" / "Sleep · end of track".
     */
    fun label(state: MusicSleepTimerState, nowElapsedMs: Long): String? = when (state) {
        MusicSleepTimerState.Off -> null
        MusicSleepTimerState.EndOfTrack -> "Sleep · end of track"
        is MusicSleepTimerState.Countdown -> "Sleep · " + formatCountdown(remainingMs(state, nowElapsedMs))
    }

    /** "14:32", "0:45" — rounded up so it doesn't touch 0:00 a beat before it actually fires. */
    private fun formatCountdown(ms: Long): String {
        val totalSec = (ms + 999) / 1000
        val m = totalSec / 60
        val s = totalSec % 60
        return "%d:%02d".format(m, s)
    }
}
