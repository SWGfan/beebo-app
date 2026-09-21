package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Pairs - twenty-four cards face down, turn two, keep them if they match and go again.
 *
 * Called Pairs because that is what the game is called in most of the world and because
 * the other common English name for it is a registered trademark in several markets.
 *
 * THE PRIVACY SHAPE HERE IS THE OPPOSITE OF THE CARD GAMES, AND THAT IS WORTH SAYING.
 *
 * [CardMatch] exists because a hand belongs to one player. Pairs has no hands: the table is
 * shared and everybody is allowed to see everything that is face up. What must never leak is
 * the face of a card that is still face down - and the way that is guaranteed here is not a
 * viewer check but an absence. A face-down card is published as JSON null. Not as a rank
 * with a flag, not as a code the page is trusted not to draw, not as a value only the owner
 * sees, because there is no owner. It is simply not in the snapshot that goes to anybody,
 * including the player whose turn it is, including the room leader, including a spectator.
 * [view] therefore does not depend on [viewer] at all beyond a courtesy "is it your turn",
 * which is a stronger guarantee than a check that could one day be written the wrong way
 * round.
 *
 * The board is dealt from the one deck in this package, [Cards], with the host's own random.
 * Twelve ranks are taken from a shuffled deck, two suits of each, and the twenty-four are
 * shuffled again: a six by four grid, which is the largest that stays tappable on a phone.
 * Two cards match when their RANKS match, so the pair is a red one and a black one as often
 * as not and a small child can still see it at a glance.
 *
 * THE FLIP-BACK PROBLEM. On paper the two cards sit face up for a second while everybody
 * looks. A phone that turns them back inside the same request shows the second card to
 * nobody. So a mismatched pair STAYS face up in the snapshot, and is covered by the first
 * tap of the next player's turn. The room gets as long as it takes somebody to reach for the
 * phone, which is exactly as long as it gets at a table, and no timer has to be trusted.
 */
internal object PairsGame : CampsiteGame {
    override val id = "pairs"
    override val title = "Pairs"
    override val blurb = "Turn two cards. Keep the matching ones and have another go."
    override val kind = "grid"
    override val seats = Seats.of(2, 6)
    override val category = GameCategory.CARD

    /** Twelve pairs, twenty-four cards, six columns by four rows. */
    private const val PAIRS_IN_PLAY = 12
    private const val COLUMNS = 6

