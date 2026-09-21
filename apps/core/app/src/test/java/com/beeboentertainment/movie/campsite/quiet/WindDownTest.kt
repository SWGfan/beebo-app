package com.beeboentertainment.movie.campsite.quiet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WindDownTest {

    private val min = 60_000L

    /** Records what the sequence asked the phone to do, and what is playing right now. */
    private class Fake : WindDownEffects {
        val log = mutableListOf<String>()
        var speaking = false
        var ambience: String? = null
        var volume = -1f
        val volumes = mutableListOf<Float>()
        override fun speak(text: String) { speaking = true; log += "speak" }
        override fun stopSpeaking() { speaking = false; log += "stopSpeaking" }
        override fun startAmbience(id: String) { ambience = id; log += "ambience:$id" }
        override fun setAmbienceVolume(level: Float) { volume = level; volumes += level }
        override fun stopAmbience() { ambience = null; log += "stopAmbience" }
    }

    private val story = WindDownStory("Test", "Once. Twice. Three times.")

    private fun runner(fake: Fake) = WindDownRunner(fake, listOf(story))

    @Test
    fun `it runs the story then ambience then fades then stops, and nothing plays after the timer`() {
        val fake = Fake()
        val r = runner(fake)
        val t0 = 1_000_000L
        r.start(t0, WindDownConfig(minutes = 20, story = true, ambienceId = "rain"))
        assertEquals(WindDownPhase.STORY, r.phase)
        assertTrue(fake.speaking)
        assertEquals(null, fake.ambience)

        // The voice finishes after 3 minutes: the ambience begins.
        r.storyFinished(t0 + 3 * min)
        assertEquals(WindDownPhase.AMBIENCE, r.phase)
        assertEquals("rain", fake.ambience)
        assertEquals(WindDownRunner.BASE_LEVEL, fake.volume, 0.0001f)

        // Nineteen minutes in, the last minute is a fade: the level falls.
        r.tick(t0 + 19 * min + 10_000)
        assertEquals(WindDownPhase.FADE, r.phase)
        val early = fake.volume
        r.tick(t0 + 19 * min + 40_000)
        assertTrue("fading", fake.volume < early)
        assertTrue(fake.volume > 0f)

        // The timer ends: everything stops.
        r.tick(t0 + 20 * min)
        assertEquals(WindDownPhase.DONE, r.phase)
        assertEquals(null, fake.ambience)
        assertFalse(fake.speaking)

        // Nothing can start it again by itself: late ticks and a late "story finished" do nothing.
        val before = fake.log.size
        r.tick(t0 + 21 * min)
        r.storyFinished(t0 + 22 * min)
        r.tick(t0 + 60 * min)
        assertEquals(before, fake.log.size)
        assertEquals(null, fake.ambience)
        assertFalse(r.running)
        assertEquals(0L, r.remainingMs(t0 + 60 * min))
    }

    @Test
    fun `a story that never ends is cut off at forty percent so the ambience still comes`() {
        val fake = Fake()
        val r = runner(fake)
        val t0 = 0L
        r.start(t0, WindDownConfig(minutes = 10))
        r.tick(t0 + 3 * min)
        assertEquals("still reading", WindDownPhase.STORY, r.phase)
        r.tick(t0 + 4 * min)
        assertEquals(WindDownPhase.AMBIENCE, r.phase)
        assertFalse(fake.speaking)
        assertTrue(fake.log.contains("stopSpeaking"))
        assertEquals("rain", fake.ambience)
    }

    @Test
    fun `with the story off it goes straight to ambience`() {
        val fake = Fake()
        val r = runner(fake)
        r.start(0L, WindDownConfig(minutes = 10, story = false, ambienceId = "crickets"))
        assertEquals(WindDownPhase.AMBIENCE, r.phase)
        assertFalse(fake.log.contains("speak"))
        assertEquals("crickets", fake.ambience)
        assertEquals("", r.storyTitle)
    }

    @Test
    fun `cancel stops the voice and the ambience at once and can be used in any phase`() {
        listOf(0L, 5 * min, 9 * min + 30_000).forEach { offset ->
            val fake = Fake()
            val r = runner(fake)
            r.start(0L, WindDownConfig(minutes = 10))
            r.tick(offset)
            r.cancel()
            assertEquals(WindDownPhase.IDLE, r.phase)
            assertEquals(null, fake.ambience)
            assertFalse(fake.speaking)
            assertFalse(r.running)
            // And it stays quiet afterwards.
            val n = fake.log.size
            r.tick(offset + 30 * min)
            assertEquals(n, fake.log.size)
        }
    }

    @Test
    fun `a second start while running is ignored and the length is one of the offered ones`() {
        val fake = Fake()
        val r = runner(fake)
        r.start(0L, WindDownConfig(minutes = 30))
        r.start(1L, WindDownConfig(minutes = 10))
        assertEquals(30 * min, r.remainingMs(0L))
        val other = runner(Fake())
        other.start(0L, WindDownConfig(minutes = 17)) // not an offered length
        assertEquals(20 * min, other.remainingMs(0L))
        assertEquals(listOf(10, 20, 30), WindDownConfig.MINUTES)
    }

    @Test
    fun `the fade is the last minute or a fifth of a short session`() {
        assertEquals(60_000L, WindDownRunner.fadeMs(10 * min))
        assertEquals(60_000L, WindDownRunner.fadeMs(30 * min))
        assertEquals(6_000L, WindDownRunner.fadeMs(30_000L))
    }

    @Test
    fun `the stories are bundled, original and free of claims`() {
        val stories = WindDownStories.ALL
        assertTrue(stories.size >= 3)
        assertEquals(stories.size, stories.map { it.title }.toSet().size)
        stories.forEach { s ->
            assertTrue(s.title, s.text.length in 400..2000)
            listOf("sleep better", "cure", "treat ", "medicine", "insomnia", "http").forEach { bad ->
                assertFalse("${s.title} says $bad", s.text.lowercase().contains(bad))
            }
        }
    }
}
