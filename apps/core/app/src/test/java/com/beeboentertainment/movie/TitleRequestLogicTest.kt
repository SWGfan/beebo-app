package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.AdminErrors
import com.beeboentertainment.movie.core.TitleRequestLogic
import com.beeboentertainment.movie.core.TitleRequestLogic.ResultAction
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.RequestRef
import com.beeboentertainment.movie.data.TitleRequest
import com.beeboentertainment.movie.data.TitleRequestCreate
import com.beeboentertainment.movie.data.TitleRequestResult
import com.beeboentertainment.movie.data.TitleRequestsResponse
import com.beeboentertainment.movie.data.TitleRequester
import com.beeboentertainment.movie.data.TitleSearchResponse
import com.beeboentertainment.movie.data.TitleSearchResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TitleRequestLogicTest {

    private val json = ApiClient.JSON

    @Test
    fun `search results parse`() {
        val body = """
            {"ok":true,"items":[
              {"kind":"movie","tmdbId":438631,"title":"Dune","year":2021,"overview":"Spice.",
               "tmdbPoster":"https://image.tmdb.org/t/p/w185/dune.jpg","inLibrary":false,
               "request":{"id":"r1","status":"requested","mine":true}},
              {"kind":"tv","tmdbId":90228,"title":"Dune: Prophecy","year":2024,"tmdbPoster":null,"inLibrary":false,"request":null}]}
        """.trimIndent()
        val r = json.decodeFromString(TitleSearchResponse.serializer(), body)
        assertEquals(2, r.items.size)
        assertEquals(ResultAction.REQUESTED_BY_YOU, TitleRequestLogic.resultAction(r.items[0]))
        assertEquals(ResultAction.REQUEST, TitleRequestLogic.resultAction(r.items[1]))
        assertEquals("TV show · 2024", TitleRequestLogic.resultSubtitle(r.items[1]))
    }

    @Test
    fun `no key on the server is a readable ok=false`() {
        val r = json.decodeFromString(TitleSearchResponse.serializer(), """{"ok":false,"error":"no_api_key","items":[]}""")
        assertFalse(r.ok)
        assertTrue(AdminErrors.message(r.error).contains("TMDB key"))
    }

    @Test
    fun `refusal codes have wording`() {
        listOf("rate_limited", "already_in_library", "owner_only", "query_too_short", "tmdb_unreachable", "bad_request")
            .forEach { assertFalse(it, AdminErrors.message(it).startsWith("The server said:")) }
    }

    @Test
    fun `what a result row offers`() {
        val base = TitleSearchResult(kind = "movie", tmdbId = 1, title = "X")
        assertEquals(ResultAction.REQUEST, TitleRequestLogic.resultAction(base))
        assertEquals(ResultAction.IN_LIBRARY, TitleRequestLogic.resultAction(base.copy(inLibrary = true, request = RequestRef("r"))))
        assertEquals(ResultAction.JOIN, TitleRequestLogic.resultAction(base.copy(request = RequestRef("r", "requested", false))))
        assertEquals(ResultAction.DISMISSED, TitleRequestLogic.resultAction(base.copy(request = RequestRef("r", "dismissed", true))))
        assertEquals(ResultAction.ADDED, TitleRequestLogic.resultAction(base.copy(request = RequestRef("r", "added", true))))
        assertTrue(TitleRequestLogic.isActionable(ResultAction.REQUEST))
        assertTrue(TitleRequestLogic.isActionable(ResultAction.JOIN))
        listOf(ResultAction.REQUESTED_BY_YOU, ResultAction.IN_LIBRARY, ResultAction.DISMISSED, ResultAction.ADDED)
            .forEach { assertFalse(it.name, TitleRequestLogic.isActionable(it)) }
        assertEquals("Me too", TitleRequestLogic.resultButtonLabel(ResultAction.JOIN))
    }

    @Test
    fun `search needs two letters`() {
        assertFalse(TitleRequestLogic.canSearch(" a "))
        assertTrue(TitleRequestLogic.canSearch("up"))
    }

    @Test
    fun `the note is capped as you type and tidied when sent`() {
        val long = "x".repeat(400)
        assertEquals(TitleRequestLogic.NOTE_MAX, TitleRequestLogic.clampNote(long).length)
        assertEquals("0 / 280", TitleRequestLogic.noteCounter(""))
        val c = TitleRequestLogic.create(
            TitleSearchResult(kind = "tv", tmdbId = 2316, title = " The Office ", year = 2005, tmdbPoster = "https://image.tmdb.org/t/p/w185/o.jpg"),
            "  the   US one \n please "
        )
        assertEquals(TitleRequestCreate("tv", 2316, "The Office", 2005, "the US one please", "https://image.tmdb.org/t/p/w185/o.jpg"), c)
        val blank = TitleRequestLogic.buildCreate("book", 0, "Dune", null, "   ", "http://evil.example/x.jpg")
        assertEquals("movie", blank.kind)
        assertNull(blank.tmdbId)
        assertNull(blank.note)
        assertNull("only TMDB image URLs are passed on", blank.poster)
    }

    @Test
    fun `the request body serialises the way the server reads it`() {
        val s = json.encodeToString(TitleRequestCreate.serializer(), TitleRequestCreate("movie", 438631, "Dune", 2021, null, null))
        assertTrue(s.contains("\"kind\":\"movie\""))
        assertTrue(s.contains("\"tmdbId\":438631"))
        assertFalse("nulls are left out", s.contains("note"))
    }

    @Test
    fun `success messages`() {
        assertEquals("You've already asked for Dune.", TitleRequestLogic.successMessage("Dune", false, true, false))
        assertEquals("Added your name to the request for Dune.", TitleRequestLogic.successMessage("Dune", false, false, true))
        assertTrue(TitleRequestLogic.successMessage("Dune", true, false, false).startsWith("Requested Dune."))
    }

    @Test
    fun `lists stay in step after a request or a dismiss`() {
        val results = listOf(
            TitleSearchResult(kind = "movie", tmdbId = 1, title = "A"),
            TitleSearchResult(kind = "tv", tmdbId = 1, title = "A show")
        )
        val created = TitleRequest(id = "r1", title = "A", status = "requested", mine = true)
        val marked = TitleRequestLogic.markResultRequested(results, "movie", 1, created)
        assertEquals(ResultAction.REQUESTED_BY_YOU, TitleRequestLogic.resultAction(marked[0]))
        assertEquals("same id, other kind, untouched", ResultAction.REQUEST, TitleRequestLogic.resultAction(marked[1]))

        val existing = listOf(TitleRequest(id = "r0", title = "Old"), TitleRequest(id = "r1", title = "A", status = "requested"))
        val dismissed = created.copy(status = "dismissed")
        val up = TitleRequestLogic.upsert(existing, dismissed)
        assertEquals(listOf("r1", "r0"), up.map { it.id })
        assertEquals("dismissed", up[0].status)
        assertEquals(existing, TitleRequestLogic.upsert(existing, null))
    }

    @Test
    fun `only the owner is offered dismiss, and only on open requests`() {
        val open = TitleRequest(id = "a", status = "requested")
        assertTrue(TitleRequestLogic.canDismiss(true, open))
        assertFalse(TitleRequestLogic.canDismiss(false, open))
        assertFalse(TitleRequestLogic.canDismiss(true, open.copy(status = "added")))
        assertFalse(TitleRequestLogic.canDismiss(true, open.copy(status = "dismissed")))
    }

    @Test
    fun `my requests parse, sort open first, and describe themselves`() {
        val body = """
            {"ok":true,"canDismiss":false,"items":[
              {"id":"1","kind":"movie","title":"Dune","year":2021,"status":"added","requestedAt":300,"mine":true,"note":"the new one","requesters":[],"requesterCount":2},
              {"id":"2","kind":"tv","title":"The Office","status":"requested","requestedAt":100,"mine":true},
              {"id":"3","kind":"tv","title":"Severance — S1E3","showName":"Severance","season":1,"episode":3,"source":"upnext","status":"requested","requestedAt":200,"mine":true},
              {"id":"4","kind":"movie","title":"Nope","status":"dismissed","requestedAt":400,"mine":true}]}
        """.trimIndent()
        val r = json.decodeFromString(TitleRequestsResponse.serializer(), body)
        assertFalse(r.canDismiss)
        assertEquals(listOf("3", "2", "1", "4"), TitleRequestLogic.sorted(r.items).map { it.id })
        assertEquals("Season 1, episode 3", TitleRequestLogic.requestSubtitle(r.items[2]))
        assertEquals("TV show", TitleRequestLogic.requestSubtitle(r.items[1]))
        assertEquals("Film · 2021", TitleRequestLogic.requestSubtitle(r.items[0]))
        assertEquals("Added", TitleRequestLogic.statusLabel("added"))
        assertEquals("Declined", TitleRequestLogic.statusLabel("dismissed"))
        assertNull("a member sees no names", TitleRequestLogic.requestersLine(r.items[0]))
        assertEquals(
            "Asked for by Mia, Sam",
            TitleRequestLogic.requestersLine(TitleRequest(requesters = listOf(TitleRequester("Mia"), TitleRequester("Sam"))))
        )
    }

    @Test
    fun `a rate-limited create parses its retry hint`() {
        val r = json.decodeFromString(TitleRequestResult.serializer(), """{"ok":false,"error":"rate_limited","retryAfterSeconds":1200}""")
        assertEquals(1200, r.retryAfterSeconds)
    }
}
