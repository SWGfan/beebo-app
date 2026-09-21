package com.beeboentertainment.movie.player

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.view.Display
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioCapabilities
import com.beeboentertainment.movie.core.AudioFormatCaps
import com.beeboentertainment.movie.core.DeviceCaps
import com.beeboentertainment.movie.core.DeviceProfileBuilder
import com.beeboentertainment.movie.core.PassthroughSetting
import com.beeboentertainment.movie.core.TvDetection
import com.beeboentertainment.movie.core.VideoDecoderCaps
import kotlinx.serialization.json.JsonObject

/**
 * Reads what this Android TV / Fire TV / phone can decode and show, for the declaration sent to
 * `POST /api/playback/negotiate` (core/HomeTheater.kt builds it; docs/HOME-THEATER.md describes it).
 *
 * Sources: MediaCodecList (which decoders exist), Display.HdrCapabilities (what the screen accepts),
 * Media3's AudioCapabilities (what the HDMI receiver accepts as a bitstream, the same object the
 * player's own audio sink follows) and the HDMI-passthrough setting. No Google Play services are used (the amazon flavor needs none).
 *
 * UNVERIFIED on real devices: this code has only ever compiled, nobody has read what it returns on a Shield,
 * a Fire TV or a Google TV. TrueHD / DTS passthrough stay OFF unless the audio output reports them.
 */
@UnstableApi
object DeviceProfileProbe {

    /** What the computer is told, as JSON, and the client name it goes with. */
    class Declaration(val client: String, val profile: JsonObject, val summary: String)

    fun declaration(context: Context, passthrough: PassthroughSetting): Declaration {
        val caps = read(context, passthrough)
        val profile = DeviceProfileBuilder.build(caps)
        return Declaration(caps.client, profile, DeviceProfileBuilder.summary(profile))
    }

    fun read(context: Context, passthrough: PassthroughSetting): DeviceCaps {
        val decoders = runCatching { MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder } }.getOrDefault(emptyList())

        val h264 = videoCaps(decoders, "video/avc") { p ->
            when (p) {
                1 -> "baseline"   // AVCProfileBaseline
                2 -> "main"       // AVCProfileMain
                8 -> "high"       // AVCProfileHigh
                16 -> "high10"    // AVCProfileHigh10
                else -> null
            }
        }
        val hevc = videoCaps(decoders, "video/hevc") { p ->
            when (p) {
                1 -> "main"                         // HEVCProfileMain
                2, 0x1000, 0x2000 -> "main10"       // HEVCProfileMain10, ...Main10HDR10, ...Main10HDR10Plus
                else -> null
            }
        }
        val vp9 = videoCaps(decoders, "video/x-vnd.on2.vp9") { p ->
            when (p) {
                1 -> "profile0"                     // VP9Profile0
                4, 0x1000, 0x2000 -> "profile2"     // VP9Profile2, ...HDR, ...HDR10Plus
                else -> null
            }
        }
        val av1 = videoCaps(decoders, "video/av01") { p ->
            when (p) {
                1, 2, 0x1000, 0x2000 -> "main"      // AV1ProfileMain8 / Main10 / Main10HDR10 / Main10HDR10Plus
                else -> null
            }
        }?.let { d ->
            // 10-bit only when a Main10 profile is really listed.
            val ten = decoders.any { info -> hardwareLike(info) && profileInts(info, "video/av01").any { it == 2 || it == 0x1000 || it == 0x2000 } }
            d.copy(bitDepths = if (ten) listOf(8, 10) else listOf(8))
        }
        val video = buildMap<String, VideoDecoderCaps> {
            h264?.let { put("h264", it) }
            hevc?.let { put("hevc", it) }
            vp9?.let { put("vp9", it) }
            av1?.let { put("av1", it) }
        }

        val fourK = listOf("video/hevc", "video/avc").any { mime -> decoders.any { hardwareLike(it) && supportsSize(it, mime, 3840, 2160) } }

        // Screen HDR types (Display.HdrCapabilities.HDR_TYPE_*): 1 Dolby Vision, 2 HDR10, 3 HLG, 4 HDR10+.
        val hdrTypes = screenHdrTypes(context)
        val hevcMain10 = hevc?.profiles?.contains("main10") == true
        val dvProfiles = if (1 in hdrTypes) dolbyVisionProfiles(decoders) else emptyList()
        val hdr10 = 2 in hdrTypes && hevcMain10

        val audio = audioFormats(context, decoders, passthrough)
        val output = runCatching { AudioCapabilities.getCapabilities(context, AudioAttributes.DEFAULT, null).maxChannelCount }.getOrDefault(2)

