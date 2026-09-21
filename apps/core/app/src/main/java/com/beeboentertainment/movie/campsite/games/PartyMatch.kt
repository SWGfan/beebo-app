package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*

/**
 * A match that can lose a player and carry on.
 *
 * Every game before the party games was two to six people at one board, where somebody
 * walking off really does end the round, so the service voids a match the moment a seat
 * empties. A werewolf game of eleven is different: one child going to bed must not throw
 * away the other ten's evening. The service asks this first; true means "handled, keep
 * going", and the match itself decides whether what is left is still a game.
 */
internal interface SeatKeeper {
    /** The player has left the room mid-match. True when the match carries on without them. */
    fun playerLeft(playerId: String): Boolean

    /** A player who left has come back to the same room while the match is still running. */
    fun playerReturned(playerId: String)
}

/**
 * A match with a clock of its own.
 *
 * The engine has no timer thread for free play - a match only changes when somebody's
 * request reaches the host. So the service calls [tick] on every request it serves (every
 * guest poll is one, about once a second) and from the bot clock, and the match compares
 * the host's own clock reading with its deadline. True means the state changed.
 */
internal interface ClockedMatch {
    fun tick(): Boolean
}

/**
 * Host settings for a party game, typed by nobody: the leader's page sends
 * "minutes=7;rounds=3" as the start text, built from buttons. Anything unrecognised or
 * out of range simply falls back to the default, so a hand-made request can never start
 * a ninety-hour round.
 */
internal class PartySettings(text: String) {
    private val values: Map<String, String> = text.split(';', '&', ',')
        .mapNotNull { part ->
            val eq = part.indexOf('=')
            if (eq <= 0) null else part.substring(0, eq).trim().lowercase() to part.substring(eq + 1).trim().lowercase()
        }
        .filter { (key, value) -> key.length <= 20 && value.length <= 20 }
        .toMap()

    fun int(key: String, default: Int, range: IntRange): Int =
        values[key]?.toIntOrNull()?.takeIf { it in range } ?: default

    fun choice(key: String, default: String, allowed: Collection<String>): String =
        values[key]?.takeIf { it in allowed } ?: default

    fun flag(key: String, default: Boolean): Boolean = when (values[key]) {
        "1", "yes", "true", "on" -> true
        "0", "no", "false", "off" -> false
        else -> default
    }
}

/**
 * Text comparison for typed answers: guesses in Sketch & Guess, fakes in Fake Out.
 *
 * Deliberately forgiving about the things that are not the point - case, spaces,
 * punctuation, a leading "a" or "the", a plural - and exact about everything else. It
 * never tries to understand meaning: it runs on a phone in a field with no dictionary.
 */
internal object PartyText {
    private val ARTICLES = setOf("a", "an", "the")

    /** "The Big  Dogs!" -> "big dog". Words kept apart, so containment checks work on words. */
    fun normalize(raw: String): String {
        val words = raw.lowercase()
            .map { if (it.isLetterOrDigit()) it else ' ' }
            .joinToString("")
            .split(' ')
            .filter { it.isNotBlank() }
        val trimmed = if (words.size > 1 && words.first() in ARTICLES) words.drop(1) else words
        return trimmed.joinToString(" ") { singular(it) }
    }

    /** "big dog" -> "bigdog": "fire truck" and "firetruck" are the same guess. */
    fun compact(raw: String): String = normalize(raw).replace(" ", "")

    /** Close enough to count as the same word, for plurals only - never for meaning. */
    fun singular(word: String): String = when {
        word.length > 4 && word.endsWith("ies") -> word.dropLast(3) + "y"
        word.length > 4 && (word.endsWith("ches") || word.endsWith("shes") || word.endsWith("xes") ||
            word.endsWith("sses") || word.endsWith("zes")) -> word.dropLast(2)
        word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") -> word.dropLast(1)
        else -> word
    }

    fun same(a: String, b: String): Boolean {
        val x = compact(a)
        return x.isNotEmpty() && x == compact(b)
    }

