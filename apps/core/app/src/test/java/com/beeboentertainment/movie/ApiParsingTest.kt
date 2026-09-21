package com.beeboentertainment.movie

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.EpisodesResponse
import com.beeboentertainment.movie.data.LoginResponse
import com.beeboentertainment.movie.data.MoviesResponse
import com.beeboentertainment.movie.data.PingResponse
import com.beeboentertainment.movie.data.SurfGenresResponse
import com.beeboentertainment.movie.data.SurfResponse
import com.beeboentertainment.movie.data.SurfYearsResponse
import com.beeboentertainment.movie.data.TvShowsResponse
import com.beeboentertainment.movie.data.WatchSessionResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parses the exact JSON shapes from /root/work/spec/api-contract.md, plus the two real-world
 * wrinkles the server team confirmed: null posters and null season numbers.
 */
class ApiParsingTest {

    private val json = ApiClient.JSON

    @Test
    fun `ping identifies a beeboentertainment server`() {
        val r = json.decodeFromString(
            PingResponse.serializer(),
            """{"ok":true,"app":"beeboentertainment","apiVersion":1}"""
        )
        assertTrue(r.isBeeboServer)
        assertEquals(1, r.apiVersion)
    }

    @Test
    fun `ping rejects some other server that happens to answer`() {
        val r = json.decodeFromString(PingResponse.serializer(), """{"ok":true,"app":"something-else"}""")
        assertFalse(r.isBeeboServer)
    }

    @Test
    fun `login success carries a token and the user`() {
        val r = json.decodeFromString(
            LoginResponse.serializer(),
            """{"ok":true,"token":"u1.1790000000.abcdef","user":{"id":"u1","name":"Nick","isAdmin":true}}"""
        )
        assertTrue(r.ok)
        assertEquals("u1.1790000000.abcdef", r.token)
        assertEquals("Nick", r.user?.name)
        assertTrue(r.user!!.isAdmin)
    }

    @Test
    fun `login failure maps bad_credentials to a readable message`() {
        val r = json.decodeFromString(LoginResponse.serializer(), """{"ok":false,"error":"bad_credentials"}""")
        assertFalse(r.ok)
        assertEquals("Wrong username or password.", r.failureMessage())
    }

    @Test
    fun `login lockout surfaces the wait time`() {
        val r = json.decodeFromString(
            LoginResponse.serializer(),
            """{"ok":false,"error":"locked","locked":true,"minutesRemaining":7}"""
        )
        assertTrue(r.locked)
        assertEquals("Too many failed attempts. Try again in 7 minutes.", r.failureMessage())
    }

    @Test
    fun `login lockout singular minute reads correctly`() {
        val r = json.decodeFromString(
            LoginResponse.serializer(),
            """{"ok":false,"error":"locked","locked":true,"minutesRemaining":1}"""
        )
        assertEquals("Too many failed attempts. Try again in 1 minute.", r.failureMessage())
    }

    @Test
    fun `movies list with genres and a full item`() {
        val body = """
        {"ok":true,
         "genres":[{"id":28,"name":"Action","count":12},{"id":35,"name":"Comedy","count":4}],
         "items":[
           {"id":"bW92aWVzL0hlYXQubWt2","title":"Heat","year":1995,
            "poster":"/media/poster/123.jpg","quality":"1080p","genres":[28,80],
            "overview":"A crew of thieves.","isNew":false,
            "stream":"/file?id=bW92aWVzL0hlYXQubWt2&mt=deadbeef"}
         ]}
        """.trimIndent()
        val r = json.decodeFromString(MoviesResponse.serializer(), body)
        assertTrue(r.ok)
        assertEquals(2, r.genres.size)
        assertEquals("Action", r.genres[0].name)
        assertEquals(12, r.genres[0].count)
        assertEquals(1, r.items.size)
        val m = r.items[0]
        assertEquals("Heat", m.title)
        assertEquals(1995, m.year)
        assertEquals("1080p", m.quality)
        assertEquals(listOf(28, 80), m.genres)
        assertEquals("/file?id=bW92aWVzL0hlYXQubWt2&mt=deadbeef", m.stream)
    }