        return DeviceCaps(
            client = clientName(context),
            name = Build.MODEL.orEmpty().take(60),
            video = video,
            maxHeight = if (fourK) 2160 else 1080,
            hdr10 = hdr10,
            hdr10Plus = 4 in hdrTypes && hevcMain10,
            hlg = 3 in hdrTypes && hevcMain10,
            dolbyVisionProfiles = dvProfiles,
            // Media3 is expected to play the HDR10 / HLG base layer of a profile 8 file on its HEVC decoder: not checked on a device.
            dvFallback = hdr10 && 8 !in dvProfiles,
            audio = audio,
            maxAudioChannels = output.coerceIn(2, 8)
        )
    }

    // ------------------------------------------------------------------ pieces

    private fun clientName(context: Context): String {
        val pm = context.packageManager
        val fire = runCatching { pm.hasSystemFeature(TvDetection.FIRE_TV_FEATURE) }.getOrDefault(false)
        val tv = runCatching { pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) }.getOrDefault(false)
        return when {
            fire -> "firetv"
            tv -> "androidtv"
            else -> "android"
        }
    }

    /** A decoder that is real hardware, not the software reference codec (which cannot play big pictures). */
    private fun hardwareLike(info: MediaCodecInfo): Boolean =
        if (Build.VERSION.SDK_INT >= 29) info.isHardwareAccelerated
        else !info.name.startsWith("OMX.google.") && !info.name.startsWith("c2.android.")

    private fun profileInts(info: MediaCodecInfo, mime: String): List<Int> =
        runCatching { info.getCapabilitiesForType(mime).profileLevels.map { it.profile } }.getOrDefault(emptyList())

    private fun supportsSize(info: MediaCodecInfo, mime: String, w: Int, h: Int): Boolean =
        runCatching { info.getCapabilitiesForType(mime).videoCapabilities?.isSizeSupported(w, h) == true }.getOrDefault(false)

    /** Null when no hardware decoder for [mime] exists. */
    private fun videoCaps(decoders: List<MediaCodecInfo>, mime: String, name: (Int) -> String?): VideoDecoderCaps? {
        val forMime = decoders.filter { info -> info.supportedTypes.any { it.equals(mime, ignoreCase = true) } && hardwareLike(info) }
        if (forMime.isEmpty()) return null
        val ints = forMime.flatMap { profileInts(it, mime) }
        var names = ints.mapNotNull(name).distinct()
        if (names.isEmpty()) {
            // A decoder that lists no profile we know: say only the base one, never more than was reported.
            names = when (mime) {
                "video/avc" -> listOf("baseline", "main", "high")
                "video/hevc" -> listOf("main")
                "video/x-vnd.on2.vp9" -> listOf("profile0")
                else -> listOf("main")
            }
        }
        val ten = names.any { it == "main10" || it == "high10" || it == "profile2" }
        return VideoDecoderCaps(names, if (ten) listOf(8, 10) else listOf(8))
    }

    @Suppress("DEPRECATION")
    private fun screenHdrTypes(context: Context): List<Int> = runCatching {
        val dm = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        dm.getDisplay(Display.DEFAULT_DISPLAY)?.hdrCapabilities?.supportedHdrTypes?.toList().orEmpty()
    }.getOrDefault(emptyList())

    /** Dolby Vision profile numbers the device's Dolby Vision decoder lists (DolbyVisionProfileDvheStn = 5, DvheDtb = 7, DvheSt = 8). */
    private fun dolbyVisionProfiles(decoders: List<MediaCodecInfo>): List<Int> {
        val mime = "video/dolby-vision"
        val ints = decoders.filter { info -> info.supportedTypes.any { it.equals(mime, ignoreCase = true) } && hardwareLike(info) }
            .flatMap { profileInts(it, mime) }
        return ints.mapNotNull { p ->
            when (p) {
                0x20 -> 5
                0x80 -> 7
                0x100 -> 8
                else -> null
            }
        }.distinct().sorted()
    }

    private fun audioFormats(context: Context, decoders: List<MediaCodecInfo>, setting: PassthroughSetting): Map<String, AudioFormatCaps> {
        val caps = runCatching { AudioCapabilities.getCapabilities(context, AudioAttributes.DEFAULT, null) }.getOrNull()
        // With "HDMI passthrough: Off" nothing is sent to the receiver as a bitstream, whatever it accepts.
        fun pass(encoding: Int): Boolean = setting != PassthroughSetting.OFF && caps?.supportsEncoding(encoding) == true
        fun decodes(mime: String): Boolean = decoders.any { info -> info.supportedTypes.any { it.equals(mime, ignoreCase = true) } }

        val out = LinkedHashMap<String, AudioFormatCaps>()
        fun add(key: String, f: AudioFormatCaps) { if (f.listed) out[key] = f }
        add("aac", AudioFormatCaps(decode = decodes("audio/mp4a-latm"), passthrough = false))
        add("ac3", AudioFormatCaps(decode = decodes("audio/ac3"), passthrough = pass(C.ENCODING_AC3)))
        add("eac3", AudioFormatCaps(decode = decodes("audio/eac3"), passthrough = pass(C.ENCODING_E_AC3), atmos = pass(C.ENCODING_E_AC3_JOC)))
        // Off unless the audio output reports the bitstream: the receiver then renders it (TrueHD carries Atmos objects as they are).
        val truehd = pass(C.ENCODING_DOLBY_TRUEHD)
        add("truehd", AudioFormatCaps(decode = decodes("audio/true-hd"), passthrough = truehd, atmos = truehd))
        add("dts", AudioFormatCaps(decode = decodes("audio/vnd.dts"), passthrough = pass(C.ENCODING_DTS)))
        add("dtshd", AudioFormatCaps(decode = decodes("audio/vnd.dts.hd"), passthrough = pass(C.ENCODING_DTS_HD)))
        add("flac", AudioFormatCaps(decode = decodes("audio/flac"), passthrough = false))
        add("opus", AudioFormatCaps(decode = decodes("audio/opus"), passthrough = false))
        add("mp3", AudioFormatCaps(decode = decodes("audio/mpeg"), passthrough = false))
        add("vorbis", AudioFormatCaps(decode = decodes("audio/vorbis"), passthrough = false))
        return out
    }
}
