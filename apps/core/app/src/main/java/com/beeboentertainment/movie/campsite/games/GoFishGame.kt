package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Go Fish - ask a named player for a rank, and collect sets of four.
 *
 * The oldest children's card game there is, and the reason this package needed a
 * per-viewer snapshot before it needed anything else: the whole game is "what are you
 * holding", and it is over the moment one phone can read another's hand.
 *
 * What is public here is exactly what is public at a real table: how many cards each
 * player holds, which sets of four have been laid down, who asked whom for what, and
 * whether they got any. What stays private is the hand itself.
 */
internal object GoFishGame : CampsiteGame {
    override val id = "gofish"
    override val title = "Go Fish"
    override val blurb = "Ask for the cards you need and collect sets of four."
    override val kind = "grid"
    override val seats = Seats.of(2, 6)
    override val category = GameCategory.CARD

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    override fun botMove(match: GameMatch, playerId: String, random: kotlin.random.Random): GameMove? =
        (match as? Match)?.botAsk(playerId, random)

    private class Match(players: List<String>, ctx: MatchContext) : CardMatch(players, ctx) {

        /** The host's deck. It never leaves this object; only its size is published. */
        private val stock = Cards.deck(ctx.random)

        /** Sets of four, face up on the table - public, like the real thing. */
        private val books = linkedMapOf<String, MutableList<Rank>>()

        init {
            // Seven cards each for a small table, five when there are more mouths to feed:
            // the traditional deal, and it also keeps the stock alive long enough to matter.
            val dealt = if (players.size <= 3) 7 else 5
            players.forEach { id ->
                books[id] = mutableListOf()
                Cards.deal(stock, hand(id), dealt)
            }
            players.forEach { collectBooks(it) }
            announceTurn()
        }

        override fun onApply(move: GameMove) {
            require(move.action == "ask") { "Pick a player and a rank to ask for." }
            require(phase == "playing") { "This hand has finished." }
            require(players.getOrNull(turnIndex) == move.playerId) { "It's not your turn yet." }

            val target = move.text("target")
            require(target != move.playerId) { "Ask somebody else, not yourself." }
            require(target in players) { "Pick somebody who is playing this hand." }
            require(hand(target).isNotEmpty()) { name(target) + " has no cards left - ask somebody else." }

            val rank = Rank.of(move.text("rank"))
                ?: throw IllegalArgumentException("Pick a rank to ask for.")
            // The real rule, and the one that stops a phone fishing for information: you may
            // only ask for something you are already holding.
            require(hand(move.playerId).any { it.rank == rank }) {
                "You can only ask for a rank you are holding."
            }

            val taken = hand(target).filter { it.rank == rank }
            if (taken.isNotEmpty()) {
                hand(target).removeAll(taken.toSet())
                hand(move.playerId).addAll(taken)
                note(name(move.playerId) + " asked " + name(target) + " for " + rank.many +
                    " and took " + taken.size + ".")
                collectBooks(move.playerId)
                afterMove(keepTurn = true)
            } else {
                note(name(move.playerId) + " asked " + name(target) + " for " + rank.many +
                    ". Go Fish!")
                val drawn = stock.drawTop()
                if (drawn != null) hand(move.playerId).add(drawn)
                collectBooks(move.playerId)
                // Fishing your own wish out of the pond is the one card this game reveals,
                // and the rules are what reveal it: you show it and go again. Nothing else
                // about the draw is ever logged.
                val wished = drawn != null && drawn.rank == rank
                if (wished) note(name(move.playerId) + " fished the " + rank.one + " and goes again.")
                afterMove(keepTurn = wished)
            }
        }

        /** Four of a kind leaves the hand and goes on the table, where everybody can see it. */
        private fun collectBooks(playerId: String) {
            val mine = hand(playerId)
            Rank.values().forEach { rank ->
                val four = mine.filter { it.rank == rank }
                if (four.size == 4) {
                    mine.removeAll(four.toSet())
                    books.getValue(playerId).add(rank)
                    award(playerId, 1)
                    note(name(playerId) + " landed a set of " + rank.many + ".")
                }
            }
        }

