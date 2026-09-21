package com.beeboentertainment.movie.player

import com.beeboentertainment.movie.core.UrlUtils
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * The seek-preview strip of the file on screen, as `/playback/trickplay/info` describes it.
 * Every field is optional on the wire: a server that predates previews answers 404 and none of
 * this exists.
 */
data class TrickplayInfo(
    val available: Boolean = false,
    val generating: Boolean = false,
    val disabled: Boolean = false,
    val intervalSec: Int = 0,
    val count: Int = 0,
    val width: Int = 0,
    val thumbUrl: String = ""
) {
    /** Previews can be shown right now. */
    val usable: Boolean get() = available && !disabled && intervalSec > 0 && count > 0 && thumbUrl.isNotBlank()

    /** Not ready yet but the computer is making them: ask again later. */
    val shouldPoll: Boolean get() = !available && generating && !disabled

    /** The frame closest to [positionMs]. */
    fun frameIndex(positionMs: Long): Int {
        if (intervalSec <= 0 || count <= 0) return 0
        val nearest = Math.round(positionMs.coerceAtLeast(0L) / (intervalSec * 1000.0)).toInt()
        return nearest.coerceIn(0, count - 1)
    }

    /** The instant a frame stands for, in whole seconds (what is asked of the server, so identical asks cache). */
    fun frameTimeSec(index: Int): Int = index.coerceIn(0, (count - 1).coerceAtLeast(0)) * intervalSec

    /** The absolute URL of frame [index], or null when there is no usable base. The media token travels inside [thumbUrl]. */
    fun frameUrl(baseUrl: String?, index: Int): String? {
        val absolute = UrlUtils.join(baseUrl, thumbUrl) ?: return null
        val joiner = if (absolute.contains('?')) "&" else "?"
        return "$absolute${joiner}t=${frameTimeSec(index)}"
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /** Null for anything that is not a well-formed successful answer. */
        fun parse(body: String?): TrickplayInfo? {
            if (body.isNullOrBlank()) return null
            val obj = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject ?: return null
            if (bool(obj["ok"]) != true) return null
            return TrickplayInfo(
                available = bool(obj["available"]) == true,
                generating = bool(obj["generating"]) == true,
                disabled = bool(obj["disabled"]) == true,
                intervalSec = int(obj["intervalSec"]),
                count = int(obj["count"]),
                width = int(obj["width"]),
                thumbUrl = ((obj["thumbUrl"] as? JsonPrimitive)?.takeIf { it.isString }?.content).orEmpty()
            )
        }

        private fun bool(e: JsonElement?): Boolean? = (e as? JsonPrimitive)?.booleanOrNull

        private fun int(e: JsonElement?): Int {
            val d = (e as? JsonPrimitive)?.doubleOrNull ?: return 0
            return if (d.isNaN() || d.isInfinite() || d < 0 || d > Int.MAX_VALUE) 0 else d.toInt()
        }
    }
}

/** When to ask again while the computer is still making the first set: 15 s, 30 s, 60 s, then give up. */
object TrickplayPoll {
    val DELAYS_MS: List<Long> = listOf(15_000L, 30_000L, 60_000L)

    /** The wait before poll number [attempt] (0-based), or null once they are used up. */
    fun delayMs(attempt: Int): Long? = DELAYS_MS.getOrNull(attempt)
}

/** Lets an action through at most once per [minIntervalMs]. Used for the info refresh after an expired media token. */
class Throttle(private val minIntervalMs: Long, private val clock: () -> Long = { System.currentTimeMillis() }) {
    private var last = Long.MIN_VALUE

    @Synchronized
    fun tryAcquire(): Boolean {
        val now = clock()
        if (last != Long.MIN_VALUE && now - last < minIntervalMs) return false
        last = now
        return true
    }
}

/** A small least-recently-used map; thumbnails are ~5 KB each so 40 of them are cheap. */
class FrameCache<V : Any>(private val maxEntries: Int = DEFAULT_MAX) {
    private val map = object : LinkedHashMap<Int, V>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, V>?): Boolean = size > maxEntries
    }

    @Synchronized
    operator fun get(key: Int): V? = map[key]

    @Synchronized
    operator fun set(key: Int, value: V) {
        map[key] = value
    }

    @Synchronized
    fun clear() = map.clear()

    @get:Synchronized
    val size: Int get() = map.size

    companion object {
        const val DEFAULT_MAX = 40
    }
}
