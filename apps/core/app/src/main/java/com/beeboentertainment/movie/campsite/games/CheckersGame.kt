package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*

/**
 * Checkers - eight by eight, diagonal moves, jump to capture, crowned on the far row.
 *
 * RULE CHOICES. Each of these changes the game, so each gets its line:
 *
 *  - CAPTURING IS COMPULSORY. When a jump exists it is the only legal move. That is the
 *    standard draughts rule, and it also kills the commonest phone-game stall, where one
 *    player refuses every trade and the round never ends. It is not "maximum capture":
 *    any available jump will do, not necessarily the longest one, because explaining to
 *    a child that their jump was the wrong jump is not worth the strength it buys.
 *  - Men move and jump FORWARDS only. Kings move and jump one square in all four
 *    diagonal directions. This is English draughts, the version most families own.
 *  - Kings do NOT fly. A king steps one square, like a man, in four directions.
 *  - A multi-jump must be played out. The same piece keeps jumping while it can and the
 *    turn does not pass until it cannot.
 *  - CROWNING ENDS THE TURN. A man that lands on the far row is crowned and stays there,
 *    even if the new king could jump again. Also the English rule.
 *  - A player with no legal move has lost. Being frozen is as final as being taken.
 *  - Forty half-moves with nothing captured and nobody crowned is a draw, so two lone
 *    kings in the back of a car cannot chase each other until the battery dies.
 *
 * BOARD ENCODING, which the guest page reads straight out of the snapshot: sixty-four
 * cells, row-major from the top-left. 0 empty, 1 seat-one man, 2 seat-two man, 3 seat-one
 * king, 4 seat-two king. Light squares are always 0 and are never played on. Seat one
 * starts at the bottom and moves up the board.
 */
internal object CheckersGame : CampsiteGame {
    override val id = "checkers"
    override val title = "Checkers"
    override val blurb = "Hop over your opponent's pieces and take them. Reach the far row for a king."
    override val kind = "board"
    override val seats = Seats.exactly(2)
    override val category = GameCategory.BOARD

    private const val SIZE = 8
    private const val CELLS = SIZE * SIZE

