package com.beeboentertainment.movie.campsite.quiet

import com.beeboentertainment.movie.campsite.family.WallClock
import java.util.TimeZone

/**
 * Quiet hours: when the campsite audio (the host phone's narrator, game sounds, "play together"
 * music) should go quiet so the neighbours can sleep.
 *
 * NOT A CLAIM. This does not know your campground's rules and never says it satisfies them. The
 * copy everywhere is "Check your campground's posted quiet hours". It is a courtesy switch.
 *
 * Everything here is pure: the time is passed in (epoch millis) with the [TimeZone] to read it in,
 * so the same code is tested against a fake clock in several zones, across midnight and across a
 * daylight-saving change. It deliberately uses [Calendar] and not java.time, which needs API 26 and
 * this app supports API 24.
 *
 * A window is a pair of WALL-CLOCK minutes, "22:00 to 06:00", exactly how a campground posts them.
 * It is not "eight hours": on the night the clocks change the window is an hour shorter or longer in
 * real time, because the sign on the campground gate says 10 pm to 6 am, not eight hours.
 */
internal data class QuietSettings(
    val enabled: Boolean = false,
    /** Minutes after local midnight the quiet window opens (0..1439). */
    val startMinute: Int = 22 * 60,
    /** Minutes after local midnight it closes. Earlier than [startMinute] means it crosses midnight. */
    val endMinute: Int = 6 * 60,
) {
    fun sanitized(): QuietSettings = copy(
        startMinute = startMinute.coerceIn(0, MINUTES_PER_DAY - 1),
        endMinute = endMinute.coerceIn(0, MINUTES_PER_DAY - 1),
    )

    /** True when the window is empty (start equals end): never quiet, whatever [enabled] says. */
    val emptyWindow: Boolean get() = startMinute == endMinute

    companion object {
        const val MINUTES_PER_DAY = 24 * 60

        /** 9, 10 or 11 pm. */
        val START_PRESETS = listOf(21 * 60, 22 * 60, 23 * 60)

        /** 6 or 7 am. */
        val END_PRESETS = listOf(6 * 60, 7 * 60)
    }
}

/** Where the schedule is at one moment: quiet now or not, and when that next changes. */
internal data class QuietStatus(
    val active: Boolean,
    /** When the state flips: the window's end while [active], its next start otherwise. Epoch millis. */
    val changeAtMs: Long,
) {
    fun msUntilChange(nowMs: Long): Long = (changeAtMs - nowMs).coerceAtLeast(0L)
}

internal object QuietHours {

    /** The host gets a heads-up this long before quiet hours begin. */
    const val WARN_MS = 15 * 60_000L

    /** Wall-clock minutes after midnight at [nowMs] in [zone]. */
    fun minuteOfDay(nowMs: Long, zone: TimeZone): Int = WallClock.minuteOfDay(nowMs, zone)

    /** Whether [minute] falls in the window, handling windows that cross midnight. */
    fun inWindow(minute: Int, startMinute: Int, endMinute: Int): Boolean = when {
        startMinute == endMinute -> false
        startMinute < endMinute -> minute in startMinute until endMinute
        else -> minute >= startMinute || minute < endMinute
    }

    /** Whether it is quiet at [nowMs]. Always false when the host has not turned quiet hours on. */
    fun isQuiet(settings: QuietSettings, nowMs: Long, zone: TimeZone): Boolean =
        settings.enabled && inWindow(minuteOfDay(nowMs, zone), settings.startMinute, settings.endMinute)

    /** See [WallClock.nextOccurrence]: the next time the wall clock reads [minute], daylight saving handled. */
    fun nextOccurrence(minute: Int, afterMs: Long, zone: TimeZone): Long = WallClock.nextOccurrence(minute, afterMs, zone)

    /** See [WallClock.previousOccurrence]. */
    fun previousOccurrence(minute: Int, atOrBeforeMs: Long, zone: TimeZone): Long = WallClock.previousOccurrence(minute, atOrBeforeMs, zone)

