package com.beeboentertainment.movie.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TripLogicTest {

    private val packed = PackingSnapshot(10L, listOf(PackedItem("Tent", true), PackedItem("Torch", false)))

    private fun started(book: TripBook = TripBook(), at: Long = 1_000L, roster: List<String> = emptyList()) =
        TripLogic.start(book, "t1", "Lake weekend", at, roster, setOf("packed", "first_movie"), packed)

    // ---- lifecycle ---------------------------------------------------------------------

    @Test
    fun `starting a trip snapshots the badges and the packing list and logs the departure`() {
        val trip = started().active!!
        assertEquals("Lake weekend", trip.name)
        assertEquals(1_000L, trip.startedAt)
        assertTrue(trip.running)
        assertEquals(listOf("first_movie", "packed"), trip.badgesAtStart)
        assertEquals(packed, trip.packingAtDepart)
        assertEquals(listOf(MomentKind.DEPARTED), trip.moments.map { it.kind })
    }

    @Test
    fun `a second start while one is running changes nothing`() {
        val one = started()
        val two = TripLogic.start(one, "t2", "Other", 5_000L, emptyList(), emptySet(), packed)
        assertSame(one, two)
        assertEquals(1, two.trips.size)
    }

    @Test
    fun `ending freezes the window the roster and the return snapshots`() {
        val back = PackingSnapshot(9_000L, listOf(PackedItem("Tent", true), PackedItem("Torch", true)))
        val ended = TripLogic.end(started(roster = listOf("Ana")), 9_000L, setOf("packed", "trivia_5"), back, listOf("Ben", "ana"))
        val trip = ended.trips.single()
        assertFalse(trip.running)
        assertNull(ended.active)
        assertEquals(9_000L, trip.endedAt)
        assertEquals(listOf("Ana", "Ben"), trip.roster)
        assertEquals(listOf("packed", "trivia_5"), trip.badgesAtEnd)
        assertEquals(back, trip.packingAtReturn)
        assertEquals(MomentKind.HOME, trip.moments.last().kind)
    }

    @Test
    fun `an end time before the start is clamped to the start`() {
        val ended = TripLogic.end(started(at = 5_000L), 1_000L, emptySet(), packed, emptyList())
        assertEquals(5_000L, ended.trips.single().endedAt)
    }

    @Test
    fun `ending with no trip running changes nothing`() {
        val book = TripBook()
        assertSame(book, TripLogic.end(book, 9L, emptySet(), packed, emptyList()))
    }

    @Test
    fun `after a trip ends a new one can start and only one is ever running`() {
        val ended = TripLogic.end(started(), 2_000L, emptySet(), packed, emptyList())
        val next = TripLogic.start(ended, "t2", "Second", 3_000L, emptyList(), emptySet(), packed)
        assertEquals(2, next.trips.size)
        assertEquals("t2", next.active!!.id)
        assertEquals(1, next.trips.count { it.running })
    }

    @Test
    fun `the trip name is cleaned and never empty`() {
        assertEquals("Our trip", TripLogic.cleanName("   ", "Our trip"))
        assertEquals("Lake", TripLogic.cleanName(" Lake ", "x"))
        assertEquals(TripLogic.MAX_NAME, TripLogic.cleanName("x".repeat(500), "y").length)
    }

    // ---- roster ------------------------------------------------------------------------

    @Test
    fun `the roster merges names case-insensitively keeping the first spelling`() {
        val merged = TripLogic.mergeRoster(listOf("Dad", "Ana"), listOf("dad ", "  ", "Ben", "ANA", "Ben"))
        assertEquals(listOf("Dad", "Ana", "Ben"), merged)
    }

    @Test
    fun `two people who typed the same name are one roster entry`() {
        // The identity caveat: a name is all there is, so this is the documented behaviour, not a bug.
        assertEquals(1, TripLogic.mergeRoster(emptyList(), listOf("Dad", "Dad")).size)
    }

    @Test
    fun `the roster is capped`() {
        val many = (1..200).map { "Guest $it" }
        assertEquals(TripLogic.MAX_ROSTER, TripLogic.mergeRoster(emptyList(), many).size)
    }

    @Test
    fun `names can be added to a trip later`() {
        val book = TripLogic.addRoster(started(roster = listOf("Ana")), "t1", listOf("Ben", "ana"))
        assertEquals(listOf("Ana", "Ben"), book.trips.single().roster)
    }

    // ---- stories -----------------------------------------------------------------------

    private val story = StoryResult("s1", "A cozy campfire story", "Cozy", listOf("Ana", "Ben"), "Once upon a time. The end.")

    @Test
    fun `a story is kept only while a trip is running`() {
        val none = TripBook()
        assertSame(none, TripLogic.recordStory(none, story, 100L))
        val kept = TripLogic.recordStory(started(), story, 1_500L).active!!
        val moment = kept.moments.last()
        assertEquals(MomentKind.STORY, moment.kind)
        assertEquals("story-s1", moment.id)
        assertEquals("A cozy campfire story", moment.title)
        assertEquals("Cozy", moment.mood)
        assertEquals(listOf("Ana", "Ben"), moment.names)
        assertEquals("Once upon a time. The end.", moment.text)
        assertEquals(1_500L, moment.at)
    }

    @Test
    fun `saving the same story twice keeps one entry`() {
        val once = TripLogic.recordStory(started(), story, 1_500L)
        val twice = TripLogic.recordStory(once, story.copy(text = "Longer now."), 1_600L)
        val stories = twice.active!!.moments.filter { it.kind == MomentKind.STORY }
        assertEquals(1, stories.size)
        assertEquals("Longer now.", stories.single().text)
    }

    @Test
    fun `an empty story is not kept`() {
        val book = started()
        assertSame(book, TripLogic.recordStory(book, story.copy(text = "   "), 1_500L))
    }

    @Test
    fun `story text is bounded`() {
        val long = TripLogic.recordStory(started(), story.copy(text = "a".repeat(20_000)), 1_500L)
        assertEquals(TripLogic.MAX_STORY_CHARS, long.active!!.moments.last().text.length)
    }

    // ---- scavenger hunt ----------------------------------------------------------------

    private val find = HuntFind("w1", "By the big rock", "Ana", 51.5, -0.12)

    @Test
    fun `hunt finds are kept only while a trip is running`() {
        val none = TripBook()
        assertSame(none, TripLogic.recordHunt(none, listOf(find), 100L))
    }

    @Test
    fun `coordinates are never saved by default`() {
        val trip = TripLogic.recordHunt(started(), listOf(find), 1_500L).active!!
        assertFalse(trip.saveLocation)
        val moment = trip.moments.last()
        assertEquals("By the big rock", moment.title)
        assertEquals(listOf("Ana"), moment.names)
        assertNull(moment.lat)
        assertNull(moment.lng)
    }

    @Test
    fun `coordinates are saved once the trip opts in`() {
        val book = TripLogic.setSaveLocation(started(), true)
        val moment = TripLogic.recordHunt(book, listOf(find), 1_500L).active!!.moments.last()
        assertEquals(51.5, moment.lat!!, 0.0)
        assertEquals(-0.12, moment.lng!!, 0.0)
    }

    @Test
    fun `a find with no coordinates stores none even when opted in`() {
        val book = TripLogic.setSaveLocation(started(), true)
        val moment = TripLogic.recordHunt(book, listOf(find.copy(lat = null, lng = null)), 1_500L).active!!.moments.last()
        assertNull(moment.lat)
    }

    @Test
    fun `turning location saving off erases what was saved`() {
        val on = TripLogic.recordHunt(TripLogic.setSaveLocation(started(), true), listOf(find), 1_500L)
        assertNotNull(on.active!!.moments.last().lat)
        val off = TripLogic.setSaveLocation(on, false).active!!
        assertFalse(off.saveLocation)
        assertTrue(off.moments.all { it.lat == null && it.lng == null })
    }

    @Test
    fun `reporting a find again updates it and keeps the first time`() {
        val first = TripLogic.recordHunt(started(), listOf(find), 1_500L)
        val again = TripLogic.recordHunt(first, listOf(find.copy(finder = "Ben")), 9_000L).active!!
        val hunts = again.moments.filter { it.kind == MomentKind.HUNT }
        assertEquals(1, hunts.size)
        assertEquals(1_500L, hunts.single().at)
        assertEquals(listOf("Ben"), hunts.single().names)
    }

    // ---- misc --------------------------------------------------------------------------

    @Test
    fun `the moment log is capped`() {
        var book = started()
        (1..600).forEach { book = TripLogic.recordHunt(book, listOf(HuntFind("w$it", "Spot $it", "Ana")), 2_000L + it) }
        assertEquals(TripLogic.MAX_MOMENTS, book.active!!.moments.size)
    }

    @Test
    fun `media picks are de-duplicated and capped`() {
        val media = (1..400).map { TripMedia("content://m/$it") } + TripMedia("content://m/1")
        val trip = TripLogic.setMedia(started(), "t1", media).trips.single()
        assertEquals(TripLogic.MAX_MEDIA, trip.media.size)
        assertEquals(trip.media.size, trip.media.map { it.uri }.toSet().size)
    }

    @Test
    fun `rename and delete`() {
        val renamed = TripLogic.rename(started(), "t1", "  Coast  ")
        assertEquals("Coast", renamed.trips.single().name)
        assertEquals("Coast", TripLogic.rename(renamed, "t1", "   ").trips.single().name)
        assertTrue(TripLogic.delete(renamed, "t1").trips.isEmpty())
    }

    @Test
    fun `old trips are dropped past the cap`() {
        var book = TripBook()
        (1..40).forEach { i ->
            book = TripLogic.start(book, "t$i", "Trip $i", i * 1000L, emptyList(), emptySet(), packed)
            book = TripLogic.end(book, i * 1000L + 1, emptySet(), packed, emptyList())
        }
        assertEquals(TripLogic.MAX_TRIPS, book.trips.size)
        assertEquals("t40", book.trips.last().id)
    }
}
