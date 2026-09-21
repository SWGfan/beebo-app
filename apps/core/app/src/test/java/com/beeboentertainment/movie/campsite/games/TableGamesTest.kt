package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.campsite.CampsiteGames
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class TableGamesTest {

    // ---- Dots and Boxes ------------------------------------------------------

    @Test fun `dots closing a box scores it and gives another turn`() {
        val t = TestTable()
        val m = DotsAndBoxesGame.create(listOf("a", "b"), "size=3", t.ctx)
        // Box 0 on a 3x3 grid: top 0, bottom 3, left 12, right 13.
        m.apply(t.move("a", "move", "line" to 0))
        m.apply(t.move("b", "move", "line" to 3))
        m.apply(t.move("a", "move", "line" to 12))
        m.apply(t.move("b", "move", "line" to 13))
        assertEquals(1, m.scoreOf("b"))
        assertEquals(0, m.scoreOf("a"))
        assertEquals(listOf("b"), m.waitingOn())
        assertThrows(IllegalArgumentException::class.java) { m.apply(t.move("a", "move", "line" to 1)) }
        assertThrows(IllegalArgumentException::class.java) { m.apply(t.move("b", "move", "line" to 0)) }
        // A line that closes nothing passes the turn on.
        m.apply(t.move("b", "move", "line" to 8))
        assertEquals(listOf("a"), m.waitingOn())
    }

    @Test fun `dots one line can close two boxes at once`() {
        val t = TestTable()
        val m = DotsAndBoxesGame.create(listOf("a", "b"), "size=3", t.ctx)
        // Boxes 0 and 1 share line 13. Box 0: 0, 3, 12. Box 1: 1, 4, 14.
        listOf(0, 3, 12, 1, 4, 14).forEachIndexed { i, line ->
            m.apply(t.move(if (i % 2 == 0) "a" else "b", "move", "line" to line))
        }
        m.apply(t.move("a", "move", "line" to 13))
        assertEquals(2, m.scoreOf("a"))
        assertEquals(listOf("a"), m.waitingOn())
    }

    @Test fun `dots bots finish every size at every level with every box owned`() {
        for (size in 3..6) for (level in BotLevel.values()) for (players in listOf(2, 4)) {
            val t = TestTable(size * 10 + players)
            val seats = (1..players).map { "p$it" }
            val m = DotsAndBoxesGame.create(seats, "size=$size;level=${level.wire}", t.ctx)
            t.playOut(DotsAndBoxesGame, m)
            assertEquals("done", m.phase)
            assertEquals(size * size, seats.sumOf { m.scoreOf(it) })
            val result = m.result()!!
            assertTrue(result.outcome == Outcome.WINNER || result.outcome == Outcome.DRAW)
        }
    }

    @Test fun `hard dots player double-deals the last two boxes of a chain`() {
        // One row of five boxes. Box 0 has three sides, box 1 two, and boxes 2-4 form a
        // chain that someone will have to open once box 0 and 1 are gone.
        val board = DotsBoard(1, 5)
        val lines = BooleanArray(board.lineCount)
        listOf(0, 5, 10, 1, 6, 2, 3, 8, 4, 9).forEach { lines[it] = true }
        assertEquals(11, board.choose(lines, BotLevel.MEDIUM, Random(1)))
        assertEquals(12, board.choose(lines, BotLevel.HARD, Random(1)))
    }

    @Test fun `medium dots player never hands over a third side while a safe line exists`() {
        val board = DotsBoard(3, 3)
        val random = Random(5)
        repeat(50) {
            val lines = BooleanArray(board.lineCount)
            // Scatter a few lines, then ask for a move while safe ones remain.
            board.open(lines).shuffled(random).take(6).forEach { if (board.isSafe(lines, it)) lines[it] = true }
            val safe = board.open(lines).filter { board.isSafe(lines, it) }
            if (safe.isEmpty()) return@repeat
            val capturing = board.open(lines).any { board.completes(lines, it) > 0 }
            val chosen = board.choose(lines, BotLevel.MEDIUM, random)
            if (!capturing) assertTrue(board.isSafe(lines, chosen))
        }
    }

    // ---- Mancala ------------------------------------------------------------

    @Test fun `mancala last stone in the store is another turn`() {
        val s = MancalaRules.sow(MancalaRules.start(), 0, 2)
        assertTrue(s.again)
        assertEquals(listOf(3, 4, 5, 6), s.path)
        assertEquals(1, s.board[MancalaRules.STORE_A])
        val t = TestTable()
        val m = MancalaGame.create(listOf("a", "b"), "", t.ctx)
        m.apply(t.move("a", "move", "pit" to 2))
        assertEquals(listOf("a"), m.waitingOn())
        m.apply(t.move("a", "move", "pit" to 0))
        assertEquals(listOf("b"), m.waitingOn())
    }

    @Test fun `mancala capture takes the stone and everything opposite`() {
        val b = IntArray(14)
        b[0] = 3; b[4] = 1; b[7] = 5; b[8] = 2
        val s = MancalaRules.sow(b, 0, 4)
        assertEquals(6, s.captured)
        assertEquals(6, s.board[MancalaRules.STORE_A])
        assertEquals(0, s.board[5])
        assertEquals(0, s.board[7])
        assertFalse(s.again)
        // Nothing opposite: the stone simply stays.
        val c = IntArray(14)
        c[0] = 3; c[4] = 1; c[8] = 2
        val quiet = MancalaRules.sow(c, 0, 4)
        assertEquals(0, quiet.captured)
        assertEquals(1, quiet.board[5])
        // Seat two captures on their own side.
        val d = IntArray(14)
        d[1] = 4; d[8] = 1; d[3] = 4; d[11] = 1
        val theirs = MancalaRules.sow(d, 1, 8)
        assertEquals(5, theirs.captured)
        assertEquals(5, theirs.board[MancalaRules.STORE_B])
    }

    @Test fun `mancala sowing skips the opponent store`() {
        val b = MancalaRules.start()
        b[5] = 9
        val s = MancalaRules.sow(b, 0, 5)
        assertFalse(MancalaRules.STORE_B in s.path)
        assertEquals(9, s.path.size)
        assertEquals(1, s.path.last())
    }

    @Test fun `mancala end of game sweeps the other side into its store`() {
        val b = IntArray(14)
        b[5] = 1; b[8] = 3; b[10] = 2; b[MancalaRules.STORE_A] = 20; b[MancalaRules.STORE_B] = 22
        val s = MancalaRules.sow(b, 0, 5)
        assertTrue(s.over)
        assertTrue(s.swept)
        assertFalse(s.again)
        assertEquals(21, s.board[MancalaRules.STORE_A])
        assertEquals(27, s.board[MancalaRules.STORE_B])
        assertTrue((0..12).filter { it != 6 }.all { s.board[it] == 0 })
    }

    @Test fun `mancala bots finish at every level and the stones add up`() {
        for (level in BotLevel.values()) {
            val t = TestTable(level.ordinal + 3)
            val m = MancalaGame.create(listOf("a", "b"), "level=${level.wire}", t.ctx)
            val start = System.currentTimeMillis()
            t.playOut(MancalaGame, m)
            println("mancala $level game took ${System.currentTimeMillis() - start} ms")
            assertEquals("done", m.phase)
            assertEquals(48, m.scoreOf("a") + m.scoreOf("b"))
        }
    }

    @Test fun `hard mancala beats easy mancala more often than not`() {
        var hardWins = 0
        var easyWins = 0
        repeat(6) { game ->
            val t = TestTable(100 + game)
            // Seat order alternates so first-move advantage cancels out.
            val hardFirst = game % 2 == 0
            val seats = if (hardFirst) listOf("hard", "easy") else listOf("easy", "hard")
            val m = MancalaGame.create(seats, "", t.ctx) as MancalaGame.Match
            var steps = 0
            while (m.phase != "done" && steps++ < 500) {
                val who = m.waitingOn().first()
                val seat = m.players.indexOf(who)
                val board = m.boardCopy()
                val pit = if (who == "hard") MancalaRules.bestPit(board, seat, MancalaRules.depthFor(BotLevel.HARD), t.random)
                else MancalaRules.legal(board, seat).random(t.random)
                m.apply(t.move(who, "move", "pit" to if (seat == 0) pit else pit - 7))
            }
            when (m.result()!!.winnerId) { "hard" -> hardWins++; "easy" -> easyWins++ }
        }
        assertTrue("hard $hardWins, easy $easyWins", hardWins > easyWins)
    }

    // ---- Five Dice ----------------------------------------------------------

    private fun empty() = IntArray(FiveDiceRules.CATEGORIES) { -1 }

    @Test fun `five dice scores every category`() {
        val d = intArrayOf(3, 3, 3, 5, 5)
        assertEquals(0, FiveDiceRules.raw(0, d))
        assertEquals(0, FiveDiceRules.raw(1, d))
        assertEquals(9, FiveDiceRules.raw(2, d))
        assertEquals(0, FiveDiceRules.raw(3, d))
        assertEquals(10, FiveDiceRules.raw(4, d))
        assertEquals(0, FiveDiceRules.raw(5, intArrayOf(1, 2, 3, 4, 5)))
        assertEquals(12, FiveDiceRules.raw(5, intArrayOf(6, 6, 1, 2, 3)))
        assertEquals(4, FiveDiceRules.raw(0, intArrayOf(1, 1, 1, 1, 6)))
        assertEquals(19, FiveDiceRules.raw(FiveDiceRules.THREE_KIND, d))
        assertEquals(0, FiveDiceRules.raw(FiveDiceRules.THREE_KIND, intArrayOf(1, 1, 2, 2, 3)))
        assertEquals(22, FiveDiceRules.raw(FiveDiceRules.FOUR_KIND, intArrayOf(4, 4, 4, 4, 6)))
        assertEquals(0, FiveDiceRules.raw(FiveDiceRules.FOUR_KIND, d))
        assertEquals(25, FiveDiceRules.raw(FiveDiceRules.FULL_HOUSE, d))
        assertEquals(0, FiveDiceRules.raw(FiveDiceRules.FULL_HOUSE, intArrayOf(3, 3, 3, 3, 5)))
        assertEquals(30, FiveDiceRules.raw(FiveDiceRules.SMALL_STRAIGHT, intArrayOf(1, 2, 3, 4, 6)))
        assertEquals(30, FiveDiceRules.raw(FiveDiceRules.SMALL_STRAIGHT, intArrayOf(3, 4, 5, 6, 6)))
        assertEquals(30, FiveDiceRules.raw(FiveDiceRules.SMALL_STRAIGHT, intArrayOf(2, 3, 4, 5, 6)))
        assertEquals(0, FiveDiceRules.raw(FiveDiceRules.SMALL_STRAIGHT, intArrayOf(1, 2, 3, 5, 6)))
        assertEquals(40, FiveDiceRules.raw(FiveDiceRules.LARGE_STRAIGHT, intArrayOf(5, 4, 3, 2, 1)))
        assertEquals(0, FiveDiceRules.raw(FiveDiceRules.LARGE_STRAIGHT, intArrayOf(1, 2, 3, 4, 6)))
        assertEquals(50, FiveDiceRules.raw(FiveDiceRules.FIVE_KIND, intArrayOf(2, 2, 2, 2, 2)))
        assertEquals(0, FiveDiceRules.raw(FiveDiceRules.FIVE_KIND, intArrayOf(2, 2, 2, 2, 1)))
        assertEquals(22, FiveDiceRules.raw(FiveDiceRules.CHANCE, intArrayOf(6, 5, 4, 4, 3)))
    }

    @Test fun `five dice upper bonus at 63`() {
        val sheet = empty()
        for (i in 0..5) sheet[i] = 3 * (i + 1)
        assertEquals(63, FiveDiceRules.upperTotal(sheet))
        assertEquals(35, FiveDiceRules.upperBonus(sheet))
        assertEquals(98, FiveDiceRules.total(sheet, 0))
        sheet[0] = 2
        assertEquals(0, FiveDiceRules.upperBonus(sheet))
        assertEquals(62, FiveDiceRules.total(sheet, 0))
    }

    @Test fun `five dice extra five of a kind bonus and joker rule`() {
        val fives = intArrayOf(4, 4, 4, 4, 4)
        val sheet = empty()
        // First five of a kind: no bonus, any box.
        assertEquals(0, FiveDiceRules.bonusFor(sheet, fives))
        assertEquals(13, FiveDiceRules.allowed(sheet, fives).size)
        sheet[FiveDiceRules.FIVE_KIND] = 50
        // Another: 100 bonus, and it must go in Fours while Fours is open.
        assertEquals(100, FiveDiceRules.bonusFor(sheet, fives))
        assertEquals(listOf(3), FiveDiceRules.allowed(sheet, fives))
        sheet[3] = 12
        // Fours taken: anywhere, with straights and full house at full value.
        assertEquals(25, FiveDiceRules.score(sheet, fives, FiveDiceRules.FULL_HOUSE))
        assertEquals(30, FiveDiceRules.score(sheet, fives, FiveDiceRules.SMALL_STRAIGHT))
        assertEquals(40, FiveDiceRules.score(sheet, fives, FiveDiceRules.LARGE_STRAIGHT))
        assertEquals(20, FiveDiceRules.score(sheet, fives, FiveDiceRules.CHANCE))
        assertEquals(0, FiveDiceRules.score(sheet, fives, 0))
        assertEquals(50 + 12 + 100, FiveDiceRules.total(sheet, 1))
        // A zero in the Five-of-a-kind box still means joker, but never a bonus.
        val zeroed = empty()
        zeroed[FiveDiceRules.FIVE_KIND] = 0
        assertEquals(0, FiveDiceRules.bonusFor(zeroed, fives))
        assertEquals(listOf(3), FiveDiceRules.allowed(zeroed, fives))
    }

    @Test fun `five dice turn is three rolls with holds then one box`() {
        val t = TestTable()
        val m = FiveDiceGame.create(listOf("a", "b"), "", t.ctx)
        assertThrows(IllegalArgumentException::class.java) { m.apply(t.move("a", "score", "category" to 12)) }
        assertThrows(IllegalArgumentException::class.java) { m.apply(t.move("a", "hold", "die" to 0)) }
        m.apply(t.move("a", "roll"))
        val first = m.view("a").getValue("dice").jsonArray.map { it.jsonPrimitive.int }
        m.apply(t.move("a", "hold", "die" to 0))
        m.apply(t.move("a", "hold", "die" to 1))
        m.apply(t.move("a", "roll"))
        val second = m.view("a").getValue("dice").jsonArray.map { it.jsonPrimitive.int }
        assertEquals(first.take(2), second.take(2))
        m.apply(t.move("a", "roll", "held" to "11111"))
        assertEquals(second, m.view("a").getValue("dice").jsonArray.map { it.jsonPrimitive.int })
        assertThrows(IllegalArgumentException::class.java) { m.apply(t.move("a", "roll")) }
        m.apply(t.move("a", "score", "category" to FiveDiceRules.CHANCE))
        assertEquals(second.sum(), m.scoreOf("a"))
        assertEquals(listOf("b"), m.waitingOn())
        assertThrows(IllegalArgumentException::class.java) { m.apply(t.move("a", "roll")) }
    }

    @Test fun `five dice expected value holds are sensible`() {
        val sheet = empty()
        assertEquals(-1, FiveDiceRules.chooseHold(sheet, intArrayOf(1, 2, 3, 4, 5), 2))
        assertEquals(15, FiveDiceRules.chooseHold(sheet, intArrayOf(6, 6, 6, 6, 2), 2))
        assertEquals(FiveDiceRules.FIVE_KIND, FiveDiceRules.bestCategory(sheet, intArrayOf(2, 2, 2, 2, 2)))
    }

    @Test fun `five dice bots finish, and the expected value player outscores the casual one`() {
        fun average(level: BotLevel): Double {
            var total = 0
            val games = 12
            repeat(games) { g ->
                val t = TestTable(500 + g)
                val m = FiveDiceGame.create(listOf("solo"), "level=${level.wire}", t.ctx)
                t.playOut(FiveDiceGame, m)
                assertEquals("done", m.phase)
                total += m.scoreOf("solo")
            }
            return total.toDouble() / games
        }
        val start = System.currentTimeMillis()
        val easy = average(BotLevel.EASY)
        val hard = average(BotLevel.HARD)
        println("five dice averages: easy $easy, hard $hard in ${System.currentTimeMillis() - start} ms")
        assertTrue("easy $easy hard $hard", hard > easy)
    }

    @Test fun `pass and play on one phone with no server routes each move to the player on turn`() {
        val local = com.beeboentertainment.movie.campsite.CampsiteLocalGames(botClock = false)
        assertTrue(local.open("mancala", withComputer = true))
        var seq = 0
        fun post(action: String, vararg fields: Pair<String, JsonElement>): JsonObject {
            val snap = Json.parseToJsonElement(Json.parseToJsonElement(local.get()).jsonObject.getValue("body").jsonPrimitive.content).jsonObject
            val round = snap["room"]?.jsonObject?.get("round") ?: JsonPrimitive(0)
            val reply = Json.parseToJsonElement(local.post(buildJsonObject {
                put("action", action); put("actionId", "p${seq++}"); put("round", round); fields.forEach { (k, v) -> put(k, v) }
            }.toString())).jsonObject
            assertEquals(reply.toString(), 200, reply.getValue("status").jsonPrimitive.int)
            return Json.parseToJsonElement(reply.getValue("body").jsonPrimitive.content).jsonObject
        }
        post("addlocal")
        val room = post("start", "text" to JsonPrimitive("level=easy")).getValue("room").jsonObject
        assertEquals(0, room.getValue("bots").jsonPrimitive.int)
        assertEquals(2, room.getValue("seats").jsonArray.size)
        // Seat one sows pit 0 (no extra turn), then the phone speaks for seat two.
        val after = post("move", "pit" to JsonPrimitive(0))
        val second = post("move", "pit" to JsonPrimitive(0))
        assertNotEquals(after.getValue("you"), second.getValue("you"))
        assertTrue(second.getValue("local").jsonPrimitive.boolean)
        local.close()
    }

    // ---- through the real service, the way a phone reaches them -------------

    @Test fun `table games start from the room with options and record a finished match`() {
        val g = CampsiteGames(botClockEnabled = false)
        val a = g.join("A")!!
        val b = g.join("B")!!
        var seq = 0
        fun send(token: String, action: String, vararg fields: Pair<String, JsonElement>): Int {
            val room = g.handle(token).body["room"] as? JsonObject
            return g.handle(token, buildJsonObject {
                put("action", action); put("actionId", "x${seq++}"); put("round", room?.get("round") ?: JsonPrimitive(0))
                fields.forEach { (k, v) -> put(k, v) }
            }).status
        }
        for (id in listOf("dotsboxes", "mancala", "fivedice", "chess")) {
            assertEquals(200, send(a, "enter", "game" to JsonPrimitive(id)))
            assertEquals(200, send(b, "enter", "game" to JsonPrimitive(id)))
            assertEquals(200, send(a, "start", "text" to JsonPrimitive("level=hard;size=5;clock=5")))
            val room = g.handle(b).body.getValue("room").jsonObject
            assertEquals("playing", room.getValue("phase").jsonPrimitive.content)
            assertEquals("hard", room.getValue("level").jsonPrimitive.content)
            assertEquals(200, send(a, "leave"))
            assertEquals(200, send(b, "leave"))
        }
        assertTrue(CampsiteGameCatalog.ALL.filter { it.category == GameCategory.BOARD }.map { it.id }
            .containsAll(listOf("dotsboxes", "mancala", "fivedice", "chess")))
        assertTrue(listOf("dotsboxes", "mancala", "fivedice", "chess").all { CampsiteGameCatalog[it]!!.tournamentReady && !CampsiteGameCatalog[it]!!.needsGuests })
    }
}
