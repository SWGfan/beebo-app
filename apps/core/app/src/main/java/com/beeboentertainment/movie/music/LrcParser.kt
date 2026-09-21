package com.beeboentertainment.movie.music

/**
 * Song lyrics in LRC form ("[01:23.45]A line"), the format of a .lrc file next to a song and of
 * synced lyrics embedded in its tags. Plain text (no timestamps) is kept as unsynced lyrics.
 * Pure Kotlin: unit tested in LrcParserTest.
 */
object LrcParser {

    data class Line(val timeMs: Long, val text: String)

    data class Lyrics(
        val synced: Boolean,
        val lines: List<Line>,
        /** The words alone, one line each: what an unsynced view shows. */
        val text: String,
        val offsetMs: Long = 0L
    )

    // [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx], [mm:ss:xx], [h:mm:ss.xx]
    private val TIME_TAG = Regex("""^\[(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:[.:](\d{1,3}))?]""")
    private val META_TAG = Regex("""^\[([A-Za-z#]+):(.*)]\s*$""")
    private val WORD_STAMP = Regex("""<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>""")
    private val SPACES = Regex("""\s+""")

    fun parse(raw: String?): Lyrics {
        val source = (raw ?: "").removePrefix("﻿")
        val timed = mutableListOf<Line>()
        val plain = mutableListOf<String>()
        var offset = 0L
        for (rawLine in source.split("\r\n", "\n", "\r")) {
            var line = rawLine.trim()
            if (line.isEmpty()) { plain += ""; continue }
            val stamps = mutableListOf<Long>()
            while (true) {
                val m = TIME_TAG.find(line) ?: break
                stamps += toMs(m)
                line = line.substring(m.range.last + 1)
            }
            if (stamps.isNotEmpty()) {
                val words = line.replace(WORD_STAMP, "").replace(SPACES, " ").trim()
                stamps.forEach { timed += Line(it, words) }
                continue
            }
            val meta = META_TAG.matchEntire(line)
            if (meta != null) {
                if (meta.groupValues[1].equals("offset", ignoreCase = true)) {
                    meta.groupValues[2].trim().removePrefix("+").toLongOrNull()?.let { offset = it }
                }
                continue
            }
            plain += line
        }
        if (timed.isEmpty()) {
            return Lyrics(synced = false, lines = emptyList(), text = plain.joinToString("\n").trim('\n'))
        }
        // A positive offset shows the words earlier (the LRC convention).
        val lines = timed
            .map { it.copy(timeMs = (it.timeMs - offset).coerceAtLeast(0L)) }
            .sortedBy { it.timeMs } // stable: lines at the same time keep their file order
        return Lyrics(synced = true, lines = lines, text = lines.joinToString("\n") { it.text }, offsetMs = offset)
    }

    private fun toMs(m: MatchResult): Long {
        val g = m.groupValues
        var h = 0L
        var min = g[1].toLong()
        var sec = g[2].toLong()
        // Three numbers and a fraction is h:mm:ss.xx; three numbers alone is the mm:ss:xx form
        // some writers use, where the last pair is hundredths.
        var frac = g[4]
        if (g[3].isNotEmpty()) {
            if (frac.isNotEmpty()) { h = min; min = sec; sec = g[3].toLong() } else frac = g[3]
        }
        val ms = when (frac.length) {
            0 -> 0L
            1 -> frac.toLong() * 100
            2 -> frac.toLong() * 10
            3 -> frac.toLong()
            else -> frac.substring(0, 3).toLong()
        }
        return ((h * 60 + min) * 60 + sec) * 1000 + ms
    }

    /** The line being sung at [positionMs], or -1 before the first. Binary search. */
    fun activeIndex(lines: List<Line>, positionMs: Long): Int {
        var lo = 0
        var hi = lines.size - 1
        var ans = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (lines[mid].timeMs <= positionMs) { ans = mid; lo = mid + 1 } else hi = mid - 1
        }
        return ans
    }
}
