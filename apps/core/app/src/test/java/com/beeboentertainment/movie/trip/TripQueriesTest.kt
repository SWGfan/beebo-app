package com.beeboentertainment.movie.trip

import com.beeboentertainment.movie.campsite.games.ChampionRecord
import com.beeboentertainment.movie.campsite.games.MatchPlayer
import com.beeboentertainment.movie.campsite.games.MatchRecord
import com.beeboentertainment.movie.checklist.ChecklistItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale
import java.util.TimeZone

class TripQueriesTest {

    private val hour = 3_600_000L
    private val trip = Trip(id = "t", name = "Lake", startedAt = 100 * hour, endedAt = 140 * hour)
    private val running = Trip(id = "r", name = "Now", startedAt = 100 * hour)

    private fun match(id: String, endedAt: Long, vararg players: MatchPlayer, game: String = "chess", title: String = "Chess") =
        MatchRecord(
            id = id, game = game, title = title, players = players.toList(),
            winner = players.firstOrNull { it.won }?.name.orEmpty(), endedAt = endedAt,
        )

    private fun p(name: String, won: Boolean = false, bot: Boolean = false) = MatchPlayer(name, if (won) 1 else 0, won, bot)

    // ---- the window --------------------------------------------------------------------

    @Test
    fun `a finished trip covers start to end and a running one runs to now`() {
        assertEquals(TripWindow(100 * hour, 140 * hour), TripQueries.window(trip, now = 999 * hour))
        assertEquals(TripWindow(100 * hour, 120 * hour), TripQueries.window(running, now = 120 * hour))
        // A clock that went backwards must not produce an upside-down window.
        assertEquals(TripWindow(100 * hour, 100 * hour), TripQueries.window(running, now = 50 * hour))
    }

    @Test
    fun `matches are selected by when they ended, inclusive at both ends, oldest first`() {
        val window = TripQueries.window(trip, 0)
        val before = match("before", 99 * hour, p("A"))
        val atStart = match("start", 100 * hour, p("A"))
        val late = match("late", 139 * hour, p("A"))
        val atEnd = match("end", 140 * hour, p("A"))
        val after = match("after", 141 * hour, p("A"))
        val undated = match("undated", 0L, p("A"))
        val got = TripQueries.matchesIn(window, listOf(after, late, before, atEnd, atStart, undated))
        assertEquals(listOf("start", "late", "end"), got.map { it.id })
    }

    @Test
    fun `champions are selected the same way`() {
        val window = TripQueries.window(trip, 0)
        val inside = ChampionRecord("chess", "Chess", "Ana", 4, 120 * hour)
        val outside = ChampionRecord("chess", "Chess", "Zed", 4, 10 * hour)
        assertEquals(listOf("Ana"), TripQueries.championsIn(window, listOf(outside, inside)).map { it.champion })
    }

    // ---- roster ------------------------------------------------------------------------

    @Test
    fun `the roster folds in typed names, storytellers, finders and players but never a computer`() {
        val withLog = trip.copy(
            roster = listOf("Dad"),
            moments = listOf(
                TripMoment("s", 110 * hour, MomentKind.STORY, names = listOf("Mum", "dad")),
                TripMoment("h", 111 * hour, MomentKind.HUNT, names = listOf("Kit")),
            ),
        )
        val matches = listOf(match("m", 120 * hour, p("Ana", won = true), p("Beebo", bot = true), p("kit")))
        val champs = listOf(ChampionRecord("chess", "Chess", "Zoe", 3, 130 * hour))
        assertEquals(listOf("Dad", "Mum", "Kit", "Ana", "Zoe"), TripQueries.roster(withLog, matches, champs))
    }

    // ---- badges ------------------------------------------------------------------------

    @Test
    fun `badges earned are the earned set at the end minus the set at the start, in catalog order`() {
        val done = trip.copy(badgesAtStart = listOf("first_movie"), badgesAtEnd = listOf("first_movie", "packed", "trivia_5"))
        assertEquals(listOf("trivia_5", "packed"), TripQueries.badgesEarned(done, earnedNow = emptySet()).map { it.id })
    }

    @Test
    fun `a running trip judges badges against the set earned right now`() {
        val r = running.copy(badgesAtStart = listOf("first_movie"))
        assertEquals(listOf("packed"), TripQueries.badgesEarned(r, setOf("first_movie", "packed")).map { it.id })
        // Sticky badges from before the trip are never "new".
        assertTrue(TripQueries.badgesEarned(r, setOf("first_movie")).isEmpty())
    }

    @Test
    fun `unknown badge ids are ignored`() {
        val odd = trip.copy(badgesAtEnd = listOf("from_the_future"))
        assertTrue(TripQueries.badgesEarned(odd, emptySet()).isEmpty())
    }

    // ---- packing -----------------------------------------------------------------------

    @Test
    fun `a packing snapshot keeps display order and leaves deleted rows out`() {
        val items = listOf(
            ChecklistItem("2", "Torch", checked = false, createdAt = 20),
            ChecklistItem("1", "Tent", checked = true, createdAt = 10),
            ChecklistItem("3", "Gone", checked = true, createdAt = 30, deleted = true),
        )
        val snap = TripQueries.packingSnapshot(items, at = 55L)
        assertEquals(55L, snap.at)
        assertEquals(listOf(PackedItem("Tent", true), PackedItem("Torch", false)), snap.items)
        assertEquals(1, snap.packed)
        assertEquals(2, snap.total)
    }

