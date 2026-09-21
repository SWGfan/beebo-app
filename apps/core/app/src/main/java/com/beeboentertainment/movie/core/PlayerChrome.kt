package com.beeboentertainment.movie.core

/**
 * When the player's custom chrome (top bar, surf row) should be on screen.
 *
 * The bug this fixes: those overlays were plain siblings of the PlayerView with a fixed
 * visibility, so nothing ever took them away — they sat on top of the film forever.
 *
 * The fix is to give them ONE owner. Media3's PlayerView already runs a correct show/hide
 * controller (it keeps controls up while paused, buffering, idle or ended, and auto-hides only
 * while actually playing), so the chrome simply follows that controller's visibility instead of
 * running a second timer that would drift out of step with the native transport controls.
 *
 * The website hit exactly that second-timer trap: a single hide timer armed at load expired while
 * the video was still buffering, and nothing re-armed it once playback began. Delegating the
 * clock to PlayerView avoids it by construction, and [ChromeVisibilityModel] re-states the rules
 * so they can be asserted headlessly.
 */
object PlayerChromePolicy {

    /** Matches the owner's request: about three seconds of no touch. */
    const val HIDE_TIMEOUT_MS = 3_000L

    /**
     * The final decision for the custom overlays.
     *
     * The up-next card is deliberately exempt — it carries a countdown the viewer has to see and
     * act on — and while it is up the rest of the chrome stays with it rather than fading out
     * from under it.
     */
    fun shouldShowChrome(
        controllerVisible: Boolean,
        upNextShowing: Boolean,
        inPictureInPicture: Boolean = false
    ): Boolean {
        // A PiP window is a couple of centimetres across. Any overlay makes it useless, so
        // everything goes — including the up-next card, which is otherwise exempt.
        if (inPictureInPicture) return false
        return upNextShowing || controllerVisible
    }

    /**
     * Should a hide be scheduled at all? Only while genuinely playing: paused, buffering, idle
     * and ended all keep the controls up, so the user is never left hunting for them.
     */
    fun shouldScheduleHide(
        isPlaying: Boolean,
        upNextShowing: Boolean,
        inPictureInPicture: Boolean = false
    ): Boolean =
        // Nothing to hide in PiP — it is already hidden — so nothing needs scheduling either.
        isPlaying && !upNextShowing && !inPictureInPicture

    /**
     * The chrome's touch hook only ever OBSERVES a touch to re-arm the countdown — it must never
     * consume one. Consuming would swallow a drag on the scrub bar, which is the same class of
     * bug as an overlay sitting on top of it. Always false, and asserted in the tests.
     */
    fun shouldConsumeTouch(): Boolean = false

    /**
     * Should a touch re-arm the hide countdown? Only when the controls are already up: when they
     * are hidden, PlayerView's own tap-to-show handles it on ACTION_UP, and showing here too
     * would immediately be toggled back off.
     */
    fun shouldRearmOnTouch(controllerAlreadyVisible: Boolean): Boolean = controllerAlreadyVisible

    /** Delay before hiding, or null when the chrome should stay up indefinitely. */
    fun hideDelayMs(isPlaying: Boolean, upNextShowing: Boolean): Long? =
        if (shouldScheduleHide(isPlaying, upNextShowing)) HIDE_TIMEOUT_MS else null
}

/**
 * A clock-driven model of the same rules, used by PlayerActivity to hold the state that
 * PlayerView cannot know about (whether the up-next card is up) and to decide the final
 * visibility. PlayerView still owns the real countdown; this owns the exemptions.
 *
 * Written against an injected clock so the whole timeline is unit-testable with no device.
 */
class ChromeVisibilityModel(private val nowMs: () -> Long = { System.currentTimeMillis() }) {

    var isPlaying: Boolean = false
        private set
    var upNextShowing: Boolean = false
        private set

    /** While true the chrome is unconditionally hidden. */
    var inPictureInPicture: Boolean = false
        private set

    /** What PlayerView's controller last reported. */
    var controllerVisible: Boolean = true
        private set

    /** When the countdown was last (re-)armed; null when nothing is scheduled. */
    var hideArmedAt: Long? = null
        private set

    /** The chrome's current visibility under the full rule set. */
    val chromeVisible: Boolean
        get() = PlayerChromePolicy.shouldShowChrome(controllerVisible, upNextShowing, inPictureInPicture)

    /** True when a hide is pending. */
    val hidePending: Boolean get() = hideArmedAt != null

    /** Milliseconds until the chrome hides, or null when it will stay up. */
    fun msUntilHide(): Long? {
        val armed = hideArmedAt ?: return null
        return (armed + PlayerChromePolicy.HIDE_TIMEOUT_MS - nowMs()).coerceAtLeast(0L)
    }

    /** Any touch anywhere brings everything back and restarts the countdown. */
    fun onTouch() {
        controllerVisible = true
        rearm()
    }

    /**
     * Playback started, stopped or paused.
     * Starting re-arms the countdown — this is the trap the website hit, where the timer was only
     * ever armed once at load and never again after buffering finished.
     */
    fun onIsPlayingChanged(playing: Boolean) {
        isPlaying = playing
        if (!playing) {
            // Paused / buffering / ended: bring the chrome back and stop any pending hide.
            controllerVisible = true
            hideArmedAt = null
        } else {
            rearm()
        }
    }

    /** The up-next card appeared or was dismissed. */
    fun onUpNextChanged(showing: Boolean) {
        upNextShowing = showing
        if (showing) {
            controllerVisible = true
            hideArmedAt = null      // never fade out from under a live countdown
        } else {
            rearm()
        }
    }

    /**
     * Entered or left Picture-in-Picture.
     * Leaving restores whatever the ordinary rules say, with a fresh countdown if playing.
     */
    fun onPipChanged(inPip: Boolean) {
        inPictureInPicture = inPip
        if (inPip) {
            hideArmedAt = null
        } else {
            controllerVisible = true
            rearm()
        }
    }

    /** PlayerView told us its controller shown/hidden. */
    fun onControllerVisibilityChanged(visible: Boolean) {
        controllerVisible = visible
        if (visible) rearm() else hideArmedAt = null
    }

    /** Advance the model to the point where a scheduled hide has fired. */
    fun onHideTimerFired() {
        if (!PlayerChromePolicy.shouldScheduleHide(isPlaying, upNextShowing, inPictureInPicture)) {
            // Conditions changed since it was armed (paused, or up next appeared) — ignore it.
            hideArmedAt = null
            return
        }
        controllerVisible = false
        hideArmedAt = null
    }

    private fun rearm() {
        hideArmedAt =
            if (PlayerChromePolicy.shouldScheduleHide(isPlaying, upNextShowing, inPictureInPicture)) nowMs()
            else null
    }
}
