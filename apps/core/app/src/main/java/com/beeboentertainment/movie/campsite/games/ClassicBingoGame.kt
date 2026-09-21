package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Classic Bingo - the 75-ball numbers game. In a guest room the leader is the caller
 * (and plays too unless they choose "call only"); every phone gets its own cards. On
 * the host phone alone it is played against computer players - see the offline screen.
 */
internal object ClassicBingoGame : CampsiteGame {
    override val id = "classicbingo"
    override val title = "Classic Bingo"
    override val blurb = "75-ball B-I-N-G-O. The caller draws, you daub, first valid Bingo wins."
    override val kind = "grid"
    override val seats = Seats.any(2)
    override val category = GameCategory.PARTY
    override val needsGuests = false
    override val localRoute = "classicbingo"
    override val tournamentReady = false

    override fun validateSetup(text: String) {
        require(text.length <= 80) { "Those settings are too long." }
    }

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        val s = ClassicBingoEngine.settings(setup)
        val callerOnly = if (s.callerPlays) emptySet() else setOf(ctx.leader()).filter { it in players }.toSet()
        require(players.size - callerOnly.size >= 1) { "Somebody has to play." }
        return Match(players, ctx, ClassicBingoEngine(players, ctx.random, s.cards, s.pattern, s.penalty, callerOnly))
    }

    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botMove(playerId)

    private class Match(players: List<String>, ctx: MatchContext, private val engine: ClassicBingoEngine) : BaseMatch(players, ctx) {

        init {
            prompt = "Playing for: " + engine.pattern.label + " (" + engine.pattern.describe + ")."
        }

        override fun onApply(move: GameMove) {
            require(phase == "playing") { "This game has finished." }
            when (move.action) {
                "call" -> {
                    require(move.playerId == ctx.leader()) { "Only the caller draws balls." }
                    val ball = engine.callNext()
                    if (ball != null) prompt = "Ball " + engine.called.size + ": " + ClassicBingoRules.label(ball)
                    if (engine.over) end()
                }
                "mark" -> engine.mark(move.playerId, move.int("card"), move.int("cell"))
                "bingo" -> {
                    require(move.playerId in engine.cards) { "You don't have a card in this game." }
                    when (val c = engine.claim(move.playerId)) {
                        ClassicBingoEngine.Claim.Win -> log.add(ctx.nameOf(move.playerId) + " has Bingo on " + ballText() + "!")
                        is ClassicBingoEngine.Claim.Penalty -> {
                            log.add(ctx.nameOf(move.playerId) + " called Bingo too soon" + (if (c.calls > 0) " and sits out ${c.calls} calls." else "."))
                        }
                        is ClassicBingoEngine.Claim.Blocked -> throw IllegalArgumentException("Wait ${c.callsLeft} more calls before calling Bingo again.")
                        ClassicBingoEngine.Claim.Closed -> throw IllegalArgumentException("Too late - that Bingo has been called.")
                    }
                }
                "finish" -> {
                    require(move.playerId == ctx.leader()) { "Only the caller can end the game." }
                    engine.finish()
                    end()
                }
                else -> throw IllegalArgumentException("Unknown game action.")
            }
        }

        private fun ballText(): String = engine.current?.let { ClassicBingoRules.label(it) } ?: "the first ball"

        private fun end() {
            val winners = engine.winners
            winners.forEach { award(it, 1) }
            when (winners.size) {
                0 -> settleDraw("No Bingo this game.")
                1 -> settleWinner(winners.first())
                else -> settleScores("A tie on " + ballText() + ".")
            }
        }

        fun botMove(playerId: String): GameMove? = when {
            phase != "playing" -> null
            playerId in engine.cards && engine.hasValidCard(playerId) && playerId !in engine.winners && engine.penaltyLeft(playerId) == 0 ->
                botAction(playerId, "bingo")
            playerId == ctx.leader() -> botAction(playerId, "call")
            else -> null
        }

        override fun hasAnswered(playerId: String): Boolean = playerId in engine.winners

        override fun waitingOn(): List<String> = if (phase == "done") emptyList() else listOf(ctx.leader())

        override fun resultIfStoppedNow(): MatchResult = result() ?: when (engine.winners.size) {
            1 -> MatchResult(Outcome.WINNER, engine.winners.first(), scores.toMap())
            else -> MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped early.")
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            put("called", JsonArray(engine.called.map { JsonPrimitive(it) }))
            put("current", engine.current ?: 0)
            put("pattern", engine.pattern.label)
            put("patternWire", engine.pattern.wire)
            put("winners", JsonArray(engine.winners.map { JsonPrimitive(it) }))
            put("caller", ctx.leader())
            val mine = viewer?.let { engine.cards[it] }
            if (viewer != null && mine != null) {
                put("cards", JsonArray(mine.map { card -> JsonArray(card.map { JsonPrimitive(it) }) }))
                put("cardMarks", JsonArray(mine.indices.map { i -> JsonArray(engine.marksOf(viewer, i).map { JsonPrimitive(it) }) }))
                put("penaltyLeft", engine.penaltyLeft(viewer))
            }
        }
    }
}
