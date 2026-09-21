package com.beeboentertainment.movie.campsite.tripclock

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Optional GPS progress for the Trip Clock. OFF BY DEFAULT and never saved.
 *
 * It adds up how far the phone has moved between location fixes and compares that with the route
 * length the parent typed. It is deliberately rough: fixes are coarse (network location, not GPS
 * chips), a road is longer than the straight lines between fixes, and small wobbles are ignored. The
 * screen calls it "about" and says "not exact".
 *
 * PRIVACY, in the code and not only in the copy:
 *  - It lives in memory. There is no field, file or preference here that holds a coordinate. It keeps
 *    the LAST fix only (to measure the next step) and a running total in metres.
 *  - [reset] and garbage collection forget everything. The Trip Clock's saved state has no
 *    coordinate field (see [TripClockState]).
 *  - The location callback is registered only while the Trip Clock screen is in front and GPS is on,
 *    and removed when the screen stops (see TripClockScreen), so nothing updates with the screen off.
 */
internal class PathProgress(private val totalMeters: Int) {

    private var hasLast = false
    private var lastLat = 0.0
    private var lastLng = 0.0
    private var lastTimeMs = 0L
    private var travelled = 0.0

    /** Metres accumulated so far. */
    val metres: Double get() = travelled

    /**
     * Feed one fix. Returns true if it moved the total. A fix is ignored when it is invalid, too
     * inaccurate to trust, a wobble smaller than its own uncertainty, or an impossible jump.
     */
    fun onFix(lat: Double, lng: Double, accuracyM: Float, timeMs: Long): Boolean {
        if (lat !in -90.0..90.0 || lng !in -180.0..180.0 || lat.isNaN() || lng.isNaN()) return false
        if (accuracyM.isNaN() || accuracyM > MAX_ACCURACY_M) return false
        if (!hasLast) {
            hasLast = true; lastLat = lat; lastLng = lng; lastTimeMs = timeMs
            return false
        }
        val d = haversineMetres(lastLat, lastLng, lat, lng)
        val step = maxOf(MIN_STEP_M, accuracyM.toDouble() / 2.0)
        if (d < step) return false
        val seconds = ((timeMs - lastTimeMs).coerceAtLeast(1L)) / 1000.0
        if (d / seconds > MAX_SPEED_MS) {
            // A jump no car can make: take it as the new starting point but do not count the leap.
            lastLat = lat; lastLng = lng; lastTimeMs = timeMs
            return false
        }
        travelled += d
        lastLat = lat; lastLng = lng; lastTimeMs = timeMs
        return true
    }

    /** 0..1 of the typed route length, or null when no length was typed. */
    fun fraction(): Double? =
        if (totalMeters <= 0) null else (travelled / totalMeters).coerceIn(0.0, 1.0)

    fun reset() {
        hasLast = false
        travelled = 0.0
        lastTimeMs = 0L
    }

    companion object {
        /** Coarse fixes are usually a few hundred metres; worse than this is not worth using. */
        const val MAX_ACCURACY_M = 3_000f

        /** Movement smaller than this is jitter, not progress. */
        const val MIN_STEP_M = 150.0

        /** About 250 km/h. Anything faster between two fixes is a glitch. */
        const val MAX_SPEED_MS = 70.0

        fun haversineMetres(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
            val r = 6_371_000.0
            val p1 = Math.toRadians(lat1)
            val p2 = Math.toRadians(lat2)
            val dp = Math.toRadians(lat2 - lat1)
            val dl = Math.toRadians(lng2 - lng1)
            val a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
            return 2 * r * asin(sqrt(a))
        }
    }
}
