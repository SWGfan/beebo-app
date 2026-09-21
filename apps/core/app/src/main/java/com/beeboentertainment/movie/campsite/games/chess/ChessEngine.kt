package com.beeboentertainment.movie.campsite.games.chess

import kotlin.math.abs
import kotlin.random.Random

/**
 * The computer chess player. Small on purpose: iterative-deepening alpha-beta with a
 * quiescence search, MVV-LVA capture ordering, a killer-free move order, and a
 * material-plus-piece-square-table evaluation. No opening book, no native engine.
 *
 * It is ALWAYS time-limited. The search checks the clock every few thousand nodes and
 * gives back the best move of the last depth it finished, so a slow phone plays a
 * little weaker rather than freezing. It never runs on the UI thread: the campsite
 * match starts it on a worker thread, and the on-phone screen calls it from a
 * background dispatcher.
 *
 * THE THREE LEVELS.
 *  - [Level.BEGINNER] looks one move ahead plus captures and then chooses among its
 *    options with a lot of noise, and one move in five it simply plays something that
 *    looked natural - a developing move, a capture - without checking it. That is how
 *    a beginner actually loses: by hanging a piece, not by playing random rubbish.
 *  - [Level.CASUAL] searches about four moves ahead for under a second, with a little
 *    noise so it does not play the identical game twice.
 *  - [Level.STRONG] searches as deep as it can in about two seconds, with no noise.
 */
class ChessEngine(private val random: Random = Random.Default) {

    enum class Level(val wire: String, val maxDepth: Int, val millis: Long, val noise: Int) {
        BEGINNER("easy", 2, 300, 180),
        CASUAL("medium", 4, 800, 25),
        STRONG("hard", 32, 2000, 0),
    }

    private class Abort : RuntimeException() {
        override fun fillInStackTrace(): Throwable = this
    }

    private var deadline = 0L
    private var nodes = 0L

    /** Positions searched by the last call, for tests and curiosity. */
    var lastNodes = 0L
        private set

    var lastDepth = 0
        private set

    /**
     * The move to play, or 0 when there is no legal move. [position] is not modified
     * (the engine works on a copy). Returns within roughly [Level.millis], plus the cost
     * of finishing the node it was on.
     */
    fun bestMove(position: ChessPosition, level: Level, millis: Long = level.millis): Int {
        val pos = position.copy()
        val legal = pos.legalMoves()
        if (legal.size == 0) return 0
        if (legal.size == 1) return legal[0]
        deadline = System.currentTimeMillis() + millis
        nodes = 0
        lastDepth = 0

        if (level == Level.BEGINNER && random.nextInt(5) == 0) {
            // The human mistake: a plausible-looking move played without checking it.
            val natural = (0 until legal.size).map { legal[it] }
                .filter { ChessPosition.flags(it) and ChessPosition.CAPTURE != 0 || developing(pos, it) }
            if (natural.isNotEmpty()) return natural[random.nextInt(natural.size)]
        }

        val scores = IntArray(legal.size)
        val order = legal.toList().sortedByDescending { orderScore(pos, it) }.toMutableList()
        var best = order[0]
        for (depth in 1..level.maxDepth) {
            try {
                var alpha = -INF
                val beta = INF
                var bestHere = order[0]
                val depthScores = HashMap<Int, Int>()
                for (m in order) {
                    pos.make(m)
                    // A level that picks among near-equal moves needs every root score
                    // exact, not a cut-off bound, or a blunder can tie with the best move.
                    val window = if (level.noise > 0) -INF else alpha
                    val score = -search(pos, depth - 1, -beta, -window, 1)
                    pos.unmake()
                    depthScores[m] = score
                    if (score > alpha) {
                        alpha = score
                        bestHere = m
                    }
                }
                best = bestHere
                lastDepth = depth
                // Best first next time: the principal move of this depth is usually right.
                order.sortByDescending { depthScores[it] ?: -INF }
                for (i in 0 until legal.size) scores[i] = depthScores[legal[i]] ?: -INF
                if (abs(alpha) > MATE - 100) break
            } catch (_: Abort) {
                break
            }
            if (System.currentTimeMillis() > deadline) break
        }
        lastNodes = nodes

        if (level.noise > 0 && lastDepth > 0) {
            // Pick among the moves that are "close enough" once noise is added. A mate is
            // never thrown away: noise is only added to ordinary scores.
            var chosen = best
            var top = Int.MIN_VALUE
            for (i in 0 until legal.size) {
                val s = scores[i]
                if (s <= -INF) continue
                val noisy = if (abs(s) > MATE - 100) s * 4 else s + random.nextInt(-level.noise, level.noise + 1)
                if (noisy > top) { top = noisy; chosen = legal[i] }
            }
            return chosen
        }
        return best
    }

