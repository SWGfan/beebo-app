package com.beeboentertainment.auto.family

import com.beeboentertainment.auto.drive.VideoGate
import java.security.MessageDigest

/** The spoken side of one item: its title, and the script the voice reads. */
internal data class SpokenItem(val title: String, val subtitle: String, val script: Script, val speechRate: Float)

/**
 * Turns a Family Fun media id into what the phone's voice should say, and applies the rules of
 * [FamilyGate] at the two moments they matter: when someone asks to START something
 * ([forMedia], [gameQueue]) and just before an item is spoken ([forPlayback]).
 */
internal object FamilyScripts {

    /** A little slower than the engine's default: clearer in a car with road noise. */
    const val RATE_NORMAL = 0.95f

    /** Slower again for quiet hours and stories at bedtime. */
    const val RATE_CALM = 0.82f

    private fun build(p: FamilyIds.Parsed, env: FamilyEnv, calm: Boolean): SpokenItem? = when (p) {
        FamilyIds.Parsed.Clock -> {
            val g = TripGlance.glance(env.clock, env.nowMs, env.zone)
            SpokenItem(g.title, g.subtitle, Script(listOf(Step.Say(g.spoken))), RATE_NORMAL)
        }
        is FamilyIds.Parsed.StoryPart -> Stories.byId(p.id)?.takeIf { p.part < Stories.partCount(it) }?.let { story ->
            SpokenItem(
                story.title, "Part ${p.part + 1} of ${Stories.partCount(story)}",
                Stories.script(story, p.part, calm), if (calm) RATE_CALM else RATE_NORMAL,
            )
        }
        is FamilyIds.Parsed.Round -> VoiceGames.round(p.kind, p.seed, p.index, p.band)?.let {
            SpokenItem(it.title, it.subtitle, it.script, RATE_NORMAL)
        }
        else -> null
    }

    /**
     * The script for [id] at the moment someone asks to START it, or null if it is unknown or the
     * gate says it may not play right now. [surface] and [signals] say who is asking; see [FamilyGate].
     */
    fun forMedia(id: String, env: FamilyEnv, surface: FamilyGate.Surface, signals: VideoGate.Signals): SpokenItem? {
        val p = FamilyIds.parse(id) ?: return null
        val feature = when (p) {
            FamilyIds.Parsed.Clock -> FamilyGate.Feature.TRIP_CLOCK
            is FamilyIds.Parsed.StoryPart, is FamilyIds.Parsed.Story -> FamilyGate.Feature.STORIES
            is FamilyIds.Parsed.Round, is FamilyIds.Parsed.GameStart -> FamilyGate.Feature.VOICE_GAMES
            else -> return null
        }
        val d = env.gate(feature, surface, signals)
        return if (d.listen) build(p, env, d.calm) else null
    }

    /**
     * The script for an item that is about to be heard. It was allowed when it was queued, so only
     * what can change while a queue plays is checked again: quiet hours starting mid-queue stops the
     * next voice-game round from being spoken, and stories turn calm.
     */
    fun forPlayback(id: String, env: FamilyEnv): SpokenItem? {
        val p = FamilyIds.parse(id) ?: return null
        if (p is FamilyIds.Parsed.Round && env.quiet) return null
        return build(p, env, calm = env.quiet)
    }

    /** The queue for tapping a game in the list: every round of one play, sharing a seed. Empty when the rule says no. */
    fun gameQueue(
        kind: GameKind, seed: Int, env: FamilyEnv, surface: FamilyGate.Surface, signals: VideoGate.Signals,
    ): List<MenuEntry> {
        val d = env.gate(FamilyGate.Feature.VOICE_GAMES, surface, signals)
        if (!d.listen) return emptyList()
        return (0 until kind.rounds).mapNotNull { i ->
            VoiceGames.round(kind, seed, i, env.ageBand)?.let {
                MenuEntry(FamilyIds.round(kind, seed, i, env.ageBand), it.title, it.subtitle, true)
            }
        }
    }

    /** The parts of one story, in order. Empty for an unknown story. */
    fun storyQueue(storyId: String): List<MenuEntry> {
        val story = Stories.byId(storyId) ?: return emptyList()
        val n = Stories.partCount(story)
        return (0 until n).map { i ->
            MenuEntry(FamilyIds.storyPart(story.id, i), story.title, "Part ${i + 1} of $n", true)
        }
    }
}

/** How the rendered speech files are named and how many are kept. Pure, so it is tested. */
internal object SpeechCache {

    const val KEEP_FILES = 40

    /** The same words at the same speed always map to the same file, so a repeat costs nothing. */
    fun key(item: SpokenItem): String {
        val text = buildString {
            append(item.speechRate).append('|')
            item.script.steps.forEach {
                when (it) {
                    is Step.Say -> append('S').append(it.text)
                    is Step.Pause -> append('P').append(it.ms)
                }
                append('\n')
            }
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        return digest.take(16).joinToString("") { "%02x".format(it) }
    }

    /** Given (name, lastModified) pairs, the names to delete so at most [keep] remain (oldest go first). */
    fun trimPlan(files: List<Pair<String, Long>>, keep: Int = KEEP_FILES): List<String> =
        files.sortedByDescending { it.second }.drop(keep.coerceAtLeast(0)).map { it.first }

    /** Long text is spoken in pieces no longer than [max], split at sentence ends when possible. */
    fun chunks(text: String, max: Int): List<String> {
        val limit = max.coerceAtLeast(50)
        if (text.length <= limit) return listOf(text)
        val out = ArrayList<String>()
        var rest = text.trim()
        while (rest.length > limit) {
            val window = rest.substring(0, limit)
            var cut = maxOf(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "))
            if (cut < limit / 3) cut = window.lastIndexOf(' ')
            if (cut <= 0) cut = limit - 1
            out += rest.substring(0, cut + 1).trim()
            rest = rest.substring(cut + 1).trim()
        }
        if (rest.isNotEmpty()) out += rest
        return out
    }
}
