package com.beeboentertainment.movie.downloads

import java.io.IOException
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min

/*
 * Pure (no Android) rules for one download transfer: what a reply to a ranged request means for
 * the file on disk, when a failure is worth retrying and how long to wait, whether the finished
 * file is the file the server has, how fast it is going and when it will be done, and whether
 * there is room for it. Everything here is unit-tested on the JVM (DownloadTransferTest).
 */

/** A failure that no amount of retrying fixes (out of space, a refusal, a link that isn't a video). */
class DownloadFatalException(message: String) : RuntimeException(message)

/** The server answered with a status the transfer can't use; [code] decides whether it is retried. */
class DownloadHttpException(val code: Int, message: String) : IOException(message)

object ResumeRules {

    /** The parts of a reply the resume decision needs. */
    data class Reply(
        val code: Int,
        val contentLength: Long,
        val contentRange: String?,
        val etag: String?,
        val lastModified: String?
    )

    sealed class Outcome {
        /** Write the body at [startOffset] of the .part file. [total] is the whole file, or -1 if unknown. */
        data class Continue(val startOffset: Long, val total: Long) : Outcome()

        /** Throw the .part away; this reply is the file from byte 0. */
        data class FromScratch(val total: Long) : Outcome()

        /** 416 and the .part is already the whole file: nothing left to fetch. */
        data object AlreadyComplete : Outcome()

        /** The .part doesn't belong to what the server has now: delete it and ask again without a Range. */
        data object DiscardAndAskAgain : Outcome()
    }

    private val RANGE = Regex("""^\s*bytes\s+(\d+)-(\d+)/(\d+|\*)\s*$""", RegexOption.IGNORE_CASE)
    private val UNSATISFIED = Regex("""^\s*bytes\s+\*/(\d+)\s*$""", RegexOption.IGNORE_CASE)

    /** A strong ETag if the server sends one, else Last-Modified: the value sent back as If-Range. */
    fun validatorOf(etag: String?, lastModified: String?): String? {
        val tag = etag?.trim()?.takeIf { it.isNotEmpty() && !it.startsWith("W/") }
        return tag ?: lastModified?.trim()?.takeIf { it.isNotEmpty() }
    }

    fun validatorOf(reply: Reply): String? = validatorOf(reply.etag, reply.lastModified)

    /** The Range header for a .part of [already] bytes, or null to ask for the whole file. */
    fun rangeHeader(already: Long): String? = if (already > 0) "bytes=$already-" else null

    /**
     * Decide what to do with [reply] to a request made with `Range: bytes=[already]-`
     * (no Range at all when [already] is 0).
     *
     * @param storedValidator what the first reply of this download said (ETag or Last-Modified)
     * @param storedTotal the whole-file size that reply promised, or 0
     */
    fun interpret(already: Long, storedValidator: String?, storedTotal: Long, reply: Reply): Outcome {
        when (reply.code) {
            416 -> {
                val size = UNSATISFIED.find(reply.contentRange.orEmpty())?.groupValues?.get(1)?.toLongOrNull()
                return if (already > 0 && size != null && size == already) Outcome.AlreadyComplete
                else Outcome.DiscardAndAskAgain
            }
            206 -> {
                val m = RANGE.find(reply.contentRange.orEmpty()) ?: return Outcome.DiscardAndAskAgain
                val start = m.groupValues[1].toLongOrNull() ?: return Outcome.DiscardAndAskAgain
                val end = m.groupValues[2].toLongOrNull() ?: return Outcome.DiscardAndAskAgain
                val total = m.groupValues[3].toLongOrNull() ?: -1L
                if (start != already) return Outcome.DiscardAndAskAgain
                if (already > 0) {
                    if (storedTotal > 0 && total > 0 && total != storedTotal) return Outcome.DiscardAndAskAgain
                    val now = validatorOf(reply)
                    if (storedValidator != null && now != null && now != storedValidator) return Outcome.DiscardAndAskAgain
                }
                return Outcome.Continue(start, if (total > 0) total else end + 1)
            }
            else -> {
                val total = if (reply.contentLength > 0) reply.contentLength else -1L
                return Outcome.FromScratch(total)
            }
        }
    }
}