    private fun developing(pos: ChessPosition, m: Int): Boolean {
        val p = abs(pos.piece(ChessPosition.fromSq(m)))
        val fromRank = ChessPosition.fromSq(m) / 8
        val home = if (pos.side > 0) 0 else 7
        return (p == ChessPosition.KNIGHT || p == ChessPosition.BISHOP) && fromRank == home
    }

    private fun search(pos: ChessPosition, depth: Int, alphaIn: Int, beta: Int, ply: Int): Int {
        if ((++nodes and 2047L) == 0L && System.currentTimeMillis() > deadline) throw Abort()
        // A repetition or fifty moves inside the search is a draw.
        if (ply > 0 && (pos.halfmove >= 100 || pos.repetitions() >= 2)) return 0
        val inCheck = pos.inCheck()
        if (depth <= 0 && !inCheck) return quiesce(pos, alphaIn, beta, ply)
        var alpha = alphaIn
        val moves = IntList()
        pos.pseudoMoves(moves)
        sortMoves(pos, moves)
        val us = pos.side
        var legal = 0
        for (i in 0 until moves.size) {
            val m = moves[i]
            pos.make(m)
            if (pos.inCheck(us)) { pos.unmake(); continue }
            legal++
            val score = -search(pos, depth - 1 + (if (inCheck) 1 else 0).coerceAtMost(if (ply < 12) 1 else 0), -beta, -alpha, ply + 1)
            pos.unmake()
            if (score >= beta) return score
            if (score > alpha) alpha = score
        }
        if (legal == 0) return if (inCheck) -MATE + ply else 0
        return alpha
    }

    private fun quiesce(pos: ChessPosition, alphaIn: Int, beta: Int, ply: Int): Int {
        if ((++nodes and 2047L) == 0L && System.currentTimeMillis() > deadline) throw Abort()
        val stand = evaluate(pos)
        if (stand >= beta) return stand
        var alpha = if (stand > alphaIn) stand else alphaIn
        if (ply > 40) return stand
        val moves = IntList()
        pos.pseudoMoves(moves, capturesOnly = true)
        sortMoves(pos, moves)
        val us = pos.side
        for (i in 0 until moves.size) {
            val m = moves[i]
            pos.make(m)
            if (pos.inCheck(us)) { pos.unmake(); continue }
            val score = -quiesce(pos, -beta, -alpha, ply + 1)
            pos.unmake()
            if (score >= beta) return score
            if (score > alpha) alpha = score
        }
        return alpha
    }

    private fun orderScore(pos: ChessPosition, m: Int): Int {
        var s = 0
        if (ChessPosition.flags(m) and ChessPosition.CAPTURE != 0) {
            val victim = abs(pos.piece(ChessPosition.toSq(m))).let { if (it == 0) ChessPosition.PAWN else it }
            val attacker = abs(pos.piece(ChessPosition.fromSq(m)))
            s += 10_000 + VALUE[victim] * 10 - VALUE[attacker] / 10
        }
        if (ChessPosition.promo(m) != 0) s += 9_000 + VALUE[ChessPosition.promo(m)]
        return s
    }

    /** Insertion sort by [orderScore], best first. Move lists are short. */
    private fun sortMoves(pos: ChessPosition, moves: IntList) {
        val n = moves.size
        val keys = IntArray(n) { orderScore(pos, moves[it]) }
        for (i in 1 until n) {
            val m = moves[i]; val k = keys[i]
            var j = i - 1
            while (j >= 0 && keys[j] < k) {
                moves[j + 1] = moves[j]; keys[j + 1] = keys[j]; j--
            }
            moves[j + 1] = m; keys[j + 1] = k
        }
    }

