package com.beeboentertainment.auto.family

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Joining the phone's speech clips and silences into one WAV file. */
class WavStitcherTest {

    private val mono22 = WavFormat(22_050, 1)

    private fun pcm(vararg samples: Int): ByteArray {
        val out = ByteArray(samples.size * 2)
        samples.forEachIndexed { i, s -> out[i * 2] = (s and 0xFF).toByte(); out[i * 2 + 1] = ((s shr 8) and 0xFF).toByte() }
        return out
    }

    private fun clip(vararg samples: Int) = WavPart.Clip(Wav(mono22, pcm(*samples)))

    private fun le32(bytes: ByteArray, at: Int) =
        (bytes[at].toInt() and 0xFF) or ((bytes[at + 1].toInt() and 0xFF) shl 8) or
            ((bytes[at + 2].toInt() and 0xFF) shl 16) or ((bytes[at + 3].toInt() and 0xFF) shl 24)

    @Test
    fun `a built file has a correct header and parses back to the same sound`() {
        val data = pcm(1, -2, 300, -400, 32_767, -32_768)
        val file = WavStitcher.build(mono22, data)
        assertEquals(44 + data.size, file.size)
        assertEquals("RIFF", String(file, 0, 4))
        assertEquals("WAVE", String(file, 8, 4))
        assertEquals(36 + data.size, le32(file, 4))
        assertEquals(data.size, le32(file, 40))
        assertEquals(22_050, le32(file, 24))
        assertEquals(22_050 * 2, le32(file, 28))
        val back = WavStitcher.parse(file)
        assertEquals(mono22, back.format)
        assertArrayEquals(data, back.pcm)
    }

    @Test
    fun `silence is the right length for the format`() {
        assertEquals(22_050 * 2, WavStitcher.silence(mono22, 1_000).size)
        assertEquals(22_050 * 2 * 2 / 2, WavStitcher.silence(mono22, 1_000).size)
        assertEquals(44_100 * 4 / 2, WavStitcher.silence(WavFormat(44_100, 2), 500).size)
        assertEquals(0, WavStitcher.silence(mono22, 0).size)
        assertEquals(0, WavStitcher.silence(mono22, -5).size)
        assertTrue(WavStitcher.silence(mono22, 250).all { it == 0.toByte() })
    }

    @Test
    fun `clips and silences are joined in order into one file`() {
        val file = WavStitcher.stitch(listOf(clip(1, 2, 3), WavPart.Silence(1_000), clip(4, 5)))
        val wav = WavStitcher.parse(file)
        val expected = pcm(1, 2, 3) + WavStitcher.silence(mono22, 1_000) + pcm(4, 5)
        assertArrayEquals(expected, wav.pcm)
        assertEquals(mono22, wav.format)
    }

    @Test
    fun `leading silence is fine as long as there is some speech to learn the format from`() {
        val wav = WavStitcher.parse(WavStitcher.stitch(listOf(WavPart.Silence(500), clip(9))))
        assertEquals(WavStitcher.silence(mono22, 500).size + 2, wav.pcm.size)
    }

    @Test
    fun `no speech at all is refused`() {
        try { WavStitcher.stitch(listOf(WavPart.Silence(1_000))); fail() } catch (e: IllegalArgumentException) { assertTrue(e.message!!.isNotBlank()) }
        try { WavStitcher.stitch(emptyList()); fail() } catch (e: IllegalArgumentException) { }
    }

    @Test
    fun `clips in different formats are refused rather than played as noise`() {
        val other = WavPart.Clip(Wav(WavFormat(16_000, 1), pcm(1, 2)))
        try { WavStitcher.stitch(listOf(clip(1), other)); fail() } catch (e: IllegalArgumentException) { assertTrue(e.message!!.contains("format")) }
    }

    @Test
    fun `something absurdly long is refused`() {
        try { WavStitcher.stitch(listOf(clip(1), WavPart.Silence(31 * 60 * 1000))); fail() } catch (e: IllegalArgumentException) { assertTrue(e.message!!.contains("long")) }
    }

    @Test
    fun `a file with extra chunks before the sound still parses`() {
        val data = pcm(7, 8, 9, 10)
        val plain = WavStitcher.build(mono22, data)
        // Insert a LIST chunk (odd length, so it has a pad byte) between fmt and data.
        val fmtEnd = 12 + 8 + 16
        val list = "LIST".toByteArray() + byteArrayOf(3, 0, 0, 0) + byteArrayOf(1, 2, 3, 0)
        val withList = plain.copyOfRange(0, fmtEnd) + list + plain.copyOfRange(fmtEnd, plain.size)
        assertArrayEquals(data, WavStitcher.parse(withList).pcm)
    }

    @Test
    fun `a streamed file that leaves the data size at zero or too big uses what is there`() {
        val data = pcm(1, 2, 3, 4, 5)
        val zero = WavStitcher.build(mono22, data).also { it[40] = 0; it[41] = 0; it[42] = 0; it[43] = 0 }
        assertArrayEquals(data, WavStitcher.parse(zero).pcm)
        val huge = WavStitcher.build(mono22, data).also { for (i in 40..43) it[i] = 0xFF.toByte() }
        assertArrayEquals(data, WavStitcher.parse(huge).pcm)
    }

    @Test
    fun `a half sample at the end is dropped`() {
        val file = WavStitcher.build(mono22, pcm(1, 2, 3))
        val cut = file.copyOfRange(0, file.size - 1)
        assertEquals(4, WavStitcher.parse(cut).pcm.size)
    }

    @Test
    fun `things that are not sound files are refused with a plain sentence`() {
        listOf(
            ByteArray(0), ByteArray(10), ByteArray(100),
            "RIFF0000WAVE".toByteArray() + ByteArray(40),
            "this is definitely not a wave file, just some text long enough to pass the size check".toByteArray(),
        ).forEach {
            try { WavStitcher.parse(it); fail("parsed junk of ${it.size} bytes") } catch (e: IllegalArgumentException) {
                assertTrue(e.message!!.isNotBlank())
            }
        }
    }

    @Test
    fun `eight bit and float sound is refused`() {
        val file = WavStitcher.build(mono22, pcm(1, 2))
        val eightBit = file.copyOf().also { it[34] = 8 }
        try { WavStitcher.parse(eightBit); fail() } catch (e: IllegalArgumentException) { }
        val float = file.copyOf().also { it[20] = 3 }
        try { WavStitcher.parse(float); fail() } catch (e: IllegalArgumentException) { }
    }

    @Test
    fun `stereo is kept and never split part way through a frame`() {
        val stereo = WavFormat(24_000, 2)
        val data = pcm(1, 2, 3, 4, 5, 6)
        val wav = WavStitcher.parse(WavStitcher.build(stereo, data))
        assertEquals(stereo, wav.format)
        assertEquals(0, wav.pcm.size % 4)
        assertFalse(wav.pcm.isEmpty())
    }
}