object RetryPolicy {

    /** Consecutive failed attempts, with no new bytes in between, before a download gives up. */
    const val MAX_ATTEMPTS = 6

    private val RETRYABLE_STATUS = setOf(408, 425, 429, 500, 502, 503, 504)

    fun statusIsRetryable(code: Int): Boolean = code in RETRYABLE_STATUS

    fun isRetryable(t: Throwable): Boolean = when (t) {
        is DownloadFatalException -> false
        is DownloadHttpException -> statusIsRetryable(t.code)
        is IOException -> !looksLikeOutOfSpace(t)
        else -> false
    }

    /**
     * Did the transfer end because it was cancelled (a stop, a pause, the call aborted)? A read
     * timeout is not: SocketTimeoutException is an InterruptedIOException, but it is a stalled
     * connection, and the partial file is worth keeping and retrying.
     */
    fun isCancellation(t: Throwable): Boolean = when {
        t is InterruptedException -> true
        t is java.net.SocketTimeoutException -> false
        t is java.io.InterruptedIOException -> true
        t is IOException -> t.message?.contains("anceled") == true
        else -> false
    }

    fun looksLikeOutOfSpace(t: Throwable): Boolean {
        val m = t.message.orEmpty()
        return m.contains("ENOSPC") || m.contains("No space left", ignoreCase = true)
    }

    /**
     * Failed attempts in a row, restarting from 1 whenever the .part grew since the last failure.
     * [lastPartBytes] is what the .part held at the previous failure (-1 if none yet).
     */
    fun attemptsAfterFailure(previousAttempts: Int, lastPartBytes: Long, partBytesNow: Long): Int =
        if (partBytesNow > lastPartBytes) 1 else previousAttempts + 1

    fun shouldRetry(attempts: Int): Boolean = attempts <= MAX_ATTEMPTS
}

object Backoff {

    const val BASE_MS = 2_000L
    const val MAX_MS = 60_000L

    /**
     * Wait before retry number [attempt] (1 = first): 2 s, 4 s, 8 s ... capped at a minute, each
     * spread by +/-25% so a whole season of downloads doesn't hit a recovering server in step.
     * [random] gives 0.0 up to (not including) 1.0.
     */
    fun delayMs(attempt: Int, random: () -> Double = { Math.random() }): Long {
        val doublings = min(max(attempt - 1, 0), 10)
        val base = min(MAX_MS, BASE_MS shl doublings)
        val spread = 0.75 + random().coerceIn(0.0, 1.0) * 0.5
        return (base * spread).toLong().coerceAtLeast(500L)
    }
}

object Integrity {

    sealed class Verdict {
        data object Ok : Verdict()
        /** The connection ended before the whole file arrived: keep the .part and go again. */
        data class Short(val missingBytes: Long) : Verdict()
        /** More bytes than the server promised: the .part can't be trusted. */
        data class Overrun(val extraBytes: Long) : Verdict()
        /** What is on disk isn't what was written: a write failed quietly. */
        data class DiskMismatch(val onDisk: Long, val written: Long) : Verdict()
    }

    /** [expectedTotal] <= 0 means the server never said how big the file is. */
    fun verify(written: Long, expectedTotal: Long, partLengthOnDisk: Long): Verdict = when {
        partLengthOnDisk != written -> Verdict.DiskMismatch(partLengthOnDisk, written)
        expectedTotal <= 0 -> Verdict.Ok
        written < expectedTotal -> Verdict.Short(expectedTotal - written)
        written > expectedTotal -> Verdict.Overrun(written - expectedTotal)
        else -> Verdict.Ok
    }

