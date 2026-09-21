package com.beeboentertainment.movie.campsite.hunt

/** One find. [byToken] is private and never leaves the host; [byName] is the cleaned nickname. */
internal class HuntClaim(
    val itemId: String,
    var pending: Boolean,
    val byToken: String,
    val byName: String,
    /** When the guest tapped, epoch millis. This is the time that breaks ties, not the approval time. */
    val at: Long,
)

/**
 * One hunt, with no Android, network or web types. All time comes from the caller, so a test drives it
 * with a fake clock.
 *
 * Rules that matter:
 *  - Everyone in a hunt looks for the same list. Solo: every guest has their own ticks. Teams (and
 *    "all together"): the ticks belong to the team, so a find by any member counts once for the team,
 *    and a second tap on something already found changes nothing.
 *  - With approval on, a tick is only "pending" until the host approves it; only approved finds score.
 *    A team may have at most [MAX_PENDING] finds waiting, so a queue cannot be flooded.
 *  - A guest can take back their own tick until the host has checked it (or, with approval off, at
 *    any time). Only the host can remove anyone else's.
 *  - The hunt ends when the host ends it, when the timer runs out, or when every player (or team) has
 *    found everything. Finds still waiting for approval at the end do not count.
 *  - Nothing here records a location, a photo or a name beyond the nickname held for this hunt.
 */
