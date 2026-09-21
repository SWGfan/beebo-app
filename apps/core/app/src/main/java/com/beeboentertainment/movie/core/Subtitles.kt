package com.beeboentertainment.movie.core

/**
 * The decisions behind sidecar subtitles, free of Android and Media3.
 *
 * Both PlayerActivity and PlaybackService put sidecars on a MediaItem and pick one of them, and
 * they must agree on every detail - the stamped track id above all, which is how a selection
 * finds its track again - or a choice made on one side would silently miss on the other.
 */
object SubtitlePolicy {

    private const val TAG_PREFIX = "beebo-sub-"

    /**
     * The id stamped on the sidecar at [index]. It comes back as Format.id on the selectable
     * track, and is the only way to tell an "English" and an "English (SDH)" pair apart.
     */
    fun tag(index: Int): String = "$TAG_PREFIX$index"

    /**
     * Which sidecar the remembered preference points at, or -1 for off.
     *
     * Matched by language code, falling back to the first track. The set of sidecars differs
     * from one file to the next, so the language is the only part of a previous choice that can
     * mean anything on another file. [languages] is one entry per sidecar, in list order.
     */
    fun rememberedIndex(languages: List<String?>, subtitlesOn: Boolean, wantedLanguage: String?): Int {
        if (!subtitlesOn || languages.isEmpty()) return -1
        val wanted = wantedLanguage.orEmpty()
        if (wanted.isNotBlank()) {
            val hit = languages.indexOfFirst { it.equals(wanted, ignoreCase = true) }
            if (hit >= 0) return hit
        }
        return 0
    }

    /**
     * Should PlaybackService fetch this item's sidecars and put them on it after it has started?
     *
     * That costs a re-prepare, so only when the viewer has subtitles on. Never while casting - the
     * receiver is handed the item without them, and re-setting it would reload the video on the
     * TV for nothing. Never for a downloaded file (not http), which must keep working offline, and
     * never for an item with no library id, which the server has no sidecar list for.
     */
    fun shouldAttach(
        subtitlesOn: Boolean,
        casting: Boolean,
        itemId: String?,
        uri: String?,
        alreadyAttached: Boolean
    ): Boolean =
        subtitlesOn && !casting && !alreadyAttached && !itemId.isNullOrBlank() && isStream(uri)

    /** A server stream, as opposed to a downloaded file or anything else. */
    fun isStream(uri: String?): Boolean =
        uri != null && (uri.startsWith("http://", ignoreCase = true) || uri.startsWith("https://", ignoreCase = true))
}

/**
 * A small time-limited map, for answers worth reusing for a while but not forever.
 *
 * Holds at most [maxEntries], dropping the least recently used. Not thread-safe: the one user
 * keeps it on the main thread.
 */
class ExpiringCache<V>(
    private val ttlMs: Long,
    private val maxEntries: Int,
    private val clock: () -> Long = System::currentTimeMillis
) {
    private class Entry<V>(val value: V, val storedAt: Long)

    private val entries = object : LinkedHashMap<String, Entry<V>>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry<V>>?): Boolean =
            size > maxEntries
    }

    fun get(key: String): V? {
        val entry = entries[key] ?: return null
        if (clock() - entry.storedAt >= ttlMs) {
            entries.remove(key)
            return null
        }
        return entry.value
    }

    fun put(key: String, value: V) {
        entries[key] = Entry(value, clock())
    }
}
