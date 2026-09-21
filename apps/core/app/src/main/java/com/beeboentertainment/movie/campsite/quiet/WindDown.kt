package com.beeboentertainment.movie.campsite.quiet

/**
 * Bedtime Wind-Down: one tap runs a short, scripted sequence on the host phone.
 *
 *   1. a gentle story, read aloud with the phone's own voice,
 *   2. then quiet ambience (rain, crickets, waves or a fire),
 *   3. then a slow fade-out,
 *   4. then it stops, and NOTHING plays after the timer ends.
 *
 * The sequence is a plain state machine driven by a clock reading, with the sound side behind
 * [WindDownEffects]. So the timing is tested with a fake clock and a recording fake, and the real
 * phone only has to supply a voice and an ambience player.
 *
 * NO CLAIMS. It never says it helps anyone sleep and it is not a treatment for anything. It is a
 * story, some quiet sound and a timer. The screen says so.
 *
 * All of it is local: the stories are bundled in the app (see [WindDownStories]) and the ambience is
 * made on the phone, so it works with no network.
 */
internal enum class WindDownPhase { IDLE, STORY, AMBIENCE, FADE, DONE }

internal interface WindDownEffects {
    /** Start reading [text] aloud. The runner is told when it ends through [WindDownRunner.storyFinished]. */
    fun speak(text: String)
    fun stopSpeaking()
    fun startAmbience(id: String)
    fun setAmbienceVolume(level: Float)
    fun stopAmbience()
}

internal data class WindDownConfig(
    /** Total length: one of [MINUTES]. */
    val minutes: Int = 20,
    val story: Boolean = true,
    val storyIndex: Int = 0,
    /** One of the app's ambience ids (fire, crickets, rain, waves). */
    val ambienceId: String = "rain",
) {
    companion object {
        val MINUTES = listOf(10, 20, 30)
    }
}

internal class WindDownRunner(
    private val effects: WindDownEffects,
    private val stories: List<WindDownStory> = WindDownStories.ALL,
) {
    var phase: WindDownPhase = WindDownPhase.IDLE
        private set

    private var config = WindDownConfig()
    private var startedAtMs = 0L
    private var endsAtMs = 0L

    /** When the story is cut off if it has not finished by itself. */
    private var storyCapMs = 0L
    private var fadeStartMs = 0L

    /** The story being read, for the screen. */
    var storyTitle: String = ""
        private set

    /** True from [start] until it finishes or is cancelled. */
    val running: Boolean get() = phase == WindDownPhase.STORY || phase == WindDownPhase.AMBIENCE || phase == WindDownPhase.FADE

    fun remainingMs(nowMs: Long): Long = if (running) (endsAtMs - nowMs).coerceAtLeast(0L) else 0L

    fun start(nowMs: Long, config: WindDownConfig) {
        if (running) return
        this.config = config.copy(minutes = if (config.minutes in WindDownConfig.MINUTES) config.minutes else 20)
        val total = this.config.minutes * 60_000L
        startedAtMs = nowMs
        endsAtMs = nowMs + total
        fadeStartMs = endsAtMs - fadeMs(total)
        // A story gets at most the first 40% of the time, so there is always ambience after it.
        storyCapMs = nowMs + total * 2 / 5
        val story = stories.getOrNull(this.config.storyIndex.mod(stories.size.coerceAtLeast(1)))
        if (this.config.story && story != null) {
            storyTitle = story.title
            phase = WindDownPhase.STORY
            effects.speak(story.text)
        } else {
            storyTitle = ""
            beginAmbience()
        }
    }

    /** The voice reached the end of the story. Ignored unless the story phase is what is running. */
    fun storyFinished(nowMs: Long) {
        if (phase != WindDownPhase.STORY) return
        if (nowMs >= endsAtMs) { finish(); return }
        beginAmbience()
    }

    /** Move the sequence on. Call about once a second. Cheap and safe to call after it has finished. */
    fun tick(nowMs: Long) {
        when (phase) {
            WindDownPhase.STORY -> when {
                nowMs >= endsAtMs -> finish()
                nowMs >= storyCapMs -> { effects.stopSpeaking(); beginAmbience() }
            }
            WindDownPhase.AMBIENCE -> when {
                nowMs >= endsAtMs -> finish()
                nowMs >= fadeStartMs -> { phase = WindDownPhase.FADE; effects.setAmbienceVolume(fadeLevel(nowMs)) }
            }
            WindDownPhase.FADE -> if (nowMs >= endsAtMs) finish() else effects.setAmbienceVolume(fadeLevel(nowMs))
            WindDownPhase.IDLE, WindDownPhase.DONE -> Unit
        }
    }

    /** The visible Cancel. Stops the voice and the ambience at once. */
    fun cancel() {
        if (!running) return
        effects.stopSpeaking()
        effects.stopAmbience()
        phase = WindDownPhase.IDLE
    }

    private fun beginAmbience() {
        phase = WindDownPhase.AMBIENCE
        effects.setAmbienceVolume(BASE_LEVEL)
        effects.startAmbience(config.ambienceId)
    }

    private fun finish() {
        effects.stopSpeaking()
        effects.stopAmbience()
        phase = WindDownPhase.DONE
    }

    private fun fadeLevel(nowMs: Long): Float {
        val left = (endsAtMs - nowMs).coerceAtLeast(0L).toFloat()
        val span = (endsAtMs - fadeStartMs).coerceAtLeast(1L).toFloat()
        return (BASE_LEVEL * (left / span)).coerceIn(0f, BASE_LEVEL)
    }

    companion object {
        /** Ambience is kept gentle: never full volume. */
        const val BASE_LEVEL = 0.6f

        /** The fade is the last minute, or a fifth of a short session. */
        fun fadeMs(totalMs: Long): Long = minOf(60_000L, totalMs / 5)
    }
}

