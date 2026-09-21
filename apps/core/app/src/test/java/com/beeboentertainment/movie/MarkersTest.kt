package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.MarkerPolicy
import com.beeboentertainment.movie.core.PipPolicy
import com.beeboentertainment.movie.core.TransportPolicy
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.MarkersRequest
import com.beeboentertainment.movie.data.MarkersResponse
import com.beeboentertainment.movie.data.UpNextItem
import com.beeboentertainment.movie.player.TransportCache
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Intro / credits markers, the auto-advance they drive, and the ⏭ availability bug the owner hit.
 */
class MarkersTest {

    private val json = ApiClient.JSON
    private val hour = 3600.0

    @Before
    fun reset() = TransportCache.clear()

    /* ------------------ THE BUG: next-button availability ------------------- */

    @Test
    fun `the forwarding player reports next available exactly when the cache has a next item`() {
        // This is the reported bug: ⏮ worked, ⏭ was dead. Previous is always allowed because it
        // can restart the current item; next has to come from the cached /api/upnext answer.
        assertTrue(TransportPolicy.previousAvailable())
        assertTrue(TransportPolicy.nextAvailable(hasNextItem = true))
        assertFalse(TransportPolicy.nextAvailable(hasNextItem = false))
    }

    @Test
    fun `the cache drives availability as the upnext answer arrives`() {
        TransportCache.startItem("e1", "tv")
        // before the lookup answers, there is no next
        assertFalse(TransportCache.current.hasNext)
        assertFalse(TransportPolicy.nextAvailable(TransportCache.current.hasNext))

        TransportCache.setTransport(
            "e1",
            next = UpNextItem(kind = "tv", id = "e2", title = "S1E2", stream = "/tvfile?id=e2"),
            previous = null
        )
        assertTrue(TransportCache.current.hasNext)
        assertTrue(TransportPolicy.nextAvailable(TransportCache.current.hasNext))
        // ...and previous is still fine to offer even though there isn't one
        assertFalse(TransportCache.current.hasPrevious)
        assertTrue(TransportPolicy.previousAvailable())
    }

    @Test
    fun `a late answer for an item we have moved off is ignored`() {
        TransportCache.startItem("e1", "tv")
        TransportCache.startItem("e2", "tv")
        TransportCache.setTransport("e1", UpNextItem(id = "stale"), null)
        assertFalse(TransportCache.current.hasNext)
        assertEquals("e2", TransportCache.current.itemId)
    }

    @Test
    fun `at the end of a series next is unavailable and previous still is`() {
        TransportCache.startItem("last", "tv")
        TransportCache.setTransport("last", next = null, previous = UpNextItem(id = "e9"))
        assertFalse(TransportPolicy.nextAvailable(TransportCache.current.hasNext))
        assertTrue(TransportCache.current.hasPrevious)
    }

    /* ------------------------------ guard limits ---------------------------- */

    @Test
    fun `intro guards - positive, under five minutes, under a quarter of the runtime`() {
        assertTrue(MarkerPolicy.isValidIntro(45.0, hour))
        assertFalse(MarkerPolicy.isValidIntro(0.0, hour))
        assertFalse(MarkerPolicy.isValidIntro(-5.0, hour))
        assertFalse(MarkerPolicy.isValidIntro(301.0, hour))
        assertFalse(MarkerPolicy.isValidIntro(null, hour))
        // 25% of a 10-minute item is 150s
        assertTrue(MarkerPolicy.isValidIntro(150.0, 600.0))
        assertFalse(MarkerPolicy.isValidIntro(151.0, 600.0))
    }

    @Test
    fun `credits guards - past halfway and leaving a minute of runtime`() {
        assertTrue(MarkerPolicy.isValidCredits(3000.0, hour))
        assertFalse(MarkerPolicy.isValidCredits(1000.0, hour))   // before halfway
        assertFalse(MarkerPolicy.isValidCredits(3550.0, hour))   // inside the last minute
        assertFalse(MarkerPolicy.isValidCredits(0.0, hour))
        // with no duration only "> 0" can be checked, so it is writable but not yet actionable
        assertTrue(MarkerPolicy.isValidCredits(3000.0, 0.0))
        assertNull(MarkerPolicy.creditsTriggerMs(3000.0, 0L))
    }

