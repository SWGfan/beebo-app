package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.VoiceSearch
import com.beeboentertainment.movie.core.VoiceSearch.Candidate
import com.beeboentertainment.movie.core.VoiceSearch.EpisodeRef
import com.beeboentertainment.movie.core.VoiceSearch.Focus
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** "Hey Google, play <title> on Beebo": what was said -> which title in the library. */
class VoiceSearchTest {

    private val library = listOf(
        Candidate("m-heat", "Heat", Focus.MOVIE, 1995),
        Candidate("m-up", "Up", Focus.MOVIE, 2009),
        Candidate("m-br", "Blade Runner", Focus.MOVIE, 1982),
        Candidate("m-br2049", "Blade Runner 2049", Focus.MOVIE, 2017),
        Candidate("m-sw", "Star Wars: A New Hope", Focus.MOVIE, 1977),
        Candidate("m-amelie", "Amélie", Focus.MOVIE, 2001),
        Candidate("m-fast", "Fast & Furious", Focus.MOVIE, 2009),
        Candidate("s-friends", "Friends", Focus.SHOW, 1994),
        Candidate("s-office", "The Office", Focus.SHOW, 2005),
        Candidate("m-office", "Office Space", Focus.MOVIE, 1999)
    )

    @After fun resetFilter() { VoiceSearch.contentFilter = { true } }

    private fun best(spoken: String) = VoiceSearch.bestMatch(VoiceSearch.parse(spoken), library)?.candidate?.id

    @Test fun `request words around the title are dropped`() {
        assertEquals("heat", VoiceSearch.parse("play Heat on Beebo").title)
        assertEquals("heat", VoiceSearch.parse("Hey Google, play heat on the Beebo app").title)
        assertEquals("heat", VoiceSearch.parse("watch Heat").title)
        val movie = VoiceSearch.parse("play the movie Up on Beebo")
        assertEquals("up", movie.title)
        assertEquals(Focus.MOVIE, movie.focus)
        val show = VoiceSearch.parse("play the show The Office")
        assertEquals("the office", show.title)
        assertEquals(Focus.SHOW, show.focus)
    }

    @Test fun `season and episode parsing`() {
        val q = VoiceSearch.parse("play Friends season 2 episode 3 on Beebo")
        assertEquals("friends", q.title)
        assertEquals(2, q.season)
        assertEquals(3, q.episode)
        assertEquals(Focus.SHOW, q.focus)

        VoiceSearch.parse("play Friends season two episode three").let { assertEquals(listOf(2, 3), listOf(it.season, it.episode)); assertEquals("friends", it.title) }
        VoiceSearch.parse("play Friends S02E03").let { assertEquals(listOf(2, 3), listOf(it.season, it.episode)); assertEquals("friends", it.title) }
        VoiceSearch.parse("play Friends 2x03").let { assertEquals(listOf(2, 3), listOf(it.season, it.episode)) }
        VoiceSearch.parse("play episode 4 of season 1 of Friends").let { assertEquals(listOf(1, 4), listOf(it.season, it.episode)); assertEquals("friends", it.title) }
        VoiceSearch.parse("play The Office season 3").let { assertEquals(3, it.season); assertNull(it.episode); assertEquals("the office", it.title) }
        VoiceSearch.parse("play the next episode of Friends").let { assertEquals("friends", it.title); assertNull(it.season) }
        VoiceSearch.parse("play Friends season to episode for").let { assertEquals(listOf(2, 4), listOf(it.season, it.episode)) }
    }

    @Test fun `fuzzy title matching picks the right film`() {
        assertEquals("m-heat", best("play Heat on Beebo"))
        assertEquals("m-up", best("play the movie Up"))
        assertEquals("s-friends", best("play Friends season 2 episode 3"))
        assertEquals("s-office", best("play the office"))
        assertEquals("m-office", best("play office space"))
        // Accents, punctuation, "and" for "&", a leading article, small mishearings.
        assertEquals("m-amelie", best("play amelie"))
        assertEquals("m-fast", best("play fast and furious"))
        assertEquals("m-sw", best("play star wars a new hope"))
        assertEquals("m-sw", best("play star wars"))
        assertEquals("s-friends", best("play freinds"))
        // A number that looks like a year but is part of the title.
        assertEquals("m-br2049", best("play blade runner 2049"))
        assertEquals("m-br", best("play blade runner"))
        assertEquals("m-heat", best("play heat 1995"))
    }

