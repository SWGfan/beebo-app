package com.beeboentertainment.movie

import com.beeboentertainment.movie.downloads.Backoff
import com.beeboentertainment.movie.downloads.DownloadFatalException
import com.beeboentertainment.movie.downloads.DownloadHttpException
import com.beeboentertainment.movie.downloads.DownloadIndex
import com.beeboentertainment.movie.downloads.DownloadRecord
import com.beeboentertainment.movie.downloads.DownloadStatus
import com.beeboentertainment.movie.downloads.Integrity
import com.beeboentertainment.movie.downloads.ResumeRules
import com.beeboentertainment.movie.downloads.ResumeRules.Outcome
import com.beeboentertainment.movie.downloads.ResumeRules.Reply
import com.beeboentertainment.movie.downloads.RetryPolicy
import com.beeboentertainment.movie.downloads.SpaceGuard
import com.beeboentertainment.movie.downloads.SpeedMeter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/** The rules one transfer follows: resume, retry, integrity, speed and space. Pure JVM. */
class DownloadTransferTest {

    private fun reply(
        code: Int,
        length: Long = -1,
        range: String? = null,
        etag: String? = null,
        modified: String? = null
    ) = Reply(code, length, range, etag, modified)

    /* ------------------------------------------------------------------ resume */

    @Test
    fun `a fresh download asks for the whole file and takes the 200 from byte zero`() {
        assertNull(ResumeRules.rangeHeader(0))
        assertEquals(Outcome.FromScratch(5_000), ResumeRules.interpret(0, null, 0, reply(200, 5_000)))
    }

    @Test
    fun `a partial file asks for the rest from the next byte`() {
        assertEquals("bytes=1048576-", ResumeRules.rangeHeader(1_048_576))
        assertEquals("bytes=5000000000-", ResumeRules.rangeHeader(5_000_000_000L))
    }

    @Test
    fun `a 206 that starts exactly where the part ends carries on`() {
        val r = reply(206, 4_000, "bytes 1000-4999/5000", etag = "\"e1\"")
        assertEquals(Outcome.Continue(1_000, 5_000), ResumeRules.interpret(1_000, "\"e1\"", 5_000, r))
    }

    @Test
    fun `resuming past 4 GiB keeps exact offsets`() {
        val start = 5L * 1024 * 1024 * 1024 + 7
        val total = start + 1_000_000
        val r = reply(206, 1_000_000, "bytes $start-${total - 1}/$total")
        assertEquals(Outcome.Continue(start, total), ResumeRules.interpret(start, null, total, r))
    }

    @Test
    fun `a 200 to a ranged request means the server ignored it, so start over`() {
        assertEquals(Outcome.FromScratch(5_000), ResumeRules.interpret(1_000, "\"e1\"", 5_000, reply(200, 5_000, etag = "\"e2\"")))
    }

    @Test
    fun `a 206 starting at the wrong byte is thrown away`() {
        val r = reply(206, 4_500, "bytes 500-4999/5000")
        assertEquals(Outcome.DiscardAndAskAgain, ResumeRules.interpret(1_000, null, 5_000, r))
    }

    @Test
    fun `a file that changed size or validator on the server is not spliced`() {
        val bigger = reply(206, 4_000, "bytes 1000-5999/6000")
        assertEquals(Outcome.DiscardAndAskAgain, ResumeRules.interpret(1_000, null, 5_000, bigger))
        val replaced = reply(206, 4_000, "bytes 1000-4999/5000", etag = "\"new\"")
        assertEquals(Outcome.DiscardAndAskAgain, ResumeRules.interpret(1_000, "\"old\"", 5_000, replaced))
        val sameLastModified = reply(206, 4_000, "bytes 1000-4999/5000", modified = "Mon, 01 Jan 2024 00:00:00 GMT")
        assertEquals(
            Outcome.Continue(1_000, 5_000),
            ResumeRules.interpret(1_000, "Mon, 01 Jan 2024 00:00:00 GMT", 5_000, sameLastModified)
        )
    }

    @Test
    fun `a 206 with no Content-Range can't be placed, so it is discarded`() {
        assertEquals(Outcome.DiscardAndAskAgain, ResumeRules.interpret(1_000, null, 0, reply(206, 4_000)))
        assertEquals(Outcome.DiscardAndAskAgain, ResumeRules.interpret(1_000, null, 0, reply(206, 4_000, "garbage")))
    }

