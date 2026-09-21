package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.AudioOption
import com.beeboentertainment.movie.core.AutoQuality
import com.beeboentertainment.movie.core.LanguageCodes
import com.beeboentertainment.movie.core.MediaTokenHeader
import com.beeboentertainment.movie.core.MimeGuess
import com.beeboentertainment.movie.core.NetworkPathKind
import com.beeboentertainment.movie.core.OnlineSubtitleText
import com.beeboentertainment.movie.core.PlaybackSheetModel
import com.beeboentertainment.movie.core.QualityChoice
import com.beeboentertainment.movie.core.QualityLabel
import com.beeboentertainment.movie.core.SubtitleOption
import com.beeboentertainment.movie.core.TrackChoice
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.OnlineSubtitle
import com.beeboentertainment.movie.data.PlaybackInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackChoicesTest {

    /* ------------------------------------------------------------------ Auto */

    @Test
    fun `auto keeps the original at home when it plays and the line carries it`() {
        assertEquals(QualityChoice.ORIGINAL, AutoQuality.pick(200_000, NetworkPathKind.LAN, 20_000, originalPlayable = true, transcodeAvailable = true))
        // Bitrate unknown at home: original.
        assertEquals(QualityChoice.ORIGINAL, AutoQuality.pick(50_000, NetworkPathKind.LAN, null, true, true))
        // No measurement at home: original.
        assertEquals(QualityChoice.ORIGINAL, AutoQuality.pick(null, NetworkPathKind.LAN, 40_000, true, true))
    }

    @Test
    fun `auto converts when the line is too slow for the original`() {
        // 40 Mbps remux over 30 Mbps Wi-Fi: 1080p (8 Mbps x 1.3 fits).
        assertEquals(QualityChoice.P1080, AutoQuality.pick(30_000, NetworkPathKind.LAN, 40_000, true, true))
        // Tunnel needs double headroom: 12 Mbps carries 720p (8) but not 1080p (16).
        assertEquals(QualityChoice.P720, AutoQuality.pick(12_000, NetworkPathKind.TUNNEL, 20_000, true, true))
        // Very slow: the lowest, even when it doesn't strictly fit.
        assertEquals(QualityChoice.P480, AutoQuality.pick(900, NetworkPathKind.INTERNET, 20_000, true, true))
    }

    @Test
    fun `auto on Beebo Relay never goes above 720p or plays the original`() {
        assertEquals(QualityChoice.P720, AutoQuality.pick(100_000, NetworkPathKind.RELAY, 5_000, true, true))
        assertEquals(QualityChoice.P480, AutoQuality.pick(null, NetworkPathKind.RELAY, 5_000, true, true))
        assertEquals(QualityChoice.P480, AutoQuality.pick(5_000, NetworkPathKind.RELAY, 5_000, true, true))
    }

    @Test
    fun `auto away from home with no measurement starts at 720p`() {
        assertEquals(QualityChoice.P720, AutoQuality.pick(null, NetworkPathKind.TUNNEL, null, true, true))
        assertEquals(QualityChoice.P720, AutoQuality.pick(0, NetworkPathKind.INTERNET, null, true, true))
    }

    @Test
    fun `auto never picks an original this device cannot play, and always the original without conversion`() {
        assertEquals(QualityChoice.P1080, AutoQuality.pick(500_000, NetworkPathKind.LAN, 10_000, originalPlayable = false, transcodeAvailable = true))
        assertEquals(QualityChoice.ORIGINAL, AutoQuality.pick(500, NetworkPathKind.RELAY, 40_000, true, transcodeAvailable = false))
        // Only what the file offers (a 720p file isn't converted "up" to 1080p).
        assertEquals(QualityChoice.P720, AutoQuality.pick(500_000, NetworkPathKind.LAN, 10_000, false, true, listOf(QualityChoice.P720, QualityChoice.P480)))
    }

    @Test
    fun `away-from-home is a tunnel or Beebo Relay - never LAN or a plain internet address`() {
        assertTrue(AutoQuality.isAway(NetworkPathKind.TUNNEL))
        assertTrue(AutoQuality.isAway(NetworkPathKind.RELAY))
        assertFalse(AutoQuality.isAway(NetworkPathKind.LAN))
        assertFalse(AutoQuality.isAway(NetworkPathKind.INTERNET))
    }

    @Test
    fun `bestUnderCap picks the highest conversion at or under the cap, else the lowest offered`() {
        // The household plan's 1080p cap: 1080p itself still qualifies (at, not just under).
        assertEquals(QualityChoice.P1080, AutoQuality.bestUnderCap(1080, QualityChoice.TRANSCODES))
        assertEquals(QualityChoice.P720, AutoQuality.bestUnderCap(720, QualityChoice.TRANSCODES))
        // Nothing offered fits under an unusually low cap: falls back to the lowest offered, never null.
        assertEquals(QualityChoice.P480, AutoQuality.bestUnderCap(240, QualityChoice.TRANSCODES))
        // No conversions offered at all: nothing to fall back to.
        assertNull(AutoQuality.bestUnderCap(1080, emptyList()))
    }

    @Test
    fun `speed and home-network helpers`() {
        assertEquals(8_000, AutoQuality.kbps(1_000_000, 1_000))
        assertEquals(0, AutoQuality.kbps(0, 1_000))
        assertEquals(0, AutoQuality.kbps(10, 0))
        assertTrue(AutoQuality.isPrivateHost("192.168.1.20"))
        assertTrue(AutoQuality.isPrivateHost("10.0.0.5"))
        assertTrue(AutoQuality.isPrivateHost("172.20.1.1"))
        assertTrue(AutoQuality.isPrivateHost("100.101.1.1"))
        assertFalse(AutoQuality.isPrivateHost("172.32.1.1"))
        assertFalse(AutoQuality.isPrivateHost("nick.beebo.tv"))
        assertFalse(AutoQuality.isPrivateHost(null))
    }

    /* --------------------------------------------------------- labels + urls */

    @Test
    fun `current quality reads like Plex`() {
        assertEquals("Auto · 720p", QualityLabel.current(QualityChoice.AUTO, QualityChoice.P720))
        assertEquals("Auto · Original", QualityLabel.current(QualityChoice.AUTO, QualityChoice.ORIGINAL))
        assertEquals("480p", QualityLabel.current(QualityChoice.P480, QualityChoice.P480))
        assertEquals("Original", QualityLabel.current(QualityChoice.ORIGINAL, QualityChoice.ORIGINAL))
        assertEquals(QualityChoice.P1080, QualityChoice.fromId("1080p"))
        assertEquals(QualityChoice.AUTO, QualityChoice.fromId("nonsense"))
    }

    @Test
    fun `HLS urls from the server resolve on the saved address and are recognised as HLS`() {
        val url = UrlUtils.join("https://nick.beebo.tv", "/hls/eyJ2IjoxfQ.123.sig/index.m3u8")
        assertEquals("https://nick.beebo.tv/hls/eyJ2IjoxfQ.123.sig/index.m3u8", url)
        assertEquals("application/x-mpegURL", MimeGuess.forStreamUrl(url!!, "Film"))
        // The ticket is in the path, so the media-token header logic leaves the URL alone.
        assertNull(MediaTokenHeader.split(url))
        // Embedded subtitle URLs carry mt like sidecars do.
        val sub = MediaTokenHeader.split("https://h/subtitles/embedded?kind=movie&id=abc&s=3&mt=1.sig")
        assertEquals("https://h/subtitles/embedded?kind=movie&id=abc&s=3", sub!!.url)
        assertEquals("1.sig", sub.token)
    }

    /* ---------------------------------------------------------------- tracks */

    private val audio = listOf(
        AudioOption(streamIndex = 1, ordinal = 0, label = "English · 5.1", language = "eng", isDefault = true),
        AudioOption(streamIndex = 2, ordinal = 1, label = "French · Stereo", language = "fre", isDefault = false),
        AudioOption(streamIndex = 3, ordinal = 2, label = "Spanish · Stereo", language = "spa", isDefault = false)
    )

    @Test
    fun `remembered audio language picks the matching track, default stays null`() {
        assertEquals(2, TrackChoice.rememberedAudio(audio, "fr")!!.streamIndex)
        assertEquals(3, TrackChoice.rememberedAudio(audio, "es-MX")!!.streamIndex)
        assertNull(TrackChoice.rememberedAudio(audio, "en"), "already the default")
        assertNull(TrackChoice.rememberedAudio(audio, "de"))
        assertNull(TrackChoice.rememberedAudio(audio.take(1), "fr"))
        assertEquals(1, TrackChoice.defaultAudio(audio)!!.streamIndex)
    }

    private fun assertNull(value: Any?, message: String) = org.junit.Assert.assertNull(message, value)

    @Test
    fun `audio group mapping by position, else by language`() {
        assertEquals(1, TrackChoice.audioGroupIndex(listOf("en", "fr", "es"), audio, audio[1]))
        assertEquals(0, TrackChoice.audioGroupIndex(listOf("fr", "es"), audio, audio[1]))
        assertEquals(-1, TrackChoice.audioGroupIndex(listOf("de"), audio, audio[1]))
    }

    private val subs = listOf(
        SubtitleOption("side:0", "English", "en", "sidecar", "text", "/subtitles/file?i=0", null, null, false),
        SubtitleOption("emb:4", "English (Forced)", "eng", "embedded", "text", "/subtitles/embedded?s=4", 4, 0, true),
        SubtitleOption("emb:5", "French", "fre", "embedded", "text", "/subtitles/embedded?s=5", 5, 1, false),
        SubtitleOption("emb:6", "English · picture subtitles", "eng", "embedded", "image", "", 6, 2, false)
    )

    @Test
    fun `remembered subtitles - text only, full before forced, sidecar before embedded`() {
        assertNull(TrackChoice.rememberedSubtitle(subs, subtitlesOn = false, language = "en"))
        assertEquals("side:0", TrackChoice.rememberedSubtitle(subs, true, "eng")!!.key)
        assertEquals("emb:5", TrackChoice.rememberedSubtitle(subs, true, "fr")!!.key)
        assertNull(TrackChoice.rememberedSubtitle(subs, true, "de"))
        assertEquals("side:0", TrackChoice.rememberedSubtitle(subs, true, null)!!.key)
        assertNull(TrackChoice.rememberedSubtitle(subs.filter { it.isImage }, true, "en"))
    }

    @Test
    fun `picture subtitles map to the container's own text groups only when counts agree`() {
        assertEquals(2, TrackChoice.embeddedTextGroupIndex(3, subs, subs[3]))
        assertEquals(-1, TrackChoice.embeddedTextGroupIndex(2, subs, subs[3]))
        assertEquals(-1, TrackChoice.embeddedTextGroupIndex(3, subs, subs[0]))
    }

    @Test
    fun `language codes`() {
        assertEquals("en", LanguageCodes.twoLetter("eng"))
        assertEquals("pt", LanguageCodes.twoLetter("pt-BR"))
        assertEquals("", LanguageCodes.twoLetter("und"))
        assertTrue(LanguageCodes.same("ger", "de"))
        assertFalse(LanguageCodes.same("", ""))
    }

    /* ----------------------------------------------------------------- sheet */

    @Test
    fun `sheet shows quality, audio and subtitles with the current choices marked`() {
        val sections = PlaybackSheetModel.build(
            state = PlaybackSheetModel.State(QualityChoice.AUTO, QualityChoice.P720, audioStreamIndex = 2, subtitleKey = "emb:5"),
            originalLabel = "Original · 1080p · 12 Mbps",
            offered = QualityChoice.TRANSCODES,
            transcodeAvailable = true,
            transcodeReason = "",
            audio = audio,
            subtitles = subs,
            offline = false
        )
        assertEquals(listOf("Quality", "Audio", "Subtitles"), sections.map { it.title })
        val q = sections[0].rows
        assertEquals(listOf("Auto", "Original · 1080p · 12 Mbps", "1080p", "720p", "480p"), q.map { it.label })
        assertEquals("Auto · 720p", q[0].detail)
        assertTrue(q[0].selected)
        assertEquals("8 Mbps", q[2].detail)
        assertEquals("1.5 Mbps", q[4].detail)
        assertEquals(listOf(false, true, false), sections[1].rows.map { it.selected })
        val s = sections[2].rows
        assertEquals("Off", s.first().label)
        assertFalse(s.first().selected)
        assertTrue(s.first { it.key == "emb:5" }.selected)
        assertEquals("Picture subtitles", s.first { it.key == "emb:6" }.detail)
        assertEquals(PlaybackSheetModel.Action.SEARCH_ONLINE, s.last().action)
    }

    @Test
    fun `sheet explains a capped Original instead of silently offering a worse picture`() {
        val capped = PlaybackSheetModel.build(
            state = PlaybackSheetModel.State(QualityChoice.ORIGINAL, QualityChoice.ORIGINAL, null, null),
            originalLabel = "Original · 4K · 40 Mbps",
            offered = QualityChoice.TRANSCODES,
            transcodeAvailable = true,
            transcodeReason = "",
            audio = emptyList(),
            subtitles = emptyList(),
            offline = false,
            awayQualityCapHeight = 1080
        )
        val original = capped[0].rows.first { it.key == QualityChoice.ORIGINAL.id }
        assertEquals("Capped at 1080p away from home", original.detail)

        // At home (or on the 4K tier, or when the file already fits): no cap passed in, no change
        // from today's behaviour - never silently different without a reason attached.
        val uncapped = PlaybackSheetModel.build(
            PlaybackSheetModel.State(QualityChoice.ORIGINAL, QualityChoice.ORIGINAL, null, null),
            "Original · 4K · 40 Mbps", QualityChoice.TRANSCODES, transcodeAvailable = true,
            transcodeReason = "", audio = emptyList(), subtitles = emptyList(), offline = false
        )
        assertEquals("Best picture, most data", uncapped[0].rows.first { it.key == QualityChoice.ORIGINAL.id }.detail)
    }

    @Test
    fun `sheet without conversion greys out the conversions and says why`() {
        val sections = PlaybackSheetModel.build(
            PlaybackSheetModel.State(QualityChoice.ORIGINAL, QualityChoice.ORIGINAL, null, null),
            "Original", QualityChoice.TRANSCODES, transcodeAvailable = false,
            transcodeReason = "The converter (ffmpeg) is not installed on the PC.", audio = emptyList(), subtitles = emptyList(), offline = false
        )
        assertEquals(listOf("Quality", "Subtitles"), sections.map { it.title })
        val p1080 = sections[0].rows.first { it.key == "1080p" }
        assertFalse(p1080.enabled)
        assertEquals("The converter (ffmpeg) is not installed on the PC.", p1080.detail)
        assertTrue(sections[1].rows.first().selected)
    }

    /* ----------------------------------------------------------- server JSON */

    @Test
    fun `playback info parses the server answer`() {
        val body = """
            {"ok":true,"kind":"movie","id":"abc","durationSec":7200.5,"bitrateKbps":12000,
             "video":{"codec":"hevc","width":1920,"height":800,"hdr":false},
             "original":{"label":"Original · 1080p · 12 Mbps","height":800},
             "direct":{"android":true,"cast":true,"castSafe":false,"browser":false,"reason":""},
             "qualities":[{"id":"1080p","label":"1080p","videoKbps":8000,"height":800,"upscale":false},
                          {"id":"720p","label":"720p","videoKbps":4000,"height":534,"upscale":false},
                          {"id":"480p","label":"480p","videoKbps":1500,"height":356,"upscale":false}],
             "transcode":{"available":true,"encoder":"h264_nvenc","encoderLabel":"NVIDIA graphics card","hardware":true,"reason":""},
             "audio":[{"ordinal":0,"streamIndex":1,"label":"English · 5.1 · Dolby Digital","language":"eng","isDefault":true}],
             "subtitles":[{"key":"side:0","source":"sidecar","kind":"text","label":"English","language":"en","url":"/subtitles/file?i=0"},
                          {"key":"emb:3","source":"embedded","kind":"image","label":"English · picture subtitles","language":"eng","streamIndex":3,"ordinal":0,"url":""},
                          {"key":"emb:9","source":"embedded","kind":"text","label":"Broken","url":""}],
             "prefs":{"quality":"720p","audioLanguage":"fre","subtitleLanguage":"en","subtitlesOn":true},
             "onlineSearch":{"configured":true},"awayQualityCapHeight":1080,"futureField":1}
        """.trimIndent()
        val info = ApiClient.JSON.decodeFromString(PlaybackInfo.serializer(), body)
        assertTrue(info.ok)
        assertFalse(info.direct.castSafe)
        assertEquals(listOf(QualityChoice.P1080, QualityChoice.P720, QualityChoice.P480), info.offered)
        assertEquals(listOf("side:0", "emb:3"), info.subtitleOptions.map { it.key }, )
        assertTrue(info.subtitleOptions[1].isImage)
        assertEquals("720p", info.prefs.quality)
        assertTrue(info.onlineSearch.configured)
        assertEquals(1080, info.awayQualityCapHeight)

        val small = ApiClient.JSON.decodeFromString(PlaybackInfo.serializer(),
            """{"ok":true,"qualities":[{"id":"1080p","upscale":true},{"id":"720p","upscale":true},{"id":"480p","upscale":true}]}""")
        assertEquals(listOf(QualityChoice.P480), small.offered)
        // Older servers that don't send the field at all: no cap communicated, not "capped to 0".
        assertNull(small.awayQualityCapHeight)
    }

    @Test
    fun `online subtitle words`() {
        val row = OnlineSubtitleText.rowLabel(OnlineSubtitle(fileId = 1, release = "Film.2020.BluRay", hashMatch = true, hearingImpaired = true, downloads = 1200))
        assertEquals("Film.2020.BluRay\nexact match for this file · SDH · 1200 downloads", row)
        assertEquals("French", OnlineSubtitleText.languageWord("fre"))
        assertTrue(OnlineSubtitleText.SETUP_HELP.contains("Ask the owner to set up subtitle search on the PC"))
        assertTrue(OnlineSubtitleText.SETUP_HELP.contains("opensubtitles.com/en/consumers"))
        assertEquals("Subtitles saved. 17 downloads left today on the owner's account.", OnlineSubtitleText.savedMessage(17))
    }
}
