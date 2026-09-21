package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * The 5x5 bingo grid, shared by every bingo that marks squares on a card: cell 12 is
 * the free centre, and a "line" is a full row, column or diagonal.
 */
internal object BingoGrid {
    const val SIZE = 5
    const val CELLS = SIZE * SIZE
    const val FREE = 12

    val ROWS: List<List<Int>> = (0 until SIZE).map { r -> (0 until SIZE).map { r * SIZE + it } }
    val COLUMNS: List<List<Int>> = (0 until SIZE).map { c -> (0 until SIZE).map { it * SIZE + c } }
    val DIAGONALS: List<List<Int>> = listOf((0 until SIZE).map { it * (SIZE + 1) }, (1..SIZE).map { it * (SIZE - 1) })
    val LINES: List<List<Int>> = ROWS + COLUMNS + DIAGONALS

    /** Every complete row, column and diagonal in [marks]. The free centre counts only if it is in [marks]. */
    fun completeLines(marks: Set<Int>): List<List<Int>> = LINES.filter { line -> line.all { it in marks } }

    fun hasLine(marks: Set<Int>): Boolean = completeLines(marks).isNotEmpty()
}

/** Card generation for Nature Bingo, kept free of any match state so it can be tested directly. */
internal object NatureBingoCards {

    const val FREE_LABEL = "FREE"

    /**
     * A 25-square card: 24 different things from the chosen packs, shuffled, with the
     * free square in the centre. Throws if the packs cannot fill a card.
     */
    fun generate(packs: Set<NaturePack>, random: Random): List<String> {
        val pool = NatureBingoContent.itemsFor(packs).map { it.label }.distinct()
        require(pool.size >= BingoGrid.CELLS - 1) { "Choose more packs to fill a card." }
        return pool.shuffled(random).take(BingoGrid.CELLS - 1).toMutableList().also { it.add(BingoGrid.FREE, FREE_LABEL) }
    }

    /** Host settings: "packs=easy+night;verify=off". Unknown packs are ignored; no packs means Easy and Forest. */
    data class Settings(val packs: Set<NaturePack>, val verify: Boolean)

    fun settings(setup: String): Settings {
        val pairs = setup.lowercase().split(';').mapNotNull {
            val bits = it.split('=', limit = 2)
            if (bits.size == 2) bits[0].trim() to bits[1].trim() else null
        }.toMap()
        val packs = pairs["packs"].orEmpty().split('+', ' ', ',')
            .mapNotNull { w -> NaturePack.entries.firstOrNull { it.wire == w } }.toSet()
        return Settings(packs.ifEmpty { setOf(NaturePack.EASY, NaturePack.FOREST) }, pairs["verify"] != "off")
    }
}

/**
 * Nature Bingo - Car Bingo's outdoor cousin. Every phone gets its own card of things to
 * spot; a full line lets you call Bingo, and the host checks it before it counts.
 *
 * Photo proof never touches this class: a picture stays on the phone that took it and
 * the host is only ever told "square 7 is marked". Show the host your phone to prove it.
 */
internal object NatureBingoGame : CampsiteGame {
    override val id = "naturebingo"
    override val title = "Nature Bingo"
    override val blurb = "Spot things outdoors on your own card. The host checks your line."
    override val kind = "grid"
    override val seats = Seats.any(2)
    override val category = GameCategory.OUTDOORS
    override val needsGuests = false
    override val usesCamera = true
    override val localRoute = "naturebingo"

    /** A walk outdoors does not fit a bracket's stall timer. */
    override val tournamentReady = false

    override fun validateSetup(text: String) {
        require(text.length <= 80) { "Those settings are too long." }
    }

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch =
        Match(players, ctx, NatureBingoCards.settings(setup))

    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botMove(playerId, random)