internal data class WindDownStory(val title: String, val text: String)

/**
 * Three short bedtime stories, written for Beebo for this feature (so they are ours to ship). Kept
 * calm and small: no danger, no cliffhangers, no names of real people, places or brands.
 */
internal object WindDownStories {
    val ALL: List<WindDownStory> = listOf(
        WindDownStory(
            "The Little Lantern",
            "Once there was a little lantern that hung by the door of a tent at the edge of a quiet wood. " +
                "All day the lantern rested. When the sun went down, it glowed softly, warm as a cup of cocoa. " +
                "A moth came by and said, Hello, little lantern. Are you tired? " +
                "The lantern said, A little. But the night is gentle, so there is no hurry. " +
                "The moth settled on the canvas and folded her wings. " +
                "Down in the grass, the crickets began their slow, sleepy song. " +
                "The lantern glowed a little lower, and a little lower, the way a fire does when it has kept everyone warm. " +
                "The stars came out, one by one, like small lamps being lit far away. " +
                "And under the soft light, everybody in the tent rested. " +
                "Goodnight, little lantern. Goodnight, moth. Goodnight, wood.",
        ),
        WindDownStory(
            "The Sleepy River",
            "Far up in the hills there was a river that never hurried. " +
                "It slid over smooth stones and whispered to them as it went. " +
                "A small leaf climbed on and asked, Where are we going? " +
                "The river said, Down, and down, and down, slowly, to the sea. " +
                "So the leaf lay back and watched the sky. " +
                "They floated past tall ferns and under a wooden bridge. " +
                "They passed a heron standing on one leg, half asleep already. " +
                "The water made the softest sound, hush, hush, hush. " +
                "The moon rose and laid a silver path on the ripples, and the leaf followed it, drifting, drifting. " +
                "By the time they reached the wide, calm bay, the leaf was fast asleep, and the river carried her on, gently, all night long.",
        ),
        WindDownStory(
            "The Fox and the Quiet Moon",
            "A young fox lived in a den beneath an old pine tree. " +
                "One night he could not settle, and he padded out to look at the moon. " +
                "The moon was big and round and very still. " +
                "Why are you so quiet? asked the fox. " +
                "The moon smiled and said, Because everyone below is resting, and I like to keep watch without a sound. " +
                "The fox sat down on the soft pine needles. " +
                "He listened to the wind move slowly through the branches, like a long, slow breath. " +
                "He listened to an owl far away, saying good night. " +
                "He yawned a big fox yawn. " +
                "Then he curled his tail around his nose and walked back to his den, where it was warm and dark and safe. " +
                "The moon kept watch. And the whole wood slept.",
        ),
    )
}
