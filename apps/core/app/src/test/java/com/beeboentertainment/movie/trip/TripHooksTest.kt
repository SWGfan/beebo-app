package com.beeboentertainment.movie.trip

import com.beeboentertainment.movie.campsite.CampsiteGames
import com.beeboentertainment.movie.campsite.games.CampfireStoriesContent
import com.beeboentertainment.movie.campsite.games.StoryMood
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class TripHooksTest {

    private class Recording : TripMomentSink {
        val stories = mutableListOf<StoryResult>()
        override fun story(story: StoryResult) { stories += story }
    }

    // ---- pure capture ------------------------------------------------------------------

    @Test
    fun `a round becomes a story with the starter first and the tellers credited`() {
        val story = StoryCapture.fromRound(
            "id", "Funny", "It began with a hat.",
            listOf("Ana: The hat sneezed.", "Ben: Nobody noticed.", "Ana: Except the dog."),
            listOf("Ana", "Ben"),
        )!!
        assertEquals("Campfire story · Funny", story.title)
        assertEquals("Funny", story.mood)
        assertEquals(listOf("Ana", "Ben"), story.tellers)
        assertEquals("It began with a hat. The hat sneezed. Nobody noticed. Except the dog.", story.text)
    }

    @Test
    fun `a computer player's lines stay in the text but it is not credited`() {
        val story = StoryCapture.fromRound(
            "id", "Cozy", "Start.", listOf("Ana: One.", "Beebo: Two."), humanNames = listOf("Ana"),
        )!!
        assertEquals(listOf("Ana"), story.tellers)
        assertTrue(story.text.contains("Two."))
    }

    @Test
    fun `the longest matching name wins so Sam and Sam 2 are told apart`() {
        val story = StoryCapture.fromRound("id", "Cozy", "Start.", listOf("Sam 2: Hello there."), listOf("Sam", "Sam 2"))!!
        assertEquals(listOf("Sam 2"), story.tellers)
        assertEquals("Start. Hello there.", story.text)
    }

    @Test
    fun `a starter with nobody adding to it is not a story`() {
        assertNull(StoryCapture.fromRound("id", "Cozy", "Start.", emptyList(), listOf("Ana")))
    }

    // ---- through the real games service ------------------------------------------------

    private var seq = 0
    private fun act(g: CampsiteGames, token: String, action: String, text: String? = null, game: String? = null): Int {
        val round = g.handle(token).body["room"]?.jsonObject?.get("round") ?: JsonPrimitive(0)
        return g.handle(token, buildJsonObject {
            put("action", action); put("actionId", "a${seq++}"); put("round", round)
            if (text != null) put("text", text)
            if (game != null) put("game", game)
        }).status
    }

    @Test
    fun `a story the leader finishes is handed to the running trip`() {
        val sink = Recording()
        val g = CampsiteGames(random = Random(5), botClockEnabled = false, trip = sink)
        val ann = g.join("Ann")!!
        val ben = g.join("Ben")!!
        listOf(ann, ben).forEach { assertEquals(200, act(g, it, "enter", game = "campfirestories")) }
        assertEquals(200, act(g, ann, "start", text = "mood=spooky"))
        assertEquals(200, act(g, ann, "text", text = "A door creaked open."))
        assertEquals(200, act(g, ben, "text", text = "Nobody dared to look."))
        assertTrue("nothing is kept until the story ends", sink.stories.isEmpty())

        assertEquals(200, act(g, ann, "finish"))
        val story = sink.stories.single()
        assertEquals("A little spooky", story.mood)
        assertEquals(listOf("Ann", "Ben"), story.tellers)
        assertTrue(story.text.endsWith("A door creaked open. Nobody dared to look."))
        val starter = story.text.removeSuffix(" A door creaked open. Nobody dared to look.")
        assertTrue("opens with one of the spooky starters", starter in CampfireStoriesContent.STARTERS.getValue(StoryMood.SPOOKY))
    }

    @Test
    fun `the story is kept once even if the room is polled afterwards`() {
        val sink = Recording()
        val g = CampsiteGames(random = Random(5), botClockEnabled = false, trip = sink)
        val ann = g.join("Ann")!!
        val ben = g.join("Ben")!!
        listOf(ann, ben).forEach { act(g, it, "enter", game = "campfirestories") }
        act(g, ann, "start", text = "mood=funny")
        act(g, ann, "text", text = "Once.")
        act(g, ann, "finish")
        repeat(5) { g.handle(ann); g.handle(ben) }
        assertEquals(1, sink.stories.size)
    }

    @Test
    fun `a story nobody finished is never handed over`() {
        val sink = Recording()
        val g = CampsiteGames(random = Random(5), botClockEnabled = false, trip = sink)
        val ann = g.join("Ann")!!
        val ben = g.join("Ben")!!
        listOf(ann, ben).forEach { act(g, it, "enter", game = "campfirestories") }
        act(g, ann, "start", text = "mood=cozy")
        act(g, ann, "text", text = "Once.")
        act(g, ben, "leave")
        act(g, ann, "leave")
        assertTrue(sink.stories.isEmpty())
    }

    @Test
    fun `finishing an empty story is refused and nothing is kept`() {
        val sink = Recording()
        val g = CampsiteGames(random = Random(5), botClockEnabled = false, trip = sink)
        val ann = g.join("Ann")!!
        val ben = g.join("Ben")!!
        listOf(ann, ben).forEach { act(g, it, "enter", game = "campfirestories") }
        act(g, ann, "start", text = "mood=cozy")
        assertEquals(409, act(g, ann, "finish"))
        assertTrue(sink.stories.isEmpty())
    }

    @Test
    fun `other games hand nothing to the trip`() {
        val sink = Recording()
        val g = CampsiteGames(random = Random(5), botClockEnabled = false, trip = sink)
        val ann = g.join("Ann")!!
        val ben = g.join("Ben")!!
        listOf(ann, ben).forEach { assertEquals(200, act(g, it, "enter", game = "ttt")) }
        assertEquals(200, act(g, ann, "start"))
        assertNotNull(g.handle(ann).body)
        assertTrue(sink.stories.isEmpty())
    }

    @Test
    fun `the real sink keeps the story on a running trip and does nothing without one`() {
        val disk = MemoryTripPersistence()
        val store = TripStore(disk, clock = { 5_000L }, newId = { "t1" })
        val sink = TripStoreSink(store)
        val story = StoryResult("s", "A cozy campfire story", "Cozy", listOf("Ana"), "Once.")
        sink.story(story)
        assertNull(disk.text)
        store.start("Lake", emptyList(), emptySet(), PackingSnapshot())
        sink.story(story)
        assertEquals(1, store.active()!!.moments.count { it.kind == MomentKind.STORY })
    }
}
