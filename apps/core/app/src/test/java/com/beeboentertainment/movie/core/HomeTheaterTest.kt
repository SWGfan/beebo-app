package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.NegotiateResponse
import com.beeboentertainment.movie.data.PlaybackInfo
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The declaration this TV / phone sends with POST /api/playback/negotiate and the rules for following the answer
 * (docs/HOME-THEATER.md). UNVERIFIED on a device: these prove the declaration and the decisions, not what a Shield or a
 * Fire TV really reports.
 */
class HomeTheaterTest {
    private val lenient = Json { ignoreUnknownKeys = true }

    private val uhdTv = DeviceCaps(
        client = "androidtv", name = "Living room Shield",
        video = mapOf(
            "h264" to VideoDecoderCaps(listOf("baseline", "main", "high"), listOf(8)),
            "hevc" to VideoDecoderCaps(listOf("main", "main10"), listOf(8, 10)),
            "vp9" to VideoDecoderCaps(listOf("profile0", "profile2"), listOf(8, 10)),
        ),
        maxHeight = 2160, hdr10 = true, hdr10Plus = false, hlg = true, dolbyVisionProfiles = listOf(5, 8), dvFallback = false,
        audio = mapOf(
            "aac" to AudioFormatCaps(decode = true, passthrough = false),
            "ac3" to AudioFormatCaps(decode = true, passthrough = true),
            "eac3" to AudioFormatCaps(decode = true, passthrough = true, atmos = true),
            "flac" to AudioFormatCaps(decode = true, passthrough = false),
        ),
        maxAudioChannels = 8
    )

    private fun JsonObject.audio(key: String): JsonObject? = this["audio"]?.jsonObject?.get(key)?.jsonObject