    /** Half-moves with no capture and no crowning before the position is called a draw. */
    private const val QUIET_LIMIT = 40

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size >= 2) { "Checkers needs two players." }
        return Match(players.take(2), ctx)
    }

    override fun botMove(match: GameMatch, playerId: String, random: kotlin.random.Random): GameMove? {
        return (match as? Match)?.botMove(playerId, random)
    }

    /** The dark squares are the only playable ones. */
    private fun dark(cell: Int): Boolean = ((cell / SIZE) + (cell % SIZE)) % 2 == 1

    private fun seatOf(piece: Int): Int = when (piece) {
        1, 3 -> 0
        2, 4 -> 1
        else -> -1
    }

    private fun isKing(piece: Int): Boolean = piece >= 3

    /** Row deltas this piece may travel in. Men go one way; kings go both. */
    private fun rowSteps(piece: Int): List<Int> =
        if (isKing(piece)) listOf(-1, 1) else if (seatOf(piece) == 0) listOf(-1) else listOf(1)

    /** One legal hop. [captured] is the cell of the jumped piece, or -1 for a quiet move. */
    private data class Step(val from: Int, val to: Int, val captured: Int)

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {

        private val board = IntArray(CELLS)

        /** Cell of the piece part-way through a multi-jump, or -1. It alone may move. */
        private var chaining = -1

        private var quiet = 0

        init {
            for (cell in 0 until CELLS) {
                if (!dark(cell)) continue
                val row = cell / SIZE
                if (row <= 2) board[cell] = 2
                if (row >= 5) board[cell] = 1
            }
            prompt = "Dark squares only, one step diagonally. If you can jump, you must."
        }

        // ---- rules -----------------------------------------------------------

        private fun jumpsFrom(from: Int): List<Step> {
            val piece = board[from]
            if (piece == 0) return emptyList()
            val row = from / SIZE
            val col = from % SIZE
            val out = mutableListOf<Step>()
            for (dr in rowSteps(piece)) {
                for (dc in listOf(-1, 1)) {
                    val landRow = row + dr + dr
                    val landCol = col + dc + dc
                    if (landRow !in 0 until SIZE || landCol !in 0 until SIZE) continue
                    val over = (row + dr) * SIZE + (col + dc)
                    val land = landRow * SIZE + landCol
                    val victim = board[over]
                    if (victim == 0 || seatOf(victim) == seatOf(piece)) continue
                    if (board[land] != 0) continue
                    out.add(Step(from, land, over))
                }
            }
            return out
        }

        private fun quietFrom(from: Int): List<Step> {
            val piece = board[from]
            if (piece == 0) return emptyList()
            val row = from / SIZE
            val col = from % SIZE
            val out = mutableListOf<Step>()
            for (dr in rowSteps(piece)) {
                for (dc in listOf(-1, 1)) {
                    val nr = row + dr
                    val nc = col + dc
                    if (nr !in 0 until SIZE || nc !in 0 until SIZE) continue
                    val land = nr * SIZE + nc
                    if (board[land] != 0) continue
                    out.add(Step(from, land, -1))
                }
            }
            return out
        }

        /**
         * Every move this seat is allowed to make right now. Compulsory capture lives
         * here and nowhere else: if any jump exists, the quiet moves are never even
         * generated, so no other part of the game has to remember the rule.
         */
        private fun legalMoves(seat: Int): List<Step> {
            if (chaining >= 0) return jumpsFrom(chaining)
            val jumps = mutableListOf<Step>()
            for (cell in 0 until CELLS) if (seatOf(board[cell]) == seat) jumps.addAll(jumpsFrom(cell))
            if (jumps.isNotEmpty()) return jumps
            val quiets = mutableListOf<Step>()
            for (cell in 0 until CELLS) if (seatOf(board[cell]) == seat) quiets.addAll(quietFrom(cell))
            return quiets
        }

        private fun pieces(seat: Int): Int = board.count { seatOf(it) == seat }

        /** A king is worth two men when the engine has to judge an abandoned board. */
        private fun material(seat: Int): Int {
            var total = 0
            for (piece in board) if (seatOf(piece) == seat) total += if (isKing(piece)) 2 else 1
            return total
        }

        // ---- moves -----------------------------------------------------------

        override fun onApply(move: GameMove) {
            require(move.action == "move") { "Tap one of your pieces, then a square to move it to." }
            require(phase == "playing") { "This game has finished." }
            val seat = players.indexOf(move.playerId)
            require(seat >= 0) { "You are watching this game." }
            require(seat == turnIndex) { "It is not your turn yet." }
            val from = move.int("from")
            val to = move.int("to")
            require(from in 0 until CELLS && to in 0 until CELLS) {
                "Tap one of your pieces, then a square to move it to."
            }
            val legal = legalMoves(seat)
            val step = legal.firstOrNull { it.from == from && it.to == to }
                ?: throw IllegalArgumentException(why(seat, from, legal))
            playStep(step, seat)
        }

        /** Say what was wrong in words a parent can read out loud. */
        private fun why(seat: Int, from: Int, legal: List<Step>): String = when {
            chaining >= 0 && from != chaining -> "Keep jumping with the same piece."
            seatOf(board.getOrElse(from) { 0 }) != seat -> "That is not one of your pieces."
            legal.none { it.from == from } && legal.any { it.captured >= 0 } ->
                "You can jump, and a jump has to be taken."
            legal.none { it.from == from } -> "That piece has nowhere to go. Try another one."
            else -> "That piece cannot go there. Move one square diagonally to an empty square."
        }

        private fun playStep(step: Step, seat: Int) {
            val piece = board[step.from]
            board[step.from] = 0
            if (step.captured >= 0) board[step.captured] = 0
            val row = step.to / SIZE
            val crowns = !isKing(piece) && ((seat == 0 && row == 0) || (seat == 1 && row == SIZE - 1))
            board[step.to] = if (crowns) piece + 2 else piece
            quiet = if (step.captured >= 0 || crowns) 0 else quiet + 1
            if (step.captured >= 0) note(ctx.nameOf(players[seat]) + " took a piece")
            if (crowns) note(ctx.nameOf(players[seat]) + " crowned a king")
            if (step.captured >= 0 && !crowns && jumpsFrom(step.to).isNotEmpty()) {
                chaining = step.to
                prompt = "Keep jumping with the same piece."
                return
            }
            chaining = -1
            endTurn(seat)
        }

        private fun endTurn(seat: Int) {
            val other = 1 - seat
            if (pieces(other) == 0) {
                award(players[seat], 1)
                settleWinner(players[seat])
                return
            }
            val replies = legalMoves(other)
            if (replies.isEmpty()) {
                award(players[seat], 1)
                settleWinner(players[seat])
                return
            }
            if (quiet >= QUIET_LIMIT) {
                settleDraw("Forty moves with nothing taken, so it is a draw.")
                return
            }
            turnIndex = other
            prompt = when {
                replies.any { it.captured >= 0 } -> "There is a jump on the board, so it has to be taken."
                else -> "Move one square diagonally."
            }
        }

        /** The log is a running commentary, not an archive; keep it short enough to read. */
        private fun note(line: String) {
            log.add(line)
            if (log.size > 12) log.removeAt(0)
        }

        // ---- engine hooks ----------------------------------------------------

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        /**
         * A half-played board is normally a draw, but two clear pieces up is not a
         * position anybody at the table would call level, so material decides it. A
         * king counts two, which is roughly what it is worth.
         */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val first = material(0)
            val second = material(1)
            return when {
                first - second >= 2 ->
                    MatchResult(Outcome.WINNER, players[0], scores.toMap(), "Stopped with a clear lead.")
                second - first >= 2 ->
                    MatchResult(Outcome.WINNER, players[1], scores.toMap(), "Stopped with a clear lead.")
                else -> MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped with the board level.")
            }
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // A board is public by nature: both players are looking at the same squares,
            // so there is nothing here a spectator may not see.
            put("board", JsonArray(board.map { JsonPrimitive(it) }))
            val seat = viewer?.let { players.indexOf(it) } ?: -1
            val mine = if (phase == "playing" && seat >= 0 && seat == turnIndex) legalMoves(seat) else emptyList()
            put("moves", JsonArray(mine.map { JsonPrimitive(it.from.toString() + "-" + it.to) }))
            put("mustJump", mine.any { it.captured >= 0 })
            put("chain", chaining)
            put("counts", JsonArray(listOf(pieces(0), pieces(1)).map { JsonPrimitive(it) }))
        }

        // ---- bot -------------------------------------------------------------

        /**
         * Sensible-random with a little tactics: it takes when it can (it has no choice
         * anyway), likes crowning and continuing a chain, and avoids landing where it
         * can be taken straight back. It never invents a move: every candidate comes out
         * of the same [legalMoves] the referee uses.
         */
        fun botMove(playerId: String, random: kotlin.random.Random): GameMove? {
            if (phase != "playing") return null
            val seat = players.indexOf(playerId)
            if (seat < 0 || seat != turnIndex) return null
            val legal = legalMoves(seat)
            if (legal.isEmpty()) return null
            var best = Int.MIN_VALUE
            val shortlist = mutableListOf<Step>()
            for (step in legal) {
                val score = rate(step, seat) + random.nextInt(3)
                if (score > best) {
                    best = score
                    shortlist.clear()
                    shortlist.add(step)
                } else if (score == best) {
                    shortlist.add(step)
                }
            }
            val chosen = shortlist[random.nextInt(shortlist.size)]
            return GameMove(playerId, "move", buildJsonObject {
                put("from", chosen.from)
                put("to", chosen.to)
            })
        }

        private fun rate(step: Step, seat: Int): Int {
            val piece = board[step.from]
            val row = step.to / SIZE
            val crowns = !isKing(piece) && ((seat == 0 && row == 0) || (seat == 1 && row == SIZE - 1))
            var score = 0
            if (step.captured >= 0) score += 12
            if (crowns) score += 8
            if (step.captured >= 0 && !crowns && chainAfter(step, seat)) score += 6
            // Leaving the back row unguards the two squares a man is crowned on.
            val homeRow = if (seat == 0) SIZE - 1 else 0
            if (step.from / SIZE == homeRow) score -= 2
            if (exposed(step, seat)) score -= 9
            return score
        }

        /** Run [body] with [step] played, then put the board back exactly as it was. */
        private fun <T> simulate(step: Step, seat: Int, body: () -> T): T {
            val piece = board[step.from]
            val victim = if (step.captured >= 0) board[step.captured] else 0
            val landedOn = board[step.to]
            val row = step.to / SIZE
            val crowns = !isKing(piece) && ((seat == 0 && row == 0) || (seat == 1 && row == SIZE - 1))
            board[step.from] = 0
            if (step.captured >= 0) board[step.captured] = 0
            board[step.to] = if (crowns) piece + 2 else piece
            try {
                return body()
            } finally {
                board[step.from] = piece
                if (step.captured >= 0) board[step.captured] = victim
                board[step.to] = landedOn
            }
        }

        private fun chainAfter(step: Step, seat: Int): Boolean =
            simulate(step, seat) { jumpsFrom(step.to).isNotEmpty() }

        private fun exposed(step: Step, seat: Int): Boolean = simulate(step, seat) {
            var risky = false
            for (cell in 0 until CELLS) {
                if (seatOf(board[cell]) != 1 - seat) continue
                if (jumpsFrom(cell).any { it.captured == step.to }) {
                    risky = true
                    break
                }
            }
            risky
        }
    }
}
