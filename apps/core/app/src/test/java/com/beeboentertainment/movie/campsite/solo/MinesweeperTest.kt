package com.beeboentertainment.movie.campsite.solo

import com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog
import com.beeboentertainment.movie.campsite.games.GameCategory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class MinesweeperTest {

    /** A board with mines exactly where [layout] has '*'. */
    private fun board(vararg layout: String): MineBoard {
        val rows = layout.size; val cols = layout[0].length
        val count = layout.sumOf { r -> r.count { it == '*' } }
        return MineBoard(rows, cols, count, mines = layout.joinToString("").map { it == '*' }, placed = true)
    }

    @Test fun `first dig is never a mine and opens an area on every level`() {
        for (level in MineLevel.values()) {
            repeat(200) { seed ->
                val random = Random(seed)
                val b = MineBoard.of(level)
                val first = random.nextInt(b.size)
                val after = b.dig(first, random)
                assertFalse(after.lost)
                assertEquals(level.mines, after.mines.count { it })
                assertFalse(after.mines[first])
                assertTrue(after.neighbours(first).none { after.mines[it] })
                assertEquals(0, after.adjacentMines(first))
                assertTrue("opening", after.revealed.count { it } > 1)
            }
        }
    }

    @Test fun `flood fill opens zeros and stops at numbers`() {
        val b = board(
            ".....",
            ".....",
            "....*",
        )
        val after = b.dig(0, Random(1))
        // Everything but the mine and ... all reachable squares open: the two next to the mine are numbers.
        assertFalse(after.revealed[14])
        assertTrue(after.revealed[3]); assertTrue(after.revealed[8]); assertTrue(after.revealed[13])
        assertEquals(1, after.adjacentMines(8))
        assertTrue(after.won)
    }

    @Test fun `flood fill does not open flagged squares`() {
        val b = board("*....", ".....", ".....").toggleFlag(4)
        val after = b.dig(14, Random(1))
        assertFalse(after.revealed[4])
        assertTrue(after.revealed[3])
        assertFalse(after.won)
    }

    @Test fun `chording digs neighbours when the flags match and loses on a wrong flag`() {
        val base = board(
            "*..",
            "...",
            "...",
        )
        // Reveal the 1 at (1,1) and flag the real mine: chord opens everything else.
        val ready = base.copy(revealed = base.revealed.toMutableList().also { it[4] = true }).toggleFlag(0)
        val chorded = ready.chord(4, Random(1))
        assertFalse(chorded.lost)
        assertTrue(chorded.won)
        // Not enough flags: nothing happens.
        val none = base.copy(revealed = base.revealed.toMutableList().also { it[4] = true })
        assertEquals(none, none.chord(4, Random(1)))
        // A wrong flag: chord digs the real mine.
        val wrong = none.toggleFlag(1)
        val boom = wrong.chord(4, Random(1))
        assertTrue(boom.lost)
        assertEquals(0, boom.exploded)
    }

    @Test fun `flags cannot go on revealed squares and stats keep best time`() {
        val b = board("*..", "...", "...").dig(8, Random(1))
        assertEquals(b, b.toggleFlag(8))
        var s = MineStats()
        s = s.record(MineLevel.BEGINNER, true, 50_000)
        s = s.record(MineLevel.BEGINNER, false, 10_000)
        s = s.record(MineLevel.BEGINNER, true, 40_000)
        assertEquals(3, s.of(MineLevel.BEGINNER).played)
        assertEquals(40_000, s.of(MineLevel.BEGINNER).bestMs)
    }

    @Test fun `minesweeper is a solo puzzle`() {
        val g = CampsiteGameCatalog.solo("minesweeper")!!
        assertFalse(g.needsGuests)
        assertEquals(GameCategory.PUZZLE, g.category)
    }
}