    @Test
    fun `movies item with every nullable field null`() {
        val body = """
        {"ok":true,"genres":[],"items":[
          {"id":"x1","title":"Mystery File","year":null,"poster":null,"quality":null,
           "genres":[],"overview":null,"isNew":false,"stream":"/file?id=x1&mt=t"}]}
        """.trimIndent()
        val r = json.decodeFromString(MoviesResponse.serializer(), body)
        val m = r.items.single()
        assertNull(m.year)
        // poster is null when the server has no cached poster — the UI shows a placeholder
        assertNull(m.poster)
        assertNull(m.quality)
        assertNull(m.overview)
        assertTrue(m.genres.isEmpty())
    }

    @Test
    fun `unknown fields from a newer server do not break parsing`() {
        val body = """{"ok":true,"genres":[],"items":[
            {"id":"x","title":"T","stream":"/file?id=x","futureField":{"nested":true}}],"pagination":{"page":1}}"""
        val r = json.decodeFromString(MoviesResponse.serializer(), body)
        assertEquals("T", r.items.single().title)
    }

    @Test
    fun `tv shows list`() {
        val body = """
        {"ok":true,"genres":[{"id":18,"name":"Drama","count":3}],
         "items":[{"key":"the-wire","name":"The Wire","year":null,"poster":"/media/poster/9.jpg",
                   "episodeCount":24,"quality":"720p","genres":[18]}]}
        """.trimIndent()
        val r = json.decodeFromString(TvShowsResponse.serializer(), body)
        val s = r.items.single()
        assertEquals("the-wire", s.key)
        assertEquals(24, s.episodeCount)
        assertNull(s.year)
    }

    @Test
    fun `episodes grouped by season`() {
        val body = """
        {"ok":true,
         "show":{"key":"the-wire","name":"The Wire","poster":"/media/poster/9.jpg","overview":"Baltimore."},
         "seasons":[
           {"season":1,"episodes":[
              {"id":"e1","season":1,"episode":1,"title":"The Wire — S1E1","quality":"720p","stream":"/tvfile?id=e1&mt=t"},
              {"id":"e2","season":1,"episode":2,"title":"The Wire — S1E2","quality":null,"stream":"/tvfile?id=e2&mt=t"}]}
         ]}
        """.trimIndent()
        val r = json.decodeFromString(EpisodesResponse.serializer(), body)
        assertEquals("The Wire", r.show?.name)
        assertEquals(1, r.seasons.size)
        assertEquals("Season 1", r.seasons[0].displayName)
        assertEquals(2, r.seasons[0].episodes.size)
        assertEquals(2, r.seasons[0].episodes[1].episode)
        assertNull(r.seasons[0].episodes[1].quality)
    }

    @Test
    fun `episodes with unparseable numbering land in the unsorted group`() {
        val body = """
        {"ok":true,"show":{"key":"misc","name":"Misc"},
         "seasons":[
           {"season":2,"episodes":[{"id":"a","season":2,"episode":1,"title":"S2E1","stream":"/tvfile?id=a"}]},
           {"season":null,"episodes":[{"id":"b","season":null,"episode":null,"title":"weird-file","stream":"/tvfile?id=b"}]}
         ]}
        """.trimIndent()
        val r = json.decodeFromString(EpisodesResponse.serializer(), body)
        val unsorted = r.seasons.first { it.season == null }
        assertEquals("Unsorted", unsorted.displayName)
        assertNull(unsorted.episodes.single().episode)
        // the "Unsorted" bucket always sorts last
        val ordered = r.seasons.sortedWith(compareBy(nullsLast<Int>()) { it.season })
        assertEquals("Unsorted", ordered.last().displayName)
    }

    @Test
    fun `surf genres response`() {
        val r = json.decodeFromString(
            SurfGenresResponse.serializer(),
            """{"ok":true,"genres":[{"id":28,"name":"Action","count":9}],"total":40,"seed":123456}"""
        )
        assertEquals(40, r.total)
        assertEquals(123456L, r.seed)
        assertEquals(9, r.genres.single().count)
    }

