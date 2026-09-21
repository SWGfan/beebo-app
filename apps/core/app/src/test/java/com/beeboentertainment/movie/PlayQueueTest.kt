package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.PlayQueue
import com.beeboentertainment.movie.core.PlayQueueHolder
import com.beeboentertainment.movie.core.PlaylistLogic
import com.beeboentertainment.movie.core.PlaylistLogic.toQueueItem
import com.beeboentertainment.movie.core.QueueItem
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.PlaylistDetailResponse
import com.beeboentertainment.movie.data.PlaylistField
import com.beeboentertainment.movie.data.PlaylistPlayResponse
import com.beeboentertainment.movie.data.PlaylistsResponse
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The play queue behind playlists, Play next and Add to queue, and the playlist wire format. */
class PlayQueueTest {

    private fun item(id: String, kind: String = "movie") = QueueItem(kind = kind, id = id, title = id.uppercase())
    private fun ids(q: PlayQueue) = q.items.map { it.id }

    @Test
    fun `a playlist plays in order from the start index and then finishes`() {
        var q = PlayQueue.fromPlaylist(listOf(item("a"), item("b"), item("c")), startIndex = 1, playlistId = "pl_1")
        assertNull(q.current?.takeIf { it.id == "b" })
        assertEquals("b", q.next?.id)
        q = q.advance()
        assertEquals("b", q.current?.id)
        assertEquals(1, q.remaining)
        q = q.advance()
        assertEquals("c", q.current?.id)
        assertNull(q.next)
        q = q.advance()
        assertNull(q.current)
        assertEquals(0, q.remaining)
        // advancing past the end stays at the end
        assertEquals(q, q.advance())
        assertEquals("b", q.jump(2).back().current?.id)
        assertTrue(PlayQueue.fromPlaylist(emptyList()).isEmpty)
    }

    @Test
    fun `play next goes straight after the current item, add to queue goes last`() {
        var q = PlayQueue.fromPlaylist(listOf(item("a"), item("b"), item("c"))).advance()
        q = q.playNext(listOf(item("x")))
        q = q.addToQueue(listOf(item("y"), item("z")))
        assertEquals(listOf("a", "x", "b", "c", "y", "z"), ids(q))
        assertEquals("x", q.next?.id)
        // with nothing queued at all
        val solo = PlayQueue().playNext(listOf(item("solo")))
        assertEquals("solo", solo.next?.id)
        assertEquals(q, q.playNext(emptyList()))
    }

    @Test
    fun `an item starting moves the queue onto it only when it is queued ahead`() {
        var q = PlayQueue().addToQueue(listOf(item("a"), item("b", "tv")))
        q = q.onItemStarted("movie", "other")
        assertEquals(-1, q.pos)
        q = q.onItemStarted("tv", "b")
        assertEquals("b", q.current?.id)
        // an episode id is not a film id
        assertEquals(-1, PlayQueue().addToQueue(listOf(item("z", "tv"))).onItemStarted("movie", "z").pos)
        // "episode" and "tv" are the same kind
        assertEquals(0, PlayQueue().addToQueue(listOf(item("e", "tv"))).onItemStarted("episode", "e").pos)
        // already current: unchanged
        assertEquals(q, q.onItemStarted("tv", "b"))
        // a blank id changes nothing
        assertEquals(q, q.onItemStarted("movie", null))
    }

    @Test
    fun `the transport asks the queue for next and previous`() {
        val q = PlayQueue.fromPlaylist(listOf(item("a"), item("b"), item("c"))).advance().advance()
        assertEquals("c", q.nextAfter("movie", "b")?.id)
        assertEquals("a", q.previousBefore("movie", "b")?.id)
        // something unrelated is playing mid-queue: the server's up next applies
        assertNull(q.nextAfter("movie", "zzz"))
        assertNull(q.previousBefore("movie", "zzz"))
        // lined up with Play next while a film plays: that film rolls into the queue
        val lined = PlayQueue().addToQueue(listOf(item("next1")))
        assertEquals("next1", lined.nextAfter("movie", "whatever")?.id)
        assertNull(PlayQueue().nextAfter("movie", "a"))
        assertNull(q.advance().nextAfter("movie", "c"))
    }

