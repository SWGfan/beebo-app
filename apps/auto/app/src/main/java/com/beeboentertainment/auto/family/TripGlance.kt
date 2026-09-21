package com.beeboentertainment.auto.family

import com.beeboentertainment.movie.campsite.family.WallClock
import com.beeboentertainment.movie.campsite.tripclock.TripClockLogic
import com.beeboentertainment.movie.campsite.tripclock.TripClockState
import com.beeboentertainment.movie.campsite.tripclock.TripClockView
import java.util.TimeZone

/**
 * The Trip Clock as a glance: one short line a back-seat rider can understand, for the car's media
 * list, plus the words the phone speaks if someone taps it.
 *
 * READ-ONLY, ESTIMATE ONLY. The time comes from the same [TripClockLogic] the phone app uses (synced
 * into this build, see build.gradle.kts), so the car and the phone cannot disagree about how long is
 * left. Nothing here knows about roads, traffic or a map. The estimate line is always present, using
 * the phone app's own wording: [TripClockView.DISCLAIMER].
 *
 * The title is kept to a few words on purpose: it is what a passenger reads at a glance, and it is
 * all a driver ever needs to hear.
 */
enum class GlanceUnit(val wire: String, val label: String, val unitMs: Long) {
    MOVIES("movies", "movies", 100 * 60_000L),
    EPISODES("episodes", "TV episodes", 22 * 60_000L),
    SONGS("songs", "songs", 210_000L),
    NONE("none", "just the time", 0L),
    ;

    companion object {
        /** Older or unknown values read as movies, the friendliest unit for a long drive. */
        fun fromWire(text: String?): GlanceUnit = entries.firstOrNull { it.wire == text } ?: MOVIES
    }
}

data class Glance(
    /** "About 3 more movies". */
    val title: String,
    /** The estimate-only line. Always present. */
    val subtitle: String,
    /** What is spoken when the item is played. */
    val spoken: String,
    val running: Boolean,
)

internal object TripGlance {

    const val DISCLAIMER = TripClockView.DISCLAIMER
    const val PASSENGERS = TripClockView.PASSENGERS

    /** The unit and phrase for the time left. Fuzzy on purpose: "a few", not a false precision. */
    fun kidPhrase(remainingMs: Long, unit: GlanceUnit): String {
        if (remainingMs <= 0L) return "You're here!"
        if (remainingMs < 5 * 60_000L) return "Almost there!"
        if (unit == GlanceUnit.NONE || unit.unitMs <= 0L) return "About ${WallClock.durationText(remainingMs)} to go"
        val n = Math.round(remainingMs.toDouble() / unit.unitMs).toInt()
        return when (unit) {
            GlanceUnit.MOVIES -> when {
                n <= 0 -> "Less than a movie to go"
                n == 1 -> "About 1 more movie"
                n <= 9 -> "About $n more movies"
                else -> "Lots more movies"
            }
            GlanceUnit.EPISODES -> when {
                n <= 0 -> "Less than an episode to go"
                n == 1 -> "About 1 more episode"
                n <= 12 -> "About $n more episodes"
                else -> "Lots more episodes"
            }
            GlanceUnit.SONGS -> when {
                n <= 1 -> "Just 1 more song"
                n <= 5 -> "A few more songs"
                n <= 12 -> "A bunch more songs"
                else -> "Lots more songs"
            }
            GlanceUnit.NONE -> ""
        }
    }

    fun glance(state: TripClockState, nowMs: Long, zone: TimeZone): Glance {
        val view = TripClockLogic.view(state, nowMs, zone)
        if (!view.running) {
            return Glance(
                title = "Trip Clock is not running",
                subtitle = "Set it on the phone when parked",
                spoken = "The trip clock is not running. A parent can set it on the phone when the car is parked. $DISCLAIMER",
                running = false,
            )
        }
        if (view.arrived) {
            return Glance("You're here!", DISCLAIMER, "You're here! $DISCLAIMER", running = true)
        }
        if (view.late) {
            // Past the estimate and not arrived: never say "you're here". The parent can tap +15 on the phone.
            val words = "It is taking a little longer than planned."
            return Glance("A little longer than planned", DISCLAIMER, "$words $DISCLAIMER", running = true)
        }
        val unit = GlanceUnit.fromWire(state.kidUnit)
        val kid = kidPhrase(view.remainingMs, unit)
        val spoken = if (unit == GlanceUnit.NONE) "$kid. $DISCLAIMER"
        else "$kid. That is about ${view.leftText}. $DISCLAIMER"
        return Glance(title = kid, subtitle = DISCLAIMER, spoken = spoken, running = true)
    }

    /**
     * The plain-time helper the phone screen uses for the big countdown ("1 hour 10 min"). Same
     * rounding as the phone app's Trip Clock.
     */
    fun timeLeftText(state: TripClockState, nowMs: Long, zone: TimeZone): String =
        TripClockLogic.view(state, nowMs, zone).leftText
}
