package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.ContinueFormat
import com.beeboentertainment.movie.core.HistoryClear
import com.beeboentertainment.movie.core.IdCodec
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.ContinueResponse
import com.beeboentertainment.movie.data.HistoryClearRequest
import com.beeboentertainment.movie.data.MissingRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Continue Watching formatting, history clear scopes, and the missing-request payload. */
class HistoryLogicTest {

    private val json = ApiClient.JSON

    /* ------------------------------ formatting ------------------------------ */

    @Test
    fun `the subtitle reads like the website`() {
        // 90 minute film, 64 minutes watched -> 26 minutes to go
        assertEquals(
            "43% · 26 min left",
            ContinueFormat.subtitle(43, currentTimeSec = 3840.0, durationSec = 5400.0)
        )
        // a part-minute always rounds UP, so "0 min left" can never appear while it's still playing
        assertEquals("26 min left", ContinueFormat.remainingLabel(3870.0, 5400.0))
    }

    @Test
    fun `over an hour left reads in hours and minutes`() {
        assertEquals("1 hr 5 min left", ContinueFormat.remainingLabel(0.0, 3900.0))
        assertEquals("2 hr left", ContinueFormat.remainingLabel(0.0, 7200.0))
    }

    @Test
    fun `nearly finished and finished read sensibly`() {
        assertEquals("less than a minute left", ContinueFormat.remainingLabel(5370.0, 5400.0))
        assertEquals("finished", ContinueFormat.remainingLabel(5400.0, 5400.0))
    }

    @Test
    fun `an unknown duration falls back to just the percent`() {
        assertNull(ContinueFormat.remainingLabel(100.0, 0.0))
        assertEquals("43%", ContinueFormat.subtitle(43, 100.0, 0.0))
    }

    @Test
    fun `the server's percent is trusted, and derived only when absent or nonsense`() {
        assertEquals(43, ContinueFormat.percent(43, 3900.0, 5400.0))
        assertEquals(72, ContinueFormat.percent(null, 3900.0, 5400.0))
        assertEquals(72, ContinueFormat.percent(-5, 3900.0, 5400.0))
        assertEquals(0, ContinueFormat.percent(null, 100.0, 0.0))
    }

    @Test
    fun `the progress bar fraction is clamped`() {
        assertEquals(0.43f, ContinueFormat.fraction(43), 0.0001f)
        assertEquals(1.0f, ContinueFormat.fraction(150), 0.0001f)
        assertEquals(0.0f, ContinueFormat.fraction(-10), 0.0001f)
    }

    /* -------------------------------- parsing ------------------------------- */

    @Test
    fun `continue response parses`() {
        val body = """
        {"ok":true,"items":[
          {"id":"bW92aWVzL0hlYXQubWt2","kind":"movie","title":"Heat",
           "poster":"/media/poster/123.jpg","stream":"/file?id=x&mt=t",
           "currentTime":3900.0,"duration":5400.0,"percent":72},
          {"id":"e1","kind":"tv","title":"The Wire — S1E2","poster":null,
           "stream":"/tvfile?id=e1&mt=t","currentTime":600.0,"duration":3600.0,"percent":17}]}
        """.trimIndent()
        val r = json.decodeFromString(ContinueResponse.serializer(), body)
        assertTrue(r.ok)
        assertEquals(2, r.items.size)
        assertEquals("movie", r.items[0].kind)
        assertEquals(72, r.items[0].percent)
        assertNull(r.items[1].poster)
        assertEquals("tv", r.items[1].kind)
    }

    @Test
    fun `an empty history parses to an empty list`() {
        val r = json.decodeFromString(ContinueResponse.serializer(), """{"ok":true,"items":[]}""")
        assertTrue(r.ok)
        assertTrue(r.items.isEmpty())
    }

    /* ------------------------------ clear scopes ---------------------------- */

    @Test
    fun `the show half of an episode title is what scope=show matches on`() {
        assertEquals("The Wire", HistoryClear.showTitleOf("The Wire — S1E2"))
        assertEquals("The Wire", HistoryClear.showTitleOf("The Wire - S1E2"))
        // a movie has no episode half and comes back untouched
        assertEquals("Heat", HistoryClear.showTitleOf("Heat"))
        assertEquals("", HistoryClear.showTitleOf(null))
    }

    @Test
    fun `scope one sends a fileName, scope show sends a title, scope all sends neither`() {
        val one = json.encodeToString(
            HistoryClearRequest.serializer(),
            HistoryClearRequest(HistoryClear.SCOPE_ONE, fileName = "movies/Heat.mkv")
        )
        assertTrue(one.contains("\"scope\":\"one\""))
        assertTrue(one.contains("\"fileName\":\"movies/Heat.mkv\""))
        assertFalse(one.contains("\"title\""))

        val show = json.encodeToString(
            HistoryClearRequest.serializer(),
            HistoryClearRequest(HistoryClear.SCOPE_SHOW, title = "The Wire")
        )
        assertTrue(show.contains("\"scope\":\"show\""))
        assertTrue(show.contains("\"title\":\"The Wire\""))
        assertFalse(show.contains("\"fileName\""))

        val all = json.encodeToString(
            HistoryClearRequest.serializer(),
            HistoryClearRequest(HistoryClear.SCOPE_ALL)
        )
        assertEquals("{\"scope\":\"all\"}", all)
    }

    @Test
    fun `every destructive action says exactly what it will remove`() {
        assertEquals(
            "Remove \"Heat\" from your history?",
            HistoryClear.confirmationFor(HistoryClear.SCOPE_ONE, "Heat")
        )
        assertEquals(
            "Remove everything for \"The Wire\" from your history?",
            HistoryClear.confirmationFor(HistoryClear.SCOPE_SHOW, "The Wire — S1E2")
        )
        assertTrue(
            HistoryClear.confirmationFor(HistoryClear.SCOPE_ALL, null).contains("can't be undone")
        )
    }

    /* -------------------------------- id codec ------------------------------ */

    @Test
    fun `an encoded id decodes back to the fileName the clear endpoint wants`() {
        val encoded = java.util.Base64.getEncoder()
            .encodeToString("TV Shows/The Wire/S01E02.mkv".toByteArray())
        assertEquals("TV Shows/The Wire/S01E02.mkv", IdCodec.decodeToPath(encoded))
        assertEquals("TV Shows/The Wire/S01E02.mkv", IdCodec.fileNameFor(encoded))
    }

    @Test
    fun `an id that isn't base64 is passed through untouched`() {
        // the server treats an unmatched fileName as "removes nothing", so this is safe
        assertEquals("not-base64!!", IdCodec.fileNameFor("not-base64!!"))
        assertEquals("", IdCodec.fileNameFor(null))
    }

    /* ---------------------------- missing request --------------------------- */

    @Test
    fun `a tv missing request carries show, season and episode and omits movie-only fields`() {
        val body = json.encodeToString(
            MissingRequest.serializer(),
            MissingRequest(kind = "tv", showName = "The Wire", season = 1, episode = 3, title = "The Wire S1E3")
        )
        assertTrue(body.contains("\"kind\":\"tv\""))
        assertTrue(body.contains("\"showName\":\"The Wire\""))
        assertTrue(body.contains("\"season\":1"))
        assertTrue(body.contains("\"episode\":3"))
        // fields the phone API cannot supply are left out rather than guessed
        assertFalse(body.contains("collectionName"))
        assertFalse(body.contains("tmdbId"))
    }
}
