package com.beeboentertainment.movie.audiobooks

import com.beeboentertainment.movie.audio.SpokenTimeline
import com.beeboentertainment.movie.server.SafeText
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The audiobook player's rules, free of Android so they can be unit tested. They mirror the
 * server's own player (electron/audiobookPlayer.js, audiobookProgress.js) so a phone, a browser
 * and the desktop app agree on speed steps, where a chapter starts, what the sleep timer does and
 * whose listening position wins.
 */
object AudiobookLogic {

    /* ------------------------------- speed ------------------------------- */

    const val MIN_SPEED = 0.5
    const val MAX_SPEED = 3.0
    val SPEED_PRESETS = listOf(0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0)

    /** 0.5x to 3x in steps of 0.05; junk and non-positive values fall back to 1x. */
    fun clampSpeed(v: Double?): Double {
        if (v == null || !v.isFinite() || v <= 0) return 1.0
        val stepped = (v * 20).roundToInt() / 20.0
        return min(MAX_SPEED, max(MIN_SPEED, stepped))
    }

    /** "1.25x", "1x", "2.5x". */
    fun speedLabel(speed: Double): String {
        val s = clampSpeed(speed)
        val text = if (s == floor(s)) s.toInt().toString() else "%.2f".format(java.util.Locale.US, s).trimEnd('0').trimEnd('.')
        return "${text}x"
    }

    /** One tap on the speed control: the next preset up (or the first), wrapping round. */
    fun nextPreset(current: Double): Double {
        val c = clampSpeed(current)
        return SPEED_PRESETS.firstOrNull { it > c + 0.001 } ?: SPEED_PRESETS.first()
    }

    /* ------------------------------ chapters ------------------------------ */

    data class Chapter(val title: String, val start: Double, val end: Double)

    fun chapters(dtos: List<ChapterDto>): List<Chapter> =
        dtos.filter { it.start.isFinite() && it.start >= 0 }
            .sortedBy { it.start }
            .mapIndexed { i, c -> Chapter(SafeText.clean(c.title, 120).ifBlank { "Chapter ${i + 1}" }, c.start, c.end) }

