package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.TransportPolicy
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.EpisodeContextResponse
import com.beeboentertainment.movie.data.UpNextResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The ⏮ / ⏭ rule, and the episode-context lookup behind "📺 All episodes". */
class TransportTest {

    private val json = ApiClient.JSON

    /* --------------------------- the five-second rule ------------------------- */

    @Test
    fun `the threshold is five seconds`() {
        assertEquals(5_000L, TransportPolicy.RESTART_THRESHOLD_MS)
    }

    @Test
    fun `well into the episode, back restarts it`() {
        assertEquals(
            TransportPolicy.PreviousAction.RESTART,
            TransportPolicy.previousAction(positionMs = 600_000L, hasPrevious = true)
        )
    }

    @Test
    fun `at the very start, back goes to the previous episode`() {
        assertEquals(
            TransportPolicy.PreviousAction.GO_PREVIOUS,
            TransportPolicy.previousAction(positionMs = 0L, hasPrevious = true)
        )
        assertEquals(
            TransportPolicy.PreviousAction.GO_PREVIOUS,
            TransportPolicy.previousAction(positionMs = 2_500L, hasPrevious = true)
        )
    }

    @Test
    fun `the boundary belongs to going back, not restarting`() {
        // exactly 5s is still "at the start"; one millisecond later is not
        assertEquals(
            TransportPolicy.PreviousAction.GO_PREVIOUS,
            TransportPolicy.previousAction(positionMs = 5_000L, hasPrevious = true)
        )
        assertEquals(
            TransportPolicy.PreviousAction.RESTART,
            TransportPolicy.previousAction(positionMs = 5_001L, hasPrevious = true)
        )
    }

    @Test
    fun `with no previous episode, back still restarts - never a dead button`() {
        assertEquals(
            TransportPolicy.PreviousAction.RESTART,
            TransportPolicy.previousAction(positionMs = 0L, hasPrevious = false)
        )
        assertEquals(
            TransportPolicy.PreviousAction.RESTART,
            TransportPolicy.previousAction(positionMs = 600_000L, hasPrevious = false)
        )
    }

    @Test
    fun `forward needs somewhere to go`() {
        assertTrue(TransportPolicy.canGoNext(hasNext = true))
        assertFalse(TransportPolicy.canGoNext(hasNext = false))
        assertEquals("That's the last one.", TransportPolicy.NO_NEXT_MESSAGE)
    }

    @Test
    fun `transport is off in surf mode, which has its own meaning for back and next`() {
        assertTrue(TransportPolicy.transportEnabled(surfMode = false))
        assertFalse(TransportPolicy.transportEnabled(surfMode = true))
    }

    /* ------------------------- upnext previous + showKey ---------------------- */

    @Test
    fun `upnext now carries previous and showKey in both directions`() {
        val body = """
        {"ok":true,
         "next":{"kind":"tv","id":"e3","showKey":"the-wire","title":"The Wire — S1E3",
                 "poster":"/media/poster/9.jpg","stream":"/tvfile?id=e3&mt=t"},
         "previous":{"kind":"tv","id":"e1","showKey":"the-wire","title":"The Wire — S1E1",
                     "poster":null,"stream":"/tvfile?id=e1&mt=t"},
         "missing":null}
        """.trimIndent()
        val r = json.decodeFromString(UpNextResponse.serializer(), body)
        assertEquals("e3", r.next?.id)
        assertEquals("e1", r.previous?.id)
        // showKey feeds /api/tvshows/<showKey>/episodes
        assertEquals("the-wire", r.next?.showKey)
        assertEquals("the-wire", r.previous?.showKey)
        assertNull(r.previous?.poster)
    }

    @Test
    fun `previous is null at the first episode of a series`() {
        val body = """
        {"ok":true,
         "next":{"kind":"tv","id":"e2","showKey":"wire","title":"S1E2","poster":null,"stream":"/tvfile?id=e2"},
         "previous":null,"missing":null}
        """.trimIndent()
        val r = json.decodeFromString(UpNextResponse.serializer(), body)
        assertNotNull(r.next)
        assertNull(r.previous)
        // ...and the rule still gives the user something
        assertEquals(
            TransportPolicy.PreviousAction.RESTART,
            TransportPolicy.previousAction(0L, r.previous != null)
        )
    }

    @Test
    fun `a movie collection part carries a null showKey`() {
        val body = """
        {"ok":true,
         "next":{"kind":"movie","id":"gf3","showKey":null,"title":"Part III","poster":null,
                 "stream":"/file?id=gf3&mt=t"},
         "previous":{"kind":"movie","id":"gf1","showKey":null,"title":"Part I","poster":null,
                     "stream":"/file?id=gf1&mt=t"},
         "missing":null}
        """.trimIndent()
        val r = json.decodeFromString(UpNextResponse.serializer(), body)
        assertNull(r.next?.showKey)
        assertNull(r.previous?.showKey)
        assertEquals("movie", r.previous?.kind)
    }

    @Test
    fun `both directions null at the end of everything`() {
        val r = json.decodeFromString(
            UpNextResponse.serializer(),
            """{"ok":true,"next":null,"previous":null,"missing":null}"""
        )
        assertNull(r.next)
        assertNull(r.previous)
        assertFalse(TransportPolicy.canGoNext(r.next != null))
    }

    @Test
    fun `an older server without previous still parses`() {
        val r = json.decodeFromString(
            UpNextResponse.serializer(),
            """{"ok":true,"next":{"kind":"tv","id":"e2","title":"S1E2","stream":"/tvfile?id=e2"}}"""
        )
        assertNull(r.previous)
        assertNull(r.next?.showKey)
        assertEquals("e2", r.next?.id)
    }

    /* ---------------------------- episode context ---------------------------- */

    @Test
    fun `episode context gives the show key the episode list takes`() {
        val r = json.decodeFromString(
            EpisodeContextResponse.serializer(),
            """{"ok":true,"showKey":"show-a","showName":"Show A","season":2,"episode":1}"""
        )
        assertTrue(r.ok)
        assertEquals("show-a", r.showKey)
        assertEquals("Show A", r.showName)
        assertEquals(2, r.season)
        assertEquals(1, r.episode)
    }

    @Test
    fun `season and episode may be null without breaking the jump`() {
        val r = json.decodeFromString(
            EpisodeContextResponse.serializer(),
            """{"ok":true,"showKey":"show-a","showName":"Show A","season":null,"episode":null}"""
        )
        assertEquals("show-a", r.showKey)   // the jump only needs the key
        assertNull(r.season)
    }

    @Test
    fun `the tv_only and not_found errors parse rather than throwing`() {
        val tvOnly = json.decodeFromString(
            EpisodeContextResponse.serializer(),
            """{"ok":false,"error":"tv_only"}"""
        )
        assertFalse(tvOnly.ok)
        assertEquals("tv_only", tvOnly.error)
        assertNull(tvOnly.showKey)

        val notFound = json.decodeFromString(
            EpisodeContextResponse.serializer(),
            """{"ok":false,"error":"not_found"}"""
        )
        assertEquals("not_found", notFound.error)
        assertNull(notFound.showKey)
    }
}
