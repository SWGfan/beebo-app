package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Old Maid - one queen is taken out of the deck, pairs are thrown away, and whoever is
 * left holding the odd queen at the end loses.
 *
 * The deck is built with the Queen of Clubs removed, which leaves the two red queens to
 * pair each other and the Queen of Spades with nobody. That is the Old Maid. Taking the
 * card out here rather than dealing round it is why the shared deck helper takes a
 * removal list at all.
 *
 * Privacy has a second face in this game. Your own hand is private from everybody else,
 * as always - but the hand you draw FROM is private from you as well, which is the whole
 * point of the draw. So the neighbour's cards appear in nobody's snapshot except the
 * neighbour's own; the drawer is told a number of cards and taps a position.
 *
 * WHO WINS: Old Maid only really names a loser, and with two players that is enough. With
 * three or more, "everybody but the loser" is not a result a bracket can advance, so the
 * round places players in the order they got rid of their last card: first out wins,
 * then second out, and so on down to the one cornered with the queen. The scores carry
 * that order, so the top score is always one person and never a tie.
 */
internal object OldMaidGame : CampsiteGame {
    override val id = "oldmaid"
    override val title = "Old Maid"
    override val blurb = "Throw away pairs. Don't be left with the odd queen."
    override val kind = "grid"
    override val seats = Seats.of(2, 6)
    override val category = GameCategory.CARD

    /** The queen that leaves the deck. The one left unpaired is the Queen of Spades. */
    private val REMOVED = Card(Rank.QUEEN, Suit.CLUBS)

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    override fun botMove(match: GameMatch, playerId: String, random: kotlin.random.Random): GameMove? =
        (match as? Match)?.botDraw(playerId, random)

    private class Match(players: List<String>, ctx: MatchContext) : CardMatch(players, ctx) {

        /** How many pairs each seat has thrown away. Public - they land face up. */
        private val pairs = linkedMapOf<String, Int>()

        /**
         * Who emptied their hand, in the order it happened. This is the finishing order:
         * the head of the list won the round. It is filled only through [markOut] so a
         * player is placed once, at the moment their last card went.
         */
        private val out = mutableListOf<String>()

        init {
            players.forEach { pairs[it] = 0 }
            val deck = Cards.deck(ctx.random, remove = listOf(REMOVED))
            // Round robin, so an uneven deal is spread rather than dumped on the last seat.
            var seat = 0
            while (deck.isNotEmpty()) {
                deck.drawTop()?.let { hand(players[seat % players.size]).add(it) }
                seat++
            }
            // A hand that pairs off completely on the deal is out before anybody has drawn.
            // Two such hands are placed in seat order - it is the only order there is.
            players.forEach {
                discardPairs(it)
                markOut(it)
            }
            if (!checkEnd()) {
                nextHolder(players.size - 1)?.let { turnIndex = it }
                announceTurn()
            }
        }

        override fun onApply(move: GameMove) {
            require(move.action == "draw") { "Tap one of your neighbour's cards." }
            require(phase == "playing") { "This hand has finished." }
            require(players.getOrNull(turnIndex) == move.playerId) { "It's not your turn yet." }

            val targetSeat = nextHolder(turnIndex)
                ?: throw IllegalArgumentException("There is nobody left to draw from.")
            val target = players[targetSeat]
            require(target != move.playerId) { "You are the only one still holding cards." }

            val offered = hand(target)
            // The fan is shuffled before it is offered. A phone can only send a position, and
            // the position must mean nothing: if the order stayed put, a player who drew twice
            // could work out where the queen is not, which a real fan never lets you do.
            offered.shuffle(ctx.random)

            val index = move.int("index")
            require(index in offered.indices) { "Tap one of the face-down cards." }
            val taken = offered.removeAt(index)
            hand(move.playerId).add(taken)
            // The card taken is never named in the log: the drawer can see it in their own
            // hand a moment later, and nobody else is entitled to know what moved.
            note(name(move.playerId) + " drew from " + name(target) + ".")
            // The neighbour's last card left their hand at the moment it was taken, which is
            // before the drawer could pair it - so if both go out on one draw, the neighbour
            // placed first.
            markOut(target)
            discardPairs(move.playerId)
            markOut(move.playerId)

            if (checkEnd()) return
            // The player who was just drawn from goes next, so the draw travels round the car.
            turnIndex = if (hand(target).isNotEmpty()) targetSeat else (nextHolder(targetSeat) ?: targetSeat)
            announceTurn()
        }

