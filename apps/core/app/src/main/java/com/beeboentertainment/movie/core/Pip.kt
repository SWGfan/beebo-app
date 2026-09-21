package com.beeboentertainment.movie.core

/**
 * Picture-in-Picture eligibility and sizing.
 *
 * Kept pure so the rules can be asserted without a device: PiP only exists from API 26, only on
 * hardware that declares the feature, and never while a Chromecast owns playback (the video is
 * already on the TV — a thumbnail on the phone would be pointless and would fight the cast
 * session for the player).
 */
object PipPolicy {

    /** PiP arrived in Android 8.0. */
    const val MIN_SDK = 26

    /** Android rejects PictureInPictureParams outside this range and throws. */
    const val MIN_ASPECT = 0.4184
    const val MAX_ASPECT = 2.39

    /** Default when the video size isn't known yet. */
    const val DEFAULT_WIDTH = 16
    const val DEFAULT_HEIGHT = 9

    /**
     * Is PiP possible at all on this device? [hasFeature] comes from
     * PackageManager.FEATURE_PICTURE_IN_PICTURE — the button is hidden rather than shown dead.
     */
    fun isSupported(sdkInt: Int, hasFeature: Boolean): Boolean = sdkInt >= MIN_SDK && hasFeature

    /**
     * Should the PiP button be offered right now?
     * Hidden while casting, and once the Activity is on its way out.
     */
    fun canOfferPip(supported: Boolean, isCasting: Boolean, isFinishing: Boolean): Boolean =
        supported && !isCasting && !isFinishing

    /**
     * Should pressing Home drop us into PiP automatically?
     *
     * Only when something is actually playing — leaving a paused player should just leave. This
     * composes with the "keep playing with the screen off" toggle rather than competing with it:
     * PiP covers leaving the app, background audio covers the screen going off, and if the screen
     * locks while in PiP the ordinary background-playback rules still decide what happens.
     */
    fun shouldAutoEnterOnLeave(
        supported: Boolean,
        isPlaying: Boolean,
        isCasting: Boolean,
        isFinishing: Boolean,
        alreadyInPip: Boolean
    ): Boolean = supported && isPlaying && !isCasting && !isFinishing && !alreadyInPip

    /**
     * Aspect ratio for the PiP window, clamped into the range Android accepts.
     * Falls back to 16:9 for nonsense input rather than letting the system throw.
     */
    fun aspectRatio(videoWidth: Int, videoHeight: Int): Pair<Int, Int> {
        if (videoWidth <= 0 || videoHeight <= 0) return DEFAULT_WIDTH to DEFAULT_HEIGHT
        val ratio = videoWidth.toDouble() / videoHeight.toDouble()
        return when {
            ratio < MIN_ASPECT -> 1 to 2          // ~0.5, safely inside the lower bound
            ratio > MAX_ASPECT -> 239 to 100      // exactly the upper bound
            else -> videoWidth to videoHeight
        }
    }

    /**
     * Which remote actions fit in the PiP window.
     *
     * Android caps this at getMaxNumPictureInPictureActions() — normally 3, which is exactly
     * previous / play-pause / next. On a device that allows fewer, play-pause is the one that
     * must survive, so the list degrades from the outside in rather than being truncated blindly.
     */
    enum class PipAction { PREVIOUS, PLAY_PAUSE, NEXT }

    fun actionsFor(maxActions: Int): List<PipAction> = when {
        maxActions <= 0 -> emptyList()
        maxActions == 1 -> listOf(PipAction.PLAY_PAUSE)
        maxActions == 2 -> listOf(PipAction.PREVIOUS, PipAction.PLAY_PAUSE)
        else -> listOf(PipAction.PREVIOUS, PipAction.PLAY_PAUSE, PipAction.NEXT)
    }

    /** True when the given ratio would be accepted as-is. */
    fun isAcceptableAspect(videoWidth: Int, videoHeight: Int): Boolean {
        if (videoWidth <= 0 || videoHeight <= 0) return false
        val ratio = videoWidth.toDouble() / videoHeight.toDouble()
        return ratio in MIN_ASPECT..MAX_ASPECT
    }
}
