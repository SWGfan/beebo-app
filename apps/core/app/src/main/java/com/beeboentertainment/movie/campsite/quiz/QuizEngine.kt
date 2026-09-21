package com.beeboentertainment.movie.campsite.quiz

import kotlin.random.Random

internal enum class QuizMode(val wire: String) {
    /** Every guest answers on their own phone. */
    PHONES("phones"),

    /** One phone is passed round or watched by everyone; teams take turns and the host taps their answer. */
    TURNS("turns");

    companion object {
        fun of(wire: String?): QuizMode = entries.firstOrNull { it.wire == wire } ?: PHONES
    }
}

internal enum class QuizPhase(val wire: String) { LOBBY("lobby"), ASKING("asking"), REVEALED("revealed"), DONE("done") }

/** What the host chose before starting. [normalised] clamps every field so nothing downstream needs to. */
internal data class QuizSettings(
    val packs: Set<String> = emptySet(),
    val band: AgeBand? = null,
    val rounds: Int = 10,
    val teams: Int = 0,
    val timerSeconds: Int = 0,
    val mode: QuizMode = QuizMode.PHONES,
    val turnNames: List<String> = emptyList(),
) {
    fun normalised(): QuizSettings = copy(
        packs = packs.filter { QuizPacks.info(it) != null }.toSet(),
        rounds = rounds.coerceIn(3, 20),
        teams = if (mode == QuizMode.PHONES && teams in 2..MAX_TEAMS) teams else 0,
        timerSeconds = if (timerSeconds <= 0) 0 else timerSeconds.coerceIn(10, 120),
        turnNames = if (mode == QuizMode.TURNS) turnNames.map { com.beeboentertainment.movie.campsite.family.FamilyText.name(it, 20, "Team") }
            .filter { it.isNotBlank() }.take(MAX_TURN_NAMES).ifEmpty { listOf("Team Red", "Team Blue") } else emptyList(),
    )

    companion object {
        const val MAX_TEAMS = 4
        const val MAX_TURN_NAMES = 6
    }
}

internal object QuizTeams {
    /** Colour names double as the team names. The page adds a shape (triangle, circle, square, star) so colour is never the only cue. */
    val NAMES = listOf("Red", "Blue", "Green", "Gold")
}

/**
 * One round of the quiz, with no Android, network or web types.
 *
 * Rules that matter:
 *  - The correct answer and the fun fact never leave the session before the reveal ([snapshot]).
 *  - Options are shuffled per question at play time, so the position of the right answer in the data
 *    files never becomes a pattern a child can learn.
 *  - Everybody's answer stays private until the reveal, and can be changed until then.
 *  - The question reveals by itself when every guest who is still here has answered; the host can
 *    reveal early; and, only if the host set a timer, when the time is up. There is no countdown unless
 *    the host asked for one.
 *  - A point is one correct answer. A team's score is the sum of its members' points. Nothing is
 *    ranked across households and nothing is saved beyond one line of match history.
 */
