package com.beeboentertainment.auto.family

import com.beeboentertainment.auto.drive.VideoGate

/**
 * The one rule that decides what the Family Fun features may do right now: parked or driving,
 * quiet hours or not, and whether a parent switched hands-free games on.
 *
 * Built on [VideoGate], the rule the picture features already use, so "is this device in a moving
 * car" has exactly one answer in the app. Pure and platform-free, so it is unit-tested on the JVM.
 *
 * THE PRINCIPLES
 *  1. The car screen is never a control surface for a game. Nothing here needs a tap, a read or a
 *     glance while driving. The only controls are the car's own media buttons (Play/Pause, Next).
 *  2. Taps on this app's own screen (a point, a "Next round" button, setting the Trip Clock) need
 *     [VideoGate] to say it is safe: a parked car (Android Automotive) or a phone that is NOT
 *     projecting to Android Auto and whose user said "I'm a passenger".
 *  3. A voice game may start at all only if either taps are allowed (a parked or passenger device)
 *     or a parent switched on hands-free games in the car. Off by default.
 *  4. Quiet hours: no voice games (they are meant to be shouted along with). Stories still play,
 *     calmer and with a sleep timer.
 *  5. The Trip Clock glance and the stories are audio the car may play like any audiobook.
 */
object FamilyGate {

    enum class Feature { TRIP_CLOCK, STORIES, VOICE_GAMES }

    /** Where the request comes from. The car's own media browser never gets taps. */
    enum class Surface { CAR_MEDIA_BROWSER, THIS_APP_SCREEN }

    enum class Reason {
        NONE,
        QUIET_HOURS,
        GAMES_NEED_PARENT_OK,
    }

    data class Inputs(
        val surface: Surface,
        /** Live drive signals. Only meaningful for [Surface.THIS_APP_SCREEN]. */
        val signals: VideoGate.Signals,
        /** Quiet hours are on and it is inside the window. */
        val quiet: Boolean,
        /** The parent switched on "voice games in the car, hands-free". Default off. */
        val handsFreeGamesOk: Boolean,
    )

    data class Decision(
        /** The audio may play. */
        val listen: Boolean,
        /** This app's own buttons (points, next round, editing the clock) may be used. */
        val tap: Boolean,
        /** Play calmly: slower voice, and a sleep timer by default. */
        val calm: Boolean,
        val reason: Reason,
        /** A sentence for the phone or for a note row in the car, or null when nothing is blocked. */
        val message: String?,
    )

    /** Whether this app's own buttons are safe to use. Never true from the car's media browser. */
    fun tapAllowed(surface: Surface, signals: VideoGate.Signals): Boolean =
        surface == Surface.THIS_APP_SCREEN && VideoGate.decide(signals) == VideoGate.Block.NONE

    fun decide(feature: Feature, i: Inputs): Decision {
        val tap = tapAllowed(i.surface, i.signals)
        return when (feature) {
            Feature.TRIP_CLOCK -> Decision(
                listen = true, tap = tap, calm = false, reason = Reason.NONE, message = null,
            )
            Feature.STORIES -> Decision(
                listen = true, tap = tap, calm = i.quiet, reason = Reason.NONE, message = null,
            )
            Feature.VOICE_GAMES -> when {
                i.quiet -> Decision(
                    listen = false, tap = false, calm = true, reason = Reason.QUIET_HOURS,
                    message = QUIET_MESSAGE,
                )
                tap || i.handsFreeGamesOk -> Decision(
                    listen = true, tap = tap, calm = false, reason = Reason.NONE, message = null,
                )
                else -> Decision(
                    listen = false, tap = false, calm = false, reason = Reason.GAMES_NEED_PARENT_OK,
                    message = NEEDS_PARENT_MESSAGE,
                )
            }
        }
    }

    /** The same two notices, short enough to read at a glance in the car's list. */
    const val CAR_NOTE_QUIET = "Quiet hours: games are resting"
    const val CAR_NOTE_NEEDS_PARENT = "Games are off. See the phone app."

    fun carNote(reason: Reason): String = when (reason) {
        Reason.QUIET_HOURS -> CAR_NOTE_QUIET
        Reason.GAMES_NEED_PARENT_OK -> CAR_NOTE_NEEDS_PARENT
        Reason.NONE -> "Games are resting"
    }

    const val QUIET_MESSAGE ="Quiet hours. Voice games are resting. Stories are still here."

    const val NEEDS_PARENT_MESSAGE =
        "Voice games are for passengers. A parent can switch them on in the Beebo Auto app on the phone."

    /** Why a phone screen's buttons are off, in words a passenger can read once parked. */
    fun tapMessage(signals: VideoGate.Signals): String? = when (VideoGate.decide(signals)) {
        VideoGate.Block.NONE -> null
        VideoGate.Block.DRIVING ->
            "Buttons are off while the car is moving. The car's own Next and Pause buttons still work."
        VideoGate.Block.CAR_STATE_UNKNOWN ->
            "Buttons are off because the car has not said it is parked."
        VideoGate.Block.PROJECTING ->
            "This phone is running the car screen, so its buttons stay off. Use the car's Next and Pause buttons, " +
                "or a passenger's own phone."
        VideoGate.Block.NEEDS_PASSENGER_CONFIRMATION ->
            "Buttons are for passengers only. Never for the driver."
    }
}
