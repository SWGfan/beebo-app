package com.beeboentertainment.movie.player

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.util.Locale

/** One chapter of the file on screen. [number] is the 1-based place in the sorted list, whatever index the server used. */
data class Chapter(val number: Int, val startSec: Double, val endSec: Double, val title: String) {
    val startMs: Long get() = (startSec * 1000).toLong()

    /** What to show for it: the file's own title, or "Chapter N" when it has none. */
    val label: String get() = title.ifBlank { "Chapter $number" }
}

/**
 * The chapters `/playback/info` returned, made safe to show. The list is optional on the wire
 * (older servers and files with no chapters omit it) and every entry is untrusted text.
 */
object ChapterParser {
    const val MAX_CHAPTERS = 500
    const val MAX_TITLE_CHARS = 80

    /** Two chapters or more; a lone chapter has nothing to jump to. */
    const val MIN_USEFUL = 2

    fun parse(element: JsonElement?): List<Chapter> {
        val array = element as? JsonArray ?: return emptyList()
        val raw = ArrayList<Chapter>()
        for (entry in array) {
            if (raw.size >= MAX_CHAPTERS) break
            val obj = entry as? JsonObject ?: continue
            val start = number(obj["startSec"]) ?: continue
            if (start < 0.0 || start.isNaN() || start.isInfinite()) continue
            val end = number(obj["endSec"])?.takeIf { it >= start && !it.isInfinite() } ?: start
            raw += Chapter(0, start, end, sanitizeTitle(text(obj["title"])))
        }
        val sorted = raw.sortedBy { it.startSec }
        val out = ArrayList<Chapter>(sorted.size)
        for (c in sorted) {
            // Two chapters starting at the same instant would be one unreachable row.
            if (out.isNotEmpty() && c.startSec <= out.last().startSec) continue
            out += c.copy(number = out.size + 1)
        }
        return out
    }

    /** Single line, no control or direction-changing characters, at most [MAX_TITLE_CHARS] long. */
    fun sanitizeTitle(raw: String?): String {
        if (raw == null) return ""
        val cleaned = StringBuilder(raw.length)
        for (ch in raw) {
            cleaned.append(if (ch.isISOControl() || ch in BIDI || ch.isWhitespace()) ' ' else ch)
        }
        val collapsed = cleaned.toString().trim().replace(Regex(" {2,}"), " ")
        if (collapsed.length <= MAX_TITLE_CHARS) return collapsed
        return collapsed.take(MAX_TITLE_CHARS - 1).trimEnd() + "…"
    }

    private val BIDI = "‎‏‪‫‬‭‮⁦⁧⁨⁩".toSet()

    private fun text(e: JsonElement?): String? =
        (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun number(e: JsonElement?): Double? {
        return (e as? JsonPrimitive)?.doubleOrNull
    }
}

/** Next / previous chapter and "which chapter is this", from a position in milliseconds. */
class ChapterNavigator(val chapters: List<Chapter>) {

    val hasChapters: Boolean get() = chapters.size >= ChapterParser.MIN_USEFUL

    /** The chapter the position is inside, or -1 before the first one. */
    fun indexAt(positionMs: Long): Int {
        var found = -1
        for (i in chapters.indices) {
            if (chapters[i].startMs <= positionMs) found = i else break
        }
        return found
    }

    fun chapterAt(positionMs: Long): Chapter? = chapters.getOrNull(indexAt(positionMs))

    /** Where the next chapter starts, or null at the last one (the caller then falls back to its own "next"). */
    fun nextStartMs(positionMs: Long): Long? {
        if (!hasChapters) return null
        return chapters.getOrNull(indexAt(positionMs) + 1)?.startMs
    }

    /**
     * Standard "previous": more than [restartAfterMs] into the chapter goes back to its start,
     * otherwise to the one before it. Null in the first chapter's opening seconds.
     */
    fun previousStartMs(positionMs: Long, restartAfterMs: Long = RESTART_AFTER_MS): Long? {
        if (!hasChapters) return null
        val i = indexAt(positionMs)
        if (i < 0) return null
        val here = chapters[i].startMs
        if (positionMs - here > restartAfterMs) return here
        return chapters.getOrNull(i - 1)?.startMs
    }

    companion object {
        const val RESTART_AFTER_MS = 3_000L

        /** "5:07" or "1:02:03". */
        fun formatTime(totalSec: Double): String {
            val s = if (totalSec.isNaN() || totalSec < 0) 0L else totalSec.toLong()
            val h = s / 3600
            val m = (s % 3600) / 60
            val sec = s % 60
            return if (h > 0) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, sec) else String.format(Locale.ROOT, "%d:%02d", m, sec)
        }

        /** "3. The heist  41:20" - the list row text. */
        fun rowText(c: Chapter): String = "${c.number}. ${c.label}  ${formatTime(c.startSec)}"
    }
}
