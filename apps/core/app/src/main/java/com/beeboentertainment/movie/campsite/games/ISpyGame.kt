package com.beeboentertainment.movie.campsite.games

import kotlin.random.Random

/**
 * I Spy - the host names a thing, the first player to spot it says so.
 *
 * There is nothing to verify: the honesty is the game. It is still host-authoritative
 * in the way that matters, because the phone says only "I claim", and the host decides
 * that the first claim it received is the one that counts.
 */
internal object ISpyGame : CampsiteGame {
    override val id = "ispy"
    override val title = "I Spy"
    override val blurb = "First to spot it wins. Play honestly!"
    override val kind = "claim"
    override val seats = Seats.any(2)
    override val category = GameCategory.OUTDOORS

    private val THINGS = listOf(
        "Something red", "Something round", "A bird", "Something with wheels",
        "Something taller than a house", "A road sign", "Something blue", "Something shiny",
        "A cloud", "Something yellow",
    )

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    /**
     * The bot says it spotted the thing - eventually.
     *
     * I Spy is pure reaction, so the ONLY thing that makes a bot fair here is how long
     * it waits, and that is the service's business, not the game's: claim games get the
     * long think-time. The coin toss on top of it is why the bot does not claim at the
     * same moment every round - returning null means "not yet", the service has another
     * think, and the delay comes out spread rather than fixed.
     *
     * Honesty is the rule of this game and a bot has none, so it is simply claiming
     * like everybody else. A bot that never claimed would be a seat that never plays.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        if (match.phase == "playing" && random.nextInt(2) == 0) botAction(playerId, "claim") else null

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {
        init {
            prompt = THINGS.random(ctx.random)
        }

        override fun onApply(move: GameMove) {
            require(move.action == "claim") { "Choose a game action." }
            require(phase == "playing") { "This round has finished." }
            award(move.playerId, 1)
            settleWinner(move.playerId)
        }
    }
}
