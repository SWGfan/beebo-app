package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.ContinueGrouping
import com.beeboentertainment.movie.core.LibraryClearKind
import com.beeboentertainment.movie.core.LibraryClearModel
import com.beeboentertainment.movie.core.LibraryRefreshPolicy
import com.beeboentertainment.movie.core.LiveProgressLogic
import com.beeboentertainment.movie.core.LiveProgressRepository
import com.beeboentertainment.movie.data.ContinueItem
import com.beeboentertainment.movie.data.Episode
import com.beeboentertainment.movie.data.EpisodesResponse
import com.beeboentertainment.movie.data.LibraryClearCounts
import com.beeboentertainment.movie.data.Season
import com.beeboentertainment.movie.data.ShelfItem
import com.beeboentertainment.movie.ui.HomeShelvesData
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** My Library: one row per show, rows that follow the player, the clear actions, the shelves. */
class LibraryLiveTest {

    private fun ep(id: String, title: String, t: Double = 600.0, d: Double = 2600.0) =
        ContinueItem(id = id, kind = "tv", title = title, currentTime = t, duration = d, percent = (t * 100 / d).toInt())

    private fun film(id: String, title: String) =
        ContinueItem(id = id, kind = "movie", title = title, currentTime = 900.0, duration = 6000.0, percent = 15)

    /* ------------------------------ grouping ------------------------------ */

    @Test
    fun `several episodes of one show become one row, the newest (old server order)`() {
        val rows = listOf(
            ep("e16", "House — S2E16 · Safe"),
            ep("e15", "House — S2E15 · Clueless"),
            ep("e14", "House — S2E14 · Sex Kills"),
            film("f1", "Heat"),
            ep("e11", "house — S2E11"),
            film("f2", "Alien")
        )
        assertEquals(listOf("e16", "f1", "f2"), ContinueGrouping.group(rows).map { it.id })
    }

    @Test
    fun `grouping ignores case, spacing and punctuation, and never merges films`() {
        assertEquals(ContinueGrouping.normaliseShowName("House"), ContinueGrouping.normaliseShowName("  house "))
        assertEquals(ContinueGrouping.normaliseShowName("Grey's Anatomy"), ContinueGrouping.normaliseShowName("GREYS  anatomy"))
        assertEquals(ContinueGrouping.normaliseShowName("Law & Order"), ContinueGrouping.normaliseShowName("Law and Order"))
        val films = listOf(film("a", "Same Title"), film("b", "Same Title"))
        assertEquals(2, ContinueGrouping.group(films).size)
    }

    /* ---------------------------- live progress ---------------------------- */

    @Test
    fun `player reports update the row at once and move it to the top`() {
        val repo = LiveProgressRepository()
        val rows = listOf(film("f1", "Heat"), ep("e16", "House — S2E16"))
        assertFalse(repo.report("e16", "tv", "House — S2E16", 1_300_000, 2_600_000, nowMs = 10_000))
        val shown = LiveProgressLogic.applyToContinue(rows, repo.entries.value, nowMs = 12_000)
        assertEquals(listOf("e16", "f1"), shown.map { it.id })
        assertEquals(50, shown[0].percent)
        assertEquals(1300.0, shown[0].currentTime, 0.0)
        assertTrue(repo.isPlaybackActive(12_000))
        assertFalse(repo.isPlaybackActive(10_000 + LiveProgressLogic.ACTIVE_WINDOW_MS))
    }

