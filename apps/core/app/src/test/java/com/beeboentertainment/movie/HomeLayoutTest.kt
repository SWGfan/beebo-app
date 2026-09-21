package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.HomeLayout
import com.beeboentertainment.movie.core.HomeSection
import com.beeboentertainment.movie.core.KeyValueStore
import com.beeboentertainment.movie.core.NavTip
import com.beeboentertainment.movie.data.ContinueItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeLayoutTest {

    @Test
    fun `Continue watching comes first, then Up next and the shelves`() {
        assertEquals(
            listOf(
                HomeSection.CONTINUE, HomeSection.UP_NEXT, HomeSection.RECENTLY_ADDED,
                HomeSection.BECAUSE_YOU_WATCHED, HomeSection.COLLECTIONS
            ),
            HomeLayout.ORDER
        )
        assertEquals("Continue watching", HomeLayout.ORDER.first().heading)
    }

    @Test
    fun `empty sections draw nothing and order is kept`() {
        assertEquals(
            listOf(HomeSection.CONTINUE, HomeSection.BECAUSE_YOU_WATCHED),
            HomeLayout.visibleSections(2, 0, 0, 5, 0)
        )
        assertEquals(
            listOf(HomeSection.UP_NEXT, HomeSection.RECENTLY_ADDED, HomeSection.COLLECTIONS),
            HomeLayout.visibleSections(0, 1, 3, 0, 4)
        )
        assertEquals(emptyList<HomeSection>(), HomeLayout.visibleSections(0, 0, 0, 0, 0))
        assertEquals(HomeLayout.ORDER, HomeLayout.visibleSections(1, 1, 1, 1, 1))
    }

    @Test
    fun `not-started next episodes are Up next, everything with progress is Continue`() {
        val rows = listOf(
            ContinueItem(id = "a", kind = "movie", currentTime = 600.0),
            ContinueItem(id = "b", kind = "tv", upNext = true, currentTime = 0.0),
            ContinueItem(id = "c", kind = "tv", upNext = true, currentTime = 30.0),
            ContinueItem(id = "d", kind = "tv", currentTime = 10.0)
        )
        val (continuing, upNext) = HomeLayout.split(rows)
        assertEquals(listOf("a", "c", "d"), continuing.map { it.id })
        assertEquals(listOf("b"), upNext.map { it.id })
    }

    @Test
    fun `shelves load only after Continue has painted`() {
        assertFalse(HomeLayout.shelvesMayLoad(continueLoading = true))
        assertTrue(HomeLayout.shelvesMayLoad(continueLoading = false))
    }

    private class MemoryStore : KeyValueStore {
        val map = HashMap<String, Long>()
        override fun getLong(key: String, default: Long) = map[key] ?: default
        override fun putLong(key: String, value: Long) { map[key] = value }
        override fun remove(key: String) { map.remove(key) }
        override fun keys(): Set<String> = map.keys
    }

    @Test
    fun `the layout tip shows once to someone who used the old layout`() {
        val store = MemoryStore()
        assertTrue(NavTip.shouldShow(store, hadOldLayout = true))
        // Not dismissed yet: still shows on the next launch.
        assertTrue(NavTip.shouldShow(store, hadOldLayout = true))
        NavTip.dismiss(store)
        assertFalse(NavTip.shouldShow(store, hadOldLayout = true))
    }

    @Test
    fun `a new install never sees the tip`() {
        val store = MemoryStore()
        assertFalse(NavTip.shouldShow(store, hadOldLayout = false))
        // ...and not later either, once it has been set up.
        assertFalse(NavTip.shouldShow(store, hadOldLayout = true))
    }

    @Test
    fun `tip wording names the five destinations`() {
        listOf("Home", "Browse", "Library", "Play", "More", "Movies and TV are together in Browse").forEach {
            assertTrue(it, NavTip.TEXT.contains(it))
        }
    }
}
