package com.beeboentertainment.movie.campsite.family

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * Shared plumbing for the family pack (Roadside Quiz and Campfire Songbook). Nothing in this
 * package touches the network, the microphone, the camera or the phone's location, and nothing
 * here stores a guest's name anywhere but in memory for the life of the session.
 */

/** One HTTP-ish answer from a family service: a status and a JSON body. */
internal class FamilyReply(val status: Int, val body: JsonObject) {
    companion object {
        fun ok(body: JsonObject): FamilyReply = FamilyReply(200, body)

        fun error(status: Int, message: String): FamilyReply = FamilyReply(status, buildJsonObject {
            put("ok", false)
            put("error", message)
        })
    }
}

/** Cleaning for every string that ever came from a person's keyboard. */
internal object FamilyText {

    /**
     * A display name: control characters and markup-significant characters removed, whitespace
     * collapsed, at most [max] characters. Web pages still render it with textContent; stripping
     * here is the second line of defence, not the only one.
     */
    fun name(raw: String, max: Int = 24, fallback: String = "Guest"): String {
        val cleaned = raw.filter { !it.isISOControl() && it != '<' && it != '>' && it != '&' && it != '"' }
            .replace(Regex("\\s+"), " ").trim().take(max).trim()
        return cleaned.ifBlank { fallback }
    }

    /** HTML-escape, for the rare place a value is placed into markup instead of textContent. */
    fun html(value: String): String = value.replace("&", "&amp;")
        .replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")
}

/**
 * A per-key sliding-window rate limit, on the host's own clock so a test can drive it. A guest
 * that polls politely never notices it; a phone stuck in a retry loop, or a page that was left
 * open in fifty tabs, is told to slow down instead of being allowed to keep the host busy.
 */
internal class RateLimiter(
    private val maxEvents: Int,
    private val windowMs: Long,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val events = HashMap<String, ArrayDeque<Long>>()

    @Synchronized
    fun allow(key: String): Boolean {
        val now = clock()
        if (events.size > MAX_KEYS) events.entries.removeAll { (_, q) -> q.isEmpty() || now - q.last() > windowMs }
        val queue = events.getOrPut(key) { ArrayDeque() }
        while (queue.isNotEmpty() && now - queue.first() >= windowMs) queue.removeFirst()
        if (queue.size >= maxEvents) return false
        queue.addLast(now)
        return true
    }

    private companion object {
        const val MAX_KEYS = 512
    }
}

/** A JSON string field read defensively: absent, not a string or too long all give null. */
internal fun JsonObject.textOrNull(key: String, maxLength: Int = 200): String? {
    val primitive = this[key] as? JsonPrimitive ?: return null
    if (!primitive.isString) return null
    return primitive.content.takeIf { it.length <= maxLength }
}

/** A JSON whole number field read defensively; absent or not a number gives null. */
internal fun JsonObject.intOrNull(key: String): Int? {
    val primitive = this[key] as? JsonPrimitive ?: return null
    if (primitive.isString) return null
    return primitive.content.toIntOrNull()
}
