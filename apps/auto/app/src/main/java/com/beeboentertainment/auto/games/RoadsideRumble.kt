package com.beeboentertainment.auto.games

/*
 * Roadside Rumble — the MVP game (Section 3 of the brief). Pure logic, no
 * Android, no coroutines: driven by [GameEngine], played by [PlayerSlot]s,
 * exercised directly by RoadsideRumbleTest.
 *
 * Rules
 * -----
 *  - A 5x5 grid of tiles (25 in all).
 *  - Seats take turns. Claiming an open tile scores its owner one point AND locks
 *    each orthogonally-adjacent tile (up/down/left/right) for exactly the next
 *    turn — those neighbours cannot be claimed on the turn immediately after,
 *    then they free up again.
 *  - The game runs a fixed 15 turns. Most tiles claimed wins; equal tops tie.
 *
 * A tile is claimable when it is unclaimed and not currently locked. Because a
 * lock lasts a single turn, only the previous claim's neighbours are ever locked
 * at once — at most four tiles — so with 25 tiles and only 15 turns there is
 * always a legal move (at the last turn: 25 - 14 claimed - 4 locked = 7 free).
 * The game therefore never stalls and never needs a "pass".
 */

/** A claim of the tile at ([row], [col]). Data class so `in legalMoves` works. */
data class RoadsideMove(val row: Int, val col: Int)

/**
 * Immutable snapshot of a Roadside Rumble game.
 *
 * @param owners tile index -> id of the seat that claimed it.
 * @param lockedUntil tile index -> the turn number the tile stays locked BELOW;
 *   the tile is locked while `turnsPlayed < lockedUntil`. A claim made on turn
 *   `t` sets its neighbours to `t + 2`, which locks them on turn `t + 1` only.
 * @param turnsPlayed how many turns have been taken (0..[totalTurns]).
 */
data class RoadsideState(
    val seatIds: List<String>,
    val size: Int = 5,
    val totalTurns: Int = 15,
    val owners: Map<Int, String> = emptyMap(),
    val lockedUntil: Map<Int, Int> = emptyMap(),
    val turnsPlayed: Int = 0,
) {
    val tileCount: Int get() = size * size

    fun indexOf(row: Int, col: Int): Int = row * size + col
    fun rowOf(index: Int): Int = index / size
    fun colOf(index: Int): Int = index % size

    fun inBounds(row: Int, col: Int): Boolean = row in 0 until size && col in 0 until size

    /** Orthogonal on-board neighbours of the tile at [index]. */
    fun neighbours(index: Int): List<Int> {
        val r = rowOf(index)
        val c = colOf(index)
        val out = ArrayList<Int>(4)
        if (inBounds(r - 1, c)) out.add(indexOf(r - 1, c))
        if (inBounds(r + 1, c)) out.add(indexOf(r + 1, c))
        if (inBounds(r, c - 1)) out.add(indexOf(r, c - 1))
        if (inBounds(r, c + 1)) out.add(indexOf(r, c + 1))
        return out
    }

    fun isClaimed(index: Int): Boolean = owners.containsKey(index)

    /** Locked right now (a neighbour of the immediately previous claim). */
    fun isLocked(index: Int): Boolean = turnsPlayed < (lockedUntil[index] ?: 0)

    /** Open to be claimed on the current turn. */
    fun isClaimable(index: Int): Boolean = !isClaimed(index) && !isLocked(index)
}

/** The outcome of a game. */
sealed class RoadsideResult {
    object InProgress : RoadsideResult()
    data class Win(val seatId: String) : RoadsideResult()
    data class Tie(val seatIds: List<String>) : RoadsideResult()
}

/**
 * The rules object. Stateless and pure — one shared instance drives every table.
 */
object RoadsideRumbleRules : GameRules<RoadsideState, RoadsideMove> {

    override fun initialState(seatIds: List<String>): RoadsideState =
        RoadsideState(seatIds = seatIds)

    /** Round-robin turn order. */
    override fun currentSeatIndex(state: RoadsideState): Int =
        if (state.seatIds.isEmpty()) 0 else state.turnsPlayed % state.seatIds.size

    override fun legalMoves(state: RoadsideState): List<RoadsideMove> {
        val out = ArrayList<RoadsideMove>()
        for (i in 0 until state.tileCount) {
            if (state.isClaimable(i)) out.add(RoadsideMove(state.rowOf(i), state.colOf(i)))
        }
        return out
    }

    override fun applyMove(
        state: RoadsideState,
        seatIndex: Int,
        move: RoadsideMove,
    ): RoadsideState {
        val seatId = state.seatIds[seatIndex]
        val target = state.indexOf(move.row, move.col)
        val legalClaim = state.inBounds(move.row, move.col) && state.isClaimable(target)

        if (!legalClaim) {
            // Defensive: an illegal move only burns the turn (never reached in a
            // normal game — legalMoves is always non-empty and the engine coerces).
            return state.copy(turnsPlayed = state.turnsPlayed + 1)
        }

        val newOwners = state.owners + (target to seatId)
        // A claim on turn `turnsPlayed` locks each neighbour through the next turn:
        // locked while `turn < turnsPlayed + 2`, i.e. on turn `turnsPlayed + 1` only.
        val freeUntil = state.turnsPlayed + 2
        val newLocked = state.lockedUntil.toMutableMap()
        for (nb in state.neighbours(target)) {
            newLocked[nb] = maxOf(newLocked[nb] ?: 0, freeUntil)
        }

        return state.copy(
            owners = newOwners,
            lockedUntil = newLocked,
            turnsPlayed = state.turnsPlayed + 1,
        )
    }

    override fun isOver(state: RoadsideState): Boolean =
        state.turnsPlayed >= state.totalTurns

    // ----------------------------------------------------------------- scoring

    /** Tiles claimed per seat, including seats on zero. */
    fun scores(state: RoadsideState): Map<String, Int> {
        val counts = LinkedHashMap<String, Int>()
        for (id in state.seatIds) counts[id] = 0
        for (owner in state.owners.values) counts[owner] = (counts[owner] ?: 0) + 1
        return counts
    }

    /** Winner, tie, or still in progress. */
    fun result(state: RoadsideState): RoadsideResult {
        if (!isOver(state)) return RoadsideResult.InProgress
        val scores = scores(state)
        val best = scores.values.maxOrNull() ?: 0
        val leaders = state.seatIds.filter { (scores[it] ?: 0) == best }
        return if (leaders.size == 1) RoadsideResult.Win(leaders.first())
        else RoadsideResult.Tie(leaders)
    }
}
