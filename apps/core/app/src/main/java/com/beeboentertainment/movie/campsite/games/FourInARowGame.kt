package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.party.games.ConnectFourRules
import kotlin.random.Random

/**
 * Four in a Row - drop a counter, get four across, down or diagonally.
 *
 * Named for what it is. "Connect Four" is a Hasbro trademark; four-in-a-row itself is
 * public domain, so the game stays and the brand name goes. The wire id stays
 * "connect4" on purpose: it is baked into saved history and guest bookmarks, and
 * nobody reads it.
 *
 * The rules are [ConnectFourRules], shared with the phone-side party game so the two
 * can never disagree about what a win is.
 */
internal object FourInARowGame : CampsiteGame {
    override val id = "connect4"
    override val title = "Four in a Row"
    override val blurb = "Four in a row. Two players; everyone else can watch."
    override val kind = "board"
    override val seats = Seats.exactly(2)
    override val category = GameCategory.BOARD

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    /**
     * Beebo drops a counter.
     *
     * The thinking is [ConnectFourRules.botColumn], the SAME routine the phone-side
     * party game already uses - reusing it means the campsite bot and the phone bot can
     * never disagree about what a threat is, and it is already covered by
     * ConnectFourRulesTest. It takes a win, blocks an immediate loss, then prefers a
     * central column that does not hand the opponent a win on the reply.
     *
     * The win and the block are checked here as well, before the variety roll, so the
     * one thing a human will not forgive - a bot that ignores three in a row - can
     * never be skipped. Everything after that is one move in six played at random, so
     * the bot does not play the identical game every single time; a perfectly
     * deterministic opponent stops being a game after the third rematch.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val board = match as? Match ?: return null
        if (!board.onTurn(playerId)) return null
        val mark = board.markOf(playerId)
        if (mark !in 1..2) return null
        val opponent = 3 - mark
        val legal = (0 until ConnectFourRules.COLS).filter { board.after(it, mark) != null }
        if (legal.isEmpty()) return null
        val win = legal.firstOrNull { column ->
            board.after(column, mark)?.let { board.lineIn(it).isNotEmpty() } == true
        }
        val block = legal.firstOrNull { column ->
            board.after(column, opponent)?.let { board.lineIn(it).isNotEmpty() } == true
        }
        val column = win ?: block ?: when {
            random.nextInt(6) == 0 -> legal.random(random)
            else -> ConnectFourRules.botColumn(board.cells(), mark) ?: legal.random(random)
        }
        return botAction(playerId, "move", "cell", column)
    }

    private class Match(players: List<String>, ctx: MatchContext) :
        BoardMatch(players, ctx, ConnectFourRules.ROWS * ConnectFourRules.COLS) {

        override fun place(board: List<Int>, cell: Int, mark: Int): List<Int> =
            ConnectFourRules.drop(board, cell, mark)
                ?: throw IllegalArgumentException("That column is full.")

        override fun winningLine(board: List<Int>): List<Int> = ConnectFourRules.winningCells(board)
    }
}
