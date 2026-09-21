package com.beeboentertainment.auto.family

/**
 * The mediaId namespace for the Family Fun folder in the car's media browser.
 *
 * Everything here is a plain string that round-trips through Android Auto. A round of a voice game
 * is described completely by its id (which game, which seed, which round, which age band), so the
 * spoken audio for it can be rebuilt from nothing but that id: no session state has to survive in
 * memory between one round and the next, and a process restart in the middle of a queue is harmless.
 *
 * Nothing in an id is personal: no name, no place, no time.
 */
object FamilyIds {
    const val ROOT = "family/root"
    const val CLOCK = "family/clock"
    const val STORIES = "family/stories"
    const val GAMES = "family/games"

    /** A browsable row that only carries a sentence (for example "Games are resting until 6:00 AM"). */
    const val NOTE = "family/note"

    /** The host shows Family Fun as a root tab only when it will show at least this many tabs. */
    const val ROOT_TABS_WITH_FAMILY = 7

    /** URI scheme of the spoken audio. It is resolved on the phone; nothing is ever fetched. */
    const val AUDIO_SCHEME = "beebo-tts"

    private const val AUDIO_PREFIX = "$AUDIO_SCHEME://voice/"

    private const val MAX_PARTS = 40

    private val SAFE_ID = Regex("^[a-z0-9-]{1,40}$")

    fun isFamily(mediaId: String): Boolean = mediaId.startsWith("family/")

    fun story(id: String) = "family/story/$id"

    /** One part of a story: a story is read as a short queue of parts so the sound starts quickly. */
    fun storyPart(id: String, part: Int) = "family/part/$id/$part"

    fun gameStart(kind: GameKind) = "family/game/${kind.wire}"

    fun round(kind: GameKind, seed: Int, index: Int, band: AgeBand) =
        "family/round/${kind.wire}/$seed/$index/${band.wire}"

    sealed interface Parsed {
        data object Root : Parsed
        data object Clock : Parsed
        data object Stories : Parsed
        data object Games : Parsed
        data object Note : Parsed
        data class Story(val id: String) : Parsed
        data class StoryPart(val id: String, val part: Int) : Parsed
        data class GameStart(val kind: GameKind) : Parsed
        data class Round(val kind: GameKind, val seed: Int, val index: Int, val band: AgeBand) : Parsed
    }

    /** Null for anything that is not a well-formed Family Fun id. */
    fun parse(mediaId: String): Parsed? {
        when (mediaId) {
            ROOT -> return Parsed.Root
            CLOCK -> return Parsed.Clock
            STORIES -> return Parsed.Stories
            GAMES -> return Parsed.Games
            NOTE -> return Parsed.Note
        }
        val parts = mediaId.split('/')
        if (parts.size < 3 || parts[0] != "family") return null
        return when (parts[1]) {
            "story" -> if (parts.size == 3 && SAFE_ID.matches(parts[2])) Parsed.Story(parts[2]) else null
            "part" -> {
                if (parts.size != 4 || !SAFE_ID.matches(parts[2])) return null
                val n = parts[3].toIntOrNull()?.takeIf { it in 0..MAX_PARTS } ?: return null
                Parsed.StoryPart(parts[2], n)
            }
            "game" -> if (parts.size == 3) GameKind.fromWire(parts[2])?.let { Parsed.GameStart(it) } else null
            "round" -> {
                if (parts.size != 6) return null
                val kind = GameKind.fromWire(parts[2]) ?: return null
                val seed = parts[3].toIntOrNull() ?: return null
                val index = parts[4].toIntOrNull()?.takeIf { it in 0 until kind.rounds } ?: return null
                val band = AgeBand.entries.firstOrNull { it.wire == parts[5] } ?: return null
                Parsed.Round(kind, seed, index, band)
            }
            else -> null
        }
    }

    /** The URI a playable item carries. It only has meaning inside this app. */
    fun audioUri(mediaId: String): String = AUDIO_PREFIX + mediaId

    /** Back from [audioUri]; null when the string is not one of ours. */
    fun mediaIdFromAudioUri(uri: String): String? =
        uri.takeIf { it.startsWith(AUDIO_PREFIX) }?.removePrefix(AUDIO_PREFIX)?.takeIf { isFamily(it) }
}
