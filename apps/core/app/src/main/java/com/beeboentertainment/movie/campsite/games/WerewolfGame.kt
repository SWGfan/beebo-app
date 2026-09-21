package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import kotlin.random.Random

/**
 * Campfire Werewolf - the classic hidden-role story game, told by the host phone.
 *
 * A few players are secretly werewolves. Each night they quietly choose a camper to send
 * out of the game, while the seer checks one player's secret and the healer protects one
 * player. Each day the whole camp talks it over and votes someone out. The villagers win
 * when every werewolf is out; the werewolves win when they match the villagers in number.
 *
 * THE PHONES ARE THE CLOSED EYES. In a circle round a fire nobody has to shut their eyes:
 * the night choices are made on each player's own screen, and EVERY living player has
 * something to tap at night - a villager marks a hunch that nobody ever sees - so a
 * glance round the circle shows everybody tapping and gives nothing away. For the same
 * reason the roster's "answered" tick and the waiting list are never per-player at night.
 *
 * The narration is plain text in the snapshot with an id; the leader's phone, when it is
 * the host phone, reads each new line aloud (see CampsiteNarrator). The wording is kept
 * mild on purpose: players are "caught" and "leave the game", nothing worse.
 *
 * Nobody is ever told another player's role while the game runs, except that werewolves
 * know each other and the seer learns what they checked. Roles of players who are voted
 * out are shown only if the leader chose that setting; everything is shown at the end.
 */
internal object WerewolfGame : CampsiteGame {
    override val id = "werewolf"
    override val title = "Campfire Werewolf"
    override val blurb = "Secret roles, night-time choices and a village vote. The host phone tells the story."
    override val kind = "poll"
    override val seats = Seats.of(5, 12)
    override val needsGuests = true
    override val tournamentReady = false
    override val category = GameCategory.PARTY

    const val WOLF = "werewolf"
    const val SEER = "seer"
    const val HEALER = "healer"
    const val VILLAGER = "villager"

    const val DEFAULT_DAY_MINUTES = 3
    val DAY_MINUTES = 1..8
    const val ROLES_MS = 45_000L
    const val NIGHT_MS = 60_000L
    const val PAUSE_MS = 12_000L

    /** How many werewolves a camp of this size gets. */
    fun wolvesFor(players: Int): Int = when {
        players <= 6 -> 1
        players <= 9 -> 2
        else -> 3
    }

    /** The full deck for [players] seats, before shuffling. */
    fun deck(players: Int): List<String> {
        val wolves = wolvesFor(players)
        return List(wolves) { WOLF } + SEER + HEALER + List(players - wolves - 2) { VILLAGER }
    }

    override fun create(players: List<String>, setup: String, ctx: MatchContext): GameMatch {
        require(players.size in seats.min..seats.max) { "Campfire Werewolf needs 5 to 12 players, each on their own phone." }
        val settings = PartySettings(setup)
        return Match(
            players, ctx,
            dayMinutes = settings.int("day", DEFAULT_DAY_MINUTES, DAY_MINUTES),
            revealOnExit = settings.flag("reveal", true),
        )
    }

    /**
     * Bots play the role they were dealt, with no more knowledge than a person holding it:
     * a werewolf bot knows its pack, a seer bot remembers what it checked, and everybody
     * else guesses. It cannot hear the discussion, so its day vote is a guess too.
     */
    override fun botMove(match: GameMatch, playerId: String, random: Random): GameMove? =
        (match as? Match)?.botStep(playerId, random)

