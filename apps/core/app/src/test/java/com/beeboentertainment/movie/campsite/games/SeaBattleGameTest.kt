package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SeaBattleGameTest {
    private val t = TestTable(53)
    private fun match() = SeaBattleGame.create(listOf("a", "b"), "", t.ctx)
    private fun ships(m: GameMatch, who: String = "a") = m.view(who)["myShips"]!!.jsonArray
    private fun cells(m: GameMatch, ship: Int, who: String = "a") =
        ships(m, who)[ship].jsonObject["cells"]!!.jsonArray.map { it.jsonPrimitive.int }
    private fun place(m: GameMatch, who: String, ship: Int, cell: Int, vertical: Int = 0) =
        m.apply(t.move(who, "place", "ship" to ship, "cell" to cell, "vertical" to vertical))
    private fun rejects(action: () -> Unit) = assertThrows(IllegalArgumentException::class.java, action)
    private fun fleet(m: GameMatch, who: String) {
        (0..4).forEach { place(m, who, it, it * 8) }
    }

    @Test fun `captains start with five empty hulls and must place them before ready`() {
        val m = match()
        assertEquals(listOf(4, 3, 3, 2, 2), ships(m).map { it.jsonObject["size"]!!.jsonPrimitive.int })
        assertTrue((0..4).all { cells(m, it).isEmpty() })
        rejects { m.apply(t.move("a", "ready")) }
        place(m, "a", 0, 4)
        assertEquals(listOf(4, 5, 6, 7), cells(m, 0))
        place(m, "a", 1, 47, 1)
        assertEquals(listOf(47, 55, 63), cells(m, 1))
        rejects { m.apply(t.move("a", "ready")) }
    }

    @Test fun `invalid placement is atomic and moving across own previous position is legal`() {
        val m = match()
        place(m, "a", 0, 0)
        place(m, "a", 0, 1)
        assertEquals(listOf(1, 2, 3, 4), cells(m, 0))
        place(m, "a", 1, 16)
        val before = ships(m)
        for ((ship, cell, vertical) in listOf(Triple(0, 16, 0), Triple(0, 6, 0),
            Triple(0, 48, 1), Triple(0, -1, 0), Triple(0, 64, 0), Triple(-1, 0, 0),
            Triple(5, 0, 0), Triple(0, 0, 2))) {
            rejects { place(m, "a", ship, cell, vertical) }
            assertEquals(before, ships(m))
        }
        rejects { place(m, "spectator", 0, 0) }
        rejects { m.apply(t.move("a", "place", "ship" to 0, "cell" to 0)) }
        assertEquals(before, ships(m))
    }

    @Test fun `rotation must fit and cannot overlap another ship`() {
        val m = match()
        place(m, "a", 0, 0)
        place(m, "a", 1, 16)
        rejects { place(m, "a", 0, 0, 1) }
        assertEquals(listOf(0, 1, 2, 3), cells(m, 0))
        place(m, "a", 0, 4, 1)
        assertEquals(listOf(4, 12, 20, 28), cells(m, 0))
    }

    @Test fun `return clear and shuffle preserve a legal fleet and readiness locks it`() {
        val m = match()
        fleet(m, "a")
        m.apply(t.move("a", "remove", "ship" to 2))
        assertTrue(cells(m, 2).isEmpty())
        assertEquals(4, cells(m, 0).size)
        rejects { m.apply(t.move("a", "remove", "ship" to 9)) }
        m.apply(t.move("a", "clear"))
        assertTrue((0..4).all { cells(m, it).isEmpty() })
        repeat(30) {
            m.apply(t.move("a", "shuffle"))
            val all = (0..4).flatMap { cells(m, it) }
            assertEquals(14, all.size)
            assertEquals(14, all.toSet().size)
            assertTrue(all.all { it in 0..63 })
        }
        m.apply(t.move("a", "ready"))
        val locked = ships(m)
        for (action in listOf("shuffle", "clear", "remove", "place")) {
            rejects { m.apply(t.move("a", action, "ship" to 0, "cell" to 0, "vertical" to 0)) }
            assertEquals(locked, ships(m))
        }
        fleet(m, "b")
        m.apply(t.move("b", "ready"))
        assertEquals("firing", m.view("a")["stage"]!!.jsonPrimitive.content)
        rejects { place(m, "b", 0, 40) }
        assertEquals(locked, ships(m))
    }

    @Test fun `only owner receives intact ships and enemy hull appears only after sinking`() {
        val m = match()
        fleet(m, "a")
        fleet(m, "b")
        for (who in listOf(null, "spectator")) {
            for (key in listOf("mySea", "myShots", "myShips", "mySunkShips"))
                assertTrue(m.view(who)[key]!!.jsonArray.isEmpty())
        }
        for (who in listOf("a", "b")) {
            assertTrue(m.view(who)["mySunkShips"]!!.jsonArray.isEmpty())
            m.apply(t.move(who, "ready"))
        }
        for (cell in 0..3) {
            m.apply(t.move("a", "fire", "cell" to cell))
            assertEquals(listOf("b"), m.waitingOn())
            val revealed = m.view("a")["mySunkShips"]!!.jsonArray
            if (cell < 3) assertTrue(revealed.isEmpty())
            else {
                assertEquals(1, revealed.size)
                assertEquals(listOf(0, 1, 2, 3), revealed[0].jsonObject["cells"]!!.jsonArray.map { it.jsonPrimitive.int })
            }
            m.apply(t.move("b", "fire", "cell" to 56 + cell))
        }
        assertEquals(4, m.scoreOf("a"))
        rejects { m.apply(t.move("a", "fire", "cell" to 0)) }
        assertTrue(m.view("b")["mySunkShips"]!!.jsonArray.isEmpty())
        assertTrue(m.view("spectator")["myShips"]!!.jsonArray.isEmpty())
        assertTrue(m.view("spectator")["mySunkShips"]!!.jsonArray.isEmpty())
    }

    @Test fun `bots deploy and finish complete games without illegal moves`() {
        repeat(12) { seed ->
            val table = TestTable(seed)
            val m = SeaBattleGame.create(listOf("a", "b"), "", table.ctx)
            table.playOut(SeaBattleGame, m, 150)
            assertEquals("done", m.phase)
            assertEquals(14, maxOf(m.scoreOf("a"), m.scoreOf("b")))
            for (key in listOf("mySea", "myShots", "myShips", "mySunkShips"))
                assertTrue(m.view(null)[key]!!.jsonArray.isEmpty())
        }
    }
}
