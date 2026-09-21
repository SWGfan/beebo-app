package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Snap - cards go face up one at a time, and the first player to tap when the top two
 * match takes the pile.
 *
 * FAIRNESS ON A HOTSPOT, which is the only interesting problem in this game.
 *
 * Everybody is on one phone's hotspot in a moving car. The phone at the back of the
 * footwell is not on the same link as the one next to the host, and Wi-Fi power saving
 * alone can hold a packet for a couple of hundred milliseconds. If the host simply gave
 * the pile to the first tap it received, Snap would stop being a test of reactions and
 * become a test of who is sitting closest to the router. Children notice this within
 * about four rounds and stop playing.
 *
 * So the host does not decide on the first arrival. It opens a window:
 *
 *  1. Every claim is stamped with the HOST's clock at the moment it arrives. No phone
 *     ever sends a time - a sent time is just a number a phone can make up, and the
 *     first person to work that out would win every round forever.
 *  2. The first claim after a matching pair opens a judging window of
 *     [SNAP_WINDOW_MS] milliseconds. Every claim that lands inside it is treated as
 *     having happened at the same moment.
 *  3. When the window closes, the pile goes to one of those claimants picked with the
 *     HOST's own random source. A claim that arrives after the window has closed is
 *     simply too late.
 *
 * The window is 700ms because that is comfortably wider than the link jitter this setup
 * produces and still narrower than the gap between someone who was watching and someone
 * who looked up late. Inside it, we are honestly saying "too close to call" and tossing a
 * coin, which is a fair answer to a genuine tie. Outside it, somebody really was quicker.
 *
 * The window has to be closed by something, and this engine has no timer of its own - a
 * match only ever wakes up when a move arrives. So any move closes an elapsed window
 * first, and there is a no-argument "resolve" action that does nothing except that. The
 * guest page sends it while the snapshot says a snap is being judged, and the bots send
 * it too, so a pile is never left sitting there because the room went quiet.
 *
 * Nothing in this game is private: a face-down pile is unknown to its own owner as well
 * as to everybody else, so it lives here as counts only and there is no hand to leak.
 */
internal object SnapGame : CampsiteGame {
    override val id = "snap"
    override val title = "Snap"
    override val blurb = "Watch the cards. Tap the moment two match."
    override val kind = "claim"
    override val seats = Seats.of(2, 6)
    override val category = GameCategory.CARD

    /** How close two taps have to be before the host calls them a tie. See the class comment. */
    private const val SNAP_WINDOW_MS = 700L

