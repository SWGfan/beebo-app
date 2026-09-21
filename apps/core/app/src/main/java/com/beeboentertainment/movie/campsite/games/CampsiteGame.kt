package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.party.games.TriviaQuestion
import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * The contract every campsite game implements.
 *
 * WHY this exists: twenty games cannot live in one file and one `when` block. The
 * split is deliberately in two halves -
 *
 *  - [CampsiteGame] is the *description* of a game: a singleton that knows its id,
 *    its title, and how many phones it seats. It holds no state, so it can be listed
 *    in a menu and asked to start ten matches at once.
 *  - [GameMatch] is *one live match* between a named set of players. Everything that
 *    changes lives here.
 *
 * That separation is what makes a tournament possible at all: a bracket needs two
 * matches of the same game running side by side, which a one-room-per-game service
 * can never do.
 *
 * THE RULE THAT OUTRANKS EVERYTHING: this engine is host-authoritative. A [GameMove]
 * carries a player id the *host* looked up from the session cookie, never one the
 * phone typed. A match is handed only that id and the fields of the request, and it
 * alone decides what the move did. No guest ever supplies a score, a winner, a
 * correct answer, the board, or another player's identity. The people playing are
 * sitting next to each other and can see each other's screens, so [view] is the
 * other half of that rule: it is per-player on purpose, and a game with private
 * state (a hand of cards, a bingo card, a secret word) must put that state only in
 * the asking player's own view. Anything in a view is effectively public to the room.
 */
internal interface CampsiteGame {

    /** Stable wire id. Never change one: it is in saved history and in guest bookmarks. */
    val id: String

    /** What a guest sees in the menu and at the top of the round. */
    val title: String

    /** One line of "what is this" for the menu. Served to the page so a new game needs no page edit. */
    val blurb: String

    /**
     * A hint for the guest page about which control set to draw: "board", "poll",
     * "grid", "text" or "claim". Presentation only - no rule ever depends on it.
     */
    val kind: String

    /** How many phones this game seats: fixed two, a range, or as many as turn up. */
    val seats: Seats

    /** True when the leader must type something private before a match can begin. */
    val needsSetup: Boolean get() = false

    /**
     * True when the game only makes sense with other people on other phones: a vote whose
     * point is how the room split, a secret somebody else has to guess, a game of keeping
     * quiet. False (the default) means one person on this phone can play it against
     * computer players with no Wi-Fi, no hotspot and no guest server.
     *
     * The host's Games list reads it: a true game says "Needs other phones" and offers
     * "Invite players" instead of opening. It never changes the rules - bots still work
     * in these rooms once people have joined.
     */
    val needsGuests: Boolean get() = false

    /**
     * True for a game that one person can play with nobody else and no computer player, such as a
     * checklist. The host's Games list then says "Play on this phone" and does not seat a bot.
     * Never changes the rules.
     */
    val playsSolo: Boolean get() = false

    /** Which section of the host's Games list this sits in. Every game should set it. */
    val category: GameCategory get() = GameCategory.PARTY

    /**
     * Whether results count towards the leaderboard. False for games whose "winner"
     * is a raffle (Pick the Next One) or which have no winner at all (Story Builder):
     * counting those would make the champion whoever suggested the most films.
     */
    val ranked: Boolean get() = true

    /**
     * Whether a bracket makes sense. A game needing a typed secret cannot be
     * auto-started in eight simultaneous heats, so it stays a free-play game.
     */
    val tournamentReady: Boolean get() = ranked && !needsSetup && seats.min >= 2

    /*
     * Android TV. A game states what it physically needs; whether a TV lists it is derived
     * from that, never set by hand, so a new game gets it right by default.
     */

    /**
     * True when the game's core control is a finger on a touch screen (drawing, dragging,
     * tapping cells fast), so it is hidden on Android TV where only a remote is available.
     * Everything else is plain buttons and text fields, which a D-pad can reach.
     */
    val needsTouch: Boolean get() = false

    /** Uses a camera (photo proof). A TV has none, so such a game is hidden there. */
    val usesCamera: Boolean get() = false

    /** Played by handing one device round the circle. Hidden on a TV, which nobody can pass. */
    val passThePhone: Boolean get() = false

    /**
     * Whether Android TV can offer this game. Derived from the facts above by
     * [com.beeboentertainment.movie.core.TvFeatures.gameShowsOnTv]; games do not override it.
     */
    val showOnTv: Boolean
        get() = com.beeboentertainment.movie.core.TvFeatures.gameShowsOnTv(needsTouch, usesCamera, passThePhone)