    @Test
    fun `transport buttons prefer the queue and fall back to the server`() {
        val server = com.beeboentertainment.movie.data.UpNextItem(kind = "tv", id = "server-next", title = "S1E3")
        val serverPrev = com.beeboentertainment.movie.data.UpNextItem(kind = "tv", id = "server-prev", title = "S1E1")
        val q = PlayQueue.fromPlaylist(listOf(item("a"), item("b", "tv").copy(stream = "/tvfile?id=b", showKey = "sk"), item("c"))).advance()
        // playing a: the queue says b is next; nothing queued before a, so the server's previous stays
        val (next, prev) = PlaylistLogic.transportFor(q, "movie", "a", server, serverPrev)
        assertEquals("b", next?.id)
        assertEquals("tv", next?.kind)
        assertEquals("/tvfile?id=b", next?.stream)
        assertEquals("sk", next?.showKey)
        assertEquals("server-prev", prev?.id)
        // an unrelated episode mid-queue: the server decides both
        val (n2, p2) = PlaylistLogic.transportFor(q, "tv", "other", server, serverPrev)
        assertEquals("server-next", n2?.id)
        assertEquals("server-prev", p2?.id)
        // no queue, no server answer
        assertEquals(null to null, PlaylistLogic.transportFor(PlayQueue(), "movie", "a", null, null))
    }

    @Test
    fun `removing items keeps the playing one playing`() {
        var q = PlayQueue.fromPlaylist(listOf(item("a"), item("b"), item("c"), item("d"))).jump(2)
        q = q.removeAt(0)
        assertEquals("c", q.current?.id)
        q = q.removeAt(2)
        assertEquals("c", q.current?.id)
        q = q.removeAt(1)
        assertEquals(listOf("b"), ids(q))
        assertNull(q.next)
        assertEquals(q, q.removeAt(9))
    }

    @Test
    fun `the shared holder reports only real moves`() {
        PlayQueueHolder.set(PlayQueue().addToQueue(listOf(item("a"), item("b"))))
        assertFalse(PlayQueueHolder.onItemStarted("movie", "nope"))
        assertTrue(PlayQueueHolder.onItemStarted("movie", "b"))
        assertFalse(PlayQueueHolder.onItemStarted("movie", "b"))
        PlayQueueHolder.update { it.back() }
        assertEquals("a", PlayQueueHolder.current.current?.id)
        PlayQueueHolder.clear()
        assertTrue(PlayQueueHolder.current.isEmpty)
    }

    @Test
    fun `play responses become a queue without unavailable items, resume and shuffle kept`() {
        val body = """
            {"ok":true,"playlist":{"id":"pl_x","name":"Sunday","kind":"manual"},
             "items":[
               {"entryId":"e_1","type":"episode","id":"ep1","kind":"tv","title":"Show — S1E1","showKey":"sk","resumeSeconds":120.5,"stream":"/tvfile?id=ep1&mt=t"},
               {"entryId":"e_2","type":"movie","id":"m1","kind":"movie","title":"Film","available":false},
               {"entryId":"e_3","type":"movie","id":"m2","kind":"movie","title":"Film 2","future":"ignored"}
             ],
             "startIndex":1,"shuffle":true,"seed":4242}
        """.trimIndent()
        val r = ApiClient.JSON.decodeFromString(PlaylistPlayResponse.serializer(), body)
        val q = PlaylistLogic.queueFrom(r, "pl_x")
        assertEquals(listOf("ep1", "m2"), ids(q))
        assertEquals("m2", q.next?.id)
        assertEquals("Sunday", q.playlistName)
        assertTrue(q.shuffle)
        assertEquals(4242L, q.seed)
        assertEquals(120.5, q.items[0].resumeSeconds, 0.0)
        assertEquals("tv", r.items[0].toQueueItem().kind)
        assertEquals("e_1", q.items[0].entryId)
    }

    @Test
    fun `lists and details parse, including smart rules and unknown item types`() {
        val list = ApiClient.JSON.decodeFromString(
            PlaylistsResponse.serializer(),
            """{"ok":true,"playlists":[{"id":"pl_a","name":"90s action","kind":"smart","smart":true,"shared":true,"canEdit":false,"ownerName":"Nick","itemCount":12}],
               "templates":[{"id":"continue-my-shows","name":"Continue my shows"}],"canShare":false}"""
        )
        assertEquals("Nick", list.playlists[0].ownerName)
        assertEquals(12, list.playlists[0].itemCount)
        assertEquals("continue-my-shows", list.templates[0].id)
        val detail = ApiClient.JSON.decodeFromString(
            PlaylistDetailResponse.serializer(),
            """{"ok":true,"playlist":{"id":"pl_a","name":"n","smart":true,"rules":{"match":"all","conditions":[{"field":"decade","op":"is","value":1990}],"sort":{"by":"year","dir":"asc"},"limit":null}},
               "items":[{"entryId":"s_1","type":"movie","id":"m","kind":"movie","title":"Speed","year":1994,"durationSeconds":6960,"quality":"4K","percent":40}],
               "count":1,"skipped":2,"progress":{"entryId":"s_1","index":0,"shuffle":false,"seed":0,"at":1}}"""
        )
        assertEquals(2, detail.skipped)
        assertEquals("1994 · 4K · 116 min · 40% watched", PlaylistLogic.subtitle(detail.items[0]))
        val draft = PlaylistLogic.fromJson(detail.playlist.rules)
        assertEquals(PlaylistLogic.RuleDraft("decade", "is", "1990"), draft.rules[0])
        assertEquals("year", draft.sortBy)
        assertEquals("asc", draft.sortDir)
    }

