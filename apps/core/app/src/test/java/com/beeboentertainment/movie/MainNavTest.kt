package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.BrowseFilter
import com.beeboentertainment.movie.core.LibrarySection
import com.beeboentertainment.movie.core.MainNav
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Home · Browse · Library · Play · More, and every older layout's route still lands somewhere. */
class MainNavTest {

    @Test
    fun `bottom bar is Home Browse Library Play More`() {
        assertEquals(listOf("home", "browse", "library", "play", "more"), MainNav.BOTTOM_TABS)
        listOf("movies", "tv", "surf", "games", "downloads").forEach { assertFalse(it in MainNav.BOTTOM_TABS) }
    }

    @Test
    fun `the TV rail has the same five destinations`() {
        assertEquals(MainNav.BOTTOM_TABS, MainNav.destinations(isTv = true))
        assertEquals(MainNav.destinations(isTv = false), MainNav.destinations(isTv = true))
        assertEquals(MainNav.HOME, MainNav.firstRailFocus())
        assertTrue(MainNav.firstRailFocus() in MainNav.destinations(isTv = true))
    }

    @Test
    fun `Movies and TV migrate to Browse with the switch set`() {
        assertEquals(MainNav.Migration(MainNav.BROWSE, browseFilter = BrowseFilter.FILMS), MainNav.migrate("movies"))
        assertEquals(MainNav.Migration(MainNav.BROWSE, browseFilter = BrowseFilter.SHOWS), MainNav.migrate("tv"))
    }

    @Test
    fun `old Library, Other and Downloads migrate to Home, Play and Library Downloads`() {
        assertEquals(MainNav.Migration(MainNav.HOME), MainNav.migrate("continue"))
        assertEquals(MainNav.Migration(MainNav.PLAY), MainNav.migrate("games"))
        assertEquals(
            MainNav.Migration(MainNav.LIBRARY, librarySection = LibrarySection.DOWNLOADS),
            MainNav.migrate("downloads")
        )
    }

    @Test
    fun `every legacy route migrates to a real tab, and new routes do not migrate`() {
        MainNav.LEGACY_ROUTES.forEach { route ->
            val target = MainNav.migrate(route)?.route
            assertTrue("$route -> $target", target in MainNav.BOTTOM_TABS)
        }
        MainNav.BOTTOM_TABS.forEach { assertNull(MainNav.migrate(it)) }
        assertNull(MainNav.migrate(null))
        assertNull(MainNav.migrate("show/{key}"))
    }

    @Test
    fun `Surf is still a screen, owned by Home, and Stories by Play`() {
        assertNull(MainNav.migrate("surf"))
        assertFalse("surf" in MainNav.LEGACY_ROUTES)
        assertEquals(MainNav.HOME, MainNav.tabFor("surf"))
        assertEquals(MainNav.PLAY, MainNav.tabFor("stories"))
    }

    @Test
    fun `old routes light up their new tab`() {
        assertEquals(MainNav.BROWSE, MainNav.tabFor("movies"))
        assertEquals(MainNav.BROWSE, MainNav.tabFor("tv"))
        assertEquals(MainNav.HOME, MainNav.tabFor("continue"))
        assertEquals(MainNav.PLAY, MainNav.tabFor("games"))
        assertEquals(MainNav.LIBRARY, MainNav.tabFor("downloads"))
    }

    @Test
    fun `every bottom tab owns itself`() {
        MainNav.BOTTOM_TABS.forEach { assertEquals(it, MainNav.tabFor(it)) }
    }

    @Test
    fun `pushed screens and unknown routes own no tab`() {
        assertNull(MainNav.tabFor(null))
        assertNull(MainNav.tabFor("show/{key}"))
        assertNull(MainNav.tabFor("campsite"))
        assertNull(MainNav.tabFor(""))
    }

    @Test
    fun `saved section and switch names restore, and junk falls back`() {
        LibrarySection.entries.forEach { assertEquals(it, LibrarySection.fromName(it.name)) }
        assertEquals(LibrarySection.WATCHLIST, LibrarySection.fromName("CONTINUE"))
        assertEquals(LibrarySection.WATCHLIST, LibrarySection.fromName(null))
        BrowseFilter.entries.forEach { assertEquals(it, BrowseFilter.fromName(it.name)) }
        assertEquals(BrowseFilter.ALL, BrowseFilter.fromName("nope"))
    }

    @Test
    fun `Library sections are Watchlist, Favourites, History, Downloads`() {
        assertEquals(
            listOf(LibrarySection.WATCHLIST, LibrarySection.FAVOURITES, LibrarySection.PLAYLISTS, LibrarySection.HISTORY, LibrarySection.DOWNLOADS),
            LibrarySection.entries.toList()
        )
    }
}
