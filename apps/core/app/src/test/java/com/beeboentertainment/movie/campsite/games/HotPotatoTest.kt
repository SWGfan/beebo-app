package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.campsite.CampsiteGames
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class HotPotatoTest {

    /** A random source that always answers with the lowest or highest value it may. */
    private class Edge(private val high: Boolean) : Random() {
        override fun nextBits(bitCount: Int): Int = if (high) -1 ushr (32 - bitCount) else 0
        override fun nextLong(from: Long, until: Long): Long = if (high) until - 1 else from
    }

    @Test fun `fuse is always within the chosen bounds including both ends`() {
        assertEquals(20_000L, HotPotatoEngine.drawFuseMs(Edge(false), 20, 60))
        assertEquals(60_000L, HotPotatoEngine.drawFuseMs(Edge(true), 20, 60))
        val r = Random(99)
        repeat(5_000) {
            val ms = HotPotatoEngine.drawFuseMs(r, 20, 60)
            assertTrue(ms in 20_000L..60_000L)
        }
        HotPotatoEngine.PRESETS.forEach { (_, min, max) ->
            val e = HotPotatoEngine(listOf("a", "b"), Random(3), min, max)
            assertTrue(e.fuseMs in min * 1_000L..max * 1_000L)
        }
    }

    @Test fun `same seed gives the same categories and fuses`() {
        val a = HotPotatoEngine(listOf("a", "b"), Random(7))
        val b = HotPotatoEngine(listOf("a", "b"), Random(7))
        repeat(5) {
            assertEquals(a.category, b.category); assertEquals(a.fuseMs, b.fuseMs)
            a.burn(); b.burn(); a.startRound(); b.startRound()
        }
    }

    @Test fun `letters spell POTATO and the game ends on the last letter`() {
        val e = HotPotatoEngine(listOf("ann", "ben", "cat"), Random(1))
        assertEquals("ann", e.holder)
        e.pass()
        assertEquals("ben", e.holder)
        val expected = listOf("P", "PO", "POT", "POTA", "POTAT", "POTATO")
        expected.forEachIndexed { i, spelled ->
            assertFalse(e.over)
            assertEquals("ben", e.holder) // the burned player starts the next round
            assertEquals("ben", e.burn())
            assertEquals(spelled, e.spelled("ben"))
            if (i < expected.lastIndex) e.startRound()
        }
        assertTrue(e.over)
        assertEquals("ben", e.loser)
        assertEquals(mapOf("ann" to 6, "ben" to 0, "cat" to 6), e.scores())
        assertThrows(IllegalStateException::class.java) { e.pass() }
        assertThrows(IllegalStateException::class.java) { e.startRound() }
    }

    @Test fun `passing wraps round the circle`() {
        val e = HotPotatoEngine(listOf("a", "b", "c"), Random(1))
        repeat(4) { e.pass() }
        assertEquals("b", e.holder)
        assertEquals(4, e.passes)
    }

    @Test fun `categories do not repeat until the deck runs out`() {
        val e = HotPotatoEngine(listOf("a", "b"), Random(5), word = "X".repeat(500))
        val seen = mutableListOf(e.category)
        repeat(HotPotatoContent.CATEGORIES.size - 1) { e.burn(); e.startRound(); seen.add(e.category) }
        assertEquals(HotPotatoContent.CATEGORIES.toSet(), seen.toSet())
    }

    @Test fun `category list is big unique and tidy`() {
        val list = HotPotatoContent.CATEGORIES
        assertTrue("have ${list.size}", list.size >= 200)
        assertEquals(list.size, list.map { it.lowercase() }.toSet().size)
        assertTrue(list.all { it.isNotBlank() && it == it.trim() && it.length <= 60 })
    }

    @Test fun `presets parse from setup and metadata hides it on TV`() {
        assertEquals(10 to 25, HotPotatoEngine.preset("timer=short"))
        assertEquals(20 to 60, HotPotatoEngine.preset(""))
        assertFalse(HotPotatoGame.needsGuests)
        assertTrue(HotPotatoGame.passThePhone)
        assertFalse(HotPotatoGame.showOnTv)
        assertEquals(GameCategory.PARTY, HotPotatoGame.category)
        assertEquals("hotpotato", HotPotatoGame.localRoute)
    }

    @Test fun `in a guest room the fuse runs on the host clock and only the holder can pass`() {
        var clock = 0L
        val g = CampsiteGames(now = { clock }, random = Random(2))
        val a = g.join("Ann")!!; val b = g.join("Ben")!!
        var seq = 0
        fun act(t: String, action: String, status: Int = 200, extra: JsonObjectBuilder.() -> Unit = {}) {
            val round = g.handle(t).body["room"]?.jsonObject?.get("round") ?: JsonPrimitive(0)
            val r = g.handle(t, buildJsonObject { put("action", action); put("actionId", "h${seq++}"); put("round", round); extra() })
            assertEquals(r.body.toString(), status, r.status)
        }
        fun room(t: String) = g.handle(t).body.getValue("room").jsonObject
        act(a, "enter") { put("game", "hotpotato") }; act(b, "enter") { put("game", "hotpotato") }
        act(a, "start") { put("text", "timer=short") }
        assertEquals(true, room(a)["myTurn"]!!.jsonPrimitive.boolean)
        act(b, "pass", status = 409)
        act(a, "pass")
        assertEquals(true, room(b)["myTurn"]!!.jsonPrimitive.boolean)
        clock += 26_000 // past the longest short fuse
        act(a, "tick")
        val bang = room(a)
        assertEquals("bang", bang["stage"]!!.jsonPrimitive.content)
        assertEquals("P", bang["letters"]!!.jsonObject.values.map { it.jsonPrimitive.content }.single { it.isNotEmpty() })
        act(b, "next", status = 409)
        act(a, "next")
        assertEquals("live", room(a)["stage"]!!.jsonPrimitive.content)
    }
}