    /**
     * How many turned cards a bot keeps in its head.
     *
     * A bot with perfect recall wins every game of Pairs against every human being alive,
     * which is not an opponent anybody plays twice. Five is roughly a person paying
     * attention, and it is a human failure mode too - it forgets the OLDEST card it saw,
     * so it loses track of the corner it stopped looking at.
     */
    private const val BOT_RECALL = 5

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size >= 2) { "Pairs needs at least two players." }
        return Match(players.take(6), ctx)
    }

    /**
     * The bot turns a card, and the only thing it knows is what the room watched it see.
     *
     * Its recall is filled in [Match.remember], which runs when a card is turned FACE UP -
     * in other words when everybody at the table saw the same thing at the same moment. It
     * is never filled from [Match.layout], so a bot cannot know the face of a card that has
     * not been turned. Given that much it does the obvious: if it can still recall a matching
     * pair, it plays it; on a second pick it looks for the partner of the card it just
     * turned; otherwise it prefers a card it has never seen, because turning a known card
     * whose partner it has forgotten teaches it nothing.
     *
     * Every cell it can return is a face-down cell, so it cannot send a move the rules would
     * refuse.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val table = match as? Match ?: return null
        val cell = table.botPick(playerId, random) ?: return null
        return botAction(playerId, "turn", "cell", cell)
    }

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {

        /**
         * Host-side truth: what is actually under each place on the table. NEVER published
         * whole. A card leaves this list only through [JsonObjectBuilder.decorate], and only
         * when its own square is face up or already won.
         */
        private val layout: List<Card>

        /** Per square: 0 face down, 1 face up right now, 2 won and out of play. */
        private val state: IntArray

        /** Seat index that won each square, or -1 while it is still on the table. */
        private val owner: IntArray

        /** The one or two squares the current player has turned this turn. */
        private val turned = mutableListOf<Int>()

        /** True while a mismatched pair is still on show, waiting to be covered. */
        private var showing = false

        /**
         * What each player has watched get turned over, newest last. Bots read their own.
         * It holds only publicly turned cards and it is never published to anybody.
         */
        private val recall = linkedMapOf<String, LinkedHashMap<Int, Rank>>()

        init {
            // One deck, the host's shuffle, from the package's own [Cards]. Grouping the
            // shuffled deck by rank and taking two of each gives two random suits per pair.
            val deck = Cards.deck(ctx.random)
            val chosen = mutableListOf<Card>()
            deck.groupBy { it.rank }.entries.shuffled(ctx.random).take(PAIRS_IN_PLAY)
                .forEach { entry -> chosen.addAll(entry.value.take(2)) }
            layout = chosen.shuffled(ctx.random)
            state = IntArray(layout.size)
            owner = IntArray(layout.size) { -1 }
            players.forEach { recall[it] = LinkedHashMap() }
            prompt = ctx.nameOf(players[0]) + " turns first."
        }

        private fun name(playerId: String): String = ctx.nameOf(playerId)

        private fun note(line: String) {
            log.add(line)
            while (log.size > 10) log.removeAt(0)
        }

        override fun onApply(move: GameMove) {
            require(move.action == "turn") { "Tap a face-down card." }
            require(phase == "playing") { "This game has finished." }
            require(move.playerId in players) { "You are not playing this game." }
            require(players.getOrNull(turnIndex) == move.playerId) { "It's not your turn." }
            val cell = move.int("cell")
            require(cell in layout.indices) { "Tap a card on the table." }
            // The previous player's near miss goes back face down the moment somebody moves
            // on. Doing it here, rather than on a timer, means the room decides how long it
            // looks at them.
            if (showing) coverUp()
            require(state[cell] == 0) { "That card is already face up. Choose another one." }

            state[cell] = 1
            turned.add(cell)
            // Everybody at the table just saw it, so everybody's recall gets it.
            players.forEach { remember(it, cell) }

            if (turned.size < 2) {
                prompt = name(move.playerId) + " turned " + layout[cell].label + " - turn one more."
                return
            }

            val first = turned[0]
            val second = turned[1]
            if (layout[first].rank == layout[second].rank) {
                state[first] = 2
                state[second] = 2
                owner[first] = turnIndex
                owner[second] = turnIndex
                turned.clear()
                award(move.playerId, 1)
                note(name(move.playerId) + " matched two " + layout[first].rank.many + ".")
                if (state.all { it == 2 }) {
                    finish()
                    return
                }
                prompt = name(move.playerId) + " found a pair and goes again."
            } else {
                showing = true
                note(
                    name(move.playerId) + " turned " + layout[first].label + " and " +
                        layout[second].label + " - no match."
                )
                turnIndex = (turnIndex + 1) % players.size
                prompt = "No match. " + name(players[turnIndex]) + " is next."
            }
        }

        private fun coverUp() {
            turned.forEach { if (state[it] == 1) state[it] = 0 }
            turned.clear()
            showing = false
        }

        /** Note a card the whole room just watched being turned, forgetting the oldest. */
        private fun remember(playerId: String, cell: Int) {
            val mind = recall[playerId] ?: return
            mind.remove(cell)
            mind[cell] = layout[cell].rank
            while (mind.size > BOT_RECALL) {
                val oldest = mind.keys.firstOrNull() ?: break
                mind.remove(oldest)
            }
        }

        private fun finish() {
            val best = scores.values.maxOrNull() ?: 0
            val leaders = scores.filterValues { it == best }.keys
            if (leaders.size == 1) {
                winner = leaders.first()
                prompt = name(leaders.first()) + " won with " + best + " pairs."
            } else {
                prompt = "All square on " + best + " pairs each."
            }
            settleScores("Every pair found.")
        }

        override fun hasAnswered(playerId: String): Boolean =
            players.getOrNull(turnIndex) != playerId

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        /**
         * A pair already won is won. Nobody is going to accept "we stopped, so your six
         * pairs count for nothing", so a stopped game is simply the pairs on the table in
         * front of each player, and level counts separate nobody.
         */
        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(
                Outcome.SCORES,
                topScorer(),
                scores.toMap(),
                "Stopped - pairs already won still count.",
            )

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // NOTHING BELOW DEPENDS ON WHO IS ASKING, and that is the guarantee. A face-down
            // card is JSON null in every snapshot this match ever builds, so there is no
            // viewer, no leader and no spectator who can be sent one by mistake.
            put("columns", COLUMNS)
            put("seats", JsonArray(players.map { JsonPrimitive(it) }))
            put("names", JsonArray(players.map { JsonPrimitive(ctx.nameOf(it)) }))
            put("pairs", JsonArray(players.map { JsonPrimitive(scores[it] ?: 0) }))
            put("cards", JsonArray(layout.indices.map { index ->
                if (state[index] == 0) JsonNull else layout[index].toJson()
            }))
            put("state", JsonArray(state.map { JsonPrimitive(it) }))
            put("owners", JsonArray(owner.map { JsonPrimitive(it) }))
            put("left", state.count { it != 2 })
            put("showing", showing)
            put("myTurn", viewer != null && players.getOrNull(turnIndex) == viewer)
        }

        /**
         * The square this bot will tap, or null when it is not its move.
         *
         * Reads [state] (public - the shape of the table), the face of the card it has
         * already turned this turn (public - it is face up), and its own [recall] (public
         * when it was written). It never reads [layout] for a face-down square.
         */
        fun botPick(playerId: String, random: Random): Int? {
            if (phase != "playing") return null
            if (players.getOrNull(turnIndex) != playerId) return null
            val mind = recall[playerId] ?: return null
            // Squares that will be face down once any leftover pair has been covered.
            val down = layout.indices.filter { state[it] == 0 || (showing && state[it] == 1) }
            if (down.isEmpty()) return null
            val open = if (showing) emptyList() else turned.toList()
            val available = down.filter { it !in open }
            if (available.isEmpty()) return null

            if (open.isEmpty()) {
                // First pick: play a remembered pair if it can still see both halves.
                val known = available.filter { mind[it] != null }
                val half = known.firstOrNull { cell ->
                    known.any { other -> other != cell && mind[other] == mind[cell] }
                }
                if (half != null) return half
            } else {
                // Second pick: the partner of the card lying face up in front of it.
                val wanted = layout[open[0]].rank
                val partner = available.firstOrNull { mind[it] == wanted }
                if (partner != null) return partner
            }
            val fresh = available.filter { mind[it] == null }
            return (if (fresh.isNotEmpty()) fresh else available).random(random)
        }
    }
}