    /**
     * An in-app route that plays this game on the host phone with no guest server
     * running (for example "hotpotato"), or null when the game only exists as a room.
     */
    val localRoute: String? get() = null

    /** Reject a bad setup string before any state is touched, with a guest-facing message. */
    fun validateSetup(text: String) {}

    /**
     * Start one match. Throws [IllegalArgumentException] with a guest-facing message if
     * it cannot start (no cached questions, for example) - the caller relies on that to
     * leave the previous round untouched.
     */
    fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch

    /** A legal move a bot can make right now, or null when the bot cannot act. Default: this game has no bot. */
    fun botMove(match: GameMatch, playerId: String, random: kotlin.random.Random): GameMove? = null
}

/**
 * The sections of the host's Games list, in the order they are shown. Games inside a
 * section are listed alphabetically, so the declaration order here is the only order.
 */
internal enum class GameCategory(val title: String, val chip: String) {
    CARD("Card games", "Card"),
    BOARD("Board & dice games", "Board"),
    PARTY("Party games", "Party"),
    PUZZLE("Puzzles", "Puzzle"),
    WORD_AND_TALK("Word & talk games", "Word & talk"),
    OUTDOORS("Outdoors & travel", "Outdoors"),
}

/**
 * How a game builds its bot's move.
 *
 * WHY IT LIVES HERE AND NOT IN THE SERVICE: a bot's move must be indistinguishable
 * from a human's once it reaches [GameMatch.apply] - same action names, same body
 * fields, same rule checks, no side door. These helpers only wrap the JSON a phone
 * would have sent, so a bot is subject to every `require` in the match exactly as a
 * guest is. The host still supplies the player id, which is the whole point: a bot id
 * is minted by the host and belongs to no session, so no phone can ever hold one.
 */
internal fun botAction(playerId: String, action: String): GameMove =
    GameMove(playerId, action, JsonObject(emptyMap()))

internal fun botAction(playerId: String, action: String, key: String, value: Int): GameMove =
    GameMove(playerId, action, buildJsonObject { put(key, value) })

internal fun botAction(playerId: String, action: String, key: String, value: String): GameMove =
    GameMove(playerId, action, buildJsonObject { put(key, value) })

/**
 * How many phones a game seats.
 *
 * [max] is also how a tournament splits a crowd: a 2-seat game makes pairs, a 4-seat
 * game makes heats of four, and a game that takes everyone makes a single match.
 */
internal data class Seats(val min: Int, val max: Int) {
    fun fits(count: Int): Boolean = count >= min

    companion object {
        /** Room cap is twelve; this is only a sane ceiling for "everyone". */
        const val MANY = 64
        fun exactly(n: Int) = Seats(n, n)
        fun of(min: Int, max: Int) = Seats(min, max)
        fun any(min: Int = 2) = Seats(min, MANY)
    }
}

/**
 * One player's move, already authenticated by the host.
 *
 * [playerId] comes from the session table, NOT from the request body. A phone can put
 * whatever it likes in the JSON; it can never claim to be someone else.
 */
internal class GameMove(
    val playerId: String,
    val action: String,
    private val body: JsonObject,
) {
    fun text(key: String = "text"): String = (body[key] as? JsonPrimitive)?.content.orEmpty()
    fun int(key: String): Int = (body[key] as? JsonPrimitive)?.intOrNull ?: -1
}

/** Everything a match is allowed to ask the host for. Nothing here comes from a guest. */
internal interface MatchContext {
    val random: Random
    fun now(): Long

    /** Display name for a player id, for log lines the whole room reads. */
    fun nameOf(playerId: String): String

    /**
     * Who may press the leader-only buttons (reveal, next, finish, judge). In free play
     * that is the room leader; inside a tournament heat it is the first seat of that
     * heat, because the room leader may not even be in the match and a heat must never
     * wait on somebody who is not at it.
     */
    fun leader(): String

    /**
     * Invalidate every guest action that was in flight for the previous round. Call it
     * when the thing a tap would have meant has changed underneath - a new question, a
     * new deal. Guests echo the round number back with each action and get a polite
     * "the round changed, try again" instead of a tap landing on the wrong question.
     */
    fun nextRound()

    /** Host-owned question pack. A guest never supplies questions or correct answers. */
    fun trivia(count: Int): List<TriviaQuestion>
}

/** How a finished match ended. */
internal enum class Outcome(val wire: String) {
    /** One player beat the others. */
    WINNER("winner"),

