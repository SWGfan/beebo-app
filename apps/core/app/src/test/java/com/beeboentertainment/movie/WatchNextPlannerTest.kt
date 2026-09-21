package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.DashboardText
import com.beeboentertainment.movie.core.WatchNextPlanner
import com.beeboentertainment.movie.core.WatchNextPlanner.Existing
import com.beeboentertainment.movie.core.WatchNextPlanner.Item
import com.beeboentertainment.movie.core.WatchNextPlanner.Type
import com.beeboentertainment.movie.data.AdminDashboardResponse
import com.beeboentertainment.movie.data.ApiClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The TV home screen's "Continue watching" row, and the phone's dashboard parsing. */
class WatchNextPlannerTest {

    private val now = 1_800_000_000_000L
    private fun item(id: String, pos: Double = 600.0, dur: Double = 6000.0, kind: String = "movie", upNext: Boolean = false) =
        Item(id = id, kind = kind, title = "Title $id", positionSeconds = pos, durationSeconds = dur, upNext = upNext)

    @Test fun `new items are inserted, barely started and finished ones are not`() {
        val plan = WatchNextPlanner.plan(
            listOf(item("a"), item("b", pos = 10.0), item("c", pos = 5800.0), item("d", pos = 0.0, kind = "tv", upNext = true), item("")),
            emptyList(), now
        )
        assertEquals(listOf("movie:a", "tv:d"), plan.insert.map { it.internalId })
        assertEquals(Type.CONTINUE, plan.insert[0].type)
        assertEquals(600_000L, plan.insert[0].positionMs)
        assertEquals(Type.NEXT, plan.insert[1].type)
        assertEquals(0L, plan.insert[1].positionMs)
        assertTrue("newest first keeps its order", plan.insert[0].lastEngagementMs > plan.insert[1].lastEngagementMs)
        assertTrue(plan.update.isEmpty() && plan.delete.isEmpty())
    }

    @Test fun `unchanged programs are left alone, moved ones updated, gone ones removed`() {
        val existing = listOf(
            Existing(1, "movie:a", 600_000, "Title a", Type.CONTINUE),
            Existing(2, "movie:b", 100_000, "Title b", Type.CONTINUE),
            Existing(3, "movie:gone", 5_000, "Gone", Type.CONTINUE),
            Existing(4, "movie:a", 600_000, "Title a", Type.CONTINUE)
        )
        val plan = WatchNextPlanner.plan(listOf(item("a"), item("b", pos = 900.0)), existing, now)
        assertTrue(plan.insert.isEmpty())
        assertEquals(listOf(2L), plan.update.map { it.first })
        assertEquals(900_000L, plan.update[0].second.positionMs)
        assertEquals(setOf(3L, 4L), plan.delete.toSet())
        // Nothing changed at all: an empty plan, so a periodic sync never churns the home screen.
        val again = WatchNextPlanner.plan(listOf(item("a")), listOf(Existing(1, "movie:a", 600_400, "Title a", Type.CONTINUE)), now)
        assertTrue(again.isEmpty)
    }

    @Test fun `a title the viewer removed from the row stays removed until they watch more`() {
        val removed = listOf(Existing(7, "movie:a", 600_000, "Title a", Type.CONTINUE, browsable = false))
        assertTrue(WatchNextPlanner.plan(listOf(item("a", pos = 630.0)), removed, now).isEmpty)
        val later = WatchNextPlanner.plan(listOf(item("a", pos = 1200.0)), removed, now)
        assertEquals(listOf(7L), later.delete)
        assertEquals(listOf("movie:a"), later.insert.map { it.internalId })
    }

    @Test fun `at most ten programs and signing out empties the row`() {
        val many = (1..15).map { item("m$it") }
        assertEquals(WatchNextPlanner.MAX_PROGRAMS, WatchNextPlanner.plan(many, emptyList(), now).insert.size)
        val cleared = WatchNextPlanner.plan(emptyList(), listOf(Existing(1, "movie:a", 1, "a", Type.CONTINUE)), now)
        assertEquals(listOf(1L), cleared.delete)
        assertFalse(WatchNextPlanner.eligible(item("x", pos = 29.0)))
        assertTrue(WatchNextPlanner.eligible(item("x", pos = 30.0, dur = 0.0)))
    }

    @Test fun `dashboard wording and a partial response from an older PC`() {
        assertEquals("8.0 Mbps", DashboardText.bitrate(8_000_000))
        assertEquals("640 kbps", DashboardText.bitrate(640_000))
        assertEquals("3h 5m", DashboardText.duration(3 * 3600 + 300))
        assertEquals("1:02:05", DashboardText.clock(3725.0))
        assertEquals("never", DashboardText.ago(null))
        assertEquals("🛰️", DashboardText.whereIcon("away_relay"))

        val r = ApiClient.JSON.decodeFromString(
            AdminDashboardResponse.serializer(),
            """{"ok":true,"canStopStreams":true,"nowPlaying":[{"id":"x","streamId":"s1","user":"Sam","title":"Heat","where":"home","currentBitsPerSec":8000000,"progress":0.5,"somethingNew":1}],
               "bandwidth":{"currentBitsPerSec":1,"streams":[]},"health":{"cpuPercent":null,"errors24h":{"count":2,"recent":[]}}}"""
        )
        assertTrue(r.canStopStreams)
        assertEquals("s1", r.nowPlaying!![0].streamId)
        assertEquals(2, r.health!!.errors24h.count)
        assertNull(r.activity)
        assertNull(r.library)
    }
}
