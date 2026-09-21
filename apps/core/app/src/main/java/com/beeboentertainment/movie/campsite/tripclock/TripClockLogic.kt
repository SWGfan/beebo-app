package com.beeboentertainment.movie.campsite.tripclock

import com.beeboentertainment.movie.campsite.family.WallClock
import kotlinx.serialization.Serializable
import java.util.TimeZone

/**
 * The Trip Clock: an answer to "are we there yet?" that a child can read.
 *
 * NOT NAVIGATION. It knows nothing about roads, traffic or routes. The parent types (or taps) when
 * they left and when they expect to arrive, and can push the arrival back with "+15 min" when
 * traffic happens. Everything it shows is "estimate only". It never claims to be a safety product,
 * never uses an ETA from a maps or traffic service, and never tells a driver anything: it is for
 * the passengers.
 *
 * NO LOCATION IN HERE. [TripClockState] has no coordinate field at all, so nothing saved can carry
 * one. The optional GPS progress lives in [PathProgress], in memory only, off by default.
 *
 * DAYLIGHT SAVING AND TIME ZONES. Every duration is a difference between two epoch-millisecond
 * instants. A wall-clock time ("4:30 pm") is used once, by [TripClockLogic.etaFromWallClock], to pick
 * an instant when it is typed. After that no clock change can bend the countdown, and a phone that
 * crosses a time zone simply shows the same instant in its new local time.
 */
@Serializable
internal data class ClockStop(val id: String, val title: String, val atMs: Long)

@Serializable
internal data class TripClockState(
    val running: Boolean = false,
    val startedAtMs: Long = 0L,
    val etaMs: Long = 0L,
    /** The arrival first entered, so "running 30 min late" can be shown after +15 taps. */
    val originalEtaMs: Long = 0L,
    /** Route length in metres if the parent entered one, else 0 (unknown). Never measured, never precise. */
    val distanceM: Int = 0,
    val kidUnit: String = KidUnit.EPISODES.wire,
    /** Suggest an activity every this many minutes: 0 (off), 30 or 60. */
    val nudgeMinutes: Int = 30,
    /** The last nudge the parent dismissed or acted on. */
    val nudgeAcked: Int = 0,
    val arrivedAtMs: Long = 0L,
    val stops: List<ClockStop> = emptyList(),
)

/** How "time left" is put in words a child understands. Durations are generic constants, not a library lookup. */
internal enum class KidUnit(val wire: String, val label: String, val unitMs: Long, val one: String, val many: String) {
    EPISODES("episodes", "TV episodes", 22 * 60_000L, "episode", "episodes"),
    SONGS("songs", "songs", 210_000L, "song", "songs"),
    NONE("none", "just the time", 0L, "", ""),
    ;

    companion object {
        fun fromWire(text: String): KidUnit = values().firstOrNull { it.wire == text } ?: EPISODES
    }
}

/** What the screens (host phone, guest browser) draw. Pure data. */
internal data class TripClockView(
    val running: Boolean,
    val arrived: Boolean,
    val remainingMs: Long,
    val elapsedMs: Long,
    val totalMs: Long,
    /** 0..1 along the road. Time-based unless GPS progress was supplied. */
    val fraction: Double,
    val source: String,
    /** Past the estimated arrival and not yet arrived. */
    val late: Boolean,
    /** How far the arrival has been pushed back from the first estimate. */
    val delayMs: Long,
    val etaText: String,
    val leftText: String,
    val kidText: String,
    val stops: List<ClockStop>,
    /** Where the stops sit along the road, 0..1, in the same order as [stops]. */
    val stopFractions: List<Double>,
    /** The nudge the parent has not answered yet (30 min, 60 min...), or 0. */
    val nudgeDue: Int,
    val nudgeText: String,
    val distanceText: String,
) {
    companion object {
        const val DISCLAIMER = "Estimate only. Use your navigation app for directions."
        const val PASSENGERS = "For passengers. Never for the driver."
    }
}

internal object TripClockLogic {

    const val MAX_HORIZON_MS = 72 * 3_600_000L
    const val MIN_TRIP_MS = 60_000L
    const val MAX_STOPS = 12
    const val MAX_TITLE = 40
    const val MAX_DISTANCE_M = 20_000_000
    const val ADJUST_STEP_MIN = 15
    val NUDGE_CHOICES = listOf(0, 30, 60)

