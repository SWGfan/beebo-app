package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Pick the Next One - everyone suggests something, the leader spins.
 *
 * Unranked on purpose. Its "winner" is whoever the shuffle landed on, and a
 * championship table that counted raffle wins would stop meaning anything.
 */
internal object PickTheNextOne : CampsiteGame {
    override val id = "picknext"
    override val title = "Pick the Next One"
    override val blurb = "Suggest a movie or activity. Let the room pick."
    override val kind = "text"
    override val seats = Seats.any(2)
    override val category = GameCategory.PARTY
    override val needsGuests = true
    override val ranked = false

    /** What a bot throws into the hat. Kept vague on purpose - no titles, no brands. */
    private val BOT_IDEAS = listOf(
        "A walk to the top of the hill", "Toasting marshmallows", "Cards by the tent",
        "Something with a heist in it", "A comedy nobody has seen", "An early night",
        "A swim, if anyone is brave", "Something with car chases", "A cartoon",
        "Whatever is longest", "Whatever is shortest", "Something scary",
        "A film about the sea", "Hide and seek before dark", "A quiz round",
        "Whatever the youngest picks",
    )

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    /**
     * The bot throws one suggestion in the hat and then stops.
     *
     * It spins only when it is the one leading the round, which happens only when the
     * room's leader started it and then sat back to watch - otherwise nobody could ever
     * spin and the suggestions would sit there forever. Being the one who taps spin is
     * worth nothing: the pick is drawn with the HOST's random source inside the match,
     * so a bot can no more arrange to be chosen than a guest can.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val round = match as? Match ?: return null
        if (round.phase != "playing") return null
        if (round.botShouldSpin(playerId)) return botAction(playerId, "finish")
        if (round.botHasSuggested(playerId)) return null
        return botAction(playerId, "text", "text", BOT_IDEAS.random(random))
    }

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {
        private val entries = linkedMapOf<String, String>()

        init {
            prompt = "Everyone suggests something to watch or do. The leader spins to choose one."
        }

        override fun onApply(move: GameMove) {
            when (move.action) {
                "text" -> {
                    val text = GameText.clean(move.text())
                    entries[move.playerId] = text.take(100)
                }
                "finish" -> {
                    require(move.playerId == ctx.leader() && phase == "playing") { "Only the leader can finish this round." }
                    require(entries.isNotEmpty()) { "Add at least one suggestion first." }
                    // The spin happens on the host with the host's own random source, so
                    // no phone can arrange to be picked.
                    val selected = entries.entries.toList().random(ctx.random)
                    prompt = "The pick is: " + selected.value
                    settleWinner(selected.key)
                }
                else -> throw IllegalArgumentException("Unknown game action.")
            }
        }

        /** One suggestion per player, bots included. */
        fun botHasSuggested(playerId: String): Boolean = playerId in entries

        /** Everybody has put something in the hat and this bot is the one holding it. */
        fun botShouldSpin(playerId: String): Boolean =
            playerId == ctx.leader() && entries.isNotEmpty() && players.all { it in entries }

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else players.filter { it !in entries }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // Suggestions are meant to be read by the room - that is the game.
            put("entries", JsonArray(entries.map { (id, text) ->
                buildJsonObject {
                    put("name", ctx.nameOf(id))
                    put("text", text)
                }
            }))
        }
    }
}
