package com.beeboentertainment.movie.campsite.platehunt

import com.beeboentertainment.movie.campsite.games.BaseMatch
import com.beeboentertainment.movie.campsite.games.CampsiteGame
import com.beeboentertainment.movie.campsite.games.GameCategory
import com.beeboentertainment.movie.campsite.games.GameMatch
import com.beeboentertainment.movie.campsite.games.GameMove
import com.beeboentertainment.movie.campsite.games.MatchContext
import com.beeboentertainment.movie.campsite.games.Seats
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Plate & Sign Hunt: the oldest car game there is, on every phone in the car.
 *
 * Tick off every US state (and DC), every Canadian province and territory, or find the letters
 * A to Z on signs, in order. Two ways to play:
 *
 *  - TEAM: everybody ticks one shared list, and the list says who spotted what. First to see a
 *    plate ticks it for the whole car.
 *  - RACE: everybody has their own list, and the first to complete it wins. A player's list is
 *    only ever in that player's own snapshot (see [decorate]); other players see a count and
 *    nothing else.
 *
 * WHAT THIS IS NOT. It is a game for PASSENGERS. It never reads the camera, the microphone or the
 * location, stores no picture of any plate and needs no network. It is an honour system (like I
 * Spy): nothing checks a plate was really seen. Ranked is false because a shared checklist has no
 * loser, and a race on the honour system should not fill a leaderboard.
 *
 * It is playable alone with no guest server: [playsSolo] is true and [seats] starts at one, so
 * the host's Games list opens it on this phone through CampsiteLocalGames.
 */
internal object PlateHuntGame : CampsiteGame {
    override val id = "plates"
    override val title = PlateHuntStrings.TITLE
    override val blurb = PlateHuntStrings.BLURB

    /** A presentation hint like "grid" or "claim"; nothing in the rules depends on it. */
    override val kind = "checklist"
    override val seats = Seats.any(1)
    override val category = GameCategory.OUTDOORS
    override val ranked = false
    override val playsSolo = true

    /** How many taps one player may make in [RATE_WINDOW_MS]. A finger on a bumpy road is fast, a script is faster. */
    const val RATE_MAX = 12
    const val RATE_WINDOW_MS = 3_000L

    override fun validateSetup(text: String) {
        PlateSetup.parse(text)
    }

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx, PlateSetup.parse(setup))

    private class Match(players: List<String>, ctx: MatchContext, private val setup: PlateSetup) :
        BaseMatch(players, ctx), PlateHuntReporting {

        private val items = PlateRegions.items(setup.region)
        private val ordered = PlateRegions.ordered(setup.region)
        private val team = setup.team

        /** TEAM: who ticked each entry, or null. */
        private val shared = arrayOfNulls<String>(items.size)

        /** RACE: each player's own ticks, in the order they were made. */
        private val marks = LinkedHashMap<String, LinkedHashSet<Int>>()

        /** Recent tap times per player, for [throttle]. */
        private val recent = HashMap<String, ArrayDeque<Long>>()

        init {
            players.forEach { marks[it] = LinkedHashSet() }
            prompt = PlateHuntStrings.PROMPT
        }

        private fun teamFound(): Int = shared.count { it != null }

        override fun onApply(move: GameMove) {
            val who = move.playerId
            require(who in players) { "You are not in this round." }
            when (move.action) {
                "spot" -> { throttle(who); spot(who, move.int("cell")) }
                "unspot" -> { throttle(who); unspot(who, move.int("cell"), move.text("player")) }
                "finish" -> finish(who)
                else -> throw IllegalArgumentException("Choose a game action.")
            }
        }

        /** At most [RATE_MAX] taps per [RATE_WINDOW_MS] per player, so one phone cannot flood the round. */
        private fun throttle(who: String) {
            val now = ctx.now()
            val times = recent.getOrPut(who) { ArrayDeque() }
            while (times.isNotEmpty() && now - times.first() > RATE_WINDOW_MS) times.removeFirst()
            require(times.size < RATE_MAX) { "Slow down a little - one tap at a time." }
            times.addLast(now)
        }

        private fun spot(who: String, cell: Int) {
            require(phase == "playing") { "This round has finished." }
            require(cell in items.indices) { "Choose one from the list." }
            if (team) {
                // Two kids tapping the same plate at once is normal in a car. The second tap is
                // not an error; the plate is already found.
                if (shared[cell] != null) return
                if (ordered) {
                    val next = shared.indexOfFirst { it == null }
                    require(cell == next) { "Look for ${items[next].name} next." }
                }
                shared[cell] = who
                award(who, 1)
                if (teamFound() == items.size) settleScores("Everything on the list was spotted.")
            } else {
                val mine = marks.getValue(who)
                if (cell in mine) return
                if (ordered) require(cell == mine.size) { "Look for ${items[mine.size].name} next." }
                mine += cell
                award(who, 1)
                if (mine.size == items.size) settleWinner(who)
            }
        }

        /**
         * Take a tick back. A player can take back their own; the leader can take back any. In
         * ordered mode only the latest can be taken back, so the list never has a hole in it.
         */
        private fun unspot(who: String, cell: Int, other: String) {
            require(phase == "playing") { "This round has finished." }
            require(cell in items.indices) { "Choose one from the list." }
            if (team) {
                val by = shared[cell] ?: return
                require(who == by || who == ctx.leader()) { "Only the person who spotted it, or the leader, can take it back." }
                if (ordered) require(cell == shared.indexOfLast { it != null }) { "Take back the latest letter first." }
                shared[cell] = null
                award(by, -1)
            } else {
                val target = other.ifBlank { who }
                if (target != who) {
                    require(who == ctx.leader()) { "Only the leader can take back somebody else's." }
                    require(target in players) { "That player is not in this round." }
                }
                val mine = marks.getValue(target)
                if (cell !in mine) return
                if (ordered) require(cell == mine.size - 1) { "Take back the latest letter first." }
                mine -= cell
                award(target, -1)
            }
        }

        private fun finish(who: String) {
            require(phase == "playing") { "This round has finished." }
            require(who == ctx.leader()) { "The leader finishes the round." }
            if (team) {
                settleScores("Spotted ${teamFound()} of ${items.size} ${PlateRegions.noun(setup.region)}.")
                return
            }
            val top = topScorer()
            if (top.isNotBlank() && (scores[top] ?: 0) > 0) settleWinner(top)
            else settleDraw("Nobody was ahead when the round ended.")
        }

        override fun plateSummary(): PlateSummary {
            val per = players.associateWith { if (team) scores[it] ?: 0 else marks[it]?.size ?: 0 }
            val found = if (team) teamFound() else (per.values.maxOrNull() ?: 0)
            return PlateSummary(setup.region, team, items.size, found, per)
        }

        override fun line(): String =
            if (phase == "done") "Finished - ${plateSummary().found} of ${items.size}"
            else "${plateSummary().found} of ${items.size} spotted"

        /**
         * Everything this page needs. PRIVACY: in a race, [mine] is the asking player's own list and
         * nobody else's, and a spectator (null viewer) gets none. What other players get is a count.
         */
        override fun JsonObjectBuilder.decorate(viewer: String?) {
            val summary = plateSummary()
            put("plates", buildJsonObject {
                put("region", setup.region.wire)
                put("regionLabel", setup.region.label)
                put("noun", PlateRegions.noun(setup.region))
                put("mode", if (team) "team" else "race")
                put("ordered", ordered)
                put("total", items.size)
                put("found", if (team) summary.found else viewer?.let { marks[it]?.size } ?: 0)
                put("complete", summary.found == items.size)
                put("note", PlateHuntStrings.DRIVER_NOTE)
                put("items", JsonArray(items.map { item ->
                    buildJsonObject { put("name", item.name); put("abbr", item.abbr) }
                }))
                // TEAM: who ticked each entry ("" when not yet). RACE: nothing, on purpose.
                put("team", JsonArray(if (team) shared.map { JsonPrimitive(it?.let(ctx::nameOf) ?: "") } else emptyList()))
                put("teamBy", JsonArray(if (team) shared.map { JsonPrimitive(it ?: "") } else emptyList()))
                // RACE: only the asking player's own list.
                put("mine", JsonArray(if (!team && viewer != null) marks[viewer].orEmpty().map { JsonPrimitive(it) } else emptyList()))
                // The entry an ordered hunt is waiting for, or -1.
                put("next", when {
                    !ordered -> -1
                    team -> shared.indexOfFirst { it == null }
                    viewer != null -> marks[viewer]?.size?.takeIf { it < items.size } ?: -1
                    else -> -1
                })
                // Counts only: how far along each player is.
                put("progress", JsonArray(players.map { id ->
                    buildJsonObject {
                        put("id", id)
                        put("name", ctx.nameOf(id))
                        put("found", summary.perPlayer[id] ?: 0)
                    }
                }))
            })
        }
    }
}