    private val fields = mapOf(
        "decade" to PlaylistField("Decade", listOf("is", "isNot"), "decade"),
        "genre" to PlaylistField("Genre", listOf("is", "isNot"), "genre"),
        "durationMinutes" to PlaylistField("Length (minutes)", listOf("lte", "gte", "between"), "minutes"),
        "watchState" to PlaylistField("Watched", listOf("is", "isNot"), "enum", listOf("unwatched", "watched", "inProgress")),
        "onDeck" to PlaylistField("Next up", listOf("is"), "bool"),
        "rating" to PlaylistField("Rating", listOf("gte"), "rating")
    )

    @Test
    fun `rule drafts become typed JSON and read back`() {
        val draft = PlaylistLogic.RulesDraft(
            match = "any",
            rules = listOf(
                PlaylistLogic.RuleDraft("decade", "is", "1990"),
                PlaylistLogic.RuleDraft("genre", "is", "Action"),
                PlaylistLogic.RuleDraft("genre", "isNot", "28"),
                PlaylistLogic.RuleDraft("durationMinutes", "between", "20", "30"),
                PlaylistLogic.RuleDraft("onDeck", "is", "true"),
                PlaylistLogic.RuleDraft("rating", "gte", "7.5")
            ),
            sortBy = "random",
            limit = "25"
        )
        val json = PlaylistLogic.toJson(draft, fields)
        assertEquals("any", json["match"]!!.jsonPrimitive.content)
        val c = json["conditions"]!!.jsonArray.map { it.jsonObject }
        assertEquals(JsonPrimitive(1990L), c[0]["value"])
        assertEquals(JsonPrimitive("Action"), c[1]["value"])
        assertEquals(JsonPrimitive(28L), c[2]["value"])
        assertEquals(JsonArray(listOf(JsonPrimitive(20L), JsonPrimitive(30L))), c[3]["value"])
        assertEquals(JsonPrimitive(true), c[4]["value"])
        assertEquals(JsonPrimitive(7.5), c[5]["value"])
        assertEquals(JsonPrimitive(25), json["limit"])
        assertEquals(JsonNull, PlaylistLogic.toJson(draft.copy(limit = "none"), fields)["limit"])
        // round trip
        val back = PlaylistLogic.fromJson(json)
        assertEquals(draft.rules, back.rules)
        assertEquals("random", back.sortBy)
        assertEquals("25", back.limit)
        assertEquals(
            "Decade is 1990 or Genre is Action or Genre is not 28 or Length (minutes) between 20–30 or Next up is true or Rating at least 7.5",
            PlaylistLogic.ruleSummary(json, fields)
        )
    }

    @Test
    fun `nested groups are noticed and new rules start sensibly`() {
        val nested = ApiClient.JSON.parseToJsonElement(
            """{"match":"all","conditions":[{"match":"any","conditions":[]},{"field":"genre","op":"is","value":"Drama"}]}"""
        ).jsonObject
        assertTrue(PlaylistLogic.hasNestedGroups(nested))
        assertEquals(1, PlaylistLogic.fromJson(nested).rules.size)
        assertFalse(PlaylistLogic.hasNestedGroups(null))
        assertEquals(PlaylistLogic.RuleDraft("watchState", "is", "unwatched"), PlaylistLogic.newRule("watchState", fields["watchState"]))
        assertEquals(PlaylistLogic.RuleDraft("onDeck", "is", "true"), PlaylistLogic.newRule("onDeck", fields["onDeck"]))
        assertEquals(listOf("unwatched", "watched", "inProgress"), PlaylistLogic.choicesFor(fields["watchState"]))
        assertEquals("2020", PlaylistLogic.choicesFor(fields["decade"])!!.first())
        assertNull(PlaylistLogic.choicesFor(fields["genre"]))
    }

    @Test
    fun `what a details panel adds`() {
        assertEquals("show", PlaylistLogic.refFor("tv", "sk", showKey = "sk").type)
        assertEquals("episode", PlaylistLogic.refFor("tv", "ep1").type)
        assertEquals("movie", PlaylistLogic.refFor("movie", "m1").type)
        assertEquals("track", PlaylistLogic.refFor("track", "t1").type)
        val season = PlaylistLogic.seasonRef("sk", 2)
        assertEquals("season", season.type)
        assertEquals(2, season.season)
        assertEquals("", PlaylistLogic.countLabel(null))
        assertEquals("1 item", PlaylistLogic.countLabel(1))
        assertEquals("3 items", PlaylistLogic.countLabel(3))
        assertEquals("Give it a name.", PlaylistLogic.errorText("missing_name"))
    }
}
