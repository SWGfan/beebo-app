package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.MimeGuess
import com.beeboentertainment.movie.core.SurfFilters
import com.beeboentertainment.movie.core.SurfItemRouting
import com.beeboentertainment.movie.core.SurfNav
import com.beeboentertainment.movie.core.SurfPoolSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The three surf axes: kind (movie/tv/both), genre, and the year/decade slice. */
class SurfFiltersTest {

    /* ------------------------------- kind ------------------------------- */

    @Test
    fun `three kinds with labels and emoji`() {
        assertEquals(listOf("movie", "tv", "both"), SurfFilters.KINDS)
        assertEquals("Movies", SurfFilters.kindLabel("movie"))
        assertEquals("TV Shows", SurfFilters.kindLabel("tv"))
        assertEquals("Both", SurfFilters.kindLabel("both"))
        assertEquals("🎬", SurfFilters.kindEmoji("movie"))
        assertEquals("📺", SurfFilters.kindEmoji("tv"))
        assertEquals("🍿", SurfFilters.kindEmoji("both"))
    }

    @Test
    fun `changing kind resets genre and year because the pool is different`() {
        val f = SurfFilters("movie").withGenre(35, "Comedy").withYear(1994)
        val switched = f.withKind("both")
        assertEquals("both", switched.kind)
        assertNull(switched.genreId)
        assertNull(switched.year)
        assertNull(switched.decade)
    }

    @Test
    fun `re-selecting the same kind changes nothing`() {
        val f = SurfFilters("tv").withGenre(18, "Drama")
        assertEquals(f, f.withKind("tv"))
    }

    @Test
    fun `an unknown kind falls back to movies rather than being sent to the server`() {
        assertEquals("movie", SurfFilters("movie").withKind("nonsense").kind)
        assertFalse(SurfFilters.isValidKind("nonsense"))
        assertTrue(SurfFilters.isValidKind("both"))
    }

    /* --------------------------- decade / year --------------------------- */

    @Test
    fun `decade arithmetic`() {
        assertEquals(1990, SurfFilters.decadeOf(1994))
        assertEquals(1990, SurfFilters.decadeOf(1990))
        assertEquals(1990, SurfFilters.decadeOf(1999))
        assertEquals(2020, SurfFilters.decadeOf(2024))
        assertEquals("1990s", SurfFilters.decadeLabel(1990))
        assertTrue(SurfFilters.yearInDecade(1999, 1990))
        assertFalse(SurfFilters.yearInDecade(2000, 1990))
    }

    @Test
    fun `picking a year remembers its decade so the year chips stay expanded`() {
        val f = SurfFilters("movie").withYear(1994)
        assertEquals(1994, f.year)
        assertEquals(1990, f.decade)
    }

    @Test
    fun `at most one of year and decade is ever sent to the server`() {
        val decadeOnly = SurfFilters("movie").withDecade(1990)
        assertEquals(1990, decadeOnly.requestDecade)
        assertNull(decadeOnly.requestYear)

        // narrowing to a specific year suppresses the decade parameter
        val yearPicked = decadeOnly.withYear(1994)
        assertEquals(1994, yearPicked.requestYear)
        assertNull(yearPicked.requestDecade)

        // widening back out to the whole decade restores it
        val widened = yearPicked.withDecade(1990)
        assertEquals(1990, widened.requestDecade)
        assertNull(widened.requestYear)
    }

    @Test
    fun `selecting a decade preserves the genre and vice versa`() {
        val withGenreThenYear = SurfFilters("both").withGenre(35, "Comedy").withDecade(1990)
        assertEquals(35, withGenreThenYear.genreId)
        assertEquals(1990, withGenreThenYear.decade)

        val withYearThenGenre = SurfFilters("both").withDecade(1990).withGenre(35, "Comedy")
        assertEquals(35, withYearThenGenre.genreId)
        assertEquals(1990, withYearThenGenre.decade)

        // and they compose to the same request
        assertEquals(withGenreThenYear.genreParam, withYearThenGenre.genreParam)
        assertEquals(withGenreThenYear.requestDecade, withYearThenGenre.requestDecade)
    }

    @Test
    fun `clearing one axis leaves the other alone`() {
        val f = SurfFilters("movie").withGenre(28, "Action").withYear(1994)
        assertEquals(28, f.clearTime().genreId)
        assertFalse(f.clearTime().hasTimeFilter)
        assertNull(f.clearGenre().genreId)
        assertEquals(1994, f.clearGenre().year)
    }

    @Test
    fun `clear all keeps the kind`() {
        val f = SurfFilters("both").withGenre(28, "Action").withYear(1994).clearAll()
        assertEquals("both", f.kind)
        assertFalse(f.hasAnyFilter)
    }

    @Test
    fun `genre param is the raw id or nothing`() {
        assertNull(SurfFilters("movie").genreParam)
        assertEquals("28", SurfFilters("movie").withGenre(28, "Action").genreParam)
        // id 0 is "no genre", not a real tmdb id
        assertNull(SurfFilters("movie").withGenre(0, "Bogus").genreParam)
    }

    /* -------------------------------- labels ------------------------------ */

