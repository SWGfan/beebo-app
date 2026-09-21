package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.campsite.CampsiteGames
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class ClassicBingoTest {

    /** A known card: column c, row r holds c*15 + r + 1 (centre free). */
    private val card: List<Int> = (0 until 25).map { i -> if (i == 12) 0 else (i % 5) * 15 + i / 5 + 1 }
    private fun numbers(vararg cells: Int) = cells.map { card[it] }.filter { it != 0 }.toSet()

    @Test fun `cards use the right column ranges unique numbers and a free centre`() {
        repeat(200) { seed ->
            val c = ClassicBingoRules.card(Random(seed))
            assertEquals(25, c.size)
            assertEquals(0, c[BingoGrid.FREE])
            assertEquals(24, c.filter { it != 0 }.toSet().size)
            c.forEachIndexed { i, n ->
                if (i != BingoGrid.FREE) assertEquals("cell $i = $n", i % 5, ClassicBingoRules.column(n))
            }
        }
        assertEquals("B 7", ClassicBingoRules.label(7))
        assertEquals("N 45", ClassicBingoRules.label(45))
        assertEquals("O 61", ClassicBingoRules.label(61))
    }

    @Test fun `caller never repeats and covers all 75`() {
        val caller = BingoCaller(Random(11))
        val seen = mutableListOf<Int>()
        while (true) seen.add(caller.next() ?: break)
        assertEquals(75, seen.size)
        assertEquals((1..75).toSet(), seen.toSet())
        assertNull(caller.next())
        assertEquals(0, caller.remaining)
    }

    @Test fun `each pattern is detected and not falsely`() {
        val row = numbers(10, 11, 13, 14) // middle row using the free centre
        assertTrue(ClassicBingoRules.wins(card, row, BingoPattern.LINE))
        assertTrue(ClassicBingoRules.wins(card, numbers(0, 5, 10, 15, 20), BingoPattern.LINE))
        assertFalse(ClassicBingoRules.wins(card, numbers(0, 5, 10, 15), BingoPattern.LINE))

        assertTrue(ClassicBingoRules.wins(card, numbers(0, 4, 20, 24), BingoPattern.FOUR_CORNERS))
        assertFalse(ClassicBingoRules.wins(card, numbers(0, 4, 20), BingoPattern.FOUR_CORNERS))
        assertFalse(ClassicBingoRules.wins(card, row, BingoPattern.FOUR_CORNERS))

        val x = numbers(0, 6, 18, 24, 4, 8, 16, 20)
        assertTrue(ClassicBingoRules.wins(card, x, BingoPattern.X))
        assertFalse(ClassicBingoRules.wins(card, numbers(0, 6, 18, 24), BingoPattern.X)) // one diagonal only

        assertTrue(ClassicBingoRules.wins(card, numbers(18, 19, 23, 24), BingoPattern.POSTAGE_STAMP))
        assertTrue(ClassicBingoRules.wins(card, numbers(0, 1, 5, 6), BingoPattern.POSTAGE_STAMP))
        assertFalse(ClassicBingoRules.wins(card, numbers(6, 7, 11, 13), BingoPattern.POSTAGE_STAMP)) // not a corner
        assertFalse(ClassicBingoRules.wins(card, numbers(0, 4, 20, 24), BingoPattern.POSTAGE_STAMP))

        val all = card.filter { it != 0 }.toSet()
        assertTrue(ClassicBingoRules.wins(card, all, BingoPattern.BLACKOUT))
        assertFalse(ClassicBingoRules.wins(card, all - card[3], BingoPattern.BLACKOUT))
    }

    /** An engine whose first player holds [card], by drawing until the balls cover the cells we want. */
    private fun engineWithCalls(pattern: BingoPattern, penalty: Int = 3, players: List<String> = listOf("me", "bot")): ClassicBingoEngine =
        ClassicBingoEngine(players, Random(5), 1, pattern, penalty)

    private fun callUntil(e: ClassicBingoEngine, done: () -> Boolean) {
        while (!done()) assertNotNull(e.callNext())
    }

    @Test fun `verification uses only called numbers never marks`() {
        val e = engineWithCalls(BingoPattern.LINE)
        // Daub a whole top row before a single ball: marks are allowed, and they count for nothing.
        (0 until 5).forEach { e.mark("me", 0, it) }
        assertEquals((0 until 5).toSet() + 12, e.marksOf("me", 0))
        assertFalse(e.hasValidCard("me"))
        assertEquals(ClassicBingoEngine.Claim.Penalty(3), e.claim("me"))
        // And a line of called numbers wins with no marks at all.
        val fresh = engineWithCalls(BingoPattern.LINE, penalty = 0)
        callUntil(fresh) { fresh.hasValidCard("me") }
        assertEquals(setOf(12), fresh.marksOf("me", 0))
        assertEquals(ClassicBingoEngine.Claim.Win, fresh.claim("me"))
    }

    @Test fun `false call penalty blocks the next calls then lifts`() {
        val e = engineWithCalls(BingoPattern.BLACKOUT, penalty = 3)
        e.callNext()
        assertEquals(ClassicBingoEngine.Claim.Penalty(3), e.claim("me"))
        assertEquals(3, e.penaltyLeft("me"))
        assertEquals(ClassicBingoEngine.Claim.Blocked(3), e.claim("me"))
        e.callNext(); e.callNext()
        assertEquals(ClassicBingoEngine.Claim.Blocked(1), e.claim("me"))
        e.callNext()
        assertEquals(0, e.penaltyLeft("me"))
        assertTrue(e.claim("me") is ClassicBingoEngine.Claim.Penalty) // allowed to try again, still wrong

        val lenient = engineWithCalls(BingoPattern.BLACKOUT, penalty = 0)
        lenient.callNext()
        lenient.claim("me")
        assertEquals(0, lenient.penaltyLeft("me"))
    }

    @Test fun `computer players daub and claim exactly when they have the pattern`() {
        val e = ClassicBingoEngine(listOf("me", "c1", "c2"), Random(8), 2, BingoPattern.LINE)
        val bots = listOf("c1", "c2")
        var claimed = emptyList<String>()
        while (claimed.isEmpty()) {
            assertNotNull(e.callNext())
            val shouldWin = bots.filter { e.hasValidCard(it) }
            claimed = e.botTurn(bots)
            assertEquals(shouldWin, claimed)
        }
        claimed.forEach { b ->
            val daubed = e.cards.getValue(b).indices.map { e.marksOf(b, it) }
            e.cards.getValue(b).forEachIndexed { i, c ->
                c.forEachIndexed { cell, n -> if (n in e.calledSet) assertTrue(cell in daubed[i]) }
            }
        }
        assertEquals(claimed, e.winners)
    }

    @Test fun `two valid calls on the same ball both win and the next draw ends the game`() {
        // Same seed and both players: find a ball where two players are valid together.
        var found = false
        for (seed in 0 until 400) {
            val e = ClassicBingoEngine(listOf("a", "b", "c", "d", "e", "f"), Random(seed), 4, BingoPattern.LINE, 3)
            while (!e.over && e.winners.isEmpty()) {
                e.callNext() ?: break
                val valid = e.players.filter { e.hasValidCard(it) }
                if (valid.isNotEmpty()) {
                    valid.forEach { assertEquals(ClassicBingoEngine.Claim.Win, e.claim(it)) }
                    if (valid.size >= 2) {
                        assertEquals(valid, e.winners)
                        assertNull(e.callNext())
                        assertTrue(e.over)
                        assertEquals(ClassicBingoEngine.Claim.Closed, e.claim(e.players.first { it !in valid }))
                        found = true
                    }
                    break
                }
            }
            if (found) break
        }
        assertTrue("no same-ball tie found in 400 seeded games", found)
    }

    @Test fun `a late valid call after the next ball is closed`() {
        val e = ClassicBingoEngine(listOf("a", "b"), Random(2), 1, BingoPattern.FOUR_CORNERS, 0)
        callUntil(e) { e.hasValidCard("a") || e.hasValidCard("b") }
        val first = if (e.hasValidCard("a")) "a" else "b"
        assertEquals(ClassicBingoEngine.Claim.Win, e.claim(first))
        assertNull(e.callNext())
        assertEquals(ClassicBingoEngine.Claim.Closed, e.claim(if (first == "a") "b" else "a"))
    }

    @Test fun `settings and metadata`() {
        val s = ClassicBingoEngine.settings("cards=3;pattern=stamp;penalty=0;caller=call")
        assertEquals(ClassicBingoEngine.Companion.Settings(3, BingoPattern.POSTAGE_STAMP, 0, false), s)
        assertEquals(ClassicBingoEngine.Companion.Settings(1, BingoPattern.LINE, 3, true), ClassicBingoEngine.settings(""))
        assertThrows(IllegalArgumentException::class.java) { ClassicBingoEngine(listOf("a"), Random(1), 5) }
        assertFalse(ClassicBingoGame.needsGuests)
        assertEquals(GameCategory.PARTY, ClassicBingoGame.category)
        assertSame(ClassicBingoGame, CampsiteGameCatalog["classicbingo"])
    }

    @Test fun `guest room keeps cards private and checks bingo on the host`() {
        val g = CampsiteGames(random = Random(4))
        val a = g.join("Ann")!!; val b = g.join("Ben")!!
        var seq = 0
        fun act(t: String, action: String, status: Int = 200, extra: JsonObjectBuilder.() -> Unit = {}) {
            val round = g.handle(t).body["room"]?.jsonObject?.get("round") ?: JsonPrimitive(0)
            val r = g.handle(t, buildJsonObject { put("action", action); put("actionId", "c${seq++}"); put("round", round); extra() })
            assertEquals(r.body.toString(), status, r.status)
        }
        fun room(t: String) = g.handle(t).body.getValue("room").jsonObject
        act(a, "enter") { put("game", "classicbingo") }; act(b, "enter") { put("game", "classicbingo") }
        act(a, "start") { put("text", "cards=2;pattern=line;penalty=3;caller=call") }
        assertFalse(room(a).containsKey("cards")) // the caller only calls
        assertEquals(2, room(b)["cards"]!!.jsonArray.size)
        act(b, "call", status = 409)
        act(a, "call")
        act(b, "mark") { put("card", 0); put("cell", 0) }
        act(b, "bingo") // false call: accepted as a penalty, not an error
        assertEquals(3, room(b)["penaltyLeft"]!!.jsonPrimitive.int)
        act(b, "bingo", status = 409)
        repeat(74) { if (room(a)["phase"]!!.jsonPrimitive.content == "playing" && room(a)["winners"]!!.jsonArray.isEmpty()) {
            act(a, "call")
            if (room(b)["penaltyLeft"]!!.jsonPrimitive.int == 0) {
                val before = room(b)["winners"]!!.jsonArray.size
                act(b, "bingo")
                if (room(b)["winners"]!!.jsonArray.size == before) Unit
            }
        } }
        assertEquals(1, room(a)["winners"]!!.jsonArray.size)
        act(a, "call") // closes the claim window
        assertEquals("done", room(a)["phase"]!!.jsonPrimitive.content)
    }
}
