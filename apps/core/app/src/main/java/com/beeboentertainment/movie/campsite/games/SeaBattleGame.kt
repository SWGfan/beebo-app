package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Sea Battle - hide a fleet on your own sea, then call squares until one fleet is gone.
 *
 * The rules are the pen-and-paper game that was played in trenches and classrooms long
 * before anybody boxed it: two grids, a handful of ships, hit or miss, sink them all.
 *
 * Players place the five ships by dragging or tapping; shuffle remains a quick option.
 * The host validates every placement before replacing a ship, so invalid moves are
 * atomic and no client can overlap hulls, leave the board, or move a ready fleet.
 *
 * PRIVACY. This is the game in the whole catalogue with the most to lose from a leaky
 * snapshot. Own hull geometry is sent only to its owner. Enemy geometry is sent only
 * for ships that viewer has completely sunk; every revealed square is already a hit.
 * Spectators and unknown viewers receive no private boards or ship geometry.
 *
 * The brand name of the boxed version is a trademark and appears nowhere in this file.
 */
internal object SeaBattleGame : CampsiteGame {
    override val id = "seabattle"
    override val title = "Sea Battle"
    override val blurb = "Hide your fleet, call squares and sink every enemy ship."
    override val kind = "grid"
    override val seats = Seats.exactly(2)
    override val category = GameCategory.BOARD

    /** Eight by eight, not ten by ten: sixty-four taps still fit a phone held in one hand. */
    private const val WIDTH = 8
    private const val CELLS = WIDTH * WIDTH

    /** Fourteen ship squares in sixty-four, which is about the density of the paper game. */
    private val SHIPS = listOf(4, 3, 3, 2, 2)

    /** Attempts per ship before the whole fleet is thrown away and dealt again. */
    private const val PLACE_TRIES = 400

