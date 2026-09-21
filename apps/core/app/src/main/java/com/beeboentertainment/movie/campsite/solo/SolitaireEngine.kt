package com.beeboentertainment.movie.campsite.solo

import com.beeboentertainment.movie.campsite.games.GameCategory
import com.beeboentertainment.movie.campsite.games.SoloGame
import kotlinx.serialization.Serializable
import kotlin.random.Random

internal val SOLITAIRE_GAME = SoloGame(
    id = "solitaire",
    title = "Solitaire",
    blurb = "Classic Klondike patience. Build the four suits from Ace to King.",
    emoji = "🃏",
    category = GameCategory.CARD,
    howToPlay = listOf(
        "Goal: move all 52 cards onto the four foundation piles at the top right, one pile per suit, from Ace up to King.",
        "In the seven columns, build downwards in alternating colours: a red 6 on a black 7, for example. You can move a run of face-up cards together. Only a King (or a run starting with a King) can go into an empty column.",
        "Tap the deck at the top left to turn over cards (one or three at a time, your choice). When it runs out, tap it again to turn the pile back over.",
        "Tap a card to send it to the best place it can go, or drag it where you want it. Undo takes back a move.",
        "When every card is face up and the deck is empty, Finish plays the rest for you.",
        "Scoring: Standard gives points for good moves and never ends. Vegas style starts at −52 and pays 5 points per card on the foundations, with a limited number of passes through the deck. It is only points - nothing is ever bought or paid.",
    ),
    needsTouch = true,
)

/** A card as 0..51: suit * 13 + (rank - 1). Suits: 0 clubs, 1 diamonds, 2 hearts, 3 spades. */
internal object Card {
    fun suit(card: Int) = card / 13
    fun rank(card: Int) = card % 13 + 1
    fun red(card: Int) = suit(card) == 1 || suit(card) == 2
    fun of(suit: Int, rank: Int) = suit * 13 + rank - 1
    private val RANKS = listOf("A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K")
    private val SUITS = listOf("♣", "♦", "♥", "♠")
    private val SUIT_NAMES = listOf("clubs", "diamonds", "hearts", "spades")
    fun rankLabel(card: Int) = RANKS[rank(card) - 1]
    fun suitLabel(card: Int) = SUITS[suit(card)]
    fun spoken(card: Int) = "${listOf("Ace", "2", "3", "4", "5", "6", "7", "8", "9", "10", "Jack", "Queen", "King")[rank(card) - 1]} of ${SUIT_NAMES[suit(card)]}"
}

@Serializable
internal enum class Scoring { STANDARD, VEGAS }

/** Where a card or run is. [index] is the column, or the foundation, depending on [kind]. */
internal sealed interface Spot {
    object Waste : Spot
    data class Tableau(val column: Int) : Spot
    data class Foundation(val pile: Int) : Spot
}

/**
 * One Klondike game, immutable. Every move returns a new state (or null when illegal), so
 * undo is simply the previous state and a save is simply this object.
 *
 * Each tableau column is a list bottom-to-top, and [faceDown] says how many of its bottom
 * cards are still face down.
 */