    companion object {
        const val MATE = 100_000
        const val INF = 1_000_000

        private val VALUE = intArrayOf(0, 100, 320, 330, 500, 900, 20_000)

        /**
         * Material plus piece-square tables, from the side to move's point of view.
         * The tables are the well-known "simplified evaluation" ones, written from
         * White's side with a8 first, so a white piece on square s reads index
         * `(7 - rank) * 8 + file` and a black piece reads `rank * 8 + file`.
         */
        fun evaluate(pos: ChessPosition): Int {
            var score = 0
            var material = 0
            for (sq in 0 until 64) {
                val p = pos.piece(sq)
                if (p == 0) continue
                val kind = abs(p)
                if (kind != ChessPosition.KING && kind != ChessPosition.PAWN) material += VALUE[kind]
            }
            val endgame = material <= 2600
            for (sq in 0 until 64) {
                val p = pos.piece(sq)
                if (p == 0) continue
                val kind = abs(p)
                val r = sq / 8; val f = sq % 8
                val index = if (p > 0) (7 - r) * 8 + f else r * 8 + f
                val table = when (kind) {
                    ChessPosition.PAWN -> PAWN_TABLE
                    ChessPosition.KNIGHT -> KNIGHT_TABLE
                    ChessPosition.BISHOP -> BISHOP_TABLE
                    ChessPosition.ROOK -> ROOK_TABLE
                    ChessPosition.QUEEN -> QUEEN_TABLE
                    else -> if (endgame) KING_END_TABLE else KING_MID_TABLE
                }
                val v = VALUE[kind] + table[index]
                score += if (p > 0) v else -v
            }
            return score * pos.side
        }

        private val PAWN_TABLE = intArrayOf(
            0, 0, 0, 0, 0, 0, 0, 0,
            50, 50, 50, 50, 50, 50, 50, 50,
            10, 10, 20, 30, 30, 20, 10, 10,
            5, 5, 10, 25, 25, 10, 5, 5,
            0, 0, 0, 20, 20, 0, 0, 0,
            5, -5, -10, 0, 0, -10, -5, 5,
            5, 10, 10, -20, -20, 10, 10, 5,
            0, 0, 0, 0, 0, 0, 0, 0,
        )
        private val KNIGHT_TABLE = intArrayOf(
            -50, -40, -30, -30, -30, -30, -40, -50,
            -40, -20, 0, 0, 0, 0, -20, -40,
            -30, 0, 10, 15, 15, 10, 0, -30,
            -30, 5, 15, 20, 20, 15, 5, -30,
            -30, 0, 15, 20, 20, 15, 0, -30,
            -30, 5, 10, 15, 15, 10, 5, -30,
            -40, -20, 0, 5, 5, 0, -20, -40,
            -50, -40, -30, -30, -30, -30, -40, -50,
        )
        private val BISHOP_TABLE = intArrayOf(
            -20, -10, -10, -10, -10, -10, -10, -20,
            -10, 0, 0, 0, 0, 0, 0, -10,
            -10, 0, 5, 10, 10, 5, 0, -10,
            -10, 5, 5, 10, 10, 5, 5, -10,
            -10, 0, 10, 10, 10, 10, 0, -10,
            -10, 10, 10, 10, 10, 10, 10, -10,
            -10, 5, 0, 0, 0, 0, 5, -10,
            -20, -10, -10, -10, -10, -10, -10, -20,
        )
        private val ROOK_TABLE = intArrayOf(
            0, 0, 0, 0, 0, 0, 0, 0,
            5, 10, 10, 10, 10, 10, 10, 5,
            -5, 0, 0, 0, 0, 0, 0, -5,
            -5, 0, 0, 0, 0, 0, 0, -5,
            -5, 0, 0, 0, 0, 0, 0, -5,
            -5, 0, 0, 0, 0, 0, 0, -5,
            -5, 0, 0, 0, 0, 0, 0, -5,
            0, 0, 0, 5, 5, 0, 0, 0,
        )
        private val QUEEN_TABLE = intArrayOf(
            -20, -10, -10, -5, -5, -10, -10, -20,
            -10, 0, 0, 0, 0, 0, 0, -10,
            -10, 0, 5, 5, 5, 5, 0, -10,
            -5, 0, 5, 5, 5, 5, 0, -5,
            0, 0, 5, 5, 5, 5, 0, -5,
            -10, 5, 5, 5, 5, 5, 0, -10,
            -10, 0, 5, 0, 0, 0, 0, -10,
            -20, -10, -10, -5, -5, -10, -10, -20,
        )
        private val KING_MID_TABLE = intArrayOf(
            -30, -40, -40, -50, -50, -40, -40, -30,
            -30, -40, -40, -50, -50, -40, -40, -30,
            -30, -40, -40, -50, -50, -40, -40, -30,
            -30, -40, -40, -50, -50, -40, -40, -30,
            -20, -30, -30, -40, -40, -30, -30, -20,
            -10, -20, -20, -20, -20, -20, -20, -10,
            20, 20, 0, 0, 0, 0, 20, 20,
            20, 30, 10, 0, 0, 10, 30, 20,
        )
        private val KING_END_TABLE = intArrayOf(
            -50, -40, -30, -20, -20, -30, -40, -50,
            -30, -20, -10, 0, 0, -10, -20, -30,
            -30, -10, 20, 30, 30, 20, -10, -30,
            -30, -10, 30, 40, 40, 30, -10, -30,
            -30, -10, 30, 40, 40, 30, -10, -30,
            -30, -10, 20, 30, 30, 20, -10, -30,
            -30, -30, 0, 0, 0, 0, -30, -30,
            -50, -30, -30, -30, -30, -30, -30, -50,
        )
    }
}
