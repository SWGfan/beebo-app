package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Car Bingo - each phone gets its own shuffled card; a row, column or diagonal wins.
 *
 * The clearest example of why [GameMatch.view] takes a viewer: every player's card is
 * different, and the whole game collapses the moment one phone can read another's. A
 * card and its marks go into exactly one player's snapshot and nobody else's, and a
 * spectator with no id gets neither.
 */
internal object CarBingoGame : CampsiteGame {
    override val id = "bingo"
    override val title = "Car Bingo"
    override val blurb = "Spot things together. First line wins."
    override val kind = "grid"
    override val seats = Seats.any(2)
    override val category = GameCategory.OUTDOORS

    private const val FREE = 12

    private val SQUARES = listOf(
        "Red car", "Blue car", "Truck", "Bicycle", "Dog", "Bird", "Bridge", "Tree", "Cloud",
        "Flag", "Bus", "Stop sign", "Motorcycle", "Gas station", "Flower", "Tent",
        "Picnic table", "Boat", "River", "Hill", "Bench", "Backpack", "Hat", "Sunglasses",
        "White car", "Fence", "Rock", "Puddle", "Leaf", "Trailer", "Camper", "Squirrel",
    )

    private val LINES: List<List<Int>> =
        (0..4).map { row -> (0..4).map { row * 5 + it } } +
            (0..4).map { col -> (0..4).map { it * 5 + col } } +
            listOf((0..4).map { it * 6 }, (0..4).map { it * 4 + 4 })

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    /**
     * The bot marks a square it has not marked yet.
     *
     * Nothing to be clever about: the real game is looking out of the window and the
     * honesty is the rule, so a bot marking at random is exactly as plausible as a
     * guest who really did spot a red car. Note it asks the MATCH for its own card -
     * a bot reads its own squares and nobody else's, the same rule the human views
     * follow, so adding a bot cannot become the hole that leaks somebody's card.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val card = match as? Match ?: return null
        if (card.phase != "playing") return null
        val cell = card.botSquare(playerId, random) ?: return null
        return botAction(playerId, "claim", "cell", cell)
    }

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {
        private val cards = mutableMapOf<String, List<String>>()
        private val marks = mutableMapOf<String, MutableSet<Int>>()

        init {
            players.forEach { id ->
                cards[id] = SQUARES.shuffled(ctx.random).take(24).toMutableList()
                    .also { it.add(FREE, "FREE") }
                marks[id] = mutableSetOf(FREE)
            }
        }

        override fun onApply(move: GameMove) {
            require(move.action == "claim") { "Choose a game action." }
            require(phase == "playing") { "This round has finished." }
            val cell = move.int("cell")
            require(cell in 0..24 && cell != FREE) { "Choose a bingo square." }
            val mine = marks[move.playerId] ?: throw IllegalArgumentException("You are not in this round.")
            // A marked square stays marked. A second tap on it is a bounce in a moving car far
            // more often than a change of mind, and a square that quietly un-marks itself is
            // how a real line goes unnoticed. So the tap does nothing rather than toggling.
            if (!mine.add(cell)) return
            if (LINES.any { line -> line.all { it in mine } }) {
                award(move.playerId, 1)
                settleWinner(move.playerId)
            }
        }

        /** An unmarked square on this bot's OWN card, or null when the card is full. */
        fun botSquare(playerId: String, random: Random): Int? {
            val mine = marks[playerId] ?: return null
            val free = (0..24).filter { it != FREE && it !in mine }
            return if (free.isEmpty()) null else free.random(random)
        }

        /** Furthest along is not a win at bingo, so a stopped card decides nothing. */
        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped before a line.")

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            put("bingo", JsonArray(viewer?.let { cards[it] }.orEmpty().map { JsonPrimitive(it) }))
            put("marks", JsonArray(viewer?.let { marks[it] }.orEmpty().map { JsonPrimitive(it) }))
        }
    }
}
