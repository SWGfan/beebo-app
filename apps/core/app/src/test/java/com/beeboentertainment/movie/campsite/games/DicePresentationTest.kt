package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class DicePresentationTest {
    private val t = TestTable()
    // Always rolling one verifies that an animation event does not rely on the face changing.
    private fun context() = SimpleMatchContext(object : Random() {
        override fun nextBits(bitCount: Int) = 0
    }, { 1_000L }, { it.uppercase() }, { "a" }, {}, { emptyList() })
    private fun faces(m: GameMatch) = m.view("a")["rollFaces"]!!.jsonArray.map { it.jsonPrimitive.int }
    private fun serial(m: GameMatch) = m.view("a")["rollId"]!!.jsonPrimitive.int

    @Test fun `ludo preserves the real roll after a no-move turn and distinguishes equal rolls`() {
        val m = LudoGame.create(listOf("a", "b"), "", context())
        assertTrue(faces(m).isEmpty())
        m.apply(t.move("a", "roll", "die" to 6))
        assertEquals(listOf(1), faces(m))
        assertEquals(1, serial(m))
        assertEquals("a", m.view("b")["rollBy"]!!.jsonPrimitive.content)
        assertTrue(m.view("b")["pendingRoll"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("b"), m.waitingOn())
        assertThrows(IllegalArgumentException::class.java) { m.apply(t.move("a", "roll")) }
        assertEquals(1, serial(m))
        m.apply(t.move("b", "roll"))
        assertEquals(listOf(1), faces(m))
        assertEquals(2, serial(m))
        assertEquals("b", m.view("a")["rollBy"]!!.jsonPrimitive.content)
    }

    @Test fun `snakes publishes one event for every accepted roll including repeated faces`() {
        val m = SnakesAndLaddersGame.create(listOf("a", "b"), "", context())
        m.apply(t.move("a", "roll"))
        assertEquals(1, serial(m))
        assertEquals(listOf(1), faces(m))
        m.apply(t.move("b", "roll"))
        assertEquals(2, serial(m))
        assertEquals(listOf(1), faces(m))
        assertEquals(m.view("a")["rollFaces"], m.view(null)["rollFaces"])
    }

    @Test fun `five dice preserves held dice and only an accepted roll makes an animation event`() {
        val m = FiveDiceGame.create(listOf("a", "b"), "", context())
        m.apply(t.move("a", "roll"))
        assertEquals(List(5) { 1 }, faces(m))
        val initial = m.view("a")["rollKept"]
        m.apply(t.move("a", "hold", "die" to 2))
        assertEquals(1, serial(m))
        assertEquals(initial, m.view("a")["rollKept"])
        m.apply(t.move("a", "roll"))
        assertEquals(2, serial(m))
        assertEquals(List(5) { 1 }, faces(m))
        assertEquals(listOf(false, false, true, false, false),
            m.view("a")["rollKept"]!!.jsonArray.map { it.jsonPrimitive.boolean })
        m.apply(t.move("a", "score", "category" to 0))
        assertEquals(2, serial(m))
        assertEquals(List(5) { 1 }, faces(m))
        assertEquals(List(5) { 0 }, m.view("a")["dice"]!!.jsonArray.map { it.jsonPrimitive.int })
        assertEquals("a", m.view("b")["rollBy"]!!.jsonPrimitive.content)
    }
}