    /** Classic edit distance, capped: anything beyond [cap] is reported as cap + 1. */
    fun distance(a: String, b: String, cap: Int = 3): Int {
        if (kotlin.math.abs(a.length - b.length) > cap) return cap + 1
        var previous = IntArray(b.length + 1) { it }
        for (i in 1..a.length) {
            val current = IntArray(b.length + 1)
            current[0] = i
            var best = current[0]
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                current[j] = minOf(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
                best = minOf(best, current[j])
            }
            if (best > cap) return cap + 1
            previous = current
        }
        return previous[b.length].coerceAtMost(cap + 1)
    }
}

/**
 * Shared plumbing for the party games: sub-stages, a host-owned countdown, and players
 * who drift away and back.
 *
 * The engine's own phase stays "playing" from the first second to the last - the guest
 * page and the service both treat "playing" as "a round is on" - and each game moves
 * through its own [stage] underneath it. The remaining time is published as a number of
 * milliseconds rather than a clock reading, because a guest phone's clock is not the
 * host's and nobody should have to care.
 */
internal abstract class PartyMatch(
    players: List<String>,
    ctx: MatchContext,
) : BaseMatch(players, ctx), SeatKeeper, ClockedMatch {

    /** Seated players who have left the room. Still in [players], so they can come back. */
    protected val away = linkedSetOf<String>()

    protected var stage: String = ""

    private var deadline = 0L
    private var clockTotal = 0L

    /** Players still at the campsite, in seat order. */
    protected val present: List<String> get() = players.filter { it !in away }

    protected fun startClock(ms: Long) {
        clockTotal = ms
        deadline = ctx.now() + ms
    }

    protected fun stopClock() {
        deadline = 0L
        clockTotal = 0L
    }

    protected fun clockRunning(): Boolean = deadline != 0L

    protected fun remainingMs(): Long = if (deadline == 0L) 0L else (deadline - ctx.now()).coerceAtLeast(0L)

    /** How far through the running clock we are, 0.0 at the start and 1.0 at the end. */
    protected fun elapsedFraction(): Double =
        if (deadline == 0L || clockTotal <= 0L) 0.0 else 1.0 - remainingMs().toDouble() / clockTotal

    final override fun tick(): Boolean {
        if (phase == "done" || deadline == 0L || ctx.now() < deadline) return false
        deadline = 0L
        clockTotal = 0L
        onTimeUp()
        return true
    }

    /** The clock ran out in the current [stage]. */
    protected abstract fun onTimeUp()

    final override fun playerLeft(playerId: String): Boolean {
        if (playerId !in players || phase == "done") return false
        away.add(playerId)
        onLeft(playerId)
        return true
    }

    final override fun playerReturned(playerId: String) {
        if (phase != "done" && away.remove(playerId)) onReturned(playerId)
    }

    protected open fun onLeft(playerId: String) {}
    protected open fun onReturned(playerId: String) {}

    /** End with no result: nobody is rated for a game that fell apart. */
    protected fun abandon(note: String) {
        stopClock()
        close(MatchResult(Outcome.VOID, "", scores.toMap(), note), note)
    }

    /** A team won. Every member is marked as a winner in history; no single name is shown. */
    protected fun settleTeam(team: Set<String>, note: String) {
        stopClock()
        team.forEach { award(it, 1) }
        prompt = note
        settle(MatchResult(Outcome.WINNER, "", scores.toMap(), note, winners = team))
    }

    /** Finish on points, naming the winner on screen when the top score is not shared. */
    protected fun settlePoints(note: String) {
        stopClock()
        val top = topScorer()
        if (top.isNotBlank()) winner = top
        prompt = note
        settleScores(note)
    }

    protected fun note(line: String) {
        log.add(line)
        while (log.size > 12) log.removeAt(0)
    }

    final override fun JsonObjectBuilder.decorate(viewer: String?) {
        put("stage", stage)
        put("remainingMs", remainingMs())
        put("clockMs", clockTotal)
        put("away", JsonArray(away.map { JsonPrimitive(it) }))
        put("seated", viewer != null && viewer in players)
        decorateParty(viewer?.takeIf { it in players })
    }

    /** This game's own fields. [viewer] is already narrowed to a seated player, or null. */
    protected abstract fun JsonObjectBuilder.decorateParty(viewer: String?)
}