    /** Index of the chapter playing at [seconds], or -1 before the first (or with no chapters). */
    fun chapterIndexAt(chapters: List<Chapter>, seconds: Double): Int {
        if (chapters.isEmpty() || !seconds.isFinite()) return -1
        var lo = 0
        var hi = chapters.lastIndex
        var found = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (chapters[mid].start <= seconds + 0.001) { found = mid; lo = mid + 1 } else hi = mid - 1
        }
        return found
    }

    /** Previous chapter: the start of this one, or of the one before when within 3 s of this one's start. Null with no chapters. */
    fun previousChapterStart(chapters: List<Chapter>, seconds: Double): Double? {
        if (chapters.isEmpty()) return null
        val i = chapterIndexAt(chapters, seconds)
        if (i < 0) return 0.0
        return if (seconds - chapters[i].start > 3 || i == 0) chapters[i].start else chapters[i - 1].start
    }

    /** Next chapter start, or null at the last one. */
    fun nextChapterStart(chapters: List<Chapter>, seconds: Double): Double? =
        chapters.firstOrNull { it.start > seconds + 0.001 }?.start

    /* ---------------------------- sleep timer ---------------------------- */

    /** Off, N minutes on the wall clock (counts while paused, like a bedside clock), or until the chapter ends. */
    sealed class Sleep {
        data class Minutes(val endsAtMs: Long) : Sleep()
        data class ChapterEnd(val endPosSec: Double) : Sleep()
    }

    val SLEEP_MINUTES = listOf(5, 10, 15, 30, 45, 60)
    const val MAX_SLEEP_MINUTES = 720
    private const val FADE_SECONDS = 10.0

    fun sleepMinutes(minutes: Int, nowMs: Long): Sleep.Minutes? =
        if (minutes <= 0) null else Sleep.Minutes(nowMs + min(minutes, MAX_SLEEP_MINUTES) * 60_000L)

    /** Null when the book has no chapters or the position is not inside one. */
    fun sleepAtChapterEnd(chapters: List<Chapter>, positionSec: Double): Sleep.ChapterEnd? {
        val c = chapters.firstOrNull { it.start <= positionSec + 0.001 && positionSec < it.end - 0.001 } ?: return null
        return Sleep.ChapterEnd(c.end)
    }

    data class SleepStatus(val done: Boolean, val remainingSec: Double, val volume: Float)

    fun sleepStatus(timer: Sleep?, nowMs: Long, positionSec: Double): SleepStatus {
        if (timer == null) return SleepStatus(false, 0.0, 1f)
        val remaining = when (timer) {
            is Sleep.ChapterEnd -> timer.endPosSec - positionSec
            is Sleep.Minutes -> (timer.endsAtMs - nowMs) / 1000.0
        }
        if (!remaining.isFinite()) return SleepStatus(false, 0.0, 1f)
        if (remaining <= 0.25) return SleepStatus(true, 0.0, 0f)
        // Ten seconds of fade-out at the end of a minutes timer; a chapter timer stops at the boundary.
        val fade = if (timer is Sleep.Minutes && remaining < FADE_SECONDS) max(0.0, remaining / FADE_SECONDS) else 1.0
        return SleepStatus(false, remaining, fade.toFloat())
    }

    /** "Sleep 14:32" / "Sleep end of chapter". Null when off. */
    fun sleepLabel(timer: Sleep?, nowMs: Long, positionSec: Double): String? = when (timer) {
        null -> null
        is Sleep.ChapterEnd -> "Sleep · end of chapter"
        is Sleep.Minutes -> "Sleep · " + formatClock(sleepStatus(timer, nowMs, positionSec).remainingSec.let { ceilSeconds(it) })
    }

    private fun ceilSeconds(s: Double): Double = kotlin.math.ceil(s)

    /* ----------------------------- resume sync ----------------------------- */

    /** A position kept on this phone that has not reached the server yet (offline, or the app was killed). */
    data class LocalPosition(val bookId: String, val position: Double, val updatedAt: Long, val speed: Double? = null)

    enum class ResumeSource { SERVER, THIS_DEVICE, NONE }

    data class Resume(val positionSec: Double, val source: ResumeSource, val speed: Double?)

    /**
     * Where to start listening. The most recent listen wins, whichever device it was on: a phone
     * that was offline for a day must not drag the position back over what the car heard this
     * morning, and a position saved here that never reached the server must not be lost either.
     * Ties go to the server. A finished book restarts from the top.
     */
    fun resolveResume(server: BookProgress?, local: LocalPosition?, durationSec: Double): Resume {
        val serverAt = server?.updatedAt ?: 0L
        val localAt = local?.updatedAt ?: 0L
        val useLocal = local != null && localAt > serverAt
        val position = if (useLocal) local!!.position else server?.position ?: 0.0
        val speed = if (useLocal) local!!.speed else server?.speed
        val source = when {
            useLocal -> ResumeSource.THIS_DEVICE
            server != null && server.updatedAt > 0 -> ResumeSource.SERVER
            else -> ResumeSource.NONE
        }
        val finished = !useLocal && server?.finished == true
        val clamped = if (durationSec > 0) min(max(0.0, position), durationSec) else max(0.0, position)
        return Resume(if (finished) 0.0 else clamped, source, speed)
    }

    /** Should a position be sent now? Every [intervalMs] while playing, and always when it moved a lot (a seek). */
    fun shouldPush(lastPushedAtMs: Long, lastPushedPosSec: Double, nowMs: Long, positionSec: Double, intervalMs: Long = 15_000L): Boolean {
        if (lastPushedAtMs <= 0) return true
        if (nowMs - lastPushedAtMs >= intervalMs) return abs(positionSec - lastPushedPosSec) >= 1.0
        return abs(positionSec - lastPushedPosSec) > 45.0
    }

    /** The server's own "finished" rule: within the last 2% of the book, between 5 and 45 seconds. */
    fun isFinished(position: Double, duration: Double): Boolean {
        if (duration <= 0) return false
        return duration - position <= max(5.0, min(45.0, duration * 0.02))
    }

    /* ------------------------------ formatting ------------------------------ */

    /** 3725 -> "1:02:05", 65 -> "1:05". */
    fun formatClock(seconds: Double): String {
        var s = if (seconds.isFinite()) floor(seconds).toLong() else 0L
        if (s < 0) s = 0
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return (if (h > 0) "$h:${m.toString().padStart(2, '0')}" else m.toString()) + ":" + sec.toString().padStart(2, '0')
    }

    /** 3725 -> "1 h 2 min"; under a minute -> "under a minute". */
    fun formatLeft(seconds: Double): String {
        val s = if (seconds.isFinite()) seconds.roundToInt() else 0
        if (s <= 0) return "0 min"
        if (s < 60) return "under a minute"
        var h = s / 3600
        var m = ((s % 3600) / 60.0).roundToInt()
        if (m == 60) { h += 1; m = 0 }
        return (if (h > 0) "$h h" else "") + (if (h > 0 && m > 0) " " else "") + (if (m > 0 || h == 0) "$m min" else "")
    }

    /** "Book 3" / "Book 2.5" for a book's place in its series, or null. */
    fun seriesPlace(series: String?, index: Double?): String? {
        val name = SafeText.clean(series, 80)
        if (name.isBlank()) return null
        val n = index?.takeIf { it.isFinite() && it > 0 }
        return if (n == null) name else name + " · Book " + (if (n == floor(n)) n.toInt().toString() else n.toString())
    }

    /* ---------------------------- book -> playlist ---------------------------- */

    /** The parts of a book as the player sees them (only stream addresses that are ours). */
    fun parts(book: BookDetail): List<SpokenTimeline.Part> =
        book.parts.sortedBy { it.index }.mapIndexed { i, p -> SpokenTimeline.Part(i, p.start, p.duration) }

    /** A part's stream path if it is a real audiobook stream path on this server, else null. */
    fun streamPath(part: PartDto): String? =
        SafeText.serverPathOrNull(part.stream, "/api/audiobooks/book/")

    /** Status words for a book row. */
    fun statusLine(b: BookBrief): String {
        val p = b.progress
        return when {
            p == null || b.status == "unstarted" -> formatLeft(b.duration)
            b.status == "finished" || p.finished -> "Finished"
            else -> formatLeft(p.remaining) + " left"
        }
    }
}
