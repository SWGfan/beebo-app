package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.MissingTitlesLogic
import com.beeboentertainment.movie.core.MissingTitlesLogic.RequestState
import com.beeboentertainment.movie.core.SearchSiteLogic
import com.beeboentertainment.movie.core.TrailerLogic
import com.beeboentertainment.movie.data.ActorMissingResponse
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.MissingTitle
import com.beeboentertainment.movie.data.MoviesResponse
import com.beeboentertainment.movie.data.RequestRef
import com.beeboentertainment.movie.data.SearchSite
import com.beeboentertainment.movie.data.SearchSitesResponse
import com.beeboentertainment.movie.data.TrailerResponse
import com.beeboentertainment.movie.data.TvShowsResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActorPageLogicTest {

    private val json = ApiClient.JSON

    /* ------------------------------- trailers ------------------------------- */

    @Test
    fun trailerUrisTryTheYouTubeAppThenTheWeb() {
        assertEquals(
            listOf("vnd.youtube:dlnmQbPGuls", "https://www.youtube.com/watch?v=dlnmQbPGuls"),
            TrailerLogic.launchOrder("dlnmQbPGuls")
        )
        assertEquals("vnd.youtube:a_b-c1234", TrailerLogic.appUri("a_b-c1234"))
    }

    @Test
    fun oddKeysNeverReachAUrl() {
        assertEquals(emptyList<String>(), TrailerLogic.launchOrder(null))
        assertEquals(emptyList<String>(), TrailerLogic.launchOrder(""))
        assertEquals(emptyList<String>(), TrailerLogic.launchOrder("abc&list=evil"))
        assertEquals(emptyList<String>(), TrailerLogic.launchOrder("../../x"))
        assertNull(TrailerLogic.webUrl("has space1"))
        assertFalse(TrailerLogic.isValidKey("x".repeat(40)))
    }

    @Test
    fun trailerButtonOnlyForMatchedTitles() {
        assertTrue(TrailerLogic.canShow(854))
        assertFalse(TrailerLogic.canShow(null))
        assertFalse(TrailerLogic.canShow(0))
        assertFalse(TrailerLogic.canShow(-3))
    }

    /* ----------------------------- search sites ----------------------------- */

    @Test
    fun encodesLikeEncodeUriComponent() {
        assertEquals("Am%C3%A9lie%20%26%20Co.%20(2001)!~*'", SearchSiteLogic.encodeComponent("Amélie & Co. (2001)!~*'"))
        assertEquals("a%2Fb%3Fc%3Dd%23e%2Bf", SearchSiteLogic.encodeComponent("a/b?c=d#e+f"))
    }

    @Test
    fun builtInSitesSearchTitleAndYear() {
        val imdb = SearchSite("imdb", "IMDb", "https://www.imdb.com/find/?q={query}&s=tt", appendYear = true)
        assertEquals("https://www.imdb.com/find/?q=The%20Truman%20Show%201998&s=tt", SearchSiteLogic.url(imdb, "The Truman Show", 1998))
        assertEquals("https://www.imdb.com/find/?q=Kidding&s=tt", SearchSiteLogic.url(imdb, "Kidding", null))
    }

    @Test
    fun customSitesSearchTheTitleAlone() {
        val custom = SearchSite("custom", "My Tracker", "https://tracker.example/s?q={query}&cat=1", appendYear = false)
        assertEquals("https://tracker.example/s?q=Liar%20Liar&cat=1", SearchSiteLogic.url(custom, "  Liar Liar ", 1997))
        assertEquals("Search My Tracker", SearchSiteLogic.buttonLabel(custom))
        assertTrue(SearchSiteLogic.showGoogleToo(custom))
    }

    @Test
    fun anythingUnusableFallsBackToGoogle() {
        val google = "https://www.google.com/search?q=The%20Mask%201994"
        assertEquals(google, SearchSiteLogic.url(null, "The Mask", 1994))
        assertEquals(google, SearchSiteLogic.url(SearchSite("custom", "Broken", "https://x.example/no-slot", false), "The Mask", 1994))
        assertEquals(google, SearchSiteLogic.url(SearchSite("custom", "Script", "javascript:alert('{query}')", false), "The Mask", 1994))
        assertEquals("Search Google", SearchSiteLogic.buttonLabel(null))
        assertFalse(SearchSiteLogic.showGoogleToo(null))
    }

    @Test
    fun siteIsChosenPerKind() {
        val films = SearchSite("custom", "Films Site", "https://f.example/?q={query}", false)
        val tv = SearchSite("bing", "Bing", "https://www.bing.com/search?q={query}", true)
        assertEquals("Films Site", SearchSiteLogic.siteFor("movie", films, tv).name)
        assertEquals("Bing", SearchSiteLogic.siteFor("tv", films, tv).name)
        assertEquals("Google", SearchSiteLogic.siteFor("tv", films, null).name)
    }

    /* --------------------------- not in your library -------------------------- */

    private val serverBody = """
        {"ok":true,"person":{"id":206,"name":"Jim Carrey"},"items":[
          {"tmdbId":37165,"kind":"movie","title":"The Truman Show","year":1998,"poster":"https://image.tmdb.org/t/p/w300/truman.jpg",
           "voteCount":18000,"character":"Truman Burbank","overview":"He does not know.","request":null},
          {"tmdbId":80000,"kind":"tv","title":"Kidding","year":2018,"poster":null,"voteCount":300,"character":"Jeff","overview":null,
           "request":{"id":"r1","status":"requested","mine":false}},
          {"tmdbId":854,"kind":"movie","title":"The Mask","year":1994,"poster":null,"voteCount":9000,"character":"","overview":null,"request":null}
        ],"someFutureField":1}
    """.trimIndent()

    @Test
    fun parsesTheServerShape() {
        val r = json.decodeFromString(ActorMissingResponse.serializer(), serverBody)
        assertTrue(r.ok)
        assertEquals("Jim Carrey", r.person?.name)
        assertEquals(3, r.items.size)
        assertEquals("tv", r.items[1].kind)
        assertEquals("r1", r.items[1].request?.id)

        val empty = json.decodeFromString(ActorMissingResponse.serializer(), """{"ok":true,"person":{"id":1,"name":null},"items":[],"reason":"no_api_key"}""")
        assertEquals(emptyList<MissingTitle>(), empty.items)
        assertEquals("no_api_key", empty.reason)

        val t = json.decodeFromString(TrailerResponse.serializer(), """{"ok":true,"youtubeKey":null,"name":null}""")
        assertNull(t.youtubeKey)
        val sites = json.decodeFromString(
            SearchSitesResponse.serializer(),
            """{"ok":true,"movies":{"engine":"custom","name":"My Tracker","urlTemplate":"https://t.example/?q={query}","appendYear":false},"tv":{"engine":"google","name":"Google","urlTemplate":"https://www.google.com/search?q={query}","appendYear":true}}"""
        )
        assertEquals("My Tracker", sites.movies?.name)
        assertFalse(sites.movies!!.appendYear)
    }

    @Test
    fun libraryListsCarryTmdbIdsAndOlderServersDefaultToNull() {
        val movies = json.decodeFromString(MoviesResponse.serializer(), """{"ok":true,"items":[{"id":"a","title":"The Mask","tmdbId":854},{"id":"b","title":"Old"}]}""")
        assertEquals(854, movies.items[0].tmdbId)
        assertNull(movies.items[1].tmdbId)
        val shows = json.decodeFromString(TvShowsResponse.serializer(), """{"ok":true,"items":[{"key":"k","name":"In Living Color","tmdbId":70000}]}""")
        assertEquals(70000, shows.items[0].tmdbId)
    }

    @Test
    fun splitsAndDropsAnythingAlreadyOwnedOnScreen() {
        val items = json.decodeFromString(ActorMissingResponse.serializer(), serverBody).items
        val kept = MissingTitlesLogic.withoutOwned(items, ownedMovieIds = setOf(854), ownedShowIds = setOf(37165))
        assertEquals(listOf(37165, 80000), kept.map { it.tmdbId })
        assertEquals(listOf(37165), MissingTitlesLogic.films(kept).map { it.tmdbId })
        assertEquals(listOf(80000), MissingTitlesLogic.shows(kept).map { it.tmdbId })
        assertEquals(emptyList<MissingTitle>(), MissingTitlesLogic.films(listOf(MissingTitle(tmdbId = 0, title = "Bad"))))
    }

    @Test
    fun wordingIsPlain() {
        val truman = MissingTitle(tmdbId = 1, kind = "movie", title = "The Truman Show", year = 1998, character = "Truman Burbank")
        assertEquals("Film · 1998", MissingTitlesLogic.subtitle(truman))
        assertEquals("TV show", MissingTitlesLogic.subtitle(MissingTitle(tmdbId = 2, kind = "tv")))
        assertEquals("as Truman Burbank", MissingTitlesLogic.roleLine(truman))
        assertNull(MissingTitlesLogic.roleLine(truman.copy(character = " ")))
        assertEquals("Not owned", MissingTitlesLogic.badge(truman))
        assertEquals("Request this title", MissingTitlesLogic.requestButtonLabel(truman))
    }

    @Test
    fun requestStatesFollowTheExistingRequestFlow() {
        val base = MissingTitle(tmdbId = 7, kind = "movie", title = "X")
        assertEquals(RequestState.REQUEST, MissingTitlesLogic.requestState(base))
        assertTrue(MissingTitlesLogic.canRequest(base))
        val others = base.copy(request = RequestRef("r", "requested", mine = false))
        assertEquals(RequestState.JOIN, MissingTitlesLogic.requestState(others))
        assertTrue(MissingTitlesLogic.canRequest(others))
        assertEquals("Someone asked", MissingTitlesLogic.badge(others))
        val mine = base.copy(request = RequestRef("r", "requested", mine = true))
        assertFalse(MissingTitlesLogic.canRequest(mine))
        assertEquals("Requested", MissingTitlesLogic.badge(mine))
        assertFalse(MissingTitlesLogic.canRequest(base.copy(request = RequestRef("r", "dismissed"))))
        assertEquals(RequestState.ADDED, MissingTitlesLogic.requestState(base.copy(request = RequestRef("r", "added"))))
    }

    @Test
    fun aRequestMarksOnlyThatTile() {
        val list = listOf(MissingTitle(tmdbId = 7, kind = "movie"), MissingTitle(tmdbId = 7, kind = "tv"))
        val after = MissingTitlesLogic.markRequested(list, "movie", 7, "r9", "requested")
        assertEquals(RequestRef("r9", "requested", mine = true), after[0].request)
        assertNull(after[1].request)
    }
}
