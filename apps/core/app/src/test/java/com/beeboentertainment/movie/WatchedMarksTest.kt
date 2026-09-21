package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.WatchedMarks
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.ContinueItem
import com.beeboentertainment.movie.data.ContinueResponse
import com.beeboentertainment.movie.data.Episode
import com.beeboentertainment.movie.data.EpisodesResponse
import com.beeboentertainment.movie.data.Season
import com.beeboentertainment.movie.data.WatchedMarkResponse
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Watched marks: the tick rule, season/show progress, local updates and the request bodies. */
class WatchedMarksTest {

    private val json = ApiClient.JSON

    private fun ep(id: String, season: Int?, watched: Boolean? = null, at: Long? = null, pct: Int = 0) =
        Episode(id = id, season = season, episode = 1, watched = watched, watchedAt = at, watchedPercent = pct)

    private val show = EpisodesResponse(
        ok = true,
        seasons = listOf(
            Season(1, listOf(ep("a", 1, watched = true, at = 10L, pct = 100), ep("b", 1, watched = false, at = 20L, pct = 40))),
            Season(2, listOf(ep("c", 2, watched = false))),
            Season(null, listOf(ep("u", null, watched = false)))
        )
    )

    /* -------------------------------- the tick -------------------------------- */

    @Test
    fun `the server's watched flag wins over percentages`() {
        assertTrue(WatchedMarks.isWatched(ep("x", 1, watched = true)))
        assertFalse(WatchedMarks.isWatched(ep("x", 1, watched = false, at = 5L, pct = 100)))
    }

    @Test
    fun `an older server without the flag falls back to the 95 percent rule`() {
        assertTrue(WatchedMarks.isWatched(ep("x", 1, watched = null, at = 5L, pct = 95)))
        assertFalse(WatchedMarks.isWatched(ep("x", 1, watched = null, at = 5L, pct = 94)))
        assertFalse(WatchedMarks.isWatched(ep("x", 1, watched = null, at = null, pct = 100)))
    }

    @Test
    fun `episode json with and without watched`() {
        val newer = json.decodeFromString(Episode.serializer(), """{"id":"a","watched":true,"watchedAt":null,"watchedPercent":100}""")
        assertEquals(true, newer.watched)
        val older = json.decodeFromString(Episode.serializer(), """{"id":"a","watchedAt":5,"watchedPercent":97}""")
        assertNull(older.watched)
        assertTrue(WatchedMarks.isWatched(older))
    }

    /* -------------------------------- progress -------------------------------- */

    @Test
    fun `season and show progress offer watched until everything is`() {
        val s1 = WatchedMarks.progress(show.seasons[0].episodes)
        assertEquals(1, s1.watched)
        assertEquals(2, s1.total)
        assertEquals("1 of 2 watched", s1.label)
        assertTrue(s1.nextMarkIsWatched)
        assertEquals("Mark season watched", WatchedMarks.seasonMenuLabel(s1))

        val all = WatchedMarks.Progress(3, 3)
        assertTrue(all.all)
        assertFalse(all.nextMarkIsWatched)
        assertEquals("All watched", all.label)
        assertEquals("Mark show unwatched", WatchedMarks.showMenuLabel(all))

        assertEquals("", WatchedMarks.Progress(0, 4).label)
        assertEquals("", WatchedMarks.Progress(0, 0).label)
        assertFalse(WatchedMarks.Progress(0, 0).all)

        assertEquals(WatchedMarks.Progress(1, 4), WatchedMarks.showProgress(show))
        assertEquals(listOf("u"), WatchedMarks.seasonIds(show, null))
        assertEquals(listOf("a", "b", "c", "u"), WatchedMarks.showIds(show))
    }

    /* ----------------------------- local updates ----------------------------- */