    /** Nobody won and nobody can be separated by the game's own rules. */
    DRAW("draw"),

    /** There is a score per player; the top score wins if it is unique. */
    SCORES("scores"),

    /** Ended because the other side stopped being there. Recorded, but never rated. */
    WALKOVER("walkover"),

    /** Ended with no result at all - everybody left. Advances nobody, rates nobody. */
    VOID("void"),
}

/** What a match reports when it is over. */
internal data class MatchResult(
    val outcome: Outcome,
    val winnerId: String = "",
    val scores: Map<String, Int> = emptyMap(),
    val note: String = "",
    /**
     * Everybody on the winning side, for team games (the villagers, the werewolves). A
     * team has no single [winnerId], but each of its members still won and history must
     * say so. Empty for every one-winner game.
     */
    val winners: Set<String> = emptySet(),
) {
    val decisive: Boolean get() = winnerId.isNotBlank() && outcome != Outcome.VOID
}

/**
 * One live match. Created by [CampsiteGame.create], driven by [apply], read by [view].
 */
internal interface GameMatch {

    /** Seat order. Seat 0 moves first and is the heat leader inside a tournament. */
    val players: List<String>

    /** "playing", "revealed" (answers shown, round not over) or "done". */
    val phase: String

    /** Host clock reading of the last accepted move, for stall detection. */
    val lastMoveAt: Long

    /**
     * Apply one move. Throws [IllegalArgumentException] with a message meant for the
     * guest's screen when the move is not allowed. Must never trust anything but
     * [GameMove.playerId] for identity.
     */
    fun apply(move: GameMove)

    /**
     * The state THIS viewer is allowed to see. `null` means "no viewer" - a spectator
     * or a bracket cell - and must return nothing private to anybody. Private state
     * belongs behind a `viewer == owner` check and nowhere else.
     */
    fun view(viewer: String?): JsonObject

    fun scoreOf(playerId: String): Int

    /** Roster hint: has this player answered the thing we are waiting for. */
    fun hasAnswered(playerId: String): Boolean

    /**
     * Who the match is waiting for right now. The tournament uses it so a match is
     * never timed out because of someone who has already taken their turn, and a UI
     * can say "waiting for Ben".
     */
    fun waitingOn(): List<String>

    /** Non-null once the match is over. */
    fun result(): MatchResult?

    /**
     * The fairest result if the match had to be stopped where it stands - a board with
     * no line is a draw, a scored game is its current scores. Used when a match stalls;
     * it is the game's own judgement, not the tournament's guess.
     */
    fun resultIfStoppedNow(): MatchResult

    /** End the match from outside (walkover, timeout, everybody left). */
    fun close(result: MatchResult, note: String)

    /** One short public line for a bracket cell. Must never leak private state. */
    fun line(): String
}

/**
 * Shared plumbing for a match: phase, prompt, seat order, scores, a log, and the
 * default snapshot fields the guest page always reads.
 *
 * Kept deliberately thin. Everything here is something the *engine* needs (who is
 * playing, whose turn, what the score is, is it over) rather than something a
 * particular game needs, so this cannot quietly grow back into the one-class-holds-
 * every-game shape this refactor exists to undo.
 */
