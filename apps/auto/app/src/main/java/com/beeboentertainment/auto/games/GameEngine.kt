package com.beeboentertainment.auto.games

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/*
 * The engine — Section 2 of the games brief.
 *
 * [GameRules] is the whole of a game expressed as pure functions over an
 * immutable state: no Android, no coroutines, no I/O, so it can be exhaustively
 * unit-tested. [GameEngine] is the tiny driver that walks the turn order and
 * asks each seat for a move — and it asks the SAME way regardless of whether the
 * seat is a human or a bot. That indifference is the point of the whole design.
 */

/**
 * A turn-based game's rules as pure functions. One instance per game type;
 * shared across every table.
 *
 * @param S immutable state type.
 * @param M move type (a data class so equality/`in` work for legality checks).
 */
interface GameRules<S, M> {
    /** Starting position for a table of [seatIds]; list order is turn order. */
    fun initialState(seatIds: List<String>): S

    /** Index into the seat list of whoever moves next. Undefined once [isOver]. */
    fun currentSeatIndex(state: S): Int

    /**
     * Every move the seat-to-move may legally make right now. For a well-formed
     * game this is non-empty until [isOver] is true (Roadside Rumble guarantees
     * it — see [RoadsideRumbleRules]); the engine falls back on the first legal
     * move if a seat ever returns an illegal one.
     */
    fun legalMoves(state: S): List<M>

    /** Apply [move] by seat [seatIndex] and return the next state. */
    fun applyMove(state: S, seatIndex: Int, move: M): S

    fun isOver(state: S): Boolean
}

/**
 * Drives a [GameRules] to completion using a fixed list of [seats].
 *
 * The engine holds the live [state] as a [StateFlow] so a UI can simply collect
 * it. [run] is the entire game loop; it is deliberately blind to seat type.
 *
 * A [GameEngine] plays exactly one game. For a rematch, build a fresh one with a
 * fresh seat list.
 */
class GameEngine<S, M>(
    val rules: GameRules<S, M>,
    val seats: List<PlayerSlot<S, M>>,
) {
    private val _state = MutableStateFlow(rules.initialState(seats.map { it.id }))

    /** The live game state. Emits the start position immediately, then a new
     *  value after every applied move. */
    val state: StateFlow<S> = _state.asStateFlow()

    /**
     * Play the game to the end.
     *
     * Each turn: find whose seat it is, ask that seat for a move, apply it, and
     * report it through [onMove] so a controller can broadcast the moves it owns.
     * Nothing here inspects [PlayerSlot.isBot] — a human tap and a bot's score
     * arrive through the identical `decideMove` call, and an absent seat that a
     * controller has swapped for a [BotPlayer] slots straight in.
     *
     * A move a seat returns that is not currently legal is coerced to the first
     * legal move, so a stray or late network/UI move can never corrupt state.
     *
     * Suspends until [isOver]; run it in its own coroutine.
     */
    suspend fun run(onMove: (suspend (seatIndex: Int, move: M) -> Unit)? = null) {
        while (!rules.isOver(_state.value)) {
            val snapshot = _state.value
            val idx = rules.currentSeatIndex(snapshot)
            val legal = rules.legalMoves(snapshot)
            val requested = seats[idx].decideMove(snapshot)
            val move = if (requested in legal) requested else legal.first()
            _state.value = rules.applyMove(snapshot, idx, move)
            onMove?.invoke(idx, move)
        }
    }
}
