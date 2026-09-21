package com.beeboentertainment.movie.campsite.solo

import com.beeboentertainment.movie.campsite.games.GameCategory
import com.beeboentertainment.movie.campsite.games.SoloGame
import kotlinx.serialization.Serializable
import kotlin.random.Random

internal val MINESWEEPER_GAME = SoloGame(
    id = "minesweeper",
    title = "Minesweeper",
    blurb = "Clear the field without digging up a mine. Numbers tell you how many are next door.",
    emoji = "💣",
    category = GameCategory.PUZZLE,
    howToPlay = listOf(
        "Dig every square that does not hide a mine. Your first dig is always safe and opens up an area.",
        "A number shows how many mines touch that square, including diagonally. Use the numbers to work out where the mines are.",
        "Flag a square you think hides a mine: switch to Flag mode, or press and hold a square.",
        "Tap a number that already has the right count of flags around it to dig all its other neighbours at once. Careful: a wrong flag sets off a mine.",
        "Pinch or use the + and – buttons to zoom, drag to move around the board.",
        "Beginner 9×9 with 10 mines, Intermediate 16×16 with 40, Expert 16×30 with 99. Your best times are saved.",
    ),
    needsTouch = false,
)

internal enum class MineLevel(val label: String, val rows: Int, val cols: Int, val mines: Int) {
    BEGINNER("Beginner", 9, 9, 10),
    INTERMEDIATE("Intermediate", 16, 16, 40),
    EXPERT("Expert", 16, 30, 99),
}

/**
 * One Minesweeper board. Pure Kotlin, serialisable as-is for save and resume.
 *
 * Mines are NOT placed until the first dig, and never on or next to the first square dug
 * (when the board has room), so the first tap is always safe and always opens an area.
 */
@Serializable
internal data class MineBoard(
    val rows: Int,
    val cols: Int,
    val mineCount: Int,
    val mines: List<Boolean> = List(rows * cols) { false },
    val revealed: List<Boolean> = List(rows * cols) { false },
    val flagged: List<Boolean> = List(rows * cols) { false },
    val placed: Boolean = false,
    val lost: Boolean = false,
    /** The mine that went off, for drawing. -1 when none. */
    val exploded: Int = -1,
    val elapsedMs: Long = 0L,
) {
    val size: Int get() = rows * cols
    val won: Boolean get() = placed && !lost && (0 until size).all { mines[it] || revealed[it] }
    val over: Boolean get() = won || lost
    val flagsLeft: Int get() = mineCount - flagged.count { it }

    fun index(r: Int, c: Int) = r * cols + c

    fun neighbours(i: Int): List<Int> {
        val r = i / cols; val c = i % cols
        val out = ArrayList<Int>(8)
        for (dr in -1..1) for (dc in -1..1) {
            if (dr == 0 && dc == 0) continue
            val nr = r + dr; val nc = c + dc
            if (nr in 0 until rows && nc in 0 until cols) out.add(nr * cols + nc)
        }
        return out
    }

    fun adjacentMines(i: Int): Int = neighbours(i).count { mines[it] }

    /** Put the mines down, keeping [safe] and (room permitting) its neighbours clear. */
    fun placeMines(safe: Int, random: Random): MineBoard {
        val excluded = (neighbours(safe) + safe).toSet()
        var pool = (0 until size).filter { it !in excluded }
        if (pool.size < mineCount) pool = (0 until size).filter { it != safe }
        val chosen = pool.shuffled(random).take(mineCount).toSet()
        return copy(mines = List(size) { it in chosen }, placed = true)
    }

    /** Dig one square. Places mines first if this is the first dig. */
    fun dig(i: Int, random: Random): MineBoard {
        if (over || flagged[i] || revealed[i]) return this
        val board = if (placed) this else placeMines(i, random)
        if (board.mines[i]) {
            val rev = board.revealed.toMutableList().also { it[i] = true }
            return board.copy(revealed = rev, lost = true, exploded = i)
        }
        return board.copy(revealed = board.flood(i))
    }

    /** Reveal [start] and, spreading from every zero, all the squares around it. */
    fun flood(start: Int): List<Boolean> {
        val rev = revealed.toMutableList()
        val queue = ArrayDeque<Int>()
        queue.add(start)
        while (queue.isNotEmpty()) {
            val i = queue.removeFirst()
            if (rev[i] || flagged[i] || mines[i]) continue
            rev[i] = true
            if (adjacentMines(i) == 0) neighbours(i).forEach { if (!rev[it]) queue.add(it) }
        }
        return rev
    }

    fun toggleFlag(i: Int): MineBoard {
        if (over || revealed[i]) return this
        return copy(flagged = flagged.toMutableList().also { it[i] = !it[i] })
    }

    /**
     * Chord: on a revealed number whose flag count matches it, dig every unflagged
     * neighbour. A wrong flag means a mine is dug and the game is lost, as in the classic.
     */
    fun chord(i: Int, random: Random): MineBoard {
        if (over || !revealed[i] || mines[i]) return this
        val n = adjacentMines(i)
        if (n == 0) return this
        val around = neighbours(i)
        if (around.count { flagged[it] } != n) return this
        var board = this
        for (j in around) {
            if (board.over) break
            if (!board.flagged[j] && !board.revealed[j]) board = board.dig(j, random)
        }
        return board
    }

    companion object {
        fun of(level: MineLevel) = MineBoard(level.rows, level.cols, level.mines)
    }
}

@Serializable
internal data class MineSave(val level: MineLevel, val board: MineBoard, val counted: Boolean = false)

@Serializable
internal data class MineLevelStats(val played: Int = 0, val won: Int = 0, val bestMs: Long = 0L)

@Serializable
internal data class MineStats(val byLevel: Map<String, MineLevelStats> = emptyMap()) {
    fun of(level: MineLevel) = byLevel[level.name] ?: MineLevelStats()
    fun record(level: MineLevel, won: Boolean, ms: Long) = copy(byLevel = byLevel + (level.name to of(level).let {
        it.copy(
            played = it.played + 1,
            won = it.won + if (won) 1 else 0,
            bestMs = if (!won) it.bestMs else if (it.bestMs == 0L) ms else minOf(it.bestMs, ms),
        )
    }))
}