    // ---- this or that ------------------------------------------------------------------

    @Test
    fun `the This or That counter is used only when the whole run is inside the trip`() {
        val w = TripWindow(100 * hour, 140 * hour)
        assertEquals(6, TripQueries.thisOrThatRounds(w, 6, 110 * hour, 130 * hour))
        assertEquals(0, TripQueries.thisOrThatRounds(w, 6, 90 * hour, 130 * hour)) // started before the trip
        assertEquals(0, TripQueries.thisOrThatRounds(w, 6, 110 * hour, 150 * hour)) // carried on after it
        assertEquals(0, TripQueries.thisOrThatRounds(w, 0, 0L, 0L))
    }

    // ---- choosing which trip the recap shows -------------------------------------------

    @Test
    fun `the recap defaults to the running trip, else the newest, and can be sent back to all activity`() {
        val newestFirst = listOf(trip.copy(id = "new", startedAt = 300), trip.copy(id = "old", startedAt = 200))
        assertEquals("new", TripQueries.selectTrip(newestFirst, null)!!.id)
        assertEquals("old", TripQueries.selectTrip(newestFirst, "old")!!.id)
        assertEquals("new", TripQueries.selectTrip(newestFirst, "deleted-meanwhile")!!.id)
        assertNull(TripQueries.selectTrip(newestFirst, TripQueries.ALL_ACTIVITY))

        val withRunning = listOf(trip.copy(id = "done", startedAt = 500), running.copy(id = "live", startedAt = 400))
        assertEquals("live", TripQueries.selectTrip(withRunning, null)!!.id)
    }

    @Test
    fun `with no trips the recap keeps its all-time behaviour`() {
        assertNull(TripQueries.selectTrip(emptyList(), null))
        assertNull(TripQueries.selectTrip(emptyList(), "anything"))
    }

    // ---- choosing photos and videos ----------------------------------------------------

    private fun photo(uri: String, takenAt: Long) = TripMedia(uri, false, takenAt)

    @Test
    fun `picked media is ordered by date taken with undated items after the dated ones`() {
        val window = TripWindow(100 * hour, 140 * hour)
        val picked = listOf(photo("c", 130 * hour), photo("u1", 0L), photo("a", 105 * hour), photo("u2", 0L), photo("b", 120 * hour))
        val pick = TripQueries.pickMedia(picked, window, includeOutside = false)
        assertEquals(listOf("a", "b", "c", "u1", "u2"), pick.shown.map { it.uri })
        assertEquals(0, pick.outsideCount)
    }

    @Test
    fun `media dated well outside the trip is set aside and counted, and can be included`() {
        val window = TripWindow(100 * hour, 140 * hour)
        val picked = listOf(photo("in", 120 * hour), photo("way-before", 10 * hour), photo("way-after", 300 * hour))
        val strict = TripQueries.pickMedia(picked, window, includeOutside = false)
        assertEquals(listOf("in"), strict.shown.map { it.uri })
        assertEquals(2, strict.outsideCount)
        val all = TripQueries.pickMedia(picked, window, includeOutside = true)
        assertEquals(listOf("way-before", "in", "way-after"), all.shown.map { it.uri })
    }

    @Test
    fun `a photo taken just before leaving or after getting back still counts`() {
        val window = TripWindow(100 * hour, 140 * hour)
        val nearby = listOf(photo("packing-the-car", 100 * hour - 2 * hour), photo("the-drive-home", 140 * hour + 5 * hour))
        assertEquals(2, TripQueries.pickMedia(nearby, window, false).shown.size)
        val tooFar = listOf(photo("yesterday", 100 * hour - 7 * hour))
        assertEquals(0, TripQueries.pickMedia(tooFar, window, false).shown.size)
    }

    // ---- formatting --------------------------------------------------------------------

    private val us = Locale.US
    private val utc = TimeZone.getTimeZone("UTC")
    private fun at(y: Int, m: Int, d: Int, h: Int = 12): Long =
        java.util.GregorianCalendar(utc).apply { clear(); set(y, m - 1, d, h, 0) }.timeInMillis

    @Test
    fun `date ranges read naturally`() {
        assertEquals("Mar 6, 2026", TripFormat.dateRange(at(2026, 3, 6, 9), at(2026, 3, 6, 18), 0, us, utc))
        assertEquals("Mar 3 – Mar 6, 2026", TripFormat.dateRange(at(2026, 3, 3), at(2026, 3, 6), 0, us, utc))
        assertEquals("Dec 30, 2025 – Jan 2, 2026", TripFormat.dateRange(at(2025, 12, 30), at(2026, 1, 2), 0, us, utc))
    }

    @Test
    fun `a running trip's range ends today`() {
        assertEquals("Mar 3 – Mar 5, 2026", TripFormat.dateRange(at(2026, 3, 3), 0L, at(2026, 3, 5), us, utc))
    }

    @Test
    fun `trip length is rough and human`() {
        assertEquals("under an hour", TripFormat.length(0, 30 * 60_000L, 0))
        assertEquals("1 hour", TripFormat.length(0, hour + 1, 0))
        assertEquals("5 hours", TripFormat.length(0, 5 * hour, 0))
        assertEquals("3 days", TripFormat.length(0, 72 * hour, 0))
        assertEquals("2 days", TripFormat.length(0, 40 * hour, 0))
    }
}