    @Test
    fun `crossing 95 percent is reported once, removes the row and ticks the episode`() {
        val repo = LiveProgressRepository()
        repo.report("e16", "tv", "House — S2E16", 2_000_000, 2_600_000, nowMs = 1)
        assertTrue(repo.report("e16", "tv", "House — S2E16", 2_480_000, 2_600_000, nowMs = 2))
        assertFalse("only the crossing", repo.report("e16", "tv", "House — S2E16", 2_500_000, 2_600_000, nowMs = 3))

        val rows = listOf(ep("e16", "House — S2E16"), film("f1", "Heat"))
        assertEquals(listOf("f1"), LiveProgressLogic.applyToContinue(rows, repo.entries.value, nowMs = 4).map { it.id })

        val history = LiveProgressLogic.applyToHistory(rows, repo.entries.value)
        assertEquals(listOf("e16", "f1"), history.map { it.id })
        assertTrue(history[0].watched)

        val episodes = EpisodesResponse(ok = true, seasons = listOf(Season(2, listOf(
            Episode(id = "e16", season = 2, episode = 16, watched = false),
            Episode(id = "e17", season = 2, episode = 17, watched = false)
        ))))
        val after = LiveProgressLogic.applyToEpisodes(episodes, repo.entries.value)
        val e16 = after.seasons[0].episodes[0]
        assertEquals(true, e16.watched)
        assertEquals(96, e16.watchedPercent)
        assertEquals(false, after.seasons[0].episodes[1].watched)
    }

    @Test
    fun `the next episode playing takes its show's row without waiting for the server`() {
        val repo = LiveProgressRepository()
        repo.report("e17", "tv", "House — S2E17", 60_000, 2_600_000, nowMs = 5, streamUrl = "https://home/tvfile?id=e17&mt=x")
        val rows = listOf(ep("e16", "House — S2E16"), film("f1", "Heat"))
        val shown = LiveProgressLogic.applyToContinue(rows, repo.entries.value, nowMs = 6)
        assertEquals(listOf("e17", "f1"), shown.map { it.id })
        assertEquals("https://home/tvfile?id=e17&mt=x", shown[0].stream)
        assertEquals(2, shown[0].percent)
    }

    @Test
    fun `nothing is added for a title the list does not have`() {
        val repo = LiveProgressRepository()
        repo.report("surfed", "movie", "Some Film", 600_000, 6_000_000, nowMs = 1)
        repo.report("other-ep", "tv", "Weeds — S1E1", 600_000, 1_600_000, nowMs = 1)
        val rows = listOf(ep("e16", "House — S2E16"))
        assertEquals(listOf("e16"), LiveProgressLogic.applyToContinue(rows, repo.entries.value, nowMs = 2).map { it.id })
    }

    @Test
    fun `server reports tick the refresh signal, and forget and clear drop entries`() {
        val repo = LiveProgressRepository()
        assertEquals(0, repo.serverChanges.value)
        repo.serverUpdated()
        assertEquals(1, repo.serverChanges.value)
        repo.report("a", "movie", "A", 100_000, 0, nowMs = 1)
        repo.report("b", "movie", "B", 100_000, 0, nowMs = 1)
        repo.forget(listOf("a"))
        assertEquals(setOf("b"), repo.entries.value.keys)
        repo.clear()
        assertTrue(repo.entries.value.isEmpty())
    }

    @Test
    fun `refresh policy never polls off screen and polls faster while playing`() {
        assertNull(LibraryRefreshPolicy.intervalMs(visible = false, playbackActive = true))
        assertEquals(LibraryRefreshPolicy.ACTIVE_INTERVAL_MS, LibraryRefreshPolicy.intervalMs(true, true))
        assertEquals(LibraryRefreshPolicy.IDLE_INTERVAL_MS, LibraryRefreshPolicy.intervalMs(true, false))
        assertTrue(LibraryRefreshPolicy.ACTIVE_INTERVAL_MS >= 30_000L)
        assertFalse(LibraryRefreshPolicy.shouldRefresh(nowMs = 10_000, lastRefreshMs = 8_000))
        assertTrue(LibraryRefreshPolicy.shouldRefresh(nowMs = 20_000, lastRefreshMs = 8_000))
    }

    /* ---------------------------- clear actions ---------------------------- */

    private class FakeApi(var counts: LibraryClearCounts?) : LibraryClearModel.Api {
        val cleared = mutableListOf<String>()
        var fail = false
        override suspend fun counts(): LibraryClearCounts? = counts
        override suspend fun clear(kind: LibraryClearKind): Pair<Int, LibraryClearCounts?> {
            if (fail) throw java.io.IOException("offline")
            cleared += kind.wire
            val c = counts!!
            val removed = kind.countIn(c)
            counts = when (kind) {
                LibraryClearKind.HISTORY -> c.copy(history = 0)
                LibraryClearKind.FAVOURITES -> c.copy(favourites = 0)
                LibraryClearKind.WATCHLIST -> c.copy(watchlist = 0)
                LibraryClearKind.WATCHED -> c.copy(watched = 0)
            }
            return removed to counts
        }
        override suspend fun clearHistoryLegacy() { cleared += "legacy-all" }
    }