    @Test
    fun `a 206 with an unknown total still continues`() {
        assertEquals(Outcome.Continue(1_000, 5_000), ResumeRules.interpret(1_000, null, 0, reply(206, 4_000, "bytes 1000-4999/*")))
    }

    @Test
    fun `416 with the part already the whole file is a finished download, not a failure`() {
        assertEquals(Outcome.AlreadyComplete, ResumeRules.interpret(5_000, null, 5_000, reply(416, 0, "bytes */5000")))
    }

    @Test
    fun `416 with a part that doesn't fit the file is thrown away and asked for again`() {
        assertEquals(Outcome.DiscardAndAskAgain, ResumeRules.interpret(9_000, null, 5_000, reply(416, 0, "bytes */5000")))
        assertEquals(Outcome.DiscardAndAskAgain, ResumeRules.interpret(9_000, null, 5_000, reply(416)))
        assertEquals(Outcome.DiscardAndAskAgain, ResumeRules.interpret(0, null, 0, reply(416, 0, "bytes */0")))
    }

    @Test
    fun `the validator is a strong ETag, else Last-Modified, else nothing`() {
        assertEquals("\"abc\"", ResumeRules.validatorOf("\"abc\"", "Mon, 01 Jan 2024 00:00:00 GMT"))
        assertEquals("Mon, 01 Jan 2024 00:00:00 GMT", ResumeRules.validatorOf("W/\"weak\"", "Mon, 01 Jan 2024 00:00:00 GMT"))
        assertEquals("Mon, 01 Jan 2024 00:00:00 GMT", ResumeRules.validatorOf(null, "Mon, 01 Jan 2024 00:00:00 GMT"))
        assertNull(ResumeRules.validatorOf(null, null))
        assertNull(ResumeRules.validatorOf("", " "))
    }

    /* ------------------------------------------------------------------ retry and backoff */

    @Test
    fun `network trouble and busy servers are retried, refusals and lack of space are not`() {
        assertTrue(RetryPolicy.isRetryable(IOException("Connection reset")))
        assertTrue(RetryPolicy.isRetryable(SocketTimeoutException("timeout")))
        assertTrue(RetryPolicy.isRetryable(UnknownHostException("no route")))
        for (code in listOf(408, 429, 500, 502, 503, 504)) assertTrue("$code", RetryPolicy.isRetryable(DownloadHttpException(code, "x")))
        for (code in listOf(400, 401, 403, 404, 410)) assertFalse("$code", RetryPolicy.isRetryable(DownloadHttpException(code, "x")))
        assertFalse(RetryPolicy.isRetryable(DownloadFatalException("Not enough space")))
        assertFalse(RetryPolicy.isRetryable(IOException("write failed: ENOSPC (No space left on device)")))
        assertFalse(RetryPolicy.isRetryable(IllegalStateException("bug")))
    }

    @Test
    fun `a read timeout is a stalled connection to retry, not a user stop`() {
        assertFalse(RetryPolicy.isCancellation(SocketTimeoutException("timeout")))
        assertTrue(RetryPolicy.isCancellation(IOException("Canceled")))
        assertTrue(RetryPolicy.isCancellation(InterruptedException("Stopped")))
        assertTrue(RetryPolicy.isCancellation(java.io.InterruptedIOException("interrupted")))
        assertFalse(RetryPolicy.isCancellation(IOException("Connection reset")))
    }

    @Test
    fun `attempts count up only while no new bytes arrive`() {
        var attempts = RetryPolicy.attemptsAfterFailure(0, -1, 0)
        assertEquals(1, attempts)
        attempts = RetryPolicy.attemptsAfterFailure(attempts, 0, 0)
        assertEquals(2, attempts)
        attempts = RetryPolicy.attemptsAfterFailure(attempts, 0, 0)
        assertEquals(3, attempts)
        attempts = RetryPolicy.attemptsAfterFailure(attempts, 0, 4_000_000)
        assertEquals("progress resets the count", 1, attempts)
    }

