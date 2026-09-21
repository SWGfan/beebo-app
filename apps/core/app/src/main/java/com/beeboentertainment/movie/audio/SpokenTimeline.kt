package com.beeboentertainment.movie.audio

/**
 * The arithmetic of one long recording that may be split over several files (an audiobook of
 * mp3 parts), the same rules the server's own player uses (audiobookPlayer.js). Everything the
 * server says about positions is whole-book seconds; Media3 plays one file at a time with its own
 * position, so these functions translate between the two. Pure, unit tested.
 */
object SpokenTimeline {

    /** One file: where it starts on the whole-book timeline and how long it is (0 when unknown). */
    data class Part(val index: Int, val start: Double, val duration: Double)

    /** Which part, and how many seconds into it. */
    data class Located(val index: Int, val offset: Double)

    /** Whole-book position -> the part to play and where in it. Past the end parks at the end of the last part. */
    fun locate(parts: List<Part>, seconds: Double): Located {
        if (parts.isEmpty()) return Located(0, 0.0)
        val pos = if (seconds.isFinite() && seconds > 0) seconds else 0.0
        for (i in parts.indices.reversed()) {
            if (pos >= parts[i].start) {
                var offset = pos - parts[i].start
                if (i == parts.lastIndex && parts[i].duration > 0 && offset > parts[i].duration) offset = parts[i].duration
                return Located(i, offset)
            }
        }
        return Located(0, 0.0)
    }

    /** Part + seconds into it -> whole-book seconds. */
    fun bookPosition(parts: List<Part>, index: Int, offset: Double): Double {
        val p = parts.getOrNull(index) ?: return 0.0
        return p.start + (if (offset.isFinite() && offset > 0) offset else 0.0)
    }

    /** A skip's landing place, kept inside the book. [duration] <= 0 means unknown. */
    fun skipTarget(position: Double, delta: Double, duration: Double): Double {
        var p = position + delta
        if (!p.isFinite() || p < 0) p = 0.0
        if (duration.isFinite() && duration > 0 && p > duration) p = duration
        return p
    }

    /** Skip [deltaSec] from where playback is now (part [index], [offsetSec] into it), across part boundaries. */
    fun skipFrom(parts: List<Part>, index: Int, offsetSec: Double, deltaSec: Double, totalSec: Double): Located {
        if (parts.isEmpty()) return Located(0, (offsetSec + deltaSec).coerceAtLeast(0.0))
        val total = if (totalSec > 0) totalSec else parts.last().let { if (it.duration > 0) it.start + it.duration else 0.0 }
        return locate(parts, skipTarget(bookPosition(parts, index, offsetSec), deltaSec, total))
    }
}
