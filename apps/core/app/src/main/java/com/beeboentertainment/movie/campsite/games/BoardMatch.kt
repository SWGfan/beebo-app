package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*

/**
 * Two players, one grid, strict alternating turns.
 *
 * Shared by Four in a Row and Tic-Tac-Toe because the only thing that differs between
 * them is where a counter lands and what counts as a line. Keeping the turn order and
 * the end-of-match rules in one place is what stops the twentieth board game from
 * inventing its own idea of whose turn it is.
 */
internal abstract class BoardMatch(
    players: List<String>,
    ctx: MatchContext,
    cells: Int,
) : BaseMatch(players, ctx) {

    protected var board: List<Int> = List(cells) { 0 }
        private set

    /** Drop or place [mark], or throw with a guest-facing message if the move is illegal. */
    protected abstract fun place(board: List<Int>, cell: Int, mark: Int): List<Int>

    /** The winning cells, or empty. Also what the snapshot highlights. */
    protected abstract fun winningLine(board: List<Int>): List<Int>

    override fun onApply(move: GameMove) {
        require(move.action == "move") { "Unknown game action." }
        require(phase == "playing") { "This board is finished." }
        // Turn order is the host's, not the phone's: a guest cannot move twice or move
        // for the other seat however it crafts the request.
        require(players.getOrNull(turnIndex) == move.playerId) { "It's the other player's turn." }
        board = place(board, move.int("cell"), turnIndex + 1)
        when {
            winningLine(board).isNotEmpty() -> {
                award(move.playerId, 1)
                settleWinner(move.playerId)
            }
            board.none { it == 0 } -> settleDraw("A full board with nobody in a line.")
            else -> turnIndex = 1 - turnIndex
        }
    }

    override fun waitingOn(): List<String> =
        if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

    // ---- what a bot is allowed to look at ------------------------------------
    //
    // A bot reads the board through these and nothing else. They are deliberately the
    // same three questions a human at the table can answer by looking - what is on the
    // grid, is it my turn, and what would happen if I played there - so a bot can never
    // learn anything a player at the table could not. There is nothing private on a
    // board, which is exactly why board games are the ones worth giving a real bot.

    /** The grid as it stands. Public by nature: everyone is looking at the same one. */
    internal fun cells(): List<Int> = board

    /** This player's counter, 1 or 2, or 0 when they are not in this match. */
    internal fun markOf(playerId: String): Int =
        players.indexOf(playerId).let { if (it < 0) 0 else it + 1 }

    /** True only when the rules would accept a move from this player right now. */
    internal fun onTurn(playerId: String): Boolean =
        phase == "playing" && players.getOrNull(turnIndex) == playerId

    /**
     * The board as it WOULD be after [mark] plays [cell], or null when that is not a
     * legal move. Nothing is committed - it is the bot looking ahead one ply, and it
     * is also the bot's legality check, so a bot cannot send a move the match would
     * then have to reject.
     */
    internal fun after(cell: Int, mark: Int): List<Int>? =
        runCatching { place(board, cell, mark) }.getOrNull()

    /** The winning line in a hypothetical board from [after], or empty. */
    internal fun lineIn(candidate: List<Int>): List<Int> = winningLine(candidate)

    /**
     * An unfinished board separates nobody, whatever the position looks like: judging a
     * half-played board would mean the engine guessing at a game it deliberately does
     * not understand.
     */
    override fun resultIfStoppedNow(): MatchResult =
        result() ?: MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped mid-board.")

    override fun JsonObjectBuilder.decorate(viewer: String?) {
        // A board is public by nature - everyone is looking at the same grid - so there
        // is nothing here to hide from a spectator.
        put("board", JsonArray(board.map { JsonPrimitive(it) }))
        put("winningCells", JsonArray(winningLine(board).map { JsonPrimitive(it) }))
    }
}
