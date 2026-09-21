package com.beeboentertainment.movie.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * The home-theatre side of playback (docs/HOME-THEATER.md): what this device can decode and show, as the
 * declaration the computer reads (`deviceProfile` in `POST /api/playback/negotiate`, format owned by
 * desktop/apps/desktop/electron/deviceProfile.js), and the rules for following the plan it answers with.
 *
 * Free of Android types so it is unit tested on the JVM. The values come from `player/DeviceProfileProbe.kt`
 * (MediaCodecList, Display.HdrCapabilities, Media3's AudioCapabilities).
 *
 * HONESTY: the computer trusts this declaration, so a claim that is not true means a picture that does not play.
 *  - A video format is listed only when a hardware decoder for it exists; HDR only when the screen reports it AND the
 *    HEVC Main 10 decoder exists; Dolby Vision only for the profiles a Dolby Vision decoder lists.
 *  - Compressed sound (Dolby Digital, Digital Plus, TrueHD, DTS, DTS-HD) is passed to the receiver only when
 *    the audio output reports it (and the person's "HDMI passthrough" setting is not Off). TrueHD and DTS are therefore OFF
 *    unless detected, and DTS:X is never claimed.
 *  - Atmos only where the output reports the E-AC-3 JOC encoding (TrueHD rides as a bitstream when passed through).
 */
data class VideoDecoderCaps(val profiles: List<String>, val bitDepths: List<Int>)

/** One sound format: the device decodes it itself, and / or passes the bitstream to a receiver. */
data class AudioFormatCaps(val decode: Boolean, val passthrough: Boolean, val atmos: Boolean = false) {
    val listed: Boolean get() = decode || passthrough
}

data class DeviceCaps(
    /** "androidtv" | "firetv" | "android" (the names the computer knows). */
    val client: String,
    val name: String = "",
    /** By codec key: "h264", "hevc", "vp9", "av1". A codec with no hardware decoder is simply absent. */
    val video: Map<String, VideoDecoderCaps> = emptyMap(),
    val maxHeight: Int = 1080,
    val hdr10: Boolean = false,
    val hdr10Plus: Boolean = false,
    val hlg: Boolean = false,
    val dolbyVisionProfiles: List<Int> = emptyList(),
    /** The player itself plays the HDR10 / HLG base layer of a Dolby Vision profile 8 file (Media3 is expected to; unverified). */
    val dvFallback: Boolean = false,
    /** By format key: aac ac3 eac3 truehd dts dtshd flac opus mp3 vorbis. */
    val audio: Map<String, AudioFormatCaps> = emptyMap(),
    /** What the current output plays as decoded sound (2 for TV speakers, 6 or 8 behind a receiver). */
    val maxAudioChannels: Int = 2
)

object DeviceProfileBuilder {
    const val VERSION = 1

    private val ORDER = listOf("aac", "ac3", "eac3", "truehd", "dts", "dtshd", "flac", "opus", "mp3", "vorbis")

    fun build(caps: DeviceCaps): JsonObject = buildJsonObject {
        put("v", VERSION)
        put("client", caps.client)
        if (caps.name.isNotBlank()) put("name", caps.name.take(60))

        if (caps.video.isNotEmpty()) {
            putJsonObject("video") {
                for ((codec, d) in caps.video) {
                    putJsonObject(codec) {
                        putJsonArray("profiles") { d.profiles.forEach { add(it) } }
                        putJsonArray("bitDepths") { d.bitDepths.forEach { add(it) } }
                    }
                }
            }
        }

        putJsonArray("hdr") {
            if (caps.hdr10) add("hdr10")
            if (caps.hdr10Plus) add("hdr10plus")
            if (caps.hlg) add("hlg")
            if (caps.dolbyVisionProfiles.isNotEmpty()) add("dv:" + caps.dolbyVisionProfiles.distinct().sorted().joinToString(","))
            if (caps.dvFallback) add("dvfallback")
        }

        if (caps.maxHeight >= 2160) {
            put("maxHeight", 2160)
            put("maxWidth", 3840)
        } else {
            put("maxHeight", 1080)
        }

        val listed = ORDER.filter { caps.audio[it]?.listed == true }
        if (listed.isNotEmpty()) {
            putJsonObject("audio") {
                for (key in listed) {
                    val f = caps.audio.getValue(key)
                    putJsonObject(key) {
                        put("maxChannels", channelsFor(key, f, caps.maxAudioChannels))
                        if (f.passthrough) put("passthrough", true)
                        if (!f.decode) put("decode", false)
                        if (f.atmos) put("atmos", true)
                    }
                }
            }
            val passesAny = listed.any { caps.audio.getValue(it).passthrough }
            put("maxAudioChannels", if (passesAny) maxOf(caps.maxAudioChannels, 6).coerceAtMost(8) else caps.maxAudioChannels.coerceIn(2, 8))
        }

        // Media3's extractors open these as they are; the streaming formats are its HLS support.
        putJsonArray("containers") { listOf("mp4", "mkv", "ts", "webm").forEach { add(it) } }
        putJsonArray("streaming") { listOf("hls-ts", "hls-fmp4").forEach { add(it) } }
        // The app shows sidecar WebVTT and embedded text tracks; picture subtitles (PGS, VobSub) are burnt in by the computer.
        putJsonArray("subtitles") { listOf("vtt", "srt").forEach { add(it) } }
    }

    private fun channelsFor(key: String, f: AudioFormatCaps, output: Int): Int = when {
        // A bitstream handed to a receiver is not limited by this device's own decoded channel count.
        f.passthrough && !f.decode -> 8
        key == "aac" || key == "ac3" -> minOf(6, output.coerceAtLeast(2))
        key == "eac3" -> output.coerceIn(2, 8)
        else -> 2
    }

    /** A short line for diagnostics: "hevc h264 · hdr10 hlg · 2160p". */
    fun summary(profile: JsonObject): String {
        val video = (profile["video"] as? JsonObject)?.keys?.sorted()?.joinToString(" ") ?: "default"
        val hdr = (profile["hdr"] as? kotlinx.serialization.json.JsonArray)?.joinToString(" ") { it.toString().trim('"') }.orEmpty().ifBlank { "SDR" }
        val height = profile["maxHeight"]?.toString()?.let { "${it}p" }.orEmpty()
        return listOf(video, hdr, height).filter { it.isNotBlank() }.joinToString(" · ")
    }
}

/** The three ways a title reaches the screen. */
enum class PlayMethod(val wire: String, val label: String) {
    /** The original file, as it is. */
    DIRECT_PLAY("DirectPlay", "Direct play"),
    /** The picture (HDR and Dolby Vision included) copied into fragmented-MP4 HLS. */
    DIRECT_STREAM("DirectStream", "Direct stream"),
    /** The live H.264 / AAC conversion. */
    TRANSCODE("Transcode", "Converted");

    companion object {
        fun fromWire(text: String?): PlayMethod? = entries.firstOrNull { it.wire == text }
    }
}

object HomeTheaterRules {
    const val MAX_PREPARE_TRIES = 4
    const val PREPARE_MIN_MS = 1_000L
    const val PREPARE_MAX_MS = 10_000L

    /**
     * Whether to ask the computer how to play the original. Only a server that has the route (the `homeTheater` block of
     * `/api/playback/info`), only when the original is what would play (an explicit conversion is left alone), never while casting
     * (the declaration describes this device, not the cast receiver), and not when a picture subtitle has to be burnt in
     * (that needs the conversion, which the existing path already asks for).
     */
    fun shouldNegotiate(serverHasRoute: Boolean, wantsOriginal: Boolean, casting: Boolean, burningSubtitle: Boolean): Boolean =
        serverHasRoute && wantsOriginal && !casting && !burningSubtitle

    /**
     * Only the three plans on their own routes are followed: an answer that points anywhere else is ignored (the original keeps
     * playing), so a wrong or hostile reply can never send the player somewhere unexpected.
     */
    fun followable(method: PlayMethod?, url: String): Boolean {
        if (method == null || url.isEmpty() || !url.startsWith("/")) return false
        if (url.startsWith("//") || url.contains('\\') || url.contains("..") || url.any { it.isISOControl() }) return false
        return when (method) {
            PlayMethod.DIRECT_PLAY -> url.startsWith("/file?") || url.startsWith("/tvfile?")
            PlayMethod.DIRECT_STREAM, PlayMethod.TRANSCODE -> url.startsWith("/hls/") && url.contains(".m3u8")
        }
    }

    /** 503 `preparing` -> how long to wait before asking again. */
    fun prepareWaitMs(retryAfterSec: Double?): Long =
        (((retryAfterSec ?: 3.0) * 1000).toLong()).coerceIn(PREPARE_MIN_MS, PREPARE_MAX_MS)
}