        /**
         * Tidy up after a move: top empty hands back up, end the hand if it is over, and
         * make sure whoever is on turn can actually do something. Doing this in one place
         * is what stops the table deadlocking with a player who has nothing to ask with.
         */
        private fun afterMove(keepTurn: Boolean) {
            players.forEach { if (hand(it).isEmpty() && stock.isNotEmpty()) Cards.deal(stock, hand(it), 1) }
            if (books.values.sumOf { it.size } >= 13) {
                finish("Every set of four is home.")
                return
            }
            if (!keepTurn) advance()
            var guard = 0
            while (phase == "playing" && guard++ <= players.size) {
                val me = players[turnIndex]
                if (hand(me).isEmpty()) {
                    advance()
                    continue
                }
                if (players.none { it != me && hand(it).isNotEmpty() }) {
                    finish("There was nobody left to ask.")
                    return
                }
                break
            }
            if (phase == "playing") announceTurn()
        }

        private fun advance() {
            val next = nextHolder(turnIndex)
            if (next == null) finish("Nobody had a card left.") else turnIndex = next
        }

        private fun announceTurn() {
            prompt = name(players[turnIndex]) + " to ask."
        }

        /** Most sets wins. [BaseMatch.winner] is set by hand so the round names its winner on screen. */
        private fun finish(why: String) {
            prompt = why
            winner = topScorer()
            settleScores(why)
        }

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        /**
         * Sets of four already landed are a real, finished thing - unlike a half-built
         * board - so a hand stopped early is honestly scored by them. A hand stopped before
         * anybody booked anything comes out level, which is also honest.
         */
        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(Outcome.SCORES, topScorer(), scores.toMap(), "Stopped with the sets counted.")

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // Private: only the asking viewer's own cards, and the ranks they are allowed
            // to ask for - which is derived from that same hand, so it leaks nothing new.
            putPrivateHand(viewer)
            put(
                "askRanks",
                JsonArray(
                    viewer?.let { hands[it] }.orEmpty()
                        .map { it.rank }.distinct().sortedBy { it.ordinal }
                        .map { JsonPrimitive(it.short) },
                ),
            )
            // Public: counts, names, the stock, the books on the table, and who may be asked.
            putCounts()
            put("stock", stock.size)
            put(
                "books",
                JsonArray(
                    players.map { id ->
                        buildJsonObject {
                            put("player", id)
                            put("name", ctx.nameOf(id))
                            put("ranks", JsonArray(books[id].orEmpty().map { JsonPrimitive(it.short) }))
                        }
                    },
                ),
            )
            put(
                "targets",
                JsonArray(
                    players.filter { it != viewer && (hands[it]?.isNotEmpty() == true) }
                        .map { JsonPrimitive(it) },
                ),
            )
        }

        /**
         * A bot that plays the obvious human line: ask for whatever you hold most of,
         * from whoever is holding the most cards. It reads only its own hand and the public
         * card counts, so it cannot cheat even by accident, and the rank it names is always
         * one it is holding.
         */
        fun botAsk(playerId: String, random: Random): GameMove? {
            if (phase != "playing") return null
            if (players.getOrNull(turnIndex) != playerId) return null
            val mine = hands[playerId].orEmpty()
            if (mine.isEmpty()) return null
            val byRank = mine.groupBy { it.rank }
            val deepest = byRank.values.maxOf { it.size }
            val rank = byRank.filterValues { it.size == deepest }.keys.random(random)
            val targets = players.filter { it != playerId && (hands[it]?.isNotEmpty() == true) }
            if (targets.isEmpty()) return null
            val fattest = targets.maxOf { hands.getValue(it).size }
            val target = targets.filter { hands.getValue(it).size == fattest }.random(random)
            return GameMove(
                playerId,
                "ask",
                buildJsonObject {
                    put("target", target)
                    put("rank", rank.short)
                },
            )
        }
    }
}
