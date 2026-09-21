package com.beeboentertainment.auto.games

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay

/*
 * The seat abstraction — Section 2 of the games brief.
 *
 * A game is played by SEATS, not by "humans" and "bots". A seat's only job is to
 * produce the next move when the engine asks for it; whether a person tapped a
 * tile or an algorithm scored one is the seat's private business. That single
 * idea is what lets an empty or departed seat be filled by a [BotPlayer] with no
 * change anywhere in the engine (see [GameEngine.run]).
 *
 * Everything in this file is pure Kotlin (kotlinx-coroutines only, no Android),
 * so the whole turn machine runs in a plain JVM unit test.
 */

/**
 * One seat at a turn-based table.
 *
 * @param S the game's state type — what a player sees in order to decide.
 * @param M the game's move type.
 */
interface PlayerSlot<S, M> {
    /** Stable identity of the seat. In multiplayer this is the hub member id; in
     *  a solo game it is a synthetic id like "you" or "carl". */
    val id: String

    /** Human-readable label for scoreboards and "whose turn" text. */
    val name: String

    /** True for an algorithmic seat. The engine never branches on this — it is
     *  here only so the UI can badge a bot and a controller can decide who
     *  broadcasts a seat's moves. */
    val isBot: Boolean

    /**
     * Produce this seat's move for [state]. May suspend: a [HumanPlayer] waits
     * for a tap or a network move, a [BotPlayer] returns as soon as it has
     * thought. The engine awaits this the same way for both.
     */
    suspend fun decideMove(state: S): M
}

/**
 * A seat driven from OUTSIDE the engine — a local tap or a move decoded off the
 * network. [decideMove] suspends until [submit] delivers a move, so the engine's
 * turn loop blocks on a human exactly as it would on a slow bot.
 *
 * Backed by a conflated [Channel]: capacity one, newest wins. That tolerates the
 * two harmless races of a turn-based game — a move submitted a hair before the
 * engine asks for it is kept and delivered, and a double-tap only ever leaves
 * the latest intent in the box.
 */
class HumanPlayer<S, M>(
    override val id: String,
    override val name: String,
) : PlayerSlot<S, M> {
    override val isBot: Boolean = false

    private val inbox = Channel<M>(Channel.CONFLATED)

    override suspend fun decideMove(state: S): M = inbox.receive()

    /** Feed the next move (local input, or a move that arrived over the room
     *  socket). Never suspends and never throws; safe from any thread. */
    fun submit(move: M) {
        inbox.trySend(move)
    }
}

/**
 * The thinking half of a [BotPlayer], split out so a difficulty's move choice is
 * a pure function that can be unit-tested on its own and reused across seats.
 */
interface BotBrain<S, M> {
    /** Choose a move for [state]. Must return a currently-legal move. */
    fun chooseMove(state: S): M
}

/**
 * A seat played by an algorithm. [decideMove] just asks the [brain] — after an
 * optional [thinkDelayMs] so a bot in the UI does not slam its move down the
 * instant your turn ends (the "reaction" half of a difficulty). The delay is
 * zero by default so tests run instantly.
 *
 * Because it satisfies the very same [PlayerSlot] contract as [HumanPlayer], the
 * engine cannot tell a bot from a person — which is exactly what makes the two
 * swappable when a seat needs filling.
 */
class BotPlayer<S, M>(
    override val id: String,
    override val name: String,
    private val brain: BotBrain<S, M>,
    private val thinkDelayMs: Long = 0L,
) : PlayerSlot<S, M> {
    override val isBot: Boolean = true

    override suspend fun decideMove(state: S): M {
        if (thinkDelayMs > 0L) delay(thinkDelayMs)
        return brain.chooseMove(state)
    }
}
