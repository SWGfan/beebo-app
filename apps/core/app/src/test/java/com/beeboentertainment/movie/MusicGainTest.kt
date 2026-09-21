package com.beeboentertainment.movie

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.music.MusicGain
import com.beeboentertainment.movie.music.MusicTrack
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.pow

class MusicGainTest {

    @Test
    fun `album mode uses the album gain, track mode the track gain, each falls back to the other`() {
        assertEquals(-6.0, MusicGain.db(-6.0, -4.0, null, null, albumMode = false)!!, 1e-9)
        assertEquals(-4.0, MusicGain.db(-6.0, -4.0, null, null, albumMode = true)!!, 1e-9)
        assertEquals(-6.0, MusicGain.db(-6.0, null, null, null, albumMode = true)!!, 1e-9)
        assertEquals(-4.0, MusicGain.db(null, -4.0, null, null, albumMode = false)!!, 1e-9)
        assertNull(MusicGain.db(null, null, null, null, albumMode = true))
        assertNull(MusicGain.db(Double.NaN, Double.POSITIVE_INFINITY, null, null, albumMode = false))
    }

    @Test
    fun `the tag's own peak holds a boost back so nothing clips, and the range is bounded`() {
        assertEquals(0.0, MusicGain.db(6.0, null, 1.0, null, false)!!, 1e-9)
        assertEquals(6.0206, MusicGain.db(9.0, null, 0.5, null, false)!!, 1e-3)
        assertEquals(-6.0, MusicGain.db(-6.0, null, 1.0, null, false)!!, 1e-9)
        assertEquals(12.0, MusicGain.db(20.0, null, null, null, false)!!, 1e-9)
        assertEquals(-30.0, MusicGain.db(-45.0, null, null, null, false)!!, 1e-9)
        // Album mode is limited by the album's peak, or the song's when the album has none.
        assertEquals(0.0, MusicGain.db(-6.0, 3.0, null, 1.0, true)!!, 1e-9)
        assertEquals(3.0, MusicGain.db(-6.0, 3.0, 0.5, null, true)!!, 1e-9)
        assertEquals(0.0, MusicGain.db(-6.0, 3.0, 1.0, null, true)!!, 1e-9)
        // No negative zero.
        assertTrue(1.0 / MusicGain.db(6.0, null, 1.0, null, false)!! > 0)
    }

    @Test
    fun `player volume only ever goes down, and untagged songs are left alone`() {
        assertEquals(1f, MusicGain.volumeFor(null), 0f)
        assertEquals(1f, MusicGain.volumeFor(0.0), 0f)
        assertEquals(1f, MusicGain.volumeFor(6.0), 0f)
        assertEquals(0.5f, MusicGain.volumeFor(-6.0206), 1e-3f)
        assertEquals(10.0.pow(-9.0 / 20).toFloat(), MusicGain.volumeFor(-9.0), 1e-6f)
        assertEquals(1f, MusicGain.volumeFor(Double.NaN), 0f)
        for (i in 0 until 200) {
            val g = (Math.random() - 0.5) * 60
            val v = MusicGain.volumeFor(MusicGain.db(g, null, null, null, false))
            assertTrue("volume $v within 0..1 for $g dB", v in 0f..1f)
        }
    }

    @Test
    fun `words say what happened, including a boost that is not given`() {
        assertEquals("Volume levelling is off", MusicGain.words(-6.0, true, true, enabled = false))
        assertEquals("No ReplayGain tag in this file, so its level is left alone", MusicGain.words(null, true, false, true))
        assertEquals("Volume levelling: -6.3 dB (album ReplayGain)", MusicGain.words(-6.3, true, true, true))
        assertEquals("Volume levelling: -6.3 dB (song ReplayGain)", MusicGain.words(-6.3, false, true, true))
        assertEquals("Volume levelling: -6.3 dB (song ReplayGain)", MusicGain.words(-6.3, true, false, true))
        assertEquals("Volume levelling: +3.0 dB (song ReplayGain), not boosted on this phone", MusicGain.words(3.0, false, false, true))
        assertFalse(MusicGain.boostDropped(0.0))
        assertFalse(MusicGain.boostDropped(-3.0))
        assertTrue(MusicGain.boostDropped(0.5))
    }

    @Test
    fun `the server's track answer carries the gain fields, and an older server's does not break decoding`() {
        val t = ApiClient.JSON.decodeFromString(
            MusicTrack.serializer(),
            """{"id":"a","title":"T","codec":"flac","lossless":true,"gainDb":-6.5,"albumGainDb":-5.25,"gainPeak":0.98,"albumGainPeak":1.0}"""
        )
        assertEquals(-6.5, t.gainDb!!, 1e-9)
        assertEquals(-5.25, t.albumGainDb!!, 1e-9)
        assertEquals(0.98, t.gainPeak!!, 1e-9)
        assertEquals(1.0, t.albumGainPeak!!, 1e-9)
        assertTrue(t.lossless)
        val none = ApiClient.JSON.decodeFromString(MusicTrack.serializer(), """{"id":"a","title":"T","gainDb":null}""")
        assertNull(none.gainDb)
        assertNull(none.albumGainDb)
        val old = ApiClient.JSON.decodeFromString(MusicTrack.serializer(), """{"id":"a","title":"T"}""")
        assertNull(old.gainPeak)
    }
}