internal abstract class BaseMatch(
    final override val players: List<String>,
    protected val ctx: MatchContext,
) : GameMatch {

    final override var phase: String = "playing"
        private set

    final override var lastMoveAt: Long = ctx.now()
        private set

    protected var prompt: String = ""
    protected var winner: String = ""

    /** Index into [players]. Games with no turn order leave it at seat 0, as before. */
    protected var turnIndex: Int = 0

    protected val scores = linkedMapOf<String, Int>()
    protected val log = mutableListOf<String>()
    private var outcome: MatchResult? = null

    init {
        players.forEach { scores[it] = 0 }
    }

    final override fun apply(move: GameMove) {
        require(phase != "done") { "This round has finished." }
        onApply(move)
        lastMoveAt = ctx.now()
    }

    protected abstract fun onApply(move: GameMove)

    protected fun award(playerId: String, points: Int) {
        scores[playerId] = (scores[playerId] ?: 0) + points
    }

    protected fun markRevealed() {
        if (phase == "playing") phase = "revealed"
    }

    /**
     * Finish. Note it does NOT touch the displayed [winner]: a game with scores and no
     * single victor (a trivia round, a vote) showed no winner banner before this
     * refactor and must not start showing one now. Only [settleWinner] and an outside
     * [close] name a winner on screen; [MatchResult] still carries one for the bracket
     * and the history, which is a different question from what the round announces.
     */
    protected fun settle(result: MatchResult) {
        outcome = result
        phase = "done"
    }

    /** Finish with the winner the rules just produced, and say so on screen. */
    protected fun settleWinner(playerId: String) {
        winner = playerId
        settle(MatchResult(Outcome.WINNER, playerId, scores.toMap()))
    }

    /** Back to taking answers - a new question in the same match. */
    protected fun resumePlaying() {
        if (phase == "revealed") phase = "playing"
    }

    protected fun settleDraw(note: String = "") {
        settle(MatchResult(Outcome.DRAW, "", scores.toMap(), note))
    }

    /** Finish on points. The winner is the top score only when it is not shared. */
    protected fun settleScores(note: String = "") {
        settle(MatchResult(Outcome.SCORES, topScorer(), scores.toMap(), note))
    }

    protected fun topScorer(): String {
        val best = scores.values.maxOrNull() ?: return ""
        val leaders = scores.filterValues { it == best }.keys
        return if (leaders.size == 1) leaders.first() else ""
    }

    final override fun close(result: MatchResult, note: String) {
        if (note.isNotBlank()) prompt = note
        if (result.winnerId.isNotBlank()) winner = result.winnerId
        settle(result)
    }

    override fun result(): MatchResult? = outcome

    override fun resultIfStoppedNow(): MatchResult =
        outcome ?: MatchResult(Outcome.SCORES, topScorer(), scores.toMap(), "Stopped before the end.")

    override fun scoreOf(playerId: String): Int = scores[playerId] ?: 0

    override fun hasAnswered(playerId: String): Boolean = false

    override fun waitingOn(): List<String> = if (phase == "done") emptyList() else players

    override fun line(): String = when {
        phase == "done" && winner.isNotBlank() -> ctx.nameOf(winner) + " won"
        phase == "done" -> "Finished"
        else -> waitingOn().singleOrNull()?.let { ctx.nameOf(it) + " to play" } ?: "In play"
    }

    /**
     * Every field the guest page reads, with an empty default for the games that do
     * not use it. A game adds only what it actually owns, which is why a new game does
     * not have to know what the other nineteen put in the snapshot.
     */
    final override fun view(viewer: String?): JsonObject = buildJsonObject {
        MatchFields.defaults(players.size).forEach { (key, value) -> put(key, value) }
        put("prompt", prompt)
        put("turn", players.getOrNull(turnIndex).orEmpty())
        put("winner", winner)
        put("log", JsonArray(log.map { JsonPrimitive(it) }))
        decorate(viewer)
    }

    /** Add this game's own fields. Anything private must be behind a [viewer] check. */
    protected open fun JsonObjectBuilder.decorate(viewer: String?) {}
}

/** The only [MatchContext] there is; both free play and tournament heats use it. */
internal class SimpleMatchContext(
    override val random: Random,
    private val clock: () -> Long,
    private val names: (String) -> String,
    private val leaderOf: () -> String,
    private val bump: () -> Unit,
    private val triviaSource: (Int) -> List<TriviaQuestion>,
) : MatchContext {
    override fun now(): Long = clock()
    override fun nameOf(playerId: String): String = names(playerId)
    override fun leader(): String = leaderOf()
    override fun nextRound() = bump()
    override fun trivia(count: Int): List<TriviaQuestion> = triviaSource(count)
}

/** Shared cleaning for every typed entry. Control characters never reach a log line. */
internal object GameText {
    fun clean(raw: String): String {
        val text = raw.filter { !it.isISOControl() }.trim()
        require(text.isNotEmpty() && text.length <= 300) { "Enter up to 300 characters." }
        return text
    }
}

/**
 * The fields the guest page reads out of every round, with an empty value for the games
 * that do not use them.
 *
 * One definition, used both by a live match and by an empty lobby, so the page never has
 * to guard against a key that is simply missing this time.
 */
internal object MatchFields {
    fun defaults(expected: Int): JsonObject = buildJsonObject {
        put("prompt", "")
        put("turn", "")
        put("winner", "")
        put("question", 1)
        put("total", 0)
        put("board", JsonArray(emptyList()))
        put("winningCells", JsonArray(emptyList()))
        put("options", JsonArray(emptyList()))
        put("answered", 0)
        put("expected", expected)
        put("myAnswer", -1)
        put("log", JsonArray(emptyList()))
        put("entries", JsonArray(emptyList()))
        put("bingo", JsonArray(emptyList()))
        put("marks", JsonArray(emptyList()))
    }
}
