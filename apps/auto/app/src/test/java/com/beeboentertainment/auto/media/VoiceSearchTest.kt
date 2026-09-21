package com.beeboentertainment.auto.media

import com.beeboentertainment.auto.media.VoiceSearch.Candidate
import com.beeboentertainment.auto.media.VoiceSearch.EpisodeRef
import com.beeboentertainment.auto.media.VoiceSearch.Focus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** "Hey Google, play <title> on Beebo" in the car: the same matcher as the phone app. */
class VoiceSearchTest {

    private val library = listOf(
        Candidate("m-heat", "Heat", Focus.MOVIE, 1995),
        Candidate("m-cars", "Cars", Focus.MOVIE, 2006),
        Candidate("m-cars2", "Cars 2", Focus.MOVIE, 2011),
        Candidate("s-friends", "Friends", Focus.SHOW, 1994),
        Candidate("s-bluey", "Bluey", Focus.SHOW, 2018)
    )

    private fun best(spoken: String) = VoiceSearch.bestMatch(VoiceSearch.parse(spoken), library)?.candidate?.id

    @Test fun `titles and misheard titles`() {
        assertEquals("m-heat", best("play Heat on Beebo"))
        assertEquals("m-cars", best("play cars"))
        assertEquals("m-cars2", best("play cars 2"))
        assertEquals("s-friends", best("play freinds"))
        assertEquals("s-bluey", best("play the show bluey"))
        assertNull(best("play the godfather"))
    }

    @Test fun `season and episode in the car`() {
        val q = VoiceSearch.parse("play Friends season 2 episode 3 on Beebo")
        assertEquals(listOf(2, 3), listOf(q.season, q.episode))
        assertEquals("s-friends", VoiceSearch.bestMatch(q, library)?.candidate?.id)
        val eps = listOf(EpisodeRef("a", 1, 1), EpisodeRef("b", 2, 3), EpisodeRef("c", 2, 1))
        assertEquals("b", VoiceSearch.pickEpisode(eps, 2, 3)?.id)
        assertEquals("c", VoiceSearch.pickEpisode(eps, 2, null)?.id)
        assertEquals("a", VoiceSearch.pickEpisode(eps, null, null)?.id)
        assertTrue(VoiceSearch.parse("play Beebo").resume)
    }

    @Test fun `stays in step with the phone app's copy`() {
        val phone = File("../../core/app/src/main/java/com/beeboentertainment/movie/core/VoiceSearch.kt")
        if (!phone.exists()) return
        val body = { f: File -> f.readText().replace("\r\n", "\n").substringAfter("object VoiceSearch {") }
        assertEquals(body(phone), body(File("src/main/java/com/beeboentertainment/auto/media/VoiceSearch.kt")))
    }
}
