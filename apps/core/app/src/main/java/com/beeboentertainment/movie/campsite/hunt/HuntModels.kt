package com.beeboentertainment.movie.campsite.hunt

/*
 * Scavenger Hunt for Everyone: the plain data. Nothing in this package touches the network, the
 * microphone, the camera or the phone's location. A guest is a typed nickname held in memory for
 * the life of the hunt; the only thing kept afterwards is one line in the running Trip Journal
 * (counts only) and two badge counters, both on the host phone.
 */

/** Who an item is suitable for. An item is offered to its own band and every older band. */
internal enum class HuntBand(val wire: String, val label: String, val rank: Int) {
    LITTLE("4-6", "Ages 4-6", 0),
    MIDDLE("7-10", "Ages 7-10", 1),
    OLDER("11+", "Ages 11 and up", 2);

    companion object {
        fun of(wire: String?): HuntBand? = entries.firstOrNull { it.wire == wire }
    }
}

/** A plain checklist, or a bingo grid (rows, columns and diagonals earn a bonus). */
internal enum class HuntLayout(val wire: String) { LIST("list"), BINGO("bingo") }

/**
 * One thing to look for. [text] is words only (no markup), starts with a looking or listening verb,
 * and never asks anyone to touch, pick, catch or take anything. See [HuntContentRules].
 */
internal data class HuntItem(
    val id: String,
    val text: String,
    val band: HuntBand,
    /** A short extra nudge, shown under the item. Optional. */
    val hint: String = "",
) {
    /** A harder item is worth a little more. A bingo card ignores this: every square is one point. */
    val points: Int get() = band.rank + 1
}

/** A card set: the pool of items a hunt draws from. All written for Beebo. */
internal data class HuntCard(
    val id: String,
    val title: String,
    val emoji: String,
    val blurb: String,
    val layout: HuntLayout,
    /** Where this hunt is played, in one plain sentence for the host and the guests. */
    val where: String,
    val items: List<HuntItem>,
)

/** What the host chose before opening the hunt. [normalised] keeps every value in its allowed range. */
internal data class HuntSettings(
    val cardId: String = "camp-basics",
    val band: HuntBand = HuntBand.MIDDLE,
    /** How many items a list hunt uses (a bingo card uses the whole grid instead). */
    val itemCount: Int = 16,
    /** 0 = everyone alone, 1 = everyone together on one list, 2 to 4 = teams. */
    val teams: Int = 0,
    /** 0 = no timer. */
    val timerMinutes: Int = 0,
    /** The host checks each find before it counts. */
    val approval: Boolean = false,
    /** Guests may snap a photo to show their grown-up. It stays on that guest's phone. Default off. */
    val photos: Boolean = false,
    /** A shared, people-free photo prompt of the day. Needs [photos]. It stays on each phone. */
    val photoOfDay: Boolean = false,
) {
    fun normalised(): HuntSettings = copy(
        itemCount = itemCount.coerceIn(MIN_ITEMS, MAX_ITEMS),
        teams = teams.coerceIn(0, MAX_TEAMS),
        timerMinutes = if (timerMinutes in TIMERS) timerMinutes else 0,
        photoOfDay = photoOfDay && photos,
    )

    companion object {
        const val MIN_ITEMS = 8
        const val MAX_ITEMS = 40
        const val MAX_TEAMS = 4
        val TIMERS = listOf(0, 10, 20, 30, 45, 60)
        val COUNTS = listOf(12, 16, 20, 24)
    }
}

internal enum class HuntPhase(val wire: String) {
    LOBBY("lobby"),
    RUNNING("running"),
    DONE("done"),
}

/** Team names double as colours; the page adds a shape so colour is never the only cue. */
internal object HuntTeams {
    val NAMES = listOf("Red", "Blue", "Green", "Gold")
    val GLYPHS = listOf("▲", "●", "■", "★")
    fun label(index: Int): String = NAMES.getOrNull(index)?.let { "Team $it" } ?: "Team"
}

/** The fixed words shown to grown-ups and children. Tests hold the page and the host screen to these. */
internal object HuntSafety {
    const val STAY_TOGETHER = "Stay with your grown-up, and always within sight of an adult."
    const val LOOK_DONT_TOUCH = "Look, don't touch: leave plants, animals and their homes where they are."
    const val NO_EATING = "Never eat or taste anything you find."
    const val STAY_IN_BOUNDS = "Stay inside the areas your grown-up says are OK, and on marked paths."
    const val ASK_FIRST = "Ask a grown-up before you pick anything up."
    const val PHOTO_LOCAL = "Photos stay on your own phone. Nothing is sent to anyone."
    const val PHOTO_THINGS = "Photograph things, not people: no faces, no other campers, no signs with names or numbers."
    const val CAMPGROUND = "Check your campground's posted rules."

    /** The lines shown before and during every hunt. */
    val CORE = listOf(STAY_TOGETHER, LOOK_DONT_TOUCH, NO_EATING, STAY_IN_BOUNDS)
}
