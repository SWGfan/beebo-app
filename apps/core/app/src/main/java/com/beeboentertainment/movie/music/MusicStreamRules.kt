package com.beeboentertainment.movie.music

import com.beeboentertainment.movie.core.UrlUtils

/**
 * What the Music player asks the computer for, in plain rules (unit tested):
 *  - which formats this device can decode, so the computer converts only the rest
 *    (FLAC on an older phone, Apple Lossless almost everywhere);
 *  - which quality: the original at home, the owner's choice away from home to save data.
 */
object MusicStreamRules {

    /** Qualities, best first; the words the server reads in ?quality=. */
    val QUALITIES = listOf("original", "high", "medium", "low")
    const val DEFAULT_AWAY_QUALITY = "medium"
    const val DEFAULT_HOME_QUALITY = "original"

    fun qualityLabel(q: String): String = when (q) {
        "high" -> "High (256 kbps)"
        "medium" -> "Normal (160 kbps)"
        "low" -> "Data saver (96 kbps)"
        else -> "Original"
    }

    /** Decoder MIME types (MediaCodecList) to the codec names the server uses. */
    private val MIME_TO_CODEC = mapOf(
        "audio/mpeg" to "mp3",
        "audio/mp4a-latm" to "aac",
        "audio/flac" to "flac",
        "audio/opus" to "opus",
        "audio/vorbis" to "vorbis",
        "audio/alac" to "alac",
        "audio/raw" to "pcm",
        "audio/mpeg-l2" to "mp2"
    )

    /**
     * The formats to tell the server about. MP3, AAC and WAV play on every Android device, and
     * Media3 decodes WAV itself, so those are always listed whatever the codec list says.
     */
    fun codecsFor(decoderMimes: Collection<String>): List<String> {
        val found = decoderMimes.mapNotNull { MIME_TO_CODEC[it.lowercase()] }.toSet()
        return (setOf("mp3", "aac", "pcm") + found).sortedBy { listOf("mp3", "aac", "flac", "alac", "opus", "vorbis", "pcm", "mp2").indexOf(it) }
    }

    fun qualityFor(away: Boolean, homeQuality: String, awayQuality: String): String =
        (if (away) awayQuality else homeQuality).takeIf { it in QUALITIES } ?: "original"

    /** True for a song stream on this server (only those get the bearer token and the options). */
    fun isMusicStream(url: String, baseUrl: String?): Boolean {
        val base = baseUrl?.trimEnd('/') ?: return false
        if (!url.startsWith("$base/")) return false
        return Regex("""/api/music/track/[a-f0-9]{20}/stream(\?.*)?$""").containsMatchIn(url.substring(base.length))
    }

    /**
     * The stream URL with what this device can play and the quality added. Options already on the
     * URL are replaced, so resolving twice gives the same answer.
     */
    fun withOptions(url: String, codecs: List<String>, quality: String): String {
        val q = url.indexOf('?')
        val path = if (q >= 0) url.substring(0, q) else url
        val kept = if (q >= 0) url.substring(q + 1).split('&').filter {
            it.isNotBlank() && !it.startsWith("codecs=") && !it.startsWith("quality=")
        } else emptyList()
        val added = buildList {
            if (codecs.isNotEmpty()) add("codecs=" + UrlUtils.encode(codecs.joinToString(",")))
            if (quality != "original") add("quality=" + UrlUtils.encode(quality))
        }
        val all = kept + added
        return if (all.isEmpty()) path else path + "?" + all.joinToString("&")
    }
}
