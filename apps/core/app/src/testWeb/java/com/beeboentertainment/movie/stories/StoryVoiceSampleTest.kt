package com.beeboentertainment.movie.stories

import org.junit.Assert.*
import org.junit.Test
import java.io.File

class StoryVoiceSampleTest {
    // The PC's allowlist (desktop/apps/desktop/electron/storybookRuntime.js ENGLISH_VOICES).
    private val pcVoices = ("af_heart af_alloy af_aoede af_bella af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky " +
        "am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa bf_alice bf_emma bf_isabella bf_lily " +
        "bm_daniel bm_fable bm_george bm_lewis").split(" ").toSet()

    @Test fun `the picker offers exactly the computer's twenty-eight voices`() {
        assertEquals(pcVoices, COMPUTER_VOICES.keys)
    }

    @Test fun `display names and accents come from the picker labels`() {
        assertEquals("Heart", computerVoiceNameFor("af_heart"))
        assertEquals("Isabella", computerVoiceNameFor("bf_isabella"))
        assertEquals("Lewis", computerVoiceNameFor("bm_lewis"))
        assertNull(computerVoiceNameFor(""))
        assertNull(computerVoiceNameFor("zz_nobody"))
        COMPUTER_VOICES.forEach { (id, label) ->
            val name = computerVoiceName(label)
            assertTrue(id, name.isNotBlank() && !name.contains("·"))
            assertEquals(id, id.substringAfter('_'), name.lowercase())
            assertTrue(id, label.endsWith(if (id.startsWith("b")) "British" else "American"))
        }
        assertEquals("Hi, I'm Emma.", voiceSampleLine(computerVoiceName("Emma · British")))
    }

    @Test fun `phone voices are named the way the list shows them`() {
        assertEquals("Voice 3", phoneVoiceName("English (United States) · Voice 3"))
        assertEquals("your phone voice", phoneVoiceName(""))
        assertEquals("Hi, I'm Voice 3.", voiceSampleLine(phoneVoiceName("English (United Kingdom) · Voice 3")))
    }

    @Test fun `sample urls are built only for real voice ids`() {
        assertEquals("/api/storybook-voice-sample/af_heart", voiceSamplePath("af_heart"))
        assertEquals("https://nick.beebo.tv/api/storybook-voice-sample/bm_george", voiceSampleUrl("nick.beebo.tv/", "bm_george"))
        assertEquals("http://192.168.1.5:47811/api/storybook-voice-sample/am_santa", voiceSampleUrl("http://192.168.1.5:47811", "am_santa"))
        listOf("", "af_heart/../x", "../af_heart", "AF_HEART", "af_heart.mp3", "af_he%2Fart", "xf_heart", "af_", "af heart")
            .forEach { assertNull(it, voiceSamplePath(it)) }
        assertNull(voiceSampleUrl(null, "af_heart"))
        assertNull(voiceSampleUrl("nick.beebo.tv", "nope"))
        COMPUTER_VOICES.keys.forEach { assertNotNull(it, voiceSamplePath(it)) }
    }

    @Test fun `every failure has a short message and success has none`() {
        assertNull(voiceSampleProblem(VoiceSampleResult.Ready(File("x.mp3"))))
        assertTrue(voiceSampleProblem(VoiceSampleResult.Unreachable)!!.contains("computer"))
        assertNotNull(voiceSampleProblem(VoiceSampleResult.Unavailable))
    }
}
