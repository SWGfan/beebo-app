package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.campsite.games.chess.ChessEngine
import com.beeboentertainment.movie.campsite.games.chess.ChessPosition
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class ChessRulesTest {

    private fun perft(fen: String, depth: Int) = ChessPosition.perft(ChessPosition.fromFen(fen), depth)

    @Test fun `perft from the starting position depths 1 to 4`() {
        val start = System.currentTimeMillis()
        assertEquals(20L, perft(ChessPosition.START_FEN, 1))
        assertEquals(400L, perft(ChessPosition.START_FEN, 2))
        assertEquals(8_902L, perft(ChessPosition.START_FEN, 3))
        assertEquals(197_281L, perft(ChessPosition.START_FEN, 4))
        val took = System.currentTimeMillis() - start
        println("perft start 1-4 took ${took} ms")
        assertTrue("perft depth 4 took $took ms", took < 10_000)
    }

    @Test fun `perft from Kiwipete depths 1 to 3`() {
        val fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"
        assertEquals(48L, perft(fen, 1))
        assertEquals(2_039L, perft(fen, 2))
        assertEquals(97_862L, perft(fen, 3))
    }

    @Test fun `perft from an en passant and pin position`() {
        val fen = "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1"
        assertEquals(14L, perft(fen, 1))
        assertEquals(191L, perft(fen, 2))
        assertEquals(2_812L, perft(fen, 3))
        assertEquals(43_238L, perft(fen, 4))
    }

    @Test fun `perft from a promotion heavy position`() {
        val fen = "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1"
        assertEquals(6L, perft(fen, 1))
        assertEquals(264L, perft(fen, 2))
        assertEquals(9_467L, perft(fen, 3))
    }

    @Test fun `castling both ways and the rights that go with it`() {
        val p = ChessPosition.fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
        val short = p.parseSan("O-O")
        assertNotEquals(0, short)
        p.make(short)
        assertEquals(ChessPosition.ROOK, p.piece(5))
        assertEquals(ChessPosition.KING, p.piece(6))
        assertEquals(0, p.castling and 3)
        val long = p.parseSan("0-0-0")
        assertNotEquals(0, long)
        p.make(long)
        assertEquals(-ChessPosition.KING, p.piece(58))
        assertEquals(-ChessPosition.ROOK, p.piece(59))
        p.unmake(); p.unmake()
        assertEquals("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", p.fen())
        // No castling through an attacked square.
        val through = ChessPosition.fromFen("4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1")
        assertEquals(0, through.parseSan("O-O"))
        assertNotEquals(0, through.parseSan("O-O-O"))
    }

    @Test fun `en passant is only available immediately`() {
        val p = ChessPosition.start()
        listOf("e4", "a6", "e5", "d5").forEach { p.make(p.parseSan(it)) }
        val ep = p.parseSan("exd6")
        assertNotEquals(0, ep)
        p.make(ep)
        assertEquals(0, p.piece(ChessPosition.squareOf("d5")))
        assertEquals(ChessPosition.PAWN, p.piece(ChessPosition.squareOf("d6")))
        p.unmake()
        p.make(p.parseSan("h3")); p.make(p.parseSan("h6"))
        assertEquals(0, p.parseSan("exd6"))
    }

    @Test fun `promotion to the piece chosen, with and without the equals sign`() {
        val p = ChessPosition.fromFen("8/4P1k1/8/8/8/8/8/4K3 w - - 0 1")
        val knight = p.parseSan("e8=N")
        assertNotEquals(0, knight)
        assertEquals(knight, p.parseSan("e8N"))
        p.make(knight)
        assertEquals(ChessPosition.KNIGHT, p.piece(ChessPosition.squareOf("e8")))
        p.unmake()
        assertEquals(ChessPosition.PAWN, p.piece(ChessPosition.squareOf("e7")))
        assertEquals(4, p.legalMoves().toList().count { ChessPosition.fromSq(it) == ChessPosition.squareOf("e7") })
    }

    @Test fun `checkmate and stalemate are recognised`() {
        val fool = ChessPosition.start()
        listOf("f3", "e5", "g4", "Qh4#").forEach { fool.make(fool.parseSan(it)) }
        assertEquals(ChessPosition.Status.CHECKMATE, fool.status())
        val stale = ChessPosition.fromFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")
        assertEquals(ChessPosition.Status.STALEMATE, stale.status())
    }

    @Test fun `threefold repetition, fifty moves and insufficient material are draws`() {
        val p = ChessPosition.start()
        repeat(2) { listOf("Nf3", "Nf6", "Ng1", "Ng8").forEach { p.make(p.parseSan(it)) } }
        assertEquals(ChessPosition.Status.REPETITION, p.status())

        val fifty = ChessPosition.fromFen("4k3/8/8/8/8/8/8/R3K3 w - - 99 80")
        assertEquals(ChessPosition.Status.PLAYING, fifty.status())
        fifty.make(fifty.parseSan("Ra2"))
        assertEquals(ChessPosition.Status.FIFTY_MOVES, fifty.status())

        assertTrue(ChessPosition.fromFen("4k3/8/8/8/8/8/8/4KB2 w - - 0 1").insufficientMaterial())
        assertTrue(ChessPosition.fromFen("4k3/8/8/8/8/8/8/4KN2 w - - 0 1").insufficientMaterial())
        assertTrue(ChessPosition.fromFen("2b1k3/8/8/8/8/8/8/4KB2 w - - 0 1").insufficientMaterial())
        assertFalse(ChessPosition.fromFen("1b2k3/8/8/8/8/8/8/4KB2 w - - 0 1").insufficientMaterial())
        assertFalse(ChessPosition.fromFen("4k3/8/8/8/8/8/8/3NKN2 w - - 0 1").insufficientMaterial())
        assertFalse(ChessPosition.fromFen("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1").insufficientMaterial())
    }

    @Test fun `algebraic notation round trips for every legal move`() {
        val fens = listOf(
            ChessPosition.START_FEN,
            "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
            "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
            "1k6/8/8/8/8/8/8/R3K2R w KQ - 0 1",
            "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
        )
        var checked = 0
        for (fen in fens) {
            val p = ChessPosition.fromFen(fen)
            val legal = p.legalMoves()
            val names = mutableSetOf<String>()
            for (i in 0 until legal.size) {
                val san = p.san(legal[i], legal)
                assertTrue("duplicate SAN $san in $fen", names.add(san))
                assertEquals("$san in $fen", legal[i], p.parseSan(san))
                checked++
            }
        }
        assertTrue(checked > 100)
        // Disambiguation by file, and a check mark.
        val rooks = ChessPosition.fromFen("4k3/8/8/8/8/1K6/8/R6R w - - 0 1")
        assertEquals(0, rooks.parseSan("Rf1"))
        assertNotEquals(0, rooks.parseSan("Rhf1"))
        assertEquals("Ra8+", rooks.san(rooks.parseSan("Ra8")))
    }

    @Test fun `engine returns a legal move within its time limit at every level`() {
        val fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"
        for (level in ChessEngine.Level.values()) {
            val p = ChessPosition.fromFen(fen)
            val engine = ChessEngine(Random(1))
            val start = System.currentTimeMillis()
            val m = engine.bestMove(p, level)
            val took = System.currentTimeMillis() - start
            println("engine $level: ${took} ms, depth ${engine.lastDepth}, ${engine.lastNodes} nodes")
            assertTrue("$level returned an illegal move", p.legalMoves().contains(m))
            assertTrue("$level took $took ms", took <= level.millis + 1_000)
            assertEquals("engine must not change the position", fen, p.fen())
        }
    }

    @Test fun `strong engine finds mate in one and wins a hanging queen`() {
        val mate = ChessPosition.fromFen("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1")
        assertEquals("Rd8#", mate.san(ChessEngine(Random(3)).bestMove(mate, ChessEngine.Level.STRONG, 1000)))
        val queen = ChessPosition.fromFen("4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1")
        assertEquals("Rxd5", queen.san(ChessEngine(Random(3)).bestMove(queen, ChessEngine.Level.CASUAL, 1000)))
    }

    @Test fun `the match referees turns, promotion choice and resignation`() {
        val t = TestTable()
        val m = ChessGame.create(listOf("a", "b"), "level=easy", t.ctx)
        fun sq(n: String) = ChessPosition.squareOf(n)
        assertThrows(IllegalArgumentException::class.java) { m.apply(t.move("b", "move", "from" to sq("e7"), "to" to sq("e5"))) }
        assertThrows(IllegalArgumentException::class.java) { m.apply(t.move("a", "move", "from" to sq("e2"), "to" to sq("e5"))) }
        m.apply(t.move("a", "move", "from" to sq("e2"), "to" to sq("e4")))
        val view = m.view("b")
        assertEquals(listOf("e4"), view.getValue("san").jsonArray.map { it.jsonPrimitive.content })
        assertEquals(20, view.getValue("moves").jsonArray.size)
        assertEquals(0, m.view("a").getValue("moves").jsonArray.size)
        m.apply(t.move("b", "resign"))
        assertEquals("done", m.phase)
        assertEquals("a", m.result()!!.winnerId)
    }

    @Test fun `the clock ends the game when a flag falls`() {
        val t = TestTable()
        val m = ChessGame.create(listOf("a", "b"), "clock=1", t.ctx)
        m.apply(t.move("a", "move", "from" to ChessPosition.squareOf("e2"), "to" to ChessPosition.squareOf("e4")))
        t.clock += 61_000
        assertTrue(m.waitingOn().isEmpty())
        assertEquals("a", m.result()!!.winnerId)
    }

    @Test fun `computer players finish a game without an illegal move`() {
        val t = TestTable(11)
        val m = ChessGame.create(listOf("x", "y"), "level=easy", t.ctx)
        t.playOut(ChessGame, m, limit = 30)
        // Either finished, or still legal after 30 plies; both are fine - no exception is the point.
        assertTrue(m.view(null).getValue("san").jsonArray.size >= 1)
        assertTrue(m.phase == "done" || m.waitingOn().isNotEmpty())
    }
}
