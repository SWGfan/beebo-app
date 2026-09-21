package com.beeboentertainment.movie.campsite.quiet

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.campsite.family.SharedPrefsFamilyStorage
import java.util.TimeZone

/** What the guest pages and the host screen are told about quiet hours right now. */
internal data class QuietView(
    val enabled: Boolean,
    val active: Boolean,
    /** Music is allowed to play in quiet hours only because the host confirmed headphones. */
    val headphones: Boolean,
    /** When the state next flips, epoch millis (0 when quiet hours are off). */
    val changeAtMs: Long,
    /** "6:00 AM" while [active], else "". */
    val endText: String,
    /** Milliseconds until quiet hours begin, or -1 when they are not about to. */
    val startsInMs: Long,
    val windowText: String,
) {
    val bannerText: String get() = QuietHours.bannerText(active, headphones, endText)
}

/**
 * The live side of quiet hours: reads the saved settings, the clock and the zone, and answers "is it
 * quiet now". One instance per process in the app ([QuietGate]); tests build their own with a fake
 * clock and [com.beeboentertainment.movie.campsite.family.MemoryFamilyStorage].
 */
internal class QuietRuntime(
    val store: QuietHoursStore,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val zone: () -> TimeZone = { TimeZone.getDefault() },
) {
    /** The host confirmed everybody has headphones, so "play together" may run in quiet hours. */
    @Volatile var headphonesConfirmed: Boolean = false

    fun isQuiet(): Boolean = QuietHours.isQuiet(store.settings(), nowMs(), zone())

    fun view(): QuietView {
        val s = store.settings()
        val now = nowMs()
        val tz = zone()
        val st = QuietHours.status(s, now, tz)
        val active = st?.active == true
        // Headphones-only is an answer to one quiet period. It does not carry to the next night.
        if (!active) headphonesConfirmed = false
        return QuietView(
            enabled = s.enabled,
            active = active,
            headphones = active && headphonesConfirmed,
            changeAtMs = st?.changeAtMs ?: 0L,
            endText = if (active) QuietHours.clockText(s.endMinute) else "",
            startsInMs = if (st != null && !st.active) st.msUntilChange(now) else -1L,
            windowText = QuietHours.windowText(s),
        )
    }

    fun musicDecision(): MusicDecision = QuietMusicPolicy.decide(isQuiet(), headphonesConfirmed)

    /** Whether the host's evening prompt should be shown now. */
    fun shouldPrompt(): Boolean = QuietHours.shouldPrompt(store.settings(), store.alreadyAsked(), nowMs(), zone())

    /** Turn quiet hours on with the given window (from the prompt or the settings card). */
    fun turnOn(startMinute: Int, endMinute: Int) {
        store.save(QuietSettings(true, startMinute, endMinute))
        store.markAsked()
    }

    /** What one look at the clock found: a warning to show, and whether tonight counts as kept. */
    data class Tick(val warnStartMs: Long?, val nightKept: Boolean)

    /**
     * Called about every 30 seconds while Campsite is running. Returns the start of a window the host
     * should be warned about (once per window), and records the night as kept when it is quiet and a
     * session is running.
     */
    fun tick(serverRunning: Boolean): Tick {
        val s = store.settings()
        val now = nowMs()
        val tz = zone()
        val warn = QuietHours.warningDue(s, now, tz, store.lastWarnedStart())
        if (warn != null) store.setLastWarnedStart(warn)
        var kept = false
        if (serverRunning && QuietHours.isQuiet(s, now, tz)) {
            val start = QuietHours.previousOccurrence(s.startMinute, now, tz)
            if (start !in store.nights()) { store.addNight(start); kept = true }
        }
        return Tick(warn, kept)
    }
}

/** The app's one [QuietRuntime]. Anything that must go quiet asks here; a failure to ask means "not quiet". */
internal object QuietGate {
    val runtime: QuietRuntime by lazy {
        QuietRuntime(QuietHoursStore(SharedPrefsFamilyStorage(BeeboApp.instance.session.plain)))
    }

    /** Safe to call from anywhere, including a WebView bridge thread. */
    fun isQuietNow(): Boolean = runCatching { runtime.isQuiet() }.getOrDefault(false)
}
