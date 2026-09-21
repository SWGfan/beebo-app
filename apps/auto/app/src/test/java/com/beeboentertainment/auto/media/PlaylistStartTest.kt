package com.beeboentertainment.auto.media

import com.beeboentertainment.auto.data.PlaylistPlayEntry
import com.beeboentertainment.auto.data.PlaylistPlayOrderResponse
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Playlists in the car: the browse ids round-trip, and a row expands into the right play order. */
class PlaylistStartTest {

    private val entries = listOf("a", "b", "c", "d").map {
        PlaylistPlayEntry(entryId = "e_$it", id = it, kind = if (it == "c") "tv" else "movie", title = it.uppercase(), stream = "/file?id=$it&mt=x")
    }

    @Test
    fun idsRoundTrip() {
        for (start in listOf(
            PlaylistStart("pl_AbC-12_x", PlaylistStart.Mode.ORDER),
            PlaylistStart("pl_AbC-12_x", PlaylistStart.Mode.SHUFFLE),
            PlaylistStart("pl_AbC-12_x", PlaylistStart.Mode.RESUME),
            PlaylistStart("pl_AbC-12_x", PlaylistStart.Mode.FROM, 7),
        )) {
            assertEquals(start, PlaylistStart.parse(start.mediaId()))
        }
        assertEquals("playlists/pl_x", MediaIds.playlist("pl_x"))
        assertEquals("pl_x", MediaIds.parsePlaylist("playlists/pl_x"))
    }

    @Test
    fun junkIsRejected() {
        val bad = listOf(
            "plstart/", "plstart/pl_x", "plstart/pl_x/sideways", "plstart/pl_x/from", "plstart/pl_x/from/-1",
            "plstart/pl_x/from/two", "plstart/pl_x/order/extra", "play/movie/abc", "playlists/pl_x",
        )
        for (id in bad) assertNull(id, PlaylistStart.parse(id))
        assertNull(MediaIds.parsePlaylist("playlists/"))
        assertNull(MediaIds.parsePlaylist("playlists/a/b"))
        assertNull(MediaIds.parsePlaylist(MediaIds.TAB_PLAYLISTS))
        // A playlist row is none of the older kinds of id.
        val row = PlaylistStart("pl_x", PlaylistStart.Mode.FROM, 1).mediaId()
        assertNull(MediaIds.parsePlayable(row))
        assertNull(MediaIds.parseShow(row))
        assertNull(MediaIds.parsePlayable(MediaIds.playlist("pl_x")))
    }

    @Test
    fun playOrderFromEachRow() {
        val response = PlaylistPlayOrderResponse(ok = true, items = entries, startIndex = 2)
        assertEquals(listOf("a", "b", "c", "d"), PlaylistStart("p", PlaylistStart.Mode.ORDER).order(response).map { it.id })
        assertEquals(listOf("b", "c", "d"), PlaylistStart("p", PlaylistStart.Mode.FROM, 1).order(response).map { it.id })
        assertEquals(listOf("c", "d"), PlaylistStart("p", PlaylistStart.Mode.RESUME).order(response).map { it.id })
        // the list shrank since the car drew it: nothing, never the wrong film
        assertTrue(PlaylistStart("p", PlaylistStart.Mode.FROM, 9).order(response).isEmpty())
        // unavailable or stream-less entries are skipped
        val gaps = response.copy(items = entries.mapIndexed { i, e -> if (i == 1) e.copy(available = false) else if (i == 2) e.copy(stream = null) else e })
        assertEquals(listOf("a", "d"), PlaylistStart("p", PlaylistStart.Mode.ORDER).order(gaps).map { it.id })
        assertTrue(PlaylistStart("p", PlaylistStart.Mode.SHUFFLE).order(PlaylistPlayOrderResponse()).isEmpty())
    }

    @Test
    fun serverResponseParses() {
        val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false }
        val r = json.decodeFromString(
            PlaylistPlayOrderResponse.serializer(),
            """{"ok":true,"playlist":{"id":"pl_x"},"items":[{"entryId":"e_1","type":"episode","id":"ep","kind":"tv","title":"Show — S1E1","available":true,"stream":"/tvfile?id=ep&mt=t","poster":null,"future":1}],"startIndex":0,"shuffle":true,"seed":99,"skipped":1}"""
        )
        assertEquals("tv", r.items[0].kind)
        assertEquals(99L, r.seed)
        assertTrue(r.shuffle)
    }
}
