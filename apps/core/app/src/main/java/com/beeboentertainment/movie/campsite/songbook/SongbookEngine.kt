package com.beeboentertainment.movie.campsite.songbook

/**
 * The songbook's whole brain, with no Android, network or web types, so it can be tested directly.
 *
 * TIME MODEL. A song is a list of displayed lines. The host owns one number, the STEP: which line
 * the singers are on. While the song is playing in auto mode the step advances by itself every
 * [lineMs] milliseconds, computed from `(now - baseAt)` rather than by a timer, so nothing ticks
 * on the host and a guest that polls late still lands on the right line. In manual mode (or paused)
 * the step only moves when the host taps Next or Back. A guest page is told the step and how far
 * into it we are, and extrapolates with its own clock between polls.
 *
 * ROUNDS. In a round every group sings the same lines, each group starting [RoundSpec.offsetLines]
 * lines after the one before. The song is looped [RoundSpec.repeats] times. For group g at step s the
 * position is `k = s - g * offset`: before zero the group is waiting, past `repeats * L` it is done,
 * otherwise it sings line `k % L`. [GroupLine] carries that answer; the web page mirrors the same
 * arithmetic (see assets/campsite-songbook.html) and a unit test pins the numbers.
 */
internal class SongbookEngine(
    private val catalogProvider: () -> SongbookCatalog,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val catalog: SongbookCatalog get() = catalogProvider()

    /** What one group should be showing right now. */
    data class GroupLine(
        val group: Int,
        /** WAIT until the group's turn, SING while it has a line, DONE once it has sung every repeat. */
        val state: Phase,
        /** Line index for SING; for WAIT the number of lines until this group starts; otherwise 0. */
        val index: Int,
    ) {
        enum class Phase { WAIT, SING, DONE }
    }

    /** A person on the songbook page. Order decides the default round group; [chosenGroup] overrides it. */
    private class Guest(val id: String, val name: String, val order: Int, var chosenGroup: Int? = null, var lastSeen: Long = 0L)

    var song: Song? = null
        private set
    var songRevision = 0
        private set
    var revision = 0
        private set

    /** True when the host has turned on round mode for a song that has a round block. */
    var roundMode = false
        private set
    var groups = 3
        private set
    var offsetLines = 1
        private set
    var repeats = 3
        private set
    var lineMs = 3_000L
        private set
    var auto = true
        private set
    var playing = false
        private set

    /** The host's preference for the campfire (dark, low-brightness) theme. Guests may still flip their own. */
    var campfire = true
        private set

    private var stepAtBase = 0
    private var baseAt = 0L
    private var guestCounter = 0
    private val guests = LinkedHashMap<String, Guest>()
    private val hearts = LinkedHashMap<String, LinkedHashSet<String>>()
    private val sung = LinkedHashSet<String>()

    /** When this singing session began (first song chosen), or 0. */
    var sessionStartedAt = 0L
        private set

    private fun bump() { revision++ }

    // ---- what the song looks like ---------------------------------------------------------

    val lineCount: Int get() = song?.lines?.size ?: 0

    /** Total steps: one per line, or `repeats * lines + (groups - 1) * offset` in a round. */
    val totalSteps: Int
        get() {
            val s = song ?: return 0
            return if (roundMode) repeats * s.lines.size + (groups - 1) * offsetLines else s.lines.size
        }

    fun currentStep(now: Long = clock()): Int {
        if (song == null) return 0
        val moved = if (playing && auto) ((now - baseAt) / lineMs).toInt() else 0
        return (stepAtBase + moved).coerceIn(0, totalSteps)
    }

    /** Milliseconds since the current step began, for extrapolation on a guest; 0 unless auto is running. */
    fun msIntoStep(now: Long = clock()): Long =
        if (playing && auto && currentStep(now) < totalSteps) ((now - baseAt) % lineMs).coerceAtLeast(0L) else 0L

    fun finished(now: Long = clock()): Boolean = song != null && currentStep(now) >= totalSteps

    /** The answer for one group at the current step (or at [step] if given). */
    fun lineFor(group: Int, step: Int = currentStep()): GroupLine {
        val s = song ?: return GroupLine(group, GroupLine.Phase.DONE, 0)
        val size = s.lines.size
        if (!roundMode) {
            return if (step >= size) GroupLine(group, GroupLine.Phase.DONE, 0) else GroupLine(group, GroupLine.Phase.SING, step)
        }
        val k = step - group * offsetLines
        return when {
            k < 0 -> GroupLine(group, GroupLine.Phase.WAIT, -k)
            k >= repeats * size -> GroupLine(group, GroupLine.Phase.DONE, 0)
            else -> GroupLine(group, GroupLine.Phase.SING, k % size)
        }
    }

    // ---- host controls --------------------------------------------------------------------

    /** Pick a song. Clears its requests, resets to the top and stops. Returns false for an unknown id. */
    fun select(songId: String): Boolean {
        val next = catalog[songId] ?: return false
        noteProgress()
        song = next
        songRevision++
        roundMode = false
        val spec = next.round
        groups = spec?.groups ?: 3
        offsetLines = spec?.offsetLines ?: 1
        repeats = spec?.repeats ?: 3
        lineMs = (next.lineSeconds * 1000).toLong()
        stepAtBase = 0
        playing = false
        baseAt = clock()
        hearts.remove(next.id)
        if (sessionStartedAt == 0L) sessionStartedAt = clock()
        bump()
        return true
    }

    fun start(): Boolean {
        val now = clock()
        if (song == null) return false
        if (currentStep(now) >= totalSteps) stepAtBase = 0 else stepAtBase = currentStep(now)
        baseAt = now
        playing = true
        bump()
        return true
    }

    fun pause() {
        val now = clock()
        if (!playing) return
        stepAtBase = currentStep(now)
        playing = false
        noteProgress(now)
        bump()
    }

    fun next() {
        val now = clock()
        if (song == null) return
        stepAtBase = (currentStep(now) + 1).coerceAtMost(totalSteps)
        baseAt = now
        noteProgress(now)
        bump()
    }

    fun back() {
        val now = clock()
        if (song == null) return
        stepAtBase = (currentStep(now) - 1).coerceAtLeast(0)
        baseAt = now
        bump()
    }

    fun restart() {
        if (song == null) return
        stepAtBase = 0
        baseAt = clock()
        bump()
    }

    fun setLineSeconds(seconds: Double) {
        val now = clock()
        stepAtBase = currentStep(now)
        baseAt = now
        lineMs = (seconds.coerceIn(MIN_SECONDS, MAX_SECONDS) * 1000).toLong()
        bump()
    }

    fun setAuto(on: Boolean) {
        val now = clock()
        stepAtBase = currentStep(now)
        baseAt = now
        auto = on
        bump()
    }

    fun setCampfire(on: Boolean) { campfire = on; bump() }

    /** Round mode is only for songs that have a round block; returns false otherwise. */
    fun setRoundMode(on: Boolean): Boolean {
        val s = song ?: return false
        if (on && s.round == null) return false
        val now = clock()
        // Changing the shape of the timeline restarts it: the old step means something else now.
        stepAtBase = 0
        baseAt = now
        roundMode = on
        bump()
        return true
    }

    fun setGroups(count: Int) { groups = count.coerceIn(2, 4); if (roundMode) restart() else bump() }

    fun setOffsetLines(lines: Int) {
        val s = song
        val max = ((s?.lines?.size ?: 2) - 1).coerceIn(1, 8)
        offsetLines = lines.coerceIn(1, max)
        if (roundMode) restart() else bump()
    }

    /** The catalog changed (a pack was added or removed): forget a song that is no longer there. */
    fun catalogChanged() {
        val current = song
        if (current != null && !catalog.has(current.id)) { song = null; songRevision++; playing = false; roundMode = false; stepAtBase = 0 }
        hearts.keys.removeAll { !catalog.has(it) }
        bump()
    }

    /** End the singing session: nothing is playing and the sung list is empty again. */
    fun resetSession() {
        song = null
        songRevision++
        playing = false
        roundMode = false
        stepAtBase = 0
        sung.clear()
        hearts.clear()
        sessionStartedAt = 0L
        bump()
    }

    // ---- what counts as sung --------------------------------------------------------------

    /** Songs the family has sung this session, in order: a song counts once it is at least half way. */
    fun sungTitles(now: Long = clock()): List<String> {
        noteProgress(now)
        return sung.toList()
    }

    private fun noteProgress(now: Long = clock()) {
        val s = song ?: return
        val total = totalSteps
        if (total > 0 && currentStep(now) * 2 >= total) sung += s.title
    }

    // ---- guests ---------------------------------------------------------------------------

    fun join(id: String, name: String): Boolean {
        val now = clock()
        guests[id]?.let { it.lastSeen = now; return true }
        // Somebody who left long ago must not lock the door for a newcomer.
        if (guests.size >= MAX_GUESTS) guests.values.removeAll { now - it.lastSeen > STALE_MS }
        if (guests.size >= MAX_GUESTS) return false
        guests[id] = Guest(id, name, guestCounter++, lastSeen = now)
        bump()
        return true
    }

    private fun present(now: Long = clock()): List<Guest> = guests.values.filter { now - it.lastSeen <= PRESENT_MS }

    fun isGuest(id: String): Boolean = id in guests

    fun guestNames(): List<String> = present().map { it.name }

    fun setGroup(id: String, group: Int): Boolean {
        val guest = guests[id] ?: return false
        if (group !in 0 until MAX_GROUPS) return false
        guest.chosenGroup = group
        bump()
        return true
    }

    /** The group this guest sings with right now: their own choice, else join order, wrapped to the group count. */
    fun groupOf(id: String): Int {
        val guest = guests[id] ?: return 0
        return (guest.chosenGroup ?: guest.order).mod(groups)
    }

    /** People per group, for the host's round setup card. */
    fun groupSizes(): List<Int> = present().let { here -> (0 until groups).map { g -> here.count { groupOf(it.id) == g } } }

    // ---- requests -------------------------------------------------------------------------

    /**
     * A guest taps a song's heart. Tapping again takes it back. Returns null on success or the
     * message to show. A guest may keep only [MAX_HEARTS_PER_GUEST] open hearts.
     */
    fun toggleHeart(guestId: String, songId: String): String? {
        if (guestId !in guests) return "Join the songbook first."
        if (catalog[songId] == null) return "That song is not in the songbook."
        val voters = hearts.getOrPut(songId) { LinkedHashSet() }
        if (guestId in voters) {
            voters.remove(guestId)
            if (voters.isEmpty()) hearts.remove(songId)
            bump()
            return null
        }
        val open = hearts.values.count { guestId in it }
        if (open >= MAX_HEARTS_PER_GUEST) {
            if (voters.isEmpty()) hearts.remove(songId)
            return "You can ask for $MAX_HEARTS_PER_GUEST songs at a time. Un-heart one first."
        }
        voters.add(guestId)
        bump()
        return null
    }

    fun heartCount(songId: String): Int = hearts[songId]?.size ?: 0

    fun hearted(guestId: String, songId: String): Boolean = hearts[songId]?.contains(guestId) == true

    /** Requested songs, most hearts first; ties keep the order they were first requested. */
    fun requests(): List<Pair<Song, Int>> = hearts.entries
        .mapNotNull { (id, voters) -> catalog[id]?.let { it to voters.size } }
        .sortedByDescending { it.second }

    fun dismissRequest(songId: String) {
        if (hearts.remove(songId) != null) bump()
    }

    companion object {
        const val MAX_GUESTS = 40
        /** A guest seen in this long is "here" for the round setup card and the host's list. */
        const val PRESENT_MS = 45_000L
        const val STALE_MS = 15 * 60_000L
        const val MAX_GROUPS = 4
        const val MAX_HEARTS_PER_GUEST = 5
        const val MIN_SECONDS = 1.5
        const val MAX_SECONDS = 12.0
    }
}
