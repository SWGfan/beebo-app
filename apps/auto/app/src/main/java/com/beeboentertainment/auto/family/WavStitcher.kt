package com.beeboentertainment.auto.family

import java.io.ByteArrayOutputStream

/**
 * Joins the phone's own speech clips and stretches of silence into one WAV file.
 *
 * The phone's text-to-speech engine writes one small WAV per sentence. A game round is "speak, wait,
 * speak, wait", so this puts the clips and the silences end to end and writes a single file with a
 * correct header, which the car's media player then plays like any recording. Pure byte arithmetic,
 * so it is unit-tested on the JVM without a phone.
 *
 * It only accepts 16-bit PCM (what Android's speech engines write). Anything else is refused with a
 * plain error rather than played as noise.
 *
 * Nothing here records anyone. The audio it handles is the phone's synthetic voice reading text that
 * ships inside the app.
 */
class WavFormat(val sampleRate: Int, val channels: Int) {
    val bytesPerFrame: Int get() = channels * 2
    override fun equals(other: Any?) = other is WavFormat && other.sampleRate == sampleRate && other.channels == channels
    override fun hashCode() = sampleRate * 31 + channels
}

class Wav(val format: WavFormat, val pcm: ByteArray)

sealed interface WavPart {
    class Clip(val wav: Wav) : WavPart
    class Silence(val ms: Int) : WavPart
}

object WavStitcher {

    /** No round is ever anywhere near this long; it stops a bad file from filling the cache. */
    const val MAX_SECONDS = 30 * 60

    /** Reads the format and the sound data out of a WAV file. Throws [IllegalArgumentException]. */
    fun parse(bytes: ByteArray): Wav {
        require(bytes.size >= 44) { "That is not a sound file." }
        require(tag(bytes, 0) == "RIFF" && tag(bytes, 8) == "WAVE") { "That is not a WAV sound file." }
        var pos = 12
        var format: WavFormat? = null
        while (pos + 8 <= bytes.size) {
            val id = tag(bytes, pos)
            val size = le32(bytes, pos + 4)
            val body = pos + 8
            when (id) {
                "fmt " -> {
                    require(size >= 16 && body + 16 <= bytes.size) { "The sound file's format is damaged." }
                    val code = le16(bytes, body)
                    val channels = le16(bytes, body + 2)
                    val rate = le32(bytes, body + 4)
                    val bits = le16(bytes, body + 14)
                    require(code == 1 || code == 0xFFFE) { "The phone's voice made a sound format this app cannot join." }
                    require(bits == 16) { "The phone's voice made a sound format this app cannot join." }
                    require(channels in 1..2 && rate in 8_000..96_000) { "The phone's voice made an unusual sound format." }
                    format = WavFormat(rate, channels)
                }
                "data" -> {
                    val f = requireNotNull(format) { "The sound file has no format." }
                    // A streamed file can say 0 or a huge size: trust what is actually there.
                    val available = bytes.size - body
                    val len = if (size <= 0 || size > available) available else size
                    val aligned = len - (len % f.bytesPerFrame)
                    return Wav(f, bytes.copyOfRange(body, body + aligned))
                }
            }
            if (size < 0) break
            pos = body + size + (size and 1)
        }
        throw IllegalArgumentException("The sound file has no sound in it.")
    }

    fun silence(format: WavFormat, ms: Int): ByteArray {
        val frames = (format.sampleRate.toLong() * ms.coerceAtLeast(0) / 1000L).toInt()
        return ByteArray(frames * format.bytesPerFrame)
    }

    /** A complete WAV file around [pcm]. */
    fun build(format: WavFormat, pcm: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(pcm.size + 44)
        val byteRate = format.sampleRate * format.bytesPerFrame
        out.write("RIFF".toByteArray(Charsets.US_ASCII))
        out.write(le32Bytes(36 + pcm.size))
        out.write("WAVE".toByteArray(Charsets.US_ASCII))
        out.write("fmt ".toByteArray(Charsets.US_ASCII))
        out.write(le32Bytes(16))
        out.write(le16Bytes(1))
        out.write(le16Bytes(format.channels))
        out.write(le32Bytes(format.sampleRate))
        out.write(le32Bytes(byteRate))
        out.write(le16Bytes(format.bytesPerFrame))
        out.write(le16Bytes(16))
        out.write("data".toByteArray(Charsets.US_ASCII))
        out.write(le32Bytes(pcm.size))
        out.write(pcm)
        return out.toByteArray()
    }

    /**
     * Clips and silences, in order, as one WAV file. Every clip must share one format (they all come
     * from one engine in one session). Needs at least one clip to learn the format from.
     */
    fun stitch(parts: List<WavPart>): ByteArray {
        val first = parts.filterIsInstance<WavPart.Clip>().firstOrNull()
            ?: throw IllegalArgumentException("There was no speech to join.")
        val format = first.wav.format
        val out = ByteArrayOutputStream()
        val limit = format.sampleRate.toLong() * format.bytesPerFrame * MAX_SECONDS
        for (p in parts) {
            when (p) {
                is WavPart.Clip -> {
                    require(p.wav.format == format) { "The phone's voice changed sound format part way through." }
                    require(out.size().toLong() + p.wav.pcm.size <= limit) { "That would be far too long." }
                    out.write(p.wav.pcm)
                }
                is WavPart.Silence -> {
                    // Checked before the silence is made, so a huge request never allocates.
                    val bytes = format.sampleRate.toLong() * p.ms.coerceAtLeast(0) / 1000L * format.bytesPerFrame
                    require(out.size() + bytes <= limit) { "That would be far too long." }
                    out.write(silence(format, p.ms))
                }
            }
        }
        return build(format, out.toByteArray())
    }

    // ---- little-endian helpers

    private fun tag(b: ByteArray, at: Int) = String(b, at, 4, Charsets.US_ASCII)

    private fun le16(b: ByteArray, at: Int) = (b[at].toInt() and 0xFF) or ((b[at + 1].toInt() and 0xFF) shl 8)

    private fun le32(b: ByteArray, at: Int) =
        (b[at].toInt() and 0xFF) or ((b[at + 1].toInt() and 0xFF) shl 8) or
            ((b[at + 2].toInt() and 0xFF) shl 16) or ((b[at + 3].toInt() and 0xFF) shl 24)

    private fun le16Bytes(v: Int) = byteArrayOf((v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte())

    private fun le32Bytes(v: Int) = byteArrayOf(
        (v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte(), ((v shr 16) and 0xFF).toByte(), ((v shr 24) and 0xFF).toByte(),
    )
}