    @Test fun anUhdHdrShieldDeclaration() {
        val p = DeviceProfileBuilder.build(uhdTv)
        assertEquals(1, p["v"]!!.jsonPrimitive.int)
        assertEquals("androidtv", p["client"]!!.jsonPrimitive.content)
        assertEquals("Living room Shield", p["name"]!!.jsonPrimitive.content)
        assertEquals(setOf("h264", "hevc", "vp9"), p["video"]!!.jsonObject.keys)
        assertEquals(listOf(8, 10), p["video"]!!.jsonObject["hevc"]!!.jsonObject["bitDepths"]!!.jsonArray.map { it.jsonPrimitive.int })
        assertEquals(listOf("hdr10", "hlg", "dv:5,8"), p["hdr"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(2160, p["maxHeight"]!!.jsonPrimitive.int)
        assertEquals(3840, p["maxWidth"]!!.jsonPrimitive.int)
        assertEquals(listOf("mp4", "mkv", "ts", "webm"), p["containers"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("hls-ts", "hls-fmp4"), p["streaming"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("vtt", "srt"), p["subtitles"]!!.jsonArray.map { it.jsonPrimitive.content })
        // it survives the trip over the wire
        assertEquals(p, lenient.parseToJsonElement(p.toString()))
    }

    @Test fun dolbyDigitalIsDecodedAndPassedThroughAndAtmosOnlyOnJoc() {
        val p = DeviceProfileBuilder.build(uhdTv)
        val eac3 = p.audio("eac3")!!
        assertTrue(eac3["passthrough"]!!.jsonPrimitive.boolean)
        assertTrue(eac3["atmos"]!!.jsonPrimitive.boolean)
        assertNull("decode is on by default: only a 'no' is written", eac3["decode"])
        assertNull(p.audio("ac3")!!["atmos"])
        assertEquals(6, p.audio("aac")!!["maxChannels"]!!.jsonPrimitive.int)
        assertEquals(8, p["maxAudioChannels"]!!.jsonPrimitive.int)
    }

    @Test fun trueHdAndDtsAreOffUnlessTheOutputReportedThem() {
        val p = DeviceProfileBuilder.build(uhdTv)
        for (key in listOf("truehd", "dts", "dtshd", "dtsx")) assertNull(key, p.audio(key))

        val withReceiver = uhdTv.copy(
            audio = uhdTv.audio + mapOf(
                "truehd" to AudioFormatCaps(decode = false, passthrough = true, atmos = true),
                "dts" to AudioFormatCaps(decode = false, passthrough = true),
                "dtshd" to AudioFormatCaps(decode = false, passthrough = true),
            )
        )
        val q = DeviceProfileBuilder.build(withReceiver)
        val truehd = q.audio("truehd")!!
        assertTrue(truehd["passthrough"]!!.jsonPrimitive.boolean)
        assertFalse(truehd["decode"]!!.jsonPrimitive.boolean)
        assertEquals(8, truehd["maxChannels"]!!.jsonPrimitive.int)
        assertNotNull(q.audio("dts"))
        assertNotNull(q.audio("dtshd"))
        assertNull("DTS:X is never claimed", q.audio("dtsx"))
    }

    @Test fun anSdrTvSaysSdrAndNoDolbyVision() {
        val sdr = uhdTv.copy(hdr10 = false, hlg = false, dolbyVisionProfiles = emptyList(), maxHeight = 1080)
        val p = DeviceProfileBuilder.build(sdr)
        assertEquals(JsonArray(emptyList()), p["hdr"])
        assertEquals(1080, p["maxHeight"]!!.jsonPrimitive.int)
        assertNull(p["maxWidth"])
        assertFalse(p.toString().contains("dv:"))
        assertFalse(p.toString().contains("hdr10plus"))
    }

    @Test fun hdr10PlusAndTheDolbyVisionFallbackAreOnlyWhatWasReported() {
        val p = DeviceProfileBuilder.build(uhdTv.copy(hdr10Plus = true, dolbyVisionProfiles = emptyList(), dvFallback = true))
        assertEquals(listOf("hdr10", "hdr10plus", "hlg", "dvfallback"), p["hdr"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test fun aCodecWithNoDecoderIsAbsentAndNothingProbedIsStillValid() {
        val p = DeviceProfileBuilder.build(DeviceCaps(client = "android"))
        assertNull(p["video"])
        assertNull(p["audio"])
        assertEquals("android", p["client"]!!.jsonPrimitive.content)
        assertEquals(1080, p["maxHeight"]!!.jsonPrimitive.int)
        assertEquals(setOf("v", "client", "hdr", "maxHeight", "containers", "streaming", "subtitles"), p.keys)
    }

    @Test fun aTvWithTwoChannelSpeakersDoesNotClaimSurroundDecoding() {
        val speakers = uhdTv.copy(
            maxAudioChannels = 2,
            audio = mapOf(
                "aac" to AudioFormatCaps(decode = true, passthrough = false),
                "ac3" to AudioFormatCaps(decode = true, passthrough = false),
            )
        )
        val p = DeviceProfileBuilder.build(speakers)
        assertEquals(2, p.audio("aac")!!["maxChannels"]!!.jsonPrimitive.int)
        assertEquals(2, p["maxAudioChannels"]!!.jsonPrimitive.int)
    }

    @Test fun summaryIsAShortReadableLine() {
        assertEquals("h264 hevc vp9 · hdr10 hlg dv:5,8 · 2160p", DeviceProfileBuilder.summary(DeviceProfileBuilder.build(uhdTv)))
    }

    @Test fun onlyAServerWithTheRouteIsAskedAndOnlyForTheOriginal() {
        assertTrue(HomeTheaterRules.shouldNegotiate(serverHasRoute = true, wantsOriginal = true, casting = false, burningSubtitle = false))
        assertFalse("an older computer", HomeTheaterRules.shouldNegotiate(false, true, false, false))
        assertFalse("an explicit conversion is left alone", HomeTheaterRules.shouldNegotiate(true, false, false, false))
        assertFalse("the declaration describes this device, not the cast receiver", HomeTheaterRules.shouldNegotiate(true, true, true, false))
        assertFalse("a burnt-in subtitle needs the conversion the app already asks for", HomeTheaterRules.shouldNegotiate(true, true, false, true))
    }

    @Test fun onlyThePlansOnTheirOwnRoutesAreFollowed() {
        assertTrue(HomeTheaterRules.followable(PlayMethod.DIRECT_PLAY, "/file?id=a&mt=T"))
        assertTrue(HomeTheaterRules.followable(PlayMethod.DIRECT_PLAY, "/tvfile?id=a&mt=T"))
        assertTrue(HomeTheaterRules.followable(PlayMethod.DIRECT_STREAM, "/hls/T1/master.m3u8"))
        assertTrue(HomeTheaterRules.followable(PlayMethod.TRANSCODE, "/hls/T2/index.m3u8"))
        val bad = listOf(
            PlayMethod.DIRECT_PLAY to "http://evil.example/file?id=a",
            PlayMethod.DIRECT_PLAY to "//evil.example/file?id=a",
            PlayMethod.DIRECT_PLAY to "/api/admin/settings",
            PlayMethod.DIRECT_PLAY to "/hls/T/index.m3u8",
            PlayMethod.DIRECT_STREAM to "/file?id=a",
            PlayMethod.DIRECT_STREAM to "/hls/../x.m3u8",
            PlayMethod.DIRECT_STREAM to "/hls/T/evil.php",
            PlayMethod.TRANSCODE to "/x/index.m3u8",
            PlayMethod.DIRECT_PLAY to "/file?id=a\nX: y",
            PlayMethod.DIRECT_PLAY to "",
        )
        for ((m, u) in bad) assertFalse("$m $u", HomeTheaterRules.followable(m, u))
        assertFalse(HomeTheaterRules.followable(null, "/file?id=a"))
    }

    @Test fun thePreparingWaitIsBounded() {
        assertEquals(3_000L, HomeTheaterRules.prepareWaitMs(3.0))
        assertEquals(3_000L, HomeTheaterRules.prepareWaitMs(null))
        assertEquals(10_000L, HomeTheaterRules.prepareWaitMs(99.0))
        assertEquals(1_000L, HomeTheaterRules.prepareWaitMs(0.0))
    }

    @Test fun theAnswerIsParsedLeniently() {
        val plan = lenient.decodeFromString<NegotiateResponse>(
            """{"ok":true,"method":"DirectStream","url":"/hls/T9/master.m3u8","ticket":"T9","container":"hls-fmp4","durationSec":7020.5,"plan":{"reasonCodes":[]}}"""
        )
        assertEquals(PlayMethod.DIRECT_STREAM, plan.playMethod)
        assertTrue(plan.followable)
        assertEquals("T9", plan.ticket)
        val hostile = lenient.decodeFromString<NegotiateResponse>("""{"ok":true,"method":"DirectPlay","url":"http://evil.example/file?id=a"}""")
        assertFalse(hostile.followable)
        val notOk = lenient.decodeFromString<NegotiateResponse>("""{"ok":false,"method":"DirectPlay","url":"/file?id=a"}""")
        assertFalse(notOk.followable)
        val preparing = lenient.decodeFromString<NegotiateResponse>("""{"ok":false,"error":"preparing","retryAfterSec":3}""")
        assertEquals("preparing", preparing.error)
        assertNull(PlayMethod.fromWire("Teleport"))
    }

    @Test fun theInfoBlockIsTheFeatureTest() {
        val older = lenient.decodeFromString<PlaybackInfo>("""{"ok":true,"durationSec":10}""")
        assertNull(older.homeTheater)
        val newer = lenient.decodeFromString<PlaybackInfo>("""{"ok":true,"durationSec":10,"homeTheater":{"badges":["4K","Dolby Vision"],"plan":{}}}""")
        assertEquals(listOf("4K", "Dolby Vision"), newer.homeTheater!!.badges)
        val bare = lenient.decodeFromString<PlaybackInfo>("""{"ok":true,"homeTheater":{}}""")
        assertNotNull(bare.homeTheater)
    }
}
