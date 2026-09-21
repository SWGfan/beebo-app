package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*

/**
 * War - both players turn a card, the higher one takes the trick, and a tie means war.
 *
 * WHY THIS ONE IS NOT RANKED. A player of War makes no decisions at all. The deal
 * decides the whole game and the players just turn the cards over. The interface already
 * says a raffle must not count towards the leaderboard, because the champion would end
 * up being whoever was handed the most rounds of it, and War is a raffle that takes ten
 * minutes. So [ranked] is false here, which also makes [tournamentReady] false - a
 * bracket of coin flips is not a tournament. It stays as a free-play game, which is what
 * it is for: something for a five year old to play on a plane that needs no explaining.
 *
 * Both piles are face down and unknown to their own owners, so there is no private hand
 * in this game - only counts, and the two cards currently face up.
 */
internal object WarGame : CampsiteGame {
    override val id = "war"
    override val title = "War"
    override val blurb = "Highest card takes the pile. Ties mean war."
    override val kind = "claim"
    override val seats = Seats.exactly(2)
    override val category = GameCategory.CARD

    /** A journey ends long before a stubborn game of War does, so the host calls it. */
    private const val TRICK_CAP = 300

    /** Cards each player buries face down before a war is decided. */
    private const val WAR_BURIED = 3

