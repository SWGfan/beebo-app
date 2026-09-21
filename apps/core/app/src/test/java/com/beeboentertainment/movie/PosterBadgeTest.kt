package com.beeboentertainment.movie

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.MoviesResponse
import com.beeboentertainment.movie.data.TvShowsResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Poster corner badges. These assert what the API can and cannot tell us, so the two known
 * gaps (TV "NEW", and collection membership) fail loudly here the moment the server adds them.
 */
class PosterBadgeTest {

    private val json = ApiClient.JSON

    @Test
    fun `movies carry isNew, which drives the green NEW banner`() {
        val body = """
        {"ok":true,"genres":[],"items":[
          {"id":"a","title":"Just Added","isNew":true,"quality":"4K","stream":"/file?id=a"},
          {"id":"b","title":"Old Favourite","isNew":false,"quality":"1080p","stream":"/file?id=b"}]}
        """.trimIndent()
        val r = json.decodeFromString(MoviesResponse.serializer(), body)
        assertTrue(r.items[0].isNew)
        assertFalse(r.items[1].isNew)
    }

    @Test
    fun `a movie with no isNew key defaults to not new`() {
        val r = json.decodeFromString(
            MoviesResponse.serializer(),
            """{"ok":true,"items":[{"id":"a","title":"T","stream":"/file?id=a"}]}"""
        )
        assertFalse(r.items.single().isNew)
    }

    @Test
    fun `all four quality tiers survive parsing for the badge`() {
        val body = """
        {"ok":true,"items":[
          {"id":"1","title":"a","quality":"4K"},{"id":"2","title":"b","quality":"1080p"},
          {"id":"3","title":"c","quality":"720p"},{"id":"4","title":"d","quality":"SD"},
          {"id":"5","title":"e","quality":null}]}
        """.trimIndent()
        val r = json.decodeFromString(MoviesResponse.serializer(), body)
        assertEquals(listOf("4K", "1080p", "720p", "SD", null), r.items.map { it.quality })
    }

    @Test
    fun `tv shows now carry isNew, so TV cards get the NEW banner too`() {
        val body = """
        {"ok":true,"items":[
          {"key":"wire","name":"The Wire","episodeCount":24,"quality":"720p","isNew":true},
          {"key":"old","name":"Old Show","episodeCount":3,"quality":"SD","isNew":false}]}
        """.trimIndent()
        val r = json.decodeFromString(TvShowsResponse.serializer(), body)
        assertTrue(r.items[0].isNew)
        assertFalse(r.items[1].isNew)
        assertTrue(TvShow_hasIsNewField())
    }

    @Test
    fun `a tv show with no isNew key defaults to not new`() {
        val r = json.decodeFromString(
            TvShowsResponse.serializer(),
            """{"ok":true,"items":[{"key":"wire","name":"The Wire"}]}"""
        )
        assertFalse(r.items.single().isNew)
    }

    @Test
    fun `movies now carry collection membership, which drives the link badge`() {
        val body = """
        {"ok":true,"items":[
          {"id":"a","title":"The Godfather","stream":"/file?id=a",
           "collectionName":"The Godfather Collection","collectionId":230},
          {"id":"b","title":"Standalone","stream":"/file?id=b",
           "collectionName":null,"collectionId":null}]}
        """.trimIndent()
        val r = json.decodeFromString(MoviesResponse.serializer(), body)
        assertEquals("The Godfather Collection", r.items[0].collectionName)
        assertEquals(230, r.items[0].collectionId)
        // a standalone film gets no badge
        assertNull(r.items[1].collectionId)
        assertNull(r.items[1].collectionName)
        assertTrue(Movie_hasCollectionField())
    }

    @Test
    fun `a movie whose collection has not been looked up yet gets no badge`() {
        // both null also means "cache-only, not resolved" — same rendering either way
        val r = json.decodeFromString(
            MoviesResponse.serializer(),
            """{"ok":true,"items":[{"id":"a","title":"T","stream":"/file?id=a"}]}"""
        )
        assertNull(r.items.single().collectionId)
    }

    /* Reflection guards: these caught the fields being absent before, and now pin them present. */

    private fun TvShow_hasIsNewField(): Boolean =
        com.beeboentertainment.movie.data.TvShow::class.java.declaredFields.any { it.name == "isNew" }

    private fun Movie_hasCollectionField(): Boolean =
        com.beeboentertainment.movie.data.Movie::class.java.declaredFields.any {
            it.name.contains("collection", ignoreCase = true)
        }
}
