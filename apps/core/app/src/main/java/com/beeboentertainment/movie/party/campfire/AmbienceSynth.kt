package com.beeboentertainment.movie.party.campfire

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

/**
 * Campfire Mode's ambience, made on the phone: filtered noise for rain, waves and the fire's
 * rumble, short noise bursts for crackles, and pulsed tones for crickets. No audio files are
 * bundled, so the four sounds always work, offline, in every build. Endless by construction (the
 * generator never repeats a loop point), so there is no audible seam.
 *
 * Pure Kotlin (no Android types): AmbiencePlayer streams [fill]'s output to an AudioTrack, and
 * AmbienceSynthTest checks every sound is audible, never clips and is steady from call to call.
 */
class AmbienceSynth(val id: String, val sampleRate: Int = SAMPLE_RATE, seed: Int = 0x0BEEB0) {

    private val rng = Random(seed)
    private var t = 0L

    // Filter memories.
    private var lp1 = 0.0
    private var lp2 = 0.0
    private var brown = 0.0

    // Fire crackles: remaining samples and level of the current pop.
    private var crackleLeft = 0
    private var crackleLevel = 0.0
    private var crackleDecay = 0.0

    // Rain: an occasional nearer drop.
    private var dropLeft = 0
    private var dropLevel = 0.0

    /** True for an ambience this synth knows how to make. */
    val isKnown: Boolean get() = id in IDS

    /** Fill [out] with the next samples (16-bit mono). An unknown id gives silence. */
    fun fill(out: ShortArray) {
        for (i in out.indices) {
            val v = when (id) {
                "rain" -> rain()
                "waves" -> waves()
                "fire" -> fire()
                "crickets" -> crickets()
                else -> 0.0
            }
            t++
            out[i] = (v.coerceIn(-1.0, 1.0) * Short.MAX_VALUE * MASTER).roundToInt().toShort()
        }
    }

    private fun white(): Double = rng.nextDouble() * 2.0 - 1.0

    private fun seconds(): Double = t.toDouble() / sampleRate

    private fun rain(): Double {
        lp1 += 0.45 * (white() - lp1)
        lp2 += 0.08 * (white() - lp2)
        var v = lp1 * 0.55 + lp2 * 0.6
        if (dropLeft <= 0 && rng.nextDouble() < 6.0 / sampleRate) {
            dropLeft = sampleRate / 60
            dropLevel = 0.15 + rng.nextDouble() * 0.25
        }
        if (dropLeft > 0) {
            v += white() * dropLevel * dropLeft / (sampleRate / 60.0)
            dropLeft--
        }
        return v
    }

    private fun waves(): Double {
        // Leaky integrated noise ("brown"), then a slow swell: a wave about every 7 seconds.
        brown = (brown + white() * 0.06) * 0.995
        lp1 += 0.2 * (white() - lp1)
        val swell = 0.5 - 0.5 * cos(2.0 * PI * seconds() / 7.0)
        return brown * (0.35 + 1.1 * swell) + lp1 * 0.25 * swell
    }

    private fun fire(): Double {
        brown = (brown + white() * 0.05) * 0.993
        var v = brown * 0.9
        if (crackleLeft <= 0 && rng.nextDouble() < 9.0 / sampleRate) {
            crackleLeft = (sampleRate * (0.004 + rng.nextDouble() * 0.025)).toInt().coerceAtLeast(1)
            crackleLevel = 0.35 + rng.nextDouble() * 0.55
            crackleDecay = exp(-6.0 / crackleLeft)
        }
        if (crackleLeft > 0) {
            v += white() * crackleLevel
            crackleLevel *= crackleDecay
            crackleLeft--
        }
        return v
    }

    private fun crickets(): Double {
        val s = seconds()
        fun cricket(freq: Double, period: Double, offset: Double): Double {
            // Three 30 ms pulses, then quiet, every [period] seconds.
            val phase = ((s + offset) % period)
            val pulse = (phase / 0.06).toInt()
            val inPulse = pulse < 3 && (phase % 0.06) < 0.03
            return if (inPulse) sin(2.0 * PI * freq * s) * 0.5 else 0.0
        }
        lp1 += 0.05 * (white() - lp1)
        return cricket(4400.0, 0.62, 0.0) + cricket(4750.0, 0.71, 0.23) * 0.6 + lp1 * 0.08
    }

    companion object {
        const val SAMPLE_RATE = 22_050
        /** Keeps the loudest peaks well under full scale. */
        const val MASTER = 0.7
        val IDS = setOf("fire", "crickets", "rain", "waves")

        /** Root-mean-square of a buffer, 0..1: a test and debugging aid. */
        fun rms(buf: ShortArray): Double {
            if (buf.isEmpty()) return 0.0
            var sum = 0.0
            for (s in buf) { val d = s / Short.MAX_VALUE.toDouble(); sum += d * d }
            return kotlin.math.sqrt(sum / buf.size)
        }

        fun peak(buf: ShortArray): Double = buf.maxOfOrNull { abs(it.toInt()) }?.let { it / Short.MAX_VALUE.toDouble() } ?: 0.0
    }
}
