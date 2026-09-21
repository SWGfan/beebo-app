package com.beeboentertainment.movie.player

import android.content.Context
import android.media.AudioManager
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import com.beeboentertainment.movie.core.DeviceAudio
import com.beeboentertainment.movie.core.SoundRules

/**
 * Sound output for the phone and TV player.
 *
 * ExoPlayer already sends Dolby Digital / Digital Plus / DTS / TrueHD to an HDMI receiver as a
 * bitstream when the device reports it can (DefaultAudioSink built from a Context follows the HDMI
 * capabilities live). What was missing is a way to switch that off, a report of what the device
 * really accepts, and a truthful line about what is happening. That is what this file adds:
 *
 *  - [BeeboRenderersFactory]: the stock DefaultRenderersFactory whose sink refuses compressed
 *    formats when the "HDMI passthrough: Off" setting is on, so they are decoded here instead.
 *  - [DeviceAudioProbe]: what this device's output takes (channels, passthrough formats), used to
 *    tell the computer what to send.
 *  - [AudioOutputState]: what the audio track actually became (bitstream to HDMI, or decoded PCM),
 *    so the sheet never claims a passthrough that did not happen.
 *
 * Decoders: no FFmpeg audio decoder is bundled. Media3's FFmpeg extension is LGPL but has to be
 * built from source with native code, which would add several MB per ABI and a source-offer
 * obligation. DTS and TrueHD tracks the device cannot decode or pass through are converted to
 * Dolby Digital Plus, Dolby Digital or AAC by the computer instead (see hlsAudio.js). To add it
 * later: build media3's decoder_ffmpeg module, add it as a dependency, and set
 * setExtensionRendererMode(EXTENSION_RENDERER_MODE_ON) on [BeeboRenderersFactory].
 */
@UnstableApi
class BeeboRenderersFactory(
    context: Context,
    private val passthroughEnabled: () -> Boolean
) : DefaultRenderersFactory(context) {

    init {
        // A device without a decoder for a format tries the next decoder the platform lists.
        setEnableDecoderFallback(true)
    }

    override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink {
        val sink = DefaultAudioSink.Builder(context)
            .setEnableFloatOutput(enableFloatOutput)
            .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
            .build()
        return PassthroughGate(sink, passthroughEnabled)
    }
}

/** Says "not supported" for compressed audio while passthrough is off, so the renderer decodes it. */
@UnstableApi
internal class PassthroughGate(sink: AudioSink, private val passthroughEnabled: () -> Boolean) : ForwardingAudioSink(sink) {

    private fun blocked(format: Format): Boolean = PassthroughRule.blocks(passthroughEnabled(), format.sampleMimeType)

    override fun supportsFormat(format: Format): Boolean = if (blocked(format)) false else super.supportsFormat(format)

    override fun getFormatSupport(format: Format): Int =
        if (blocked(format)) AudioSink.SINK_FORMAT_UNSUPPORTED else super.getFormatSupport(format)
}

internal object PassthroughRule {
    /** With passthrough off, every compressed format is refused so the renderer decodes it; PCM is never refused. */
    fun blocks(passthroughEnabled: Boolean, sampleMimeType: String?): Boolean {
        if (passthroughEnabled) return false
        val mime = sampleMimeType ?: return false
        return mime != MimeTypes.AUDIO_RAW
    }
}

@UnstableApi
object DeviceAudioProbe {

    /** What the audio output can play right now (HDMI receiver, TV speakers, headphones). */
    fun read(context: Context): DeviceAudio {
        val caps = runCatching { AudioCapabilities.getCapabilities(context, AudioAttributes.DEFAULT, null) }.getOrNull()
        val codecs = buildSet {
            if (caps != null) {
                if (caps.supportsEncoding(C.ENCODING_AC3)) add("ac3")
                if (caps.supportsEncoding(C.ENCODING_E_AC3)) add("eac3")
                if (caps.supportsEncoding(C.ENCODING_DTS) || caps.supportsEncoding(C.ENCODING_DTS_HD)) add("dts")
                if (caps.supportsEncoding(C.ENCODING_DOLBY_TRUEHD)) add("truehd")
            }
        }
        val routes = runCatching {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }
        }.getOrDefault(emptyList())
        return SoundRules.deviceFrom(caps?.maxChannelCount ?: 2, codecs, routes)
    }
}

/**
 * What the last audio track really became. Written by the playback service's listener, read by the
 * sheet. A bitstream encoding means the receiver is decoding it; PCM means this device did.
 */
object AudioOutputState {
    @Volatile var encoding: Int = C.ENCODING_INVALID
    @Volatile var outputChannels: Int = 0
    @Volatile var inputChannels: Int = 0

    fun reset() {
        encoding = C.ENCODING_INVALID
        outputChannels = 0
        inputChannels = 0
    }

    @UnstableApi
    val listener = object : AnalyticsListener {
        override fun onAudioTrackInitialized(eventTime: AnalyticsListener.EventTime, audioTrackConfig: AudioSink.AudioTrackConfig) {
            encoding = audioTrackConfig.encoding
            outputChannels = Integer.bitCount(audioTrackConfig.channelConfig)
        }

        override fun onAudioInputFormatChanged(eventTime: AnalyticsListener.EventTime, format: Format, decoderReuseEvaluation: androidx.media3.exoplayer.DecoderReuseEvaluation?) {
            inputChannels = format.channelCount.takeIf { it > 0 } ?: 0
        }

        override fun onAudioTrackReleased(eventTime: AnalyticsListener.EventTime, audioTrackConfig: AudioSink.AudioTrackConfig) {
            encoding = C.ENCODING_INVALID
        }
    }

    /** Plain words for what reached the output, or null before anything played. Honest: says PCM when it is PCM. */
    fun words(encoding: Int = this.encoding, output: Int = outputChannels, input: Int = inputChannels): String? {
        val bitstream = when (encoding) {
            C.ENCODING_AC3 -> "Dolby Digital"
            C.ENCODING_E_AC3, C.ENCODING_E_AC3_JOC -> "Dolby Digital Plus"
            C.ENCODING_DTS -> "DTS"
            C.ENCODING_DTS_HD -> "DTS-HD"
            C.ENCODING_DOLBY_TRUEHD -> "Dolby TrueHD"
            else -> null
        }
        if (bitstream != null) {
            val ch = if (input > 0) " (${SoundRules.channelWords(input)})" else ""
            return "Sent to your TV or receiver as $bitstream$ch, undecoded"
        }
        val isPcm = encoding == C.ENCODING_PCM_16BIT || encoding == C.ENCODING_PCM_FLOAT || encoding == C.ENCODING_PCM_24BIT || encoding == C.ENCODING_PCM_32BIT
        if (!isPcm) return null
        val words = SoundRules.channelWords(output.takeIf { it > 0 } ?: input)
        return if (words.isBlank()) "Decoded on this device" else "Decoded on this device, $words output"
    }
}
