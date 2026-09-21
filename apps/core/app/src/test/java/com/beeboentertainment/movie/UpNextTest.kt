package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.UpNextResolver
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.CreditsResponse
import com.beeboentertainment.movie.data.MissingRequest
import com.beeboentertainment.movie.data.UpNextResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GET /api/upnext is the single source of truth for "what's next", so these tests are about
 * reading it faithfully and posting `missing` back untouched — there is no client-side
 * derivation left to test.
 */
class UpNextTest {

    private val json = ApiClient.JSON

    /* ------------------------------ next present ---------------------------- */

    @Test
    fun `a tv next episode parses`() {
        val body = """
        {"ok":true,
         "next":{"kind":"tv","id":"e3","title":"The Wire — S1E3",
                 "poster":"/media/poster/9.jpg","stream":"/tvfile?id=e3&mt=t"},
         "missing":null}
        """.trimIndent()
        val r = json.decodeFromString(UpNextResponse.serializer(), body)
        assertTrue(r.ok)
        assertNull(r.missing)
        assertNotNull(r.next)
        assertEquals("tv", r.next!!.kind)
        assertEquals("e3", r.next!!.id)
        assertEquals("/tvfile?id=e3&mt=t", r.next!!.stream)
    }

    @Test
    fun `a movie collection part parses and carries its own kind`() {
        val body = """
        {"ok":true,
         "next":{"kind":"movie","id":"bW92aWVzL0dvZGZhdGhlcjIubWt2","title":"The Godfather Part II",
                 "poster":null,"stream":"/file?id=x&mt=t"},
         "missing":null}
        """.trimIndent()
        val r = json.decodeFromString(UpNextResponse.serializer(), body)
        // the item's own kind decides the stream path and history kind, not the request's
        assertEquals("movie", r.next?.kind)
        assertNull(r.next?.poster)
        assertEquals(
            "http://host:47811/file?id=x&mt=t",
            UrlUtils.join("http://host:47811", r.next?.stream)
        )
    }

    @Test
    fun `a null poster stays null so the UI shows a placeholder`() {
        val r = json.decodeFromString(
            UpNextResponse.serializer(),
            """{"ok":true,"next":{"kind":"tv","id":"e1","title":"T","poster":null,"stream":"/tvfile?id=e1"},"missing":null}"""
        )
        assertNull(r.next?.poster)
        assertNull(UrlUtils.join("http://host:47811", r.next?.poster))
    }

    /* -------------------------------- missing ------------------------------- */

    @Test
    fun `a missing tv episode parses, with the show's tmdb id passed through untouched`() {
        val body = """
        {"ok":true,"next":null,
         "missing":{"kind":"tv","title":"The Wire S1E3","showName":"The Wire",
                    "season":1,"episode":3,"collectionName":null,"tmdbId":1438,"year":2002}}
        """.trimIndent()
        val r = json.decodeFromString(UpNextResponse.serializer(), body)
        assertNull(r.next)
        val m = r.missing!!
        assertEquals("tv", m.kind)
        assertEquals("The Wire", m.showName)
        assertEquals(1, m.season)
        assertEquals(3, m.episode)
        // this is the SHOW's id, not an episode id — the app only carries it
        assertEquals(1438, m.tmdbId)
        assertNull(m.collectionName)
    }

    @Test
    fun `a missing movie collection part parses`() {
        val body = """
        {"ok":true,"next":null,
         "missing":{"kind":"movie","title":"The Godfather Part III","showName":null,
                    "season":null,"episode":null,"collectionName":"The Godfather Collection",
                    "tmdbId":242,"year":1990}}
        """.trimIndent()
        val r = json.decodeFromString(UpNextResponse.serializer(), body)
        val m = r.missing!!
        assertEquals("movie", m.kind)
        assertEquals("The Godfather Collection", m.collectionName)
        assertNull(m.showName)
        assertNull(m.season)
    }

    @Test
    fun `the missing object is posted straight back to missing-request, unchanged`() {
        val body = """
        {"ok":true,"next":null,
         "missing":{"kind":"tv","title":"The Wire S1E3","showName":"The Wire",
                    "season":1,"episode":3,"collectionName":null,"tmdbId":1438,"year":2002}}
        """.trimIndent()
        val missing = json.decodeFromString(UpNextResponse.serializer(), body).missing!!

        // Same type in both directions, so the round trip cannot re-derive or drop anything.
        val posted = json.encodeToString(MissingRequest.serializer(), missing)
        val reparsed = json.decodeFromString(MissingRequest.serializer(), posted)
        assertEquals(missing, reparsed)

        assertTrue(posted.contains("\"kind\":\"tv\""))
        assertTrue(posted.contains("\"showName\":\"The Wire\""))
        assertTrue(posted.contains("\"season\":1"))
        assertTrue(posted.contains("\"episode\":3"))
        assertTrue(posted.contains("\"tmdbId\":1438"))
        assertTrue(posted.contains("\"year\":2002"))
    }

