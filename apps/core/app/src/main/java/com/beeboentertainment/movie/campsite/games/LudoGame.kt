package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Ludo - four tokens each, a six to leave the yard, land on somebody to send them back,
 * all four home wins.
 *
 * Ludo is the public-domain English name of the game (itself a simplification of Pachisi)
 * and is the name used throughout. The American trademarked variant of the same board is
 * a different product with a different name, and that name is in no string, comment or
 * identifier here.
 *
 * THE NEVER-ENDING GAME, AND WHAT IS DONE ABOUT IT.
 *
 * Ludo's famous problem is that it has no natural end. Capturing sends a token all the way
 * back to the yard, so two players who keep meeting can undo each other's progress
 * indefinitely, and the last token needing an exact roll can sit one square short for ten
 * turns. In a living room that is a feature. In a car it is how a game gets abandoned
 * half-played with everybody cross.
 *
 * The fix here is deliberately NOT a rule change. Weakening capture, or dropping the exact
 * finish, would not be Ludo any more - capture IS the game. Instead the game is bounded
 * from outside it:
 *
 *  - A HARD TURN CAP. After [TURN_CAP] completed turns the match stops and is decided on
 *    total progress: every square every token has travelled, added up. That is the honest
 *    measure of who was winning, it is the measure a person in the back seat would use,
 *    and it can be read off the board so nobody has to take the host's word for it.
 *  - The same measure is what [resultIfStoppedNow] uses, so a game abandoned early and a
 *    game that hit the cap are judged by exactly the same yardstick.
 *
 * Two simplifications and one classic penalty, all stated so nobody thinks they are bugs:
 *
 *  - NO BLOCKING. Two of your own tokens may share a square; they do not form a wall.
 *    Blocking is the rule that most often produces a stuck board, and explaining it to a
 *    six year old on a phone costs more than it is worth.
 *  - NO BONUS ROLL FOR A CAPTURE. A six already grants another roll; stacking a second
 *    bonus on top of a capture is what makes a good run unstoppable.
 *  - THREE SIXES FORFEIT THE TURN. A six gives another roll, but a third six in a row
 *    is not moved: the turn passes on the spot. That is the classic rule, and without
 *    it a lucky run could carry a token from the yard to the run-in in one go.
 *
 * Everything in this game is public. Ludo is played face up on one board, so the snapshot
 * is the same for every viewer and there is nothing here a spectator must be kept from.
 */
internal object LudoGame : CampsiteGame {
    override val id = "ludo"
    override val title = "Ludo"
    override val blurb = "Race four tokens home. Roll a six to start, land on someone to send them back."
    override val kind = "board"
    override val seats = Seats.of(2, 4)
    override val category = GameCategory.BOARD

    /** Squares in the shared ring. */
    private const val TRACK = 52

    /** Squares in a player's own private run-in, the last one being home. */
    private const val HOME_RUN = 6

    /** Progress values: -1 in the yard, 0..51 on the ring, 52..57 the run-in, 57 is home. */
    private const val HOME = TRACK + HOME_RUN - 1
    private const val YARD = -1
    private const val TOKENS = 4

    private const val TURN_CAP = 240

