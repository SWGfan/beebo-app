package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * One suit of a standard deck.
 *
 * [code] is the single letter that travels on the wire, [symbol] is what a phone
 * draws. Keeping the two apart matters: the wire value has to survive a JSON round
 * trip and an old browser font, the drawn one has to look like a playing card.
 */
internal enum class Suit(val code: Char, val symbol: String, val label: String) {
    CLUBS('C', "♣", "Clubs"),
    DIAMONDS('D', "♦", "Diamonds"),
    HEARTS('H', "♥", "Hearts"),
    SPADES('S', "♠", "Spades");

    val red: Boolean get() = this == DIAMONDS || this == HEARTS

    companion object {
        fun of(code: Char): Suit? {
            val upper = code.uppercaseChar()
            return values().firstOrNull { it.code == upper }
        }

        fun of(text: String): Suit? = text.trim().firstOrNull()?.let { of(it) }
    }
}

/**
 * One rank.
 *
 * [value] is Ace-high, which is what War compares and what the Crazy Eights bot uses
 * to decide which card is the expensive one to be holding. Games that want Ace-low
 * are free to ignore it - nothing in here decides a rule on its own.
 *
 * [one] and [many] exist so a log line can read "Ben asked Amy for Queens" instead of
 * "asked for Q", because the log is the bit of the screen a five year old reads out.
 */
internal enum class Rank(
    val code: Char,
    val short: String,
    val one: String,
    val many: String,
    val value: Int,
) {
    TWO('2', "2", "Two", "Twos", 2),
    THREE('3', "3", "Three", "Threes", 3),
    FOUR('4', "4", "Four", "Fours", 4),
    FIVE('5', "5", "Five", "Fives", 5),
    SIX('6', "6", "Six", "Sixes", 6),
    SEVEN('7', "7", "Seven", "Sevens", 7),
    EIGHT('8', "8", "Eight", "Eights", 8),
    NINE('9', "9", "Nine", "Nines", 9),
    TEN('T', "10", "Ten", "Tens", 10),
    JACK('J', "J", "Jack", "Jacks", 11),
    QUEEN('Q', "Q", "Queen", "Queens", 12),
    KING('K', "K", "King", "Kings", 13),
    ACE('A', "A", "Ace", "Aces", 14);

    companion object {
        fun of(code: Char): Rank? {
            val upper = code.uppercaseChar()
            return values().firstOrNull { it.code == upper }
        }

        /** Accepts "Q", "q", "10", "T" and "Queens" - a phone should never be able to typo its way to a crash. */
        fun of(text: String): Rank? {
            val t = text.trim().uppercase()
            return when {
                t.isEmpty() -> null
                t == "10" -> TEN
                t.length == 1 -> of(t[0])
                else -> values().firstOrNull { it.one.uppercase() == t || it.many.uppercase() == t }
            }
        }
    }
}

/**
 * One card.
 *
 * A data class on purpose: a deck holds no duplicates, so equality by rank and suit is
 * the same thing as identity, and "does this player actually hold that card" is a
 * plain `contains` instead of an index a phone could have made up.
 */
internal data class Card(val rank: Rank, val suit: Suit) {

    /** Compact wire form: rank letter then suit letter, "QH", "TS", "8D". Two bytes. */
    val code: String get() = "" + rank.code + suit.code

    /** What a human reads: "Q♥". */
    val label: String get() = rank.short + suit.symbol

    /**
     * The shape a phone gets. [code] is what it sends back when tapped, the rest is
     * only for drawing - a page must never have to parse the code to render a card.
     */
    fun toJson(): JsonObject = buildJsonObject {
        put("code", code)
        put("label", label)
        put("rank", rank.short)
        put("suit", suit.code.toString())
        put("red", suit.red)
    }
}

/**
 * Take the top card, or null when the pile is empty.
 *
 * WHY not `removeFirstOrNull()`: on Android that stdlib name collides with the Java 21
 * SequencedCollection method and blows up at runtime on older devices. `removeAt(0)` is
 * boring and works everywhere, which is the whole requirement for a deck of cards.
 */
internal fun MutableList<Card>.drawTop(): Card? = if (isEmpty()) null else removeAt(0)

/**
 * Public seat information, in one place so five games publish it the same way.
 *
 * How many cards somebody is holding is public in every one of these games - you can
 * see a fan of cards across a tent - so it is safe for a spectator and for a bracket
 * cell. WHAT those cards are never comes through here.
 */
internal fun JsonObjectBuilder.putSeatCounts(players: List<String>, sizeOf: (String) -> Int) {
    put("seats", JsonArray(players.map { JsonPrimitive(it) }))
    put("counts", JsonArray(players.map { JsonPrimitive(sizeOf(it)) }))
}

/**
 * The deck itself.
 *
 * Every shuffle in every card game goes through here with the host's [MatchContext.random].
 * That is not tidiness: it is the reason no phone can predict or influence a deal. A guest
 * supplies taps and nothing else.
 */
internal object Cards {

    /** All fifty-two, in a fixed order. Never handed out unshuffled to a player. */
    val FULL: List<Card> = Suit.values().flatMap { suit -> Rank.values().map { rank -> Card(rank, suit) } }

    /**
     * A shuffled deck, optionally with cards taken out or extra ones put in.
     *
     * [remove] is why this parameter exists at all: Old Maid needs the fifty-one card
     * deck with one queen gone, and doing that here keeps the "which queen" decision in
     * the game that cares instead of in a second copy of the deck code. [add] is the
     * other direction - a joker, or a second deck for a big table.
     */
    fun deck(
        random: Random,
        remove: Collection<Card> = emptyList(),
        add: Collection<Card> = emptyList(),
    ): MutableList<Card> {
        val base = if (remove.isEmpty()) FULL else FULL - remove.toSet()
        return (base + add).shuffled(random).toMutableList()
    }

    /** Parse a wire code back to a card, or null. Never throws: callers word their own refusal. */
    fun card(code: String): Card? {
        val t = code.trim().uppercase()
        return when (t.length) {
            2 -> {
                val rank = Rank.of(t[0])
                val suit = Suit.of(t[1])
                if (rank == null || suit == null) null else Card(rank, suit)
            }
            3 -> if (t.startsWith("10")) Suit.of(t[2])?.let { Card(Rank.TEN, it) } else null
            else -> null
        }
    }

    /** A list of cards as the page wants them. */
    fun json(cards: List<Card>): JsonArray = JsonArray(cards.map { it.toJson() })

    /** "Q♥ 7♠" - for a log line, never for a hand a rule depends on. */
    fun labels(cards: List<Card>): String = cards.joinToString(" ") { it.label }

    /** A tidy fan: suits together, low to high inside a suit. Cosmetic only. */
    fun sorted(cards: List<Card>): List<Card> =
        cards.sortedWith(compareBy({ it.suit.ordinal }, { it.rank.ordinal }))

    /** Deal [count] off the top of [from] into [to]. Stops quietly if the deck runs dry. */
    fun deal(from: MutableList<Card>, to: MutableList<Card>, count: Int) {
        repeat(count) { from.drawTop()?.let { to.add(it) } }
    }
}
