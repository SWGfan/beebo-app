package com.beeboentertainment.movie.trip

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.TimeZone

class TripExportFilesTest {

    // ---- campfire ambience as a WAV ------------------------------------------------------

    @Test
    fun `the ambience is a valid 16-bit mono WAV of exactly the requested length`() {
        val out = ByteArrayOutputStream()
        AmbienceWav.write(out, durationMs = 3_000L)
        val bytes = out.toByteArray()
        val samples = AmbienceWav.sampleCount(3_000L)
        assertEquals(44 + samples * 2, bytes.size.toLong())

        val h = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", String(bytes, 0, 4, Charsets.US_ASCII))
        assertEquals("WAVE", String(bytes, 8, 4, Charsets.US_ASCII))
        assertEquals("data", String(bytes, 36, 4, Charsets.US_ASCII))
        assertEquals(bytes.size - 8, h.getInt(4))
        assertEquals(1, h.getShort(20).toInt())                // PCM
        assertEquals(1, h.getShort(22).toInt())                // mono
        assertEquals(AmbienceWav.SAMPLE_RATE, h.getInt(24))
        assertEquals(16, h.getShort(34).toInt())
        assertEquals(samples * 2, h.getInt(40).toLong())
    }

    @Test
    fun `the ambience fades in and out, is audible in the middle and never clips`() {
        val out = ByteArrayOutputStream()
        AmbienceWav.write(out, durationMs = 6_000L)
        val pcm = ByteBuffer.wrap(out.toByteArray(), 44, out.size() - 44).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val all = ShortArray(pcm.remaining()).also { pcm.get(it) }
        val rate = AmbienceWav.SAMPLE_RATE
        fun peak(from: Int, to: Int) = (from until to).maxOf { kotlin.math.abs(all[it].toInt()) }

        assertTrue("silent at the very start", peak(0, 50) < 200)
        assertTrue("silent at the very end", peak(all.size - 50, all.size) < 200)
        assertTrue("audible in the middle", peak(2 * rate, 4 * rate) > 2_000)
        assertTrue("never near full scale", all.all { kotlin.math.abs(it.toInt()) < 30_000 })
    }

    @Test
    fun `a zero-length request writes just a header`() {
        val out = ByteArrayOutputStream()
        AmbienceWav.write(out, durationMs = 0L)
        assertEquals(44, out.size())
    }

    // ---- stripping location from a finished MP4 ------------------------------------------

    private fun box(type: String, payload: ByteArray): ByteArray {
        val b = ByteBuffer.allocate(8 + payload.size).order(ByteOrder.BIG_ENDIAN)
        b.putInt(8 + payload.size)
        b.put(type.toByteArray(Charsets.ISO_8859_1))
        b.put(payload)
        return b.array()
    }

    private val gps = "+51.5007-000.1246/".toByteArray(Charsets.US_ASCII)
    private fun xyz() = box("©xyz", byteArrayOf(0, gps.size.toByte(), 0x15, 0xC7.toByte()) + gps)

    private fun sampleMp4(): ByteArray {
        val ftyp = box("ftyp", "isom".toByteArray() + ByteArray(8))
        val mdat = box("mdat", ByteArray(64) { 7 })
        val name = box("name", "Trip".toByteArray())
        val udta = box("udta", name + xyz())
        val mvhd = box("mvhd", ByteArray(100))
        val moov = box("moov", mvhd + udta)
        return ftyp + mdat + moov
    }

    @Test
    fun `location atoms are blanked in place and the rest of the file is untouched`() {
        val file = File.createTempFile("trip", ".mp4")
        try {
            val original = sampleMp4()
            file.writeBytes(original)
            assertEquals(1, Mp4LocationStripper.strip(file))

            val after = file.readBytes()
            assertEquals("same size, nothing re-muxed", original.size, after.size)
            assertFalse("the coordinates are gone", String(after, Charsets.ISO_8859_1).contains("+51.5007"))
            assertFalse(String(after, Charsets.ISO_8859_1).contains("©xyz"))
            assertTrue(String(after, Charsets.ISO_8859_1).contains("free"))
            // Everything before the location atom is byte-for-byte the same.
            val at = String(original, Charsets.ISO_8859_1).indexOf("©xyz") - 4
            assertArrayEquals(original.copyOfRange(0, at), after.copyOfRange(0, at))
            assertTrue(String(after, Charsets.ISO_8859_1).contains("Trip"))
        } finally {
            file.delete()
        }
    }

    @Test
    fun `a file with no location atom is left exactly as it was`() {
        val file = File.createTempFile("trip", ".mp4")
        try {
            val clean = box("ftyp", "isom".toByteArray() + ByteArray(8)) + box("moov", box("mvhd", ByteArray(100)))
            file.writeBytes(clean)
            assertEquals(0, Mp4LocationStripper.strip(file))
            assertArrayEquals(clean, file.readBytes())
        } finally {
            file.delete()
        }
    }

    @Test
    fun `a truncated or non-mp4 file is never damaged or crashed on`() {
        val file = File.createTempFile("trip", ".mp4")
        try {
            val junk = ByteArray(200) { (it * 31).toByte() }
            file.writeBytes(junk)
            Mp4LocationStripper.strip(file)
            assertArrayEquals(junk, file.readBytes())

            val cut = sampleMp4().copyOf(sampleMp4().size - 20)
            file.writeBytes(cut)
            Mp4LocationStripper.strip(file) // must simply not throw
            assertEquals(cut.size, file.length().toInt())
        } finally {
            file.delete()
        }
    }

    @Test
    fun `a missing file strips nothing`() {
        assertEquals(0, Mp4LocationStripper.strip(File("does-not-exist.mp4")))
    }

    // ---- reading dates from picked media --------------------------------------------------

    @Test
    fun `exif dates are read in the given zone and bad ones read as unknown`() {
        val utc = TimeZone.getTimeZone("UTC")
        assertEquals(1_774_872_000_000L, MediaDates.parseExif("2026:03:30 12:00:00", utc))
        assertEquals(1_774_872_000_000L - 3_600_000L, MediaDates.parseExif("2026:03:30 12:00:00", TimeZone.getTimeZone("GMT+1")))
        assertEquals(0L, MediaDates.parseExif(null, utc))
        assertEquals(0L, MediaDates.parseExif("", utc))
        assertEquals(0L, MediaDates.parseExif("0000:00:00 00:00:00", utc))
        assertEquals(0L, MediaDates.parseExif("not a date at all!!", utc))
    }

    @Test
    fun `video dates are always UTC and tolerate a fraction and a Z`() {
        assertEquals(1_774_872_000_000L, MediaDates.parseBasicUtc("20260330T120000.000Z"))
        assertEquals(1_774_872_000_000L, MediaDates.parseBasicUtc("20260330T120000"))
        assertEquals(0L, MediaDates.parseBasicUtc(null))
        assertEquals(0L, MediaDates.parseBasicUtc("garbage"))
    }
}
