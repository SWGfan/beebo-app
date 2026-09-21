package com.beeboentertainment.movie.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TripStoreTest {

    private var clock = 1_000L
    private var ids = 0
    private val disk = MemoryTripPersistence()

    private fun store(persistence: TripPersistence = disk) =
        TripStore(persistence, clock = { clock }, newId = { "id${ids++}" })

    private val list = PackingSnapshot(0L, listOf(PackedItem("Tent", true)))

    @Test
    fun `a trip survives being read by a fresh store`() {
        val a = store()
        val trip = a.start("Lake weekend", listOf("Ana"), setOf("packed"), list)!!
        assertEquals("Lake weekend", trip.name)

        val b = store() // e.g. the app was closed and reopened
        assertEquals(trip.id, b.active()!!.id)
        assertEquals(listOf("Ana"), b.active()!!.roster)
        assertEquals(list, b.active()!!.packingAtDepart)
    }

    @Test
    fun `starting twice returns null the second time`() {
        val s = store()
        assertNotNull(s.start("One", emptyList(), emptySet(), list))
        assertNull(s.start("Two", emptyList(), emptySet(), list))
        assertEquals(1, s.all().size)
    }

    @Test
    fun `ending a trip records the return snapshot and clears the active trip`() {
        val s = store()
        s.start("Lake", emptyList(), setOf("a"), list)
        clock = 9_000L
        val back = PackingSnapshot(9_000L, listOf(PackedItem("Tent", true), PackedItem("Torch", true)))
        val ended = s.end(setOf("a", "b"), back, listOf("Ben"))!!
        assertEquals(9_000L, ended.endedAt)
        assertEquals(listOf("Ben"), ended.roster)
        assertNull(s.active())
        assertEquals(back, s.trip(ended.id)!!.packingAtReturn)
    }

    @Test
    fun `ending with nothing running is a no-op`() {
        assertNull(store().end(emptySet(), list, emptyList()))
    }

    @Test
    fun `stories and hunt finds are dropped with no trip and kept during one`() {
        val s = store()
        assertFalse(s.recordStory(StoryResult("s", "T", "Cozy", listOf("Ana"), "Text")))
        s.recordHunt(listOf(HuntFind("w", "Rock", "Ana")))
        assertNull(disk.text) // nothing was even written

        s.start("Lake", emptyList(), emptySet(), list)
        assertTrue(s.recordStory(StoryResult("s", "T", "Cozy", listOf("Ana"), "Text")))
        s.recordHunt(listOf(HuntFind("w", "Rock", "Ana", 1.0, 2.0)))
        val moments = s.active()!!.moments
        assertEquals(listOf(MomentKind.DEPARTED, MomentKind.STORY, MomentKind.HUNT), moments.map { it.kind })
    }

    @Test
    fun `coordinates do not reach the disk unless the trip opted in`() {
        val s = store()
        s.start("Lake", emptyList(), emptySet(), list)
        s.recordHunt(listOf(HuntFind("w", "Rock", "Ana", 51.123456, -0.654321)))
        assertFalse(disk.text!!.contains("51.123456"))
        assertFalse(disk.text!!.contains("0.654321"))

        s.setSaveLocation(true)
        s.recordHunt(listOf(HuntFind("w2", "Tree", "Ben", 52.5, -1.5)))
        assertTrue(disk.text!!.contains("52.5"))

        s.setSaveLocation(false)
        assertFalse(disk.text!!.contains("52.5"))
    }

    @Test
    fun `two store instances do not overwrite each other`() {
        val games = store()
        val hunt = store()
        games.start("Lake", emptyList(), emptySet(), list)
        games.recordStory(StoryResult("s", "T", "Cozy", emptyList(), "Text"))
        hunt.recordHunt(listOf(HuntFind("w", "Rock", "Ana")))
        games.recordStory(StoryResult("s2", "T2", "Funny", emptyList(), "More"))
        assertEquals(4, store().active()!!.moments.size) // departed, story, hunt, story
    }

    @Test
    fun `an unreadable or oversized saved book reads as empty rather than crashing`() {
        assertTrue(store(MemoryTripPersistence("{not json")).all().isEmpty())
        assertTrue(store(MemoryTripPersistence("x".repeat(2_500_000))).all().isEmpty())
        assertTrue(store(MemoryTripPersistence("")).all().isEmpty())
    }

    @Test
    fun `unknown fields in a saved book are ignored`() {
        val saved = """{"trips":[{"id":"a","name":"Old","startedAt":5,"endedAt":9,"future":true}],"more":1}"""
        val trip = store(MemoryTripPersistence(saved)).all().single()
        assertEquals("Old", trip.name)
        assertFalse(trip.saveLocation)
    }

    @Test
    fun `trips list newest first and can be deleted`() {
        val s = store()
        s.start("First", emptyList(), emptySet(), list)
        clock = 2_000L
        s.end(emptySet(), list, emptyList())
        clock = 3_000L
        val second = s.start("Second", emptyList(), emptySet(), list)!!
        assertEquals(listOf("Second", "First"), s.all().map { it.name })
        s.delete(second.id)
        assertEquals(listOf("First"), s.all().map { it.name })
    }

    @Test
    fun `chosen media is remembered on the trip`() {
        val s = store()
        val trip = s.start("Lake", emptyList(), emptySet(), list)!!
        s.setMedia(trip.id, listOf(TripMedia("content://a", false, 5L), TripMedia("content://b", true, 6L)))
        assertEquals(2, store().trip(trip.id)!!.media.size)
        assertTrue(store().trip(trip.id)!!.media[1].video)
    }
}