    @Test
    fun `a confirmed watched mark ticks exactly the returned ids`() {
        val out = WatchedMarks.applyToEpisodes(show, listOf("b", "c"), watched = true, nowMs = 999L)
        val byId = out.seasons.flatMap { it.episodes }.associateBy { it.id }
        assertEquals(true, byId.getValue("b").watched)
        assertEquals(100, byId.getValue("b").watchedPercent)
        assertEquals(20L, byId.getValue("b").watchedAt) // the last-played date is kept
        assertEquals(999L, byId.getValue("c").watchedAt) // never played: now
        assertEquals(false, byId.getValue("u").watched)
        assertTrue(WatchedMarks.showProgress(out).watched == 3)
    }

    @Test
    fun `a confirmed unwatched mark leaves no watched line`() {
        val out = WatchedMarks.applyToEpisodes(show, listOf("a"), watched = false, nowMs = 999L)
        val a = out.seasons[0].episodes[0]
        assertEquals(false, a.watched)
        assertNull(a.watchedAt)
        assertEquals(0, a.watchedPercent)
        assertFalse(WatchedMarks.isWatched(a))
        assertEquals(show, WatchedMarks.applyToEpisodes(show, emptyList(), watched = true, nowMs = 1L))
    }

    @Test
    fun `continue watching drops watched items and restores nothing on unwatch`() {
        val rows = listOf(ContinueItem(id = "a"), ContinueItem(id = "b"), ContinueItem(id = "c"))
        assertEquals(listOf("c"), WatchedMarks.continueAfter(rows, listOf("a", "b"), watched = true).map { it.id })
        assertEquals(rows, WatchedMarks.continueAfter(rows, listOf("a"), watched = false))
    }

    @Test
    fun `all history keeps the rows and flips the tick`() {
        val rows = listOf(ContinueItem(id = "a"), ContinueItem(id = "b", watched = true))
        val marked = WatchedMarks.historyAfter(rows, listOf("a"), watched = true)
        assertEquals(listOf(true, true), marked.map { it.watched })
        val unmarked = WatchedMarks.historyAfter(marked, listOf("b"), watched = false)
        assertEquals(listOf(true, false), unmarked.map { it.watched })
    }

    /* ------------------------------ wire shapes ------------------------------ */

    @Test
    fun `the Unsorted season is sent as an explicit null`() {
        val body = json.parseToJsonElement(WatchedMarks.seasonBody("key", null, true)).jsonObject
        assertTrue("season must be present", body.containsKey("season"))
        assertEquals(JsonNull, body["season"])
        assertEquals(JsonPrimitive(true), body["watched"])
        val numbered = json.parseToJsonElement(WatchedMarks.seasonBody("key", 2, false)).jsonObject
        assertEquals(JsonPrimitive(2), numbered["season"])
        assertEquals(JsonPrimitive("key"), numbered["showKey"])
    }

    @Test
    fun `item and show bodies carry a real boolean`() {
        val item = json.parseToJsonElement(WatchedMarks.itemBody("id1", false)).jsonObject
        assertEquals(JsonPrimitive("id1"), item["id"])
        assertEquals(JsonPrimitive(false), item["watched"])
        val showBody = json.parseToJsonElement(WatchedMarks.showBody("sk", true)).jsonObject
        assertEquals(JsonPrimitive("sk"), showBody["showKey"])
    }

    @Test
    fun `mark response and continue rows parse`() {
        val r = json.decodeFromString(
            WatchedMarkResponse.serializer(),
            """{"ok":true,"watched":true,"count":2,"changed":1,"ids":["a","b"]}"""
        )
        assertEquals(listOf("a", "b"), r.ids)
        assertEquals(1, r.changed)
        val c = json.decodeFromString(ContinueResponse.serializer(), """{"ok":true,"items":[{"id":"a","watched":true},{"id":"b"}]}""")
        assertEquals(listOf(true, false), c.items.map { it.watched })
    }

    @Test
    fun `bulk confirmation says what is lost`() {
        assertEquals(
            "Mark 3 episodes of Season 1 as watched? They'll leave Continue Watching and lose their resume points.",
            WatchedMarks.bulkConfirmMessage("Season 1", 3, true)
        )
        assertTrue(WatchedMarks.bulkConfirmMessage("Show", 1, false).startsWith("Mark 1 episode of Show as unwatched?"))
    }
}