    @Test
    fun `a movie missing round trip keeps collectionName`() {
        val missing = json.decodeFromString(
            MissingRequest.serializer(),
            """{"kind":"movie","title":"Part III","collectionName":"The Godfather Collection","tmdbId":242}"""
        )
        val posted = json.encodeToString(MissingRequest.serializer(), missing)
        assertEquals(missing, json.decodeFromString(MissingRequest.serializer(), posted))
        assertTrue(posted.contains("\"collectionName\":\"The Godfather Collection\""))
    }

    /* ------------------------------- both null ------------------------------ */

    @Test
    fun `both null means end of series or collection`() {
        val r = json.decodeFromString(
            UpNextResponse.serializer(),
            """{"ok":true,"next":null,"missing":null}"""
        )
        assertTrue(r.ok)
        assertNull(r.next)
        assertNull(r.missing)
    }

    @Test
    fun `absent fields behave the same as explicit nulls`() {
        val r = json.decodeFromString(UpNextResponse.serializer(), """{"ok":true}""")
        assertNull(r.next)
        assertNull(r.missing)
    }

    /* -------------------------------- copy ---------------------------------- */

    @Test
    fun `card copy`() {
        assertEquals("Up next: The Wire — S1E3", UpNextResolver.upNextLabel("The Wire — S1E3"))
        assertEquals("Playing in 7s…", UpNextResolver.countdownLabel(7))
        assertEquals(10, UpNextResolver.COUNTDOWN_SECONDS)
    }

    @Test
    fun `the missing message uses the title the server already built`() {
        assertEquals(
            "The Wire S1E3 isn't in your library yet. Reported to the admin.",
            UpNextResolver.missingMessage("The Wire S1E3")
        )
        assertEquals(
            "The next one isn't in your library yet. Reported to the admin.",
            UpNextResolver.missingMessage(null)
        )
    }

    /* ------------------------------- credits -------------------------------- */

    @Test
    fun `credits parse with photos and characters`() {
        val body = """
        {"ok":true,"cast":[
          {"id":1158,"name":"Al Pacino","character":"Vincent Hanna","profile":"/media/actor/1158.jpg"},
          {"id":380,"name":"Robert De Niro","character":null,"profile":"/media/actor/380.jpg"}]}
        """.trimIndent()
        val r = json.decodeFromString(CreditsResponse.serializer(), body)
        assertEquals(2, r.cast.size)
        assertEquals(1158, r.cast[0].id)
        assertEquals("Vincent Hanna", r.cast[0].character)
        // character is usually null today, so it must be optional
        assertNull(r.cast[1].character)
        assertEquals(
            "http://host:47811/media/actor/380.jpg",
            UrlUtils.join("http://host:47811", r.cast[1].profile)
        )
    }

    @Test
    fun `a person with no cached photo has a null profile and falls back to initials`() {
        val r = json.decodeFromString(
            CreditsResponse.serializer(),
            """{"ok":true,"cast":[{"id":7,"name":"Val Kilmer","character":null,"profile":null}]}"""
        )
        assertNull(r.cast.single().profile)
        assertNull(UrlUtils.join("http://host:47811", r.cast.single().profile))
        assertEquals("VK", com.beeboentertainment.movie.ui.initialsOf("Val Kilmer"))
        assertEquals("C", com.beeboentertainment.movie.ui.initialsOf("Cher"))
        assertEquals("?", com.beeboentertainment.movie.ui.initialsOf("   "))
    }

    @Test
    fun `an empty cast list renders nothing at all - no empty state`() {
        val r = json.decodeFromString(CreditsResponse.serializer(), """{"ok":true,"cast":[]}""")
        assertTrue(r.ok)
        assertTrue(r.cast.isEmpty())
    }

    @Test
    fun `credits tolerate a missing cast key`() {
        assertTrue(json.decodeFromString(CreditsResponse.serializer(), """{"ok":true}""").cast.isEmpty())
    }

    /* ---------------------------- actor filtering --------------------------- */

    @Test
    fun `the actor filter is a tmdb person id and composes with the other list params`() {
        assertEquals("?actor=1158", UrlUtils.query("actor" to 1158.toString()))
        assertEquals(
            "?genre=28&actor=1158",
            UrlUtils.query("genre" to "28", "q" to null, "sort" to null, "actor" to "1158")
        )
        // no actor -> the parameter disappears entirely rather than being sent empty
        assertEquals("", UrlUtils.query("actor" to null))
        assertFalse(UrlUtils.query("genre" to "28", "actor" to null).contains("actor"))
    }
}
