package com.beeboentertainment.movie.core

/**
 * The decisions behind the player's "Sound" section, free of Android and Media3 so they can be unit
 * tested: what this device's speakers / HDMI receiver can take, what to ask the computer for, when a
 * choice needs a live conversion, and which rows the sheet shows.
 *
 * The computer does the heavy work (5.1 encoding, a proper stereo mix-down, night mode, an audio delay,
 * see desktop/apps/desktop/electron/hlsAudio.js); the phone or TV only says what it can play.
 */
enum class SoundMode(val id: String) {
    AUTO("auto"), STEREO("stereo"), SURROUND("surround");

    companion object {
        fun fromId(id: String?): SoundMode = entries.firstOrNull { it.id == id } ?: AUTO
    }
}

enum class DownmixStyle(val id: String) {
    STANDARD("standard"), DIALOGUE("dialogue");

    companion object {
        fun fromId(id: String?): DownmixStyle = entries.firstOrNull { it.id == id } ?: STANDARD
    }
}

/** Whether the app may send compressed audio (Dolby Digital, DTS...) to the TV or receiver untouched. */
enum class PassthroughSetting(val id: String) {
    AUTO("auto"), OFF("off");

    companion object {
        const val PREF_KEY = "audio_passthrough"
        fun fromId(id: String?): PassthroughSetting = entries.firstOrNull { it.id == id } ?: AUTO
    }
}

/** The remembered choices, per account, saved with the other playback prefs on the computer. */
data class SoundPrefs(
    val mode: SoundMode = SoundMode.AUTO,
    val downmix: DownmixStyle = DownmixStyle.STANDARD,
    val night: Boolean = false,
    val normalize: Boolean = false,
    val delayMs: Int = 0
) {
    companion object {
        const val DELAY_LIMIT_MS = 500
        fun clampDelay(ms: Int): Int = ms.coerceIn(-DELAY_LIMIT_MS, DELAY_LIMIT_MS)
    }
}

/**
 * What the device's audio output can take. [maxChannels] is what it plays as ordinary decoded sound
 * (2 for phone speakers and Bluetooth, 6 or 8 for a receiver that accepts multichannel PCM);
 * [passthroughCodecs] are the compressed formats it accepts as they are: "ac3", "eac3", "dts", "truehd".
 */
data class DeviceAudio(val maxChannels: Int = 2, val passthroughCodecs: Set<String> = emptySet()) {
    val passesDolby: Boolean get() = "ac3" in passthroughCodecs || "eac3" in passthroughCodecs
}

/** The audio part of a /api/playback/start request. Nulls are left out of the request entirely. */
data class SoundRequest(
    val audioMode: String?,
    val maxChannels: Int?,
    val codecs: List<String>?,
    val downmix: String?,
    val night: Boolean?,
    val normalize: Boolean?,
    val delayMs: Int?
)

object SoundRules {

    /** Output device types that only ever play stereo (AudioDeviceInfo.TYPE_* values). */
    private val STEREO_ONLY_TYPES = setOf(
        3,  // TYPE_WIRED_HEADSET
        4,  // TYPE_WIRED_HEADPHONES
        7,  // TYPE_BLUETOOTH_SCO
        8,  // TYPE_BLUETOOTH_A2DP
        11, // TYPE_USB_DEVICE
        22, // TYPE_USB_HEADSET
        26, // TYPE_BLE_HEADSET
        27, // TYPE_BLE_SPEAKER
        30  // TYPE_BLE_BROADCAST
    )

    /**
     * Headphones on the phone (or a Bluetooth speaker on a TV box) take the sound before an HDMI
     * receiver does, and they are stereo: so a connected one means stereo, whatever HDMI reports.
     */
    fun deviceFrom(maxChannels: Int, passthroughCodecs: Set<String>, connectedOutputTypes: Collection<Int>): DeviceAudio =
        if (connectedOutputTypes.any { it in STEREO_ONLY_TYPES }) DeviceAudio(2, emptySet())
        else DeviceAudio(maxChannels.coerceIn(2, 8), passthroughCodecs)