    @Test
    fun `it gives up after the sixth failure in a row`() {
        for (n in 1..RetryPolicy.MAX_ATTEMPTS) assertTrue("attempt $n", RetryPolicy.shouldRetry(n))
        assertFalse(RetryPolicy.shouldRetry(RetryPolicy.MAX_ATTEMPTS + 1))
    }

    @Test
    fun `backoff doubles from two seconds, is capped at a minute, and is spread by a quarter either way`() {
        val mid = { 0.5 }
        assertEquals(2_000, Backoff.delayMs(1, mid))
        assertEquals(4_000, Backoff.delayMs(2, mid))
        assertEquals(8_000, Backoff.delayMs(3, mid))
        assertEquals(16_000, Backoff.delayMs(4, mid))
        assertEquals(32_000, Backoff.delayMs(5, mid))
        assertEquals(60_000, Backoff.delayMs(6, mid))
        assertEquals(60_000, Backoff.delayMs(40, mid))
        assertEquals(1_500, Backoff.delayMs(1) { 0.0 })
        assertEquals(2_500.0, Backoff.delayMs(1) { 0.999999 }.toDouble(), 1.0)
        assertEquals("a first attempt of 0 behaves like 1", 2_000, Backoff.delayMs(0, mid))
        for (a in 1..12) {
            val d = Backoff.delayMs(a)
            assertTrue("attempt $a gave $d", d in 500..75_000)
        }
    }

    /* ------------------------------------------------------------------ integrity */

    @Test
    fun `a file is finished only when every promised byte is on disk`() {
        assertEquals(Integrity.Verdict.Ok, Integrity.verify(5_000, 5_000, 5_000))
        assertEquals(Integrity.Verdict.Ok, Integrity.verify(5_000, -1, 5_000))
        assertEquals(Integrity.Verdict.Short(1_000), Integrity.verify(4_000, 5_000, 4_000))
        assertEquals(Integrity.Verdict.Overrun(7), Integrity.verify(5_007, 5_000, 5_007))
        assertEquals(Integrity.Verdict.DiskMismatch(3_000, 5_000), Integrity.verify(5_000, 5_000, 3_000))
    }

    @Test
    fun `a login page, an error page or a playlist is not a film`() {
        assertTrue(Integrity.looksLikeMedia("video/mp4"))
        assertTrue(Integrity.looksLikeMedia("video/x-matroska"))
        assertTrue(Integrity.looksLikeMedia("application/octet-stream"))
        assertTrue(Integrity.looksLikeMedia("audio/mpeg"))
        assertTrue(Integrity.looksLikeMedia(null))
        assertTrue(Integrity.looksLikeMedia(""))
        assertFalse(Integrity.looksLikeMedia("text/html; charset=utf-8"))
        assertFalse(Integrity.looksLikeMedia("application/json"))
        assertFalse(Integrity.looksLikeMedia("application/vnd.apple.mpegurl"))
        assertFalse(Integrity.looksLikeMedia("text/plain"))
        assertTrue(Integrity.looksLikeLoginPage("Text/HTML; charset=utf-8"))
        assertFalse(Integrity.looksLikeLoginPage("video/mp4"))
    }

    /* ------------------------------------------------------------------ space */

    @Test
    fun `it refuses a file that would leave the phone with less than the reserve`() {
        val gb = 1024L * 1024 * 1024
        assertFalse(SpaceGuard.tooFull(2 * gb, 10 * gb))
        assertTrue(SpaceGuard.tooFull(10 * gb, 10 * gb))
        assertTrue(SpaceGuard.tooFull(10 * gb - 10, 10 * gb))
        assertFalse(SpaceGuard.tooFull(10 * gb - SpaceGuard.RESERVE_BYTES, 10 * gb))
        assertFalse("an unreadable volume is not a full one", SpaceGuard.tooFull(10 * gb, 0))
        assertFalse("an unknown size can't be checked up front", SpaceGuard.tooFull(-1, 10 * gb))
        assertFalse(SpaceGuard.tooFull(0, 10 * gb))
    }

    /* ------------------------------------------------------------------ speed and time left */

    @Test
    fun `speed is unknown until two samples, then steady`() {
        val m = SpeedMeter()
        m.sample(0, 0)
        assertEquals(0, m.bytesPerSecond)
        assertNull(m.etaSeconds(1_000_000))
        m.sample(1_000, 2_000_000)
        assertEquals(2_000_000, m.bytesPerSecond)
        assertEquals(50L, m.etaSeconds(100_000_000))
    }