    /** Begin the clock. Throws [IllegalArgumentException] with a message the parent can read. */
    fun start(nowMs: Long, etaMs: Long, distanceM: Int, kidUnit: KidUnit, nudgeMinutes: Int): TripClockState {
        require(etaMs - nowMs >= MIN_TRIP_MS) { "Pick an arrival time that is later than now." }
        require(etaMs - nowMs <= MAX_HORIZON_MS) { "That is more than three days away. Pick a closer arrival time." }
        require(distanceM in 0..MAX_DISTANCE_M) { "That distance is not possible." }
        require(nudgeMinutes in NUDGE_CHOICES) { "Choose no nudges, every 30 minutes or every hour." }
        return TripClockState(
            running = true,
            startedAtMs = nowMs,
            etaMs = etaMs,
            originalEtaMs = etaMs,
            distanceM = distanceM,
            kidUnit = kidUnit.wire,
            nudgeMinutes = nudgeMinutes,
        )
    }

    /**
     * The instant for "arrive at [minuteOfDay]" typed by the parent: the next time the wall clock in
     * [zone] reads it. Across a daylight-saving change this is the real instant, so 01:00 to 04:00 on
     * spring-forward night is two hours, not three.
     */
    fun etaFromWallClock(nowMs: Long, minuteOfDay: Int, zone: TimeZone): Long =
        WallClock.nextOccurrence(minuteOfDay.coerceIn(0, 24 * 60 - 1), nowMs, zone)

    /** "About 2 h 30 min from now" typed as a duration. */
    fun etaFromNow(nowMs: Long, minutes: Int): Long = nowMs + minutes.coerceIn(1, 72 * 60) * 60_000L

    /**
     * Move the estimated arrival by [minutes] (the "+15 min" tap is [ADJUST_STEP_MIN]). Later is
     * always from the later of the old estimate and now, so tapping +15 when already late really does
     * mean 15 minutes from now. Earlier never goes past a minute from now.
     */
    fun adjust(state: TripClockState, minutes: Int, nowMs: Long): TripClockState {
        if (!state.running || state.arrivedAtMs > 0L) return state
        val delta = minutes.coerceIn(-120, 240) * 60_000L
        val next = if (delta >= 0) maxOf(state.etaMs, nowMs) + delta
        else maxOf(state.etaMs + delta, nowMs + MIN_TRIP_MS)
        return state.copy(etaMs = minOf(next, nowMs + MAX_HORIZON_MS))
    }

    /** Set the estimated arrival to an exact instant (the parent edited it). Same limits as [start]. */
    fun setEta(state: TripClockState, etaMs: Long, nowMs: Long): TripClockState {
        if (!state.running || state.arrivedAtMs > 0L) return state
        require(etaMs - nowMs >= MIN_TRIP_MS) { "Pick an arrival time that is later than now." }
        require(etaMs - nowMs <= MAX_HORIZON_MS) { "That is more than three days away. Pick a closer arrival time." }
        return state.copy(etaMs = etaMs)
    }

    /** Add a stop ("Snack stop") at [nowMs]. Bounded, control characters removed, never a location. */
    fun addStop(state: TripClockState, id: String, title: String, nowMs: Long): TripClockState {
        if (!state.running) return state
        val clean = title.filter { !it.isISOControl() }.trim().take(MAX_TITLE)
        require(clean.isNotEmpty()) { "Give the stop a name." }
        if (state.stops.size >= MAX_STOPS) return state
        return state.copy(stops = state.stops + ClockStop(id.take(24), clean, nowMs))
    }

    fun arrive(state: TripClockState, nowMs: Long): TripClockState =
        if (!state.running || state.arrivedAtMs > 0L) state else state.copy(arrivedAtMs = nowMs)

    /** The parent answered the current nudge, so it goes away until the next interval. */
    fun acknowledgeNudge(state: TripClockState, nowMs: Long): TripClockState {
        val due = nudgeDue(state, nowMs)
        return if (due > 0) state.copy(nudgeAcked = due) else state
    }

