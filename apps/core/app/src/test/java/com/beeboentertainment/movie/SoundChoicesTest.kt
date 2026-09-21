package com.beeboentertainment.movie

import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import com.beeboentertainment.movie.core.DeviceAudio
import com.beeboentertainment.movie.core.DownmixStyle
import com.beeboentertainment.movie.core.PassthroughSetting
import com.beeboentertainment.movie.core.PlaybackSheetModel
import com.beeboentertainment.movie.core.QualityChoice
import com.beeboentertainment.movie.core.SoundMode
import com.beeboentertainment.movie.core.SoundPrefs
import com.beeboentertainment.movie.core.SoundRules
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.AudioCapsRequest
import com.beeboentertainment.movie.data.PlaybackInfo
import com.beeboentertainment.movie.data.PlaybackPrefsUpdate
import com.beeboentertainment.movie.data.PlaybackStartRequest
import com.beeboentertainment.movie.data.PlaybackStartResponse
import com.beeboentertainment.movie.player.AudioOutputState
import com.beeboentertainment.movie.player.PassthroughRule
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SoundChoicesTest {

    private val stereoPhone = DeviceAudio(2, emptySet())
    private val receiver = DeviceAudio(8, setOf("ac3", "eac3", "dts", "truehd"))
    private val arcTv = DeviceAudio(2, setOf("ac3", "eac3"))
    private val pcmOnly51 = DeviceAudio(6, emptySet())

    /* ------------------------------------------------------------- parsing */

    @Test
    fun `unknown ids fall back to the safe default`() {
        assertEquals(SoundMode.AUTO, SoundMode.fromId(null))
        assertEquals(SoundMode.AUTO, SoundMode.fromId("garbage"))
        assertEquals(SoundMode.SURROUND, SoundMode.fromId("surround"))
        assertEquals(DownmixStyle.STANDARD, DownmixStyle.fromId("loud"))
        assertEquals(DownmixStyle.DIALOGUE, DownmixStyle.fromId("dialogue"))
        assertEquals(PassthroughSetting.AUTO, PassthroughSetting.fromId(""))
        assertEquals(PassthroughSetting.OFF, PassthroughSetting.fromId("off"))
    }

    @Test
    fun `delay is clamped to plus or minus 500 ms`() {
        assertEquals(500, SoundPrefs.clampDelay(9999))
        assertEquals(-500, SoundPrefs.clampDelay(-9999))
        assertEquals(120, SoundPrefs.clampDelay(120))
    }

    /* -------------------------------------------------------- device output */

    @Test
    fun `headphones or a Bluetooth speaker make the device stereo whatever HDMI reports`() {
        val a2dp = SoundRules.deviceFrom(8, setOf("eac3"), listOf(1, 8))
        assertEquals(DeviceAudio(2, emptySet()), a2dp)
        assertEquals(DeviceAudio(2, emptySet()), SoundRules.deviceFrom(8, setOf("ac3"), listOf(4)))
        assertEquals(DeviceAudio(2, emptySet()), SoundRules.deviceFrom(8, setOf("ac3"), listOf(22)))
        assertEquals(DeviceAudio(2, emptySet()), SoundRules.deviceFrom(6, setOf("ac3"), listOf(26)))
    }

    @Test
    fun `an HDMI receiver keeps what it reports, bounded to 2 to 8 channels`() {
        assertEquals(DeviceAudio(8, setOf("ac3", "eac3")), SoundRules.deviceFrom(8, setOf("ac3", "eac3"), listOf(9)))
        assertEquals(2, SoundRules.deviceFrom(0, emptySet(), emptyList()).maxChannels)
        assertEquals(8, SoundRules.deviceFrom(16, emptySet(), emptyList()).maxChannels)
        // Built-in speaker (2) and a wired HDMI sink (9) together are not stereo-only.
        assertEquals(6, SoundRules.deviceFrom(6, emptySet(), listOf(2, 9)).maxChannels)
    }

    @Test
    fun `surround is asked for only when the device can play or pass it on`() {
        assertFalse(SoundRules.surroundCapable(stereoPhone, PassthroughSetting.AUTO))
        assertTrue(SoundRules.surroundCapable(pcmOnly51, PassthroughSetting.AUTO))
        assertTrue(SoundRules.surroundCapable(pcmOnly51, PassthroughSetting.OFF))
        assertTrue(SoundRules.surroundCapable(arcTv, PassthroughSetting.AUTO), "a stereo-PCM TV that passes Dolby Digital is surround capable")
        assertFalse(SoundRules.surroundCapable(arcTv, PassthroughSetting.OFF), "with passthrough off it is only a stereo TV")
        assertTrue(SoundRules.surroundCapable(receiver, PassthroughSetting.OFF), "a receiver that takes 8 PCM channels still is")
        assertFalse(SoundRules.surroundCapable(DeviceAudio(2, setOf("dts", "truehd")), PassthroughSetting.AUTO), "DTS/TrueHD cannot ride in HLS, so they do not count")
    }

    private fun assertTrue(cond: Boolean, msg: String) = org.junit.Assert.assertTrue(msg, cond)
    private fun assertFalse(cond: Boolean, msg: String) = org.junit.Assert.assertFalse(msg, cond)

    /* ------------------------------------------------------------- request */

    @Test
    fun `a stereo phone asks for auto with two channels and AAC only`() {
        val r = SoundRules.request(SoundPrefs(), PassthroughSetting.AUTO, stereoPhone)
        assertEquals("auto", r.audioMode)
        assertEquals(2, r.maxChannels)
        assertEquals(listOf("aac"), r.codecs)
        assertNull(r.downmix); assertNull(r.night); assertNull(r.normalize); assertNull(r.delayMs)
    }

    @Test
    fun `an HDMI receiver asks for surround and lists the Dolby formats it accepts`() {
        val r = SoundRules.request(SoundPrefs(), PassthroughSetting.AUTO, receiver)
        assertEquals("auto", r.audioMode)
        assertEquals(8, r.maxChannels)
        assertEquals(listOf("aac", "ac3", "eac3"), r.codecs)
    }

    @Test
    fun `passthrough off never lists Dolby formats`() {
        val r = SoundRules.request(SoundPrefs(), PassthroughSetting.OFF, receiver)
        assertEquals(listOf("aac"), r.codecs)
        assertEquals("decoded PCM channels are still available", 8, r.maxChannels)
        val tv = SoundRules.request(SoundPrefs(), PassthroughSetting.OFF, arcTv)
        assertEquals(2, tv.maxChannels)
        assertEquals(listOf("aac"), tv.codecs)
    }

    @Test
    fun `a stereo-PCM TV that passes Dolby Digital gets a surround request with the Dolby codecs`() {
        val r = SoundRules.request(SoundPrefs(), PassthroughSetting.AUTO, arcTv)
        assertEquals(6, r.maxChannels)
        assertEquals(listOf("aac", "ac3", "eac3"), r.codecs)
    }

    @Test
    fun `explicit stereo sends no capabilities at all`() {
        val r = SoundRules.request(SoundPrefs(mode = SoundMode.STEREO), PassthroughSetting.AUTO, receiver)
        assertEquals("stereo", r.audioMode)
        assertNull(r.maxChannels); assertNull(r.codecs)
    }

    @Test
    fun `explicit surround asserts at least six channels even on a stereo phone`() {
        val r = SoundRules.request(SoundPrefs(mode = SoundMode.SURROUND), PassthroughSetting.AUTO, stereoPhone)
        assertEquals("auto", r.audioMode)
        assertEquals(6, r.maxChannels)
        assertEquals(8, SoundRules.request(SoundPrefs(mode = SoundMode.SURROUND), PassthroughSetting.AUTO, receiver).maxChannels)
    }

    @Test
    fun `night, levelling, dialogue mix-down and delay are sent only when switched on`() {
        val r = SoundRules.request(SoundPrefs(downmix = DownmixStyle.DIALOGUE, night = true, normalize = true, delayMs = -120), PassthroughSetting.AUTO, stereoPhone)
        assertEquals("dialogue", r.downmix)
        assertEquals(true, r.night)
        assertEquals(true, r.normalize)
        assertEquals(-120, r.delayMs)
        assertEquals(500, SoundRules.request(SoundPrefs(delayMs = 9000), PassthroughSetting.AUTO, stereoPhone).delayMs)
        assertNull(SoundRules.request(SoundPrefs(delayMs = 0), PassthroughSetting.AUTO, stereoPhone).delayMs)
    }

    /* ---------------------------------------------------- conversion needed */

    @Test
    fun `only what the computer can do to the sound forces a conversion`() {
        assertFalse(SoundRules.needsConversion(SoundPrefs(), 6))
        assertFalse(SoundRules.needsConversion(SoundPrefs(mode = SoundMode.SURROUND), 6))
        assertTrue(SoundRules.needsConversion(SoundPrefs(night = true), 2))
        assertTrue(SoundRules.needsConversion(SoundPrefs(normalize = true), null))
        assertTrue(SoundRules.needsConversion(SoundPrefs(delayMs = -10), 2))
        assertTrue(SoundRules.needsConversion(SoundPrefs(mode = SoundMode.STEREO), 6))
        assertFalse(SoundRules.needsConversion(SoundPrefs(mode = SoundMode.STEREO), 2), "nothing to mix down")
        assertFalse(SoundRules.needsConversion(SoundPrefs(mode = SoundMode.STEREO), null))
        assertTrue(SoundRules.needsConversion(SoundPrefs(downmix = DownmixStyle.DIALOGUE), 8))
        assertFalse(SoundRules.needsConversion(SoundPrefs(downmix = DownmixStyle.DIALOGUE), 2))
    }

    /* --------------------------------------------------------------- words */

    @Test
    fun `plain words for the file itself never say more than it carries`() {
        assertEquals("Surround 5.1 · Dolby Digital", SoundRules.originalWords(SoundRules.codecWords("ac3"), 6))
        assertEquals("Stereo · AAC", SoundRules.originalWords(SoundRules.codecWords("aac"), 2))
        assertEquals("Mono · MP3", SoundRules.originalWords(SoundRules.codecWords("mp3"), 1))
        assertEquals("Surround 7.1 · Dolby TrueHD", SoundRules.originalWords(SoundRules.codecWords("truehd"), 8))
        assertEquals("Surround 7 channels · DTS", SoundRules.originalWords(SoundRules.codecWords("dts"), 7))
        assertEquals("Audio", SoundRules.originalWords("", null))
        for (codec in listOf("truehd", "dts", "eac3", "flac", "alac", "aac")) {
            val words = SoundRules.originalWords(SoundRules.codecWords(codec), 8)
            assertFalse(words, Regex("atmos|dts:x", RegexOption.IGNORE_CASE).containsMatchIn(words))
        }
    }

    @Test
    fun `output words say bitstream only for a real bitstream`() {
        assertEquals("Sent to your TV or receiver as Dolby Digital Plus (5.1), undecoded", AudioOutputState.words(C.ENCODING_E_AC3, 2, 6))
        assertEquals("Sent to your TV or receiver as Dolby Digital, undecoded", AudioOutputState.words(C.ENCODING_AC3, 2, 0))
        assertEquals("Sent to your TV or receiver as DTS-HD (7.1), undecoded", AudioOutputState.words(C.ENCODING_DTS_HD, 2, 8))
        assertEquals("Sent to your TV or receiver as Dolby TrueHD (7.1), undecoded", AudioOutputState.words(C.ENCODING_DOLBY_TRUEHD, 8, 8))
        assertEquals("Decoded on this device, 5.1 output", AudioOutputState.words(C.ENCODING_PCM_16BIT, 6, 6))
        assertEquals("Decoded on this device, Stereo output", AudioOutputState.words(C.ENCODING_PCM_FLOAT, 2, 6))
        assertEquals("Decoded on this device", AudioOutputState.words(C.ENCODING_PCM_16BIT, 0, 0))
        assertNull(AudioOutputState.words(C.ENCODING_INVALID, 0, 0))
    }

    @Test
    fun `passthrough off refuses every compressed format and never PCM`() {
        for (mime in listOf(MimeTypes.AUDIO_AC3, MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_E_AC3_JOC, MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_HD, MimeTypes.AUDIO_TRUEHD)) {
            assertTrue(mime, PassthroughRule.blocks(false, mime))
            assertFalse(mime, PassthroughRule.blocks(true, mime))
        }
        assertFalse(PassthroughRule.blocks(false, MimeTypes.AUDIO_RAW))
        assertFalse(PassthroughRule.blocks(false, null))
        assertFalse(PassthroughRule.blocks(true, MimeTypes.AUDIO_RAW))
    }

    /* --------------------------------------------------------------- sheet */

    private fun section(
        prefs: SoundPrefs = SoundPrefs(),
        passthrough: PassthroughSetting = PassthroughSetting.AUTO,
        device: DeviceAudio = stereoPhone,
        conversion: Boolean = true,
        wide: Boolean = true,
        surround: Boolean = true,
        offline: Boolean = false
    ) = SoundRules.section(prefs, passthrough, device, "Surround 5.1 · Dolby Digital" to "original audio, played as stored", conversion, wide, surround, offline)

    @Test
    fun `the sound section starts with what is playing and marks the current choices`() {
        val s = section(prefs = SoundPrefs(mode = SoundMode.SURROUND, night = true, delayMs = 100), passthrough = PassthroughSetting.OFF, device = receiver)
        assertEquals("Sound", s.title)
        val first = s.rows.first()
        assertEquals(PlaybackSheetModel.Action.INFO, first.action)
        assertEquals("Surround 5.1 · Dolby Digital", first.label)
        assertFalse(first.enabled)
        assertTrue(s.rows.single { it.action == PlaybackSheetModel.Action.SOUND_MODE && it.selected }.key == "surround")
        assertTrue(s.rows.single { it.action == PlaybackSheetModel.Action.NIGHT }.selected)
        assertTrue(s.rows.single { it.action == PlaybackSheetModel.Action.PASSTHROUGH && it.selected }.key == "off")
        assertTrue(s.rows.single { it.action == PlaybackSheetModel.Action.DELAY && it.selected }.key == "100")
        assertEquals(SoundRules.DELAY_STEPS.size, s.rows.count { it.action == PlaybackSheetModel.Action.DELAY })
    }

    @Test
    fun `surround and mix-down rows appear only when the film and computer offer them`() {
        val plain = section(surround = false, wide = false)
        assertTrue(plain.rows.none { it.key == "surround" })
        assertTrue(plain.rows.none { it.action == PlaybackSheetModel.Action.DOWNMIX })
        val full = section()
        assertTrue(full.rows.any { it.action == PlaybackSheetModel.Action.SOUND_MODE && it.key == "surround" })
        assertEquals(2, full.rows.count { it.action == PlaybackSheetModel.Action.DOWNMIX })
    }

    @Test
    fun `rows only the computer can do are disabled, with the reason, when it cannot convert`() {
        val s = section(conversion = false)
        for (a in listOf(PlaybackSheetModel.Action.NIGHT, PlaybackSheetModel.Action.NORMALIZE)) {
            val r = s.rows.single { it.action == a }
            assertFalse(r.enabled)
            assertEquals("Needs your computer to convert", r.detail)
        }
        assertTrue(s.rows.single { it.action == PlaybackSheetModel.Action.DELAY && it.key == "0" }.enabled, "resetting the delay always works")
        assertFalse(s.rows.single { it.action == PlaybackSheetModel.Action.DELAY && it.key == "100" }.enabled)
        assertTrue(s.rows.single { it.action == PlaybackSheetModel.Action.PASSTHROUGH && it.key == "off" }.enabled, "a device setting needs no computer")
        assertFalse(section(offline = true).rows.single { it.action == PlaybackSheetModel.Action.NIGHT }.enabled)
    }

    @Test
    fun `passthrough rows say what this device really reports`() {
        val none = section(device = stereoPhone).rows.first { it.action == PlaybackSheetModel.Action.PASSTHROUGH }
        assertEquals("This device reports no Dolby or DTS passthrough", none.detail)
        val some = section(device = receiver).rows.first { it.action == PlaybackSheetModel.Action.PASSTHROUGH }
        assertEquals("Sends Dolby Digital, Dolby Digital Plus, DTS, Dolby TrueHD to your TV or receiver untouched", some.detail)
        val auto = section(device = arcTv).rows.first { it.key == "auto" && it.action == PlaybackSheetModel.Action.SOUND_MODE }
        assertEquals("Surround, this device can play it", auto.detail)
        assertEquals("Stereo, this device plays stereo", section(device = stereoPhone).rows.first { it.key == "auto" && it.action == PlaybackSheetModel.Action.SOUND_MODE }.detail)
    }

    @Test
    fun `the sheet places the sound section after audio and leaves older sheets unchanged`() {
        val sections = PlaybackSheetModel.build(
            state = PlaybackSheetModel.State(QualityChoice.AUTO, QualityChoice.ORIGINAL, null, null),
            originalLabel = "Original", offered = QualityChoice.TRANSCODES, transcodeAvailable = true, transcodeReason = "",
            audio = listOf(com.beeboentertainment.movie.core.AudioOption(1, 0, "English", "eng", true)),
            subtitles = emptyList(), offline = false, sound = section()
        )
        assertEquals(listOf("Quality", "Audio", "Sound", "Subtitles"), sections.map { it.title })
        val old = PlaybackSheetModel.build(
            state = PlaybackSheetModel.State(QualityChoice.AUTO, QualityChoice.ORIGINAL, null, null),
            originalLabel = "Original", offered = QualityChoice.TRANSCODES, transcodeAvailable = true, transcodeReason = "",
            audio = listOf(com.beeboentertainment.movie.core.AudioOption(1, 0, "English", "eng", true)),
            subtitles = emptyList(), offline = false
        )
        assertEquals(listOf("Quality", "Audio", "Subtitles"), old.map { it.title })
    }

    /* ------------------------------------------------------------ requests */

    @Test
    fun `an old-style start request is byte for byte what older builds sent`() {
        val json = ApiClient.JSON.encodeToString(PlaybackStartRequest("movie", "abc", "720p", 2, null))
        assertEquals("""{"kind":"movie","id":"abc","quality":"720p","audio":2}""", json)
        assertEquals("""{"kind":"movie","id":"abc","quality":"720p"}""", ApiClient.JSON.encodeToString(PlaybackStartRequest("movie", "abc", "720p")))
    }

    @Test
    fun `a sound-aware start request carries the mode and what the device can play`() {
        val json = ApiClient.JSON.encodeToString(
            PlaybackStartRequest("movie", "abc", "1080p", null, null, audioMode = "auto", night = true, audioDelayMs = -100, audioCaps = AudioCapsRequest(6, listOf("aac", "eac3")))
        )
        assertTrue(json, json.contains(""""audioMode":"auto""""))
        assertTrue(json, json.contains(""""night":true"""))
        assertTrue(json, json.contains(""""audioDelayMs":-100"""))
        assertTrue(json, json.contains(""""audioCaps":{"maxChannels":6,"codecs":["aac","eac3"]}"""))
        assertFalse(json, json.contains("downmix"))
        assertFalse(json, json.contains("normalize"))
    }

    @Test
    fun `prefs updates only carry what changed`() {
        assertEquals("""{"night":true}""", ApiClient.JSON.encodeToString(PlaybackPrefsUpdate(night = true)))
        assertEquals("""{"audioMode":"stereo","audioDelayMs":40}""", ApiClient.JSON.encodeToString(PlaybackPrefsUpdate(audioMode = "stereo", audioDelayMs = 40)))
    }

    @Test
    fun `the server's sound answer is read, and an older server's answer still parses`() {
        val newer = ApiClient.JSON.decodeFromString(
            PlaybackInfo.serializer(),
            """{"ok":true,"audio":[{"streamIndex":1,"ordinal":0,"label":"English","language":"eng","codec":"ac3","channels":6,"isDefault":true,"channelLayout":"5.1(side)","playsAs":{"label":"Surround 5.1 · Dolby Digital","detail":"original audio, played as stored"}}],
               "audioOptions":{"surroundAvailable":true,"delayLimitMs":500,"normalizeNote":"x"},
               "prefs":{"quality":"auto","audioMode":"surround","downmix":"dialogue","night":true,"normalize":false,"boostDb":2.5,"audioDelayMs":-60}}"""
        )
        assertNotNull(newer.soundOptions)
        assertTrue(newer.soundOptions!!.surroundAvailable)
        assertEquals("Surround 5.1 · Dolby Digital", newer.audio[0].playsAs?.label)
        assertEquals("surround", newer.prefs.audioMode)
        assertEquals(-60, newer.prefs.audioDelayMs)
        assertEquals("the track list is unaffected by the new key of the same name", 1, newer.audioOptions.size)
        val older = ApiClient.JSON.decodeFromString(PlaybackInfo.serializer(), """{"ok":true,"audio":[{"streamIndex":1,"ordinal":0,"label":"English","language":"eng","isDefault":true}],"prefs":{"quality":"720p"}}""")
        assertNull(older.soundOptions)
        assertEquals("auto", older.prefs.audioMode)
        assertEquals(0, older.prefs.audioDelayMs)
        assertFalse(older.prefs.night)
    }

    @Test
    fun `the start answer's audio plan is read`() {
        val r = ApiClient.JSON.decodeFromString(
            PlaybackStartResponse.serializer(),
            """{"ok":true,"url":"/hls/T/index.m3u8","ticket":"T","audioPlan":{"label":"Surround 5.1 · Dolby Digital Plus","detail":"converted from DTS","kind":"encode","codec":"eac3","channels":6,"surround":true}}"""
        )
        assertEquals("Surround 5.1 · Dolby Digital Plus", r.audioPlan?.label)
        assertEquals("converted from DTS", r.audioPlan?.detail)
        assertTrue(r.audioPlan!!.surround)
        assertNull(ApiClient.JSON.decodeFromString(PlaybackStartResponse.serializer(), """{"ok":true,"url":"/hls/T/index.m3u8","ticket":"T"}""").audioPlan)
    }
}