        /** Two of a rank go face up on the table. Three of a rank means one pair and a leftover. */
        private fun discardPairs(playerId: String) {
            val mine = hand(playerId)
            Rank.values().forEach { rank ->
                val same = mine.filter { it.rank == rank }
                val found = same.size / 2
                if (found > 0) {
                    mine.removeAll(same.take(found * 2).toSet())
                    pairs[playerId] = (pairs[playerId] ?: 0) + found
                    note(
                        name(playerId) + " laid down " +
                            (if (found == 1) "a pair of " else found.toString() + " pairs of ") + rank.many + ".",
                    )
                }
            }
        }

        /** Place [playerId] in the finishing order the first time their hand is found empty. */
        private fun markOut(playerId: String) {
            if (hand(playerId).isEmpty() && playerId !in out) {
                out.add(playerId)
                note(name(playerId) + " is out.")
            }
        }

        /**
         * The hand is over when only one player still holds a card, and by arithmetic that
         * card is the odd queen: everything else in a fifty-one card deck pairs up.
         *
         * Scoring is the finishing order turned into points: first out scores one less
         * than the number of players, the next one less again, and the loser nothing. Those
         * are distinct by construction, so [topScorer] always names exactly one person and
         * a heat of three or more has somebody to advance. With two players it comes to
         * the same thing it always did - the survivor scores one, the loser nought.
         */
        private fun checkEnd(): Boolean {
            val holders = players.filter { hand(it).isNotEmpty() }
            if (holders.size > 1) return false
            val loser = holders.firstOrNull()
            // Belt and braces: anybody with an empty hand who somehow was not placed yet is
            // placed now, in seat order, so nobody is left off the scoreboard.
            players.forEach { markOut(it) }
            out.forEachIndexed { place, id -> award(id, players.size - 1 - place) }
            val first = out.firstOrNull()
            prompt = when {
                loser != null && first != null ->
                    name(first) + " got out first. " + name(loser) + " was left with the Old Maid!"
                loser != null -> name(loser) + " was left with the Old Maid!"
                else -> "Every card was paired off."
            }
            // The first out holds the unshared top score, so settleScores names them.
            winner = topScorer()
            settleScores(prompt)
            return true
        }

        private fun announceTurn() {
            val target = nextHolder(turnIndex)?.let { players[it] }
            prompt = if (target == null || target == players[turnIndex]) {
                name(players[turnIndex]) + " to play."
            } else {
                name(players[turnIndex]) + " draws from " + name(target) + "."
            }
        }

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        /**
         * Nobody has lost until somebody is cornered with the queen. A player holding her
         * halfway through very often gets rid of her, so judging a stopped hand by who has
         * her now would be inventing a result the game had not reached.
         */
        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped before anybody was cornered.")

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // Private: your own hand only. Note what is NOT here - the neighbour's cards.
            putPrivateHand(viewer)
            // Public: counts, names, pairs laid down, and who draws from whom next.
            putCounts()
            put("pairs", JsonArray(players.map { JsonPrimitive(pairs[it] ?: 0) }))
            val drawer = players.getOrNull(turnIndex)
            val targetSeat = nextHolder(turnIndex)
            val target = targetSeat?.let { players[it] }
            put("drawer", drawer.orEmpty())
            put("target", if (target != null && target != drawer) target else "")
            put("targetCount", if (target != null && target != drawer) hand(target).size else 0)
            put("maidGone", phase == "done")
        }

        /**
         * There is nothing to be clever about: the draw is blind, so the bot picks a position
         * at random. A bot that peeked at the neighbour's hand would be cheating at a game
         * whose only mechanic is not being able to peek.
         */
        fun botDraw(playerId: String, random: Random): GameMove? {
            if (phase != "playing") return null
            if (players.getOrNull(turnIndex) != playerId) return null
            val targetSeat = nextHolder(turnIndex) ?: return null
            val target = players[targetSeat]
            if (target == playerId) return null
            val size = hands[target]?.size ?: 0
            if (size <= 0) return null
            return GameMove(playerId, "draw", buildJsonObject { put("index", random.nextInt(size)) })
        }
    }
}