internal class QuizSession(
    val settings: QuizSettings,
    private val questions: List<QuizQuestion>,
    private val random: Random,
    private val clock: () -> Long,
) {
    class Participant(val id: String, val name: String, var team: Int, val order: Int, var lastSeen: Long) {
        var score = 0
    }

    data class Row(
        val id: String,
        val name: String,
        val team: Int,
        val score: Int,
        val answered: Boolean,
        /** Set only after the reveal. */
        val right: Boolean?,
        val choice: Int?,
    )

    data class TeamRow(val index: Int, val name: String, val score: Int, val members: Int)

    data class Snapshot(
        val phase: QuizPhase,
        val mode: QuizMode,
        val number: Int,
        val total: Int,
        val prompt: String,
        val options: List<String>,
        /** Displayed index of the right answer; -1 until the reveal. */
        val correct: Int,
        val fact: String,
        /** Milliseconds left, or -1 when there is no timer or no open question. */
        val remainingMs: Long,
        val timerSeconds: Int,
        val answered: Int,
        val expected: Int,
        val turnId: String?,
        val turnName: String?,
        val rows: List<Row>,
        val teams: List<TeamRow>,
        /** How many chose each option, after the reveal only. */
        val counts: List<Int>,
        val packTitle: String,
    )

    var phase = QuizPhase.LOBBY
        private set
    val total: Int = questions.size
    var index = -1
        private set
    var startedAt = 0L
        private set
    var endedAt = 0L
        private set
    var aborted = false
        private set
    var revealedCount = 0
        private set

    private val participants = LinkedHashMap<String, Participant>()
    private var order = IntArray(4) { it }
    private var deadline = 0L
    private val answers = LinkedHashMap<String, Int>()
    private var results: Map<String, Boolean> = emptyMap()
    private var counter = 0

    val askedIds: List<String> get() = questions.take((index + 1).coerceAtLeast(0)).map { it.id }

    // ---- who is playing -------------------------------------------------------------------

    fun join(id: String, name: String, now: Long = clock()): String? {
        participants[id]?.let { it.lastSeen = now; return null }
        if (settings.mode == QuizMode.TURNS) return "This quiz is played on the host's phone."
        if (phase == QuizPhase.DONE) return "This quiz has finished."
        if (participants.size >= MAX_PLAYERS) return "The quiz is full."
        val team = if (settings.teams > 0) smallestTeam() else -1
        participants[id] = Participant(id, name, team, counter++, now)
        return null
    }

    fun touch(id: String, now: Long = clock()) { participants[id]?.lastSeen = now }

    fun hasPlayer(id: String): Boolean = id in participants

    fun playerCount(): Int = participants.size

    private fun smallestTeam(): Int = (0 until settings.teams).minByOrNull { t -> participants.values.count { it.team == t } } ?: 0

    fun setTeam(id: String, team: Int): String? {
        val p = participants[id] ?: return "Join the quiz first."
        if (settings.teams == 0) return "This quiz has no teams."
        if (phase != QuizPhase.LOBBY) return "Teams are locked once the quiz starts."
        if (team !in 0 until settings.teams) return "Choose one of the teams."
        p.team = team
        return null
    }

    // ---- running the quiz -----------------------------------------------------------------

    fun start(now: Long = clock()): String? {
        if (phase != QuizPhase.LOBBY) return "The quiz has already started."
        if (total < 1) return "There are no questions for that choice."
        if (settings.mode == QuizMode.TURNS) {
            settings.turnNames.forEachIndexed { i, name -> participants["t$i"] = Participant("t$i", name, -1, i, now) }
        } else if (participants.isEmpty()) {
            return "Wait for at least one guest to join, or play on this phone instead."
        }
        startedAt = now
        openQuestion(0, now)
        return null
    }

    private fun openQuestion(i: Int, now: Long) {
        index = i
        order = (0..3).toList().shuffled(random).toIntArray()
        answers.clear()
        results = emptyMap()
        deadline = if (settings.timerSeconds > 0) now + settings.timerSeconds * 1000L else 0L
        phase = QuizPhase.ASKING
    }

    private val question: QuizQuestion? get() = questions.getOrNull(index)

    private fun correctDisplay(): Int = question?.let { q -> order.indexOf(q.answer) } ?: -1

    fun currentTurn(): Participant? =
        if (settings.mode == QuizMode.TURNS && index >= 0) participants.values.toList().let { it[index % it.size] } else null

    fun answer(id: String, choice: Int, now: Long = clock()): String? {
        tick(now)
        if (phase != QuizPhase.ASKING) return "That question has finished."
        val p = participants[id] ?: return "Join the quiz first."
        if (choice !in 0..3) return "Choose one of the answers."
        if (settings.mode == QuizMode.TURNS && currentTurn()?.id != id) return "It is not that team's turn."
        p.lastSeen = now
        answers[id] = choice
        if (settings.mode == QuizMode.TURNS) reveal(now) else if (everyoneHereAnswered(now)) reveal(now)
        return null
    }

    private fun everyoneHereAnswered(now: Long): Boolean {
        val here = participants.values.filter { now - it.lastSeen <= PRESENT_MS }
        return here.isNotEmpty() && here.all { it.id in answers }
    }

    /** Host: show the answer now. Also what the timer calls. */
    fun reveal(now: Long = clock()): String? {
        if (phase != QuizPhase.ASKING) return "There is no open question."
        val right = correctDisplay()
        results = participants.keys.filter { it in answers }.associateWith { answers[it] == right }
        results.forEach { (id, ok) -> if (ok) participants[id]!!.score++ }
        revealedCount++
        phase = QuizPhase.REVEALED
        return null
    }

    fun next(now: Long = clock()): String? {
        if (phase != QuizPhase.REVEALED) return "Show the answer first."
        if (index + 1 < total) openQuestion(index + 1, now) else finish(now)
        return null
    }

    /** Host: stop early. The points so far stand. */
    fun end(now: Long = clock()) {
        if (phase == QuizPhase.DONE) return
        if (phase == QuizPhase.ASKING) answers.clear()
        finish(now)
    }

    private fun finish(now: Long) {
        // Ended early = some questions were never revealed. Points already scored stand either way.
        aborted = revealedCount < total
        phase = QuizPhase.DONE
        endedAt = now
    }

    /** Lazy timer: called before every read so nothing ticks on the host. */
    fun tick(now: Long = clock()) {
        if (phase == QuizPhase.ASKING && deadline > 0 && now >= deadline) reveal(now)
    }

    // ---- what anybody may see -------------------------------------------------------------

    fun teamScore(team: Int): Int = participants.values.filter { it.team == team }.sumOf { it.score }

    /** Individuals, best first. */
    fun standings(): List<Participant> = participants.values.sortedWith(compareByDescending<Participant> { it.score }.thenBy { it.order })

    /** Winning names: the unique top scorer, or a tie for the top, or the top team's name in a team quiz. Empty if nobody scored. */
    fun winners(): List<String> {
        if (settings.teams > 0) {
            val scores = (0 until settings.teams).map { it to teamScore(it) }
            val best = scores.maxOfOrNull { it.second } ?: return emptyList()
            return if (best == 0) emptyList() else scores.filter { it.second == best }.map { "Team " + QuizTeams.NAMES[it.first] }
        }
        val best = participants.values.maxOfOrNull { it.score } ?: return emptyList()
        return if (best == 0) emptyList() else participants.values.filter { it.score == best }.map { it.name }
    }

    fun snapshot(now: Long = clock()): Snapshot {
        tick(now)
        val q = question
        val reveal = phase == QuizPhase.REVEALED || phase == QuizPhase.DONE
        val shown = if (q != null && phase != QuizPhase.LOBBY) order.map { q.options[it] } else emptyList()
        val turn = currentTurn()
        val expected = when {
            phase != QuizPhase.ASKING && phase != QuizPhase.REVEALED -> 0
            settings.mode == QuizMode.TURNS -> 1
            else -> participants.values.count { now - it.lastSeen <= PRESENT_MS }
        }
        val revealedNow = phase == QuizPhase.REVEALED
        return Snapshot(
            phase = phase,
            mode = settings.mode,
            number = (index + 1).coerceAtLeast(0),
            total = total,
            prompt = if (phase == QuizPhase.LOBBY) "" else q?.prompt.orEmpty(),
            options = shown,
            correct = if (revealedNow) correctDisplay() else -1,
            fact = if (revealedNow) q?.fact.orEmpty() else "",
            remainingMs = if (phase == QuizPhase.ASKING && deadline > 0) (deadline - now).coerceAtLeast(0L) else -1L,
            timerSeconds = settings.timerSeconds,
            answered = answers.size,
            expected = expected,
            turnId = turn?.id,
            turnName = turn?.name,
            rows = participants.values.sortedBy { it.order }.map { p ->
                Row(
                    id = p.id, name = p.name, team = p.team, score = p.score,
                    answered = p.id in answers,
                    right = if (revealedNow) results[p.id] ?: false else null,
                    choice = if (revealedNow) answers[p.id] else null,
                )
            },
            teams = (0 until settings.teams).map { TeamRow(it, QuizTeams.NAMES[it], teamScore(it), participants.values.count { p -> p.team == it }) },
            counts = if (revealedNow) (0..3).map { c -> answers.values.count { it == c } } else emptyList(),
            packTitle = q?.let { QuizPacks.info(it.pack)?.title }.orEmpty(),
        )
    }

    /** The choice a guest made on the open question (displayed index), for that guest's own view only. */
    fun choiceOf(id: String): Int = answers[id] ?: -1

    fun scoreOf(id: String): Int = participants[id]?.score ?: 0

    fun teamOf(id: String): Int = participants[id]?.team ?: -1

    fun nameOf(id: String): String = participants[id]?.name.orEmpty()

    companion object {
        const val MAX_PLAYERS = 24

        /** A guest seen in this long is "here" for the everyone-has-answered check. */
        const val PRESENT_MS = 30_000L
    }
}