    @Test
    fun `surf pick includes the start fraction`() {
        val body = """
        {"ok":true,"seed":123,"index":3,"total":40,"startFraction":0.5,
         "item":{"id":"m1","kind":"movie","title":"Heat","poster":"/media/poster/123.jpg",
                 "stream":"/file?id=m1&mt=t"}}
        """.trimIndent()
        val r = json.decodeFromString(SurfResponse.serializer(), body)
        assertEquals(3, r.index)
        assertEquals(40, r.total)
        assertEquals(0.5, r.startFraction, 0.0001)
        assertEquals("movie", r.item?.kind)
    }

    @Test
    fun `surf with an empty pool returns a null item`() {
        val r = json.decodeFromString(SurfResponse.serializer(), """{"ok":true,"total":0,"item":null}""")
        assertTrue(r.ok)
        assertEquals(0, r.total)
        assertNull(r.item)
    }

    @Test
    fun `surf years response with decades, years and unknown titles`() {
        val body = """
        {"ok":true,
         "decades":[{"decade":2000,"label":"2000s","count":7},{"decade":1990,"label":"1990s","count":12}],
         "years":[{"year":1999,"count":2},{"year":1994,"count":3}],
         "unknownCount":5,"total":40}
        """.trimIndent()
        val r = json.decodeFromString(SurfYearsResponse.serializer(), body)
        assertTrue(r.ok)
        assertEquals(2, r.decades.size)
        assertEquals(5, r.unknownCount)
        assertEquals(40, r.total)
        // lists arrive newest-first and we must not resort them
        assertEquals(2000, r.decades.first().decade)
        assertEquals("2000s", r.decades.first().displayLabel)
        assertEquals(1999, r.years.first().year)
        assertEquals(3, r.years.last().count)
    }

    @Test
    fun `surf years with a missing label falls back to the decade number`() {
        val r = json.decodeFromString(
            SurfYearsResponse.serializer(),
            """{"ok":true,"decades":[{"decade":1980,"count":4}],"years":[],"unknownCount":0,"total":4}"""
        )
        assertEquals("1980s", r.decades.single().displayLabel)
    }

    @Test
    fun `surf years for an empty pool parses to empty lists, not a crash`() {
        val r = json.decodeFromString(
            SurfYearsResponse.serializer(),
            """{"ok":true,"decades":[],"years":[],"unknownCount":0,"total":0}"""
        )
        assertTrue(r.ok)
        assertTrue(r.decades.isEmpty())
        assertTrue(r.years.isEmpty())
        assertEquals(0, r.unknownCount)
        assertEquals(0, r.total)
    }

    @Test
    fun `surf years tolerates the fields being absent entirely`() {
        val r = json.decodeFromString(SurfYearsResponse.serializer(), """{"ok":true}""")
        assertTrue(r.decades.isEmpty())
        assertEquals(0, r.unknownCount)
    }

    @Test
    fun `a kind equals both pool returns items that each declare their own kind`() {
        val movie = json.decodeFromString(
            SurfResponse.serializer(),
            """{"ok":true,"seed":1,"index":0,"total":57,"startFraction":0.5,
                "item":{"id":"m1","kind":"movie","title":"Heat","poster":null,"stream":"/file?id=m1&mt=t"}}"""
        )
        val episode = json.decodeFromString(
            SurfResponse.serializer(),
            """{"ok":true,"seed":1,"index":1,"total":57,"startFraction":0.5,
                "item":{"id":"e1","kind":"tv","title":"The Wire — S1E2","poster":null,"stream":"/tvfile?id=e1&mt=t"}}"""
        )
        assertEquals("movie", movie.item?.kind)
        assertEquals("/file?id=m1&mt=t", movie.item?.stream)
        assertEquals("tv", episode.item?.kind)
        assertEquals("/tvfile?id=e1&mt=t", episode.item?.stream)
        // same pool, same size — only the item differs
        assertEquals(57, movie.total)
        assertEquals(57, episode.total)
    }

    @Test
    fun `watch session id`() {
        val r = json.decodeFromString(
            WatchSessionResponse.serializer(),
            """{"ok":true,"sessionId":"sess-abc"}"""
        )
        assertEquals("sess-abc", r.sessionId)
    }
}
