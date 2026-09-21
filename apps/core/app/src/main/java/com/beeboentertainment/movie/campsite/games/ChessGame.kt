package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.campsite.games.chess.ChessEngine
import com.beeboentertainment.movie.campsite.games.chess.ChessPosition
import kotlinx.serialization.json.*
import kotlin.math.abs
import kotlin.random.Random

/**
 * Chess, with every rule: castling, en passant, promotion to the piece you choose,
 * check, checkmate, stalemate, threefold repetition, the fifty-move rule and
 * insufficient material. The rules live in [ChessPosition]; this is the referee and the
 * wire around them.
 *
 * RULE CHOICES.
 *  - Threefold repetition and fifty moves END the game as a draw the moment they
 *    happen, rather than waiting for somebody to claim it. Nobody at a campsite knows
 *    they are allowed to claim, and a game that could go on forever is worse.
 *  - A player may resign. There is no draw offer: two people at one table can agree a
 *    draw by one of them resigning or by starting again.
 *  - THE CLOCK is optional and off by default. When it is on ("clock=5;inc=2") each
 *    side has that many minutes plus the increment per move, measured by the host's
 *    clock, never the phone's. Running out loses - unless the other side has too
 *    little material to ever mate, which is a draw, as in the real rules. It is meant
 *    for phone-to-phone games; against the computer it is simply not offered.
 *
 * SETUP: "level=easy|medium|hard;clock=0..30;inc=0..30". All optional.
 *
 * WIRE: action "move" with `from` and `to` (0..63, a1 = 0) and `promo` ("q", "r", "b"
 * or "n", only for a promotion; the default is a queen), or action "resign".
 */
internal object ChessGame : CampsiteGame {
    override val id = "chess"
    override val title = "Chess"
    override val blurb = "The full game, with a computer opponent at three levels and an optional clock."
    override val kind = "board"
    override val seats = Seats.exactly(2)
    override val needsGuests = false
    override val category = GameCategory.BOARD