internal class HuntSession(
    settings: HuntSettings,
    val card: HuntCard,
    val items: List<HuntItem>,
    val gridSize: Int,
    val photoPrompt: String,
    startedFor: Long,
) {
    val settings: HuntSettings = settings.normalised()
    val id: String = "hunt-$startedFor"

    var phase: HuntPhase = HuntPhase.LOBBY
        private set
    var startedAt: Long = 0L
        private set
    var endedAt: Long = 0L
        private set
    /** True when the host pressed End (the points so far stand); false for a timer or a full house. */
    var stoppedByHost: Boolean = false
        private set
    var timedOut: Boolean = false
        private set
    var allFinished: Boolean = false
        private set

    private class Player(val name: String, var team: Int, val joinedAt: Long)

    private val players = LinkedHashMap<String, Player>()
    private val claims = HashMap<String, LinkedHashMap<String, HuntClaim>>()
    private val photoDone = LinkedHashSet<String>()

    val layout: HuntLayout get() = card.layout
    val timerMs: Long get() = settings.timerMinutes * 60_000L
    val playerCount: Int get() = players.size
    val maxPoints: Int get() = HuntScoring.maxPoints(layout, gridSize, items)

    // ---- players ------------------------------------------------------------------------

    private fun entityKey(token: String): String? {
        val p = players[token] ?: return null
        return if (settings.teams == 0) "p:$token" else "t:${p.team}"
    }

    fun hasPlayer(token: String): Boolean = token in players
    fun nameOf(token: String): String = players[token]?.name.orEmpty()
    fun teamOf(token: String): Int = if (settings.teams >= 2) players[token]?.team ?: -1 else -1

    /** Add a guest. [name] is already cleaned. Returns null on success, or a message. */
    fun join(token: String, name: String, now: Long): String? {
        sync(now)
        if (token in players) return null
        if (phase == HuntPhase.DONE) return "This hunt has finished."
        if (players.size >= MAX_PLAYERS) return "This hunt is full."
        val shown = HuntNames.unique(name, players.values.map { it.name })
        val team = when {
            settings.teams <= 1 -> 0
            else -> smallestTeam()
        }
        players[token] = Player(shown, team, now)
        return null
    }

    private fun smallestTeam(): Int =
        (0 until settings.teams).minByOrNull { t -> players.values.count { it.team == t } } ?: 0

    /** Pick a team. Only before the start, and only when there are two or more teams. */
    fun setTeam(token: String, team: Int, now: Long): String? {
        sync(now)
        val p = players[token] ?: return "Join the hunt first."
        if (settings.teams < 2) return "This hunt has no teams to choose."
        if (phase != HuntPhase.LOBBY) return "Teams are fixed once the hunt has started."
        if (team !in 0 until settings.teams) return "That team does not exist."
        p.team = team
        return null
    }

    // ---- host ---------------------------------------------------------------------------

    fun start(now: Long): String? {
        if (phase != HuntPhase.LOBBY) return "The hunt has already started."
        if (players.isEmpty()) return "Wait for at least one player to join."
        phase = HuntPhase.RUNNING
        startedAt = now
        return null
    }

    /** Host: stop now. The points so far stand; finds still waiting for approval do not count. */
    fun end(now: Long) {
        sync(now)
        if (phase != HuntPhase.RUNNING) return
        finish(now)
        stoppedByHost = true
    }

    private fun finish(now: Long) {
        phase = HuntPhase.DONE
        endedAt = now
    }

    /** Apply the timer. Called at the top of every read and write, so nothing needs its own thread. */
    fun sync(now: Long) {
        if (phase == HuntPhase.RUNNING && timerMs > 0 && now >= startedAt + timerMs) {
            finish(startedAt + timerMs)
            timedOut = true
        }
    }

    fun remainingMs(now: Long): Long {
        if (phase != HuntPhase.RUNNING || timerMs <= 0) return -1L
        return (startedAt + timerMs - now).coerceAtLeast(0L)
    }

    // ---- finding ------------------------------------------------------------------------

    private fun claimsOf(entity: String): LinkedHashMap<String, HuntClaim> = claims.getOrPut(entity) { LinkedHashMap() }

    fun tick(token: String, itemId: String, now: Long): String? {
        sync(now)
        if (phase != HuntPhase.RUNNING) return if (phase == HuntPhase.DONE) "The hunt has finished." else "The hunt has not started yet."
        val player = players[token] ?: return "Join the hunt first."
        if (items.none { it.id == itemId }) return "That is not on this hunt."
        val entity = entityKey(token) ?: return "Join the hunt first."
        val mine = claimsOf(entity)
        // A second tap on something already found (or already waiting) is not an error and steals nothing.
        if (itemId in mine) return null
        if (settings.approval && mine.values.count { it.pending } >= MAX_PENDING) {
            return "Wait for your grown-up to check the finds you have sent."
        }
        mine[itemId] = HuntClaim(itemId, pending = settings.approval, byToken = token, byName = player.name, at = now)
        if (!settings.approval) checkEveryoneDone(now)
        return null
    }

    fun untick(token: String, itemId: String, now: Long): String? {
        sync(now)
        if (phase != HuntPhase.RUNNING) return "The hunt is not running."
        val entity = entityKey(token) ?: return "Join the hunt first."
        val mine = claims[entity]
        val claim = mine?.get(itemId) ?: return null
        if (claim.byToken != token) return "Only the person who found it can take it back."
        if (!claim.pending && settings.approval) return "Your grown-up already checked that one."
        mine.remove(itemId)
        return null
    }

    /** Host: count a pending find. */
    fun approve(entityKey: String, itemId: String, now: Long): String? {
        sync(now)
        if (phase != HuntPhase.RUNNING) return "The hunt is not running."
        val claim = claims[entityKey]?.get(itemId) ?: return "That find is not waiting."
        if (!claim.pending) return null
        claim.pending = false
        checkEveryoneDone(now)
        return null
    }

    fun approveAll(now: Long): Int {
        sync(now)
        if (phase != HuntPhase.RUNNING) return 0
        var n = 0
        claims.values.forEach { m -> m.values.filter { it.pending }.forEach { it.pending = false; n++ } }
        if (n > 0) checkEveryoneDone(now)
        return n
    }

    /** Host: turn a find down, or take away one already counted. */
    fun remove(entityKey: String, itemId: String, now: Long) {
        sync(now)
        if (phase != HuntPhase.RUNNING) return
        claims[entityKey]?.remove(itemId)
    }

    /** A guest says they took today's photo. Only a yes; the picture itself never reaches the host. */
    fun photoTaken(token: String, now: Long): String? {
        sync(now)
        if (!settings.photoOfDay) return "There is no photo of the day in this hunt."
        if (token !in players) return "Join the hunt first."
        if (phase == HuntPhase.LOBBY) return "The photo of the day opens when the hunt starts."
        photoDone += token
        return null
    }

    val photoCount: Int get() = photoDone.size
    fun photoDoneBy(token: String): Boolean = token in photoDone

    private fun checkEveryoneDone(now: Long) {
        val rows = rows(now)
        if (rows.isNotEmpty() && rows.all { it.found >= items.size }) {
            finish(now)
            allFinished = true
        }
    }

    // ---- views --------------------------------------------------------------------------

    /** The state of one item for one guest's list: none, pending or found, and who found it. */
    class ItemView(val item: HuntItem, val state: String, val by: String, val mine: Boolean)

    fun itemsFor(token: String): List<ItemView> {
        val entity = entityKey(token) ?: return emptyList()
        val mine = claims[entity].orEmpty()
        return items.map { item ->
            val c = mine[item.id]
            when {
                c == null -> ItemView(item, "none", "", false)
                c.pending -> ItemView(item, "pending", c.byName, c.byToken == token)
                else -> ItemView(item, "found", c.byName, c.byToken == token)
            }
        }
    }

    private fun foundIds(entity: String): Set<String> =
        claims[entity].orEmpty().values.filter { !it.pending }.map { it.itemId }.toSet()

    /** Leaderboard rows, ranked. A team with nobody in it is not shown. */
    fun rows(now: Long = 0L): List<HuntRow> {
        val raw = ArrayList<HuntRow>()
        if (settings.teams == 0) {
            players.forEach { (token, p) ->
                val key = "p:$token"
                raw += row(key, p.name, -1, 1)
            }
        } else {
            for (t in 0 until settings.teams) {
                val members = players.values.count { it.team == t }
                if (members == 0) continue
                raw += row("t:$t", if (settings.teams == 1) "Everyone" else HuntTeams.label(t), if (settings.teams == 1) -1 else t, members)
            }
        }
        return HuntScoring.ranked(raw)
    }

    private fun row(key: String, name: String, team: Int, members: Int): HuntRow {
        val found = foundIds(key)
        val score = HuntScoring.score(layout, gridSize, items, found)
        val mine = claims[key].orEmpty().values
        val lastAt = mine.filter { !it.pending }.maxOfOrNull { it.at } ?: 0L
        return HuntRow(
            key = key, name = name, team = team, members = members,
            points = score.points, found = score.found, pending = mine.count { it.pending },
            lines = score.lines, done = score.found >= items.size, lastAt = lastAt, rank = 0,
        )
    }

    fun rankOf(token: String, now: Long): HuntRow? {
        val key = entityKey(token) ?: return null
        return rows(now).firstOrNull { it.key == key }
    }

    fun winners(now: Long): List<HuntRow> = HuntScoring.winners(rows(now))

    /** What each player added to their team's list (team hunts), best first. Names are cleaned nicknames. */
    fun contributions(): List<Pair<String, Int>> {
        val byToken = HashMap<String, Int>()
        val scoring = claims.values.flatMap { it.values }.filter { !it.pending }
        scoring.forEach { c ->
            val item = items.firstOrNull { it.id == c.itemId } ?: return@forEach
            byToken[c.byToken] = (byToken[c.byToken] ?: 0) + if (layout == HuntLayout.BINGO) 1 else item.points
        }
        return players.entries.map { (token, p) -> p.name to (byToken[token] ?: 0) }.sortedByDescending { it.second }
    }

    /** A find waiting for the host, for the host's own queue. */
    class PendingLine(val entityKey: String, val itemId: String, val itemText: String, val who: String, val team: String, val at: Long)

    fun pendingQueue(): List<PendingLine> = claims.entries.flatMap { (entity, map) ->
        map.values.filter { it.pending }.mapNotNull { c ->
            val item = items.firstOrNull { it.id == c.itemId } ?: return@mapNotNull null
            val team = if (entity.startsWith("t:") && settings.teams >= 2) HuntTeams.label(entity.substring(2).toIntOrNull() ?: 0) else ""
            PendingLine(entity, c.itemId, item.text, c.byName, team, c.at)
        }
    }.sortedBy { it.at }

    fun playerLines(): List<Triple<String, Int, Boolean>> = players.entries.map { (t, p) -> Triple(p.name, if (settings.teams >= 2) p.team else -1, t in photoDone) }

    fun totalFound(): Int = claims.values.sumOf { m -> m.values.count { !it.pending } }

    /** The most items any one player or team found (for the badge and the trip line). */
    fun bestFound(): Int = rows().maxOfOrNull { it.found } ?: 0

    companion object {
        const val MAX_PLAYERS = 24
        const val MAX_PENDING = 6
    }
}
