package com.beeboentertainment.movie.core

/**
 * Tiny key/value abstraction so the resume-position logic can be unit-tested on the JVM
 * without SharedPreferences. The Android implementation is SharedPrefsKeyValueStore.
 */
interface KeyValueStore {
    fun getLong(key: String, default: Long): Long
    fun putLong(key: String, value: Long)
    fun remove(key: String)
    fun keys(): Set<String>

    // Booleans default to being stored as 0/1 longs, so an implementation only has to override
    // these if its backing store has a real boolean type (SharedPreferences does).
    fun getBoolean(key: String, default: Boolean): Boolean =
        getLong(key, if (default) 1L else 0L) != 0L

    fun putBoolean(key: String, value: Boolean) = putLong(key, if (value) 1L else 0L)
}

/** In-memory implementation, used by tests and as a safe fallback. */
class MemoryKeyValueStore(initial: Map<String, Long> = emptyMap()) : KeyValueStore {
    private val map = LinkedHashMap<String, Long>(initial)
    override fun getLong(key: String, default: Long) = map[key] ?: default
    override fun putLong(key: String, value: Long) { map[key] = value }
    override fun remove(key: String) { map.remove(key) }
    override fun keys(): Set<String> = map.keys.toSet()
}

/**
 * Remembers "where was I?" per library item.
 *
 * Rules (deliberately simple, matches how the family actually watches things):
 *  - anything under MIN_RESUME_MS is treated as "didn't really start" and is not stored
 *  - anything within NEAR_END_MS of the end counts as finished and clears the mark
 *  - a stored mark only produces a resume prompt if it is still above MIN_RESUME_MS
 */
class ResumeStore(private val store: KeyValueStore) {

    companion object {
        const val PREFIX = "resume_"
        /** Don't bother remembering the first 30 seconds. */
        const val MIN_RESUME_MS = 30_000L
        /** Within 90 seconds of the end -> treat as watched. */
        const val NEAR_END_MS = 90_000L

        fun keyFor(itemId: String): String = PREFIX + itemId
    }

    /** Record a position. durationMs <= 0 means "unknown", in which case near-end logic is skipped. */
    fun save(itemId: String, positionMs: Long, durationMs: Long) {
        if (itemId.isBlank()) return
        val key = keyFor(itemId)
        if (positionMs < MIN_RESUME_MS) {
            store.remove(key)
            return
        }
        if (durationMs > 0 && positionMs >= durationMs - NEAR_END_MS) {
            store.remove(key)
            return
        }
        store.putLong(key, positionMs)
    }

    /** 0 when there is nothing worth resuming. */
    fun position(itemId: String): Long {
        if (itemId.isBlank()) return 0L
        val v = store.getLong(keyFor(itemId), 0L)
        return if (v >= MIN_RESUME_MS) v else 0L
    }

    fun hasResume(itemId: String): Boolean = position(itemId) > 0L

    fun clear(itemId: String) = store.remove(keyFor(itemId))

    fun clearAll() = store.keys().filter { it.startsWith(PREFIX) }.forEach { store.remove(it) }

    /** "1:23:45" / "4:07" for the resume prompt. */
    fun formatted(itemId: String): String = formatMs(position(itemId))
}

fun formatMs(ms: Long): String {
    if (ms <= 0) return "0:00"
    val totalSec = ms / 1000
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    return if (h > 0) String.format("%d:%02d:%02d", h, m, s) else String.format("%d:%02d", m, s)
}

/** Human-readable byte size for the Downloads tab. */
fun formatBytes(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var v = bytes.toDouble()
    var i = 0
    while (v >= 1024 && i < units.lastIndex) { v /= 1024; i++ }
    return if (i == 0) "${bytes} B" else String.format("%.1f %s", v, units[i])
}