@Serializable
internal data class Klondike(
    val stock: List<Int>,
    val waste: List<Int> = emptyList(),
    val foundations: List<List<Int>> = List(4) { emptyList() },
    val tableau: List<List<Int>>,
    val faceDown: List<Int>,
    val drawCount: Int = 1,
    val scoring: Scoring = Scoring.STANDARD,
    val score: Int = 0,
    val moves: Int = 0,
    /** How many times the waste has been turned back into the stock. */
    val redeals: Int = 0,
) {
    val won: Boolean get() = foundations.sumOf { it.size } == 52

    /** Vegas: one pass with draw one, three passes with draw three. Standard: unlimited. */
    val redealsAllowed: Int get() = if (scoring == Scoring.VEGAS) (if (drawCount == 1) 0 else 2) else Int.MAX_VALUE
    val canRedeal: Boolean get() = stock.isEmpty() && waste.isNotEmpty() && redeals < redealsAllowed

    fun allCards(): List<Int> = stock + waste + foundations.flatten() + tableau.flatten()

    // ---- rules ----

    fun canStackOnTableau(card: Int, column: Int): Boolean {
        val pile = tableau[column]
        if (pile.isEmpty()) return Card.rank(card) == 13
        val top = pile.last()
        if (pile.size <= faceDown[column]) return false
        return Card.red(top) != Card.red(card) && Card.rank(top) == Card.rank(card) + 1
    }

    fun canMoveToFoundation(card: Int, pile: Int): Boolean {
        val f = foundations[pile]
        if (f.isEmpty()) return Card.rank(card) == 1
        val top = f.last()
        return Card.suit(top) == Card.suit(card) && Card.rank(card) == Card.rank(top) + 1
    }

    /** Aces go to the first empty foundation; after that a suit keeps its pile. */
    fun foundationFor(card: Int): Int {
        foundations.forEachIndexed { i, f -> if (f.isNotEmpty() && Card.suit(f[0]) == Card.suit(card)) return i }
        return foundations.indexOfFirst { it.isEmpty() }
    }

    /** True when [count] top cards of [column] are face up and form a valid descending, alternating run. */
    fun isMovableRun(column: Int, count: Int): Boolean {
        val pile = tableau[column]
        if (count < 1 || count > pile.size - faceDown[column]) return false
        val run = pile.takeLast(count)
        for (k in 0 until run.size - 1) {
            if (Card.red(run[k]) == Card.red(run[k + 1]) || Card.rank(run[k]) != Card.rank(run[k + 1]) + 1) return false
        }
        return true
    }

    // ---- moves (null = not allowed) ----

    fun draw(): Klondike? {
        if (stock.isNotEmpty()) {
            val n = minOf(drawCount, stock.size)
            val taken = stock.takeLast(n).reversed()
            return copy(stock = stock.dropLast(n), waste = waste + taken, moves = moves + 1)
        }
        if (!canRedeal) return null
        val penalty = if (scoring == Scoring.STANDARD && drawCount == 1) 100 else 0
        return copy(
            stock = waste.reversed(), waste = emptyList(), redeals = redeals + 1, moves = moves + 1,
            score = if (scoring == Scoring.STANDARD) maxOf(0, score - penalty) else score,
        )
    }

    fun move(from: Spot, count: Int, to: Spot): Klondike? {
        if (from == to) return null
        val cards: List<Int> = when (from) {
            Spot.Waste -> if (count == 1 && waste.isNotEmpty()) listOf(waste.last()) else return null
            is Spot.Foundation -> if (count == 1 && foundations[from.pile].isNotEmpty()) listOf(foundations[from.pile].last()) else return null
            is Spot.Tableau -> if (isMovableRun(from.column, count)) tableau[from.column].takeLast(count) else return null
        }
        val first = cards.first()
        when (to) {
            Spot.Waste -> return null
            is Spot.Foundation -> if (cards.size != 1 || !canMoveToFoundation(first, to.pile)) return null
            is Spot.Tableau -> if (!canStackOnTableau(first, to.column)) return null
        }

        val newWaste = if (from == Spot.Waste) waste.dropLast(1) else waste
        val f = foundations.map { it.toMutableList() }.toMutableList()
        val t = tableau.map { it.toMutableList() }.toMutableList()
        val down = faceDown.toMutableList()
        when (from) {
            is Spot.Foundation -> f[from.pile].removeAt(f[from.pile].size - 1)
            is Spot.Tableau -> repeat(count) { t[from.column].removeAt(t[from.column].size - 1) }
            else -> {}
        }
        var flipped = false
        if (from is Spot.Tableau) {
            val col = from.column
            if (t[col].isNotEmpty() && down[col] >= t[col].size) { down[col] = t[col].size - 1; flipped = true }
            if (t[col].isEmpty()) down[col] = 0
        }
        when (to) {
            is Spot.Foundation -> f[to.pile].addAll(cards)
            is Spot.Tableau -> t[to.column].addAll(cards)
            else -> {}
        }
        var points = 0
        if (scoring == Scoring.STANDARD) {
            points += when {
                from == Spot.Waste && to is Spot.Tableau -> 5
                from == Spot.Waste && to is Spot.Foundation -> 10
                from is Spot.Tableau && to is Spot.Foundation -> 10
                from is Spot.Foundation && to is Spot.Tableau -> -15
                else -> 0
            }
            if (flipped) points += 5
        } else {
            if (to is Spot.Foundation) points += 5
            if (from is Spot.Foundation) points -= 5
        }
        val newScore = if (scoring == Scoring.STANDARD) maxOf(0, score + points) else score + points
        return copy(waste = newWaste, foundations = f, tableau = t, faceDown = down, moves = moves + 1, score = newScore)
    }

    /**
     * Tap-to-move: the best legal destination for the card (or run starting at [count]
     * from the top) at [from]. Foundations first, then a column with cards, then an empty
     * column - but a King already at the bottom of a column is not shuffled to another
     * empty one.
     */
    fun autoMove(from: Spot, count: Int): Klondike? {
        if (count == 1) {
            for (p in 0 until 4) move(from, 1, Spot.Foundation(p))?.let { return it }
        }
        val occupied = (0 until 7).filter { tableau[it].isNotEmpty() }
        for (c in occupied) move(from, count, Spot.Tableau(c))?.let { return it }
        val wholeColumn = from is Spot.Tableau && faceDown[from.column] == 0 && tableau[from.column].size == count
        if (!wholeColumn) {
            for (c in (0 until 7).filter { tableau[it].isEmpty() }) move(from, count, Spot.Tableau(c))?.let { return it }
        }
        return null
    }

    /** Every card is face up and nothing is left to draw: the rest is just putting cards away. */
    val canAutoFinish: Boolean get() = !won && stock.isEmpty() && waste.isEmpty() && faceDown.all { it == 0 }

    /** One step of the auto-finish: the lowest card that can go to a foundation. */
    fun autoFinishStep(): Klondike? {
        val sources = (0 until 7).filter { tableau[it].isNotEmpty() }.map { Spot.Tableau(it) as Spot } +
            listOfNotNull(if (waste.isNotEmpty()) Spot.Waste else null)
        val ordered = sources.sortedBy { s -> Card.rank(if (s is Spot.Tableau) tableau[s.column].last() else waste.last()) }
        for (s in ordered) for (p in 0 until 4) move(s, 1, Spot.Foundation(p))?.let { return it }
        return null
    }

    companion object {
        fun deal(random: Random, drawCount: Int = 1, scoring: Scoring = Scoring.STANDARD): Klondike {
            val deck = (0 until 52).shuffled(random).toMutableList()
            val tableau = (0 until 7).map { c -> List(c + 1) { deck.removeAt(deck.size - 1) } }
            return Klondike(
                stock = deck.toList(),
                tableau = tableau,
                faceDown = List(7) { it },
                drawCount = drawCount,
                scoring = scoring,
                score = if (scoring == Scoring.VEGAS) -52 else 0,
            )
        }
    }
}

@Serializable
internal data class SolitaireSave(val game: Klondike, val elapsedMs: Long = 0L, val counted: Boolean = false, val undoCount: Int = 0)

@Serializable
internal data class SolitaireStats(
    val played: Int = 0,
    val won: Int = 0,
    val bestMs: Long = 0L,
    val fewestMoves: Int = 0,
    val bestStandard: Int = 0,
    val bestVegas: Int = Int.MIN_VALUE,
) {
    fun started() = copy(played = played + 1)
    fun finished(game: Klondike, ms: Long) = copy(
        won = won + 1,
        bestMs = if (bestMs == 0L) ms else minOf(bestMs, ms),
        fewestMoves = if (fewestMoves == 0) game.moves else minOf(fewestMoves, game.moves),
        bestStandard = if (game.scoring == Scoring.STANDARD) maxOf(bestStandard, game.score) else bestStandard,
        bestVegas = if (game.scoring == Scoring.VEGAS) maxOf(bestVegas, game.score) else bestVegas,
    )
}
