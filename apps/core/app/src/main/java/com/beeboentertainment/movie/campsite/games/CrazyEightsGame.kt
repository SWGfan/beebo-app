package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Crazy Eights - match the rank or the suit on top, eights are wild and name a new suit,
 * and the first player with an empty hand wins.
 *
 * A traditional game from long before anybody printed a boxed version of it. Nothing in
 * here is borrowed from any boxed version: no skips, no reverses, no draw-twos. Plain
 * Crazy Eights is quicker to explain to a back seat anyway.
 *
 * DRAWING: you draw only when nothing in your hand will go, and you draw one card. If
 * that card plays, it is still your turn and you play it; if it does not, your turn
 * moves on by itself. Without the first half of that rule a player could sit and draw
 * for ever and nobody else would get a go; without the second half they would have to
 * find a Pass button after every dud draw.
 *
 * Private state is one thing only - your hand. The top of the discard pile, the suit in
 * force, the size of the stock and how many cards everybody is holding are all things you
 * can see across a table, so they go to everybody including a spectator.
 */
internal object CrazyEightsGame : CampsiteGame {
    override val id = "crazy8s"
    override val title = "Crazy Eights"
    override val blurb = "Match the suit or the rank. Eights are wild."
    override val kind = "grid"
    override val seats = Seats.of(2, 6)
    override val category = GameCategory.CARD

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    override fun botMove(match: GameMatch, playerId: String, random: kotlin.random.Random): GameMove? =
        (match as? Match)?.botPlay(playerId, random)

    private class Match(players: List<String>, ctx: MatchContext) : CardMatch(players, ctx) {

        private val stock = Cards.deck(ctx.random)

        /** Face up, everybody sees it. The last entry is the top card. */
        private val discard = mutableListOf<Card>()

        /** The suit in force. Normally the top card's own suit; an eight changes it. */
        private var activeSuit: Suit

        /** Consecutive passes, so a table that genuinely cannot move does not sit there forever. */
        private var passes = 0

        init {
            val dealt = if (players.size == 2) 7 else 5
            players.forEach { Cards.deal(stock, hand(it), dealt) }
            // The starter must not be an eight: a wild card on the table with nobody to have
            // named a suit is a rule argument waiting to happen.
            val start = stock.indexOfFirst { it.rank != Rank.EIGHT }
            val first = stock.removeAt(if (start >= 0) start else 0)
            discard.add(first)
            activeSuit = first.suit
            note("Starting card " + first.label + ".")
            announceTurn()
        }

        private fun top(): Card = discard.last()

        /** The rule, in one place, so the phone's idea of legality can never be the one that counts. */
        private fun playable(card: Card): Boolean =
            card.rank == Rank.EIGHT || card.suit == activeSuit || card.rank == top().rank

        /** When the stock runs dry, the pile minus its face-up top card is shuffled back. */
        private fun replenish() {
            if (stock.isNotEmpty() || discard.size <= 1) return
            val recycled = discard.subList(0, discard.size - 1)
            val cards = recycled.toList()
            recycled.clear()
            stock.addAll(cards.shuffled(ctx.random))
            note("The pile was shuffled back into the deck.")
        }

        override fun onApply(move: GameMove) {
            require(phase == "playing") { "This hand has finished." }
            require(players.getOrNull(turnIndex) == move.playerId) { "It's not your turn yet." }
            when (move.action) {
                "play" -> playCard(move)
                "draw" -> drawCard(move)
                "pass" -> passTurn(move)
                else -> throw IllegalArgumentException("Play a card, draw one, or pass.")
            }
        }

        private fun playCard(move: GameMove) {
            val card = heldCard(move.playerId, move.text("card"))
            require(playable(card)) {
                "That card doesn't match " + top().label + " or " + activeSuit.label + "."
            }
            hand(move.playerId).remove(card)
            discard.add(card)
            passes = 0
            if (card.rank == Rank.EIGHT) {
                val chosen = Suit.of(move.text("suit"))
                    ?: throw IllegalArgumentException("Choose a suit for your eight.")
                activeSuit = chosen
                note(name(move.playerId) + " played " + card.label + " and called " + chosen.label + ".")
            } else {
                activeSuit = card.suit
                note(name(move.playerId) + " played " + card.label + ".")
            }
            if (hand(move.playerId).isEmpty()) {
                award(move.playerId, 1)
                prompt = name(move.playerId) + " played their last card."
                settleWinner(move.playerId)
                return
            }
            advance()
        }

