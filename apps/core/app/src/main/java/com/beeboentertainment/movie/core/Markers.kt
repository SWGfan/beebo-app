package com.beeboentertainment.movie.core

/**
 * Viewer-supplied skip points: "the intro ends here" and "the credits start here".
 *
 * Scope is decided by the SERVER (TV markers are show-wide, movie markers per file), so nothing
 * here computes a key — the app posts the id it is playing and reads back whatever applies.
 *
 * The server applies its guard limits on write and again on read; these are mirrored here so a
 * value the server would silently drop can be reported to the user at the moment they press the
 * button, instead of appearing to save and then quietly doing nothing.
 */
object MarkerPolicy {

    /** Grace before an advance triggered by a credits marker — a fact, so a short wait. */
    const val CREDITS_GRACE_SECONDS = 5

    /** Grace at the natural end of a file, where we are guessing rather than told. */
    const val END_OF_FILE_GRACE_SECONDS = 10

    /** With no credits marker, the card still appears this close to the end. */
    const val END_CARD_LEAD_MS = 20_000L

    /* ------------------------------ guard limits ----------------------------- */

    const val MAX_INTRO_SECONDS = 300.0          // 5 minutes
    const val MAX_INTRO_FRACTION = 0.25          // and at most a quarter of the runtime
    const val MIN_CREDITS_TAIL_SECONDS = 60.0    // must leave a minute of runtime
    const val MIN_CREDITS_FRACTION = 0.5         // and be at least halfway through

    /** Is this a legal intro marker? [durationSeconds] <= 0 means "unknown". */
    fun isValidIntro(seconds: Double?, durationSeconds: Double): Boolean {
        val s = seconds ?: return false
        if (s <= 0.0) return false
        if (s > MAX_INTRO_SECONDS) return false
        if (durationSeconds > 0.0 && s > durationSeconds * MAX_INTRO_FRACTION) return false
        return true
    }

    /**
     * Is this a legal credits marker?
     * Both duration-relative rules need a duration; without one only "> 0" can be checked on
     * write, and the player refuses to ACT on a credits marker until it knows the real duration.
     */
    fun isValidCredits(seconds: Double?, durationSeconds: Double): Boolean {
        val s = seconds ?: return false
        if (s <= 0.0) return false
        if (durationSeconds <= 0.0) return true            // writable, but not actionable yet
        if (s > durationSeconds - MIN_CREDITS_TAIL_SECONDS) return false
        if (s < durationSeconds * MIN_CREDITS_FRACTION) return false
        return true
    }

    /** Why a marker was refused, for the toast. Null when it is fine. */
    fun introRejectionReason(seconds: Double, durationSeconds: Double): String? = when {
        seconds <= 0.0 -> "You're at the very start — play a little further in first."
        seconds > MAX_INTRO_SECONDS -> "That's more than 5 minutes in — too long for an intro."
        durationSeconds > 0.0 && seconds > durationSeconds * MAX_INTRO_FRACTION ->
            "That's more than a quarter of the way in — too long for an intro."
        else -> null
    }

    fun creditsRejectionReason(seconds: Double, durationSeconds: Double): String? = when {
        seconds <= 0.0 -> "You're at the very start."
        durationSeconds <= 0.0 -> null
        seconds < durationSeconds * MIN_CREDITS_FRACTION ->
            "That's less than halfway through — too early for credits."
        seconds > durationSeconds - MIN_CREDITS_TAIL_SECONDS ->
            "That's within the last minute — too late to be useful."
        else -> null
    }

    /* ------------------------------- intro skip ------------------------------ */

    /**
     * Should we jump past the intro on load?
     *
     * Only when the marker is valid AND the viewer has not asked for a specific position — an
     * explicit resume position, or answering the Resume prompt, both mean "put me where I said",
     * and silently moving them somewhere else would be worse than showing the intro.
     */
    fun shouldSkipIntro(
        introEndSeconds: Double?,
        durationSeconds: Double,
        startPositionMs: Long,
        viewerChosePosition: Boolean
    ): Boolean {
        if (viewerChosePosition) return false
        if (!isValidIntro(introEndSeconds, durationSeconds)) return false
        val introEndMs = ((introEndSeconds ?: 0.0) * 1000.0).toLong()
        // already past it (or starting there) — nothing to skip
        return startPositionMs < introEndMs
    }

    fun introEndMs(introEndSeconds: Double?): Long = ((introEndSeconds ?: 0.0) * 1000.0).toLong()

    /* ---------------------------- credits advance ---------------------------- */

    /** Position at which the credits card should appear, or null when it should not. */
    fun creditsTriggerMs(creditsStartSeconds: Double?, durationMs: Long): Long? {
        val durationSeconds = durationMs / 1000.0
        if (!isValidCredits(creditsStartSeconds, durationSeconds)) return null
        if (durationMs <= 0L) return null   // not actionable until the real length is known
        return ((creditsStartSeconds ?: 0.0) * 1000.0).toLong()
    }

    /**
     * Has playback reached the point where the "up next" card should come up?
     * Either the credits marker, or — with no marker — the last [END_CARD_LEAD_MS] of the file.
     */
    fun shouldShowUpNextCard(
        positionMs: Long,
        durationMs: Long,
        creditsStartSeconds: Double?,
        cancelled: Boolean
    ): Boolean {
        if (cancelled) return false
        if (positionMs <= 0L || durationMs <= 0L) return false
        creditsTriggerMs(creditsStartSeconds, durationMs)?.let { return positionMs >= it }
        return positionMs >= durationMs - END_CARD_LEAD_MS
    }

    /** A marker is a fact, the natural end is a guess — so the marker gets the shorter grace. */
    fun graceSecondsFor(hasCreditsMarker: Boolean): Int =
        if (hasCreditsMarker) CREDITS_GRACE_SECONDS else END_OF_FILE_GRACE_SECONDS

    fun countdownLabel(secondsRemaining: Int, hasCreditsMarker: Boolean): String =
        if (hasCreditsMarker) "Credits — playing now in ${secondsRemaining}s…"
        else "Playing in ${secondsRemaining}s…"

    /**
     * Cancelling stops the advance for the WHOLE of this playback, including the one that would
     * otherwise fire at the natural end of the file.
     */
    fun advanceAllowed(cancelledForThisPlayback: Boolean): Boolean = !cancelledForThisPlayback

    /** Markers and auto-advance are off in surf mode, which has its own Next. */
    fun markersEnabled(surfMode: Boolean): Boolean = !surfMode
}