    /**
     * Surround is worth asking for when the device plays 6 or more decoded channels, or hands
     * Dolby Digital / Digital Plus to a receiver that mixes it. A device that does neither would
     * only flatten a 5.1 track itself, badly, so the computer's own stereo mix-down is better.
     */
    fun surroundCapable(device: DeviceAudio, passthrough: PassthroughSetting): Boolean =
        device.maxChannels >= 6 || (passthrough != PassthroughSetting.OFF && device.passesDolby)

    /** What to send with /api/playback/start. */
    fun request(prefs: SoundPrefs, passthrough: PassthroughSetting, device: DeviceAudio): SoundRequest {
        val hdmi = if (passthrough == PassthroughSetting.OFF) emptySet() else device.passthroughCodecs
        val codecs = buildList {
            add("aac")
            if ("ac3" in hdmi) add("ac3")
            if ("eac3" in hdmi) add("eac3")
        }
        val capable = surroundCapable(device, passthrough)
        val channels = when {
            prefs.mode == SoundMode.SURROUND -> maxOf(6, device.maxChannels)
            capable -> maxOf(6, device.maxChannels)
            else -> 2
        }
        val mode = if (prefs.mode == SoundMode.STEREO) "stereo" else "auto"
        return SoundRequest(
            audioMode = mode,
            maxChannels = if (mode == "stereo") null else channels,
            codecs = if (mode == "stereo") null else codecs,
            downmix = if (prefs.downmix == DownmixStyle.DIALOGUE) "dialogue" else null,
            night = if (prefs.night) true else null,
            normalize = if (prefs.normalize) true else null,
            delayMs = if (prefs.delayMs != 0) SoundPrefs.clampDelay(prefs.delayMs) else null
        )
    }

    /**
     * Does a sound choice need the computer to convert (rather than play the original file as it is)?
     * Only things the computer can do to the sound: night mode, levelling, a delay, or a stereo mix-down
     * (chosen explicitly) of a track with more than two channels.
     */
    fun needsConversion(prefs: SoundPrefs, trackChannels: Int?): Boolean {
        if (prefs.night || prefs.normalize || prefs.delayMs != 0) return true
        val wide = (trackChannels ?: 0) > 2
        return wide && (prefs.mode == SoundMode.STEREO || prefs.downmix == DownmixStyle.DIALOGUE)
    }

    /** Words for a channel count: "Mono", "Stereo", "5.1", "7.1", "6 channels". */
    fun channelWords(channels: Int?): String = when (channels) {
        null, 0 -> ""
        1 -> "Mono"
        2 -> "Stereo"
        6 -> "5.1"
        8 -> "7.1"
        else -> "$channels channels"
    }

    /** "Surround 5.1 · Dolby Digital" for a track played as it is. Never says more than the file carries. */
    fun originalWords(codecWords: String, channels: Int?): String {
        val n = channels ?: 0
        val layout = channelWords(channels)
        val head = when {
            n <= 0 -> "Audio"
            n <= 2 -> layout
            else -> "Surround $layout"
        }
        return if (codecWords.isBlank()) head else "$head · $codecWords"
    }

    /** The codec names the desktop uses, for the "now playing" line of a file played as it is. */
    fun codecWords(codec: String?): String = when (codec?.lowercase()) {
        "aac" -> "AAC"
        "ac3" -> "Dolby Digital"
        "eac3" -> "Dolby Digital Plus"
        "dts" -> "DTS"
        "truehd" -> "Dolby TrueHD"
        "mp3" -> "MP3"
        "opus" -> "Opus"
        "vorbis" -> "Vorbis"
        "flac" -> "FLAC"
        "alac" -> "Apple Lossless"
        null, "" -> ""
        else -> codec.uppercase()
    }