    override val ranked = false

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    override fun botMove(match: GameMatch, playerId: String, random: kotlin.random.Random): GameMove? =
        (match as? Match)?.botFlip(playerId)

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {

        /** Face down, secret from everybody including the owner. Only the size is published. */
        private val piles = linkedMapOf<String, MutableList<Card>>()

        /** This trick's turned cards, hidden until both are in so neither is turned "after" the other. */
        private val revealed = linkedMapOf<String, Card>()

        /** The last pair both players saw, kept on screen until the next pair lands. */
        private val shown = linkedMapOf<String, Card>()

        /** Cards on the table waiting to be won, including everything buried by a war. */
        private val stake = mutableListOf<Card>()

        private var tricks = 0
        private var warDepth = 0

        init {
            val deck = Cards.deck(ctx.random)
            players.forEach { piles[it] = mutableListOf() }
            var seat = 0
            while (deck.isNotEmpty()) {
                deck.drawTop()?.let { piles.getValue(players[seat % players.size]).add(it) }
                seat++
            }
            prompt = "Both players turn a card."
        }

        private fun other(playerId: String): String = players.first { it != playerId }

        override fun onApply(move: GameMove) {
            require(phase == "playing") { "This game has finished." }
            require(move.action == "flip") { "Tap Turn Card." }
            require(move.playerId in players) { "You are not playing this game." }
            require(revealed[move.playerId] == null) {
                "You've turned your card - waiting for " + name(other(move.playerId)) + "."
            }
            val pile = piles.getValue(move.playerId)
            if (pile.isEmpty()) {
                // Out of cards is how War ends; it is not a bad move, so it is not an error.
                finishWith(other(move.playerId), name(move.playerId) + " ran out of cards.")
                return
            }
            pile.drawTop()?.let { revealed[move.playerId] = it }
            if (revealed.size < players.size) {
                prompt = "Waiting for " + name(other(move.playerId)) + "."
                return
            }
            resolveTrick()
        }

        private fun resolveTrick() {
            val first = players[0]
            val second = players[1]
            val cardOne = revealed.getValue(first)
            val cardTwo = revealed.getValue(second)
            shown.clear()
            shown[first] = cardOne
            shown[second] = cardTwo
            revealed.clear()
            stake.add(cardOne)
            stake.add(cardTwo)
            tricks++
            when {
                cardOne.rank.value > cardTwo.rank.value -> takeStake(first, cardOne, cardTwo)
                cardTwo.rank.value > cardOne.rank.value -> takeStake(second, cardTwo, cardOne)
                else -> declareWar(cardOne)
            }
        }

        private fun takeStake(taker: String, high: Card, low: Card) {
            note(name(taker) + " won " + high.label + " over " + low.label + " (" + stake.size + " cards).")
            // Shuffled under the pile: an unshuffled pile can loop the same tricks forever.
            val won = stake.toList()
            stake.clear()
            piles.getValue(taker).addAll(won.shuffled(ctx.random))
            warDepth = 0
            val beaten = players.firstOrNull { piles.getValue(it).isEmpty() }
            when {
                beaten != null -> finishWith(other(beaten), name(beaten) + " ran out of cards.")
                tricks >= TRICK_CAP -> stopOnCounts("That is enough War for one journey.")
                else -> prompt = "Both players turn a card."
            }
        }

        private fun declareWar(tied: Card) {
            warDepth++
            note("War! Two " + tied.rank.many + ".")
            players.forEach { id ->
                val pile = piles.getValue(id)
                // Keep one card back to turn over: a war you cannot complete is a war you lost.
                val buried = minOf(WAR_BURIED, maxOf(0, pile.size - 1))
                repeat(buried) { pile.drawTop()?.let { stake.add(it) } }
            }
            val broke = players.firstOrNull { piles.getValue(it).isEmpty() }
            if (broke != null) {
                finishWith(other(broke), name(broke) + " could not fight the war.")
                return
            }
            prompt = "War! Both players turn a card."
        }

        private fun finishWith(champion: String, why: String) {
            prompt = why
            award(champion, 1)
            settleWinner(champion)
        }

        /** Whoever is holding more cards is winning at War; that is the entire measure of it. */
        private fun stopOnCounts(why: String) {
            val counts = holdings()
            val best = counts.values.maxOrNull() ?: 0
            val leaders = counts.filterValues { it == best }.keys
            if (leaders.size == 1) {
                prompt = why
                winner = leaders.first()
                settle(MatchResult(Outcome.WINNER, leaders.first(), counts, why + " Most cards wins."))
            } else {
                prompt = why
                settle(MatchResult(Outcome.DRAW, "", counts, why + " Dead level."))
            }
        }

        /** Cards held, counting the ones you have turned over but not yet won or lost. */
        private fun holdings(): Map<String, Int> =
            players.associateWith { piles.getValue(it).size + (if (revealed[it] != null) 1 else 0) }

        private fun note(line: String) {
            log.add(line)
            while (log.size > 10) log.removeAt(0)
        }

        private fun name(playerId: String): String = ctx.nameOf(playerId)

        override fun hasAnswered(playerId: String): Boolean = revealed[playerId] != null

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else players.filter { revealed[it] == null }

        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val counts = holdings()
            val best = counts.values.maxOrNull() ?: 0
            val leaders = counts.filterValues { it == best }.keys
            return MatchResult(
                if (leaders.size == 1) Outcome.WINNER else Outcome.DRAW,
                if (leaders.size == 1) leaders.first() else "",
                counts,
                "Stopped - most cards held.",
            )
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // Public only. A face-down pile is a secret from its owner as well, so there is
            // nothing here to hide behind a viewer check - and a card that has been turned is
            // held back until both are in, so neither player turns "after" seeing the other.
            putSeatCounts(players) { piles[it]?.size ?: 0 }
            put("names", JsonArray(players.map { JsonPrimitive(ctx.nameOf(it)) }))
            put("shown", JsonArray(players.map { shown[it]?.toJson() ?: JsonNull }))
            put("flipped", JsonArray(players.map { JsonPrimitive(revealed[it] != null) }))
            put("stake", stake.size)
            put("war", warDepth)
            put("tricks", tricks)
            put("myTurnDone", viewer != null && revealed[viewer] != null)
        }

        /** There is exactly one legal move in War, so the bot makes it. There is nothing else to say. */
        fun botFlip(playerId: String): GameMove? {
            if (phase != "playing") return null
            if (playerId !in players) return null
            if (revealed[playerId] != null) return null
            if (piles[playerId]?.isEmpty() != false) return null
            return GameMove(playerId, "flip", buildJsonObject { })
        }
    }
}
