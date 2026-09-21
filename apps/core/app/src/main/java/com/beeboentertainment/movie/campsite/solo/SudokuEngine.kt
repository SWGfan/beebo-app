package com.beeboentertainment.movie.campsite.solo

import com.beeboentertainment.movie.campsite.games.GameCategory
import com.beeboentertainment.movie.campsite.games.SoloGame
import kotlinx.serialization.Serializable
import kotlin.random.Random

internal val SUDOKU_GAME = SoloGame(
    id = "sudoku",
    title = "Sudoku",
    blurb = "Fill the grid so every row, column and box has 1 to 9. Four levels.",
    emoji = "🔢",
    category = GameCategory.PUZZLE,
    howToPlay = listOf(
        "Fill every empty square with a number from 1 to 9. Each row, each column and each of the nine 3×3 boxes must contain every number exactly once.",
        "Tap a square, then tap a number. Turn on Notes to pencil in small candidates instead. Erase clears a square.",
        "Every puzzle has exactly one solution.",
        "Easy and Medium can be solved by spotting the only number that fits a square, or the only square a number fits in a row, column or box. Hard also needs pairs and “locked” numbers (a number confined to one line inside a box). Expert needs harder chains of reasoning beyond that.",
        "Hint first points out a wrong number if you have one; otherwise it fills in a square you could work out next and says why.",
        "Your game is saved as you play. Leave any time and carry on later.",
    ),
    needsTouch = false,
)

internal enum class SudokuLevel(val label: String) { EASY("Easy"), MEDIUM("Medium"), HARD("Hard"), EXPERT("Expert") }

/**
 * Sudoku rules, solver, rater and generator. No Android here.
 *
 * DIFFICULTY is decided by what it takes to solve the puzzle logically, with the number
 * of givens as a second band so Easy also looks easy:
 *
 *  - EASY    singles only (naked + hidden), 36 to 40 givens
 *  - MEDIUM  singles only, 28 to 35 givens
 *  - HARD    needs locked candidates (pointing / claiming) or naked / hidden pairs,
 *            and is not solvable by singles alone
 *  - EXPERT  not solvable by any of the above techniques (needs longer chains)
 *
 * Every puzzle is checked by [countSolutions] to have exactly one solution.
 */
internal object Sudoku {

    private val ROW = IntArray(81) { it / 9 }
    private val COL = IntArray(81) { it % 9 }
    private val BOX = IntArray(81) { (it / 9 / 3) * 3 + (it % 9) / 3 }

    /** The 27 units (9 rows, 9 cols, 9 boxes), each as 9 cell indices. */
    val UNITS: List<IntArray> = buildList {
        for (r in 0 until 9) add(IntArray(9) { r * 9 + it })
        for (c in 0 until 9) add(IntArray(9) { it * 9 + c })
        for (b in 0 until 9) {
            val br = (b / 3) * 3; val bc = (b % 3) * 3
            add(IntArray(9) { (br + it / 3) * 9 + bc + it % 3 })
        }
    }

    /** The 20 other cells that share a row, column or box with each cell. */
    val PEERS: Array<IntArray> = Array(81) { i ->
        (0 until 81).filter { j -> j != i && (ROW[j] == ROW[i] || COL[j] == COL[i] || BOX[j] == BOX[i]) }.toIntArray()
    }

    fun row(i: Int) = ROW[i]
    fun col(i: Int) = COL[i]
    fun box(i: Int) = BOX[i]

    /** Cells whose value clashes with a peer. Empty cells never conflict. */
    fun conflicts(grid: IntArray): Set<Int> {
        val out = HashSet<Int>()
        for (i in 0 until 81) {
            val v = grid[i]
            if (v == 0) continue
            if (PEERS[i].any { grid[it] == v }) out.add(i)
        }
        return out
    }

    /** A grid is a valid solution when full, in range and conflict-free. */
    fun isSolved(grid: IntArray): Boolean =
        grid.size == 81 && grid.all { it in 1..9 } && conflicts(grid).isEmpty()

    /** True when [puzzle] is consistent (no clashes, values 0-9). Says nothing about solvability. */
    fun isValidPuzzle(grid: IntArray): Boolean =
        grid.size == 81 && grid.all { it in 0..9 } && conflicts(grid).isEmpty()

    private fun candidates(grid: IntArray, i: Int): Int {
        var used = 0
        for (p in PEERS[i]) if (grid[p] != 0) used = used or (1 shl grid[p])
        return 0x3FE and used.inv()
    }