    fun setKidUnit(state: TripClockState, unit: KidUnit): TripClockState = state.copy(kidUnit = unit.wire)

    fun setNudge(state: TripClockState, minutes: Int): TripClockState =
        if (minutes in NUDGE_CHOICES) state.copy(nudgeMinutes = minutes, nudgeAcked = 0) else state

    /** Which nudge (1 for the first interval, 2 for the second...) is waiting, or 0. */
    fun nudgeDue(state: TripClockState, nowMs: Long): Int {
        if (!state.running || state.arrivedAtMs > 0L || state.nudgeMinutes <= 0) return 0
        if (nowMs >= state.etaMs) return 0
        val interval = state.nudgeMinutes * 60_000L
        val k = ((nowMs - state.startedAtMs) / interval).toInt()
        return if (k > state.nudgeAcked) k else 0
    }

    /** "about 2 episodes", "about 1 song", "almost there!", or "" when the parent chose plain time. */
    fun kidText(remainingMs: Long, unit: KidUnit): String {
        if (unit == KidUnit.NONE || unit.unitMs <= 0L) return ""
        val n = Math.round(remainingMs.toDouble() / unit.unitMs).toInt()
        return when {
            remainingMs <= 0L -> "You're here!"
            n <= 0 -> "almost there!"
            n == 1 -> "about 1 ${unit.one}"
            else -> "about $n ${unit.many}"
        }
    }

    /**
     * Everything to draw at [nowMs], read in [zone]. [pathFraction] is the optional on-device GPS
     * progress (0..1) when the parent switched it on and typed a distance; null means "use the time".
     */
    fun view(state: TripClockState, nowMs: Long, zone: TimeZone, pathFraction: Double? = null): TripClockView {
        if (!state.running) {
            return TripClockView(
                running = false, arrived = false, remainingMs = 0, elapsedMs = 0, totalMs = 0, fraction = 0.0,
                source = "time", late = false, delayMs = 0, etaText = "", leftText = "", kidText = "",
                stops = emptyList(), stopFractions = emptyList(), nudgeDue = 0, nudgeText = "", distanceText = "",
            )
        }
        val arrived = state.arrivedAtMs > 0L
        val total = (state.etaMs - state.startedAtMs).coerceAtLeast(1L)
        val elapsed = ((if (arrived) state.arrivedAtMs else nowMs) - state.startedAtMs).coerceAtLeast(0L)
        val remaining = if (arrived) 0L else (state.etaMs - nowMs).coerceAtLeast(0L)
        val byTime = (elapsed.toDouble() / total).coerceIn(0.0, 1.0)
        val useGps = !arrived && pathFraction != null
        val fraction = when {
            arrived -> 1.0
            useGps -> pathFraction!!.coerceIn(0.0, 1.0)
            else -> byTime
        }
        val late = !arrived && nowMs > state.etaMs
        val unit = KidUnit.fromWire(state.kidUnit)
        val due = nudgeDue(state, nowMs)
        return TripClockView(
            running = true,
            arrived = arrived,
            remainingMs = remaining,
            elapsedMs = elapsed,
            totalMs = total,
            fraction = fraction,
            source = if (useGps) "distance" else "time",
            late = late,
            delayMs = (state.etaMs - state.originalEtaMs).coerceAtLeast(0L),
            etaText = WallClock.clockText(state.etaMs, zone),
            leftText = if (arrived) "" else WallClock.durationText(remaining),
            kidText = if (arrived) "" else kidText(remaining, unit),
            stops = state.stops,
            stopFractions = state.stops.map { ((it.atMs - state.startedAtMs).toDouble() / total).coerceIn(0.0, 1.0) },
            nudgeDue = due,
            nudgeText = if (due > 0) "${WallClock.durationText(due * state.nudgeMinutes * 60_000L)} down. Time for a game?" else "",
            distanceText = if (state.distanceM > 0) "About ${distanceKm(state.distanceM)} in all. Not exact." else "",
        )
    }

    fun distanceKm(meters: Int): String {
        val km = meters / 1000.0
        return if (km >= 100) "${Math.round(km)} km" else String.format(java.util.Locale.US, "%.1f km", km)
    }
}