    @Test
    fun `a burst nudges the estimate instead of swinging it`() {
        val m = SpeedMeter()
        m.sample(0, 0)
        var bytes = 0L
        for (s in 1..10) { bytes += 1_000_000; m.sample(s * 1_000L, bytes) }
        assertEquals(1_000_000.0, m.bytesPerSecond.toDouble(), 5_000.0)
        bytes += 10_000_000
        m.sample(11_000, bytes)
        assertTrue("one 10x second moved it to ${m.bytesPerSecond}", m.bytesPerSecond in 1_000_000..3_500_000)
    }

    @Test
    fun `it follows a real change within about ten seconds`() {
        val m = SpeedMeter()
        m.sample(0, 0)
        var bytes = 0L
        for (s in 1..10) { bytes += 4_000_000; m.sample(s * 1_000L, bytes) }
        for (s in 11..25) { bytes += 500_000; m.sample(s * 1_000L, bytes) }
        assertTrue("still ${m.bytesPerSecond}", m.bytesPerSecond < 1_200_000)
    }

    @Test
    fun `samples closer than a third of a second are ignored and a stall reads as no progress`() {
        val m = SpeedMeter()
        m.sample(0, 0)
        m.sample(100, 50_000_000)
        assertEquals(0, m.bytesPerSecond)
        m.sample(1_000, 1_000_000)
        assertEquals(1_000_000, m.bytesPerSecond)
        m.sample(4_000, 1_000_000)
        assertTrue(m.bytesPerSecond < 1_000_000)
        assertEquals(0L, SpeedMeter.etaSeconds(0, 0))
        assertNull(SpeedMeter.etaSeconds(1_000, 10))
    }

    @Test
    fun `time left and speed read like a person would say them`() {
        assertEquals("under a minute", SpeedMeter.formatEta(20))
        assertEquals("under a minute", SpeedMeter.formatEta(59))
        assertEquals("1 min", SpeedMeter.formatEta(60))
        assertEquals("7 min", SpeedMeter.formatEta(7 * 60))
        assertEquals("2 h", SpeedMeter.formatEta(2 * 3_600))
        assertEquals("2 h 5 min", SpeedMeter.formatEta(2 * 3_600 + 5 * 60))
        assertEquals("12.5 MB/s", SpeedMeter.formatSpeed((12.5 * 1_048_576).toLong()))
        assertEquals("340 KB/s", SpeedMeter.formatSpeed(340 * 1_024L))
        assertEquals("12 B/s", SpeedMeter.formatSpeed(12))
    }

    /* ------------------------------------------------------------------ the row */

    @Test
    fun `a paused row is a failed row with the pause note, and it keeps its bytes and validator`() {
        val r = DownloadRecord(
            id = "a", kind = "movie", title = "T", streamUrl = "http://h/file?id=a", fileName = "a.dat",
            status = DownloadStatus.FAILED.name, error = DownloadIndex.PAUSED_NOTE,
            bytesDownloaded = 123, totalBytes = 456, validator = "\"e\"", speedBps = 999
        )
        val back = DownloadIndex.decode(DownloadIndex.encode(listOf(r))).single()
        assertEquals(DownloadIndex.PAUSED_NOTE, back.error)
        assertEquals("\"e\"", back.validator)
        assertEquals(123, back.bytesDownloaded)
    }

    @Test
    fun `an index saved before the validator existed still loads`() {
        val old = """[{"id":"a","kind":"movie","title":"T","streamUrl":"u","fileName":"a.dat","status":"QUEUED","bytesDownloaded":5,"totalBytes":10}]"""
        val r = DownloadIndex.decode(old).single()
        assertNull(r.validator)
        assertEquals(0L, r.speedBps)
    }

    @Test
    fun `after a restart nothing claims a speed`() {
        val running = DownloadRecord(
            id = "a", kind = "movie", title = "T", streamUrl = "u", fileName = "a.dat",
            status = DownloadStatus.RUNNING.name, speedBps = 5_000_000
        )
        val after = DownloadIndex.reconcileAfterRestart(listOf(running)).single()
        assertEquals(DownloadStatus.QUEUED, after.statusEnum)
        assertEquals(0L, after.speedBps)
    }
}