    /**
     * Count solutions, stopping at [limit]. Backtracking on the cell with the fewest
     * candidates, which keeps it fast enough to call once per removed clue.
     */
    fun countSolutions(puzzle: IntArray, limit: Int = 2): Int {
        if (!isValidPuzzle(puzzle)) return 0
        val g = puzzle.copyOf()
        return search(g, limit, null)
    }

    /** The unique solution, or null if there is none or more than one. */
    fun solve(puzzle: IntArray): IntArray? {
        if (!isValidPuzzle(puzzle)) return null
        val g = puzzle.copyOf()
        val holder = arrayOfNulls<IntArray>(1)
        return if (search(g, 2, holder) == 1) holder[0] else null
    }

    private fun search(g: IntArray, limit: Int, found: Array<IntArray?>?, random: Random? = null): Int {
        var best = -1
        var bestMask = 0
        var bestCount = 10
        for (i in 0 until 81) {
            if (g[i] != 0) continue
            val m = candidates(g, i)
            val n = Integer.bitCount(m)
            if (n == 0) return 0
            if (n < bestCount) { best = i; bestMask = m; bestCount = n; if (n == 1) break }
        }
        if (best < 0) {
            if (found != null && found[0] == null) found[0] = g.copyOf()
            return 1
        }
        var total = 0
        val digits = (1..9).filter { bestMask and (1 shl it) != 0 }.let { if (random != null) it.shuffled(random) else it }
        for (d in digits) {
            g[best] = d
            total += search(g, limit - total, found, random)
            g[best] = 0
            if (total >= limit) break
        }
        return total
    }

    /** A random complete, valid grid. */
    fun randomSolution(random: Random): IntArray {
        val g = IntArray(81)
        val holder = arrayOfNulls<IntArray>(1)
        search(g, 1, holder, random)
        return holder[0]!!
    }

    // ---- logical rating ------------------------------------------------------------

    /** Hardest technique tier needed: 0 singles, 1 locked candidates / pairs, 2 beyond (or unsolved). */
    fun techniqueTier(puzzle: IntArray): Int {
        val g = puzzle.copyOf()
        val cand = IntArray(81) { if (g[it] == 0) candidates(g, it) else 0 }
        var tier = 0
        while (true) {
            if (g.none { it == 0 }) return tier
            if (applySingles(g, cand)) continue
            if (applyLocked(cand) || applyPairs(cand)) { tier = 1; continue }
            return 2
        }
    }

    private fun place(g: IntArray, cand: IntArray, i: Int, d: Int) {
        g[i] = d
        cand[i] = 0
        val bit = 1 shl d
        for (p in PEERS[i]) cand[p] = cand[p] and bit.inv()
    }

    /** One naked or hidden single, if any. Returns true when something was placed. */
    private fun applySingles(g: IntArray, cand: IntArray): Boolean = findSingle(g, cand)?.let { (i, d, _) ->
        place(g, cand, i, d); true
    } ?: false

    /** (cell, digit, reason) for the next single, or null. Naked singles first. */
    fun findSingle(g: IntArray, cand: IntArray = IntArray(81) { if (g[it] == 0) candidates(g, it) else 0 }): Triple<Int, Int, String>? {
        for (i in 0 until 81) {
            if (g[i] == 0 && Integer.bitCount(cand[i]) == 1) {
                return Triple(i, Integer.numberOfTrailingZeros(cand[i]), "it is the only number that fits this square")
            }
        }
        UNITS.forEachIndexed { u, unit ->
            for (d in 1..9) {
                val bit = 1 shl d
                var spot = -1; var n = 0
                for (i in unit) if (g[i] == 0 && cand[i] and bit != 0) { spot = i; n++ }
                if (n == 1) {
                    val where = when { u < 9 -> "row"; u < 18 -> "column"; else -> "box" }
                    if (unit.none { g[it] == d }) return Triple(spot, d, "it is the only place for a $d in this $where")
                }
            }
        }
        return null
    }

    private fun applyLocked(cand: IntArray): Boolean {
        var changed = false
        // Pointing: within a box, a digit confined to one row/col removes it from the rest of that line.
        // Claiming: within a row/col, a digit confined to one box removes it from the rest of that box.
        for (a in UNITS.indices) {
            val unit = UNITS[a]
            for (d in 1..9) {
                val bit = 1 shl d
                val spots = unit.filter { cand[it] and bit != 0 }
                if (spots.size < 2) continue
                for (b in UNITS.indices) {
                    if (a == b) continue
                    val other = UNITS[b]
                    if (spots.all { it in other }) {
                        for (i in other) if (i !in spots && cand[i] and bit != 0) {
                            cand[i] = cand[i] and bit.inv(); changed = true
                        }
                    }
                }
            }
        }
        return changed
    }