    private class Match(players: List<String>, ctx: MatchContext, private val settings: NatureBingoCards.Settings) :
        BaseMatch(players, ctx) {
        private val cards = mutableMapOf<String, List<String>>()
        private val marks = mutableMapOf<String, MutableSet<Int>>()
        /** Players who have called Bingo and are waiting for the host, in the order they called. */
        private val claims = linkedSetOf<String>()

        init {
            prompt = "Look, don't touch: spot it, tap it, and call Bingo on a full line."
            players.forEach { id ->
                cards[id] = NatureBingoCards.generate(settings.packs, ctx.random)
                marks[id] = mutableSetOf(BingoGrid.FREE)
            }
        }

        override fun onApply(move: GameMove) {
            require(phase == "playing") { "This round has finished." }
            val mine = marks[move.playerId] ?: throw IllegalArgumentException("You are not in this round.")
            when (move.action) {
                "claim" -> {
                    val cell = move.int("cell")
                    require(cell in 0 until BingoGrid.CELLS && cell != BingoGrid.FREE) { "Choose a bingo square." }
                    // Outdoors a tap is deliberate, so a second tap un-marks a square you got wrong.
                    if (!mine.add(cell)) mine.remove(cell)
                    if (move.playerId in claims && !BingoGrid.hasLine(mine)) claims.remove(move.playerId)
                }
                "bingo" -> {
                    require(BingoGrid.hasLine(mine)) { "You need a full row, column or diagonal first." }
                    if (!settings.verify) {
                        win(move.playerId)
                    } else if (claims.add(move.playerId)) {
                        log.add(ctx.nameOf(move.playerId) + " called Bingo! Waiting for the host to check.")
                    }
                }
                "verify", "reject" -> {
                    require(move.playerId == ctx.leader()) { "Only the host can check a Bingo." }
                    val target = move.text("target")
                    require(target in claims) { "That Bingo call has been withdrawn." }
                    if (move.action == "verify") {
                        win(target)
                    } else {
                        claims.remove(target)
                        log.add(ctx.nameOf(target) + "'s Bingo wasn't confirmed. Keep looking!")
                    }
                }
                else -> throw IllegalArgumentException("Unknown game action.")
            }
        }

        private fun win(playerId: String) {
            award(playerId, 1)
            log.add(ctx.nameOf(playerId) + " got Bingo!")
            settleWinner(playerId)
        }

        fun botMove(playerId: String, random: Random): GameMove? {
            if (phase != "playing") return null
            val mine = marks[playerId] ?: return null
            if (playerId == ctx.leader() && claims.isNotEmpty()) return botAction(playerId, "verify", "target", claims.first())
            if (BingoGrid.hasLine(mine) && playerId !in claims) return botAction(playerId, "bingo")
            if (playerId in claims) return null
            val open = (0 until BingoGrid.CELLS).filter { it != BingoGrid.FREE && it !in mine }
            return if (open.isEmpty()) null else botAction(playerId, "claim", "cell", open.random(random))
        }

        override fun hasAnswered(playerId: String): Boolean = playerId in claims

        override fun waitingOn(): List<String> =
            if (phase != "playing") emptyList() else if (claims.isNotEmpty()) listOf(ctx.leader()) else players

        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped before a line.")

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            put("bingo", JsonArray(viewer?.let { cards[it] }.orEmpty().map { JsonPrimitive(it) }))
            put("marks", JsonArray(viewer?.let { marks[it] }.orEmpty().map { JsonPrimitive(it) }))
            put("hasLine", viewer?.let { marks[it] }?.let { BingoGrid.hasLine(it) } ?: false)
            put("verify", settings.verify)
            put("packs", JsonArray(settings.packs.map { JsonPrimitive(it.label) }))
            // A called Bingo is public: the whole circle can see the line being checked.
            put("claims", buildJsonArray {
                claims.forEach { id ->
                    val card = cards[id].orEmpty()
                    val line = BingoGrid.completeLines(marks[id].orEmpty()).firstOrNull().orEmpty()
                    add(buildJsonObject {
                        put("id", id)
                        put("line", JsonArray(line.map { JsonPrimitive(card.getOrElse(it) { "" }) }))
                    })
                }
            })
        }
    }
}
