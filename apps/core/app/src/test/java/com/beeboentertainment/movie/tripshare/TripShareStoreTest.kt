package com.beeboentertainment.movie.tripshare

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TripShareStoreTest {

    private val day = 24L * 3600 * 1000
    private var now = 1_800_000_000_000L
    private val persistence = MemoryLinkPersistence()
    private fun store() = TripShareStore(persistence, clock = { now })

    private fun link(id: String, trip: String = "t1", created: Long = now, expires: Long = now + 30 * day) =
        SavedLink(id, trip, "Lake", "https://x.beebo.tv/trip/$id", created, expires)

    @Test
    fun `links are saved, listed newest first and survive a fresh store`() {
        store().add(link("a", created = now - 5))
        store().add(link("b", created = now))
        assertEquals(listOf("b", "a"), store().all().map { it.shareId })
        assertEquals(listOf("a"), TripShareStore(persistence, clock = { now }).forTrip("t1").filter { it.shareId == "a" }.map { it.shareId })
    }

    @Test
    fun `adding the same link twice keeps one`() {
        store().add(link("a"))
        store().add(link("a").copy(title = "Renamed"))
        assertEquals(1, store().all().size)
        assertEquals("Renamed", store().all().single().title)
    }

    @Test
    fun `a link is removed on its own and a whole trip's links together`() {
        store().add(link("a", "t1")); store().add(link("b", "t1")); store().add(link("c", "t2"))
        store().remove("a")
        assertEquals(setOf("b", "c"), store().all().map { it.shareId }.toSet())
        store().removeTrip("t1")
        assertEquals(listOf("c"), store().all().map { it.shareId })
        store().removeTrip("t2")
        assertNull("nothing left means nothing stored", persistence.text)
    }

    @Test
    fun `links long past their end are forgotten and the list is bounded`() {
        store().add(link("old", created = now - 100 * day, expires = now - 40 * day))
        store().add(link("fresh"))
        assertEquals(listOf("fresh"), store().all().map { it.shareId })
        for (i in 1..80) store().add(link("l$i", created = now + i))
        assertTrue(store().all().size <= TripShareStore.MAX_LINKS)
    }

    @Test
    fun `damaged or oversized saved text reads as no links`() {
        persistence.text = "{ not json"
        assertEquals(emptyList<SavedLink>(), store().all())
        persistence.text = "x".repeat(300_000)
        assertEquals(emptyList<SavedLink>(), store().all())
    }

    @Test
    fun `a job holds no link or token and maps back to the options the sender chose`() {
        val job = ShareJob(
            id = "j1", tripId = "t1", tripName = "Lake", includeLocation = true, includeSong = true, rightsAck = true,
            expiryHours = 48, shownNames = listOf("ana"),
        )
        val o = job.options
        assertTrue(o.includeLocation && o.includeSong && o.rightsAck)
        assertEquals(ShareExpiry.TWO_DAYS, o.expiry)
        assertEquals(setOf("ana"), o.shownNames)
        val defaults = ShareJob(id = "j2", tripId = "t", tripName = "n").options
        assertEquals(ShareOptions(), defaults)
        assertNotNull(job.copy(songUri = null))
    }
}