    private fun applyPairs(cand: IntArray): Boolean {
        var changed = false
        for (unit in UNITS) {
            // naked pairs
            for (x in 0 until 9) for (y in x + 1 until 9) {
                val m = cand[unit[x]]
                if (Integer.bitCount(m) == 2 && cand[unit[y]] == m) {
                    for (k in unit) if (k != unit[x] && k != unit[y] && cand[k] and m != 0) {
                        cand[k] = cand[k] and m.inv(); changed = true
                    }
                }
            }
            // hidden pairs
            for (d1 in 1..9) for (d2 in d1 + 1..9) {
                val s1 = unit.filter { cand[it] and (1 shl d1) != 0 }
                val s2 = unit.filter { cand[it] and (1 shl d2) != 0 }
                if (s1.size == 2 && s1 == s2) {
                    val keep = (1 shl d1) or (1 shl d2)
                    for (i in s1) if (cand[i] and keep.inv() != 0) { cand[i] = cand[i] and keep; changed = true }
                }
            }
        }
        return changed
    }

    fun rate(puzzle: IntArray): SudokuLevel {
        val givens = puzzle.count { it != 0 }
        return when (techniqueTier(puzzle)) {
            0 -> if (givens >= 36) SudokuLevel.EASY else SudokuLevel.MEDIUM
            1 -> SudokuLevel.HARD
            else -> SudokuLevel.EXPERT
        }
    }

    // ---- generation ----------------------------------------------------------------

    class Generated(val puzzle: IntArray, val solution: IntArray, val level: SudokuLevel)

    /**
     * Make a puzzle of [level]. Clues are removed one at a time in random order, and a
     * removal is only kept if the puzzle still has exactly one solution. Easy and Medium
     * stop at a target number of givens; Hard and Expert strip as far as uniqueness allows
     * and are then rated. Attempts that rate as the wrong level are thrown away; after
     * [maxAttempts] the closest harder-or-equal result is returned so the player is never
     * left waiting.
     */
    fun generate(level: SudokuLevel, random: Random, maxAttempts: Int = 60): Generated {
        var fallback: Generated? = null
        repeat(maxAttempts) {
            val solution = randomSolution(random)
            val puzzle = solution.copyOf()
            val floor = when (level) {
                SudokuLevel.EASY -> 36 + random.nextInt(5)
                SudokuLevel.MEDIUM -> 28 + random.nextInt(4)
                SudokuLevel.HARD, SudokuLevel.EXPERT -> 17
            }
            var givens = 81
            for (i in (0 until 81).shuffled(random)) {
                if (givens <= floor) break
                val keep = puzzle[i]
                puzzle[i] = 0
                if (countSolutions(puzzle, 2) != 1) puzzle[i] = keep else givens--
            }
            val rated = rate(puzzle)
            val result = Generated(puzzle, solution, rated)
            if (rated == level) return result
            if (fallback == null || (rated.ordinal >= level.ordinal && rated.ordinal < fallback!!.level.ordinal)) fallback = result
        }
        return fallback!!
    }
}

/** A saved Sudoku game. Notes are bitmasks (bit d set = pencil mark d). */
@Serializable
internal data class SudokuSave(
    val level: SudokuLevel,
    val puzzle: List<Int>,
    val solution: List<Int>,
    val values: List<Int>,
    val notes: List<Int>,
    val elapsedMs: Long = 0L,
    val hints: Int = 0,
    val done: Boolean = false,
)

@Serializable
internal data class SudokuLevelStats(val started: Int = 0, val solved: Int = 0, val bestMs: Long = 0L)

@Serializable
internal data class SudokuStats(val byLevel: Map<String, SudokuLevelStats> = emptyMap()) {
    fun of(level: SudokuLevel) = byLevel[level.name] ?: SudokuLevelStats()
    fun started(level: SudokuLevel) = copy(byLevel = byLevel + (level.name to of(level).let { it.copy(started = it.started + 1) }))
    fun solved(level: SudokuLevel, ms: Long) = copy(byLevel = byLevel + (level.name to of(level).let {
        it.copy(solved = it.solved + 1, bestMs = if (it.bestMs == 0L) ms else minOf(it.bestMs, ms))
    }))
}
