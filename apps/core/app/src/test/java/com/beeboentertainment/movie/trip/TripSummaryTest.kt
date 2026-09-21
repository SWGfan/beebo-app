package com.beeboentertainment.movie.trip

import com.beeboentertainment.movie.campsite.games.MatchPlayer
import com.beeboentertainment.movie.campsite.games.MatchRecord
import com.beeboentertainment.movie.recap.TripRecapBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The recap scoped to one trip: what falls inside the window, what does not, and how it reads. */
class TripSummaryTest {

    private val hour = 3_600_000L
    private val trip = Trip(
        id = "t", name = "Lake weekend", startedAt = 100 * hour, endedAt = 140 * hour,
        roster = listOf("Dad"),
        badgesAtStart = listOf("first_movie"), badgesAtEnd = listOf("first_movie", "packed"),
        packingAtDepart = PackingSnapshot(100 * hour, listOf(PackedItem("Tent", true), PackedItem("Torch", false), PackedItem("Kettle", false))),
        packingAtReturn = PackingSnapshot(140 * hour, listOf(PackedItem("Tent", true), PackedItem("Torch", true), PackedItem("Kettle", true))),
        moments = listOf(
            TripMoment("departed", 100 * hour, MomentKind.DEPARTED),
            TripMoment("story-1", 110 * hour, MomentKind.STORY, "A cozy campfire story", "Once upon a time there was a fox. The end.", listOf("Ana", "Ben"), "Cozy"),
            TripMoment("hunt-1", 112 * hour, MomentKind.HUNT, "By the big rock", names = listOf("Kit")),
            TripMoment("home", 140 * hour, MomentKind.HOME),
        ),
    )

    private fun p(name: String, won: Boolean = false, bot: Boolean = false) = MatchPlayer(name, if (won) 1 else 0, won, bot)
    private fun match(id: String, endedAt: Long, title: String, vararg players: MatchPlayer, outcome: String = "winner") =
        MatchRecord(id, title.lowercase(), title, players.toList(), players.firstOrNull { it.won }?.name.orEmpty(), outcome, endedAt)

    private val matches = listOf(
        match("old", 50 * hour, "Chess", p("Zed", won = true), p("Yan")),           // before the trip
        match("a", 105 * hour, "Chess", p("Ana", won = true), p("Ben")),
        match("b", 106 * hour, "Checkers", p("Ben", won = true), p("ana")),
        match("c", 107 * hour, "Checkers", p("Ana", won = true), p("Ben")),
        match("d", 108 * hour, "Snap", p("Ana"), p("Beebo", won = true, bot = true)),
        match("e", 109 * hour, "Ludo", p("Ana"), p("Ben"), outcome = "draw"),
        match("later", 150 * hour, "Chess", p("Ben", won = true), p("Ana")),        // after the trip
    )

    private fun summary(now: Long = 200 * hour, rounds: Int = 0) =
        TripSummaryBuilder.build(trip, matches, emptyList(), earnedBadgesNow = setOf("first_movie", "packed", "bingo"), thisOrThatRounds = rounds, now = now)

    // ---- scoping ---------------------------------------------------------------------

    @Test
    fun `only games played inside the trip are counted`() {
        val s = summary()
        assertEquals(5, s.gameCount)
        assertEquals(listOf("Chess", "Checkers", "Checkers", "Snap", "Ludo"), s.games.map { it.title })
    }

    @Test
    fun `wins are tallied per person with a computer never listed and most wins first`() {
        val s = summary()
        assertEquals(listOf(WinTally("Ana", 2), WinTally("Ben", 1)), s.tally)
        assertTrue(s.tally.none { it.name == "Beebo" })
    }

    @Test
    fun `a computer's win is reported as such and a draw as a draw`() {
        val s = summary()
        val snap = s.games.first { it.title == "Snap" }
        assertTrue(snap.botWon)
        assertTrue(snap.winners.isEmpty())
        assertEquals("Snap · the computer won", TripSlides.resultLine(snap, NameMask.ShowAll))
        assertEquals("Ludo · a draw", TripSlides.resultLine(s.games.first { it.title == "Ludo" }, NameMask.ShowAll))
        assertEquals("Chess · Ana won", TripSlides.resultLine(s.games.first { it.title == "Chess" }, NameMask.ShowAll))
    }

    @Test
    fun `the roster is the typed names plus everyone in the trip's own data, without duplicates or computers`() {
        assertEquals(listOf("Dad", "Ana", "Ben", "Kit"), summary().roster)
    }

    @Test
    fun `stories hunt badges and packing come from the trip's own snapshots`() {
        val s = summary()
        assertEquals(1, s.stories.size)
        assertEquals(1, s.hunt.size)
        // "bingo" was earned after the trip ended, so it is not this trip's.
        assertEquals(listOf("packed"), s.badges.map { it.id })
        assertEquals(listOf("Torch", "Kettle"), s.packing!!.leftUnpacked)
    }

    @Test
    fun `an empty trip is empty and says so on the cover`() {
        val bare = Trip("t", "Quiet", startedAt = 100 * hour, endedAt = 101 * hour)
        val s = TripSummaryBuilder.build(bare, emptyList(), emptyList(), emptySet(), now = 200 * hour)
        assertTrue(s.isEmpty)
        val cover = TripSlides.build(s, emptyList()).single()
        assertTrue(cover.lines.any { it.contains("Nothing has been recorded") })
    }

    // ---- the recap card for a trip ---------------------------------------------------