        private fun drawCard(move: GameMove) {
            // Holding something legal means play it, not draw. This check is what stops a
            // player taking card after card while the rest of the table waits.
            require(hand(move.playerId).none { playable(it) }) {
                "You have a card you can play - play that instead of drawing."
            }
            replenish()
            require(stock.isNotEmpty()) { "There are no cards left to draw - tap Pass." }
            val drawn = stock.drawTop()
                ?: throw IllegalArgumentException("There are no cards left to draw - tap Pass.")
            hand(move.playerId).add(drawn)
            passes = 0
            // The card drawn is NOT logged. Everybody may see that a card was taken; only its
            // owner may see which one.
            note(name(move.playerId) + " drew a card.")
            if (playable(drawn)) {
                // It goes, so it is still their turn and the only legal move is to play it:
                // the guard above refuses a second draw and passTurn refuses a pass.
                prompt = name(move.playerId) + " drew a card they can play."
                return
            }
            // A dud draw is the end of the turn. One card per turn, and nobody has to find a
            // Pass button to hand the turn on.
            advance()
        }

        private fun passTurn(move: GameMove) {
            replenish()
            // Order matters for the message: if they are holding something legal, say that,
            // rather than telling them to draw a card they do not need.
            require(hand(move.playerId).none { playable(it) }) { "You have a card you can play." }
            require(stock.isEmpty()) { "You can still draw a card - try that first." }
            passes++
            note(name(move.playerId) + " couldn't go.")
            if (passes >= players.size) {
                stopOnCounts("Nobody could move.")
                return
            }
            advance()
        }

        private fun advance() {
            turnIndex = (turnIndex + 1) % players.size
            announceTurn()
        }

        private fun announceTurn() {
            prompt = name(players[turnIndex]) + " to play on " + top().label +
                " (" + activeSuit.label + ")."
        }

        /** A jammed or abandoned hand is decided the way players decide one: fewest cards left. */
        private fun stopOnCounts(why: String) {
            val fewest = players.minOf { hand(it).size }
            val leaders = players.filter { hand(it).size == fewest }
            if (leaders.size == 1) {
                award(leaders.first(), 1)
                winner = leaders.first()
                settle(MatchResult(Outcome.WINNER, leaders.first(), scores.toMap(), why + " Fewest cards wins."))
            } else {
                settleDraw(why + " Nobody was ahead.")
            }
        }

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val fewest = players.minOf { hand(it).size }
            val leaders = players.filter { hand(it).size == fewest }
            return if (leaders.size == 1) {
                MatchResult(Outcome.WINNER, leaders.first(), scores.toMap(), "Stopped - fewest cards left wins.")
            } else {
                MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped with nobody ahead.")
            }
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // Private: this viewer's own hand, plus which of those cards are legal right now.
            // The legality list is computed from the viewer's own cards and the public top
            // card, so it tells them nothing they could not work out themselves.
            putPrivateHand(viewer)
            val mine = viewer?.let { hands[it] }.orEmpty()
            put("playable", JsonArray(mine.filter { playable(it) }.map { JsonPrimitive(it.code) }))
            // A draw is only on offer when nothing in the hand will go - the same rule drawCard
            // enforces, so the page never shows a button the host would refuse.
            put("canDraw", mine.none { playable(it) } && (stock.isNotEmpty() || discard.size > 1))
            put("mustPass", mine.isNotEmpty() && mine.none { playable(it) } && stock.isEmpty() && discard.size <= 1)
            // Public: the table.
            putCounts()
            put("top", top().toJson())
            put("suit", activeSuit.code.toString())
            put("suitLabel", activeSuit.label)
            put("suitSymbol", activeSuit.symbol)
            put("stock", stock.size)
            put("pile", discard.size)
        }

        /**
         * A bot with a little sense: play the dearest card that matches, because a high card
         * left in your hand is what loses you the round; keep an eight back until nothing else
         * will go, and then call the suit it is longest in. It only ever names a card from its
         * own hand, which the host re-checks anyway.
         */
        fun botPlay(playerId: String, random: Random): GameMove? {
            if (phase != "playing") return null
            if (players.getOrNull(turnIndex) != playerId) return null
            val mine = hands[playerId].orEmpty()
            val legal = mine.filter { playable(it) }
            val plain = legal.filter { it.rank != Rank.EIGHT }
            if (plain.isNotEmpty()) {
                val dearest = plain.maxOf { it.rank.value }
                val card = plain.filter { it.rank.value == dearest }.random(random)
                return GameMove(playerId, "play", buildJsonObject { put("card", card.code) })
            }
            val eight = legal.firstOrNull { it.rank == Rank.EIGHT }
            if (eight != null) {
                val rest = mine.filter { it.rank != Rank.EIGHT }
                val suit = rest.groupBy { it.suit }.maxByOrNull { it.value.size }?.key
                    ?: Suit.values().toList().random(random)
                return GameMove(
                    playerId,
                    "play",
                    buildJsonObject {
                        put("card", eight.code)
                        put("suit", suit.code.toString())
                    },
                )
            }
            if (stock.isNotEmpty() || discard.size > 1) {
                return GameMove(playerId, "draw", buildJsonObject { })
            }
            return GameMove(playerId, "pass", buildJsonObject { })
        }
    }
}