    @Test
    fun `four separate actions with counts, each confirmed with what it removes`() = runTest {
        val api = FakeApi(LibraryClearCounts(history = 12, favourites = 1, watchlist = 0, watched = 30))
        val model = LibraryClearModel(api)
        model.load()
        val actions = model.state.value.actions
        assertEquals(
            listOf("Clear watch history (12)", "Clear favourites (1)", "Clear watchlist (0)", "Clear watched marks (30)"),
            actions.map { it.label }
        )
        assertEquals(listOf(true, true, false, true), actions.map { it.enabled })

        model.ask(LibraryClearKind.HISTORY)
        assertEquals(
            "Clear 12 titles from your watch history, with their resume points? Favourites, your watchlist and watched marks stay. This can't be undone.",
            model.state.value.confirmMessage
        )
        model.cancel()
        assertNull(model.state.value.pending)
        assertTrue("cancel clears nothing", api.cleared.isEmpty())

        model.ask(LibraryClearKind.WATCHED)
        assertEquals("Clear 30 watched marks? Your watch history stays. This can't be undone.", model.state.value.confirmMessage)
        assertEquals(LibraryClearKind.WATCHED, model.confirm())
        assertEquals(listOf("watched"), api.cleared)
        assertEquals(0, model.state.value.counts!!.watched)
        assertEquals(12, model.state.value.counts!!.history)
        assertEquals("Cleared 30 watched marks.", model.state.value.message)

        model.ask(LibraryClearKind.FAVOURITES)
        assertEquals("Remove 1 favourite? This can't be undone.", model.state.value.confirmMessage)
        assertNull("confirm without a pending action does nothing", LibraryClearModel(api).confirm())
    }

    @Test
    fun `an older server offers only clearing the whole history through the old route`() = runTest {
        val api = FakeApi(null)
        val model = LibraryClearModel(api)
        model.load()
        assertTrue(model.state.value.legacyServer)
        assertEquals(listOf(LibraryClearKind.HISTORY), model.state.value.actions.map { it.kind })
        model.ask(LibraryClearKind.WATCHED)
        assertNull("not offered", model.state.value.pending)
        model.ask(LibraryClearKind.HISTORY)
        assertTrue(model.state.value.confirmMessage!!.startsWith("Clear your whole watch history"))
        assertEquals(LibraryClearKind.HISTORY, model.confirm())
        assertEquals(listOf("legacy-all"), api.cleared)
    }

    @Test
    fun `a failed clear says so and changes nothing`() = runTest {
        val api = FakeApi(LibraryClearCounts(history = 3)).apply { fail = true }
        val model = LibraryClearModel(api)
        model.load()
        model.ask(LibraryClearKind.HISTORY)
        assertNull(model.confirm())
        assertEquals(3, model.state.value.counts!!.history)
        assertEquals("Couldn't reach your server, so nothing was cleared.", model.state.value.message)
    }

    /* ------------------------------ shelves ------------------------------ */

    @Test
    fun `moved shelves - a show tile opens its show, a film tile plays, empty draws nothing`() {
        val show = ShelfItem(id = "k", kind = "tv", title = "House", showKey = "house-key")
        val film = ShelfItem(id = "f", kind = "movie", title = "Heat", stream = "/file?id=f")
        assertTrue(HomeShelvesData.opensShow(show))
        assertEquals("house-key", HomeShelvesData.showKeyOf(show))
        assertEquals("k", HomeShelvesData.showKeyOf(show.copy(showKey = null)))
        assertFalse(HomeShelvesData.opensShow(film))
        assertTrue(HomeShelvesData().isEmpty)
        assertEquals("Recommended for you", HomeShelvesData(recommended = listOf(film)).recommendedHeading)
        assertEquals("Because you watched House", HomeShelvesData(recommendedReason = "Because you watched House").recommendedHeading)
    }
}
