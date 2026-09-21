package com.beeboentertainment.movie.campsite.family

import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * Wall-clock arithmetic for quiet hours and the trip clock, in one place so both agree.
 *
 * It uses [Calendar] on purpose: java.time needs API 26 and this app supports API 24. Everything
 * takes the instant (epoch millis) and the [TimeZone] to read it in, so a test can run the same code
 * against several zones and across a daylight-saving change with a fake clock.
 *
 * THE RULE THAT MAKES DST EASY: durations are always differences between instants (epoch millis),
 * never "hours on a clock". A wall-clock time ("4:30 pm") is only used to PICK an instant, once, when
 * the parent types it. From then on everything is millis, which no clock change can bend.
 */
internal object WallClock {

    /** Wall-clock minutes after midnight at [nowMs] in [zone]. */
    fun minuteOfDay(nowMs: Long, zone: TimeZone): Int {
        val cal = Calendar.getInstance(zone).apply { timeInMillis = nowMs }
        return cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
    }

    /**
     * The first instant strictly after [afterMs] at which the wall clock in [zone] reads [minute]
     * (minutes after midnight). In a daylight-saving gap (the hour that does not exist) the calendar
     * moves it forward, so a 02:30 edge on spring-forward night lands at 03:30 instead of vanishing.
     */
    fun nextOccurrence(minute: Int, afterMs: Long, zone: TimeZone): Long {
        val cal = Calendar.getInstance(zone).apply { timeInMillis = afterMs }
        repeat(4) {
            setMinute(cal, minute)
            if (cal.timeInMillis > afterMs) return cal.timeInMillis
            cal.add(Calendar.DAY_OF_MONTH, 1)
        }
        // A day always passes in four steps; this only keeps the caller moving.
        return afterMs + DAY_MS
    }

    /** The latest instant at or before [atOrBeforeMs] at which the wall clock in [zone] read [minute]. */
    fun previousOccurrence(minute: Int, atOrBeforeMs: Long, zone: TimeZone): Long {
        val cal = Calendar.getInstance(zone).apply { timeInMillis = atOrBeforeMs }
        repeat(4) {
            setMinute(cal, minute)
            if (cal.timeInMillis <= atOrBeforeMs) return cal.timeInMillis
            cal.add(Calendar.DAY_OF_MONTH, -1)
        }
        return atOrBeforeMs - DAY_MS
    }

    private fun setMinute(cal: Calendar, minute: Int) {
        cal.set(Calendar.HOUR_OF_DAY, minute / 60)
        cal.set(Calendar.MINUTE, minute % 60)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
    }

    /** "4:30 PM" in [zone]. Formatted by hand so a test never depends on a locale's 12/24 hour habit. */
    fun clockText(atMs: Long, zone: TimeZone): String = clockText(minuteOfDay(atMs, zone))

    fun clockText(minute: Int): String {
        val h24 = (minute / 60).coerceIn(0, 23)
        val m = (minute % 60).coerceIn(0, 59)
        val h12 = when (val h = h24 % 12) { 0 -> 12; else -> h }
        return String.format(Locale.US, "%d:%02d %s", h12, m, if (h24 < 12) "AM" else "PM")
    }

    /** "12 min", "1 hour 5 min", "2 hours". Rounds up to the next whole minute. */
    fun durationText(ms: Long): String {
        val totalMin = ((ms + 59_999L) / 60_000L).coerceAtLeast(0L)
        val h = totalMin / 60
        val m = totalMin % 60
        return when {
            h == 0L -> "$m min"
            m == 0L -> if (h == 1L) "1 hour" else "$h hours"
            else -> (if (h == 1L) "1 hour " else "$h hours ") + "$m min"
        }
    }

    const val DAY_MS = 24 * 3_600_000L
}
