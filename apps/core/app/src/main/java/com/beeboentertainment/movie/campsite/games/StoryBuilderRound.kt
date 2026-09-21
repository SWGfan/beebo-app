package com.beeboentertainment.movie.campsite.games

import kotlin.random.Random

/**
 * Story Builder - everyone adds a line in turn until the leader reads it out.
 *
 * There is no winner and there never will be, which is exactly why it is unranked: a
 * leaderboard that counted this would rank whoever typed the most.
 */
internal object StoryBuilderRound : CampsiteGame {
    override val id = "storybuilder"
    override val title = "Story Builder"
    override val blurb = "Take turns adding a line to the story."
    override val kind = "text"
    override val seats = Seats.any(2)
    override val category = GameCategory.WORD_AND_TALK
    override val ranked = false

    private const val LINES = 60

    /** How long a story a bot leader lets run before it reads it out. */
    private const val BOT_FINISH_AT = 12

    /**
     * What a bot adds to the story.
     *
     * Fragments rather than sentences, so whatever a person wrote on the line above
     * still reads into it. Repeats are allowed here on purpose - the match keeps no
     * used-line set, and a story that comes back round to the badger twice is funnier
     * than a bot that runs out of things to say.
     */
    private val BOT_LINES = listOf(
        "and then the kettle fell over",
        "but nobody could find the torch",
        "so we all ran back to the tent",
        "and a badger walked straight through the camp",
        "and it started raining sideways",
        "so we pretended we had meant to do that",
        "and the map turned out to be upside down",
        "but the marshmallows survived",
        "and somebody's boot went in the river",
        "so we decided to blame the weather",
        "and an owl started shouting about it",
        "but the fire refused to go out",
        "and the tent pegs had walked off on their own",
        "so we followed the noise up the hill",
        "and there was a very smug looking sheep",
        "but by then it was far too dark to argue",
        "and the whole field smelled of burnt toast",
        "so we voted to keep that part secret",
        "and the dog came back covered in mud",
        "but the sandwiches had gone missing again",
        "and a torch beam swept across the field",
        "so everybody pretended to be asleep",
        "and the wind took the washing line",
        "but in the morning it all seemed fine",
    )

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx)

    /**
     * The bot adds a line when it is its turn.
     *
     * There is no winner here and nothing to be good at, so the only thing a bot has to
     * be is willing to take its turn - a story that stops because the seat next to you
     * is a bot is the one failure mode. It never presses `finish`: this game is
     * unranked, so it never enters a bracket. It DOES finish the round when it is the
     * one leading it, which only happens when the room's leader started the round and
     * then sat back to watch: somebody has to be able to say the story is done, and if
     * that seat is a bot and the bot will not, the story runs to sixty lines and stops
     * with nobody able to end it.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? {
        val round = match as? Match ?: return null
        if (round.phase != "playing") return null
        if (round.botShouldFinish(playerId)) return botAction(playerId, "finish")
        val line = round.botLine(playerId, random) ?: return null
        return botAction(playerId, "text", "text", line)
    }

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {
        init {
            prompt = "Once upon a camping trip…"
        }

        override fun onApply(move: GameMove) {
            when (move.action) {
                "text" -> {
                    val text = GameText.clean(move.text())
                    require(players.getOrNull(turnIndex) == move.playerId) { "Wait for your turn." }
                    require(log.size < LINES) { "This round is full. The leader can finish it." }
                    log.add(ctx.nameOf(move.playerId) + ": " + text)
                    turnIndex = (turnIndex + 1) % players.size
                }
                "finish" -> {
                    require(move.playerId == ctx.leader() && phase == "playing") { "Only the leader can finish this round." }
                    require(log.isNotEmpty()) { "Add something first." }
                    settleScores("The story is finished.")
                }
                else -> throw IllegalArgumentException("Unknown game action.")
            }
        }

        /**
         * A bot running the round reads it out once there is a story to read. Twelve
         * lines is about a minute of bots talking to each other, which is the point at
         * which watching them stops being funny.
         */
        fun botShouldFinish(playerId: String): Boolean =
            playerId == ctx.leader() && players.getOrNull(turnIndex) == playerId && log.size >= BOT_FINISH_AT

        /** A fragment for this bot, or null when it is not its turn or the page is full. */
        fun botLine(playerId: String, random: Random): String? =
            if (players.getOrNull(turnIndex) != playerId || log.size >= LINES) null
            else BOT_LINES.random(random)

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))
    }
}
