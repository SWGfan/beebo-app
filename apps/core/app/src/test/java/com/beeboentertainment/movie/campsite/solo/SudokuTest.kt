package com.beeboentertainment.movie.campsite.solo

import com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog
import com.beeboentertainment.movie.campsite.games.GameCategory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class SudokuTest {

    private fun parse(s: String) = s.filter { it.isDigit() || it == '.' }.map { if (it == '.') 0 else it - '0' }.toIntArray()

    // A well-known puzzle with a single solution.
    private val classic = parse(
        "53..7...." + "6..195..." + ".98....6." + "8...6...3" + "4..8.3..1" + "7...2...6" + ".6....28." + "...419..5" + "....8..79"
    )

    @Test fun `solver finds the unique solution and the checker accepts it`() {
        assertEquals(1, Sudoku.countSolutions(classic))
        val solved = Sudoku.solve(classic)
        assertNotNull(solved)
        assertTrue(Sudoku.isSolved(solved!!))
        for (i in 0 until 81) if (classic[i] != 0) assertEquals(classic[i], solved[i])
    }

    @Test fun `validity checker catches clashes and the solver counts several solutions`() {
        val clash = classic.copyOf().also { it[2] = 5 } // second 5 in row 1
        assertFalse(Sudoku.isValidPuzzle(clash))
        assertEquals(setOf(0, 2), Sudoku.conflicts(clash).filter { it < 9 }.toSet())
        assertEquals(0, Sudoku.countSolutions(clash))
        assertEquals(2, Sudoku.countSolutions(IntArray(81), limit = 2))
        assertFalse(Sudoku.isSolved(classic))
    }

    @Test fun `generated puzzles have exactly one solution and match their level`() {
        val random = Random(20260916)
        for (level in SudokuLevel.values()) {
            repeat(2) {
                val g = Sudoku.generate(level, random)
                assertEquals("$level must be unique", 1, Sudoku.countSolutions(g.puzzle, limit = 2))
                assertTrue(Sudoku.isSolved(g.solution))
                assertTrue(g.solution.contentEquals(Sudoku.solve(g.puzzle)))
                assertEquals(level, g.level)
                assertEquals(level, Sudoku.rate(g.puzzle))
                val givens = g.puzzle.count { it != 0 }
                when (level) {
                    SudokuLevel.EASY -> assertTrue("easy givens $givens", givens in 36..40)
                    SudokuLevel.MEDIUM -> assertTrue("medium givens $givens", givens in 28..35)
                    else -> assertTrue("$level givens $givens", givens in 17..35)
                }
                when (level) {
                    SudokuLevel.EASY, SudokuLevel.MEDIUM -> assertEquals(0, Sudoku.techniqueTier(g.puzzle))
                    SudokuLevel.HARD -> assertEquals(1, Sudoku.techniqueTier(g.puzzle))
                    SudokuLevel.EXPERT -> assertEquals(2, Sudoku.techniqueTier(g.puzzle))
                }
            }
        }
    }

    @Test fun `hint single is a correct move`() {
        val single = Sudoku.findSingle(classic.copyOf())!!
        assertEquals(Sudoku.solve(classic)!![single.first], single.second)
    }

    @Test fun `sudoku is a solo puzzle`() {
        val g = CampsiteGameCatalog.solo("sudoku")!!
        assertFalse(g.needsGuests)
        assertEquals(GameCategory.PUZZLE, g.category)
    }
}
