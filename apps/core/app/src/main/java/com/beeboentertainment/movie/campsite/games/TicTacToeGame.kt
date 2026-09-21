package com.beeboentertainment.movie.campsite.games

import kotlin.random.Random

/** Tic-Tac-Toe: three in a row on a nine-square grid. */
internal object TicTacToeGame : CampsiteGame {
    override val id = "ttt"
    override val title = "Tic-Tac-Toe"
    override val blurb = "Three in a row on your own phones."
    override val kind = "board"
    override val seats = Seats.exactly(2)
    override val category = GameCategory.BOARD

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    /**
     * Take the win, block the loss, otherwise play the centre.
     *
     * Deliberately NOT perfect. Tic-Tac-Toe is solved, and a bot that plays it solved
     * draws every single game with an adult and beats every child - which is not a bot
     * anybody wants to play twice. Win-block-centre is the level a person actually
     * plays at: it punishes carelessness, it can still be forked, and one move in six
     * is simply a legal square picked at random so it is not the same game each time.
     *
     * The candidate list is the whole grid; [BoardMatch.after] is what decides which of
     * those squares are legal, so an occupied square can never be sent.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val board = match as? Match ?: return null
        if (!board.onTurn(playerId)) return null
        val mark = board.markOf(playerId)
        if (mark !in 1..2) return null
        val opponent = 3 - mark
        val legal = CENTRE_FIRST.filter { board.after(it, mark) != null }
        if (legal.isEmpty()) return null
        val win = legal.firstOrNull { cell ->
            board.after(cell, mark)?.let { board.lineIn(it).isNotEmpty() } == true
        }
        val block = legal.firstOrNull { cell ->
            board.after(cell, opponent)?.let { board.lineIn(it).isNotEmpty() } == true
        }
        val cell = win ?: block ?: if (random.nextInt(6) == 0) legal.random(random) else legal.first()
        return botAction(playerId, "move", "cell", cell)
    }

    /**
     * Centre, then corners, then edges - the ordinary human opening order, and the one
     * that does not lose to a fork out of nowhere. Used only as the preference AFTER a
     * win and a block have been ruled out.
     */
    private val CENTRE_FIRST = listOf(4, 0, 2, 6, 8, 1, 3, 5, 7)

    private val LINES = listOf(
        listOf(0, 1, 2), listOf(3, 4, 5), listOf(6, 7, 8),
        listOf(0, 3, 6), listOf(1, 4, 7), listOf(2, 5, 8),
        listOf(0, 4, 8), listOf(2, 4, 6),
    )

    private class Match(players: List<String>, ctx: MatchContext) : BoardMatch(players, ctx, 9) {
        override fun place(board: List<Int>, cell: Int, mark: Int): List<Int> {
            require(cell in 0..8 && board[cell] == 0) { "Choose an empty square." }
            return board.toMutableList().also { it[cell] = mark }
        }

        override fun winningLine(board: List<Int>): List<Int> =
            LINES.firstOrNull { line -> board[line[0]] != 0 && line.all { board[it] == board[line[0]] } }
                .orEmpty()
    }
}