/** What a finished round adds up to. Pure data, so the trip and badges never see a match. */
internal data class PlateSummary(
    val region: PlateRegionId,
    val team: Boolean,
    val total: Int,
    /** TEAM: how many the car found. RACE: the best single list. */
    val found: Int,
    /** Player id to how many that player ticked. */
    val perPlayer: Map<String, Int>,
) {
    val complete: Boolean get() = total > 0 && found >= total
}

/** Implemented by the match so the games service can report a finished round without knowing the game. */
internal interface PlateHuntReporting {
    fun plateSummary(): PlateSummary
}

/** The setup the leader chooses: which list, and team or race. Parsed from the `start` text. */
internal data class PlateSetup(val region: PlateRegionId, val team: Boolean) {
    companion object {
        const val MAX_LENGTH = 64

        /** "region=usa;mode=team". Empty means the defaults. Anything unknown is refused, never guessed at. */
        fun parse(text: String): PlateSetup {
            val bad = IllegalArgumentException("Choose a list and a way to play from the buttons.")
            if (text.length > MAX_LENGTH) throw bad
            var region = PlateRegionId.USA
            var team = true
            text.split(';').map { it.trim() }.filter { it.isNotEmpty() }.forEach { part ->
                val key = part.substringBefore('=', "")
                val value = part.substringAfter('=', "")
                when (key) {
                    "region" -> region = PlateRegionId.fromWire(value) ?: throw bad
                    "mode" -> team = when (value) {
                        "team" -> true
                        "race" -> false
                        else -> throw bad
                    }
                    else -> throw bad
                }
            }
            return PlateSetup(region, team)
        }
    }
}

/**
 * Every line of text this game shows that is not a state name, kept in one place so a test can hold
 * all of it against a deny list (slogans, seals, brands). The page's own strings live in
 * campsite-platehunt.js and are held to the same list.
 */
internal object PlateHuntStrings {
    const val TITLE = "Plate & Sign Hunt"
    const val BLURB = "Spot every state, province or letter on the road. For passengers only, never the driver."
    const val PROMPT = "Look out of the window. Passengers only, never the driver."
    const val DRIVER_NOTE = "For passengers only, never the driver. Nothing is recorded: no camera, no location."

    val ALL: List<String> = listOf(TITLE, BLURB, PROMPT, DRIVER_NOTE) + PlateRegionId.values().map { it.label }
}