    internal class Match(
        players: List<String>,
        ctx: MatchContext,
        val dayMinutes: Int,
        val revealOnExit: Boolean,
    ) : PartyMatch(players, ctx) {

        internal val roles: Map<String, String> = players.zip(deck(players.size).shuffled(ctx.random)).toMap()
        internal val alive = linkedSetOf<String>().apply { addAll(players) }

        private val ready = linkedSetOf<String>()
        private val wolfPicks = linkedMapOf<String, String>()
        private var seerPick = ""
        private var healerPick = ""
        private var lastHealed = ""
        private val hunches = linkedSetOf<String>()
        private val seen = linkedMapOf<String, Boolean>()
        private val votes = linkedMapOf<String, String>()
        private val fallen = mutableListOf<String>()
        private var night = 0
        private var narrationId = 0
        private var narration = ""

        init {
            stage = "roles"
            say("Welcome to Campfire Werewolf. Look at your secret card and keep it to yourself. When everyone is ready, night will fall.")
            startClock(ROLES_MS)
        }

        private fun name(id: String) = ctx.nameOf(id)
        private fun roleOf(id: String) = roles.getValue(id)
        private val wolvesAlive: List<String> get() = alive.filter { roleOf(it) == WOLF }
        private val othersAlive: List<String> get() = alive.filter { roleOf(it) != WOLF }

        private fun say(text: String) {
            narration = text
            narrationId++
            prompt = text
        }

        override fun onApply(move: GameMove) {
            val who = move.playerId
            require(who in players) { "You are watching this game." }
            when (move.action) {
                "ready" -> {
                    require(stage == "roles") { "The game has already begun." }
                    ready.add(who)
                    if (present.all { it in ready }) beginNight()
                }
                "night" -> nightChoice(who, move.text("target"))
                "vote" -> dayVote(who, move.text("target"))
                "continue" -> {
                    require(who == ctx.leader()) { "The leader moves the story on." }
                    when (stage) {
                        "roles" -> beginNight()
                        "morning" -> beginDay()
                        "verdict" -> afterVerdict()
                        else -> throw IllegalArgumentException("Wait for this part of the game to finish.")
                    }
                }
                else -> throw IllegalArgumentException("Choose an action on your screen.")
            }
        }

        // ---- night ------------------------------------------------------------

        private fun beginNight() {
            night++
            stage = "night"
            wolfPicks.clear()
            seerPick = ""
            healerPick = ""
            hunches.clear()
            say("Night $night falls on the camp. Everyone, look only at your own phone. Werewolves, choose a camper. Seer, choose someone to check. Healer, choose someone to protect. Everyone else, pick who you suspect.")
            startClock(NIGHT_MS)
            ctx.nextRound()
        }

        private fun nightChoice(who: String, target: String) {
            require(stage == "night") { "It isn't night." }
            require(who in alive) { "You're out of the game - watch quietly." }
            require(target in alive) { "Choose a player who is still in the game." }
            when (roleOf(who)) {
                WOLF -> {
                    require(roleOf(target) != WOLF) { "Choose someone who isn't a werewolf." }
                    wolfPicks[who] = target
                }
                SEER -> {
                    require(target != who) { "Choose someone other than yourself." }
                    require(seerPick.isEmpty()) { "You have already checked someone tonight." }
                    seerPick = target
                    seen[target] = roleOf(target) == WOLF
                }
                HEALER -> {
                    require(target != lastHealed) { "You can't protect the same player two nights in a row." }
                    healerPick = target
                }
                else -> {
                    require(target != who) { "Choose someone other than yourself." }
                    hunches.add(who)
                }
            }
            if (nightComplete()) endNight()
        }

        private fun nightComplete(): Boolean {
            val acting = alive.filter { it !in away }
            val wolvesDone = acting.filter { roleOf(it) == WOLF }.all { it in wolfPicks }
            val seerDone = acting.none { roleOf(it) == SEER } || seerPick.isNotEmpty()
            val healerDone = acting.none { roleOf(it) == HEALER } || healerPick.isNotEmpty()
            return wolvesDone && seerDone && healerDone
        }

        private fun endNight() {
            if (stage != "night") return
            val counts = wolfPicks.filterKeys { it in alive }.values.filter { it in alive }.groupingBy { it }.eachCount()
            val best = counts.values.maxOrNull()
            val target = if (best == null) "" else counts.filterValues { it == best }.keys.toList().random(ctx.random)
            lastHealed = healerPick
            val morning = when {
                target.isEmpty() -> "Morning comes. The werewolves couldn't decide, and everyone made it through the night."
                target == healerPick -> "Morning comes. The werewolves came for someone, but the healer was watching over them. Everyone is still here!"
                else -> {
                    remove(target)
                    "Morning comes. " + name(target) + " was caught by the werewolves and has left the game." + revealLine(target)
                }
            }
            note("Night $night: " + if (target.isNotEmpty() && target != healerPick) name(target) + " was caught." else "nobody was caught.")
            stage = "morning"
            say(morning)
            if (!checkWin()) startClock(PAUSE_MS)
            ctx.nextRound()
        }

        private fun revealLine(id: String): String =
            if (revealOnExit) " They were " + article(roleOf(id)) + "." else ""

        private fun article(role: String) = when (role) {
            WOLF -> "a werewolf"
            SEER -> "the seer"
            HEALER -> "the healer"
            else -> "a villager"
        }

        private fun remove(id: String) {
            alive.remove(id)
            fallen.add(id)
            wolfPicks.remove(id)
            votes.remove(id)
            votes.entries.removeAll { it.value == id }
        }

        // ---- day --------------------------------------------------------------

        private fun beginDay() {
            stage = "day"
            votes.clear()
            say("Talk it over. Who do you think is a werewolf? Vote when you're ready. You have $dayMinutes minute" + (if (dayMinutes == 1) "" else "s") + ".")
            startClock(dayMinutes * 60_000L)
            ctx.nextRound()
        }

        private fun dayVote(who: String, target: String) {
            require(stage == "day") { "Voting happens during the day." }
            require(who in alive) { "You're out of the game - watch quietly." }
            require(target == SKIP || (target in alive && target != who)) { "Vote for another player, or skip." }
            votes[who] = target
            if (alive.filter { it !in away }.all { it in votes }) endDay()
        }

        private fun endDay() {
            if (stage != "day") return
            val counts = votes.filterKeys { it in alive }.values.groupingBy { it }.eachCount()
            val skip = counts[SKIP] ?: 0
            val tally = counts.filterKeys { it != SKIP }
            val best = tally.values.maxOrNull() ?: 0
            val leaders = tally.filterValues { it == best }.keys
            val out = if (best > 0 && best > skip && leaders.size == 1) leaders.first() else ""
            stage = "verdict"
            if (out.isEmpty()) {
                note("Day $night: no one was voted out.")
                say("The camp couldn't agree, so nobody leaves today.")
            } else {
                remove(out)
                note("Day $night: " + name(out) + " was voted out with " + best + " vote" + (if (best == 1) "" else "s") + ".")
                say("The camp has voted. " + name(out) + " leaves the game." + revealLine(out))
            }
            if (!checkWin()) startClock(PAUSE_MS)
            ctx.nextRound()
        }

        private fun afterVerdict() {
            if (!checkWin()) beginNight()
        }

        /** True when the game is over. */
        private fun checkWin(): Boolean {
            val wolves = wolvesAlive.size
            val others = othersAlive.size
            val team: Set<String>
            val message: String
            when {
                wolves == 0 -> {
                    team = players.filter { roleOf(it) != WOLF }.toSet()
                    message = "Every werewolf has been found. The villagers win!"
                }
                wolves >= others -> {
                    team = players.filter { roleOf(it) == WOLF }.toSet()
                    message = "The werewolves now match the villagers. The werewolves win!"
                }
                else -> return false
            }
            // Winners who made it to the end get a little extra.
            team.filter { it in alive }.forEach { award(it, 1) }
            // Said straight after the morning or verdict line it follows, as one piece.
            val full = if (narration.isBlank()) message else "$narration $message"
            stage = "over"
            say(full)
            settleTeam(team, full)
            return true
        }

        override fun onTimeUp() {
            when (stage) {
                "roles" -> beginNight()
                "night" -> endNight()
                "morning" -> beginDay()
                "day" -> endDay()
                "verdict" -> afterVerdict()
            }
        }

        override fun onLeft(playerId: String) {
            // A player who drifts off stays in the game - the story does not wait for
            // them, and they can pick up where they were if they come back. Only a camp
            // too small to argue in is called off.
            if (present.size < 3) { abandon("Too few players are left. Start a new game when everyone is back."); return }
            when (stage) {
                "roles" -> if (present.all { it in ready }) beginNight()
                "night" -> if (nightComplete()) endNight()
                "day" -> if (alive.filter { it !in away }.all { it in votes }) endDay()
            }
        }

        override fun hasAnswered(playerId: String): Boolean = when (stage) {
            "roles" -> playerId in ready
            "day" -> playerId in votes
            else -> false
        }

        override fun waitingOn(): List<String> = when {
            phase == "done" -> emptyList()
            stage == "roles" -> present.filter { it !in ready }
            stage == "day" -> alive.filter { it !in away && it !in votes }
            stage == "morning" || stage == "verdict" -> listOf(ctx.leader())
            else -> alive.filter { it !in away }
        }

        override fun resultIfStoppedNow(): MatchResult =
            result() ?: MatchResult(Outcome.DRAW, "", scores.toMap(), "Stopped before either side won.")

        override fun JsonObjectBuilder.decorateParty(viewer: String?) {
            val over = phase == "done"
            put("night", night)
            put("dayMinutes", dayMinutes)
            put("revealOnExit", revealOnExit)
            put("wolfCount", wolvesFor(players.size))
            put("narration", buildJsonObject { put("id", "w" + narrationId); put("text", narration) })
            put("alive", JsonArray(players.filter { it in alive }.map { JsonPrimitive(it) }))
            put("fallen", JsonArray(fallen.map { id ->
                buildJsonObject {
                    put("id", id)
                    put("role", if (revealOnExit || over) roleOf(id) else "")
                }
            }))
            put("ready", JsonArray(ready.map { JsonPrimitive(it) }))
            // Day votes are cast in the open, as they are round a real fire.
            put("votes", buildJsonObject { if (stage == "day" || stage == "verdict") votes.forEach { (k, v) -> put(k, v) } })

            // ---- private -------------------------------------------------------
            val role = viewer?.let { roleOf(it) }.orEmpty()
            put("myRole", role)
            put("myAlive", viewer != null && viewer in alive)
            put("myVote", viewer?.let { votes[it] }.orEmpty())
            put("myReady", viewer != null && viewer in ready)
            val myPick = when {
                viewer == null || stage != "night" -> ""
                role == WOLF -> wolfPicks[viewer].orEmpty()
                role == SEER -> seerPick
                role == HEALER -> healerPick
                else -> if (viewer in hunches) "hunch" else ""
            }
            put("myPick", myPick)
            if (role == WOLF || over) {
                put("pack", JsonArray(players.filter { roleOf(it) == WOLF }.map { JsonPrimitive(it) }))
                put("packPicks", buildJsonObject { if (stage == "night") wolfPicks.forEach { (k, v) -> put(k, v) } })
            }
            if (role == SEER) put("checks", buildJsonObject { seen.forEach { (k, v) -> put(k, v) } })
            if (role == HEALER) put("lastHealed", lastHealed)
            if (over) put("roles", buildJsonObject { roles.forEach { (k, v) -> put(k, v) } })
        }

        fun botStep(playerId: String, random: Random): GameMove? {
            if (phase != "playing" || playerId !in players) return null
            when (stage) {
                "roles" -> return if (playerId in ready) null else botAction(playerId, "ready")
                "night" -> {
                    if (playerId !in alive) return null
                    val others = alive.filter { it != playerId }
                    val target = when (roleOf(playerId)) {
                        WOLF -> if (playerId in wolfPicks) null
                            else wolfPicks.values.firstOrNull { it in alive } ?: othersAlive.randomOrNull(random)
                        SEER -> if (seerPick.isNotEmpty()) null else (others.filter { it !in seen }.ifEmpty { others }).randomOrNull(random)
                        HEALER -> if (healerPick.isNotEmpty()) null else alive.filter { it != lastHealed }.randomOrNull(random)
                        else -> if (playerId in hunches) null else others.randomOrNull(random)
                    } ?: return null
                    return botAction(playerId, "night", "target", target)
                }
                "day" -> {
                    if (playerId !in alive || playerId in votes) return null
                    val others = alive.filter { it != playerId }
                    val target = when (roleOf(playerId)) {
                        WOLF -> others.filter { roleOf(it) != WOLF }.randomOrNull(random)
                        SEER -> seen.filter { it.value && it.key in alive }.keys.firstOrNull() ?: others.randomOrNull(random)
                        else -> if (random.nextInt(4) == 0) SKIP else others.randomOrNull(random)
                    } ?: SKIP
                    return botAction(playerId, "vote", "target", target)
                }
            }
            return null
        }
    }

    const val SKIP = "skip"
}