    override fun validateSetup(text: String) {
        require(text.length <= 200) { "Those chess settings are too long." }
    }

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size >= 2) { "Chess needs two players." }
        return Match(players.take(2), ctx, TableOptions.parse(setup))
    }

    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botMove(playerId, random)

    internal class Match(players: List<String>, ctx: MatchContext, private val options: TableOptions) :
        BaseMatch(players, ctx) {

        private val position = ChessPosition.start()
        private val sanList = mutableListOf<String>()
        private var ending = ""

        val level: ChessEngine.Level = when (options.level) {
            BotLevel.EASY -> ChessEngine.Level.BEGINNER
            BotLevel.MEDIUM -> ChessEngine.Level.CASUAL
            BotLevel.HARD -> ChessEngine.Level.STRONG
        }

        private val undoAllowed: Boolean = options.int("undo", 0, 0..1) == 1
        private val clockMs: Long = if (undoAllowed) 0L else options.int("clock", 0, 0..30) * 60_000L
        private val incrementMs: Long = options.int("inc", 0, 0..30) * 1_000L
        private val remaining = longArrayOf(clockMs, clockMs)
        private var turnStartedAt = ctx.now()

        init {
            prompt = "White to move."
        }

        /** A copy of the position, for the engine and for the on-phone screen. */
        fun positionCopy(): ChessPosition = position.copy()

        // ---- moves ----------------------------------------------------------

        override fun onApply(move: GameMove) {
            checkClock()
            require(phase == "playing") { "This game has finished." }
            val seat = players.indexOf(move.playerId)
            require(seat >= 0) { "You are watching this game." }
            when (move.action) {
                "resign" -> {
                    val other = 1 - seat
                    note(ctx.nameOf(players[seat]) + " resigned")
                    finish(players[other], ctx.nameOf(players[seat]) + " resigned.")
                }
                "move" -> playMove(seat, move)
                "undo" -> {
                    // Take-backs are for games against the computer on this phone: the
                    // on-phone screen switches them on with "undo=1". They go back to the
                    // asking player's previous turn - their own move and the reply.
                    require(undoAllowed) { "Take-backs are only for games against the computer." }
                    require(seat == turnIndex) { "You can take back a move when it is your turn." }
                    require(sanList.size >= 2) { "There is no move of yours to take back yet." }
                    repeat(2) { position.unmake(); sanList.removeAt(sanList.size - 1) }
                    searchKey = 0L
                    note(ctx.nameOf(players[seat]) + " took back a move")
                    prompt = (if (position.side > 0) "White" else "Black") + " to move."
                    turnStartedAt = ctx.now()
                }
                else -> throw IllegalArgumentException("Tap a piece, then where it goes.")
            }
        }

        private fun playMove(seat: Int, move: GameMove) {
            require(seat == turnIndex) { "It is not your turn yet." }
            val from = move.int("from")
            val to = move.int("to")
            require(from in 0..63 && to in 0..63) { "Tap a piece, then where it goes." }
            val promoText = move.text("promo").lowercase()
            val promo = when (promoText) {
                "n" -> ChessPosition.KNIGHT
                "b" -> ChessPosition.BISHOP
                "r" -> ChessPosition.ROOK
                else -> ChessPosition.QUEEN
            }
            val legal = position.legalMoves()
            var chosen = 0
            for (i in 0 until legal.size) {
                val m = legal[i]
                if (ChessPosition.fromSq(m) != from || ChessPosition.toSq(m) != to) continue
                if (ChessPosition.promo(m) != 0 && ChessPosition.promo(m) != promo) continue
                chosen = m
                break
            }
            if (chosen == 0) throw IllegalArgumentException(why(from, to, legal.size))
            val san = position.san(chosen, legal)
            val now = ctx.now()
            if (clockMs > 0) {
                remaining[seat] = remaining[seat] - (now - turnStartedAt) + incrementMs
            }
            turnStartedAt = now
            position.make(chosen)
            sanList.add(san)
            note(ctx.nameOf(players[seat]) + " played " + san)
            turnIndex = 1 - seat
            afterMove(seat)
        }

        private fun why(from: Int, to: Int, legalCount: Int): String {
            val piece = position.piece(from)
            return when {
                piece == 0 -> "There is no piece on that square."
                (piece > 0) != (position.side > 0) -> "That is not one of your pieces."
                position.inCheck() -> "You are in check - that move does not get your king out of it."
                legalCount == 0 -> "You have no legal move."
                else -> "That piece cannot go there."
            }
        }

        private fun afterMove(seat: Int) {
            val status = position.status()
            val mover = players[seat]
            when (status) {
                ChessPosition.Status.PLAYING -> {
                    prompt = (if (position.side > 0) "White" else "Black") + " to move" +
                        (if (position.inCheck()) " - check!" else ".")
                }
                ChessPosition.Status.CHECKMATE -> finish(mover, "Checkmate.")
                ChessPosition.Status.STALEMATE -> draw("Stalemate - no legal move, and not in check.")
                ChessPosition.Status.REPETITION -> draw("The same position three times - a draw.")
                ChessPosition.Status.FIFTY_MOVES -> draw("Fifty moves each with no capture and no pawn move - a draw.")
                ChessPosition.Status.INSUFFICIENT -> draw("Neither side has enough pieces left to checkmate - a draw.")
            }
        }

        private fun finish(winnerId: String, why: String) {
            ending = why
            prompt = why + " " + ctx.nameOf(winnerId) + " wins."
            award(winnerId, 1)
            settleWinner(winnerId)
        }

        private fun draw(why: String) {
            ending = why
            prompt = why
            settleDraw(why)
        }

        /** Flag fall. Checked on every move and every look at the board. */
        private fun checkClock() {
            if (clockMs <= 0 || phase != "playing") return
            val seat = turnIndex
            val left = remaining[seat] - (ctx.now() - turnStartedAt)
            if (left > 0) return
            remaining[seat] = 0
            val other = 1 - seat
            // The side that ran out still does not lose to an opponent who cannot mate.
            if (cannotMate(if (other == 0) 1 else -1)) {
                draw("Out of time, but the other side cannot checkmate - a draw.")
            } else {
                note(ctx.nameOf(players[seat]) + " ran out of time")
                finish(players[other], ctx.nameOf(players[seat]) + " ran out of time.")
            }
        }

        private fun cannotMate(color: Int): Boolean {
            var minors = 0
            for (sq in 0..63) {
                val p = position.piece(sq)
                if (p == 0 || (p > 0) != (color > 0)) continue
                when (abs(p)) {
                    ChessPosition.PAWN, ChessPosition.ROOK, ChessPosition.QUEEN -> return false
                    ChessPosition.KNIGHT, ChessPosition.BISHOP -> minors++
                }
            }
            return minors <= 1
        }

        private fun note(line: String) {
            log.add(line)
            if (log.size > 12) log.removeAt(0)
        }

        // ---- engine hooks ---------------------------------------------------

        override fun result(): MatchResult? {
            checkClock()
            return super.result()
        }

        override fun waitingOn(): List<String> {
            checkClock()
            return if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))
        }

        /**
         * A game stopped part way is a draw unless one side is clearly ahead: three
         * pawns' worth of material, which is what most people would resign over.
         */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            var balance = 0
            for (sq in 0..63) {
                val p = position.piece(sq)
                val v = when (abs(p)) { 1 -> 1; 2, 3 -> 3; 4 -> 5; 5 -> 9; else -> 0 }
                balance += if (p > 0) v else -v
            }
            return when {
                balance >= 3 -> MatchResult(Outcome.WINNER, players[0], scores.toMap(), "Stopped with a clear material lead.")
                balance <= -3 -> MatchResult(Outcome.WINNER, players[1], scores.toMap(), "Stopped with a clear material lead.")
                else -> MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped with the material level.")
            }
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            checkClock()
            // Nothing in chess is private: both players are looking at the same board.
            val board = IntArray(64) { position.piece(it) }
            put("board", JsonArray(board.map { JsonPrimitive(it) }))
            val seat = viewer?.let { players.indexOf(it) } ?: -1
            val mine = if (phase == "playing" && seat >= 0 && seat == turnIndex) position.legalMoves() else null
            put("moves", JsonArray(buildList {
                if (mine != null) for (i in 0 until mine.size) {
                    val m = mine[i]
                    val promo = ChessPosition.promo(m)
                    // Promotions are listed once; the page asks which piece.
                    if (promo != 0 && promo != ChessPosition.QUEEN) continue
                    add(JsonPrimitive("" + ChessPosition.fromSq(m) + "-" + ChessPosition.toSq(m) + if (promo != 0) "-p" else ""))
                }
            }))
            val last = position.lastMove()
            put("lastMove", JsonArray(if (last == 0) emptyList() else listOf(JsonPrimitive(ChessPosition.fromSq(last)), JsonPrimitive(ChessPosition.toSq(last)))))
            put("check", if (phase == "playing" && position.inCheck()) position.kingSquare(position.side) else -1)
            put("san", JsonArray(sanList.map { JsonPrimitive(it) }))
            put("toMove", if (position.side > 0) 0 else 1)
            put("mySeat", seat)
            put("ending", ending)
            put("level", options.level.wire)
            put("undo", undoAllowed && sanList.size >= 2)
            put("clock", clockMs > 0)
            if (clockMs > 0) {
                val live = remaining.copyOf()
                if (phase == "playing") live[turnIndex] = (live[turnIndex] - (ctx.now() - turnStartedAt)).coerceAtLeast(0)
                put("clocks", JsonArray(live.map { JsonPrimitive(it) }))
            }
            put("fen", position.fen())
        }

        // ---- the computer ---------------------------------------------------

        @Volatile private var searchKey = 0L
        @Volatile private var searchResult = 0
        @Volatile private var searching = false

        /**
         * The engine never runs under the service's lock. The first call for a position
         * starts a search on its own thread and answers "not yet"; the service asks
         * again after the bot's thinking pause, by which time the search - which is
         * time-limited - has an answer. The position is copied before the thread starts,
         * so the search can never see a board the referee is changing.
         */
        fun botMove(playerId: String, random: Random): GameMove? {
            if (phase != "playing") return null
            val seat = players.indexOf(playerId)
            if (seat < 0 || seat != turnIndex) return null
            val key = position.hash xor position.plyCount.toLong()
            if (searchKey == key && !searching && searchResult != 0) {
                val m = searchResult
                searchResult = 0
                searchKey = 0L
                return GameMove(playerId, "move", buildJsonObject {
                    put("from", ChessPosition.fromSq(m))
                    put("to", ChessPosition.toSq(m))
                    put("promo", when (ChessPosition.promo(m)) { 2 -> "n"; 3 -> "b"; 4 -> "r"; else -> "q" })
                })
            }
            if (searching && searchKey == key) return null
            val copy = position.copy()
            val engineLevel = level
            val seed = random.nextLong()
            searchKey = key
            searchResult = 0
            searching = true
            Thread({
                val found = runCatching { ChessEngine(Random(seed)).bestMove(copy, engineLevel) }.getOrDefault(0)
                if (searchKey == key) searchResult = found
                searching = false
            }, "campsite-chess").apply { isDaemon = true; start() }
            return null
        }

        /** For tests and the on-phone screen: search right here, on the calling thread. */
        fun computeBotMove(random: Random): Int = ChessEngine(random).bestMove(position.copy(), level)
    }
}