    /** Whole-fleet attempts before giving up and using the tidy fallback below. */
    private const val FLEET_TRIES = 60

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size == 2) { "Sea Battle is for exactly two players." }
        return Match(players, ctx)
    }

    /**
     * The bot places, declares ready, and then hunts.
     *
     * It reads ONE thing: its own record of the shots it has fired, which is the same
     * piece of paper a person playing it would have in front of them. It cannot see the
     * enemy fleet, because the only method it is given does not look at one. That is the
     * whole safety argument and it is worth keeping that way: the moment a bot here is
     * allowed to ask "where are the ships", the game is over for everyone.
     *
     * The hunt is the one a child works out by themselves. If something is wounded, poke
     * next to it until it dies. Otherwise fire on every other square, because the
     * smallest ship is two long and therefore cannot hide between them - which halves the
     * searching without needing any cleverness at all.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botStep(playerId, random)

    /** One ship, its squares, and which of them have been hit. */
    private class Ship(val size: Int, val cells: List<Int>) {
        val hits = mutableSetOf<Int>()
        val sunk: Boolean get() = cells.isNotEmpty() && hits.size == cells.size
    }

    /**
     * Deal one legal fleet with the host's own randomness.
     *
     * Ships are allowed to touch, as they are in the paper game. Forbidding touching
     * would make the bot's job easier and the human's placement duller, and it is a
     * rule from a box, not from the game.
     */
    private fun placeFleet(random: Random): List<Ship> {
        repeat(FLEET_TRIES) {
            val taken = mutableSetOf<Int>()
            val fleet = mutableListOf<Ship>()
            var failed = false
            for (size in SHIPS) {
                var chosen: List<Int>? = null
                var tries = 0
                while (chosen == null && tries < PLACE_TRIES) {
                    tries++
                    val across = random.nextBoolean()
                    val row = random.nextInt(if (across) WIDTH else WIDTH - size + 1)
                    val col = random.nextInt(if (across) WIDTH - size + 1 else WIDTH)
                    val cells = (0 until size).map { step ->
                        if (across) row * WIDTH + col + step else (row + step) * WIDTH + col
                    }
                    if (cells.none { it in taken }) chosen = cells
                }
                if (chosen == null) {
                    failed = true
                    break
                }
                taken.addAll(chosen)
                fleet.add(Ship(size, chosen))
            }
            if (!failed) return fleet
        }
        return tidyFleet()
    }

    /**
     * A layout that always exists, used only if random placement somehow fails.
     *
     * It is never reached in practice - fourteen squares in sixty-four with four hundred
     * attempts each does not fail - but a game that can loop forever while a family waits
     * is worse than a game that is occasionally boring, so there is a floor.
     */
    private fun tidyFleet(): List<Ship> =
        SHIPS.mapIndexed { index, size -> Ship(size, (0 until size).map { index * WIDTH + it }) }

    /** The four squares touching this one, clipped at the edges. */
    private fun neighbours(cell: Int): List<Int> {
        val row = cell / WIDTH
        val col = cell % WIDTH
        val out = mutableListOf<Int>()
        if (row > 0) out.add(cell - WIDTH)
        if (row < WIDTH - 1) out.add(cell + WIDTH)
        if (col > 0) out.add(cell - 1)
        if (col < WIDTH - 1) out.add(cell + 1)
        return out
    }

    /** "C4" - what a person says out loud, so the log reads like the paper game. */
    private fun label(cell: Int): String = ('A' + cell % WIDTH).toString() + (cell / WIDTH + 1)

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {

        /** Host-side truth. Only the owner gets intact hulls; opponents see fully sunk hulls. */
        private val fleets = linkedMapOf<String, List<Ship>>()

        private val ready = mutableSetOf<String>()

        /** What THIS player has learnt by firing: 0 unfired, 1 miss, 2 hit, 3 part of a sunk ship. */
        private val shots = linkedMapOf<String, IntArray>()

        /** What has been fired at THIS player: 0 nothing, 1 miss, 2 hit. */
        private val incoming = linkedMapOf<String, IntArray>()

        /** "placing" or "firing". A sub-stage of the engine's own "playing" phase. */
        private var stage = "placing"

        init {
            players.forEach { id ->
                fleets[id] = SHIPS.map { Ship(it, emptyList()) }
                shots[id] = IntArray(CELLS)
                incoming[id] = IntArray(CELLS)
            }
            prompt = "Place your five ships, rotate them if you like, then tap Ready."
        }

        private fun name(playerId: String): String = ctx.nameOf(playerId)

        private fun other(playerId: String): String = players.first { it != playerId }

        private fun note(line: String) {
            log.add(line)
            while (log.size > 10) log.removeAt(0)
        }

        override fun onApply(move: GameMove) {
            require(move.playerId in players) { "You are not playing this game." }
            when (move.action) {
                "place" -> place(move.playerId, move.int("ship"), move.int("cell"), move.int("vertical"))
                "remove" -> {
                    requirePlacing(move.playerId)
                    val index = move.int("ship")
                    require(index in SHIPS.indices) { "Choose one of your ships." }
                    fleets[move.playerId] = fleets.getValue(move.playerId).toMutableList().also {
                        it[index] = Ship(SHIPS[index], emptyList())
                    }
                }
                "clear" -> {
                    requirePlacing(move.playerId)
                    fleets[move.playerId] = SHIPS.map { Ship(it, emptyList()) }
                }
                "shuffle" -> {
                    requirePlacing(move.playerId)
                    fleets[move.playerId] = placeFleet(ctx.random)
                }
                "ready" -> {
                    require(stage == "placing") { "Both fleets are already at sea." }
                    require(fleets.getValue(move.playerId).all { it.cells.size == it.size }) {
                        "Place all five ships before you are ready."
                    }
                    ready.add(move.playerId)
                    if (ready.size == players.size) beginFiring()
                    else prompt = "Waiting for " + name(other(move.playerId)) + " to set a fleet."
                }
                "fire" -> fire(move.playerId, move.int("cell"))
                else -> throw IllegalArgumentException("Tap a square to call it.")
            }
        }

        private fun requirePlacing(playerId: String) {
            require(stage == "placing") { "The shooting has started - your ships stay where they are." }
            require(playerId !in ready) { "Your fleet is ready and cannot be moved." }
        }

        private fun place(playerId: String, index: Int, start: Int, vertical: Int) {
            requirePlacing(playerId)
            require(index in SHIPS.indices) { "Choose one of your ships." }
            require(start in 0 until CELLS && vertical in 0..1) { "Choose a square and ship direction." }
            val size = SHIPS[index]
            val row = start / WIDTH
            val col = start % WIDTH
            require(if (vertical == 1) row + size <= WIDTH else col + size <= WIDTH) {
                "Keep the whole ship inside your sea."
            }
            val cells = (0 until size).map { start + it * (if (vertical == 1) WIDTH else 1) }
            val fleet = fleets.getValue(playerId)
            val occupied = fleet.filterIndexed { i, _ -> i != index }.flatMap { it.cells }.toSet()
            require(cells.none { it in occupied }) { "Ships cannot overlap. Choose open water." }
            // Validate first; a rejected drag/rotation must leave the old fleet intact.
            fleets[playerId] = fleet.toMutableList().also { it[index] = Ship(size, cells) }
        }

        private fun beginFiring() {
            stage = "firing"
            turnIndex = 0
            note("Both fleets are at sea.")
            prompt = name(players[0]) + " calls the first square."
            // What a tap MEANS has just changed - from "shuffle my ships" to "fire here" -
            // so any tap still in flight from the placing screen must be thrown away.
            ctx.nextRound()
        }

        private fun fire(playerId: String, cell: Int) {
            require(stage == "firing") { "Set your fleet first." }
            require(players.getOrNull(turnIndex) == playerId) { "It's the other captain's turn." }
            require(cell in 0 until CELLS) { "Tap a square on the enemy sea." }
            val mine = shots.getValue(playerId)
            require(mine[cell] == 0) { "You have already called that square." }
            val target = other(playerId)
            val struck = fleets.getValue(target).firstOrNull { cell in it.cells }
            if (struck == null) {
                mine[cell] = 1
                incoming.getValue(target)[cell] = 1
                note(name(playerId) + " called " + label(cell) + " - miss.")
            } else {
                struck.hits.add(cell)
                mine[cell] = 2
                incoming.getValue(target)[cell] = 2
                award(playerId, 1)
                if (struck.sunk) {
                    // Every square was already hit. Reveal this completed hull without
                    // revealing the positions of any surviving enemy ships.
                    struck.cells.forEach { mine[it] = 3 }
                    note(name(playerId) + " called " + label(cell) + " and sank a ship of " + struck.size + ".")
                } else {
                    note(name(playerId) + " called " + label(cell) + " - hit.")
                }
            }
            if (fleets.getValue(target).all { it.sunk }) {
                prompt = name(playerId) + " sank the whole fleet."
                settleWinner(playerId)
                return
            }
            // ONE SHOT PER TURN, hit or miss. The "a hit lets you go again" variant turns a
            // lucky run into a finished game before the other player has had a look at the
            // board, which on a shared journey is the difference between a game and a sulk.
            turnIndex = 1 - turnIndex
            prompt = name(players[turnIndex]) + " to call a square."
        }

        /** The owner's own sea: 0 water, 1 ship, 2 miss, 3 hit, 4 a square of a sunk ship. */
        private fun ownSea(playerId: String): List<Int> {
            val marks = incoming.getValue(playerId)
            val out = IntArray(CELLS)
            fleets.getValue(playerId).forEach { ship ->
                val value = if (ship.sunk) 4 else 1
                ship.cells.forEach { out[it] = value }
            }
            for (i in 0 until CELLS) {
                if (marks[i] == 1) out[i] = 2
                if (marks[i] == 2 && out[i] != 4) out[i] = 3
            }
            return out.toList()
        }

        override fun hasAnswered(playerId: String): Boolean =
            if (stage == "placing") playerId in ready else players.getOrNull(turnIndex) != playerId

        override fun waitingOn(): List<String> = when {
            phase == "done" -> emptyList()
            stage == "placing" -> players.filter { it !in ready }
            else -> listOfNotNull(players.getOrNull(turnIndex))
        }

        /**
         * A half-played Sea Battle is not a draw the way a half-played board is: hits are
         * earned, they are permanent, and everybody in the car has been counting them out
         * loud. So the player who has landed more hits is ahead and takes a stopped game.
         * Level hits, or a game abandoned during placement, separates nobody.
         */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val hits = players.associateWith { scoreOf(it) }
            val best = hits.values.maxOrNull() ?: 0
            if (best == 0) return MatchResult(Outcome.DRAW, "", hits, "Stopped before a shot landed.")
            val leaders = hits.filterValues { it == best }.keys
            return MatchResult(
                if (leaders.size == 1) Outcome.WINNER else Outcome.DRAW,
                if (leaders.size == 1) leaders.first() else "",
                hits,
                "Stopped - most hits landed.",
            )
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // Public: the shape of the grid, who is ready, and how many ships each side has
            // left afloat. That last one is announced out loud in the paper game too.
            put("width", WIDTH)
            put("stage", stage)
            put("seats", JsonArray(players.map { JsonPrimitive(it) }))
            put("names", JsonArray(players.map { JsonPrimitive(ctx.nameOf(it)) }))
            put("ready", JsonArray(players.map { JsonPrimitive(it in ready) }))
            put("afloat", JsonArray(players.map { id -> JsonPrimitive(fleets[id]?.count { !it.sunk } ?: 0) }))
            put("fleet", JsonArray(SHIPS.map { JsonPrimitive(it) }))

            // PRIVATE. Both arrays belong to the asking viewer and to nobody else. A viewer
            // who is not in this match, and a spectator with no id at all, gets empty ones -
            // not the leader's sea, not seat zero's sea, nothing.
            val own = viewer?.takeIf { it in players }
            put("mySea", JsonArray(own?.let { ownSea(it) }.orEmpty().map { JsonPrimitive(it) }))
            put("myShots", JsonArray(own?.let { shots[it]?.toList() }.orEmpty().map { JsonPrimitive(it) }))
            put("myShips", JsonArray(own?.let { id ->
                fleets.getValue(id).mapIndexed { index, ship -> shipView(index, ship) }
            }.orEmpty()))
            put("mySunkShips", JsonArray(own?.let { id ->
                fleets.getValue(other(id)).mapIndexedNotNull { index, ship ->
                    if (ship.sunk) shipView(index, ship) else null
                }
            }.orEmpty()))
            put("myReady", own != null && own in ready)
            put("myTurn", own != null && players.getOrNull(turnIndex) == own)
        }

        private fun shipView(index: Int, ship: Ship): JsonObject = buildJsonObject {
            put("id", index)
            put("size", ship.size)
            put("cells", JsonArray(ship.cells.map { JsonPrimitive(it) }))
            put("vertical", ship.cells.size > 1 && ship.cells[1] - ship.cells[0] == WIDTH)
            put("sunk", ship.sunk)
        }

        fun botStep(playerId: String, random: Random): GameMove? {
            if (phase != "playing" || playerId !in players) return null
            if (stage == "placing") {
                if (playerId in ready) return null
                return if (fleets.getValue(playerId).any { it.cells.size != it.size })
                    botAction(playerId, "shuffle") else botAction(playerId, "ready")
            }
            if (players.getOrNull(turnIndex) != playerId) return null
            val cell = botTarget(playerId, random) ?: return null
            return botAction(playerId, "fire", "cell", cell)
        }

        /**
         * The next square to call, chosen from this bot's OWN firing record and nothing
         * else. Every square it returns has never been called, so the bot cannot hand
         * [fire] a move that [fire] would then have to refuse.
         */
        private fun botTarget(playerId: String, random: Random): Int? {
            val mine = shots[playerId] ?: return null
            val unknown = (0 until CELLS).filter { mine[it] == 0 }
            if (unknown.isEmpty()) return null
            // A 2 is a hit on a ship that is still afloat: something is wounded next door.
            val follow = (0 until CELLS).filter { mine[it] == 2 }
                .flatMap { neighbours(it) }
                .filter { mine[it] == 0 }
            if (follow.isNotEmpty()) return follow.random(random)
            val spaced = unknown.filter { (it / WIDTH + it % WIDTH) % 2 == 0 }
            return (if (spaced.isNotEmpty()) spaced else unknown).random(random)
        }
    }
}
