package com.beeboentertainment.movie.campsite.games.chess

/**
 * The rules of chess, and nothing else: a board, move generation, make and unmake,
 * check, the draw rules and algebraic notation.
 *
 * WHY IT IS WRITTEN THIS WAY. The same class serves the referee (one move every few
 * seconds) and the computer player (hundreds of thousands of positions a second on a
 * phone), so it is a mutable board with make/unmake rather than a fresh immutable
 * position per move. Nothing Android is imported, so the perft tests run on the JVM.
 *
 * ENCODING.
 *  - Squares are 0..63, a1 = 0, h1 = 7, a8 = 56. `rank = sq / 8`, `file = sq % 8`.
 *  - Pieces are signed ints: positive white, negative black. 1 pawn, 2 knight,
 *    3 bishop, 4 rook, 5 queen, 6 king. 0 is empty.
 *  - A move is one Int: from (6 bits) | to << 6 | promotion piece type << 12 | flags << 16.
 *    Flags: [CAPTURE], [EN_PASSANT], [CASTLE], [DOUBLE_PUSH].
 */
class ChessPosition private constructor(
    internal val board: IntArray,
) {
    /** 1 for white to move, -1 for black. */
    var side: Int = 1
        internal set

    /** Castling rights bitmask: 1 white short, 2 white long, 4 black short, 8 black long. */
    var castling: Int = 0
        internal set

    /** The square a pawn may capture en passant onto, or -1. */
    var epSquare: Int = -1
        internal set

    /** Half-moves since the last capture or pawn move, for the fifty-move rule. */
    var halfmove: Int = 0
        internal set

    var fullmove: Int = 1
        internal set

    /** Zobrist hash of the position, kept up to date incrementally. */
    var hash: Long = 0L
        private set

    /** Hashes of every position since the game began, the current one last, for repetition. */
    private val hashes = LongArrayList()
    private val undo = ArrayList<Undo>()

    private class Undo(
        val move: Int,
        val captured: Int,
        val castling: Int,
        val ep: Int,
        val halfmove: Int,
        val hash: Long,
    )

    fun piece(square: Int): Int = board[square]

    fun copy(): ChessPosition {
        val c = ChessPosition(board.copyOf())
        c.side = side; c.castling = castling; c.epSquare = epSquare
        c.halfmove = halfmove; c.fullmove = fullmove; c.hash = hash
        for (i in 0 until hashes.size) c.hashes.add(hashes[i])
        return c
    }

    // ---- attacks ------------------------------------------------------------

    /** True when [square] is attacked by any piece of [by] (1 white, -1 black). */
    fun attacked(square: Int, by: Int): Boolean {
        val r = square / 8
        val f = square % 8
        // Pawns: a white pawn attacks upwards, so it sits one rank BELOW the square.
        val pr = r - by
        if (pr in 0..7) {
            if (f > 0 && board[pr * 8 + f - 1] == by * PAWN) return true
            if (f < 7 && board[pr * 8 + f + 1] == by * PAWN) return true
        }
        for (d in KNIGHT_STEPS) {
            val nr = r + d[0]; val nf = f + d[1]
            if (nr in 0..7 && nf in 0..7 && board[nr * 8 + nf] == by * KNIGHT) return true
        }
        for (d in KING_STEPS) {
            val nr = r + d[0]; val nf = f + d[1]
            if (nr in 0..7 && nf in 0..7 && board[nr * 8 + nf] == by * KING) return true
        }
        for (d in ROOK_DIRS) if (slideHits(r, f, d, by, ROOK)) return true
        for (d in BISHOP_DIRS) if (slideHits(r, f, d, by, BISHOP)) return true
        return false
    }

    private fun slideHits(r: Int, f: Int, d: IntArray, by: Int, kind: Int): Boolean {
        var nr = r + d[0]; var nf = f + d[1]
        while (nr in 0..7 && nf in 0..7) {
            val p = board[nr * 8 + nf]
            if (p != 0) return p == by * kind || p == by * QUEEN
            nr += d[0]; nf += d[1]
        }
        return false
    }

    fun kingSquare(color: Int): Int {
        val target = color * KING
        for (i in 0 until 64) if (board[i] == target) return i
        return -1
    }

    fun inCheck(color: Int = side): Boolean {
        val k = kingSquare(color)
        return k >= 0 && attacked(k, -color)
    }

    // ---- generation ---------------------------------------------------------

    /**
     * Pseudo-legal moves into [out] (cleared first). A pseudo-legal move may leave the
     * mover's own king in check; [legalMoves] filters those out. [capturesOnly] is for
     * the engine's quiescence search and also keeps promotions.
     */
    fun pseudoMoves(out: IntList, capturesOnly: Boolean = false) {
        out.clear()
        val us = side
        for (from in 0 until 64) {
            val p = board[from]
            if (p == 0 || (p > 0) != (us > 0)) continue
            val r = from / 8
            val f = from % 8
            when (p * us) {
                PAWN -> pawnMoves(from, r, f, us, out, capturesOnly)
                KNIGHT -> steps(from, r, f, KNIGHT_STEPS, us, out, capturesOnly)
                BISHOP -> slides(from, r, f, BISHOP_DIRS, us, out, capturesOnly)
                ROOK -> slides(from, r, f, ROOK_DIRS, us, out, capturesOnly)
                QUEEN -> { slides(from, r, f, ROOK_DIRS, us, out, capturesOnly); slides(from, r, f, BISHOP_DIRS, us, out, capturesOnly) }
                KING -> {
                    steps(from, r, f, KING_STEPS, us, out, capturesOnly)
                    if (!capturesOnly) castles(from, us, out)
                }
            }
        }
    }

    private fun pawnMoves(from: Int, r: Int, f: Int, us: Int, out: IntList, capturesOnly: Boolean) {
        val nr = r + us
        if (nr !in 0..7) return
        val lastRank = if (us > 0) 7 else 0
        val startRank = if (us > 0) 1 else 6
        val one = nr * 8 + f
        if (board[one] == 0) {
            if (nr == lastRank) addPromotions(from, one, 0, out)
            else if (!capturesOnly) {
                out.add(move(from, one))
                val two = (r + 2 * us) * 8 + f
                if (r == startRank && board[two] == 0) out.add(move(from, two, 0, DOUBLE_PUSH))
            }
        }
        for (df in intArrayOf(-1, 1)) {
            val nf = f + df
            if (nf !in 0..7) continue
            val to = nr * 8 + nf
            val target = board[to]
            if (target != 0 && (target > 0) != (us > 0)) {
                if (nr == lastRank) addPromotions(from, to, CAPTURE, out)
                else out.add(move(from, to, 0, CAPTURE))
            } else if (to == epSquare && target == 0) {
                out.add(move(from, to, 0, CAPTURE or EN_PASSANT))
            }
        }
    }

    private fun addPromotions(from: Int, to: Int, flags: Int, out: IntList) {
        out.add(move(from, to, QUEEN, flags))
        out.add(move(from, to, KNIGHT, flags))
        out.add(move(from, to, ROOK, flags))
        out.add(move(from, to, BISHOP, flags))
    }

    private fun steps(from: Int, r: Int, f: Int, deltas: Array<IntArray>, us: Int, out: IntList, capturesOnly: Boolean) {
        for (d in deltas) {
            val nr = r + d[0]; val nf = f + d[1]
            if (nr !in 0..7 || nf !in 0..7) continue
            val to = nr * 8 + nf
            val target = board[to]
            if (target == 0) { if (!capturesOnly) out.add(move(from, to)) }
            else if ((target > 0) != (us > 0)) out.add(move(from, to, 0, CAPTURE))
        }
    }

    private fun slides(from: Int, r: Int, f: Int, dirs: Array<IntArray>, us: Int, out: IntList, capturesOnly: Boolean) {
        for (d in dirs) {
            var nr = r + d[0]; var nf = f + d[1]
            while (nr in 0..7 && nf in 0..7) {
                val to = nr * 8 + nf
                val target = board[to]
                if (target == 0) {
                    if (!capturesOnly) out.add(move(from, to))
                } else {
                    if ((target > 0) != (us > 0)) out.add(move(from, to, 0, CAPTURE))
                    break
                }
                nr += d[0]; nf += d[1]
            }
        }
    }

    private fun castles(from: Int, us: Int, out: IntList) {
        val home = if (us > 0) 4 else 60
        if (from != home) return
        val shortRight = if (us > 0) 1 else 4
        val longRight = if (us > 0) 2 else 8
        if (castling and (shortRight or longRight) == 0) return
        if (attacked(home, -us)) return
        if (castling and shortRight != 0 && board[home + 1] == 0 && board[home + 2] == 0 &&
            board[home + 3] == us * ROOK && !attacked(home + 1, -us) && !attacked(home + 2, -us)
        ) out.add(move(home, home + 2, 0, CASTLE))
        if (castling and longRight != 0 && board[home - 1] == 0 && board[home - 2] == 0 && board[home - 3] == 0 &&
            board[home - 4] == us * ROOK && !attacked(home - 1, -us) && !attacked(home - 2, -us)
        ) out.add(move(home, home - 2, 0, CASTLE))
    }

    /** Every legal move for the side to move. */
    fun legalMoves(): IntList {
        val pseudo = IntList()
        pseudoMoves(pseudo)
        val out = IntList()
        val us = side
        for (i in 0 until pseudo.size) {
            val m = pseudo[i]
            make(m)
            if (!inCheck(us)) out.add(m)
            unmake()
        }
        return out
    }

    // ---- make / unmake ------------------------------------------------------

    fun make(m: Int) {
        val from = fromSq(m); val to = toSq(m); val flags = flags(m)
        val p = board[from]
        val us = side
        var captured = board[to]
        undo.add(Undo(m, captured, castling, epSquare, halfmove, hash))
        var h = hash
        h = h xor Zobrist.piece(p, from)
        if (epSquare >= 0) h = h xor Zobrist.EP[epSquare % 8]
        h = h xor Zobrist.CASTLE[castling]
        if (flags and EN_PASSANT != 0) {
            val victim = to - 8 * us
            captured = board[victim]
            h = h xor Zobrist.piece(captured, victim)
            board[victim] = 0
        } else if (captured != 0) {
            h = h xor Zobrist.piece(captured, to)
        }
        board[from] = 0
        val placed = if (promo(m) != 0) us * promo(m) else p
        board[to] = placed
        h = h xor Zobrist.piece(placed, to)
        if (flags and CASTLE != 0) {
            val rookFrom = if (to > from) from + 3 else from - 4
            val rookTo = if (to > from) from + 1 else from - 1
            val rook = board[rookFrom]
            board[rookFrom] = 0; board[rookTo] = rook
            h = h xor Zobrist.piece(rook, rookFrom) xor Zobrist.piece(rook, rookTo)
        }
        castling = castling and CASTLE_MASK[from] and CASTLE_MASK[to]
        // The en passant square is only recorded when an enemy pawn actually stands
        // beside the one that moved. It changes no move list, and it keeps 1.e4 e5
        // 2.Nf3 Nf6 3.Ng1 Ng8 a repetition of the start, as the rules intend.
        epSquare = if (flags and DOUBLE_PUSH != 0 && pawnBeside(to, -us)) (from + to) / 2 else -1
        halfmove = if (p * us == PAWN || captured != 0) 0 else halfmove + 1
        if (us < 0) fullmove++
        side = -us
        h = h xor Zobrist.CASTLE[castling]
        if (epSquare >= 0) h = h xor Zobrist.EP[epSquare % 8]
        h = h xor Zobrist.SIDE
        hash = h
        hashes.add(h)
    }

    private fun pawnBeside(square: Int, color: Int): Boolean {
        val f = square % 8
        return (f > 0 && board[square - 1] == color * PAWN) || (f < 7 && board[square + 1] == color * PAWN)
    }

    fun unmake() {
        val u = undo.removeAt(undo.size - 1)
        hashes.removeLast()
        val m = u.move
        val from = fromSq(m); val to = toSq(m); val flags = flags(m)
        side = -side
        val us = side
        if (us < 0) fullmove--
        val moved = board[to]
        board[from] = if (promo(m) != 0) us * PAWN else moved
        if (flags and EN_PASSANT != 0) {
            board[to] = 0
            board[to - 8 * us] = -us * PAWN
        } else {
            board[to] = u.captured
        }
        if (flags and CASTLE != 0) {
            val rookFrom = if (to > from) from + 3 else from - 4
            val rookTo = if (to > from) from + 1 else from - 1
            board[rookFrom] = board[rookTo]; board[rookTo] = 0
        }
        castling = u.castling; epSquare = u.ep; halfmove = u.halfmove; hash = u.hash
    }

    /** A null move for the engine's benefit is deliberately not offered: it is not a rule. */
    val plyCount: Int get() = undo.size

    fun lastMove(): Int = if (undo.isEmpty()) 0 else undo[undo.size - 1].move

    // ---- game state ---------------------------------------------------------

    /** How many times the current position has occurred, this time included. */
    fun repetitions(): Int {
        var n = 0
        val limit = (hashes.size - 1 - halfmove).coerceAtLeast(0)
        var i = hashes.size - 1
        while (i >= limit) {
            if (hashes[i] == hash) n++
            i -= 1
        }
        return n
    }

    /**
     * Neither side can possibly mate: bare kings, king and one minor piece against a
     * bare king, or kings and bishops that all stand on the same colour of square.
     */
    fun insufficientMaterial(): Boolean {
        var minors = 0
        var knights = 0
        var bishopColours = 0
        for (sq in 0 until 64) {
            when (kotlin.math.abs(board[sq])) {
                0, KING -> {}
                PAWN, ROOK, QUEEN -> return false
                KNIGHT -> { minors++; knights++ }
                BISHOP -> { minors++; bishopColours = bishopColours or (1 shl ((sq / 8 + sq % 8) % 2)) }
            }
        }
        if (minors <= 1) return true
        return knights == 0 && bishopColours != 3
    }

    fun status(): Status {
        val moves = legalMoves()
        if (moves.size == 0) return if (inCheck()) Status.CHECKMATE else Status.STALEMATE
        if (insufficientMaterial()) return Status.INSUFFICIENT
        if (halfmove >= 100) return Status.FIFTY_MOVES
        if (repetitions() >= 3) return Status.REPETITION
        return Status.PLAYING
    }

    enum class Status(val over: Boolean) {
        PLAYING(false), CHECKMATE(true), STALEMATE(true), REPETITION(true), FIFTY_MOVES(true), INSUFFICIENT(true)
    }

    // ---- notation -----------------------------------------------------------

    /** Standard algebraic notation for [m], which must be legal in this position. */
    fun san(m: Int, legal: IntList = legalMoves()): String {
        val from = fromSq(m); val to = toSq(m)
        val p = board[from]
        val kind = kotlin.math.abs(p)
        val sb = StringBuilder()
        if (flags(m) and CASTLE != 0) {
            sb.append(if (to > from) "O-O" else "O-O-O")
        } else {
            if (kind != PAWN) {
                sb.append(LETTERS[kind])
                var sameFile = false; var sameRank = false; var ambiguous = false
                for (i in 0 until legal.size) {
                    val o = legal[i]
                    if (o == m || toSq(o) != to || fromSq(o) == from || board[fromSq(o)] != p) continue
                    ambiguous = true
                    if (fromSq(o) % 8 == from % 8) sameFile = true
                    if (fromSq(o) / 8 == from / 8) sameRank = true
                }
                if (ambiguous) {
                    if (!sameFile) sb.append(FILES[from % 8])
                    else if (!sameRank) sb.append(RANKS[from / 8])
                    else sb.append(squareName(from))
                }
            } else if (flags(m) and CAPTURE != 0) {
                sb.append(FILES[from % 8])
            }
            if (flags(m) and CAPTURE != 0) sb.append('x')
            sb.append(squareName(to))
            if (promo(m) != 0) sb.append('=').append(LETTERS[promo(m)])
        }
        make(m)
        if (inCheck()) sb.append(if (legalMoves().size == 0) '#' else '+')
        unmake()
        return sb.toString()
    }

    /**
     * The legal move written as [text] in algebraic notation, or 0. Forgiving about the
     * decorations people actually type: check marks, "!?" annotations, zeros for
     * castling and a promotion with or without the "=".
     */
    fun parseSan(text: String): Int {
        val clean = normalise(text)
        if (clean.isEmpty()) return 0
        val legal = legalMoves()
        for (i in 0 until legal.size) {
            if (normalise(san(legal[i], legal)) == clean) return legal[i]
        }
        return 0
    }

    private fun normalise(text: String): String =
        text.trim().replace("0", "O").replace("=", "").replace("+", "").replace("#", "")
            .replace("!", "").replace("?", "").replace("e.p.", "").trim()

    /** Coordinate notation, "e2e4" or "e7e8q". Used on the wire and in tests. */
    fun uci(m: Int): String =
        squareName(fromSq(m)) + squareName(toSq(m)) + if (promo(m) != 0) LETTERS[promo(m)].lowercaseChar().toString() else ""

    fun fen(): String {
        val sb = StringBuilder()
        for (r in 7 downTo 0) {
            var empty = 0
            for (f in 0..7) {
                val p = board[r * 8 + f]
                if (p == 0) { empty++; continue }
                if (empty > 0) { sb.append(empty); empty = 0 }
                val c = LETTERS[kotlin.math.abs(p)]
                sb.append(if (p > 0) c else c.lowercaseChar())
            }
            if (empty > 0) sb.append(empty)
            if (r > 0) sb.append('/')
        }
        sb.append(if (side > 0) " w " else " b ")
        var rights = ""
        if (castling and 1 != 0) rights += "K"
        if (castling and 2 != 0) rights += "Q"
        if (castling and 4 != 0) rights += "k"
        if (castling and 8 != 0) rights += "q"
        sb.append(rights.ifEmpty { "-" })
        sb.append(' ').append(if (epSquare >= 0) squareName(epSquare) else "-")
        sb.append(' ').append(halfmove).append(' ').append(fullmove)
        return sb.toString()
    }

    private fun rehash() {
        var h = 0L
        for (sq in 0 until 64) if (board[sq] != 0) h = h xor Zobrist.piece(board[sq], sq)
        h = h xor Zobrist.CASTLE[castling]
        if (epSquare >= 0) h = h xor Zobrist.EP[epSquare % 8]
        if (side < 0) h = h xor Zobrist.SIDE
        hash = h
        hashes.clear()
        hashes.add(h)
    }

    companion object {
        const val PAWN = 1
        const val KNIGHT = 2
        const val BISHOP = 3
        const val ROOK = 4
        const val QUEEN = 5
        const val KING = 6

        const val CAPTURE = 1
        const val EN_PASSANT = 2
        const val CASTLE = 4
        const val DOUBLE_PUSH = 8

        const val START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

        private const val LETTERS = " PNBRQK"
        private const val FILES = "abcdefgh"
        private const val RANKS = "12345678"

        internal val KNIGHT_STEPS = arrayOf(intArrayOf(1, 2), intArrayOf(2, 1), intArrayOf(2, -1), intArrayOf(1, -2),
            intArrayOf(-1, -2), intArrayOf(-2, -1), intArrayOf(-2, 1), intArrayOf(-1, 2))
        internal val KING_STEPS = arrayOf(intArrayOf(1, 0), intArrayOf(1, 1), intArrayOf(0, 1), intArrayOf(-1, 1),
            intArrayOf(-1, 0), intArrayOf(-1, -1), intArrayOf(0, -1), intArrayOf(1, -1))
        internal val ROOK_DIRS = arrayOf(intArrayOf(1, 0), intArrayOf(-1, 0), intArrayOf(0, 1), intArrayOf(0, -1))
        internal val BISHOP_DIRS = arrayOf(intArrayOf(1, 1), intArrayOf(1, -1), intArrayOf(-1, 1), intArrayOf(-1, -1))

        /** ANDed into the rights whenever a piece leaves or arrives on a square. */
        private val CASTLE_MASK = IntArray(64) { 15 }.also {
            it[0] = 15 and 2.inv(); it[7] = 15 and 1.inv(); it[4] = 15 and 3.inv()
            it[56] = 15 and 8.inv(); it[63] = 15 and 4.inv(); it[60] = 15 and 12.inv()
        }

        fun move(from: Int, to: Int, promo: Int = 0, flags: Int = 0): Int =
            from or (to shl 6) or (promo shl 12) or (flags shl 16)

        fun fromSq(m: Int): Int = m and 63
        fun toSq(m: Int): Int = (m shr 6) and 63
        fun promo(m: Int): Int = (m shr 12) and 7
        fun flags(m: Int): Int = (m shr 16) and 15

        fun squareName(sq: Int): String = "" + FILES[sq % 8] + RANKS[sq / 8]

        fun squareOf(name: String): Int {
            if (name.length != 2) return -1
            val f = FILES.indexOf(name[0]); val r = RANKS.indexOf(name[1])
            return if (f < 0 || r < 0) -1 else r * 8 + f
        }

        fun start(): ChessPosition = fromFen(START_FEN)

        /** Parse a FEN string. Throws [IllegalArgumentException] on nonsense. */
        fun fromFen(fen: String): ChessPosition {
            val parts = fen.trim().split(Regex("\\s+"))
            require(parts.size >= 4) { "Not a FEN position." }
            val board = IntArray(64)
            val rows = parts[0].split('/')
            require(rows.size == 8) { "Not a FEN position." }
            for ((i, row) in rows.withIndex()) {
                val r = 7 - i
                var f = 0
                for (ch in row) {
                    if (ch.isDigit()) { f += ch - '0'; continue }
                    val kind = LETTERS.indexOf(ch.uppercaseChar())
                    require(kind > 0 && f < 8) { "Not a FEN position." }
                    board[r * 8 + f] = if (ch.isUpperCase()) kind else -kind
                    f++
                }
                require(f == 8) { "Not a FEN position." }
            }
            val p = ChessPosition(board)
            p.side = if (parts[1] == "b") -1 else 1
            var rights = 0
            if ('K' in parts[2]) rights = rights or 1
            if ('Q' in parts[2]) rights = rights or 2
            if ('k' in parts[2]) rights = rights or 4
            if ('q' in parts[2]) rights = rights or 8
            p.castling = rights
            p.epSquare = if (parts[3] == "-") -1 else squareOf(parts[3])
            p.halfmove = parts.getOrNull(4)?.toIntOrNull() ?: 0
            p.fullmove = parts.getOrNull(5)?.toIntOrNull() ?: 1
            p.rehash()
            return p
        }

        /** Count leaf nodes of the legal move tree - the standard check on a move generator. */
        fun perft(position: ChessPosition, depth: Int): Long {
            if (depth == 0) return 1
            val moves = IntList()
            position.pseudoMoves(moves)
            val us = position.side
            var nodes = 0L
            for (i in 0 until moves.size) {
                position.make(moves[i])
                if (!position.inCheck(us)) nodes += if (depth == 1) 1 else perft(position, depth - 1)
                position.unmake()
            }
            return nodes
        }
    }
}