    @Test
    fun `a rejected marker explains itself instead of silently doing nothing`() {
        assertNotNull(MarkerPolicy.introRejectionReason(400.0, hour))
        assertNotNull(MarkerPolicy.introRejectionReason(0.0, hour))
        assertNull(MarkerPolicy.introRejectionReason(45.0, hour))

        assertTrue(MarkerPolicy.creditsRejectionReason(100.0, hour)!!.contains("halfway"))
        assertTrue(MarkerPolicy.creditsRejectionReason(3590.0, hour)!!.contains("last minute"))
        assertNull(MarkerPolicy.creditsRejectionReason(3000.0, hour))
    }

    /* ------------------------------ request body ---------------------------- */

    @Test
    fun `saving an intro sends only that field, plus the duration the guards need`() {
        val body = json.encodeToString(
            MarkersRequest.serializer(),
            MarkersRequest(kind = "tv", id = "e1", introEndSeconds = 45.0, durationSeconds = hour)
        )
        assertTrue(body.contains("\"kind\":\"tv\""))
        assertTrue(body.contains("\"introEndSeconds\":45.0"))
        assertTrue(body.contains("\"durationSeconds\":3600.0"))
        // an ABSENT field means "leave it alone" — we must not send a null and clear the other one
        assertFalse(body.contains("creditsStartSeconds"))
    }

    @Test
    fun `saving credits leaves the intro marker alone`() {
        val body = json.encodeToString(
            MarkersRequest.serializer(),
            MarkersRequest(kind = "movie", id = "m1", creditsStartSeconds = 3000.0, durationSeconds = hour)
        )
        assertTrue(body.contains("\"creditsStartSeconds\":3000.0"))
        assertFalse(body.contains("introEndSeconds"))
    }

    @Test
    fun `markers response parses, including the show scope every episode inherits`() {
        val r = json.decodeFromString(
            MarkersResponse.serializer(),
            """{"ok":true,"introEndSeconds":45,"creditsStartSeconds":1500,"scope":"show","key":"the-wire"}"""
        )
        assertEquals(45.0, r.introEndSeconds!!, 0.001)
        assertEquals(1500.0, r.creditsStartSeconds!!, 0.001)
        assertEquals("show", r.scope)
        assertEquals("the-wire", r.key)
    }

    @Test
    fun `unset markers come back as nulls`() {
        val r = json.decodeFromString(
            MarkersResponse.serializer(),
            """{"ok":true,"introEndSeconds":null,"creditsStartSeconds":null,"scope":"movie","key":"Heat.mkv"}"""
        )
        assertNull(r.introEndSeconds)
        assertNull(r.creditsStartSeconds)
    }

    @Test
    fun `a not_found answer parses rather than throwing`() {
        val r = json.decodeFromString(MarkersResponse.serializer(), """{"ok":false,"error":"not_found"}""")
        assertFalse(r.ok)
        assertEquals("not_found", r.error)
    }

    /* ------------------------------- intro skip ----------------------------- */

    @Test
    fun `a fresh start skips a known intro`() {
        assertTrue(
            MarkerPolicy.shouldSkipIntro(45.0, hour, startPositionMs = 0L, viewerChosePosition = false)
        )
        assertEquals(45_000L, MarkerPolicy.introEndMs(45.0))
    }

    @Test
    fun `the skip is suppressed when the viewer asked for a position`() {
        // Continue Watching's ?t=, or answering the Resume prompt — put them where they said
        assertFalse(
            MarkerPolicy.shouldSkipIntro(45.0, hour, startPositionMs = 0L, viewerChosePosition = true)
        )
        assertFalse(
            MarkerPolicy.shouldSkipIntro(45.0, hour, startPositionMs = 600_000L, viewerChosePosition = true)
        )
    }

    @Test
    fun `already past the intro means nothing to skip`() {
        assertFalse(
            MarkerPolicy.shouldSkipIntro(45.0, hour, startPositionMs = 46_000L, viewerChosePosition = false)
        )
    }

    @Test
    fun `no marker, or an invalid one, means no skip`() {
        assertFalse(MarkerPolicy.shouldSkipIntro(null, hour, 0L, false))
        assertFalse(MarkerPolicy.shouldSkipIntro(400.0, hour, 0L, false))   // fails the 5-min guard
    }

    /* --------------------------- credits auto-advance ------------------------ */

    @Test
    fun `the card comes up at the credits marker`() {
        val duration = 3_600_000L
        assertFalse(MarkerPolicy.shouldShowUpNextCard(2_000_000L, duration, 3000.0, cancelled = false))
        assertTrue(MarkerPolicy.shouldShowUpNextCard(3_000_000L, duration, 3000.0, cancelled = false))
        assertEquals(3_000_000L, MarkerPolicy.creditsTriggerMs(3000.0, duration))
    }