    /** After a pair appears, a tap this soon after it is a near miss rather than a wrong call. */
    private const val LATE_GRACE_MS = 2_500L

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    override fun botMove(match: GameMatch, playerId: String, random: kotlin.random.Random): GameMove? =
        (match as? Match)?.botTap(playerId, random)

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {

        /** Face-down piles. Secret from everyone, their owner included - only sizes go out. */
        private val piles = linkedMapOf<String, MutableList<Card>>()

        /** The face-up pile in the middle. The last entry is the card on top. */
        private val middle = mutableListOf<Card>()

        private val out = linkedSetOf<String>()

        /** Claims inside the current judging window: player id to host arrival time. */
        private val claims = linkedMapOf<String, Long>()

        private var windowOpenedAt = 0L

        /** Host clock reading when the pair now (or most recently) on the table appeared. */
        private var pairShownAt = 0L

        private var lastWinner = ""

        init {
            val deck = Cards.deck(ctx.random)
            players.forEach { piles[it] = mutableListOf() }
            var seat = 0
            while (deck.isNotEmpty()) {
                deck.drawTop()?.let { piles.getValue(players[seat % players.size]).add(it) }
                seat++
            }
            prompt = name(players[turnIndex]) + " turns the first card."
        }

        override fun onApply(move: GameMove) {
            require(phase == "playing") { "This round has finished." }
            // Any move closes a judging window that has already run out. This is what stands
            // in for a timer in an engine that only wakes on a move.
            settleWindowIfElapsed()
            if (phase == "done") return
            when (move.action) {
                "flip" -> flip(move.playerId)
                "snap" -> snap(move.playerId)
                "resolve" -> Unit
                else -> throw IllegalArgumentException("Turn a card over, or tap Snap.")
            }
        }

        private fun flip(playerId: String) {
            require(claims.isEmpty()) { "Hold on - a Snap is being judged." }
            // A pair stays on the table until somebody calls it. Letting the next card land on
            // top would bury a snap before the phone at the back has even drawn it.
            require(!matchShowing()) { "There's a snap on the table — call it or let it go." }
            require(players.getOrNull(turnIndex) == playerId) { "It's not your turn to turn a card." }
            require(playerId !in out) { "You're out of this round." }
            val pile = piles.getValue(playerId)
            require(pile.isNotEmpty()) { "You have no cards left to turn over." }
            val card = pile.drawTop()
            if (card != null) {
                middle.add(card)
                note(name(playerId) + " turned over " + card.label + ".")
                if (matchShowing()) pairShownAt = ctx.now()
            }
            if (!advanceFlipper()) {
                stopWithNoCards()
                return
            }
            prompt = if (matchShowing()) {
                "SNAP! Two " + middle.last().rank.many + "!"
            } else {
                name(players[turnIndex]) + " to turn a card."
            }
        }

        private fun snap(playerId: String) {
            require(playerId in players) { "You are not playing this round." }
            require(playerId !in out) { "You're out of this round." }
            val now = ctx.now()
            if (!matchShowing()) {
                // The pair has gone because somebody took it. A tap this soon after it appeared
                // is somebody who was a fraction late, not somebody who called it wrong.
                // Punishing that would teach children not to try.
                require(now - pairShownAt > LATE_GRACE_MS) { "Just too slow that time!" }
                payPenalty(playerId)
                return
            }
            require(playerId !in claims) { "You've already snapped - wait for the host." }
            if (claims.isEmpty()) windowOpenedAt = now
            claims[playerId] = now
            prompt = "Snap called - deciding."
        }

        /** A wrong call costs one card off the top of your pile, face down under the middle. */
        private fun payPenalty(playerId: String) {
            val pile = piles.getValue(playerId)
            val paid = pile.drawTop()
            if (paid == null) {
                note(name(playerId) + " snapped too soon, with no card left to pay.")
            } else {
                middle.add(0, paid)
                note(name(playerId) + " snapped too soon and paid a card.")
            }
        }

        /** Two cards on top of the middle with the same rank. Suits and colours do not matter. */
        private fun matchShowing(): Boolean =
            middle.size >= 2 && middle[middle.size - 1].rank == middle[middle.size - 2].rank

        private fun settleWindowIfElapsed() {
            if (claims.isEmpty()) return
            if (ctx.now() - windowOpenedAt < SNAP_WINDOW_MS) return
            awardPile()
        }

        private fun awardPile() {
            val contenders = claims.keys.toList()
            claims.clear()
            if (contenders.isEmpty()) return
            // Inside the window everybody was equally quick as far as the host can honestly
            // tell, so the host - never a phone - draws the short straw.
            val taker = if (contenders.size == 1) contenders.first() else contenders.random(ctx.random)
            if (contenders.size > 1) {
                note(
                    contenders.joinToString(" and ") { name(it) } +
                        " snapped together - the pile went to " + name(taker) + ".",
                )
            } else {
                note(name(taker) + " snapped and took " + middle.size + " cards.")
            }
            // Shuffled under the winner's pile, so the sequence the whole car just watched
            // does not decide the next ten flips.
            val won = middle.toList()
            middle.clear()
            piles.getValue(taker).addAll(won.shuffled(ctx.random))
            award(taker, 1)
            lastWinner = taker
            // Running out only puts you out when somebody else takes the pile; until then you
            // are still in and can snap your way back in, which is how families play it.
            players.forEach { if (it != taker && piles.getValue(it).isEmpty()) out.add(it) }
            val left = players.filter { it !in out }
            if (left.size <= 1) {
                val champion = left.firstOrNull() ?: taker
                prompt = name(champion) + " took the lot."
                settleWinner(champion)
                return
            }
            turnIndex = players.indexOf(taker)
            prompt = name(taker) + " took the pile and turns next."
        }

        private fun advanceFlipper(): Boolean {
            for (step in 1..players.size) {
                val seat = (turnIndex + step) % players.size
                val id = players[seat]
                if (id !in out && piles.getValue(id).isNotEmpty()) {
                    turnIndex = seat
                    return true
                }
            }
            return piles.getValue(players[turnIndex]).isNotEmpty()
        }

        /** Every pile is in the middle and nobody can turn a card: the last taker holds the game. */
        private fun stopWithNoCards() {
            val champion = lastWinner.ifBlank { topScorer() }
            if (champion.isNotBlank()) {
                prompt = "Nobody had a card left to turn over."
                settleWinner(champion)
            } else {
                settleDraw("Nobody had a card left to turn over.")
            }
        }

        private fun note(line: String) {
            log.add(line)
            while (log.size > 10) log.removeAt(0)
        }

        private fun name(playerId: String): String = ctx.nameOf(playerId)

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        /**
         * Snap is a game about collecting all the cards, so the pile in front of you is the
         * score. Stopping early is judged on exactly that, and a dead heat is a draw.
         */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val counts = players.associateWith { piles.getValue(it).size }
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
            // Everything here is public on purpose. A face-down pile is a secret from its own
            // owner too, so there is no per-viewer hand in this game at all; a spectator sees
            // exactly what a player sees, which is the two cards on top of the middle.
            putSeatCounts(players) { piles[it]?.size ?: 0 }
            put("names", JsonArray(players.map { JsonPrimitive(ctx.nameOf(it)) }))
            put("middle", middle.size)
            put("top", middle.lastOrNull()?.toJson() ?: JsonNull)
            put("under", if (middle.size >= 2) middle[middle.size - 2].toJson() else JsonNull)
            put("match", matchShowing())
            put("judging", claims.isNotEmpty())
            put("claimants", JsonArray(claims.keys.map { JsonPrimitive(it) }))
            put("mySnap", viewer != null && viewer in claims)
            put("out", JsonArray(out.map { JsonPrimitive(it) }))
        }

        /**
         * A bot has no thumbs and no lag, so left alone it would take every pile. It misses on
         * purpose about a third of the time, which puts it roughly where an adult who is also
         * driving the conversation sits. It never calls a snap that is not there, so it never
         * hands itself a penalty, and it helps close judging windows so a quiet room still
         * resolves.
         */
        fun botTap(playerId: String, random: Random): GameMove? {
            if (phase != "playing") return null
            if (playerId in out) return null
            if (claims.isNotEmpty()) {
                if (ctx.now() - windowOpenedAt >= SNAP_WINDOW_MS) {
                    return GameMove(playerId, "resolve", buildJsonObject { })
                }
                if (playerId !in claims && random.nextInt(100) < 70) {
                    return GameMove(playerId, "snap", buildJsonObject { })
                }
                return null
            }
            if (matchShowing()) {
                return if (random.nextInt(100) < 70) {
                    GameMove(playerId, "snap", buildJsonObject { })
                } else {
                    null
                }
            }
            if (players.getOrNull(turnIndex) == playerId && piles[playerId]?.isNotEmpty() == true) {
                return GameMove(playerId, "flip", buildJsonObject { })
            }
            return null
        }
    }
}
