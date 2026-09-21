package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.CollectionsLogic
import com.beeboentertainment.movie.core.CollectionsLogic.PartAction
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.CollectionDetailResponse
import com.beeboentertainment.movie.data.CollectionPart
import com.beeboentertainment.movie.data.CollectionSummary
import com.beeboentertainment.movie.data.CollectionsResponse
import com.beeboentertainment.movie.data.Movie
import com.beeboentertainment.movie.data.RequestRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CollectionsLogicTest {

    private val json = ApiClient.JSON

    /** The shape the stream server's /api/collections test asserts, trimmed. */
    private val listBody = """
        {"ok":true,"unchecked":3,"refreshing":true,"items":[
          {"id":8091,"name":"Alien Collection","displayName":"Alien Collection","poster":"/media/poster/348.jpg",
           "tmdbPoster":"https://image.tmdb.org/t/p/w300/alien.jpg","ownedCount":2,"total":4,"complete":false,
           "firstYear":1979,"lastYear":1992},
          {"id":10194,"name":"Toy Story","displayName":"Toy Story Collection","poster":null,
           "tmdbPoster":"https://image.tmdb.org/t/p/w300/ts1.jpg","ownedCount":2,"total":2,"complete":true,
           "firstYear":1995,"lastYear":1999}]}
    """.trimIndent()

    private val detailBody = """
        {"ok":true,"collection":{"id":8091,"name":"Alien Collection","displayName":"Alien Collection",
          "ownedCount":2,"total":4,"complete":false,"parts":[
          {"tmdbId":348,"title":"Alien","year":1979,"releaseDate":"1979-05-25","owned":true,"poster":"/media/poster/348.jpg",
           "tmdbPoster":"https://image.tmdb.org/t/p/w300/alien.jpg",
           "movie":{"id":"QWxpZW4","title":"Alien","year":1979,"stream":"/file?id=QWxpZW4&mt=x","collectionId":8091},"request":null},
          {"tmdbId":679,"title":"Aliens","year":1986,"owned":true,"poster":null,"tmdbPoster":null,
           "movie":{"id":"QWxpZW5z","title":"Aliens","stream":"/file?id=QWxpZW5z"},"request":null},
          {"tmdbId":8077,"title":"Alien³","year":1992,"owned":false,"poster":null,
           "tmdbPoster":"https://image.tmdb.org/t/p/w300/alien3.jpg","movie":null,
           "request":{"id":"r1","status":"requested","mine":true}},
          {"tmdbId":999999,"title":"Untitled Alien Sequel","year":null,"owned":false,"movie":null,"request":null}]}}
    """.trimIndent()

    @Test
    fun `the collections list parses`() {
        val r = json.decodeFromString(CollectionsResponse.serializer(), listBody)
        assertEquals(listOf(8091, 10194), r.items.map { it.id })
        assertEquals(3, r.unchecked)
        assertTrue(r.refreshing)
        assertEquals("Toy Story Collection", CollectionsLogic.title(r.items[1]))
    }

    @Test
    fun `a collection page parses, keeping the server's release order`() {
        val r = json.decodeFromString(CollectionDetailResponse.serializer(), detailBody)
        val c = r.collection!!
        assertEquals(listOf(348, 679, 8077, 999999), c.parts.map { it.tmdbId })
        assertEquals("/file?id=QWxpZW4&mt=x", c.parts[0].movie?.stream)
        assertEquals("r1", c.parts[2].request?.id)
        assertNull(c.parts[3].year)
    }

    @Test
    fun `filter chips and search`() {
        val items = json.decodeFromString(CollectionsResponse.serializer(), listBody).items
        assertEquals(2, CollectionsLogic.filter(items, CollectionsLogic.Filter.ALL).size)
        assertEquals(listOf(8091), CollectionsLogic.filter(items, CollectionsLogic.Filter.INCOMPLETE).map { it.id })
        assertEquals(listOf(10194), CollectionsLogic.filter(items, CollectionsLogic.Filter.COMPLETE).map { it.id })
        assertEquals(listOf(10194), CollectionsLogic.filter(items, CollectionsLogic.Filter.ALL, " toy ").map { it.id })
    }

    @Test
    fun `progress and year labels`() {
        assertEquals("2 of 4", CollectionsLogic.progressLabel(2, 4))
        assertEquals("You have all 3", CollectionsLogic.progressLabel(3, 3))
        assertEquals("You have it", CollectionsLogic.progressLabel(1, 1))
        assertEquals("", CollectionsLogic.progressLabel(0, 0))
        assertEquals("1979–1992", CollectionsLogic.yearsLabel(1979, 1992))
        assertEquals("1995", CollectionsLogic.yearsLabel(1995, 1995))
        assertEquals("1995", CollectionsLogic.yearsLabel(null, 1995))
        assertNull(CollectionsLogic.yearsLabel(null, null))
        val s = CollectionSummary(ownedCount = 2, total = 4, firstYear = 1979, lastYear = 1992)
        assertEquals("2 of 4 · 1979–1992", CollectionsLogic.subtitle(s))
    }

    @Test
    fun `detail summary line`() {
        val c = json.decodeFromString(CollectionDetailResponse.serializer(), detailBody).collection!!
        assertEquals("2 of 4 in your library · 2 not", CollectionsLogic.detailSummary(c))
        assertEquals("You have all 4 — complete", CollectionsLogic.detailSummary(c.copy(ownedCount = 4)))
        assertEquals("None of the 4 films are in your library", CollectionsLogic.detailSummary(c.copy(ownedCount = 0)))
    }

    @Test
    fun `what choosing a film does`() {
        val owned = CollectionPart(tmdbId = 1, owned = true, movie = Movie(id = "a"))
        assertEquals(PartAction.PLAY, CollectionsLogic.partAction(owned))
        assertNull(CollectionsLogic.partBadge(owned))
        // Owned but no playable item (shouldn't happen) is not treated as playable.
        assertEquals(PartAction.REQUEST, CollectionsLogic.partAction(owned.copy(movie = null)))

        val missing = CollectionPart(tmdbId = 2, owned = false)
        assertEquals(PartAction.REQUEST, CollectionsLogic.partAction(missing))
        assertTrue(CollectionsLogic.canRequest(missing))
        assertEquals("Not in library", CollectionsLogic.partBadge(missing))

        val mine = missing.copy(request = RequestRef("r", "requested", mine = true))
        assertEquals(PartAction.REQUESTED_BY_YOU, CollectionsLogic.partAction(mine))
        assertFalse(CollectionsLogic.canRequest(mine))

        val others = missing.copy(request = RequestRef("r", "requested", mine = false))
        assertEquals(PartAction.REQUESTED_BY_OTHERS, CollectionsLogic.partAction(others))
        assertTrue("you can add your name", CollectionsLogic.canRequest(others))

        assertEquals(PartAction.DISMISSED, CollectionsLogic.partAction(missing.copy(request = RequestRef("r", "dismissed"))))
        assertEquals(PartAction.ADDED, CollectionsLogic.partAction(missing.copy(request = RequestRef("r", "added"))))
    }

    @Test
    fun `poster falls back to TMDB`() {
        assertEquals("/media/poster/1.jpg", CollectionsLogic.posterPath("/media/poster/1.jpg", "https://image.tmdb.org/x"))
        assertEquals("https://image.tmdb.org/x", CollectionsLogic.posterPath(null, "https://image.tmdb.org/x"))
        assertEquals("https://image.tmdb.org/x", CollectionsLogic.posterPath("", "https://image.tmdb.org/x"))
        assertNull(CollectionsLogic.posterPath(null, null))
    }

    @Test
    fun `part of line reads naturally`() {
        assertEquals("Part of the Alien Collection", CollectionsLogic.partOfLine("Alien Collection"))
        assertEquals("Part of the Toy Story Collection", CollectionsLogic.partOfLine("Toy Story"))
        assertEquals("Part of the Godfather Collection", CollectionsLogic.partOfLine("The Godfather Collection"))
        assertNull(CollectionsLogic.partOfLine(null))
        assertNull(CollectionsLogic.partOfLine("  "))
    }

    @Test
    fun `a request from the page marks only that film`() {
        val c = json.decodeFromString(CollectionDetailResponse.serializer(), detailBody).collection!!
        val after = CollectionsLogic.withRequested(c, 999999, "r9")
        assertEquals(PartAction.REQUESTED_BY_YOU, CollectionsLogic.partAction(after.parts[3]))
        assertEquals("r9", after.parts[3].request?.id)
        assertEquals(c.parts.take(3), after.parts.take(3))
    }
}
