package com.beeboentertainment.auto.games

import kotlin.random.Random

/*
 * "Cruisin' Carl" — the Roadside Rumble bot (Section 3 of the brief).
 *
 * Pure logic: a [BotBrain] whose [chooseMove] scores every open tile and picks by
 * a weight function, with a small difficulty scale. Wrapped in a [BotPlayer] to
 * take a seat. No Android, no coroutines — unit-tested directly.
 *
 * Weight of a tile = how much claiming it hurts the opponents, plus a nudge to
 * the middle:
 *
 *   weight = DENY * (open neighbours it would lock next turn) + POS * (neighbours)
 *
 * The DENY term is the heart of the strategy: claiming a tile locks its open
 * neighbours for the opponents' next turn, so a tile surrounded by open tiles
 * takes the most options away. The POS term (a tile's own neighbour count: 2 in a
 * corner, 3 on an edge, 4 in the middle) breaks ties toward central tiles, which
 * stay useful longer.
 */

/**
 * How sharply Carl plays. The scale trades between always taking the strongest
 * tile and leaving a solo passenger some room to win.
 */
enum class BotDifficulty {
    /** Picks a decent tile — a random one from the stronger half of the board. */
    EASY,

    /** Picks from the strongest quarter. */
    MEDIUM,

    /** Always the single highest-weight tile (optimal by the weight function). */
    HARD;

    companion object {
        fun from(raw: String?): BotDifficulty =
            entries.firstOrNull { it.name.equals(raw, ignoreCase = true) } ?: MEDIUM
    }
}

/**
 * Carl's brain for Roadside Rumble.
 *
 * @param difficulty how close to optimal Carl plays.
 * @param random source of the easy/medium spread; injectable so tests are
 *   deterministic.
 */
class CruisinCarl(
    val difficulty: BotDifficulty = BotDifficulty.MEDIUM,
    private val random: Random = Random.Default,
) : BotBrain<RoadsideState, RoadsideMove> {

    /** Weight of claiming the tile at [index] in [state]. Public for testing. */
    fun weight(state: RoadsideState, index: Int): Double {
        val neighbours = state.neighbours(index)
        val deny = neighbours.count { state.isClaimable(it) }
        return DENY_WEIGHT * deny + POSITION_WEIGHT * neighbours.size
    }

    override fun chooseMove(state: RoadsideState): RoadsideMove {
        // Rank every legal tile by weight, strongest first. Ties break by tile
        // index so HARD is fully deterministic (needed for a stable authority).
        val ranked = RoadsideRumbleRules.legalMoves(state)
            .map { move -> move to weight(state, state.indexOf(move.row, move.col)) }
            .sortedWith(
                compareByDescending<Pair<RoadsideMove, Double>> { it.second }
                    .thenBy { state.indexOf(it.first.row, it.first.col) }
            )

        // ranked is never empty: Roadside Rumble always has a legal move.
        val poolSize = when (difficulty) {
            BotDifficulty.HARD -> 1
            BotDifficulty.MEDIUM -> (ranked.size + 3) / 4   // top quarter, at least 1
            BotDifficulty.EASY -> (ranked.size + 1) / 2      // top half, at least 1
        }.coerceIn(1, ranked.size)

        val pick = if (poolSize == 1) 0 else random.nextInt(poolSize)
        return ranked[pick].first
    }

    private companion object {
        const val DENY_WEIGHT = 1.0
        const val POSITION_WEIGHT = 0.1
    }
}