    @Test
    fun `with no marker the card still comes up in the last twenty seconds`() {
        val duration = 3_600_000L
        assertFalse(MarkerPolicy.shouldShowUpNextCard(3_570_000L, duration, null, cancelled = false))
        assertTrue(MarkerPolicy.shouldShowUpNextCard(3_581_000L, duration, null, cancelled = false))
        assertEquals(20_000L, MarkerPolicy.END_CARD_LEAD_MS)
    }

    @Test
    fun `a marker gets a five second grace, the natural end ten`() {
        assertEquals(5, MarkerPolicy.graceSecondsFor(hasCreditsMarker = true))
        assertEquals(10, MarkerPolicy.graceSecondsFor(hasCreditsMarker = false))
        assertEquals("Credits — playing now in 3s…", MarkerPolicy.countdownLabel(3, true))
        assertEquals("Playing in 7s…", MarkerPolicy.countdownLabel(7, false))
    }

    @Test
    fun `cancel stops the credits advance AND the end-of-file one`() {
        val duration = 3_600_000L
        // the credits path
        assertFalse(MarkerPolicy.shouldShowUpNextCard(3_000_000L, duration, 3000.0, cancelled = true))
        // and the end-of-file path, for the rest of this playback
        assertFalse(MarkerPolicy.shouldShowUpNextCard(3_599_000L, duration, null, cancelled = true))
        assertFalse(MarkerPolicy.advanceAllowed(cancelledForThisPlayback = true))
        assertTrue(MarkerPolicy.advanceAllowed(cancelledForThisPlayback = false))
    }

    @Test
    fun `an unknown duration never triggers an advance`() {
        assertFalse(MarkerPolicy.shouldShowUpNextCard(1_000L, 0L, 3000.0, cancelled = false))
        assertFalse(MarkerPolicy.shouldShowUpNextCard(0L, 3_600_000L, null, cancelled = false))
    }

    @Test
    fun `markers and auto-advance are off in surf mode`() {
        assertFalse(MarkerPolicy.markersEnabled(surfMode = true))
        assertTrue(MarkerPolicy.markersEnabled(surfMode = false))
    }

    /* ------------------------------- pip actions ----------------------------- */

    @Test
    fun `pip gets previous, play-pause and next when three actions are allowed`() {
        assertEquals(
            listOf(PipPolicy.PipAction.PREVIOUS, PipPolicy.PipAction.PLAY_PAUSE, PipPolicy.PipAction.NEXT),
            PipPolicy.actionsFor(3)
        )
        assertEquals(3, PipPolicy.actionsFor(5).size)   // never more than the three we have
    }

    @Test
    fun `a device allowing fewer actions keeps play-pause`() {
        assertEquals(listOf(PipPolicy.PipAction.PLAY_PAUSE), PipPolicy.actionsFor(1))
        assertEquals(
            listOf(PipPolicy.PipAction.PREVIOUS, PipPolicy.PipAction.PLAY_PAUSE),
            PipPolicy.actionsFor(2)
        )
        assertTrue(PipPolicy.actionsFor(0).isEmpty())
    }

    /* --------------------------- cache bookkeeping --------------------------- */

    @Test
    fun `re-saving a marker updates the cache without a re-fetch`() {
        TransportCache.startItem("e1", "tv")
        TransportCache.setMarkers("e1", introEndSeconds = 30.0, creditsStartSeconds = null)
        assertEquals(30.0, TransportCache.current.introEndSeconds!!, 0.001)

        TransportCache.updateIntro("e1", 45.0)
        assertEquals(45.0, TransportCache.current.introEndSeconds!!, 0.001)
        TransportCache.updateCredits("e1", 3000.0)
        assertEquals(3000.0, TransportCache.current.creditsStartSeconds!!, 0.001)
        assertTrue(TransportCache.current.markersLoaded)
    }

    @Test
    fun `starting a new item forgets the previous one's markers`() {
        TransportCache.startItem("e1", "tv")
        TransportCache.setMarkers("e1", 30.0, 3000.0)
        TransportCache.startItem("e2", "tv")
        assertNull(TransportCache.current.introEndSeconds)
        assertNull(TransportCache.current.creditsStartSeconds)
        assertFalse(TransportCache.current.markersLoaded)
    }
}
