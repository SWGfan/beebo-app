package com.beeboentertainment.movie.campsite.hunt

import kotlin.random.Random

/** One row of the leaderboard: a player (solo), or a team. */
internal data class HuntRow(
    /** Private key (never sent to a guest): "p:token" for a player, "t:index" for a team. */
    val key: String,
    val name: String,
    /** Team index, or -1 when playing alone. */
    val team: Int,
    val members: Int,
    val points: Int,
    val found: Int,
    val pending: Int,
    /** Completed bingo lines (always 0 on a list card). */
    val lines: Int,
    val done: Boolean,
    /** When this row last gained a point, epoch millis (0 = never). Breaks ties: earlier is better. */
    val lastAt: Long,
    val rank: Int,
)

/** What one entity's found items add up to. */
internal data class HuntScore(val points: Int, val found: Int, val lines: Int)

/**
 * Pure scoring: no clock, no session, no Android. A list item is worth its band's points (1, 2 or 3);
 * every bingo square is worth 1 and each completed row, column or diagonal adds
 * [BINGO_LINE_POINTS]. Rank is by points, then by who got there first (earlier last find), and rows
 * that tie on both share a rank.
 */
internal object HuntScoring {
    const val BINGO_LINE_POINTS = 2

    /** The largest bingo grid the pool allows: 5x5, else 4x4, else 3x3, else 0 (not enough items). */
    fun gridFor(available: Int): Int = when {
        available >= 25 -> 5
        available >= 16 -> 4
        available >= 9 -> 3
        else -> 0
    }

    /** Every row, column and both diagonals of a size-by-size grid, as lists of cell numbers. */
    fun lineCells(size: Int): List<List<Int>> {
        if (size < 2) return emptyList()
        val lines = ArrayList<List<Int>>()
        for (r in 0 until size) lines += (0 until size).map { c -> r * size + c }
        for (c in 0 until size) lines += (0 until size).map { r -> r * size + c }
        lines += (0 until size).map { it * size + it }
        lines += (0 until size).map { it * size + (size - 1 - it) }
        return lines
    }

    /** How many lines are fully found. [order] is the grid in cell order; [found] the item ids found. */
    fun completedLines(size: Int, order: List<String>, found: Set<String>): Int {
        if (size < 2 || order.size < size * size) return 0
        return lineCells(size).count { cells -> cells.all { order[it] in found } }
    }

    fun score(layout: HuntLayout, gridSize: Int, items: List<HuntItem>, found: Set<String>): HuntScore {
        val inPlay = items.filter { it.id in found }
        val base = inPlay.sumOf { if (layout == HuntLayout.BINGO) 1 else it.points }
        val lines = if (layout == HuntLayout.BINGO) completedLines(gridSize, items.map { it.id }, found) else 0
        return HuntScore(base + lines * BINGO_LINE_POINTS, inPlay.size, lines)
    }

    /** The most a list of [items] can score, so a page can show "12 of 30 points". */
    fun maxPoints(layout: HuntLayout, gridSize: Int, items: List<HuntItem>): Int =
        score(layout, gridSize, items, items.map { it.id }.toSet()).points

    /** Order rows best first and give each a rank (ties on points and time share a rank). */
    fun ranked(rows: List<HuntRow>): List<HuntRow> {
        val sorted = rows.sortedWith(
            compareByDescending<HuntRow> { it.points }
                .thenBy { if (it.lastAt == 0L) Long.MAX_VALUE else it.lastAt }
                .thenBy { it.name.lowercase() },
        )
        var previous: HuntRow? = null
        var previousRank = 0
        return sorted.mapIndexed { i, row ->
            val tied = previous != null && previous!!.points == row.points && previous!!.lastAt == row.lastAt
            val rank = if (tied) previousRank else i + 1
            previous = row
            previousRank = rank
            row.copy(rank = rank)
        }
    }

    /** Who won: the rank-1 rows, and only if they scored something. */
    fun winners(rows: List<HuntRow>): List<HuntRow> = rows.filter { it.rank == 1 && it.points > 0 }
}

/** Choosing the items a hunt uses. Pure, and driven by an injected [Random] so a test can fix it. */
internal object HuntSelector {

    class Pick(val items: List<HuntItem>, val gridSize: Int)

    /** The items for [card] at [band]: an error string, or the pick. */
    fun select(card: HuntCard, band: HuntBand, count: Int, random: Random): Result<Pick> {
        val pool = card.items.filter { it.band.rank <= band.rank }
        if (card.layout == HuntLayout.BINGO) {
            val size = HuntScoring.gridFor(pool.size)
            if (size == 0) return Result.failure(IllegalArgumentException("Not enough squares for that age. Pick an older age."))
            return Result.success(Pick(pool.shuffled(random).take(size * size), size))
        }
        val wanted = count.coerceIn(HuntSettings.MIN_ITEMS, HuntSettings.MAX_ITEMS)
        if (pool.size < HuntSettings.MIN_ITEMS) return Result.failure(IllegalArgumentException("Not enough items for that age. Pick an older age."))
        // Shuffle, keep the wanted number, then put the easy ones first: a warm-up before the harder ones.
        val chosen = pool.shuffled(random).take(wanted).sortedBy { it.band.rank }
        return Result.success(Pick(chosen, 0))
    }

    /** How many items a hunt would offer for this card and band (a bingo card offers its whole grid). */
    fun available(card: HuntCard, band: HuntBand): Int {
        val pool = card.items.count { it.band.rank <= band.rank }
        return if (card.layout == HuntLayout.BINGO) HuntScoring.gridFor(pool).let { it * it } else pool
    }
}