/** Random keys for position hashing. Fixed seed, so a hash means the same thing every run. */
internal object Zobrist {
    private val rng = java.util.Random(0x5EEDBEEBL)
    private val PIECES = LongArray(13 * 64) { rng.nextLong() }
    val CASTLE = LongArray(16) { rng.nextLong() }
    val EP = LongArray(8) { rng.nextLong() }
    val SIDE = rng.nextLong()
    fun piece(p: Int, sq: Int): Long = PIECES[(p + 6) * 64 + sq]
}

/** A growable int list with no boxing - move lists are built millions of times. */
class IntList(capacity: Int = 48) {
    private var data = IntArray(capacity)
    var size = 0
        private set

    fun add(v: Int) {
        if (size == data.size) data = data.copyOf(size * 2)
        data[size++] = v
    }

    operator fun get(i: Int): Int = data[i]
    operator fun set(i: Int, v: Int) { data[i] = v }
    fun clear() { size = 0 }
    fun contains(v: Int): Boolean { for (i in 0 until size) if (data[i] == v) return true; return false }
    fun toList(): List<Int> = List(size) { data[it] }
}

internal class LongArrayList {
    private var data = LongArray(64)
    var size = 0
        private set

    fun add(v: Long) {
        if (size == data.size) data = data.copyOf(size * 2)
        data[size++] = v
    }

    operator fun get(i: Int): Long = data[i]
    fun removeLast() { if (size > 0) size-- }
    fun clear() { size = 0 }
}