    val DELAY_STEPS = listOf(-250, -100, 0, 100, 250)

    /** The sheet's "Sound" section. [now] is the plain-words line for what is playing (label, detail). */
    fun section(
        prefs: SoundPrefs,
        passthrough: PassthroughSetting,
        device: DeviceAudio,
        now: Pair<String, String>?,
        conversionAvailable: Boolean,
        anyWideTrack: Boolean,
        surroundAvailable: Boolean,
        offline: Boolean
    ): PlaybackSheetModel.Section {
        val rows = mutableListOf<PlaybackSheetModel.Row>()
        if (now != null) rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.INFO, "now", now.first, now.second, selected = false, enabled = false)
        val convOk = conversionAvailable && !offline
        val capable = surroundCapable(device, passthrough)
        rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.SOUND_MODE, SoundMode.AUTO.id, "Auto",
            if (capable) "Surround, this device can play it" else "Stereo, this device plays stereo",
            prefs.mode == SoundMode.AUTO)
        rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.SOUND_MODE, SoundMode.STEREO.id, "Stereo", "Always two channels", prefs.mode == SoundMode.STEREO,
            enabled = convOk || !anyWideTrack)
        if (surroundAvailable) {
            rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.SOUND_MODE, SoundMode.SURROUND.id, "Surround", "5.1 when the film has it", prefs.mode == SoundMode.SURROUND, enabled = convOk)
        }
        if (anyWideTrack) {
            rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.DOWNMIX, DownmixStyle.STANDARD.id, "Stereo mix-down: standard", "", prefs.downmix == DownmixStyle.STANDARD)
            rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.DOWNMIX, DownmixStyle.DIALOGUE.id, "Stereo mix-down: dialogue focus", if (convOk) "Speech about 3 dB louder" else "Needs your computer to convert",
                prefs.downmix == DownmixStyle.DIALOGUE, enabled = convOk)
        }
        rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.NIGHT, "night", "Night mode", if (convOk) (if (prefs.night) "On, quieter explosions" else "Off") else "Needs your computer to convert",
            prefs.night, enabled = convOk)
        rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.NORMALIZE, "normalize", "Volume levelling", if (convOk) (if (prefs.normalize) "On" else "Off") else "Needs your computer to convert",
            prefs.normalize, enabled = convOk)
        rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.PASSTHROUGH, PassthroughSetting.AUTO.id, "HDMI passthrough: Auto",
            when {
                device.passthroughCodecs.isEmpty() -> "This device reports no Dolby or DTS passthrough"
                else -> "Sends ${passthroughWords(device)} to your TV or receiver untouched"
            }, passthrough == PassthroughSetting.AUTO)
        rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.PASSTHROUGH, PassthroughSetting.OFF.id, "HDMI passthrough: Off", "Always decode the sound on this device", passthrough == PassthroughSetting.OFF)
        for (ms in DELAY_STEPS) {
            val label = when {
                ms == 0 -> "Audio delay: none"
                ms < 0 -> "Audio delay: sound earlier by ${-ms} ms"
                else -> "Audio delay: sound later by $ms ms"
            }
            rows += PlaybackSheetModel.Row(PlaybackSheetModel.Action.DELAY, ms.toString(), label, if (ms == 0 || convOk) "" else "Needs your computer to convert", prefs.delayMs == ms, enabled = ms == 0 || convOk)
        }
        return PlaybackSheetModel.Section("Sound", rows)
    }

    fun passthroughWords(device: DeviceAudio): String {
        val names = buildList {
            if ("ac3" in device.passthroughCodecs) add("Dolby Digital")
            if ("eac3" in device.passthroughCodecs) add("Dolby Digital Plus")
            if ("dts" in device.passthroughCodecs) add("DTS")
            if ("truehd" in device.passthroughCodecs) add("Dolby TrueHD")
        }
        return names.joinToString(", ").ifBlank { "compressed audio" }
    }
}