    /** Sixes in a row that forfeit the turn - the classic penalty. */
    private const val SIXES_FORFEIT = 3

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size >= 2) { "Ludo needs at least two players." }
        return Match(players.take(4), ctx)
    }

    /**
     * The bot rolls when it must roll, and otherwise plays the move a person would.
     *
     * Its order of preference is capture, then get a token home, then bring one out of the
     * yard, then push the leading token on; one move in five it simply takes a legal move
     * at random so it is not the same opponent every single journey. It never invents a
     * move: every candidate comes from the match's own list of legal tokens, which is the
     * same list the rules then check the move against.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botStep(playerId, random)

    private class Match(players: List<String>, ctx: MatchContext) : BaseMatch(players, ctx) {

        /** Progress per token, per seat. The whole state of the game is in here. */
        private val tokens = linkedMapOf<String, IntArray>()

        /** Where each seat joins the ring, so one ring serves everybody. */
        private val offsets = linkedMapOf<String, Int>()

        private var die = 0
        private var rollId = 0
        private var rollFace = 0
        private var rollBy = ""
        private var pendingRoll = true

        /** Sixes rolled in a row this turn. The third one forfeits the turn. */
        private var sixesThisTurn = 0
        private var turns = 0

        /** Tokens the current roll may legally move. Recomputed by the host on every roll. */
        private var legal: List<Int> = emptyList()

        init {
            // Seats sit at the corners of the cross, thirteen squares apart, exactly as
            // the printed board has them: 0/13/26/39 for four players, 0/13/26 for three.
            // Two players sit opposite each other (0/26) so they are not chasing at close
            // quarters. Everything else - entry square, exit square, safe squares - reads
            // [offsets], so the ring geometry lives in this one place.
            val step = if (players.size == 2) TRACK / 2 else TRACK / 4
            players.forEachIndexed { seat, id ->
                tokens[id] = IntArray(TOKENS) { YARD }
                offsets[id] = seat * step
                scores[id] = 0
            }
            prompt = ctx.nameOf(players[0]) + " rolls first. A six brings a token out."
        }

        private fun name(playerId: String): String = ctx.nameOf(playerId)

        private fun note(line: String) {
            log.add(line)
            while (log.size > 10) log.removeAt(0)
        }

        /** The ring square a progress value sits on, or -1 when it is in the yard or the run-in. */
        private fun square(playerId: String, progress: Int): Int =
            if (progress in 0 until TRACK) (offsets.getValue(playerId) + progress) % TRACK else -1

        /**
         * The entry squares are safe: a token cannot be captured on one.
         *
         * Without this, a token that has just come out of the yard can be sent straight back
         * by the player sitting behind it, and a game where a six achieves nothing is a game
         * nobody finishes.
         */
        private fun safe(): Set<Int> = offsets.values.toSet()

        private fun target(playerId: String, token: Int): Int {
            val progress = tokens.getValue(playerId)[token]
            return if (progress == YARD) 0 else progress + die
        }

        /** Which of this player's tokens the current [die] may move. The only source of legality. */
        private fun legalFor(playerId: String, roll: Int): List<Int> {
            val mine = tokens[playerId] ?: return emptyList()
            return (0 until TOKENS).filter { index ->
                val progress = mine[index]
                when {
                    progress == HOME -> false
                    progress == YARD -> roll == 6
                    // Exact count into the run-in. Overshooting is simply not a move.
                    else -> progress + roll <= HOME
                }
            }
        }

        // Squares travelled, per player - the yardstick for the turn cap and for a game
        // stopped early. Kept apart from [scores] on purpose: scores are POINTS, and they
        // reach the history and the championship table as points. Writing distances into
        // them handed the leaderboard numbers like 37 for a game somebody simply lost.
        private val travelled = HashMap<String, Int>()

        private fun syncScores() {
            players.forEach { id ->
                var total = 0
                tokens.getValue(id).forEach { progress -> if (progress != YARD) total += progress + 1 }
                travelled[id] = total
            }
        }

        override fun onApply(move: GameMove) {
            require(phase == "playing") { "This game has finished." }
            require(move.playerId in players) { "You are not playing this game." }
            require(players.getOrNull(turnIndex) == move.playerId) { "It's not your turn." }
            when (move.action) {
                "roll" -> roll(move.playerId)
                "move" -> step(move.playerId, move.int("token"))
                else -> throw IllegalArgumentException("Tap Roll, then tap a token.")
            }
        }

        private fun roll(playerId: String) {
            require(pendingRoll) { "You rolled a " + die + " - now tap a token to move." }
            // THE HOST ROLLS. The action carries no number for a phone to choose.
            die = ctx.random.nextInt(1, 7)
            rollId++
            rollFace = die
            rollBy = playerId
            if (die == 6) {
                sixesThisTurn++
                if (sixesThisTurn >= SIXES_FORFEIT) {
                    // The classic penalty: the third six in a row is not moved, and the
                    // turn passes on the spot.
                    note(name(playerId) + " rolled three sixes in a row - turn passes.")
                    endTurn()
                    return
                }
            }
            legal = legalFor(playerId, die)
            if (legal.isEmpty()) {
                // Nothing to move is not a mistake, so there is no Pass button to find and
                // no way for a round to die because somebody did not notice they were stuck.
                note(name(playerId) + " rolled " + die + " and could not move.")
                if (die == 6) {
                    prompt = name(playerId) + " rolled a six - roll again."
                } else {
                    endTurn()
                }
                return
            }
            pendingRoll = false
            prompt = name(playerId) + " rolled " + die + " - choose a token."
        }

        private fun step(playerId: String, token: Int) {
            require(!pendingRoll) { "Tap Roll first." }
            require(token in legal) { "That token cannot move " + die + "." }
            val mine = tokens.getValue(playerId)
            val to = target(playerId, token)
            val leftYard = mine[token] == YARD
            mine[token] = to
            var captured = 0
            if (to < TRACK) {
                val landing = square(playerId, to)
                if (landing !in safe()) {
                    players.forEach { rival ->
                        if (rival != playerId) {
                            val theirs = tokens.getValue(rival)
                            for (i in 0 until TOKENS) {
                                if (theirs[i] in 0 until TRACK && square(rival, theirs[i]) == landing) {
                                    theirs[i] = YARD
                                    captured++
                                }
                            }
                        }
                    }
                }
            }
            syncScores()
            note(
                when {
                    captured > 0 -> name(playerId) + " rolled " + die + " and sent " + captured + " token(s) home."
                    to == HOME -> name(playerId) + " got a token home."
                    leftYard -> name(playerId) + " rolled a six and brought a token out."
                    else -> name(playerId) + " moved a token " + die + "."
                }
            )
            if (mine.all { it == HOME }) {
                prompt = name(playerId) + " got all four tokens home."
                award(playerId, 1)
                settleWinner(playerId)
                return
            }
            pendingRoll = true
            legal = emptyList()
            // A third six never gets this far - [roll] forfeits the turn before a token
            // can be chosen - so a six here always earns another roll.
            if (die == 6) {
                prompt = name(playerId) + " rolled a six - roll again."
                return
            }
            endTurn()
        }

        private fun endTurn() {
            turns++
            sixesThisTurn = 0
            pendingRoll = true
            legal = emptyList()
            if (turns >= TURN_CAP) {
                stopOnProgress("That is a long enough game of Ludo.")
                return
            }
            turnIndex = (turnIndex + 1) % players.size
            prompt = name(players[turnIndex]) + " to roll."
        }

        /** Total squares travelled by all four tokens - the cap's yardstick and the stall's. */
        private fun standings(): Map<String, Int> = players.associateWith { travelled[it] ?: 0 }

        /** One point to the named player, none to anybody else - what a result carries. */
        private fun pointsTo(playerId: String): Map<String, Int> =
            players.associateWith { if (it == playerId) 1 else 0 }

        private fun stopOnProgress(why: String) {
            val places = standings()
            val best = places.values.maxOrNull() ?: 0
            val leaders = places.filterValues { it == best }.keys
            prompt = why
            if (leaders.size == 1) {
                winner = leaders.first()
                award(winner, 1)
                settle(MatchResult(Outcome.WINNER, winner, scores.toMap(), why + " Furthest along wins."))
            } else {
                settle(MatchResult(Outcome.DRAW, "", scores.toMap(), why + " Dead level."))
            }
        }

        override fun hasAnswered(playerId: String): Boolean =
            players.getOrNull(turnIndex) != playerId

        override fun waitingOn(): List<String> =
            if (phase == "done") emptyList() else listOfNotNull(players.getOrNull(turnIndex))

        /**
         * Same yardstick as the turn cap: whoever has travelled furthest was winning. A
         * game stopped before anybody left the yard separates nobody.
         */
        override fun resultIfStoppedNow(): MatchResult {
            result()?.let { return it }
            val places = standings()
            val best = places.values.maxOrNull() ?: 0
            if (best == 0) return MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped before anyone got going.")
            val leaders = places.filterValues { it == best }.keys
            val ahead = if (leaders.size == 1) leaders.first() else ""
            return MatchResult(
                if (ahead.isNotEmpty()) Outcome.WINNER else Outcome.DRAW,
                ahead,
                if (ahead.isNotEmpty()) pointsTo(ahead) else scores.toMap(),
                "Stopped - furthest along wins.",
            )
        }

        override fun JsonObjectBuilder.decorate(viewer: String?) {
            // All public. One board, sixteen tokens, everybody looking at the same thing.
            put("track", TRACK)
            put("homeRun", HOME_RUN)
            put("home", HOME)
            put("tokenCount", TOKENS)
            put("seats", JsonArray(players.map { JsonPrimitive(it) }))
            put("names", JsonArray(players.map { JsonPrimitive(ctx.nameOf(it)) }))
            put("offsets", JsonArray(players.map { JsonPrimitive(offsets[it] ?: 0) }))
            put("tokens", JsonArray(players.map { id ->
                JsonArray(tokens.getValue(id).map { JsonPrimitive(it) })
            }))
            put("squares", JsonArray(players.map { id ->
                JsonArray(tokens.getValue(id).map { JsonPrimitive(square(id, it)) })
            }))
            put("safe", JsonArray(safe().sorted().map { JsonPrimitive(it) }))
            put("die", die)
            // Keep the public roll result even when a no-move turn resets the live die.
            put("rollId", rollId)
            put("rollFaces", JsonArray(if (rollId > 0) listOf(JsonPrimitive(rollFace)) else emptyList()))
            put("rollBy", rollBy)
            put("pendingRoll", pendingRoll)
            val onTurn = viewer != null && players.getOrNull(turnIndex) == viewer
            put("myTurn", onTurn)
            // Only meaningful to the player on turn; it is derivable from the board anyway,
            // so it is a convenience for drawing, not a secret.
            put("legal", JsonArray(if (onTurn) legal.map { JsonPrimitive(it) } else emptyList()))
        }

        fun botStep(playerId: String, random: Random): GameMove? {
            if (phase != "playing") return null
            if (players.getOrNull(turnIndex) != playerId) return null
            if (pendingRoll) return botAction(playerId, "roll")
            if (legal.isEmpty()) return null
            val mine = tokens.getValue(playerId)
            val capture = legal.firstOrNull { wouldCapture(playerId, it) }
            val finisher = legal.firstOrNull { target(playerId, it) == HOME }
            val leaving = legal.firstOrNull { mine[it] == YARD }
            val furthest = legal.maxByOrNull { mine[it] } ?: legal.first()
            val pick = capture
                ?: finisher
                ?: leaving
                ?: if (random.nextInt(5) == 0) legal.random(random) else furthest
            return botAction(playerId, "move", "token", pick)
        }

        /** Would this legal move land on an opponent outside a safe square. Board-visible only. */
        private fun wouldCapture(playerId: String, token: Int): Boolean {
            val to = target(playerId, token)
            if (to >= TRACK) return false
            val landing = square(playerId, to)
            if (landing in safe()) return false
            return players.any { rival ->
                rival != playerId && tokens.getValue(rival).any { progress ->
                    progress in 0 until TRACK && square(rival, progress) == landing
                }
            }
        }
    }
}
