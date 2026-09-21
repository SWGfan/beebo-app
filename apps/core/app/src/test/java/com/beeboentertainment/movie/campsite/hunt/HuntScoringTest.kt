package com.beeboentertainment.movie.campsite.hunt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure scoring: points, bingo lines, ranking, ties, winners. No session and no clock. */
class HuntScoringTest {

    private fun item(id: String, band: HuntBand) = HuntItem(id, "Find $id", band)

    private val list = listOf(
        item("a", HuntBand.LITTLE), item("b", HuntBand.LITTLE), item("c", HuntBand.MIDDLE), item("d", HuntBand.OLDER),
    )

    @Test fun aListItemIsWorthItsBandPoints() {
        assertEquals(1, HuntBand.LITTLE.rank + 1)
        val s = HuntScoring.score(HuntLayout.LIST, 0, list, setOf("a", "c", "d"))
        assertEquals(1 + 2 + 3, s.points)
        assertEquals(3, s.found)
        assertEquals(0, s.lines)
        assertEquals(7, HuntScoring.maxPoints(HuntLayout.LIST, 0, list))
        assertEquals(0, HuntScoring.score(HuntLayout.LIST, 0, list, emptySet()).points)
    }

    @Test fun anIdThatIsNotOnTheListScoresNothing() {
        assertEquals(0, HuntScoring.score(HuntLayout.LIST, 0, list, setOf("zzz")).points)
    }

    @Test fun everyBingoSquareIsOnePointAndLinesAddBonus() {
        val grid = (0 until 9).map { item("s$it", HuntBand.OLDER) }
        val order = grid.map { it.id }
        // Nothing, then one square: 1 point.
        assertEquals(0, HuntScoring.score(HuntLayout.BINGO, 3, grid, emptySet()).points)
        assertEquals(1, HuntScoring.score(HuntLayout.BINGO, 3, grid, setOf("s4")).points)
        // Top row: 3 squares + one line (2) = 5.
        val top = HuntScoring.score(HuntLayout.BINGO, 3, grid, setOf("s0", "s1", "s2"))
        assertEquals(5, top.points); assertEquals(1, top.lines)
        // A column and the same top row cross at s0: 5 squares + 2 lines.
        val cross = HuntScoring.score(HuntLayout.BINGO, 3, grid, setOf("s0", "s1", "s2", "s3", "s6"))
        assertEquals(5 + 2 * 2, cross.points); assertEquals(2, cross.lines)
        // The whole card: 9 + 8 lines * 2.
        val all = HuntScoring.score(HuntLayout.BINGO, 3, grid, order.toSet())
        assertEquals(8, all.lines); assertEquals(9 + 16, all.points)
        assertEquals(all.points, HuntScoring.maxPoints(HuntLayout.BINGO, 3, grid))
    }

    @Test fun aGridOfNHasTwoNPlusTwoLinesAndEachLineHasNCells() {
        listOf(3, 4, 5).forEach { n ->
            val lines = HuntScoring.lineCells(n)
            assertEquals(2 * n + 2, lines.size)
            assertTrue(lines.all { it.size == n && it.toSet().size == n && it.all { c -> c in 0 until n * n } })
            assertEquals(lines.size, lines.map { it.toSet() }.toSet().size)
        }
        assertEquals(emptyList<List<Int>>(), HuntScoring.lineCells(1))
    }

    @Test fun theTwoDiagonalsAreLines() {
        val order = (0 until 16).map { "s$it" }
        assertEquals(1, HuntScoring.completedLines(4, order, setOf("s0", "s5", "s10", "s15")))
        assertEquals(1, HuntScoring.completedLines(4, order, setOf("s3", "s6", "s9", "s12")))
        assertEquals(0, HuntScoring.completedLines(4, order, setOf("s0", "s5", "s10")))
        assertEquals(0, HuntScoring.completedLines(4, order.take(10), order.take(10).toSet()))
    }

    @Test fun theGridSizeFollowsTheItemsAvailable() {
        assertEquals(0, HuntScoring.gridFor(8))
        assertEquals(3, HuntScoring.gridFor(9))
        assertEquals(3, HuntScoring.gridFor(15))
        assertEquals(4, HuntScoring.gridFor(16))
        assertEquals(4, HuntScoring.gridFor(24))
        assertEquals(5, HuntScoring.gridFor(25))
        assertEquals(5, HuntScoring.gridFor(99))
    }

    // ---- ranking ---------------------------------------------------------------------------

    private fun row(name: String, points: Int, lastAt: Long) =
        HuntRow("p:$name", name, -1, 1, points, points, 0, 0, false, lastAt, 0)

    @Test fun moreTeamPointsRankHigher() {
        val ranked = HuntScoring.ranked(listOf(row("Ann", 3, 100), row("Ben", 9, 500), row("Cy", 5, 50)))
        assertEquals(listOf("Ben", "Cy", "Ann"), ranked.map { it.name })
        assertEquals(listOf(1, 2, 3), ranked.map { it.rank })
    }

    @Test fun onATieTheEarlierFinderWins() {
        val ranked = HuntScoring.ranked(listOf(row("Late", 6, 900), row("Early", 6, 100)))
        assertEquals(listOf("Early", "Late"), ranked.map { it.name })
        assertEquals(listOf(1, 2), ranked.map { it.rank })
        assertEquals(listOf("Early"), HuntScoring.winners(ranked).map { it.name })
    }

    @Test fun rowsThatTieOnPointsAndTimeShareARank() {
        val ranked = HuntScoring.ranked(listOf(row("Ann", 6, 100), row("Ben", 6, 100), row("Cy", 2, 100)))
        assertEquals(listOf(1, 1, 3), ranked.map { it.rank })
        assertEquals(setOf("Ann", "Ben"), HuntScoring.winners(ranked).map { it.name }.toSet())
    }

    @Test fun nobodyWinsWithZeroPointsAndNeverFindingSortsLast() {
        val ranked = HuntScoring.ranked(listOf(row("Ann", 0, 0), row("Ben", 0, 0)))
        assertEquals(emptyList<HuntRow>(), HuntScoring.winners(ranked))
        val mixed = HuntScoring.ranked(listOf(row("Never", 0, 0), row("Some", 1, 5)))
        assertEquals("Some", mixed.first().name)
        assertFalse(HuntScoring.winners(mixed).any { it.name == "Never" })
        assertEquals(emptyList<HuntRow>(), HuntScoring.ranked(emptyList()))
    }
}
