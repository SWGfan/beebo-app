package com.beeboentertainment.movie.audio

/**
 * What the app's one audio service (the Media3 session in music/MusicPlaybackService) is playing.
 * Music was first; audiobooks, podcasts and internet radio share the same service, notification
 * and lock-screen controls, and differ only in what the buttons mean (see [spoken]). The kind
 * travels with every item as an extra, so a notification tap, the mini player and a headset all
 * know which screen and which behaviour a queue item belongs to.
 */
enum class AudioKind(val id: String) {
    MUSIC("music"),
    AUDIOBOOK("audiobook"),
    PODCAST("podcast"),
    RADIO("radio");

    /** Spoken word (and live radio): speed control and the 15 s back / 30 s forward buttons instead of shuffle and gain. */
    val spoken: Boolean get() = this != MUSIC

    /** Radio has no length and nothing to seek in. */
    val seekable: Boolean get() = this != RADIO

    companion object {
        fun fromId(id: String?): AudioKind = values().firstOrNull { it.id == id } ?: MUSIC
    }
}

/** Keys on a MediaItem's metadata extras. */
object AudioExtras {
    const val KIND = "beebo.audio.kind"
    /** Book id, episode key or station session id: what the server calls this item. */
    const val ITEM_ID = "beebo.audio.itemId"
    const val PART_INDEX = "beebo.audio.partIndex"
    /** Where this file starts on the whole-book / whole-episode timeline, in seconds. */
    const val PART_START_SEC = "beebo.audio.partStartSec"
    const val PART_DURATION_SEC = "beebo.audio.partDurationSec"
    const val TOTAL_DURATION_SEC = "beebo.audio.totalDurationSec"
    /** The show / series / station the item belongs to, for "go to" actions. */
    const val GROUP_ID = "beebo.audio.groupId"
}

/**
 * Which of the server's audio addresses a URL is, so the service knows to send the bearer token
 * (and only to this server) and which options it may add. A URL on another host, or a path that
 * is not exactly one of these shapes, is nothing to us.
 */
object AudioStreamRules {

    private val MUSIC = Regex("""^/api/music/track/[a-f0-9]{20}/stream(\?.*)?$""")
    private val AUDIOBOOK = Regex("""^/api/audiobooks/book/[a-f0-9]{16}/stream(/\d{1,5})?(\?.*)?$""")
    private val PODCAST = Regex("""^/api/podcasts/episode/[a-f0-9]{12}\.[a-f0-9]{16}/stream(\?.*)?$""")
    private val RADIO = Regex("""^/api/radio/session/[a-f0-9]{16}/stream(\?.*)?$""")

    /** The kind of stream [url] is on [baseUrl], or null when it is not one of ours. */
    fun kindOf(url: String, baseUrl: String?): AudioKind? {
        val base = baseUrl?.trimEnd('/') ?: return null
        if (!url.startsWith("$base/")) return null
        val path = url.substring(base.length)
        return when {
            MUSIC.matches(path) -> AudioKind.MUSIC
            AUDIOBOOK.matches(path) -> AudioKind.AUDIOBOOK
            PODCAST.matches(path) -> AudioKind.PODCAST
            RADIO.matches(path) -> AudioKind.RADIO
            else -> null
        }
    }

    /** Server-relative path prefixes a stream address from a server answer may have, per kind. */
    fun pathPrefix(kind: AudioKind): String = when (kind) {
        AudioKind.MUSIC -> "/api/music/"
        AudioKind.AUDIOBOOK -> "/api/audiobooks/"
        AudioKind.PODCAST -> "/api/podcasts/"
        AudioKind.RADIO -> "/api/radio/"
    }
}
