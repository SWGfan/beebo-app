package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Campfire Stories - not a contest. On the host phone it is a story-starter deck and a
 * story spinner with read-aloud (see the campfire screen). In a guest room, the circle
 * gets a starter and takes turns adding a sentence on their own phones.
 */
internal object CampfireStoriesGame : CampsiteGame {
    override val id = "campfirestories"
    override val title = "Campfire Stories"
    override val blurb = "Cozy, funny or a little spooky. Start with a first line and take turns telling the rest."
    override val kind = "text"
    override val seats = Seats.any(2)
    override val ranked = false
    override val category = GameCategory.WORD_AND_TALK
    override val needsGuests = false
    override val localRoute = "campfirestories"

    /** What a story ended by its leader says. The trip recap keeps only stories that ended this way. */
    const val FINISHED_NOTE = "The end."

    private const val LINES = 40
    private const val BOT_FINISH_AT = 8

    private val BOT_LINES = listOf(
        "Just then, a twig snapped somewhere behind them.",
        "Nobody said a word for a long moment.",
        "So they packed a torch, a flask of cocoa and a very old map.",
        "The wind picked up, as if it wanted to join in.",
        "Somewhere far away, an owl hooted twice.",
        "It was not at all what anyone expected.",
        "They laughed so hard that the fire crackled along with them.",
        "And that was when they noticed the footprints.",
    )

    fun mood(setup: String): StoryMood {
        val wanted = Regex("mood=(\\w+)").find(setup.lowercase())?.groupValues?.get(1)
        return StoryMood.entries.firstOrNull { it.wire == wanted } ?: StoryMood.COZY
    }

    override fun validateSetup(text: String) {
        require(text.length <= 40) { "Those settings are too long." }
    }

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx, mood(setup))

    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botMove(playerId, random)

    private class Match(players: List<String>, ctx: MatchContext, private val mood: StoryMood) : BaseMatch(players, ctx) {
        init {
            prompt = CampfireStoriesContent.STARTERS.getValue(mood).random(ctx.random)
        }

        override fun onApply(move: GameMove) {
            when (move.action) {
                "text" -> {
                    require(players.getOrNull(turnIndex) == move.playerId) { "Wait for your turn." }
                    require(log.size < LINES) { "The story is full. The leader can finish it." }
                    val text = GameText.clean(move.text())
                    log.add(ctx.nameOf(move.playerId) + ": " + text)
                    turnIndex = (turnIndex + 1) % players.size
                }
                "starter" -> {
                    require(move.playerId == ctx.leader()) { "Only the leader can change the first line." }
                    require(log.isEmpty()) { "The story has already started." }
                    prompt = CampfireStoriesContent.STARTERS.getValue(mood).filter { it != prompt }.random(ctx.random)
                }
                "finish" -> {
                    require(move.playerId == ctx.leader()) { "Only the leader can finish the story." }
                    require(log.isNotEmpty()) { "Add a line first." }
                    settleScores(FINISHED_NOTE)
                }
                else -> throw IllegalArgumentException("Unknown game action.")
            }
        }

        fun botMove(playerId: String, random: Random): GameMove? = when {
            phase != "playing" -> null
            playerId == ctx.leader() && log.size >= BOT_FINISH_AT && players.getOrNull(turnIndex) == playerId -> botAction(playerId, "finish")
            players.getOrNull(turnIndex) == playerId && log.size < LINES -> botAction(playerId, "text", "text", BOT_LINES.random(random))
            else -> null
        }

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            put("mood", mood.label)
        }
    }
}
