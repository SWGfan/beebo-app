package com.beeboentertainment.movie.trip

import com.beeboentertainment.movie.party.campfire.AmbienceSynth
import java.io.File
import java.io.OutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

/**
 * The only sound an exported trip video can have: the campfire ambience Beebo already synthesizes
 * on the phone ([AmbienceSynth], no audio files, nothing licensed). Written as a plain WAV file the
 * encoder reads like any other audio input. Never a track from the person's music library.
 */
internal object AmbienceWav {

    const val SAMPLE_RATE = 44_100
    private const val FADE_MS = 2_000L
    private const val GAIN = 0.55

    /** How many samples cover [durationMs]. */
    fun sampleCount(durationMs: Long, sampleRate: Int = SAMPLE_RATE): Long = durationMs.coerceAtLeast(0L) * sampleRate / 1000L

    /** A 44-byte PCM header for 16-bit mono audio of [samples] samples. */
    fun header(samples: Long, sampleRate: Int = SAMPLE_RATE): ByteArray {
        val dataBytes = samples * 2
        return ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray(Charsets.US_ASCII))
            putInt((36 + dataBytes).toInt())
            put("WAVE".toByteArray(Charsets.US_ASCII))
            put("fmt ".toByteArray(Charsets.US_ASCII))
            putInt(16)
            putShort(1) // PCM
            putShort(1) // mono
            putInt(sampleRate)
            putInt(sampleRate * 2)
            putShort(2)
            putShort(16)
            put("data".toByteArray(Charsets.US_ASCII))
            putInt(dataBytes.toInt())
        }.array()
    }

    /**
     * Stream [durationMs] of the fire ambience to [out], fading in and out so it never starts or
     * stops with a click. Generated in chunks, so a ten-minute video needs no ten-minute buffer.
     */
    fun write(out: OutputStream, durationMs: Long, sampleRate: Int = SAMPLE_RATE, ambienceId: String = "fire") {
        val total = sampleCount(durationMs, sampleRate)
        out.write(header(total, sampleRate))
        val synth = AmbienceSynth(ambienceId, sampleRate)
        val fade = (FADE_MS * sampleRate / 1000L).coerceAtMost(total / 2).coerceAtLeast(1L)
        val chunk = ShortArray(sampleRate)
        val bytes = ByteBuffer.allocate(chunk.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        var done = 0L
        while (done < total) {
            val n = minOf(chunk.size.toLong(), total - done).toInt()
            val part = if (n == chunk.size) chunk else ShortArray(n)
            synth.fill(part)
            bytes.clear()
            for (i in 0 until n) {
                val at = done + i
                val edge = minOf(at, total - 1 - at)
                val envelope = if (edge >= fade) 1.0 else edge.toDouble() / fade
                bytes.putShort((part[i] * GAIN * envelope).roundToInt().toShort())
            }
            out.write(bytes.array(), 0, n * 2)
            done += n
        }
    }

    fun write(file: File, durationMs: Long) {
        file.outputStream().buffered().use { write(it, durationMs) }
    }
}

/**
 * Makes sure a finished MP4 carries no GPS position.
 *
 * Photos never do: each is re-drawn from its pixels into a fresh JPEG, which writes no EXIF at all.
 * A video is different. Transformer re-encodes the picture but its muxer can write a location atom
 * from the source clip, and the Transformer API offers no switch to refuse that. So after the file
 * is written this walks its top-level boxes (moov, then udta inside it), overwrites any location
 * atom's contents with zeros and renames it "free", which every player skips.
 *
 * It only rewrites bytes in place (same size, no re-mux), so it cannot break a valid file.
 */
internal object Mp4LocationStripper {

    private const val HEADER = 8
    private val CONTAINERS = setOf("moov", "udta")
    // "©xyz" is the QuickTime/Android GPS atom, "loci" is the 3GPP location atom.
    private val LOCATION_ATOMS = setOf("©xyz", "loci")

    /** Returns how many location atoms were blanked. */
    fun strip(file: File): Int {
        if (!file.isFile) return 0
        return RandomAccessFile(file, "rw").use { raf -> scan(raf, 0L, raf.length(), depth = 0) }
    }

    private fun scan(raf: RandomAccessFile, start: Long, end: Long, depth: Int): Int {
        var found = 0
        var at = start
        val header = ByteArray(HEADER)
        while (at + HEADER <= end) {
            raf.seek(at)
            raf.readFully(header)
            val size32 = ByteBuffer.wrap(header, 0, 4).order(ByteOrder.BIG_ENDIAN).int.toLong() and 0xFFFFFFFFL
            val type = String(header, 4, 4, Charsets.ISO_8859_1)
            var headerSize = HEADER.toLong()
            val size = when (size32) {
                0L -> end - at
                1L -> {
                    headerSize = 16
                    val large = ByteArray(8)
                    raf.readFully(large)
                    ByteBuffer.wrap(large).order(ByteOrder.BIG_ENDIAN).long
                }
                else -> size32
            }
            if (size < headerSize || at + size > end) break
            when {
                type in LOCATION_ATOMS -> {
                    blank(raf, at, headerSize, size)
                    found++
                }
                type in CONTAINERS && depth < 3 -> found += scan(raf, at + headerSize, at + size, depth + 1)
            }
            at += size
        }
        return found
    }

    private fun blank(raf: RandomAccessFile, at: Long, headerSize: Long, size: Long) {
        raf.seek(at + 4)
        raf.write("free".toByteArray(Charsets.ISO_8859_1))
        raf.seek(at + headerSize)
        var left = size - headerSize
        val zeros = ByteArray(minOf(left, 4096L).toInt())
        while (left > 0) {
            val n = minOf(left, zeros.size.toLong()).toInt()
            raf.write(zeros, 0, n)
            left -= n
        }
    }
}