    @Test
    fun `summary reads the way the owner asked for it`() {
        assertEquals(
            "Movies · Comedy · 1990s",
            SurfFilters("movie").withGenre(35, "Comedy").withDecade(1990).summary()
        )
        assertEquals(
            "Both · Any category · Any year",
            SurfFilters("both").summary()
        )
        assertEquals(
            "TV Shows · Drama · 1994",
            SurfFilters("tv").withGenre(18, "Drama").withYear(1994).summary()
        )
        assertEquals(
            "Comedy · 1990s",
            SurfFilters("movie").withGenre(35, "Comedy").withDecade(1990).summary(includeKind = false)
        )
    }

    @Test
    fun `empty pool message names only the filters that are actually on`() {
        assertEquals("Movies", SurfFilters("movie").activeFilterSummary())
        assertEquals(
            "Both · Comedy · 1994",
            SurfFilters("both").withGenre(35, "Comedy").withYear(1994).activeFilterSummary()
        )
    }

    /* ------------------------------ pool size ----------------------------- */

    @Test
    fun `a genre chip count is already the genre plus year pool size`() {
        val f = SurfFilters("movie").withGenre(35, "Comedy").withDecade(1990)
        val size = SurfPoolSize.estimate(
            filters = f,
            genreCounts = listOf(28 to 9, 35 to 4),   // counts already respect the 1990s filter
            decadeCounts = listOf(1990 to 12),
            yearCounts = listOf(1994 to 3),
            total = 40
        )
        assertEquals(4, size)
    }

    @Test
    fun `with no genre the year buckets size the pool`() {
        val base = SurfFilters("both")
        assertEquals(
            40,
            SurfPoolSize.estimate(base, emptyList(), emptyList(), emptyList(), 40)
        )
        assertEquals(
            12,
            SurfPoolSize.estimate(
                base.withDecade(1990), emptyList(), listOf(1990 to 12), listOf(1994 to 3), 40
            )
        )
        assertEquals(
            3,
            SurfPoolSize.estimate(
                base.withYear(1994), emptyList(), listOf(1990 to 12), listOf(1994 to 3), 40
            )
        )
    }

    @Test
    fun `a combination the server has nothing for sizes to zero, not to the total`() {
        val f = SurfFilters("tv").withGenre(99, "Nothing").withYear(1900)
        assertEquals(0, SurfPoolSize.estimate(f, listOf(28 to 9), listOf(1990 to 12), listOf(1994 to 3), 40))
    }

    /* --------------------------- kind=both routing ------------------------- */

    @Test
    fun `in a mixed pool the item kind wins over the pool kind`() {
        assertEquals("tv", SurfItemRouting.kindOf("tv", "both"))
        assertEquals("movie", SurfItemRouting.kindOf("movie", "both"))
    }

    @Test
    fun `both is never returned as an item kind`() {
        // "both" describes a pool, not a thing you can watch
        assertEquals("movie", SurfItemRouting.kindOf("both", "both"))
        assertEquals("movie", SurfItemRouting.kindOf(null, "both"))
        assertEquals("tv", SurfItemRouting.kindOf(null, "tv"))
    }

    @Test
    fun `stream path identifies the kind and outranks a disagreeing item kind`() {
        assertEquals("tv", SurfItemRouting.kindFromStreamPath("/tvfile?id=abc&mt=t"))
        assertEquals("movie", SurfItemRouting.kindFromStreamPath("/file?id=abc&mt=t"))
        assertNull(SurfItemRouting.kindFromStreamPath("/something-else?id=abc"))
        assertNull(SurfItemRouting.kindFromStreamPath(null))

        assertEquals("tv", SurfItemRouting.resolveKind("movie", "/tvfile?id=abc&mt=t", "both"))
        assertEquals("movie", SurfItemRouting.resolveKind(null, "/file?id=abc&mt=t", "both"))
        // unknown path -> fall back to the item's own kind
        assertEquals("tv", SurfItemRouting.resolveKind("tv", "/weird?id=abc", "both"))
    }

    @Test
    fun `mixed pool items get their own mime type from their own stream url`() {
        val tvUrl = "http://host:47811/tvfile?id=" +
            java.net.URLEncoder.encode(
                java.util.Base64.getEncoder().encodeToString("/tv/Show/S01E02.mkv".toByteArray()),
                "UTF-8"
            ) + "&mt=t"
        val movieUrl = "http://host:47811/file?path=%2Fmovies%2FHeat.mp4&mt=t"

        assertEquals("video/x-matroska", SurfItemRouting.mimeFor(tvUrl, "Show — S1E2"))
        assertEquals("video/mp4", SurfItemRouting.mimeFor(movieUrl, "Heat"))
        // and it agrees with the plain guesser the player uses for library items
        assertEquals(MimeGuess.forStreamUrl(tvUrl, null), SurfItemRouting.mimeFor(tvUrl, null))
    }

    /* --------------------------- mixed pool wrapping ----------------------- */

    @Test
    fun `index wrapping still holds for a mixed movies-plus-tv pool`() {
        val total = 57   // e.g. 40 movies + 17 episodes
        assertEquals(56, SurfNav.previous(0, total))
        assertEquals(0, SurfNav.next(56, total))
        assertEquals(1, SurfNav.wrap(58, total))
        assertEquals("1 of 57", SurfNav.label(0, total))
        assertEquals("57 of 57", SurfNav.label(56, total))
    }
}