    @Test fun `nothing close enough plays nothing`() {
        assertNull(best("play the godfather"))
        assertNull(best("play"))
        assertTrue(VoiceSearch.parse("play something on Beebo").resume)
        assertTrue(VoiceSearch.parse("play Beebo").resume)
        assertFalse(VoiceSearch.parse("play Heat").resume)
        // The media focus Assistant sends narrows the kind.
        val q = VoiceSearch.parse("the office", mediaFocus = "vnd.android.cursor.item/video")
        assertEquals(Focus.ANY, q.focus)
        assertEquals(Focus.SHOW, VoiceSearch.parse("office", mediaFocus = "vnd.android.cursor.item/tv").focus)
        // A structured title from Assistant wins over the raw words.
        assertEquals("Heat", VoiceSearch.parse("play that heat film thing", title = "Heat").title)
    }

    @Test fun `similarity is symmetric enough and bounded`() {
        assertEquals(1.0, VoiceSearch.similarity("The Office", "office"), 0.0001)
        assertTrue(VoiceSearch.similarity("heat", "heath ledger documentary") < VoiceSearch.MIN_SCORE)
        assertEquals(0.0, VoiceSearch.similarity("", "Heat"), 0.0)
        assertEquals("fast and furious", VoiceSearch.normalize("Fast & Furious (2009)"))
    }

    @Test fun `the parental filter seam hides titles from voice`() {
        VoiceSearch.contentFilter = { it.id != "m-heat" }
        assertNull(best("play heat"))
        assertEquals("m-up", best("play up"))
        VoiceSearch.contentFilter = { throw IllegalStateException("filter broke") }
        org.junit.Assert.assertNull("a broken filter must fail closed", best("play up"))
    }


    @Test fun `which episode of a show`() {
        val eps = listOf(
            EpisodeRef("e11", 1, 1, 100, 1_000), EpisodeRef("e12", 1, 2, 100, 2_000), EpisodeRef("e13", 1, 3, 0, null),
            EpisodeRef("e21", 2, 1, 0, null), EpisodeRef("e23", 2, 3, 0, null), EpisodeRef("eX", null, null, 0, null)
        )
        assertEquals("e23", VoiceSearch.pickEpisode(eps, 2, 3)?.id)
        assertNull(VoiceSearch.pickEpisode(eps, 5, 1))
        assertEquals("e21", VoiceSearch.pickEpisode(eps, 2, null)?.id)
        assertEquals("e13", VoiceSearch.pickEpisode(eps, null, null)?.id, )
        val partway = eps + EpisodeRef("e22", 2, 2, 40, 3_000)
        assertEquals("e22", VoiceSearch.pickEpisode(partway, null, null)?.id)
        assertEquals("e11", VoiceSearch.pickEpisode(eps.map { it.copy(watchedAt = null, watchedPercent = 0) }, null, null)?.id)
        assertNull(VoiceSearch.pickEpisode(emptyList(), null, null))
    }

    @Test fun `manifest declares the voice entry points`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android.media.action.MEDIA_PLAY_FROM_SEARCH"))
        assertTrue(manifest.contains(".voice.VoiceSearchActivity"))
        assertTrue(manifest.contains("android.permission.GLOBAL_SEARCH"))
        assertTrue(manifest.contains("@xml/shortcuts"))
        val searchable = File("src/main/res/xml/searchable.xml").readText()
        assertTrue("authority matches the provider", searchable.contains("com.beeboentertainment.movie.tvsearch"))
        assertTrue(File("src/main/res/xml/shortcuts.xml").readText().contains("actions.intent.GET_THING"))
    }
}
