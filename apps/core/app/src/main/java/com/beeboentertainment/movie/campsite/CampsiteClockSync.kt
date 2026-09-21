package com.beeboentertainment.movie.campsite

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.sqrt

/**
 * NTP-style clock offset estimation, in pure Kotlin so the maths can be unit tested.
 *
 * The guest phone's browser runs the SAME algorithm in JavaScript
 * (app/src/main/assets/campsite-music.js, "ClockSync"); both are checked against the shared
 * vectors in src/test/resources/campsite-clock-vectors.json, so a change to one that is not made
 * to the other fails a test. The host does not need to run this itself (its own clock is the
 * reference), but the host screen, tests and future native guests (a second Beebo phone) can.
 *
 * One exchange (all times in milliseconds, on the clock named):
 *   t0  client sends ping        (client clock)
 *   t1  host receives it         (host clock)
 *   t2  host sends the pong      (host clock)
 *   t3  client receives the pong (client clock)
 *   rtt    = (t3 - t0) - (t2 - t1)          time on the wire, host processing removed
 *   offset = ((t1 - t0) + (t2 - t3)) / 2    host clock minus client clock
 * The offset is exact when the two legs take equal time; each 1 ms of asymmetry between them
 * costs 0.5 ms of error. Hence: the best samples are the ones with the lowest RTT (least chance
 * of a queueing spike on one leg), and the estimate can never be wrong by more than rtt / 2.
 */
data class ClockSample(val t0: Double, val t1: Double, val t2: Double, val t3: Double) {
    val rtt: Double get() = (t3 - t0) - (t2 - t1)
    val offset: Double get() = ((t1 - t0) + (t2 - t3)) / 2.0
    val isFinite: Boolean get() = t0.isFinite() && t1.isFinite() && t2.isFinite() && t3.isFinite()
}

/** [offsetMs] = host clock - client clock; [errorMs] is an honest estimate, not a hard bound. */
data class ClockEstimate(
    val offsetMs: Double,
    val rttMs: Double,
    val errorMs: Double,
    /** Samples that survived rejection, out of [total] received. */
    val used: Int,
    val total: Int,
)

object ClockSync {
    const val MIN_SAMPLES = 5
    /** Samples with a round trip longer than this are dropped outright (a stalled radio, a paused tab). */
    const val MAX_RTT_MS = 2000.0
    /** Fraction of the lowest-RTT samples kept for the median, never fewer than [MIN_KEEP]. */
    const val KEEP_FRACTION = 0.5
    const val MIN_KEEP = 3
    /** A kept sample further than max(OUTLIER_SIGMAS * sigma, OUTLIER_FLOOR_MS) from the median is discarded. */
    const val OUTLIER_SIGMAS = 3.0
    const val OUTLIER_FLOOR_MS = 3.0
    /** Negative RTTs this small are clock resolution, not corruption. */
    const val RTT_TOLERANCE_MS = 0.5

    /**
     * Offset estimate from a burst of samples, or null if there are too few usable ones.
     *
     * 1. drop samples that are not finite, have a negative RTT (beyond resolution) or an RTT over [MAX_RTT_MS];
     * 2. keep the lowest-RTT half (at least [MIN_KEEP]);
     * 3. take the median offset of those, discard outliers from that median, take the median again.
     *
     * The reported error is max(robust standard deviation of what was kept, best RTT / 4, 0.5 ms):
     * the quarter-RTT term says "assume the two legs differ by up to half of the round trip".
     */
    fun estimate(samples: List<ClockSample>): ClockEstimate? {
        val valid = samples.filter { it.isFinite && it.rtt >= -RTT_TOLERANCE_MS && it.rtt <= MAX_RTT_MS }
        if (valid.size < MIN_SAMPLES) return null
        val byRtt = valid.sortedBy { it.rtt }
        val keep = byRtt.take(max(MIN_KEEP, ceil(byRtt.size * KEEP_FRACTION).toInt()))
        val firstMedian = median(keep.map { it.offset })
        val sigma0 = MAD_TO_SIGMA * median(keep.map { abs(it.offset - firstMedian) })
        val limit = max(OUTLIER_SIGMAS * sigma0, OUTLIER_FLOOR_MS)
        val good = keep.filter { abs(it.offset - firstMedian) <= limit }.ifEmpty { keep }
        val offset = median(good.map { it.offset })
        val sigma = MAD_TO_SIGMA * median(good.map { abs(it.offset - offset) })
        val rttMin = max(0.0, byRtt.first().rtt)
        val error = max(max(sigma, rttMin / 4.0), 0.5)
        return ClockEstimate(offset, median(good.map { max(0.0, it.rtt) }), error, good.size, samples.size)
    }

    /** Median absolute deviation to standard deviation for normally distributed noise. */
    const val MAD_TO_SIGMA = 1.4826

    fun median(values: List<Double>): Double {
        require(values.isNotEmpty())
        val s = values.sorted()
        val mid = s.size / 2
        return if (s.size % 2 == 1) s[mid] else (s[mid - 1] + s[mid]) / 2.0
    }
}

/**
 * Smooths successive estimates (one burst every 30-60 s). Small changes are blended in (the true
 * offset only wanders by the two clocks' frequency difference, roughly 0.1 ms per second at the
 * worst); a big jump (the host phone's clock was stepped, the guest tab was frozen for a minute)
 * is believed immediately.
 */
class ClockFilter {
    var offsetMs: Double = 0.0
        private set
    var errorMs: Double = Double.POSITIVE_INFINITY
        private set
    var rttMs: Double = 0.0
        private set
    var updates: Int = 0
        private set
    val isReady: Boolean get() = updates > 0

    fun update(e: ClockEstimate): Double {
        if (updates == 0 || abs(e.offsetMs - offsetMs) > STEP_MS) {
            offsetMs = e.offsetMs
            errorMs = e.errorMs
        } else {
            offsetMs += ALPHA * (e.offsetMs - offsetMs)
            // Weighted RMS of the two error figures: no optimism about the blend.
            errorMs = sqrt((1 - ALPHA) * errorMs * errorMs + ALPHA * e.errorMs * e.errorMs)
        }
        rttMs = e.rttMs
        updates++
        return offsetMs
    }

    companion object {
        const val ALPHA = 0.35
        const val STEP_MS = 40.0
    }
}
