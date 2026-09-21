package com.beeboentertainment.movie.podcasts

import com.beeboentertainment.movie.audiobooks.AudiobookLogic
import com.beeboentertainment.movie.server.SafeText
import java.util.Calendar
import java.util.TimeZone

/**
 * Podcast rules without Android, so they can be unit tested: what an episode row says, where
 * playback resumes, which speed a show plays at, what plays next, when progress is sent, and the
 * wording for a copy kept on the computer.
 */
object PodcastLogic {

    private val KEY = Regex("^[a-f0-9]{12}\\.[a-f0-9]{16}$")
    private val SHOW = Regex("^[a-f0-9]{12}$")

    fun isEpisodeKey(s: String?): Boolean = s != null && KEY.matches(s)
    fun isShowId(s: String?): Boolean = s != null && SHOW.matches(s)

    /** A feed address the person typed: https or http with a host, no spaces. The server judges the rest. */
    fun feedAddressOrNull(input: String?): String? {
        val s = input?.trim().orEmpty()
        if (s.length !in 8..1000 || s.any { it.isWhitespace() || it.code < 32 }) return null
        val lower = s.lowercase()
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return null
        val authority = s.substringAfter("://").substringBefore('/').substringBefore('?').substringBefore('#')
        if (authority.isEmpty() || authority.contains('@')) return null
        return s
    }

    /** Where to start an episode: the saved place, unless it was played to the end (then the start). Not the last few seconds either. */
    fun resumeSec(e: EpisodeDto): Double {
        if (e.played) return 0.0
        val p = e.progressSec
        if (!p.isFinite() || p < 5) return 0.0
        return if (e.durationSec > 0 && e.durationSec - p < 10) 0.0 else p
    }

    /** Speed for a show: its own if the person set one, else their podcast-wide speed. */
    fun speedFor(prefs: PodcastPrefs, feedId: String): Double =
        AudiobookLogic.clampSpeed(prefs.speedByFeed[feedId] ?: prefs.speed)

    /** "Mar 4 · 42 min" style line: date (UTC, no locale surprises), length, and progress. */
    fun subtitle(e: EpisodeDto): String {
        val parts = mutableListOf<String>()
        date(e.publishedAt)?.let { parts += it }
        if (e.durationSec > 0) parts += lengthLabel(e.durationSec)
        if (e.played) parts += "Played"
        else if (e.progressSec > 5 && e.durationSec > 0) parts += AudiobookLogic.formatLeft((e.durationSec - e.progressSec).coerceAtLeast(0.0)) + " left"
        return parts.joinToString(" · ")
    }

    fun lengthLabel(sec: Double): String {
        val m = (sec / 60).toInt()
        return if (m >= 60) "${m / 60} h ${m % 60} min" else if (m >= 1) "$m min" else "under a minute"
    }

    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    private fun date(epochMs: Long): String? {
        if (epochMs <= 0) return null
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = epochMs }
        return "${MONTHS[c.get(Calendar.MONTH)]} ${c.get(Calendar.DAY_OF_MONTH)}, ${c.get(Calendar.YEAR)}"
    }

    /** Episode title with its season/episode number when the feed gave them. */
    fun title(e: EpisodeDto): String {
        val t = SafeText.clean(e.title, 200).ifBlank { "Untitled episode" }
        val n = listOfNotNull(e.season?.let { "S$it" }, e.episode?.let { "E$it" }).joinToString("")
        return if (n.isBlank()) t else "$n · $t"
    }

    /** What the download button and badge say. */
    fun downloadLabel(e: EpisodeDto, info: DownloadInfo?): String {
        val status = info?.status
        val size = info?.size ?: 0L
        return when {
            status == "downloading" || status == "queued" -> "Copying to your computer…"
            status == "failed" -> "The copy failed" + (info?.error?.takeIf { it.isNotBlank() }?.let { ": " + SafeText.clean(it, 80) } ?: "")
            e.downloaded || info?.downloaded == true -> "Kept on your computer" + (if (size > 0) " (" + megabytes(size) + ")" else "")
            else -> "Streams from the show"
        }
    }

    fun megabytes(bytes: Long): String = if (bytes >= 1_048_576) "%.0f MB".format(java.util.Locale.US, bytes / 1_048_576.0) else "under 1 MB"

    fun canDownload(e: EpisodeDto, info: DownloadInfo?): Boolean =
        !e.downloaded && info?.downloaded != true && info?.status != "downloading" && info?.status != "queued"

    /**
     * The episodes that play after [current] when a queue is used: the queue in its own order,
     * starting after [current] if it is in it (otherwise all of it), without repeats and without
     * episodes already played through.
     */
    fun upNext(current: String, queue: List<EpisodeDto>): List<EpisodeDto> {
        val i = queue.indexOfFirst { it.key == current }
        val after = if (i >= 0) queue.drop(i + 1) else queue
        return after.filter { it.key != current && !it.played && it.stream.isNotBlank() }.distinctBy { it.key }
    }

    /** A stream address is only ours if it is a podcasts path on this server. */
    fun streamPath(e: EpisodeDto): String? =
        SafeText.serverPathOrNull(e.stream, "/api/podcasts/episode/")

    /** Notes as plain text (the server already sanitised the HTML; the app never renders it). */
    fun notes(e: EpisodeDto): String =
        SafeText.htmlToText(e.notesHtml.ifBlank { e.summary }, 3000)

    /** Chapters worth listing: visible ones, in order, with a name. */
    fun chapters(list: List<ChapterItem>): List<AudiobookLogic.Chapter> =
        list.filter { !it.hidden && it.start.isFinite() && it.start >= 0 }.sortedBy { it.start }
            .mapIndexed { i, c -> AudiobookLogic.Chapter(SafeText.clean(c.title, 120).ifBlank { "Chapter ${i + 1}" }, c.start, c.end ?: Double.MAX_VALUE) }

    /** Should the position be sent to the server now? Same cadence as books. */
    fun shouldPush(lastAtMs: Long, lastPosSec: Double, nowMs: Long, posSec: Double): Boolean =
        AudiobookLogic.shouldPush(lastAtMs, lastPosSec, nowMs, posSec)

    /** Sleep at the end of the episode: a "chapter" ending at the episode's length. Null when the length is unknown. */
    fun sleepAtEpisodeEnd(durationSec: Double): AudiobookLogic.Sleep.ChapterEnd? =
        if (durationSec > 0 && durationSec.isFinite()) AudiobookLogic.Sleep.ChapterEnd(durationSec) else null

    val SLEEP_MINUTES = listOf(5, 10, 15, 30, 45, 60)

    /** Show line under a followed show: "3 new" or "Up to date". */
    fun unplayedLabel(s: ShowDto): String = when {
        s.error.isNotBlank() -> "Couldn't be refreshed"
        s.pending -> "Loading episodes…"
        s.unplayed > 0 -> "${s.unplayed} new"
        else -> "Up to date"
    }
}