    @Test
    fun `the trip recap is titled with the trip and states only trip data`() {
        val recap = TripRecapBuilder.buildForTrip(summary(rounds = 3), now = 200 * hour)
        assertEquals("Lake weekend", recap.title)
        val text = recap.stats.joinToString("\n") { it.text }
        assertTrue(text, text.contains("5 games played"))
        assertTrue(text, text.contains("Most wins: Ana (2)"))
        assertTrue(text, text.contains("This or That: 3 rounds played"))
        assertTrue(text, text.contains("1 campfire story"))
        assertTrue(text, text.contains("Scavenger hunt: 1 waypoint found"))
        assertTrue(text, text.contains("New badges: Packed and Ready"))
        assertTrue(text, text.contains("Packed 1 of 3 before leaving"))
        assertFalse("watch activity has no dates so it is never in a trip recap", text.contains("Watched"))
    }

    @Test
    fun `a trip with no activity gives an empty recap for the friendly empty state`() {
        val bare = Trip("t", "Quiet", startedAt = 100 * hour, endedAt = 101 * hour)
        val s = TripSummaryBuilder.build(bare, matches, emptyList(), emptySet(), now = 200 * hour)
        assertTrue(TripRecapBuilder.buildForTrip(s, now = 200 * hour).isEmpty)
    }

    @Test
    fun `with no trip at all the existing all-time recap is untouched`() {
        val recap = TripRecapBuilder.build(
            continueResponse = null, checklist = emptyList(),
            gameRounds = 4, gameFirstMs = 1_000L, gameLastMs = 2_000L, now = 5_000L,
        )
        assertEquals("Your Trip Recap", recap.title)
        assertEquals("This or That: 4 rounds played", recap.stats.single().text)
    }

    // ---- the slides ------------------------------------------------------------------

    @Test
    fun `the deck follows the design order and leaves empty sections out`() {
        val kinds = TripSlides.build(summary(), listOf(TripMedia("content://p", false, 5L), TripMedia("content://v", true, 6L))).map { it.kind }
        assertEquals(
            listOf(
                SlideKind.COVER, SlideKind.GAMES, SlideKind.RESULTS, SlideKind.STORY, SlideKind.HUNT,
                SlideKind.BADGES, SlideKind.PACKING, SlideKind.PHOTO, SlideKind.VIDEO,
            ),
            kinds,
        )
        val bare = Trip("t", "Quiet", startedAt = 100 * hour, endedAt = 101 * hour)
        val onlyCover = TripSlides.build(TripSummaryBuilder.build(bare, emptyList(), emptyList(), emptySet(), now = 200 * hour), emptyList())
        assertEquals(listOf(SlideKind.COVER), onlyCover.map { it.kind })
    }

    @Test
    fun `present mode shows names exactly as typed`() {
        val slides = TripSlides.build(summary(), emptyList())
        val games = slides.first { it.kind == SlideKind.GAMES }
        assertTrue(games.lines.contains("Ana · 2 wins"))
        val story = slides.first { it.kind == SlideKind.STORY }
        assertEquals("Cozy · told by Ana, Ben", story.subtitle)
        assertEquals("With Dad, Ana, Ben and Kit", slides.first().lines.last())
    }

    @Test
    fun `a name mask turns unticked guests into a friend everywhere they appear`() {
        val mask = NameMask.only(listOf("Dad", "ana"))
        val slides = TripSlides.build(summary(), emptyList(), mask)
        val text = slides.flatMap { listOf(it.title, it.subtitle, it.body) + it.lines }.joinToString("\n")
        assertTrue(text, text.contains("Ana · 2 wins"))          // ticked, case-insensitively
        assertFalse(text, text.contains("Ben"))
        assertFalse(text, text.contains("Kit"))
        assertTrue(text, text.contains("a friend"))
        assertEquals("With Dad, Ana and a friend", slides.first().lines.last())
        assertEquals("Cozy · told by Ana, a friend", slides.first { it.kind == SlideKind.STORY }.subtitle)
    }

    @Test
    fun `the crew line handles one name many names and none`() {
        assertNull(TripSlides.crew(emptyList(), NameMask.ShowAll))
        assertEquals("With Ana", TripSlides.crew(listOf("Ana"), NameMask.ShowAll))
        assertEquals("With Ana and Ben", TripSlides.crew(listOf("Ana", "Ben"), NameMask.ShowAll))
        assertEquals(
            "With A, B, C, D, E, F and 2 more",
            TripSlides.crew(listOf("A", "B", "C", "D", "E", "F", "G", "H"), NameMask.ShowAll),
        )
    }

    @Test
    fun `no slide ever shows coordinates`() {
        val withCoords = trip.copy(
            moments = trip.moments.map { if (it.kind == MomentKind.HUNT) it.copy(lat = 51.501234, lng = -0.141234) else it },
        )
        val s = TripSummaryBuilder.build(withCoords, matches, emptyList(), emptySet(), now = 200 * hour)
        val text = TripSlides.build(s, emptyList()).flatMap { listOf(it.title, it.subtitle, it.body) + it.lines }.joinToString("\n")
        assertFalse(text.contains("51.5"))
        assertFalse(text.contains("0.14"))
    }

    @Test
    fun `long story text is cut at a word with an ellipsis`() {
        val long = "word ".repeat(300)
        val cut = TripSlides.excerpt(long, 100)
        assertTrue(cut.length <= 101)
        assertTrue(cut.endsWith("…"))
        assertEquals("short", TripSlides.excerpt("short", 100))
    }

    @Test
    fun `packing slide reports leaving and returning and what was left`() {
        val packing = TripSlides.build(summary(), emptyList()).first { it.kind == SlideKind.PACKING }
        assertEquals(
            listOf("Leaving: 1 of 3 items packed", "Back home: 3 of 3 items ticked", "Left unpacked: Torch, Kettle"),
            packing.lines,
        )
    }
}
