package com.beeboentertainment.movie.trip

/**
 * Where a game hands its results to the running trip. Split from [TripStore] so the games engine,
 * which is built and tested with no Android context, needs nothing but this: [None] is what a test
 * gets, and no game knows the difference.
 */
internal interface TripMomentSink {
    fun story(story: StoryResult)

    /** A finished plate or sign hunt. Default does nothing so older sinks and tests are unaffected. */
    fun tally(tally: TallyResult) {}

    /** A finished Scavenger Hunt for Everyone: a card name and a count. Default does nothing. */
    fun huntCard(tally: TallyResult) {}

    object None : TripMomentSink {
        override fun story(story: StoryResult) {}
    }
}

/** The real sink: keeps the story on the running trip, and does nothing when none is running. */
internal class TripStoreSink(private val store: TripStore) : TripMomentSink {
    override fun story(story: StoryResult) {
        // A finished story must never fail the round that produced it.
        runCatching { store.recordStory(story) }
    }

    override fun tally(tally: TallyResult) {
        runCatching { store.recordTally(tally) }
    }

    override fun huntCard(tally: TallyResult) {
        runCatching { store.recordHuntCard(tally) }
    }
}

/** Turns a finished Campfire Stories round into a [StoryResult]. Pure. */
internal object StoryCapture {

    /**
     * @param starter the first line the round opened with
     * @param log the lines people added, each "Name: sentence" as the game writes them
     * @param humanNames the people seated in the round. Only they are credited as tellers; a
     *   computer player's lines stay in the text but it is not named.
     * @return null when nobody added a line, since a starter alone is not a story
     */
    fun fromRound(id: String, mood: String, starter: String, log: List<String>, humanNames: List<String>): StoryResult? {
        if (log.isEmpty()) return null
        val byLength = humanNames.sortedByDescending { it.length }
        val tellers = linkedSetOf<String>()
        val sentences = ArrayList<String>()
        log.forEach { line ->
            val name = byLength.firstOrNull { line.startsWith("$it: ") }
            if (name != null) tellers += name
            sentences += (if (name != null) line.removePrefix("$name: ") else line.substringAfter(": ", line)).trim()
        }
        val text = (listOf(starter.trim()) + sentences).filter { it.isNotEmpty() }.joinToString(" ")
        val label = mood.trim()
        return StoryResult(
            id = id,
            title = if (label.isEmpty()) "Campfire story" else "Campfire story · $label",
            mood = mood.trim(),
            tellers = tellers.toList(),
            text = text,
        )
    }
}
