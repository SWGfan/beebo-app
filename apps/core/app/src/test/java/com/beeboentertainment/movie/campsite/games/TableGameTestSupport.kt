package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/** A match context with a fake clock, for driving table games directly. */
internal class TestTable(seed: Int = 7) {
    var clock = 1_000L
    val random = Random(seed)
    val ctx = SimpleMatchContext(random, { clock }, { it.uppercase() }, { "a" }, {}, { emptyList() })

    fun move(player: String, action: String, vararg fields: Pair<String, Any>): GameMove =
        GameMove(player, action, buildJsonObject {
            fields.forEach { (k, v) ->
                when (v) {
                    is Int -> put(k, v)
                    is String -> put(k, v)
                    else -> error("unsupported")
                }
            }
        })

    /** Let every bot play until the match ends, asking again when a bot says "not yet". */
    fun playOut(game: CampsiteGame, match: GameMatch, limit: Int = 5_000) {
        var steps = 0
        while (match.phase != "done" && steps++ < limit) {
            val who = match.waitingOn().firstOrNull() ?: break
            var move = game.botMove(match, who, random)
            var waits = 0
            while (move == null && waits++ < 400) {
                Thread.sleep(10)
                move = game.botMove(match, who, random)
            }
            requireNotNull(move) { "bot never moved" }
            match.apply(move)
        }
    }
}