    /** Null when quiet hours are off or the window is empty. */
    fun status(settings: QuietSettings, nowMs: Long, zone: TimeZone): QuietStatus? {
        if (!settings.enabled || settings.emptyWindow) return null
        val quiet = isQuiet(settings, nowMs, zone)
        val edge = if (quiet) settings.endMinute else settings.startMinute
        return QuietStatus(quiet, nextOccurrence(edge, nowMs, zone))
    }

    /**
     * The start of the window the host should be warned about, or null. Non-null exactly once per
     * window: within [WARN_MS] before it opens, and not already warned about ([lastWarnedStartMs]).
     */
    fun warningDue(settings: QuietSettings, nowMs: Long, zone: TimeZone, lastWarnedStartMs: Long): Long? {
        val s = status(settings, nowMs, zone) ?: return null
        if (s.active) return null
        val until = s.msUntilChange(nowMs)
        return if (until in 1..WARN_MS && s.changeAtMs != lastWarnedStartMs) s.changeAtMs else null
    }

    /** "10:00 PM". */
    fun clockText(minute: Int): String = WallClock.clockText(minute)

    fun windowText(settings: QuietSettings): String =
        clockText(settings.startMinute) + " to " + clockText(settings.endMinute)

    /** "12 min", "1 hour 5 min": for the host's "quiet hours start in..." line. */
    fun durationText(ms: Long): String = WallClock.durationText(ms)

    /**
     * Whether to ask the host, once, if they want quiet hours: they have never been asked, quiet
     * hours are off, and the session starts in the evening or the small hours (from 8 pm to 5 am).
     */
    fun shouldPrompt(settings: QuietSettings, alreadyAsked: Boolean, nowMs: Long, zone: TimeZone): Boolean {
        if (alreadyAsked || settings.enabled) return false
        val minute = minuteOfDay(nowMs, zone)
        return minute >= 20 * 60 || minute < 5 * 60
    }

    /** The one banner line every guest page shows. Says nothing about rules, health or sleep. */
    fun bannerText(active: Boolean, headphones: Boolean, endText: String): String = when {
        active && headphones -> "Quiet hours until $endText. Headphones only, please."
        active -> "Quiet hours until $endText. Please keep the sound down."
        else -> ""
    }
}

/** What "play together" is allowed to do in quiet hours. Pure, so the rule is tested without a phone. */
internal enum class MusicDecision { ALLOW, ALLOW_WITH_HEADPHONES, REFUSE }

internal object QuietMusicPolicy {
    /**
     * Outside quiet hours, anything goes. Inside them the phones must not play out loud for the
     * whole camp: the host may only start it after confirming everyone is on headphones.
     */
    fun decide(quiet: Boolean, headphonesConfirmed: Boolean): MusicDecision = when {
        !quiet -> MusicDecision.ALLOW
        headphonesConfirmed -> MusicDecision.ALLOW_WITH_HEADPHONES
        else -> MusicDecision.REFUSE
    }

    const val REFUSED_MESSAGE =
        "Quiet hours are on. Tap Play with headphones once everyone has headphones in. Check your campground's posted quiet hours."
}

/**
 * Nights quiet hours were kept, for "Quiet hours kept: 3 nights" in the recap and the Quiet Hero
 * badge. A night counts when quiet hours were on and Campsite was running while the window was open.
 * Stored as the epoch millis of the window's start, at most [MAX] of them.
 */
internal object QuietNights {
    const val MAX = 60

    fun add(nights: List<Long>, windowStartMs: Long): List<Long> =
        if (windowStartMs <= 0L || windowStartMs in nights) nights else (nights + windowStartMs).takeLast(MAX)

    /** Nights whose window opened between [fromMs] and [toMs] (0 for an open end). */
    fun inRange(nights: List<Long>, fromMs: Long, toMs: Long): Int =
        nights.count { it >= fromMs && (toMs <= 0L || it <= toMs) }
}
