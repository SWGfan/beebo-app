package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.BrowseFilter
import com.beeboentertainment.movie.core.BrowseLogic
import com.beeboentertainment.movie.core.BrowseLogic.Kind
import com.beeboentertainment.movie.core.BrowseLogic.SearchState
import com.beeboentertainment.movie.core.TitleRequestLogic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowseLogicTest {

    private data class F(val title: String)
    private data class S(val name: String)

    private val films = listOf(F("Up"), F("The Office Party"), F("Amélie"), F("Zootopia"), F("Office Space"))
    private val shows = listOf(S("The Office"), S("Bluey"), S("Up North"), S("Office"))

    private fun run(filter: BrowseFilter, query: String) =
        BrowseLogic.results(films, shows, filter, query, { it.title }, { it.name })

    @Test
    fun `All shows films and shows, Films only films, Shows only shows`() {
        assertEquals(films.size + shows.size, run(BrowseFilter.ALL, "").size)
        assertTrue(run(BrowseFilter.FILMS, "").all { it.kind == Kind.FILM && it.film != null && it.show == null })
        assertEquals(films.size, run(BrowseFilter.FILMS, "").size)
        assertTrue(run(BrowseFilter.SHOWS, "").all { it.kind == Kind.SHOW && it.show != null && it.film == null })
        assertEquals(shows.size, run(BrowseFilter.SHOWS, "").size)
    }

    @Test
    fun `switch flags`() {
        assertTrue(BrowseFilter.ALL.includesFilms && BrowseFilter.ALL.includesShows)
        assertTrue(BrowseFilter.FILMS.includesFilms && !BrowseFilter.FILMS.includesShows)
        assertTrue(!BrowseFilter.SHOWS.includesFilms && BrowseFilter.SHOWS.includesShows)
    }

    @Test
    fun `no query is A to Z across both kinds`() {
        val titles = run(BrowseFilter.ALL, "").map { it.title }
        // AlphaIndex ignores nothing by default, so "The Office" sorts under T.
        assertEquals(listOf("Amélie", "Bluey", "Office", "Office Space", "The Office", "The Office Party", "Up", "Up North", "Zootopia"), titles)
    }

    @Test
    fun `a film and a show with the same name list the film first`() {
        val hits = BrowseLogic.results(listOf(F("Fargo")), listOf(S("Fargo")), BrowseFilter.ALL, "", { it.title }, { it.name })
        assertEquals(listOf(Kind.FILM, Kind.SHOW), hits.map { it.kind })
        val searched = BrowseLogic.results(listOf(F("Fargo")), listOf(S("Fargo")), BrowseFilter.ALL, "fargo", { it.title }, { it.name })
        assertEquals(listOf(Kind.FILM, Kind.SHOW), searched.map { it.kind })
    }

    @Test
    fun `one search covers films and shows, best match first`() {
        val hits = run(BrowseFilter.ALL, "office")
        assertEquals(
            listOf("Office", "Office Space", "The Office", "The Office Party"),
            hits.map { it.title }
        )
        assertEquals(listOf(Kind.SHOW, Kind.FILM, Kind.SHOW, Kind.FILM), hits.map { it.kind })
    }

    @Test
    fun `search respects the switch`() {
        assertEquals(listOf("Office Space", "The Office Party"), run(BrowseFilter.FILMS, "office").map { it.title })
        assertEquals(listOf("Office", "The Office"), run(BrowseFilter.SHOWS, "office").map { it.title })
    }

    @Test
    fun `match ranks - exact, prefix, word, anywhere`() {
        assertEquals(0, BrowseLogic.matchRank("Up", "up"))
        assertEquals(1, BrowseLogic.matchRank("Up North", "up"))
        assertEquals(2, BrowseLogic.matchRank("Look Up", "up"))
        assertEquals(3, BrowseLogic.matchRank("Pupil", "up"))
        assertNull(BrowseLogic.matchRank("Bluey", "up"))
    }

    @Test
    fun `search ignores case and accents and surrounding spaces`() {
        assertEquals(listOf("Amélie"), run(BrowseFilter.ALL, "  AMELIE ").map { it.title })
    }

    @Test
    fun `nothing found offers Request this title`() {
        assertTrue(run(BrowseFilter.ALL, "paddington").isEmpty())
        assertEquals(SearchState.REQUEST_THIS_TITLE, BrowseLogic.searchState("paddington", 0, loading = false))
    }

    @Test
    fun `results, loading and too-short queries do not offer a request`() {
        assertEquals(SearchState.RESULTS, BrowseLogic.searchState("up", 3, loading = false))
        assertEquals(SearchState.RESULTS, BrowseLogic.searchState("up", 3, loading = true))
        assertEquals(SearchState.LOADING, BrowseLogic.searchState("paddington", 0, loading = true))
        assertEquals(SearchState.TOO_SHORT, BrowseLogic.searchState("q", 0, loading = false))
        assertEquals(SearchState.TOO_SHORT, BrowseLogic.searchState(" q ", 0, loading = false))
    }

    @Test
    fun `searching only while something is typed`() {
        assertFalse(BrowseLogic.isSearching(""))
        assertFalse(BrowseLogic.isSearching("   "))
        assertTrue(BrowseLogic.isSearching("a"))
    }

    @Test
    fun `the request is prefilled with the matching kind`() {
        assertEquals(TitleRequestLogic.Kind.ALL, BrowseLogic.requestKindFor(BrowseFilter.ALL))
        assertEquals(TitleRequestLogic.Kind.MOVIE, BrowseLogic.requestKindFor(BrowseFilter.FILMS))
        assertEquals(TitleRequestLogic.Kind.TV, BrowseLogic.requestKindFor(BrowseFilter.SHOWS))
    }

    @Test
    fun `All's genres merge by name`() {
        assertEquals(
            listOf("Animation", "Comedy", "Drama", "Kids"),
            BrowseLogic.mergedGenreNames(listOf("Comedy", "Drama", "Animation"), listOf("comedy", "Kids", "", "Animation"))
        )
    }

    @Test
    fun `genre membership uses each kind's own ids`() {
        val movieGenres = mapOf(35 to "Comedy", 18 to "Drama")
        val tvGenres = mapOf(10762 to "Kids", 35 to "Comedy")
        assertTrue(BrowseLogic.inGenre(listOf(18, 35), movieGenres, "comedy"))
        assertFalse(BrowseLogic.inGenre(listOf(18), movieGenres, "Comedy"))
        assertTrue(BrowseLogic.inGenre(listOf(10762), tvGenres, "Kids"))
        assertTrue(BrowseLogic.inGenre(emptyList(), tvGenres, null))
    }

    @Test
    fun `combined TV genres are split into the film genres`() {
        assertEquals(
            listOf("Action", "Adventure", "Comedy", "Fantasy", "Politics", "Science Fiction", "War"),
            BrowseLogic.mergedGenreNames(
                listOf("Action", "Science Fiction"),
                listOf("Action & Adventure", "Sci-Fi & Fantasy", "War & Politics", "Comedy")
            )
        )
        val tvGenres = mapOf(10759 to "Action & Adventure", 35 to "Comedy")
        assertTrue(BrowseLogic.inGenre(listOf(10759), tvGenres, "Action"))
        assertTrue(BrowseLogic.inGenre(listOf(10759), tvGenres, "adventure"))
        assertFalse(BrowseLogic.inGenre(listOf(10759), tvGenres, "Action & Adventure"))
        assertFalse(BrowseLogic.inGenre(listOf(35), tvGenres, "Action"))
    }

    @Test
    fun `genre chips count what the switch shows and hide empty genres`() {
        val filmGenres = mapOf(28 to "Action", 27 to "Horror")
        val showGenres = mapOf(10759 to "Action & Adventure", 10764 to "Reality")
        val films = listOf(listOf(28), listOf(28, 27))
        val shows = listOf(listOf(10759), listOf(10759))
        fun chips(f: BrowseFilter) =
            BrowseLogic.genreChips(films, shows, f, filmGenres, showGenres, { it }, { it })
                .map { "${it.name} ${it.count}" }
        assertEquals(listOf("Action 4", "Adventure 2", "Horror 1"), chips(BrowseFilter.ALL))
        assertEquals(listOf("Action 2", "Horror 1"), chips(BrowseFilter.FILMS))
        assertEquals(listOf("Action 2", "Adventure 2"), chips(BrowseFilter.SHOWS))
    }
}
