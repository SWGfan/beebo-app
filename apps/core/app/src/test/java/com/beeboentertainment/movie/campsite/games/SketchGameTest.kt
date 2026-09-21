package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class SketchGameTest {

    private fun start(n: Int = 4, ctx: TestCtx = TestCtx(), setup: String = "") =
        SketchGame.create(seats(n), setup, ctx) as SketchGame.Match

    private fun SketchGame.Match.stage() = view(null).str("stage")

    @Test fun `guesses match forgiving case, spaces, punctuation and plurals`() {
        assertTrue(SketchGame.matches("Fire Truck", "fire truck"))
        assertTrue(SketchGame.matches("firetruck", "fire truck"))
        assertTrue(SketchGame.matches("  fire-truck! ", "fire truck"))
        assertTrue(SketchGame.matches("cats", "cat"))
        assertTrue(SketchGame.matches("pancake", "pancakes"))
        assertTrue(SketchGame.matches("butterflies", "butterfly"))
        assertTrue(SketchGame.matches("a kite", "kite"))
        assertFalse(SketchGame.matches("dog", "cat"))
        assertFalse(SketchGame.matches("", "cat"))
        assertFalse(SketchGame.matches("catapult", "cat"))
    }

    @Test fun `close guesses and guesses that give the answer away are recognised`() {
        assertTrue(SketchGame.isClose("giraff", "giraffe"))
        assertFalse(SketchGame.isClose("zebra", "giraffe"))
        assertTrue(SketchGame.revealsAnswer("is it a big volcano", "volcano"))
        assertFalse(SketchGame.revealsAnswer("mountain", "volcano"))
    }

    @Test fun `the word is only on the drawer's phone and the mask keeps spaces`() {
        val m = start()
        m.players.forEach { id ->
            val v = m.view(id)
            if (id == m.drawer) assertEquals(m.word, v.str("word")) else assertEquals("", v.str("word"))
        }
        assertEquals("", m.view(null).str("word"))
        assertEquals("_ _ _ _   _ _ _ _ _", SketchGame.mask("fire truck", false))
        assertEquals("F _ _ _   _ _ _ _ _", SketchGame.mask("fire truck", true))
    }

    @Test fun `strokes stream in batches, only from the drawer, and undo and clear move the revision`() {
        val m = start()
        val guesser = m.players.first { it != m.drawer }
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(guesser, "stroke", "s" to 1, "c" to 0, "w" to 1, "p" to "1,2")) }
        m.apply(mv(m.drawer, "stroke", "s" to 1, "c" to 2, "w" to 1, "p" to "10,10,20,20"))
        m.apply(mv(m.drawer, "stroke", "s" to 1, "c" to 2, "w" to 1, "p" to "30,30"))
        m.apply(mv(m.drawer, "stroke", "s" to 2, "c" to 5, "w" to 3, "p" to "500,500"))
        val strokes = m.view(guesser).getValue("strokes").jsonArray
        assertEquals(2, strokes.size)
        assertEquals("10,10,20,20,30,30", strokes[0].jsonArray[3].jsonPrimitive.content)
        // Late or malformed batches are refused rather than scrambling the picture.
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(m.drawer, "stroke", "s" to 1, "c" to 0, "w" to 0, "p" to "1,1")) }
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(m.drawer, "stroke", "s" to 3, "c" to 0, "w" to 0, "p" to "1,1,2")) }
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(m.drawer, "stroke", "s" to 3, "c" to 0, "w" to 0, "p" to "1,5000")) }
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(m.drawer, "stroke", "s" to 3, "c" to 99, "w" to 0, "p" to "1,1")) }
        val rev = m.sketchRev
        m.apply(mv(m.drawer, "undo"))
        assertEquals(1, m.strokes.size)
        assertEquals(rev + 1, m.sketchRev)
        m.apply(mv(m.drawer, "clear"))
        assertTrue(m.strokes.isEmpty())
    }

    @Test fun `the picture has a hard size cap`() {
        val m = start()
        val batch = (0 until SketchGame.MAX_BATCH).joinToString(",") { "1,1" }
        var seq = 1
        repeat(SketchGame.MAX_POINTS / SketchGame.MAX_BATCH) { m.apply(mv(m.drawer, "stroke", "s" to seq++, "c" to 0, "w" to 0, "p" to batch)) }
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(m.drawer, "stroke", "s" to seq, "c" to 0, "w" to 0, "p" to "1,1")) }
        val tooBig = (0..SketchGame.MAX_BATCH).joinToString(",") { "1,1" }
        m.apply(mv(m.drawer, "clear"))
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(m.drawer, "stroke", "s" to 999, "c" to 0, "w" to 0, "p" to tooBig)) }
    }

    @Test fun `faster guesses score more, the drawer scores per guesser, and everyone guessing ends the turn`() {
        val ctx = TestCtx()
        val m = start(4, ctx, "seconds=100")
        val guessers = m.players.filter { it != m.drawer }
        val drawer = m.drawer
        m.apply(mv(guessers[0], "guess", "text" to m.word.uppercase()))
        ctx.clock += 80_000
        m.apply(mv(guessers[1], "guess", "text" to m.word))
        assertTrue(m.scoreOf(guessers[0]) > m.scoreOf(guessers[1]))
        assertEquals(40, m.scoreOf(drawer))
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(guessers[0], "guess", "text" to "again")) }
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(drawer, "guess", "text" to m.word)) }
        assertEquals("drawing", m.stage())
        m.apply(mv(guessers[2], "guess", "text" to m.word))
        assertEquals("reveal", m.stage())
        assertTrue(m.view(guessers[0]).str("word").isNotEmpty())
    }

    @Test fun `a guess containing the answer is hidden from everyone but its author`() {
        val m = start()
        val (a, b) = m.players.filter { it != m.drawer }
        m.apply(mv(a, "guess", "text" to "maybe a " + m.word + " thing"))
        assertEquals(1, m.view(a).getValue("guesses").jsonArray.size)
        assertEquals(0, m.view(b).getValue("guesses").jsonArray.size)
        assertEquals(0, m.view(null).getValue("guesses").jsonArray.size)
        // A right guess is announced to everyone but not spelled out.
        m.apply(mv(b, "guess", "text" to m.word))
        val seenByA = m.view(a).getValue("guesses").jsonArray.map { it.jsonObject }.single { it.bool("right") }
        assertEquals("", seenByA.str("text"))
    }

    @Test fun `turns rotate through every seat for each round and the game settles on points`() {
        val ctx = TestCtx()
        val m = start(3, ctx, "rounds=2")
        val drawers = mutableListOf<String>()
        while (m.phase != "done") {
            drawers.add(m.drawer)
            ctx.clock += 80_000; assertTrue(m.tick())
            assertEquals("reveal", m.stage())
            ctx.clock += SketchGame.REVEAL_MS; m.tick()
        }
        assertEquals(m.players + m.players, drawers)
        assertEquals(Outcome.SCORES, m.result()!!.outcome)
    }

    @Test fun `the drawer can swap the word once before drawing, or pass`() {
        val m = start(3)
        val first = m.drawer
        m.apply(mv(first, "skipword"))
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(first, "skipword")) }
        m.apply(mv(first, "pass"))
        assertNotEquals(first, m.drawer)
        assertEquals("drawing", m.stage())
    }

    @Test fun `the drawer leaving ends their turn, a returning player guesses again, too few ends the game`() {
        val m = start(4)
        val drawer = m.drawer
        m.playerLeft(drawer)
        assertEquals("reveal", m.stage())
        m.playerReturned(drawer)
        m.apply(mv("p0", "next"))
        assertEquals("drawing", m.stage())
        val others = m.players.filter { it != m.drawer }
        others.forEach { m.playerLeft(it) }
        assertEquals(Outcome.VOID, m.result()!!.outcome)
    }

    @Test fun `bots pass the pencil and only guess`() {
        val ctx = TestCtx()
        val m = start(3, ctx)
        val random = Random(1)
        val first = m.drawer
        val move = SketchGame.botMove(m, first, random)!!
        assertEquals("pass", move.action)
        m.apply(move)
        repeat(30) { m.players.forEach { id -> SketchGame.botMove(m, id, random)?.takeIf { it.action == "guess" }?.let { m.apply(it) } } }
        assertEquals("playing", m.phase)
    }

    @Test fun `word lists are 100 each, unique across lists, short and plain`() {
        listOf(SketchWords.EASY, SketchWords.MEDIUM, SketchWords.HARD).forEach { assertEquals(100, it.size) }
        val all = SketchWords.EASY + SketchWords.MEDIUM + SketchWords.HARD
        assertEquals(300, all.map { PartyText.compact(it) }.toSet().size)
        all.forEach { w ->
            assertTrue(w, w.length in 2..30)
            assertEquals(w, w.lowercase())
            assertTrue(w, w.all { it.isLetter() || it == ' ' || it == '-' })
        }
    }
}
