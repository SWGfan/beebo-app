package com.beeboentertainment.movie.party

import com.beeboentertainment.movie.party.campfire.AMBIENCES
import com.beeboentertainment.movie.party.campfire.AmbienceSynth
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AmbienceSynthTest {

    private fun seconds(id: String, s: Double, seed: Int = 7): ShortArray {
        val synth = AmbienceSynth(id, seed = seed)
        val out = ShortArray((AmbienceSynth.SAMPLE_RATE * s).toInt())
        synth.fill(out)
        return out
    }

    @Test
    fun `every Campfire ambience has a synthesized sound`() {
        AMBIENCES.forEach { assertTrue(it.id, AmbienceSynth(it.id).isKnown) }
    }

    @Test
    fun `each sound is audible and never clips`() {
        AmbienceSynth.IDS.forEach { id ->
            val buf = seconds(id, 8.0)
            val rms = AmbienceSynth.rms(buf)
            assertTrue("$id rms $rms", rms > 0.02)
            assertTrue("$id peak", AmbienceSynth.peak(buf) <= AmbienceSynth.MASTER + 1e-3)
            // Not stuck at a rail: most samples are well inside the range.
            assertTrue(id, buf.count { kotlin.math.abs(it.toInt()) > 32000 } < buf.size / 100)
        }
    }

    @Test
    fun `unknown id is silence`() {
        val synth = AmbienceSynth("nope")
        assertFalse(synth.isKnown)
        val buf = ShortArray(1000)
        synth.fill(buf)
        assertEquals(0.0, AmbienceSynth.rms(buf), 0.0)
    }

    @Test
    fun `same seed gives the same sound and chunks join seamlessly`() {
        val whole = seconds("fire", 1.0)
        val synth = AmbienceSynth("fire", seed = 7)
        val a = ShortArray(whole.size / 2)
        val b = ShortArray(whole.size - a.size)
        synth.fill(a); synth.fill(b)
        assertArrayEquals(whole, a + b)
    }

    @Test
    fun `waves swell and crickets pause between chirps`() {
        val rate = AmbienceSynth.SAMPLE_RATE
        val waves = seconds("waves", 7.0)
        val trough = AmbienceSynth.rms(waves.copyOfRange(0, rate / 4))
        val crest = AmbienceSynth.rms(waves.copyOfRange((3.3 * rate).toInt(), (3.7 * rate).toInt()))
        assertTrue("crest $crest trough $trough", crest > trough * 1.5)

        val crickets = seconds("crickets", 2.0)
        val windows = crickets.toList().chunked(rate / 50).map { AmbienceSynth.rms(it.toShortArray()) }
        assertTrue(windows.any { it > 0.1 })
        assertTrue(windows.any { it < 0.05 })
    }
}