    /**
     * A film comes back as video/audio or a generic binary type. A login page (the media link
     * expired and the server redirected), an error page, JSON or a playlist means the body is not
     * the file, however politely it arrived with a 200.
     */
    fun looksLikeMedia(contentType: String?): Boolean {
        val t = contentType?.substringBefore(';')?.trim()?.lowercase().orEmpty()
        if (t.isEmpty()) return true
        if (t.startsWith("text/")) return false
        if (t.contains("json") || t.contains("xml") || t.contains("mpegurl")) return false
        return true
    }

    fun looksLikeLoginPage(contentType: String?): Boolean =
        contentType?.substringBefore(';')?.trim()?.lowercase() == "text/html"
}

object SpaceGuard {

    /** Keep this much free beyond the file itself, so the phone never fills to zero. */
    const val RESERVE_BYTES = 50L * 1024 * 1024

    /**
     * True when [neededBytes] (what is still to arrive) can't fit in [freeBytes]. A volume that
     * reports no free space at all (0) is treated as "can't tell" rather than "full".
     */
    fun tooFull(neededBytes: Long, freeBytes: Long, reserve: Long = RESERVE_BYTES): Boolean =
        neededBytes > 0 && freeBytes > 0 && neededBytes + reserve > freeBytes
}

/**
 * Speed and time left, smoothed. Raw bytes-per-second over a second or two jumps around (Wi-Fi,
 * the tunnel, a burst from a buffer), and an ETA built on it flickers; this weights recent
 * seconds over older ones so the number is steady but follows a real change within ~10 s.
 */
class SpeedMeter(private val timeConstantMs: Long = 8_000L) {

    private var lastAtMs = -1L
    private var lastBytes = 0L
    private var smoothed = 0.0

    /** Feed the total bytes on disk (including any resumed part) with the current time. */
    fun sample(nowMs: Long, totalBytes: Long) {
        if (lastAtMs < 0) {
            lastAtMs = nowMs
            lastBytes = totalBytes
            return
        }
        val dt = nowMs - lastAtMs
        if (dt < MIN_INTERVAL_MS) return
        val instant = (totalBytes - lastBytes).coerceAtLeast(0) * 1000.0 / dt
        smoothed = if (smoothed == 0.0) instant else {
            val alpha = 1.0 - exp(-dt.toDouble() / timeConstantMs)
            smoothed + alpha * (instant - smoothed)
        }
        lastAtMs = nowMs
        lastBytes = totalBytes
    }

    val bytesPerSecond: Long get() = smoothed.toLong()

    /** Whole seconds left for [remainingBytes], or null while the speed isn't known yet. */
    fun etaSeconds(remainingBytes: Long): Long? = etaSeconds(remainingBytes, bytesPerSecond)

    companion object {
        private const val MIN_INTERVAL_MS = 300L
        private const val MIN_SPEED = 1_024L

        /** Whole seconds left at a steady [bytesPerSecond], or null when there is no usable speed. */
        fun etaSeconds(remainingBytes: Long, bytesPerSecond: Long): Long? {
            if (remainingBytes <= 0) return 0
            if (bytesPerSecond < MIN_SPEED) return null
            return (remainingBytes + bytesPerSecond - 1) / bytesPerSecond
        }

        /** "under a minute", "7 min", "2 h 5 min". */
        fun formatEta(seconds: Long): String = when {
            seconds < 60 -> "under a minute"
            seconds < 3_600 -> "${(seconds + 30) / 60} min"
            else -> {
                val totalMin = (seconds + 30) / 60
                val h = totalMin / 60
                val m = totalMin % 60
                if (m == 0L) "$h h" else "$h h $m min"
            }
        }

        fun formatSpeed(bytesPerSecond: Long): String = when {
            bytesPerSecond >= 1_048_576 -> String.format(java.util.Locale.US, "%.1f MB/s", bytesPerSecond / 1_048_576.0)
            bytesPerSecond >= 1_024 -> "${bytesPerSecond / 1_024} KB/s"
            else -> "$bytesPerSecond B/s"
        }
    }
}
